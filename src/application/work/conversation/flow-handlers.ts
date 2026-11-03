import { ChangeApprovabilityError } from "../../../domain/governance/policies/change-approvability.ts";
import {
  ChangePendingError,
  DuplicateOperatorCreationError,
} from "../../../domain/governance/policies/governance.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  CompiledFlowNode,
  FlowActionResult,
  FlowValues,
} from "../../../domain/model/execution/flow.ts";
import { AgentBudgetWait } from "../budget/agent.ts";
import { OperatorCommandPending } from "../operators/command-delivery.ts";
import { chooseMove, executeOperatorCommand } from "./decision.ts";
import { consultDeclaredModelSource } from "./declared-model-consultation.ts";
import { checkInvocation, invokeTool, reportRefusal } from "./invocation.ts";
import { observeOutcome } from "./observation.ts";
import { submitProposal } from "./proposals.ts";
import { hasQueuedBatchCall, pendingBatch } from "./batches.ts";
import { authorityNoticeInput, noticeDecisionRecorded } from "./notice-turn.ts";
import {
  cancelCompletedTurnSiblings,
  requestOpeningReceipt,
} from "./turn-completion.ts";
import type {
  ConversationTurnHost,
  ConversationTurnState,
} from "./turn-context.ts";

/** Turn counter key: the agent may correct a refused proposal once per turn. */
const PROPOSAL_REFUSAL = "proposal-refusal";

/** The submission output of a refused proposal, which the flow observes. */
function refusedSubmission(
  error: { message: string; context?: unknown; recovery?: unknown },
  code: string,
  awaitingInput: boolean,
): FlowActionResult {
  return {
    outputs: {
      submission: { awaitingInput },
      outcome: {
        succeeded: false,
        refused: true,
        code,
        details: error.message,
        context: error.context,
        recovery: error.recovery,
      },
    },
  };
}

/** Native action execution keeps the façade's reference scope and budget catch. */
export async function handleConversationNode(
  this: ConversationTurnHost,
  turn: ConversationTurnState,
  node: CompiledFlowNode,
  inputs: FlowValues,
  boundaryModel?: ExecutableModel,
): Promise<FlowActionResult> {
  return await this.action(node, async (current) => {
    try {
      // Intermediate narrations belong to ordinary dialogue. A notice-driven
      // authority turn retains tool observations and its explicit final reply
      // path, while successful exact decisions route directly to input wait.
      const host: ConversationTurnHost = turn.noticeCompletionAvailable &&
          node.mechanism !== "reply" &&
          authorityNoticeInput(this.state, turn.inputMessageId)
        ? Object.create(this, {
          say: { value: () => Promise.resolve() },
        })
        : this;
      return await dispatchConversationNode.call(
        host,
        turn,
        current,
        node,
        inputs,
      );
    } catch (error) {
      if (error instanceof ChangePendingError) {
        await this.feedback(
          JSON.stringify({
            code: error.code,
            context: error.context,
            recovery: error.recovery,
          }),
        );
        return refusedSubmission(error, error.code, true);
      }
      if (
        node.mechanism === "submit_proposal" &&
        (error instanceof ChangeApprovabilityError ||
          error instanceof OperatorAuthorityError ||
          error instanceof RequestSpaceError ||
          error instanceof DuplicateOperatorCreationError) &&
        !turn.failures.has(PROPOSAL_REFUSAL)
      ) {
        // The domain judged the proposal: the agent sees why and may correct
        // or explain. A second refusal in the turn fails it.
        turn.failures.set(PROPOSAL_REFUSAL, 1);
        const code = error instanceof ChangeApprovabilityError
          ? error.reason
          : error.code;
        await this.feedback(
          `Host refusal while preparing or applying your proposal. Check its recorded state and exact publication receipt before retrying. The refusal itself grants no rights. Correct the request or explain the limit to the person.\n${
            JSON.stringify({
              code,
              message: error.message,
              context: error.context,
              recovery: error.recovery,
            })
          }`,
        );
        return refusedSubmission(error, code, false);
      }
      if (!(error instanceof AgentBudgetWait)) {
        throw error;
      }
      await this.suspendBudget(error, node, "decide");
      return { suspend: true };
    }
  }, boundaryModel);
}

async function dispatchConversationNode(
  this: ConversationTurnHost,
  turn: ConversationTurnState,
  current: ExecutableModel,
  node: CompiledFlowNode,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  switch (node.mechanism) {
    case "read_case": {
      const {
        conversationContext: _context,
        conversationCursor: _cursor,
        conversationFlow: _flow,
        invocationContinuations: _continuations,
        changeWorkContinuations: _changeWork,
        conversationBatches: _batches,
        activeBatchCall: _batchCall,
        ...record
      } = this.snapshot;
      return {
        outputs: { record: { ...record, sessionId: this.state.id } },
      };
    }
    case "consult_declared_source": {
      if (pendingBatch(this.state)) {
        // Already-decided members preserve their original response order. The
        // next fresh response must pass this primitive again after draining.
        return {
          outputs: {
            consultation: {
              succeeded: true,
              code: "BATCH_DECISION_ALREADY_CONSULTED",
              details: "Draining an already-decided response.",
            },
          },
        };
      }
      return await consultDeclaredModelSource.call(this, current, node);
    }
    case "execute_operator_command": {
      let result;
      try {
        result = await executeOperatorCommand.call(
          this,
          turn,
          current,
          undefined,
          false,
        );
      } catch (error) {
        // The native graph retains the selected command and original input.
        // A correlated target receipt resumes this action; no synthetic user
        // input, successful outcome or additional authority is introduced.
        if (error instanceof OperatorCommandPending) {
          turn.pendingCommand = {
            receipt: error.receipt,
            origin: error.origin,
          };
          return { suspend: true };
        }
        throw error;
      }
      const completionAvailable = turn.noticeCompletionAvailable === true &&
        node.outputs.includes("submission");
      const openingReceipt = completionAvailable
        ? requestOpeningReceipt(
          this.state,
          turn.inputMessageId,
          turn.chosen,
          result,
        )
        : undefined;
      const awaitingInput = completionAvailable && (!!openingReceipt ||
        noticeDecisionRecorded(
          this.state,
          turn.inputMessageId,
          turn.chosen,
          result,
        ));
      if (awaitingInput) {
        if (openingReceipt) await this.say(openingReceipt);
        await this.update((state) =>
          cancelCompletedTurnSiblings(
            state,
            turn.inputMessageId!,
            openingReceipt
              ? "REQUEST_OPENING_RECORDED"
              : "NOTICE_DECISION_RECORDED",
          )
        );
      }
      return {
        outputs: {
          ...(node.outputs.includes("submission")
            ? { submission: { awaitingInput } }
            : {}),
          outcome: {
            succeeded: result.status === "succeeded",
            refused: result.status === "refused",
            code: result.code,
            details: result.details,
            value: result.value,
          },
        },
      };
    }
    case "choose_move":
      return await chooseMove.call(this, turn, current, inputs);
    case "reply": {
      if (turn.chosen?.kind !== "reply") {
        throw new Error(
          "La réponse native ne possède pas de choix de réponse.",
        );
      }
      await this.say(turn.chosen.text);
      return { outputs: { response: { text: turn.chosen.text } } };
    }
    case "await_input":
      if (hasQueuedBatchCall(this.state) && turn.chosen?.kind !== "reply") {
        return {};
      }
      if (!turn.resumedContribution && turn.resumeNodeId === node.id) {
        turn.resumedContribution = true;
        return {};
      }
      return { suspend: true };
    case "check_invocation":
      return await checkInvocation.call(this, turn, current, inputs);
    case "invoke_tool":
      return await invokeTool.call(this, turn, current, inputs);
    case "report_refusal":
      return reportRefusal(turn);
    case "submit_proposal":
      return await submitProposal.call(this, turn, current, inputs);
    case "observe_outcome":
      return await observeOutcome.call(this, turn, current, inputs);
    default:
      throw new Error(
        `Mécanisme natif interdit dans la conversation : ${node.mechanism}`,
      );
  }
}
