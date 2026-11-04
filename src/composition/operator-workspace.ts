import {
  assertWorkspaceRuntimeAvailable,
  createWorkspaceRegistry,
  requireWorkspacePrimary,
  type WorkspaceRuntime,
} from "../application/work/operators/workspace-registry.ts";
import { createWorkspaceReaders } from "../application/work/operators/workspace-readers.ts";
import {
  createWorkspaceEvolutionTargets,
  finalizeWorkspaceEvolution,
  type WorkspaceEvolutionContext,
  type WorkspaceEvolutionPorts,
} from "../application/work/evolution/workspace-targets.ts";
import { createWorkspaceOperatorAuthority } from "../application/governance/workspace-operator-authority.ts";
import { createWorkspacePlans } from "../application/work/plans/workspace-plans.ts";
import { workspaceMemoryProvenance } from "../application/memory/workspace-memory-provenance.ts";
import { sourceCompilation } from "../adapters/out/sysml-toolkit/compilation/source-executables.ts";

import type { SourceExecutablesCompilationPort } from "../application/model/source-compilation.ts";

import type { ArtifactSourceServicePort } from "../application/work/artifacts/publication.ts";
import { bindHostBackgroundTask } from "../infrastructure/host-background-task.ts";
import type { QueuedArtifactSourcePublication } from "../domain/work/artifacts/source-publication.ts";

import { EvolutionConversationProjection } from "../application/work/operators/evolution-projection.ts";
import {
  EvolutionFinalizationJob,
  operatorEvolutionCommands,
} from "../application/work/runtime/evolution-commands.ts";
import { verifyTaskSourceInputContext } from "../application/work/cases/task-source-input.ts";

import { EvolutionService } from "../application/model/evolution/service.ts";

import { PilotCase } from "../application/work/cases/handlers/case-lifecycle-handler.ts";

import {
  type MainOpener,
  type OpeningCommand,
  type OpeningView,
} from "../domain/work/request-spaces.ts";

import type { OperatorCommandOrigin } from "../application/work/operators/command-delivery.ts";

import type { RequestSpaceAuthorityBridge } from "../application/governance/request-space-authority-bridge.ts";

import type { ChatContext } from "../domain/work/dialogue.ts";

/** Composition of the normal conversation engine for every admitted model unit. */
import type { CaseNumberPort } from "../application/work/cases/ports/out/case-number.port.ts";
import type {
  AgentPort,
  ClockPort,
  ModelDiagnosticsPort,
  ModelPort,
} from "../application/work/runtime/ports.ts";
import type { ModelToolingPort } from "../application/model/tooling.ts";
import { queryModelRevision } from "../application/model/editing/query-revision.ts";
import type { WorkBudgetPort } from "../application/work/budget/ports.ts";
import type { RuntimeProvenancePort } from "../application/work/runtime/provenance.ts";
import type { ProviderCallContextPort } from "../application/telemetry/provider-call.ts";
import { SystemRuntime } from "../application/work/runtime/system.ts";
import type { SchemaValidationPort } from "../application/work/behaviors/schema-validation.ts";
import { OperatorConversations } from "../application/work/operators/conversations.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../application/work/behaviors/invocation.ts";
import { ObservationInvocationRegistry } from "../application/work/behaviors/observation.ts";

import type { ExecutableModel } from "../domain/model/execution/executable-model.ts";

import type { SourceModel } from "../application/model/source-model.ts";

import { type SourceModelOptions } from "../application/model/source-model-options.ts";
import type { ModelRepositoryPort } from "../application/model/repository.ts";
import type { StorePort } from "../application/work/runtime/ports.ts";
import type { NativeExecutionPort } from "../application/work/native-execution/contract.ts";
import type { OperatorExecutionDispatchPort } from "../application/work/operators/execution.ts";
import type { StateHistoryPort } from "../domain/work/history.ts";
import type { MemoryStorePort } from "../application/memory/ports/store.ts";
import type { SkillStorePort } from "../application/skills/ports.ts";
import type { WorkPlanStorePort } from "../application/work/plans/ports.ts";
import { DenoToolRunner } from "../adapters/out/sandbox/runner.ts";
import { WorkArtifactObservationBehavior } from "../application/work/behaviors/artifact-observation.ts";
import { OperatorInboxBehavior } from "../application/work/behaviors/operator-inbox.ts";

import { InformationBehavior } from "../application/work/context/information-behavior.ts";
import { ModelContextInformation } from "../application/model/consultation/context-information.ts";
import { ModelContextReader } from "../application/model/consultation/source-reader.ts";
import { GovernedMemoryPromotionService } from "../application/memory/governed-memory-promotion.ts";
import type { DecisionInformationPort } from "../application/work/context/information-ports.ts";
import type { SkillDownloadPort } from "../application/skills/ports.ts";
import { ContextSkillsService } from "../application/skills/context-skills.ts";
import { HttpsSkillDownloader } from "../adapters/out/http-client/download.ts";
import { SkillsBehavior } from "../application/skills/behavior.ts";
import { bundledSkillReader } from "../adapters/out/filesystem/skill-bundles.ts";

import {
  PublishedToolsBehavior,
  ToolReuseBehavior,
} from "../application/work/behaviors/tool-reuse.ts";
import { SystemClock } from "../infrastructure/clock.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../infrastructure/logging.ts";
import { CaseScheduler } from "../application/work/cases/scheduling.ts";

const log = technicalLogger("scheduler");
const compositionLog = technicalLogger("composition");
import type { NetworkImpactLineageReader } from "../application/model/impact/ports/out/network-impact-lineage-reader.port.ts";
import { NetworkImpactService } from "../application/model/impact/analysis.ts";
import { NetworkImpactConsultation } from "../application/model/impact/consultation.ts";
import type {
  NetworkImpactSkillsEvidenceSource,
  NetworkImpactStateEvidenceSource,
} from "../application/model/impact/evidence-sources.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../domain/model/consultation/network-impact.ts";
import { CompiledNetworkImpactModelReader } from "../application/model/impact/compiled-model-reader.ts";
import {
  LiveNetworkImpactEvidenceReader,
  type LiveNetworkImpactEvidenceSource,
} from "../application/model/impact/live-evidence-reader.ts";

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
  sourceExecutablesCompilation: SourceExecutablesCompilationPort;
  /** Production models share the repository's durable writer. */
  createSourceModel(
    options: Pick<
      SourceModelOptions,
      "systemQualifiedName" | "initialSources"
    >,
  ): SourceModel;
  modelContextReader?:
    import("../application/work/context/information-ports.ts").ModelConsultationReader;
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
  const primary = requireWorkspacePrimary(
    options.primary.snapshot.executionModel,
  );
  const projectId = primary.identity.projectId;
  let evolutionPorts: WorkspaceEvolutionPorts | undefined;
  let evolution: EvolutionService | undefined;
  let evolutionProjection: EvolutionConversationProjection | undefined;
  let unsubscribeEvolutionStore: (() => void) | undefined;
  const runtimes = new Map<string, WorkspaceRuntime>([[
    primary.identity.builderId,
    {
      runtime: options.primary,
      model: options.primaryModel,
      history: options.primaryHistory,
      // Only the historical ASE primary omits its source scope from identity.
      scope: primary.identity.systemQualifiedName ??
        "ASELiveBuilder::liveBuilder",
    },
  ]]);
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
      import("../domain/work/dialogue.ts").SystemRuntimeState[
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
  const finalization = new EvolutionFinalizationJob(
    () =>
      finalizeWorkspaceEvolution({
        ports: evolutionPorts,
        service: evolution,
        runtimes,
      }),
    (error) =>
      log.error("EVOLUTION_FINALIZATION_FAILED", {
        ...errorLogProperties(error),
        code: "EVOLUTION_FINALIZATION_FAILED",
      }),
  );
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
  const pins = new Map<string, Promise<ExecutableModel | null>>();
  const registry = createWorkspaceRegistry({
    projectId,
    primaryId: primary.identity.builderId,
    primary: () => options.primary.snapshot.executionModel!,
    runtimes,
    repository: options.repository,
    compilation: sourceCompilation,
    loadOperatorState: async (id) =>
      (await options.storage.operator(id)).state.load(),
    pins,
    conversations: () => conversations,
    initializeSkills: (model) => skillInformation.initialize(model),
    ensurePlanner: () => ensurePlanner(),
    deliveriesActive: () => deliveriesActive,
  });
  const {
    targets,
    observationOwners,
    reuseOwners,
    planOwners,
    publishedTargets,
    reuseTargets,
    planTargets,
    workTargets,
    informationEntries,
    manifest,
    registerTargets,
    reconcile,
  } = registry;
  const readers = createWorkspaceReaders({
    projectId,
    runtimes,
    pins,
    targets,
    repository: options.repository,
    compilation: sourceCompilation,
  });
  const { resolveCallerModel, ownEvidenceScope, listArtifacts } = readers;
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
        provenance: workspaceMemoryProvenance((ownerId) =>
          runtimes.get(ownerId)?.runtime.snapshot
        ),
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
          compilation: options.sourceExecutablesCompilation,
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
    readSourceRevision: readers.readSourceRevision,
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
        const model = options.createSourceModel({
          systemQualifiedName: unit.systemQualifiedName,
        });
        assertWorkspaceRuntimeAvailable(runtimes, id);
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

  const authority = createWorkspaceOperatorAuthority({
    primary: options.primary,
    primaryModel: primary,
    runtimes,
    storage: options.storage,
    assertCommandOrigin: options.assertCommandOrigin,
    assertArtifactSourceOrigin: options.assertArtifactSourceOrigin,
    assertSkillAuthority: (authority, permission) =>
      skillInformation.assertCurrentAuthority(authority, permission),
    conversations,
    reconcile,
    clock,
    branchAuthority: options.branchAuthority,
    requestOpenings: options.requestOpenings,
    recoveryError: (error) =>
      log.error(error.message, errorLogProperties(error)),
  });
  function bindAuthority(runtime: SystemRuntime) {
    authority.bindAuthority(runtime);
  }
  const { targets: evolutionTargets, validationTargets } =
    createWorkspaceEvolutionTargets({
      runtimes,
      primaryId: primary.identity.builderId,
      projectId,
      repository: options.repository,
      compilation: sourceCompilation,
      workBudget: options.workBudget,
      clock,
      memoryRecords: async (ownerId) =>
        (await memory()).ports.store.list(ownerId),
      evolutionPorts: () => evolutionPorts,
      withAdmission: (operation) => conversations.withAdmission(operation),
      manifest,
      async reconcileRegistry() {
        await registry.publishRegistry();
      },
    });
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

  bindAuthority(options.primary);
  options.primary.bindOperatorRegistry(conversations);
  const admittedManifest = await manifest();
  await conversations.initialize(admittedManifest);
  registerTargets(admittedManifest.units);
  const unbindArtifactSourceAuthority = options.bindArtifactSourceAuthority(
    authority.verifyArtifactSourcePublication,
  );
  for (const unit of admittedManifest.units) {
    await skillInformation.initialize(unit.model);
    // Enqueue source-selected foundation commands before any recovered first
    // work; no native graph runs before the host starts durable workers.
    await runtimes.get(unit.model.identity.builderId)?.runtime
      .prepareInitialTools();
  }

  const inbox = new OperatorInboxBehavior({
    targets,
    resolveCallerModel,
    canContribute: readers.canContribute,
    dispatch: (actor, text, correlation, proof) =>
      conversations.submitWork(actor, text, correlation, proof),
  });
  options.executors.push(inbox);
  const observation = new WorkArtifactObservationBehavior({
    targets: observationOwners,
    workTargets: targets,
    resolveCallerModel,
    target: readers.observationTarget,
  });
  options.executors.push(observation);
  const observations = new ObservationInvocationRegistry([observation]);

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
      findArtifact: readers.findArtifact,
      importForCaller: readers.importForCaller,
    }),
  );

  const workspacePlans = createWorkspacePlans({
    loadStore: async (callerId) =>
      (await options.storage.operator(callerId)).plans,
    now,
    schemaValidator: options.schemaValidator,
    resolveCallerModel,
    isCaller: (callerId) => runtimes.has(callerId),
    planOwners,
    planTargets,
    workTargets,
    targets,
    workInvoker: inbox,
    observationInvoker: observations,
  });
  function ensurePlanner() {
    const planner = workspacePlans.ensure();
    if (planner) options.executors.push(planner);
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

  await authority.recover();

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
    adopt: registry.adopt,
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
