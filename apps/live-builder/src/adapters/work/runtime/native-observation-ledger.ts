/** Append-only native observation journal in the execution ensemble (R4b).
 * Every append runs in its own caller-owned SQL transaction under the exact
 * checkpoint fence, before the awaited business callback. It never joins the
 * queue-acceptance, effect or saver transactions, and records nothing that
 * grants authority, settles effects, proves consumption or permits a
 * continuation. */
import type { PostgresRuntimeScope } from "../../out/postgres/scope.ts";
import type { ExecutionSql } from "../../out/postgres/execution-transaction.ts";
import {
  assertNativeObservationEmission,
  compareNativeObservations,
  encodeNativeObservation,
  type NativeObservationEmission,
  type NativeObservationRecord,
  parseNativeObservationPayload,
  verifyNativeObservationBatches,
} from "./native-observation.ts";

/** Authenticated session facts. Event data cannot select any of these. */
export interface NativeObservationOwner {
  threadId: string;
  runId: string;
  checkpointNamespace: string;
  contributionId: string;
  identityJson: string;
  pinJson: string;
  epoch: bigint;
  jobId: string;
  retryCount: number;
}
const scoped = (scope: PostgresRuntimeScope, threadId: string) => [
  scope.projectId,
  scope.systemId,
  scope.executionSpaceId,
  scope.operatorId,
  threadId,
];
const where =
  '"projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 AND "threadId"=$5';
const COLUMNS =
  '"checkpointNamespace","producerPhase","occurrenceId","emissionStep","eventOrdinal","batchCount","batchDigest","contributionId","identityJson","pinJson","payloadJson","firstRecordedAt"';

function firstRecordedAt(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("NATIVE_OBSERVATION_CORRUPT");
  }
  return date.toISOString();
}
function record(row: Record<string, unknown>): NativeObservationRecord {
  const parsed = assertNativeObservationEmission({
    producerPhase: row
      .producerPhase as NativeObservationRecord["producerPhase"],
    occurrenceId: String(row.occurrenceId),
    emissionStep: Number(row.emissionStep),
    eventOrdinal: Number(row.eventOrdinal),
    batchCount: Number(row.batchCount),
    batchDigest: String(row.batchDigest),
    event: parseNativeObservationPayload(String(row.payloadJson)),
  });
  return { ...parsed, firstRecordedAt: firstRecordedAt(row.firstRecordedAt) };
}

export class ExecutionNativeObservationLedger {
  constructor(
    private readonly table: (name: "ExecutionNativeObservation") => string,
  ) {}

  /** First writer wins: identical key, payload, pin, owner and batch returns
   * the original record (including its provenance and firstRecordedAt); any
   * mismatch refuses and leaves the prior row immutable. Retry/epoch are a
   * fence check by the caller, never part of logical identity. */
  async append(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    owner: NativeObservationOwner,
    emission: NativeObservationEmission,
  ): Promise<NativeObservationRecord> {
    const checked = assertNativeObservationEmission(emission);
    if (checked.event.operatorId !== scope.operatorId) {
      throw new Error("NATIVE_OBSERVATION_OWNER_MISMATCH");
    }
    const payloadJson = encodeNativeObservation(checked.event);
    const key = [
      ...scoped(scope, owner.threadId),
      owner.runId,
      owner.checkpointNamespace,
      checked.producerPhase,
      checked.occurrenceId,
      checked.emissionStep,
      checked.eventOrdinal,
    ];
    await query(
      `INSERT INTO ${
        this.table("ExecutionNativeObservation")
      } ("projectId","systemId","executionSpaceId","operatorId","threadId","runId","checkpointNamespace","producerPhase","occurrenceId","emissionStep","eventOrdinal","batchCount","batchDigest","contributionId","identityJson","pinJson","payloadJson","epoch","jobId","retryCount","firstRecordedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,clock_timestamp()) ON CONFLICT DO NOTHING`,
      [
        ...key,
        checked.batchCount,
        checked.batchDigest,
        owner.contributionId,
        owner.identityJson,
        owner.pinJson,
        payloadJson,
        owner.epoch,
        owner.jobId,
        owner.retryCount,
      ],
    );
    const row = (await query(
      `SELECT ${COLUMNS} FROM ${
        this.table("ExecutionNativeObservation")
      } WHERE ${where} AND "runId"=$6 AND "checkpointNamespace"=$7 AND "producerPhase"=$8 AND "occurrenceId"=$9 AND "emissionStep"=$10 AND "eventOrdinal"=$11`,
      key,
    )).rows[0];
    if (
      !row || row.payloadJson !== payloadJson ||
      row.pinJson !== owner.pinJson ||
      row.identityJson !== owner.identityJson ||
      row.contributionId !== owner.contributionId ||
      Number(row.batchCount) !== checked.batchCount ||
      row.batchDigest !== checked.batchDigest
    ) throw new Error("NATIVE_OBSERVATION_CONFLICT");
    return record(row);
  }

  /** Only the requested run, in producer order (never storage time). No
   * business-event fallback and no ancestor or inherited-trace synthesis. */
  async read(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    runId: string,
  ): Promise<NativeObservationRecord[]> {
    const rows = (await query(
      `SELECT ${COLUMNS} FROM ${
        this.table("ExecutionNativeObservation")
      } WHERE ${where} AND "runId"=$6 ORDER BY "emissionStep", CASE "producerPhase" WHEN 'preparation' THEN 0 WHEN 'immutable-group-join' THEN 1 ELSE 2 END, "eventOrdinal"`,
      [...scoped(scope, threadId), runId],
    )).rows;
    const records = rows.map(record).sort(compareNativeObservations);
    await verifyNativeObservationBatches(records);
    return records;
  }
}
