import type { OperatorStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { createRequestRuntimeReaders } from "../../src/adapters/out/postgres/request-runtime-readers.ts";
import { sourceExecutablesCompilation } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { createScopedSoftwareEvolutionComposition } from "../../src/composition/scoped-software-evolution.ts";
import type { OperatorNotice } from "../../src/domain/governance/operator-authority.ts";
import { PostgresRequestNetworkHumanDecision } from "../../src/adapters/out/postgres/request-network-human-decision.ts";
import { RequestCaseConversations } from "../../src/application/work/request-spaces/conversations.ts";
import { RequestNetworkChangeSources } from "../../src/application/work/request-spaces/request-network-change-sources.ts";
import {
  createRequestChangeDecision,
  personRequestChangeDecision,
} from "../../src/composition/request-change-decision.ts";
import { createRequestSpaceDispatcher } from "../../src/application/work/request-spaces/dispatch.ts";
import { RequestSpaceRuntime } from "../../src/application/work/request-spaces/runtime.ts";
import {
  createRequestSpaceAuthorityBridge,
  requestAuthorityLifecycleBindings,
} from "../../src/composition/request-space-authority-bridge.ts";
import { PostgresEvolutionStore } from "../../src/adapters/out/postgres/evolution-store.ts";
import { PostgresRequestAdoptionTransition } from "../../src/adapters/out/postgres/request-adoption-transition.ts";
import { PostgresRequestSourceAdmissionStore } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import { RequestAdoptionContexts } from "../../src/adapters/out/postgres/request-adoption-context.ts";
import { RequestRuntimeAdoptionService } from "../../src/application/model/evolution/request-adoption-service.ts";
import type { BehaviorModelVersion } from "../../src/domain/shared-kernel/behavior-model-version.ts";
/** One focused real-factory host for the separate PG + normal-Toolkit witness.
 * No source admission service is mocked; this uses production composition.
 * Never invoke outside the isolated
 * withPostgresDatabase fixture. */
import assert from "node:assert/strict";
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { queryModelRevision } from "../../src/application/model/editing/query-revision.ts";
import { bundledSkillReader } from "../../src/adapters/out/filesystem/skill-bundles.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { DenoRuntimeProvenanceCollector } from "../../src/infrastructure/runtime-provenance.ts";
import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";
import { createRequestSourceAdmissionComposition } from "../../src/composition/request-source-admission.ts";
import { RequestSourceRevisions } from "../../src/application/model/source-admission/revisions.ts";
import { openModelBackend } from "../../src/composition/model-backend.ts";
import { bootstrapPrimaryRuntime } from "../../src/composition/primary-runtime-bootstrap.ts";
import { createRequestSpaceControls } from "../../src/composition/space-controls.ts";
import { createRequestReleasesComposition } from "../../src/composition/request-releases.ts";
import { createRequestOpeningSourcesComposition } from "../../src/composition/request-opening-sources.ts";
import { createRequestSpacesComposition } from "../../src/composition/request-spaces.ts";
import { composeMainOperator } from "../../src/composition/main-operator.ts";
import { primaryInformationPort } from "../../src/composition/primary-information.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import { RequestRuntimeDependencies } from "../../src/composition/request-runtime-dependencies.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type { ToolDraft } from "../../src/domain/work/records/candidates.ts";
import type { PostgresTestDatabase } from "./postgres.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { createModelProject } from "../../src/adapters/out/filesystem/model-project.ts";
import { toolDraftDigest } from "../../src/application/work/artifacts/catalog.ts";
import type { Candidate } from "../../src/domain/work/records/candidates.ts";
import {
  retainedToolDraft,
  savedSystemRetentionSources,
} from "./saved-system-retention-sources.ts";

export async function openNormalAdmissionWitnessHost(
  database: PostgresTestDatabase,
  options: {
    enableRuntimeAdoption?: boolean;
    /** The actual production scoped software factory/queue participant. */
    enableSoftwareEvolutionWitness?: boolean;
    /** Real native source/owner preparation before Primary's initial capture. */
    beforePrimaryBootstrap?(
      backend: Awaited<ReturnType<typeof openModelBackend>>,
    ): Promise<void>;
    wholeSystemClosure?: boolean;
    tools?: Array<ToolDraft & { id: string }>;
    agent?: AgentPort;
    /** Main Operator provider. When set, Main is composed by the host's own
     * `composeMainOperator` (operator workspace, branch authority, delivery
     * order) instead of a bare runtime. Requires the whole-system closure and
     * the network and adoption witnesses. */
    mainAgents?: AgentPort;
    runner?: DenoToolRunner;
    preparationRunner?: DenoToolRunner;
    networkHost?: string;
    /** Observe settled Request contributions as root.ts does (4.8e: an
     * autonomous creation is decided once its creator's turn settles). */
    observeSettledContributions?: boolean;
    /** PRIMARY's native creation grant (4.8e), mirrored onto each BO. */
    creationPolicy?: NonNullable<
      Parameters<typeof savedSystemRetentionSources>[0]
    >["creationPolicy"];
    enableNetworkChangeWitness?: boolean;
    beforeNetworkDecisionTransaction?: () => Promise<void>;
    networkAdoptionFault?: ConstructorParameters<
      typeof PostgresRequestAdoptionTransition
    >[0]["fault"];
  } = {},
) {
  // openModelBackend honors this user setting; never accidentally operate an
  // inherited non-fixture repository during a dedicated qualification run.
  assert.equal(
    readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR"),
    undefined,
    "qualification requires the backend's fresh isolated project",
  );
  const directory = await Deno.makeTempDir({
    prefix: "request-source-admission-",
  });
  database.registerCleanup(() => Deno.remove(directory, { recursive: true }));
  const storage = new PostgresHostStorage(
    postgresClientConfiguration(database.connectionString, 4, database.schema),
  );
  let backend: Awaited<ReturnType<typeof openModelBackend>> | undefined =
    undefined;
  let stage:
    | Awaited<ReturnType<typeof createRequestSpacesComposition>>
    | undefined = undefined;
  const schemas = {
    queueSchema: `${database.schema}_source_queue`,
    checkpointSchema: `${database.schema}_source_checkpoint`,
  };
  // The fixture runs callbacks in reverse registration order and aggregates
  // failures. A failed native stop must not skip the writer, storage or schemas.
  database.registerCleanup(async () => {
    const admin = new Client({ connectionString: database.connectionString });
    await admin.connect();
    try {
      for (const schema of Object.values(schemas)) {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    } finally {
      await admin.end();
    }
  });
  database.registerCleanup(() => storage.close());
  database.registerCleanup(() => backend?.close());
  database.registerCleanup(() => stage?.nativeRuntime.stop());
  if (options.wholeSystemClosure) {
    await createModelProject({
      root: directory,
      name: "model-project",
      sources: await savedSystemRetentionSources({
        information: true,
        distinctSecondaryInstruction: true,
        ...(options.tools ? { tools: options.tools } : {}),
        ...(options.networkHost ? { networkHost: options.networkHost } : {}),
        ...(options.creationPolicy
          ? { creationPolicy: options.creationPolicy }
          : {}),
      }),
    });
  }
  backend = await openModelBackend(directory, {
    storage,
    systemId: crypto.randomUUID(),
  });
  await options.beforePrimaryBootstrap?.(backend);
  const { primaryOperatorId, primaryStorage, admittedInitialModel } =
    await bootstrapPrimaryRuntime({
      directory,
      storage,
      model: backend.model,
      hasPersistedRuntimes: async () =>
        (await storage.client.operatorRuntime.count({
          where: { ...storage.scope, executionSpaceId: "main" },
        })) > 0,
    });
  assert(admittedInitialModel, "qualification requires a new isolated PRIMARY");
  if (!options.wholeSystemClosure && !await primaryStorage.state.load()) {
    // Store the actual Toolkit-compiled normal model as PRIMARY. This is a
    // controlled initialization fixture; it is not a Main provider call.
    await primaryStorage.state.save({
      id: `qualification-main:${primaryOperatorId}`,
      revision: 0,
      catalogRevision: 0,
      messages: [],
      cases: [],
      candidates: [],
      events: [],
      busy: false,
      phase: "ready",
      provider: "controlled-witness",
      model: structuredClone(admittedInitialModel.identity),
      executionModel: structuredClone(admittedInitialModel),
    }, null);
  }
  const scope = storage.scope;
  let source = await backend.repository.current();
  assert(admittedInitialModel.ownerAuthority?.ownerSource === "modeled");
  assert(
    admittedInitialModel.contextPolicy && admittedInitialModel.memoryPolicy &&
      admittedInitialModel.skillPolicy,
  );
  assert.equal(admittedInitialModel.initialSkills?.length, 1);
  const seed = admittedInitialModel.initialSkills![0];
  const readBundledSkill = bundledSkillReader();
  const seedContent = await readBundledSkill(
    seed.source,
    admittedInitialModel.skillPolicy!.maxSkillBytes,
  );
  const providerObservations: Array<
    {
      caseId: string;
      digest: string;
      version?: string;
      instruction?: string;
      contextVersion?: string;
    }
  > = [];
  const installedSkillPins = new Map<string, BehaviorModelVersion>();
  function observeDecision(context: Parameters<AgentPort["decide"]>[0]) {
    // A Request's sub-operator (4.8e) works by its parent's contribution in
    // that Case at its admitted pin. Its template grants no revision right
    // (no model context), no skill installation and no initial observation.
    if (context.operator?.nativeId !== primaryOperatorId) {
      assert(context.case?.id && context.admittedModelVersion);
      return;
    }
    assert(
      context.case?.id && context.admittedModelVersion &&
        context.modelContext && context.memoryGuidance,
    );
    assert.equal(context.skills?.loaded.length, 1);
    assert.equal(context.skills!.loaded[0].digest, seed.digest);
    assert.equal(context.skills!.loaded[0].content, seedContent);
    const installedPin = context.skills!.loaded[0].source.modelVersion;
    if (options.enableRuntimeAdoption) {
      const original = installedSkillPins.get(context.case.id);
      if (!original) {
        assert.deepEqual(installedPin, context.admittedModelVersion);
        installedSkillPins.set(
          context.case.id,
          structuredClone(installedPin),
        );
      } else {assert.deepEqual(
          installedPin,
          original,
          "Loaded skill installation retains its original model pin after adoption",
        );}
    } else assert.deepEqual(installedPin, context.admittedModelVersion);
    providerObservations.push({
      caseId: context.case.id,
      digest: context.admittedModelVersion.digest,
      version: context.admittedModelVersion.repositoryVersion,
      instruction: context.operator?.instruction,
      contextVersion: context.modelContext.version,
    });
  }
  const agents: AgentPort = {
    label: "Controlled provider; real Request context/skill/memory",
    decide(context) {
      observeDecision(context);
      return options.agent?.decide(context) ?? Promise.resolve({
        kind: "reply",
        text: `Qualification reply ${context.case?.id}`,
      });
    },
    ...(options.agent?.decideBatch
      ? {
        decideBatch(context: Parameters<AgentPort["decide"]>[0]) {
          observeDecision(context);
          return options.agent!.decideBatch!(context);
        },
      }
      : {}),
    review() {
      throw new Error("Review is not part of this witness");
    },
  };
  const clock = { now: () => new Date().toISOString() };
  const provenance = new DenoRuntimeProvenanceCollector({
    applicationDirectory: fileURLToPath(new URL("../../", import.meta.url)),
    toolkitPackageDirectory: backend.toolkitPackageDirectory,
    agents: {
      provider: "controlled-source-admission-witness",
      model: "deterministic-reply",
    },
  });
  const sourceReader = await GitModelRepository.openReadOnly({
    projectDir: backend.project.projectDir,
    repositoryId: backend.project.id,
    buildService: backend.buildService,
  });
  const dependencies = new RequestRuntimeDependencies({
    hostScope: scope,
    sourceProjectId: backend.projectId,
    agents,
    runner: options.runner ?? new DenoToolRunner(),
    clock,
    schemaValidator: new AjvSchemaValidator(),
    runtimeProvenance: provenance,
    readBundledSkill,
    ...(options.enableRuntimeAdoption
      ? {
        resolveExecutedModel: (
          target: Parameters<
            NonNullable<
              ConstructorParameters<
                typeof RequestRuntimeDependencies
              >[0]["resolveExecutedModel"]
            >
          >[0],
          version: BehaviorModelVersion,
        ) => {
          if (!stage?.executedModels) {
            throw new Error(
              "Verified executed-lineage resolver is unavailable",
            );
          }
          return stage.executedModels.historical(target, version);
        },
      }
      : {}),
    artifactSourcesForScope: (target) =>
      backend!.artifactSourcesForScope(target),
    modelContext: {
      reader: new ModelContextReader({
        current() {
          throw new Error("Exact Request source required");
        },
        at: (version) => sourceReader.at(version),
      }),
      toolingQuery: async (version, expression) =>
        await queryModelRevision(
          backend!.tooling,
          await sourceReader.at(version),
          expression,
        ),
      toolingReferenceSites: async (version: string, elementId: string) => {
        const revision = await sourceReader.at(version);
        return {
          sourceDigest: revision.sourceDigest,
          sites: await backend!.tooling.referenceSites!(
            revision.sources,
            elementId,
          ),
        };
      },
      async readSourceRevision(model, requestedScope) {
        if (options.enableSoftwareEvolutionWitness) {
          assert(requestedScope && requestedScope.executionSpaceId !== "main");
          const openingRow = await storage.client.spaceOpening.findUnique({
            where: {
              projectId_systemId_executionSpaceId: {
                ...scope,
                executionSpaceId: requestedScope.executionSpaceId,
              },
            },
          });
          const opening = openingRow
            ? await new PostgresRequestSpaceStore(storage.client, scope).get(
              openingRow.id,
            )
            : null;
          assert(
            opening &&
              opening.base?.requestOwner.operatorId ===
                model.identity.builderId,
          );
          const chain = await sourceAdmission.admittedSource(opening);
          const revision = await sourceReader.at(chain.head.source.version);
          assert.equal(revision.sourceDigest, chain.head.sourceDigest);
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
              executedSourceVersion: model.version.repositoryVersion!,
            },
          };
        }
        const revision = await sourceReader.at(
          model.version.repositoryVersion!,
        );
        return { version: revision.version, sources: revision.sources };
      },
    },
  });
  const controls = createRequestSpaceControls(storage);
  const releases = createRequestReleasesComposition({
    storage,
    controls: controls.controls,
    writerLock: backend.writerLock,
    projectDir: backend.project.projectDir,
    repositoryId: backend.project.id,
    sourceScopeId: storage.sourceScopeId,
    primaryOperatorId,
    buildService: backend.buildService,
    vault: backend.vault,
    cache: backend.store,
    retainCommit: backend.retainSavedSystemCommit,
  });
  const openingSources = createRequestOpeningSourcesComposition({
    scope: { ...scope, executionSpaceId: "main" },
    projectDir: backend.project.projectDir,
    repositoryId: backend.project.id,
    buildService: backend.buildService,
    repository: backend.repository,
    writerLock: backend.writerLock,
    savedSystems: releases.savedSystems,
    requestReleases: releases,
    dependencies,
  });
  const workerErrors: unknown[] = [];
  const settledCases: string[] = [];
  const deliveryFailures: Array<{ deliveryId: string; error: unknown }> = [];
  let mainRuntime: SystemRuntime | undefined;
  if (
    options.mainAgents &&
    (!options.wholeSystemClosure || !options.enableNetworkChangeWitness ||
      !options.enableRuntimeAdoption)
  ) {
    throw new Error(
      "The composed Main requires the whole-system, network and adoption witnesses",
    );
  }
  // Same holders as the host composition root: set once Main registers.
  const registeredMain: { current?: SystemRuntime } = {};
  const informationReader: { current?: DecisionInformationPort } = {};
  const behaviorExecutors: BehaviorInvocationPort[] = [];
  const evolutionStore =
    options.enableRuntimeAdoption || options.enableSoftwareEvolutionWitness
      ? new PostgresEvolutionStore(storage.client, scope)
      : undefined;
  const networkChanges = options.enableNetworkChangeWitness
    ? new RequestNetworkChangeSources({
      assertExecuting: (opening, model) =>
        stage!.runtime.assertExecuting(opening, model),
      admittedInspection: releases.admittedInspection,
      reader: () => Promise.resolve(sourceReader),
      // The host's own wiring (root.ts): a team preview reads creation
      // policies in the requester's branch scope.
      prepareApprovedChangeAt: (
        identity,
        revision,
        change,
        digest,
        creationScope,
      ) =>
        backend!.createSourceModel({
          systemQualifiedName: identity.systemQualifiedName,
          ...(creationScope ? { creationScope } : {}),
        })
          .prepareApprovedChangeAt(identity, revision, change, digest),
    })
    : undefined;
  const softwareDiagnostics: unknown[] = [];
  stage = await createRequestSpacesComposition({
    storage,
    ...(options.enableSoftwareEvolutionWitness
      ? {
        softwareEvolution: {
          store: evolutionStore!,
          repository: backend.scopedSoftwareRepository,
          compiler: backend.compiler,
          tooling: backend.tooling,
          writer: backend.writer,
          queue: backend.queue,
          leaseMs: backend.sourceWriteLeaseMs,
          bindPublication: backend.bindScopedSoftwareSourcePublication,
          failed: (error: unknown) => {
            softwareDiagnostics.push(error);
          },
        },
      }
      : {}),
    networkChanges,
    ...(options.mainAgents
      ? {
        mainAuthorityRuntime: () => registeredMain.current,
        hostSourceContext: (...args) =>
          sourceAdmission.hostSourceContext(...args),
      }
      : options.enableNetworkChangeWitness
      ? { mainAuthorityRuntime: () => mainRuntime }
      : {}),
    sources: openingSources,
    controlComposition: controls,
    ...(options.enableRuntimeAdoption
      ? {
        adoption: {
          repositoryId: backend.project.id,
          store: evolutionStore!,
          fault: options.networkAdoptionFault,
          reader: () =>
            Promise.resolve(
              options.enableSoftwareEvolutionWitness
                ? backend!.scopedSoftwareRepository
                : sourceReader,
            ),
        },
      }
      : {}),
    nativeOptions: {
      connectionString: database.connectionString,
      ...schemas,
      // As root.ts does: the host observes settled Request contributions.
      ...(options.observeSettledContributions
        ? {
          onRequestContributionSettled: (
            _delivery: unknown,
            scope: { caseId?: string },
          ) => {
            if (scope.caseId) settledCases.push(scope.caseId);
          },
        }
        : {}),
      onError: (error) => {
        workerErrors.push(error);
      },
    },
  });
  const sourceAdmission = createRequestSourceAdmissionComposition({
    storage,
    controls: controls.controls,
    repositoryId: backend.project.id,
    reader: () => Promise.resolve(sourceReader),
    requestSourceTarget: backend.requestSourceTarget,
    readRequestSourceProposal: backend.readRequestSourceProposal,
    queue: backend.queue,
    leaseMs: backend.sourceWriteLeaseMs,
  });
  backend.bindRequestSourcePublication({
    participant: sourceAdmission.participant,
    resolver: sourceAdmission.resolver,
  });
  const revisions = new RequestSourceRevisions({
    repositoryId: backend.project.id,
    access: sourceAdmission.access,
    authorization: sourceAdmission.authorization,
    targetForProposal: sourceAdmission.targetForProposal,
    readProposal: sourceAdmission.readProposal,
    queue: backend.queue,
    writer: backend.writer,
  });
  let retainedTool: Candidate | undefined;
  let toolTests = 0;
  backend.bindArtifactSourceAuthority(async (publication) => {
    if (mainRuntime && publication.target.executionSpaceId === "main") {
      await mainRuntime.assertArtifactSourcePublication(publication);
      return;
    }
    assert.notEqual(
      publication.target.executionSpaceId,
      "main",
      "this witness has no Main source-retention effect",
    );
    await stage!.assertArtifactSourcePublication(publication);
  });
  const readyStage = stage;
  let selectedDispatch = readyStage.dispatchAccepted;
  if (options.wholeSystemClosure) {
    mainRuntime = new SystemRuntime({
      store: primaryStorage.state,
      stateHistory: primaryStorage.state,
      execution: readyStage.nativeRuntime.execution,
      dispatch: readyStage.nativeRuntime.dispatch,
      caseNumbers: storage.caseNumbers(),
      artifactSources: await backend.artifactSources(primaryOperatorId),
      model: backend.model,
      schemaValidator: new AjvSchemaValidator(),
      clock,
      workBudget: new WorkBudgetService(primaryStorage.budget),
      runtimeProvenance: provenance,
      ...(options.mainAgents
        ? {
          behaviors: new BehaviorInvocationRegistry(behaviorExecutors),
          information: primaryInformationPort(() => informationReader.current),
        }
        : {}),
      agents: options.mainAgents ?? {
        label: "Initial tool retention fixture; no provider decisions",
        decide() {
          throw new Error("Initial-tool setup must not call a provider");
        },
        review() {
          throw new Error(
            "Human initial-tool admission needs no provider review",
          );
        },
      },
      runner: {
        async test(selected) {
          toolTests++;
          const actual = {
            name: selected.name,
            description: selected.description,
            kind: selected.kind,
            code: selected.code,
          };
          if (!options.tools) assert.deepEqual(actual, retainedToolDraft);
          else {assert(options.tools.some((draft) =>
              draft.name === selected.name &&
              draft.description === selected.description &&
              draft.kind === selected.kind && draft.code === selected.code
            ));}
          if (options.preparationRunner) {
            return await options.preparationRunner.test(selected);
          }
          return {
            passed: true,
            checks: [{
              name: "controlled fixture candidate check",
              passed: true,
              detail:
                "Qualifies source retention and admission wiring, not tool behavior or sandbox isolation",
            }],
          };
        },
        run() {
          throw new Error("Retention setup never invokes the tool");
        },
      },
    });
    mainRuntime.bindArtifactSourceAuthority((publication) =>
      readyStage.nativeRuntime.assertArtifactSourceOrigin(publication)
    );
    await mainRuntime.initialize(undefined, {
      resumeContinuations: false,
      resumeCandidateContinuations: false,
    });
  }
  /** The production network decision over this host's real ports. */
  function createNetworkDecision(
    runtime = readyStage.runtime,
    adoption = readyStage.adoption,
  ) {
    if (!networkChanges || !adoption) {
      throw new Error(
        "Network witness requires explicit network and adoption options",
      );
    }
    return createRequestChangeDecision({
      repositoryId: backend!.project.id,
      access: sourceAdmission.access,
      authority: sourceAdmission.authorization,
      runtime,
      decisionCommit: new PostgresRequestNetworkHumanDecision({
        storage,
        runtime,
        binding: readyStage.executionBindings,
        beforeAuthorityLock: options.beforeNetworkDecisionTransaction,
        main: primaryStorage.state,
      }),
      delegation: {
        revalidate(envelope) {
          if (!readyStage.branchAuthority) {
            throw new Error("Request branch authority is unavailable");
          }
          return readyStage.branchAuthority.revalidateDelegated(envelope);
        },
      },
      creationGrant: {
        revalidate(envelope) {
          if (!readyStage.branchAuthority) {
            throw new Error("Request branch authority is unavailable");
          }
          return readyStage.branchAuthority.revalidateCreationGrant(envelope);
        },
      },
      branchTeamSize: async (opening) =>
        (await readyStage.executionBindings.read(opening)).admission
          .permissions.operatorIds.length - 1,
      preparation: networkChanges,
      queue: backend!.queue,
      admittedSource: sourceAdmission.admittedSource,
      adoption,
      publisher: {
        repositoryId: backend!.project.id,
        projectId: backend!.projectId,
        tooling: backend!.tooling,
        reader: () => Promise.resolve(sourceReader),
        writer: backend!.writer,
        branchTeamSize: async (opening) =>
          (await readyStage.executionBindings.read(opening)).admission
            .permissions.operatorIds.length - 1,
      },
    });
  }
  let workspace: Awaited<ReturnType<typeof composeMainOperator>> | undefined;
  if (options.mainAgents) {
    const main = mainRuntime!;
    workspace = await composeMainOperator({
      primaryOperatorId,
      storage,
      requestSpaces: {
        ...readyStage,
        dispatchAccepted: (...args) => selectedDispatch(...args),
      },
      releases: releases.releases,
      bindArtifactSourceAuthority: backend.bindArtifactSourceAuthority,
      workspace: {
        sourceExecutablesCompilation,
        execution: readyStage.nativeRuntime.execution,
        dispatch: readyStage.nativeRuntime.dispatch,
        artifactSources: backend.artifactSources,
        caseNumbers: storage.caseNumbers(),
        clock,
        schemaValidator: new AjvSchemaValidator(),
        primary: main,
        primaryModel: backend.model,
        primaryHistory: primaryStorage.state,
        repository: backend.repository,
        tooling: backend.tooling,
        createSourceModel: backend.createSourceModel,
        agents: options.mainAgents,
        runtimeProvenance: provenance,
        directory,
        executors: behaviorExecutors,
      },
      informationReader,
      registeredMain,
      prepareNetworkDecision: createNetworkDecision,
    });
    const composed = workspace;
    database.registerCleanup(async () => {
      composed.stopAcceptingRuntimeDeliveries();
      await readyStage.nativeRuntime.stop();
      await main.idle();
      await composed.close();
    });
  } else {await readyStage.nativeRuntime.start(async (delivery, resolved) => {
      try {
        await selectedDispatch(
          delivery,
          resolved,
          (input) =>
            mainRuntime
              ? mainRuntime.processAcceptedContribution(input)
              : Promise.reject(new Error("Unexpected Main delivery")),
        );
      } catch (error) {
        if (deliveryFailures.length < 8) {
          deliveryFailures.push({ deliveryId: delivery.id, error });
        }
        throw error;
      }
    });}
  if (mainRuntime) {
    const runtime = mainRuntime;
    // initialize() restores the model; the normal workspace separately starts
    // source-selected preparation through this production method. Reuse that
    // same command here, after bindings and the shared worker are ready.
    const toolDrafts = options.tools ??
      [{ id: "saved-reader-v1", ...retainedToolDraft }];
    assert.equal(
      runtime.snapshot.executionModel!.initialTools?.length ?? 0,
      toolDrafts.length,
    );
    const wait = async (
      phase: string,
      ready: () => boolean | Promise<boolean>,
      inspectSettledDecision = false,
    ) => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (await ready()) return;
        if (workerErrors.length) {
          throw new AggregateError(
            workerErrors,
            "Initial-tool native fixture failed",
          );
        }
        if (inspectSettledDecision) {
          const terminal = await storage.client.executionContribution.findFirst(
            {
              where: {
                ...scope,
                executionSpaceId: "main",
                kind: "command",
                contributionId: { startsWith: "initial-admission:" },
                status: { in: ["failed", "refused", "completed"] },
              },
              select: { contributionId: true, status: true },
            },
          );
          const outcome = runtime.snapshot.events.some((event) =>
            event.operatorCommandOutcome && event.label === "decide-candidate"
          );
          if (terminal && ["failed", "refused"].includes(terminal.status)) {
            throw new Error(
              `Initial-tool admission command ${terminal.status}; phase: ${phase}`,
            );
          }
          if (terminal?.status === "completed" || outcome) {
            const pending = await storage.client.executionContribution.count({
              where: {
                ...scope,
                executionSpaceId: "main",
                status: { in: ["queued", "running"] },
              },
            });
            if (pending === 0) {
              throw new Error(
                `Initial-tool decision settled without activation; phase: ${phase}`,
              );
            }
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      throw new Error(
        `Initial-tool native fixture did not settle within its bounded deadline; phase: ${phase}`,
      );
    };
    for (const [index, draft] of toolDrafts.entries()) {
      await runtime.prepareInitialTools();
      assert.equal(
        Object.keys(runtime.snapshot.initialToolsPreparations ?? {}).length,
        index + 1,
      );
      await wait(
        "preparation",
        () =>
          runtime.snapshot.candidates.some((candidate) =>
            candidate.initialToolSeed?.id === draft.id &&
            candidate.stage === "awaiting-admission"
          ),
      );
      // awaiting-admission is emitted before the source promotion checkpoint and
      // its preparation Case settle. Match the existing heavy fixture's drain
      // before creating the separately scoped initial-admission command.
      await runtime.idle();
      await wait(
        "preparation-drain",
        async () =>
          await storage.client.executionContribution.count({
            where: {
              ...scope,
              executionSpaceId: "main",
              status: { in: ["queued", "running"] },
            },
          }) === 0,
      );
      const prepared = await primaryStorage.state.load();

      assert(prepared);
      const pending: Candidate | undefined = prepared.candidates.find((
        candidate,
      ) => candidate.initialToolSeed?.id === draft.id);
      assert(pending);
      assert.equal(prepared.revision, runtime.snapshot.revision);
      assert.equal(prepared.busy, false);
      assert.equal(pending.stage, "awaiting-admission");
      assert(
        prepared.cases?.some((record) =>
          record.id === pending.caseId && record.status === "closed-done"
        ),
      );
      assert(
        Object.values(prepared.initialToolsPreparations ?? {}).every((intent) =>
          intent.phase === "terminal"
        ),
      );
      const pendingPromotion = pending.promotionExecution;
      assert(pendingPromotion?.threadId);
      const promotions =
        (await readyStage.nativeRuntime.execution.inspect(primaryOperatorId))
          .filter((snapshot) =>
            snapshot.identity.purpose === "promotion" &&
            snapshot.threadId === pendingPromotion.threadId &&
            snapshot.identity.subjectId === pendingPromotion.subjectId
          );
      assert.equal(promotions.length, 1);
      const promotion = promotions[0];
      assert.equal(promotion.status, "waiting");
      assert(
        promotion.initialAdmissionSource && promotion.runId &&
          promotion.checkpointNamespace && promotion.checkpointId,
      );
      assert.equal(promotion.identity.scope.kind, "request");
      assert.equal(promotion.identity.scope.scopeId, pending.caseId);
      assert.equal(promotion.modelDigest, pending.promotionModelDigest);
      assert.deepEqual(promotion.unsettledEffects, []);
      assert.equal(pending.admission, undefined);

      await runtime.decideCandidate({
        candidateId: pending.id,
        candidateDigest: pending.digest,
        verdict: "approve",
        reason:
          "Explicit isolated fixture command retains this exact tested initial tool",
      });
      await wait(
        "decision",
        () =>
          runtime.snapshot.candidates.some((candidate) =>
            candidate.id === pending.id && candidate.stage === "active"
          ),
        true,
      );

      await runtime.idle();
      await wait(
        "drain",
        async () =>
          await storage.client.executionContribution.count({
            where: {
              ...scope,
              executionSpaceId: "main",
              status: { in: ["queued", "running"] },
            },
          }) === 0,
      );
      retainedTool = structuredClone(
        runtime.snapshot.candidates.find((candidate) =>
          candidate.id === pending.id
        )!,
      );
      assert(retainedTool.sourceBinding && retainedTool.admission);
      assert.equal(
        retainedTool.admission.candidateDigest,
        await toolDraftDigest({
          name: draft.name,
          description: draft.description,
          kind: draft.kind,
          code: draft.code,
        }),
      );
    }
    assert.equal(toolTests, toolDrafts.length);
    // The fixture's immutable Main/source baseline begins after actual native
    // preparation, explicit admission and durable source activation complete.
    source = await backend.repository.current();
    assert.equal(
      runtime.snapshot.executionModel!.version.repositoryVersion,
      source.version,
    );
  }
  return {
    storage,
    backend,
    evolutionStore,
    softwareDiagnostics,
    coldSoftwareRuntimeForWitness() {
      if (
        !options.enableSoftwareEvolutionWitness || !evolutionStore ||
        !readyStage.executedModels
      ) throw new Error("Explicit software evolution composition is required");
      const openings = new PostgresRequestSpaceStore(storage.client, scope),
        journal = new PostgresRequestSourceAdmissionStore(storage.client);
      const software = createScopedSoftwareEvolutionComposition({
        storage,
        store: evolutionStore,
        openings,
        journal,
        bindings: readyStage.executionBindings,
        sqlAdmissions: controls.sqlAdmissions,
        native: readyStage.nativeRuntime,
        dependencies: dependencies.create,
        repository: backend!.scopedSoftwareRepository,
        compiler: backend!.compiler,
        tooling: backend!.tooling,
        writer: backend!.writer,
        queue: backend!.queue,
        leaseMs: backend!.sourceWriteLeaseMs,
        restore: async (opening) => {
          await cold.restoreSoftwareEvolution(opening);
        },
        failed: (error) => {
          softwareDiagnostics.push(error);
        },
      });
      const cold = new RequestSpaceRuntime({
        ...createRequestRuntimeReaders(storage.client),
        onNoticeError: () => {},
        storage,
        native: {
          scope: readyStage.nativeRuntime.ledger.options.scope,
          forCaseSpace: readyStage.nativeRuntime.forCaseSpace,
        },
        openings,
        source: openingSources.source,
        branches: openingSources.branches,
        admissions: controls.admissions,
        dependencies: dependencies.create,
        executionBindings: readyStage.executionBindings,
        resolveExecutionModel: readyStage.executedModels.current,
        softwareEvolutionFactory: software.factory,
      });
      return cold;
    },
    coldAuthorityRuntimeForWitness() {
      if (
        !options.enableNetworkChangeWitness || !mainRuntime || !networkChanges
      ) throw new Error("Real Main and network witness are required");
      const openings = new PostgresRequestSpaceStore(storage.client, scope);
      const bridge = createRequestSpaceAuthorityBridge({
        storage,
        openings,
        bindings: readyStage.executionBindings,
        main: () => mainRuntime,
      });
      return new RequestSpaceRuntime({
        ...createRequestRuntimeReaders(storage.client),
        onNoticeError: () => {},
        storage,
        native: {
          scope: readyStage.nativeRuntime.ledger.options.scope,
          forCaseSpace: readyStage.nativeRuntime.forCaseSpace,
        },
        openings,
        source: openingSources.source,
        branches: openingSources.branches,
        admissions: controls.admissions,
        dependencies: dependencies.create,
        executionBindings: readyStage.executionBindings,
        networkChanges,
        ...(readyStage.executedModels
          ? {
            resolveExecutionModel: readyStage.executedModels.current,
            resolveTeamModels: readyStage.executedModels.currentModels,
            resolveTeamCreationModels: readyStage.executedModels.creationModels,
          }
          : {}),
        ...requestAuthorityLifecycleBindings(bridge),
      });
    },
    async mainAuthorityNotices(caseId: string) {
      if (!options.enableNetworkChangeWitness || !mainRuntime) {
        throw new Error("Real Main is unavailable for this witness");
      }
      const persisted = await primaryStorage.state.load();
      if (!persisted || persisted.id !== mainRuntime.snapshot.id) {
        throw new Error("Persisted Main is unavailable");
      }
      return persisted.messages.map((message) => message.operatorNotice)
        .filter((
          notice,
        ): notice is Extract<
          OperatorNotice,
          { kind: "authority-escalation" }
        > =>
          notice?.kind === "authority-escalation" && notice.caseId === caseId
        )
        .map((notice) => structuredClone(notice));
    },
    stage: readyStage,
    /** The composed Main workspace (`mainAgents`); Main is
     * `workspace.runtimeFor(primaryOperatorId)`. */
    workspace,
    controls,
    releases,
    openingSources,
    sourceAdmission,
    revisions,
    dependencies,
    /** Explicit witness-only construction; production route remains unbound
     * until the native R1 successor transition is complete. */
    networkDecisionForWitness: createNetworkDecision,
    networkConversationsForWitness(
      runtime = readyStage.runtime,
      adoption = readyStage.adoption,
    ) {
      return new RequestCaseConversations({
        scope,
        control: controls.controls,
        store: new PostgresRequestSpaceStore(storage.client, scope),
        admissions: controls.admissions,
        runtime,
        changeDecision: personRequestChangeDecision(
          createNetworkDecision(runtime, adoption),
        ),
      });
    },
    useRuntimeForWitness(runtime: RequestSpaceRuntime<OperatorStorage>): void {
      if (!options.enableRuntimeAdoption) {
        throw new Error(
          "Runtime selection is limited to the explicit adoption witness",
        );
      }
      selectedDispatch = createRequestSpaceDispatcher(scope, runtime);
    },
    adoptionForRuntime(runtime: RequestSpaceRuntime<OperatorStorage>) {
      if (!evolutionStore) {
        throw new Error("Adoption is limited to the explicit adoption witness");
      }
      const openings = new PostgresRequestSpaceStore(storage.client, scope),
        journal = new PostgresRequestSourceAdmissionStore(storage.client);
      // A cold process uses its cold runtime for both dispatch and the real
      // adoption coordinator. Only composition is repeated, never its protocol.
      return new RequestRuntimeAdoptionService({
        context: new RequestAdoptionContexts({
          storage,
          controls: readyStage.controls,
          openings,
          binding: readyStage.executionBindings,
          journal,
          repositoryId: backend!.project.id,
          reader: () => Promise.resolve(sourceReader),
          creationModels: readyStage.executedModels?.creationModels,
        }),
        store: evolutionStore.requestAdoptions,
        networkContinuation: {
          ensure: (opening, dossier) =>
            runtime.ensureNetworkContinuation(opening, dossier),
        },
        teamContinuation: {
          ensure: (opening, dossier) =>
            runtime.ensureTeamContinuation(opening, dossier),
        },
        transition: new PostgresRequestAdoptionTransition({
          client: storage.client,
          primary: storage.primarySpaceControl,
          runtime,
          native: readyStage.nativeRuntime,
          store: evolutionStore,
          binding: readyStage.executionBindings,
          journal,
          async opening(caseId) {
            const record = await openings.forCase(caseId);
            if (!record) {
              throw new Error("The exact Request opening is unavailable");
            }
            return record;
          },
          dependencies: dependencies.create,
          fault: options.networkAdoptionFault,
          now: () => new Date().toISOString(),
        }),
        now: () => new Date().toISOString(),
      });
    },
    primaryOperatorId,
    initialModel: mainRuntime?.snapshot.executionModel ?? admittedInitialModel,
    source,
    retainedTool,
    retainedTools: mainRuntime?.snapshot.candidates.filter((candidate) =>
      candidate.stage === "active" && candidate.initialToolSeed
    ),
    toolTests,
    providerObservations,
    workerErrors,
    deliveryFailures,
  };
}

/** Open and execute one real Request before the source experiment. */
export async function openInitialNormalRequest(
  host: Awaited<ReturnType<typeof openNormalAdmissionWitnessHost>>,
) {
  const owner = host.initialModel.ownerAuthority!.operatorId;
  const capability = await host.stage.controls.issueCapability(owner);
  const session = await host.stage.controls.exchange(capability.secret);
  const controller = await host.stage.controls.authenticateSession(
    session.secret,
  );
  const opened = await host.stage.openings.open({
    openingKey: `source-qualification-${crypto.randomUUID()}`,
    text: "Start a Request for source admission qualification",
    source: { kind: "current-main", expectedVersion: host.source.version },
  }, session.secret);
  assert.equal(
    opened.phase,
    "dispatched",
    JSON.stringify({ phase: opened.phase, issues: opened.issues }),
  );
  return {
    capability,
    session,
    controller,
    ...await readCompletedNormalRequest(host, opened.id),
  };
}

/** Inspect the same real native completion for current-main or Release origins. */
export async function readCompletedNormalRequest(
  host: Awaited<ReturnType<typeof openNormalAdmissionWitnessHost>>,
  openingId: string,
) {
  const record = await new PostgresRequestSpaceStore(
    host.storage.client,
    host.storage.scope,
  ).get(openingId);
  assert(record?.base && record.admissionId);
  const view = await host.stage.nativeRuntime.forCaseSpace(
    record.executionSpaceId,
    record.caseId,
  );
  const deadline = Date.now() + 30_000;
  let receipt: Awaited<ReturnType<typeof view.dispatch.inspectAccepted>> = null;
  while (Date.now() < deadline) {
    receipt = await view.dispatch.inspectAccepted(
      host.primaryOperatorId,
      record.initialContributionId,
    );
    if (receipt?.receipt.status === "completed") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    receipt?.receipt.status,
    "completed",
    "initial Request execution must finish within the existing bounded fixture deadline",
  );
  const stores =
    await (await host.storage.caseSpace(record.executionSpaceId, record.caseId))
      .operator(host.primaryOperatorId);
  const state = await stores.state.load();
  assert(state?.executionModel);
  assert.equal(
    state.executionModel.version.repositoryVersion,
    record.base.manifest.source!.sourceVersion,
  );
  assert.equal(
    host.providerObservations.filter((item) => item.caseId === record.caseId)
      .length,
    1,
  );
  assert.deepEqual(host.workerErrors, []);
  return {
    record,
    stores,
    state,
    view,
    initialReceipt: receipt,
  };
}
