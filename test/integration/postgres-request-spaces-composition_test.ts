/** Real PG/Git/vault/Release/opening/shared-worker composition witness with the
 * unchanged normal bundled skill seed. Controlled provider decisions inspect
 * production retained instructions; this is not full MVP acceptance. */
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import {
  caseExecutionContext,
  closeCaseById,
} from "../../src/application/work/cases/runtime.ts";
import { Client } from "pg";
import { ContextSkillsService } from "../../src/application/skills/context-skills.ts";
import {
  initialSkillInvocationId,
  matchesLocalSkillExposure,
  SkillsBehavior,
} from "../../src/application/skills/behavior.ts";
import { bundledSkillReader } from "../../src/adapters/out/filesystem/skill-bundles.ts";
import { createArtifactSourceServices } from "../../src/composition/artifact-source-services.ts";
import { PostgresModelWriteQueue } from "../../src/adapters/model/repository/writing/postgres-write-queue.ts";
import { DurableQueuedArtifactSourcePublisher } from "../../src/application/model/write-queue/queued-artifact-source-publisher.ts";
import { ModelWriteWorker } from "../../src/application/model/publication/write-queue.ts";
import { QueuedModelWriter } from "../../src/application/model/publication/queued-writer.ts";
import { ArtifactSourceError } from "../../src/domain/work/artifacts/source-reference.ts";
import type { QueuedArtifactSourcePublication } from "../../src/domain/work/artifacts/source-publication.ts";
import { unusedPublication } from "../support/postgres-write-queue.ts";
import { RequestRuntimeDependencies } from "../../src/composition/request-runtime-dependencies.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { queryModelRevision } from "../../src/adapters/model/sources/editing/tooling.ts";
import { fileURLToPath } from "node:url";
import { DenoRuntimeProvenanceCollector } from "../../src/infrastructure/runtime-provenance.ts";
import { GovernedMemoryPromotionService } from "../../src/application/memory/governed-memory-promotion.ts";
import { InformationBehavior } from "../../src/application/work/context/information-behavior.ts";
import { ModelContextInformation } from "../../src/application/model/consultation/context-information.ts";
import {
  BehaviorInvocationRegistry,
  pinnedResolution,
} from "../../src/application/work/behaviors/invocation.ts";
import type { BehaviorModelVersion } from "../../src/domain/shared-kernel/behavior-model-version.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import { createRequestSpacesComposition } from "../../src/composition/request-spaces.ts";
import { createRequestOpeningSourcesComposition } from "../../src/composition/request-opening-sources.ts";
import { createRequestSpaceControls } from "../../src/composition/space-controls.ts";
import { createRequestReleasesComposition } from "../../src/composition/request-releases.ts";
import { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { PostgresRequestSpaceStore } from "../../src/adapters/out/postgres/request-space-store.ts";
import { PostgresSpaceAdmissions } from "../../src/adapters/out/postgres/request-space-control-store.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { repositoryWriterLock } from "../../src/adapters/out/git/writer-lock.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import { DEFAULT_BACKEND_BUILD_MEMORY_BYTES } from "../../src/composition/model-backend.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  SourceModel,
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { AjvSchemaValidator } from "../../src/infrastructure/ajv-schema-validation.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import {
  NativeExecutionAdmissionRefused,
  nativeExecutionIdentity,
} from "../../src/application/work/runtime/execution.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type {
  OpeningBase,
  OpeningCommand,
  OpeningRecord,
} from "../../src/domain/work/request-spaces.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { eventually } from "../support/eventually.ts";

Deno.test({
  name:
    "Normal Request host composition retains bundled skills and exact main/Release A B receipts across reconstruction and Request-origin release reuse",
  ignore: !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const startedAt = performance.now();
      const mark = (stage: string) =>
        console.info(
          `[Request composition witness] ${stage}: ${
            Math.round(performance.now() - startedAt)
          }ms; build memory ${JSON.stringify(buildService.memoryStats())}`,
        );
      const directory = await Deno.makeTempDir({
        prefix: "request-host-composition-",
      });
      database.registerCleanup(() =>
        Deno.remove(directory, { recursive: true })
      );
      const projectDir = `${directory}/model`;
      await Deno.mkdir(projectDir);
      const repositoryId = crypto.randomUUID();
      const scope = {
        projectId: `git:${repositoryId}`,
        systemId: crypto.randomUUID(),
      };
      const vaultDirectory = `${directory}/vault`;
      const vault = new FileBuildVault({ directory: vaultDirectory });
      const cache = await KvModelBuildStore.open({
        path: `${directory}/cache.kv`,
      });
      database.registerCleanup(() => cache.close());
      const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
      const compiler = new ToolkitCompiler({ packageDir });
      const runtimeProvenance = new DenoRuntimeProvenanceCollector({
        applicationDirectory: fileURLToPath(new URL("../../", import.meta.url)),
        toolkitPackageDirectory: packageDir,
        agents: {
          provider: "controlled-composition-witness",
          model: "deterministic-reply",
        },
      });
      const buildService = new ModelBuildService({
        memoryCacheBytes: DEFAULT_BACKEND_BUILD_MEMORY_BYTES,
        repositoryId,
        store: cache,
        vault,
        compiler,
        materializer: {
          materialize: ({ artifact, sources }) =>
            materialize(
              artifact.elements,
              sources,
              artifact.engineVersion,
              artifact.provider,
            ),
        },
      });
      const repository = await GitModelRepository.open({
        projectDir,
        repositoryId,
        compiler,
        buildService,
        buildVault: vault,
      });
      const sources = await loadInitialSources();
      const configurationRevision =
        'attribute configurationRevision : String = "0";';
      assert.equal(
        sources["configuration.sysml"].split(configurationRevision).length,
        2,
      );
      const sourcesAtRevision = (revision: number) => ({
        ...sources,
        "configuration.sysml": sources["configuration.sysml"].replace(
          configurationRevision,
          `attribute configurationRevision : String = "${revision}";`,
        ),
      });
      const releaseRevision = await repository.initialize(sources);
      mark("normal source initialized");
      const releaseModel = await validateSourceExecutable(
        releaseRevision,
        scope.projectId,
      );
      assert(
        releaseModel.contextPolicy && releaseModel.memoryPolicy &&
          releaseModel.skillPolicy,
      );
      assert.equal(releaseModel.initialSkills?.length, 1);
      const seed = releaseModel.initialSkills![0];
      assert.equal(seed.loaded, true);
      const readBundledSkill = bundledSkillReader();
      const seedContent = await readBundledSkill(
        seed.source,
        releaseModel.skillPolicy!.maxSkillBytes,
      );
      assert.equal(releaseModel.initialTools?.length ?? 0, 0);
      assert(releaseModel.spaceControlPolicy?.enabled);
      assert(
        releaseModel.spaceControlPolicy.acts.includes("retain-release"),
        "The unchanged normal source must explicitly grant retention; credentials do not add it",
      );
      const operatorId = releaseModel.identity.builderId;
      const ownerId = releaseModel.ownerAuthority!.operatorId;
      const schemas = {
        queueSchema: `${database.schema}_request_queue`,
        checkpointSchema: `${database.schema}_request_checkpoint`,
      };
      database.registerCleanup(async () => {
        const admin = new Client({
          connectionString: database.connectionString,
        });
        await admin.connect();
        try {
          for (const schema of Object.values(schemas)) {
            await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          }
        } finally {
          await admin.end();
        }
      });
      const calls = new Map<string, number>();
      const queueErrors: unknown[] = [], workerErrors: unknown[] = [];
      const runner = new DenoToolRunner();
      const schemaValidator = new AjvSchemaValidator();
      const clock = { now: () => new Date().toISOString() };
      let active: Awaited<ReturnType<typeof openHost>> | undefined;
      async function openHost() {
        const storage = new PostgresHostStorage(
          postgresClientConfiguration(
            database.connectionString,
            4,
            database.schema,
          ),
        );
        let sourceWriter: QueuedModelWriter | undefined;
        let mainRuntime: SystemRuntime | undefined;
        let constructed:
          | Awaited<ReturnType<typeof createRequestSpacesComposition>>
          | undefined;
        try {
          await storage.registerSystem(scope);
          await storage.registerRepository(repositoryId, scope.systemId);
          storage.bindPrimarySpaceControl({
            primaryOperatorId: operatorId,
            sourceSystemNativeId: releaseModel.identity.systemId,
          });
          // Same durable adapters and single writer as model-backend; business
          // authority always comes from the actual Main runtime or Request stage.
          const writerLock = await repositoryWriterLock(repository.stateDir);
          const sourceQueue = new PostgresModelWriteQueue({
            client: storage.client,
            scope,
            writerLock: (selectedRepositoryId) => {
              assert.equal(selectedRepositoryId, repositoryId);
              return Promise.resolve(writerLock);
            },
          });
          const sourceRepository = await GitModelRepository.open({
            projectDir,
            repositoryId,
            compiler,
            buildService,
            buildVault: vault,
            writeFence: {
              assertCurrent: (fence) => sourceQueue.heartbeat(fence, 300_000),
              guard: (fence, operation) =>
                sourceQueue.guardPublication(fence, 300_000, operation),
            },
          });
          const artifactRepository = sourceRepository.artifactSources(
            storage.sourceScopeId,
          );
          const sourceWrites = {
            scopeId: storage.sourceScopeId,
            repository: artifactRepository,
            async assertCurrent(publication: QueuedArtifactSourcePublication) {
              const target = publication.target;
              if (
                target.projectId !== scope.projectId ||
                target.systemId !== scope.systemId
              ) throw new ArtifactSourceError("scope");
              if (target.executionSpaceId === "main") {
                if (!mainRuntime) throw new ArtifactSourceError("scope");
                // SystemRuntime verifies the durable admitted pin and invokes
                // the bound real SkillsBehavior authority below for this proof.
                await mainRuntime.assertArtifactSourcePublication(publication);
              } else {
                if (!constructed) throw new ArtifactSourceError("scope");
                await constructed.assertArtifactSourcePublication(publication);
              }
            },
          };
          const sourceWorker = new ModelWriteWorker({
            queue: sourceQueue,
            repository: sourceRepository,
            publication: unusedPublication,
            artifactSourceWrites: sourceWrites,
            owner: `request-witness-source:${crypto.randomUUID()}`,
            leaseMs: 300_000,
          });
          sourceWriter = new QueuedModelWriter(
            repositoryId,
            sourceQueue,
            sourceWorker,
            compiler,
            sourceRepository,
          );
          const publisher = new DurableQueuedArtifactSourcePublisher({
            repositoryId,
            queue: sourceQueue,
            artifactSourceWrites: sourceWrites,
            pump: () => sourceWriter!.pump(),
            waitMs: 30_000,
          });
          const artifactSourcesForScope = createArtifactSourceServices({
            client: storage.client,
            hostScope: scope,
            repositoryId,
            sourceScopeId: storage.sourceScopeId,
            repository: artifactRepository,
            queuedPublisher: publisher,
            sourceHeader: (version) => sourceRepository.header(version),
          });
          const controlComposition = createRequestSpaceControls(storage);
          const releaseComposition = createRequestReleasesComposition({
            storage,
            controls: controlComposition.controls,
            writerLock,
            projectDir,
            repositoryId,
            sourceScopeId: storage.sourceScopeId,
            primaryOperatorId: operatorId,
            buildService,
            vault,
            cache,
            retainCommit: (version) =>
              repository.retainSavedSystemCommit(version),
          });
          const savedSystems = releaseComposition.savedSystems;
          const agents: AgentPort = {
            label:
              "Controlled provider; real source/opening/admission/native execution",
            async decide(context) {
              assert(context.case?.id);
              const opening = await storage.client.spaceOpening
                .findUniqueOrThrow({
                  where: {
                    projectId_systemId_caseId: {
                      ...scope,
                      caseId: context.case.id,
                    },
                  },
                });
              const base = JSON.parse(opening.baseJson!) as OpeningBase;
              const selected = base.manifest.operators.find((entry) =>
                entry.operatorId === operatorId
              )!;
              const runtimeScope = {
                ...scope,
                executionSpaceId: opening.executionSpaceId,
                operatorId,
              };
              const effects = await storage.client.executionEffect.findMany({
                where: { ...runtimeScope, status: "started" },
              });
              assert.equal(effects.length, 1);
              const proof = JSON.parse(effects[0].authorizationJson!);
              assert.equal(proof.openingId, opening.id);
              assert.equal(proof.admissionId, opening.admissionId);
              assert.equal(proof.baseDigest, opening.baseDigest);
              assert.deepEqual(context.admittedModelVersion, {
                digest: selected.modelDigest,
                repositoryVersion: selected.repositoryVersion,
              });
              assert(
                context.modelContext,
                "The production scoped context mechanism remains connected",
              );
              assert(
                context.memoryGuidance,
                "The production scoped governed-memory context remains connected",
              );
              assert.equal(context.skills?.loaded.length, 1);
              const guidance = context.skills!.loaded[0];
              assert.equal(guidance.content, seedContent);
              assert.equal(guidance.digest, seed.digest);
              assert.deepEqual(
                guidance.source.modelVersion,
                context.admittedModelVersion,
              );
              assert(guidance.sourceBinding);
              const stores = await (await storage.caseSpace(
                opening.executionSpaceId,
                opening.caseId,
              )).operator(operatorId);
              const catalog = await stores.skills.load(stores.scope.operatorId);
              assert.equal(catalog?.operations.length, 1);
              assert.deepEqual(
                guidance.sourceBinding,
                catalog!.skills[0].sourceBinding,
              );
              assert.equal(
                catalog!.operations[0].invocationId,
                initialSkillInvocationId(seed, context.admittedModelVersion!),
              );
              calls.set(
                opening.executionSpaceId,
                (calls.get(opening.executionSpaceId) ?? 0) + 1,
              );
              return { kind: "reply", text: `Scoped reply ${opening.caseId}` };
            },
            review() {
              throw new Error("No review in conversation-only witness");
            },
          };
          const exactReader = () =>
            GitModelRepository.openReadOnly({
              projectDir,
              repositoryId,
              buildService,
            });
          const tooling = new SysmlToolkitAdapter({ packageDir });
          const dependencies = new RequestRuntimeDependencies({
            hostScope: scope,
            sourceProjectId: scope.projectId,
            artifactSourcesForScope,
            readBundledSkill,
            agents,
            runner,
            clock,
            schemaValidator,
            runtimeProvenance,
            modelContext: {
              reader: new ModelContextReader({
                current() {
                  throw new Error(
                    "Request context requires an exact retained source version",
                  );
                },
                at: async (version) => await (await exactReader()).at(version),
              }),
              toolingQuery: async (version, expression) =>
                await queryModelRevision(
                  tooling,
                  await (await exactReader()).at(version),
                  expression,
                ),
              toolingReferenceSites: async (
                version: string,
                elementId: string,
              ) => {
                const revision = await (await exactReader()).at(version);
                return {
                  sourceDigest: revision.sourceDigest,
                  sites: await tooling.referenceSites(
                    revision.sources,
                    elementId,
                  ),
                };
              },
              async readSourceRevision(model) {
                const revision = await (await exactReader()).at(
                  model.version.repositoryVersion!,
                );
                return { version: revision.version, sources: revision.sources };
              },
            },
          });
          const sourceComposition = createRequestOpeningSourcesComposition({
            scope: { ...scope, executionSpaceId: "main" },
            projectDir,
            repositoryId,
            buildService,
            repository,
            writerLock: await repositoryWriterLock(repository.stateDir),
            savedSystems,
            requestReleases: releaseComposition,
            dependencies,
          });
          const stage = await createRequestSpacesComposition({
            storage,
            nativeOptions: {
              connectionString: database.connectionString,
              ...schemas,
              onError: (error) => {
                queueErrors.push(error);
              },
            },
            sources: sourceComposition,
            controlComposition,
          });
          constructed = stage;
          return {
            storage,
            stage,
            savedSystems,
            releaseComposition,
            sourceComposition,
            dependencies,
            artifactSourcesForScope,
            bindMain(runtime: SystemRuntime) {
              mainRuntime = runtime;
            },
            stopSourceWriter: () => sourceWriter!.close(),
          };
        } catch (error) {
          await constructed?.nativeRuntime.stop();
          await sourceWriter?.close();
          await storage.close();
          throw error;
        }
      }
      database.registerCleanup(async () => {
        if (active) {
          await active.stage.nativeRuntime.stop();
          await active.stopSourceWriter();
          await active.storage.close();
        }
      });
      const mainAgents: AgentPort = {
        label: "Controlled Main provider on the same real queue",
        decide(context) {
          assert.equal(context.skills?.loaded[0]?.content, seedContent);
          assert.equal(context.skills?.loaded[0]?.digest, seed.digest);
          assert(
            context.modelContext,
            "Main uses its production exact-source context reader",
          );
          assert(
            context.memoryGuidance,
            "Main uses its scoped governed memory reader",
          );
          calls.set("main", (calls.get("main") ?? 0) + 1);
          return Promise.resolve({ kind: "reply", text: "Main reply" });
        },
        review() {
          throw new Error("No Main review");
        },
      };
      async function connectMain(host: Awaited<ReturnType<typeof openHost>>) {
        mark("Main initialization started");
        const stores = await host.storage.operator(operatorId);
        const model = new SourceModel({
          repository,
          projectId: scope.projectId,
          tooling: new SysmlToolkitAdapter({ packageDir }),
        });
        const entries = new Map(
          (releaseModel.operatorEntries ?? []).map((
            entry,
          ) => [entry.id, { ownerId: operatorId, kind: entry.kind }]),
        );
        const snapshotForCaller = (callerId: string) =>
          callerId === operatorId ? runtime.snapshot : undefined;
        const pins = new Map<string, Promise<ExecutableModel | null>>();
        // Same pinned immutable model resolution as operator-workspace; each
        // use still checks the actual live admission before and after reuse.
        async function resolveCallerModel(
          callerId: string,
          version: BehaviorModelVersion,
        ) {
          const admitted = snapshotForCaller(callerId)?.executionModel;
          if (
            !admitted || admitted.version.digest !== version.digest ||
            admitted.version.repositoryVersion !== version.repositoryVersion
          ) return null;
          const key = JSON.stringify([
            callerId,
            version.digest,
            version.repositoryVersion,
          ]);
          const exact = await pinnedResolution(pins, key, async () => {
            const resolved = await model.readExecutableModel(
              admitted.identity,
              version.repositoryVersion,
            );
            return resolved.identity.builderId === callerId &&
                resolved.version.digest === version.digest &&
                resolved.version.repositoryVersion === version.repositoryVersion
              ? resolved
              : null;
          });
          const current = snapshotForCaller(callerId)?.executionModel;
          return exact && current?.version.digest === version.digest &&
              current.version.repositoryVersion === version.repositoryVersion
            ? structuredClone(exact)
            : null;
        }
        const memory = new GovernedMemoryPromotionService({
          store: stores.memory,
          now: clock.now,
          // Faithful Main provenance check from operator-workspace; only this
          // owner's actual decision/source/outcome journal can support capture.
          provenance: {
            verify(ownerId, content) {
              const snapshot = snapshotForCaller(ownerId);
              if (!snapshot) return Promise.resolve(false);
              const decision = snapshot.messages.find((message) =>
                message.id === content.origin.decisionId
              );
              if (
                decision?.role !== "assistant" || !decision.execution?.actionId
              ) return Promise.resolve(false);
              const reference = (value: string, outcome = false) => {
                if (!value.startsWith("message:")) return false;
                const message = snapshot.messages.find((message) =>
                  message.id === value.slice("message:".length)
                );
                return !!message?.execution?.digest &&
                  (!outcome ||
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
        const memoryInformation = new InformationBehavior({
          entries,
          resolveCallerModel,
          snapshotForCaller,
          memory: () => Promise.resolve(memory),
        });
        const tooling = new SysmlToolkitAdapter({ packageDir });
        const modelInformation = new ModelContextInformation({
          projectId: scope.projectId,
          resolveCallerModel,
          snapshotForCaller,
          reader: new ModelContextReader(repository),
          async readSourceRevision(callerId) {
            const admitted = snapshotForCaller(callerId)?.executionModel;
            assert(admitted?.version.repositoryVersion);
            const revision = await repository.at(
              admitted.version.repositoryVersion,
            );
            return { version: revision.version, sources: revision.sources };
          },
          toolingQuery: async (version, expression) =>
            await queryModelRevision(
              tooling,
              await repository.at(version),
              expression,
            ),
          toolingReferenceSites: async (version, elementId) => {
            const revision = await repository.at(version);
            return {
              sourceDigest: revision.sourceDigest,
              sites: await tooling.referenceSites(revision.sources, elementId),
            };
          },
        });
        const skillsService: ContextSkillsService = new ContextSkillsService({
          store: stores.skills,
          download: {
            download: () => {
              throw new Error("No download in bundled witness");
            },
          },
          artifactSources: () => host.artifactSourcesForScope(stores.scope),
          assertCurrentAuthority: (authority, permission) =>
            skillInformation.assertCurrentAuthority(authority, permission),
          now: clock.now,
        });
        const skillInformation = new SkillsBehavior({
          entries,
          resolveCallerModel,
          skills: () => Promise.resolve(skillsService),
          readBundledSkill,
        });
        const information: DecisionInformationPort = {
          modelTools: (admitted) => modelInformation.modelTools(admitted),
          assertModelContextPin: (admitted, messages, pin) =>
            modelInformation.assertModelContextPin(admitted, messages, pin),
          withModelContextPin: (admitted, messages, pin, operation) =>
            modelInformation.withModelContextPin(
              admitted,
              messages,
              pin,
              operation,
            ),
          consultModel: (admitted, input, messages, budget) =>
            modelInformation.consultModel(admitted, input, messages, budget),
          consultAdmittedModelSource: (admitted, input, messages, budget) =>
            modelInformation.consultAdmittedModelSource(
              admitted,
              input,
              messages,
              budget,
            ),
          async read(admitted, messages) {
            return {
              ...await modelInformation.read(admitted, messages),
              ...await memoryInformation.read(admitted),
              ...await skillInformation.read(admitted),
            };
          },
        };
        const runtime: SystemRuntime = new SystemRuntime({
          schemaValidator,
          clock,
          agents: mainAgents,
          information,
          behaviors: new BehaviorInvocationRegistry([
            memoryInformation,
            skillInformation,
          ]),
          runtimeProvenance,
          runner,
          model,
          caseNumbers: host.storage.caseNumbers(),
          store: stores.state,
          stateHistory: stores.state,
          execution: host.stage.nativeRuntime.execution,
          dispatch: host.stage.nativeRuntime.dispatch,
          workBudget: new WorkBudgetService(stores.budget),
        });
        host.bindMain(runtime);
        runtime.bindArtifactSourceAuthority(async (publication) => {
          if (publication.proof.kind !== "skill-authority") {
            throw new ArtifactSourceError("scope");
          }
          await skillInformation.assertCurrentAuthority(
            publication.proof.authority,
            "install",
          );
        });
        await runtime.initialize(undefined, {
          resumeContinuations: false,
          resumeCandidateContinuations: false,
        });
        mark("Main initialized");
        await skillInformation.initialize(runtime.snapshot.executionModel!);
        mark("Main seed prepared");
        return { runtime, stores, skillInformation };
      }
      async function start(
        host: Awaited<ReturnType<typeof openHost>>,
        main: Awaited<ReturnType<typeof connectMain>>,
      ) {
        await host.stage.nativeRuntime.start(async (delivery, resolved) => {
          try {
            await host.stage.dispatchAccepted(
              delivery,
              resolved,
              (input) => main.runtime.processAcceptedContribution(input),
            );
          } catch (error) {
            workerErrors.push(error);
            throw error;
          }
        });
      }
      async function record(
        host: Awaited<ReturnType<typeof openHost>>,
        id: string,
      ) {
        const found = await new PostgresRequestSpaceStore(
          host.storage.client,
          scope,
        ).get(id);
        assert(found);
        return found;
      }
      async function completed(
        host: Awaited<ReturnType<typeof openHost>>,
        opening: OpeningRecord,
      ) {
        const view = await host.stage.nativeRuntime.forCaseSpace(
          opening.executionSpaceId,
          opening.caseId,
        );
        return await eventually(async () => {
          const accepted = await view.dispatch.inspectAccepted(
            operatorId,
            opening.initialContributionId,
          );
          return accepted?.receipt.status === "completed"
            ? accepted
            : undefined;
        });
      }
      async function caseStores(
        host: Awaited<ReturnType<typeof openHost>>,
        opening: OpeningRecord,
      ) {
        return await (await host.storage.caseSpace(
          opening.executionSpaceId,
          opening.caseId,
        )).operator(operatorId);
      }
      async function mainInputId(
        host: Awaited<ReturnType<typeof openHost>>,
        caseId: string,
      ) {
        const contributions = await host.storage.client.executionContribution
          .findMany({
            where: { ...scope, executionSpaceId: "main", operatorId },
          });
        const matching = contributions.filter((contribution) => {
          const accepted = JSON.parse(
            contribution.payloadJson,
          ) as OperatorExecutionDelivery;
          return accepted.identity.scope.kind === "request" &&
            accepted.identity.scope.scopeId === caseId;
        });
        assert.equal(matching.length, 1);
        return matching[0].contributionId;
      }
      async function evidence(
        host: Awaited<ReturnType<typeof openHost>>,
        opening: OpeningRecord,
        existingStores?: Awaited<ReturnType<typeof caseStores>>,
      ) {
        const stores = existingStores ?? await caseStores(host, opening);
        const executions = await host.storage.client.operatorExecution.findMany(
          { where: stores.scope, orderBy: { threadId: "asc" } },
        );
        return {
          skills: await stores.skills.load(stores.scope.operatorId),
          bindings: await host.storage.client.artifactBinding.findMany({
            where: stores.scope,
            orderBy: { bindingId: "asc" },
          }),
          state: await stores.state.load(),
          history: await host.storage.client.runtimeRevision.findMany({
            where: stores.scope,
            orderBy: { revision: "asc" },
          }),
          effects: await host.storage.client.executionEffect.findMany({
            where: stores.scope,
            orderBy: { effectKey: "asc" },
          }),
          contributions: await host.storage.client.executionContribution
            .findMany({
              where: stores.scope,
              orderBy: { contributionId: "asc" },
            }),
          executions,
          checkpoints: await host.storage.client.$queryRawUnsafe<
            Array<Record<string, unknown>>
          >(
            `SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM "${schemas.checkpointSchema}".checkpoints WHERE thread_id IN (SELECT jsonb_array_elements_text($1::jsonb)) ORDER BY thread_id, checkpoint_ns, checkpoint_id`,
            JSON.stringify(executions.map((execution) => execution.threadId)),
          ),
        };
      }
      active = await openHost();
      mark("host composed");
      const sharedQueueName =
        active.stage.nativeRuntime.ledger.options.queueName;
      assert.equal(
        active.stage.nativeRuntime.ledger.client,
        active.storage.client,
      );
      const current = await repository.publishSystemSources(
        sourcesAtRevision(1),
        releaseRevision.version,
        "local-control",
      );
      mark("current revision published");
      assert.notEqual(current.version, releaseRevision.version);
      const currentModel = await validateSourceExecutable(
        current,
        scope.projectId,
      );
      mark("current revision validated");
      assert.deepEqual(currentModel.initialSkills, releaseModel.initialSkills);
      assert(
        currentModel.contextPolicy && currentModel.memoryPolicy &&
          currentModel.skillPolicy,
      );
      let main = await connectMain(active);
      mark("Main information and bundled skill ready");
      async function assertMainProviderCalls(expected: number) {
        if (calls.get("main") === expected) return;
        const state = await main.stores.state.load();
        const diagnostic = {
          expectedCalls: expected,
          actualCalls: calls.get("main") ?? 0,
          phase: state?.phase,
          busy: state?.busy,
          error: state?.error?.slice(0, 2000),
          lastToolFailure: state?.lastToolFailure?.code,
          messageRoles: state?.messages.slice(-20).map((message) =>
            message.role
          ),
          events: state?.events.slice(-12).map((event) => ({
            kind: event.kind,
            code: event.code,
            label: event.label.slice(0, 500),
          })),
          workerErrors: workerErrors.map((error) =>
            error instanceof Error
              ? { name: error.name }
              : { name: typeof error }
          ),
          queueErrors: queueErrors.map((error) =>
            error instanceof Error
              ? { name: error.name }
              : { name: typeof error }
          ),
        };
        assert.equal(
          calls.get("main") ?? 0,
          expected,
          `Main provider boundary was not reached: ${
            JSON.stringify(diagnostic)
          }`,
        );
      }
      async function completeMain(inputId: string, expectedCalls: number) {
        try {
          await eventually(async () =>
            (await active!.stage.nativeRuntime.dispatch.inspectAccepted(
                operatorId,
                inputId,
              ))?.receipt.status === "completed"
              ? true
              : undefined
          );
        } catch (error) {
          await assertMainProviderCalls(expectedCalls);
          throw error;
        }
        await assertMainProviderCalls(expectedCalls);
      }
      const capability = await active.stage.controls.issueCapability(ownerId);
      const session = await active.stage.controls.exchange(capability.secret);
      const controller = await active.stage.controls.authenticateSession(
        session.secret,
      );
      assert.equal(controller.ownerId, ownerId);
      assert(controller.authority.acts.includes("retain-release"));
      const mainBeforeMainRelease = await main.stores.state.load();
      const mainReleaseSource = {
        branch: { kind: "main" as const },
        sourceVersion: releaseRevision.version,
      };
      await active.releaseComposition.releases.createTag(session.secret, {
        source: mainReleaseSource,
        name: "retained-b",
      });
      const release = await active.releaseComposition.releases.save(
        session.secret,
        {
          saveKey: "retained-b",
          tag: { mode: "existing", name: "retained-b" },
          name: "Normal bundled-skill Release",
          purpose: "Composition qualification only",
          source: mainReleaseSource,
        },
      );
      mark("Release saved");
      // Declared bundle dependencies remain unresolved at Release capture.
      // Opening may satisfy them on this host; it never rewrites retention.
      assert.equal(release.status, "incomplete");
      assert.deepEqual(release.issues, ["PREREQUISITES_REQUIRED"]);
      assert.equal(release.assetAvailability, "verified");
      assert(release.digest);
      assert.deepEqual(await main.stores.state.load(), mainBeforeMainRelease);
      const mainReleaseRow = await active.storage.client.savedSystem
        .findUniqueOrThrow({ where: { id: release.id } });
      assert(mainReleaseRow.creationAuthorization);
      const mainReleaseProof = JSON.parse(mainReleaseRow.creationAuthorization);
      assert.equal(mainReleaseProof.act, "retain-release");
      assert.equal(mainReleaseProof.ownerId, controller.ownerId);
      assert.equal(mainReleaseProof.authority.sourceVersion, current.version);
      assert.equal(release.source!.sourceVersion, releaseRevision.version);
      assert.equal(mainReleaseRow.executionSpaceId, "main");
      assert.equal("creationAuthorization" in release, false);

      const commands: OpeningCommand[] = [
        {
          openingKey: "request-a",
          text: `Exact input A\n${"details ".repeat(200)}`,
          source: { kind: "current-main", expectedVersion: current.version },
        },
        {
          openingKey: "request-b",
          text: `Exact input B\n${"retained ".repeat(200)}`,
          source: {
            kind: "release",
            releaseId: release.id,
            digest: release.digest,
          },
        },
      ];
      const views = [];
      for (const command of commands) {
        mark(`${command.openingKey} opening started`);
        views.push(await active.stage.openings.open(command, session.secret));
        mark(`${command.openingKey} opening settled`);
      }
      assert.deepEqual(
        views.map((view) => ({ phase: view.phase, issues: view.issues })),
        [
          { phase: "dispatched", issues: [] },
          { phase: "dispatched", issues: [] },
        ],
        "A real unsupported host requirement must fail here, never be replaced with source Maps",
      );
      const releaseAfterOpening = await active.savedSystems.service.inspect(
        release.id,
      );
      assert.equal(releaseAfterOpening.status, release.status);
      assert.deepEqual(releaseAfterOpening.issues, release.issues);
      assert.equal(releaseAfterOpening.digest, release.digest);
      mark("A/B openings dispatched");
      const [a, b] = await Promise.all(
        views.map((view) => record(active!, view.id)),
      );
      assert.equal(a.base!.manifest.source!.sourceVersion, current.version);
      assert.equal(
        b.base!.manifest.source!.sourceVersion,
        releaseRevision.version,
      );
      assert.notEqual(
        a.base!.manifest.operators[0].modelDigest,
        b.base!.manifest.operators[0].modelDigest,
      );
      assert.notEqual(a.executionSpaceId, b.executionSpaceId);
      assert.equal(
        await active.storage.client.executionEffect.count({ where: scope }),
        0,
      );
      const mainCase = await main.runtime.submit(
        "Main shares the admitted native queue",
        undefined,
        undefined,
        true,
      );
      assert(mainCase);
      const mainInput = await mainInputId(active, mainCase);
      await start(active, main);
      const [acceptedA, acceptedB] = await Promise.all([
        completed(active, a),
        completed(active, b),
      ]);
      await completeMain(mainInput, 1);
      mark("initial A/B/Main contributions completed");
      await assertMainProviderCalls(1);
      let beforeA = await evidence(active, a);
      const beforeB = await evidence(active, b);
      const mainSkills = await main.stores.skills.load(
        main.stores.scope.operatorId,
      );
      assert.equal(mainSkills!.operations.length, 1);
      const mainSources = await active.artifactSourcesForScope(
        main.stores.scope,
      );
      const aSources = await active.artifactSourcesForScope(
        (await caseStores(active, a)).scope,
      );
      const bSources = await active.artifactSourcesForScope(
        (await caseStores(active, b)).scope,
      );
      assert.equal(
        aSources,
        await active.artifactSourcesForScope(
          (await caseStores(active, a)).scope,
        ),
      );
      assert.notEqual(aSources, bSources);
      assert.notEqual(aSources, mainSources);
      assert.notEqual(bSources, mainSources);
      const sourceCommandsBeforeRestore = await active.storage.client
        .modelWriteCommand.findMany({
          where: { ...scope, repositoryId },
          orderBy: { commandId: "asc" },
        });
      assert.equal(sourceCommandsBeforeRestore.length, 3);
      assert(
        sourceCommandsBeforeRestore.every((command) =>
          command.state === "published"
        ),
      );
      for (const [opening, found] of [[a, beforeA], [b, beforeB]] as const) {
        assert.equal(found.skills!.operations.length, 1);
        assert.equal(found.skills!.skills[0].loaded, true);
        assert.equal(found.bindings.length, 1);
        const pin = found.state!.executionModel!.version;
        assert.equal(
          found.skills!.operations[0].invocationId,
          initialSkillInvocationId(seed, pin),
        );
        assert.deepEqual(found.skills!.skills[0].source.modelVersion, {
          digest: pin.digest,
          repositoryVersion: pin.repositoryVersion,
        });
        assert.equal(
          found.bindings[0].executionSpaceId,
          opening.executionSpaceId,
        );
        assert.equal(found.bindings[0].operatorId, operatorId);
        assert.equal(
          found.bindings[0].bindingId,
          found.skills!.skills[0].sourceBinding!.bindingId,
        );
      }
      assert.notEqual(
        beforeA.bindings[0].bindingId,
        beforeB.bindings[0].bindingId,
      );
      assert.notEqual(
        beforeA.bindings[0].bindingId,
        mainSkills!.skills[0].sourceBinding!.bindingId,
      );
      for (const [opening, found] of [[a, beforeA], [b, beforeB]] as const) {
        assert.equal(calls.get(opening.executionSpaceId), 1);
        assert.equal(
          found.state!.messages.filter((message) =>
            message.id === opening.initialContributionId &&
            message.text === opening.command.text
          ).length,
          1,
        );
        assert.equal(
          found.state!.messages.filter((message) =>
            message.role === "assistant" &&
            message.text === `Scoped reply ${opening.caseId}`
          ).length,
          1,
        );
        assert.equal(
          found.state!.executionModel!.version.repositoryVersion,
          opening.base!.manifest.source!.sourceVersion,
        );
        assert(
          found.history.length > 0 && found.effects.length > 0 &&
            found.contributions.length === 1,
        );
        assert(found.executions.length > 0 && found.checkpoints.length > 0);
        assert(found.effects.every((effect) => effect.authorizationJson));
        assert.equal(
          await active.sourceComposition.branches.sourceVersion(opening),
          opening.base!.manifest.source!.sourceVersion,
        );
      }
      await assertMainProviderCalls(1);
      const advanced = await repository.publishSystemSources(
        sourcesAtRevision(2),
        current.version,
        "local-control",
      );
      const advancedModel = await validateSourceExecutable(
        advanced,
        scope.projectId,
      );
      await main.runtime.adoptModelVersion({
        expectedDigest: advancedModel.version.digest,
        expectedVersion: advanced.version,
      });
      const advancedCase = await main.runtime.submit(
        "Main advances independently",
        undefined,
        undefined,
        true,
      );
      assert(advancedCase);
      const advancedInput = await mainInputId(active, advancedCase);
      await completeMain(advancedInput, 2);
      await assertMainProviderCalls(2);
      mark("Main advanced independently");
      assert.equal(
        (await main.stores.state.load())!.executionModel!.version
          .repositoryVersion,
        advanced.version,
      );
      assert.deepEqual(await evidence(active, a), beforeA);
      assert.deepEqual(await evidence(active, b), beforeB);
      const aStores = await caseStores(active, a);
      const aSnapshot = (await aStores.state.load())!;
      const aDependencies = active.dependencies.create(
        aStores,
        aSnapshot.executionModel!,
        () => aSnapshot,
      );
      const entries = new Map(
        aSnapshot.executionModel!.operatorEntries!.map((
          entry,
        ) => [entry.id, { ownerId: operatorId, kind: entry.kind }]),
      );
      const unload = aSnapshot.executionModel!.behaviors!.find((behavior) =>
        matchesLocalSkillExposure(
          aSnapshot.executionModel!,
          behavior,
          "skill-unload",
          entries,
        )
      );
      assert(unload);
      await aDependencies.behaviors!.invoke({
        callerId: operatorId,
        behavior: unload,
        modelVersion: {
          digest: aSnapshot.executionModel!.version.digest,
          repositoryVersion: aSnapshot.executionModel!.version
            .repositoryVersion!,
        },
        invocationId: "request-a-unload-seed",
        input: { id: seed.id, expectedDigest: seed.digest },
      });
      const unloadedA = await evidence(active, a);
      assert.equal(unloadedA.skills!.skills[0].loaded, false);
      assert.equal(unloadedA.skills!.operations.length, 2);
      assert.deepEqual(
        (await aDependencies.information!.read(aSnapshot.executionModel!))
          .skills!.loaded,
        [],
      );
      assert.deepEqual(unloadedA.bindings, beforeA.bindings);
      assert.deepEqual(unloadedA.state, beforeA.state);
      beforeA = unloadedA;
      assert.deepEqual(await evidence(active, b), beforeB);
      assert.deepEqual(
        await main.stores.skills.load(main.stores.scope.operatorId),
        mainSkills,
      );
      const mainBeforeRestore = await main.stores.state.load();
      assert(mainBeforeRestore?.executionModel);
      const mainMemoryBeforeRestore = await main.stores.memory.list(
        main.stores.scope.operatorId,
      );
      await active.stage.nativeRuntime.stop();
      await active.stopSourceWriter();
      await active.storage.close();
      active = await openHost();
      mark("host reconstructed");
      assert.equal(
        active.stage.nativeRuntime.ledger.options.queueName,
        sharedQueueName,
      );
      assert.equal(
        active.stage.nativeRuntime.ledger.client,
        active.storage.client,
      );
      // Ordinary Main initialization records one startup event per runtime
      // instance (initialization.ts applyInitialization + SystemRuntime.update).
      // Request inert restoration below retains its stricter unchanged evidence.
      const mainBootstrapStartedAt = Date.now();
      main = await connectMain(active);
      const mainAfterBootstrap = await main.stores.state.load();
      assert(mainAfterBootstrap);
      assert.equal(mainAfterBootstrap.revision, mainBeforeRestore.revision + 1);
      assert.equal(
        mainAfterBootstrap.events.length,
        mainBeforeRestore.events.length + 1,
      );
      const boot = mainAfterBootstrap.events.at(-1)!;
      assert.match(boot.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
      assert(!mainBeforeRestore.events.some((event) => event.id === boot.id));
      const bootAt = Date.parse(boot.at);
      assert(
        Number.isFinite(bootAt) && bootAt >= mainBootstrapStartedAt &&
          bootAt <= Date.now(),
        "Main startup event has this bootstrap's actual timestamp",
      );
      const provenance = await runtimeProvenance.collect();
      const restoredPin = mainBeforeRestore.executionModel.version;
      const bootstrapCaseId = caseExecutionContext(mainBeforeRestore)?.caseId;
      const expectedBoot = {
        id: boot.id,
        at: boot.at,
        kind: "runtime-started",
        label: "Provenance du logiciel d’exécution",
        runtimeProvenance: provenance,
        ownerAuthority: mainBeforeRestore.ownerAuthority,
        ...(bootstrapCaseId ? { caseId: bootstrapCaseId } : {}),
        execution: {
          digest: restoredPin.digest,
          runtime: { digest: provenance.digest },
          sourceIds: restoredPin.sourceIds,
          ...(restoredPin.repositoryVersion
            ? { repositoryVersion: restoredPin.repositoryVersion }
            : {}),
        },
      };
      assert(
        isDeepStrictEqual(boot, expectedBoot),
        "Main adds exactly the native startup provenance event with its owner, Case and retained execution pin",
      );
      assert(
        isDeepStrictEqual(mainAfterBootstrap, {
          ...mainBeforeRestore,
          revision: mainBeforeRestore.revision + 1,
          events: [...mainBeforeRestore.events, expectedBoot],
        }),
        "Main bootstrap changes only its single startup provenance event and revision; all other state stays exact",
      );
      assert(
        isDeepStrictEqual(
          await main.stores.memory.list(main.stores.scope.operatorId),
          mainMemoryBeforeRestore,
        ),
        "Main memory stays exact across bootstrap",
      );
      assert(
        isDeepStrictEqual(
          await main.stores.skills.load(main.stores.scope.operatorId),
          mainSkills,
        ),
        "Main skills stay exact across bootstrap",
      );
      for (
        const [index, opening, accepted] of [[0, a, acceptedA], [
          1,
          b,
          acceptedB,
        ]] as const
      ) {
        const retry = await active.stage.openings.open(
          commands[index],
          session.secret,
        );
        assert.equal(retry.id, opening.id);
        assert.equal(retry.caseId, opening.caseId);
        assert.equal(retry.executionSpaceId, opening.executionSpaceId);
        assert.equal(
          retry.initialContributionId,
          opening.initialContributionId,
        );
        assert.equal(
          retry.sourceVersion,
          opening.base!.manifest.source!.sourceVersion,
        );
        const persisted = await record(active, opening.id);
        await active.stage.runtime.provision(persisted);
        await active.stage.runtime.prepareInitialSkills(persisted);
        const admission = await new PostgresSpaceAdmissions(
          active.storage.client,
          active.storage.primarySpaceControl,
        ).get(persisted.admissionId!);
        assert(admission);
        await active.stage.runtime.enqueue(persisted, admission);
        const replay = await completed(active, opening);
        assert.equal(replay.receipt.jobId, accepted.receipt.jobId);
        assert.deepEqual(replay.delivery, accepted.delivery);
        assert.equal(calls.get(opening.executionSpaceId), 1);
      }
      assert.deepEqual(await evidence(active, a), beforeA);
      assert.deepEqual(await evidence(active, b), beforeB);
      assert(
        isDeepStrictEqual(await main.stores.state.load(), mainAfterBootstrap),
        "Case replay and revocation leave Main's post-bootstrap state exact",
      );
      assert(
        isDeepStrictEqual(
          await main.stores.memory.list(main.stores.scope.operatorId),
          mainMemoryBeforeRestore,
        ),
        "Case replay and revocation leave Main memory exact",
      );
      assert(
        isDeepStrictEqual(
          await main.stores.skills.load(main.stores.scope.operatorId),
          mainSkills,
        ),
        "Case replay and revocation leave Main skills exact",
      );
      assert.deepEqual(
        await main.stores.skills.load(main.stores.scope.operatorId),
        mainSkills,
      );
      assert.deepEqual(
        await active.storage.client.modelWriteCommand.findMany({
          where: { ...scope, repositoryId },
          orderBy: { commandId: "asc" },
        }),
        sourceCommandsBeforeRestore,
      );
      // Extend the same normal-source witness: A's exact admitted birth model
      // becomes an actual Request-origin Release, then a fresh native Request C.
      // These operations must not borrow Main's catalogue or A's live skill state.
      const sequenceBeforeRequestRelease = await active.storage.client
        .caseSequence.findUniqueOrThrow({
          where: { projectId_systemId: scope },
        });
      const admissionsBeforeRequestRelease = await active.storage.client
        .spaceExecutionAdmission.count({ where: scope });
      const sourceWritesBeforeRequestRelease = await active.storage.client
        .modelWriteCommand.count({ where: { ...scope, repositoryId } });
      const mainBeforeRequestRelease = await main.stores.state.load();
      const admittedMainBeforeRequestRelease =
        (await repository.history({ limit: 1 })).headVersion;
      assert.equal(admittedMainBeforeRequestRelease, advanced.version);
      const requestReleaseCommand = {
        saveKey: "request-a-birth-release",
        tag: { mode: "existing" as const, name: "request-a-birth-release" },
        name: "Request A exact birth model",
        purpose: "Owned Request source round trip",
        source: {
          branch: { kind: "case" as const, caseId: a.caseId },
          sourceVersion: a.base!.manifest.source!.sourceVersion,
        },
      };
      await active.releaseComposition.releases.createTag(session.secret, {
        source: requestReleaseCommand.source,
        name: requestReleaseCommand.tag.name,
      });
      const requestRelease = await active.releaseComposition.releases.save(
        session.secret,
        requestReleaseCommand,
      );
      assert.equal(requestRelease.status, "incomplete");
      assert.deepEqual(requestRelease.issues, ["PREREQUISITES_REQUIRED"]);
      assert.equal(requestRelease.assetAvailability, "verified");
      assert(requestRelease.digest && requestRelease.manifest);
      assert.equal(requestRelease.origin.executionSpaceId, a.executionSpaceId);
      assert.deepEqual(requestRelease.source!.branch, {
        kind: "case",
        caseId: a.caseId,
      });
      assert.equal(
        requestRelease.source!.branchRef,
        `refs/heads/requests/${a.branchId}`,
      );
      assert.equal(requestRelease.source!.sourceVersion, current.version);
      assert.deepEqual(
        requestRelease.manifest.operators,
        a.base!.manifest.operators,
      );
      assert.deepEqual(
        requestRelease.manifest.prerequisites,
        a.base!.manifest.prerequisites,
      );
      const requestReleaseRow = await active.storage.client.savedSystem
        .findUniqueOrThrow({ where: { id: requestRelease.id } });
      assert.equal(requestReleaseRow.executionSpaceId, a.executionSpaceId);
      assert(requestReleaseRow.creationAuthorization);
      const requestReleaseProof = JSON.parse(
        requestReleaseRow.creationAuthorization,
      );
      assert.equal(requestReleaseProof.act, "retain-release");
      assert.equal(requestReleaseProof.ownerId, controller.ownerId);
      assert.equal(
        requestReleaseProof.authority.sourceVersion,
        advanced.version,
      );
      assert.equal("creationAuthorization" in requestRelease, false);
      assert.equal(
        (await active.storage.client.caseSequence.findUniqueOrThrow({
          where: { projectId_systemId: scope },
        })).lastNumber,
        sequenceBeforeRequestRelease.lastNumber,
      );
      assert.equal(
        await active.storage.client.spaceExecutionAdmission.count({
          where: scope,
        }),
        admissionsBeforeRequestRelease,
      );
      assert.equal(
        await active.storage.client.modelWriteCommand.count({
          where: { ...scope, repositoryId },
        }),
        sourceWritesBeforeRequestRelease,
      );
      const caseCatalogue = await active.releaseComposition.releases.list(
        session.secret,
        a.caseId,
      );
      const ownedCatalogue = await active.releaseComposition.releases.list(
        session.secret,
      );
      assert(caseCatalogue.some((entry) => entry.id === requestRelease.id));
      assert(ownedCatalogue.some((entry) => entry.id === requestRelease.id));
      assert(!ownedCatalogue.some((entry) => entry.id === release.id));
      assert(
        !(await active.savedSystems.service.list()).some((entry) =>
          entry.id === requestRelease.id
        ),
      );
      assert.equal(
        (await active.releaseComposition.releases.inspect(
          session.secret,
          requestRelease.id,
        )).digest,
        requestRelease.digest,
      );
      const requestReleaseRetry = await active.releaseComposition.releases.save(
        session.secret,
        requestReleaseCommand,
      );
      assert.equal(requestReleaseRetry.id, requestRelease.id);
      assert.equal(requestReleaseRetry.digest, requestRelease.digest);
      assert.equal(
        (await active.storage.client.savedSystem.findUniqueOrThrow({
          where: { id: requestRelease.id },
        })).creationAuthorization,
        requestReleaseRow.creationAuthorization,
      );
      assert.deepEqual(await evidence(active, a), beforeA);
      assert.deepEqual(await evidence(active, b), beforeB);
      assert.deepEqual(
        await main.stores.state.load(),
        mainBeforeRequestRelease,
      );
      assert.equal(
        (await repository.history({ limit: 1 })).headVersion,
        admittedMainBeforeRequestRelease,
      );
      await assertMainProviderCalls(2);
      // Start this reconstructed host's existing shared facility once; the
      // later revocation witness reuses these workers rather than starting twice.
      await start(active, main);
      const reusedView = await active.stage.openings.open({
        openingKey: "request-c-from-owned-release",
        text: "Fresh Request from A's exact source Release",
        source: {
          kind: "release",
          releaseId: requestRelease.id,
          digest: requestRelease.digest,
        },
      }, session.secret);
      assert.equal(reusedView.phase, "dispatched");
      assert.deepEqual(reusedView.issues, []);
      const c = await record(active, reusedView.id);
      assert.notEqual(c.executionSpaceId, a.executionSpaceId);
      assert.notEqual(c.executionSpaceId, b.executionSpaceId);
      assert.notEqual(c.caseId, a.caseId);
      assert.notEqual(c.branchId, a.branchId);
      assert.notEqual(c.initialContributionId, a.initialContributionId);
      assert.notEqual(c.admissionId, a.admissionId);
      assert.deepEqual(c.base!.release, {
        id: requestRelease.id,
        digest: requestRelease.digest,
      });
      assert.deepEqual(c.base!.manifest, requestRelease.manifest);
      assert.equal(
        c.base!.manifest.origin.executionSpaceId,
        a.executionSpaceId,
      );
      assert.equal(c.base!.manifest.source!.sourceVersion, current.version);
      assert.notEqual(c.base!.manifest.source!.sourceVersion, advanced.version);
      await completed(active, c);
      const fresh = await evidence(active, c);
      const freshRuns = await active.storage.client.executionRun.findMany({
        where: {
          ...scope,
          executionSpaceId: c.executionSpaceId,
          contributionId: c.initialContributionId,
        },
      });
      assert(freshRuns.length > 0);
      assert(
        freshRuns.every((run) =>
          run.errorJson === null && run.snapshotJson &&
          JSON.parse(run.snapshotJson).status !== "refused"
        ),
        "Completed Request-origin contribution must have an unrefused native snapshot before claiming a reply",
      );
      assert.equal(calls.get(c.executionSpaceId), 1);
      assert.equal(fresh.skills!.operations.length, 1);
      assert.equal(fresh.skills!.skills[0].loaded, true);
      assert.equal(fresh.skills!.skills[0].digest, seed.digest);
      assert.notEqual(
        fresh.bindings[0].bindingId,
        beforeA.bindings[0].bindingId,
      );
      assert.equal(fresh.bindings[0].executionSpaceId, c.executionSpaceId);
      assert.equal(
        fresh.state!.messages.filter((message) =>
          message.role === "assistant" &&
          message.text === `Scoped reply ${c.caseId}`
        ).length,
        1,
      );
      assert(
        fresh.effects.length > 0 &&
          fresh.effects.every((effect) => effect.authorizationJson),
      );
      assert.equal(
        await active.storage.client.spaceExecutionAdmission.count({
          where: scope,
        }),
        admissionsBeforeRequestRelease + 1,
      );
      assert.deepEqual(await evidence(active, a), beforeA);
      assert.deepEqual(await evidence(active, b), beforeB);
      assert.deepEqual(
        await main.stores.state.load(),
        mainBeforeRequestRelease,
      );
      assert.deepEqual(await main.stores.skills.load(operatorId), mainSkills);
      assert.deepEqual(
        await main.stores.memory.list(operatorId),
        mainMemoryBeforeRestore,
      );
      assert.equal(
        (await repository.history({ limit: 1 })).headVersion,
        advanced.version,
      );
      assert.equal(
        await active.sourceComposition.branches.sourceVersion(a),
        current.version,
      );
      await assertMainProviderCalls(2);
      mark("Request-origin retention/catalogue/fresh native reuse completed");
      const restoredAStores = await caseStores(active, a);
      assert.equal(
        (await restoredAStores.skills.load(restoredAStores.scope.operatorId))!
          .skills[0].loaded,
        false,
      );
      await assert.rejects(
        () =>
          active!.stage.openings.open({
            openingKey: "stale",
            text: "Must refuse stale main",
            source: { kind: "current-main", expectedVersion: current.version },
          }, session.secret),
        /expected version/,
      );
      await assert.rejects(
        () =>
          active!.stage.dispatchAccepted({
            ...acceptedA.delivery,
            identity: {
              ...acceptedA.delivery.identity,
              operatorId: "foreign-owner",
            },
          }, {
            ...scope,
            executionSpaceId: a.executionSpaceId,
            caseId: a.caseId,
          }, () =>
            Promise.reject(new Error("Case failure attempted Main routing"))),
        /routing is unavailable/,
      );
      // A retained Release with missing exact vault bytes cannot open new work.
      const artifactDigest =
        b.base!.manifest.operators[0].build!.artifactDigest;
      const artifactFile = `${vaultDirectory}/${artifactDigest}.zst`;
      await Deno.rename(artifactFile, `${artifactFile}.held`);
      try {
        const missing = await active.stage.openings.open({
          ...commands[1],
          openingKey: "missing-retained-bytes",
        }, session.secret);
        assert.notEqual(missing.phase, "dispatched");
        assert(missing.issues.length > 0);
      } finally {
        await Deno.rename(`${artifactFile}.held`, artifactFile);
      }
      const effectsBefore = await active.storage.client.executionEffect
        .findMany({
          where: scope,
          orderBy: [{ executionSpaceId: "asc" }, { effectKey: "asc" }],
        });
      await active.stage.controls.revokeCapability(controller);
      const requestStores = await caseStores(active, a);
      const state = (await requestStores.state.load())!;
      const deniedId = crypto.randomUUID();
      const denied: OperatorExecutionDelivery = {
        id: deniedId,
        kind: "contribution",
        identity: nativeExecutionIdentity(state, "conversation", deniedId),
        modelPin: {
          modelDigest: state.executionModel!.version.digest,
          repositoryVersion: state.executionModel!.version.repositoryVersion,
        },
        payload: {
          text: "No fresh effect after revocation",
          origin: "human",
          invocation: state.caseInvocation,
          receivedAt: new Date().toISOString(),
        },
      };
      const requestView = await active.stage.nativeRuntime.forCaseSpace(
        a.executionSpaceId,
        a.caseId,
      );
      const originalReplay = await requestView.dispatch.enqueue(
        acceptedA.delivery,
      );
      assert.equal(originalReplay.status, "completed");
      assert.equal(originalReplay.jobId, acceptedA.receipt.jobId);
      assert.equal(calls.get(a.executionSpaceId), 1);
      await requestView.dispatch.enqueue(denied);
      await eventually(async () => {
        const accepted = await requestView.dispatch.inspectAccepted(
          operatorId,
          deniedId,
        );
        return accepted?.receipt.status === "completed" ? accepted : undefined;
      });
      active.stage.nativeRuntime.stopAccepting();
      await active.stage.nativeRuntime.drain();
      assert.equal(workerErrors.length, 1);
      assert(workerErrors[0] instanceof NativeExecutionAdmissionRefused);
      assert.equal(calls.get(a.executionSpaceId), 1);
      assert.deepEqual(
        await active.storage.client.executionEffect.findMany({
          where: scope,
          orderBy: [{ executionSpaceId: "asc" }, { effectKey: "asc" }],
        }),
        effectsBefore,
      );
      assert(
        isDeepStrictEqual(await main.stores.state.load(), mainAfterBootstrap),
        "Case replay and revocation leave Main's post-bootstrap state exact",
      );
      assert(
        isDeepStrictEqual(
          await main.stores.memory.list(main.stores.scope.operatorId),
          mainMemoryBeforeRestore,
        ),
        "Case replay and revocation leave Main memory exact",
      );
      assert(
        isDeepStrictEqual(
          await main.stores.skills.load(main.stores.scope.operatorId),
          mainSkills,
        ),
        "Case replay and revocation leave Main skills exact",
      );
      assert.deepEqual(queueErrors, []);
      mark("reconstruction/replay/revocation checks complete");
      assert.deepEqual(await evidence(active, b), beforeB);
      assert.equal(
        (await evidence(active, b)).state!.messages.filter((message) =>
          message.role === "assistant" &&
          message.text === `Scoped reply ${b.caseId}`
        ).length,
        1,
      );
      // Explicit closure fixture after the original native revocation proof.
      // This exercises the canonical lifecycle operation and PostgreSQL CAS;
      // it does not claim that a scoped close HTTP command is implemented.
      const sourceStores = await caseStores(active, a);
      const sourceState = (await sourceStores.state.load())!;
      const closedAt = new Date().toISOString();
      const closedState = structuredClone(sourceState);
      closeCaseById(closedState, a.caseId, "done", { now: () => closedAt });
      closedState.revision = sourceState.revision + 1;
      await sourceStores.state.save(closedState, sourceState.revision);
      await active.storage.client.executionSpace.update({
        where: {
          projectId_systemId_executionSpaceId: {
            ...scope,
            executionSpaceId: a.executionSpaceId,
          },
        },
        data: {
          lifecycle: "closed",
          lifecycleRevision: { increment: 1 },
          closedAt: new Date(closedAt),
        },
      });
      assert.equal(
        (await active.storage.readCaseRuntimeState(
          a.executionSpaceId,
          a.caseId,
          operatorId,
        ))!.cases!.find((entry) => entry.id === a.caseId)!.status,
        "closed-done",
      );
      const closedBefore = await evidence(active, a, sourceStores);
      const freshBeforeClosedReads = await evidence(active, c);
      const closedSequenceBefore = await active.storage.client.caseSequence
        .findUniqueOrThrow({ where: { projectId_systemId: scope } });
      const closedAdmissionsBefore = await active.storage.client
        .spaceExecutionAdmission.count({ where: scope });
      const closedWritesBefore = await active.storage.client.modelWriteCommand
        .count({ where: { ...scope, repositoryId } });
      // The first capability was explicitly revoked above. A newly issued and
      // exchanged real current credential authorizes retention, never execution.
      const historicalCapability = await active.stage.controls.issueCapability(
        ownerId,
      );
      const historicalSession = await active.stage.controls.exchange(
        historicalCapability.secret,
      );
      const historicalController = await active.stage.controls
        .authenticateSession(historicalSession.secret);
      assert(historicalController.authority.acts.includes("retain-release"));
      await active.releaseComposition.releases.createTag(
        historicalSession.secret,
        {
          source: requestReleaseCommand.source,
          name: "request-a-closed-birth-release",
        },
      );
      const closedRelease = await active.releaseComposition.releases.save(
        historicalSession.secret,
        {
          ...requestReleaseCommand,
          saveKey: "request-a-closed-birth-release",
          tag: { mode: "existing", name: "request-a-closed-birth-release" },
          name: "Closed Request A exact birth model",
        },
      );
      assert.notEqual(closedRelease.id, requestRelease.id);
      assert.equal(closedRelease.status, "incomplete");
      assert.deepEqual(closedRelease.issues, ["PREREQUISITES_REQUIRED"]);
      assert.equal(closedRelease.assetAvailability, "verified");
      assert.equal(closedRelease.digest, requestRelease.digest);
      assert.deepEqual(closedRelease.manifest, requestRelease.manifest);
      const closedRow = await active.storage.client.savedSystem
        .findUniqueOrThrow({ where: { id: closedRelease.id } });
      assert.equal(closedRow.executionSpaceId, a.executionSpaceId);
      assert.equal(
        JSON.parse(closedRow.creationAuthorization!).capabilityId,
        historicalController.capabilityId,
      );
      assert(
        (await active.releaseComposition.releases.list(
          historicalSession.secret,
        )).some((entry) => entry.id === requestRelease.id),
      );
      assert.equal(
        (await active.releaseComposition.releases.inspect(
          historicalSession.secret,
          requestRelease.id,
        )).assetAvailability,
        "verified",
      );
      const historicalBase = await active.sourceComposition.source.resolve({
        kind: "release",
        releaseId: requestRelease.id,
        digest: requestRelease.digest,
      }, historicalController);
      assert.deepEqual(historicalBase.manifest, requestRelease.manifest);
      assert.equal(historicalBase.manifestDigest, requestRelease.digest);
      assert.equal(
        historicalBase.manifest.origin.executionSpaceId,
        a.executionSpaceId,
      );
      assert.equal(
        historicalBase.manifest.source!.sourceVersion,
        current.version,
      );
      assert.equal(
        (await active.storage.client.caseSequence.findUniqueOrThrow({
          where: { projectId_systemId: scope },
        })).lastNumber,
        closedSequenceBefore.lastNumber,
      );
      assert.equal(
        await active.storage.client.spaceExecutionAdmission.count({
          where: scope,
        }),
        closedAdmissionsBefore,
      );
      assert.equal(
        await active.storage.client.modelWriteCommand.count({
          where: { ...scope, repositoryId },
        }),
        closedWritesBefore,
      );
      assert.deepEqual(await evidence(active, a, sourceStores), closedBefore);
      assert.deepEqual(await evidence(active, b), beforeB);
      assert.deepEqual(await evidence(active, c), freshBeforeClosedReads);
      assert.deepEqual(
        await main.stores.state.load(),
        mainBeforeRequestRelease,
      );
      assert.deepEqual(await main.stores.skills.load(operatorId), mainSkills);
      assert.deepEqual(
        await main.stores.memory.list(operatorId),
        mainMemoryBeforeRestore,
      );
      assert.equal(
        (await repository.history({ limit: 1 })).headVersion,
        advanced.version,
      );
      assert.equal(calls.get(a.executionSpaceId), 1);
      assert.equal(calls.get(b.executionSpaceId), 1);
      assert.equal(calls.get(c.executionSpaceId), 1);
      await assertMainProviderCalls(2);
      assert.deepEqual(queueErrors, []);
      mark(
        "closed-source retention and historical source/asset eligibility verified; no new execution requested",
      );
    });
  },
});
