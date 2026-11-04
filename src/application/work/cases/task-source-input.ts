import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { sameCaseIdentity } from "../../../domain/work/execution/case-context.ts";
import {
  taskSourceUrls,
  validTaskSourceInputs,
} from "../../../domain/work/records/task-source-input.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type { TaskSourceInputPort } from "../runtime/ports.ts";
import { caseExecutionContext } from "./runtime.ts";

/** Registry-owned snapshots prove both the current work and its original source.
 * No message text outside the exact human source is shared with the recipient. */
export async function verifyTaskSourceInputContext(
  caller: SystemRuntimeState,
  roots: readonly SystemRuntimeState[],
  primary: SystemRuntimeState,
  input: Parameters<TaskSourceInputPort["verify"]>[0],
): Promise<boolean> {
  const actual = caseExecutionContext(caller);
  if (
    !actual || canonical(actual) !== canonical(input.context) ||
    !validTaskSourceInputs(input.inputs, actual.caseId) || !input.inputs.length
  ) return false;
  const owners = roots.filter((state) =>
    state.cases?.some((record) => record.id === actual.caseId)
  );
  if (owners.length !== 1) return false;
  const owner = owners[0]!;
  const record = owner.cases!.find((entry) => entry.id === actual.caseId)!;
  const authoritative = caseExecutionContext({
    ...owner,
    caseInvocation: { kind: "local", caseId: record.id },
  });
  if (
    !authoritative || record.type !== "request" || !isOpenCase(record) ||
    owner.executionModel?.identity.builderId !== record.owner ||
    !sameCaseIdentity(authoritative, actual) ||
    actual.record?.owner !== record.owner ||
    canonical(record.taskSourceInputs) !== canonical(input.inputs) ||
    canonical(actual.record?.taskSourceInputs) !== canonical(input.inputs)
  ) return false;
  const invocation = caller.caseInvocation;
  if (invocation?.kind === "local") {
    if (caller.id !== owner.id || invocation.caseId !== record.id) return false;
  } else if (invocation?.kind === "delegated") {
    // This receipt must already exist in the actual recipient journal. A JSON
    // payload containing a work/caseContext property cannot manufacture it.
    if (
      !caller.messages.some((message) =>
        message.work &&
        message.work.callerId === invocation.work.callerId &&
        message.work.invocationId === invocation.work.invocationId &&
        message.work.correlationId === invocation.work.correlationId &&
        message.caseId === record.id
      )
    ) return false;
  } else return false;
  for (const source of input.inputs) {
    const provenance = source.source;
    if (
      primary.executionModel?.identity.builderId !== provenance.operatorId ||
      primary.id !== provenance.conversationId ||
      primary.designer?.scopeId !== provenance.designerScopeId ||
      record.openedBy !== provenance.operatorId ||
      record.openedFrom.conversationId !== provenance.conversationId ||
      record.openedFrom.designerScopeId !== provenance.designerScopeId
    ) return false;
    if (provenance.resumeId !== undefined) {
      const receipt = owner.requestResumptions?.find((entry) =>
        entry.caseId === record.id && entry.resumeId === provenance.resumeId
      );
      const { rootRequestId: _root, ...capture } = source;
      if (
        !receipt || receipt.openedBy !== provenance.operatorId ||
        receipt.conversationId !== provenance.conversationId ||
        receipt.designerScopeId !== provenance.designerScopeId ||
        canonical(receipt.taskSourceInputs) !== canonical([capture])
      ) return false;
    } else if (record.openedFrom.messageId !== provenance.messageId) {
      return false;
    }
    const message = primary.messages.find((entry) =>
      entry.id === provenance.messageId
    );
    if (
      !message || message.role !== "user" || message.caseId !== undefined ||
      message.designerScopeId !== undefined &&
        message.designerScopeId !== provenance.designerScopeId ||
      await sha256(message.text) !== provenance.messageDigest ||
      canonical(taskSourceUrls(message.text)) !== canonical(source.urls)
    ) return false;
  }
  return true;
}
