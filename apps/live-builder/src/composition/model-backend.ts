import type { ArtifactSourceServicePort } from "../application/work/artifacts/publication.ts";
import { createArtifactSourceServices } from "./artifact-source-services.ts";
import { ArtifactSourceError } from "../domain/work/artifacts/source-reference.ts";
import {
  type EvolutionSourceAssessmentPort,
  NativeEvolutionRepository,
} from "../adapters/model/evolution/repository.ts";
import { resolveRepositoryLayout } from "../adapters/out/filesystem/layout.ts";
import { readAssemblyEnv } from "../infrastructure/environment.ts";
import { canonical } from "../domain/primitives/canonical-json.ts";
import { recipeDigest } from "../domain/model/value-objects/build.ts";
import { defaultToolkitPackageDir } from "../infrastructure/native/runtime-location.ts";
/** Assemble the local Git source repository and embedded SysML compiler. */
import { join, resolve } from "node:path";
import { GitModelRepository } from "../adapters/out/git/repository.ts";
import { NativeModelSourceAuthorization } from "../adapters/governance/model-access/source-authorization.ts";
import {
  createModelProject,
  readModelProject,
  readProjectSources,
} from "../adapters/out/filesystem/model-project.ts";
import {
  ModelRepositoryError,
  type ModelRepositoryPort,
} from "../application/model/repository.ts";
import { ModelBuildService } from "../application/model/builds/service.ts";
import { ModelPublicationService } from "../application/model/publication/service.ts";
import type { ArtifactSourceWritePort } from "../application/model/publication/ports/out/artifact-source-write.port.ts";
import {
  buildAcceptProposalCommand,
  ModelWriteQueueError,
  ModelWriteWorker,
} from "../application/model/publication/write-queue.ts";
import { MemoizedModelCompiler } from "../application/model/builds/memoized-compiler.ts";
import { KvModelBuildStore } from "../adapters/out/deno-kv/kv-store.ts";
import { FileBuildVault } from "../adapters/out/filesystem/build-vault.ts";
import {
  PostgresModelWriteQueue,
  type PostgresRequestPublicationParticipant,
  type PostgresScopedSoftwarePublicationParticipant,
} from "../adapters/model/repository/writing/postgres-write-queue.ts";
import type { ScopedSoftwareSourceWriteResolver } from "../application/model/publication/ports/out/scoped-software-source-publication.port.ts";
import type {
  RequestSourceTargetOptions,
  RequestSourceWriteResolver,
} from "../application/model/publication/ports/out/request-source-publication.port.ts";
import type { RequestModelWriteLocator } from "../domain/model/editing/request-write-destination.ts";
import { repositoryWriterLock } from "../adapters/out/git/writer-lock.ts";
import type { PostgresHostStorage } from "../adapters/out/postgres/host-storage.ts";
import { safeStoragePort } from "../adapters/out/postgres/errors.ts";
import { QueuedModelWriter } from "../application/model/publication/queued-writer.ts";
import { DurableQueuedArtifactSourcePublisher } from "../application/model/write-queue/queued-artifact-source-publisher.ts";
import type { QueuedArtifactSourcePublication } from "../domain/work/artifacts/source-publication.ts";
import { NativeModelPublicationRevalidator } from "../adapters/governance/model-access/publication/policy.ts";
import { createHostEditExecutor } from "../adapters/model/sources/editing/host-writer.ts";
import { storedBuildMaterializer } from "../adapters/model/builds/materialization/stored.ts";
import { type SourceModelOptions } from "../adapters/model/sources/source-model.ts";
import { observeModelRevisions } from "../application/model/diagnostics/events.ts";
import { SysmlToolkitAdapter } from "../adapters/out/sysml-toolkit/adapter.ts";
import { ToolkitCompiler } from "../adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../adapters/out/filesystem/initial-model-sources.ts";
import {
  SourceModel,
  validateSourceExecutable,
} from "../adapters/model/sources/source-model.ts";

/** Assembly runs only on the SysML Toolkit: without it, nothing starts. */
export class ToolkitRequiredError extends Error {
  readonly code = "TOOLKIT_REQUIRED";
  readonly recovery =
    "deno task model:toolkit:setup, or export SYSML_TOOLKIT_DIR=<sysml-toolkit package directory>";
  constructor(readonly context: { packageDir: string }) {
    super(`The SysML Toolkit is required: no package at ${context.packageDir}`);
  }
}

/** Refuses a Toolkit directory without its package, before anything opens. */
export async function requireToolkitPackage(packageDir: string): Promise<void> {
  try {
    if ((await Deno.stat(join(packageDir, "package.json"))).isFile) return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  throw new ToolkitRequiredError({ packageDir });
}

/** The Toolkit package: `SYSML_TOOLKIT_DIR`, else the pinned local toolchain. */
export function toolkitPackageDir(): string {
  const overridden = Deno.env.get("SYSML_TOOLKIT_DIR");
  if (overridden) return overridden;
  return defaultToolkitPackageDir();
}

/** Desktop composition budget: the measured 19-source seed weighs 112.7 MB
 * under the conservative estimator. Keep a base and prepared candidate with
 * headroom; the generic build-service default remains suitable for small models. */
export const DEFAULT_BACKEND_BUILD_MEMORY_BYTES = 256 * 1024 * 1024;

export async function openModelBackend(
  dataDir: string,
  options: {
    storage: PostgresHostStorage;
    systemId: string;
    onRevision?: (version: string) => Promise<void>;
    buildMemoryCacheBytes?: number;
    /** Optional host-provided timing only; never receives model data. */
    observeToolkitTiming?: (
      event: {
        name: string;
        phase: "start" | "end" | "error";
        elapsedMs: number;
        pid?: number;
        utc?: string;
        inputBytes?: number;
        outputBytes?: number;
      },
    ) => void;
  },
) {
  const packageDir = toolkitPackageDir();
  await requireToolkitPackage(packageDir);
  await Deno.mkdir(dataDir, { recursive: true });
  const directory = await Deno.realPath(resolve(dataDir));
  const selectedProject = readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR");
  let project: Awaited<ReturnType<typeof readModelProject>>;
  if (selectedProject) {
    project = await readModelProject(resolve(selectedProject));
  } else {
    const defaultDirectory = join(directory, "model-project");
    try {
      project = await readModelProject(defaultDirectory);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      const created = await createModelProject({
        root: directory,
        name: "model-project",
        sources: await loadInitialSources(),
      });
      project = await readModelProject(created.directory);
    }
  }
  const projectId = `git:${project.id}`;
  await options.storage.registerSystem({
    projectId,
    systemId: options.systemId,
  });
  await options.storage.registerRepository(project.id, options.systemId);
  const timing = async <T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const observer = options.observeToolkitTiming;
    if (!observer) return await operation();
    const started = performance.now();
    const report = (phase: "start" | "end" | "error") => {
      try {
        observer({
          name,
          phase,
          elapsedMs: performance.now() - started,
          pid: Deno.pid,
          utc: new Date().toISOString(),
        });
      } catch { /* Observation cannot affect the operation. */ }
    };
    report("start");
    try {
      const value = await operation();
      report("end");
      return value;
    } catch (error) {
      report("error");
      throw error;
    }
  };
  const toolkit = new ToolkitCompiler({ packageDir });
  const rawTooling = new SysmlToolkitAdapter({ packageDir });
  const tooling = options.observeToolkitTiming
    ? new Proxy(rawTooling, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (
          typeof property !== "string" ||
          ![
            "compile",
            "check",
            "query",
            "board",
            "tokens",
            "views",
            "diagram",
            "plantuml",
            "snapshot",
            "describe",
            "referenceSites",
            "edit",
          ].includes(property) || typeof value !== "function"
        ) return value;
        return (...args: unknown[]) =>
          timing(`tooling.${property}`, async () =>
            await Reflect.apply(value, target, args));
      },
    })
    : rawTooling;
  const compiler = new MemoizedModelCompiler({
    async compile(sources: Record<string, string>) {
      return await timing("compiler.compile", async () => {
        const compiled = await timing(
          "compiler.toolkit",
          () => toolkit.compile(sources),
        );
        await timing("compiler.validate", () =>
          validateSourceExecutable({
            ...compiled,
            version: "compiled-before-publication",
          }, projectId));
        return compiled;
      });
    },
    recipe: () => timing("compiler.recipe", () => toolkit.recipe()),
  });
  const runtimeDirectory = (await resolveRepositoryLayout(project.projectDir))
    .stateDir;
  // Only host composition chooses storage locations. Disposable semantic
  // preparation and native consumption receive these exact project paths.
  const buildStorage = Object.freeze({
    cachePath: join(runtimeDirectory, "builds", "cache.kv"),
    vaultDirectory: join(runtimeDirectory, "builds", "vault"),
  });
  const store = await KvModelBuildStore.open({
    path: buildStorage.cachePath,
    observeCodecTiming: options.observeToolkitTiming,
  });
  const vault = new FileBuildVault({
    directory: buildStorage.vaultDirectory,
    observeCodecTiming: options.observeToolkitTiming,
  });
  await Deno.mkdir(runtimeDirectory, { recursive: true });
  const writerLock = await repositoryWriterLock(runtimeDirectory);
  // PRIMARY is initialized after this backend. Bind its Request authority once,
  // before automatic recovery; an early Request attempt cannot fall back to Main.
  let requestSourcePublication: {
    participant: PostgresRequestPublicationParticipant;
    resolver: RequestSourceWriteResolver;
  } | undefined;
  const requestBinding = () => {
    if (!requestSourcePublication) {
      throw new ModelWriteQueueError("WRITE_QUEUE_UNAVAILABLE", {
        repositoryId: project.id,
        reason: "The Request source publication authority is not bound",
      }, "The Request source publication authority is not bound");
    }
    return requestSourcePublication;
  };
  const requestSources: RequestSourceWriteResolver = {
    resolve: (dossier) => requestBinding().resolver.resolve(dossier),
  };
  function bindRequestSourcePublication(
    binding: NonNullable<typeof requestSourcePublication>,
  ) {
    if (requestSourcePublication) {
      throw new Error("Request source publication is already bound");
    }
    requestSourcePublication = Object.freeze({ ...binding });
  }
  let scopedSoftwarePublication: {
    participant: PostgresScopedSoftwarePublicationParticipant;
    resolver: ScopedSoftwareSourceWriteResolver;
  } | undefined;
  const softwareBinding = () => {
    if (!scopedSoftwarePublication) {
      throw new ModelWriteQueueError("WRITE_QUEUE_UNAVAILABLE", {
        repositoryId: project.id,
        reason: "Scoped software publication is not bound",
      }, "Scoped software publication is not bound");
    }
    return scopedSoftwarePublication;
  };
  const scopedSoftwareSources: ScopedSoftwareSourceWriteResolver = {
    resolve: (dossier) => softwareBinding().resolver.resolve(dossier),
  };
  function bindScopedSoftwareSourcePublication(
    binding: NonNullable<typeof scopedSoftwarePublication>,
  ) {
    if (scopedSoftwarePublication) {
      throw new Error("Scoped software publication is already bound");
    }
    scopedSoftwarePublication = Object.freeze({ ...binding });
  }
  const queue = safeStoragePort(
    new PostgresModelWriteQueue({
      client: options.storage.client,
      scope: options.storage.scope,
      requestPublication: {
        assertNewLocked: (tx, context) =>
          requestBinding().participant.assertNewLocked(tx, context),
        assertExpiryLocked: (tx, context) =>
          requestBinding().participant.assertExpiryLocked(tx, context),
        appendLocked: (tx, context) =>
          requestBinding().participant.appendLocked(tx, context),
      },
      scopedSoftwarePublication: {
        prepareCurrent: (context) =>
          softwareBinding().participant.prepareCurrent(context),
        assertNewLocked: (tx, context, token) =>
          softwareBinding().participant.assertNewLocked(tx, context, token),
        assertExpiryLocked: (tx, context, token) =>
          softwareBinding().participant.assertExpiryLocked(tx, context, token),
        appendLocked: (tx, context) =>
          softwareBinding().participant.appendLocked(tx, context),
      },
      writerLock: (repositoryId) => {
        if (repositoryId !== project.id) {
          throw new Error("Unknown source repository");
        }
        return Promise.resolve(writerLock);
      },
    }),
  );
  const leaseMs = 300_000;
  const buildService = new ModelBuildService({
    memoryCacheBytes: options.buildMemoryCacheBytes ??
      DEFAULT_BACKEND_BUILD_MEMORY_BYTES,
    repositoryId: project.id,
    store,
    vault,
    compiler,
    materializer: storedBuildMaterializer,
  });
  if (options.observeToolkitTiming) {
    const ensure = buildService.ensure.bind(buildService);
    buildService.ensure = (...args: Parameters<typeof ensure>) =>
      timing("build.ensure", () => ensure(...args));
  }
  let storedRepository: GitModelRepository;
  try {
    storedRepository = await GitModelRepository.open({
      projectDir: project.projectDir,
      repositoryId: project.id,
      compiler,
      buildService,
      buildVault: vault,
      requestSourceExecutor: createHostEditExecutor(tooling),
      sourceAuthorization: new NativeModelSourceAuthorization(
        projectId,
        tooling,
      ),
      writeFence: {
        assertCurrent: (fence) => queue.heartbeat(fence, leaseMs),
        guard: (fence, operation) =>
          queue.guardPublication(fence, leaseMs, operation),
      },
    });
    if (
      storedRepository.repositoryId !== project.id ||
      storedRepository.projectId !== projectId ||
      storedRepository.stateDir !== runtimeDirectory
    ) {
      throw new Error(
        "Source repository identity or writer environment changed",
      );
    }
  } catch (error) {
    await store.close();
    throw error;
  }
  const observedRepository = options.onRevision
    ? observeModelRevisions(storedRepository, options.onRevision)
    : storedRepository;
  const publication = new ModelPublicationService({
    repositoryId: project.id,
    repository: observedRepository as GitModelRepository,
    compiler,
    builds: buildService,
    executor: createHostEditExecutor(tooling),
    revalidator: new NativeModelPublicationRevalidator(projectId),
  });
  const artifactSourceRepository = storedRepository.artifactSources(
    options.storage.sourceScopeId,
  );
  let sourceAuthority:
    | ((publication: QueuedArtifactSourcePublication) => Promise<void>)
    | undefined;
  const artifactSourceWrites: ArtifactSourceWritePort = {
    scopeId: options.storage.sourceScopeId,
    repository: artifactSourceRepository,
    assertCurrent(publication) {
      const target = publication.target;
      if (
        target.projectId !== options.storage.scope.projectId ||
        target.systemId !== options.storage.scope.systemId
      ) return Promise.reject(new ArtifactSourceError("scope"));
      if (!sourceAuthority) {
        return Promise.reject(
          new ModelWriteQueueError("WRITE_QUEUE_UNAVAILABLE", {
            repositoryId: project.id,
            commandId: publication.publicationId,
            reason: "The current source publication authority is unavailable",
          }, "The current source publication authority is unavailable"),
        );
      }
      return sourceAuthority(publication);
    },
  };
  const worker = new ModelWriteWorker({
    queue,
    requestSources,
    scopedSoftwareSources,
    artifactSourceWrites,
    publication,
    repository: observedRepository as GitModelRepository,
    owner: `model-backend:${crypto.randomUUID()}`,
    leaseMs,
    heartbeatEveryMs: 10_000,
    recipeDigest: () => compiler.recipe().then(recipeDigest),
  });
  const writer = new QueuedModelWriter(
    project.id,
    queue,
    worker,
    compiler,
    storedRepository,
    requestSources,
    scopedSoftwareSources,
  );
  const artifactSourcePublisher = new DurableQueuedArtifactSourcePublisher({
    repositoryId: project.id,
    queue,
    artifactSourceWrites,
    pump: () => writer.pump(),
  });
  // The HTTP accept producer uses this surface. The worker owns the direct
  // repository port to avoid recursively enqueuing its own execution.
  const repository: ModelRepositoryPort = {
    ...observeModelRevisions(
      storedRepository,
      options.onRevision ?? (async () => {}),
    ),
    async accept(input) {
      const existing = await queue.getDossier(project.id, input.id);
      if (existing) {
        if (existing.v !== 1) {
          throw new ModelRepositoryError(
            "INVALID_REQUEST",
            "A Request source command cannot be resumed through Main",
          );
        }
        const decision = existing.decision;
        if (
          decision.kind !== "accept-proposal" ||
          decision.author !== input.author ||
          decision.expectedVersion !== input.expectedVersion ||
          canonical(decision.decisionAuthorityExercise ?? null) !==
            canonical(input.decisionAuthorityExercise ?? null) ||
          canonical(decision.evolutionDecision ?? null) !==
            canonical(input.evolutionDecision ?? null)
        ) {
          throw new ModelRepositoryError(
            "INVALID_REQUEST",
            "Acceptance differs from the original queued decision",
          );
        }
        return (await writer.resume(input.id))!;
      }
      const current = await storedRepository.current();
      if (current.version !== input.expectedVersion) {
        throw new ModelRepositoryError(
          "STALE_REVISION",
          "The approved source acceptance base changed",
        );
      }
      const proposal = await storedRepository.proposal(input.id);
      const base = await storedRepository.header(proposal.baseVersion);
      const dossier = await buildAcceptProposalCommand({
        repositoryId: project.id,
        proposal,
        expectedVersion: input.expectedVersion,
        author: input.author,
        baseSourceDigest: base.sourceDigest,
        recipeDigest: await writer.recipeDigest(),
        ...(input.evolutionDecision
          ? { evolutionDecision: input.evolutionDecision }
          : {}),
        ...(input.decisionAuthorityExercise
          ? { decisionAuthorityExercise: input.decisionAuthorityExercise }
          : {}),
      });
      return await writer.publish(dossier);
    },
  };
  // Observers are outside the writer lock and fire only after the durable
  // effect exists. Prepared publication flows through this worker wrapper.
  let initialSources: Record<string, string>;
  try {
    initialSources = (await repository.current()).sources;
  } catch (error) {
    if (
      !(error instanceof ModelRepositoryError) || error.code !== "NOT_FOUND"
    ) {
      await store.close();
      throw error;
    }
    try {
      initialSources = await readProjectSources(project.sourcesPath);
    } catch (readError) {
      await store.close();
      throw readError;
    }
  }
  const createSourceModel = (
    modelOptions: Pick<
      SourceModelOptions,
      "systemQualifiedName" | "sourcesDir" | "initialSources" | "creationScope"
    > = {},
  ) =>
    new SourceModel({
      repository,
      projectId,
      initialSources,
      tooling,
      ...modelOptions,
      writer,
    });
  const model = createSourceModel();
  const createEvolutionRepository = (assess: EvolutionSourceAssessmentPort) =>
    new NativeEvolutionRepository({
      repositoryId: project.id,
      repository,
      compiler,
      tooling,
      assess,
    });
  const artifactSourcesForScope = createArtifactSourceServices({
    client: options.storage.client,
    hostScope: options.storage.scope,
    repositoryId: project.id,
    sourceScopeId: options.storage.sourceScopeId,
    repository: artifactSourceRepository,
    queuedPublisher: artifactSourcePublisher,
    sourceHeader: (version) => storedRepository.header(version),
  });
  /** Compatibility facade for Main's existing operator-selected stores. */
  async function artifactSources(
    operatorId: string,
  ): Promise<ArtifactSourceServicePort> {
    const scoped = await options.storage.operator(operatorId);
    return await artifactSourcesForScope(scoped.scope);
  }
  function bindArtifactSourceAuthority(
    verify: (publication: QueuedArtifactSourcePublication) => Promise<void>,
  ): () => void {
    sourceAuthority = verify;
    writer.start();
    return () => {
      if (sourceAuthority === verify) sourceAuthority = undefined;
    };
  }
  const stopSourceWriter = () => writer.close();
  const retention = {
    /** All published ancestors, admissions, proposal refs and journals stay roots. */
    referencedArtifacts: () => storedRepository.reachableArtifactDigests(),
    async preserveReferenced() {
      const referenced = await storedRepository.reachableArtifactDigests();
      const missing: string[] = [];
      for (const digest of referenced) {
        if (await vault.getVerified(digest).catch(() => null)) continue;
        try {
          await vault.putVerified(digest, await store.get(digest));
        } catch {
          missing.push(digest);
        }
      }
      return {
        referenced,
        missing,
        complete: missing.length === 0,
        evictionPermitted: false as const,
      };
    },
  };
  try {
    await retention.preserveReferenced();
  } catch (error) {
    await store.close();
    throw error;
  }
  // The host binds all current runtime/skill authority before automatic
  // recovery can claim source-retention commands. Explicit publishers share pump.
  let closing: Promise<void> | undefined;
  const close = () =>
    closing ??= (async () => {
      try {
        await writer.close();
      } finally {
        compiler.clear();
        buildService.clearMemory();
        await store.close();
      }
    })();
  return {
    repository,
    model,
    createSourceModel,
    createEvolutionRepository,
    store,
    buildService,
    buildStorage,
    vault,
    queue,
    writer,
    sourceWriteLeaseMs: leaseMs,
    bindRequestSourcePublication,
    bindScopedSoftwareSourcePublication,
    scopedSoftwareRepository: storedRepository,
    requestSourceTarget: (target: RequestSourceTargetOptions) =>
      storedRepository.requestSourceTarget(target),
    readRequestSourceProposal: (
      locator: RequestModelWriteLocator,
      id: string,
    ) => storedRepository.readRequestSourceProposal(locator, id),
    artifactSourceRepository,
    writerLock,
    retainSavedSystemCommit: (version: string) =>
      storedRepository.retainSavedSystemCommit(version),
    artifactSourcePublisher,
    artifactSources,
    artifactSourcesForScope,
    bindArtifactSourceAuthority,
    stopSourceWriter,
    retention,
    close,
    compiler,
    directory,
    tooling,
    toolkitPackageDirectory: packageDir,
    projectId,
    project,
  };
}
