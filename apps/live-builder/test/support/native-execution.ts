import { parseAcceptedCommand } from "../../src/application/work/operators/command-delivery.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  InitialAdmissionTransferRefused,
  verifyInitialAdmissionSourceSnapshot,
  verifyInitialAdmissionTransfer,
  verifySelectedInitialAdmissionTransfer,
} from "../../src/application/work/runtime/initial-admission-transfer.ts";
/** Explicit test-only ports using the production graph and official MemorySaver.
 * These doubles do not qualify PostgreSQL, queue durability or crash recovery. */
import {
  InMemoryStore,
  type LangGraphRunnableConfig,
  MemorySaver,
} from "@langchain/langgraph";
import {
  type NativeExecutionLedger,
  type NativeExecutionSession,
  NativeGraphExecution,
} from "../../src/adapters/work/runtime/conversation.ts";
import {
  type NativeContinuationReceipt,
  NativeExecutionAdmissionRefused,
  type NativeExecutionRequest,
  type NativeExecutionSnapshot,
  type RuntimeStateHistoryPort,
} from "../../src/application/work/runtime/execution.ts";
import type {
  OperatorDeliveryReceipt,
  OperatorExecutionDelivery,
  OperatorExecutionDispatchPort,
} from "../../src/application/work/operators/execution.ts";
import type { StorePort } from "../../src/application/work/runtime/ports.ts";
import type { WorkBudgetPort } from "../../src/application/work/budget/ports.ts";
import {
  budgetCeilingContractDigest,
  nativeBudgetCeilingAdvanceEvidence,
  validateNativeBudgetCeilingAdvance,
  verifyScalarBudgetCandidate,
} from "../../src/application/work/runtime/budget-transition.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  nativeCandidateConversationAdvanceEvidence,
  nativeCatalogAdvanceEvidence,
  nativeFlowContractDigest,
  nativeMandateAdvanceEvidence,
  nativeTeamAdvanceEvidence,
  nativeUnchangedContractDigest,
} from "../../src/application/work/runtime/model-advance.ts";
import { valueDigest } from "../../src/application/work/runtime/values.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import {
  type BudgetProposalCheckpoint,
  nativeScalarBudgetProposal,
  verifyScalarBudgetFamily,
} from "../../src/adapters/work/runtime/native-budget-proposal.ts";
import type {
  BudgetCeilingManifest,
  BudgetCeilingMember,
} from "../../src/domain/work/records/budget-ceiling-transition.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type { ModelIdentity } from "../../src/domain/work/dialogue.ts";
import type { BehaviorModelVersion } from "../../src/domain/shared-kernel/behavior-model-version.ts";
import type { WorkPlanExecution } from "../../src/application/work/plans/commands/inputs.ts";
import type { CompiledFlowNode } from "../../src/domain/model/execution/flow.ts";
import {
  nativeFrameworkNodeName,
  type NativeState,
} from "../../src/adapters/work/runtime/native-graph.ts";
import {
  budgetSourceFromWait,
  checkpointConsumptions,
  checkpointInterruptEvidence,
  effectResultDigest,
  type NativeWaitConsumptionEvidence,
  type NativeWaitEvidence,
  parseNativeWaitEvidence,
  verifyOfficialFork,
} from "../../src/adapters/work/runtime/checkpoint-wait-evidence.ts";
import {
  workTaskInvocationId,
} from "../../src/application/work/plans/executor.ts";
import { artifactModel } from "./tool-artifact-fixture.ts";
import { createMemoryArtifactSources } from "./memory-artifact-sources.ts";
import {
  assertNoMemoryImmutableConsultations,
  memoryImmutableConsultationSession,
  memoryImmutableConsultationState,
  pendingMemoryImmutableConsultations,
} from "./immutable-consultations.ts";
import {
  assertNativeObservationBinding,
  assertNativeObservationEmission,
  compareNativeObservations,
  encodeNativeObservation,
  type NativeObservationRecord,
  verifyNativeObservationBatches,
} from "../../src/adapters/work/runtime/native-observation.ts";

interface Thread {
  id: string;
  request: NativeExecutionRequest;
  namespace: string;
  runId: string;
  checkpointId?: string;
  snapshot?: NativeExecutionSnapshot;
  saver: MemorySaver;
  receipts: Map<string, { digest: string; snapshot: NativeExecutionSnapshot }>;
  effects: Map<string, unknown>;
  waitReceipts: Map<string, NativeWaitEvidence>;
  consumptionReceipts: Map<string, {
    runId: string;
    checkpointNamespace: string;
    checkpointId: string;
    evidence: NativeWaitConsumptionEvidence;
  }>;
  contributionRuns: Map<
    string,
    {
      digest: string;
      runId: string;
      origin?: string;
      pin?: string;
      identity?: string;
    }
  >;
  groupLedger: ReturnType<typeof memoryImmutableConsultationState>;
  /** R4b journal rows keyed by full run scope/namespace + producer key. */
  nativeObservations: Map<string, {
    record: NativeObservationRecord;
    runId: string;
    namespace: string;
    payload: string;
    pin: string;
    identity: string;
    contributionId: string;
  }>;
  retired?: boolean;
  forceResumeWait?: boolean;
  selectedBudgetContinuation?: NativeContinuationReceipt;
}
export interface NativeFixtureEffectBoundary {
  phase: "before-operation" | "after-operation" | "after-receipt";
  key: string;
  node: CompiledFlowNode;
  request: NativeExecutionRequest;
  result?: unknown;
}
/** Same immutable execution-pin fields as PostgresNativeExecutionLedger's
 * immutablePin, without importing its database adapter into unit fixtures. */
function executionPin(request: NativeExecutionRequest): string {
  return canonical({
    identity: request.model.identity,
    version: request.model.version,
    flowRootId: request.flow.rootNativeId,
    flowOccurrenceId: request.flow.rootOccurrenceId,
    profile: request.flow.executionProfile ?? null,
    maxSteps: request.maxSteps,
  });
}
function graphPin(
  request: NativeExecutionRequest,
): NativeWaitEvidence["modelPin"] {
  return {
    identity: structuredClone(request.model.identity),
    version: structuredClone(request.model.version),
    rootNativeId: request.flow.rootNativeId,
    rootOccurrenceId: request.flow.rootOccurrenceId,
    ...(request.flow.executionProfile
      ? { executionProfile: request.flow.executionProfile }
      : {}),
  };
}
const waitKey = (namespace: string, checkpointId: string) =>
  canonical([namespace, checkpointId]);
const consumptionKey = (runId: string, contributionId: string) =>
  canonical([runId, contributionId]);
const observationKey = (
  runId: string,
  namespace: string,
  emission: {
    producerPhase: string;
    occurrenceId: string;
    emissionStep: number;
    eventOrdinal: number;
  },
) =>
  canonical([
    runId,
    namespace,
    emission.producerPhase,
    emission.occurrenceId,
    emission.emissionStep,
    emission.eventOrdinal,
  ]);
async function sortedNativeObservations(
  thread: Thread,
  runId: string,
): Promise<NativeObservationRecord[]> {
  const records = [...thread.nativeObservations.values()]
    .filter((entry) => entry.runId === runId)
    .map((entry) => structuredClone(entry.record))
    .sort(compareNativeObservations);
  await verifyNativeObservationBatches(records);
  return records;
}
function hasContributionConsumption(
  thread: Thread,
  contributionId: string,
): boolean {
  // A selected technical advance carries the same admitted contribution into
  // another run; its existing consumption remains proof across that lineage.
  return [...thread.consumptionReceipts.values()].some((receipt) =>
    receipt.evidence.contributionId === contributionId
  );
}
function selectedWait(
  thread: Thread,
  checkpointId = thread.checkpointId,
  namespace = thread.namespace,
): NativeWaitEvidence {
  const receipt = checkpointId &&
    thread.waitReceipts.get(waitKey(namespace, checkpointId));
  if (!receipt) throw new Error("NATIVE_WAIT_EVIDENCE_MISSING");
  const wait = parseNativeWaitEvidence(receipt);
  const node = thread.request.flow.nodes.find((node) =>
    node.id === wait.nodeId
  );
  const scope = thread.request.identity.scope;
  if (
    !node || wait.actionId !== node.nativeId ||
    (wait.kind === "input") !== (node.mechanism === "await_input") &&
      wait.kind !== "technical-advance" ||
    canonical(wait.modelPin) !== canonical(graphPin(thread.request)) ||
    canonical(wait.executionScope) !==
      canonical(scope) ||
    wait.operatorId !== thread.request.identity.operatorId ||
    wait.rootRequestId !==
      (scope.kind === "request" ? scope.rootRequestId : undefined)
  ) throw new Error("NATIVE_WAIT_EVIDENCE_MISMATCH");
  return wait;
}

/** Match the production retainedConversationAdvance decision family. Catalog
 * returns and approved mandate decisions remain separate attested transitions. */
async function retainedConversationAdvanceEvidence(
  source: NativeExecutionRequest,
  current: SystemRuntimeState,
  target: NativeExecutionRequest,
) {
  if (target.contribution.id.startsWith("candidate-decision:")) {
    return await nativeCandidateConversationAdvanceEvidence(
      source.model,
      current,
      target.identity,
      target.contribution,
      source.contribution.inputMessageId ?? source.identity.subjectId,
    );
  }
  const match = /^change-decision:([^:]+):([0-9a-f]{64})$/.exec(
    target.contribution.id,
  );
  const change = match &&
    current.configuration?.changes.find((item) => item.id === match[1]);
  const completing = change && change.status === "pending" &&
    !!change.publishedCommit;
  if (
    !change || !change.requestedBy ||
    change.status !== "approved" && !completing || !change.decidedAt ||
    (change.caseId ?? change.designerScopeId) !==
      target.identity.scope.scopeId ||
    target.contribution.id !==
      `change-decision:${change.id}:${await valueDigest({
        status: change.status,
        decidedAt: change.decidedAt,
        publication: change.publication,
      })}`
  ) {
    throw new Error(
      "The incoming dialogue resume lacks its exact approved change receipt",
    );
  }
  return await nativeMandateAdvanceEvidence(source.model, current, change.id);
}

class SelectedMemorySaver extends MemorySaver {
  constructor(
    readonly underlying: MemorySaver,
    readonly thread: Thread,
    readonly source?: LangGraphRunnableConfig,
    readonly sourceWait?: NativeWaitEvidence,
  ) {
    super();
  }
  private logical(config: LangGraphRunnableConfig): LangGraphRunnableConfig {
    return {
      ...config,
      configurable: {
        ...config.configurable,
        thread_id: this.thread.id,
        checkpoint_ns: "",
      },
    };
  }
  override async getTuple(config: Parameters<MemorySaver["getTuple"]>[0]) {
    const id = config.configurable?.checkpoint_id ?? this.thread.checkpointId;
    if (!id && !this.source) return undefined;
    const physical = this.source ??
      {
        ...config,
        configurable: {
          ...config.configurable,
          checkpoint_ns: this.thread.namespace,
          checkpoint_id: id,
        },
      };
    const tuple = await this.underlying.getTuple(physical);
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
  override async put(
    ...args: [
      ...Parameters<MemorySaver["put"]>,
      Parameters<typeof checkpointConsumptions>[1]?,
    ]
  ) {
    const [config, checkpoint, metadata, versions] = args;
    const waits = new Map(this.thread.waitReceipts);
    const consumptions = new Map(this.thread.consumptionReceipts);
    if (this.source) {
      if (!this.sourceWait) {
        throw new Error("NATIVE_FORK_WAIT_EVIDENCE_MISSING");
      }
      const scope = this.thread.request.identity.scope;
      const { rootRequestId: _sourceRoot, ...wait } = this.sourceWait;
      waits.set(
        waitKey(this.thread.namespace, checkpoint.id),
        parseNativeWaitEvidence({
          ...wait,
          modelPin: graphPin(this.thread.request),
          executionScope: structuredClone(scope),
          operatorId: this.thread.request.identity.operatorId,
          ...(scope.kind === "request"
            ? { rootRequestId: scope.rootRequestId }
            : {}),
        }),
      );
    } else {
      for (
        const evidence of checkpointConsumptions(
          checkpoint,
          versions ?? checkpoint.channel_versions,
        )
      ) {
        if (evidence.contributionId !== this.thread.request.contribution.id) {
          continue;
        }
        const key = consumptionKey(this.thread.runId, evidence.contributionId);
        const existing = consumptions.get(key);
        if (existing) {
          if (canonical(existing.evidence) !== canonical(evidence)) {
            throw new Error("NATIVE_WAIT_CONSUMPTION_CONFLICT");
          }
          continue;
        }
        if (evidence.kind === "wait-v1") {
          if (
            !evidence.sourceCheckpointId ||
            evidence.sourceCheckpointId !==
              config.configurable?.checkpoint_id ||
            !evidence.wait ||
            canonical(
                selectedWait(this.thread, evidence.sourceCheckpointId),
              ) !== canonical(evidence.wait)
          ) {
            throw new Error("NATIVE_WAIT_CONSUMPTION_SOURCE_MISMATCH");
          }
        }
        consumptions.set(key, {
          runId: this.thread.runId,
          checkpointNamespace: this.thread.namespace,
          checkpointId: checkpoint.id,
          evidence: structuredClone(evidence),
        });
      }
    }
    const selected = {
      ...config,
      configurable: {
        ...config.configurable,
        thread_id: this.thread.id,
        checkpoint_ns: this.thread.namespace,
        ...(this.source ? { checkpoint_id: undefined } : {}),
      },
    };
    const saved = await this.underlying.put(selected, checkpoint, metadata);
    this.thread.waitReceipts = waits;
    this.thread.consumptionReceipts = consumptions;
    this.thread.checkpointId = String(saved.configurable!.checkpoint_id);
    return this.logical(saved);
  }
  override async putWrites(...args: Parameters<MemorySaver["putWrites"]>) {
    const [config, writes, taskId] = args;
    const waits = new Map(this.thread.waitReceipts);
    for (const evidence of checkpointInterruptEvidence(writes)) {
      const checkpointId = config.configurable?.checkpoint_id;
      if (typeof checkpointId !== "string" || !checkpointId) {
        throw new Error("NATIVE_WAIT_CHECKPOINT_MISSING");
      }
      const key = waitKey(this.thread.namespace, checkpointId),
        prior = waits.get(key);
      if (prior && canonical(prior) !== canonical(evidence)) {
        throw new Error("NATIVE_WAIT_EVIDENCE_CONFLICT");
      }
      waits.set(key, structuredClone(evidence));
    }
    await this.underlying.putWrites(
      {
        ...config,
        configurable: {
          ...config.configurable,
          checkpoint_ns: this.thread.namespace,
        },
      },
      writes,
      taskId,
      args[3],
    );
    this.thread.waitReceipts = waits;
  }
  override async *list(...args: Parameters<MemorySaver["list"]>) {
    const [config, options] = args;
    const physical = config
      ? {
        ...config,
        configurable: {
          ...config.configurable,
          checkpoint_ns: this.thread.namespace,
        },
      }
      : config;
    for await (const tuple of this.underlying.list(physical, options)) {
      yield {
        ...tuple,
        config: this.logical(tuple.config),
        ...(tuple.parentConfig
          ? { parentConfig: this.logical(tuple.parentConfig) }
          : {}),
      };
    }
  }
}

export interface NativeCaseFixtureModelOptions {
  identity?: Partial<ModelIdentity>;
  admissionAuthority?: "builder" | "human";
  primary?: boolean;
  instruction?: string;
  budgetLimit?: number;
  repositoryVersion?: string;
}

/** One Case/WorkPlan model composition on the original admitted fixture graph
 * and provenance (`artifactModel`), shared by the MemorySaver host and the
 * PostgreSQL fixture host. Host ports remain the hosts' own: memory tests use
 * `createTestNativeExecution`, PostgreSQL tests use `runtimePortsFor`. */
export function nativeCaseFixtureModel(
  id: string,
  options: NativeCaseFixtureModelOptions = {},
): ExecutableModel {
  const model = artifactModel(id);
  if (options.identity) {
    Object.assign(model.identity, structuredClone(options.identity));
    model.version.rootId = model.identity.rootId;
  }
  if (options.admissionAuthority !== undefined) {
    model.configuration.builder.admissionAuthority = options.admissionAuthority;
  }
  if (options.repositoryVersion !== undefined) {
    model.version.repositoryVersion = options.repositoryVersion;
  }
  model.operator = {
    name: id,
    instruction: options.instruction ?? `Mission ${id}`,
    humanInput: true,
    primary: options.primary ?? false,
  };
  if (options.budgetLimit !== undefined) {
    model.workBudgetPolicy = {
      id: `budget-${id}`,
      revision: 1,
      unit: "agent-invocation",
      limit: options.budgetLimit,
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
      elementId: `budget-${id}`,
      sourceIds: [],
    };
  }
  return model;
}

/** The admitted worker-inbox WorkPlan used by the Case/WorkPlan suites. */
export async function nativeWorkPlanFixture(
  id: string,
  callerId: string,
  modelVersion: BehaviorModelVersion,
): Promise<WorkPlanExecution> {
  const input = { text: "Complete the admitted task" };
  return {
    id,
    callerId,
    modelVersion,
    tasks: [{
      id: "task",
      dependsOn: [],
      resourceId: "worker",
      inputDigest: await executionDigest(input),
      invocation: {
        invocationId: workTaskInvocationId(id, "task"),
        callerId,
        modelVersion,
        input,
        behavior: {
          id: "worker-exposure",
          name: "Worker inbox",
          description: "Admitted worker entry",
          callerNativeId: callerId,
          targetNativeId: "worker-inbox",
          targetTypeId: "worker-inbox-type",
          inputTypeId: "work-input",
          inputSchema: { type: "object" },
          sourceIds: ["worker-exposure"],
        },
      },
    }],
  };
}

/** The wrapped store records ONLY revisions actually accepted by the fixture. */
export function createTestNativeExecution(
  source: StorePort,
  workBudget?: Pick<WorkBudgetPort, "readRecord">,
) {
  let effectBoundary:
    | ((boundary: NativeFixtureEffectBoundary) => void)
    | undefined;
  const effectNodes = new Map<string, CompiledFlowNode>();
  const revisions = new Map<number, SystemRuntimeState>();
  const store: StorePort & RuntimeStateHistoryPort = {
    async load() {
      const state = await source.load();
      if (state) revisions.set(state.revision, structuredClone(state));
      return state;
    },
    async save(state, expected) {
      await source.save(state, expected);
      revisions.set(state.revision, structuredClone(state));
    },
    close: () => source.close(),
    loadRevision: (revision) =>
      Promise.resolve(structuredClone(revisions.get(revision) ?? null)),
  };
  const threads = new Map<string, Thread>();
  // PostgreSQL retirement creates a binding with currentRunId=NULL, not a
  // running execution. Only this explicit kind of never-started successor may
  // be absent from execution inspection; ordinary unfinished runs stay visible.
  const unstartedSuccessors = new WeakSet<Thread>();
  function hasNoSuccessorRun(thread: Thread): boolean {
    return unstartedSuccessors.has(thread) && !thread.snapshot &&
      !thread.checkpointId &&
      !thread.contributionRuns.size && !thread.receipts.size &&
      !thread.effects.size &&
      !thread.groupLedger.groups.size && !thread.groupLedger.effects.size &&
      !thread.groupLedger.publications.size &&
      ![...accepted.values()].some((entry) =>
        canonical(entry.delivery.identity) ===
          canonical(thread.request.identity) &&
        entry.receipt.status !== "completed" &&
        entry.receipt.status !== "failed"
      );
  }
  const retiredThreads: Thread[] = [];
  const budgetSourceRuns = new Map<string, Thread>();
  async function scalarBudgetCheckpoint(
    member: BudgetCeilingMember,
  ): Promise<BudgetProposalCheckpoint> {
    const thread = budgetSourceRuns.get(member.id) ??
      [...threads.values()].find((thread) =>
        thread.id === member.threadId && thread.runId === member.runId
      );
    if (
      !thread?.snapshot || thread.checkpointId !== member.checkpointId ||
      thread.namespace !== member.checkpointNamespace ||
      thread.request.contribution.id !== member.contributionId ||
      canonical(thread.request.identity) !== canonical(member.identity)
    ) throw new Error("Test scalar budget source run differs");
    const wait = selectedWait(thread);
    const { scalarBudgetProposal: _proof, ...snapshot } = thread.snapshot;
    if (await executionDigest(snapshot) !== member.snapshotDigest) {
      throw new Error("Test scalar budget source snapshot changed");
    }
    const result = thread.effects.get(member.settledEffectKey);
    const node = thread.request.flow.nodes.find((node) =>
      node.id === wait.nodeId
    );
    return {
      request: thread.request,
      snapshot,
      wait,
      contributionConsumed: hasContributionConsumption(
        thread,
        thread.request.contribution.id,
      ),
      ...(result !== undefined && node
        ? {
          effect: {
            runId: thread.runId,
            contributionId: thread.request.contribution.id,
            nodeId: node.nativeId,
            status: "completed",
            result,
          },
        }
        : {}),
    };
  }
  async function verifyScalarBudgetSources(manifest: BudgetCeilingManifest) {
    await verifyScalarBudgetFamily(manifest, scalarBudgetCheckpoint);
  }
  const admissionTransfers = new Map<string, {
    intent: string;
    source: Thread;
    target: Thread;
    phase: "intent" | "forked" | "selected";
  }>();
  const admissionTransferTails = new Map<string, Promise<unknown>>();
  let admissionTransferBoundary:
    | ((
      phase:
        | "before-fork"
        | "after-fork"
        | "before-selection"
        | "after-selection",
    ) => void)
    | undefined;
  async function verifySelectedBudgetReplay(thread: Thread) {
    if (!thread.selectedBudgetContinuation) return;
    const state = await store.load(),
      transition = state?.budgetCeilingTransition;
    const evidence = thread.selectedBudgetContinuation.evidence;
    if (
      !state || !transition ||
      evidence.kind !== "verified-budget-ceiling-advance" ||
      transition.manifestDigest !== evidence.manifestDigest
    ) throw new Error("Test selected budget intention changed");
    await verifyScalarBudgetCandidate(state);
    await verifyScalarBudgetSources(transition.manifest);
  }
  function session(thread: Thread): NativeExecutionSession {
    return {
      threadId: thread.id,
      runId: thread.runId,
      checkpointNamespace: thread.namespace,
      ...(thread.checkpointId ? { checkpointId: thread.checkpointId } : {}),
      ...(thread.forceResumeWait ? { forceResumeWait: true } : {}),
      ...(thread.selectedBudgetContinuation?.successorRunId === thread.runId &&
          thread.selectedBudgetContinuation.evidence.kind ===
            "verified-budget-ceiling-advance" &&
          canonical(thread.selectedBudgetContinuation.evidence.resume) ===
            canonical(thread.request.contribution)
        ? { selectedBudgetContinuation: thread.selectedBudgetContinuation }
        : {}),
      checkpointer: new SelectedMemorySaver(thread.saver, thread),
      immutableConsultations: memoryImmutableConsultationSession(
        thread,
        revisions,
      ),
      nativeObservations: {
        append: (emission) => {
          if (
            thread.retired ||
            threads.get(canonical(thread.request.identity)) !== thread
          ) return Promise.reject(new Error("Retired test thread"));
          const checked = assertNativeObservationEmission(emission);
          assertNativeObservationBinding(checked, {
            operatorId: thread.request.identity.operatorId,
            ...(thread.request.identity.scope.kind === "request"
              ? {
                rootRequestId: thread.request.identity.scope.rootRequestId,
              }
              : {}),
            modelDigest: thread.request.model.version.digest,
            ...(thread.request.model.version.repositoryVersion
              ? {
                repositoryVersion:
                  thread.request.model.version.repositoryVersion,
              }
              : {}),
            occurrenceIds: new Set(
              thread.request.flow.nodes.map((node) => node.id),
            ),
          });
          const payload = encodeNativeObservation(checked.event),
            pin = executionPin(thread.request),
            identity = canonical(thread.request.identity),
            key = observationKey(thread.runId, thread.namespace, checked),
            existing = thread.nativeObservations.get(key);
          if (existing) {
            if (
              existing.payload !== payload || existing.pin !== pin ||
              existing.identity !== identity ||
              existing.contributionId !== thread.request.contribution.id ||
              existing.record.batchCount !== checked.batchCount ||
              existing.record.batchDigest !== checked.batchDigest
            ) {
              return Promise.reject(
                new Error("NATIVE_OBSERVATION_CONFLICT"),
              );
            }
            return Promise.resolve(structuredClone(existing.record));
          }
          const record: NativeObservationRecord = {
            ...checked,
            firstRecordedAt: new Date().toISOString(),
          };
          thread.nativeObservations.set(key, {
            record,
            runId: thread.runId,
            namespace: thread.namespace,
            payload,
            pin,
            identity,
            contributionId: thread.request.contribution.id,
          });
          return Promise.resolve(structuredClone(record));
        },
        read: () => sortedNativeObservations(thread, thread.runId),
      },
      assertCurrent: () =>
        thread.retired
          ? Promise.reject(new Error("Retired test thread"))
          : Promise.resolve(),
      contributionConsumed: () =>
        Promise.resolve(
          hasContributionConsumption(thread, thread.request.contribution.id),
        ),
      withSelectionFence: async (operation) => {
        if (
          thread.retired ||
          threads.get(canonical(thread.request.identity)) !== thread
        ) throw new Error("Retired test thread");
        await verifySelectedBudgetReplay(thread);
        return await operation();
      },
      async effect(key, node, operation, admit) {
        effectNodes.set(key, structuredClone(node));
        if (thread.groupLedger.effects.has(key)) {
          throw new Error("EFFECT_RECEIPT_MISMATCH");
        }
        if (thread.effects.has(key)) {
          const result = thread.effects.get(key);
          if (result === undefined) {
            throw new Error(
              "Native effect was already started under this invocation",
            );
          }
          return structuredClone(result) as Awaited<
            ReturnType<typeof operation>
          >;
        }
        assertNoMemoryImmutableConsultations(thread);
        if (
          [...thread.effects.values()].some((value) => value === undefined)
        ) {
          throw new Error(
            "Unsettled native effects block new operation dispatch",
          );
        }
        try {
          await admit?.();
        } catch {
          assertNoMemoryImmutableConsultations(thread);
          throw new NativeExecutionAdmissionRefused(
            "NATIVE_ADMISSION_REFUSED",
            node.nativeId,
            "The current native admission refused this action",
          );
        }
        assertNoMemoryImmutableConsultations(thread);
        effectBoundary?.({
          phase: "before-operation",
          key,
          node,
          request: thread.request,
        });
        thread.effects.set(key, undefined);
        const result = await operation();
        effectBoundary?.({
          phase: "after-operation",
          key,
          node,
          request: thread.request,
          result,
        });
        thread.effects.set(key, structuredClone(result));
        effectBoundary?.({
          phase: "after-receipt",
          key,
          node,
          request: thread.request,
          result,
        });
        return result;
      },
      unsettledEffects: () =>
        Promise.resolve(
          [...thread.effects].filter(([, value]) => value === undefined).map((
            [key],
          ) => key),
        ),
      complete(snapshot) {
        assertNoMemoryImmutableConsultations(thread);
        if (
          ["waiting", "completed"].includes(snapshot.status) &&
          !hasContributionConsumption(thread, thread.request.contribution.id)
        ) {
          throw new Error("NATIVE_WAIT_COMPLETION_WITHOUT_CONSUMPTION");
        }
        thread.forceResumeWait = false;
        thread.snapshot = structuredClone(snapshot);
        thread.receipts.set(thread.request.contribution.id, {
          digest: canonical(thread.request.contribution),
          snapshot: structuredClone(snapshot),
        });
        return Promise.resolve();
      },
      fail(error) {
        if (
          error instanceof NativeExecutionAdmissionRefused &&
          !pendingMemoryImmutableConsultations(thread).length
        ) {
          thread.snapshot = {
            contributionId: thread.request.contribution.id,
            identity: thread.request.identity,
            threadId: thread.id,
            modelDigest: thread.request.model.version.digest,
            repositoryVersion: thread.request.model.version.repositoryVersion,
            flowRootId: thread.request.flow.rootNativeId,
            status: "refused",
            checkpointId: thread.checkpointId,
            refusal: {
              code: error.code,
              nodeId: error.nodeId,
              message: error.message,
            },
            waits: [],
            unsettledEffects: [],
            pendingContributions: [],
          };
        } else {
          const unsettledEffects = [...thread.effects]
            .filter(([, value]) => value === undefined).map(([key]) => key);
          thread.snapshot = {
            contributionId: thread.request.contribution.id,
            identity: structuredClone(thread.request.identity),
            threadId: thread.id,
            modelDigest: thread.request.model.version.digest,
            repositoryVersion: thread.request.model.version.repositoryVersion,
            flowRootId: thread.request.flow.rootNativeId,
            status: unsettledEffects.length ? "uncertain" : "failed",
            checkpointId: thread.checkpointId,
            waits: [],
            unsettledEffects,
            pendingContributions: [],
          };
        }
        return Promise.resolve();
      },
      async advance(input, fork) {
        assertNoMemoryImmutableConsultations(thread);
        // A mandate advance resumes an unconsumed input wait (no settled
        // effect); a catalog advance continues a settled prepared result.
        const mandate = input.evidence.kind === "verified-mandate-advance";
        // A team advance continues its settled proposal effect, like a
        // catalog advance, but binds the flows only, like a mandate.
        const flowsOnly = mandate ||
          input.evidence.kind === "verified-team-advance";
        const sourceNode = thread.request.flow.nodes.find((node) =>
          nativeFrameworkNodeName(node.id, "await-preparation") ===
            input.source.preparedNodeId
        );
        const unconsumedInput = input.mode === "retained-wait" &&
          thread.request.identity.purpose === "conversation" &&
          sourceNode?.mechanism === "await_input";
        const sourceContract = flowsOnly
          ? await nativeFlowContractDigest(thread.request.model)
          : input.evidence.kind === "verified-budget-ceiling-advance"
          ? await budgetCeilingContractDigest(thread.request.model)
          : await nativeUnchangedContractDigest(thread.request.model);
        const targetContract = flowsOnly
          ? await nativeFlowContractDigest(input.target.model)
          : input.evidence.kind === "verified-budget-ceiling-advance"
          ? await budgetCeilingContractDigest(input.target.model)
          : await nativeUnchangedContractDigest(input.target.model);
        const expectedContract =
          input.evidence.kind === "verified-mandate-advance" ||
            input.evidence.kind === "verified-team-advance"
            ? input.evidence.flowContractDigest
            : input.evidence.unchangedContractDigest;
        if (
          !thread.checkpointId ||
          !sourceNode || input.source.threadId !== thread.id ||
          input.source.checkpointNamespace !== thread.namespace ||
          input.source.checkpointId !== thread.checkpointId ||
          canonical(input.target.identity) !==
            canonical(thread.request.identity) ||
          input.target.flow.rootNativeId !== thread.request.flow.rootNativeId ||
          input.target.flow.rootOccurrenceId !==
            thread.request.flow.rootOccurrenceId ||
          input.target.maxSteps !== thread.request.maxSteps ||
          thread.effects.has(input.source.settledEffectKey) ===
            (mandate || unconsumedInput) ||
          // Mandates are re-proved below from the immutable accepted business
          // revision. Reviewer publication may change future promotion only;
          // the complete target flow digest must still match that proof.
          !mandate && sourceContract !== expectedContract ||
          targetContract !== expectedContract
        ) {
          throw new Error(
            mandate
              ? "Invalid test mandate advance evidence"
              : "Invalid test catalog advance evidence",
          );
        }
        if (mandate) {
          const accepted = await store.loadRevision(
            input.evidence.businessRevision.__assemblyRuntimeRevision.revision,
          );
          const current = await store.load();
          const verified = accepted &&
            await retainedConversationAdvanceEvidence(
              thread.request,
              accepted,
              input.target,
            );
          const currentProof = current &&
            await retainedConversationAdvanceEvidence(
              thread.request,
              current,
              input.target,
            );
          const wait = selectedWait(thread);
          if (
            !unconsumedInput || !verified || !currentProof ||
            canonical(verified) !== canonical(input.evidence) ||
            canonical(currentProof) !== canonical(input.evidence) ||
            canonical(current?.executionModel?.identity) !==
              canonical(input.target.model.identity) ||
            canonical(current?.executionModel?.version) !==
              canonical(input.target.model.version) ||
            thread.snapshot?.status !== "waiting" ||
            thread.snapshot.waits.length !== 1 ||
            thread.snapshot.waits[0].kind !== "input" ||
            thread.snapshot.waits[0].nodeId !== sourceNode.id ||
            wait.nodeId !== sourceNode.id ||
            wait.effectKey !== input.source.settledEffectKey ||
            wait.kind !== "input" ||
            [...thread.effects.values()].some((value) => value === undefined)
          ) {
            throw new Error(
              "Invalid test mandate continuation receipt or prepared input wait",
            );
          }
        }
        if (input.evidence.kind === "verified-team-advance") {
          const accepted = await store.loadRevision(
            input.evidence.businessRevision.__assemblyRuntimeRevision.revision,
          );
          const verified = accepted &&
            await nativeTeamAdvanceEvidence(
              thread.request.model,
              accepted,
              input.evidence.changeId,
              thread.request.identity.scope,
            );
          if (
            input.mode === "retained-wait" ||
            !verified || canonical(verified) !== canonical(input.evidence)
          ) {
            throw new Error("Invalid test team advance evidence");
          }
        }
        if (input.evidence.kind === "verified-budget-ceiling-advance") {
          const state = await store.load();
          const historical = await store.loadRevision(
            input.evidence.businessRevision.__assemblyRuntimeRevision.revision,
          );
          const budget = state &&
            await workBudget?.readRecord?.(
              input.evidence.budget.scopeId,
              input.evidence.budget.ownerId,
            );
          if (
            !state || !historical || !budget || input.mode !== "retained-wait"
          ) throw new Error("Test budget proof unavailable");
          await verifyScalarBudgetSources(
            state.budgetCeilingTransition!.manifest,
          );
          await validateNativeBudgetCeilingAdvance(
            input.evidence,
            historical,
            budget,
            input.target.identity,
            input.target.contribution,
          );
          const currentEvidence = await nativeBudgetCeilingAdvanceEvidence(
            state,
            budget,
            input.evidence.memberId,
            input.target.contribution,
          );
          const { businessRevision: _oldRevision, ...oldProof } =
            input.evidence;
          const { businessRevision: _currentRevision, ...currentProof } =
            currentEvidence;
          if (canonical(oldProof) !== canonical(currentProof)) {
            throw new Error("Test current budget proof differs");
          }
        }
        if (
          unconsumedInput && !mandate &&
          input.evidence.kind !== "verified-budget-ceiling-advance"
        ) {
          const accepted = await store.loadRevision(
            input.target.businessRevision.__assemblyRuntimeRevision.revision,
          );
          const verified = accepted &&
            await nativeCandidateConversationAdvanceEvidence(
              thread.request.model,
              accepted,
              input.target.identity,
              input.target.contribution,
              thread.request.contribution.inputMessageId ??
                thread.request.identity.subjectId,
            );
          if (!verified || canonical(verified) !== canonical(input.evidence)) {
            throw new Error("Invalid test catalog conversation input receipt");
          }
        }
        if (input.evidence.kind === "verified-budget-ceiling-advance") {
          budgetSourceRuns.set(`${thread.id}:${thread.runId}`, thread);
        }
        const oldRunId = thread.runId;
        const next: Thread = {
          ...thread,
          request: input.target,
          runId: crypto.randomUUID(),
          namespace: `test:${crypto.randomUUID()}`,
          checkpointId: undefined,
          snapshot: undefined,
          selectedBudgetContinuation: undefined,
          forceResumeWait: input.mode === "retained-wait",
          contributionRuns: new Map(thread.contributionRuns),
          waitReceipts: new Map(thread.waitReceipts),
          consumptionReceipts: new Map(thread.consumptionReceipts),
          nativeObservations: new Map(thread.nativeObservations),
        };
        next.contributionRuns.set(input.target.contribution.id, {
          digest: canonical(input.target.contribution),
          runId: next.runId,
        });
        const config = await fork(
          new SelectedMemorySaver(thread.saver, next, {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: thread.namespace,
              checkpoint_id: thread.checkpointId,
            },
          }, selectedWait(thread)),
          {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: "",
              checkpoint_id: thread.checkpointId,
            },
          },
        );
        next.checkpointId = String(config.configurable!.checkpoint_id);
        const sourceTuple = await thread.saver.getTuple({
          configurable: {
            thread_id: thread.id,
            checkpoint_ns: thread.namespace,
            checkpoint_id: thread.checkpointId,
          },
        });
        const targetTuple = await next.saver.getTuple({
          configurable: {
            thread_id: next.id,
            checkpoint_ns: next.namespace,
            checkpoint_id: next.checkpointId,
          },
        });
        if (!sourceTuple || !targetTuple) {
          throw new Error("Test continuation official fork is unavailable");
        }
        verifyOfficialFork(sourceTuple, targetTuple, {
          modelPin: graphPin(next.request),
          continuationRef: `${thread.id}:${thread.checkpointId}`,
        });
        const receipt: NativeContinuationReceipt = {
          id: crypto.randomUUID(),
          predecessorRunId: oldRunId,
          source: input.source,
          evidence: input.evidence,
          successorRunId: next.runId,
        };
        if (receipt.evidence.kind === "verified-budget-ceiling-advance") {
          next.selectedBudgetContinuation = receipt;
        }
        if (input.evidence.kind === "verified-budget-ceiling-advance") {
          const current = await store.load();
          if (!current?.budgetCeilingTransition) {
            throw new Error(
              "Test budget intention unavailable before selection",
            );
          }
          await verifyScalarBudgetSources(
            current.budgetCeilingTransition.manifest,
          );
        }
        threads.set(canonical(next.request.identity), next);
        return { receipt, session: session(next) };
      },
    };
  }
  const claims = new AsyncLocalStorage<OperatorExecutionDelivery>();
  const ledger: NativeExecutionLedger = {
    async transferInitialAdmission(request, fork) {
      const intent = request.initialAdmissionTransfer;
      if (!intent) throw new InitialAdmissionTransferRefused("missing-intent");
      const prior = admissionTransferTails.get(intent.key) ?? Promise.resolve();
      const pending = prior.catch(() => {}).then(async () => {
        const historical = await store.loadRevision(intent.sourceRevision);
        const current = await store.load();
        if (!historical || !current) {
          throw new InitialAdmissionTransferRefused("missing-history");
        }
        const retained = admissionTransfers.get(intent.key);
        if (retained?.phase === "selected") {
          const acceptedTarget = await store.loadRevision(
            retained.target.request.businessRevision.__assemblyRuntimeRevision
              .revision,
          );
          if (!acceptedTarget) {
            throw new InitialAdmissionTransferRefused("missing-target-history");
          }
          await verifySelectedInitialAdmissionTransfer(
            retained.target.request,
            historical,
            acceptedTarget,
            current,
          );
          if (
            canonical(request.identity) !== canonical(intent.target.identity) ||
            canonical(request.contribution) !== canonical(intent.contribution)
          ) {
            throw new InitialAdmissionTransferRefused("selected-request");
          }
        } else {
          await verifyInitialAdmissionTransfer(request, historical, current);
        }
        const source = [...threads.values()].find((thread) =>
          thread.id === intent.source.threadId
        );
        if (!source?.snapshot) {
          throw new InitialAdmissionTransferRefused("missing-source-thread");
        }
        const digest = canonical(intent);
        let transfer = admissionTransfers.get(intent.key);
        if (transfer && transfer.intent !== digest) {
          throw new InitialAdmissionTransferRefused("intent-conflict");
        }
        if (!transfer) {
          await verifyInitialAdmissionSourceSnapshot(intent, source.snapshot);
          assertNoMemoryImmutableConsultations(source);
          const wait = selectedWait(source, intent.source.checkpointId);
          const result = source.effects.get(intent.source.settledEffectKey);
          if (
            source.retired || source.runId !== intent.source.runId ||
            source.checkpointId !== intent.source.checkpointId ||
            wait.nodeId !== intent.source.occurrenceId ||
            wait.effectKey !== intent.source.settledEffectKey ||
            wait.kind !== "decision" ||
            !source.effects.has(intent.source.settledEffectKey) ||
            result === undefined ||
            wait.resultDigest !== await effectResultDigest(result) ||
            [...source.effects.values()].some((value) => value === undefined) ||
            threads.has(canonical(request.identity))
          ) {
            throw new InitialAdmissionTransferRefused(
              "unsafe-source-or-target",
            );
          }
          const target: Thread = {
            id: crypto.randomUUID(),
            request: structuredClone(request),
            runId: crypto.randomUUID(),
            namespace: `test:${crypto.randomUUID()}`,
            saver: source.saver,
            receipts: new Map(),
            effects: new Map(),
            waitReceipts: new Map(),
            consumptionReceipts: new Map(),
            contributionRuns: new Map(),
            groupLedger: memoryImmutableConsultationState(),
            nativeObservations: new Map(),
            forceResumeWait: true,
          };
          target.contributionRuns.set(request.contribution.id, {
            digest: canonical(request.contribution),
            runId: target.runId,
          });
          transfer = { intent: digest, source, target, phase: "intent" };
          admissionTransfers.set(intent.key, transfer);
        }
        const target = transfer.target;
        if (transfer.phase === "selected") {
          if (
            threads.get(canonical(request.identity)) !== target ||
            !source.retired
          ) throw new InitialAdmissionTransferRefused("selection-conflict");
          const accepted = target.receipts.get(request.contribution.id);
          return accepted
            ? {
              ...session(target),
              alreadyCompleted: structuredClone(accepted.snapshot),
            }
            : {
              ...session(target),
              resumeRequest: structuredClone(target.request),
            };
        }
        if (!target.checkpointId) {
          admissionTransferBoundary?.("before-fork");
          await fork(
            new SelectedMemorySaver(source.saver, target, {
              configurable: {
                thread_id: source.id,
                checkpoint_ns: source.namespace,
                checkpoint_id: intent.source.checkpointId,
              },
            }, selectedWait(source, intent.source.checkpointId)),
            {
              configurable: {
                thread_id: target.id,
                checkpoint_ns: "",
                checkpoint_id: intent.source.checkpointId,
              },
            },
          );
          transfer.phase = "forked";
          admissionTransferBoundary?.("after-fork");
        }
        const original = await source.saver.getTuple({
          configurable: {
            thread_id: source.id,
            checkpoint_ns: source.namespace,
            checkpoint_id: intent.source.checkpointId,
          },
        });
        const tuple = await target.saver.getTuple({
          configurable: {
            thread_id: target.id,
            checkpoint_ns: target.namespace,
            checkpoint_id: target.checkpointId,
          },
        });
        if (!tuple || !original) {
          throw new InitialAdmissionTransferRefused("fork-identity");
        }
        verifyOfficialFork(original, tuple, {
          executionScope: request.identity.scope,
          rootRequestId: intent.target.caseId,
          continuationRef: intent.key,
        });
        const now = await store.load();
        if (!now) {
          throw new InitialAdmissionTransferRefused("missing-current-state");
        }
        await verifyInitialAdmissionTransfer(request, historical, now);
        await verifyInitialAdmissionSourceSnapshot(intent, source.snapshot);
        assertNoMemoryImmutableConsultations(source);
        admissionTransferBoundary?.("before-selection");
        if (threads.has(canonical(request.identity))) {
          throw new InitialAdmissionTransferRefused("target-already-selected");
        }
        threads.set(canonical(request.identity), target);
        source.retired = true;
        transfer.phase = "selected";
        admissionTransferBoundary?.("after-selection");
        return session(target);
      });
      admissionTransferTails.set(intent.key, pending);
      return await pending;
    },
    async open(request) {
      const claim = claims.getStore();
      if (
        request.networkAdoptionContinuation ||
        request.networkRefusalContinuation ||
        request.contribution.networkAdoptionContinuation ||
        request.contribution.networkRefusalContinuation ||
        claim?.id.startsWith("network-adoption:") ||
        claim?.id.startsWith("network-refusal:")
      ) {
        // This fixture has no Request source-admission chain or adoption
        // receipt store. Its ordinary resume contract cannot attest those paths.
        throw new Error(
          "Test network continuation requires durable Request source-admission evidence",
        );
      }
      if (
        claim && (claim.identity.operatorId !== request.identity.operatorId ||
          canonical(claim.identity.scope) !== canonical(request.identity.scope))
      ) {
        throw new Error("Execution claim scope mismatch");
      }
      const key = canonical(request.identity);
      let thread = threads.get(key);
      if (!thread) {
        thread = {
          id: crypto.randomUUID(),
          request: structuredClone(request),
          runId: crypto.randomUUID(),
          namespace: `test:${crypto.randomUUID()}`,
          saver: new MemorySaver(),
          receipts: new Map(),
          effects: new Map(),
          waitReceipts: new Map(),
          consumptionReceipts: new Map(),
          contributionRuns: new Map(),
          groupLedger: memoryImmutableConsultationState(),
          nativeObservations: new Map(),
        };
        threads.set(key, thread);
      }
      const accepted = thread.receipts.get(request.contribution.id);
      if (accepted) {
        if (accepted.digest !== canonical(request.contribution)) {
          throw new Error("Test contribution conflict");
        }
        return Promise.resolve({
          ...session(thread),
          alreadyCompleted: structuredClone(accepted.snapshot),
        });
      }
      if (thread.snapshot?.localState?.changeApprovalWait) {
        throw new Error(
          "A Request approval wait requires its exact recorded decision",
        );
      }
      if (
        executionPin(thread.request) !== executionPin(request)
      ) {
        assertNoMemoryImmutableConsultations(thread);
        const snapshot = thread.snapshot;
        const current = await store.loadRevision(
          request.businessRevision.__assemblyRuntimeRevision.revision,
        );
        if (
          !current ||
          canonical(current.executionModel) !== canonical(request.model) ||
          request.contribution.kind !== "resume" ||
          snapshot?.status !== "waiting" ||
          !thread.checkpointId || snapshot.unsettledEffects.length ||
          snapshot.waits.length !== 1 ||
          [...thread.effects.values()].some((value) => value === undefined)
        ) {
          throw new Error("Test pin transition requires an exact receipt");
        }
        if (
          current.budgetCeilingTransition?.phase ===
            "adopted-continuations-pending"
        ) {
          const budget = await workBudget?.readRecord?.(
            current.budgetCeilingTransition.manifest.budget.scopeId,
            current.budgetCeilingTransition.manifest.budget.ownerId,
          );
          const memberId = `${thread.id}:${thread.runId}`;
          const member = current.budgetCeilingTransition.manifest.members.find(
            (item) => item.id === memberId,
          );
          const wait = selectedWait(thread);
          const projected = budgetSourceFromWait(wait);
          const storedEffect = thread.effects.get(
            member?.settledEffectKey ?? "",
          );
          if (
            !budget || !member || !projected ||
            canonical(projected) !== canonical({
                sourceKind: member.sourceKind,
                occurrenceId: member.occurrenceId,
                preparedNodeId: member.preparedNodeId,
                settledEffectKey: member.settledEffectKey,
              }) ||
            member.snapshotDigest !== await executionDigest(snapshot) ||
            member.checkpointId !== thread.checkpointId ||
            member.checkpointNamespace !== thread.namespace ||
            canonical(member.identity) !== canonical(request.identity) ||
            member.contributionId !== thread.request.contribution.id ||
            (member.sourceKind === "unconsumed-input-wait"
              ? thread.effects.has(member.settledEffectKey)
              : storedEffect === undefined ||
                await effectResultDigest(storedEffect) !== wait.resultDigest)
          ) {
            throw new Error(
              "Test budget continuation differs from its saved checkpoint and receipt",
            );
          }
          await verifyScalarBudgetSources(
            current.budgetCeilingTransition.manifest,
          );
          const evidence = await nativeBudgetCeilingAdvanceEvidence(
            current,
            budget,
            memberId,
            request.contribution,
          );
          await validateNativeBudgetCeilingAdvance(
            evidence,
            current,
            budget,
            request.identity,
            request.contribution,
          );
          return {
            ...session(thread),
            resumeRequest: structuredClone(thread.request),
            beforeInputAdvance: {
              source: {
                threadId: thread.id,
                checkpointNamespace: thread.namespace,
                checkpointId: thread.checkpointId,
                preparedNodeId: member.preparedNodeId,
                settledEffectKey: member.settledEffectKey,
              },
              evidence,
              target: request,
              mode: "retained-wait" as const,
            },
          };
        }
        const conversation = request.identity.purpose === "conversation";
        const evidence = conversation
          ? await retainedConversationAdvanceEvidence(
            thread.request,
            current,
            request,
          )
          : await nativeCatalogAdvanceEvidence(thread.request.model, current);
        if (
          !evidence ||
          canonical(evidence.to) !==
            canonical({
              identity: request.model.identity,
              version: request.model.version,
            })
        ) {
          throw new Error(
            "Test pin transition requires an exact publication receipt",
          );
        }
        if (conversation) {
          if (
            snapshot.waits[0].kind !== "input" ||
            snapshot.waits[0].mechanism !== "await_input"
          ) {
            throw new Error(
              "Test catalog return requires its settled input wait",
            );
          }
        } else {
          if (evidence.kind !== "verified-catalog-advance") {
            throw new Error(
              "Test promotion requires catalog advance evidence",
            );
          }
          const candidate = current.candidates.find((candidate) =>
            candidate.promotionExecution?.subjectId ===
              request.identity.subjectId &&
            candidate.promotionExecution?.threadId === thread!.id
          );
          if (
            snapshot.waits[0].kind !== "decision" ||
            !candidate?.admissionDecision ||
            request.contribution.id !==
              `candidate-decision:${candidate.id}:${await valueDigest(
                candidate.admissionDecision,
              )}` ||
            candidate.id === evidence.candidateId ||
            !candidate.preparationEvidence ||
            !candidate.catalogRefreshes?.some((refresh) =>
              refresh.publishedCandidateId === evidence.candidateId &&
              refresh.modelDigest === thread!.request.model.version.digest &&
              refresh.testsDigest ===
                candidate.preparationEvidence!.testsDigest &&
              refresh.contractDigest ===
                candidate.preparationEvidence!.contractDigest &&
              refresh.toCatalogRevision === candidate.baseCatalogRevision
            )
          ) {
            throw new Error(
              "Test promotion requires its exact sibling publication refresh receipt",
            );
          }
        }
        const wait = selectedWait(thread);
        const node = thread.request.flow.nodes.find((node) =>
          node.id === wait.nodeId
        );
        if (
          !node || wait.kind === "technical-advance" ||
          snapshot.waits[0].nodeId !== node.id ||
          (conversation
            ? node.mechanism !== "await_input" ||
              wait.kind !== "input" ||
              thread.effects.has(wait.effectKey)
            : wait.kind !== "decision" ||
              !thread.effects.has(wait.effectKey))
        ) {
          throw new Error(
            "Test retained wait lost its exact prepared source checkpoint",
          );
        }
        return {
          ...session(thread),
          resumeRequest: structuredClone(thread.request),
          beforeInputAdvance: {
            source: {
              threadId: thread.id,
              checkpointNamespace: thread.namespace,
              checkpointId: thread.checkpointId,
              preparedNodeId: nativeFrameworkNodeName(
                node.id,
                "await-preparation",
              ),
              settledEffectKey: wait.effectKey,
            },
            evidence,
            target: request,
            mode: "retained-wait" as const,
          },
        };
      }
      // PostgreSQL reselects the accepted contribution's run on retry. The
      // logical run is part of effect keys, so a retry cannot mint a new one.
      const previous = thread.contributionRuns.get(request.contribution.id);
      if (!previous) assertNoMemoryImmutableConsultations(thread);
      const digest = canonical(request.contribution);
      if (previous && previous.digest !== digest) {
        throw new Error("Test contribution conflict");
      }
      if (
        !previous &&
        [...thread.effects.values()].some((value) => value === undefined)
      ) {
        throw new Error(
          "Unsettled native effects block new operation dispatch",
        );
      }
      thread.runId = previous?.runId ?? crypto.randomUUID();
      thread.contributionRuns.set(request.contribution.id, {
        digest,
        runId: thread.runId,
        ...(previous?.origin
          ? { origin: previous.origin }
          : claim
          ? { origin: canonical(claim) }
          : {}),
        pin: previous?.pin ?? executionPin(request),
        identity: previous?.identity ?? canonical(request.identity),
      });
      thread.request = structuredClone(request);
      thread.snapshot = undefined;
      // All admission/pin checks above succeeded and the contribution's real
      // run was enrolled. Failed opens must preserve the empty binding marker.
      unstartedSuccessors.delete(thread);
      return Promise.resolve(session(thread));
    },
    async ownsCandidateRecoveryContribution({ snapshot, acceptedDigest }) {
      const claim = claims.getStore();
      const accepted = claim && parseAcceptedCommand(claim);
      if (
        !claim || !accepted ||
        accepted.command.kind !== "resume-candidate-continuation" ||
        await executionDigest(accepted) !== acceptedDigest ||
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
      const thread = threads.get(canonical(snapshot.identity));
      const receipt = thread?.contributionRuns.get(snapshot.contributionId);
      if (
        !thread || thread.retired || thread.id !== snapshot.threadId ||
        snapshot.runId && snapshot.runId !== thread.runId ||
        snapshot.checkpointId !== thread.checkpointId || !receipt ||
        receipt.runId !== thread.runId || receipt.origin !== canonical(claim) ||
        receipt.identity !== canonical(snapshot.identity) ||
        receipt.digest !==
          canonical({ id: snapshot.contributionId, kind: "resume" })
      ) return false;
      const pin = receipt.pin && JSON.parse(receipt.pin);
      return pin?.version?.digest === accepted.modelPin.modelDigest &&
        pin?.version?.repositoryVersion === accepted.modelPin.repositoryVersion;
    },
    async inspect(operatorId) {
      return await Promise.all(
        [...threads.values()].filter((thread) =>
          !thread.retired && !hasNoSuccessorRun(thread) &&
          thread.request.identity.operatorId === operatorId
        )
          .map(async (thread) => {
            let scalarBudgetProposal:
              NativeExecutionSnapshot["scalarBudgetProposal"];
            const snapshot = thread.snapshot;
            if (
              snapshot?.status === "waiting" && snapshot.waits.length === 1 &&
              snapshot.waits[0].mechanism === "submit_proposal" &&
              snapshot.waits[0].kind === "budget"
            ) {
              const member: BudgetCeilingMember = {
                id: `${thread.id}:${thread.runId}`,
                identity: thread.request.identity,
                contributionId: thread.request.contribution.id,
                threadId: thread.id,
                runId: thread.runId,
                checkpointNamespace: thread.namespace,
                checkpointId: thread.checkpointId!,
                ...snapshot.budgetContinuationSource!,
                snapshotDigest: await executionDigest(snapshot),
              };
              scalarBudgetProposal = await nativeScalarBudgetProposal(
                await scalarBudgetCheckpoint(member),
              );
            }
            const base: NativeExecutionSnapshot = snapshot ?? {
              contributionId: thread.request.contribution.id,
              identity: thread.request.identity,
              threadId: thread.id,
              modelDigest: thread.request.model.version.digest,
              repositoryVersion: thread.request.model.version.repositoryVersion,
              flowRootId: thread.request.flow.rootNativeId,
              status: "running",
              waits: [],
              unsettledEffects: [],
              pendingContributions: [],
            };
            const { scalarBudgetProposal: _oldProof, ...saved } = base;
            return structuredClone(
              {
                ...saved,
                ...(scalarBudgetProposal ? { scalarBudgetProposal } : {}),
                ...(pendingMemoryImmutableConsultations(thread).length
                  ? {
                    openImmutableConsultationGroups:
                      pendingMemoryImmutableConsultations(thread).map((group) =>
                        group.groupId
                      ),
                  }
                  : {}),
              },
            );
          }),
      );
    },
    async readNativeObservations(operatorId, threadId, runId) {
      const thread = [...threads.values(), ...retiredThreads].find((
        candidate,
      ) =>
        candidate.id === threadId &&
          candidate.request.identity.operatorId === operatorId &&
          [...candidate.nativeObservations.values()].some((entry) =>
            entry.runId === runId
          ) ||
        candidate.id === threadId &&
          candidate.request.identity.operatorId === operatorId &&
          candidate.runId === runId
      );
      if (!thread) throw new Error("NATIVE_OBSERVATION_RUN_MISSING");
      return await sortedNativeObservations(thread, runId);
    },
    async closeScope(snapshot, closure) {
      const thread = threads.get(canonical(snapshot.identity));
      const state = await store.loadRevision(
        closure.businessRevision.__assemblyRuntimeRevision.revision,
      );
      if (
        !thread ||
        !state?.cases?.some((record) =>
          record.id === closure.caseId && record.status === closure.status &&
          record.closedAt === closure.closedAt
        )
      ) throw new Error("Invalid test closure receipt");
      assertNoMemoryImmutableConsultations(thread);
      if (thread.snapshot) thread.snapshot.status = "completed";
    },
    retireAndAdvance(snapshot, authorization, target) {
      const key = canonical(snapshot.identity), old = threads.get(key);
      if (
        !old || old.checkpointId !== snapshot.checkpointId ||
        snapshot.runId && snapshot.runId !== old.runId ||
        snapshot.checkpointNamespace !== undefined &&
          snapshot.checkpointNamespace !== old.namespace ||
        snapshot.waits.length !== 1 ||
        snapshot.waits.some((wait) => wait.kind !== "input")
      ) throw new Error("Invalid test retirement");
      if (
        authorization.kind === "owner-adoption" && authorization.network ||
        snapshot.localState?.changeApprovalWait
      ) {
        throw new Error(
          "Test network retirement requires durable Request source-admission evidence",
        );
      }
      const wait = selectedWait(old);
      if (
        wait.kind !== "input" || wait.nodeId !== snapshot.waits[0].nodeId ||
        old.effects.has(wait.effectKey) ||
        !hasContributionConsumption(old, snapshot.contributionId)
      ) throw new Error("Invalid test retirement wait evidence");
      assertNoMemoryImmutableConsultations(old);
      old.retired = true;
      retiredThreads.push(old);
      const successor: Thread = {
        id: crypto.randomUUID(),
        request: {
          ...old.request,
          model: structuredClone(target),
          flow: snapshot.identity.purpose === "promotion"
            ? target.flows.promotion
            : target.flows.conversation,
        },
        runId: crypto.randomUUID(),
        namespace: `test:${crypto.randomUUID()}`,
        saver: new MemorySaver(),
        receipts: new Map(),
        effects: new Map(),
        waitReceipts: new Map(),
        consumptionReceipts: new Map(),
        contributionRuns: new Map(),
        groupLedger: memoryImmutableConsultationState(),
        nativeObservations: new Map(),
      };
      unstartedSuccessors.add(successor);
      threads.set(key, successor);
      return Promise.resolve();
    },
  };
  const execution = new NativeGraphExecution(new InMemoryStore(), ledger);
  const handlers = new Map<
    string,
    (delivery: OperatorExecutionDelivery) => Promise<void>
  >();
  const tails = new Map<string, Promise<void>>();
  const accepted = new Map<
    string,
    {
      digest: string;
      receipt: OperatorDeliveryReceipt;
      delivery: OperatorExecutionDelivery;
    }
  >();
  // Worker failures are reported exactly once, by the first idle() that
  // observes them; a settled failure must not poison every later drain.
  const failures: unknown[] = [];
  const dispatch: OperatorExecutionDispatchPort = {
    enqueue(delivery) {
      const key = canonical([delivery.identity, delivery.id]),
        previous = accepted.get(key);
      if (previous) {
        if (previous.digest !== canonical(delivery)) {
          throw new Error("Test delivery conflict");
        }
        return Promise.resolve(previous.receipt);
      }
      const receipt: OperatorDeliveryReceipt = {
        id: delivery.id,
        threadId: key,
        jobId: crypto.randomUUID(),
        status: "queued",
      };
      accepted.set(key, {
        digest: canonical(delivery),
        receipt,
        delivery: structuredClone(delivery),
      });
      const old = tails.get(delivery.identity.operatorId) ?? Promise.resolve();
      const pending = old.catch(() => {}).then(async () => {
        const handler = handlers.get(delivery.identity.operatorId);
        if (!handler) {
          throw new Error("Test worker entry must be explicitly bound");
        }
        receipt.status = "running";
        await claims.run(
          structuredClone(delivery),
          () => handler(structuredClone(delivery)),
        );
        receipt.status = "completed";
      });
      tails.set(
        delivery.identity.operatorId,
        pending.catch((error) => {
          receipt.status = "failed";
          failures.push(error);
        }),
      );
      return Promise.resolve(receipt);
    },
    inspect(identity, id) {
      return Promise.resolve(
        accepted.get(canonical([identity, id]))?.receipt ?? null,
      );
    },
    inspectAccepted(operatorId, id) {
      // Exact accepted-DTO lookup for command replay, mirroring the
      // production PostgresOperatorDispatch.inspectAccepted contract: null
      // when absent, ambiguity refusal, and corruption refusal.
      const matches = [...accepted.values()].filter((entry) =>
        entry.delivery.identity.operatorId === operatorId &&
        entry.delivery.id === id
      );
      if (!matches.length) return Promise.resolve(null);
      if (matches.length !== 1) {
        throw new Error("Accepted operator delivery ID is ambiguous");
      }
      const record = matches[0];
      if (canonical(record.delivery) !== record.digest) {
        throw new Error("Accepted operator delivery receipt is corrupt");
      }
      return Promise.resolve({
        receipt: structuredClone(record.receipt),
        delivery: structuredClone(record.delivery),
      });
    },
    async inspectTerminalAccepted(operatorId, id) {
      const item = await dispatch.inspectAccepted!(operatorId, id);
      if (!item) return null;
      // Unknown native effects are never evidence for replacing this delivery.
      if (
        [...threads.values()].some((thread) =>
          thread.request.identity.operatorId === operatorId &&
          canonical(thread.request.identity.scope) ===
            canonical(item.delivery.identity.scope) &&
          [...thread.effects.values()].some((value) => value === undefined)
        )
      ) return null;
      // This memory worker has no retry queue: its failed/completed states are terminal.
      const terminal = item.receipt.status === "completed"
        ? "completed"
        : item.receipt.status === "failed"
        ? "failed"
        : undefined;
      return terminal ? { ...item, terminal } : null;
    },
  };
  async function idle() {
    let prior: Promise<void>[];
    do {
      prior = [...tails.values()];
      await Promise.all(prior);
    } while (
      prior.length !== tails.size ||
      prior.some((value, index) => value !== [...tails.values()][index])
    );
    if (failures.length) {
      const observed = failures.splice(0, failures.length);
      throw observed.length === 1
        ? observed[0]
        : new AggregateError(observed, "Test worker deliveries failed");
    }
  }
  return {
    execution,
    dispatch,
    store,
    stateHistory: store,
    artifactSources: createMemoryArtifactSources(),
    /** Explicit test diagnostics over the actual saver/ledger, never a business cursor. */
    async checkpoints() {
      return await Promise.all(
        [...threads.values()].filter((thread) => !hasNoSuccessorRun(thread))
          .map(async (thread) => {
            const tuple = await thread.saver.getTuple({
              configurable: {
                thread_id: thread.id,
                checkpoint_ns: thread.namespace,
                checkpoint_id: thread.checkpointId,
              },
            });
            const values = structuredClone(
              tuple?.checkpoint.channel_values ?? {},
            ) as Partial<NativeState>;
            const history: Partial<NativeState>[] = [];
            for await (
              const saved of thread.saver.list({
                configurable: {
                  thread_id: thread.id,
                  checkpoint_ns: thread.namespace,
                },
              })
            ) {
              history.push(
                structuredClone(saved.checkpoint.channel_values) as Partial<
                  NativeState
                >,
              );
            }
            return {
              // Ledger selection is the diagnostic source for an unfinished run.
              // A failed execution projection may not yet contain a run receipt.
              threadId: thread.id,
              runId: thread.runId,
              checkpointNamespace: thread.namespace,
              request: structuredClone(thread.request),
              checkpointId: thread.checkpointId,
              wait: thread.checkpointId
                ? structuredClone(
                  thread.waitReceipts.get(
                    waitKey(thread.namespace, thread.checkpointId),
                  ),
                )
                : undefined,
              contributionConsumed: hasContributionConsumption(
                thread,
                thread.request.contribution.id,
              ),
              nativeObservations: await sortedNativeObservations(
                thread,
                thread.runId,
              ),
              values,
              history,
              effects: [...thread.effects].map(([key, result]) => ({
                key,
                node: structuredClone(effectNodes.get(key)!),
                result: structuredClone(result),
                settled: result !== undefined,
              })),
            };
          }),
      );
    },
    admissionTransferBoundary(
      operation?: (
        phase:
          | "before-fork"
          | "after-fork"
          | "before-selection"
          | "after-selection",
      ) => void,
    ) {
      admissionTransferBoundary = operation;
    },
    effectBoundary(
      operation?: (boundary: NativeFixtureEffectBoundary) => void,
    ) {
      effectBoundary = operation;
    },
    /** Retry the same accepted input against a rebound runtime and retained saver.
     * Test-only recovery driver; it does not qualify durable pg-boss retry. */
    async retryFailed() {
      await idle();
      const failed = [...accepted.values()].filter((entry) =>
        entry.receipt.status === "failed"
      );
      if (failed.length !== 1) {
        throw new Error("Expected one exact failed fixture delivery");
      }
      const entry = failed[0];
      const handler = handlers.get(entry.delivery.identity.operatorId);
      if (!handler) throw new Error("Retry requires a rebound fixture worker");
      entry.receipt.status = "running";
      try {
        await claims.run(
          structuredClone(entry.delivery),
          () => handler(structuredClone(entry.delivery)),
        );
        entry.receipt.status = "completed";
      } catch (error) {
        entry.receipt.status = "failed";
        throw error;
      }
    },
    bind(
      runtime: {
        snapshot: SystemRuntimeState;
        processAcceptedContribution(
          delivery: OperatorExecutionDelivery,
        ): Promise<void>;
        idle(): Promise<void>;
      },
    ) {
      const operatorId = runtime.snapshot.executionModel!.identity.builderId;
      handlers.set(
        operatorId,
        (delivery) => runtime.processAcceptedContribution(delivery),
      );
      runtime.idle = idle;
    },
    idle,
  };
}
