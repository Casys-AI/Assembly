import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import {
  type TaskSourceInputCapture,
  taskSourceUrls,
} from "../../../domain/work/records/task-source-input.ts";
import { caseMessages } from "./runtime.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority-error.ts";
import type { ChatContext } from "../conversation/chat-context.ts";
import type { ChatDecision } from "../conversation/chat-decision.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";

interface OpeningRuntime {
  readonly snapshot: SystemRuntimeState;
  resumeRequest(
    input: import("./commands/inputs.ts").IndependentRequestResume,
  ): Promise<import("../runtime/state.ts").RequestResumeOutcome>;
}

/** Main's resumption of the main Requests it opened. Opening a Request is a
 * branch opening (`RequestSpaceOpenings.openForMain`); only the composition
 * root binds this capability to the actual Main runtime. */
export function requestOpeningHost(options: {
  primary: OpeningRuntime;
  caller: OpeningRuntime;
  runtimes(): readonly OpeningRuntime[];
}) {
  function authorized() {
    const state = options.caller.snapshot;
    if (
      options.caller !== options.primary ||
      state.caseInvocation?.kind !== "designer" ||
      state.caseInvocation.scopeId !== state.designer?.scopeId ||
      !state.executionModel
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "Only Main's design conversation can open an independent Request",
      );
    }
    return state;
  }
  return {
    /** The main Requests this Main conversation opened (operator creation
     * and history): the only targets of `resume_request`. */
    mainRequests(): NonNullable<ChatContext["requestOpening"]>["mainRequests"] {
      let actor: SystemRuntimeState;
      try {
        actor = authorized();
      } catch {
        return undefined;
      }
      return options.runtimes().flatMap((runtime) =>
        (runtime.snapshot.cases ?? []).filter((record) =>
          record.type === "request" &&
          !!(record.openedFrom.openingId || record.openedFrom.changeId) &&
          !record.openedFrom.caseId &&
          record.owner ===
            runtime.snapshot.executionModel?.identity.builderId &&
          record.openedBy === actor.executionModel!.identity.builderId &&
          record.openedFrom.conversationId === actor.id &&
          record.openedFrom.designerScopeId === actor.designer!.scopeId
        ).map((record) => ({
          caseId: record.id,
          operatorId: record.owner,
          status: record.status,
        }))
      );
    },
    async resumeRequest(
      command: Extract<ChatDecision, { kind: "resume_request" }>,
    ) {
      const actor = authorized();
      const target = options.runtimes().find((runtime) =>
        runtime !== options.primary &&
        runtime.snapshot.executionModel?.identity.builderId ===
          command.operatorId &&
        runtime.snapshot.cases?.some((record) =>
          record.id === command.caseId &&
          record.owner === command.operatorId && record.type === "request" &&
          !!(record.openedFrom.openingId || record.openedFrom.changeId) &&
          !record.openedFrom.caseId &&
          record.openedBy === actor.executionModel!.identity.builderId &&
          record.openedFrom.conversationId === actor.id &&
          record.openedFrom.designerScopeId === actor.designer!.scopeId
        )
      );
      if (!target) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "The Request is not owned by this Main conversation",
        );
      }
      const prior = target.snapshot.requestResumptions?.find((receipt) =>
        receipt.caseId === command.caseId &&
        receipt.resumeId === command.resumeId
      );
      const human = caseMessages(actor).findLast((message) =>
        message.role === "user"
      );
      const urls = human ? taskSourceUrls(human.text) : [];
      // A replay belongs to its original capture, even after another human input.
      const taskSourceInputs: TaskSourceInputCapture[] | undefined = prior
        ? prior.taskSourceInputs
        : human && urls.length
        ? [{
          kind: "human-selected-urls",
          source: {
            operatorId: actor.executionModel!.identity.builderId,
            conversationId: actor.id,
            designerScopeId: actor.designer!.scopeId,
            messageId: human.id,
            messageDigest: await sha256(human.text),
            resumeId: command.resumeId,
          },
          urls,
        }]
        : undefined;
      return await target.resumeRequest({
        ...(taskSourceInputs?.length
          ? { taskSourceInputs: structuredClone(taskSourceInputs) }
          : {}),
        caseId: command.caseId,
        resumeId: command.resumeId,
        instruction: command.instruction,
        openedBy: actor.executionModel!.identity.builderId,
        conversationId: actor.id,
        designerScopeId: actor.designer!.scopeId,
      });
    },
  };
}
