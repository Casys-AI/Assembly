import { isPlainRecord as object } from "../../../domain/primitives/is-plain-record.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type { FlowValues } from "../../../domain/model/execution/flow.ts";
import type {
  NativeChangeApprovalWait,
  NativeExecutionModelPin,
  NativeExecutionScope,
  NativeModelAdvanceEvidence,
} from "./contract.ts";
import { nativeFrameworkNodeName } from "./framework-node-name.ts";

export const TYPED_WAIT_PROTOCOL = "typed-wait-v1";
export const LEGACY_WAIT_PROTOCOL = "legacy-checkpoint-v0";
export interface NativeWaitEvidence {
  version: 1;
  kind: "input" | "decision" | "budget" | "contribution" | "technical-advance";
  nodeId: string;
  actionId: string;
  preparedNodeId: string;
  effectKey: string;
  modelPin: NativeExecutionModelPin;
  executionScope: NativeExecutionScope;
  operatorId: string;
  rootRequestId?: string;
  resultDigest: string;
  inputs: FlowValues;
  promotionId?: string;
  changeApprovalWait?: NativeChangeApprovalWait;
  evidence?: NativeModelAdvanceEvidence;
}
export interface NativeWaitConsumptionEvidence {
  version: 1;
  kind: "wait-v1" | "input-v1";
  contributionId: string;
  wait?: NativeWaitEvidence;
  sourceCheckpointId?: string;
}

function validChangeApprovalWait(
  value: unknown,
): value is NativeChangeApprovalWait {
  return object(value) && value.version === 1 && object(value.identity) &&
    [
      "contributionId",
      "inputMessageId",
      "modelDigest",
      "repositoryVersion",
      "flowRootId",
      "flowOccurrenceId",
      "nodeId",
      "actionId",
      "effectKey",
      "changeId",
      "proposalIntentDigest",
    ].every((key) =>
      typeof value[key] === "string" && (value[key] as string).length > 0
    );
}
export function parseNativeWaitEvidence(value: unknown): NativeWaitEvidence {
  if (
    !object(value) || value.version !== 1 ||
    !["input", "decision", "budget", "contribution", "technical-advance"]
      .includes(String(value.kind)) ||
    [
      "nodeId",
      "actionId",
      "preparedNodeId",
      "effectKey",
      "operatorId",
      "resultDigest",
    ].some((key) =>
      typeof value[key] !== "string" || !(value[key] as string).length
    ) ||
    !/^[0-9a-f]{64}$/.test(String(value.resultDigest)) ||
    !object(value.inputs) ||
    !object(value.modelPin) || !object(value.executionScope) ||
    value.preparedNodeId !==
      nativeFrameworkNodeName(String(value.nodeId), "await-preparation") ||
    (value.kind === "technical-advance") !== object(value.evidence) ||
    value.changeApprovalWait !== undefined &&
      !validChangeApprovalWait(value.changeApprovalWait)
  ) {
    throw new Error("NATIVE_WAIT_EVIDENCE_INVALID");
  }
  return structuredClone(value) as unknown as NativeWaitEvidence;
}

export function budgetSourceFromWait(wait: NativeWaitEvidence) {
  const sourceKind = wait.kind === "budget"
    ? "settled-budget-wait" as const
    : wait.kind === "input"
    ? "unconsumed-input-wait" as const
    : undefined;
  return sourceKind
    ? {
      sourceKind,
      occurrenceId: wait.nodeId,
      preparedNodeId: wait.preparedNodeId,
      settledEffectKey: wait.effectKey,
    }
    : undefined;
}
export async function effectResultDigest(result: unknown): Promise<string> {
  if (!object(result)) throw new Error("NATIVE_WAIT_EFFECT_INVALID");
  const {
    localState: _local,
    messages: _messages,
    journal: _journal,
    operatorData: _data,
    asyncTasks: _async,
    ...prepared
  } = result;
  return await executionDigest(prepared);
}
