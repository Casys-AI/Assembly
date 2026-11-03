import { isPlainRecord as object } from "../../../domain/primitives/is-plain-record.ts";
/** Lossless native observation contract (R4b). A technical diagnostic seam in
 * the execution ensemble: an observation never grants authority, settles an
 * effect, proves consumption or permits continuation. Ownership (scope,
 * thread, run, namespace, contribution, identity, exact pin) is bound by the
 * authenticated session; event data never selects its owner. */
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  executionDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import type { NativeTrace } from "./native-graph.ts";

/** The three real producer sites in native-graph.ts, in read order. */
export type NativeObservationPhase =
  | "preparation"
  | "immutable-group-join"
  | "node-commit";
const NATIVE_OBSERVATION_PHASE_ORDER: Record<
  NativeObservationPhase,
  number
> = { "preparation": 0, "immutable-group-join": 1, "node-commit": 2 };

/** One emission at deterministic producer coordinates. `emissionStep` is the
 * producer's count; the event's own `step` stays intact inside `event`. The
 * batch descriptor pins the whole constructed trace array so a replay cannot
 * change its tail or order. Identity excludes payload, time, retry/epoch and
 * business callback IDs. */
export interface NativeObservationEmission {
  producerPhase: NativeObservationPhase;
  occurrenceId: string;
  emissionStep: number;
  eventOrdinal: number;
  batchCount: number;
  batchDigest: string;
  event: NativeTrace;
}

/** The first durable recording of one logical emission. `firstRecordedAt` is
 * assigned once by the durable store and returned unchanged on replay. */
export interface NativeObservationRecord extends NativeObservationEmission {
  firstRecordedAt: string;
}

/** Mandatory awaited journal on every production execution session. A missing
 * journal or a persistence error refuses; nothing falls back to logging, a
 * business event, or dropping the detail. */
export interface NativeObservationJournal {
  append(
    emission: NativeObservationEmission,
  ): Promise<NativeObservationRecord>;
  /** Only this session's run, ordered by emission step, phase and ordinal. */
  read(): Promise<NativeObservationRecord[]>;
}

const EVENT_KEYS = new Set([
  "kind",
  "actionId",
  "edgeId",
  "nodeId",
  "mechanism",
  "guardIds",
  "source",
  "step",
  "immutableGroupId",
  "immutableCallId",
  "operatorId",
  "rootRequestId",
  "performerId",
  "allocationId",
  "acceptActionId",
  "modelDigest",
  "modelSourceIds",
  "repositoryVersion",
]);
const SOURCE_KEYS = new Set(["file", "line", "quote", "native"]);
const STRING_FIELDS = [
  "actionId",
  "edgeId",
  "nodeId",
  "mechanism",
  "immutableGroupId",
  "immutableCallId",
  "operatorId",
  "rootRequestId",
  "performerId",
  "allocationId",
  "acceptActionId",
  "modelDigest",
  "repositoryVersion",
] as const;

function invalid(): never {
  throw new Error("NATIVE_OBSERVATION_INVALID");
}

/** Exact NativeTrace shape: every field, absence, type and array order is a
 * contract. Unknown keys and nulls refuse rather than normalize away. */
export function parseNativeTrace(value: unknown): NativeTrace {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !EVENT_KEYS.has(key)) ||
    !["action", "edge", "suspended", "completed"].includes(
      String(value.kind),
    ) ||
    !Number.isSafeInteger(value.step) || (value.step as number) < 0 ||
    typeof value.operatorId !== "string" || !value.operatorId ||
    typeof value.modelDigest !== "string" || !value.modelDigest ||
    !Array.isArray(value.modelSourceIds) ||
    value.modelSourceIds.some((item) => typeof item !== "string") ||
    STRING_FIELDS.some((key) =>
      value[key] !== undefined && typeof value[key] !== "string"
    ) ||
    value.guardIds !== undefined &&
      (!Array.isArray(value.guardIds) ||
        value.guardIds.some((item) => typeof item !== "string")) ||
    !object(value.source) ||
    Object.keys(value.source).some((key) => !SOURCE_KEYS.has(key)) ||
    typeof value.source.file !== "string" ||
    !(typeof value.source.line === "string" ||
      typeof value.source.line === "number" &&
        Number.isFinite(value.source.line)) ||
    value.source.quote !== undefined &&
      typeof value.source.quote !== "string" ||
    value.source.native !== undefined &&
      typeof value.source.native !== "boolean"
  ) invalid();
  return structuredClone(value) as unknown as NativeTrace;
}

/** Dedicated versioned exact encoding for new observations. No existing
 * canonical encoder or digest changes: this envelope only wraps canonical(). */
export function encodeNativeObservation(event: NativeTrace): string {
  return canonical({ version: 1, event: parseNativeTrace(event) });
}

export function parseNativeObservationPayload(payload: string): NativeTrace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("NATIVE_OBSERVATION_CORRUPT");
  }
  if (
    !object(parsed) || parsed.version !== 1 ||
    Object.keys(parsed).sort().join(",") !== "event,version"
  ) throw new Error("NATIVE_OBSERVATION_CORRUPT");
  const event = parseNativeTrace(parsed.event);
  if (canonical({ version: 1, event }) !== payload) {
    throw new Error("NATIVE_OBSERVATION_CORRUPT");
  }
  return event;
}

export function assertNativeObservationEmission(
  emission: NativeObservationEmission,
): NativeObservationEmission {
  if (
    !object(emission) ||
    !(emission.producerPhase in NATIVE_OBSERVATION_PHASE_ORDER) ||
    typeof emission.occurrenceId !== "string" || !emission.occurrenceId ||
    !Number.isSafeInteger(emission.emissionStep) || emission.emissionStep < 1 ||
    !Number.isSafeInteger(emission.eventOrdinal) || emission.eventOrdinal < 0 ||
    !Number.isSafeInteger(emission.batchCount) || emission.batchCount < 1 ||
    emission.eventOrdinal >= emission.batchCount ||
    !isSha256Hex(emission.batchDigest)
  ) invalid();
  const event = parseNativeTrace(emission.event);
  if (event.nodeId !== emission.occurrenceId) invalid();
  return { ...emission, event };
}

/** The authenticated session binding an event may not contradict. Derived
 * from the session's request, never from event or transport data. */
interface NativeObservationBinding {
  operatorId: string;
  rootRequestId?: string;
  modelDigest: string;
  repositoryVersion?: string;
  occurrenceIds: ReadonlySet<string>;
}

export function assertNativeObservationBinding(
  emission: NativeObservationEmission,
  binding: NativeObservationBinding,
): void {
  const event = emission.event;
  if (
    event.operatorId !== binding.operatorId ||
    event.rootRequestId !== binding.rootRequestId ||
    !binding.occurrenceIds.has(emission.occurrenceId)
  ) throw new Error("NATIVE_OBSERVATION_OWNER_MISMATCH");
  if (
    event.modelDigest !== binding.modelDigest ||
    event.repositoryVersion !== binding.repositoryVersion
  ) throw new Error("NATIVE_OBSERVATION_PIN_MISMATCH");
}

export async function nativeObservationBatchDigest(input: {
  producerPhase: NativeObservationPhase;
  occurrenceId: string;
  emissionStep: number;
  events: readonly NativeTrace[];
}): Promise<string> {
  return await executionDigest({
    version: 1,
    producerPhase: input.producerPhase,
    occurrenceId: input.occurrenceId,
    emissionStep: input.emissionStep,
    payloads: input.events.map(encodeNativeObservation),
  });
}

export function compareNativeObservations(
  left: NativeObservationEmission,
  right: NativeObservationEmission,
): number {
  return left.emissionStep - right.emissionStep ||
    NATIVE_OBSERVATION_PHASE_ORDER[left.producerPhase] -
      NATIVE_OBSERVATION_PHASE_ORDER[right.producerPhase] ||
    left.eventOrdinal - right.eventOrdinal;
}

/** A committed prefix of a batch is a legitimate durable state (a later
 * callback or checkpoint failed). Only a complete batch must match its
 * descriptor digest; a partial batch is returned as recorded. */
export async function verifyNativeObservationBatches(
  records: readonly NativeObservationRecord[],
): Promise<void> {
  const batches = new Map<string, NativeObservationRecord[]>();
  for (const record of records) {
    const key = canonical([
      record.producerPhase,
      record.occurrenceId,
      record.emissionStep,
    ]);
    const batch = batches.get(key) ?? [];
    batch.push(record);
    batches.set(key, batch);
  }
  for (const batch of batches.values()) {
    const first = batch[0];
    const ordinals = new Set(batch.map((record) => record.eventOrdinal));
    if (
      ordinals.size !== batch.length ||
      batch.some((record) =>
        record.batchCount !== first.batchCount ||
        record.batchDigest !== first.batchDigest
      )
    ) throw new Error("NATIVE_OBSERVATION_CORRUPT");
    if (batch.length !== first.batchCount) continue;
    const ordered = [...batch].sort((a, b) => a.eventOrdinal - b.eventOrdinal);
    if (
      ordered.some((record, index) => record.eventOrdinal !== index) ||
      await nativeObservationBatchDigest({
          producerPhase: first.producerPhase,
          occurrenceId: first.occurrenceId,
          emissionStep: first.emissionStep,
          events: ordered.map((record) => record.event),
        }) !== first.batchDigest
    ) throw new Error("NATIVE_OBSERVATION_CORRUPT");
  }
}
