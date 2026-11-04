import {
  assertChangeAdoptionClaim,
  assertChangeAdoptionPublication,
  assertOwnerInertSourceMarker,
  assertOwnerSuccessorAuthorizationHistory,
  assertOwnerSuccessorCommittedHistory,
  assertOwnerSuccessorCurrentPin,
  assertOwnerSuccessorSelection,
  changeAdoptionLineage,
  changeAdoptionRetirement,
  type NeverStartedAdoptionSource,
  ownerAdoptionChange,
  parseNeverStartedAdoptionSource,
  parseRequestNeverStartedSuccessorContext,
  type RequestNeverStartedSuccessorContext,
  verifyPriorNativeRetirementDigest,
} from "../../../application/work/evolution/native-adoption-successor.ts";
import {
  InitialAdmissionTransferRefused,
  verifyInitialAdmissionClaim,
  verifyInitialAdmissionEffect,
  verifyInitialAdmissionSourceSnapshot,
  verifyInitialAdmissionTransfer,
  verifyInitialAdmissionWait,
  verifySelectedInitialAdmissionTransfer,
} from "../../../application/work/runtime/initial-admission-transfer.ts";
import {
  type BudgetProposalCheckpoint,
  nativeScalarBudgetProposal,
  retainedBudgetAdvanceEvidence,
  scalarBudgetSourceRequest,
  verifyScalarBudgetFamily,
} from "../../../application/work/native-execution/native-budget-proposal.ts";
import {
  assertEvolutionRetirementAuthority,
  assertOwnerRetirementAuthority,
  assertRetirementHistoricalSource,
  assertRetirementSafety,
  assertScopedSoftwareRetirementAuthority,
} from "../../../application/work/evolution/native-retirement-authority.ts";
import {
  assertSoftwareInertSourceMarker,
  assertSoftwareSuccessorAuthorizationHistory,
  assertSoftwareSuccessorCommittedHistory,
  assertSoftwareSuccessorCurrentPin,
  assertSoftwareSuccessorSelection,
  parseScopedSoftwareNeverStartedSuccessorContext,
  type ScopedSoftwareNeverStartedSuccessorContext,
} from "../../../application/work/evolution/scoped-software-adoption-successor.ts";
import {
  assertAcceptedModelAdvance,
  assertCurrentModelAdvance,
  commandOwnApprovedAdvance,
  type NativeAdvanceRequest,
  nativeAdvanceSourceNode,
  rederiveSettledAdvanceEvidence,
  retainedConversationAdvanceEvidence,
  retainedDecisionAdvanceEvidence,
} from "../../../application/work/native-execution/model-advance.ts";
import {
  immutablePin,
  modelSourceReference,
  postgresExecutionThreadId,
} from "../../../application/work/native-execution/encodings.ts";
import {
  assertAcceptedArtifactPublication,
  assertArtifactOriginAction,
  assertArtifactOriginPin,
  assertArtifactOriginScope,
  assertCommandOriginAction,
  assertCommandOriginIdentity,
  assertCommandOriginInput,
  assertCompletedCommandOrigin,
  commandOriginPinMatches,
} from "../../../application/work/native-execution/origins.ts";
import {
  assertBusinessRevisionReference,
  assertBusinessRevisionState,
  recoverHistoricalRequest,
} from "../../../application/work/native-execution/history.ts";
import {
  assertCurrentScopeClosure,
  assertHistoricalScopeClosure,
} from "../../../application/work/native-execution/scope-closure.ts";
import { nativeFrameworkNodeName } from "../../../application/work/native-execution/framework-node-name.ts";
import { persistedOrder } from "../../../domain/primitives/persisted-order.ts";
import { parseScopedSoftwareDossier } from "../../../application/model/evolution/scoped-software-dossier.ts";
import { lockRetirementJobReceipts } from "./retirement-job-receipts.ts";
import { ExecutionWaitEvidenceLedger } from "./wait-evidence-ledger.ts";
import {
  type NativeContinuationReceipt,
  type NativeExecutionActionResult,
  NativeExecutionAdmissionRefused,
  type NativeExecutionIdentity,
  type NativeExecutionRequest,
  type NativeExecutionSelection,
  type NativeExecutionSnapshot,
  type NativeModelAdvanceEvidence,
  type NativeObservationJournal,
  type NativeScopeClosure,
  type NativeThreadAdvanceAuthorization,
  parseRequestNetworkContinuation,
  parseRequestNetworkRefusalContinuation,
  type RuntimeRevisionReference,
} from "../../../application/work/native-execution/contract.ts";
import { ExecutionNativeObservationLedger } from "./native-observation-ledger.ts";
import { assertNativeObservationBinding } from "../../../domain/model/execution/native-observation.ts";
import {
  budgetSourceFromWait,
  effectResultDigest,
  type NativeWaitConsumptionEvidence,
  type NativeWaitEvidence,
} from "../../../application/work/native-execution/wait-evidence.ts";
import {
  captureOfficialCheckpointRows,
  checkpointConsumptions,
  checkpointInterruptEvidence,
  verifyOfficialFork,
  verifyOfficialWaitCheckpoint,
} from "./checkpoint-wait-evidence.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces/scope.ts";
import { providerCallContext } from "../llm-providers/provider-call-context.ts";
import {
  postgresClientSchema,
  type Prisma,
  type PrismaClient,
} from "../postgres/client.ts";
import type { CompiledFlowNode } from "../../../domain/model/execution/flow.ts";
import type { SpaceEffectStartProof } from "../postgres/request-space-control-store.ts";
import { PostgresRequestSourceAdmissionStore } from "../postgres/request-source-admission-store.ts";
import { decodeRequestSpaceOpening } from "../postgres/request-space-store.ts";
import {
  readRequestCreationPolicySourceAdmissionProof,
  readRequestNetworkSourceAdmissionProof,
  readRequestTeamSourceAdmissionProof,
} from "../postgres/request-source-publication-participant.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import { fromPrisma, type Job } from "pg-boss";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RunnableConfig } from "@langchain/core/runnables";
import type {
  BaseCheckpointSaver,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  executionDigest,
  sha256,
} from "../../../domain/primitives/execution-digest.ts";
import {
  assertNoOpenImmutableConsultationGroups,
  createPostgresImmutableConsultationSession,
} from "./immutable-consultation-ledger.ts";
import { decidedByNetworkAuthority } from "../../../domain/governance/records/request-network-change.ts";
import {
  decidedByTeamAuthority,
  requestChangeProposalDigest,
} from "../../../domain/governance/records/request-change.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "../../../application/work/runtime/state.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { verifyScalarBudgetCandidate } from "../../../application/work/runtime/budget-transition.ts";
import {
  budgetState,
  type WorkBudgetRecord,
} from "../../../domain/work/policies/budget.ts";
import { exactNativeChangeApprovalWait } from "../../../application/work/runtime/evolution.ts";
import { parseRequestOwnerAdoptionDossier } from "../../../application/model/evolution/request-adoption-invariants.ts";
import type {
  BudgetCeilingManifest,
  BudgetCeilingMember,
} from "../../../application/work/runtime/budget-ceiling-transition.ts";
import { invocationKey } from "../../../application/work/operators/journal.ts";
import { assertEvolutionDossier } from "../../../application/model/evolution/invariants.ts";
import type { EvolutionDossier } from "../../../application/model/evolution/ports.ts";
import type { QueuedArtifactSourcePublication } from "../../../domain/work/artifacts/source-publication.ts";
import { decodeRuntimeSnapshotPayload } from "../postgres/runtime-snapshot-codec.ts";
import { assertRuntimeState } from "../postgres/runtime-state-snapshot.ts";
import { compileNativeOperatorGraph } from "./native-graph.ts";
import type {
  OperatorExecutionCommandOrigin,
  OperatorExecutionDelivery,
} from "../../../application/work/operators/execution.ts";
import { parseAcceptedCommand } from "../../../application/work/operators/command-delivery.ts";
import type {
  PostgresRuntimeScope,
  PostgresSystemScope,
} from "../postgres/scope.ts";
import type {
  NativeExecutionLedger,
  NativeExecutionSession,
} from "./conversation.ts";
import {
  currentPostgresExecutionTransaction,
  type ExecutionSql,
  postgresExecutionTransaction,
  withPostgresExecutionTransaction,
} from "../postgres/execution-transaction.ts";

/** Dedicated execution metadata. Canonical business state stays in its stores;
 * checkpoint bytes, serialization and migrations stay in the official saver. */

export interface PostgresOperatorJob {
  runtimeScope: PostgresSystemScope & { executionSpaceId: string };
  delivery: OperatorExecutionDelivery;
  threadId: string;
}
interface Claim {
  job: Job<PostgresOperatorJob>;
  delivery: OperatorExecutionDelivery;
}
interface SessionRecord {
  scope: PostgresRuntimeScope;
  threadId: string;
  identityDigest: string;
  runId: string;
  namespace: string;
  epoch: bigint;
  jobId: string;
  retryCount: number;
  checkpointId: string | null;
  request: NativeExecutionRequest;
  signal: AbortSignal;
  parentFence?: (query: ExecutionSql) => Promise<void>;
  ownsDelivery: boolean;
  beforeInputAdvance?: AdvanceRequest & { mode: "retained-wait" };
  forceResumeWait?: boolean;
  selectedBudgetContinuation?: NativeContinuationReceipt;
}
type AdvanceRequest = NativeAdvanceRequest;
type NativeFork = (
  saver: BaseCheckpointSaver,
  config: LangGraphRunnableConfig,
  sourceProtocol?: string,
) => Promise<LangGraphRunnableConfig>;
/** Composition-only final guard. Ordinary concrete native admission runs first. */
export type PostgresSpaceEffectStartGuard = (
  tx: Prisma.TransactionClient,
  input: {
    scope: PostgresRuntimeScope;
    request: NativeExecutionRequest;
    node: CompiledFlowNode;
    target?:
      import("../../../application/work/native-execution/contract.ts").NativeEffectTarget;
  },
) => Promise<SpaceEffectStartProof>;
export interface PostgresExecutionLedgerOptions {
  client: PrismaClient;
  lookupRetirementJob?:
    import("./retirement-job-receipts.ts").RetirementJobLookup;
  spaceEffectStart?: PostgresSpaceEffectStartGuard;
  /** Same-transaction current control/admission/pin and nonlocking scoped barrier
   * check. Replay returns precede this fresh-acceptance guard. */
  acceptDeliveryInTransaction?: (tx: Prisma.TransactionClient, input: {
    identity: NativeExecutionIdentity;
    scope: PostgresRuntimeScope;
    modelPin: OperatorExecutionDelivery["modelPin"];
    phase: "before-share" | "after-share";
  }) => Promise<void>;
  scope: PostgresSystemScope & { executionSpaceId: string };
  queueSchema: string;
  queueName: string;
  checkpointPool: Pool;
  checkpointSchema: string;
  /** Disposable qualification seam; faults surround the OFFICIAL commit. */
  waitEvidenceFault?: (
    phase:
      | "before-interrupt-commit"
      | "after-interrupt-commit"
      | "before-consumption-commit"
      | "after-consumption-commit",
  ) => void | Promise<void>;
  initialAdmissionFault?: (
    phase:
      | "before-fork"
      | "after-fork"
      | "before-selection"
      | "after-selection",
  ) => void | Promise<void>;
}
const scopedValues = (
  scope: PostgresRuntimeScope,
) => [
  scope.projectId,
  scope.systemId,
  scope.executionSpaceId,
  scope.operatorId,
];
const scopeWhere =
  `"projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "operatorId"=$4`;
function sqlIdentifier(value: string) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Invalid execution schema");
  }
  return `"${value}"`;
}
export { postgresExecutionThreadId } from "../../../application/work/native-execution/encodings.ts";
function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

interface PreparedNeverStartedSuccessor {
  scope: PostgresRuntimeScope;
  identity: NativeExecutionIdentity;
  identityJson: string;
  identityDigest: string;
  threadId: string;
  rowJson: string;
  bindingJson: string;
  bindingRevision: string;
  authorizationJson: string;
  targetPin: string;
  context:
    | RequestNeverStartedSuccessorContext
    | ScopedSoftwareNeverStartedSuccessorContext;
}

export class PostgresNativeExecutionLedger implements NativeExecutionLedger {
  readonly #claim = new AsyncLocalStorage<Claim>();
  readonly #transferAuthorization = Symbol("initial-admission");
  readonly #sessionRecords = new WeakMap<
    NativeExecutionSession,
    SessionRecord
  >();
  readonly waitEvidence: ExecutionWaitEvidenceLedger;
  readonly nativeObservations: ExecutionNativeObservationLedger;
  readonly #schema: string;
  readonly #queueSchema: string;
  constructor(readonly options: PostgresExecutionLedgerOptions) {
    this.options = {
      ...options,
      scope: Object.freeze({
        projectId: options.scope.projectId,
        systemId: options.scope.systemId,
        executionSpaceId: options.scope.executionSpaceId,
      }),
    };
    this.#schema = sqlIdentifier(postgresClientSchema(options.client));
    this.#queueSchema = sqlIdentifier(options.queueSchema);
    sqlIdentifier(options.checkpointSchema);
    this.nativeObservations = new ExecutionNativeObservationLedger(
      (name) => this.table(name),
    );
    this.waitEvidence = new ExecutionWaitEvidenceLedger(
      (name) => this.table(name),
      (threadId, namespace, id) =>
        new PostgresSaver(this.options.checkpointPool, undefined, {
          schema: this.options.checkpointSchema,
        }).getTuple({
          configurable: {
            thread_id: threadId,
            checkpoint_ns: namespace,
            checkpoint_id: id,
          },
        }),
    );
  }
  get client() {
    return this.options.client;
  }
  table(
    name:
      | "OperatorRuntime"
      | "OperatorExecution"
      | "ExecutionWaitProtocol"
      | "ExecutionWaitReceipt"
      | "ExecutionWaitConsumption"
      | "ExecutionNativeObservation"
      | "ExecutionRun"
      | "ExecutionContribution"
      | "ExecutionEffect"
      | "ImmutableConsultationGroup"
      | "ExecutionThreadBinding"
      | "NativeContinuationReceipt"
      | "InitialAdmissionTransferReceipt",
  ) {
    return `${this.#schema}."${name}"`;
  }
  scope(
    identity: Pick<NativeExecutionIdentity, "operatorId">,
  ): PostgresRuntimeScope {
    return { ...this.options.scope, operatorId: identity.operatorId };
  }
  private assertNoOpenGroups(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
  ) {
    return assertNoOpenImmutableConsultationGroups(
      query,
      this.table("ImmutableConsultationGroup"),
      [...scopedValues(scope), threadId],
    );
  }
  async withClaim<T>(
    job: Job<PostgresOperatorJob>,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (
      canonical(job.data.runtimeScope) !== canonical(this.options.scope) ||
      !job.data.delivery?.id || !job.data.delivery.identity.operatorId
    ) throw new Error("Invalid operator delivery claim scope");
    return await this.#claim.run(
      { job, delivery: job.data.delivery },
      () =>
        withPostgresExecutionTransaction({
          client: this.client,
          fence: async (query) => {
            await this.lockClaim(query, job);
          },
        }, operation),
    );
  }
  currentClaim() {
    return this.#claim.getStore();
  }
  /** Retained source is not tool activation. An expired/unknown native producer
   * can only anchor its ALREADY ACCEPTED exact W4 subcommand; it is never replayed
   * or relabelled complete here. The runtime separately rechecks current grants. */
  async assertArtifactSourceOrigin(
    publication: QueuedArtifactSourcePublication,
  ): Promise<void> {
    assertArtifactOriginScope(this.options.scope, publication);
    const target = publication.target;
    const scope = this.scope({ operatorId: target.operatorId });
    // This READ-ONLY origin check also runs in the independently leased W4
    // worker. Do not inherit an expired producer's ambient native write fence.
    // Initial issuance below still requires the actual live source claim.
    await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      const effects = await query(
        `SELECT * FROM ${
          this.table("ExecutionEffect")
        } WHERE ${scopeWhere} AND "effectKey"=$5 LIMIT 2`,
        [...scopedValues(scope), target.invocationId],
      );
      if (effects.rows.length !== 1) {
        throw new Error(
          "Artifact source has no unique actual native effect origin",
        );
      }
      const effect = effects.rows[0];
      if (
        !["started", "completed", "unknown"].includes(String(effect.status))
      ) throw new Error("Artifact source native origin was not issued");
      const run = (await query(
        `SELECT * FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...scopedValues(scope), effect.threadId, effect.runId],
      )).rows[0];
      if (!run) throw new Error("Artifact source native run is unavailable");
      const pin = JSON.parse(String(run.pinJson));
      assertArtifactOriginPin(publication, pin);
      const historical = await this.businessRevision(
        query,
        scope,
        this.runSource(run).businessRevision,
      );
      assertArtifactOriginAction(publication, historical, pin, effect.nodeId);
      const commands = await query(
        `SELECT command_json AS "commandJson",dossier_json AS "dossierJson",command_digest AS "commandDigest",dossier_digest AS "dossierDigest",state FROM ${this.#schema}."ModelWriteCommand" WHERE project_id=$1 AND system_id=$2 AND command_id=$3 LIMIT 2`,
        [scope.projectId, scope.systemId, publication.publicationId],
      );
      if (commands.rows.length > 1) {
        throw new Error("Artifact source accepted W4 intent is ambiguous");
      }
      if (commands.rows.length === 1) {
        const command = commands.rows[0];
        await assertAcceptedArtifactPublication(publication, command);
        return;
      }
      if (effect.status !== "started") {
        throw new Error(
          "Expired or settled artifact producer has no exact preaccepted W4 intent",
        );
      }
      const liveClaim = this.#claim.getStore()?.job;
      await this.lockClaim(query, {
        id: String(effect.jobId),
        retryCount: Number(effect.retryCount),
        ...(liveClaim && liveClaim.id === effect.jobId &&
            liveClaim.retryCount === effect.retryCount
          ? { signal: liveClaim.signal }
          : {}),
      });
      const thread = (await query(
        `SELECT "identityJson","epoch","currentRunId","currentJobId","currentRetry","retiredAt" FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5 FOR UPDATE`,
        [...scopedValues(scope), effect.threadId],
      )).rows[0];
      if (
        !thread || thread.retiredAt ||
        BigInt(thread.epoch as bigint) !== BigInt(effect.epoch as bigint) ||
        thread.currentRunId !== effect.runId ||
        thread.currentJobId !== effect.jobId ||
        thread.currentRetry !== effect.retryCount
      ) {
        throw new Error(
          "Artifact proposal no longer holds its original native execution claim",
        );
      }
      const identity = JSON.parse(
        String(thread.identityJson),
      ) as NativeExecutionIdentity;
      const binding = (await query(
        `SELECT "activeThreadId" FROM ${
          this.table("ExecutionThreadBinding")
        } WHERE ${scopeWhere} AND "identityDigest"=$5`,
        [...scopedValues(scope), await executionDigest(identity)],
      )).rows[0];
      if (binding?.activeThreadId !== effect.threadId) {
        throw new Error("Artifact proposal belongs to a retired native thread");
      }
    });
  }
  /** This proves a native execution origin, not the authority of its requested
   * command. The host must still resolve/revalidate the canonical source grant. */
  async assertCommandOrigin(
    origin: OperatorExecutionCommandOrigin,
  ): Promise<void> {
    const operatorId = origin.businessRevision.__assemblyRuntimeRevision
      ?.operatorId;
    if (!operatorId || !origin.effectKey || !origin.inputMessageId) {
      throw new Error("Native command origin is incomplete");
    }
    const scope = this.scope({ operatorId });
    await postgresExecutionTransaction(this.client, async (tx) => {
      const query = fromPrisma(tx).executeSql;
      const state = await this.businessRevision(
        query,
        scope,
        origin.businessRevision,
      );
      assertCommandOriginInput(state, origin);
      const effects = await query(
        `SELECT * FROM ${
          this.table("ExecutionEffect")
        } WHERE ${scopeWhere} AND "effectKey"=$5 LIMIT 2`,
        [...scopedValues(scope), origin.effectKey],
      );
      if (effects.rows.length !== 1) {
        throw new Error(
          "Native command origin effect is unavailable or ambiguous",
        );
      }
      const effect = effects.rows[0];
      if (effect.status !== "started" && effect.status !== "completed") {
        throw new Error("Native command origin has an uncertain effect");
      }
      const run = (await query(
        `SELECT * FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...scopedValues(scope), effect.threadId, effect.runId],
      )).rows[0];
      const thread = (await query(
        `SELECT "identityJson","epoch","currentRunId","currentJobId","currentRetry","retiredAt" FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5`,
        [...scopedValues(scope), effect.threadId],
      )).rows[0];
      if (
        !run || !thread || !state.executionModel ||
        !commandOriginPinMatches(
          state.executionModel,
          JSON.parse(String(run.pinJson)).version,
        )
      ) {
        throw new Error(
          "Native command origin source pin differs from its immutable business revision",
        );
      }
      const identity = JSON.parse(
        String(thread.identityJson),
      ) as NativeExecutionIdentity;
      assertCommandOriginIdentity(state, origin, identity);
      const historical = await this.businessRevision(
        query,
        scope,
        this.runSource(run).businessRevision,
      );
      assertCommandOriginAction(historical, origin, effect.nodeId);
      if (effect.status === "completed") {
        if (typeof effect.resultJson !== "string") {
          throw new Error(
            "Completed native command origin has no exact result receipt",
          );
        }
        const result = JSON.parse(
          effect.resultJson,
        ) as NativeExecutionActionResult;
        assertCompletedCommandOrigin(result);
      } else {
        await this.lockClaim(query, {
          id: String(effect.jobId),
          retryCount: Number(effect.retryCount),
        });
        const binding = (await query(
          `SELECT "activeThreadId" FROM ${
            this.table("ExecutionThreadBinding")
          } WHERE ${scopeWhere} AND "identityDigest"=$5 FOR UPDATE`,
          [...scopedValues(scope), await executionDigest(identity)],
        )).rows[0];
        if (
          binding?.activeThreadId !== effect.threadId || thread.retiredAt ||
          BigInt(thread.epoch as bigint) !== BigInt(effect.epoch as bigint) ||
          thread.currentRunId !== effect.runId ||
          thread.currentJobId !== effect.jobId ||
          thread.currentRetry !== effect.retryCount
        ) {
          throw new Error(
            "Started native command origin no longer holds its actual execution claim",
          );
        }
      }
    });
  }
  private decodeBusiness(payload: unknown): SystemRuntimeState {
    if (typeof payload !== "string") {
      throw new Error("Canonical business revision is unavailable");
    }
    const state: unknown = JSON.parse(decodeRuntimeSnapshotPayload(payload));
    assertRuntimeState(state);
    return state;
  }
  private runSource(run: Record<string, unknown>) {
    if (typeof run.modelReferenceJson !== "string") {
      throw new Error("Native run has no exact model source reference");
    }
    const source = JSON.parse(run.modelReferenceJson) as {
      businessRevision: RuntimeRevisionReference;
      contribution: NativeExecutionRequest["contribution"];
    };
    if (
      !source.businessRevision?.__assemblyRuntimeRevision ||
      source.contribution?.id !== run.contributionId ||
      !["input", "resume"].includes(source.contribution.kind)
    ) throw new Error("Corrupt native run model/contribution source reference");
    return source;
  }
  private async businessRevision(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    reference: RuntimeRevisionReference,
  ) {
    const ref = assertBusinessRevisionReference(scope.operatorId, reference);
    const row = (await query(
      `SELECT "payload" FROM ${this.#schema}."RuntimeRevision" WHERE ${scopeWhere} AND "revision"=$5`,
      [...scopedValues(scope), BigInt(ref.revision)],
    )).rows[0];
    const state = this.decodeBusiness(row?.payload);
    assertBusinessRevisionState(ref, state);
    return state;
  }
  /** A post-approve dialogue tolerates only its command's own verified advance:
   * an approved change or the exact candidate publication checked below.
   * Command-time pins and immutable source history remain mandatory; any other
   * drift returns false and keeps the early delivery-pin refusal. */
  private commandOwnApprovedAdvance(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    delivery: OperatorExecutionDelivery,
    request: NativeExecutionRequest,
    predecessorRun?: Record<string, unknown>,
  ): Promise<boolean> {
    return commandOwnApprovedAdvance(scope.operatorId, delivery, request, {
      hasPredecessorSnapshot: !!predecessorRun &&
        typeof predecessorRun.snapshotJson === "string",
      predecessorSnapshot: () =>
        JSON.parse(
          predecessorRun!.snapshotJson as string,
        ) as NativeExecutionSnapshot,
      predecessorRequest: () =>
        this.recoverRequest(query, scope, predecessorRun!, request),
      businessRevision: (reference) =>
        this.businessRevision(query, scope, reference),
    });
  }
  private async currentBusiness(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
  ) {
    const row = (await query(
      `SELECT "payload" FROM ${this.#schema}."RuntimeState" WHERE ${scopeWhere} FOR SHARE`,
      scopedValues(scope),
    )).rows[0];
    return this.decodeBusiness(row?.payload);
  }
  private async recoverRequest(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    run: Record<string, unknown>,
    submitted: NativeExecutionRequest,
  ): Promise<NativeExecutionRequest> {
    if (
      typeof run.modelReferenceJson !== "string" ||
      typeof run.pinJson !== "string"
    ) {
      throw new Error(
        "Native run lacks its immutable model revision reference",
      );
    }
    const source = this.runSource(run), reference = source.businessRevision;
    const historical = await this.businessRevision(query, scope, reference);
    return recoverHistoricalRequest(submitted, source, historical, run.pinJson);
  }
  private async verifyRunLineage(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    selected: Record<string, unknown>,
    base: Record<string, unknown>,
    delivery: OperatorExecutionDelivery,
  ) {
    let cursor = selected;
    let cursorThread = threadId, reachedBase = false;
    for (let count = 0; count < 64; count++) {
      if (cursor.runId === base.runId && cursorThread === threadId) {
        reachedBase = true;
      }
      const pin = JSON.parse(String(cursor.pinJson));
      if (
        reachedBase && pin.version.digest === delivery.modelPin.modelDigest &&
        pin.version.repositoryVersion === delivery.modelPin.repositoryVersion
      ) return;
      const receipt = (await query(
        `SELECT * FROM ${
          this.table("NativeContinuationReceipt")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "successorRunId"=$6 AND "status"='selected'`,
        [...scopedValues(scope), cursorThread, cursor.runId],
      )).rows[0];
      let prior: Record<string, unknown> | undefined;
      if (receipt && receipt.targetPinJson === cursor.pinJson) {
        prior = (await query(
          `SELECT * FROM ${
            this.table("ExecutionRun")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
          [...scopedValues(scope), cursorThread, receipt.predecessorRunId],
        )).rows[0];
        if (prior?.contributionId !== cursor.contributionId) {
          throw new Error(
            "Native continuation changed its source contribution",
          );
        }
      } else if (reachedBase && cursor.parentThreadId && cursor.parentRunId) {
        cursorThread = String(cursor.parentThreadId);
        prior = (await query(
          `SELECT * FROM ${
            this.table("ExecutionRun")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
          [...scopedValues(scope), cursorThread, cursor.parentRunId],
        )).rows[0];
        if (prior?.jobId !== selected.jobId) {
          throw new Error(
            "Nested native run is not bound to the same claimed delivery",
          );
        }
      }
      if (!prior) {
        throw new Error("Native continuation predecessor is unavailable");
      }
      cursor = prior;
    }
    throw new Error("Native continuation lineage exceeds its bounded read");
  }
  /** First enrollment is explicit. Existing identities resolve only their
   * durable selected binding; a retired thread is never reactively revived. */
  async resolveThread(
    query: ExecutionSql,
    identity: NativeExecutionIdentity,
    initialPin: OperatorExecutionDelivery["modelPin"],
    allowTerminalContributionId?: string,
  ) {
    const scope = this.scope(identity), values = scopedValues(scope);
    const identityJson = canonical(identity),
      identityDigest = await executionDigest(identity);
    let binding = (await query(
      `SELECT * FROM ${
        this.table("ExecutionThreadBinding")
      } WHERE ${scopeWhere} AND "identityDigest"=$5 FOR UPDATE`,
      [...values, identityDigest],
    )).rows[0];
    if (!binding) {
      const threadId = await postgresExecutionThreadId(
        this.options.scope,
        identity,
      );
      await query(
        `INSERT INTO ${
          this.table("OperatorExecution")
        } ("projectId","systemId","executionSpaceId","operatorId","threadId","identityJson","scopeKind","scopeId","rootRequestId","ownerId","purpose","subjectId","revision","epoch","status","checkpointNamespace","authorizedPinJson","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,'queued','',$13,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`,
        [
          ...values,
          threadId,
          identityJson,
          identity.scope.kind,
          identity.scope.scopeId,
          identity.scope.kind === "request"
            ? identity.scope.rootRequestId
            : null,
          identity.scope.kind === "designer" ? identity.scope.ownerId : null,
          identity.purpose,
          identity.subjectId ?? null,
          canonical(initialPin),
        ],
      );
      await query(
        `INSERT INTO ${
          this.table("ExecutionThreadBinding")
        } ("projectId","systemId","executionSpaceId","operatorId","identityDigest","identityJson","activeThreadId","revision","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,0,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`,
        [...values, identityDigest, identityJson, threadId],
      );
      binding = (await query(
        `SELECT * FROM ${
          this.table("ExecutionThreadBinding")
        } WHERE ${scopeWhere} AND "identityDigest"=$5 FOR UPDATE`,
        [...values, identityDigest],
      )).rows[0];
    }
    if (!binding || binding.identityJson !== identityJson) {
      throw new Error("Execution identity binding mismatch");
    }
    const threadId = String(binding.activeThreadId);
    const row = (await query(
      `SELECT * FROM ${
        this.table("OperatorExecution")
      } WHERE ${scopeWhere} AND "threadId"=$5 FOR UPDATE`,
      [...values, threadId],
    )).rows[0];
    if (!row || row.identityJson !== identityJson) {
      throw new Error("Execution binding selects a different identity");
    }
    if (row.retiredAt) {
      const terminal = typeof row.terminalReceiptJson === "string"
        ? JSON.parse(row.terminalReceiptJson) as {
          snapshot: NativeExecutionSnapshot;
        }
        : undefined;
      if (
        terminal && allowTerminalContributionId &&
        terminal.snapshot.contributionId === allowTerminalContributionId &&
        terminal.snapshot.status === "completed" &&
        canonical(terminal.snapshot.identity) === identityJson
      ) {
        return {
          threadId,
          identityDigest,
          row,
          terminalSnapshot: terminal.snapshot,
        };
      }
      throw new Error("Execution binding selects a retired identity");
    }
    return { threadId, identityDigest, row };
  }
  async lockClaim(
    query: ExecutionSql,
    claim: Pick<Job, "id" | "retryCount"> & { signal?: AbortSignal },
  ) {
    claim.signal?.throwIfAborted();
    await query(
      `SELECT id FROM ${this.#queueSchema}.job WHERE name=$1 AND id=$2::uuid FOR UPDATE`,
      [this.options.queueName, claim.id],
    );
    const { rows } = await query(
      `SELECT state::text, retry_count,
      started_on + expire_seconds * interval '1 second' > clock_timestamp() AS live,
      (heartbeat_seconds IS NULL OR heartbeat_on + heartbeat_seconds * interval '1 second' > clock_timestamp()) AS heartbeat_live
      FROM ${this.#queueSchema}.job WHERE name=$1 AND id=$2::uuid`,
      [this.options.queueName, claim.id],
    );
    const row = rows[0];
    if (
      !row || row.state !== "active" || row.retry_count !== claim.retryCount ||
      !row.live || !row.heartbeat_live
    ) throw new Error("STALE_EXECUTION_CLAIM");
  }
  async fence(query: ExecutionSql, session: SessionRecord) {
    await session.parentFence?.(query);
    await this.lockClaim(query, {
      id: session.jobId,
      retryCount: session.retryCount,
      signal: session.signal,
    });
    const binding = (await query(
      `SELECT "activeThreadId" FROM ${
        this.table("ExecutionThreadBinding")
      } WHERE ${scopeWhere} AND "identityDigest"=$5 FOR UPDATE`,
      [...scopedValues(session.scope), session.identityDigest],
    )).rows[0];
    if (!binding || binding.activeThreadId !== session.threadId) {
      throw new Error("STALE_EXECUTION_THREAD_BINDING");
    }
    const { rows } = await query(
      `SELECT "epoch", "currentRunId", "currentJobId", "currentRetry", "retiredAt"
      FROM ${
        this.table("OperatorExecution")
      } WHERE ${scopeWhere} AND "threadId"=$5 FOR UPDATE`,
      [...scopedValues(session.scope), session.threadId],
    );
    const row = rows[0];
    if (
      !row || row.retiredAt || BigInt(row.epoch as bigint) !== session.epoch ||
      row.currentRunId !== session.runId ||
      row.currentJobId !== session.jobId ||
      row.currentRetry !== session.retryCount
    ) throw new Error("STALE_EXECUTION_EPOCH");
  }

  private async retainedWaitAdvance(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    run: Record<string, unknown>,
    incoming: NativeExecutionRequest,
    claimedWait = false,
  ) {
    await this.assertNoOpenGroups(query, scope, threadId);
    if (
      incoming.contribution.kind !== "resume" ||
      !(run.status === "waiting" ||
        claimedWait && ["running", "failed"].includes(String(run.status))) ||
      typeof run.snapshotJson !== "string" || !run.checkpointId
    ) {
      throw new Error(
        "A changed pin cannot replace an active or unproved native wait",
      );
    }
    const snapshot = JSON.parse(run.snapshotJson) as NativeExecutionSnapshot;
    if (
      snapshot.threadId !== threadId || snapshot.status !== "waiting" ||
      snapshot.unsettledEffects.length
    ) {
      throw new Error(
        "The immediate native predecessor is not a settled native wait",
      );
    }
    const sourceRequest = await this.recoverRequest(
      query,
      scope,
      run,
      incoming,
    );
    const current = await this.businessRevision(
      query,
      scope,
      incoming.businessRevision,
    );
    if (
      current.budgetCeilingTransition?.phase === "adopted-continuations-pending"
    ) {
      return await this.retainedBudgetAdvance(
        query,
        scope,
        threadId,
        run,
        incoming,
        snapshot,
        sourceRequest,
        current,
      );
    }
    if (incoming.identity.purpose === "conversation") {
      return await this.retainedConversationAdvance(
        query,
        scope,
        threadId,
        run,
        incoming,
        snapshot,
        sourceRequest,
        current,
      );
    }
    const evidence = await retainedDecisionAdvanceEvidence(
      threadId,
      incoming,
      snapshot,
      sourceRequest,
      current,
    );
    const wait = await this.waitEvidence.read(
      query,
      scope,
      threadId,
      run,
      sourceRequest,
    );
    const node = sourceRequest.flow.nodes.find((entry) =>
      entry.id === wait.nodeId
    );
    if (!node || wait.kind !== "decision") {
      throw new Error(
        "The selected source receipt no longer retains the genuine decision wait",
      );
    }
    const source: NativeContinuationReceipt["source"] = {
      threadId,
      checkpointNamespace: String(run.checkpointNamespace),
      checkpointId: String(run.checkpointId),
      preparedNodeId: nativeFrameworkNodeName(node.id, "await-preparation"),
      settledEffectKey: wait.effectKey,
    };
    const effect = (await query(
      `SELECT "runId","status","resultJson" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
      [...scopedValues(scope), threadId, source.settledEffectKey],
    )).rows[0];
    if (
      !effect || effect.runId !== run.runId || effect.status !== "completed" ||
      typeof effect.resultJson !== "string"
    ) {
      throw new Error(
        "The prepared decision wait lacks its actual settled source effect",
      );
    }
    const { localState: _localState, ...preparedResult } = JSON.parse(
      effect.resultJson,
    ) as NativeExecutionActionResult;
    if (await effectResultDigest(preparedResult) !== wait.resultDigest) {
      throw new Error(
        "The retained decision wait differs from its exact settled source result",
      );
    }
    const unknown = await query(
      `SELECT "effectKey" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' LIMIT 1`,
      [...scopedValues(scope), threadId],
    );
    if (unknown.rows.length) {
      throw new Error(
        "Unsettled effects block retained decision-wait continuation",
      );
    }
    return {
      sourceRequest,
      advance: {
        source,
        evidence,
        target: incoming,
        mode: "retained-wait" as const,
      },
    };
  }
  /** A post-approve dialogue crosses only its exact approved change or its own
   * separately admitted candidate publication. Both require canonical decision
   * provenance and the genuine unconsumed input wait; this is not a general pin
   * refresh. Candidate returns additionally retain their original input/Case. */
  private async retainedConversationAdvance(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    run: Record<string, unknown>,
    incoming: NativeExecutionRequest,
    snapshot: NativeExecutionSnapshot,
    sourceRequest: NativeExecutionRequest,
    current: SystemRuntimeState,
  ) {
    const evidence = await retainedConversationAdvanceEvidence(
      incoming,
      snapshot,
      sourceRequest,
      current,
    );
    const wait = await this.waitEvidence.read(
      query,
      scope,
      threadId,
      run,
      sourceRequest,
    );
    const node = sourceRequest.flow.nodes.find((entry) =>
      entry.id === wait.nodeId
    );
    if (
      !node || wait.kind !== "input" || node.mechanism !== "await_input" ||
      snapshot.waits[0].nodeId !== node.id
    ) {
      throw new Error(
        "The selected source receipt no longer retains the genuine input wait",
      );
    }
    const source: NativeContinuationReceipt["source"] = {
      threadId,
      checkpointNamespace: String(run.checkpointNamespace),
      checkpointId: String(run.checkpointId),
      preparedNodeId: nativeFrameworkNodeName(node.id, "await-preparation"),
      settledEffectKey: wait.effectKey,
    };
    const effect = (await query(
      `SELECT "runId" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
      [...scopedValues(scope), threadId, source.settledEffectKey],
    )).rows[0];
    if (effect) {
      throw new Error("The retained conversation wait was already consumed");
    }
    const unknown = await query(
      `SELECT "effectKey" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' LIMIT 1`,
      [...scopedValues(scope), threadId],
    );
    if (unknown.rows.length) {
      throw new Error(
        "Unsettled effects block retained conversation-wait continuation",
      );
    }
    return {
      sourceRequest,
      advance: {
        source,
        evidence,
        target: incoming,
        mode: "retained-wait" as const,
      },
    };
  }
  private async scalarBudgetCheckpoint(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    member: BudgetCeilingMember,
  ): Promise<BudgetProposalCheckpoint> {
    const run = (await query(
      `SELECT r.*,e."identityJson" FROM ${this.table("ExecutionRun")} r JOIN ${
        this.table("OperatorExecution")
      } e USING ("projectId","systemId","executionSpaceId","operatorId","threadId") WHERE r."projectId"=$1 AND r."systemId"=$2 AND r."executionSpaceId"=$3 AND r."operatorId"=$4 AND r."threadId"=$5 AND r."runId"=$6`,
      [...scopedValues(scope), member.threadId, member.runId],
    )).rows[0];
    if (
      !run || run.checkpointNamespace !== member.checkpointNamespace ||
      run.checkpointId !== member.checkpointId ||
      run.contributionId !== member.contributionId ||
      typeof run.identityJson !== "string" ||
      canonical(JSON.parse(run.identityJson)) !== canonical(member.identity) ||
      typeof run.snapshotJson !== "string" || typeof run.pinJson !== "string"
    ) {
      throw new Error(
        "Scalar budget source run differs from its frozen member",
      );
    }
    const source = this.runSource(run),
      historical = await this.businessRevision(
        query,
        scope,
        source.businessRevision,
      );
    const request = scalarBudgetSourceRequest(
      member,
      source,
      historical,
      run.pinJson,
    );
    const wait = await this.waitEvidence.read(
      query,
      scope,
      member.threadId,
      run,
      request,
    );
    const saved = JSON.parse(run.snapshotJson) as NativeExecutionSnapshot;
    const { scalarBudgetProposal: _projection, ...snapshot } = {
      ...saved,
      runId: member.runId,
      checkpointNamespace: member.checkpointNamespace,
      budgetContinuationSource: budgetSourceFromWait(wait),
    };
    if (await executionDigest(snapshot) !== member.snapshotDigest) {
      throw new Error("Scalar budget source snapshot changed");
    }
    const effect = (await query(
      `SELECT "runId","contributionId","nodeId","status","resultJson" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
      [...scopedValues(scope), member.threadId, member.settledEffectKey],
    )).rows[0];
    const unknown = await query(
      `SELECT "effectKey" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6 AND "status"<>'completed' LIMIT 1`,
      [...scopedValues(scope), member.threadId, member.runId],
    );
    if (unknown.rows.length) {
      throw new Error(
        "Unsettled scalar source effects block budget continuation",
      );
    }
    return {
      request,
      snapshot,
      wait,
      contributionConsumed: await this.waitEvidence.consumed(
        query,
        scope,
        member.threadId,
        run,
        request.contribution.id,
      ),
      ...(effect && typeof effect.resultJson === "string"
        ? {
          effect: {
            ...effect,
            runId: effect.runId,
            contributionId: effect.contributionId,
            nodeId: effect.nodeId,
            status: effect.status,
            result: JSON.parse(effect.resultJson),
          },
        }
        : {}),
    };
  }
  private async verifyScalarBudgetSources(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    manifest: BudgetCeilingManifest,
  ) {
    await verifyScalarBudgetFamily(
      manifest,
      (member) => this.scalarBudgetCheckpoint(query, scope, member),
    );
  }
  /** Reconstruct the frozen member from the accepted run and official saver.
   * The canonical policy/event proof is recalculated against the locked ledger. */
  private async retainedBudgetAdvance(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    run: Record<string, unknown>,
    incoming: NativeExecutionRequest,
    snapshot: NativeExecutionSnapshot,
    sourceRequest: NativeExecutionRequest,
    current: SystemRuntimeState,
  ) {
    const transition = current.budgetCeilingTransition;
    if (!transition || transition.phase !== "adopted-continuations-pending") {
      throw new Error("Budget ceiling continuation is not adopted");
    }
    await this.verifyScalarBudgetSources(query, scope, transition.manifest);
    const memberId = `${threadId}:${String(run.runId)}`;
    const member = transition.manifest.members.find((entry) =>
      entry.id === memberId
    );
    if (
      !member || member.threadId !== threadId || member.runId !== run.runId ||
      member.checkpointNamespace !== run.checkpointNamespace ||
      member.checkpointId !== run.checkpointId ||
      member.contributionId !== run.contributionId ||
      canonical(member.identity) !== canonical(sourceRequest.identity) ||
      canonical(member.identity) !== canonical(incoming.identity) ||
      canonical(transition.manifest.from) !==
        canonical({
          identity: sourceRequest.model.identity,
          version: sourceRequest.model.version,
        }) ||
      canonical(transition.manifest.to) !==
        canonical({
          identity: incoming.model.identity,
          version: incoming.model.version,
        }) ||
      snapshot.threadId !== threadId || snapshot.status !== "waiting" ||
      snapshot.unsettledEffects.length || snapshot.waits.length !== 1
    ) {
      throw new Error(
        "Budget continuation member differs from its retained run",
      );
    }
    const wait = await this.waitEvidence.read(
      query,
      scope,
      threadId,
      run,
      sourceRequest,
    );
    const projected = budgetSourceFromWait(wait);
    if (
      !projected ||
      canonical(projected) !==
        canonical({
          sourceKind: member.sourceKind,
          occurrenceId: member.occurrenceId,
          preparedNodeId: member.preparedNodeId,
          settledEffectKey: member.settledEffectKey,
        })
    ) throw new Error("Budget continuation receipt source changed");
    const projectedSnapshot = {
      ...snapshot,
      runId: member.runId,
      checkpointNamespace: member.checkpointNamespace,
      budgetContinuationSource: projected,
    };
    if (await executionDigest(projectedSnapshot) !== member.snapshotDigest) {
      throw new Error(
        "Budget continuation snapshot differs from its frozen member",
      );
    }
    const node = sourceRequest.flow.nodes.find((entry) =>
      entry.id === member.occurrenceId
    );
    if (
      !node ||
      nativeFrameworkNodeName(node.id, "await-preparation") !==
        member.preparedNodeId
    ) {
      throw new Error(
        "Budget continuation occurrence differs from its admitted flow",
      );
    }
    const effect = (await query(
      `SELECT "runId","contributionId","nodeId","status","resultJson" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
      [...scopedValues(scope), threadId, member.settledEffectKey],
    )).rows[0];
    if (member.sourceKind === "unconsumed-input-wait") {
      if (node.mechanism !== "await_input" || effect) {
        throw new Error("Budget input wait was consumed");
      }
    } else {
      if (
        !effect || effect.runId !== run.runId ||
        effect.contributionId !== run.contributionId ||
        effect.nodeId !== node.nativeId || effect.status !== "completed" ||
        typeof effect.resultJson !== "string"
      ) {
        throw new Error("Budget wait lacks its exact settled action receipt");
      }
      const { localState: _localState, ...result } = JSON.parse(
        effect.resultJson,
      ) as NativeExecutionActionResult;
      if (
        !result.suspend || result.suspensionKind !== "budget" ||
        result.modelAdvance ||
        await effectResultDigest(result) !== wait.resultDigest
      ) {
        throw new Error("Budget wait differs from its settled action receipt");
      }
    }
    const unknown = await query(
      `SELECT "effectKey" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' LIMIT 1`,
      [...scopedValues(scope), threadId],
    );
    if (unknown.rows.length) {
      throw new Error("Unsettled effects block budget continuation");
    }
    const budgetRow = (await query(
      `SELECT "revision","payload" FROM ${this.#schema}."WorkBudget" WHERE ${scopeWhere} AND "scopeId"=$5 FOR SHARE`,
      [...scopedValues(scope), transition.manifest.budget.scopeId],
    )).rows[0];
    if (!budgetRow || typeof budgetRow.payload !== "string") {
      throw new Error("Budget continuation ledger unavailable");
    }
    const budget = JSON.parse(budgetRow.payload) as WorkBudgetRecord;
    budgetState(budget);
    if (
      BigInt(budget.revision) !== BigInt(budgetRow.revision as bigint) ||
      budget.ownerId !== scope.operatorId ||
      budget.scopeId !== transition.manifest.budget.scopeId
    ) {
      throw new Error("Budget continuation ledger scope or revision changed");
    }
    const evidence = await retainedBudgetAdvanceEvidence(
      current,
      budget,
      memberId,
      member,
      incoming,
      transition.manifest,
      {
        intent: async () => {
          const intents = await query(
            `SELECT "evidenceJson","evidenceDigest","sourceCheckpointNamespace","sourceCheckpointId","preparedNodeId","settledEffectKey" FROM ${
              this.table("NativeContinuationReceipt")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "predecessorRunId"=$6 AND "evidenceKind"='verified-budget-ceiling-advance' AND "status"='intent'`,
            [...scopedValues(scope), threadId, member.runId],
          );
          if (intents.rows.length > 1) {
            throw new Error(
              "Multiple budget continuation intents for one member",
            );
          }
          const intent = intents.rows[0];
          return intent
            ? {
              evidence: JSON.parse(
                String(intent.evidenceJson),
              ) as NativeModelAdvanceEvidence,
              evidenceDigest: intent.evidenceDigest,
              sourceCheckpointNamespace: intent.sourceCheckpointNamespace,
              sourceCheckpointId: intent.sourceCheckpointId,
              preparedNodeId: intent.preparedNodeId,
              settledEffectKey: intent.settledEffectKey,
            }
            : undefined;
        },
        businessRevision: (reference) =>
          this.businessRevision(query, scope, reference),
        currentBusiness: () => this.currentBusiness(query, scope),
      },
    );
    return {
      sourceRequest,
      advance: {
        source: {
          threadId,
          checkpointNamespace: member.checkpointNamespace,
          checkpointId: member.checkpointId,
          preparedNodeId: member.preparedNodeId,
          settledEffectKey: member.settledEffectKey,
        },
        evidence,
        target: incoming,
        mode: "retained-wait" as const,
      },
    };
  }
  private async retainedWaitNeedsResume(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    threadId: string,
    run: Record<string, unknown>,
    request: NativeExecutionRequest,
  ) {
    const receipt = (await query(
      `SELECT n."settledEffectKey",n."predecessorRunId",n."sourceKind",n."sourceOccurrenceId",n."evidenceKind",e."resultJson" FROM ${
        this.table("NativeContinuationReceipt")
      } n LEFT JOIN ${
        this.table("ExecutionEffect")
      } e ON e."projectId"=n."projectId" AND e."systemId"=n."systemId" AND e."executionSpaceId"=n."executionSpaceId" AND e."operatorId"=n."operatorId" AND e."threadId"=n."threadId" AND e."effectKey"=n."settledEffectKey" WHERE n."projectId"=$1 AND n."systemId"=$2 AND n."executionSpaceId"=$3 AND n."operatorId"=$4 AND n."threadId"=$5 AND n."successorRunId"=$6 AND n."status"='selected'`,
      [...scopedValues(scope), threadId, run.runId],
    )).rows[0];
    if (!receipt) return false;
    const sourceKind = receipt.sourceKind ??
      (receipt.evidenceKind === "verified-catalog-advance"
        ? "settled-effect"
        : receipt.evidenceKind === "verified-mandate-advance"
        ? "unconsumed-input-wait"
        : undefined);
    if (
      !sourceKind ||
      !["settled-effect", "unconsumed-input-wait", "settled-budget-wait"]
        .includes(
          String(sourceKind),
        ) ||
      ![
        "verified-catalog-advance",
        "verified-mandate-advance",
        "verified-team-advance",
        "verified-budget-ceiling-advance",
      ].includes(
        String(receipt.evidenceKind),
      )
    ) {
      throw new Error("Selected continuation has an unsupported source shape");
    }
    if (
      sourceKind === "settled-effect" || sourceKind === "settled-budget-wait"
    ) {
      if (
        sourceKind === "settled-budget-wait" &&
        receipt.evidenceKind !== "verified-budget-ceiling-advance"
      ) {
        throw new Error("Selected budget wait has incompatible evidence");
      }
      if (typeof receipt.resultJson !== "string") {
        throw new Error("Selected continuation lost its settled source effect");
      }
      const result = JSON.parse(
        receipt.resultJson,
      ) as NativeExecutionActionResult;
      if (
        !result.suspend || result.suspensionKind !==
          (sourceKind === "settled-budget-wait" ? "budget" : "decision") ||
        result.modelAdvance
      ) return false;
    } else if (receipt.resultJson !== null) {
      throw new Error(
        "Selected conversation continuation lost its unconsumed input wait",
      );
    }
    if (!run.checkpointId) {
      throw new Error("Selected retained wait has no exact checkpoint");
    }
    if (
      await this.waitEvidence.consumed(
        query,
        scope,
        threadId,
        run,
        String(run.contributionId),
      )
    ) return false;
    const wait = await this.waitEvidence.read(
      query,
      scope,
      threadId,
      run,
      request,
    );
    if (
      wait.effectKey !== receipt.settledEffectKey ||
      wait.kind !==
        (sourceKind === "settled-effect"
          ? "decision"
          : sourceKind === "settled-budget-wait"
          ? "budget"
          : "input") ||
      receipt.sourceOccurrenceId !== null &&
        wait.nodeId !== receipt.sourceOccurrenceId
    ) {
      throw new Error(
        "Selected continuation lost its genuine unconsumed wait receipt",
      );
    }
    return true;
  }
  async open(
    request: NativeExecutionRequest,
    transferAuthorization?: symbol,
  ): Promise<NativeExecutionSession> {
    const claim = this.#claim.getStore();
    if (!claim) {
      throw new Error(
        "Native execution requires a durable claimed operator delivery",
      );
    }
    const adoptionKind = request.teamAdoptionContinuation ? "team" : "network";
    const adoptionContinuation = request.networkAdoptionContinuation ??
      request.teamAdoptionContinuation;
    if (
      claim.delivery.kind === "continuation" &&
      claim.delivery.id.startsWith(`${adoptionKind}-adoption:`) &&
      (!adoptionContinuation ||
        canonical(
            (adoptionKind === "team"
              ? claim.delivery.payload?.teamAdoption
              : claim.delivery.payload?.networkAdoption) ?? null,
          ) !== canonical(adoptionContinuation))
    ) {
      throw new Error(
        "Network continuation requires its exact receipt-bound fork",
      );
    }
    const refusalKind = request.teamRefusalContinuation ? "team" : "network";
    const refusalInput = request.networkRefusalContinuation ??
      request.teamRefusalContinuation;
    const refusal = refusalInput
      ? parseRequestNetworkRefusalContinuation(refusalInput)
      : undefined;
    if (claim.delivery.id.startsWith(`${refusalKind}-refusal:`) || refusal) {
      if (
        !refusal || claim.delivery.kind !== "continuation" ||
        claim.delivery.id !==
          `${refusalKind}-refusal:${refusal.decisionDigest}` ||
        request.contribution.id !== claim.delivery.id ||
        request.contribution.kind !== "resume" ||
        request.identity.scope.kind !== "request" ||
        request.identity.subjectId !== refusal.originalInputMessageId ||
        request.contribution.inputMessageId !==
          refusal.originalInputMessageId ||
        canonical(
            refusalKind === "team"
              ? request.contribution.teamRefusalContinuation
              : request.contribution.networkRefusalContinuation,
          ) !== canonical(refusal) ||
        canonical(
            refusalKind === "team"
              ? claim.delivery.payload?.teamRefusal
              : claim.delivery.payload?.networkRefusal,
          ) !== canonical(refusal) ||
        claim.delivery.payload?.inputMessageId !==
          refusal.originalInputMessageId ||
        canonical(claim.delivery.identity) !== canonical(request.identity) ||
        adoptionContinuation || request.initialAdmissionTransfer
      ) {
        throw new Error(
          "The exact Request refusal continuation claim is unavailable",
        );
      }
    }
    if (
      claim.delivery.identity.operatorId !== request.identity.operatorId ||
      transferAuthorization !== this.#transferAuthorization &&
        canonical(claim.delivery.identity.scope) !==
          canonical(request.identity.scope)
    ) throw new Error("Execution claim scope mismatch");
    const scope = this.scope(request.identity);
    const identityJson = canonical(request.identity);
    const deliveryDigest = await executionDigest(claim.delivery);
    const deliveryThreadId = claim.job.data.threadId;
    if (refusal && deliveryThreadId !== refusal.threadId) {
      throw new Error("The refusal continuation thread differs");
    }
    let refusalEvidence: {
      snapshot: NativeExecutionSnapshot;
      rows: string;
      waitKey: string;
    } | undefined;
    if (refusal) {
      const prior = await this.client.executionContribution.findFirst({
        where: {
          ...scope,
          threadId: refusal.threadId,
          contributionId: claim.delivery.id,
        },
      });
      if (!prior?.runId) {
        const runs = await this.client.executionRun.findMany({
          where: {
            ...scope,
            threadId: refusal.threadId,
            checkpointId: refusal.checkpointId,
            status: "waiting",
          },
        });
        if (runs.length !== 1 || !runs[0].snapshotJson) {
          throw new Error("The refusal wait snapshot is unavailable");
        }
        const snapshot = JSON.parse(
          runs[0].snapshotJson,
        ) as NativeExecutionSnapshot;
        const read = () =>
          this.client.$transaction(
            (tx) =>
              this.networkCheckpointRows(
                fromPrisma(tx).executeSql,
                snapshot,
                false,
              ),
            { isolationLevel: "RepeatableRead" },
          );
        const rows = await read();
        const tuple = await new PostgresSaver(
          this.options.checkpointPool,
          undefined,
          { schema: this.options.checkpointSchema },
        ).getTuple({
          configurable: {
            thread_id: refusal.threadId,
            checkpoint_ns: snapshot.checkpointNamespace,
            checkpoint_id: refusal.checkpointId,
          },
        });
        const source = await this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.lockClaim(query, claim.job);
          return await this.assertUnconsumedSnapshotWait(
            query,
            scope,
            snapshot,
          );
        });
        await verifyOfficialWaitCheckpoint(tuple, source.wait);
        if (
          canonical(source.wait.changeApprovalWait) !==
            canonical(snapshot.localState?.changeApprovalWait) ||
          await read() !== rows
        ) {
          throw new Error(
            "The refusal checkpoint is not the exact unconsumed wait",
          );
        }
        refusalEvidence = { snapshot, rows, waitKey: source.wait.effectKey };
      }
    }
    const parentFence = currentPostgresExecutionTransaction()?.fence;
    const parentSession = currentPostgresExecutionTransaction()?.session;
    const session = await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      await parentFence?.(query);
      await this.lockClaim(query, claim.job);
      const exactDelivery =
        canonical(request.identity) === canonical(claim.delivery.identity) &&
        request.contribution.id === claim.delivery.id;
      const binding = await this.resolveThread(query, request.identity, {
        modelDigest: request.model.version.digest,
        repositoryVersion: request.model.version.repositoryVersion,
      }, exactDelivery ? claim.delivery.id : undefined);
      const threadId = binding.threadId;
      if (
        canonical(request.identity) === canonical(claim.delivery.identity) &&
        threadId !== deliveryThreadId
      ) {
        throw new Error(
          "Accepted delivery targets a retired execution binding",
        );
      }
      if (binding.terminalSnapshot) {
        if (
          refusal &&
          binding.terminalSnapshot.contributionId !== claim.delivery.id
        ) {
          throw new Error("The Request refusal wait is already closed");
        }
        const terminalRun = (await query(
          `SELECT * FROM ${
            this.table("ExecutionRun")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
          [...scopedValues(scope), threadId, binding.row.currentRunId],
        )).rows[0];
        if (
          !terminalRun ||
          !await this.waitEvidence.consumed(
            query,
            scope,
            threadId,
            terminalRun,
            binding.terminalSnapshot.contributionId,
          )
        ) throw new Error("NATIVE_WAIT_TERMINAL_CONSUMPTION_PROOF_MISSING");
        return {
          alreadyCompleted: binding.terminalSnapshot,
          savedRunId: String(binding.row.currentRunId),
        };
      }
      const values = [...scopedValues(scope), threadId];
      await query(
        `INSERT INTO ${
          this.table("OperatorExecution")
        } ("projectId","systemId","executionSpaceId","operatorId","threadId","identityJson","scopeKind","scopeId","rootRequestId","ownerId","purpose","subjectId","revision","epoch","status","checkpointNamespace","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,'queued','',clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING`,
        [
          ...values,
          identityJson,
          request.identity.scope.kind,
          request.identity.scope.scopeId,
          request.identity.scope.kind === "request"
            ? request.identity.scope.rootRequestId
            : null,
          request.identity.scope.kind === "designer"
            ? request.identity.scope.ownerId
            : null,
          request.identity.purpose,
          request.identity.subjectId ?? null,
        ],
      );
      const row = (await query(
        `SELECT * FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5 FOR UPDATE`,
        values,
      )).rows[0];
      if (!row || row.identityJson !== identityJson || row.retiredAt) {
        throw new Error("Execution identity is retired or changed");
      }
      const old = row.currentRunId
        ? (await query(
          `SELECT * FROM ${
            this.table("ExecutionRun")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
          [...values, row.currentRunId],
        )).rows[0]
        : undefined;
      if (old?.status === "reserved") {
        throw new Error(
          "An unselected reserved native successor cannot execute",
        );
      }
      const existing = (await query(
        `SELECT * FROM ${
          this.table("ExecutionContribution")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6`,
        [...values, request.contribution.id],
      )).rows[0];
      if (refusal) {
        const current = await this.currentBusiness(query, scope);
        const change = current.configuration?.changes.find((item) =>
          item.id === refusal.changeId
        );
        const decision = current.requestNetworkDecisions?.[refusal.changeId];
        if (
          !change || !decision || change.status !== "refused" ||
          !(refusalKind === "team"
            ? decidedByTeamAuthority(change)
            : decidedByNetworkAuthority(change)) ||
          decision.verdict !== "refuse" ||
          decision.caseId !== request.identity.scope.scopeId ||
          decision.executionSpaceId !== scope.executionSpaceId ||
          decision.commandId !== refusal.changeId ||
          !current.cases?.some((entry) =>
            entry.id === decision.caseId &&
            entry.openedFrom.openingId === decision.openingId
          ) ||
          decision.proposalIntentDigest !== refusal.proposalIntentDigest ||
          await requestChangeProposalDigest(change) !==
            refusal.proposalIntentDigest ||
          await canonicalDigest({ change, decision }) !==
            refusal.decisionDigest ||
          canonical(current.executionModel) !== canonical(request.model)
        ) {
          throw new Error("The recorded Request refusal changed");
        }
        if (!existing?.runId) {
          const evidence = refusalEvidence;
          const wait = evidence &&
            exactNativeChangeApprovalWait(
              current,
              evidence.snapshot,
              request.model,
              {
                changeId: refusal.changeId,
                proposalIntentDigest: refusal.proposalIntentDigest,
                caseId: decision.caseId,
              },
            );
          if (
            !evidence || !wait || old?.runId !== evidence.snapshot.runId ||
            old.status !== "waiting" ||
            row.currentCheckpointId !== refusal.checkpointId ||
            canonical(request.identity) !==
              canonical(evidence.snapshot.identity) ||
            wait.inputMessageId !== refusal.originalInputMessageId ||
            await this.networkCheckpointRows(query, evidence.snapshot, true) !==
              evidence.rows
          ) throw new Error("The refusal wait changed before selection");
          const retainedWait = await this.assertUnconsumedSnapshotWait(
            query,
            scope,
            evidence.snapshot,
          );
          if (
            retainedWait.wait.effectKey !== evidence.waitKey ||
            canonical(retainedWait.wait.changeApprovalWait) !== canonical(wait)
          ) {
            throw new Error(
              "The refusal wait typed proof changed before selection",
            );
          }
          const effect = await tx.executionEffect.findUnique({
            where: {
              projectId_systemId_executionSpaceId_operatorId_threadId_effectKey:
                {
                  ...scope,
                  threadId: refusal.threadId,
                  effectKey: wait.effectKey,
                },
            },
            select: {
              status: true,
              runId: true,
              contributionId: true,
              nodeId: true,
              resultJson: true,
            },
          });
          if (
            !effect || effect.status !== "completed" ||
            effect.runId !== evidence.snapshot.runId ||
            effect.contributionId !== wait.contributionId ||
            effect.nodeId !== wait.actionId ||
            typeof effect.resultJson !== "string"
          ) throw new Error("The refusal proposal effect is unavailable");
          const result = JSON.parse(
            effect.resultJson,
          ) as NativeExecutionActionResult;
          if (
            canonical(result.localState?.changeApprovalProposal) !==
              canonical({
                changeId: refusal.changeId,
                proposalIntentDigest: refusal.proposalIntentDigest,
              }) ||
            (result.outputs?.submission as
                | { awaitingInput?: unknown }
                | undefined)?.awaitingInput !== true ||
            await tx.executionEffect.findUnique({
              where: {
                projectId_systemId_executionSpaceId_operatorId_threadId_effectKey:
                  {
                    ...scope,
                    threadId: refusal.threadId,
                    effectKey: evidence.waitKey,
                  },
              },
              select: { effectKey: true },
            })
          ) throw new Error("The refusal proposal or wait differs");
        }
      }
      if (
        !existing?.runId && !refusal && !adoptionContinuation &&
        claim.delivery.kind === "continuation" &&
        old?.status === "waiting" && typeof old.snapshotJson === "string" &&
        (JSON.parse(old.snapshotJson) as NativeExecutionSnapshot).localState
          ?.changeApprovalWait
      ) {
        throw new Error(
          "A Request approval wait requires its exact recorded decision",
        );
      }
      if (!existing?.runId) {
        await this.assertNoOpenGroups(query, scope, threadId);
      }
      if (
        existing &&
        (existing.digest !== deliveryDigest ||
          existing.originJson !== canonical({ delivery: claim.delivery }))
      ) throw new Error("CONTRIBUTION_RECEIPT_MISMATCH");
      let baseRun = existing?.runId
        ? (await query(
          `SELECT * FROM ${
            this.table("ExecutionRun")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
          [...values, existing.runId],
        )).rows[0]
        : undefined;
      if (baseRun?.status === "reserved") {
        const intent = (await query(
          `SELECT "predecessorRunId","status" FROM ${
            this.table("NativeContinuationReceipt")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "successorRunId"=$6`,
          [...values, baseRun.runId],
        )).rows[0];
        if (
          !intent || intent.status !== "intent" ||
          intent.predecessorRunId !== old?.runId
        ) {
          throw new Error(
            "Reserved native successor has no immediate unselected continuation intent",
          );
        }
        baseRun = undefined;
      }
      const selectedRun = baseRun
        ? old?.contributionId === request.contribution.id ? old : baseRun
        : undefined;
      let selectedBudgetContinuation: NativeContinuationReceipt | undefined;
      if (selectedRun) {
        const receipt = (await query(
          `SELECT * FROM ${
            this.table("NativeContinuationReceipt")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "successorRunId"=$6 AND "status"='selected' AND "evidenceKind"='verified-budget-ceiling-advance'`,
          [...values, selectedRun.runId],
        )).rows[0];
        if (receipt) {
          const evidence = JSON.parse(
            String(receipt.evidenceJson),
          ) as NativeModelAdvanceEvidence;
          if (
            evidence.kind !== "verified-budget-ceiling-advance" ||
            receipt.successorCheckpointNamespace !==
              selectedRun.checkpointNamespace ||
            receipt.predecessorRunId !== selectedRun.predecessorRunId ||
            receipt.targetPinJson !== selectedRun.pinJson ||
            evidence.memberId !==
              `${threadId}:${String(receipt.predecessorRunId)}` ||
            canonical(evidence.resume) !== canonical(request.contribution) ||
            receipt.evidenceDigest !== await executionDigest(evidence)
          ) {
            throw new Error(
              "Selected budget continuation receipt differs from its successor",
            );
          }
          const budgetCurrent = await this.currentBusiness(query, scope);
          const budgetManifest = budgetCurrent.budgetCeilingTransition
            ?.manifest;
          if (
            !budgetManifest ||
            budgetCurrent.budgetCeilingTransition?.manifestDigest !==
              evidence.manifestDigest
          ) throw new Error("Selected budget family intention unavailable");
          await verifyScalarBudgetCandidate(budgetCurrent);
          await this.verifyScalarBudgetSources(query, scope, budgetManifest);
          selectedBudgetContinuation = {
            id: String(receipt.id),
            predecessorRunId: String(receipt.predecessorRunId),
            source: {
              threadId,
              checkpointNamespace: String(receipt.sourceCheckpointNamespace),
              checkpointId: String(receipt.sourceCheckpointId),
              preparedNodeId: String(receipt.preparedNodeId),
              settledEffectKey: String(receipt.settledEffectKey),
            },
            evidence,
            successorRunId: String(selectedRun.runId),
          };
        }
      }
      let acceptedRequest = request;
      if (selectedRun && baseRun) {
        await this.verifyRunLineage(
          query,
          scope,
          threadId,
          selectedRun,
          baseRun,
          claim.delivery,
        );
        acceptedRequest = await this.recoverRequest(
          query,
          scope,
          selectedRun,
          request,
        );
        const originalDigest = await executionDigest({
          identity: request.identity,
          contribution: request.contribution,
          pin: baseRun.pinJson,
        });
        if (
          existing?.requestDigest && existing.requestDigest !== originalDigest
        ) throw new Error("CONTRIBUTION_RECEIPT_MISMATCH");
        if (selectedRun.snapshotJson) {
          const saved = JSON.parse(
            String(selectedRun.snapshotJson),
          ) as NativeExecutionSnapshot;
          await this.waitEvidence.protocol(
            query,
            scope,
            threadId,
            selectedRun.runId,
          );
          if (
            ["waiting", "completed"].includes(saved.status) &&
            !await this.waitEvidence.consumed(
              query,
              scope,
              threadId,
              selectedRun,
              acceptedRequest.contribution.id,
            )
          ) throw new Error("NATIVE_WAIT_COMPLETION_WITHOUT_CONSUMPTION");
          if (saved.status === "waiting") {
            await this.waitEvidence.read(
              query,
              scope,
              threadId,
              selectedRun,
              acceptedRequest,
            );
          }
          return {
            alreadyCompleted: JSON.parse(
              String(selectedRun.snapshotJson),
            ) as NativeExecutionSnapshot,
            savedRunId: String(selectedRun.runId),
            selectedBudgetContinuation,
          };
        }
        if (immutablePin(acceptedRequest) !== immutablePin(request)) {
          const results = await query(
            `SELECT "resultJson" FROM ${
              this.table("ExecutionEffect")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6 AND "status"='completed'`,
            [...values, selectedRun.runId],
          );
          const evidence = results.rows.map((item) =>
            JSON.parse(String(item.resultJson)).modelAdvance as
              | NativeModelAdvanceEvidence
              | undefined
          ).find((item) =>
            item &&
            canonical(item.to) ===
              canonical({
                identity: request.model.identity,
                version: request.model.version,
              })
          );
          if (!evidence) throw new Error("EXECUTION_PIN_TRANSITION_REQUIRED");
          const historical = await this.businessRevision(
            query,
            scope,
            evidence.businessRevision,
          );
          if (
            canonical(
              await rederiveSettledAdvanceEvidence(
                acceptedRequest.model,
                historical,
                evidence,
                acceptedRequest.identity.scope,
              ),
            ) !== canonical(evidence)
          ) {
            throw new Error(
              "Recovered source continuation lacks its canonical publication evidence",
            );
          }
        }
      } else {
        if (
          claim.delivery.modelPin.modelDigest !==
            request.model.version.digest ||
          claim.delivery.modelPin.repositoryVersion !==
            request.model.version.repositoryVersion
        ) {
          // A post-approve dialogue resumption binds to the advance its own
          // approved command produced; any other drift still refuses below.
          const selfAdvanced = await this.commandOwnApprovedAdvance(
            query,
            scope,
            claim.delivery,
            request,
            old,
          );
          if (!selfAdvanced) {
            if (!parentSession || parentSession.threadId === threadId) {
              throw new Error("EXECUTION_DELIVERY_MODEL_PIN_MISMATCH");
            }
            const parent = (await query(
              `SELECT "pinJson","jobId" FROM ${
                this.table("ExecutionRun")
              } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
              [
                ...scopedValues(scope),
                parentSession.threadId,
                parentSession.runId,
              ],
            )).rows[0];
            if (
              !parent || parent.jobId !== claim.job.id ||
              canonical(JSON.parse(String(parent.pinJson)).version) !==
                canonical(request.model.version)
            ) {
              throw new Error(
                "Nested native execution does not match its selected parent generation",
              );
            }
          }
        }
        const sourceState = await this.businessRevision(
          query,
          scope,
          request.businessRevision,
        );
        if (
          canonical(sourceState.executionModel) !== canonical(request.model)
        ) {
          throw new Error(
            "Native request model differs from the accepted business revision",
          );
        }
        if (old && old.pinJson !== immutablePin(request)) {
          const retained = await this.retainedWaitAdvance(
            query,
            scope,
            threadId,
            old,
            request,
            old.jobId === claim.job.id,
          );
          const epoch = BigInt(row.epoch as bigint) + 1n;
          await query(
            `UPDATE ${
              this.table("ExecutionRun")
            } SET "epoch"=$7,"jobId"=$8,"retryCount"=$9,"status"='running',"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
            [...values, old.runId, epoch, claim.job.id, claim.job.retryCount],
          );
          await query(
            `UPDATE ${
              this.table("OperatorExecution")
            } SET "epoch"=$6,"revision"="revision"+1,"currentJobId"=$7,"currentRetry"=$8,"status"='running',"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5`,
            [...values, epoch, claim.job.id, claim.job.retryCount],
          );
          await this.lockClaim(query, claim.job);
          return {
            scope,
            threadId,
            identityDigest: binding.identityDigest,
            runId: String(old.runId),
            namespace: String(old.checkpointNamespace),
            epoch,
            jobId: claim.job.id,
            retryCount: claim.job.retryCount,
            checkpointId: String(old.checkpointId),
            request: retained.sourceRequest,
            signal: claim.job.signal,
            ownsDelivery: false,
            beforeInputAdvance: retained.advance,
            ...(parentFence ? { parentFence } : {}),
          } satisfies SessionRecord;
        }
      }
      const pin = immutablePin(acceptedRequest);
      const contributionDigest = existing?.requestDigest
        ? String(existing.requestDigest)
        : await executionDigest({
          identity: acceptedRequest.identity,
          contribution: acceptedRequest.contribution,
          pin,
        });
      const runId = selectedRun
        ? String(selectedRun.runId)
        : crypto.randomUUID();
      const retainCheckpoint = selectedRun ??
        (old && old.status !== "completed" ? old : undefined);
      if (!selectedRun && old?.status === "waiting") {
        const sourceRequest = await this.recoverRequest(
          query,
          scope,
          old,
          acceptedRequest,
        );
        await this.waitEvidence.read(
          query,
          scope,
          threadId,
          old,
          sourceRequest,
        );
      }
      const namespace = retainCheckpoint
        ? String(retainCheckpoint.checkpointNamespace)
        : `run:${runId}`;
      const checkpointId = retainCheckpoint?.checkpointId
        ? String(retainCheckpoint.checkpointId)
        : null;
      const epoch = BigInt(row.epoch as bigint) + 1n;
      // A new contribution has a new immutable run; it explicitly selects the
      // prior accepted checkpoint in the SAME official thread namespace.
      const insertedRun = await query(
        `INSERT INTO ${
          this.table("ExecutionRun")
        } ("projectId","systemId","executionSpaceId","operatorId","threadId","runId","generation","contributionId","pinJson","status","checkpointNamespace","checkpointId","epoch","jobId","retryCount","predecessorRunId","parentThreadId","parentRunId","modelReferenceJson","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10,$11,$12,$13,$14,$15,$16,$17,$18,clock_timestamp(),clock_timestamp()) ON CONFLICT DO NOTHING RETURNING "runId"`,
        [
          ...values,
          runId,
          epoch,
          request.contribution.id,
          pin,
          namespace,
          checkpointId,
          epoch,
          claim.job.id,
          claim.job.retryCount,
          old && old.runId !== runId ? old.runId : null,
          parentSession && parentSession.threadId !== threadId
            ? parentSession.threadId
            : null,
          parentSession && parentSession.threadId !== threadId
            ? parentSession.runId
            : null,
          modelSourceReference(acceptedRequest),
        ],
      );
      if (insertedRun.rows.length) {
        await this.waitEvidence.initialize(query, scope, threadId, runId);
      }
      await query(
        `UPDATE ${
          this.table("ExecutionRun")
        } SET "epoch"=$7,"jobId"=$8,"retryCount"=$9,"status"='running',"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...values, runId, epoch, claim.job.id, claim.job.retryCount],
      );
      await query(
        `INSERT INTO ${
          this.table("ExecutionContribution")
        } ("projectId","systemId","executionSpaceId","operatorId","threadId","contributionId","digest","requestDigest","kind","originJson","payloadJson","jobId","runId","status","acceptedAt")
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'running',clock_timestamp()) ON CONFLICT DO NOTHING`,
        [
          ...values,
          request.contribution.id,
          deliveryDigest,
          contributionDigest,
          request.contribution.kind,
          canonical({ delivery: claim.delivery }),
          canonical(claim.delivery),
          claim.job.id,
          runId,
        ],
      );
      await query(
        `UPDATE ${
          this.table("ExecutionContribution")
        } SET "runId"=COALESCE("runId",$7),"requestDigest"=COALESCE("requestDigest",$8),"status"='running' WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6`,
        [...values, request.contribution.id, runId, contributionDigest],
      );
      await query(
        `UPDATE ${
          this.table("OperatorExecution")
        } SET "epoch"=$6,"revision"="revision"+1,"currentRunId"=$7,"currentJobId"=$8,"currentRetry"=$9,"status"='running',"checkpointNamespace"=$10,"currentCheckpointId"=$11,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5`,
        [
          ...values,
          epoch,
          runId,
          claim.job.id,
          claim.job.retryCount,
          namespace,
          checkpointId,
        ],
      );
      const forceResumeWait = refusal &&
          (!selectedRun || selectedRun.checkpointId === refusal.checkpointId)
        ? true
        : selectedRun
        ? await this.retainedWaitNeedsResume(
          query,
          scope,
          threadId,
          selectedRun,
          acceptedRequest,
        )
        : false;
      await this.lockClaim(query, claim.job);
      return {
        scope,
        threadId,
        identityDigest: binding.identityDigest,
        runId,
        namespace,
        epoch,
        jobId: claim.job.id,
        retryCount: claim.job.retryCount,
        checkpointId,
        request: acceptedRequest,
        forceResumeWait,
        selectedBudgetContinuation,
        signal: claim.job.signal,
        ownsDelivery: threadId === deliveryThreadId &&
          request.contribution.id === claim.delivery.id,
        ...(parentFence ? { parentFence } : {}),
      } satisfies SessionRecord;
    });
    if (session.alreadyCompleted) {
      return {
        threadId: session.alreadyCompleted.threadId,
        runId: session.savedRunId!,
        checkpointNamespace: "",
        alreadyCompleted: session.alreadyCompleted,
        contributionConsumed: () => Promise.resolve(true),
        ...(session.selectedBudgetContinuation
          ? { selectedBudgetContinuation: session.selectedBudgetContinuation }
          : {}),
        assertCurrent: () => Promise.resolve(),
        withSelectionFence: (operation) => {
          const selected = session.selectedBudgetContinuation;
          if (!selected) {
            return Promise.reject(
              new Error("Completed execution has no budget selection"),
            );
          }
          return withPostgresExecutionTransaction({
            client: this.client,
            session: {
              threadId: selected.source.threadId,
              runId: selected.successorRunId,
            },
            fence: async (query) => {
              await parentFence?.(query);
              await this.lockClaim(query, claim.job);
              const row = (await query(
                `SELECT e."currentRunId",e."retiredAt",n."status",n."evidenceJson",n."evidenceDigest",n."successorRunId",n."predecessorRunId",n."sourceCheckpointNamespace",n."sourceCheckpointId",n."preparedNodeId",n."settledEffectKey" FROM ${
                  this.table("OperatorExecution")
                } e JOIN ${
                  this.table("NativeContinuationReceipt")
                } n USING ("projectId","systemId","executionSpaceId","operatorId","threadId") WHERE e."projectId"=$1 AND e."systemId"=$2 AND e."executionSpaceId"=$3 AND e."operatorId"=$4 AND e."threadId"=$5 AND n."id"=$6 FOR UPDATE OF e,n`,
                [
                  ...scopedValues(scope),
                  selected.source.threadId,
                  selected.id,
                ],
              )).rows[0];
              if (
                !row || row.retiredAt ||
                row.currentRunId !== selected.successorRunId ||
                row.status !== "selected" ||
                row.successorRunId !== selected.successorRunId ||
                row.predecessorRunId !== selected.predecessorRunId ||
                row.sourceCheckpointNamespace !==
                  selected.source.checkpointNamespace ||
                row.sourceCheckpointId !== selected.source.checkpointId ||
                row.preparedNodeId !== selected.source.preparedNodeId ||
                row.settledEffectKey !== selected.source.settledEffectKey ||
                row.evidenceJson !== canonical(selected.evidence) ||
                row.evidenceDigest !== await executionDigest(selected.evidence)
              ) {
                throw new Error("STALE_COMPLETED_BUDGET_SELECTION");
              }
              const current = await this.currentBusiness(query, scope);
              const transition = current.budgetCeilingTransition;
              if (
                !transition ||
                selected.evidence.kind !== "verified-budget-ceiling-advance" ||
                transition.manifestDigest !== selected.evidence.manifestDigest
              ) throw new Error("Completed budget intention changed");
              await verifyScalarBudgetCandidate(current);
              await this.verifyScalarBudgetSources(
                query,
                scope,
                transition.manifest,
              );
            },
          }, operation);
        },
        effect: () =>
          Promise.reject(new Error("Completed execution has no new effects")),
        immutableConsultations: {
          register: () =>
            Promise.reject(
              new Error("Completed execution has no new consultation groups"),
            ),
          withPublicationFence: () =>
            Promise.reject(
              new Error(
                "Completed execution has no new consultation publications",
              ),
            ),
          memberEffect: () =>
            Promise.reject(
              new Error("Completed execution has no new consultation effects"),
            ),
          publish: () =>
            Promise.reject(
              new Error(
                "Completed execution has no new consultation publications",
              ),
            ),
          pending: () => Promise.resolve([]),
        },
        nativeObservations: {
          append: () =>
            Promise.reject(
              new Error("Completed execution has no new observations"),
            ),
          read: () =>
            this.client.$transaction((tx) =>
              this.nativeObservations.read(
                fromPrisma(tx).executeSql,
                scope,
                session.alreadyCompleted!.threadId,
                session.savedRunId!,
              )
            ),
        },
        unsettledEffects: () => Promise.resolve([]),
        complete: () => Promise.resolve(),
        fail: () => Promise.resolve(),
        advance: () =>
          Promise.reject(new Error("Completed execution cannot advance")),
      };
    }
    return this.createSession(session);
  }

  async transferInitialAdmission(
    request: NativeExecutionRequest,
    fork: NativeFork,
  ): Promise<NativeExecutionSession> {
    const claim = this.#claim.getStore();
    if (!claim) throw new InitialAdmissionTransferRefused("claim-or-command");
    const intent = verifyInitialAdmissionClaim(
      request.initialAdmissionTransfer,
      claim.delivery,
    );
    const scope = this.scope(request.identity), values = scopedValues(scope);
    const parentFence = currentPostgresExecutionTransaction()?.fence;
    const intentDigest = await executionDigest(intent);
    let sourceEffectResult: NativeExecutionActionResult | undefined;
    const verify = async (query: ExecutionSql, allowRetired: boolean) => {
      await parentFence?.(query);
      await this.lockClaim(query, claim.job);
      const sourceState = await this.businessRevision(query, scope, {
        __assemblyRuntimeRevision: {
          systemId: intent.runtimeId,
          operatorId: intent.operatorId,
          revision: intent.sourceRevision,
          modelDigest: intent.pin.modelDigest,
        },
      });
      const current = await this.currentBusiness(query, scope);
      if (allowRetired) {
        const receipt = (await query(
          `SELECT * FROM ${
            this.table("InitialAdmissionTransferReceipt")
          } WHERE ${scopeWhere} AND "id"=$5`,
          [...values, intent.key],
        )).rows[0];
        if (
          !receipt || receipt.status !== "selected" ||
          receipt.intentJson !== canonical(intent) ||
          receipt.intentDigest !== intentDigest
        ) {
          throw new InitialAdmissionTransferRefused("selected-intent");
        }
        const targetRun = (await query(
          `SELECT * FROM ${
            this.table("ExecutionRun")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
          [...values, receipt.targetThreadId, receipt.targetRunId],
        )).rows[0];
        if (!targetRun) {
          throw new InitialAdmissionTransferRefused("selected-target-run");
        }
        const original = await this.recoverRequest(
          query,
          scope,
          targetRun,
          request,
        );
        const accepted = await this.businessRevision(
          query,
          scope,
          this.runSource(targetRun).businessRevision,
        );
        await verifySelectedInitialAdmissionTransfer(
          original,
          sourceState,
          accepted,
          current,
        );
        if (
          canonical(request.identity) !== canonical(intent.target.identity) ||
          canonical(request.contribution) !== canonical(intent.contribution)
        ) {
          throw new InitialAdmissionTransferRefused("selected-request");
        }
      } else {
        await verifyInitialAdmissionTransfer(request, sourceState, current);
      }
      const thread = (await query(
        `SELECT * FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5 FOR UPDATE`,
        [...values, intent.source.threadId],
      )).rows[0];
      const run = (await query(
        `SELECT * FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6 FOR UPDATE`,
        [...values, intent.source.threadId, intent.source.runId],
      )).rows[0];
      const binding = (await query(
        `SELECT "activeThreadId","identityJson" FROM ${
          this.table("ExecutionThreadBinding")
        } WHERE ${scopeWhere} AND "identityDigest"=$5 FOR UPDATE`,
        [...values, await executionDigest(intent.source.identity)],
      )).rows[0];
      if (
        !binding || binding.activeThreadId !== intent.source.threadId ||
        binding.identityJson !== canonical(intent.source.identity)
      ) {
        throw new InitialAdmissionTransferRefused("source-binding");
      }
      if (
        !thread || (!allowRetired && thread.retiredAt) ||
        thread.currentRunId !== intent.source.runId ||
        thread.currentCheckpointId !== intent.source.checkpointId ||
        thread.checkpointNamespace !== intent.source.checkpointNamespace ||
        thread.identityJson !== canonical(intent.source.identity) ||
        !run || run.status !== "waiting" ||
        typeof run.snapshotJson !== "string" ||
        run.checkpointId !== intent.source.checkpointId ||
        run.checkpointNamespace !== intent.source.checkpointNamespace
      ) {
        throw new InitialAdmissionTransferRefused("source-thread-or-run");
      }
      await verifyInitialAdmissionSourceSnapshot(
        intent,
        JSON.parse(run.snapshotJson),
      );
      await this.assertNoOpenGroups(query, scope, intent.source.threadId);
      const effects = (await query(
        `SELECT * FROM ${
          this.table("ExecutionEffect")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND ("status"<>'completed' OR "effectKey"=$6)`,
        [...values, intent.source.threadId, intent.source.settledEffectKey],
      )).rows;
      if (
        effects.length !== 1 || effects[0].status !== "completed" ||
        effects[0].runId !== intent.source.runId ||
        effects[0].nodeId !== intent.source.actionId ||
        effects[0].resultJson == null
      ) {
        throw new InitialAdmissionTransferRefused("source-effect");
      }
      const result = JSON.parse(
        String(effects[0].resultJson),
      ) as NativeExecutionActionResult;
      sourceEffectResult = result;
      verifyInitialAdmissionEffect(result);
      const pending = (await query(
        `SELECT 1 FROM ${
          this.table("ExecutionContribution")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "status" IN ('queued','running') LIMIT 1`,
        [...values, intent.source.threadId],
      )).rows;
      if (pending.length) {
        throw new InitialAdmissionTransferRefused("source-pending-input");
      }
      await this.lockClaim(query, claim.job);
    };
    await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      const prior = (await query(
        `SELECT "status","intentJson" FROM ${
          this.table("InitialAdmissionTransferReceipt")
        } WHERE ${scopeWhere} AND "id"=$5`,
        [...values, intent.key],
      )).rows[0];
      await verify(
        query,
        prior?.status === "selected" && prior.intentJson === canonical(intent),
      );
    });
    const opened = await this.open(request, this.#transferAuthorization);
    if (opened.alreadyCompleted) return opened;
    const record = this.#sessionRecords.get(opened);
    if (!record || record.threadId === intent.source.threadId) {
      throw new InitialAdmissionTransferRefused("target-session");
    }
    const row = await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      await this.checkpointFence(query, record, record.checkpointId);
      const existing = (await query(
        `SELECT * FROM ${
          this.table("InitialAdmissionTransferReceipt")
        } WHERE ${scopeWhere} AND "id"=$5 FOR UPDATE`,
        [...values, intent.key],
      )).rows[0];
      await verify(query, existing?.status === "selected");
      if (existing) {
        if (
          existing.intentJson !== canonical(intent) ||
          existing.intentDigest !== intentDigest ||
          existing.sourceThreadId !== intent.source.threadId ||
          existing.sourceRunId !== intent.source.runId ||
          existing.targetThreadId !== record.threadId ||
          existing.status !== "selected" &&
            (existing.targetRunId !== record.runId ||
              existing.targetCheckpointNamespace !== record.namespace)
        ) {
          throw new InitialAdmissionTransferRefused("conflicting-receipt");
        }
        return existing;
      }
      if (record.checkpointId !== null) {
        throw new InitialAdmissionTransferRefused("target-not-empty");
      }
      await query(
        `INSERT INTO ${
          this.table("InitialAdmissionTransferReceipt")
        } ("projectId","systemId","executionSpaceId","operatorId","id","sourceThreadId","sourceRunId","sourceCheckpointNamespace","sourceCheckpointId","targetThreadId","targetRunId","targetCheckpointNamespace","intentDigest","intentJson","status","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'intent',clock_timestamp())`,
        [
          ...values,
          intent.key,
          intent.source.threadId,
          intent.source.runId,
          intent.source.checkpointNamespace,
          intent.source.checkpointId,
          record.threadId,
          record.runId,
          record.namespace,
          intentDigest,
          canonical(intent),
        ],
      );
      return { status: "intent" };
    });
    if (row.status === "selected") {
      if (!record.checkpointId || !row.targetCheckpointId) {
        throw new InitialAdmissionTransferRefused("selected-checkpoint");
      }
      record.forceResumeWait = true;
      return this.createSession(record);
    }
    const reader = new PostgresSaver(this.options.checkpointPool, undefined, {
      schema: this.options.checkpointSchema,
    });
    const sourceTuple = await reader.getTuple({
      configurable: {
        thread_id: intent.source.threadId,
        checkpoint_ns: intent.source.checkpointNamespace,
        checkpoint_id: intent.source.checkpointId,
      },
    });
    if (!sourceTuple) {
      throw new InitialAdmissionTransferRefused("missing-source-tuple");
    }
    const { wait: sourceWait, protocol: sourceProtocol } = await this.client
      .$transaction(async (tx) => {
        const query = fromPrisma(tx).executeSql;
        await verify(query, row.status === "selected");
        const run = (await query(
          `SELECT * FROM ${
            this.table("ExecutionRun")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6 FOR UPDATE`,
          [...values, intent.source.threadId, intent.source.runId],
        )).rows[0];
        const sourceRequest = await this.recoverRequest(query, scope, run, {
          ...request,
          identity: intent.source.identity,
        });
        const wait = await this.waitEvidence.read(
          query,
          scope,
          intent.source.threadId,
          run,
          sourceRequest,
        );
        const protocol = await this.waitEvidence.protocol(
          query,
          scope,
          intent.source.threadId,
          run.runId,
        );
        if (
          !await this.waitEvidence.consumed(
            query,
            scope,
            intent.source.threadId,
            run,
            sourceRequest.contribution.id,
          )
        ) throw new InitialAdmissionTransferRefused("source-consumption-proof");
        return { wait, protocol };
      });
    await verifyInitialAdmissionWait(intent, sourceWait, sourceEffectResult);
    let checkpointId = row.targetCheckpointId as string | undefined;
    if (row.status === "intent") {
      await this.options.initialAdmissionFault?.("before-fork");
      const saver = new FencedExecutionSaver(
        this.options.checkpointPool,
        this.options.checkpointSchema,
        this,
        record,
        record.namespace,
        {
          sourceId: intent.source.checkpointId,
          tuple: sourceTuple,
          onFork: async (query, id) => {
            await verify(query, false);
            const updated = await query(
              `UPDATE ${
                this.table("InitialAdmissionTransferReceipt")
              } SET "status"='forked',"targetCheckpointId"=$6 WHERE ${scopeWhere} AND "id"=$5 AND "status"='intent' AND "targetRunId"=$7 RETURNING "id"`,
              [...values, intent.key, id, record.runId],
            );
            if (
              updated.rows.length !== 1
            ) throw new InitialAdmissionTransferRefused("fork-race");
          },
        },
        { runId: record.runId, request, wait: sourceWait },
      );
      const result = await fork(saver, {
        configurable: {
          thread_id: record.threadId,
          checkpoint_ns: "",
          checkpoint_id: intent.source.checkpointId,
        },
      });
      checkpointId = result.configurable?.checkpoint_id as string | undefined;
      if (
        !checkpointId || result.configurable?.thread_id !== record.threadId ||
        (result.configurable?.checkpoint_ns ?? "") !== ""
      ) throw new InitialAdmissionTransferRefused("fork-config");
      await this.options.initialAdmissionFault?.("after-fork");
    }
    if (!checkpointId) {
      throw new InitialAdmissionTransferRefused("fork-checkpoint");
    }
    const targetConfig = {
      configurable: {
        thread_id: record.threadId,
        checkpoint_ns: record.namespace,
        checkpoint_id: checkpointId,
      },
    };
    const targetTuple = await reader.getTuple(targetConfig);
    if (!targetTuple) throw new InitialAdmissionTransferRefused("fork-tuple");
    verifyOfficialFork(sourceTuple, targetTuple, {
      executionScope: request.identity.scope,
      rootRequestId: intent.target.caseId,
      continuationRef: intent.key,
    }, sourceProtocol);
    const graph = compileNativeOperatorGraph(request.model, () => {
      throw new Error("verification cannot execute");
    }, {
      scope: request.identity.scope,
      operatorId: request.identity.operatorId,
      flow: request.flow,
      maxSteps: request.maxSteps,
      checkpointer: reader,
      assertBoundary: () => {
        throw new Error("verification cannot execute");
      },
    });
    const pending = await graph.graph.getState(targetConfig);
    if (
      pending.next.length !== 1 ||
      pending.next[0] !== nativeFrameworkNodeName(intent.source.occurrenceId)
    ) {
      throw new InitialAdmissionTransferRefused("fork-next-node");
    }
    await this.options.initialAdmissionFault?.("before-selection");
    await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      await this.checkpointFence(query, record, null);
      await verify(query, false);
      const selected = await query(
        `UPDATE ${
          this.table("InitialAdmissionTransferReceipt")
        } SET "status"='selected',"selectedAt"=clock_timestamp() WHERE ${scopeWhere} AND "id"=$5 AND "status"='forked' AND "targetRunId"=$6 AND "targetCheckpointId"=$7 RETURNING "id"`,
        [...values, intent.key, record.runId, checkpointId],
      );
      if (selected.rows.length !== 1) {
        throw new InitialAdmissionTransferRefused("selection-race");
      }
      await this.selectCheckpoint(query, record, null, checkpointId!);
      await query(
        `UPDATE ${
          this.table("OperatorExecution")
        } SET "retiredAt"=clock_timestamp(),"revision"="revision"+1 WHERE ${scopeWhere} AND "threadId"=$5 AND "retiredAt" IS NULL`,
        [...values, intent.source.threadId],
      );
      // Cross-Case lineage belongs to the immutable two-thread receipt above.
      // predecessorThreadId is the birth-bound same-identity advance lineage;
      // assigning it here would mutate B's identity after enrollment.
      await this.lockClaim(query, claim.job);
    });
    record.checkpointId = checkpointId;
    record.forceResumeWait = true;
    await this.options.initialAdmissionFault?.("after-selection");
    return this.createSession(record);
  }

  async resumeRequestNetworkAdoption(
    request: NativeExecutionRequest,
    fork: NativeFork,
  ): Promise<NativeExecutionSession> {
    return await this.#resumeChangeAdoption(request, fork, "network");
  }

  async resumeRequestTeamAdoption(
    request: NativeExecutionRequest,
    fork: NativeFork,
  ): Promise<NativeExecutionSession> {
    return await this.#resumeChangeAdoption(request, fork, "team");
  }

  async #resumeChangeAdoption(
    request: NativeExecutionRequest,
    fork: NativeFork,
    kind: "network" | "team",
  ): Promise<NativeExecutionSession> {
    const proof = parseRequestNetworkContinuation(
      kind === "team"
        ? request.teamAdoptionContinuation
        : request.networkAdoptionContinuation,
    );
    const claim = this.#claim.getStore();
    if (!claim) {
      throw new Error("The exact network continuation claim is unavailable");
    }
    assertChangeAdoptionClaim(request, claim.delivery, proof, kind);
    const scope = this.scope(request.identity), values = scopedValues(scope);
    const verify = async (
      tx: Prisma.TransactionClient,
      lockCheckpoint: boolean,
    ) => {
      const query = fromPrisma(tx).executeSql;
      await this.lockClaim(query, claim.job);
      const row = (await query(
        `SELECT "advanceAuthorizationJson","predecessorThreadId","identityJson","retiredAt" FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5 ${
          lockCheckpoint ? "FOR SHARE" : ""
        }`,
        [...values, proof.successorThreadId],
      )).rows[0];
      if (
        !row || row.retiredAt ||
        row.predecessorThreadId !== proof.predecessorThreadId ||
        row.identityJson !== canonical(request.identity) ||
        typeof row.advanceAuthorizationJson !== "string"
      ) throw new Error("The selected network successor differs");
      const lineage = JSON.parse(row.advanceAuthorizationJson) as {
        authorization?: NativeThreadAdvanceAuthorization;
        source?: NativeExecutionSnapshot;
        target?: unknown;
      };
      const { authorization, snapshot, changeProof } = changeAdoptionLineage(
        request,
        proof,
        kind,
        lineage,
      );
      const openingRow = await tx.spaceOpening.findUnique({
        where: {
          projectId_systemId_executionSpaceId: {
            projectId: scope.projectId,
            systemId: scope.systemId,
            executionSpaceId: scope.executionSpaceId,
          },
        },
      });
      if (!openingRow) throw new Error("The network opening is unavailable");
      const opening = decodeRequestSpaceOpening(openingRow);
      const chain = await new PostgresRequestSourceAdmissionStore(this.client)
        .readAdmittedSource(tx, opening);
      const retirement = changeAdoptionRetirement(
        request,
        proof,
        kind,
        changeProof,
        chain.execution,
        opening.base!,
      );
      const authorizations: string[] = [], inert: string[] = [];
      for (let i = 0; i < retirement.successorThreadIds.length; i++) {
        const selected = (await query(
          `SELECT "predecessorThreadId","advanceAuthorizationJson" FROM ${
            this.table("OperatorExecution")
          } WHERE ${scopeWhere} AND "threadId"=$5`,
          [...values, retirement.successorThreadIds[i]],
        )).rows[0];
        if (
          !selected ||
          selected.predecessorThreadId !== retirement.predecessorThreadIds[i] ||
          typeof selected.advanceAuthorizationJson !== "string"
        ) throw new Error("The network retirement lineage is incomplete");
        const item = JSON.parse(selected.advanceAuthorizationJson) as {
          source?: { kind?: string };
        };
        // A team adoption also retires the inert successors the previous
        // adoption left (see #prepareChangeApprovalCheckpoint).
        if (
          (kind === "team" || changeProof.creationPolicy) &&
          item.source?.kind === "never-started-adoption-successor"
        ) {
          parseNeverStartedAdoptionSource(item.source);
          inert.push(selected.advanceAuthorizationJson);
          continue;
        }
        if (!item.source || item.source.kind !== undefined) {
          throw new Error("Unsupported network retirement source");
        }
        authorizations.push(selected.advanceAuthorizationJson);
      }
      if (
        await executionDigest({
          predecessorThreadIds: retirement.predecessorThreadIds,
          successorThreadIds: retirement.successorThreadIds,
          emptyAuthorization: null,
          ...(inert.length ? { neverStartedAuthorizations: inert } : {}),
          authorizations,
        }) !== retirement.digest
      ) throw new Error("The network retirement digest differs");
      const sourceReceipt = chain.receipts.find((entry) =>
        entry.revision === changeProof.proof.sourceAdmission.revision
      );
      const reread = sourceReceipt
        ? kind === "team"
          ? await readRequestTeamSourceAdmissionProof(
            tx,
            sourceReceipt,
            this.client,
          )
          : changeProof.creationPolicy
          ? await readRequestCreationPolicySourceAdmissionProof(
            tx,
            sourceReceipt,
            this.client,
          )
          : await readRequestNetworkSourceAdmissionProof(
            tx,
            sourceReceipt,
            this.client,
          )
        : undefined;
      assertChangeAdoptionPublication(kind, changeProof, sourceReceipt, reread);
      const wait = snapshot.localState?.changeApprovalWait as
        | import("../../../application/work/native-execution/contract.ts").NativeChangeApprovalWait
        | undefined;
      if (
        !wait || wait.changeId !== proof.changeId ||
        wait.proposalIntentDigest !== proof.proposalIntentDigest ||
        wait.inputMessageId !== proof.originalInputMessageId
      ) throw new Error("The original approval wait differs");
      const effect = (await query(
        `SELECT "status","runId","contributionId","nodeId","resultJson" FROM ${
          this.table("ExecutionEffect")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
        [...values, proof.predecessorThreadId, wait.effectKey],
      )).rows[0];
      if (
        !effect || effect.status !== "completed" ||
        effect.runId !== snapshot.runId ||
        effect.contributionId !== snapshot.contributionId ||
        effect.nodeId !== wait.actionId || typeof effect.resultJson !== "string"
      ) throw new Error("The original proposal effect is unavailable");
      const result = JSON.parse(
        effect.resultJson,
      ) as NativeExecutionActionResult;
      if (
        canonical(result.localState?.changeApprovalProposal) !==
          canonical({
            changeId: proof.changeId,
            proposalIntentDigest: proof.proposalIntentDigest,
          })
      ) throw new Error("The original proposal effect differs");
      if (
        await sha256(
          await this.networkCheckpointRows(query, snapshot, lockCheckpoint),
        ) !== changeProof.checkpointDigest
      ) throw new Error("The original approval checkpoint changed");
      const source = await this.assertUnconsumedSnapshotWait(
        query,
        scope,
        snapshot,
      );
      if (canonical(source.wait.changeApprovalWait) !== canonical(wait)) {
        throw new Error("The original approval wait typed proof differs");
      }
      if (
        !await this.waitEvidence.consumed(
          query,
          scope,
          snapshot.threadId,
          source.run,
          source.request.contribution.id,
        )
      ) throw new Error("NATIVE_WAIT_SOURCE_CONSUMPTION_PROOF_MISSING");
      return {
        snapshot,
        authorization,
        wait: source.wait,
        protocol: source.protocol,
      };
    };
    const source = await this.client.$transaction((tx) => verify(tx, false), {
      isolationLevel: "RepeatableRead",
    });
    const opened = await this.open(request);
    if (opened.alreadyCompleted) return opened;
    const record = this.#sessionRecords.get(opened);
    if (!record || record.threadId !== proof.successorThreadId) {
      throw new Error("The network successor session differs");
    }
    const reader = new PostgresSaver(this.options.checkpointPool, undefined, {
      schema: this.options.checkpointSchema,
    });
    const sourceTuple = await reader.getTuple({
      configurable: {
        thread_id: proof.predecessorThreadId,
        checkpoint_ns: source.snapshot.checkpointNamespace,
        checkpoint_id: proof.checkpointId,
      },
    });
    if (!sourceTuple) {
      throw new Error("The retained approval checkpoint is unavailable");
    }
    await verifyOfficialWaitCheckpoint(sourceTuple, source.wait);
    // A selected successor may already have consumed the wait before a crash.
    // Its immutable receipt proves that handoff; comparing the advanced state
    // to the original fork would incorrectly require prepared to still exist.
    if (record.checkpointId && await opened.contributionConsumed()) {
      const selectedCheckpointId = record.checkpointId;
      const selection = await this.client.$transaction(async (tx) => {
        await verify(tx, true);
        const query = fromPrisma(tx).executeSql;
        await this.checkpointFence(query, record, selectedCheckpointId);
        const consumption = (await query(
          `SELECT c."sourceRunId",c."sourceCheckpointNamespace",c."sourceCheckpointId",w."origin",w."pinJson" FROM ${
            this.table("ExecutionWaitConsumption")
          } c JOIN ${
            this.table("ExecutionWaitReceipt")
          } w ON w."projectId"=c."projectId" AND w."systemId"=c."systemId" AND w."executionSpaceId"=c."executionSpaceId" AND w."operatorId"=c."operatorId" AND w."threadId"=c."threadId" AND w."runId"=c."sourceRunId" AND w."checkpointNamespace"=c."sourceCheckpointNamespace" AND w."checkpointId"=c."sourceCheckpointId" WHERE c."projectId"=$1 AND c."systemId"=$2 AND c."executionSpaceId"=$3 AND c."operatorId"=$4 AND c."threadId"=$5 AND c."runId"=$6 AND c."contributionId"=$7 AND c."kind"='wait-v1'`,
          [...values, record.threadId, record.runId, request.contribution.id],
        )).rows[0];
        if (
          !consumption || consumption.sourceRunId !== record.runId ||
          consumption.sourceCheckpointNamespace !== record.namespace ||
          consumption.origin !== "fork-v1" ||
          consumption.pinJson !== immutablePin(request)
        ) {
          throw new Error(
            "The consumed network continuation lost its exact fork receipt",
          );
        }
        const consumedWait = await this.waitEvidence.read(
          query,
          scope,
          record.threadId,
          {
            runId: record.runId,
            checkpointNamespace: record.namespace,
            checkpointId: consumption.sourceCheckpointId,
            pinJson: immutablePin(request),
          },
          request,
        );
        const expectedWait = {
          ...source.wait,
          modelPin: {
            ...source.wait.modelPin,
            identity: request.model.identity,
            version: request.model.version,
          },
        };
        if (canonical(consumedWait) !== canonical(expectedWait)) {
          throw new Error(
            "The consumed network continuation differs from its retained source wait",
          );
        }
        await this.lockClaim(query, claim.job);
        return Object.freeze({
          mode: "consumed-successor" as const,
          threadId: record.threadId,
          runId: record.runId,
          checkpointNamespace: record.namespace,
          checkpointId: selectedCheckpointId,
          contributionId: request.contribution.id,
        });
      });
      record.forceResumeWait = false;
      const resumed = this.createSession(record);
      delete resumed.resumeRequest;
      resumed.forceResumeWait = false;
      resumed.selectedNetworkContinuation = selection;
      return resumed;
    }
    let checkpointId = record.checkpointId;
    if (!checkpointId) {
      const saver = new FencedExecutionSaver(
        this.options.checkpointPool,
        this.options.checkpointSchema,
        this,
        record,
        record.namespace,
        {
          sourceId: proof.checkpointId,
          tuple: sourceTuple,
          onFork: async (query) => {
            await this.checkpointFence(query, record, null);
            await this.lockClaim(query, claim.job);
          },
        },
        { runId: record.runId, request, wait: source.wait },
      );
      const result = await fork(saver, {
        configurable: {
          thread_id: record.threadId,
          checkpoint_ns: "",
          checkpoint_id: proof.checkpointId,
        },
      }, source.protocol);
      checkpointId = typeof result.configurable?.checkpoint_id === "string"
        ? result.configurable.checkpoint_id
        : null;
      if (
        !checkpointId || result.configurable?.thread_id !== record.threadId ||
        (result.configurable?.checkpoint_ns ?? "") !== ""
      ) throw new Error("The network checkpoint fork differs");
    }
    const targetConfig = {
      configurable: {
        thread_id: record.threadId,
        checkpoint_ns: record.namespace,
        checkpoint_id: checkpointId,
      },
    };
    const targetSnapshot = {
      ...source.snapshot,
      threadId: record.threadId,
      checkpointNamespace: record.namespace,
      checkpointId,
    };
    const readTargetRows = () =>
      this.client.$transaction(
        (tx) =>
          this.networkCheckpointRows(
            fromPrisma(tx).executeSql,
            targetSnapshot,
            false,
          ),
        { isolationLevel: "RepeatableRead" },
      );
    const targetRows = await readTargetRows();
    const targetTuple = await reader.getTuple(targetConfig);
    if (!targetTuple) {
      throw new Error("The network successor checkpoint is unavailable");
    }
    verifyOfficialFork(sourceTuple, targetTuple, {
      modelPin: {
        ...source.wait.modelPin,
        identity: request.model.identity,
        version: request.model.version,
      },
      continuationRef: `request-${kind}-adoption:${proof.receiptDigest}`,
    }, source.protocol);
    const waitNode = source.snapshot.waits[0]?.nodeId;
    const graph = compileNativeOperatorGraph(request.model, () => {
      throw new Error("Verification cannot execute");
    }, {
      scope: request.identity.scope,
      operatorId: request.identity.operatorId,
      flow: request.flow,
      maxSteps: request.maxSteps,
      checkpointer: reader,
      assertBoundary: () => {
        throw new Error("Verification cannot execute");
      },
    });
    const graphState = await graph.graph.getState(targetConfig);
    if (
      !waitNode || graphState.next.length !== 1 ||
      graphState.next[0] !== nativeFrameworkNodeName(waitNode)
    ) throw new Error("The network fork does not select the exact wait");
    if (await readTargetRows() !== targetRows) {
      throw new Error("The network fork changed during verification");
    }
    const selectedCheckpointId = checkpointId;
    const selection = await this.client.$transaction(async (tx) => {
      await verify(tx, true);
      const query = fromPrisma(tx).executeSql;
      await this.checkpointFence(query, record, record.checkpointId);
      if (
        await this.networkCheckpointRows(query, targetSnapshot, true) !==
          targetRows
      ) throw new Error("The verified network fork changed before selection");
      if (!record.checkpointId) {
        await this.selectCheckpoint(query, record, null, selectedCheckpointId);
      }
      await this.lockClaim(query, claim.job);
      return Object.freeze({
        mode: "awaiting-consumption" as const,
        threadId: record.threadId,
        runId: record.runId,
        checkpointNamespace: record.namespace,
        checkpointId: selectedCheckpointId,
        contributionId: request.contribution.id,
      });
    });
    record.checkpointId = selectedCheckpointId;
    record.forceResumeWait = true;
    const session = this.createSession(record);
    delete session.resumeRequest;
    session.selectedNetworkContinuation = selection;
    return session;
  }

  private async verifyAdvance(
    query: ExecutionSql,
    record: SessionRecord,
    advance: AdvanceRequest,
  ) {
    await this.assertNoOpenGroups(query, record.scope, record.threadId);
    const node = nativeAdvanceSourceNode(record, advance);
    const effect = (await query(
      `SELECT * FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
      [
        ...scopedValues(record.scope),
        record.threadId,
        advance.source.settledEffectKey,
      ],
    )).rows[0];
    // An await_input prepare records no effect: the retained conversation wait
    // is genuine only while its prepared key stays unconsumed.
    const retainedConversationInput = advance.mode === "retained-wait" &&
      record.request.identity.purpose === "conversation" &&
      node.mechanism === "await_input";
    if (
      advance.evidence.kind === "verified-mandate-advance" ||
      retainedConversationInput
    ) {
      if (effect) {
        throw new Error("The retained conversation wait was already consumed");
      }
    } else if (
      !effect || effect.runId !== record.runId ||
      effect.nodeId !== node.nativeId || effect.status !== "completed" ||
      typeof effect.resultJson !== "string"
    ) {
      throw new Error(
        "Native continuation lacks its exact settled effect receipt",
      );
    }
    if (advance.mode === "retained-wait") {
      const prior = (await query(
        `SELECT * FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...scopedValues(record.scope), record.threadId, record.runId],
      )).rows[0];
      if (!prior) throw new Error("Retained wait predecessor is unavailable");
      const retained = await this.retainedWaitAdvance(
        query,
        record.scope,
        record.threadId,
        prior,
        advance.target,
        true,
      );
      if (
        canonical(retained.advance.source) !== canonical(advance.source) ||
        canonical(retained.advance.evidence) !== canonical(advance.evidence)
      ) throw new Error("Retained wait continuation evidence changed");
    } else if (
      advance.evidence.kind === "verified-mandate-advance" ||
      advance.evidence.kind === "verified-budget-ceiling-advance"
    ) {
      throw new Error(
        "A mandate continuation requires its retained conversation wait",
      );
    } else if (
      canonical(
        JSON.parse((effect as { resultJson: string }).resultJson).modelAdvance,
      ) !== canonical(advance.evidence)
    ) {
      throw new Error(
        "The publication result does not attest this native model advance",
      );
    }
    const accepted = await this.businessRevision(
      query,
      record.scope,
      advance.evidence.businessRevision,
    );
    await assertAcceptedModelAdvance(record.request, advance, accepted);
    const current = await this.currentBusiness(query, record.scope);
    assertCurrentModelAdvance(advance.target, current);
    const uncertain = await query(
      `SELECT "effectKey" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' LIMIT 1`,
      [...scopedValues(record.scope), record.threadId],
    );
    if (uncertain.rows.length) {
      throw new Error(
        advance.evidence.kind === "verified-mandate-advance"
          ? "Unsettled effects block native mandate continuation"
          : "Unsettled effects block native catalog continuation",
      );
    }
  }

  private async advance(
    record: SessionRecord,
    advance: AdvanceRequest,
    fork: NativeFork,
  ) {
    const sourceNode = record.request.flow.nodes.find((node) =>
      nativeFrameworkNodeName(node.id, "await-preparation") ===
        advance.source.preparedNodeId
    );
    if (!sourceNode) {
      throw new Error(
        "Continuation source occurrence is outside its admitted flow",
      );
    }
    const sourceKind = advance.mode === "retained-wait" &&
        record.request.identity.purpose === "conversation" &&
        sourceNode.mechanism === "await_input"
      ? "unconsumed-input-wait"
      : advance.evidence.kind === "verified-budget-ceiling-advance"
      ? "settled-budget-wait"
      : "settled-effect";
    const evidenceDigest = await executionDigest(advance.evidence);
    const id = `native-continuation:${await executionDigest({
      source: advance.source,
      predecessorRunId: record.runId,
      evidenceDigest,
    })}`;
    const targetPin = immutablePin(advance.target),
      values = [...scopedValues(record.scope), record.threadId];
    const intent = await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      await this.checkpointFence(query, record, advance.source.checkpointId);
      await this.verifyAdvance(query, record, advance);
      const previous = (await query(
        `SELECT * FROM ${
          this.table("NativeContinuationReceipt")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "id"=$6 FOR UPDATE`,
        [...values, id],
      )).rows[0];
      if (previous) {
        const priorSourceKind = previous.sourceKind ??
          (previous.evidenceKind === "verified-catalog-advance"
            ? "settled-effect"
            : previous.evidenceKind === "verified-mandate-advance"
            ? "unconsumed-input-wait"
            : undefined);
        if (
          previous.evidenceDigest !== evidenceDigest ||
          previous.targetPinJson !== targetPin ||
          previous.status === "rejected" ||
          priorSourceKind !== sourceKind ||
          previous.sourceOccurrenceId !== null &&
            previous.sourceOccurrenceId !== undefined &&
            previous.sourceOccurrenceId !== sourceNode.id
        ) throw new Error("Native continuation intent identity conflict");
        return {
          runId: String(previous.successorRunId),
          namespace: String(
            previous.successorCheckpointNamespace ??
              `run:${previous.successorRunId}`,
          ),
          epoch: record.epoch + 1n,
        };
      }
      const runId = crypto.randomUUID(),
        namespace = `run:${runId}`,
        epoch = record.epoch + 1n;
      const oldRun = (await query(
        `SELECT "parentThreadId","parentRunId" FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...values, record.runId],
      )).rows[0];
      // The retained resume contribution binds its request digest and successor
      // run atomically: the receipt check requires both set or both absent.
      let retainedContribution:
        | { id: string; requestDigest: string }
        | undefined;
      if (advance.mode === "retained-wait") {
        const claim = this.#claim.getStore();
        if (!claim || claim.job.id !== record.jobId) {
          throw new Error("Retained input has no current delivery claim");
        }
        const digest = await executionDigest(claim.delivery),
          requestDigest = await executionDigest({
            identity: advance.target.identity,
            contribution: advance.target.contribution,
            pin: targetPin,
          });
        const existing = (await query(
          `SELECT * FROM ${
            this.table("ExecutionContribution")
          } WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6`,
          [...values, advance.target.contribution.id],
        )).rows[0];
        if (
          existing &&
          (existing.digest !== digest ||
            existing.requestDigest &&
              existing.requestDigest !== requestDigest ||
            existing.runId)
        ) {
          throw new Error(
            "Retained wait input already has a different accepted execution",
          );
        }
        await query(
          `INSERT INTO ${
            this.table("ExecutionContribution")
          } ("projectId","systemId","executionSpaceId","operatorId","threadId","contributionId","digest","requestDigest","kind","originJson","payloadJson","jobId","runId","status","acceptedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'queued',clock_timestamp()) ON CONFLICT DO NOTHING`,
          [
            ...values,
            advance.target.contribution.id,
            digest,
            requestDigest,
            advance.target.contribution.kind,
            canonical({ delivery: claim.delivery }),
            canonical(claim.delivery),
            claim.job.id,
            runId,
          ],
        );
        retainedContribution = {
          id: advance.target.contribution.id,
          requestDigest,
        };
      }
      await query(
        `INSERT INTO ${
          this.table("ExecutionRun")
        } ("projectId","systemId","executionSpaceId","operatorId","threadId","runId","generation","contributionId","pinJson","status","checkpointNamespace","epoch","jobId","retryCount","predecessorRunId","parentThreadId","parentRunId","modelReferenceJson","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10,$11,$12,$13,$14,$15,$16,$17,clock_timestamp(),clock_timestamp())`,
        [
          ...values,
          runId,
          epoch,
          advance.target.contribution.id,
          targetPin,
          namespace,
          epoch,
          record.jobId,
          record.retryCount,
          record.runId,
          oldRun?.parentThreadId ?? null,
          oldRun?.parentRunId ?? null,
          modelSourceReference(advance.target),
        ],
      );
      await this.waitEvidence.initialize(
        query,
        record.scope,
        record.threadId,
        runId,
      );
      await query(
        `INSERT INTO ${
          this.table("NativeContinuationReceipt")
        } ("projectId","systemId","executionSpaceId","operatorId","threadId","id","predecessorRunId","sourceCheckpointNamespace","sourceCheckpointId","preparedNodeId","settledEffectKey","evidenceKind","evidenceDigest","evidenceJson","successorRunId","targetPinJson","sourceKind","sourceOccurrenceId","sourceNativeActionId","status","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'intent',clock_timestamp())`,
        [
          ...values,
          id,
          record.runId,
          record.namespace,
          advance.source.checkpointId,
          advance.source.preparedNodeId,
          advance.source.settledEffectKey,
          advance.evidence.kind,
          evidenceDigest,
          canonical(advance.evidence),
          runId,
          targetPin,
          sourceKind,
          sourceNode.id,
          sourceNode.nativeId,
        ],
      );
      if (retainedContribution) {
        await query(
          `UPDATE ${
            this.table("ExecutionContribution")
          } SET "runId"=$7,"requestDigest"=$8 WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6 AND "runId" IS NULL`,
          [
            ...values,
            retainedContribution.id,
            runId,
            retainedContribution.requestDigest,
          ],
        );
      }
      return { runId, namespace, epoch };
    });
    // Official updateState owns the fork. The provided saver fences every write
    // but intentionally leaves it unselected; an interrupted selection may leave
    // orphan bytes, which no run configuration will ever choose implicitly.
    const sourceConfig = {
      configurable: {
        thread_id: record.threadId,
        checkpoint_ns: record.namespace,
        checkpoint_id: advance.source.checkpointId,
      },
    };
    const reader = new PostgresSaver(this.options.checkpointPool, undefined, {
      schema: this.options.checkpointSchema,
    });
    const sourceTuple = await reader.getTuple(sourceConfig);
    if (!sourceTuple) {
      throw new Error("The selected native source checkpoint is unavailable");
    }
    const { wait: sourceWait, protocol: sourceProtocol } = await this.client
      .$transaction(async (tx) => {
        const query = fromPrisma(tx).executeSql;
        await this.checkpointFence(query, record, advance.source.checkpointId);
        const wait = await this.waitEvidence.read(
          query,
          record.scope,
          record.threadId,
          {
            runId: record.runId,
            checkpointNamespace: record.namespace,
            checkpointId: record.checkpointId,
            pinJson: immutablePin(record.request),
          },
          record.request,
        );
        const protocol = await this.waitEvidence.protocol(
          query,
          record.scope,
          record.threadId,
          record.runId,
        );
        if (
          !await this.waitEvidence.consumed(
            query,
            record.scope,
            record.threadId,
            {
              runId: record.runId,
              checkpointNamespace: record.namespace,
              checkpointId: record.checkpointId,
            },
            record.request.contribution.id,
          )
        ) throw new Error("NATIVE_WAIT_SOURCE_CONSUMPTION_PROOF_MISSING");
        return { wait, protocol };
      });
    const unselected = new UnselectedNativeForkSaver(
      this.options.checkpointPool,
      this.options.checkpointSchema,
      this,
      record,
      intent.namespace,
      { runId: intent.runId, request: advance.target, wait: sourceWait },
    );
    const config = await fork(unselected, {
      configurable: {
        thread_id: record.threadId,
        checkpoint_ns: "",
        checkpoint_id: advance.source.checkpointId,
      },
    });
    const selectedId = config.configurable?.checkpoint_id;
    if (
      config.configurable?.thread_id !== record.threadId ||
      (config.configurable?.checkpoint_ns ?? "") !== "" ||
      typeof selectedId !== "string" || !selectedId
    ) {
      throw new Error(
        "Official native fork returned an invalid selected checkpoint",
      );
    }
    const physicalForkConfig = {
      configurable: {
        thread_id: record.threadId,
        checkpoint_ns: intent.namespace,
        checkpoint_id: selectedId,
      },
    };
    const tuple = await reader.getTuple(physicalForkConfig);
    if (!tuple) throw new Error("Official native fork checkpoint missing");
    verifyOfficialFork(sourceTuple, tuple, {
      modelPin: {
        ...sourceWait.modelPin,
        identity: advance.target.model.identity,
        version: advance.target.model.version,
      },
      continuationRef: `${record.threadId}:${advance.source.checkpointId}`,
    }, sourceProtocol);
    const verifiedGraph = compileNativeOperatorGraph(
      advance.target.model,
      () => {
        throw new Error("Continuation verification cannot execute a primitive");
      },
      {
        scope: advance.target.identity.scope,
        operatorId: advance.target.identity.operatorId,
        flow: advance.target.flow,
        maxSteps: advance.target.maxSteps,
        checkpointer: reader,
        assertBoundary: () => {
          throw new Error("Continuation verification cannot execute a node");
        },
      },
    );
    const pending = await verifiedGraph.graph.getState(physicalForkConfig);
    if (
      pending.next.length !== 1 ||
      pending.next[0] !== nativeFrameworkNodeName(sourceNode.id)
    ) {
      throw new Error(
        "Native continuation did not retain the prepared commit as its exact next node",
      );
    }
    await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      await this.checkpointFence(query, record, advance.source.checkpointId);
      await this.verifyAdvance(query, record, advance);
      const receipt = (await query(
        `SELECT * FROM ${
          this.table("NativeContinuationReceipt")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "id"=$6 FOR UPDATE`,
        [...values, id],
      )).rows[0];
      if (
        !receipt || receipt.status !== "intent" ||
        receipt.successorRunId !== intent.runId ||
        receipt.evidenceDigest !== evidenceDigest
      ) throw new Error("Native continuation selection changed");
      await query(
        `UPDATE ${
          this.table("ExecutionRun")
        } SET "status"='completed',"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...values, record.runId],
      );
      const selected = await query(
        `UPDATE ${
          this.table("ExecutionRun")
        } SET "status"='running',"checkpointId"=$7,"epoch"=$8,"jobId"=$9,"retryCount"=$10,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6 AND "status"='reserved' RETURNING "runId"`,
        [
          ...values,
          intent.runId,
          selectedId,
          intent.epoch,
          record.jobId,
          record.retryCount,
        ],
      );
      if (selected.rows.length !== 1) {
        throw new Error("Reserved native successor changed before selection");
      }
      await query(
        `UPDATE ${
          this.table("OperatorExecution")
        } SET "epoch"=$6,"revision"="revision"+1,"currentRunId"=$7,"currentCheckpointId"=$8,"checkpointNamespace"=$9,"status"='running',"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5`,
        [...values, intent.epoch, intent.runId, selectedId, intent.namespace],
      );
      await query(
        `UPDATE ${
          this.table("NativeContinuationReceipt")
        } SET "status"='selected',"successorCheckpointNamespace"=$7,"successorCheckpointId"=$8,"selectedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "id"=$6`,
        [...values, id, intent.namespace, selectedId],
      );
      if (advance.mode === "retained-wait") {
        await query(
          `UPDATE ${
            this.table("ExecutionContribution")
          } SET "status"='running' WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6 AND "runId"=$7`,
          [...values, advance.target.contribution.id, intent.runId],
        );
      }
      await this.lockClaim(query, {
        id: record.jobId,
        retryCount: record.retryCount,
        signal: record.signal,
      });
    });
    const receipt: NativeContinuationReceipt = {
      id,
      predecessorRunId: record.runId,
      source: advance.source,
      evidence: advance.evidence,
      successorRunId: intent.runId,
    };
    return {
      receipt,
      session: this.createSession({
        ...record,
        runId: intent.runId,
        namespace: intent.namespace,
        epoch: intent.epoch,
        checkpointId: selectedId,
        request: advance.target,
        beforeInputAdvance: undefined,
        forceResumeWait: advance.mode === "retained-wait",
        ownsDelivery:
          record.threadId === this.#claim.getStore()?.job.data.threadId &&
          advance.target.contribution.id ===
            this.#claim.getStore()?.delivery.id,
      }),
    };
  }

  /** R4b journal for one authenticated session. Each append is its own SQL
   * transaction, fenced before and after against claim, binding, epoch,
   * selected run and exact cursor; it is never held across the business
   * callback and never joins queue acceptance, effect or saver commits. */
  nativeObservationJournal(record: SessionRecord): NativeObservationJournal {
    const binding = {
      operatorId: record.request.identity.operatorId,
      ...(record.request.identity.scope.kind === "request"
        ? { rootRequestId: record.request.identity.scope.rootRequestId }
        : {}),
      modelDigest: record.request.model.version.digest,
      ...(record.request.model.version.repositoryVersion
        ? {
          repositoryVersion: record.request.model.version.repositoryVersion,
        }
        : {}),
      occurrenceIds: new Set(
        record.request.flow.nodes.map((node) => node.id),
      ),
    };
    return {
      append: (emission) =>
        this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.checkpointFence(query, record, record.checkpointId);
          assertNativeObservationBinding(emission, binding);
          const pinJson = immutablePin(record.request);
          const run = (await query(
            `SELECT "pinJson" FROM ${
              this.table("ExecutionRun")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
            [...scopedValues(record.scope), record.threadId, record.runId],
          )).rows[0];
          if (!run || run.pinJson !== pinJson) {
            throw new Error("NATIVE_OBSERVATION_PIN_MISMATCH");
          }
          const appended = await this.nativeObservations.append(
            query,
            record.scope,
            {
              threadId: record.threadId,
              runId: record.runId,
              checkpointNamespace: record.namespace,
              contributionId: record.request.contribution.id,
              identityJson: canonical(record.request.identity),
              pinJson,
              epoch: record.epoch,
              jobId: record.jobId,
              retryCount: record.retryCount,
            },
            emission,
          );
          await this.checkpointFence(query, record, record.checkpointId);
          return appended;
        }),
      read: () =>
        this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.checkpointFence(query, record, record.checkpointId);
          return await this.nativeObservations.read(
            query,
            record.scope,
            record.threadId,
            record.runId,
          );
        }),
    };
  }

  /** Post-hoc scoped reader: only the requested run, in producer order. */
  async readNativeObservations(
    operatorId: string,
    threadId: string,
    runId: string,
  ) {
    const scope = this.scope({ operatorId });
    return await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      const run = (await query(
        `SELECT "runId" FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...scopedValues(scope), threadId, runId],
      )).rows[0];
      if (!run) throw new Error("NATIVE_OBSERVATION_RUN_MISSING");
      return await this.nativeObservations.read(
        query,
        scope,
        threadId,
        runId,
      );
    });
  }

  createSession(record: SessionRecord): NativeExecutionSession {
    const assertCurrent = async () => {
      await this.client.$transaction(async (tx) => {
        await this.checkpointFence(
          fromPrisma(tx).executeSql,
          record,
          record.checkpointId,
        );
      });
    };
    const unsettledEffects = async () => {
      const rows = await this.client.$queryRawUnsafe<{ effectKey: string }[]>(
        `SELECT "effectKey" FROM ${
          this.table("ExecutionEffect")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' ORDER BY "startedAt","effectKey"`,
        ...scopedValues(record.scope),
        record.threadId,
      );
      return rows.map((row) => row.effectKey);
    };
    const immutableConsultations = createPostgresImmutableConsultationSession({
      request: record.request,
      runId: record.runId,
      threadId: record.threadId,
      epoch: record.epoch,
      jobId: record.jobId,
      retryCount: record.retryCount,
      values: [...scopedValues(record.scope), record.threadId],
      groupTable: this.table("ImmutableConsultationGroup"),
      effectTable: this.table("ExecutionEffect"),
      transact: (operation) =>
        this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.checkpointFence(query, record, record.checkpointId);
          const result = await operation(query);
          await this.checkpointFence(query, record, record.checkpointId);
          return result;
        }),
      operate: (operation) =>
        withPostgresExecutionTransaction({
          client: this.client,
          session: { threadId: record.threadId, runId: record.runId },
          fence: (query) =>
            this.checkpointFence(query, record, record.checkpointId),
        }, operation),
      businessRevision: (query, reference) =>
        this.businessRevision(query, record.scope, reference),
      currentBusiness: (query) => this.currentBusiness(query, record.scope),
      assertCaseOpen: async (query, source, caseId) => {
        const invocation = source.caseInvocation;
        const captured =
          invocation?.kind === "local" && invocation.caseId === caseId
            ? source.cases?.find((item) => item.id === caseId)
            : invocation?.kind === "delegated" &&
                invocation.work.caseContext.caseId === caseId
            ? invocation.work.caseContext.record
            : undefined;
        if (!captured || captured.id !== caseId || !captured.owner?.trim()) {
          throw new Error("IMMUTABLE_CONSULTATION_CASE_OWNER_UNAVAILABLE");
        }
        const ownerScope = { ...record.scope, operatorId: captured.owner };
        // Same stable parent and lock strength as SystemStateStore.save. Keep
        // claim/thread fencing before this lock on both paths. Never lock a
        // contributor thread from the closure guard (owner -> thread inverts it).
        const locked = await query(
          `UPDATE ${this.#schema}."OperatorRuntime" SET "operatorId"="operatorId" WHERE ${scopeWhere} RETURNING "operatorId"`,
          scopedValues(ownerScope),
        );
        if (locked.rows.length !== 1) {
          throw new Error("IMMUTABLE_CONSULTATION_CASE_OWNER_UNAVAILABLE");
        }
        const owner = await this.currentBusiness(query, ownerScope);
        const actual = owner.cases?.find((item) => item.id === caseId);
        if (
          owner.executionModel?.identity.builderId !== captured.owner ||
          !actual || actual.owner !== captured.owner ||
          actual.number !== captured.number ||
          canonical(actual.modelPin) !== canonical(captured.modelPin)
        ) {
          throw new Error("IMMUTABLE_CONSULTATION_CASE_OWNER_MISMATCH");
        }
        if (!isOpenCase(actual)) {
          throw new Error("IMMUTABLE_CONSULTATION_CASE_CLOSED");
        }
      },
    });
    const session: NativeExecutionSession = {
      threadId: record.threadId,
      checkpointNamespace: record.namespace,
      runId: record.runId,
      resumeRequest: record.request,
      ...(record.selectedBudgetContinuation
        ? { selectedBudgetContinuation: record.selectedBudgetContinuation }
        : {}),
      signal: record.signal,
      ...(record.beforeInputAdvance
        ? { beforeInputAdvance: record.beforeInputAdvance }
        : {}),
      ...(record.forceResumeWait ? { forceResumeWait: true } : {}),
      ...(record.checkpointId ? { checkpointId: record.checkpointId } : {}),
      checkpointer: new FencedExecutionSaver(
        this.options.checkpointPool,
        this.options.checkpointSchema,
        this,
        record,
      ),
      assertCurrent,
      contributionConsumed: () =>
        this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.checkpointFence(query, record, record.checkpointId);
          return await this.waitEvidence.consumed(
            query,
            record.scope,
            record.threadId,
            {
              runId: record.runId,
              checkpointNamespace: record.namespace,
              checkpointId: record.checkpointId,
            },
            record.request.contribution.id,
          );
        }),
      withSelectionFence: (operation) =>
        withPostgresExecutionTransaction({
          client: this.client,
          session: { threadId: record.threadId, runId: record.runId },
          fence: (query) =>
            this.checkpointFence(query, record, record.checkpointId),
        }, operation),
      unsettledEffects,
      immutableConsultations,
      nativeObservations: this.nativeObservationJournal(record),
      advance: (advance, fork) => this.advance(record, advance, fork),
      effect: async (key, node, operation, admit, target) => {
        const requestDigest = await executionDigest({
          key,
          nodeId: node.id,
          nativeId: node.nativeId,
          contribution: record.request.contribution,
          pin: immutablePin(record.request),
          ...(target?.retainedTool ? { target } : {}),
        });
        const prior = await this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.checkpointFence(query, record, record.checkpointId);
          const values = [...scopedValues(record.scope), record.threadId, key];
          const previous = (await query(
            `SELECT * FROM ${
              this.table("ExecutionEffect")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6 FOR UPDATE`,
            values,
          )).rows[0];
          if (previous) {
            if (previous.requestDigest !== requestDigest) {
              throw new Error("EFFECT_RECEIPT_MISMATCH");
            }
            if (
              previous.status === "completed" &&
              typeof previous.resultJson === "string"
            ) {
              return JSON.parse(
                previous.resultJson,
              ) as NativeExecutionActionResult;
            }
            await query(
              `UPDATE ${
                this.table("ExecutionEffect")
              } SET "status"='unknown' WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
              values,
            );
            return "unknown" as const;
          }
          await this.assertNoOpenGroups(query, record.scope, record.threadId);
          return null;
        });
        if (prior === "unknown") {
          throw new Error(`EXECUTION_EFFECT_UNKNOWN:${key}`);
        }
        if (prior) return prior;
        if (!admit) {
          throw new Error(
            "A fresh native effect requires an explicit admission callback",
          );
        }
        const refuse = async (error: unknown): Promise<never> => {
          const refusal = new NativeExecutionAdmissionRefused(
            "NATIVE_EXECUTION_ADMISSION_REFUSED",
            node.id,
            errorText(error).slice(0, 450),
          );
          await this.client.$transaction(async (tx) => {
            const query = fromPrisma(tx).executeSql;
            await this.checkpointFence(query, record, record.checkpointId);
            await this.assertNoOpenGroups(query, record.scope, record.threadId);
            const unknown = await query(
              `SELECT "effectKey" FROM ${
                this.table("ExecutionEffect")
              } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' LIMIT 1`,
              [...scopedValues(record.scope), record.threadId],
            );
            if (unknown.rows.length) {
              throw new Error(
                "Unsettled native effects cannot be relabelled as admission refusal",
              );
            }
            const current = await this.currentBusiness(query, record.scope);
            const snapshot: NativeExecutionSnapshot = {
              contributionId: record.request.contribution.id,
              identity: record.request.identity,
              threadId: record.threadId,
              modelDigest: record.request.model.version.digest,
              repositoryVersion: record.request.model.version.repositoryVersion,
              flowRootId: record.request.flow.rootNativeId,
              status: "refused",
              ...(record.checkpointId
                ? { checkpointId: record.checkpointId }
                : {}),
              refusal: {
                code: refusal.code,
                nodeId: refusal.nodeId,
                message: refusal.message,
              },
              waits: [],
              unsettledEffects: [],
              pendingContributions: Object.entries(
                current.pendingContributions ?? {},
              ).filter(([, receipt]) => receipt.status === "pending").map((
                [id],
              ) => id),
            };
            await query(
              `UPDATE ${
                this.table("ExecutionRun")
              } SET "status"='completed',"snapshotJson"=$7,"errorJson"=$8,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6 AND "snapshotJson" IS NULL`,
              [
                ...scopedValues(record.scope),
                record.threadId,
                record.runId,
                canonical(snapshot),
                canonical(snapshot.refusal),
              ],
            );
            await query(
              `UPDATE ${
                this.table("OperatorExecution")
              } SET "status"='completed',"revision"="revision"+1,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5`,
              [...scopedValues(record.scope), record.threadId],
            );
            await query(
              `UPDATE ${
                this.table("ExecutionContribution")
              } SET "status"='completed',"completedAt"=COALESCE("completedAt",clock_timestamp()) WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6`,
              [
                ...scopedValues(record.scope),
                record.threadId,
                record.request.contribution.id,
              ],
            );
            await this.checkpointFence(query, record, record.checkpointId);
          });
          throw refusal;
        };
        try {
          await withPostgresExecutionTransaction({
            client: this.client,
            session: { threadId: record.threadId, runId: record.runId },
            fence: async (query) => {
              await this.checkpointFence(query, record, record.checkpointId);
            },
          }, admit);
        } catch (error) {
          return await refuse(error);
        }
        const raced = await this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.checkpointFence(query, record, record.checkpointId);
          const values = [...scopedValues(record.scope), record.threadId, key];
          const existing = (await query(
            `SELECT * FROM ${
              this.table("ExecutionEffect")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6 FOR UPDATE`,
            values,
          )).rows[0];
          if (existing) {
            if (
              existing.requestDigest !== requestDigest ||
              existing.status !== "completed" ||
              typeof existing.resultJson !== "string"
            ) {
              throw new Error(
                "Native effect was already started under this invocation",
              );
            }
            return JSON.parse(
              existing.resultJson,
            ) as NativeExecutionActionResult;
          }
          await this.assertNoOpenGroups(query, record.scope, record.threadId);
          const unknown = await query(
            `SELECT "effectKey" FROM ${
              this.table("ExecutionEffect")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' LIMIT 1`,
            [...scopedValues(record.scope), record.threadId],
          );
          if (unknown.rows.length) {
            throw new Error(
              "Unsettled native effects block new operation dispatch",
            );
          }
          let authorizationJson: string | null = null;
          if (this.options.spaceEffectStart) {
            try {
              const proof = await this.options.spaceEffectStart(tx, {
                scope: record.scope,
                request: record.request,
                node,
                target,
              });
              authorizationJson = canonical(proof);
              if (
                proof.scope.projectId !== record.scope.projectId ||
                proof.scope.systemId !== record.scope.systemId ||
                proof.executionSpaceId !== record.scope.executionSpaceId ||
                new TextEncoder().encode(authorizationJson).byteLength > 32_768
              ) {
                throw new Error("Invalid bounded space authorization proof");
              }
            } catch (error) {
              if (
                error instanceof RequestSpaceError &&
                (error.code === "ADMISSION_REFUSED" ||
                  error.code === "FORBIDDEN")
              ) {
                throw new NativeExecutionAdmissionRefused(
                  "NATIVE_EXECUTION_ADMISSION_REFUSED",
                  node.id,
                  "Current space authority or admission is unavailable.",
                );
              }
              // Timeout/deadlock/codec/proof failures remain technical failures.
              // The transaction rolls back before started; no operation has run.
              throw error;
            }
          }
          await query(
            `INSERT INTO ${
              this.table("ExecutionEffect")
            } ("projectId","systemId","executionSpaceId","operatorId","threadId","effectKey","runId","contributionId","nodeId","requestDigest","status","epoch","jobId","retryCount","startedAt","authorizationJson") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'started',$11,$12,$13,clock_timestamp(),$14)`,
            [
              ...values,
              record.runId,
              record.request.contribution.id,
              node.nativeId,
              requestDigest,
              record.epoch,
              record.jobId,
              record.retryCount,
              authorizationJson,
            ],
          );
          return null;
        }).catch(async (error: unknown) => {
          if (error instanceof NativeExecutionAdmissionRefused) {
            return await refuse(error);
          }
          throw error;
        });
        if (raced) return raced;
        try {
          const result = await withPostgresExecutionTransaction({
            client: this.client,
            session: { threadId: record.threadId, runId: record.runId },
            fence: async (query) => {
              await this.checkpointFence(query, record, record.checkpointId);
            },
          }, () =>
            providerCallContext.run({
              executionScope: {
                projectId: record.scope.projectId,
                systemId: record.scope.systemId,
                executionSpaceId: record.scope.executionSpaceId,
              },
              scopeKind: record.request.identity.scope.kind,
              scopeId: record.request.identity.scope.scopeId,
              // rootRequestId is captured by nativeExecutionIdentity from the
              // actual Case context; never reconstruct it from scopeId.
              caseId: record.request.identity.scope.kind === "request"
                ? record.request.identity.scope.rootRequestId
                : null,
              operatorId: record.request.identity.operatorId,
              threadId: record.threadId,
              runId: record.runId,
              effectId: key,
              nodeId: node.nativeId,
              modelDigest: record.request.model.version.digest,
              repositoryVersion:
                record.request.model.version.repositoryVersion ?? null,
              budgetAttemptId: null,
              budgetOperation: null,
            }, operation));
          const resultJson = canonical(result);
          await this.client.$transaction(async (tx) => {
            const query = fromPrisma(tx).executeSql;
            await this.checkpointFence(query, record, record.checkpointId);
            const completed = await query(
              `UPDATE ${
                this.table("ExecutionEffect")
              } SET "status"='completed',"resultJson"=$7,"completedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6 AND "status"='started' AND "epoch"=$8 RETURNING "effectKey"`,
              [
                ...scopedValues(record.scope),
                record.threadId,
                key,
                resultJson,
                record.epoch,
              ],
            );
            if (completed.rows.length !== 1) {
              throw new Error("Execution effect receipt changed");
            }
            await this.fence(query, record);
          });
          return result;
        } catch (error) {
          // A rejected callback can have committed a business/external effect.
          // Its durable started receipt is deliberately not made replayable.
          await this.client.$executeRawUnsafe(
            `UPDATE ${
              this.table("ExecutionEffect")
            } SET "status"='unknown' WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6 AND "status"='started' AND "epoch"=$7`,
            ...scopedValues(record.scope),
            record.threadId,
            key,
            record.epoch,
          ).catch(() => {});
          throw error;
        }
      },
      complete: async (snapshot) => {
        if (
          snapshot.threadId !== record.threadId ||
          snapshot.runId !== record.runId ||
          snapshot.checkpointNamespace !== record.namespace ||
          canonical(snapshot.identity) !== canonical(record.request.identity) ||
          snapshot.contributionId !== record.request.contribution.id ||
          snapshot.modelDigest !== record.request.model.version.digest ||
          snapshot.repositoryVersion !==
            record.request.model.version.repositoryVersion ||
          snapshot.flowRootId !== record.request.flow.rootNativeId ||
          !Array.isArray(snapshot.pendingContributions)
        ) {
          throw new Error(
            "Execution completion identity or model receipt mismatch",
          );
        }
        await this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.fence(query, record);
          await this.assertNoOpenGroups(query, record.scope, record.threadId);
          const values = [
            ...scopedValues(record.scope),
            record.threadId,
            record.runId,
          ];
          const row = (await query(
            `SELECT "checkpointId" FROM ${
              this.table("ExecutionRun")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6 FOR UPDATE`,
            values,
          )).rows[0];
          if (row?.checkpointId !== snapshot.checkpointId) {
            throw new Error(
              "Execution completion does not select the accepted checkpoint",
            );
          }
          const waitRun = {
            runId: record.runId,
            checkpointNamespace: record.namespace,
            checkpointId: record.checkpointId,
            pinJson: immutablePin(record.request),
          };
          if (
            ["waiting", "completed"].includes(snapshot.status) &&
            !await this.waitEvidence.consumed(
              query,
              record.scope,
              record.threadId,
              waitRun,
              record.request.contribution.id,
            )
          ) throw new Error("NATIVE_WAIT_COMPLETION_WITHOUT_CONSUMPTION");
          if (snapshot.status === "waiting") {
            const wait = await this.waitEvidence.read(
              query,
              record.scope,
              record.threadId,
              waitRun,
              record.request,
            );
            if (
              snapshot.waits.length !== 1 ||
              snapshot.waits[0].nodeId !== wait.nodeId ||
              snapshot.waits[0].kind !== wait.kind
            ) throw new Error("NATIVE_WAIT_SNAPSHOT_PROOF_MISMATCH");
          }
          await query(
            `UPDATE ${
              this.table("ExecutionRun")
            } SET "status"=$7,"snapshotJson"=$8,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
            [...values, snapshot.status, canonical(snapshot)],
          );
          await query(
            `UPDATE ${
              this.table("OperatorExecution")
            } SET "status"=$6,"revision"="revision"+1,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5`,
            [...scopedValues(record.scope), record.threadId, snapshot.status],
          );
          if (!record.ownsDelivery) {
            await query(
              `UPDATE ${
                this.table("ExecutionContribution")
              } SET "status"='completed',"completedAt"=COALESCE("completedAt",clock_timestamp()) WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6`,
              [
                ...scopedValues(record.scope),
                record.threadId,
                record.request.contribution.id,
              ],
            );
          }
          await this.fence(query, record);
        });
      },
      fail: async (error) => {
        await this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          await this.fence(query, record);
          const accepted = (await query(
            `SELECT "snapshotJson" FROM ${
              this.table("ExecutionRun")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
            [...scopedValues(record.scope), record.threadId, record.runId],
          )).rows[0];
          if (
            typeof accepted?.snapshotJson === "string" &&
            JSON.parse(accepted.snapshotJson).status === "refused"
          ) return;
          const unsettled = await query(
            `SELECT "effectKey" FROM ${
              this.table("ExecutionEffect")
            } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed'`,
            [...scopedValues(record.scope), record.threadId],
          );
          const status = unsettled.rows.length ? "uncertain" : "failed";
          await query(
            `UPDATE ${
              this.table("ExecutionRun")
            } SET "status"=$7,"errorJson"=$8,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
            [
              ...scopedValues(record.scope),
              record.threadId,
              record.runId,
              status,
              canonical({ message: errorText(error) }),
            ],
          );
          await query(
            `UPDATE ${
              this.table("OperatorExecution")
            } SET "status"=$6,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5`,
            [...scopedValues(record.scope), record.threadId, status],
          );
          if (!record.ownsDelivery) {
            // The queue settles only its own delivery. An embedded native input
            // has no separate worker to release its running receipt on failure.
            // Its run may be a selected successor of the original contribution,
            // so keep the exact contribution binding rather than comparing runs.
            await query(
              `UPDATE ${
                this.table("ExecutionContribution")
              } SET "status"=$7 WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6 AND "status"<>'completed'`,
              [
                ...scopedValues(record.scope),
                record.threadId,
                record.request.contribution.id,
                status,
              ],
            );
          }
        }).catch(() => {});
      },
    };
    this.#sessionRecords.set(session, record);
    return session;
  }
  async ownsCandidateRecoveryContribution(input: {
    snapshot: NativeExecutionSnapshot;
    acceptedDigest: string;
  }): Promise<boolean> {
    const claim = this.#claim.getStore();
    if (!claim) {
      throw new Error("Candidate recovery ownership requires a live claim");
    }
    const accepted = parseAcceptedCommand(claim.delivery);
    const snapshot = input.snapshot;
    if (
      !accepted || accepted.command.kind !== "resume-candidate-continuation" ||
      await executionDigest(accepted) !== input.acceptedDigest ||
      snapshot.identity.operatorId !== accepted.identity.operatorId ||
      canonical(snapshot.identity.scope) !==
        canonical(accepted.identity.scope) ||
      snapshot.identity.invocationKey !== accepted.command.invocationKey ||
      snapshot.identity.subjectId !== accepted.command.inputMessageId ||
      snapshot.identity.purpose !== "conversation" ||
      !snapshot.contributionId.startsWith(
        `candidate-decision:${accepted.command.candidateId}:`,
      )
    ) return false;
    const scope = this.scope(snapshot.identity), values = scopedValues(scope);
    return await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      await this.lockClaim(query, claim.job);
      const execution = (await query(
        `SELECT "identityJson","currentRunId" FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5 FOR UPDATE`,
        [...values, snapshot.threadId],
      )).rows[0];
      const binding = (await query(
        `SELECT "activeThreadId" FROM ${
          this.table("ExecutionThreadBinding")
        } WHERE ${scopeWhere} AND "identityDigest"=$5`,
        [...values, await executionDigest(snapshot.identity)],
      )).rows[0];
      if (
        !execution || execution.identityJson !== canonical(snapshot.identity) ||
        binding?.activeThreadId !== snapshot.threadId ||
        !execution.currentRunId ||
        snapshot.runId && snapshot.runId !== execution.currentRunId
      ) return false;
      const current = (await query(
        `SELECT * FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...values, snapshot.threadId, execution.currentRunId],
      )).rows[0];
      const contribution = (await query(
        `SELECT * FROM ${
          this.table("ExecutionContribution")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "contributionId"=$6 FOR UPDATE`,
        [...values, snapshot.threadId, snapshot.contributionId],
      )).rows[0];
      if (
        !current || current.contributionId !== snapshot.contributionId ||
        current.checkpointId !== snapshot.checkpointId ||
        !contribution?.runId ||
        contribution.jobId !== claim.job.id ||
        contribution.digest !== await executionDigest(claim.delivery) ||
        contribution.originJson !== canonical({ delivery: claim.delivery })
      ) return false;
      const base = (await query(
        `SELECT * FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...values, snapshot.threadId, contribution.runId],
      )).rows[0];
      if (!base || typeof base.pinJson !== "string") return false;
      const source = this.runSource(base), pin = JSON.parse(base.pinJson);
      if (
        source.contribution.id !== snapshot.contributionId ||
        source.contribution.kind !== "resume" ||
        pin.version?.digest !== accepted.modelPin.modelDigest ||
        pin.version?.repositoryVersion !==
          accepted.modelPin.repositoryVersion ||
        contribution.requestDigest !== await executionDigest({
            identity: snapshot.identity,
            contribution: source.contribution,
            pin: base.pinJson,
          })
      ) return false;
      await this.verifyRunLineage(
        query,
        scope,
        snapshot.threadId,
        current,
        base,
        claim.delivery,
      );
      await this.lockClaim(query, claim.job);
      return true;
    });
  }

  async inspect(
    operatorId: string,
    selection?: NativeExecutionSelection,
  ): Promise<NativeExecutionSnapshot[]> {
    if (
      selection &&
      [selection.threadId, selection.contributionId].some((value) =>
        typeof value !== "string" || !value.trim() || value.length > 1024 ||
        // deno-lint-ignore no-control-regex -- Exact bounded native read locators.
        /[\u0000-\u001f\u007f]/.test(value)
      )
    ) throw new Error("Exact native execution read selection is invalid");
    const scope = this.scope({ operatorId });
    const rows = await this.client.$queryRawUnsafe<
      {
        identityJson: string;
        threadId: string;
        terminalReceiptJson: string | null;
        contributionId: string;
        runId: string;
        checkpointNamespace: string;
        pinJson: string;
        checkpointId: string | null;
        status: NativeExecutionSnapshot["status"];
        snapshotJson: string | null;
        modelReferenceJson: string;
      }[]
    >(
      `SELECT r."modelReferenceJson",e."identityJson",e."threadId",e."terminalReceiptJson",r."contributionId",r."runId",r."checkpointNamespace",r."pinJson",r."checkpointId",r."status",r."snapshotJson" FROM ${
        this.table("OperatorExecution")
      } e JOIN ${
        this.table("ExecutionRun")
      } r ON r."projectId"=e."projectId" AND r."systemId"=e."systemId" AND r."executionSpaceId"=e."executionSpaceId" AND r."operatorId"=e."operatorId" AND r."threadId"=e."threadId" AND r."runId"=e."currentRunId" WHERE e."projectId"=$1 AND e."systemId"=$2 AND e."executionSpaceId"=$3 AND e."operatorId"=$4 AND (e."retiredAt" IS NULL OR (e."terminalReceiptJson" IS NOT NULL AND EXISTS (SELECT 1 FROM ${
        this.table("ExecutionThreadBinding")
      } b WHERE b."projectId"=e."projectId" AND b."systemId"=e."systemId" AND b."executionSpaceId"=e."executionSpaceId" AND b."operatorId"=e."operatorId" AND b."activeThreadId"=e."threadId")))${
        selection ? ' AND e."threadId"=$5 AND r."contributionId"=$6' : ""
      } ORDER BY e."threadId"`,
      ...scopedValues(scope),
      ...(selection ? [selection.threadId, selection.contributionId] : []),
    );
    const result: NativeExecutionSnapshot[] = [];
    let pendingAtInspection: string[] | undefined;
    let businessAtInspection: SystemRuntimeState | undefined;
    for (const row of rows) {
      await this.client.$transaction(async (tx) => {
        const query = fromPrisma(tx).executeSql;
        await this.waitEvidence.protocol(query, scope, row.threadId, row.runId);
        if (
          ["waiting", "completed"].includes(row.status) &&
          !await this.waitEvidence.consumed(
            query,
            scope,
            row.threadId,
            row,
            row.contributionId,
          )
        ) throw new Error("NATIVE_WAIT_INSPECTION_CONSUMPTION_PROOF_MISSING");
      });
      if (row.terminalReceiptJson) {
        const terminal = JSON.parse(row.terminalReceiptJson) as {
          snapshot: NativeExecutionSnapshot;
        };
        if (
          terminal.snapshot.threadId !== row.threadId ||
          terminal.snapshot.contributionId !== row.contributionId ||
          terminal.snapshot.status !== "completed"
        ) throw new Error("Corrupt terminal native scope receipt");
        result.push(terminal.snapshot);
        continue;
      }
      const pin = JSON.parse(row.pinJson),
        previous = row.snapshotJson
          ? JSON.parse(row.snapshotJson) as NativeExecutionSnapshot
          : undefined;
      if (previous && !Array.isArray(previous.pendingContributions)) {
        throw new Error(
          "Native execution snapshot has no pending-contribution evidence",
        );
      }
      if (!previous && !pendingAtInspection) {
        pendingAtInspection = Object.entries(
          (await this.currentBusiness(
            fromPrisma(this.client).executeSql,
            scope,
          )).pendingContributions ?? {},
        ).filter(([, receipt]) => receipt.status === "pending").map(([id]) =>
          id
        );
      }
      const pendingContributions = previous?.pendingContributions ??
        pendingAtInspection!;
      const unsettled = await this.client.$queryRawUnsafe<
        { effectKey: string }[]
      >(
        `SELECT "effectKey" FROM ${
          this.table("ExecutionEffect")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' ORDER BY "effectKey"`,
        ...scopedValues(scope),
        row.threadId,
      );
      const openGroups = await this.client.$queryRawUnsafe<
        { groupId: string }[]
      >(
        `SELECT "groupId" FROM ${
          this.table("ImmutableConsultationGroup")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "publicationJson" IS NULL ORDER BY "groupId"`,
        ...scopedValues(scope),
        row.threadId,
      );
      let inspectedWait: NativeWaitEvidence | undefined;
      if (previous?.status === "waiting" && row.checkpointId) {
        inspectedWait = await this.client.$transaction(async (tx) => {
          const query = fromPrisma(tx).executeSql;
          const source = this.runSource(row),
            state = await this.businessRevision(
              query,
              scope,
              source.businessRevision,
            ),
            model = state.executionModel!;
          const flow = [
            ...Object.values(model.flows),
            ...Object.values(model.caseFlows ?? {}),
          ].find((flow) =>
            flow.rootNativeId === pin.flowRootId &&
            flow.rootOccurrenceId === pin.flowOccurrenceId
          );
          if (!flow) throw new Error("Historical wait flow unavailable");
          const identity = JSON.parse(
            row.identityJson,
          ) as NativeExecutionIdentity;
          const wait = await this.waitEvidence.read(
            query,
            scope,
            row.threadId,
            row,
            {
              identity,
              contribution: source.contribution,
              businessRevision: source.businessRevision,
              model,
              flow,
              maxSteps: pin.maxSteps,
            },
          );
          if (
            previous.waits.length !== 1 ||
            previous.waits[0].nodeId !== wait.nodeId ||
            previous.waits[0].kind !== wait.kind
          ) throw new Error("NATIVE_WAIT_SNAPSHOT_PROOF_MISMATCH");
          return wait;
        });
      }
      // Older accepted snapshots predate source metadata. Derive it only for
      // a budget-suspended family from the selected official checkpoint; do
      // not rewrite the historical snapshot or alter ordinary retirement views.
      let budgetProjection: Pick<
        NativeExecutionSnapshot,
        "runId" | "checkpointNamespace" | "budgetContinuationSource"
      > = {};
      if (
        previous?.status === "waiting" && row.checkpointId &&
        (!previous.runId || !previous.checkpointNamespace ||
          !previous.budgetContinuationSource)
      ) {
        businessAtInspection ??= await this.currentBusiness(
          fromPrisma(this.client).executeSql,
          scope,
        );
        const identity = JSON.parse(
          row.identityJson,
        ) as NativeExecutionIdentity;
        if (
          businessAtInspection.budgetSuspension &&
          businessAtInspection.caseInvocation &&
          invocationKey(businessAtInspection.caseInvocation) ===
            identity.invocationKey
        ) {
          const source = inspectedWait && budgetSourceFromWait(inspectedWait);
          if (source) {
            budgetProjection = {
              runId: row.runId,
              checkpointNamespace: row.checkpointNamespace,
              budgetContinuationSource: source,
            };
          }
        }
      }
      let scalarBudgetProposal: NativeExecutionSnapshot["scalarBudgetProposal"];
      if (
        previous?.status === "waiting" && previous.waits.length === 1 &&
        previous.waits[0].mechanism === "submit_proposal" &&
        previous.waits[0].kind === "budget" && row.checkpointId
      ) {
        const sourceMember: BudgetCeilingMember = {
          id: `${row.threadId}:${row.runId}`,
          identity: JSON.parse(row.identityJson),
          contributionId: row.contributionId,
          threadId: row.threadId,
          runId: row.runId,
          checkpointNamespace: row.checkpointNamespace,
          checkpointId: row.checkpointId,
          ...previous.budgetContinuationSource!,
          ...budgetProjection.budgetContinuationSource!,
          snapshotDigest: await executionDigest({
            ...previous,
            ...budgetProjection,
          }),
        };
        const source = await this.scalarBudgetCheckpoint(
          fromPrisma(this.client).executeSql,
          scope,
          sourceMember,
        );
        scalarBudgetProposal = await nativeScalarBudgetProposal(source);
      }
      const { scalarBudgetProposal: _oldScalarProjection, ...savedSnapshot } =
        previous ?? { waits: [] };
      result.push({
        ...savedSnapshot,
        ...budgetProjection,
        ...(scalarBudgetProposal ? { scalarBudgetProposal } : {}),
        identity: JSON.parse(row.identityJson),
        threadId: row.threadId,
        contributionId: row.contributionId,
        modelDigest: pin.version.digest,
        repositoryVersion: pin.version.repositoryVersion,
        flowRootId: pin.flowRootId,
        status: previous?.status === "refused" ? "refused" : row.status,
        checkpointId: row.checkpointId ?? undefined,
        pendingContributions,
        unsettledEffects: unsettled.map((entry) => entry.effectKey),
        ...(openGroups.length
          ? {
            openImmutableConsultationGroups: openGroups.map((entry) =>
              entry.groupId
            ),
          }
          : {}),
      });
    }
    return result;
  }
  async closeScope(
    snapshot: NativeExecutionSnapshot,
    closure: NativeScopeClosure,
  ) {
    if (
      snapshot.identity.scope.kind !== "request" ||
      snapshot.identity.scope.scopeId !== closure.caseId ||
      snapshot.unsettledEffects.length ||
      snapshot.openImmutableConsultationGroups?.length || !snapshot.checkpointId
    ) throw new Error("Native scope has no exact settled Request closure");
    const scope = this.scope(snapshot.identity), values = scopedValues(scope);
    const inherited = currentPostgresExecutionTransaction(),
      claim = this.#claim.getStore();
    await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      await inherited?.fence?.(query);
      const binding = (await query(
        `SELECT "activeThreadId" FROM ${
          this.table("ExecutionThreadBinding")
        } WHERE ${scopeWhere} AND "identityDigest"=$5 FOR UPDATE`,
        [...values, await executionDigest(snapshot.identity)],
      )).rows[0];
      if (!binding || binding.activeThreadId !== snapshot.threadId) {
        throw new Error("Closure targets a different selected native thread");
      }
      const row = (await query(
        `SELECT * FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5 FOR UPDATE`,
        [...values, snapshot.threadId],
      )).rows[0];
      if (!row) throw new Error("Native closure thread is unavailable");
      await this.assertNoOpenGroups(query, scope, snapshot.threadId);
      const terminalSnapshot: NativeExecutionSnapshot = {
        ...snapshot,
        status: "completed",
        waits: [],
        unsettledEffects: [],
        pendingContributions: [],
      };
      const terminal = canonical({ closure, snapshot: terminalSnapshot });
      if (row.terminalReceiptJson) {
        const stored = JSON.parse(String(row.terminalReceiptJson)) as {
          closure: NativeScopeClosure;
          snapshot: NativeExecutionSnapshot;
        };
        if (
          canonical(stored.snapshot) !== canonical(terminalSnapshot) ||
          stored.closure.kind !== closure.kind ||
          stored.closure.caseId !== closure.caseId ||
          stored.closure.status !== closure.status ||
          stored.closure.closedAt !== closure.closedAt
        ) {
          throw new Error(
            "Native scope has a different accepted terminal receipt",
          );
        }
        return;
      }
      if (row.retiredAt || row.currentCheckpointId !== snapshot.checkpointId) {
        throw new Error("Native closure source checkpoint changed");
      }
      const run = (await query(
        `SELECT "snapshotJson","contributionId" FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [...values, snapshot.threadId, row.currentRunId],
      )).rows[0];
      if (
        run?.contributionId !== snapshot.contributionId ||
        typeof run.snapshotJson !== "string" ||
        canonical(JSON.parse(run.snapshotJson)) !== canonical(snapshot)
      ) {
        throw new Error(
          "Native closure lacks its exact completed graph contribution receipt",
        );
      }
      const accepted = await this.businessRevision(
        query,
        scope,
        closure.businessRevision,
      );
      assertHistoricalScopeClosure(scope.operatorId, closure, accepted);
      const current = await this.currentBusiness(query, scope);
      assertCurrentScopeClosure(snapshot, closure, current);
      const unknown = await query(
        `SELECT "effectKey" FROM ${
          this.table("ExecutionEffect")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed' LIMIT 1`,
        [...values, snapshot.threadId],
      );
      if (unknown.rows.length) {
        throw new Error("Unsettled effects block native scope closure");
      }
      await query(
        `UPDATE ${
          this.table("OperatorExecution")
        } SET "status"='completed',"terminalReceiptJson"=$6,"retiredAt"=clock_timestamp(),"revision"="revision"+1 WHERE ${scopeWhere} AND "threadId"=$5`,
        [...values, snapshot.threadId, terminal],
      );
      if (claim) await this.lockClaim(query, claim.job);
    });
  }
  readonly #retirements = new WeakMap<object, {
    snapshot: NativeExecutionSnapshot;
    authorization: NativeThreadAdvanceAuthorization;
    targetModel: ExecutableModel;
    identityDigest: string;
    identityJson: string;
    targetPin: string;
    authorizationJson: string;
    membership: string;
  }>();
  readonly #emptyRetirements = new WeakMap<object, {
    scope: PostgresRuntimeScope;
    membership: string;
    authorization: NativeThreadAdvanceAuthorization;
    targetModel: ExecutableModel;
    authorizationJson: string;
  }>();
  readonly #retirementBatches = new WeakMap<object, readonly object[]>();
  readonly #neverStartedSuccessors = new WeakMap<
    object,
    readonly PreparedNeverStartedSuccessor[]
  >();
  readonly #retirementLocks = new WeakMap<object, {
    tx: Prisma.TransactionClient;
    packet: object;
    membership: string;
  }>();
  readonly #networkCheckpointEvidence = new WeakMap<object, {
    snapshot: NativeExecutionSnapshot;
    wait:
      import("../../../application/work/native-execution/contract.ts").NativeChangeApprovalWait;
    rows: string;
    preparedEffectKey: string;
  }>();

  private networkCheckpointRows(
    query: ExecutionSql,
    snapshot: NativeExecutionSnapshot,
    lock: boolean,
  ): Promise<string> {
    return captureOfficialCheckpointRows(
      query,
      this.options.checkpointSchema,
      snapshot,
      lock,
    );
  }

  /** Reconstruct the exact admitted source request, then read its typed wait.
   * This is also the sole explicit historical import route for new Main paths. */
  private async snapshotWait(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    snapshot: NativeExecutionSnapshot,
  ) {
    if (
      !snapshot.runId || !snapshot.checkpointId ||
      typeof snapshot.checkpointNamespace !== "string"
    ) throw new Error("NATIVE_WAIT_EXACT_CURSOR_REQUIRED");
    const run = (await query(
      `SELECT * FROM ${
        this.table("ExecutionRun")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
      [...scopedValues(scope), snapshot.threadId, snapshot.runId],
    )).rows[0];
    if (
      !run || run.checkpointId !== snapshot.checkpointId ||
      run.checkpointNamespace !== snapshot.checkpointNamespace ||
      run.contributionId !== snapshot.contributionId
    ) throw new Error("NATIVE_WAIT_SOURCE_CURSOR_CHANGED");
    const source = this.runSource(run),
      historical = await this.businessRevision(
        query,
        scope,
        source.businessRevision,
      ),
      model = historical.executionModel!;
    const pin = JSON.parse(String(run.pinJson));
    const flow = [
      ...Object.values(model.flows),
      ...Object.values(model.caseFlows ?? {}),
    ].find((flow) =>
      flow.rootNativeId === pin.flowRootId &&
      flow.rootOccurrenceId === pin.flowOccurrenceId
    );
    if (!flow) throw new Error("NATIVE_WAIT_SOURCE_FLOW_UNAVAILABLE");
    const request: NativeExecutionRequest = {
      identity: structuredClone(snapshot.identity),
      contribution: source.contribution,
      businessRevision: source.businessRevision,
      model,
      flow,
      maxSteps: pin.maxSteps,
    };
    if (immutablePin(request) !== run.pinJson) {
      throw new Error("NATIVE_WAIT_SOURCE_PIN_MISMATCH");
    }
    const wait = await this.waitEvidence.read(
      query,
      scope,
      snapshot.threadId,
      run,
      request,
    );
    if (
      snapshot.waits.length !== 1 || snapshot.waits[0].kind !== wait.kind ||
      snapshot.waits[0].nodeId !== wait.nodeId
    ) throw new Error("NATIVE_WAIT_SNAPSHOT_PROOF_MISMATCH");
    const protocol = await this.waitEvidence.protocol(
      query,
      scope,
      snapshot.threadId,
      run.runId,
    );
    return { run, request, wait, protocol };
  }

  private async assertUnconsumedSnapshotWait(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    snapshot: NativeExecutionSnapshot,
  ) {
    const source = await this.snapshotWait(query, scope, snapshot);
    if (
      source.wait.kind !== "input" ||
      await this.waitEvidence.waitConsumed(
        query,
        scope,
        snapshot.threadId,
        source.run,
        source.wait,
      )
    ) throw new Error("The approval wait has already been consumed");
    await this.waitEvidence.verifyEffect(
      query,
      scope,
      snapshot.threadId,
      source.wait,
    );
    return source;
  }

  async prepareNetworkApprovalCheckpoint(
    packet: object,
    snapshot: NativeExecutionSnapshot,
    wait:
      import("../../../application/work/native-execution/contract.ts").NativeChangeApprovalWait,
  ): Promise<void> {
    return await this.#prepareChangeApprovalCheckpoint(
      packet,
      snapshot,
      wait,
      "network",
    );
  }

  async prepareTeamApprovalCheckpoint(
    packet: object,
    snapshot: NativeExecutionSnapshot,
    wait:
      import("../../../application/work/native-execution/contract.ts").NativeChangeApprovalWait,
  ): Promise<void> {
    return await this.#prepareChangeApprovalCheckpoint(
      packet,
      snapshot,
      wait,
      "team",
    );
  }

  async #prepareChangeApprovalCheckpoint(
    packet: object,
    snapshot: NativeExecutionSnapshot,
    wait:
      import("../../../application/work/native-execution/contract.ts").NativeChangeApprovalWait,
    kind: "network" | "team",
  ): Promise<void> {
    // A branch team grows by one adoption per creation (4.8e): the next one
    // retires the inert successors the previous adoption left, as an
    // instruction adoption does. A network adoption keeps its refusal.
    if (
      kind === "network" && this.#neverStartedSuccessors.get(packet)?.length &&
      !ownerAdoptionChange(this.#retirements.get(packet)?.authorization)
        ?.creationPolicy
    ) {
      throw new Error(
        "Network adoption cannot retire an unstarted prior successor",
      );
    }
    const members = this.#retirementBatches.get(packet) ?? [packet];
    if (
      !members.some((item) =>
        canonical(this.#retirements.get(item)?.snapshot) === canonical(snapshot)
      )
    ) throw new Error("Approval wait is not in the retirement packet");
    const read = () =>
      this.client.$transaction(
        (tx) =>
          this.networkCheckpointRows(
            fromPrisma(tx).executeSql,
            snapshot,
            false,
          ),
        { isolationLevel: "RepeatableRead" },
      );
    const before = await read();
    const tuple = await new PostgresSaver(
      this.options.checkpointPool,
      undefined,
      { schema: this.options.checkpointSchema },
    ).getTuple({
      configurable: {
        thread_id: snapshot.threadId,
        checkpoint_ns: snapshot.checkpointNamespace,
        checkpoint_id: snapshot.checkpointId,
      },
    });
    const source = await this.client.$transaction(
      (tx) =>
        this.assertUnconsumedSnapshotWait(
          fromPrisma(tx).executeSql,
          this.scope(snapshot.identity),
          snapshot,
        ),
      { isolationLevel: "RepeatableRead" },
    );
    await verifyOfficialWaitCheckpoint(tuple, source.wait);
    if (canonical(source.wait.changeApprovalWait) !== canonical(wait)) {
      throw new Error(
        "The official approval checkpoint differs from its native wait",
      );
    }
    if (await read() !== before) {
      throw new Error("Approval checkpoint changed while capturing evidence");
    }
    const digest = await sha256(before);
    for (const item of members) {
      const prepared = this.#retirements.get(item);
      if (
        !prepared || prepared.authorization.kind !== "owner-adoption" ||
        ownerAdoptionChange(prepared.authorization)?.kind !== kind
      ) throw new Error("Network retirement authorization is unavailable");
      prepared.authorization = {
        ...prepared.authorization,
        ...(kind === "team"
          ? { teamCheckpointDigest: digest }
          : { networkCheckpointDigest: digest }),
      };
      prepared.authorizationJson = canonical({
        authorization: prepared.authorization,
        source: prepared.snapshot,
        target: {
          identity: prepared.targetModel.identity,
          version: prepared.targetModel.version,
        },
      });
    }
    this.#networkCheckpointEvidence.set(packet, {
      snapshot: structuredClone(snapshot),
      wait: structuredClone(wait),
      rows: before,
      preparedEffectKey: source.wait.effectKey,
    });
  }

  async prepareRetirement(
    snapshot: NativeExecutionSnapshot,
    authorization: NativeThreadAdvanceAuthorization,
    targetModel: ExecutableModel,
  ): Promise<object> {
    return await this.#prepareRetirement(
      snapshot,
      authorization,
      targetModel,
      true,
    );
  }
  async #prepareRetirement(
    snapshot: NativeExecutionSnapshot,
    authorization: NativeThreadAdvanceAuthorization,
    targetModel: ExecutableModel,
    captureMembership: boolean,
  ): Promise<object> {
    // Capture all caller-owned data before the first asynchronous digest.
    ({ snapshot, authorization, targetModel } = structuredClone({
      snapshot,
      authorization,
      targetModel,
    }));
    if (
      snapshot.status !== "waiting" || !snapshot.checkpointId ||
      !snapshot.waits.length ||
      snapshot.waits.some((wait) => wait.kind !== "input") ||
      snapshot.unsettledEffects.length ||
      snapshot.openImmutableConsultationGroups?.length
    ) {
      throw new Error(
        "Execution cannot retire outside an empty verified input wait",
      );
    }
    const scope = this.scope(snapshot.identity);
    const identityJson = canonical(snapshot.identity),
      identityDigest = await executionDigest(snapshot.identity);
    const targetPin = canonical({
      modelDigest: targetModel.version.digest,
      repositoryVersion: targetModel.version.repositoryVersion,
    });
    const authorizationJson = canonical({
      authorization,
      source: snapshot,
      target: { identity: targetModel.identity, version: targetModel.version },
    });
    const membership = captureMembership
      ? await this.client.$transaction(
        (tx) =>
          this.#retirementMembership(fromPrisma(tx).executeSql, scope, false),
        { isolationLevel: "RepeatableRead" },
      )
      : "";
    const packet = Object.freeze({});
    this.#retirements.set(packet, {
      snapshot,
      authorization,
      targetModel,
      identityDigest,
      identityJson,
      targetPin,
      authorizationJson,
      membership,
    });
    return packet;
  }

  async prepareRetirementBatch(
    snapshots: readonly NativeExecutionSnapshot[],
    authorization: NativeThreadAdvanceAuthorization,
    targetModel: ExecutableModel,
    previous?:
      | RequestNeverStartedSuccessorContext
      | ScopedSoftwareNeverStartedSuccessorContext,
  ): Promise<object> {
    const captured = structuredClone({
      snapshots,
      authorization,
      targetModel,
      previous,
    });
    const packet = await this.#prepareRetirementBatch(
      captured.snapshots,
      captured.authorization,
      captured.targetModel,
    );
    if (captured.previous) {
      const context = "previous" in captured.previous
        ? await parseScopedSoftwareNeverStartedSuccessorContext(
          captured.previous,
        )
        : await parseRequestNeverStartedSuccessorContext(captured.previous);
      if (context.currentPin.adoption === null) return packet;
      if (
        captured.authorization.kind !== "owner-adoption" &&
          captured.authorization.kind !==
            "software-evolution-scoped-adoption" ||
        captured.authorization.kind === "owner-adoption" &&
          "previous" in context
      ) {
        throw new Error(
          "Never-started successor retirement requires its exact authority family",
        );
      }
      const prepared = this.#retirements.get(packet),
        empty = this.#emptyRetirements.get(packet);
      const scope = empty?.scope ?? this.scope(prepared!.snapshot.identity);
      const items = await this.client.$transaction(async (tx) => {
        const query = fromPrisma(tx).executeSql;
        if (
          await this.#retirementMembership(query, scope, false) !==
            (prepared?.membership ?? empty!.membership)
        ) throw new Error("Native successor preparation membership changed");
        const rows = (await query(
          `SELECT row_to_json(e)::text AS "rowJson",row_to_json(b)::text AS "bindingJson",b."revision"::text AS "bindingRevision"
          FROM ${this.table("OperatorExecution")} e JOIN ${
            this.table("ExecutionThreadBinding")
          } b
          ON b."projectId"=e."projectId" AND b."systemId"=e."systemId" AND b."executionSpaceId"=e."executionSpaceId" AND b."operatorId"=e."operatorId" AND b."activeThreadId"=e."threadId"
          WHERE e."projectId"=$1 AND e."systemId"=$2 AND e."executionSpaceId"=$3 AND e."operatorId"=$4 AND e."retiredAt" IS NULL AND e."status"='queued' ORDER BY b."identityDigest" LIMIT 257`,
          scopedValues(scope),
        )).rows;
        if (rows.length > 256) {
          throw new Error("Never-started successor packet exceeds bound");
        }
        if (rows.length) {
          await this.#verifyPriorNativeRetirementDigest(query, scope, context);
        }
        const result: PreparedNeverStartedSuccessor[] = [];
        for (const selected of rows) {
          if (
            typeof selected.rowJson !== "string" ||
            typeof selected.bindingJson !== "string" ||
            typeof selected.bindingRevision !== "string"
          ) throw new Error("Native successor capture is incomplete");
          const row = JSON.parse(selected.rowJson),
            binding = JSON.parse(selected.bindingJson);
          const identity = JSON.parse(
            row.identityJson,
          ) as NativeExecutionIdentity;
          const identityDigest = await executionDigest(identity);
          let source: NeverStartedAdoptionSource;
          if ("previous" in context) {
            source = context.previous.kind === "software"
              ? await this.#assertScopedSoftwareNeverStartedSuccessor(
                query,
                scope,
                context,
                row,
                binding,
                identityDigest,
              )
              : await this.#assertNeverStartedSuccessor(
                query,
                scope,
                {
                  currentPin: context.currentPin,
                  adoptions: [context.previous],
                },
                row,
                binding,
                identityDigest,
              );
          } else {source = await this.#assertNeverStartedSuccessor(
              query,
              scope,
              context,
              row,
              binding,
              identityDigest,
            );}
          result.push({
            scope,
            identity,
            identityJson: row.identityJson,
            identityDigest,
            threadId: row.threadId,
            rowJson: selected.rowJson,
            bindingJson: selected.bindingJson,
            bindingRevision: selected.bindingRevision,
            context,
            targetPin: canonical({
              modelDigest: captured.targetModel.version.digest,
              repositoryVersion: captured.targetModel.version.repositoryVersion,
            }),
            authorizationJson: canonical({
              authorization: captured.authorization,
              source,
              target: {
                identity: captured.targetModel.identity,
                version: captured.targetModel.version,
              },
            }),
          });
        }
        return result;
      }, { isolationLevel: "RepeatableRead" });
      this.#neverStartedSuccessors.set(packet, items);
    }
    return packet;
  }

  async prepareScopedSoftwareRetirementBatch(
    snapshots: readonly NativeExecutionSnapshot[],
    authorization: Extract<
      NativeThreadAdvanceAuthorization,
      { kind: "software-evolution-scoped-adoption" }
    >,
    targetModel: ExecutableModel,
    previous?: ScopedSoftwareNeverStartedSuccessorContext,
  ): Promise<object> {
    return await this.prepareRetirementBatch(
      snapshots,
      authorization,
      targetModel,
      previous,
    );
  }

  /** Read-only proof under the caller's complete native/parent lock set. */
  async assertScopedSoftwareInertSuccessorsInTransaction(
    tx: Prisma.TransactionClient,
    operatorId: string,
    input: ScopedSoftwareNeverStartedSuccessorContext,
  ): Promise<string[]> {
    const context = await parseScopedSoftwareNeverStartedSuccessorContext(
      input,
    );
    const query = fromPrisma(tx).executeSql, scope = this.scope({ operatorId });
    const rows = (await query(
      `SELECT row_to_json(e)::text AS "rowJson",row_to_json(b)::text AS "bindingJson" FROM ${
        this.table("OperatorExecution")
      } e JOIN ${
        this.table("ExecutionThreadBinding")
      } b ON b."projectId"=e."projectId" AND b."systemId"=e."systemId" AND b."executionSpaceId"=e."executionSpaceId" AND b."operatorId"=e."operatorId" AND b."activeThreadId"=e."threadId" WHERE e."projectId"=$1 AND e."systemId"=$2 AND e."executionSpaceId"=$3 AND e."operatorId"=$4 AND e."retiredAt" IS NULL AND e."status"='queued' ORDER BY b."identityDigest" LIMIT 257`,
      scopedValues(scope),
    )).rows;
    if (rows.length > 256) {
      throw new Error("Inert software successor bound exceeded");
    }
    if (rows.length) {
      await this.#verifyPriorNativeRetirementDigest(query, scope, context);
    }
    const ids: string[] = [];
    for (const selected of rows) {
      if (
        typeof selected.rowJson !== "string" ||
        typeof selected.bindingJson !== "string"
      ) throw new Error("Inert software successor rows unavailable");
      const row = JSON.parse(selected.rowJson),
        binding = JSON.parse(selected.bindingJson);
      const digest = await executionDigest(JSON.parse(row.identityJson));
      if (context.previous.kind === "software") {
        await this.#assertScopedSoftwareNeverStartedSuccessor(
          query,
          scope,
          context,
          row,
          binding,
          digest,
        );
      } else {await this.#assertNeverStartedSuccessor(
          query,
          scope,
          { currentPin: context.currentPin, adoptions: [context.previous] },
          row,
          binding,
          digest,
        );}
      ids.push(row.threadId);
    }
    return ids;
  }

  /** Stable ordered complete empty-wait set for a single target operator. */
  async #prepareRetirementBatch(
    snapshots: readonly NativeExecutionSnapshot[],
    authorization: NativeThreadAdvanceAuthorization,
    targetModel: ExecutableModel,
  ): Promise<object> {
    if (snapshots.length > 256) {
      throw new Error("Invalid retirement snapshot bound");
    }
    const captured = structuredClone({ snapshots, authorization, targetModel });
    if (!captured.snapshots.length) {
      if (
        captured.authorization.kind !== "owner-adoption" &&
        captured.authorization.kind !== "software-evolution-scoped-adoption"
      ) {
        throw new Error("Empty retirement requires exact Request adoption");
      }
      const scope = this.scope({
        operatorId: captured.targetModel.identity.builderId,
      });
      const membership = await this.client.$transaction(
        (tx) =>
          this.#retirementMembership(fromPrisma(tx).executeSql, scope, false),
        { isolationLevel: "RepeatableRead" },
      );
      const packet = Object.freeze({});
      this.#emptyRetirements.set(packet, {
        scope,
        membership,
        authorization: captured.authorization,
        targetModel: captured.targetModel,
        authorizationJson: canonical({
          authorization: captured.authorization,
          source: null,
          target: {
            identity: captured.targetModel.identity,
            version: captured.targetModel.version,
          },
        }),
      });
      this.#retirementBatches.set(packet, []);
      return packet;
    }
    const packets: object[] = [];
    for (
      const snapshot of [...captured.snapshots].sort((a, b) =>
        persistedOrder(canonical(a.identity), canonical(b.identity))
      )
    ) {
      packets.push(
        await this.prepareRetirement(
          snapshot,
          captured.authorization,
          captured.targetModel,
        ),
      );
    }
    const first = this.#retirements.get(packets[0])!;
    if (
      new Set(captured.snapshots.map((snapshot) => snapshot.threadId)).size !==
        packets.length ||
      packets.some((packet) => {
        const value = this.#retirements.get(packet)!;
        return canonical(this.scope(value.snapshot.identity)) !==
            canonical(this.scope(first.snapshot.identity)) ||
          value.membership !== first.membership;
      })
    ) throw new Error("Retirement batch scope or prepared membership changed");
    const packet = Object.freeze({});
    this.#retirements.set(packet, first);
    this.#retirementBatches.set(packet, packets);
    return packet;
  }

  async #verifyPriorNativeRetirementDigest(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    context:
      | RequestNeverStartedSuccessorContext
      | ScopedSoftwareNeverStartedSuccessorContext,
  ): Promise<void> {
    await verifyPriorNativeRetirementDigest(context, async (threadId) => {
      const row = (await query(
        `SELECT "advanceAuthorizationJson" FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5`,
        [...scopedValues(scope), threadId],
      )).rows[0];
      if (typeof row?.advanceAuthorizationJson !== "string") {
        throw new Error("Prior native successor authorization is unavailable");
      }
      return row.advanceAuthorizationJson;
    });
  }

  async #assertNeverStartedSuccessor(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    context: RequestNeverStartedSuccessorContext,
    row: Record<string, unknown>,
    binding: Record<string, unknown>,
    identityDigest: string,
  ): Promise<NeverStartedAdoptionSource> {
    const prior = context.adoptions.at(-1)!,
      manifest = prior.manifest,
      target = manifest.intent.target;
    const index = manifest.nativeRetirement.successorThreadIds.indexOf(
      String(row.threadId),
    );
    const identity = typeof row.identityJson === "string"
      ? JSON.parse(row.identityJson) as NativeExecutionIdentity
      : null;
    if (
      index < 0 ||
      canonical(target.host) !==
        canonical({ projectId: scope.projectId, systemId: scope.systemId }) ||
      target.executionSpaceId !== scope.executionSpaceId ||
      target.operatorId !== scope.operatorId ||
      !identity || canonical(identity) !== row.identityJson ||
      identity.operatorId !== scope.operatorId ||
      identity.scope.kind !== "request" ||
      identity.scope.scopeId !== target.caseId ||
      identity.scope.rootRequestId !== target.caseId ||
      row.scopeKind !== "request" || row.scopeId !== target.caseId ||
      row.rootRequestId !== target.caseId || row.ownerId !== null ||
      row.purpose !== identity.purpose ||
      row.subjectId !== (identity.subjectId ?? null) ||
      row.predecessorThreadId !==
        manifest.nativeRetirement.predecessorThreadIds[index] ||
      row.status !== "queued" || row.revision !== 0 || row.epoch !== 0 ||
      row.checkpointNamespace !== "" ||
      [
        row.currentRunId,
        row.currentJobId,
        row.currentRetry,
        row.currentCheckpointId,
        row.terminalReceiptJson,
        row.retiredAt,
      ].some((value) => value !== null) ||
      binding.activeThreadId !== row.threadId ||
      binding.identityJson !== row.identityJson ||
      binding.identityDigest !== identityDigest ||
      typeof row.authorizedPinJson !== "string" ||
      row.authorizedPinJson !==
        canonical({
          modelDigest: context.currentPin.modelDigest,
          repositoryVersion: context.currentPin.source.version,
        }) ||
      typeof row.advanceAuthorizationJson !== "string"
    ) {
      throw new Error(
        "Selected native successor is not an exact never-started current adoption",
      );
    }
    const current = await this.currentBusiness(query, scope);
    assertOwnerSuccessorCurrentPin(context, current);
    const priorAuthorization = JSON.parse(row.advanceAuthorizationJson);
    assertOwnerSuccessorSelection(
      manifest,
      priorAuthorization,
      row.advanceAuthorizationJson,
    );
    const authorized = await this.businessRevision(
      query,
      scope,
      priorAuthorization.authorization.businessRevision,
    );
    assertOwnerSuccessorAuthorizationHistory(
      manifest,
      priorAuthorization,
      authorized,
    );
    const committed = await this.businessRevision(query, scope, {
      __assemblyRuntimeRevision: {
        systemId: current.id,
        operatorId: scope.operatorId,
        revision: manifest.committedRuntimeRevision,
        modelDigest: context.currentPin.modelDigest,
      },
    });
    assertOwnerSuccessorCommittedHistory(context, committed);
    const predecessor = (await query(
      `SELECT * FROM ${
        this.table("OperatorExecution")
      } WHERE ${scopeWhere} AND "threadId"=$5`,
      [...scopedValues(scope), row.predecessorThreadId],
    )).rows[0];
    if (
      !predecessor || !predecessor.retiredAt ||
      predecessor.identityJson !== row.identityJson
    ) throw new Error("Never-started successor predecessor is unavailable");
    if (
      priorAuthorization.source?.kind === "never-started-adoption-successor"
    ) {
      const marker = parseNeverStartedAdoptionSource(priorAuthorization.source);
      const earlier = manifest.intent.previous.pin.adoption;
      await assertOwnerInertSourceMarker(
        marker,
        earlier,
        manifest.authorizationRuntimeRevision,
        identityDigest,
        {
          threadId: row.predecessorThreadId,
          predecessorThreadId: predecessor.predecessorThreadId,
          authorizedPinJson: predecessor.authorizedPinJson,
          advanceAuthorizationJson: predecessor.advanceAuthorizationJson,
        },
      );
    } else {
      if (priorAuthorization.source?.kind !== undefined) {
        throw new Error("Unknown native adoption source kind");
      }
      const run = (await query(
        `SELECT "snapshotJson" FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [
          ...scopedValues(scope),
          row.predecessorThreadId,
          predecessor.currentRunId,
        ],
      )).rows[0];
      if (
        priorAuthorization.source?.threadId !== row.predecessorThreadId ||
        priorAuthorization.source?.status !== "waiting" ||
        typeof run?.snapshotJson !== "string" ||
        canonical(JSON.parse(run.snapshotJson)) !==
          canonical(priorAuthorization.source)
      ) {
        throw new Error(
          "Prior native wait selection has no exact historical snapshot",
        );
      }
    }
    for (
      const table of [
        "ExecutionRun",
        "ExecutionContribution",
        "ExecutionEffect",
        "ImmutableConsultationGroup",
      ] as const
    ) {
      if (
        (await query(
          `SELECT 1 FROM ${
            this.table(table)
          } WHERE ${scopeWhere} AND "threadId"=$5 LIMIT 1`,
          [...scopedValues(scope), row.threadId],
        )).rows.length
      ) throw new Error("Native successor has started or accepted work");
    }
    if (
      (await query(
        `SELECT 1 FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "predecessorThreadId"=$5 LIMIT 1`,
        [...scopedValues(scope), row.threadId],
      )).rows.length ||
      (await query(
          `SELECT 1 FROM ${
            this.table("ExecutionThreadBinding")
          } WHERE ${scopeWhere} AND "activeThreadId"=$5`,
          [...scopedValues(scope), row.threadId],
        )).rows.length !== 1
    ) throw new Error("Never-started successor selection membership differs");
    return parseNeverStartedAdoptionSource({
      v: 1,
      kind: "never-started-adoption-successor",
      threadId: row.threadId,
      predecessorThreadId: row.predecessorThreadId,
      identityDigest,
      previousCommandId: manifest.commandId,
      previousReceiptDigest: prior.receipt.receiptDigest,
      previousAuthorizationRuntimeRevision:
        manifest.authorizationRuntimeRevision,
      previousCommittedRuntimeRevision: manifest.committedRuntimeRevision,
      authorizedPinDigest: await sha256(row.authorizedPinJson),
      advanceAuthorizationDigest: await sha256(row.advanceAuthorizationJson),
    });
  }

  async #assertScopedSoftwareNeverStartedSuccessor(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    context: ScopedSoftwareNeverStartedSuccessorContext,
    row: Record<string, unknown>,
    binding: Record<string, unknown>,
    identityDigest: string,
  ): Promise<NeverStartedAdoptionSource> {
    if (context.previous.kind !== "software") {
      throw new Error("Software native history required");
    }
    const prior = context.previous,
      manifest = prior.manifest,
      target = manifest.target;
    const index = manifest.nativeRetirement.successorThreadIds.indexOf(
      String(row.threadId),
    );
    const identity = typeof row.identityJson === "string"
      ? JSON.parse(row.identityJson) as NativeExecutionIdentity
      : null;
    const caseId = prior.source.destination.caseId;
    if (
      index < 0 || target.projectId !== scope.projectId ||
      target.systemId !== scope.systemId ||
      target.executionSpaceId !== scope.executionSpaceId ||
      target.operatorId !== scope.operatorId ||
      !identity || canonical(identity) !== row.identityJson ||
      identity.operatorId !== scope.operatorId ||
      identity.scope.kind !== "request" || identity.scope.scopeId !== caseId ||
      identity.scope.rootRequestId !== caseId ||
      row.scopeKind !== "request" || row.scopeId !== caseId ||
      row.rootRequestId !== caseId || row.ownerId !== null ||
      row.purpose !== identity.purpose ||
      row.subjectId !== (identity.subjectId ?? null) ||
      row.predecessorThreadId !==
        manifest.nativeRetirement.predecessorThreadIds[index] ||
      row.status !== "queued" || row.revision !== 0 || row.epoch !== 0 ||
      row.checkpointNamespace !== "" ||
      [
        row.currentRunId,
        row.currentJobId,
        row.currentRetry,
        row.currentCheckpointId,
        row.terminalReceiptJson,
        row.retiredAt,
      ].some((v) => v !== null) ||
      binding.activeThreadId !== row.threadId ||
      binding.identityJson !== row.identityJson ||
      binding.identityDigest !== identityDigest ||
      typeof row.authorizedPinJson !== "string" ||
      row.authorizedPinJson !==
        canonical({
          modelDigest: context.currentPin.modelDigest,
          repositoryVersion: context.currentPin.source.version,
        }) ||
      typeof row.advanceAuthorizationJson !== "string"
    ) {
      throw new Error(
        "Selected software successor is not an exact inert native thread",
      );
    }
    const journal = (await query(
      `SELECT "kind","digest","payload" FROM ${this.#schema}."SpaceManifest" WHERE "projectId"=$1 AND "systemId"=$2 AND "executionSpaceId"=$3 AND "revision"=$4::bigint`,
      [
        scope.projectId,
        scope.systemId,
        scope.executionSpaceId,
        prior.journalRevision,
      ],
    )).rows[0];
    if (
      journal?.kind !== "runtime-adoption" ||
      journal.digest !== prior.manifestDigest ||
      journal.payload !== canonical(manifest)
    ) {
      throw new Error(
        "Prior software native history has no exact durable manifest",
      );
    }
    const current = await this.currentBusiness(query, scope);
    assertSoftwareSuccessorCurrentPin(context, current);
    const selected = JSON.parse(row.advanceAuthorizationJson);
    const authorizationId =
      `${manifest.dossierId}:software-authorization:${scope.operatorId}`;
    assertSoftwareSuccessorSelection(
      manifest,
      selected,
      row.advanceAuthorizationJson,
      authorizationId,
    );
    const authorized = await this.businessRevision(
      query,
      scope,
      selected.authorization.businessRevision,
    );
    assertSoftwareSuccessorAuthorizationHistory(
      manifest,
      selected,
      authorized,
      authorizationId,
    );
    const committed = await this.businessRevision(query, scope, {
      __assemblyRuntimeRevision: {
        systemId: current.id,
        operatorId: scope.operatorId,
        revision: manifest.committedRuntimeRevision,
        modelDigest: context.currentPin.modelDigest,
      },
    });
    assertSoftwareSuccessorCommittedHistory(
      context,
      prior,
      scope.operatorId,
      selected,
      committed,
    );
    const predecessor = (await query(
      `SELECT * FROM ${
        this.table("OperatorExecution")
      } WHERE ${scopeWhere} AND "threadId"=$5`,
      [...scopedValues(scope), row.predecessorThreadId],
    )).rows[0];
    if (
      !predecessor?.retiredAt || predecessor.identityJson !== row.identityJson
    ) throw new Error("Software successor predecessor unavailable");
    if (selected.source?.kind === "never-started-adoption-successor") {
      const marker = parseNeverStartedAdoptionSource(selected.source),
        earlier = manifest.boundary.previousPin.adoption;
      await assertSoftwareInertSourceMarker(
        marker,
        earlier,
        manifest.authorizationRuntimeRevision,
        identityDigest,
        {
          threadId: row.predecessorThreadId,
          predecessorThreadId: predecessor.predecessorThreadId,
          authorizedPinJson: predecessor.authorizedPinJson,
          advanceAuthorizationJson: predecessor.advanceAuthorizationJson,
        },
      );
    } else {
      const run = (await query(
        `SELECT "snapshotJson" FROM ${
          this.table("ExecutionRun")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
        [
          ...scopedValues(scope),
          row.predecessorThreadId,
          predecessor.currentRunId,
        ],
      )).rows[0];
      if (
        selected.source?.kind !== undefined ||
        selected.source?.threadId !== row.predecessorThreadId ||
        selected.source?.status !== "waiting" ||
        typeof run?.snapshotJson !== "string" ||
        canonical(JSON.parse(run.snapshotJson)) !== canonical(selected.source)
      ) throw new Error("Software predecessor wait proof differs");
      // The retained snapshot is only a cursor; replay its typed (or explicit
      // legacy) wait receipt before relying on this historical selection.
      await this.assertUnconsumedSnapshotWait(
        query,
        scope,
        selected.source as NativeExecutionSnapshot,
      );
    }
    for (
      const table of [
        "ExecutionRun",
        "ExecutionContribution",
        "ExecutionEffect",
        "ImmutableConsultationGroup",
      ] as const
    ) {
      if (
        (await query(
          `SELECT 1 FROM ${
            this.table(table)
          } WHERE ${scopeWhere} AND "threadId"=$5 LIMIT 1`,
          [...scopedValues(scope), row.threadId],
        )).rows.length
      ) throw new Error("Software successor has already started work");
    }
    if (
      (await query(
        `SELECT 1 FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "predecessorThreadId"=$5 LIMIT 1`,
        [...scopedValues(scope), row.threadId],
      )).rows.length ||
      (await query(
          `SELECT 1 FROM ${
            this.table("ExecutionThreadBinding")
          } WHERE ${scopeWhere} AND "activeThreadId"=$5`,
          [...scopedValues(scope), row.threadId],
        )).rows.length !== 1
    ) throw new Error("Software successor selection membership differs");
    return parseNeverStartedAdoptionSource({
      v: 1,
      kind: "never-started-adoption-successor",
      threadId: row.threadId,
      predecessorThreadId: row.predecessorThreadId,
      identityDigest,
      previousCommandId: manifest.dossierId,
      previousReceiptDigest: context.currentPin.adoption!.receiptDigest,
      previousAuthorizationRuntimeRevision:
        manifest.authorizationRuntimeRevision,
      previousCommittedRuntimeRevision: manifest.committedRuntimeRevision,
      authorizedPinDigest: await sha256(row.authorizedPinJson),
      advanceAuthorizationDigest: await sha256(row.advanceAuthorizationJson),
    });
  }

  async #retireNeverStartedSuccessor(
    query: ExecutionSql,
    item: PreparedNeverStartedSuccessor,
  ): Promise<string> {
    const values = scopedValues(item.scope);
    const rows = (await query(
      `SELECT row_to_json(e)::text AS "rowJson",row_to_json(b)::text AS "bindingJson" FROM ${
        this.table("OperatorExecution")
      } e JOIN ${this.table("ExecutionThreadBinding")} b
      ON b."projectId"=e."projectId" AND b."systemId"=e."systemId" AND b."executionSpaceId"=e."executionSpaceId" AND b."operatorId"=e."operatorId" AND b."activeThreadId"=e."threadId"
      WHERE e."projectId"=$1 AND e."systemId"=$2 AND e."executionSpaceId"=$3 AND e."operatorId"=$4 AND e."threadId"=$5`,
      [...values, item.threadId],
    )).rows;
    if (
      rows.length !== 1 || rows[0].rowJson !== item.rowJson ||
      rows[0].bindingJson !== item.bindingJson
    ) throw new Error("Never-started successor changed after native locking");
    const threadId = `execution:${crypto.randomUUID()}`,
      identity = item.identity;
    await query(
      `INSERT INTO ${
        this.table("OperatorExecution")
      } ("projectId","systemId","executionSpaceId","operatorId","threadId","identityJson","scopeKind","scopeId","rootRequestId","ownerId","purpose","subjectId","revision","epoch","status","checkpointNamespace","predecessorThreadId","authorizedPinJson","advanceAuthorizationJson","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,'request',$7,$8,NULL,$9,$10,0,0,'queued','',$11,$12,$13,clock_timestamp(),clock_timestamp())`,
      [
        ...values,
        threadId,
        item.identityJson,
        identity.scope.scopeId,
        identity.scope.kind === "request" ? identity.scope.rootRequestId : null,
        identity.purpose,
        identity.subjectId ?? null,
        item.threadId,
        item.targetPin,
        item.authorizationJson,
      ],
    );
    const retired = await query(
      `UPDATE ${
        this.table("OperatorExecution")
      } SET "retiredAt"=clock_timestamp(),"revision"="revision"+1 WHERE ${scopeWhere} AND "threadId"=$5 AND "retiredAt" IS NULL AND "revision"=0 RETURNING "threadId"`,
      [...values, item.threadId],
    );
    const selected = await query(
      `UPDATE ${
        this.table("ExecutionThreadBinding")
      } SET "activeThreadId"=$6,"revision"="revision"+1,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "identityDigest"=$5 AND "activeThreadId"=$7 AND "revision"=$8::bigint RETURNING "activeThreadId"`,
      [
        ...values,
        item.identityDigest,
        threadId,
        item.threadId,
        item.bindingRevision,
      ],
    );
    if (retired.rows.length !== 1 || selected.rows.length !== 1) {
      throw new Error("Never-started successor selection CAS changed");
    }
    return threadId;
  }

  async #retirementMembership(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    lock: boolean,
  ): Promise<string> {
    const result: unknown[] = [];
    const sets = [
      ["ExecutionThreadBinding", "identityDigest"],
      ["OperatorExecution", "threadId"],
      ["ExecutionRun", "threadId", "runId"],
      ["ExecutionContribution", "threadId", "contributionId"],
      ["ExecutionEffect", "threadId", "effectKey"],
      ["ImmutableConsultationGroup", "threadId", "groupId"],
    ] as const;
    for (const [table, ...keys] of sets) {
      const rows = (await query(
        `SELECT row_to_json(t)::text AS content FROM ${this.table(table)} t
        WHERE ${scopeWhere} ORDER BY ${
          keys.map((key) => `"${key}"`).join(",")
        } LIMIT 257${lock ? " FOR UPDATE NOWAIT" : ""}`,
        scopedValues(scope),
      )).rows;
      if (rows.length > 256) {
        throw new Error(
          "Native retirement membership exceeds bounded lock packet",
        );
      }
      result.push([table, rows]);
    }
    return canonical(result);
  }

  /** Must run before control/dossier/Opening/admission/parent locks. */
  async lockRetirementInTransaction(
    tx: Prisma.TransactionClient,
    packet: object,
  ): Promise<object> {
    const prepared = this.#retirements.get(packet),
      empty = this.#emptyRetirements.get(packet);
    if (
      (!prepared && !empty) ||
      !["owner-adoption", "software-evolution-scoped-adoption"].includes(
        (prepared?.authorization ?? empty?.authorization)?.kind ?? "",
      ) ||
      currentPostgresExecutionTransaction()?.fence || this.#claim.getStore()
    ) {
      throw new Error(
        "Prepared Request retirement requires detached owner adoption",
      );
    }
    const query = fromPrisma(tx).executeSql,
      scope = empty?.scope ?? this.scope(prepared!.snapshot.identity);
    const before = await this.#retirementMembership(query, scope, false);
    if (before !== (prepared?.membership ?? empty!.membership)) {
      throw new Error("Prepared native dependencies changed; reprepare");
    }
    // Discover the exact job set before taking any binding/thread locks. Any
    // concurrent membership mutation is rejected below, never locked late.
    const jobs = (await query(
      `SELECT DISTINCT "jobId" FROM ${this.table("ExecutionRun")}
      WHERE ${scopeWhere} ORDER BY "jobId" LIMIT 257`,
      scopedValues(scope),
    )).rows;
    if (jobs.length > 256) {
      throw new Error("Native retirement job packet exceeds bound");
    }
    await lockRetirementJobReceipts({
      tx,
      client: this.client,
      scope: this.options.scope,
      queueName: this.options.queueName,
      jobIds: jobs.map((job) => String(job.jobId)),
      lookup: this.options.lookupRetirementJob,
    });
    const membership = await this.#retirementMembership(query, scope, true);
    if (membership !== before) {
      throw new Error("Native retirement membership changed; reprepare");
    }
    const network = this.#networkCheckpointEvidence.get(packet);
    const authority = prepared?.authorization ?? empty?.authorization;
    const changeProof = ownerAdoptionChange(authority);
    if (changeProof && !network) {
      throw new Error("Network checkpoint evidence unavailable");
    }
    if (network) {
      if (
        !changeProof ||
        changeProof.checkpointDigest !== await sha256(network.rows)
      ) throw new Error("Network checkpoint digest differs");
      if (
        await this.networkCheckpointRows(query, network.snapshot, true) !==
          network.rows
      ) throw new Error("Approval checkpoint changed after capture");
      const source = await this.assertUnconsumedSnapshotWait(
        query,
        scope,
        network.snapshot,
      );
      if (
        source.wait.effectKey !== network.preparedEffectKey ||
        canonical(source.wait.changeApprovalWait) !== canonical(network.wait)
      ) {
        throw new Error(
          "Approval typed checkpoint evidence changed after capture",
        );
      }
      const consumed = await query(
        `SELECT "effectKey" FROM ${
          this.table("ExecutionEffect")
        } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
        [
          ...scopedValues(scope),
          network.snapshot.threadId,
          network.preparedEffectKey,
        ],
      );
      if (consumed.rows.length) {
        throw new Error("The approval wait has already been consumed");
      }
    }
    for (
      const [table, predicate] of [
        ["ExecutionContribution", `"status" IN ('queued','running')`],
        ["ExecutionEffect", `"status"<>'completed'`],
        ["ImmutableConsultationGroup", `"publicationJson" IS NULL`],
      ] as const
    ) {
      if (
        (await query(
          `SELECT 1 FROM ${
            this.table(table)
          } WHERE ${scopeWhere} AND ${predicate} LIMIT 1`,
          scopedValues(scope),
        )).rows.length
      ) {
        throw new Error("Accepted or unsettled native work blocks retirement");
      }
    }
    const inertThreads = (this.#neverStartedSuccessors.get(packet) ?? []).map(
      (item) => item.threadId,
    );
    const expectedThreads = [
      ...(this.#retirementBatches.get(packet) ?? [packet])
        .map((item) => this.#retirements.get(item)!.snapshot.threadId),
      ...inertThreads,
    ].sort();
    const active = (await query(
      `SELECT "threadId","status" FROM ${this.table("OperatorExecution")}
      WHERE ${scopeWhere} AND "retiredAt" IS NULL AND "status"<>'completed' ORDER BY "threadId"`,
      scopedValues(scope),
    )).rows;
    if (
      active.some((row) =>
        row.status !==
          (inertThreads.includes(String(row.threadId)) ? "queued" : "waiting")
      ) ||
      canonical(active.map((row) => String(row.threadId))) !==
        canonical(expectedThreads)
    ) {
      throw new Error(
        "Prepared snapshots do not exhaust the native empty-wait set",
      );
    }
    const token = Object.freeze({});
    this.#retirementLocks.set(token, { tx, packet, membership });
    return token;
  }

  /** Recheck the complete prepared native row set after acquiring the parent.
   * This performs reads only: no late native locks, successor or other effect. */
  async assertRetirementPreparedLocked(
    tx: Prisma.TransactionClient,
    packet: object,
    token: object,
  ): Promise<void> {
    const prepared = this.#retirements.get(packet),
      empty = this.#emptyRetirements.get(packet),
      held = this.#retirementLocks.get(token);
    if ((!prepared && !empty) || held?.tx !== tx || held.packet !== packet) {
      throw new Error("Native retirement lock token mismatch");
    }
    const query = fromPrisma(tx).executeSql,
      scope = empty?.scope ?? this.scope(prepared!.snapshot.identity);
    if (
      await this.#retirementMembership(query, scope, false) !== held.membership
    ) {
      throw new Error("Native retirement dependency changed after locking");
    }
  }

  /** Verify the host proposal evidence against the actual completed effect and
   * selected native checkpoint while the retirement membership locks are held. */
  async assertNetworkApprovalEffectLocked(
    tx: Prisma.TransactionClient,
    packet: object,
    token: object,
    snapshot: NativeExecutionSnapshot,
    wait:
      import("../../../application/work/native-execution/contract.ts").NativeChangeApprovalWait,
  ): Promise<void> {
    await this.assertRetirementPreparedLocked(tx, packet, token);
    const members = this.#retirementBatches.get(packet) ?? [packet];
    if (
      !members.some((item) =>
        canonical(this.#retirements.get(item)?.snapshot) === canonical(snapshot)
      )
    ) {
      throw new Error("Approval wait is not in the locked retirement packet");
    }
    const query = fromPrisma(tx).executeSql;
    const scope = this.scope(snapshot.identity);
    const values = scopedValues(scope);
    const row = (await query(
      `SELECT "currentRunId","currentCheckpointId","status" FROM ${
        this.table("OperatorExecution")
      } WHERE ${scopeWhere} AND "threadId"=$5`,
      [...values, snapshot.threadId],
    )).rows[0];
    if (
      !row || row.status !== "waiting" ||
      row.currentCheckpointId !== snapshot.checkpointId ||
      row.currentRunId !== snapshot.runId || !snapshot.runId
    ) {
      throw new Error("Approval wait checkpoint changed");
    }
    const run = (await query(
      `SELECT "snapshotJson","checkpointId","status" FROM ${
        this.table("ExecutionRun")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
      [...values, snapshot.threadId, snapshot.runId],
    )).rows[0];
    if (
      !run || run.status !== "waiting" ||
      run.checkpointId !== snapshot.checkpointId ||
      typeof run.snapshotJson !== "string" ||
      canonical(JSON.parse(run.snapshotJson)) !== canonical(snapshot) ||
      canonical(snapshot.localState?.changeApprovalWait) !== canonical(wait)
    ) {
      throw new Error("Approval wait native snapshot differs");
    }
    const evidence = this.#networkCheckpointEvidence.get(packet);
    if (
      !evidence || canonical(evidence.snapshot) !== canonical(snapshot) ||
      canonical(evidence.wait) !== canonical(wait)
    ) throw new Error("Approval checkpoint lock packet differs");
    const effect = (await query(
      `SELECT "runId","contributionId","nodeId","status","resultJson" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "effectKey"=$6`,
      [...values, snapshot.threadId, wait.effectKey],
    )).rows[0];
    if (
      !effect || effect.status !== "completed" ||
      effect.runId !== snapshot.runId ||
      effect.contributionId !== wait.contributionId ||
      effect.nodeId !== wait.actionId ||
      typeof effect.resultJson !== "string"
    ) throw new Error("Proposal effect is not completed");
    const result = JSON.parse(effect.resultJson) as NativeExecutionActionResult;
    if (
      canonical(result.localState?.changeApprovalProposal) !== canonical({
          changeId: wait.changeId,
          proposalIntentDigest: wait.proposalIntentDigest,
        }) ||
      (result.outputs?.submission as { awaitingInput?: unknown } | undefined)
          ?.awaitingInput !== true
    ) {
      throw new Error(
        "Approval wait differs from its completed proposal effect",
      );
    }
  }

  /** Uses only already acquired native locks. Authorization r+1 must have been
   * appended in this caller's transaction using the canonical state helper. */
  async retirePreparedLocked(
    tx: Prisma.TransactionClient,
    packet: object,
    token: object,
  ) {
    await this.assertRetirementPreparedLocked(tx, packet, token);
    const prepared = this.#retirements.get(packet),
      empty = this.#emptyRetirements.get(packet);
    const query = fromPrisma(tx).executeSql,
      scope = empty?.scope ?? this.scope(prepared!.snapshot.identity);
    if (empty) {
      const current = await this.currentBusiness(query, scope);
      if (empty.authorization.kind === "software-evolution-scoped-adoption") {
        await this.#assertScopedSoftwareRetirementAuthorization(
          query,
          scope,
          empty.authorization,
          empty.targetModel,
          current,
        );
      } else if (empty.authorization.kind === "owner-adoption") {
        await this.#assertOwnerRetirementAuthorization(
          query,
          scope,
          empty.authorization,
          empty.targetModel,
          current,
        );
      } else throw new Error("Empty retirement authority mismatch");
    }
    const predecessors: string[] = [], successors: string[] = [];
    const networkAuthority = prepared?.authorization ?? empty?.authorization;
    const changeProof = ownerAdoptionChange(networkAuthority);
    let lockedNetworkSnapshot: NativeExecutionSnapshot | undefined;
    if (changeProof) {
      const entries = (this.#retirementBatches.get(packet) ?? [packet]).map((
        item,
      ) => this.#retirements.get(item)!);
      const matches = entries.filter((item) => {
        const wait = item.snapshot.localState?.changeApprovalWait as
          | import("../../../application/work/native-execution/contract.ts").NativeChangeApprovalWait
          | undefined;
        return wait?.changeId === changeProof.proof.changeId &&
          wait.proposalIntentDigest === changeProof.proof.proposalIntentDigest;
      });
      if (matches.length !== 1) {
        throw new Error("The exact network approval wait is unavailable");
      }
      await this.assertNetworkApprovalEffectLocked(
        tx,
        packet,
        token,
        matches[0].snapshot,
        matches[0].snapshot.localState!
          .changeApprovalWait as import("../../../application/work/native-execution/contract.ts").NativeChangeApprovalWait,
      );
      lockedNetworkSnapshot = matches[0].snapshot;
    }
    for (const item of this.#retirementBatches.get(packet) ?? [packet]) {
      const value = this.#retirements.get(item)!;
      predecessors.push(value.snapshot.threadId);
      successors.push(
        await this.#retireBody(query, value, false, lockedNetworkSnapshot),
      );
    }
    const neverStarted = this.#neverStartedSuccessors.get(packet) ?? [];
    if (neverStarted.length) {
      const authority = prepared?.authorization ?? empty!.authorization;
      const target = prepared?.targetModel ?? empty!.targetModel;
      if (authority.kind === "software-evolution-scoped-adoption") {
        await this.#assertScopedSoftwareRetirementAuthorization(
          query,
          scope,
          authority,
          target,
          await this.currentBusiness(query, scope),
        );
      } else if (authority.kind === "owner-adoption") {
        await this.#assertOwnerRetirementAuthorization(
          query,
          scope,
          authority,
          target,
          await this.currentBusiness(query, scope),
        );
      } else throw new Error("Never-started successor authority mismatch");
      for (const item of neverStarted) {
        predecessors.push(item.threadId);
        successors.push(await this.#retireNeverStartedSuccessor(query, item));
      }
    }
    const result = {
      predecessorThreadIds: predecessors,
      successorThreadIds: successors,
    };
    return {
      ...result,
      digest: await executionDigest({
        ...result,
        emptyAuthorization: empty?.authorizationJson ?? null,
        ...(neverStarted.length
          ? {
            neverStartedAuthorizations: neverStarted.map((item) =>
              item.authorizationJson
            ),
          }
          : {}),
        authorizations: (this.#retirementBatches.get(packet) ?? [packet]).map(
          (item) => this.#retirements.get(item)!.authorizationJson,
        ),
      }),
    };
  }

  /** Software Request proof stays distinct from human owner authorization.
   * rFinal+1 is a canonical state written in the same adoption transaction. */
  async #assertScopedSoftwareRetirementAuthorization(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    authorization: Extract<
      NativeThreadAdvanceAuthorization,
      { kind: "software-evolution-scoped-adoption" }
    >,
    targetModel: ExecutableModel,
    current: SystemRuntimeState,
  ): Promise<void> {
    const accepted = await this.businessRevision(
      query,
      scope,
      authorization.businessRevision,
    );
    const row = (await query(
      `SELECT "payload","kind","executionSpaceId" FROM ${this.#schema}."EvolutionDossier" WHERE "projectId"=$1 AND "systemId"=$2 AND "id"=$3 FOR SHARE`,
      [scope.projectId, scope.systemId, authorization.dossierId],
    )).rows[0];
    if (
      typeof row?.payload !== "string" ||
      row.kind !== "software-evolution-scoped-v2" ||
      row.executionSpaceId !== scope.executionSpaceId
    ) throw new Error("Scoped software adoption dossier unavailable");
    const dossier = await parseScopedSoftwareDossier(JSON.parse(row.payload));
    const barrier = (await query(
      `SELECT "dossierId" FROM ${this.#schema}."EvolutionTargetBarrier" WHERE "projectId"=$1 AND "systemId"=$2 AND "repositoryId"=$3 AND "targetScopeKey"=$4 AND "operatorId"=$5 FOR SHARE`,
      [
        scope.projectId,
        scope.systemId,
        dossier.repositoryId,
        `request:${scope.executionSpaceId}`,
        scope.operatorId,
      ],
    )).rows[0];
    assertScopedSoftwareRetirementAuthority(
      scope,
      authorization,
      targetModel,
      current,
      accepted,
      dossier,
      barrier?.dossierId,
    );
  }

  async #assertOwnerRetirementAuthorization(
    query: ExecutionSql,
    scope: PostgresRuntimeScope,
    authorization: Extract<
      NativeThreadAdvanceAuthorization,
      { kind: "owner-adoption" }
    >,
    targetModel: ExecutableModel,
    current: SystemRuntimeState,
  ): Promise<void> {
    const accepted = await this.businessRevision(
      query,
      scope,
      authorization.businessRevision,
    );
    assertOwnerRetirementAuthority(
      authorization,
      targetModel,
      current,
      accepted,
    );
  }

  async #retireBody(
    query: ExecutionSql,
    prepared: {
      snapshot: NativeExecutionSnapshot;
      authorization: NativeThreadAdvanceAuthorization;
      targetModel: ExecutableModel;
      identityDigest: string;
      identityJson: string;
      targetPin: string;
      authorizationJson: string;
    },
    lock: boolean,
    lockedNetworkSnapshot?: NativeExecutionSnapshot,
  ): Promise<string> {
    const {
      snapshot,
      authorization,
      targetModel,
      identityDigest,
      identityJson,
      targetPin,
      authorizationJson,
    } = prepared;
    const scope = this.scope(snapshot.identity);
    const values = scopedValues(scope);
    const binding = (await query(
      `SELECT * FROM ${
        this.table("ExecutionThreadBinding")
      } WHERE ${scopeWhere} AND "identityDigest"=$5 ${
        lock ? "FOR UPDATE" : ""
      }`,
      [...values, identityDigest],
    )).rows[0];
    if (!binding || binding.identityJson !== identityJson) {
      throw new Error("Execution retirement identity binding is unavailable");
    }
    if (binding.activeThreadId !== snapshot.threadId) {
      const selected = (await query(
        `SELECT "predecessorThreadId","advanceAuthorizationJson" FROM ${
          this.table("OperatorExecution")
        } WHERE ${scopeWhere} AND "threadId"=$5`,
        [...values, binding.activeThreadId],
      )).rows[0];
      if (
        selected?.predecessorThreadId === snapshot.threadId &&
        selected.advanceAuthorizationJson === authorizationJson
      ) {
        await this.assertUnconsumedSnapshotWait(query, scope, snapshot);
        return String(binding.activeThreadId);
      }
      throw new Error(
        "Execution retirement already selected a different successor",
      );
    }
    const rows = (await query(
      `SELECT * FROM ${
        this.table("OperatorExecution")
      } WHERE ${scopeWhere} AND "threadId"=$5 ${lock ? "FOR UPDATE" : ""}`,
      [...scopedValues(scope), snapshot.threadId],
    )).rows;
    const row = rows[0];
    await this.assertNoOpenGroups(query, scope, snapshot.threadId);
    if (
      !row || row.retiredAt || row.identityJson !== identityJson ||
      row.currentCheckpointId !== snapshot.checkpointId ||
      snapshot.runId !== undefined && row.currentRunId !== snapshot.runId ||
      row.status !== "waiting"
    ) throw new Error("Stale execution retirement snapshot");
    const run = (await query(
      `SELECT * FROM ${
        this.table("ExecutionRun")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
      [...values, snapshot.threadId, row.currentRunId],
    )).rows[0];
    if (
      typeof run?.snapshotJson !== "string" ||
      run.runId !== row.currentRunId ||
      run.checkpointId !== snapshot.checkpointId ||
      run.contributionId !== snapshot.contributionId ||
      run.status !== "waiting" ||
      canonical(JSON.parse(run.snapshotJson)) !== canonical(snapshot)
    ) {
      throw new Error(
        "Execution retirement does not match its accepted native snapshot",
      );
    }
    const effects = await query(
      `SELECT "effectKey" FROM ${
        this.table("ExecutionEffect")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "status"<>'completed'`,
      [...scopedValues(scope), snapshot.threadId],
    );
    if (effects.rows.length) {
      throw new Error("Unsettled execution effect blocks retirement");
    }
    const pending = await query(
      `SELECT "contributionId" FROM ${
        this.table("ExecutionContribution")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "status" IN ('queued','running') LIMIT 1`,
      [...values, snapshot.threadId],
    );
    if (pending.rows.length) {
      throw new Error("Accepted pending inputs block execution retirement");
    }
    const current = await this.currentBusiness(query, scope);
    // The retained immutable request proves the old run's source only. The
    // current business pin below remains the source of adoption authority.
    const source = this.runSource(run);
    const historical = await this.businessRevision(
      query,
      scope,
      source.businessRevision,
    );
    const sourceModel = historical.executionModel!;
    const pin = typeof run.pinJson === "string"
      ? JSON.parse(run.pinJson)
      : null;
    assertRetirementHistoricalSource(
      snapshot,
      identityJson,
      source,
      historical,
      pin,
    );
    await this.assertUnconsumedSnapshotWait(query, scope, snapshot);
    await assertRetirementSafety(
      scope,
      authorization,
      targetModel,
      current,
      snapshot,
      sourceModel,
      lockedNetworkSnapshot,
      async (dossierId) => {
        const row = (await query(
          `SELECT "payload" FROM ${this.#schema}."EvolutionDossier" WHERE "projectId"=$1 AND "systemId"=$2 AND "id"=$3 FOR SHARE`,
          [scope.projectId, scope.systemId, dossierId],
        )).rows[0];
        if (typeof row?.payload !== "string") {
          throw new Error("Network adoption dossier is unavailable");
        }
        return await parseRequestOwnerAdoptionDossier(JSON.parse(row.payload));
      },
    );
    if (authorization.kind === "owner-adoption") {
      await this.#assertOwnerRetirementAuthorization(
        query,
        scope,
        authorization,
        targetModel,
        current,
      );
    } else if (authorization.kind === "software-evolution-scoped-adoption") {
      await this.#assertScopedSoftwareRetirementAuthorization(
        query,
        scope,
        authorization,
        targetModel,
        current,
      );
    } else {
      const stored = (await query(
        `SELECT "payload" FROM ${this.#schema}."EvolutionDossier" WHERE "projectId"=$1 AND "systemId"=$2 AND "id"=$3 FOR SHARE`,
        [scope.projectId, scope.systemId, authorization.dossierId],
      )).rows[0];
      if (typeof stored?.payload !== "string") {
        throw new Error("Evolution adoption dossier is unavailable");
      }
      const dossier = JSON.parse(stored.payload) as EvolutionDossier;
      assertEvolutionDossier(dossier);
      assertEvolutionRetirementAuthority(
        scope.operatorId,
        authorization,
        targetModel,
        current,
        dossier,
      );
    }
    const threadId = `execution:${crypto.randomUUID()}`;
    await query(
      `INSERT INTO ${
        this.table("OperatorExecution")
      } ("projectId","systemId","executionSpaceId","operatorId","threadId","identityJson","scopeKind","scopeId","rootRequestId","ownerId","purpose","subjectId","revision","epoch","status","checkpointNamespace","predecessorThreadId","authorizedPinJson","advanceAuthorizationJson","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,0,0,'queued','',$13,$14,$15,clock_timestamp(),clock_timestamp())`,
      [
        ...values,
        threadId,
        identityJson,
        snapshot.identity.scope.kind,
        snapshot.identity.scope.scopeId,
        snapshot.identity.scope.kind === "request"
          ? snapshot.identity.scope.rootRequestId
          : null,
        snapshot.identity.scope.kind === "designer"
          ? snapshot.identity.scope.ownerId
          : null,
        snapshot.identity.purpose,
        snapshot.identity.subjectId ?? null,
        snapshot.threadId,
        targetPin,
        authorizationJson,
      ],
    );
    await query(
      `UPDATE ${
        this.table("OperatorExecution")
      } SET "retiredAt"=clock_timestamp(),"revision"="revision"+1 WHERE ${scopeWhere} AND "threadId"=$5`,
      [...scopedValues(scope), snapshot.threadId],
    );
    await query(
      `UPDATE ${
        this.table("ExecutionThreadBinding")
      } SET "activeThreadId"=$6,"revision"="revision"+1,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "identityDigest"=$5 AND "revision"=$7`,
      [...values, identityDigest, threadId, binding.revision],
    );
    return threadId;
  }

  async retireAndAdvance(
    snapshot: NativeExecutionSnapshot,
    authorization: NativeThreadAdvanceAuthorization,
    targetModel: ExecutableModel,
  ) {
    const packet = await this.#prepareRetirement(
      snapshot,
      authorization,
      targetModel,
      false,
    );
    const prepared = this.#retirements.get(packet)!;
    const inherited = currentPostgresExecutionTransaction(),
      claim = this.#claim.getStore();
    await this.client.$transaction(async (tx) => {
      const query = fromPrisma(tx).executeSql;
      await inherited?.fence?.(query);
      await this.#retireBody(query, prepared, true);
      if (claim) await this.lockClaim(query, claim.job);
    });
  }

  async checkpointFence(
    query: ExecutionSql,
    session: SessionRecord,
    expectedId: string | null,
  ) {
    await this.fence(query, session);
    const row = (await query(
      `SELECT "checkpointId" FROM ${
        this.table("ExecutionRun")
      } WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6 FOR UPDATE`,
      [...scopedValues(session.scope), session.threadId, session.runId],
    )).rows[0];
    if (!row || row.checkpointId !== expectedId) {
      throw new Error("STALE_EXECUTION_CHECKPOINT_POINTER");
    }
  }
  async selectCheckpoint(
    query: ExecutionSql,
    session: SessionRecord,
    expectedId: string | null,
    nextId: string,
  ) {
    await this.checkpointFence(query, session, expectedId);
    await query(
      `UPDATE ${
        this.table("ExecutionRun")
      } SET "checkpointId"=$7,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5 AND "runId"=$6`,
      [...scopedValues(session.scope), session.threadId, session.runId, nextId],
    );
    await query(
      `UPDATE ${
        this.table("OperatorExecution")
      } SET "currentCheckpointId"=$6,"revision"="revision"+1,"updatedAt"=clock_timestamp() WHERE ${scopeWhere} AND "threadId"=$5`,
      [...scopedValues(session.scope), session.threadId, nextId],
    );
  }
}

interface CheckpointWrite {
  expected: string | null;
  next?: string;
  waits?: NativeWaitEvidence[];
  consumptions?: NativeWaitConsumptionEvidence[];
  evidenceCheckpointId?: string;
  onEvidence?: (query: ExecutionSql, id: string) => Promise<void>;
}
/** Official saver with a transaction/pointer seam; no copied SQL or serializer. */
class FencedExecutionSaver extends PostgresSaver {
  readonly #writes: AsyncLocalStorage<CheckpointWrite>;
  #tail: Promise<void> = Promise.resolve();
  readonly #forkIds = new Set<string>();
  constructor(
    pool: Pool,
    schema: string,
    private readonly ledger: PostgresNativeExecutionLedger,
    private readonly session: SessionRecord,
    private readonly forkNamespace?: string,
    private readonly historicalFork?: {
      sourceId: string;
      tuple: NonNullable<Awaited<ReturnType<PostgresSaver["getTuple"]>>>;
      onFork: (query: ExecutionSql, checkpointId: string) => Promise<void>;
    },
    private readonly forkEvidence?: {
      runId: string;
      request: NativeExecutionRequest;
      wait: NativeWaitEvidence;
    },
  ) {
    const writes = new AsyncLocalStorage<CheckpointWrite>();
    const guarded = new Proxy(pool, {
      get(target, property) {
        if (property === "connect") {
          return async () => {
            const client = await target.connect(), write = writes.getStore();
            let begun = false;
            return new Proxy(client, {
              get(real, member) {
                if (member === "query") {
                  return async (sql: string, values?: unknown[]) => {
                    if (sql === "BEGIN") {
                      if (!write) {
                        throw new Error("Unscoped checkpoint transaction");
                      }
                      await real.query(sql);
                      begun = true;
                      await ledger.checkpointFence(
                        async (text, params) => await real.query(text, params),
                        session,
                        write.expected,
                      );
                      return { rows: [] };
                    }
                    if (!begun) {
                      // The official saver may clean up after an injected
                      // post-COMMIT crash. The committed transaction is closed.
                      if (sql === "ROLLBACK") return { rows: [] };
                      throw new Error("Checkpoint write outside transaction");
                    }
                    if (sql === "COMMIT") {
                      if (!write) {
                        throw new Error("Checkpoint write context lost");
                      }
                      const query: ExecutionSql = async (text, params) =>
                        await real.query(text, params);
                      for (const wait of write.waits ?? []) {
                        ledger.waitEvidence.verifyIdentity(
                          wait,
                          session.request,
                        );
                        await ledger.waitEvidence.verifyEffect(
                          query,
                          session.scope,
                          session.threadId,
                          wait,
                        );
                        await ledger.waitEvidence.appendWait(
                          query,
                          session.scope,
                          session.threadId,
                          session.runId,
                          session.namespace,
                          write.evidenceCheckpointId!,
                          immutablePin(session.request),
                          wait,
                          "interrupt-v1",
                        );
                      }
                      for (const proof of write.consumptions ?? []) {
                        if (
                          proof.contributionId !==
                            session.request.contribution.id
                        ) continue;
                        if (
                          proof.kind === "wait-v1" &&
                          proof.sourceCheckpointId !== write.expected
                        ) {
                          throw new Error(
                            "NATIVE_WAIT_CONSUMPTION_CURSOR_MISMATCH",
                          );
                        }
                        await ledger.waitEvidence.commitConsumption(
                          query,
                          session.scope,
                          session.threadId,
                          session.runId,
                          session.namespace,
                          write.next!,
                          proof,
                        );
                      }
                      if (write.onEvidence) {
                        await write.onEvidence(
                          query,
                          write.evidenceCheckpointId!,
                        );
                      }
                      if (write.next && historicalFork) {
                        await ledger.checkpointFence(
                          query,
                          session,
                          write.expected,
                        );
                        await historicalFork.onFork(query, write.next);
                      } else if (write.next) {
                        await ledger.selectCheckpoint(
                          query,
                          session,
                          write.expected,
                          write.next,
                        );
                      } else {await ledger.checkpointFence(
                          query,
                          session,
                          write.expected,
                        );}
                    }
                    const evidenceKind = write?.waits?.length
                      ? "interrupt"
                      : write?.consumptions?.some((proof) =>
                          proof.contributionId ===
                            session.request.contribution.id
                        )
                      ? "consumption"
                      : undefined;
                    if (sql === "COMMIT" && evidenceKind) {
                      await ledger.options.waitEvidenceFault?.(
                        `before-${evidenceKind}-commit`,
                      );
                    }
                    const result = await real.query(sql, values);
                    if (sql === "COMMIT") {
                      begun = false;
                      if (write?.next && !historicalFork) {
                        session.checkpointId = write.next;
                      }
                      if (evidenceKind) {
                        await ledger.options.waitEvidenceFault?.(
                          `after-${evidenceKind}-commit`,
                        );
                      }
                    }
                    if (sql === "ROLLBACK") begun = false;
                    return result;
                  };
                }
                const value = Reflect.get(real, member, real);
                return typeof value === "function" ? value.bind(real) : value;
              },
            });
          };
        }
        if (property === "query") {
          return async (
            query: string | { text: string },
            values?: unknown[],
          ) => {
            if (
              !/^\s*SELECT\b/i.test(
                typeof query === "string" ? query : query.text,
              )
            ) throw new Error("Checkpoint write bypassed fence");
            return await target.query(query, values);
          };
        }
        if (property === "end") return () => Promise.resolve();
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super(guarded, undefined, { schema });
    this.#writes = writes;
  }
  override async getTuple(config: RunnableConfig) {
    this.assertRoot(config);
    const selected = config.configurable?.checkpoint_id ??
      this.session.checkpointId;
    if (this.historicalFork && selected === this.historicalFork.sourceId) {
      return {
        ...this.historicalFork.tuple,
        config: {
          configurable: {
            thread_id: this.session.threadId,
            checkpoint_ns: "",
            checkpoint_id: selected,
          },
        },
        parentConfig: undefined,
      };
    }
    if (!selected) return undefined;
    const namespace = this.forkNamespace && this.#forkIds.has(selected)
      ? this.forkNamespace
      : this.session.namespace;
    const tuple = await super.getTuple({
      ...config,
      configurable: {
        ...config.configurable,
        thread_id: this.session.threadId,
        checkpoint_ns: namespace,
        checkpoint_id: selected,
      },
    });
    return tuple
      ? {
        ...tuple,
        config: this.logical(tuple.config),
        ...(tuple.parentConfig
          ? { parentConfig: this.logical(tuple.parentConfig) }
          : {}),
      }
      : undefined;
  }
  override async put(...args: Parameters<PostgresSaver["put"]>) {
    const [config, checkpoint] = args;
    this.assertRoot(config);
    if (this.forkNamespace) {
      if (
        config.configurable?.checkpoint_id !==
          (this.historicalFork?.sourceId ?? this.session.checkpointId)
      ) {
        throw new Error(
          "Native fork must anchor the exact selected source checkpoint",
        );
      }
      return await this.serial(async () =>
        await this.#writes.run(
          {
            expected: this.session.checkpointId,
            ...(this.historicalFork ? { next: checkpoint.id } : {}),
            evidenceCheckpointId: checkpoint.id,
            ...(this.forkEvidence
              ? {
                onEvidence: async (query: ExecutionSql, id: string) => {
                  const target = this.forkEvidence!;
                  const wait: NativeWaitEvidence = {
                    ...target.wait,
                    modelPin: {
                      ...target.wait.modelPin,
                      identity: target.request.model.identity,
                      version: target.request.model.version,
                    },
                    executionScope: structuredClone(
                      target.request.identity.scope,
                    ),
                    ...(target.request.identity.scope.kind === "request"
                      ? {
                        rootRequestId:
                          target.request.identity.scope.rootRequestId,
                      }
                      : {}),
                  };
                  if (target.request.identity.scope.kind !== "request") {
                    delete wait.rootRequestId;
                  }
                  this.ledger.waitEvidence.verifyIdentity(wait, target.request);
                  await this.ledger.waitEvidence.appendWait(
                    query,
                    this.session.scope,
                    this.session.threadId,
                    target.runId,
                    this.forkNamespace!,
                    id,
                    immutablePin(target.request),
                    wait,
                    "fork-v1",
                  );
                },
              }
              : {}),
          },
          async () => {
            // A namespace fork has no unchanged blobs of its own. Let the OFFICIAL
            // saver serialize every channel version, without copying storage SQL.
            const saved = await super.put(
              {
                ...config,
                configurable: {
                  ...config.configurable,
                  checkpoint_ns: this.forkNamespace,
                  checkpoint_id: undefined,
                },
              },
              checkpoint,
              args[2],
              checkpoint.channel_versions,
            );
            this.#forkIds.add(checkpoint.id);
            return this.logical(saved);
          },
        )
      );
    }
    return await this.serial(async () =>
      await this.#writes.run(
        {
          expected: config.configurable?.checkpoint_id ?? null,
          next: checkpoint.id,
          consumptions: checkpointConsumptions(checkpoint, args[3]),
        },
        async () =>
          this.logical(
            await super.put(
              this.physical(config),
              checkpoint,
              args[2],
              args[3],
            ),
          ),
      )
    );
  }
  override async putWrites(...args: Parameters<PostgresSaver["putWrites"]>) {
    const [config] = args;
    this.assertRoot(config);
    if (this.forkNamespace) {
      // An official updateState fork records its task writes against the
      // anchored source checkpoint before the forked checkpoint exists. Both
      // the anchored source and fork-created checkpoints stay fenced inside
      // the fork namespace; anything else is still refused.
      const anchored = String(config.configurable?.checkpoint_id);
      if (
        anchored !==
          (this.historicalFork?.sourceId ?? this.session.checkpointId) &&
        !this.#forkIds.has(anchored)
      ) {
        throw new Error("Unselected native fork write scope mismatch");
      }
      return await this.serial(async () =>
        await this.#writes.run(
          { expected: this.session.checkpointId },
          () =>
            super.putWrites(
              this.physical(config, this.forkNamespace),
              args[1],
              args[2],
              args[3],
            ),
        )
      );
    }
    return await this.serial(async () =>
      await this.#writes.run(
        {
          expected: config.configurable?.checkpoint_id ?? null,
          evidenceCheckpointId: String(config.configurable?.checkpoint_id),
          waits: checkpointInterruptEvidence(args[1]),
        },
        () => super.putWrites(this.physical(config), args[1], args[2], args[3]),
      )
    );
  }
  override async *list(...args: Parameters<PostgresSaver["list"]>) {
    this.assertRoot(args[0]);
    for await (const tuple of super.list(this.physical(args[0]), args[1])) {
      yield {
        ...tuple,
        config: this.logical(tuple.config),
        ...(tuple.parentConfig
          ? { parentConfig: this.logical(tuple.parentConfig) }
          : {}),
      };
    }
  }
  private assertRoot(config: RunnableConfig) {
    if (
      config.configurable?.thread_id !== this.session.threadId ||
      (config.configurable?.checkpoint_ns ?? "") !== ""
    ) throw new Error("Execution saver requires its exact root graph scope");
  }
  private physical(
    config: RunnableConfig,
    namespace = this.session.namespace,
  ): RunnableConfig {
    return {
      ...config,
      configurable: { ...config.configurable, checkpoint_ns: namespace },
    };
  }
  private logical(config: RunnableConfig): RunnableConfig {
    return {
      ...config,
      configurable: { ...config.configurable, checkpoint_ns: "" },
    };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(operation);
    this.#tail = next.then(() => {}, () => {});
    return next;
  }
}

class UnselectedNativeForkSaver extends FencedExecutionSaver {
  constructor(
    pool: Pool,
    schema: string,
    ledger: PostgresNativeExecutionLedger,
    source: SessionRecord,
    namespace: string,
    evidence: {
      runId: string;
      request: NativeExecutionRequest;
      wait: NativeWaitEvidence;
    },
  ) {
    super(pool, schema, ledger, source, namespace, undefined, evidence);
  }
}
