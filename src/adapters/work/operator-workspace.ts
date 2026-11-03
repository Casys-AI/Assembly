import { sha256 } from "../../domain/primitives/execution-digest.ts";
import type { ArtifactSourceServicePort } from "../../application/work/artifacts/publication.ts";
import { bindHostBackgroundTask } from "./runtime/host-background-task.ts";
import type { QueuedArtifactSourcePublication } from "../../domain/work/artifacts/source-publication.ts";
import { ArtifactSourceError } from "../../domain/work/artifacts/source-reference.ts";
import {
  exactCandidateInspection,
  exactDelegatedCommandDecision,
} from "../../application/governance/operator-command-origin.ts";
import { EvolutionConversationProjection } from "../../application/work/operators/evolution-projection.ts";
import {
  EvolutionFinalizationJob,
  operatorEvolutionCommands,
} from "../../application/work/runtime/evolution-commands.ts";
import { verifyTaskSourceInputContext } from "../../application/work/cases/task-source-input.ts";
import { caseBudgetPolicy as evolutionCaseBudgetPolicy } from "../../application/work/cases/runtime.ts";
import {
  captureEvolutionOrigin,
  evolutionBudgetScopes,
} from "../../application/work/runtime/evolution.ts";
import { EvolutionService } from "../../application/model/evolution/service.ts";
import {
  type EvolutionAuthorityPort,
  type EvolutionCheckpoint,
  EvolutionError,
  type EvolutionRepositoryPort,
  type EvolutionStorePort,
  type EvolutionTargetPort,
} from "../../application/model/evolution/ports.ts";
import type { ScopedExecutableModel } from "../../domain/model/evolution/semantic-effects.ts";
import type { BehaviorSettingsValidationTarget } from "../../application/work/runtime/behavior-settings-validation.ts";

export interface WorkspaceEvolutionPorts {
  repositoryId: string;
  store: EvolutionStorePort;
  authority: EvolutionAuthorityPort;
  repository: EvolutionRepositoryPort;
}
export interface WorkspaceEvolutionContext {
  targets: EvolutionTargetPort;
  validationTargets(
    models: readonly ScopedExecutableModel[],
  ): Promise<BehaviorSettingsValidationTarget[]>;
  runtimeFor(
    operatorId: string,
  ): { runtime: SystemRuntime; model: ModelPort; scope: string } | undefined;
}
import { MAX_OPERATOR_UNITS } from "../../domain/work/records/conversations.ts";
import { PilotCase } from "../../application/work/cases/handlers/case-lifecycle-handler.ts";
import { requestOpeningHost } from "../../application/work/cases/opening.ts";
import {
  type MainOpener,
  type OpeningCommand,
  type OpeningView,
  RequestSpaceError,
} from "../../domain/work/request-spaces.ts";
import {
  caseExecutionContext,
  delegatedCaseContext,
} from "../../application/work/cases/runtime.ts";
import {
  candidateCaseInvocation,
  changeCaseInvocation,
  invocationInput,
  invocationKey,
} from "../../application/work/operators/journal.ts";
import type {
  OperatorCommandOrigin,
  OperatorControlCommand,
} from "../../application/work/operators/command-delivery.ts";
import { isOpenCase } from "../../domain/work/entities/cases.ts";
import { sameCaseIdentity } from "../../domain/work/execution/case-context.ts";
import { requestOperatorSystemName } from "../governance/authority/operator/writer.ts";
import {
  awaitingPersonView,
  isTeamOperatorSpec,
  MAIN_EXECUTION_SPACE_ID,
  mainExecutionSpace,
  OperatorAuthorityError,
} from "../../domain/governance/operator-authority.ts";
import { scopedOperator } from "../../domain/governance/policies/delegation-scope.ts";
import type {
  RequestAwaitingPersonEntry,
  RequestBranchMainView,
  RequestSpaceAuthorityBridge,
} from "../../application/governance/request-space-authority-bridge.ts";
import { canonical } from "../../domain/primitives/canonical-json.ts";
import {
  deliverRequestAuthorityRoute,
  requestAuthorityRoute,
} from "../../application/governance/request-authority-routing.ts";
import { toolAdmissionDecisionContext } from "../../application/governance/operator-tool-admission-context.ts";
import type {
  ChatContext,
  ChatDecision,
  RequestOpeningOutcome,
  RequestResumeOutcome,
  SystemRuntimeState,
} from "../../domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../domain/governance/records/pending-change.ts";
import type { Case } from "../../domain/work/entities/cases.ts";
/** Composition of the normal conversation engine for every admitted model unit. */
import type { CaseNumberPort } from "../../application/work/cases/ports/out/case-number.port.ts";
import type {
  AgentPort,
  ClockPort,
  ModelDiagnosticsPort,
  ModelPort,
} from "../../application/work/runtime/ports.ts";
import type { ModelToolingPort } from "../../application/model/tooling.ts";
import { queryModelRevision } from "../model/sources/editing/tooling.ts";
import type { WorkBudgetPort } from "../../application/work/budget/ports.ts";
import type { RuntimeProvenancePort } from "../../application/work/runtime/provenance.ts";
import type { ProviderCallContextPort } from "../../application/telemetry/provider-call.ts";
import { SystemRuntime } from "../../application/work/runtime/system.ts";
import type { SchemaValidationPort } from "../../application/work/behaviors/schema-validation.ts";
import {
  conversationUnit,
  OperatorConversationError,
  type OperatorConversationManifest,
  OperatorConversations,
  type OperatorConversationUnit,
} from "../../application/work/operators/conversations.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
  pinnedResolution,
} from "../../application/work/behaviors/invocation.ts";
import { ObservationInvocationRegistry } from "../../application/work/behaviors/observation.ts";
import { WorkPlanExecutor } from "../../application/work/plans/executor.ts";
import type { PublishedToolArtifact } from "../../application/work/artifacts/catalog.ts";
import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type { BehaviorModelVersion } from "../../domain/shared-kernel/behavior-model-version.ts";
import {
  discoverConversationUnits,
  SourceModel,
  type SourceModelOptions,
  validateSourceExecutable,
} from "../model/sources/source-model.ts";
import type { ModelRepositoryPort } from "../../application/model/repository.ts";
import type { StorePort } from "../../application/work/runtime/ports.ts";
import type { NativeExecutionPort } from "../../application/work/runtime/execution.ts";
import type { OperatorExecutionDispatchPort } from "../../application/work/operators/execution.ts";
import type { StateHistoryPort } from "../../domain/work/history.ts";
import type { MemoryStorePort } from "../../application/memory/ports/store.ts";
import type { SkillStorePort } from "../../application/skills/ports.ts";
import type { WorkPlanStorePort } from "../../application/work/plans/ports.ts";
import { DenoToolRunner } from "../out/sandbox/runner.ts";
import { WorkArtifactObservationBehavior } from "../../application/work/behaviors/artifact-observation.ts";
import { OperatorInboxBehavior } from "../../application/work/behaviors/operator-inbox.ts";
import {
  callerWorkPlanPort,
  WorkPlanBehavior,
} from "../../application/work/plans/plan-behavior.ts";
import { InformationBehavior } from "../../application/work/context/information-behavior.ts";
import { ModelContextInformation } from "../../application/model/consultation/context-information.ts";
import { ModelContextReader } from "../../application/model/consultation/source-reader.ts";
import { GovernedMemoryPromotionService } from "../../application/memory/governed-memory-promotion.ts";
import type { DecisionInformationPort } from "../../application/work/context/information-ports.ts";
import type { SkillDownloadPort } from "../../application/skills/ports.ts";
import { ContextSkillsService } from "../../application/skills/context-skills.ts";
import { HttpsSkillDownloader } from "../out/http-client/download.ts";
import { SkillsBehavior } from "../../application/skills/behavior.ts";
import { bundledSkillReader } from "../out/filesystem/skill-bundles.ts";
import type { OperatorEntry } from "../../domain/model/records/operator-entry.ts";
import {
  PublishedToolsBehavior,
  ToolReuseBehavior,
} from "../../application/work/behaviors/tool-reuse.ts";
import { SystemClock } from "../../infrastructure/clock.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../../infrastructure/logging.ts";
import { CaseScheduler } from "../../application/work/cases/scheduling.ts";

const log = technicalLogger("scheduler");
const compositionLog = technicalLogger("composition");
import type { NetworkImpactLineageReader } from "../../application/model/impact/ports/out/network-impact-lineage-reader.port.ts";
import { NetworkImpactService } from "../../application/model/impact/analysis.ts";
import { NetworkImpactConsultation } from "../../application/model/impact/consultation.ts";
import type {
  NetworkImpactSkillsEvidenceSource,
  NetworkImpactStateEvidenceSource,
} from "../../application/model/impact/evidence-sources.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../../domain/model/consultation/network-impact.ts";
import { CompiledNetworkImpactModelReader } from "../model/impact/compiled-model-reader.ts";
import {
  LiveNetworkImpactEvidenceReader,
  type LiveNetworkImpactEvidenceSource,
} from "../../application/model/impact/live-evidence-reader.ts";

/** What a Main Operator does after a refused branch opening. */
const REQUEST_OPENING_RECOVERY: Record<RequestSpaceError["code"], string> = {
  INVALID_COMMAND:
    "Send a non-empty objective and current main or an exact listed Release.",
  OPENING_CONFLICT:
    "Reuse an openingId only for the identical opening; use a new openingId for another Request.",
  FORBIDDEN:
    "Your mandate's open-request act or the person's space control does not admit this opening; tell the person.",
  ADMISSION_REFUSED:
    "The Request's space admission is unavailable; tell the person.",
  UNAVAILABLE: "Retry later with the same openingId.",
  PROVISIONING_UNAVAILABLE: "Retry later with the same openingId.",
};

interface UnitRuntime {
  runtime: SystemRuntime;
  model: ModelPort;
  scope: string;
  store?: StorePort;
  history?: NetworkImpactStateEvidenceSource;
}

async function storageKey(nativeId: string): Promise<string> {
  return await sha256(nativeId);
}

export interface WorkspaceOperatorStorage {
  state:
    & StorePort
    & Pick<StateHistoryPort, "loadRevision">
    & NetworkImpactStateEvidenceSource;
  memory: MemoryStorePort;
  skills: SkillStorePort & NetworkImpactSkillsEvidenceSource;
  plans: WorkPlanStorePort;
}

/** Open from host bootstrap before starting operator delivery workers. */
export async function openOperatorWorkspace(options: {
  /** Host-resolved persistent operator scope; never selected by model input. */
  storage: { operator(operatorId: string): Promise<WorkspaceOperatorStorage> };
  execution: NativeExecutionPort;
  dispatch: OperatorExecutionDispatchPort;
  /** Actual durable source effect/run evidence, selected by trusted host composition. */
  assertCommandOrigin(origin: OperatorCommandOrigin): Promise<void>;
  artifactSources(operatorId: string): Promise<ArtifactSourceServicePort>;
  assertArtifactSourceOrigin(
    publication: QueuedArtifactSourcePublication,
  ): Promise<void>;
  bindArtifactSourceAuthority(
    verify: (publication: QueuedArtifactSourcePublication) => Promise<void>,
  ): () => void;
  /** The same durable sequence used by the primary runtime. */
  evolutionFactory?(
    context: WorkspaceEvolutionContext,
  ): Promise<WorkspaceEvolutionPorts>;
  caseNumbers: CaseNumberPort;
  schemaValidator: SchemaValidationPort;
  primary: SystemRuntime;
  primaryModel: ModelPort;
  /** Primary live history is injected by its existing serialized owner. */
  primaryHistory?: NetworkImpactStateEvidenceSource;
  /** Read-only historical repository; never rebuild a missing historical artifact. */
  networkImpactRepository?:
    & NetworkImpactLineageReader
    & Pick<ModelRepositoryPort, "at" | "descriptorAt">;
  repository: ModelRepositoryPort;
  tooling: ModelToolingPort;
  /** Production models share the repository's durable writer. */
  createSourceModel?(
    options: Pick<
      SourceModelOptions,
      "systemQualifiedName" | "sourcesDir" | "initialSources"
    >,
  ): SourceModel;
  modelContextReader?:
    import("../../application/work/context/information-ports.ts").ModelConsultationReader;
  agents: AgentPort;
  clock?: ClockPort;
  /** One durable ledger; delegated work uses its central case's budget scope. */
  workBudget?: WorkBudgetPort;
  runtimeProvenance?: RuntimeProvenancePort;
  providerCallContext?: ProviderCallContextPort;
  /** Every runtime receives the port; its current role controls diagnostic use. */
  modelDiagnostics?: ModelDiagnosticsPort;
  directory: string;
  executors: BehaviorInvocationPort[];
  /** Trusted composition port; model content never chooses its implementation. */
  skillDownload?: SkillDownloadPort;
  /** Branch Operator requests, read by Main only: the covered ones it decides
   * (4.8c) and the ones waiting for the person, read-only (4.8d). */
  branchAuthority?: Pick<
    RequestSpaceAuthorityBridge,
    | "mainView"
    | "decide"
    | "recipientSpace"
  >;
  /** Host-internal Main Operator openings of branch Requests (4.8d D3). */
  requestOpenings?: {
    openForMain(
      command: Pick<OpeningCommand, "text" | "source">,
      opener: MainOpener,
    ): Promise<OpeningView>;
    /** The exact Releases a Request may start from, newest first. */
    releases(): Promise<NonNullable<ChatContext["requestOpening"]>["releases"]>;
    /** The registered Main writes to an open branch Request's BO (Q3). */
    writeForMain(
      caseId: string,
      written: {
        resumeId: string;
        instruction: string;
        at: string;
        operatorId?: string;
      },
      opener: MainOpener,
    ): Promise<void>;
  };
}) {
  const clock = options.clock ?? new SystemClock();
  const now = () => clock.now();
  // Capture bootstrap context now. State observers and the arming command can
  // schedule this independent finalizer from inside a delivery whose signal
  // pg-boss aborts even on normal completion; its claim must not survive here.
  const scheduleFinalization = bindHostBackgroundTask(() =>
    finalization.schedule()
  );
  const primary = options.primary.snapshot.executionModel;
  if (!primary?.version.repositoryVersion) {
    throw new Error("Missing admitted operator source pin");
  }
  const projectId = primary.identity.projectId;
  let evolutionPorts: WorkspaceEvolutionPorts | undefined;
  let evolution: EvolutionService | undefined;
  let evolutionProjection: EvolutionConversationProjection | undefined;
  let unsubscribeEvolutionStore: (() => void) | undefined;
  const runtimes = new Map<string, UnitRuntime>([[primary.identity.builderId, {
    runtime: options.primary,
    model: options.primaryModel,
    history: options.primaryHistory,
    // Only the historical ASE primary omits its source scope from identity.
    scope: primary.identity.systemQualifiedName ??
      "ASELiveBuilder::liveBuilder",
  }]]);
  function bindTaskSourceInputs(runtime: SystemRuntime) {
    runtime.configureTaskSourceInputs({
      verify: (input) =>
        verifyTaskSourceInputContext(
          runtime.snapshot,
          [...runtimes.values()].map((entry) => entry.runtime.snapshot),
          options.primary.snapshot,
          input,
        ),
    });
  }
  bindTaskSourceInputs(options.primary);
  const notifyWatch = (
    notice: NonNullable<
      import("../../domain/work/dialogue.ts").SystemRuntimeState[
        "watchNotifications"
      ]
    >[number],
  ) => options.primary.receiveWatchNotification(notice);
  options.primary.bindWatchNotifications(notifyWatch);
  const caseScheduler = new CaseScheduler({
    clock,
    runtimes: () => [...runtimes.values()].map((entry) => entry.runtime),
  });
  let caseTick: Promise<void> | undefined;
  let closing = false;
  let evolutionReady = false;
  let deliveriesActive = false;
  let activation: Promise<void> | undefined;
  const evolutionSubscriptions = new Map<SystemRuntime, () => void>();
  const finalization = new EvolutionFinalizationJob(async () => {
    if (!evolution || !evolutionPorts) return;
    // Only armed dossiers require a finalizer. Prepared/accepted ones never
    // reserve work or cause compilation, even when runtime state changes.
    for (
      const dossier of await evolutionPorts.store.listPending(
        evolutionPorts.repositoryId,
      )
    ) {
      if (
        !["armed", "publishing", "published-awaiting-adoption"].includes(
          dossier.status,
        )
      ) continue;
      for (const target of dossier.proposal.targets) {
        await runtimes.get(target.operatorId)?.runtime.idle();
      }
      await evolution.finalize(dossier.id);
    }
  }, (error) =>
    log.error("EVOLUTION_FINALIZATION_FAILED", {
      ...errorLogProperties(error),
      code: "EVOLUTION_FINALIZATION_FAILED",
    }));
  function scheduleEvolution() {
    if (!closing && evolutionReady) scheduleFinalization();
  }
  function evolutionLabels(): Map<string, string | null> {
    return new Map(
      [...runtimes].map((
        [operatorId, entry],
      ) => [
        operatorId,
        entry.runtime.snapshot.executionModel?.operator?.name ?? null,
      ]),
    );
  }
  function bindEvolutionCommands(runtime: SystemRuntime) {
    if (!evolution || !evolutionPorts) return;
    runtime.configureOperatorEvolution(operatorEvolutionCommands({
      repositoryId: evolutionPorts.repositoryId,
      store: evolutionPorts.store,
      service: evolution,
      snapshot: () => runtime.snapshot,
      armed: scheduleEvolution,
      receipt: (dossier) =>
        evolutionProjection!.record(dossier, evolutionLabels()),
    }));
    if (!evolutionSubscriptions.has(runtime)) {
      evolutionSubscriptions.set(
        runtime,
        runtime.onState((state) => {
          if (!state.busy) scheduleEvolution();
        }),
      );
    }
  }
  function tickCases(): Promise<void> {
    if (closing) return Promise.resolve();
    if (caseTick) return caseTick;
    const task = (async () => {
      for (const entry of runtimes.values()) {
        await entry.runtime.flushWatchNotifications();
      }
      await caseScheduler.tick();
    })().finally(() => {
      if (caseTick === task) caseTick = undefined;
    });
    caseTick = task;
    return task;
  }
  const targets = new Map<string, string>();
  const observationOwners = new Map<string, string>();
  const reuseOwners = new Map<string, string>();
  const planOwners = new Map<string, string>();
  const publishedTargets = new Set<string>();
  const reuseTargets = new Set<string>();
  const planTargets = new Set<string>();
  const workTargets = new Set<string>();
  const pins = new Map<string, Promise<ExecutableModel | null>>();
  let plannerRegistered = false;
  const informationEntries = new Map<
    string,
    { ownerId: string; kind: OperatorEntry["kind"] }
  >();
  let memoryRuntime:
    | Promise<{
      store: MemoryStorePort;
      service: GovernedMemoryPromotionService;
    }>
    | undefined;
  async function memory() {
    memoryRuntime ??= Promise.resolve().then(() => {
      const store: MemoryStorePort = {
        load: async (ownerId, id) =>
          (await options.storage.operator(ownerId)).memory.load(ownerId, id),
        list: async (ownerId) =>
          (await options.storage.operator(ownerId)).memory.list(ownerId),
        save: async (record, expected) =>
          (await options.storage.operator(record.ownerId)).memory.save(
            record,
            expected,
          ),
      };
      const service = new GovernedMemoryPromotionService({
        store,
        now,
        provenance: {
          verify(ownerId, content) {
            const snapshot = runtimes.get(ownerId)?.runtime.snapshot;
            if (!snapshot) return Promise.resolve(false);
            const decision = snapshot.messages.find((message) =>
              message.id === content.origin.decisionId
            );
            if (
              decision?.role !== "assistant" || !decision.execution?.actionId
            ) {
              return Promise.resolve(false);
            }
            const reference = (value: string, outcome = false) => {
              if (!value.startsWith("message:")) return false;
              const message = snapshot.messages.find((message) =>
                message.id === value.slice("message:".length)
              );
              return !!message?.execution?.digest && (!outcome ||
                (message.role === "tool" && !!message.execution.actionId &&
                  !!message.observation));
            };
            return Promise.resolve(
              content.origin.sourceRefs.every((value) => reference(value)) &&
                (content.outcome.status === "pending" ||
                  content.outcome.evidenceRefs.every((value) =>
                    reference(value, true)
                  )),
            );
          },
        },
      });
      return { store, service };
    });
    try {
      return (await memoryRuntime).service;
    } catch (error) {
      memoryRuntime = undefined;
      throw error;
    }
  }
  const memoryInformation = new InformationBehavior({
    entries: informationEntries,
    resolveCallerModel,
    snapshotForCaller: (callerId) => runtimes.get(callerId)?.runtime.snapshot,
    memory,
  });
  options.executors.push(memoryInformation);
  let skillsRuntime:
    | Promise<
      {
        store: SkillStorePort & NetworkImpactSkillsEvidenceSource;
        service: ContextSkillsService;
      }
    >
    | undefined;
  async function skills() {
    skillsRuntime ??= Promise.resolve().then(() => {
      const store: SkillStorePort & NetworkImpactSkillsEvidenceSource = {
        readNetworkImpactEvidence: async (input) =>
          (await options.storage.operator(input.ownerId)).skills
            .readNetworkImpactEvidence(input),
        load: async (ownerId) =>
          (await options.storage.operator(ownerId)).skills.load(ownerId),
        save: async (record, expected) =>
          (await options.storage.operator(record.ownerId)).skills.save(
            record,
            expected,
          ),
      };
      return {
        store,
        service: new ContextSkillsService({
          store,
          now,
          download: options.skillDownload ?? new HttpsSkillDownloader(),
          artifactSources: (ownerId) => options.artifactSources(ownerId),
          assertCurrentAuthority: (authority, permission) =>
            skillInformation.assertCurrentAuthority(authority, permission),
        }),
      };
    });
    try {
      return (await skillsRuntime).service;
    } catch (error) {
      skillsRuntime = undefined;
      throw error;
    }
  }
  const skillInformation = new SkillsBehavior({
    entries: informationEntries,
    resolveCallerModel,
    skills,
    readBundledSkill: bundledSkillReader(),
  });
  options.executors.push(skillInformation);
  // The host grants only the currently admitted caller's own existing handles.
  // A future multi-owner inspection grant requires a separate authorization port.
  async function ownEvidenceScope(callerId: string) {
    const entry = runtimes.get(callerId);
    if (
      !entry?.history || !entry.runtime.snapshot.executionModel ||
      entry.runtime.snapshot.executionModel.identity.builderId !== callerId
    ) return null;
    return {
      id: `own-history:${projectId}:${await storageKey(callerId)}`,
      ownerId: callerId,
    };
  }
  const networkImpactCapability = {
    scope: "own-history" as const,
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    maxPageSize: 20,
    maxResponseCharacters: 16_000,
  };
  const networkImpact =
    options.networkImpactRepository && options.primaryHistory
      ? new NetworkImpactService({
        lineage: options.networkImpactRepository,
        models: new CompiledNetworkImpactModelReader({
          repository: options.networkImpactRepository,
          projectId,
        }),
        evidence: new LiveNetworkImpactEvidenceReader({
          async resolveSources(operatorId) {
            const scope = await ownEvidenceScope(operatorId);
            const history = runtimes.get(operatorId)?.history;
            if (!scope || !history) return [];
            const sources: LiveNetworkImpactEvidenceSource[] = [];
            // Analysis never calls skills(): an absent owner remains unavailable.
            const existingSkills = skillsRuntime
              ? await skillsRuntime
              : undefined;
            if (existingSkills) {
              sources.push({
                id: `${scope.id}:skills`,
                kind: "skills",
                read: (input) =>
                  existingSkills.store.readNetworkImpactEvidence({
                    ...input,
                    ownerId: operatorId,
                  }),
              });
            }
            // The bounded skill catalog gets first consideration; a long state
            // history must not consume its snapshot or byte allocation.
            sources.push({
              id: `${scope.id}:state`,
              kind: "state",
              read: (input) => history.readNetworkImpactEvidence(input),
            });
            return sources;
          },
        }),
      })
      : undefined;
  const networkImpactConsultation = networkImpact
    ? new NetworkImpactConsultation({
      analyze: (input, signal) => networkImpact.analyze(input, signal),
      limits: networkImpactCapability.limits,
      maxPageSize: networkImpactCapability.maxPageSize,
      maxResponseCharacters: networkImpactCapability.maxResponseCharacters,
    })
    : undefined;
  const modelInformation = new ModelContextInformation({
    projectId,
    resolveCallerModel,
    ...(networkImpactConsultation
      ? {
        networkImpact: {
          service: networkImpactConsultation,
          resolveEvidenceScope: ownEvidenceScope,
        },
      }
      : {}),
    snapshotForCaller: (callerId) => runtimes.get(callerId)?.runtime.snapshot,
    async readSourceRevision(callerId) {
      const runtime = runtimes.get(callerId);
      const identity = runtime?.runtime.snapshot.model;
      if (!identity || !runtime?.model.readSourceRevision) {
        throw new Error(
          "The model context caller has no source revision reader",
        );
      }
      return await runtime.model.readSourceRevision(identity);
    },
    reader: options.modelContextReader ??
      new ModelContextReader(options.repository),
    ...(options.tooling.referenceSites
      ? {
        toolingReferenceSites: async (version: string, elementId: string) => {
          const revision = await options.repository.at(version);
          return {
            sourceDigest: revision.sourceDigest,
            sites: await options.tooling.referenceSites!(
              revision.sources,
              elementId,
            ),
          };
        },
      }
      : {}),
    toolingQuery: async (version: string, expression: string) =>
      await queryModelRevision(
        options.tooling,
        await options.repository.at(version),
        expression,
      ),
  });
  const information: DecisionInformationPort = {
    modelTools: (model) => modelInformation.modelTools(model),
    assertModelContextPin: (model, messages, pin) =>
      modelInformation.assertModelContextPin(model, messages, pin),
    withModelContextPin: (model, messages, pin, operation) =>
      modelInformation.withModelContextPin(model, messages, pin, operation),
    consultModel: (model, input, messages, budget) =>
      modelInformation.consultModel(model, input, messages, budget),
    consultAdmittedModelSource: (model, input, messages, budget) =>
      modelInformation.consultAdmittedModelSource(
        model,
        input,
        messages,
        budget,
      ),
    async read(model, messages) {
      return {
        ...await modelInformation.read(model, messages),
        ...await memoryInformation.read(model),
        ...await skillInformation.read(model),
      };
    },
  };

  const conversations = new OperatorConversations({
    primary: options.primary,
    onNoticeError: (error) =>
      compositionLog.error(error.message, errorLogProperties(error)),
    evolutionRead: () =>
      evolutionProjection?.read(evolutionLabels()) ??
        Promise.resolve(undefined),
    skillStore: {
      async load(ownerId) {
        return await (await skills()).ports.store.load(ownerId);
      },
    },
    factory: {
      async open(unit) {
        const id = unit.model.identity.builderId;
        const stores = await options.storage.operator(id);
        const store = stores.state;
        const model = options.createSourceModel?.({
          systemQualifiedName: unit.systemQualifiedName,
        }) ?? new SourceModel({
          tooling: options.tooling,
          repository: options.repository,
          projectId,
          systemQualifiedName: unit.systemQualifiedName,
        });
        if (runtimes.has(id)) {
          throw new EvolutionError(
            "EVOLUTION_DUPLICATE_RUNTIME",
            "One live runtime per operator is required",
          );
        }
        const runtime = new SystemRuntime({
          caseNumbers: options.caseNumbers,
          clock,
          schemaValidator: options.schemaValidator,
          agents: options.agents,
          workBudget: options.workBudget,
          runtimeProvenance: options.runtimeProvenance,
          providerCallContext: options.providerCallContext,
          modelDiagnostics: options.modelDiagnostics,
          model,
          store,
          stateHistory: store,
          execution: options.execution,
          dispatch: options.dispatch,
          artifactSources: await options.artifactSources(id),
          runner: new DenoToolRunner(),
          behaviors: new BehaviorInvocationRegistry(options.executors),
          information,
          onBudgetRefreshError: (error) =>
            log.warn(
              "Budget view refresh failed after settlement",
              errorLogProperties(error),
            ),
          onNoticeError: (detail) =>
            compositionLog.warn(
              "Creation recovery notice could not be delivered",
              {
                ...errorLogProperties(detail.error),
                changeId: detail.changeId,
                changeStatus: detail.status,
              },
            ),
        });
        if (evolutionPorts) {
          runtime.bindEvolutionBarrier(
            evolutionPorts.repositoryId,
            evolutionPorts.store,
          );
        }
        bindTaskSourceInputs(runtime);
        bindEvolutionCommands(runtime);
        runtime.bindOperatorRegistry(conversations);
        runtime.bindWatchNotifications(notifyWatch);
        bindAuthority(runtime);
        await runtime.initialize(unit.model, {
          resumeCandidateContinuations: false,
        });
        runtimes.set(id, {
          runtime,
          model,
          store,
          history: store,
          scope: unit.systemQualifiedName,
        });
        return runtime;
      },
      async close(runtime) {
        const entry = [...runtimes.entries()].find(([, value]) =>
          value.runtime === runtime
        );
        if (!entry || !entry[1].store) return;
        await runtime.idle();
        evolutionSubscriptions.get(entry[1].runtime)?.();
        evolutionSubscriptions.delete(entry[1].runtime);
        runtimes.delete(entry[0]);
      },
    },
  });

  const evolutionTargets: EvolutionTargetPort = {
    async withArmingTargets(dossier, saveArmed) {
      const targets = [...dossier.proposal.targets].sort((a, b) =>
        a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0
      );
      const reserve = async (
        index: number,
      ): Promise<Awaited<ReturnType<typeof saveArmed>>> => {
        if (index === targets.length) return await saveArmed();
        const runtime = runtimes.get(targets[index]!.operatorId)?.runtime;
        if (!runtime) {
          throw new EvolutionError(
            "EVOLUTION_TARGET_MISSING",
            "An arming target has no admitted runtime",
          );
        }
        return await runtime.withEvolutionArming(() => reserve(index + 1));
      };
      return await reserve(0);
    },
    captureOrigin(input, proposal) {
      return Promise.resolve(
        captureEvolutionOrigin(
          input,
          proposal,
          [...runtimes.values()].map((entry) => entry.runtime.snapshot),
        ),
      );
    },
    async withReservedTargets(dossier, operation) {
      const ordered = [...dossier.proposal.targets].sort((a, b) =>
        a.operatorId < b.operatorId ? -1 : a.operatorId > b.operatorId ? 1 : 0
      );
      const reserve = async (
        index: number,
      ): Promise<Awaited<ReturnType<typeof operation>>> => {
        if (index < ordered.length) {
          const entry = runtimes.get(ordered[index]!.operatorId);
          if (!entry) {
            throw new EvolutionError(
              "EVOLUTION_TARGET_MISSING",
              "Target operator is not admitted",
            );
          }
          return await entry.runtime.withEvolutionReservation(
            dossier.id,
            () => reserve(index + 1),
          );
        }
        // Only a published, validated target may explain a policy already
        // advanced by an interrupted adoption. Ordinary HEAD is never proof.
        const replacements = new Map<
          string,
          Awaited<ReturnType<typeof validateSourceExecutable>>
        >();
        if (dossier.publication) {
          for (const target of dossier.proposal.targets) {
            const entry = runtimes.get(target.operatorId);
            if (!entry) continue;
            const replacement = await validateSourceExecutable(
              await options.repository.at(dossier.publication.version),
              projectId,
              entry.scope,
            );
            if (
              replacement.version.digest !== target.candidateDigest ||
              replacement.version.repositoryVersion !==
                dossier.publication.version
            ) {
              throw new EvolutionError(
                "EVOLUTION_ADOPTION_MISMATCH",
                "Published replacement budget source differs",
              );
            }
            replacements.set(target.operatorId, replacement);
          }
        }
        const evaluate = async (): Promise<EvolutionCheckpoint> => {
          const checkpoint: EvolutionCheckpoint = { safe: true, blockers: [] };
          for (const target of ordered) {
            const boundary = await runtimes.get(target.operatorId)!.runtime
              .evolutionBoundary(dossier.id, (scope) => {
                const owner = runtimes.get(scope.ownerId)?.runtime.snapshot
                  .executionModel;
                const replacement = replacements.get(scope.ownerId);
                const policy = (model: typeof owner) =>
                  model &&
                  (scope.designer
                    ? model.workBudgetPolicy
                    : evolutionCaseBudgetPolicy(
                      model,
                      scope.caseTypeId,
                      scope.ceiling,
                    ));
                return [policy(owner), policy(replacement)].filter((
                  value,
                ): value is NonNullable<typeof value> => value !== undefined);
              });
            checkpoint.safe &&= boundary.safe;
            checkpoint.blockers.push(...boundary.blockers);
            const runtimeState =
              runtimes.get(target.operatorId)!.runtime.snapshot;
            for (const scope of evolutionBudgetScopes(runtimeState)) {
              const owner = runtimes.get(scope.ownerId)?.runtime.snapshot
                .executionModel;
              const policy = owner &&
                (scope.designer
                  ? owner.workBudgetPolicy
                  : evolutionCaseBudgetPolicy(
                    owner,
                    scope.caseTypeId,
                    scope.ceiling,
                  ));
              if (!owner || policy && !options.workBudget) {
                checkpoint.safe = false;
                checkpoint.blockers.push({
                  code: "EVOLUTION_BUDGET_OWNER_MISSING",
                  operatorId: target.operatorId,
                  detail:
                    `Budget ${scope.scopeId} has no available owner/reader`,
                });
                continue;
              }
              if (!policy) continue;
              try {
                let view;
                try {
                  view = await options.workBudget!.snapshot(
                    scope.scopeId,
                    scope.ownerId,
                    policy,
                  );
                } catch (error) {
                  if (
                    scope.pending && error instanceof Error &&
                    "code" in error &&
                    error.code === "missing-state"
                  ) continue;
                  // A prior adoption attempt may have durably adopted its ledger
                  // immediately before crashing, without changing the runtime pin.
                  if (
                    !dossier.publication ||
                    !dossier.proposal.targets.some((item) =>
                      item.operatorId === scope.ownerId
                    )
                  ) throw error;
                  const ownerEntry = runtimes.get(scope.ownerId)!;
                  const replacement = await validateSourceExecutable(
                    await options.repository.at(dossier.publication.version),
                    projectId,
                    ownerEntry.scope,
                  );
                  const next = scope.designer
                    ? replacement.workBudgetPolicy
                    : evolutionCaseBudgetPolicy(
                      replacement,
                      scope.caseTypeId,
                      scope.ceiling,
                    );
                  view = await options.workBudget!.snapshot(
                    scope.scopeId,
                    scope.ownerId,
                    next,
                  );
                }
                if (view?.reserved) {
                  checkpoint.safe = false;
                  checkpoint.blockers.push({
                    code: "EVOLUTION_BUDGET_UNSETTLED",
                    operatorId: target.operatorId,
                    detail:
                      `Budget ${scope.scopeId} retains ${view.reserved} reserved attempts`,
                  });
                }
              } catch (error) {
                checkpoint.safe = false;
                checkpoint.blockers.push({
                  code: "EVOLUTION_BUDGET_UNPROVEN",
                  operatorId: target.operatorId,
                  detail: error instanceof Error
                    ? error.message
                    : String(error),
                });
              }
            }
          }
          return checkpoint;
        };
        const checkpoint = await evaluate();
        const result = await operation(checkpoint, evaluate);
        // Runtime pins changed inside this same reservation. Publish their
        // actual admitted registry before reopening any command surface.
        const nextManifest = await manifest();
        await conversations.reconcileUnits(nextManifest);
        registerTargets(nextManifest.units);
        pins.clear();
        return result;
      };
      try {
        return await conversations.withAdmission(() => reserve(0));
      } catch (error) {
        if (
          error instanceof EvolutionError &&
            error.code === "EVOLUTION_RUNTIME_BUSY" ||
          error instanceof OperatorConversationError &&
            error.code === "AGENT_BUSY"
        ) {
          return await operation({
            safe: false,
            blockers: [{
              code: "EVOLUTION_RUNTIME_BUSY",
              detail:
                "An operator command is still running; retry finalization after it settles",
            }],
          });
        }
        throw error;
      }
    },
    async inspectAdoption(dossier, target, publication) {
      const entry = runtimes.get(target.operatorId);
      if (!entry) {
        throw new EvolutionError(
          "EVOLUTION_TARGET_MISSING",
          "Target operator is not admitted",
        );
      }
      const persisted = await entry.runtime.readPersistedState();
      if (
        !persisted || persisted.revision !== entry.runtime.snapshot.revision
      ) {
        throw new EvolutionError(
          "EVOLUTION_STATE_DRIFT",
          "The durable target journal changed",
        );
      }
      return entry.runtime.inspectEvolutionAdoption(
        dossier,
        target,
        publication,
      );
    },
    async adoptExact(dossier, target, publication) {
      const entry = runtimes.get(target.operatorId);
      if (!entry || !evolutionPorts) {
        throw new EvolutionError(
          "EVOLUTION_TARGET_MISSING",
          "Target adoption is unavailable",
        );
      }
      if (
        await evolutionPorts.store.targetOwner(
          dossier.repositoryId,
          target.operatorId,
        ) !== dossier.id
      ) {
        throw new EvolutionError(
          "EVOLUTION_BARRIER_LOST",
          "The durable target reservation changed",
        );
      }
      await evolutionPorts.authority.revalidate(
        dossier.adoptionAuthorization!,
        dossier.proposal,
      );
      const source = await options.repository.at(publication.version);
      const native = await validateSourceExecutable(
        source,
        projectId,
        entry.scope,
      );
      await manifest(
        target.operatorId === primary.identity.builderId ? native : undefined,
        native,
      );
      await entry.runtime.adoptEvolution(dossier, target, publication, native);
      const receipt = await evolutionTargets.inspectAdoption(
        dossier,
        target,
        publication,
      );
      if (!receipt) {
        throw new EvolutionError(
          "EVOLUTION_RECEIPT_MISSING",
          "Native adoption has no durable receipt",
        );
      }
      return receipt;
    },
  };
  const validationTargets = async (
    models: readonly ScopedExecutableModel[],
  ) => {
    const targets: BehaviorSettingsValidationTarget[] = [];
    for (const { model } of models) {
      const entry = runtimes.get(model.identity.builderId);
      if (!entry) {
        throw new EvolutionError(
          "EVOLUTION_TARGET_MISSING",
          "A settings consumer has no admitted runtime",
        );
      }
      const target = await entry.runtime.evolutionValidationTarget(model);
      // This audit loads retained notes without changing their admission state.
      target.memoryRecords = await (await memory()).ports.store.list(
        model.identity.builderId,
      );
      target.memoryAuditAt = clock.now();
      targets.push(target);
    }
    return targets;
  };
  if (options.evolutionFactory) {
    evolutionPorts = await options.evolutionFactory({
      targets: evolutionTargets,
      validationTargets,
      runtimeFor: (id) => runtimes.get(id),
    });
    for (const entry of runtimes.values()) {
      entry.runtime.bindEvolutionBarrier(
        evolutionPorts.repositoryId,
        evolutionPorts.store,
      );
    }
    evolutionProjection = new EvolutionConversationProjection({
      repositoryId: evolutionPorts.repositoryId,
      store: evolutionPorts.store,
      repository: options.repository,
    });
    unsubscribeEvolutionStore = evolutionPorts.store.onChange?.(() => {
      if (!closing) conversations.notifyReadChange();
    });
    evolution = new EvolutionService({
      ...evolutionPorts,
      targets: evolutionTargets,
      now,
    });
    for (const entry of runtimes.values()) bindEvolutionCommands(entry.runtime);
  }

  async function manifest(
    primaryOverride?: ExecutableModel,
    operatorOverride?: ExecutableModel,
  ): Promise<OperatorConversationManifest> {
    const admitted = primaryOverride ??
      options.primary.snapshot.executionModel!;
    const revision = await options.repository.at(
      admitted.version.repositoryVersion!,
    );
    const units: OperatorConversationUnit[] = [];
    const discovered = discoverConversationUnits(revision, projectId)
      .map((unit) => ({ unit, revision }));
    const discoveredIds = new Set(
      discovered.map(({ unit }) => unit.identity.builderId),
    );
    for (const { unit, revision: unitRevision } of discovered) {
      let model = unit.identity.builderId === admitted.identity.builderId
        ? structuredClone(admitted)
        : await validateSourceExecutable(
          unitRevision,
          projectId,
          unit.systemQualifiedName,
        );
      if (unit.identity.builderId !== admitted.identity.builderId) {
        // Registry membership and executable admission are separate. Existing
        // operators retain their own immutable contract until explicit adoption.
        let local =
          operatorOverride?.identity.builderId === unit.identity.builderId
            ? operatorOverride
            : runtimes.get(unit.identity.builderId)?.runtime.snapshot
              .executionModel;
        if (!local) {
          local =
            (await (await options.storage.operator(unit.identity.builderId))
              .state.load())?.executionModel;
        }
        if (local) {
          const pin = local.version.repositoryVersion;
          if (!pin) throw new Error("Missing admitted operator source pin");
          const compiled = await validateSourceExecutable(
            await options.repository.at(pin),
            projectId,
            unit.systemQualifiedName,
          );
          if (
            compiled.version.digest !== local.version.digest ||
            compiled.identity.builderId !== unit.identity.builderId ||
            compiled.identity.systemId !== unit.identity.systemId
          ) {
            throw new Error(
              "The persisted operator contract does not match its immutable source",
            );
          }
          model = compiled;
        }
      }
      // Each operator may admit creation in its own pinned contract while Main
      // remains on an older pin. Discover only that operator's admitted children,
      // then recursively use their own pins; repository HEAD grants no admission.
      const ownRevision =
        model.version.repositoryVersion === unitRevision.version
          ? unitRevision
          : await options.repository.at(model.version.repositoryVersion!);
      for (
        const candidate of discoverConversationUnits(ownRevision, projectId)
      ) {
        if (discoveredIds.has(candidate.identity.builderId)) continue;
        const child = await validateSourceExecutable(
          ownRevision,
          projectId,
          candidate.systemQualifiedName,
        );
        if (
          child.operatorTeam?.parentOperatorId !== model.identity.builderId
        ) continue;
        if (discovered.length >= MAX_OPERATOR_UNITS) {
          throw new OperatorConversationError(
            "INVALID_MANIFEST",
            "The admitted operator registry exceeds its capacity",
            409,
          );
        }
        discoveredIds.add(candidate.identity.builderId);
        discovered.push({ unit: candidate, revision: ownRevision });
      }
      units.push(conversationUnit(unit.systemQualifiedName, model));
    }
    if (
      units.length > MAX_OPERATOR_UNITS ||
      units.filter((unit) => unit.model.operator?.primary).length > 1
    ) {
      throw new OperatorConversationError(
        "INVALID_MANIFEST",
        "The prospective registry does not have a unique primary contact",
        409,
      );
    }
    return { repositoryVersion: revision.version, units };
  }

  function registerTargets(units: readonly OperatorConversationUnit[]) {
    informationEntries.clear();
    targets.clear();
    observationOwners.clear();
    reuseOwners.clear();
    planOwners.clear();
    publishedTargets.clear();
    reuseTargets.clear();
    planTargets.clear();
    workTargets.clear();
    for (const unit of units) {
      const actor = unit.model.identity.builderId;
      for (const entry of unit.model.operatorEntries || []) {
        if (
          entry.kind === "context-evidence" ||
          entry.kind.startsWith("memory-") ||
          entry.kind.startsWith("skill-")
        ) {
          informationEntries.set(entry.id, {
            ownerId: actor,
            kind: entry.kind,
          });
        }
        if (entry.kind === "inbox") {
          targets.set(entry.id, actor);
          workTargets.add(entry.id);
        }
        if (entry.kind === "inspect-work-artifacts") {
          observationOwners.set(entry.id, actor);
        }
        if (entry.kind === "reuse-tool") {
          reuseOwners.set(entry.id, actor);
          reuseTargets.add(entry.id);
        }
        if (entry.kind === "work-plan") {
          planOwners.set(entry.id, actor);
          planTargets.add(entry.id);
        }
        if (entry.kind === "published-tools") publishedTargets.add(entry.id);
      }
    }
  }

  bindAuthority(options.primary);
  options.primary.bindOperatorRegistry(conversations);
  const admittedManifest = await manifest();
  await conversations.initialize(admittedManifest);
  registerTargets(admittedManifest.units);
  const unbindArtifactSourceAuthority = options.bindArtifactSourceAuthority(
    async (publication) => {
      const target = runtimes.get(publication.target.operatorId)?.runtime;
      if (
        !target || publication.target.ownerId !== publication.target.operatorId
      ) throw new ArtifactSourceError("scope");
      await target.assertArtifactSourcePublication(publication);
    },
  );
  for (const unit of admittedManifest.units) {
    await skillInformation.initialize(unit.model);
    // Enqueue source-selected foundation commands before any recovered first
    // work; no native graph runs before the host starts durable workers.
    await runtimes.get(unit.model.identity.builderId)?.runtime
      .prepareInitialTools();
  }

  async function resolveCallerModel(
    callerId: string,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null> {
    const entry = runtimes.get(callerId);
    if (
      !entry ||
      entry.runtime.snapshot.executionModel?.version.digest !== version.digest
    ) return null;
    const key = JSON.stringify([
      callerId,
      version.digest,
      version.repositoryVersion,
    ]);
    const result = await pinnedResolution(pins, key, async () => {
      const revision = await options.repository.at(version.repositoryVersion);
      const model = await validateSourceExecutable(
        revision,
        projectId,
        entry.scope,
      );
      return model.identity.builderId === callerId &&
          model.version.digest === version.digest
        ? model
        : null;
    });
    return entry.runtime.snapshot.executionModel?.version.digest ===
          version.digest && result
      ? structuredClone(result)
      : null;
  }

  const inbox = new OperatorInboxBehavior({
    targets,
    resolveCallerModel,
    canContribute(callerId, targetNativeId) {
      const target = targets.get(targetNativeId);
      const team = target &&
        runtimes.get(target)?.runtime.snapshot.executionModel?.operatorTeam;
      if (!team) return true;
      const caller = runtimes.get(callerId);
      const context = caller && caseExecutionContext(caller.runtime.snapshot);
      return callerId === team.parentOperatorId &&
        context?.caseId === team.requestId &&
        (context.record?.owner ?? context.budget?.ownerId) ===
          team.requestOwnerId;
    },
    dispatch: (actor, text, correlation, proof) =>
      conversations.submitWork(actor, text, correlation, proof),
  });
  options.executors.push(inbox);
  const observation = new WorkArtifactObservationBehavior({
    targets: observationOwners,
    workTargets: targets,
    resolveCallerModel,
    target(operatorId) {
      const entry = runtimes.get(operatorId);
      return entry
        ? {
          model: entry.model,
          store: {
            load: () =>
              entry.store
                ? entry.store.load()
                : entry.runtime.readPersistedState(),
          },
        }
        : undefined;
    },
  });
  options.executors.push(observation);
  const observations = new ObservationInvocationRegistry([observation]);

  async function listArtifacts(): Promise<PublishedToolArtifact[]> {
    const result: PublishedToolArtifact[] = [];
    for (const [agentId, entry] of runtimes) {
      const state = entry.runtime.snapshot;
      const native = await entry.model.readExecutableModel(state.model!);
      if (native.version.digest !== state.executionModel?.version.digest) {
        continue;
      }
      for (
        const candidate of state.candidates.filter((value) =>
          value.stage === "active"
        )
      ) {
        const verified = await entry.runtime.resolveBoundCandidateSource(
          candidate.id,
          candidate.digest,
        );
        result.push({ agentId, candidate: verified, model: native });
      }
    }
    return result;
  }

  options.executors.push(
    new PublishedToolsBehavior({
      listTargetIds: publishedTargets,
      resolveCallerModel,
      listArtifacts,
    }),
  );
  options.executors.push(
    new ToolReuseBehavior({
      reuseTargetIds: reuseTargets,
      reuseTargetOwners: reuseOwners,
      resolveCallerModel,
      async findArtifact(sourceAgentId, candidateId, digest) {
        const entry = runtimes.get(sourceAgentId);
        if (!entry) return null;
        const state = entry.runtime.snapshot;
        const native = await entry.model.readExecutableModel(state.model!);
        if (native.version.digest !== state.executionModel?.version.digest) {
          return null;
        }
        const candidate = state.candidates.find((value) =>
          value.id === candidateId && value.digest === digest &&
          value.stage === "active"
        );
        if (!candidate) return null;
        const verified = await entry.runtime.resolveBoundCandidateSource(
          candidate.id,
          candidate.digest,
        );
        return { agentId: sourceAgentId, candidate: verified, model: native };
      },
      async importForCaller(callerId, input) {
        const entry = runtimes.get(callerId);
        if (!entry) throw new Error("Unknown admitted importing operator");
        return await entry.runtime.importAdmittedArtifact(input);
      },
    }),
  );

  function ensurePlanner() {
    if (!planOwners.size || plannerRegistered) return;
    const planners = new Map<string, Promise<WorkPlanBehavior>>();
    const planner = (callerId: string) => {
      let pending = planners.get(callerId);
      if (!pending) {
        pending = (async () => {
          const store = (await options.storage.operator(callerId)).plans;
          const executor = new WorkPlanExecutor({
            store,
            invokeTarget: (request) => inbox.invoke(request),
            observeTarget: (request) => observations.invoke(request),
            completion(receipt) {
              const status = (receipt.result as { status?: unknown })?.status;
              if (
                status === "completed" || status === "waiting" ||
                status === "failed"
              ) return status;
              return "failed";
            },
          });
          return new WorkPlanBehavior({
            schemaValidator: options.schemaValidator,
            executor,
            resolveCallerModel,
            planTargetIds: planTargets,
            planTargetOwners: planOwners,
            workTargetIds: workTargets,
            workInvoker: inbox,
            observationInvoker: observations,
            maxConcurrency: 3,
            resourceId: (behavior) =>
              targets.get(behavior.targetNativeId) ?? behavior.targetNativeId,
          });
        })();
        planners.set(callerId, pending);
        void pending.catch(() => {
          if (planners.get(callerId) === pending) planners.delete(callerId);
        });
      }
      return pending;
    };
    options.executors.push(callerWorkPlanPort({
      planTargetIds: planTargets,
      isCaller: (callerId) => runtimes.has(callerId),
      planner,
    }));
    plannerRegistered = true;
  }
  // All targets are now opened, with durable admission guards already bound.
  if (evolution && evolutionPorts) {
    await evolution.recover(evolutionPorts.repositoryId);
  }
  await ensurePlanner();

  /** The host starts durable workers before activating source-selected work. */
  function activateRuntimeDeliveries(): Promise<void> {
    if (closing) {
      return Promise.reject(new Error("Operator workspace is closing"));
    }
    return activation ??= (async () => {
      deliveriesActive = true;
      await conversations.resumeCandidateContinuations();
      evolutionReady = true;
      scheduleEvolution();
    })().catch((error) => {
      deliveriesActive = false;
      activation = undefined;
      throw error;
    });
  }
  function stopAcceptingRuntimeDeliveries(): void {
    closing = true;
    evolutionReady = false;
  }
  async function drainRuntimeDeliveries(): Promise<void> {
    await caseTick;
    await conversations.idle();
    await finalization.idle();
  }

  async function reconcile({ onlyNew = false } = {}) {
    const known = new Set(runtimes.keys());
    const next = await manifest();
    await conversations.reconcileUnits(next);
    registerTargets(next.units);
    pins.clear();
    for (const unit of next.units) {
      if (onlyNew && known.has(unit.model.identity.builderId)) continue;
      await skillInformation.initialize(unit.model);
      await runtimes.get(unit.model.identity.builderId)?.runtime
        .prepareInitialTools();
    }
    await ensurePlanner();
    if (deliveriesActive) await conversations.resumeCandidateContinuations();
  }

  /** Main-space routes read the requester's own policies in its main space. */
  function requesterSpace(state: SystemRuntimeState) {
    return mainExecutionSpace((state.executionModel?.identity ?? state.model)!);
  }

  /** The registered Main as a decider; other runtimes read no branch. */
  function branchDecider(runtime: SystemRuntime) {
    const model = runtime.snapshot.executionModel;
    if (!options.branchAuthority || !model || runtime !== options.primary) {
      return undefined;
    }
    return scopedOperator(
      mainExecutionSpace(model.identity),
      model.identity.builderId,
    );
  }

  const emptyBranchView: RequestBranchMainView = {
    requests: [],
    awaitingPerson: [],
    openRequests: [],
    recorded: [],
  };
  /** One walk of the branches per Main revision: the contexts assembled for
   * one turn (authority and Request openings) share it, so a change is never
   * both decidable and waiting. Decisions walk again (4.8d D2). */
  let branchViewOf:
    | { revision: number; view: Promise<RequestBranchMainView> }
    | undefined;
  function branchView(runtime: SystemRuntime): Promise<RequestBranchMainView> {
    const decider = branchDecider(runtime);
    if (!decider) return Promise.resolve(emptyBranchView);
    const revision = runtime.snapshot.revision;
    if (branchViewOf?.revision !== revision) {
      const view = options.branchAuthority!.mainView(decider);
      branchViewOf = { revision, view };
      void view.catch(() => {
        if (branchViewOf?.view === view) branchViewOf = undefined;
      });
    }
    return branchViewOf.view;
  }

  /** Main's read-only view of the requests waiting for the person: main
   * operators' requests from the same routes as its decidable ones, then the
   * Branch Operators' requests (4.8d D2). */
  async function awaitingPersonContext(runtime: SystemRuntime) {
    const entries: RequestAwaitingPersonEntry[] = [];
    if (runtime !== options.primary) return awaitingPersonView(entries);
    const self = runtime.snapshot.executionModel?.identity.builderId;
    for (const entry of runtimes.values()) {
      for (
        const change of entry.runtime.snapshot.configuration?.changes ?? []
      ) {
        if (
          change.status !== "pending" || change.publishedCommit ||
          !change.caseId || change.requestedBy === self
        ) continue;
        const route = authorityRoute(entry.runtime, change);
        if (route.status === "actor-decision") continue;
        entries.push({
          id: change.id,
          caseId: change.caseId,
          executionSpaceId: MAIN_EXECUTION_SPACE_ID,
          requester: route.requester,
          changeKind: change.kind,
          ...(change.requestedRights
            ? { requestedRights: structuredClone(change.requestedRights) }
            : {}),
          status: route.status,
          ...(route.code ? { code: route.code } : {}),
          requestedAt: change.requestedAt,
        });
      }
    }
    entries.push(...(await branchView(runtime)).awaitingPerson);
    return awaitingPersonView(entries);
  }

  /** Main's design conversation opens branch Requests under the `open-request`
   * act of its own mandate and resumes the main Requests it opened (4.8d D3). */
  function mainRequestOpening(runtime: SystemRuntime) {
    const main = requestOpeningHost({
      primary: options.primary,
      caller: runtime,
      runtimes: () => [...runtimes.values()].map((entry) => entry.runtime),
    });
    const designer = () => {
      const state = runtime.snapshot;
      return state.caseInvocation?.kind === "designer" &&
          state.caseInvocation.scopeId === state.designer?.scopeId &&
          state.executionModel
        ? state
        : undefined;
    };
    return {
      /** A main Request it opened, or an open branch Request: there the
       * instruction reaches the BO as the Main Operator's input (Q3). */
      async resumeRequest(
        command: Extract<ChatDecision, { kind: "resume_request" }>,
      ): Promise<RequestResumeOutcome> {
        const state = designer();
        const branch = (await branchView(runtime)).openRequests.find((
          entry,
        ) => entry.caseId === command.caseId);
        if (!branch) return await main.resumeRequest(command);
        const decider = branchDecider(runtime);
        if (
          !state || !decider || !options.requestOpenings
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "Only Main's design conversation can write to this Request",
            { caseId: command.caseId },
          );
        }
        await options.requestOpenings.writeForMain(command.caseId, {
          resumeId: command.resumeId,
          ...(command.operatorId ? { operatorId: command.operatorId } : {}),
          instruction: command.instruction,
          at: clock.now(),
        }, {
          operator: decider,
          origin: {
            conversationId: state.id,
            designerScopeId: state.designer!.scopeId,
            openingId: command.resumeId,
          },
        });
        return {
          caseId: command.caseId,
          operatorId: command.operatorId ?? branch.operatorId,
          status: branch.status,
        };
      },
      /** The Case a delegated policy names, as its execution space (4.8d D4). */
      recipientSpaceFor(
        caseId: string,
        recipients: readonly string[],
      ): Promise<string> {
        const decider = branchDecider(runtime);
        if (!decider) {
          return Promise.reject(
            new OperatorAuthorityError(
              "INVALID_AUTHORITY_POLICY",
              "Request branches are unavailable on this host",
              { recipientCaseId: caseId },
            ),
          );
        }
        return options.branchAuthority!.recipientSpace(
          decider,
          caseId,
          recipients,
        );
      },
      async requestOpeningContext(): Promise<ChatContext["requestOpening"]> {
        const state = designer();
        if (!state) return undefined;
        const mainRequests = main.mainRequests() ?? [];
        // Main Requests stay discoverable on a host without branch openings.
        return {
          canOpen: !!options.requestOpenings &&
            state.executionModel!.mandate.mayOpenRequests === true,
          requests: (await branchView(runtime)).openRequests,
          releases: options.requestOpenings
            ? await options.requestOpenings.releases()
            : [],
          ...(mainRequests.length ? { mainRequests } : {}),
        };
      },
      async openRequest(
        command: Extract<ChatDecision, { kind: "open_request" }>,
      ): Promise<RequestOpeningOutcome> {
        const state = designer();
        const decider = branchDecider(runtime);
        if (!state || !options.requestOpenings || !decider) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "Only Main's design conversation can open a Request",
          );
        }
        try {
          const view = await options.requestOpenings.openForMain(
            { text: command.objective, source: command.source },
            {
              operator: decider,
              origin: {
                conversationId: state.id,
                designerScopeId: state.designer!.scopeId,
                openingId: command.openingId,
              },
            },
          );
          return {
            status: "opened",
            caseId: view.caseId,
            caseNumber: view.caseNumber,
            executionSpaceId: view.executionSpaceId,
            phase: view.phase,
            ...(view.issues.length ? { issues: view.issues } : {}),
          };
        } catch (error) {
          if (!(error instanceof RequestSpaceError)) throw error;
          return {
            status: "refused",
            code: error.code,
            recovery: error.recovery ?? REQUEST_OPENING_RECOVERY[error.code],
            ...(error.context ? { context: error.context } : {}),
          };
        }
      },
    };
  }

  function authorityRoute(runtime: SystemRuntime, change: PendingChange) {
    return requestAuthorityRoute({
      space: requesterSpace(runtime.snapshot),
      requester: runtime.snapshot,
      change,
      states: [...runtimes.values()].map((entry) => entry.runtime.snapshot),
      root: {
        kind: "main-opener",
        mainOperatorId:
          options.primary.snapshot.executionModel!.identity.builderId,
      },
    });
  }

  async function forwardProposal(
    runtime: SystemRuntime,
    change: PendingChange,
  ) {
    if (
      !change.caseId || !change.requestedBy || change.status !== "pending" ||
      change.publishedCommit
    ) {
      return;
    }
    await deliverRequestAuthorityRoute({
      space: requesterSpace(runtime.snapshot),
      requester: runtime.snapshot,
      change,
      states: [...runtimes.values()].map((entry) => entry.runtime.snapshot),
      mainOperatorId:
        options.primary.snapshot.executionModel!.identity.builderId,
      async receive(operatorId, notice, origin, delivery) {
        await runtimes.get(operatorId)!.runtime.receiveOperatorNotice(
          notice,
          origin,
          delivery,
        );
      },
    });
  }

  async function forwardCompletion(runtime: SystemRuntime, record: Case) {
    if (
      !record.openedFrom.changeId ||
      !["closed-done", "closed-abandoned"].includes(record.status)
    ) return;
    const opener = runtimes.get(record.openedBy)?.runtime;
    if (!opener) {
      throw new OperatorAuthorityError(
        "OPERATOR_OPEN_FAILED",
        "The Request opener is unavailable",
        { caseId: record.id },
      );
    }
    const result =
      runtime.snapshot.messages.filter((message) =>
        message.caseId === record.id && message.role === "assistant"
      ).at(-1)?.text ?? "";
    await opener.receiveOperatorNotice({
      kind: "request-completed",
      caseId: record.id,
      owner: record.owner,
      openedBy: record.openedBy,
      status: record.status as "closed-done" | "closed-abandoned",
      result,
    }, record.openedFrom);
  }

  async function openApprovedOperator(
    runtime: SystemRuntime,
    change: PendingChange,
  ) {
    const completing = change.status === "pending" && !!change.publishedCommit;
    if (
      change.kind !== "operator-creation" ||
      change.status !== "approved" && !completing
    ) {
      return;
    }
    if (
      !change.requestedBy || !change.operator || !change.publishedCommit ||
      change.requestedBy !== runtime.snapshot.executionModel!.identity.builderId
    ) {
      throw new OperatorAuthorityError(
        "OPERATOR_OPEN_FAILED",
        "The approved creation is missing its exact provenance",
        { changeId: change.id },
      );
    }
    await reconcile({ onlyNew: true });
    const source = runtimes.get(change.requestedBy);
    if (!source) {
      throw new OperatorAuthorityError(
        "OPERATOR_OPEN_FAILED",
        "The creation author is not registered",
        { changeId: change.id },
      );
    }
    const name = await requestOperatorSystemName(source.scope, change.id);
    const target = [...runtimes.values()].find((entry) => entry.scope === name);
    if (isTeamOperatorSpec(change.operator)) {
      const model = target?.runtime.snapshot.executionModel;
      const team = model?.operatorTeam;
      if (
        !target || !model || !change.teamOrigin ||
        team?.parentOperatorId !== change.requestedBy ||
        team.requestOwnerId !== change.teamOrigin.operatorId ||
        team.requestId !== change.teamOrigin.requestId ||
        !model.operatorEntries?.some((entry) => entry.kind === "inbox")
      ) {
        throw new OperatorAuthorityError(
          "OPERATOR_OPEN_FAILED",
          "The published team operator or its exact Request provenance is unavailable",
          { changeId: change.id },
        );
      }
      // Its admitted inbox receives work with the existing root Request context.
      // Creating a durable team member never opens a second human conversation.
      return;
    }
    const operator = change.operator;
    // A saved Case alone does not prove its first input was durably accepted.
    // The runtime opening method reconciles that gap with the same receipt ID.
    const model = target?.runtime.snapshot.executionModel;
    const type = model?.caseTypes?.find((entry) =>
      entry.type === "request" &&
      entry.name === operator.requestType.name
    );
    if (
      !target || !model || !type || type.ownerId !== model.identity.builderId ||
      type.maxInvocations !== operator.requestType.maxInvocations
    ) {
      throw new OperatorAuthorityError(
        "OPERATOR_OPEN_FAILED",
        "The published operator or Request type is unavailable",
        { changeId: change.id },
      );
    }
    await target.runtime.openOperatorRequest({
      changeId: change.id,
      caseTypeId: type.id,
      objective: operator.firstRequest.objective,
      openedBy: change.requestedBy,
      openedFrom: {
        conversationId: runtime.snapshot.id,
        ...(change.caseId
          ? { caseId: change.caseId }
          : { designerScopeId: change.designerScopeId }),
      },
    });
  }

  async function commandSource(
    origin: OperatorCommandOrigin,
    actorId: string,
    revalidateCurrent = true,
  ) {
    const reference = origin.businessRevision.__assemblyRuntimeRevision;
    const actor = runtimes.get(actorId);
    if (
      !actor || reference.operatorId !== actorId || !reference.invocationKey
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The source operator scope is unavailable",
        { actorId },
      );
    }
    await options.assertCommandOrigin(origin);
    const store = (await options.storage.operator(actorId)).state;
    const historical = await store.loadRevision(reference.revision);
    const current = await store.load();
    if (
      !historical || !current || historical.id !== reference.systemId ||
      current.id !== reference.systemId ||
      current.executionModel?.identity.builderId !== actorId ||
      historical.executionModel?.identity.builderId !== actorId ||
      historical.executionModel.version.digest !== reference.modelDigest ||
      !historical.caseInvocation ||
      invocationKey(historical.caseInvocation) !== reference.invocationKey ||
      invocationInput(historical)?.id !== origin.inputMessageId ||
      revalidateCurrent &&
        (canonical(
              invocationInput({
                ...current,
                caseInvocation: historical.caseInvocation,
                activeInputMessageId: origin.inputMessageId,
              }, historical.caseInvocation),
            ) !== canonical(invocationInput(historical)) ||
          canonical(current.executionModel?.version) !==
            canonical(historical.executionModel.version))
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The exact original command input or adopted actor contract changed",
        { actorId },
      );
    }
    const localCaseId = historical.caseInvocation.kind === "local"
      ? historical.caseInvocation.caseId
      : undefined;
    if (
      revalidateCurrent && localCaseId &&
      !current.cases?.some((record) =>
        record.id === localCaseId && isOpenCase(record)
      )
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The source Request is no longer open",
        { actorId },
      );
    }
    if (revalidateCurrent) {
      if (!current.model || !current.executionModel) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          "The admitted actor model is unavailable",
          { actorId },
        );
      }
      const actual = await actor.model.readExecutableModel(
        current.model,
        current.executionModel.version.repositoryVersion,
      );
      if (
        actual.identity.builderId !== actorId ||
        canonical(actual.version) !== canonical(current.executionModel.version)
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          "The current actor grant does not match its immutable admitted source",
          { actorId },
        );
      }
      current.executionModel = actual;
    }
    return { historical, current };
  }

  async function refreshCommandCase(
    target: SystemRuntime,
    candidateId?: string,
    changeId?: string,
  ): Promise<void> {
    const selected = target.snapshot;
    const candidate = selected.candidates.find((value) =>
      value.id === candidateId
    );
    const change = selected.configuration?.changes.find((value) =>
      value.id === changeId
    );
    const invocation = candidate
      ? candidateCaseInvocation(selected, candidate)
      : change
      ? changeCaseInvocation(selected, change)
      : undefined;
    const previous = invocation?.kind === "delegated"
      ? invocation.work.caseContext
      : invocation
      ? undefined
      : delegatedCaseContext(selected);
    if (!previous) return;
    const states = await Promise.all(
      [...runtimes.keys()].map(async (id) =>
        (await options.storage.operator(id)).state.load()
      ),
    );
    const owners = states.filter((state): state is SystemRuntimeState =>
      !!state &&
      !!state.cases?.some((record) =>
        record.id === previous.caseId &&
        record.owner === state.executionModel?.identity.builderId
      )
    );
    const owner = owners.length === 1 ? owners[0] : undefined;
    const record = owner?.cases?.find((value) => value.id === previous.caseId);
    const context = owner &&
      caseExecutionContext({
        ...owner,
        caseInvocation: { kind: "local", caseId: previous.caseId },
      });
    if (
      !record || !isOpenCase(record) || !context ||
      !sameCaseIdentity(context, previous)
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The authoritative Request is closed or changed",
        { caseId: previous.caseId },
      );
    }
    await target.refreshCaseContext(context, candidateId, changeId);
  }

  async function assertDelegatedCommand(
    target: SystemRuntime,
    command: Extract<
      OperatorControlCommand,
      { kind: "decide-candidate" | "decide-change" }
    >,
    origin: OperatorCommandOrigin,
  ): Promise<void> {
    const delegated = command.delegated;
    if (!delegated) {
      throw new OperatorAuthorityError(
        "AUTHORITY_OUT_OF_BOUNDS",
        "The delegated actor receipt is absent",
        {},
      );
    }
    const { historical, current } = await commandSource(
      origin,
      delegated.actorId,
    );
    const targetState = target.snapshot;
    const selected = exactDelegatedCommandDecision(
      historical,
      targetState.executionModel!.identity.builderId,
      command,
      origin,
    );
    if (!selected) {
      throw new OperatorAuthorityError(
        "AUTHORITY_REQUEST_STALE",
        "The source revision does not contain this exact started operator decision",
        { actorId: delegated.actorId },
      );
    }
    if (command.kind === "decide-candidate") {
      const message = historical.messages.find((value) =>
        value.id === origin.inspectionMessageId
      );
      const value = message?.observation?.value as {
        decisionReference?: Record<string, unknown>;
      } | undefined;
      const expected = value?.decisionReference;
      if (
        !message || !expected ||
        exactCandidateInspection(historical, expected)?.id !== message.id ||
        expected.operatorId !==
          targetState.executionModel?.identity.builderId ||
        expected.candidateId !== command.input.candidateId ||
        expected.candidateDigest !== command.input.candidateDigest ||
        expected.caseId !== command.input.caseId ||
        selected.kind !== "decide_operator_candidate" ||
        selected.expectedRevision !== expected.expectedRevision ||
        expected.policyId !== delegated.policyId ||
        expected.policyRevision !== delegated.policyRevision ||
        !toolAdmissionDecisionContext(current.executionModel!, [targetState])
          .candidates.some((candidate) =>
            canonical({
              operatorId: candidate.operatorId,
              candidateId: candidate.candidateId,
              candidateDigest: candidate.candidateDigest,
              expectedRevision: candidate.expectedRevision,
              caseId: candidate.caseId,
              policyId: candidate.policyId,
              policyRevision: candidate.policyRevision,
            }) === canonical(expected)
          )
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "The exact current candidate inspection and grant are unavailable",
          { candidateId: command.input.candidateId },
        );
      }
      await refreshCommandCase(target, command.input.candidateId);
    } else {
      const change = targetState.configuration?.changes.find((value) =>
        value.id === command.input.changeId
      );
      const states = await Promise.all(
        [...runtimes.keys()].map(async (id) =>
          (await options.storage.operator(id)).state.load()
        ),
      );
      const decider = change &&
        requestAuthorityRoute({
          space: requesterSpace(targetState),
          requester: targetState,
          change,
          states: states.filter((state): state is SystemRuntimeState => !!state)
            .map((state) =>
              state.executionModel?.identity.builderId === delegated.actorId
                ? current
                : state
            ),
          root: {
            kind: "main-opener",
            mainOperatorId: primary!.identity.builderId,
          },
        }).designatedDecider;
      if (
        !change || !decider || decider.operatorId !== delegated.actorId ||
        decider.policyId !== delegated.policyId ||
        decider.policyRevision !== delegated.policyRevision ||
        change.baseRevision !== command.input.expectedRevision
      ) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "Only the current designated actor may decide this exact change",
          { changeId: command.input.changeId },
        );
      }
      await refreshCommandCase(target, undefined, command.input.changeId);
    }
  }

  /** Every admitted holder can exercise only its exact current policy. */
  function delegatedAuthority(runtime: SystemRuntime) {
    const invalidatedInspectionIds = new Set<string>();
    const invalidateInspections = (
      candidate?: { candidateId: string; operatorId: string },
    ) => {
      for (const message of runtime.snapshot.messages) {
        if (message.observation?.kind !== "candidate-inspection") continue;
        const value = message.observation.value as {
          operatorId?: string;
          candidate?: { id?: string };
          context?: { candidateId?: string; operatorId?: string };
          decisionReference?: { candidateId?: string; operatorId?: string };
        } | undefined;
        const id = value?.candidate?.id ??
          value?.decisionReference?.candidateId ?? value?.context?.candidateId;
        const owner = value?.decisionReference?.operatorId ??
          value?.operatorId ?? value?.context?.operatorId;
        if (
          !candidate ||
          id === candidate.candidateId &&
            (!owner || owner === candidate.operatorId)
        ) invalidatedInspectionIds.add(message.id);
      }
    };
    type CandidateCommand = Extract<ChatDecision, {
      kind: "inspect_operator_candidate" | "decide_operator_candidate";
    }>;
    const reference = (
      command: Pick<
        CandidateCommand,
        | "operatorId"
        | "candidateId"
        | "candidateDigest"
        | "expectedRevision"
        | "caseId"
        | "policyId"
        | "policyRevision"
      >,
      revision = command.expectedRevision,
    ) => ({
      operatorId: command.operatorId,
      candidateId: command.candidateId,
      candidateDigest: command.candidateDigest,
      expectedRevision: revision,
      caseId: command.caseId,
      policyId: command.policyId,
      policyRevision: command.policyRevision,
    });
    const candidateContext = () =>
      toolAdmissionDecisionContext(
        runtime.snapshot.executionModel!,
        [...runtimes.values()].map((entry) => entry.runtime.snapshot),
      );
    const candidateActor = (command: CandidateCommand) => ({
      actorId: runtime.snapshot.executionModel!.identity.builderId,
      policyId: command.policyId,
      policyRevision: command.policyRevision,
    });
    const candidateTarget = (command: CandidateCommand) => {
      const target = runtimes.get(command.operatorId)?.runtime;
      if (!target || target === runtime) {
        throw new OperatorAuthorityError(
          "AUTHORITY_OUT_OF_BOUNDS",
          "The exact recipient operator is unavailable",
          { operatorId: command.operatorId, candidateId: command.candidateId },
        );
      }
      return target;
    };
    const candidateError = (
      error: unknown,
      command: CandidateCommand,
    ): never => {
      if (error instanceof OperatorConversationError) {
        throw new OperatorAuthorityError(
          "AUTHORITY_REQUEST_STALE",
          error.message,
          {
            operatorId: command.operatorId,
            candidateId: command.candidateId,
            reason: error.code,
          },
        );
      }
      if (error instanceof OperatorAuthorityError) {
        throw new OperatorAuthorityError(error.code, error.message, {
          ...error.context,
          operatorId: command.operatorId,
          candidateId: command.candidateId,
        });
      }
      throw error;
    };
    return {
      ...(runtime === options.primary ? mainRequestOpening(runtime) : {}),
      clearCandidateInspection: () => invalidateInspections(),
      candidateDecisionContext: candidateContext,
      inspectCandidate: async (
        command: Extract<ChatDecision, { kind: "inspect_operator_candidate" }>,
      ) => {
        invalidateInspections(command);
        const target = candidateTarget(command);
        try {
          const inspection = await conversations.inspectCandidate({
            agentId: command.operatorId,
            candidateId: command.candidateId,
            candidateDigest: command.candidateDigest,
            expectedRevision: command.expectedRevision,
            caseId: command.caseId,
          }, candidateActor(command));
          return {
            ...inspection,
            decisionReference: reference(command, target.snapshot.revision),
          };
        } catch (error) {
          return candidateError(error, command);
        }
      },
      decideCandidate: async (
        command: Extract<ChatDecision, { kind: "decide_operator_candidate" }>,
        origin?: OperatorCommandOrigin,
      ) => {
        const target = candidateTarget(command);
        if (!origin) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "A delegated command requires its actual native effect origin",
            { candidateId: command.candidateId },
          );
        }
        const { historical } = await commandSource(
          origin,
          runtime.snapshot.executionModel!.identity.builderId,
          false,
        );
        const inspection = exactCandidateInspection(
          historical,
          reference(command),
        );
        if (!inspection) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "Inspect this exact candidate and Request before deciding",
            {
              operatorId: command.operatorId,
              candidateId: command.candidateId,
            },
          );
        }
        const exactOrigin = { ...origin, inspectionMessageId: inspection.id };
        const accepted: Extract<
          OperatorControlCommand,
          { kind: "decide-candidate" }
        > = {
          kind: "decide-candidate",
          input: {
            candidateId: command.candidateId,
            candidateDigest: command.candidateDigest,
            verdict: command.verdict,
            reason: command.reason.trim(),
            caseId: command.caseId,
          },
          delegated: candidateActor(command),
        };
        if (
          !exactDelegatedCommandDecision(
            historical,
            command.operatorId,
            accepted,
            exactOrigin,
          )
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_REQUEST_STALE",
            "The source revision does not contain this exact started candidate decision",
            { candidateId: command.candidateId },
          );
        }
        if (await target.resumeOperatorCommand(accepted, exactOrigin)) return;
        if (invalidatedInspectionIds.has(inspection.id)) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "The last inspection was invalidated; inspect the exact candidate again",
            { candidateId: command.candidateId },
          );
        }
        await commandSource(
          exactOrigin,
          runtime.snapshot.executionModel!.identity.builderId,
        );
        if (
          !candidateContext().candidates.some((candidate) =>
            canonical(reference(candidate)) === canonical(reference(command))
          )
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "The current delegated candidate grant or revision changed",
            {
              operatorId: command.operatorId,
              candidateId: command.candidateId,
            },
          );
        }
        try {
          await conversations.decideCandidate(
            {
              agentId: command.operatorId,
              candidateId: command.candidateId,
              candidateDigest: command.candidateDigest,
              expectedRevision: command.expectedRevision,
              caseId: command.caseId,
              verdict: command.verdict,
              reason: command.reason,
            },
            candidateActor(command),
            exactOrigin,
          );
        } catch (error) {
          candidateError(error, command);
        }
      },
      decisionContext: async () => ({
        policies: structuredClone(
          (runtime.snapshot.executionModel?.operatorAuthorityPolicies ?? [])
            .filter((policy) =>
              policy.holderNativeId ===
                runtime.snapshot.executionModel?.identity.builderId
            ),
        ),
        requests: [
          ...[...runtimes.values()].flatMap((entry) =>
            (entry.runtime.snapshot.configuration?.changes ?? []).filter(
              (change) =>
                change.status === "pending" &&
                !change.publishedCommit &&
                change.requestedBy !==
                  runtime.snapshot.executionModel?.identity.builderId &&
                authorityRoute(entry.runtime, change).designatedDecider
                    ?.operatorId ===
                  runtime.snapshot.executionModel?.identity.builderId,
            ).map((
              { id, requestedBy, caseId, baseRevision, requestedRights, kind },
            ) => ({
              id,
              requestedBy,
              caseId,
              baseRevision,
              requestedRights: structuredClone(requestedRights),
              executionSpaceId: MAIN_EXECUTION_SPACE_ID,
              requester: scopedOperator(
                requesterSpace(entry.runtime.snapshot),
                requestedBy ?? "",
              ),
              changeKind: kind,
            }))
          ),
          ...(await branchView(runtime)).requests,
        ],
        ...(await awaitingPersonContext(runtime)),
      }),
      decide: async (
        command: Extract<ChatDecision, { kind: "decide_operator_change" }>,
        origin?: OperatorCommandOrigin,
      ) => {
        // A covered Branch Operator request lives in its Case's space: the
        // host derives that space from the Case, never from the command. A
        // change the MO already decided is found by its record, so a replay
        // of the command resumes its publication and adoption (A4).
        const mainDecider = branchDecider(runtime);
        const current = mainDecider
          ? await options.branchAuthority!.mainView(mainDecider)
          : emptyBranchView;
        const branch = [...current.requests, ...current.recorded].find((
          entry,
        ) => entry.id === command.changeId);
        if (branch) {
          if (!origin) {
            throw new OperatorAuthorityError(
              "AUTHORITY_OUT_OF_BOUNDS",
              "A delegated command requires its actual native effect origin",
              { changeId: command.changeId },
            );
          }
          await options.branchAuthority!.decide({
            caseId: branch.caseId!,
            command,
            origin,
          });
          return;
        }
        const target = runtimes.get(command.operatorId)?.runtime;
        if (!target) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "The operator is unavailable",
            { changeId: command.changeId },
          );
        }
        if (!origin) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "A delegated command requires its actual native effect origin",
            { changeId: command.changeId },
          );
        }
        const { historical } = await commandSource(
          origin,
          runtime.snapshot.executionModel!.identity.builderId,
          false,
        );
        const accepted: Extract<
          OperatorControlCommand,
          { kind: "decide-change" }
        > = {
          kind: "decide-change",
          input: {
            changeId: command.changeId,
            expectedRevision: command.expectedRevision,
            verdict: command.verdict,
          },
          delegated: {
            actorId: runtime.snapshot.executionModel!.identity.builderId,
            policyId: command.policyId,
            policyRevision: command.policyRevision,
          },
        };
        if (
          !exactDelegatedCommandDecision(
            historical,
            command.operatorId,
            accepted,
            origin,
          )
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_REQUEST_STALE",
            "The source revision does not contain this exact started change decision",
            { changeId: command.changeId },
          );
        }
        if (await target.resumeOperatorCommand(accepted, origin)) return;
        await commandSource(
          origin,
          runtime.snapshot.executionModel!.identity.builderId,
        );
        const change = target.snapshot.configuration?.changes.find((entry) =>
          entry.id === command.changeId
        );
        const decider = change &&
          authorityRoute(target, change).designatedDecider;
        if (
          !decider ||
          decider.operatorId !==
            runtime.snapshot.executionModel!.identity.builderId ||
          decider.policyId !== command.policyId ||
          decider.policyRevision !== command.policyRevision
        ) {
          throw new OperatorAuthorityError(
            "AUTHORITY_OUT_OF_BOUNDS",
            "Only the current designated responsible actor may decide this exact change",
            { changeId: command.changeId },
          );
        }
        // Domain revalidation at effect time remains mandatory, independently of routing.
        await conversations.decideChange({
          agentId: command.operatorId,
          changeId: command.changeId,
          expectedRevision: target.snapshot.revision,
          configurationRevision: command.expectedRevision,
          verdict: command.verdict,
        }, {
          actorId: runtime.snapshot.executionModel!.identity.builderId,
          policyId: command.policyId,
          policyRevision: command.policyRevision,
        }, origin);
      },
    };
  }

  function bindAuthority(runtime: SystemRuntime) {
    runtime.bindOperatorCommandAuthority((command, origin) =>
      assertDelegatedCommand(runtime, command, origin)
    );
    runtime.bindArtifactSourceAuthority(async (publication) => {
      const proof = publication.proof;
      if (proof.kind === "skill-authority") {
        await skillInformation.assertCurrentAuthority(
          proof.authority,
          "install",
        );
      } else if (
        proof.kind === "native-action" ||
        proof.kind === "admitted-model-seed" &&
          publication.source.kind === "tool-draft"
      ) {
        await options.assertArtifactSourceOrigin(publication);
      } else if (
        proof.kind === "admitted-model-seed" &&
        publication.source.kind === "skill-document"
      ) {
        // Startup skill retention has no graph effect. The runtime has already
        // checked exact historical/current source selection, bytes and policy.
        return;
      } else {
        // Production tool reuse is retained by its real native promotion action.
        // A copied modeled-behavior DTO has no independent effect proof here.
        throw new ArtifactSourceError("scope");
      }
    });
    runtime.bindOperatorAuthorityLifecycle({
      ...delegatedAuthority(runtime),
      proposed: (change) => forwardProposal(runtime, change),
      approved: (change) => openApprovedOperator(runtime, change),
      closed: (record) => forwardCompletion(runtime, record),
    });
  }

  // Recover openings and deliveries from durable facts, with idempotent recipient IDs.
  for (const entry of [...runtimes.values()]) {
    for (const change of entry.runtime.snapshot.configuration?.changes ?? []) {
      if (change.status === "approved" && change.kind === "operator-creation") {
        try {
          await openApprovedOperator(entry.runtime, change);
        } catch (error) {
          if (
            !(error instanceof OperatorAuthorityError) ||
            error.code !== "OPERATOR_OPEN_FAILED"
          ) throw error;
          log.error(error.message, errorLogProperties(error));
        }
      }
      if (change.status === "pending") {
        await forwardProposal(entry.runtime, change);
      }
    }
    for (const record of entry.runtime.cases.cases) {
      await forwardCompletion(entry.runtime, record);
    }
  }

  return {
    activateRuntimeDeliveries,
    stopAcceptingRuntimeDeliveries,
    drainRuntimeDeliveries,
    evolution,
    evolutionTargets,
    conversations,
    tickCases,
    cases: PilotCase({
      systemId: () => options.primary.snapshot.id,
      runtimes: () =>
        conversations.snapshot.conversations.filter((entry) =>
          entry.runtimeOwned
        )
          .map((entry) => runtimes.get(entry.agentId)!.runtime),
      onChange: (listener) => conversations.onChange(listener),
    }),
    information,
    runtimeFor(agentId: string) {
      const entry = runtimes.get(agentId);
      return entry ? { runtime: entry.runtime, model: entry.model } : undefined;
    },
    reconcile,
    async adopt(
      input: {
        agentId?: string;
        expectedDigest: string;
        expectedVersion: string;
      },
      adopt: () => Promise<void>,
    ) {
      await conversations.withAdmission(async () => {
        const actor = input.agentId ??
          options.primary.snapshot.executionModel!.identity.builderId;
        const target = runtimes.get(actor);
        if (!target) {
          throw new OperatorConversationError(
            "UNKNOWN_AGENT",
            "Unknown admitted operator",
            404,
          );
        }
        const source = await options.repository.at(input.expectedVersion);
        const prospective = await validateSourceExecutable(
          source,
          projectId,
          target.scope,
        );
        if (
          prospective.version.digest !== input.expectedDigest ||
          prospective.identity.builderId !== actor
        ) {
          throw new OperatorConversationError(
            "MODEL_MISMATCH",
            "The selected operator contract has changed",
            409,
          );
        }
        // Compile the entire prospective registry before the selected store is
        // mutated. Other operators keep their separately admitted contracts.
        await manifest(
          actor === primary.identity.builderId ? prospective : undefined,
          prospective,
        );
        await adopt();
        await reconcile();
      });
    },
    async close() {
      stopAcceptingRuntimeDeliveries();
      await drainRuntimeDeliveries();
      for (const unsubscribe of evolutionSubscriptions.values()) unsubscribe();
      evolutionSubscriptions.clear();
      unsubscribeEvolutionStore?.();
      unbindArtifactSourceAuthority?.();
      evolutionProjection?.close();
      await conversations.dispose();
    },
  };
}
