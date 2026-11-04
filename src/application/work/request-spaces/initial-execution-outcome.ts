import { invocationKey } from "../operators/journal.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type { NativeExecutionPort } from "../native-execution/contract.ts";
import type { OperatorExecutionDispatchPort } from "../operators/execution.ts";

export interface RequestInitialExecutionReader {
  forCaseSpace(executionSpaceId: string, caseId: string): Promise<{
    scope: {
      projectId: string;
      systemId: string;
      executionSpaceId: string;
      caseId?: string;
    };
    execution: Pick<NativeExecutionPort, "inspect">;
    dispatch: Pick<OperatorExecutionDispatchPort, "inspectAccepted">;
  }>;
}
/** Historical read only. Never open a store/runtime, enqueue work or expose the
 * native refusal text/node. This narrow projection concerns the initial input. */
export async function readRequestInitialExecutionOutcome(
  native: RequestInitialExecutionReader,
  record: OpeningRecord,
  state: SystemRuntimeState,
  lifecycle?: () => Promise<"active" | "closed">,
): Promise<"refused" | undefined> {
  const model = state.executionModel;
  const request = state.cases?.find((entry) => entry.id === record.caseId);
  if (
    !model || !request || !isOpenCase(request) || state.busy ||
    state.activeInputMessageId !== record.initialContributionId ||
    model.identity.builderId !== record.base?.requestOwner.operatorId ||
    !state.messages.some((message) =>
      message.id === record.initialContributionId &&
      message.role === "user" && message.caseId === record.caseId
    )
  ) return;
  if (await lifecycle?.() === "closed") return;
  // The execution view stays active-only. Suppress only its specific scope
  // refusal when an exact fresh lifecycle read proves a concurrent closure.
  const inspect = async () => {
    const view = await native.forCaseSpace(
      record.executionSpaceId,
      record.caseId,
    );
    if (
      view.scope.projectId !== record.scope.projectId ||
      view.scope.systemId !== record.scope.systemId ||
      view.scope.executionSpaceId !== record.executionSpaceId ||
      view.scope.caseId !== record.caseId
    ) return;
    const accepted = await view.dispatch.inspectAccepted?.(
      model.identity.builderId,
      record.initialContributionId,
    );
    if (
      !accepted || accepted.receipt.status !== "completed" ||
      accepted.receipt.id !== record.initialContributionId ||
      accepted.delivery.id !== record.initialContributionId ||
      accepted.delivery.kind !== "contribution" ||
      accepted.delivery.identity.operatorId !== model.identity.builderId ||
      accepted.delivery.identity.scope.kind !== "request" ||
      accepted.delivery.identity.scope.scopeId !== record.caseId ||
      accepted.delivery.identity.scope.rootRequestId !== record.caseId ||
      accepted.delivery.identity.invocationKey !==
        invocationKey({ kind: "local", caseId: record.caseId }) ||
      accepted.delivery.identity.purpose !== "conversation" ||
      accepted.delivery.identity.subjectId !== record.initialContributionId ||
      accepted.delivery.modelPin.modelDigest !== model.version.digest ||
      accepted.delivery.modelPin.repositoryVersion !==
        model.version.repositoryVersion
    ) return;
    const snapshots = await view.execution.inspect(model.identity.builderId, {
      threadId: accepted.receipt.threadId,
      contributionId: record.initialContributionId,
    });
    if (snapshots.length !== 1) return;
    const snapshot = snapshots[0];
    if (
      snapshot.threadId !== accepted.receipt.threadId ||
      snapshot.contributionId !== record.initialContributionId ||
      canonical(snapshot.identity) !== canonical(accepted.delivery.identity) ||
      snapshot.modelDigest !== model.version.digest ||
      snapshot.repositoryVersion !== model.version.repositoryVersion ||
      snapshot.status !== "refused" ||
      snapshot.refusal?.code !== "NATIVE_EXECUTION_ADMISSION_REFUSED" ||
      !Array.isArray(snapshot.unsettledEffects) ||
      snapshot.unsettledEffects.length !== 0
    ) return;
    return "refused" as const;
  };
  try {
    const outcome = await inspect();
    return await lifecycle?.() === "closed" ? undefined : outcome;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Case execution space is unavailable" &&
      await lifecycle?.() === "closed"
    ) return;
    throw error;
  }
}
