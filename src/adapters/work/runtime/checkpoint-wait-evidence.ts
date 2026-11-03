import { isPlainRecord as object } from "../../../domain/primitives/is-plain-record.ts";
/** LangGraph's technical checkpoint boundary. Business wait authority lives in
 * immutable ledger receipts; only explicitly marked historical runs use the
 * legacy decoder below. The official saver alone owns serialization. */
import type { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type {
  NativeChangeApprovalWait,
  NativeExecutionRequest,
  NativeExecutionScope,
  NativeModelAdvanceEvidence,
} from "../../../application/work/runtime/execution.ts";
import type { FlowValues } from "../../../domain/model/execution/flow.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { ExecutionSql } from "../../out/postgres/execution-transaction.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  nativeFrameworkNodeName,
  type NativeModelPin,
  type NativeState,
} from "./native-graph.ts";

export const TYPED_WAIT_PROTOCOL = "typed-wait-v1";
export const LEGACY_WAIT_PROTOCOL = "legacy-checkpoint-v0";
export interface NativeWaitEvidence {
  version: 1;
  kind: "input" | "decision" | "budget" | "contribution" | "technical-advance";
  nodeId: string;
  actionId: string;
  preparedNodeId: string;
  effectKey: string;
  modelPin: NativeModelPin;
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
export type OfficialCheckpointTuple = NonNullable<
  Awaited<ReturnType<PostgresSaver["getTuple"]>>
>;
export type OfficialCheckpoint = Parameters<PostgresSaver["put"]>[1];

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
export function checkpointInterruptEvidence(
  writes: Parameters<PostgresSaver["putWrites"]>[1],
): NativeWaitEvidence[] {
  return writes.filter(([channel]) => channel === "__interrupt__").map(
    ([, interrupt]) => {
      if (!object(interrupt) || !object(interrupt.value)) {
        throw new Error("NATIVE_WAIT_INTERRUPT_INVALID");
      }
      return parseNativeWaitEvidence(interrupt.value.waitEvidence);
    },
  );
}
/** Read only explicitly emitted proof channels, never acceptedContributionIds.
 * Forks inherit the channel without consuming anything and are handled separately. */
export function checkpointConsumptions(
  checkpoint: OfficialCheckpoint,
  versions: Parameters<PostgresSaver["put"]>[3],
): NativeWaitConsumptionEvidence[] {
  if (!Object.hasOwn(versions, "waitConsumptions")) return [];
  const values = checkpoint.channel_values.waitConsumptions;
  if (!Array.isArray(values) || values.length > 1) {
    throw new Error("NATIVE_WAIT_CONSUMPTION_INVALID");
  }
  return values.map((value) => {
    if (
      !object(value) || value.version !== 1 ||
      typeof value.contributionId !== "string" ||
      !value.contributionId.length ||
      !["wait-v1", "input-v1"].includes(String(value.kind)) ||
      (value.kind === "wait-v1") !== object(value.wait) ||
      (value.kind === "wait-v1" &&
        (typeof value.sourceCheckpointId !== "string" ||
          !value.sourceCheckpointId.length))
    ) throw new Error("NATIVE_WAIT_CONSUMPTION_INVALID");
    return {
      version: 1,
      kind: value.kind,
      contributionId: value.contributionId,
      ...(value.wait
        ? {
          wait: parseNativeWaitEvidence(value.wait),
          sourceCheckpointId: value.sourceCheckpointId as string,
        }
        : {}),
    } as NativeWaitConsumptionEvidence;
  });
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
/** This is the single historical decoder. The caller MUST prove this exact
 * run has the immutable legacy protocol marker before calling it. */
export async function decodeLegacyCheckpointWait(
  protocol: string,
  tuple: OfficialCheckpointTuple,
  request: NativeExecutionRequest,
): Promise<NativeWaitEvidence | undefined> {
  if (protocol !== LEGACY_WAIT_PROTOCOL) {
    throw new Error("NATIVE_WAIT_LEGACY_PROTOCOL_REQUIRED");
  }
  const state = tuple.checkpoint.channel_values as Partial<NativeState>;
  const prepared = state.prepared;
  if (
    !prepared ||
    (prepared.result.suspend !== true && !prepared.result.modelAdvance)
  ) return undefined;
  const node = request.flow.nodes.find((node) => node.id === prepared.nodeId);
  if (
    node?.mechanism === "await_input" &&
    prepared.result.suspensionKind !== undefined
  ) throw new Error("NATIVE_WAIT_LEGACY_KIND_INVALID");
  if (
    !node || !prepared.effectKey || !state.modelPin || !state.executionScope ||
    !state.operatorId || state.immutableGroup
  ) throw new Error("NATIVE_WAIT_LEGACY_PROOF_INVALID");
  const kind = prepared.result.modelAdvance
    ? "technical-advance"
    : node.mechanism === "await_input"
    ? "input"
    : prepared.result.suspensionKind === undefined
    ? "budget"
    : prepared.result.suspensionKind;
  if (
    !kind ||
    !["input", "decision", "budget", "contribution", "technical-advance"]
      .includes(kind)
  ) throw new Error("NATIVE_WAIT_LEGACY_KIND_INVALID");
  return parseNativeWaitEvidence({
    version: 1,
    kind,
    nodeId: node.id,
    actionId: node.nativeId,
    preparedNodeId: nativeFrameworkNodeName(node.id, "await-preparation"),
    effectKey: prepared.effectKey,
    modelPin: state.modelPin,
    executionScope: state.executionScope,
    operatorId: state.operatorId,
    ...(state.rootRequestId ? { rootRequestId: state.rootRequestId } : {}),
    resultDigest: await effectResultDigest(prepared.result),
    inputs: prepared.inputs,
    ...(typeof state.operatorData?.promotionId === "string"
      ? { promotionId: state.operatorData.promotionId }
      : {}),
    ...(state.operatorData?.changeApprovalWait !== undefined
      ? {
        changeApprovalWait: state.operatorData
          .changeApprovalWait as unknown as NativeChangeApprovalWait,
      }
      : {}),
    ...(prepared.result.modelAdvance
      ? { evidence: prepared.result.modelAdvance }
      : {}),
  });
}
export function legacyContributionConsumed(
  protocol: string,
  tuple: OfficialCheckpointTuple,
  contributionId: string,
): boolean {
  if (protocol !== LEGACY_WAIT_PROTOCOL) {
    throw new Error("NATIVE_WAIT_LEGACY_PROTOCOL_REQUIRED");
  }
  const ids = tuple.checkpoint.channel_values.acceptedContributionIds;
  return Array.isArray(ids) && ids.includes(contributionId);
}
/** Byte-preserving technical verification is owned here, not by the ledger. */
export function verifyOfficialFork(
  source: OfficialCheckpointTuple,
  target: OfficialCheckpointTuple,
  changes: Record<string, unknown>,
  sourceProtocol: string = TYPED_WAIT_PROTOCOL,
): void {
  if (![TYPED_WAIT_PROTOCOL, LEGACY_WAIT_PROTOCOL].includes(sourceProtocol)) {
    throw new Error("NATIVE_FORK_SOURCE_PROTOCOL_INVALID");
  }
  const before = source.checkpoint.channel_values,
    after = target.checkpoint.channel_values;
  for (
    const channel of new Set([...Object.keys(before), ...Object.keys(after)])
  ) {
    // The pinned framework initializes this newly declared reducer while
    // forking old state. It is neutral only when genuinely absent in a proven
    // legacy source, and only as the exact empty array in the target. Existing
    // source bytes and every other channel remain subject to the strict check.
    if (
      sourceProtocol === LEGACY_WAIT_PROTOCOL &&
      channel === "waitConsumptions" &&
      !Object.hasOwn(before, channel) && Object.hasOwn(after, channel) &&
      Array.isArray(after[channel]) && after[channel].length === 0
    ) continue;
    if (
      !Object.hasOwn(changes, channel) &&
      canonical(before[channel]) !== canonical(after[channel])
    ) throw new Error(`NATIVE_FORK_CHANNEL_CHANGED:${channel}`);
  }
  for (const [channel, value] of Object.entries(changes)) {
    if (canonical(after[channel]) !== canonical(value)) {
      throw new Error(`NATIVE_FORK_TARGET_CHANGED:${channel}`);
    }
  }
}

/** Validate technical state against an already persisted typed receipt. This
 * never constructs modern authority or imports missing receipt evidence. */
export async function verifyOfficialWaitCheckpoint(
  tuple: OfficialCheckpointTuple | undefined,
  wait: NativeWaitEvidence,
): Promise<void> {
  const state = tuple?.checkpoint.channel_values as
    | Partial<NativeState>
    | undefined;
  const prepared = state?.prepared;
  if (
    !tuple || tuple.checkpoint.v !== 4 || !prepared ||
    prepared.nodeId !== wait.nodeId || prepared.effectKey !== wait.effectKey ||
    prepared.result.suspend !== true ||
    prepared.result.suspensionKind !== undefined ||
    prepared.result.modelAdvance || wait.kind !== "input" ||
    (tuple.pendingWrites ?? []).some((write) => write[1] !== "__interrupt__") ||
    canonical(state?.modelPin) !== canonical(wait.modelPin) ||
    canonical(state?.executionScope) !== canonical(wait.executionScope) ||
    state?.operatorId !== wait.operatorId ||
    state?.rootRequestId !== wait.rootRequestId ||
    canonical(state?.operatorData?.changeApprovalWait) !==
      canonical(wait.changeApprovalWait) ||
    canonical(prepared.inputs) !== canonical(wait.inputs) ||
    await effectResultDigest(prepared.result) !== wait.resultDigest
  ) {
    throw new Error("NATIVE_WAIT_OFFICIAL_CHECKPOINT_MISMATCH");
  }
}

/** Exact Main network-adoption fingerprint. Encoding, field order, limits and
 * NOWAIT row locks are preserved; callers receive opaque technical bytes. */
export async function captureOfficialCheckpointRows(
  query: ExecutionSql,
  checkpointSchema: string,
  cursor: {
    threadId: string;
    checkpointNamespace?: string;
    checkpointId?: string;
  },
  lock: boolean,
): Promise<string> {
  if (!cursor.checkpointId || typeof cursor.checkpointNamespace !== "string") {
    throw new Error("Approval checkpoint identity unavailable");
  }
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(checkpointSchema)) {
    throw new Error("Invalid execution schema");
  }
  const schema = `"${checkpointSchema}"`;
  const key = [
    cursor.threadId,
    cursor.checkpointNamespace,
    cursor.checkpointId,
  ];
  const checkpoint = await query(
    `SELECT checkpoint::text AS checkpoint,metadata::text AS metadata,parent_checkpoint_id FROM ${schema}.checkpoints WHERE thread_id=$1 AND checkpoint_ns=$2 AND checkpoint_id=$3 ${
      lock ? "FOR SHARE NOWAIT" : ""
    }`,
    key,
  );
  if (checkpoint.rows.length !== 1) {
    throw new Error("Approval checkpoint unavailable");
  }
  const count = await query(
    `SELECT count(*)::integer AS count FROM ${schema}.checkpoints cp, jsonb_each_text(cp.checkpoint->'channel_versions') v WHERE cp.thread_id=$1 AND cp.checkpoint_ns=$2 AND cp.checkpoint_id=$3`,
    key,
  );
  const blobs = await query(
    `SELECT bl.channel,bl.version,bl.type,encode(bl.blob,'hex') AS blob FROM ${schema}.checkpoints cp CROSS JOIN LATERAL jsonb_each_text(cp.checkpoint->'channel_versions') v JOIN ${schema}.checkpoint_blobs bl ON bl.thread_id=cp.thread_id AND bl.checkpoint_ns=cp.checkpoint_ns AND bl.channel=v.key AND bl.version=v.value WHERE cp.thread_id=$1 AND cp.checkpoint_ns=$2 AND cp.checkpoint_id=$3 ORDER BY bl.channel LIMIT 257 ${
      lock ? "FOR SHARE OF bl NOWAIT" : ""
    }`,
    key,
  );
  const writes = await query(
    `SELECT task_id::text,idx,channel,type,encode(blob,'hex') AS blob,task_path FROM ${schema}.checkpoint_writes WHERE thread_id=$1 AND checkpoint_ns=$2 AND checkpoint_id=$3 ORDER BY task_id,idx LIMIT 257 ${
      lock ? "FOR SHARE NOWAIT" : ""
    }`,
    key,
  );
  if (
    blobs.rows.length > 256 || writes.rows.length > 256 ||
    Number(count.rows[0]?.count) !== blobs.rows.length
  ) {
    throw new Error(
      "Approval checkpoint evidence is incomplete or exceeds its bound",
    );
  }
  return canonical({
    checkpoint: checkpoint.rows[0],
    blobs: blobs.rows,
    writes: writes.rows,
  });
}
