import {
  budgetContinuationReplayEvidence,
  recordBudgetContinuationSelection,
} from "../runtime/budget-transition.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { nativeSettledActionAdvanceEvidence } from "../native-execution/model-advance.ts";
import {
  activeBatchCall,
  completeBatchCall,
  nativeCallResult,
  pendingBatch,
  selectBatchCall,
} from "./batches.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ChatDecision } from "./chat-decision.ts";
import { handleConversationNode } from "./flow-handlers.ts";
import type {
  ConversationTurnHost,
  ConversationTurnState,
} from "./turn-context.ts";
import { makeEvent } from "../runtime/values.ts";
import { currentCase, localRequestCase } from "../cases/runtime.ts";
import {
  hydrateRuntimeValues,
  type NativeExecutionContribution,
  nativeExecutionContribution,
  nativeExecutionIdentity,
  type NativeExecutionSnapshot,
  runtimeRevisionReference,
} from "../native-execution/contract.ts";
import type {
  FlowExecutionEvent,
  FlowValues,
} from "../../../domain/model/execution/flow.ts";
import { createImmutableConsultationHandlers } from "./immutable-consultations.ts";

/** Invoke the admitted graph through the execution port. This service supplies
 * real business primitives and receipts; it never advances a native cursor. */
export async function runTurn(
  this: ConversationTurnHost,
  onReply?: (reply: Extract<ChatDecision, { kind: "reply" }>) => void,
  contribution?: NativeExecutionContribution,
): Promise<void> {
  await this.currentModel();
  let model = structuredClone(this.state.executionModel!);
  const inputMessageId = contribution?.inputMessageId ??
    this.state.activeInputMessageId ??
    nativeExecutionContribution(this.state).id;
  const identity = nativeExecutionIdentity(
    this.state,
    "conversation",
    inputMessageId,
  );
  const behaviorId = this.state.scheduledExecution &&
    currentCase(this.state)?.scheduling?.behaviorId;
  const flow = behaviorId && model.caseFlows?.[behaviorId] ||
    model.flows.conversation;
  if (!this.ports.execution || !this.ports.stateHistory) {
    throw new Error(
      "Native execution and immutable state history ports are required",
    );
  }
  const events: typeof this.state.events = [];
  let boundaryModel: ExecutableModel | undefined;
  const bufferEvent = (event: FlowExecutionEvent, firstRecordedAt?: string) => {
    const step = (event as typeof event & { step: number }).step;
    const id =
      `native:${identity.invocationKey}:${flow.rootOccurrenceId}:${model.version.digest}:${step}:${event.kind}:${
        event.actionId ?? event.edgeId
      }`;
    events.push({
      ...makeEvent(
        this.ports.clock,
        `flow-${event.kind}`,
        `Conversation : ${event.kind}`,
      ),
      ...(firstRecordedAt ? { at: firstRecordedAt } : {}),
      id,
      execution: {
        ...this.executionReference(model, {
          actionId: event.actionId,
          edgeId: event.edgeId,
        }),
        digest: (event as typeof event & { modelDigest?: string })
          .modelDigest ?? model.version.digest,
        sourceIds: (event as typeof event & { modelSourceIds?: string[] })
          .modelSourceIds ?? model.version.sourceIds,
        repositoryVersion:
          (event as typeof event & { repositoryVersion?: string })
            .repositoryVersion ?? model.version.repositoryVersion,
      },
    });
    return Promise.resolve();
  };
  let result: NativeExecutionSnapshot;
  try {
    result = await this.ports.execution.run({
      businessRevision: runtimeRevisionReference(this.state),
      identity,
      contribution: contribution ?? nativeExecutionContribution(this.state),
      ...(contribution?.networkAdoptionContinuation
        ? {
          networkAdoptionContinuation: structuredClone(
            contribution.networkAdoptionContinuation,
          ),
        }
        : {}),
      ...(contribution?.networkRefusalContinuation
        ? {
          networkRefusalContinuation: structuredClone(
            contribution.networkRefusalContinuation,
          ),
        }
        : {}),
      ...(contribution?.teamAdoptionContinuation
        ? {
          teamAdoptionContinuation: structuredClone(
            contribution.teamAdoptionContinuation,
          ),
        }
        : {}),
      ...(contribution?.teamRefusalContinuation
        ? {
          teamRefusalContinuation: structuredClone(
            contribution.teamRefusalContinuation,
          ),
        }
        : {}),
      model,
      flow,
      maxSteps: model.policy.maxFlowSteps,
    }, {
      immutableConsultations: createImmutableConsultationHandlers(
        this,
        flow,
        () => structuredClone(model),
      ),
      assertBoundary: async () => {
        boundaryModel = undefined;
        const current = await this.currentModel();
        if (
          current.version.digest !== model.version.digest ||
          this.state.executionModel?.version.repositoryVersion !==
            model.version.repositoryVersion
        ) {
          throw new Error(
            "The native execution requires its exact admitted model pin",
          );
        }
        if (
          canonical(
            nativeExecutionIdentity(this.state, "conversation", inputMessageId),
          ) !== canonical(identity)
        ) {
          throw new Error(
            "The active business invocation changed during native execution",
          );
        }
        boundaryModel = current;
      },
      pendingContributions: () =>
        Object.keys(this.state.pendingContributions ?? {}).filter((id) =>
          this.state.pendingContributions![id].status === "pending"
        ),
      readAdoptedModel: async () => {
        const head = await this.inspectModelVersion();
        if (
          head.version.repositoryVersion !==
            this.state.executionModel!.version.repositoryVersion ||
          head.version.digest !== this.state.executionModel!.version.digest
        ) {
          throw new Error(
            "The catalog publication is no longer the exact current source HEAD",
          );
        }
        return structuredClone(this.state.executionModel!);
      },
      continuationSelected: async (receipt) => {
        if (receipt.evidence.kind !== "verified-budget-ceiling-advance") return;
        await this.currentModel();
        const replay = await budgetContinuationReplayEvidence(
          this.state,
          receipt,
          model,
        );
        await this.update((state) =>
          recordBudgetContinuationSelection(state, receipt, replay)
        );
      },
      modelAdvanced: (next) => {
        model = structuredClone(next);
        return Promise.resolve();
      },
      shouldAwait: () => !pendingBatch(this.state),
      resolveValues: (values) =>
        hydrateRuntimeValues(values, this.ports.stateHistory!, identity),
      handle: async (node, inputs, values, execution) => {
        const local = execution.localState;
        if (node.mechanism === "await_input") {
          // The host has already recorded the authenticated contribution. Native
          // acceptance resets contribution-local counters, never cumulative budget.
          return { localState: {} };
        }
        if (node.mechanism === "read_case") {
          return await this.action(node, () =>
            Promise.resolve({
              outputs: { record: runtimeRevisionReference(this.state) },
              localState: local,
            }), boundaryModel);
        }
        if (
          node.mechanism !== "choose_move" && !activeBatchCall(this.state) &&
          pendingBatch(this.state)?.calls.some((call) =>
            call.status === "started"
          )
        ) await selectBatchCall(this);
        const tracked = activeBatchCall(this.state);
        const chooseNode = flow.nodes.find((item) =>
          item.mechanism === "choose_move"
        );
        const chosen = chooseNode
          ? (values[chooseNode.name] as { choice?: ChatDecision } | undefined)
            ?.choice
          : undefined;
        const checkNode = flow.nodes.find((item) =>
          item.mechanism === "check_invocation"
        );
        const admission = checkNode
          ? (values[checkNode.name] as { decision?: unknown } | undefined)
            ?.decision
          : undefined;
        const turn: ConversationTurnState = {
          executionProfile: flow.executionProfile,
          noticeCompletionAvailable: flow.nodes.some((item) =>
            item.mechanism === "execute_operator_command" &&
            item.outputs.includes("submission")
          ),
          inputMessageId,
          ...(local.pendingCommand
            ? {
              pendingCommand: local
                .pendingCommand as ConversationTurnState["pendingCommand"],
            }
            : {}),
          resumedContribution: execution.resumed,
          proposals: typeof local.proposals === "number" ? local.proposals : 0,
          decisions: typeof local.decisions === "number" ? local.decisions : 0,
          chosen,
          ...(tracked
            ? {
              batchCall: { batchId: tracked.batch.id, callId: tracked.call.id },
            }
            : {}),
          sourceDecision: structuredClone(
            tracked?.batch.sourceDecision ??
              (local.sourceDecision as
                | ConversationTurnState["sourceDecision"]
                | undefined) ??
              {},
          ),
          ...(chosen?.kind === "invoke_behavior"
            ? {
              behaviorAdmission:
                admission as ConversationTurnState["behaviorAdmission"],
            }
            : { admission: admission as ConversationTurnState["admission"] }),
          failures: new Map(
            Array.isArray(local.failures)
              ? local.failures as [string, number][]
              : [],
          ),
        };
        if (
          tracked &&
          (node.mechanism === "invoke_tool" &&
              turn.chosen?.kind === "invoke_behavior" ||
            node.mechanism === "submit_proposal" &&
              turn.chosen?.kind !== "propose_tool" ||
            node.mechanism === "execute_operator_command" &&
              [
                "open_request",
                "resume_request",
                "decide_operator_candidate",
                "decide_operator_change",
              ].includes(turn.chosen?.kind ?? ""))
        ) {
          await this.update((state) => {
            const call = state.conversationBatches!.find((batch) =>
              batch.id === tracked.batch.id
            )!
              .calls.find((call) => call.id === tracked.call.id)!;
            call.effectStarted = true;
          });
        }
        const output = await this.withExecutionOrigin(
          {
            effectKey: execution.effectKey,
            inputMessageId,
            ...(turn.pendingCommand
              ? { retained: turn.pendingCommand.origin }
              : {}),
          },
          () =>
            handleConversationNode.call(
              this,
              turn,
              node,
              inputs,
              boundaryModel,
            ),
        );
        const active = activeBatchCall(this.state);
        if (
          active && !output.suspend &&
          ![
            "read_case",
            "choose_move",
            "await_input",
            "consult_declared_source",
          ]
            .includes(node.mechanism ?? "")
        ) {
          const candidate = active.call.candidateId
            ? this.state.candidates.find((item) =>
              item.id === active.call.candidateId
            )
            : undefined;
          const receipt = node.mechanism === "reply"
            ? active.call.result ??
              {
                status: "succeeded" as const,
                code: "REPLY_RECORDED",
                details: turn.chosen?.text ?? "",
              }
            : nativeCallResult(
              output,
              candidate,
              node.mechanism === "execute_operator_command"
                ? "operator-command"
                : "native-outcome",
            );
          if (receipt && node.mechanism === "report_refusal") {
            receipt.status = "refused";
          }
          if (receipt) {
            await completeBatchCall(
              this,
              active.batch.id,
              active.call.id,
              receipt,
            );
          }
        }
        const localState: FlowValues = {
          ...(turn.changeApprovalProposal
            ? {
              changeApprovalProposal: structuredClone(
                turn.changeApprovalProposal,
              ),
            }
            : {}),
          proposals: turn.proposals,
          decisions: turn.decisions,
          ...(output.suspend && turn.pendingCommand
            ? { pendingCommand: turn.pendingCommand }
            : {}),
          failures: [...turn.failures],
          ...(!activeBatchCall(this.state)
            ? { sourceDecision: structuredClone(turn.sourceDecision) }
            : {}),
          ...(local.reply ? { reply: local.reply } : {}),
          ...(node.mechanism === "reply" && turn.chosen?.kind === "reply"
            ? { reply: structuredClone(turn.chosen) }
            : {}),
        };
        const modelAdvance = await nativeSettledActionAdvanceEvidence(
          model,
          this.state,
          identity.scope,
        );
        return {
          ...output,
          localState,
          ...(modelAdvance ? { modelAdvance } : {}),
          ...(output.suspend
            ? {
              suspensionKind: this.state.budgetSuspension
                ? "budget" as const
                : "contribution" as const,
            }
            : {}),
        };
      },
      onEvent: bufferEvent,
      recoverEvents: async (records) => {
        for (const record of records) {
          await bufferEvent(record.event, record.firstRecordedAt);
        }
      },
    });
  } finally {
    if (events.length) {
      await this.update((state) => {
        const ids = new Set(state.events.map((event) => event.id));
        for (const event of events) {
          if (ids.has(event.id)) continue;
          state.events.push(event);
          ids.add(event.id);
        }
      });
    }
  }
  await this.update((state) => {
    if (state.caseInvocation?.kind === "local") {
      const caseId = state.caseInvocation.caseId;
      const record = state.cases?.find((item) => item.id === caseId);
      if (record?.openedFrom.changeId || record?.openedFrom.openingId) {
        record.firstRequestDispatched = true;
        delete record.firstRequestDispatch;
      }
    }
    if (activeBatchCall(state)?.call.status === "completed") {
      delete state.activeBatchCall;
    }
  });
  const reply = result.localState?.reply as
    | Extract<ChatDecision, { kind: "reply" }>
    | undefined;
  if (reply?.kind === "reply") {
    onReply?.(reply);
    if (
      reply.caseClosure && !this.state.scheduledExecution &&
      localRequestCase(this.state)?.owner === model.identity.builderId
    ) {
      const caseId = identity.scope.kind === "request"
        ? identity.scope.scopeId
        : undefined;
      await this.finishCase(reply.caseClosure);
      const closed = this.state.cases?.find((record) => record.id === caseId);
      if (
        !closed?.closedAt ||
        !["closed-done", "closed-abandoned"].includes(closed.status)
      ) throw new Error("The exact Request closure receipt is absent");
      const closure = {
        kind: "closed-case" as const,
        businessRevision: runtimeRevisionReference(this.state),
        caseId: closed.id,
        status: closed.status as "closed-done" | "closed-abandoned",
        closedAt: closed.closedAt,
      };
      const siblings = (await this.ports.execution.inspect(identity.operatorId))
        .filter((snapshot) =>
          snapshot.identity.scope.kind === "request" &&
          snapshot.identity.scope.scopeId === closed.id &&
          snapshot.threadId !== result.threadId
        );
      await this.ports.execution.closeScope(result, closure);
      for (const sibling of siblings) {
        await this.ports.execution.closeScope(sibling, closure);
      }
    }
  }
}
