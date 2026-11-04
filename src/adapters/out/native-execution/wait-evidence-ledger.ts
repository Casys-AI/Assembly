/** Immutable typed receipts in the execution ensemble. All mutations receive the
 * caller's fenced SQL transaction, including the official saver's transaction. */
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { NativeExecutionRequest } from "../../../application/work/native-execution/contract.ts";
import type { PostgresRuntimeScope } from "../postgres/scope.ts";
import type { ExecutionSql } from "../postgres/execution-transaction.ts";
import {
  effectResultDigest,
  LEGACY_WAIT_PROTOCOL,
  type NativeWaitConsumptionEvidence,
  type NativeWaitEvidence,
  parseNativeWaitEvidence,
  TYPED_WAIT_PROTOCOL,
} from "../../../application/work/native-execution/wait-evidence.ts";
import {
  decodeLegacyCheckpointWait,
  legacyContributionConsumed,
  type OfficialCheckpointTuple,
} from "./checkpoint-wait-evidence.ts";

export interface WaitRun {
  runId?: unknown;
  checkpointNamespace?: unknown;
  checkpointId?: unknown;
  pinJson?: unknown;
  contributionId?: unknown;
}
const scoped = (
  scope: PostgresRuntimeScope,
  threadId: string,
) => [
  scope.projectId,
  scope.systemId,
  scope.executionSpaceId,
  scope.operatorId,
  threadId,
];
const where =
  '"projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4 AND "threadId"=$5';
export class ExecutionWaitEvidenceLedger {
  constructor(
    private readonly table: (
      name:
        | "ExecutionWaitProtocol"
        | "ExecutionWaitReceipt"
        | "ExecutionWaitConsumption"
        | "ExecutionRun"
        | "ExecutionEffect",
    ) => string,
    private readonly readTuple: (
      threadId: string,
      namespace: string,
      id: string,
    ) => Promise<OfficialCheckpointTuple | undefined>,
  ) {}
  async initialize(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    runId: string,
  ) {
    await query(
      `INSERT INTO ${
        this.table("ExecutionWaitProtocol")
      } ("projectId","systemId","executionSpaceId","operatorId","threadId","runId","protocol","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp())`,
      [...scoped(scope, threadId), runId, TYPED_WAIT_PROTOCOL],
    );
  }
  async protocol(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    runId: unknown,
  ) {
    const row = (await query(
      `SELECT "protocol" FROM ${
        this.table("ExecutionWaitProtocol")
      } WHERE ${where} AND "runId"=$6`,
      [...scoped(scope, threadId), runId],
    )).rows[0];
    if (
      !row ||
      ![TYPED_WAIT_PROTOCOL, LEGACY_WAIT_PROTOCOL].includes(
        String(row.protocol),
      )
    ) throw new Error("NATIVE_WAIT_PROTOCOL_MISSING_OR_INVALID");
    return String(row.protocol);
  }
  async appendWait(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    runId: string,
    namespace: string,
    id: string,
    pinJson: string,
    wait: NativeWaitEvidence,
    origin: "interrupt-v1" | "legacy-import-v0" | "fork-v1",
  ) {
    parseNativeWaitEvidence(wait);
    const values = [...scoped(scope, threadId), runId, namespace, id],
      json = canonical(wait);
    await query(
      `INSERT INTO ${
        this.table("ExecutionWaitReceipt")
      } ("projectId","systemId","executionSpaceId","operatorId","threadId","runId","checkpointNamespace","checkpointId","waitJson","pinJson","origin","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,clock_timestamp()) ON CONFLICT DO NOTHING`,
      [...values, json, pinJson, origin],
    );
    const row = (await query(
      `SELECT "waitJson","pinJson","origin" FROM ${
        this.table("ExecutionWaitReceipt")
      } WHERE ${where} AND "runId"=$6 AND "checkpointNamespace"=$7 AND "checkpointId"=$8`,
      values,
    )).rows[0];
    if (
      !row || row.waitJson !== json || row.pinJson !== pinJson ||
      row.origin !== origin
    ) {
      throw new Error("NATIVE_WAIT_RECEIPT_CONFLICT");
    }
  }
  async verifyEffect(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    wait: NativeWaitEvidence,
  ) {
    const effect = (await query(
      `SELECT "nodeId","status","resultJson" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${where} AND "effectKey"=$6`,
      [...scoped(scope, threadId), wait.effectKey],
    )).rows[0];
    if (wait.kind === "input") {
      if (
        effect ||
        wait.resultDigest !== await effectResultDigest({ suspend: true })
      ) throw new Error("NATIVE_WAIT_INPUT_ALREADY_CONSUMED_OR_INVALID");
    } else {
      if (
        !effect || effect.nodeId !== wait.actionId ||
        effect.status !== "completed" || typeof effect.resultJson !== "string"
      ) throw new Error("NATIVE_WAIT_SETTLED_EFFECT_MISMATCH");
      const result = JSON.parse(effect.resultJson);
      if (
        await effectResultDigest(result) !== wait.resultDigest ||
        (wait.kind === "technical-advance"
          ? canonical(result.modelAdvance) !== canonical(wait.evidence)
          : result.suspend !== true ||
            (result.suspensionKind === undefined
                ? "budget"
                : result.suspensionKind) !== wait.kind ||
            result.modelAdvance)
      ) throw new Error("NATIVE_WAIT_SETTLED_EFFECT_MISMATCH");
    }
  }

  async read(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    run: WaitRun,
    request: NativeExecutionRequest,
  ): Promise<NativeWaitEvidence> {
    if (!run.checkpointId) throw new Error("NATIVE_WAIT_EXACT_CURSOR_REQUIRED");
    const protocol = await this.protocol(query, scope, threadId, run.runId);
    const values = [
      ...scoped(scope, threadId),
      String(run.runId),
      String(run.checkpointNamespace),
      String(run.checkpointId),
    ];
    let row = (await query(
      `SELECT "waitJson","pinJson","origin" FROM ${
        this.table("ExecutionWaitReceipt")
      } WHERE ${where} AND "runId"=$6 AND "checkpointNamespace"=$7 AND "checkpointId"=$8`,
      values,
    )).rows[0];
    if (!row && protocol === LEGACY_WAIT_PROTOCOL) {
      // The exact cursor is locked before importing. Existing evidence is never rewritten.
      const current = (await query(
        `SELECT "checkpointNamespace","checkpointId","pinJson" FROM ${
          this.table("ExecutionRun")
        } WHERE ${where} AND "runId"=$6 FOR UPDATE`,
        values.slice(0, 6),
      )).rows[0];
      if (
        !current || current.checkpointNamespace !== run.checkpointNamespace ||
        current.checkpointId !== run.checkpointId
      ) throw new Error("NATIVE_WAIT_LEGACY_CURSOR_CHANGED");
      const tuple = await this.readTuple(
        threadId,
        String(run.checkpointNamespace),
        String(run.checkpointId),
      );
      if (!tuple) throw new Error("NATIVE_WAIT_LEGACY_CHECKPOINT_MISSING");
      const wait = await decodeLegacyCheckpointWait(protocol, tuple, request);
      if (!wait) throw new Error("NATIVE_WAIT_LEGACY_PROOF_MISSING");
      this.verifyIdentity(wait, request);
      await this.verifyEffect(query, scope, threadId, wait);
      await this.appendWait(
        query,
        scope,
        threadId,
        String(run.runId),
        String(run.checkpointNamespace),
        String(run.checkpointId),
        String(current.pinJson),
        wait,
        "legacy-import-v0",
      );
      row = {
        waitJson: canonical(wait),
        pinJson: current.pinJson,
        origin: "legacy-import-v0",
      };
    }
    if (!row || run.pinJson !== undefined && row.pinJson !== run.pinJson) {
      throw new Error("NATIVE_WAIT_MODERN_PROOF_MISSING_OR_MISMATCHED");
    }
    const wait = parseNativeWaitEvidence(JSON.parse(String(row.waitJson)));
    this.verifyIdentity(wait, request);
    if (row.origin !== "fork-v1") {
      await this.verifyEffect(query, scope, threadId, wait);
    }
    return wait;
  }
  verifyIdentity(wait: NativeWaitEvidence, request: NativeExecutionRequest) {
    const node = request.flow.nodes.find((node) => node.id === wait.nodeId);
    if (
      !node || node.nativeId !== wait.actionId ||
      (wait.kind === "input") !== (node.mechanism === "await_input") &&
        wait.kind !== "technical-advance" ||
      wait.operatorId !== request.identity.operatorId ||
      wait.rootRequestId !==
        (request.identity.scope.kind === "request"
          ? request.identity.scope.rootRequestId
          : undefined) ||
      canonical(wait.executionScope) !== canonical(request.identity.scope) ||
      canonical(wait.modelPin) !== canonical({
          identity: request.model.identity,
          version: request.model.version,
          rootNativeId: request.flow.rootNativeId,
          rootOccurrenceId: request.flow.rootOccurrenceId,
          ...(request.flow.executionProfile
            ? { executionProfile: request.flow.executionProfile }
            : {}),
        })
    ) throw new Error("NATIVE_WAIT_IDENTITY_OR_PIN_MISMATCH");
  }
  async consumed(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    run: WaitRun,
    contributionId: string,
  ): Promise<boolean> {
    const protocol = await this.protocol(query, scope, threadId, run.runId);
    const values = [...scoped(scope, threadId), run.runId, contributionId];
    const row = (await query(
      `WITH RECURSIVE lineage AS (
      SELECT "runId","predecessorRunId","contributionId",0 AS depth FROM ${
        this.table("ExecutionRun")
      } WHERE ${where} AND "runId"=$6
      UNION ALL SELECT r."runId",r."predecessorRunId",r."contributionId",l.depth+1 FROM ${
        this.table("ExecutionRun")
      } r JOIN lineage l ON r."runId"=l."predecessorRunId" WHERE r."projectId"=$1 AND r."systemId"=$2 AND r."executionSpaceId"=$3 AND r."operatorId"=$4 AND r."threadId"=$5 AND r."contributionId"=l."contributionId" AND l.depth<64
    ) SELECT c.* FROM ${
        this.table("ExecutionWaitConsumption")
      } c JOIN lineage l ON c."runId"=l."runId" WHERE c."projectId"=$1 AND c."systemId"=$2 AND c."executionSpaceId"=$3 AND c."operatorId"=$4 AND c."threadId"=$5 AND c."contributionId"=$7 ORDER BY l.depth LIMIT 1`,
      values,
    )).rows[0];
    if (row) {
      const proof = JSON.parse(
        String(row.consumptionJson),
      ) as NativeWaitConsumptionEvidence;
      if (
        proof.version !== 1 || proof.contributionId !== contributionId ||
        proof.kind !== row.kind || !["input-v1", "wait-v1"].includes(proof.kind)
      ) throw new Error("NATIVE_WAIT_CONSUMPTION_CORRUPT");
      if (proof.kind === "wait-v1") {
        const wait = parseNativeWaitEvidence(proof.wait);
        const source = (await query(
          `SELECT "waitJson" FROM ${
            this.table("ExecutionWaitReceipt")
          } WHERE ${where} AND "runId"=$6 AND "checkpointNamespace"=$7 AND "checkpointId"=$8`,
          [
            ...scoped(scope, threadId),
            row.sourceRunId,
            row.sourceCheckpointNamespace,
            row.sourceCheckpointId,
          ],
        )).rows[0];
        if (
          !source || source.waitJson !== canonical(wait) ||
          proof.sourceCheckpointId !== row.sourceCheckpointId
        ) throw new Error("NATIVE_WAIT_CONSUMPTION_SOURCE_CORRUPT");
      }
      return true;
    }
    if (protocol === TYPED_WAIT_PROTOCOL && run.checkpointId) {
      const ownWait = (await query(
        `SELECT "origin" FROM ${
          this.table("ExecutionWaitReceipt")
        } WHERE ${where} AND "runId"=$6 AND "checkpointNamespace"=$7 AND "checkpointId"=$8`,
        [
          ...scoped(scope, threadId),
          run.runId,
          run.checkpointNamespace,
          run.checkpointId,
        ],
      )).rows[0];
      if (ownWait?.origin === "interrupt-v1") {
        throw new Error("NATIVE_WAIT_MODERN_CONSUMPTION_PROOF_MISSING");
      }
    }
    if (protocol !== LEGACY_WAIT_PROTOCOL || !run.checkpointId) return false;
    const current = (await query(
      `SELECT "checkpointNamespace","checkpointId" FROM ${
        this.table("ExecutionRun")
      } WHERE ${where} AND "runId"=$6 FOR UPDATE`,
      [...scoped(scope, threadId), run.runId],
    )).rows[0];
    if (
      !current || current.checkpointNamespace !== run.checkpointNamespace ||
      current.checkpointId !== run.checkpointId
    ) throw new Error("NATIVE_WAIT_LEGACY_CURSOR_CHANGED");
    const tuple = await this.readTuple(
      threadId,
      String(run.checkpointNamespace),
      String(run.checkpointId),
    );
    if (!tuple) throw new Error("NATIVE_WAIT_LEGACY_CHECKPOINT_MISSING");
    if (!legacyContributionConsumed(protocol, tuple, contributionId)) {
      return false;
    }
    // Historical initial inputs have no source wait. This explicit compatibility
    // proof preserves old bytes and is never available to a modern run.
    await this.appendConsumption(
      query,
      scope,
      threadId,
      String(run.runId),
      String(run.checkpointNamespace),
      String(run.checkpointId),
      {
        version: 1,
        kind: "input-v1",
        contributionId,
        legacyProtocol: LEGACY_WAIT_PROTOCOL,
      } as NativeWaitConsumptionEvidence,
      undefined,
      "input-v1",
    );
    return true;
  }
  /** A wait is consumed only by its exact successor-commit receipt. The
   * original input's consumption and the proposal effect are separate facts. */
  async waitConsumed(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    run: WaitRun,
    wait: NativeWaitEvidence,
  ): Promise<boolean> {
    const row = (await query(
      `SELECT "consumptionJson" FROM ${
        this.table("ExecutionWaitConsumption")
      } WHERE ${where} AND "sourceRunId"=$6 AND "sourceCheckpointNamespace"=$7 AND "sourceCheckpointId"=$8`,
      [
        ...scoped(scope, threadId),
        run.runId,
        run.checkpointNamespace,
        run.checkpointId,
      ],
    )).rows[0];
    if (!row) return false;
    const proof = JSON.parse(
      String(row.consumptionJson),
    ) as NativeWaitConsumptionEvidence;
    if (
      proof.version !== 1 || proof.kind !== "wait-v1" ||
      proof.sourceCheckpointId !== run.checkpointId ||
      canonical(proof.wait) !== canonical(wait)
    ) throw new Error("NATIVE_WAIT_CONSUMPTION_SOURCE_CORRUPT");
    return true;
  }
  async appendConsumption(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    runId: string,
    namespace: string,
    id: string,
    proof: NativeWaitConsumptionEvidence,
    source?: { runId: string; namespace: string; id: string },
    kind = proof.kind,
  ) {
    const values = [...scoped(scope, threadId), runId, proof.contributionId],
      json = canonical(proof);
    await query(
      `INSERT INTO ${
        this.table("ExecutionWaitConsumption")
      } ("projectId","systemId","executionSpaceId","operatorId","threadId","runId","contributionId","kind","sourceRunId","sourceCheckpointNamespace","sourceCheckpointId","successorCheckpointNamespace","successorCheckpointId","consumptionJson","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,clock_timestamp()) ON CONFLICT DO NOTHING`,
      [
        ...values,
        kind,
        source?.runId ?? null,
        source?.namespace ?? null,
        source?.id ?? null,
        namespace,
        id,
        json,
      ],
    );
    const row = (await query(
      `SELECT "kind","sourceRunId","sourceCheckpointNamespace","sourceCheckpointId","successorCheckpointNamespace","successorCheckpointId","consumptionJson" FROM ${
        this.table("ExecutionWaitConsumption")
      } WHERE ${where} AND "runId"=$6 AND "contributionId"=$7`,
      values,
    )).rows[0];
    if (
      !row || row.kind !== kind || row.consumptionJson !== json ||
      row.sourceRunId !== (source?.runId ?? null) ||
      row.sourceCheckpointNamespace !== (source?.namespace ?? null) ||
      row.sourceCheckpointId !== (source?.id ?? null) ||
      row.successorCheckpointNamespace !== namespace ||
      row.successorCheckpointId !== id
    ) throw new Error("NATIVE_WAIT_CONSUMPTION_CONFLICT");
  }
  async commitConsumption(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    runId: string,
    namespace: string,
    id: string,
    proof: NativeWaitConsumptionEvidence,
  ) {
    let source: { runId: string; namespace: string; id: string } | undefined;
    if (proof.kind === "wait-v1") {
      const rows = (await query(
        `SELECT "runId","checkpointId","waitJson" FROM ${
          this.table("ExecutionWaitReceipt")
        } WHERE ${where} AND "checkpointNamespace"=$6 AND "checkpointId"=$7`,
        [...scoped(scope, threadId), namespace, proof.sourceCheckpointId],
      )).rows;
      const matching = rows.filter((row) =>
        row.waitJson === canonical(proof.wait)
      );
      if (matching.length !== 1) {
        throw new Error("NATIVE_WAIT_CONSUMPTION_SOURCE_MISSING_OR_AMBIGUOUS");
      }
      source = {
        runId: String(matching[0].runId),
        namespace,
        id: String(matching[0].checkpointId),
      };
    }
    await this.appendConsumption(
      query,
      scope,
      threadId,
      runId,
      namespace,
      id,
      proof,
      source,
    );
  }
}
