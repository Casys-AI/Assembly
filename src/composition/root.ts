import { reservedBranchTeamSize } from "../application/governance/request-space-authority-bridge.ts";
import { PostgresRequestNetworkHumanDecision } from "../adapters/out/postgres/request-network-human-decision.ts";
import { createRequestChangeDecision } from "./request-change-decision.ts";
import { RequestNetworkChangeSources } from "../adapters/work/request-network-change-sources.ts";
import { createRequestSupervisionHandler } from "../adapters/in/http/work/request-supervision.ts";
import {
  compareRequestOperatorSources,
  createRequestOperatorDetailsHandler,
} from "../adapters/in/http/work/request-operator-details.ts";
import {
  RELEASE_CATALOGUE_INVALIDATED,
  RELEASE_CATALOGUE_INVALIDATION,
} from "../application/work/saved-systems/notifications.ts";
import {
  createRetainedProviderCallSink,
  PROVIDER_RESOURCE_INVALIDATION,
  PROVIDER_RESOURCES_INVALIDATED,
} from "../application/telemetry/provider-resource-notifications.ts";
import { createRequestRuntimeAdoptionHandler } from "../adapters/in/http/model/request-runtime-adoption.ts";
import { CurrentProviderResources } from "../application/telemetry/current-provider-resources.ts";
import { PostgresProviderResourceReader } from "../adapters/out/postgres/provider-resource-reader.ts";
import { createProviderResourcesHandler } from "../adapters/in/http/telemetry/provider-resources.ts";
import { createCaseBranchHandler } from "../adapters/in/http/model/case-branch.ts";
import { spaceSessionSecret } from "../adapters/in/http/work/space-session.ts";
/** Lot 10 composition root: assembles the atelier from its adapters and use
 * cases. The statements moved verbatim from the former `main.ts` assembly and
 * keep their order: the entry point still runs the toolkit gate, then this
 * assembly, then listen, then the advisory pre-warms, then the ordered stop.
 * Focused stages live in `model-backend.ts`, `model-projections.ts` and
 * `live-graph.ts`; HTTP route registration lives in the `adapters/in/http`
 * Hono app, served through `createHttpServeHandler`. */
import { createRequestSpaceControls } from "./space-controls.ts";
import { createRequestReleasesComposition } from "./request-releases.ts";
import { createRequestSourceAdmissionComposition } from "./request-source-admission.ts";
import { RequestSourceRevisions } from "../application/model/source-admission/revisions.ts";
import { createRequestSourceRevisionsHandler } from "../adapters/in/http/model/request-source-revisions.ts";
import { RequestRuntimeDependencies } from "./request-runtime-dependencies.ts";
import { createRequestOpeningSourcesComposition } from "./request-opening-sources.ts";
import { createRequestSpacesComposition } from "./request-spaces.ts";
import { queryModelRevision } from "../adapters/model/sources/editing/tooling.ts";
import { createSavedSystemsHandler } from "../adapters/in/http/work/saved-systems.ts";
import { createModelTagsHandler } from "../adapters/in/http/work/model-tags.ts";
import {
  createDevelopmentSessionIssuer,
  createSpaceSessionHandler,
} from "../adapters/in/http/work/space-session.ts";
import { createRequestSpaceOpeningHandler } from "../adapters/in/http/work/request-space-openings.ts";
import { ModelVersionEvents } from "../application/model/revisions/version-events.ts";
import { ModelRevisionNotifications } from "../application/model/revisions/notifications.ts";
import { createControlHandler } from "../adapters/in/http/work/control.ts";
import {
  createProviderAgents,
  providerObservation,
} from "./provider-configuration.ts";
import { providerCallContext } from "../adapters/out/llm-providers/provider-call-context.ts";
import { PostgresProviderCallStore } from "../adapters/out/postgres/provider-call-store.ts";
import { normalizeProviderCallObservation } from "../application/telemetry/provider-call.ts";
import { AjvSchemaValidator } from "../infrastructure/ajv-schema-validation.ts";
import { fileURLToPath } from "node:url";
import { DenoRuntimeProvenanceCollector } from "../infrastructure/runtime-provenance.ts";
import {
  PostgresHostStorage,
  safeStoragePort,
} from "../adapters/out/postgres/host-storage.ts";
import { resolveHostSystemId } from "../infrastructure/system-identity.ts";
import { bootstrapPrimaryRuntime } from "./primary-runtime-bootstrap.ts";
import { primaryInformationPort } from "./primary-information.ts";
import { postgresClientConfiguration } from "../adapters/out/postgres/config.ts";
import { openModelBackend } from "./model-backend.ts";
import { createModelRevisionHandler } from "../adapters/in/http/model/revisions.ts";
import { createModelDiagnosticsHandler } from "../adapters/in/http/diagnostics/diagnostics.ts";
import { createModelShapesHandler } from "../adapters/in/http/diagnostics/shapes.ts";
import { openNativeSemanticIndex } from "../adapters/out/oxigraph/runtime.ts";
import { createModelSemanticBackend } from "../adapters/out/oxigraph/backend.ts";
import { SemanticProjectionProcessClient } from "../adapters/out/oxigraph/process-client.ts";
import { ModelContextReader } from "../application/model/consultation/source-reader.ts";
import { SemanticModelContextReader } from "../application/model/consultation/semantic-reader.ts";
import { SourceModelDiagnosticsReader } from "../adapters/model/diagnostics/source.ts";
import { JsonModelDiagnosticMaskStore } from "../adapters/out/filesystem/diagnostic-masks.ts";
import { ModelDiagnosticsService } from "../application/model/diagnostics/service.ts";
import { revalidateModelDiagnostics } from "../application/model/diagnostics/events.ts";
import { broadcastSse as send } from "../infrastructure/http/sse.ts";
import {
  createCaseModelEvents,
  observeCaseWrites,
} from "./case-model-events.ts";
import { DenoToolRunner } from "../adapters/out/sandbox/runner.ts";
import { SystemRuntime } from "../application/work/runtime/system.ts";
import { WorkBudgetService } from "../application/work/budget/service.ts";
import type { DecisionInformationPort } from "../application/work/context/information-ports.ts";
import { loadFreshFrontend } from "../infrastructure/http/frontend.ts";
import { PostgresEvolutionStore } from "../adapters/out/postgres/evolution-store.ts";
import { NativeEvolutionSourceAssessment } from "../adapters/model/evolution/assessment.ts";
import { NativeEvolutionAuthority } from "../adapters/model/evolution/authority.ts";
import { createEvolutionSettingsPreflight } from "../adapters/model/evolution/settings-preflight.ts";
import { GitModelRepository } from "../adapters/out/git/repository.ts";
import { createConversationsHandler } from "../adapters/in/http/work/conversations.ts";
import { createArtifactSourcesHandler } from "../adapters/in/http/work/artifact-sources.ts";
import { createCasesHandler } from "../adapters/in/http/work/cases.ts";
import { SystemClock } from "../infrastructure/clock.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../application/work/behaviors/invocation.ts";
import { readAssemblyEnv } from "../infrastructure/environment.ts";
import {
  errorLogProperties,
  technicalLogger,
} from "../infrastructure/logging.ts";
import {
  composeModelProjections,
  startModelProjectionPrewarms,
} from "./model-projections.ts";
import { createLiveGraph } from "./live-graph.ts";
import { composeMainOperator } from "./main-operator.ts";

const log = technicalLogger("composition");
const schedulerLog = technicalLogger("scheduler");

export interface AssemblyOptions {
  environment?: import("../infrastructure/environment.ts").AssemblyEnvironment;
  dataDir: string;
  servedOrigin: string;
  provider: string;
  agentModel: string | undefined;
  agentEffort: string;
  decisionMaxTokens: number | undefined;
}

export async function assembleAssembly(options: AssemblyOptions) {
  const { dataDir, servedOrigin, provider, agentModel, agentEffort } = options;
  const environment = options.environment ?? "production";
  if (
    environment === "development" &&
    (new URL(servedOrigin).hostname !== "127.0.0.1" ||
      new URL(servedOrigin).protocol !== "http:")
  ) {
    throw new Error("Development must bind to 127.0.0.1");
  }
  const httpPolicy = Object.freeze({ servedOrigin, environment });
  const { decisionMaxTokens } = options;
  // Resolve presentation assets before opening the model or session store.
  const handleFrontend = await loadFreshFrontend();
  await Deno.mkdir(dataDir, { recursive: true });
  const systemId = await resolveHostSystemId(
    dataDir,
    readAssemblyEnv("ASSEMBLY_SYSTEM_ID"),
  );
  const databaseConfiguration = postgresClientConfiguration(
    readAssemblyEnv("ASSEMBLY_DATABASE_URL"),
  );
  const storage = new PostgresHostStorage(databaseConfiguration);
  const providerCalls = new PostgresProviderCallStore(storage.client);
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const retainProviderCall = createRetainedProviderCallSink(
    providerCalls,
    () => storage.scope,
    () =>
      send(
        clients,
        PROVIDER_RESOURCES_INVALIDATED,
        PROVIDER_RESOURCE_INVALIDATION,
      ),
  );
  const agents = createProviderAgents(
    options,
    (key) => Deno.env.get(key),
    async (metadata) => {
      await retainProviderCall(normalizeProviderCallObservation(metadata));
    },
  );
  const diagnosticsNotifications: {
    revalidate?: (version: string) => Promise<void>;
  } = {};
  const {
    model,
    repository,
    tooling,
    projectId,
    project,
    toolkitPackageDirectory,
    store: buildStore,
    buildService,
    buildStorage,
    vault: buildVault,
    retainSavedSystemCommit,
    writerLock,
    close: closeModelBackend,
    createSourceModel,
    createEvolutionRepository,
    artifactSources: artifactSourcesFor,
    artifactSourcesForScope,
    bindArtifactSourceAuthority,
    bindRequestSourcePublication,
    bindScopedSoftwareSourcePublication,
    scopedSoftwareRepository,
    compiler: sourceCompiler,
    requestSourceTarget,
    readRequestSourceProposal,
    sourceWriteLeaseMs,
    queue: sourceWriteQueue,
    writer: sourceWriter,
    stopSourceWriter,
  } = await openModelBackend(
    dataDir,
    {
      storage,
      systemId,
      onRevision: async (version) =>
        await diagnosticsNotifications.revalidate?.(version),
    },
  );
  const runtimeProvenance = new DenoRuntimeProvenanceCollector({
    applicationDirectory: fileURLToPath(new URL("../../", import.meta.url)),
    toolkitPackageDirectory,
    agents: {
      provider: provider === "muse" ? "muse" : "claude",
      // Muse's implicit CLI default is unresolved: the collector records an
      // incomplete identity instead of blocking startup or assuming a model.
      model: agentModel ?? "unknown",
      effort: agentEffort,
      ...(decisionMaxTokens === undefined ? {} : { decisionMaxTokens }),
    },
  });
  const startupProvenance = await runtimeProvenance.collect();
  const { primaryOperatorId, primaryStorage, admittedInitialModel } =
    await bootstrapPrimaryRuntime({
      directory: dataDir,
      storage,
      model,
      hasPersistedRuntimes: async () =>
        (await storage.client.operatorRuntime.count({
          where: {
            ...storage.scope,
            executionSpaceId: storage.executionSpaceId,
          },
        })) > 0,
    });
  const store = primaryStorage.state;
  const caseNumbers = storage.caseNumbers();
  const workBudgetStore = primaryStorage.budget;
  const workBudget = new WorkBudgetService(workBudgetStore);
  const diagnosticsReader = new SourceModelDiagnosticsReader(
    repository,
    projectId,
  );
  const modelDiagnostics = new ModelDiagnosticsService(
    diagnosticsReader,
    await JsonModelDiagnosticMaskStore.open(
      `${dataDir}/model-diagnostic-masks.json`,
    ),
  );
  const projectionPreparer = new SemanticProjectionProcessClient(buildStorage);
  const nativeSemantic = await openNativeSemanticIndex({
    buildCachePath: buildStorage.cachePath,
  });
  const semanticModel = createModelSemanticBackend({
    repositoryId: project.id,
    repository,
    buildService,
    cache: buildStore,
    native: nativeSemantic.native,
    projectionPreparer,
    diagnosticsReader,
  });
  const modelContextReader = new SemanticModelContextReader(
    new ModelContextReader(repository),
    semanticModel,
  );
  const handleDoctorDiagnostics = createModelDiagnosticsHandler(
    modelDiagnostics,
    httpPolicy,
  );
  const handleModelShapes = createModelShapesHandler(semanticModel);
  const handleModelDiagnostics = async (request: Request) =>
    await handleModelShapes(request) ?? await handleDoctorDiagnostics(request);
  const projections = composeModelProjections({
    repository,
    project,
    projectId,
    tooling,
    buildStore,
    toolkitDigest: startupProvenance.provenance.toolkit.digest,
    modelDiagnostics,
  });
  const behaviorExecutors: BehaviorInvocationPort[] = [];
  const informationReader: { current?: DecisionInformationPort } = {};
  const schemaValidator = new AjvSchemaValidator();
  const clock = new SystemClock();
  const requestRunner = new DenoToolRunner();
  const controlComposition = createRequestSpaceControls(storage);
  const releaseComposition = createRequestReleasesComposition({
    storage,
    notifyCatalogue: () =>
      send(
        clients,
        RELEASE_CATALOGUE_INVALIDATED,
        RELEASE_CATALOGUE_INVALIDATION,
      ),
    controls: controlComposition.controls,
    writerLock,
    projectDir: project.projectDir,
    repositoryId: project.id,
    sourceScopeId: storage.sourceScopeId,
    primaryOperatorId,
    buildService,
    vault: buildVault,
    cache: buildStore,
    retainCommit: retainSavedSystemCommit,
  });
  const savedSystemsComposition = releaseComposition.savedSystems;
  const { service: savedSystems } = savedSystemsComposition;
  const requestSourceReader = await GitModelRepository.openReadOnly({
    projectDir: project.projectDir,
    repositoryId: project.id,
    buildService,
  });
  // Bind the ready PRIMARY, scoped Git target and existing durable writer
  // before operator-workspace starts automatic publication recovery.
  const requestSourceAdmission = createRequestSourceAdmissionComposition({
    storage,
    controls: controlComposition.controls,
    repositoryId: project.id,
    reader: () => Promise.resolve(requestSourceReader),
    requestSourceTarget,
    readRequestSourceProposal,
    queue: sourceWriteQueue,
    leaseMs: sourceWriteLeaseMs,
  });
  bindRequestSourcePublication(requestSourceAdmission);
  const requestSourceRevisions = new RequestSourceRevisions({
    repositoryId: project.id,
    access: requestSourceAdmission.access,
    authorization: requestSourceAdmission.authorization,
    targetForProposal: requestSourceAdmission.targetForProposal,
    readProposal: requestSourceAdmission.readProposal,
    queue: sourceWriteQueue,
    writer: sourceWriter,
  });
  const requestDependencies = new RequestRuntimeDependencies({
    hostScope: storage.scope,
    sourceProjectId: projectId,
    agents,
    runner: requestRunner,
    clock,
    schemaValidator,
    runtimeProvenance,
    providerCallContext,
    resolveExecutedModel: (scope, version) => {
      const resolver = requestSpaces.executedModels?.historical;
      if (!resolver) {
        throw new Error(
          "The verified Request executed lineage resolver is unavailable",
        );
      }
      return resolver(scope, version);
    },
    async artifactSourcesForScope(scope) {
      const sources = await artifactSourcesForScope(scope);
      return {
        publishSkill: sources.publishSkill.bind(sources),
        resolveSkill: sources.resolveSkill.bind(sources),
      };
    },
    modelContext: {
      reader: new ModelContextReader({
        current() {
          throw new Error(
            "Request context requires its exact retained source version",
          );
        },
        at: (version) => requestSourceReader.at(version),
      }),
      toolingQuery: async (version, expression) =>
        await queryModelRevision(
          tooling,
          await requestSourceReader.at(version),
          expression,
        ),
      ...(tooling.referenceSites
        ? {
          toolingReferenceSites: async (version: string, elementId: string) => {
            const revision = await requestSourceReader.at(version);
            return {
              sourceDigest: revision.sourceDigest,
              sites: await tooling.referenceSites!(revision.sources, elementId),
            };
          },
        }
        : {}),
      async readSourceRevision(exactModel, scope) {
        if (
          !scope || scope.executionSpaceId === "main" ||
          scope.operatorId !== exactModel.identity.builderId ||
          scope.projectId !== storage.scope.projectId ||
          scope.systemId !== storage.scope.systemId
        ) {
          throw new Error(
            "The actual Request design-source scope is unavailable",
          );
        }
        const { PostgresRequestSpaceStore } = await import(
          "../adapters/out/postgres/request-space-store.ts"
        );
        const row = await storage.client.spaceOpening.findUnique({
          where: {
            projectId_systemId_executionSpaceId: {
              ...storage.scope,
              executionSpaceId: scope.executionSpaceId,
            },
          },
        });
        const opening = row
          ? await new PostgresRequestSpaceStore(storage.client, storage.scope)
            .get(row.id)
          : null;
        if (
          !opening || opening.base?.requestOwner.operatorId !== scope.operatorId
        ) throw new Error("The admitted Request source opening is unavailable");
        const chain = await requestSourceAdmission.admittedSource(opening);
        const revision = await requestSourceReader.at(
          chain.head.source.version,
        );
        if (revision.sourceDigest !== chain.head.sourceDigest) {
          throw new Error("The admitted Request source digest changed");
        }
        return {
          version: revision.version,
          sources: revision.sources,
          requestSource: {
            kind: "admitted-request-source" as const,
            openingId: opening.id,
            executionSpaceId: opening.executionSpaceId,
            admittedSourceVersion: revision.version,
            sourceAdmissionRevision: chain.head.revision,
            sourceAdmissionManifestDigest: chain.head.manifestDigest,
            executedSourceVersion: exactModel.version.repositoryVersion!,
          },
        };
      },
    },
  });
  const requestSources = createRequestOpeningSourcesComposition({
    scope: { ...storage.scope, executionSpaceId: "main" },
    projectDir: project.projectDir,
    repositoryId: project.id,
    buildService,
    repository,
    writerLock,
    savedSystems: savedSystemsComposition,
    requestReleases: releaseComposition,
    dependencies: requestDependencies,
  });
  const evolutionStoreAdapter = new PostgresEvolutionStore(
    storage.client,
    storage.scope,
  );
  const networkChanges = new RequestNetworkChangeSources({
    assertExecuting: (opening, model) =>
      requestSpaces.runtime.assertExecuting(opening, model),
    admittedInspection: releaseComposition.admittedInspection,
    reader: () => Promise.resolve(requestSourceReader),
    prepareApprovedChangeAt: (
      identity,
      revision,
      change,
      digest,
      creationScope,
    ) => {
      const scopedModel = createSourceModel({
        systemQualifiedName: identity.systemQualifiedName,
        ...(creationScope ? { creationScope } : {}),
      });
      return scopedModel.prepareApprovedChangeAt(
        identity,
        revision,
        change,
        digest,
      );
    },
  });
  // The factory getter must observe undefined until Main registration completes.
  const registeredMain: { current?: SystemRuntime } = {};
  // Bound once the event stream exists: what may have moved a Case's model.
  const caseModelChanges: { observe?(caseId: string): void } = {};
  // Keep the existing single native facility and host-owned stop/drain lifecycle.
  const requestSpaces = await createRequestSpacesComposition({
    storage,
    networkChanges,
    mainAuthorityRuntime: () => registeredMain.current,
    hostSourceContext: requestSourceAdmission.hostSourceContext,
    artifactSourcesForScope,
    compareOperatorSources: compareRequestOperatorSources,
    sources: requestSources,
    controlComposition,
    adoption: {
      repositoryId: project.id,
      store: evolutionStoreAdapter,
      reader: () => Promise.resolve(scopedSoftwareRepository),
    },
    softwareEvolution: {
      store: evolutionStoreAdapter,
      repository: scopedSoftwareRepository,
      compiler: sourceCompiler,
      tooling,
      queue: sourceWriteQueue,
      writer: sourceWriter,
      leaseMs: sourceWriteLeaseMs,
      bindPublication: bindScopedSoftwareSourcePublication,
      failed: (error) =>
        schedulerLog.error(
          "Scoped software evolution is blocked",
          errorLogProperties(error),
        ),
    },
    onCaseModelChanged: (caseId) => caseModelChanges.observe?.(caseId),
    nativeOptions: {
      primaryOperatorId,
      // An operator's settled turn in a Case may have moved its branch.
      onRequestContributionSettled: (_delivery, scope) => {
        if (scope.caseId) caseModelChanges.observe?.(scope.caseId);
      },
      connectionString: databaseConfiguration.connectionString,
      queueSchema: "assembly_operator_queue",
      checkpointSchema: "assembly_checkpoints",
      onError: (error) =>
        schedulerLog.error(
          "Operator execution queue is unavailable",
          errorLogProperties(error),
        ),
    },
  });
  // Construct with the same ports as the PostgreSQL witness after resolving
  // the registered Main, before binding conversations and starting native work.
  const prepareRequestNetworkDecision = () => {
    if (!requestSpaces.adoption) {
      throw new Error("Request adoption is unavailable");
    }
    return createRequestChangeDecision({
      repositoryId: project.id,
      access: requestSourceAdmission.access,
      authority: requestSourceAdmission.authorization,
      runtime: requestSpaces.runtime,
      decisionCommit: new PostgresRequestNetworkHumanDecision({
        storage,
        runtime: requestSpaces.runtime,
        binding: requestSpaces.executionBindings,
        main: store,
      }),
      delegation: {
        revalidate(envelope) {
          if (!requestSpaces.branchAuthority) {
            throw new Error("Request branch authority is unavailable");
          }
          return requestSpaces.branchAuthority.revalidateDelegated(envelope);
        },
      },
      creationGrant: {
        revalidate(envelope) {
          if (!requestSpaces.branchAuthority) {
            throw new Error("Request branch authority is unavailable");
          }
          return requestSpaces.branchAuthority.revalidateCreationGrant(
            envelope,
          );
        },
      },
      branchTeamSize: async (opening) =>
        reservedBranchTeamSize(
          (await requestSpaces.executionBindings.read(opening)).admission,
          [],
          opening.caseId,
        ),
      preparation: networkChanges,
      queue: sourceWriteQueue,
      admittedSource: requestSourceAdmission.admittedSource,
      adoption: requestSpaces.adoption,
      publisher: {
        repositoryId: project.id,
        projectId,
        tooling,
        reader: () => Promise.resolve(requestSourceReader),
        writer: sourceWriter,
        branchTeamSize: async (opening) =>
          reservedBranchTeamSize(
            (await requestSpaces.executionBindings.read(opening)).admission,
            [],
            opening.caseId,
          ),
      },
    });
  };
  const nativeRuntime = requestSpaces.nativeRuntime;
  const execution = safeStoragePort(nativeRuntime.execution);
  const dispatch = safeStoragePort(nativeRuntime.dispatch);
  const service = new SystemRuntime({
    caseNumbers,
    clock,
    schemaValidator,
    agents,
    runtimeProvenance,
    providerCallContext,
    workBudget,
    model,
    store,
    stateHistory: store,
    execution,
    dispatch,
    artifactSources: await artifactSourcesFor(primaryOperatorId),
    modelDiagnostics: projections.runtimeModelDiagnostics,
    runner: requestRunner,
    behaviors: new BehaviorInvocationRegistry(behaviorExecutors),
    information: primaryInformationPort(() => informationReader.current),
    onBudgetRefreshError: (error) =>
      schedulerLog.warn(
        "Budget view refresh failed after settlement",
        errorLogProperties(error),
      ),
    onNoticeError: (detail) =>
      log.warn("Creation recovery notice could not be delivered", {
        ...errorLogProperties(detail.error),
        changeId: detail.changeId,
        changeStatus: detail.status,
      }),
  });
  log.info("Initialisation du système…");
  // Cases decided before a restart resume once operator information is ready.
  await service.initialize(admittedInitialModel, {
    resumeContinuations: false,
    resumeCandidateContinuations: false,
  });
  const evolutionStore = safeStoragePort(
    evolutionStoreAdapter,
  );
  const operatorWorkspace = await composeMainOperator({
    primaryOperatorId,
    storage,
    requestSpaces,
    releases: releaseComposition.releases,
    bindArtifactSourceAuthority,
    workspace: {
      execution,
      dispatch,
      artifactSources: artifactSourcesFor,
      evolutionFactory(context) {
        const validateSettings = createEvolutionSettingsPreflight({
          context,
          store: evolutionStore,
          repositoryId: project.id,
        });
        return Promise.resolve({
          repositoryId: project.id,
          store: evolutionStore,
          authority: new NativeEvolutionAuthority({
            projectId,
            repository,
            validateSettings,
          }),
          repository: createEvolutionRepository(
            new NativeEvolutionSourceAssessment({
              projectId,
              validateSettings,
            }),
          ),
        });
      },
      caseNumbers,
      clock,
      schemaValidator,
      primary: service,
      primaryModel: model,
      primaryHistory: store,
      networkImpactRepository: await GitModelRepository.openReadOnly({
        projectDir: project.projectDir,
        repositoryId: project.id,
        buildService,
      }),
      repository,
      tooling,
      createSourceModel,
      modelContextReader,
      agents,
      runtimeProvenance,
      providerCallContext,
      workBudget,
      modelDiagnostics: projections.runtimeModelDiagnostics,
      directory: dataDir,
      executors: behaviorExecutors,
    },
    informationReader,
    registeredMain,
    prepareNetworkDecision: prepareRequestNetworkDecision,
  });
  // A failed resume stays pending in its Case and never stops the server.
  await service.resumeDecidedChanges().catch((error) =>
    log.warn("Decided changes could not resume", errorLogProperties(error))
  );
  // A successful Request write that answers for a Case may have moved it.
  const observingCaseWrites = (
    handler: (request: Request) => Promise<Response | null>,
    applies?: (url: URL) => boolean,
  ) =>
    observeCaseWrites(
      handler,
      (caseId) => caseModelChanges.observe?.(caseId),
      applies,
    );
  const handleConversations = observingCaseWrites(
    createConversationsHandler(
      operatorWorkspace.conversations,
      httpPolicy,
      requestSpaces.conversations,
    ),
    (url) => url.searchParams.get("space") === "requests",
  );
  const handleArtifactSources = createArtifactSourcesHandler({
    conversations: () => operatorWorkspace.conversations.conversations(),
    async sourceContext(conversation) {
      if (
        conversation.runtimeOwned !== true ||
        conversation.agentId !== conversation.nativeId
      ) return null;
      const target = operatorWorkspace.runtimeFor(conversation.nativeId);
      if (
        target?.runtime.snapshot.executionModel?.identity.builderId !==
          conversation.nativeId
      ) return null;
      return {
        ownerId: conversation.nativeId,
        sources: await artifactSourcesFor(conversation.nativeId),
      };
    },
  }, httpPolicy);
  const handleSavedSystems = createSavedSystemsHandler(
    savedSystems,
    httpPolicy,
    releaseComposition.releases,
    { inspect: requestSources.source.inspectRelease },
  );
  const handleModelTags = createModelTagsHandler(
    releaseComposition.releases,
    httpPolicy,
  );
  const handleRequestSourceRevisions = observingCaseWrites(
    createRequestSourceRevisionsHandler(requestSourceRevisions, httpPolicy),
  );
  // Constructing the session adapter issues nothing. Development bootstrap
  // uses the existing modeled-control issuer only when its guarded route runs.
  const handleSpaceSession = createSpaceSessionHandler(
    requestSpaces.controls,
    httpPolicy,
    environment === "development"
      ? createDevelopmentSessionIssuer(requestSpaces.controls, async () => {
        const source = await storage.primarySpaceControl.read();
        if (!source) throw new Error("Current modeled control is unavailable");
        return source.owner.operatorId;
      })
      : undefined,
  );
  const handleRequestSpaceOpenings = observingCaseWrites(
    createRequestSpaceOpeningHandler(
      requestSpaces.openings,
      httpPolicy,
      storage.scope,
    ),
  );
  const handleCases = createCasesHandler(
    operatorWorkspace.cases,
    httpPolicy,
    requestSpaces.conversations,
  );

  const currentProviderResources = new CurrentProviderResources({
    scope: storage.scope,
    mainExecutionSpaceId: storage.executionSpaceId,
    main: () => {
      const snapshot = service.snapshot;
      const model = snapshot.executionModel;
      return model
        ? {
          operatorId: model.identity.builderId,
          runtimeRevision: snapshot.revision,
          modelVersion: {
            digest: model.version.digest,
            repositoryVersion: model.version.repositoryVersion,
          },
        }
        : null;
    },
    cases: requestSpaces.conversations,
    control: requestSpaces.controls,
    reader: new PostgresProviderResourceReader(storage.client),
    clock,
  });
  const handleRequestRuntimeAdoption = requestSpaces.adoption
    ? observingCaseWrites(
      createRequestRuntimeAdoptionHandler(requestSpaces.adoption, httpPolicy),
    )
    : () => Promise.resolve(null);
  const handleProviderResources = createProviderResourcesHandler(
    currentProviderResources,
  );
  const handleRequestSupervision = createRequestSupervisionHandler(
    requestSpaces.supervision,
  );
  const handleRequestOperatorDetails = createRequestOperatorDetailsHandler(
    requestSpaces.operatorDetails,
    httpPolicy,
  );

  projections.projectionReaders.subscribe((status) =>
    send(clients, "model-projection", status)
  );
  // A Case's model is told to its owner's streams only (case-model-version).
  const caseModelEvents = createCaseModelEvents({
    versions: (caseId) => requestSpaces.caseBranchReader.versions(caseId),
    controls: requestSpaces.controls,
    onError: (error, caseId) =>
      log.warn("Case model version notification failed", {
        ...errorLogProperties(error),
        caseId,
      }),
  });
  caseModelChanges.observe = (caseId) => void caseModelEvents.observe(caseId);
  const eventAudience = caseModelEvents.eventAudience;
  const modelVersionEvents = new ModelVersionEvents(
    repository,
    (event, value) => send(clients, event, value),
    projections.modelAttention,
    (error, version) =>
      log.warn("Model attention follow-up failed", {
        ...errorLogProperties(error),
        version,
      }),
  );
  const revisionNotifications = new ModelRevisionNotifications({
    invalidateHead: () => projections.readModelBoardHead.invalidate(),
    announce: async () => {
      await modelVersionEvents.publish();
      // Fix the requested head immediately; expensive projections run in the
      // background and their ready/failure events retain their own version.
      await projections.projectionReaders.requestCurrent(
        await projections.readModelBoardHead(),
      );
    },
    refresh: async (version) => {
      await revalidateModelDiagnostics(
        modelDiagnostics,
        version,
        (event, value) => send(clients, event, value),
      );
      try {
        const report = await semanticModel.validate(version);
        send(clients, "model-shapes", report);
      } catch (error) {
        // Old inline snapshots have no exact recipe. Source diagnostics remain
        // available; never invent a native build identity for that history.
        const code = (error as { code?: unknown })?.code;
        if (code !== "INDEX_PROJECTION_MISSING") {
          log.warn("Model shapes validation failed", errorLogProperties(error));
        }
      }
    },
    onError: (stage, error) =>
      log.warn(`Model ${stage} notification failed`, errorLogProperties(error)),
  });
  diagnosticsNotifications.revalidate = (version) =>
    revisionNotifications.notify(version);
  // Skills are read asynchronously; the chain keeps snapshots in their order.
  let conversationsSent = Promise.resolve();
  operatorWorkspace.conversations.onChange((snapshot) => {
    conversationsSent = conversationsSent
      .then(() => operatorWorkspace.conversations.withReadContext(snapshot))
      .then((enriched) => send(clients, "conversations", enriched))
      .catch((error) =>
        log.warn("Conversations broadcast failed", errorLogProperties(error))
      );
  });
  operatorWorkspace.cases.onChange((snapshot) =>
    send(clients, "cases", snapshot)
  );
  const liveGraph = createLiveGraph({
    service,
    model,
    store,
    repository,
    projectId,
  });
  await liveGraph.refresh();
  liveGraph.attachStateBroadcast(clients);
  liveGraph.startPolling();
  const handleModelRevisions = createModelRevisionHandler({
    security: httpPolicy,
    repository,
    model,
    runtime: service,
    resolveRuntime: (agentId) => operatorWorkspace.runtimeFor(agentId)?.runtime,
    onAdopt: async (input, _runtime, adopt) => {
      await operatorWorkspace.adopt(input, adopt);
      await diagnosticsNotifications.revalidate?.(input.expectedVersion);
    },
    onChange: async () => {
      await liveGraph.refresh();
    },
  });
  const handleControl = createControlHandler(
    service,
    operatorWorkspace.conversations,
    httpPolicy,
  );
  const handleCaseModel = createCaseBranchHandler({
    reader: requestSpaces.caseBranchReader,
    authenticate: (request) =>
      requestSpaces.controls.authenticateSession(spaceSessionSecret(request)),
    revalidate: (controller) => requestSpaces.controls.revalidate(controller),
    handlers: [
      handleModelDiagnostics,
      projections.handleModelAttention,
      projections.handleModelBoard,
      projections.handleAuthorityMatrix,
      projections.handleSourceTokens,
      projections.handleModelViews,
      handleModelRevisions,
    ],
  });
  return {
    environment,
    servedOrigin,
    agents,
    providerCalls,
    providerObservation: providerObservation(agents),
    project,
    service,
    store,
    storage,
    operatorWorkspace,
    modelVersionEvents,
    revisionNotifications,
    clients,
    eventAudience,
    handleFrontend,
    handleModelDiagnostics,
    handleConversations,
    handleCaseModel,
    handleProviderResources,
    handleRequestSupervision,
    handleRequestOperatorDetails,
    currentProviderResources,
    handleArtifactSources,
    handleSavedSystems,
    handleModelTags,
    handleRequestSourceRevisions,
    handleRequestRuntimeAdoption,
    handleSpaceSession,
    handleRequestSpaceOpenings,
    savedSystems,
    requestReleases: releaseComposition.releases,
    requestSpaces,
    prepareRequestNetworkDecision,
    handleCases,
    handleModelRevisions,
    handleControl,
    projections,
    liveGraph,
    nativeRuntime,
    evolutionStore,
    semanticModel,
    nativeSemantic,
    projectionPreparer,
    closeModelBackend,
    stopSourceWriter,
    caseNumbers,
  };
}

export type Assembly = Awaited<ReturnType<typeof assembleAssembly>>;

/** Advisory pre-warms, called by the entry point only after listening. */
export function startAdvisoryPrewarms(assembly: Assembly): void {
  startModelProjectionPrewarms(assembly.projections);
}
