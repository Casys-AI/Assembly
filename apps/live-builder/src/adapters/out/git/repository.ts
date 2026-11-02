import type { ClockPort } from "../../../application/work/runtime/ports.ts";
import { SystemClock } from "../../../infrastructure/clock.ts";
import { sha256Bytes as sha256 } from "../../../domain/primitives/sha256-bytes.ts";
import { persistedOrder } from "../../../domain/primitives/persisted-order.ts";
import {
  isSessionlessRequestAuthority,
  requestWriteAuthorityMemberProvenanceMatches,
  requestWriteAuthorityPrior,
} from "../../../application/model/source-admission/request-delegated-authority.ts";
import { sameOwnerAuthorityIdentity } from "../../../domain/governance/authority.ts";
import {
  assertScopedSoftwareAdmissionEvidence,
  parseScopedSoftwareSourceAdmission,
  type ScopedSoftwareSourceAdmissionV2,
} from "../../../application/model/source-admission/scoped-software-source-admission.ts";
import {
  assertScopedSoftwareWriteMatchesEvolution,
  scopedSoftwareWriteCommandDigest,
  scopedSoftwareWriteDossierDigest,
} from "../../../application/model/publication/scoped-software-write.ts";
import type {
  ScopedSoftwareSourcePublicationContext,
  ScopedSoftwareSourceWriteFacade,
  ScopedSoftwareSourceWriteOptions,
} from "../../../application/model/publication/ports/out/scoped-software-source-publication.port.ts";
import {
  parseScopedSoftwareContext,
  type ScopedSoftwareContextV2,
} from "../../../application/model/evolution/scoped-software-context.ts";
import {
  assertRequestChangeDossier,
  type RequestChangeDossier,
} from "../../../application/model/publication/request-change.ts";
import {
  requestNetworkCompatibility,
  requestTeamBystanders,
  requestTeamCompatibility,
} from "../../../application/model/evolution/request-adoption-invariants.ts";
import { requestChangeEffect } from "../../../domain/governance/records/request-change.ts";
import { requestOperatorSystemName } from "../../governance/authority/operator/writer.ts";
import { isTeamOperatorSpec } from "../../../domain/governance/operator-authority.ts";
import { matchesTeamProvision } from "../../../domain/governance/policies/operator-creation-policy.ts";
import type { HostEditExecutorPort } from "../../../application/model/publication/ports/out/host-edit-executor.port.ts";
import { gitBlobIdentity } from "./blob-identity.ts";
import {
  isRequestSourceHistoryConflict,
  isRequestSourceProofUnavailable,
  isRequestSourceSettlementUnavailable,
  ModelRepositoryInspectionUnavailableError,
} from "../../../application/model/publication/request-source-context.ts";
import {
  parseRequestModelWriteDestination,
  parseRequestModelWriteLocator,
  type RequestModelWriteDestination,
  type RequestModelWriteLocator,
} from "../../../domain/model/editing/request-write-destination.ts";
import {
  assertModelWriteDestinationMatches,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
  type ModelWriteDossierV2,
  parseModelWriteDossierV2,
} from "../../../application/model/publication/write-command-v2.ts";
import {
  parseRequestSourceOwnerPhaseBinding,
  type RequestSourceOwnerPhaseBinding,
} from "../../../application/model/source-admission/request-source-owner.ts";
import {
  parseRequestSourceAdmission,
  type RequestSourceAdmission,
} from "../../../application/model/source-admission/request-source-admission.ts";
import {
  requestSourceAdmissionRef,
  requestSourceCommandRef,
  scopedSoftwareSourceAdmissionRef,
  scopedSoftwareSourceCommandRef,
} from "../../../domain/model/editing/request-source-publication.ts";
import { validateSourceEvolutionExecutables } from "../../model/sources/source-model.ts";
import { classifyEvolutionEffects } from "../../../domain/model/evolution/semantic-effects.ts";
import { requireEvolutionEffectBounds } from "../../../domain/model/evolution/authorization.ts";
import type { ModelIdentity } from "../../../domain/work/dialogue.ts";
import {
  type RequestSourcePublicationContext,
  RequestSourcePublicationPending,
  type RequestSourceTarget,
  type RequestSourceTargetOptions,
} from "../../../application/model/publication/ports/out/request-source-publication.port.ts";
import type { WriteLease } from "../../../application/model/publication/ports/out/model-write-queue.port.ts";
import {
  type ModelChangedFile,
  type ModelCommit,
  type ModelFileLastChange,
  type ModelFirstParentInterval,
  parseModelAuthor,
} from "../../../domain/model/records/revision.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import {
  anyPublicationAuthor,
  type AnySourcePublication,
  assertAnyPublicationSize,
  assertPublicationSize,
  isPreparedPublication,
  MAX_APPROVAL_RECEIPT_BYTES,
  parseAnyPublication,
  type PreparedPublication,
} from "../../../domain/model/publication/change.ts";
import {
  ChangePublicationError,
  publicationAuthor,
  publicationFailure,
  publicationSystemId,
  type SourcePublication,
} from "../../../domain/model/publication/change.ts";
import type { ModelBuildVaultPort } from "../../../application/model/builds/ports/out/build-vault.port.ts";
import {
  artifactBytesFor,
  type ModelBuildService,
  ModelBuildServiceError,
} from "../../../application/model/builds/service.ts";
import type { BuildDescriptor } from "../../../domain/model/value-objects/build.ts";
import {
  classifyGitRevisionBuildPaths,
  decodeGitRevisionBuild,
  DESCRIPTOR_BUILD_PATH,
  encodeBuildRef,
  GitRevisionFormatError,
  LEGACY_BUILD_PATH,
  LEGACY_DESCRIPTOR_BUILD_PATH,
  parseBuildRefText,
} from "./revision-format.ts";
import type { SystemSourcesUpdateOptions } from "../../../application/model/repository.ts";
import { lstat } from "node:fs/promises";
import type { ModelProposalAuthorization } from "../../../domain/governance/records/model-edit-authorization.ts";
import {
  type ModelDiagnosticAddress,
  modelDiagnosticAddresses,
} from "../../../domain/model/value-objects/diagnostic-address.ts";
import type { ModelSourceAuthorizationPort } from "../../../application/governance/ports/out/model-source-authorization.port.ts";
import {
  modelCommitHash,
  parseModelRevisionId,
} from "../../../domain/shared-kernel/revision-id.ts";
import { technicalLogger } from "../../../infrastructure/logging.ts";

const log = technicalLogger("composition");
/** Local immutable Git snapshots. The editable sources workspace is never reset.
 * All reference/journal writers share the OS lock, including across processes.
 */
import {
  canonical,
  compareCodeUnits,
} from "../../../domain/primitives/canonical-json.ts";
import type { CompiledModel } from "../../../domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../../domain/model/value-objects/sources.ts";
import { materialize } from "../../model/builds/materialization/artifact.ts";
import { readModelProject } from "../filesystem/model-project.ts";
import {
  type RepositoryLayout,
  resolveRepositoryLayout,
} from "../filesystem/layout.ts";
import { validateModelSources as validateSources } from "../../../domain/model/value-objects/sources.ts";
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
} from "../../../domain/model/value-objects/sources.ts";
import {
  diffSources,
  mergeSources,
} from "../../model/sources/changes/merge.ts";
import {
  ModelRepositoryError,
  type ModelRepositoryPort,
  type PublicationFence,
  type WriteCommandAnchor,
} from "../../../application/model/repository.ts";
import {
  type ModelHistory,
  type ModelRevision,
  type ModelRevisionHeader,
  type ProposalRecord,
} from "../../../domain/model/records/revision.ts";
import type { ModelCompiler } from "../../../application/model/builds/ports/out/model-compiler.port.ts";
import { compareModelGraphDocuments } from "../../../domain/model/projections/graph-diff.ts";
import type { GraphDiff } from "../../../domain/model/records/graph-diff.ts";
import type { ArtifactSource } from "../../../domain/work/artifacts/source-publication.ts";
import type {
  ArtifactSourcePublication,
  ArtifactSourcePublicationReceipt,
  ArtifactSourceRepositoryPort,
  ArtifactSourceRetentionOptions,
} from "../../../application/work/artifacts/source-repository.ts";
import {
  ARTIFACT_MANIFEST_DIGEST,
  ARTIFACT_MANIFEST_FORMAT,
  artifactEntry,
  artifactPrefix,
  ArtifactSourceError,
  type ArtifactSourceReference,
  requireSource,
  sourceIdentity,
  validateSourceReference,
} from "../../../domain/work/artifacts/source-reference.ts";
import {
  artifactUtf8,
  decodeArtifactSource,
  encodeArtifactSource,
  MAX_ARTIFACT_CONTENT_BYTES,
} from "./artifact-content.ts";
import {
  type ArtifactPackageManifest,
  MAX_ARTIFACT_TOTAL_BYTES,
  MAX_PACKAGE_MANIFEST_BYTES,
  MAX_REPOSITORY_MANIFEST_BYTES,
  packageManifestDigest,
  packageReference,
  parsePackageManifest,
  parseRepositoryManifest,
  REPOSITORY_FORMAT_PATH,
  repositoryManifest,
} from "./repository-format.ts";
import { repositoryWriterLock } from "./writer-lock.ts";

export interface GitRepositoryOptions {
  clock?: ClockPort;
  projectDir: string;
  repositoryId?: string;
  compiler: ModelCompiler;
  preparationConcurrency?: number;
  sourceAuthorization?: ModelSourceAuthorizationPort;
  /** Trusted immutable actor reader; absent in production uses retained Git
   * source reconstruction. Allows controlled compiler compositions in tests. */
  scopedSoftwareActor?: (
    scope: ScopedSoftwareContextV2,
  ) => Promise<
    import("../../../domain/model/execution/executable-model.ts").ExecutableModel
  >;
  /** Pure existing host executor, required only for closed approved Case network changes. */
  requestSourceExecutor?: HostEditExecutorPort;
  /** W2 build service. When injected (with repositoryId equal to this
   * repository's manifest identity), new commits carry a build descriptor
   * and descriptor commits resolve through it. Without it, the legacy inline
   * snapshot format is written exactly as before; reading a descriptor commit
   * then fails explicitly with BUILD_UNAVAILABLE, never INVALID_REPOSITORY. */
  buildService?: ModelBuildService;
  /** Durable vault receiving verified bytes at snapshot time, before the
   * descriptor commit can name them: history stays readable after the exact
   * recipe is gone (`resolve` reads cache → vault before any rebuild). */
  buildVault?: ModelBuildVaultPort;
  /** W4 fence guard, consulted under the writer lock immediately before a
   * CAS. Required to serve fenced publications; without it a supplied fence
   * refuses (fail-closed), never a silent pass. */
  writeFence?: {
    assertCurrent(fence: PublicationFence): Promise<void>;
    /** Hold the queue's publication claim through the Git ref transaction. */
    guard<T>(fence: PublicationFence, operation: () => Promise<T>): Promise<T>;
  };
}
/** Historical reads expose no admission, recovery, export or writer surface. */
export interface GitModelRepositoryReader {
  readonly repositoryId: string;
  readonly projectId: string;
  at(version: string, signal?: AbortSignal): Promise<ModelRevision>;
  descriptorAt(
    version: string,
    signal?: AbortSignal,
  ): Promise<BuildDescriptor | null>;
  readFirstParentInterval(
    fromVersion: string,
    toVersion: string,
    maxVersions?: number,
    signal?: AbortSignal,
  ): Promise<ModelFirstParentInterval>;
}

/** Host-owned eligibility capability; ordinary historical consumers need only
 * GitModelRepositoryReader and never infer a branch from an execution pin. */
export interface GitModelReleaseSourceReader extends GitModelRepositoryReader {
  admittedMainSource(
    version: string,
  ): Promise<{ headVersion: string; sourceDigest: string }>;
}
export interface GitRequestSourceProofReader
  extends GitModelReleaseSourceReader {
  /** Verify immutable publication anchors without following a live branch. */
  verifyRequestSourceAdmission(
    admission: RequestSourceAdmission,
  ): Promise<void>;
  /** Dedicated software receipt/anchors; never decode as human authority. */
  verifyScopedSoftwareSourceAdmission(
    admission: ScopedSoftwareSourceAdmissionV2,
  ): Promise<void>;
}

function check(
  value: unknown,
  code: ModelRepositoryError["code"],
  message: string,
): asserts value {
  if (!value) throw new ModelRepositoryError(code, message);
}
function publicationRef(changeId: string): string {
  check(
    /^[0-9a-f-]{36}$/.test(changeId),
    "INVALID_REQUEST",
    "Invalid approved change ID",
  );
  return `refs/ase/approved-changes/${changeId}`;
}
/** Lookup index for durable write commands (W4); never an authority. */
function commandRef(commandId: string): string {
  check(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(commandId) &&
      !commandId.includes("..") && !commandId.endsWith(".") &&
      !commandId.endsWith(".lock"),
    "INVALID_REQUEST",
    "Invalid write command ID",
  );
  return `refs/ase/write-commands/${commandId}`;
}
/** Command trailer binding digest to the acceptance commit itself, so the
 * anchor proves (commandId, digest) and recovery can recreate the ref. */
function commandTrailer(command: WriteCommandAnchor): string {
  commandRef(command.commandId);
  check(
    /^[0-9a-f]{64}$/.test(command.commandDigest),
    "INVALID_REQUEST",
    "Invalid write command digest",
  );
  return `ASE-Write-Command: ${command.commandId} ${command.commandDigest}`;
}
function isFenceLost(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    (error as { code?: unknown }).code === "WRITE_FENCE_LOST";
}
function sha(version: string): string {
  try {
    return modelCommitHash(parseModelRevisionId(version));
  } catch {
    throw new ModelRepositoryError(
      "INVALID_REQUEST",
      "Invalid immutable model version",
    );
  }
}

function actor(value: string): string {
  check(
    typeof value === "string" && value.trim().length > 0 &&
      value.length <= 200 && !/[\r\n\0]/.test(value),
    "INVALID_REQUEST",
    "Invalid repository author",
  );
  return value.trim();
}
function reasonText(value: string): string {
  check(
    typeof value === "string" && value.trim().length > 0 &&
      value.length <= 4000 && !value.includes("\0"),
    "INVALID_REQUEST",
    "Invalid repository reason",
  );
  return value.trim();
}
function commitMessage(body: string): string {
  return body.split("\n")[0];
}
class Pool {
  active = 0;
  waiting: Array<() => void> = [];
  constructor(readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
const pools = new Map<string, Pool>();
const main = "refs/heads/admitted";
const zero = "0".repeat(40);
/** Bound complete interval commit headers/messages before requesting contents. */
const MAX_INTERVAL_COMMIT_BYTES = 1024 * 1024;
interface Snapshot {
  repositoryId: string;
  compiled: CompiledModel;
  digest: string;
}
interface GitBlob {
  oid: string;
  size: number;
}
function decodeGitBlobs(
  bytes: Uint8Array,
  rows: GitBlob[],
): Map<string, string> {
  const blobs = new Map<string, string>();
  let offset = 0;
  for (const row of rows) {
    const end = bytes.indexOf(10, offset);
    check(end >= offset, "INVALID_REPOSITORY", "Incomplete Git batch header");
    const header = new TextDecoder().decode(bytes.subarray(offset, end));
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    check(
      match && match[1] === row.oid && Number(match[2]) === row.size,
      "INVALID_REPOSITORY",
      "Invalid Git batch object or declared size",
    );
    offset = end + 1;
    check(
      offset + row.size < bytes.length && bytes[offset + row.size] === 10,
      "INVALID_REPOSITORY",
      "Incomplete Git batch object",
    );
    blobs.set(
      row.oid,
      artifactUtf8(bytes.subarray(offset, offset + row.size)),
    );
    offset += row.size + 1;
  }
  check(
    offset === bytes.length,
    "INVALID_REPOSITORY",
    "Trailing Git batch bytes",
  );
  return blobs;
}
interface RequestProposalRecord extends ProposalRecord {
  requestSource: {
    format: "request-source-proposal/v1";
    destination: RequestModelWriteDestination;
    authority: RequestSourceOwnerPhaseBinding<"proposal">;
  };
}
type RequestSourceGitReceipt =
  & Pick<
    RequestSourceAdmission,
    | "destination"
    | "openingBaseDigest"
    | "predecessor"
    | "commandDigest"
    | "dossierDigest"
    | "decisionDigest"
    | "authorityDigest"
  >
  & {
    format: "request-source-publication/v1";
    result: Omit<RequestSourceAdmission["result"], "source">;
  };
type ScopedSoftwareSourceGitReceipt =
  & Omit<ScopedSoftwareSourceAdmissionV2, "format" | "result" | "publication">
  & {
    format: "request-software-source-publication/v2";
    proposalVersion: string;
    result: Omit<ScopedSoftwareSourceAdmissionV2["result"], "source">;
  };
interface ScopedSoftwareProposalRecord extends ProposalRecord {
  softwareRequestSource: {
    format: "request-software-source-proposal/v2";
    scope: ScopedSoftwareContextV2;
  };
}
interface Manifest {
  kind: "assembly-local-git-v1" | "ase-local-git-v1";
  repositoryId: string;
  workspace: "sources";
  activeRef: typeof main;
  status?: "creating" | "ready";
  initialVersion?: string;
}
export class GitModelRepository implements ModelRepositoryPort {
  readonly #clock: ClockPort;
  readonly engine = "Git";
  readonly directory: string;
  get projectId(): string {
    return `git:${this.#identity}`;
  }
  /** Manifest identity shared by snapshots, build descriptors and write
   * commands for this repository. */
  get repositoryId(): string {
    return this.#identity;
  }
  readonly stateDir: string;
  readonly gitDir: string;
  readonly #compiler: ModelCompiler;
  readonly #readOnly: boolean;
  #pool!: Pool;
  #queue: Promise<unknown> = Promise.resolve();
  #identity!: string;
  // Only the expensive, deterministic IR reconstruction is memoized. Every read
  // still reads Git's tree and blobs, checks their bytes and verifies the digest.
  readonly #verifiedArtifacts = new Map<string, string>();
  readonly #sourceDigests = new Map<string, string>();
  readonly #commitMetadata = new Map<string, Promise<ModelCommit>>();
  readonly #fileChanges = new Map<string, Promise<ModelChangedFile[]>>();
  readonly #lastChanges = new Map<string, Promise<ModelFileLastChange[]>>();
  #recoveredState?: string;
  #recoveryObjects = new Set<string>();
  #collectingRecoveryObjects?: Set<string>;
  readonly #looseObjectDirectories = new Map<
    string,
    { metadata: string; names: Set<string> }
  >();
  private constructor(
    readonly options: GitRepositoryOptions,
    readonly layout: RepositoryLayout,
    readOnly = false,
  ) {
    this.#clock = options.clock ?? new SystemClock();
    this.directory = options.projectDir;
    this.stateDir = layout.stateDir;
    this.gitDir = `${options.projectDir}/.git`;
    this.#compiler = options.compiler;
    this.#readOnly = readOnly;
  }
  /** Open an existing repository without locks, initialization, recovery or
   * filesystem writes. Missing historical builds never invoke a compiler. */
  static async #openReadOnlyRepository(options: {
    projectDir: string;
    repositoryId?: string;
    buildService?: ModelBuildService;
    signal?: AbortSignal;
  }): Promise<GitModelRepository> {
    const signal = options.signal;
    signal?.throwIfAborted();
    const step = async <T>(operation: () => Promise<T>): Promise<T> => {
      signal?.throwIfAborted();
      const value = await operation();
      signal?.throwIfAborted();
      return value;
    };
    check(
      typeof options.projectDir === "string" && options.projectDir.length > 0,
      "INVALID_REQUEST",
      "Project directory is required",
    );
    check(
      options.repositoryId === undefined ||
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
          options.repositoryId,
        ),
      "INVALID_REQUEST",
      "Invalid project repository identity",
    );
    const refuseCompiler = () => {
      throw new Error(
        "Read-only model repository cannot compile or resolve recipes",
      );
    };
    const repo = new GitModelRepository(
      {
        ...options,
        compiler: { compile: refuseCompiler, recipe: refuseCompiler },
      },
      await resolveRepositoryLayout(options.projectDir),
      true,
    );
    try {
      for (
        const path of [
          options.projectDir,
          repo.layout.metadataDir,
          repo.stateDir,
          repo.gitDir,
        ]
      ) await step(() => repo.#safeDirectory(path));
      for (
        const path of [
          `${repo.stateDir}/repository.json`,
          `${repo.gitDir}/HEAD`,
        ]
      ) {
        const info = await step(() => Deno.lstat(path));
        check(
          info.isFile && !info.isSymlink && info.size <= 65_536,
          "INVALID_REPOSITORY",
          "Invalid existing repository metadata file",
        );
      }
      const manifest = await step(() =>
        repo.#read<Manifest>("repository.json")
      );
      check(
        (manifest?.kind === "assembly-local-git-v1" ||
          manifest?.kind === "ase-local-git-v1") &&
          manifest.workspace === "sources" && manifest.activeRef === main &&
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
            manifest.repositoryId,
          ) && (manifest.status === undefined || manifest.status === "ready"),
        "INVALID_REPOSITORY",
        "Invalid or unfinished local Git repository manifest",
      );
      let projectIdentity = options.repositoryId;
      let hasProjectManifest = true;
      try {
        // Its absence is supported by legacy repositories; a present but
        // damaged project manifest must not be mistaken for its absence.
        await step(() =>
          Deno.lstat(`${options.projectDir}/model-project.json`)
        );
      } catch (error) {
        signal?.throwIfAborted();
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        hasProjectManifest = false;
      }
      if (hasProjectManifest) {
        const project = await step(() => readModelProject(options.projectDir));
        check(
          !projectIdentity || projectIdentity === project.id,
          "INVALID_REPOSITORY",
          "Requested repository identity differs from project manifest",
        );
        projectIdentity = project.id;
      }
      projectIdentity ??= manifest.repositoryId;
      check(
        projectIdentity === manifest.repositoryId,
        "INVALID_REPOSITORY",
        "Project identity differs from Git repository identity",
      );
      repo.#identity = manifest.repositoryId;
      check(
        (await step(() =>
          repo.#git(
            ["rev-parse", "--is-bare-repository"],
            undefined,
            false,
            false,
            signal,
          )
        )).trim() ===
          "false",
        "INVALID_REPOSITORY",
        "Expected non-bare local model repository",
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ModelRepositoryError) throw error;
      throw new ModelRepositoryError(
        "INVALID_REPOSITORY",
        `Cannot open existing model repository: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    signal?.throwIfAborted();
    return repo;
  }
  static async openReadOnly(options: {
    projectDir: string;
    repositoryId?: string;
    buildService?: ModelBuildService;
    signal?: AbortSignal;
  }): Promise<GitRequestSourceProofReader> {
    const repo = await this.#openReadOnlyRepository(options);
    return Object.freeze({
      repositoryId: repo.repositoryId,
      projectId: repo.projectId,
      at: (version: string, signal?: AbortSignal) =>
        repo.#atWithBuildPolicy(version, false, signal),
      admittedMainSource: (version: string) => repo.admittedMainSource(version),
      verifyRequestSourceAdmission: (admission: RequestSourceAdmission) =>
        repo.verifyRequestSourceAdmission(admission),
      verifyScopedSoftwareSourceAdmission: (
        admission: ScopedSoftwareSourceAdmissionV2,
      ) => repo.verifyScopedSoftwareSourceAdmission(admission),
      descriptorAt: (version: string, signal?: AbortSignal) =>
        repo.descriptorAt(version, signal),
      readFirstParentInterval: (
        fromVersion: string,
        toVersion: string,
        maxVersions = 128,
        signal?: AbortSignal,
      ) =>
        repo.#readFirstParentInterval(
          fromVersion,
          toVersion,
          maxVersions,
          signal,
        ),
    });
  }
  /** Separate scope-bound read surface; opening never initializes or recovers. */
  static async openArtifactSourcesReadOnly(options: {
    projectDir: string;
    repositoryId?: string;
    scopeId: string;
    signal?: AbortSignal;
  }): Promise<Pick<ArtifactSourceRepositoryPort, "read">> {
    const scopeId = options.scopeId;
    requireSource(sourceIdentity(scopeId), "invalid");
    let repo: GitModelRepository;
    try {
      repo = await this.#openReadOnlyRepository({ ...options });
    } catch {
      options.signal?.throwIfAborted();
      throw new ArtifactSourceError("repository");
    }
    return Object.freeze({
      read: (reference: ArtifactSourceReference) =>
        repo.#sourceCall(() => repo.#readArtifactSource(scopeId, reference)),
    });
  }
  static async open(
    options: GitRepositoryOptions,
  ): Promise<GitModelRepository> {
    check(
      options.projectDir.length > 0,
      "INVALID_REQUEST",
      "Project directory is required",
    );
    const repo = new GitModelRepository(
      options,
      await resolveRepositoryLayout(options.projectDir),
    );
    await repo.#safeDirectory(options.projectDir);
    for (
      const path of [
        repo.layout.metadataDir,
        repo.stateDir,
        `${repo.stateDir}/proposals`,
        repo.gitDir,
      ]
    ) {
      try {
        await repo.#safeDirectory(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    await Deno.mkdir(`${repo.stateDir}/proposals`, { recursive: true });
    await repo.#safeDirectory(repo.stateDir);
    await repo.#safeDirectory(`${repo.stateDir}/proposals`);
    const key = await Deno.realPath(repo.stateDir);
    const shared = pools.get(key);
    const limit = options.preparationConcurrency ?? shared?.limit ?? 2;
    check(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 16 &&
        (!shared || shared.limit === limit),
      "INVALID_REQUEST",
      "Invalid shared preparation concurrency",
    );
    repo.#pool = shared ?? new Pool(limit);
    pools.set(key, repo.#pool);
    await repo.#exclusive(async () => {
      check(
        !options.repositoryId ||
          /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
            options.repositoryId,
          ),
        "INVALID_REQUEST",
        "Invalid project repository identity",
      );
      let projectIdentity: string | undefined = options.repositoryId;
      try {
        const id = (await readModelProject(options.projectDir)).id;
        check(
          !projectIdentity || projectIdentity === id,
          "INVALID_REPOSITORY",
          "Requested repository identity differs from project manifest",
        );
        projectIdentity = id;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      let manifest = await repo.#read<Manifest>("repository.json");
      if (!manifest) {
        // Never adopt or overwrite an unrelated object database.
        try {
          await Deno.stat(repo.gitDir);
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            "Unidentified Git directory already exists",
          );
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        manifest = {
          kind: "assembly-local-git-v1",
          repositoryId: projectIdentity ?? crypto.randomUUID(),
          workspace: "sources",
          activeRef: main,
          status: "creating",
        };
        await repo.#write("repository.json", manifest);
      }
      check(
        (manifest.kind === "assembly-local-git-v1" ||
          manifest.kind === "ase-local-git-v1") &&
          manifest.workspace === "sources" && manifest.activeRef === main &&
          /^[a-f0-9-]{36}$/.test(manifest.repositoryId),
        "INVALID_REPOSITORY",
        "Invalid local Git repository manifest",
      );
      check(
        !projectIdentity || manifest.repositoryId === projectIdentity,
        "INVALID_REPOSITORY",
        "Project identity differs from Git repository identity",
      );
      repo.#identity = manifest.repositoryId;
      try {
        await Deno.stat(`${repo.gitDir}/HEAD`);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        check(
          manifest.status === "creating" && !manifest.initialVersion,
          "INVALID_REPOSITORY",
          "Initialized Git repository is missing HEAD",
        );
        await repo.#git(
          ["init", "--initial-branch=workspace", options.projectDir],
          undefined,
          true,
        );
      }
      check(
        (await repo.#git(["rev-parse", "--is-bare-repository"])).trim() ===
          "false",
        "INVALID_REPOSITORY",
        "Expected non-bare local model repository",
      );
      await repo.#recoverInitialization(manifest);
      await repo.#recover();
    });
    return repo;
  }
  async #git(
    args: string[],
    input?: string,
    initialize = false,
    allowFailure: boolean | "silent" = false,
    signal?: AbortSignal,
  ): Promise<string> {
    return new TextDecoder().decode(
      await this.#gitBytes(
        args,
        input,
        initialize,
        allowFailure,
        undefined,
        signal,
      ),
    );
  }
  async #gitBytes(
    args: string[],
    input?: string,
    initialize = false,
    allowFailure: boolean | "silent" = false,
    maxOutputBytes?: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    signal?.throwIfAborted();
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command("git", {
        signal,
        args: [
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "protocol.allow=never",
          ...(initialize ? [] : [`--git-dir=${this.gitDir}`]),
          ...args,
        ],
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
          ...(this.#readOnly ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_ALLOW_PROTOCOL: "",
          GIT_AUTHOR_NAME: "ASE",
          GIT_AUTHOR_EMAIL: "ase@local.invalid",
          GIT_COMMITTER_NAME: "ASE",
          GIT_COMMITTER_EMAIL: "ase@local.invalid",
        },
        stdin: input === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch {
      throw new ModelRepositoryInspectionUnavailableError(
        "git-executable",
        "Local Git executable could not be started",
      );
    }
    const writeInput = async () => {
      if (input === undefined) return;
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(input));
      } finally {
        await writer.close();
      }
    };
    const readOutput = async (): Promise<Deno.CommandOutput> => {
      if (maxOutputBytes === undefined) return await child.output();
      const readStdout = async () => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for await (const chunk of child.stdout) {
            size += chunk.length;
            check(
              size <= maxOutputBytes,
              "INVALID_REPOSITORY",
              "Git batch output exceeds declared object sizes",
            );
            chunks.push(chunk);
          }
        } catch (error) {
          try {
            child.kill("SIGKILL");
          } catch {
            // The process may already have exited; still reap it below.
          }
          throw error;
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return bytes;
      };
      const [status, stdout, stderr] = await Promise.allSettled([
        child.status,
        readStdout(),
        new Response(child.stderr).arrayBuffer(),
      ]);
      if (stdout.status === "rejected") throw stdout.reason;
      if (status.status === "rejected") throw status.reason;
      if (stderr.status === "rejected") throw stderr.reason;
      return {
        ...status.value,
        stdout: stdout.value,
        stderr: new Uint8Array(stderr.value),
      };
    };
    // Drain stdout while feeding batch requests; neither pipe may wait for the
    // other to empty, including when a damaged tree contains unexpected entries.
    // Reap/drain both sides even if the declared-size bound stops the child.
    const [result, written] = await Promise.allSettled([
      readOutput(),
      writeInput(),
    ]);
    signal?.throwIfAborted();
    if (result.status === "rejected") throw result.reason;
    if (written.status === "rejected") throw written.reason;
    const output = result.value;
    check(
      output.success ||
        allowFailure && output.code === 1 &&
          (allowFailure === true || output.stderr.length === 0),
      "INVALID_REPOSITORY",
      `Local Git ${args[0]} failed: ${
        new TextDecoder().decode(output.stderr).slice(0, 300)
      }`,
    );
    return output.success ? output.stdout : new Uint8Array();
  }
  async #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.#queue.then(async () => {
      // Resolve lazily on writer calls only. Queue claims and their SQL guard
      // share this exact canonical OS lock; historical readers never open it.
      const lock = await repositoryWriterLock(this.stateDir);
      return await lock.runExclusive(fn);
    });
    this.#queue = pending.catch(() => {});
    return await pending;
  }
  async #write(path: string, value: unknown): Promise<void> {
    const temporary = `${this.stateDir}/${path}.${crypto.randomUUID()}.tmp`;
    const file = await Deno.open(temporary, { createNew: true, write: true });
    try {
      const bytes = new TextEncoder().encode(
        JSON.stringify({ value, digest: await sha256(canonical(value)) }),
      );
      let offset = 0;
      while (offset < bytes.length) {
        offset += await file.write(bytes.subarray(offset));
      }
      await file.sync();
    } finally {
      file.close();
    }
    await Deno.rename(temporary, `${this.stateDir}/${path}`);
  }
  async #read<T>(path: string): Promise<T | undefined> {
    try {
      const envelope = JSON.parse(
        await Deno.readTextFile(`${this.stateDir}/${path}`),
      );
      check(
        envelope.digest === await sha256(canonical(envelope.value)),
        "INVALID_REPOSITORY",
        `Changed repository journal: ${path}`,
      );
      return envelope.value;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      if (error instanceof ModelRepositoryError) throw error;
      throw new ModelRepositoryError(
        "INVALID_REPOSITORY",
        `Invalid repository journal: ${path}`,
      );
    }
  }
  async #head(): Promise<string | undefined> {
    const result = (await this.#git(
      ["rev-parse", "--verify", "--quiet", main],
      undefined,
      false,
      true,
    ))
      .trim();
    if (result) return `commit:${result}`;
    const manifest = await this.#read<Manifest>("repository.json");
    check(
      manifest?.status === "creating",
      "INVALID_REPOSITORY",
      "Initialized Git repository is missing admitted revision",
    );
    return undefined;
  }
  /** Early lease check under #exclusive. #guardedRefUpdate then holds the
   * queue claim across the actual Git ref transaction. */
  async #assertFence(fence?: PublicationFence): Promise<void> {
    if (!fence) return;
    check(
      fence.repositoryId === this.#identity,
      "INVALID_REQUEST",
      "Publication fence belongs to another model repository",
    );
    check(
      this.options.writeFence,
      "INVALID_REQUEST",
      "Fenced publication requires a configured write fence guard",
    );
    await this.options.writeFence.assertCurrent(fence);
  }
  async #guardedRefUpdate<T>(
    fence: PublicationFence | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!fence) return await operation();
    check(
      fence.repositoryId === this.#identity && this.options.writeFence,
      "INVALID_REQUEST",
      "Fenced publication requires a matching write fence guard",
    );
    return await this.options.writeFence.guard(fence, operation);
  }
  async #cas(ref: string, version: string, previous?: string): Promise<void> {
    await this.#git([
      "update-ref",
      ref,
      sha(version),
      previous ? sha(previous) : zero,
    ]);
  }
  async #snapshot(
    compiled: CompiledModel,
    parents: string[],
    author: string,
    message: string,
    publication?: AnySourcePublication,
    command?: WriteCommandAnchor,
    preparedDescriptor?: BuildDescriptor,
    requestSourceReceipt?: RequestSourceGitReceipt,
    softwareSourceReceipt?: ScopedSoftwareSourceGitReceipt,
  ): Promise<string> {
    validateSources(compiled.sources);
    if (publication) assertAnyPublicationSize(publication);
    // Enumerate the exact immutable parent once, also retaining its artifact
    // entries below. Never consult HEAD or a cross-repository/OID cache here.
    const parent = parents[0]
      ? await this.#sourceEntries(sha(parents[0]))
      : undefined;
    const parentSources = new Map(
      parent?.rows.map((row) => [row.path, row.oid]),
    );
    const entries: Array<{ path: string; oid: string }> = [];
    for (const [path, content] of Object.entries(compiled.sources)) {
      const sourcePath = `sources/${path}`;
      const previous = parentSources.get(sourcePath);
      // Initial and newly added paths retain the direct write path. Existing
      // paths reuse only the exact parent's matching Git blob identity.
      const unchanged = previous && await gitBlobIdentity(content) === previous;
      entries.push({
        path: sourcePath,
        oid: unchanged
          ? previous
          : (await this.#git(["hash-object", "-w", "--stdin"], content)).trim(),
      });
    }
    if (this.options.buildService) {
      // W2e: verified bytes enter the store before the descriptor names them.
      const recipe = preparedDescriptor
        ? (() => {
          const { digest: _digest, ...inputs } = preparedDescriptor.recipe;
          return inputs;
        })()
        : await this.#compiler.recipe();
      const descriptor = await this.options.buildService.ensure(
        compiled,
        recipe,
      );
      if (preparedDescriptor) {
        check(
          canonical(descriptor) === canonical(preparedDescriptor),
          "INVALID_REQUEST",
          "Snapshot build differs from verified prepared descriptor",
        );
      }
      // Vault before the commit names A: losing the cache and later the
      // exact recipe must never make admitted history unreadable.
      if (this.options.buildVault) {
        await this.options.buildVault.putVerified(
          descriptor.artifactDigest,
          artifactBytesFor(compiled),
        );
      }
      const ref = encodeBuildRef(descriptor);
      entries.push({
        path: ref.path,
        oid: (await this.#git(["hash-object", "-w", "--stdin"], ref.text))
          .trim(),
      });
    } else {
      const snapshot: Snapshot = {
        repositoryId: this.#identity,
        compiled,
        digest: await sha256(canonical(compiled)),
      };
      entries.push({
        path: LEGACY_BUILD_PATH,
        oid: (await this.#git(
          ["hash-object", "-w", "--stdin"],
          canonical(snapshot),
        ))
          .trim(),
      });
    }
    // Preserve retained packages when this parent already uses the common format.
    // They remain outside canonical model source/build identities.
    if (parent) {
      entries.push(...parent.entries.filter((entry) =>
        entry.type === "blob" &&
        (entry.path.startsWith("artifacts/") ||
          entry.path === REPOSITORY_FORMAT_PATH)
      ));
    }
    const oid = (await this.#git(
      [
        "commit-tree",
        await this.#tree(entries),
        ...parents.flatMap((parent) => ["-p", sha(parent)]),
      ],
      `${message}\n\n${
        publication ? `ASE-Approval: ${canonical(publication)}\n` : ""
      }${command ? `${commandTrailer(command)}\n` : ""}${
        requestSourceReceipt
          ? `ASE-Request-Source: ${canonical(requestSourceReceipt)}\n`
          : ""
      }${
        softwareSourceReceipt
          ? `ASE-Software-Source: ${canonical(softwareSourceReceipt)}\n`
          : ""
      }ASE-Author: ${author}\n`,
    )).trim();
    const version = `commit:${oid}`;
    // Verify the complete immutable tree before any reference can publish it.
    await this.#atWithBuildPolicy(version, false);
    return version;
  }
  async #tree(entries: Array<{ path: string; oid: string }>): Promise<string> {
    const tree = async (prefix: string): Promise<string> => {
      const files = entries.filter((entry) => entry.path.startsWith(prefix));
      const names = [
        ...new Set(
          files.map((entry) => entry.path.slice(prefix.length).split("/")[0]),
        ),
      ].sort();
      const rows: string[] = [];
      for (const name of names) {
        const path = prefix + name;
        const file = files.find((entry) => entry.path === path);
        rows.push(
          file
            ? `100644 blob ${file.oid}\t${name}\0`
            : `040000 tree ${await tree(path + "/")}\t${name}\0`,
        );
      }
      return (await this.#git(["mktree", "-z"], rows.join(""))).trim();
    };
    return await tree("");
  }
  async current(): Promise<ModelRevision> {
    const version = await this.#head();
    check(version, "NOT_FOUND", "Model repository is not initialized");
    return await this.at(version);
  }
  /** Host binds an opaque source namespace; no path or authority comes from a reference.
   * This port retains bytes only. Composition must separately authorize the caller. */
  artifactSources(scopeId: string): ArtifactSourceRepositoryPort {
    requireSource(sourceIdentity(scopeId), "invalid");
    return Object.freeze({
      retain: (
        publication: ArtifactSourcePublication,
        options?: ArtifactSourceRetentionOptions,
      ) =>
        this.#sourceCall(() =>
          this.#retainArtifactSource(scopeId, publication, options)
        ),
      read: (reference: ArtifactSourceReference) =>
        this.#sourceCall(() => this.#readArtifactSource(scopeId, reference)),
      findByCommand: (command: WriteCommandAnchor) =>
        this.#sourceCall(() =>
          this.#findArtifactSourceCommand(scopeId, command)
        ),
    });
  }
  async #sourceCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof ArtifactSourceError || isFenceLost(error) ||
        error instanceof ModelRepositoryError &&
          error.code === "EDIT_SCOPE_DENIED"
      ) {
        throw error;
      }
      throw new ArtifactSourceError("repository");
    }
  }
  async #directSourceRef(ref: string): Promise<string | null> {
    const symbolic = await this.#git(
      ["symbolic-ref", "--quiet", ref],
      undefined,
      false,
      "silent",
    );
    requireSource(!symbolic.trim(), "integrity");
    const oid = (await this.#git(
      ["rev-parse", "--verify", "--quiet", ref],
      undefined,
      false,
      "silent",
    )).trim();
    requireSource(!oid || /^[0-9a-f]{40}$/.test(oid), "integrity");
    return oid || null;
  }
  #sourceCommandRef(command: WriteCommandAnchor): string {
    commandTrailer(command);
    return `refs/assembly/source-commands/${command.commandId}`;
  }
  async #artifactReceipt(
    scopeId: string,
    oid: string,
    digest?: string,
    command?: WriteCommandAnchor,
  ): Promise<ArtifactSourcePublicationReceipt> {
    const { packageManifests } = await this.#sourceEntries(oid);
    const selected = [...packageManifests].filter(([key, manifest]) =>
      manifest.scopeId === scopeId &&
      (digest === undefined || key === digest) &&
      (command === undefined ||
        canonical(manifest.command) === canonical(command))
    );
    requireSource(selected.length === 1, "integrity");
    const [manifestDigest, manifest] = selected[0];
    const reference = packageReference(manifest, manifestDigest, oid);
    await this.#readArtifactSource(scopeId, reference);
    return {
      version: 1,
      reference,
      baseVersion: manifest.modelBase.version,
      baseSourceDigest: manifest.modelBase.sourceDigest,
      ...(manifest.command ? { command: manifest.command } : {}),
    };
  }
  async #findArtifactSourceCommand(
    scopeId: string,
    command: WriteCommandAnchor,
  ): Promise<ArtifactSourcePublicationReceipt | null> {
    requireSource(sourceIdentity(scopeId), "invalid");
    const oid = await this.#directSourceRef(this.#sourceCommandRef(command));
    if (!oid) return null;
    return await this.#artifactReceipt(scopeId, oid, undefined, command);
  }
  async #readArtifactSource(
    scopeId: string,
    input: ArtifactSourceReference,
  ): Promise<ArtifactSource> {
    const reference = structuredClone(input);
    validateSourceReference(reference);
    requireSource(
      reference.scopeId === scopeId &&
        reference.repositoryId === this.#identity,
      "scope",
    );
    const retained = await this.#directSourceRef(
      `refs/assembly/sources/v2/${reference.manifestDigest}`,
    );
    requireSource(retained, "not-found");
    requireSource(retained === reference.commitOid, "integrity");
    const { entries, packageManifests } = await this.#sourceEntries(retained);
    const manifest = packageManifests.get(reference.manifestDigest);
    requireSource(
      manifest &&
        canonical(
            packageReference(manifest, reference.manifestDigest, retained),
          ) === canonical(reference),
      "integrity",
    );
    const row = entries.find((entry) =>
      entry.path === reference.entryPath && entry.type === "blob"
    );
    requireSource(row, "integrity");
    const { blobs } = await this.#readBlobs(retained, [row]);
    return await decodeArtifactSource(
      manifest,
      blobs.get(row.oid)!,
      reference.contentDigest,
    );
  }
  async #retainArtifactSource(
    scopeId: string,
    input: ArtifactSourcePublication,
    options?: ArtifactSourceRetentionOptions,
  ): Promise<ArtifactSourcePublicationReceipt> {
    requireSource(!this.#readOnly, "repository");
    const assertCurrent = options?.assertCurrent;
    const publication = structuredClone(input);
    requireSource(
      Boolean(publication.command) === Boolean(publication.fence),
      "invalid",
    );
    if (publication.command) {
      this.#sourceCommandRef(publication.command);
      requireSource(
        publication.command.commandId === publication.fence?.commandId,
        "invalid",
      );
    }
    const content = await encodeArtifactSource(publication.source);
    return await this.#exclusive(async () => {
      await assertCurrent?.();
      await this.#assertFence(publication.fence);
      if (publication.command) {
        const existing = await this.#findArtifactSourceCommand(
          scopeId,
          publication.command,
        );
        if (existing) {
          requireSource(
            existing.baseVersion === publication.baseVersion &&
              existing.reference.artifactId === publication.source.artifactId &&
              existing.reference.kind === publication.source.kind &&
              existing.reference.contentDigest === content.digest,
            "integrity",
          );
          await assertCurrent?.();
          return existing;
        }
      }
      const base = await this.#atWithBuildPolicy(
        publication.baseVersion,
        false,
      );
      const manifest: ArtifactPackageManifest = {
        version: 2,
        format: ARTIFACT_MANIFEST_FORMAT,
        scopeId,
        repositoryId: this.#identity,
        artifactId: publication.source.artifactId,
        kind: publication.source.kind,
        entryPath: artifactEntry(publication.source.kind),
        contentEncoding: publication.source.kind === "tool-draft"
          ? "tool-draft-json-v1"
          : "utf8-v1",
        contentDigest: content.digest,
        manifestDigestVersion: ARTIFACT_MANIFEST_DIGEST,
        modelBase: { version: base.version, sourceDigest: base.sourceDigest },
        ...(publication.command ? { command: publication.command } : {}),
      };
      const digest = await packageManifestDigest(manifest);
      const retainedRef = `refs/assembly/sources/v2/${digest}`;
      const existing = await this.#directSourceRef(retainedRef);
      if (existing) {
        const receipt = await this.#artifactReceipt(
          scopeId,
          existing,
          digest,
          publication.command,
        );
        if (publication.command) {
          await this.#assertFence(publication.fence);
          await this.#guardedRefUpdate(publication.fence, async () => {
            await assertCurrent?.();
            return await this.#git([
              "update-ref",
              "--no-deref",
              this.#sourceCommandRef(publication.command!),
              existing,
              zero,
            ]);
          });
        }
        await assertCurrent?.();
        return receipt;
      }
      const parent = await this.#sourceEntries(sha(base.version));
      const packages = [...parent.packageManifests.keys(), digest];
      const prefix = artifactPrefix(digest);
      const entries = parent.entries.filter((entry) =>
        entry.type === "blob" && entry.path !== REPOSITORY_FORMAT_PATH
      );
      for (
        const [path, text] of [
          [prefix + manifest.entryPath, content.text],
          [prefix + "manifest.json", canonical(manifest)],
          [
            REPOSITORY_FORMAT_PATH,
            canonical(repositoryManifest(this.#identity, packages)),
          ],
        ]
      ) {
        entries.push({
          type: "blob",
          path,
          size: new TextEncoder().encode(text).length,
          oid: (await this.#git(["hash-object", "-w", "--stdin"], text)).trim(),
        });
      }
      const oid = (await this.#git(
        ["commit-tree", await this.#tree(entries), "-p", sha(base.version)],
        `Retain Assembly artifact source v2 ${digest}\n${
          publication.command
            ? `Assembly-Source-Command: ${publication.command.commandId} ${publication.command.commandDigest}\n`
            : ""
        }`,
      )).trim();
      await this.#atWithBuildPolicy(`commit:${oid}`, false);
      await this.#assertFence(publication.fence);
      await this.#guardedRefUpdate(
        publication.fence,
        async () => {
          await assertCurrent?.();
          return await this.#git(
            ["update-ref", "--no-deref", "--stdin"],
            `start\ncreate ${retainedRef} ${oid}\n${
              publication.command
                ? `create ${
                  this.#sourceCommandRef(publication.command)
                } ${oid}\n`
                : ""
            }prepare\ncommit\n`,
          );
        },
      );
      return await this.#artifactReceipt(
        scopeId,
        oid,
        digest,
        publication.command,
      );
    });
  }
  async at(version: string, signal?: AbortSignal): Promise<ModelRevision> {
    return await this.#atWithBuildPolicy(version, true, signal);
  }
  async #readFirstParentInterval(
    fromVersion: string,
    toVersion: string,
    maxVersions: number,
    signal?: AbortSignal,
  ): Promise<ModelFirstParentInterval> {
    const fromOid = sha(fromVersion);
    sha(toVersion);
    check(
      Number.isSafeInteger(maxVersions) && maxVersions >= 1 &&
        maxVersions <= 128,
      "INVALID_REQUEST",
      "Invalid first-parent interval version limit (expected 1..128)",
    );
    await this.#readVersion(fromVersion, async () => {
      check(
        (await this.#git(
          ["cat-file", "-t", fromOid],
          undefined,
          false,
          false,
          signal,
        ))
          .trim() === "commit",
        "INVALID_REPOSITORY",
        "Model interval endpoint is not a commit",
      );
    }, signal);
    const versions: ModelFirstParentInterval["versions"] = [];
    let version = toVersion;
    let complete = false;
    let reason: ModelFirstParentInterval["reason"];
    while (true) {
      signal?.throwIfAborted();
      const parents = await this.#readVersion(version, async (oid) => {
        // Read actual commit headers, including every merge parent. A shallow
        // boundary must not silently turn a stored first parent into a root.
        const metadata = new TextDecoder().decode(
          await this.#gitBytes(
            ["cat-file", "--batch-check"],
            `${oid}\n`,
            false,
            false,
            256,
            signal,
          ),
        );
        const match = new RegExp(`^${oid} commit (\\d+)\\n$`).exec(metadata);
        check(
          match,
          "INVALID_REPOSITORY",
          "Model interval object is not a commit",
        );
        const size = Number(match[1]);
        check(
          Number.isSafeInteger(size) && size > 0 &&
            size <= MAX_INTERVAL_COMMIT_BYTES,
          "INVALID_REPOSITORY",
          "Git interval commit exceeds the 1 MiB read limit",
        );
        const expectedHeader = `${oid} commit ${size}`;
        const storedBytes = await this.#gitBytes(
          ["cat-file", "--batch"],
          `${oid}\n`,
          false,
          false,
          expectedHeader.length + size + 2,
          signal,
        );
        check(
          storedBytes.length === expectedHeader.length + size + 2,
          "INVALID_REPOSITORY",
          "Incomplete Git interval commit object",
        );
        const stored = new TextDecoder().decode(storedBytes);
        const firstLine = stored.indexOf("\n");
        check(
          stored.slice(0, firstLine) === expectedHeader,
          "INVALID_REPOSITORY",
          "Model interval object is not a commit",
        );
        const commit = stored.slice(firstLine + 1);
        const headers = commit.split("\n\n", 1)[0].split("\n");
        check(
          /^tree [a-f0-9]{40}$/.test(headers[0]),
          "INVALID_REPOSITORY",
          "Invalid Git interval commit",
        );
        return headers.filter((header) => header.startsWith("parent "))
          .map((header) => {
            const match = /^parent ([a-f0-9]{40})$/.exec(header);
            check(match, "INVALID_REPOSITORY", "Invalid Git interval parent");
            return `commit:${match[1]}`;
          });
      }, signal);
      versions.push({ version, parents });
      if (version === fromVersion) {
        complete = true;
        break;
      }
      if (!parents.length) {
        reason = "from-not-on-first-parent";
        break;
      }
      if (versions.length >= maxVersions) {
        reason = "version-limit";
        break;
      }
      version = parents[0];
    }
    return {
      fromVersion,
      toVersion,
      versions: versions.reverse(),
      complete,
      ...(reason ? { reason } : {}),
    };
  }
  async #atWithBuildPolicy(
    version: string,
    allowRebuild: boolean,
    signal?: AbortSignal,
  ): Promise<ModelRevision> {
    return await this.#readVersion(
      version,
      (oid) => this.#readRevision(oid, version, signal, allowRebuild),
      signal,
    );
  }
  /** Source-only read of a commit: independent of stored build entries and of the
   * artifact-derived digest caches, so a consumer can pin a projection before
   * reading its artifact. Compiler artifact integrity remains the duty of at(). */
  async header(
    version: string,
    signal?: AbortSignal,
  ): Promise<ModelRevisionHeader> {
    return await this.#readVersion(version, async (oid) => {
      const { rows } = await this.#sourceEntries(oid, signal);
      const { blobs } = await this.#readBlobs(oid, rows, signal);
      const sources = validateSources(Object.fromEntries(
        rows.map((row) => [row.path.slice(8), blobs.get(row.oid)!]),
      ));
      return {
        version,
        sources,
        sourceDigest: await modelSourceDigest(sources),
      };
    }, signal);
  }
  /** Read the immutable build identity without requiring artifact bytes or an
   * executable historical recipe. A legacy commit has no provable R/K/A. */
  async descriptorAt(
    version: string,
    signal?: AbortSignal,
  ): Promise<BuildDescriptor | null> {
    return await this.#readVersion(version, async (oid) => {
      const { entries } = await this.#sourceEntries(oid, signal);
      let format: "legacy" | "descriptor";
      try {
        format = classifyGitRevisionBuildPaths(
          entries.map((entry) => entry.path),
        );
      } catch (error) {
        if (error instanceof GitRevisionFormatError) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            `Invalid Git model build entry: ${error.code}`,
          );
        }
        throw error;
      }
      if (format === "legacy") return null;
      const entry = entries.find((row) =>
        row.path === DESCRIPTOR_BUILD_PATH ||
        row.path === LEGACY_DESCRIPTOR_BUILD_PATH
      );
      check(
        entry && entry.type === "blob" && entry.size <= 65_536,
        "INVALID_REPOSITORY",
        "Invalid Git build descriptor size",
      );
      try {
        const text = await this.#git(
          ["cat-file", "blob", entry.oid],
          undefined,
          false,
          false,
          signal,
        );
        const descriptor = parseBuildRefText(text);
        check(
          descriptor.repositoryId === this.#identity,
          "INVALID_REPOSITORY",
          "Build descriptor belongs to another repository",
        );
        return descriptor;
      } catch (error) {
        if (error instanceof GitRevisionFormatError) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            `Invalid Git model build entry: ${error.code}`,
          );
        }
        throw error;
      }
    }, signal);
  }
  /** Conservative W2g roots: every commit reachable from every Git ref,
   * plus revisions named by interrupted proposal journals. An invalid tree
   * aborts retention instead of silently dropping a live artifact. */
  async reachableArtifactDigests(): Promise<Set<string>> {
    const records = await this.#records();
    const journalVersions = records.flatMap((record) => [
      record.baseVersion,
      record.proposalVersion,
      record.targetVersion,
      record.acceptanceBaseVersion,
      record.acceptedVersion,
    ]).filter((version): version is string => !!version);
    const history = await this.#git([
      "rev-list",
      "--all",
      ...journalVersions.map(sha),
    ]);
    const digests = new Set<string>();
    for (const oid of history.split("\n").filter(Boolean)) {
      const descriptor = await this.descriptorAt(`commit:${oid}`);
      if (descriptor) digests.add(descriptor.artifactDigest);
    }
    return digests;
  }
  async #readVersion<T>(
    version: string,
    read: (oid: string) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const oid = sha(version);
    try {
      return await read(oid);
    } catch (error) {
      signal?.throwIfAborted();
      // A missing version is distinct from an unreadable repository or a
      // known object whose model snapshot is damaged or absent.
      const resolved = await this.#git(
        ["rev-parse", "--verify", "--quiet", `${oid}^{object}`],
        undefined,
        false,
        "silent",
        signal,
      );
      check(resolved.trim(), "NOT_FOUND", "Model version not found");
      if (error instanceof ModelRepositoryError) throw error;
      // W2 build failures keep their own codes: a lost or unavailable build
      // is not repository corruption.
      if (error instanceof ModelBuildServiceError) throw error;
      throw new ModelRepositoryError(
        "INVALID_REPOSITORY",
        `Invalid Git model snapshot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  async #sourceEntries(oid: string, signal?: AbortSignal) {
    // Validate metadata before requesting any blob contents. Two subprocesses
    // per revision, independent of source count; each unique blob is read once.
    const paths = new Set<string>();
    const listing = await this.#gitBytes(
      ["ls-tree", "-r", "-t", "-l", "-z", oid],
      undefined,
      false,
      false,
      1_048_576,
      signal,
    );
    const entries = artifactUtf8(listing).split("\0").filter(Boolean).map(
      (row) => {
        const match = /^(\d+) (blob|tree) ([a-f0-9]{40}) +(-|\d+)\t([\s\S]+)$/
          .exec(row);
        check(match, "INVALID_REPOSITORY", "Invalid Git snapshot tree entry");
        const [, mode, type, objectId, length, path] = match;
        check(
          !paths.has(path),
          "INVALID_REPOSITORY",
          "Git source tree differs from compiled snapshot",
        );
        paths.add(path);
        check(
          type === "tree"
            ? mode === "040000" && length === "-" &&
              (path === "sources" || path.startsWith("sources/") ||
                path === "artifacts" || /^artifacts\/[0-9a-f]{64}$/.test(path))
            : mode === "100644" && length !== "-" &&
              (path === LEGACY_BUILD_PATH || path === DESCRIPTOR_BUILD_PATH ||
                path === LEGACY_DESCRIPTOR_BUILD_PATH ||
                path === REPOSITORY_FORMAT_PATH ||
                /^artifacts\/[0-9a-f]{64}\/(?:manifest\.json|source\.json|SKILL\.md)$/
                  .test(path) ||
                path.startsWith("sources/")),
          "INVALID_REPOSITORY",
          "Unexpected Git snapshot path or mode",
        );
        const size = type === "blob" ? Number(length) : 0;
        check(
          Number.isSafeInteger(size) && size >= 0,
          "INVALID_REPOSITORY",
          "Invalid Git object size",
        );
        return { type, oid: objectId, path, size };
      },
    );
    const rows = entries.filter((entry) =>
      entry.type === "blob" && entry.path.startsWith("sources/")
    );
    // Reuse the domain's file-count and path/collision rules without loading text.
    validateSources(
      Object.fromEntries(rows.map((row) => [row.path.slice(8), ""])),
    );
    let total = 0;
    const directories = new Set<string>(["sources"]);
    for (const row of rows) {
      total += row.size;
      check(
        row.size <= MAX_FILE_BYTES && total <= MAX_TOTAL_BYTES,
        "INVALID_REPOSITORY",
        "SysML source size limit exceeded",
      );
      const parts = row.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        directories.add(parts.slice(0, i).join("/"));
      }
    }
    const packageManifests = new Map<string, ArtifactPackageManifest>();
    const artifactRows = entries.filter((entry) =>
      entry.type === "blob" &&
      (entry.path === REPOSITORY_FORMAT_PATH ||
        entry.path.startsWith("artifacts/"))
    );
    const formatRow = artifactRows.find((entry) =>
      entry.path === REPOSITORY_FORMAT_PATH
    );
    if (artifactRows.length) {
      check(
        formatRow && formatRow.size <= MAX_REPOSITORY_MANIFEST_BYTES,
        "INVALID_REPOSITORY",
        "Missing or oversized common repository manifest",
      );
      let artifactTotal = 0;
      for (const row of artifactRows) {
        artifactTotal += row.size;
        check(
          row.size <=
              (row.path === REPOSITORY_FORMAT_PATH
                ? MAX_REPOSITORY_MANIFEST_BYTES
                : row.path.endsWith("/manifest.json")
                ? MAX_PACKAGE_MANIFEST_BYTES
                : MAX_ARTIFACT_CONTENT_BYTES) &&
            artifactTotal <= MAX_ARTIFACT_TOTAL_BYTES,
          "INVALID_REPOSITORY",
          "Artifact source size limit exceeded",
        );
      }
      const { blobs } = await this.#readBlobs(oid, artifactRows, signal);
      const format = parseRepositoryManifest(
        blobs.get(formatRow.oid)!,
        this.#identity,
      );
      const expected = new Set([REPOSITORY_FORMAT_PATH]);
      for (const digest of format.packages) {
        const prefix = artifactPrefix(digest);
        const manifestRow = artifactRows.find((row) =>
          row.path === prefix + "manifest.json"
        );
        check(
          manifestRow,
          "INVALID_REPOSITORY",
          "Missing artifact package manifest",
        );
        const manifest = parsePackageManifest(
          blobs.get(manifestRow.oid)!,
          this.#identity,
        );
        check(
          await packageManifestDigest(manifest) === digest,
          "INVALID_REPOSITORY",
          "Artifact package manifest digest mismatch",
        );
        const contentRow = artifactRows.find((row) =>
          row.path === prefix + manifest.entryPath
        );
        check(
          contentRow,
          "INVALID_REPOSITORY",
          "Missing artifact source entry",
        );
        await decodeArtifactSource(
          manifest,
          blobs.get(contentRow.oid)!,
          manifest.contentDigest,
        );
        expected.add(prefix + "manifest.json");
        expected.add(prefix + manifest.entryPath);
        directories.add("artifacts");
        directories.add(prefix.slice(0, -1));
        packageManifests.set(digest, manifest);
      }
      check(
        artifactRows.length === expected.size &&
          artifactRows.every((row) => expected.has(row.path)),
        "INVALID_REPOSITORY",
        "Undeclared artifact package entries",
      );
    }
    check(
      entries.every((entry) =>
        entry.type !== "tree" || directories.has(entry.path)
      ),
      "INVALID_REPOSITORY",
      "Unexpected Git snapshot directory",
    );
    return { entries, rows, packageManifests };
  }
  async #readBlobs(
    oid: string,
    entries: Array<{ oid: string; size: number }>,
    signal?: AbortSignal,
  ) {
    // Historical artifacts have no global size cap: JSON escaping, source
    // snapshots and provider data can exceed the source budget. Request only the
    // declared snapshot and unique source blobs, bounded by the domain above,
    // and verify every batch frame against its declared size. info returns only
    // type/size, including the root tree needed by recovery; commit messages and
    // tree contents are never buffered.
    const unique = [
      ...new Map(entries.map((row) => [row.oid, row]))
        .values(),
    ];
    // Two info headers (OID/type/decimal size) fit in 256 bytes. The rest is
    // exactly the expected blob framing and payload, with no artifact size cap.
    const batchBytes = unique.reduce(
      (total, row) =>
        total + row.size + `${row.oid} blob ${row.size}\n`.length + 1,
      256,
    );
    check(
      Number.isSafeInteger(batchBytes),
      "INVALID_REPOSITORY",
      "Invalid Git batch size",
    );
    const metadata = await this.#gitBytes(
      ["cat-file", "--batch-command"],
      `info ${oid}\ninfo ${oid}^{tree}\n` +
        unique.map((row) => `contents ${row.oid}\n`).join(""),
      false,
      false,
      batchBytes,
      signal,
    );
    const commitEnd = metadata.indexOf(10);
    const rootEnd = metadata.indexOf(10, commitEnd + 1);
    const commit = /^([a-f0-9]{40}) commit \d+$/.exec(
      new TextDecoder().decode(metadata.subarray(0, commitEnd)),
    );
    const root = /^([a-f0-9]{40}) tree \d+$/.exec(
      new TextDecoder().decode(metadata.subarray(commitEnd + 1, rootEnd)),
    );
    check(
      commitEnd >= 0 && rootEnd > commitEnd && commit?.[1] === oid && root,
      "INVALID_REPOSITORY",
      "Invalid Git snapshot commit or root tree",
    );
    const blobs = decodeGitBlobs(metadata.subarray(rootEnd + 1), unique);
    return { blobs, root: root[1] };
  }
  async #readRevision(
    oid: string,
    version: string,
    signal?: AbortSignal,
    allowRebuild = true,
  ): Promise<ModelRevision> {
    const { entries, rows } = await this.#sourceEntries(oid, signal);
    let format: "legacy" | "descriptor";
    try {
      format = classifyGitRevisionBuildPaths(
        entries.map((entry) => entry.path),
      );
    } catch (error) {
      if (error instanceof GitRevisionFormatError) {
        throw new ModelRepositoryError(
          "INVALID_REPOSITORY",
          `Invalid Git model build entry: ${error.code}`,
        );
      }
      throw error;
    }
    const buildEntry = entries.find((entry) =>
      format === "legacy"
        ? entry.path === LEGACY_BUILD_PATH
        : entry.path === DESCRIPTOR_BUILD_PATH ||
          entry.path === LEGACY_DESCRIPTOR_BUILD_PATH
    );
    check(
      buildEntry?.type === "blob",
      "INVALID_REPOSITORY",
      "Missing Git model snapshot",
    );
    const { blobs, root } = await this.#readBlobs(oid, [
      buildEntry,
      ...rows,
    ], signal);
    const stored = blobs.get(buildEntry.oid)!;
    let compiled: CompiledModel;
    let verifiedKey: string;
    if (format === "legacy") {
      const snapshot: Snapshot = JSON.parse(stored);
      check(
        snapshot.repositoryId === this.#identity &&
          snapshot.digest === await sha256(canonical(snapshot.compiled)),
        "INVALID_REPOSITORY",
        "Changed model snapshot",
      );
      compiled = snapshot.compiled;
      verifiedKey = snapshot.digest;
    } else {
      let decoded;
      try {
        decoded = decodeGitRevisionBuild({ descriptorText: stored });
      } catch (error) {
        if (error instanceof GitRevisionFormatError) {
          throw new ModelRepositoryError(
            "INVALID_REPOSITORY",
            `Invalid Git model build entry: ${error.code}`,
          );
        }
        throw error;
      }
      check(
        decoded.kind === "descriptor" &&
          decoded.descriptor.repositoryId === this.#identity,
        "INVALID_REPOSITORY",
        "Changed model snapshot",
      );
      if (!this.options.buildService) {
        throw new ModelBuildServiceError(
          "BUILD_UNAVAILABLE",
          {
            reason: "descriptor build requires the W2 build service",
            artifactDigest: decoded.descriptor.artifactDigest,
          },
          "Descriptor model build is unavailable without the build service",
        );
      }
      const treeSources = validateSources(Object.fromEntries(
        rows.map((row) => [row.path.slice(8), blobs.get(row.oid)!]),
      ));
      compiled = await this.options.buildService.resolveCompiled(
        decoded.descriptor,
        treeSources,
        { ...(signal ? { signal } : {}), allowRebuild },
      );
      verifiedKey = decoded.descriptor.artifactDigest;
    }
    validateSources(compiled.sources);
    check(
      canonical(rows.map((row) => row.path).sort()) ===
        canonical(
          Object.keys(compiled.sources).map((path) => `sources/${path}`).sort(),
        ),
      "INVALID_REPOSITORY",
      "Git source tree differs from compiled snapshot",
    );
    for (const row of rows) {
      check(
        row.size ===
          new TextEncoder().encode(compiled.sources[row.path.slice(8)]).length,
        "INVALID_REPOSITORY",
        `Changed source size: ${row.path}`,
      );
    }
    this.#collectingRecoveryObjects?.add(oid);
    this.#collectingRecoveryObjects?.add(root);
    for (const entry of entries) {
      this.#collectingRecoveryObjects?.add(entry.oid);
    }
    const sources = new Map(rows.map((row) => [row.path, blobs.get(row.oid)]));
    for (const [path, content] of Object.entries(compiled.sources)) {
      check(
        sources.get(`sources/${path}`) === content &&
          compiled.sourceHashes[path] === await sha256(content),
        "INVALID_REPOSITORY",
        `Changed source: ${path}`,
      );
    }
    if (format === "descriptor") {
      // The build service verified the exact bytes and materialization on hit
      // and miss; historical text is still never recompiled by this reader.
      this.#verifiedArtifacts.set(oid, verifiedKey);
      if (this.#verifiedArtifacts.size > 64) {
        this.#verifiedArtifacts.delete(
          this.#verifiedArtifacts.keys().next().value!,
        );
      }
    } else if (this.#verifiedArtifacts.get(oid) !== verifiedKey) {
      // Re-materialize the stored provider artifact, never compile historical text.
      const verified = await materialize(
        compiled.elements,
        compiled.sources,
        compiled.engineVersion,
        compiled.provider,
      );
      check(
        canonical(verified) === canonical(compiled),
        "INVALID_REPOSITORY",
        "Stored compiler artifact or IR digest mismatch",
      );
      this.#verifiedArtifacts.set(oid, verifiedKey);
      if (this.#verifiedArtifacts.size > 64) {
        this.#verifiedArtifacts.delete(
          this.#verifiedArtifacts.keys().next().value!,
        );
      }
    }
    this.#sourceDigests.set(version, compiled.sourceDigest);
    if (this.#sourceDigests.size > 256) {
      this.#sourceDigests.delete(this.#sourceDigests.keys().next().value!);
    }
    signal?.throwIfAborted();
    return {
      ...compiled,
      sources: { ...compiled.sources },
      sourceHashes: { ...compiled.sourceHashes },
      ...(compiled.provider ? { provider: { ...compiled.provider } } : {}),
      version,
    };
  }
  admittedSourcesDirectory(version: string): string {
    return `${this.layout.snapshotsDir}/${sha(version)}/sources`;
  }
  /** Explicit convenience export. Git is authoritative; this reserved cache is
   * never read by current/at/history/admission and never touches draft sources. */
  async exportSources(version: string): Promise<string> {
    const revision = await this.header(version);
    const destination = this.admittedSourcesDirectory(version);
    const verify = async () => {
      const sources: Sources = {};
      const walk = async (directory: string, prefix: string) => {
        const info = await Deno.lstat(directory);
        check(
          info.isDirectory && !info.isSymlink,
          "INVALID_REPOSITORY",
          "Unsafe generated snapshot directory",
        );
        for await (const entry of Deno.readDir(directory)) {
          check(
            !entry.isSymlink,
            "INVALID_REPOSITORY",
            "Symlink in generated snapshot",
          );
          const relative = prefix + entry.name;
          if (entry.isDirectory) {
            await walk(`${directory}/${entry.name}`, relative + "/");
          } else {
            check(
              entry.isFile,
              "INVALID_REPOSITORY",
              "Invalid generated snapshot entry",
            );
            sources[relative] = await Deno.readTextFile(
              `${directory}/${entry.name}`,
            );
          }
        }
      };
      await walk(destination, "");
      check(
        canonical(sources) === canonical(revision.sources),
        "INVALID_REPOSITORY",
        "Generated snapshot export differs from immutable sources",
      );
    };
    await this.#safeDirectory(this.layout.metadataDir);
    await Deno.mkdir(this.layout.snapshotsDir, { recursive: true });
    await this.#safeDirectory(this.layout.snapshotsDir);
    const versionDirectory = destination.slice(0, -"/sources".length);
    try {
      await Deno.lstat(versionDirectory);
      await this.#safeDirectory(versionDirectory);
      await verify();
      return destination;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const temporary = await Deno.makeTempDir({
      dir: this.layout.snapshotsDir,
      prefix: ".export-",
    });
    try {
      for (const [path, content] of Object.entries(revision.sources)) {
        const target = `${temporary}/sources/${path}`;
        await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(target, content, { createNew: true });
      }
      try {
        await Deno.rename(temporary, versionDirectory);
      } catch (error) {
        try {
          await Deno.lstat(versionDirectory);
        } catch {
          throw error;
        }
      }
      await this.#safeDirectory(versionDirectory);
      await verify();
      return destination;
    } finally {
      await Deno.remove(temporary, { recursive: true }).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  }
  async #safeDirectory(path: string): Promise<void> {
    const info = await Deno.lstat(path);
    check(
      info.isDirectory && !info.isSymlink,
      "INVALID_REPOSITORY",
      `Unsafe repository directory: ${path}`,
    );
  }
  async #recoverInitialization(manifest: Manifest): Promise<void> {
    check(
      manifest.status === undefined || manifest.status === "creating" ||
        manifest.status === "ready",
      "INVALID_REPOSITORY",
      "Invalid repository lifecycle",
    );
    if (manifest.status === "creating" && manifest.initialVersion) {
      const pin =
        (await this.#git(["rev-parse", "--verify", "refs/ase/initial"])).trim();
      check(
        pin === sha(manifest.initialVersion),
        "INVALID_REPOSITORY",
        "Initial publication pin changed",
      );
      await this.at(manifest.initialVersion);
      const head = await this.#head();
      if (!head) await this.#cas(main, manifest.initialVersion);
      else {check(
          await this.#ancestor(manifest.initialVersion, head),
          "INVALID_REPOSITORY",
          "Initial publication target differs from admitted history",
        );}
      await this.current();
      manifest.status = "ready";
      await this.#write("repository.json", manifest);
    } else if (manifest.status !== "creating") {
      // Legacy receipts may migrate only from an intact, verified admitted model.
      const head = await this.current();
      if (manifest.status === undefined) {
        manifest.status = "ready";
        manifest.initialVersion =
          (await this.#git(["rev-list", "--first-parent", sha(head.version)]))
            .trim().split("\n").at(-1);
        manifest.initialVersion = `commit:${manifest.initialVersion}`;
        await this.#write("repository.json", manifest);
      }
    } else {
      const pin = (await this.#git(
        ["rev-parse", "--verify", "--quiet", "refs/ase/initial"],
        undefined,
        false,
        true,
      )).trim();
      if (pin) {
        manifest.initialVersion = `commit:${pin}`;
        await this.at(manifest.initialVersion);
        await this.#write("repository.json", manifest);
        await this.#recoverInitialization(manifest);
        return;
      }
      check(
        !await this.#head(),
        "INVALID_REPOSITORY",
        "Unrecorded initial admitted revision",
      );
    }
  }
  async initialize(sources: Sources): Promise<ModelRevision> {
    const existing = await this.#head();
    if (existing) return await this.at(existing);
    const compiled = await this.#pool.run(() =>
      this.#compiler.compile(structuredClone(sources))
    );
    const version = await this.#snapshot(
      compiled,
      [],
      "ase",
      "Admit initial validated model",
    );
    return await this.#exclusive(async () => {
      const manifest = await this.#read<Manifest>("repository.json");
      check(
        manifest,
        "INVALID_REPOSITORY",
        "Missing repository lifecycle receipt",
      );
      await this.#recoverInitialization(manifest);
      const head = await this.#head();
      if (head) return await this.at(head);
      check(
        manifest.status === "creating" && !manifest.initialVersion,
        "INVALID_REPOSITORY",
        "Repository is not awaiting initial publication",
      );
      await this.#cas("refs/ase/initial", version);
      manifest.initialVersion = version;
      await this.#write("repository.json", manifest);
      await this.#cas(main, version);
      const revision = await this.at(version);
      manifest.status = "ready";
      await this.#write("repository.json", manifest);
      return revision;
    });
  }
  async findPublication(
    changeId: string,
    allowRebuild = true,
  ): Promise<{ revision: ModelRevision; receipt?: SourcePublication } | null> {
    const ref = publicationRef(changeId);
    // A successful empty exact-ref query proves absence. Unlike rev-parse's
    // exit 1, this does not conflate a missing index with Git diagnostics.
    const refs = await this.#git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      ref,
    ]);
    let oid =
      refs.split("\n").find((line) => line.startsWith(`${ref} `))?.slice(
        ref.length + 1,
      ) ?? "";
    const author = (body: string) =>
      /\nASE-Author: ([^\r\n]+)\n*$/.exec(body)?.[1];
    let body = "";
    if (oid) {
      body = await this.#git(["show", "-s", "--format=%B", oid]);
    } else {
      // Grep also matches quoted trailers in ordinary multiline reasons.
      // Only the final author trailer identifies an actual publication.
      const head = await this.#head();
      check(head, "NOT_FOUND", "Model repository is not initialized");
      const candidates = (await this.#git([
        "rev-list",
        "--first-parent",
        `--grep=^ASE-Author: ase:approved-change:${changeId}$`,
        // An activation carries its receipt, whose canonical JSON names the
        // change: match this one only, never every past activation.
        `--grep=^ASE-Approval: .*"changeId":"${changeId}"`,
        sha(head),
      ])).trim().split("\n").filter(Boolean);
      for (const candidate of candidates) {
        const message = await this.#git([
          "show",
          "-s",
          "--format=%B",
          candidate,
        ]);
        if (author(message) !== `ase:approved-change:${changeId}`) {
          const trailer = message.trimEnd().split("\n").at(-2);
          if (
            !author(message)?.startsWith("ase:activate-candidate:") ||
            !trailer?.startsWith("ASE-Approval: ")
          ) continue;
          check(
            trailer.length + 1 <= MAX_APPROVAL_RECEIPT_BYTES &&
              new TextEncoder().encode(`${trailer}\n`).length <=
                MAX_APPROVAL_RECEIPT_BYTES,
            "INVALID_REPOSITORY",
            "Invalid approval receipt",
          );
          try {
            const parsed = JSON.parse(trailer.slice("ASE-Approval: ".length));
            const trailerChangeId = parsed?.v === 2
              ? parsed.approval?.changeId
              : parsed?.changeId;
            if (trailerChangeId !== changeId) continue;
          } catch {
            continue;
          }
        }
        oid = candidate;
        body = message;
        break;
      }
    }
    if (!oid) return null;
    const trailers = body.trimEnd().split(/\r?\n\r?\n/).at(-1)!
      .split("\n").filter((line) => line.startsWith("ASE-Approval:"));
    check(
      trailers.length <= 1,
      "INVALID_REPOSITORY",
      "Ambiguous approval receipt",
    );
    const v1Facts = (candidate: SourcePublication): boolean =>
      Number.isSafeInteger(candidate.baseRevision) &&
      candidate.baseRevision >= 0 &&
      typeof candidate.baseModelDigest === "string" &&
      Boolean(candidate.baseModelDigest) &&
      typeof candidate.decidedAt === "string" && Boolean(candidate.decidedAt) &&
      candidate.adoptedPin?.digest === candidate.baseModelDigest &&
      (candidate.type === "candidate-activation"
        ? Boolean(
          candidate.systemId && candidate.builderId && candidate.candidateId &&
            candidate.candidateDigest &&
            candidate.admission?.candidateId === candidate.candidateId &&
            candidate.admission.candidateDigest === candidate.candidateDigest &&
            candidate.admission.at === candidate.decidedAt &&
            candidate.admission.configurationRevision ===
              candidate.baseRevision,
        )
        : candidate.type === undefined &&
          candidate.authorityExercise?.baseModelDigest ===
            candidate.baseModelDigest &&
          candidate.authorityExercise?.action === "mandate-change" &&
          candidate.authorityExercise?.outOfMandate === false);
    let receipt: SourcePublication | undefined;
    if (trailers.length) {
      check(
        trailers[0].length + 1 <= MAX_APPROVAL_RECEIPT_BYTES &&
          new TextEncoder().encode(`${trailers[0]}\n`).length <=
            MAX_APPROVAL_RECEIPT_BYTES,
        "INVALID_REPOSITORY",
        "Invalid approval receipt",
      );
      const json = trailers[0].slice("ASE-Approval: ".length);
      let parsed: { v?: unknown } | undefined;
      try {
        parsed = JSON.parse(json);
      } catch { /* rejected below */ }
      if (parsed?.v === 2) {
        // Versioned receipt: validate the untouched approval with the exact
        // v1 facts, then project approval + replayed edits for v1 consumers.
        // The stored trailer bytes stay authoritative; findPublicationByCommand
        // returns the exact v2 receipt.
        let prepared: PreparedPublication | undefined;
        try {
          const candidate = parseAnyPublication(parsed);
          if ("v" in candidate) prepared = candidate;
        } catch { /* rejected below */ }
        check(
          prepared && canonical(prepared) === json &&
            prepared.approval.changeId === changeId &&
            v1Facts(prepared.approval) &&
            author(body) === publicationAuthor(prepared.approval) &&
            body.includes(`${trailers[0]}\nASE-Author:`),
          "INVALID_REPOSITORY",
          "Invalid approval receipt",
        );
        receipt = {
          ...structuredClone(prepared.approval),
          edits: structuredClone([...prepared.replayedEdits]),
        } as SourcePublication;
      } else {
        receipt = parsed as SourcePublication | undefined;
        check(
          receipt && canonical(receipt) === json &&
            receipt.changeId === changeId && v1Facts(receipt) &&
            author(body) === publicationAuthor(receipt) &&
            body.includes(`${trailers[0]}\nASE-Author:`),
          "INVALID_REPOSITORY",
          "Invalid approval receipt",
        );
      }
    }
    check(
      receipt || author(body) === `ase:approved-change:${changeId}`,
      "INVALID_REPOSITORY",
      "Publication index points to another author",
    );
    return {
      // Ordinary lookup follows the public revision port. Its default
      // implementation retains complete source/artifact integrity checks.
      // The strict writer path must bypass any public override so it cannot
      // accidentally rebuild while the repository lock is held.
      revision: allowRebuild
        ? await this.at(`commit:${oid}`)
        : await this.#atWithBuildPolicy(`commit:${oid}`, false),
      ...(receipt ? { receipt } : {}),
    };
  }

  async headVersion(): Promise<string | null> {
    return (await this.#head()) ?? null;
  }

  /** Exact stored receipt (either version) from a commit body, or undefined
   * when the commit carries no approval trailer. Corrupt trailers refuse. */
  #receiptFromBody(body: string): AnySourcePublication | undefined {
    const trailers = body.trimEnd().split(/\r?\n\r?\n/).at(-1)!
      .split("\n").filter((line) => line.startsWith("ASE-Approval:"));
    check(
      trailers.length <= 1,
      "INVALID_REPOSITORY",
      "Ambiguous approval receipt",
    );
    if (!trailers.length) return undefined;
    check(
      trailers[0].length + 1 <= MAX_APPROVAL_RECEIPT_BYTES &&
        new TextEncoder().encode(`${trailers[0]}\n`).length <=
          MAX_APPROVAL_RECEIPT_BYTES,
      "INVALID_REPOSITORY",
      "Invalid approval receipt",
    );
    const json = trailers[0].slice("ASE-Approval: ".length);
    let parsed: AnySourcePublication | undefined;
    try {
      parsed = parseAnyPublication(JSON.parse(json));
    } catch { /* rejected below */ }
    check(
      parsed && canonical(parsed) === json &&
        /\nASE-Author: ([^\r\n]+)\n*$/.exec(body)?.[1] ===
          anyPublicationAuthor(parsed) &&
        body.includes(`${trailers[0]}\nASE-Author:`),
      "INVALID_REPOSITORY",
      "Invalid approval receipt",
    );
    return parsed;
  }

  /** Exact `ASE-Write-Command` trailer of a commit body, when present. */
  #commandFromBody(body: string): WriteCommandAnchor | undefined {
    const trailers = body.trimEnd().split(/\r?\n\r?\n/).at(-1)!
      .split("\n").filter((line) => line.startsWith("ASE-Write-Command:"));
    check(
      trailers.length <= 1,
      "INVALID_REPOSITORY",
      "Ambiguous write command trailer",
    );
    if (!trailers.length) return undefined;
    const match =
      /^ASE-Write-Command: ([A-Za-z0-9][A-Za-z0-9._-]{0,127}) ([0-9a-f]{64})$/
        .exec(trailers[0]!);
    check(match, "INVALID_REPOSITORY", "Invalid write command trailer");
    return { commandId: match[1]!, commandDigest: match[2]! };
  }

  async findPublicationByCommand(
    commandId: string,
    allowRebuild = true,
  ): Promise<
    {
      revision: ModelRevision;
      receipt?: AnySourcePublication;
      commandDigest?: string;
    } | null
  > {
    const ref = commandRef(commandId);
    const refs = await this.#git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      ref,
    ]);
    const oid = refs.split("\n").find((line) => line.startsWith(`${ref} `))
      ?.slice(ref.length + 1) ?? "";
    if (!oid) {
      // Approved changes and activations name their command by changeId.
      if (!/^[0-9a-f-]{36}$/.test(commandId)) return null;
      const byChange = await this.findPublication(commandId, allowRebuild);
      return byChange
        ? {
          revision: byChange.revision,
          ...(byChange.receipt ? { receipt: byChange.receipt } : {}),
        }
        : null;
    }
    const body = await this.#git(["show", "-s", "--format=%B", oid]);
    check(
      !body.split("\n").some((line) => line.startsWith("ASE-Request-Source: ")),
      "SOURCE_CONFLICT",
      "Command anchor belongs to an explicit Request destination",
    );
    const receipt = this.#receiptFromBody(body);
    const anchoredCommand = this.#commandFromBody(body);
    if (anchoredCommand) {
      check(
        anchoredCommand.commandId === commandId,
        "INVALID_REPOSITORY",
        "Command index points to another write command",
      );
    }
    if (receipt) {
      const anchored = isPreparedPublication(receipt)
        ? receipt.command?.commandId === commandId ||
          receipt.approval.changeId === commandId
        : receipt.changeId === commandId;
      check(
        anchored,
        "INVALID_REPOSITORY",
        "Command index points to another publication",
      );
    }
    const commandDigest = anchoredCommand?.commandDigest ??
      (receipt && isPreparedPublication(receipt)
        ? receipt.command?.commandDigest
        : undefined);
    return {
      revision: await this.#atWithBuildPolicy(`commit:${oid}`, allowRebuild),
      ...(receipt ? { receipt } : {}),
      ...(commandDigest ? { commandDigest } : {}),
    };
  }

  /** Retain an already verified immutable commit without moving HEAD, publishing
   * sources or granting execution. Shares every repository writer's OS lock. */
  async retainSavedSystemCommit(version: string): Promise<string> {
    const oid = sha(version);
    const ref = `refs/assembly/saved-systems/commits/${oid}`;
    await this.#exclusive(async () => {
      const resolved = (await this.#git(
        [
          "rev-parse",
          "--verify",
          "--quiet",
          `${oid}^{commit}`,
        ],
        undefined,
        false,
        "silent",
      )).trim();
      check(resolved === oid, "NOT_FOUND", "Exact saved commit is unavailable");
      const existing = (await this.#git(
        [
          "rev-parse",
          "--verify",
          "--quiet",
          ref,
        ],
        undefined,
        false,
        true,
      )).trim();
      if (existing) {
        check(
          existing === oid,
          "INVALID_REPOSITORY",
          "Saved retention ref differs",
        );
      } else {
        await this.#git([
          "update-ref",
          ref,
          oid,
          "0000000000000000000000000000000000000000",
        ]);
      }
      check(
        (await this.#git(["rev-parse", "--verify", ref])).trim() === oid,
        "INVALID_REPOSITORY",
        "Saved retention ref readback differs",
      );
    });
    return ref;
  }

  async anchorCommandPublication(input: {
    commandId: string;
    version: string;
  }): Promise<void> {
    const ref = commandRef(input.commandId);
    const target = sha(input.version);
    await this.#exclusive(async () => {
      const resolved = (await this.#git(
        ["rev-parse", "--verify", "--quiet", `${target}^{object}`],
        undefined,
        false,
        "silent",
      )).trim();
      check(resolved, "NOT_FOUND", "Model version not found");
      const existing = (await this.#git(
        ["rev-parse", "--verify", "--quiet", ref],
        undefined,
        false,
        true,
      )).trim();
      if (existing) {
        check(
          existing === target,
          "INVALID_REQUEST",
          "Command index already names another model version",
        );
        return;
      }
      await this.#cas(ref, input.version);
    });
  }

  /** Eligibility is the selected admitted branch's first-parent history. A
   * viewable proposal (including a merge's second parent) is not admission.
   * This capability is intentionally main-only until host Case refs exist. */
  async admittedMainSource(
    version: string,
  ): Promise<{ headVersion: string; sourceDigest: string }> {
    const oid = sha(version);
    const headVersion = await this.#head();
    check(headVersion, "NOT_FOUND", "The admitted main branch is unavailable");
    const admitted =
      (await this.#git(["rev-list", "--first-parent", sha(headVersion)]))
        .trim().split("\n");
    check(
      admitted.includes(oid),
      "NOT_FOUND",
      "The selected source is not admitted on main",
    );
    const revision = await this.#atWithBuildPolicy(version, false);
    return { headVersion, sourceDigest: revision.sourceDigest };
  }

  async history(options: { limit?: number } = {}): Promise<ModelHistory> {
    const limit = options.limit ?? 100;
    check(
      Number.isSafeInteger(limit) && limit >= 1 && limit <= 200,
      "INVALID_REQUEST",
      "Invalid history limit",
    );
    const headVersion = await this.#head();
    check(headVersion, "NOT_FOUND", "Model repository is not initialized");
    const rows = (await this.#git([
      "rev-list",
      "--first-parent",
      `--max-count=${limit + 1}`,
      sha(headVersion),
    ])).trim().split("\n").filter(Boolean);
    const commits: ModelCommit[] = [];
    for (const oid of rows.slice(0, limit)) {
      commits.push(await this.#metadata(`commit:${oid}`));
    }
    return { headVersion, commits, truncated: rows.length > limit };
  }

  #memo<T>(
    cache: Map<string, Promise<T>>,
    version: string,
    read: () => Promise<T>,
  ): Promise<T> {
    sha(version);
    let pending = cache.get(version);
    if (!pending) {
      pending = read().catch(async (error) => {
        // Batch-check distinguishes a missing object with a successful Git
        // response; incidental stderr warnings cannot turn absence into damage.
        const oid = sha(version);
        const resolved = await this.#git(
          ["cat-file", "--batch-check"],
          `${oid}\n`,
        );
        check(
          /^[a-f0-9]{40} commit \d+$/.test(resolved.trim()),
          "NOT_FOUND",
          "Model commit not found",
        );
        throw error;
      });
      cache.set(version, pending);
      if (cache.size > 256) cache.delete(cache.keys().next().value!);
      const computation = pending;
      pending.catch(() => {
        if (cache.get(version) === computation) cache.delete(version);
      });
    }
    return pending.then((value) => structuredClone(value));
  }

  #metadata(version: string): Promise<ModelCommit> {
    return this.#memo(this.#commitMetadata, version, async () => {
      const oid = sha(version);
      const metadata =
        (await this.#git(["show", "-s", "--format=%P%n%aI%n%B", oid])).split(
          "\n",
        );
      const parents = metadata[0]
        ? metadata[0].split(" ").map((parent) => `commit:${parent}`)
        : [];
      const body = metadata.slice(2).join("\n");
      const author = /\nASE-Author: ([^\r\n]+)\n*$/.exec(body)?.[1] ?? "ase";
      // A previously verified snapshot already established this immutable fact.
      // Cold historical reads derive it from source blobs without loading IR.
      let sourceDigest = this.#sourceDigests.get(version);
      if (sourceDigest === undefined) {
        // History is advisory: at()/current() alone verify stored build entries.
        sourceDigest = (await this.header(version)).sourceDigest;
      }
      const files = await this.changedFiles(version);
      return {
        version,
        ...(parents[0] ? { parentVersion: parents[0] } : {}),
        parents,
        author,
        parsedAuthor: parseModelAuthor(author),
        message: commitMessage(body),
        createdAt: metadata[1],
        sourceDigest,
        files,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      };
    });
  }

  async changedFiles(version: string): Promise<ModelChangedFile[]> {
    return await this.#memo(this.#fileChanges, version, async () => {
      const oid = sha(version);
      // --diff-merges=first-parent compares accepted merge commits only to
      // admitted HEAD. Raw statuses and numstat share one Git execution.
      const fields = (await this.#git([
        "diff-tree",
        "--root",
        "--diff-merges=first-parent",
        "--no-commit-id",
        "-r",
        "-M",
        "-z",
        "--raw",
        "--numstat",
        `${oid}^{commit}`,
        "--",
        "sources/",
      ])).split("\0");
      const files: ModelChangedFile[] = [];
      let i = 0;
      while (fields[i]?.startsWith(":")) {
        const code = fields[i++].split(" ").at(-1)!;
        const previous = fields[i++];
        const path = code.startsWith("R") ? fields[i++] : previous;
        files.push({
          path: path.slice("sources/".length),
          ...(code.startsWith("R")
            ? { previousPath: previous.slice("sources/".length) }
            : {}),
          status: code.startsWith("A")
            ? "added"
            : code.startsWith("D")
            ? "deleted"
            : code.startsWith("R")
            ? "renamed"
            : "modified",
          additions: 0,
          deletions: 0,
        });
      }
      const byPath = new Map(files.map((file) => [file.path, file]));
      for (; i < fields.length; i++) {
        if (!fields[i]) continue;
        const [added, deleted, ...parts] = fields[i].split("\t");
        let path = parts.join("\t");
        if (!path) {
          path = fields[i + 2];
          i += 2;
        }
        check(
          /^\d+$/.test(added) && /^\d+$/.test(deleted),
          "INVALID_REPOSITORY",
          "Non-text model source diff",
        );
        const file = byPath.get(path.slice("sources/".length));
        check(file, "INVALID_REPOSITORY", "Missing Git diff status");
        file.additions = Number(added);
        file.deletions = Number(deleted);
      }
      return files.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0
      );
    });
  }

  async lastChangeByPath(head: string): Promise<ModelFileLastChange[]> {
    return await this.#memo(this.#lastChanges, head, async () => {
      const oid = sha(head);
      const paths = (await this.#git([
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        `${oid}^{commit}`,
        "--",
        "sources/",
      ]))
        .split("\0").filter(Boolean).sort();
      const result: ModelFileLastChange[] = [];
      for (const path of paths) {
        const row = (await this.#git([
          "log",
          "--first-parent",
          "-1",
          "--format=%H%x00%aI%x00%B",
          `${oid}^{commit}`,
          "--",
          path,
        ])).trimEnd().split("\0");
        check(row.length === 3, "INVALID_REPOSITORY", "Missing file history");
        result.push({
          path: path.slice("sources/".length),
          lastChange: {
            version: `commit:${row[0]}`,
            createdAt: row[1],
            message: commitMessage(row[2]),
          },
        });
      }
      return result;
    });
  }
  async graphDiff(
    fromVersion: string | null,
    toVersion: string,
    options: { limit?: number } = {},
  ): Promise<GraphDiff> {
    const after = await this.at(toVersion);
    const before = fromVersion ? await this.at(fromVersion) : undefined;
    const old = new Map(
      (before?.documents ?? []).map((
        document,
      ) => [String(document["@id"]), document]),
    );
    const next = new Map(
      after.documents.map((document) => [String(document["@id"]), document]),
    );
    const patches = [...new Set([...old.keys(), ...next.keys()])].flatMap(
      (id) => {
        const a = old.get(id), b = next.get(id);
        if (canonical(a) === canonical(b)) return [];
        return [
          !a
            ? { "@op": "Insert", "@insert": b }
            : !b
            ? { "@op": "Delete", "@delete": a }
            : Object.fromEntries(
              [...new Set([...Object.keys(a), ...Object.keys(b)])].map((
                key,
              ) => [key, b[key]]),
            ),
        ];
      },
    );
    return {
      ...compareModelGraphDocuments({
        patches,
        before: before?.documents ?? [],
        after: after.documents,
        fromVersion,
        toVersion,
        limit: options.limit ?? 100,
        sourceDigests: {
          before: before?.sourceDigest ?? null,
          after: after.sourceDigest,
        },
      }),
      engine: "Git",
    };
  }
  async #records(
    onInvalid?: (path: string, error: unknown) => void,
  ): Promise<ProposalRecord[]> {
    const records = [];
    for await (const entry of Deno.readDir(`${this.stateDir}/proposals`)) {
      if (/^[a-f0-9-]{36}\.json$/.test(entry.name)) {
        try {
          const stored = await this.#read<
            ProposalRecord & { requestSource?: { format?: string } }
          >(`proposals/${entry.name}`);
          if (stored && Object.hasOwn(stored, "requestSource")) {
            check(
              stored.requestSource?.format === "request-source-proposal/v1",
              "INVALID_REPOSITORY",
              "Unknown scoped proposal journal format",
            );
            continue;
          }
          check(
            stored && stored.id === entry.name.slice(0, -5),
            "NOT_FOUND",
            "Proposal not found",
          );
          records.push(stored);
        } catch (error) {
          if (!onInvalid) throw error;
          onInvalid(`proposals/${entry.name}`, error);
        }
      }
    }
    return records.sort((a, b) => persistedOrder(b.createdAt, a.createdAt));
  }
  async proposal(id: string): Promise<ProposalRecord> {
    check(
      /^[a-f0-9-]{36}$/.test(id),
      "INVALID_REQUEST",
      "Invalid proposal identity",
    );
    const record = await this.#read<ProposalRecord>(`proposals/${id}.json`);
    check(
      record && record.id === id && !Object.hasOwn(record, "requestSource"),
      "NOT_FOUND",
      "Proposal not found",
    );
    return record;
  }
  async #save(record: ProposalRecord): Promise<void> {
    await this.#write(`proposals/${record.id}.json`, record);
  }
  async #ancestor(ancestor: string, descendant: string): Promise<boolean> {
    const output = await this.#git(["rev-list", sha(descendant)]);
    const commits = output.trim().split("\n");
    for (const commit of commits) this.#collectingRecoveryObjects?.add(commit);
    return commits.includes(sha(ancestor));
  }
  async #authorize(
    input: Parameters<ModelSourceAuthorizationPort["validate"]>[0],
  ): Promise<void> {
    const requiresAuthorization = input.author.startsWith("agent:") ||
      input.authorization?.kind === "operator" ||
      input.authorization?.kind === "operator-administration" ||
      input.authorization?.kind === "operator-evolution";
    check(
      !requiresAuthorization ||
        (input.authorization && this.options.sourceAuthorization),
      "EDIT_SCOPE_DENIED",
      "Operator source writes require authorization metadata and an authorizer",
    );
    if (this.options.sourceAuthorization) {
      await this.options.sourceAuthorization.validate(input);
    }
  }
  /** Scoped software rights come from the exact admitted runtime pin, while
   * source replay and effect assessment still use the Request source base. */
  async #authorizeScopedSoftware(
    input: Parameters<ModelSourceAuthorizationPort["validate"]>[0],
    scope: ScopedSoftwareContextV2,
  ): Promise<void> {
    const actor = scope.targets.find((entry) =>
      canonical(entry.target) === canonical(scope.actor)
    );
    const authorizer = this.options.sourceAuthorization;
    check(
      actor && authorizer?.validateScopedSoftware,
      "EDIT_SCOPE_DENIED",
      "Exact scoped software source authority is unavailable",
    );
    const retained = this.options.scopedSoftwareActor
      ? undefined
      : await validateSourceEvolutionExecutables(
        await this.#atWithBuildPolicy(actor.previousPin.source.version, false),
        this.projectId,
      );
    const matches = this.options.scopedSoftwareActor
      ? [await this.options.scopedSoftwareActor(scope)]
      : retained!.map((entry) => entry.model);
    const exact = matches.filter((model) =>
      model.identity.builderId === scope.actor.operatorId &&
      model.version.digest === actor.previousPin.modelDigest &&
      model.version.repositoryVersion === actor.previousPin.source.version &&
      model.identity.projectId === this.projectId
    );
    check(
      exact.length === 1,
      "EDIT_SCOPE_DENIED",
      "Exact admitted software actor source is unavailable",
    );
    await authorizer.validateScopedSoftware(input, exact[0]);
    if (retained) {
      const [sourceBefore, candidate] = await Promise.all([
        validateSourceEvolutionExecutables(input.before, this.projectId),
        validateSourceEvolutionExecutables({
          ...input.after,
          version: "unpublished-evolution-assessment",
        }, this.projectId),
      ]);
      const old = retained.filter((entry) =>
        entry.model.identity.builderId === scope.actor.operatorId &&
        entry.model.version.digest === actor.previousPin.modelDigest
      );
      const before = [...sourceBefore],
        index = before.findIndex((entry) =>
          entry.model.identity.builderId === scope.actor.operatorId
        );
      check(
        old.length === 1 && index >= 0 && scope.targets.length === 1,
        "EDIT_SCOPE_DENIED",
        "Exact scoped software runtime assessment is unavailable",
      );
      before[index] = old[0];
      const effects = classifyEvolutionEffects(before, candidate);
      check(
        effects.length > 0 &&
          effects.every((effect) =>
            effect.targetNativeId === scope.actor.operatorId
          ),
        "EDIT_SCOPE_DENIED",
        "Scoped software runtime effects exceed the exact target",
      );
      requireEvolutionEffectBounds(
        exact[0],
        "prepare",
        effects,
        before,
        candidate,
      );
    }
  }
  async #recoveryFingerprint(
    records: ProposalRecord[],
  ): Promise<string | undefined> {
    // Inspect only dependencies of the preceding recovery, never object bytes
    // or an entire loose-object database. ctime also changes when an object is
    // overwritten with its old size and mtime. Packs contribute metadata only.
    // External object/config stores opt out of this local-filesystem cache.
    const entries: Array<[string, string]> = [];
    const refs = await this.#git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
    ]);
    // Include ref targets themselves, including replacement objects that Git
    // may transparently substitute while reading a snapshot or its ancestry.
    const objects = new Set(this.#recoveryObjects);
    for (const ref of refs.trim().split("\n").filter(Boolean)) {
      objects.add(ref.slice(ref.lastIndexOf(" ") + 1));
    }
    let local = true;
    const inspect = async (path: string) => {
      let info;
      try {
        info = await lstat(`${this.gitDir}/${path}`, { bigint: true });
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT") {
          entries.push([path, "missing"]);
          return;
        }
        throw error;
      }
      if (
        info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) ||
        typeof info.ctimeNs !== "bigint" || info.ctimeNs <= 0n
      ) {
        local = false;
        return;
      }
      entries.push([
        path,
        [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs]
          .map(String).join(":"),
      ]);
      return info;
    };

    for (const path of ["objects", "objects/info", "info"]) {
      const info = await inspect(path);
      if (info && !info.isDirectory()) local = false;
    }
    for (
      const path of [
        "commondir",
        "objects/info/alternates",
        "objects/info/http-alternates",
      ]
    ) {
      if (await inspect(path)) local = false;
    }
    for (
      const path of [
        "config",
        "config.worktree",
        "shallow",
        "info/grafts",
        "objects/info/commit-graph",
      ]
    ) {
      const info = await inspect(path);
      if (!info) continue;
      if (!info.isFile()) {
        local = false;
        continue;
      }
      if (
        (path === "config" || path === "config.worktree") &&
        /^\s*\[\s*include(?:if)?(?:\s|\.|\])/im.test(
          await Deno.readTextFile(`${this.gitDir}/${path}`),
        )
      ) local = false;
    }
    if (!local) return undefined;
    const graphs = await inspect("objects/info/commit-graphs");
    if (graphs) {
      if (!graphs.isDirectory()) return undefined;
      for await (
        const entry of Deno.readDir(`${this.gitDir}/objects/info/commit-graphs`)
      ) {
        const info = await inspect(`objects/info/commit-graphs/${entry.name}`);
        if (info && !info.isFile()) local = false;
      }
    }
    const prefixes = new Map<string, Set<string> | undefined>();
    for (const oid of objects) {
      if (!/^[a-f0-9]{40}$/.test(oid)) return undefined;
      const prefix = `objects/${oid.slice(0, 2)}`;
      if (!prefixes.has(prefix)) {
        const info = await inspect(prefix);
        if (!info) {
          prefixes.set(prefix, undefined);
          this.#looseObjectDirectories.delete(prefix);
        } else {
          if (!info.isDirectory()) return undefined;
          const metadata = [
            info.dev,
            info.ino,
            info.mode,
            info.size,
            info.mtimeNs,
            info.ctimeNs,
          ].map(String).join(":");
          let directory = this.#looseObjectDirectories.get(prefix);
          if (directory?.metadata !== metadata) {
            const names = new Set<string>();
            for await (
              const entry of Deno.readDir(`${this.gitDir}/${prefix}`)
            ) {
              names.add(entry.name);
            }
            directory = { metadata, names };
            this.#looseObjectDirectories.set(prefix, directory);
          }
          prefixes.set(prefix, directory.names);
        }
      }
      // Packed ancestors have no loose file to inspect. Directory metadata
      // detects newly added loose shadows; existing loose bytes remain covered
      // by their own ctime even when the directory itself is unchanged.
      const name = oid.slice(2);
      if (!prefixes.get(prefix)?.has(name)) continue;
      const info = await inspect(`${prefix}/${name}`);
      if (info && !info.isFile()) local = false;
    }
    const packs = await inspect("objects/pack");
    if (packs) {
      if (!packs.isDirectory()) return undefined;
      for await (const entry of Deno.readDir(`${this.gitDir}/objects/pack`)) {
        const info = await inspect(`objects/pack/${entry.name}`);
        if (info && !info.isFile()) local = false;
      }
    }
    if (!local) return undefined;
    entries.sort(([a], [b]) => compareCodeUnits(a, b));
    return await sha256(canonical({ records, refs, objects: entries }));
  }
  async #recover(allowRebuild = true): Promise<void> {
    const records = await this.#records();
    if (!records.length) {
      this.#recoveredState = undefined;
      this.#recoveryObjects.clear();
      return;
    }
    // GC or an unreadable unrelated object must only disable this optimization;
    // the authoritative validation below still determines repository validity.
    const fingerprint = await this.#recoveryFingerprint(records).catch(() =>
      undefined
    );
    if (fingerprint && fingerprint === this.#recoveredState) return;
    this.#recoveredState = undefined;
    const previousObjects = this.#recoveryObjects;
    const recoveryObjects = new Set<string>();
    this.#collectingRecoveryObjects = recoveryObjects;
    // Several dossiers refer to the same base. Validate it once per recovery,
    // even on a cache miss, with no cache of live authority or CAS decisions.
    // Keep at() here: a Git blob hash alone cannot establish repository identity,
    // source/artifact agreement or valid derived IR in an imported commit. A
    // source-only header would let recovery publish such a malformed snapshot.
    const revisions = new Map<string, Promise<ModelRevision>>();
    const at = (version: string): Promise<ModelRevision> => {
      let revision = revisions.get(version);
      if (!revision) {
        revision = this.#atWithBuildPolicy(version, allowRebuild);
        revisions.set(version, revision);
      }
      return revision;
    };
    try {
      for (const record of records) {
        check(
          record.branch === `proposal_${record.id}`,
          "INVALID_REPOSITORY",
          "Invalid proposal branch",
        );
        check(
          ["preparing", "proposed", "accepting", "accepted", "rejected"]
            .includes(
              record.status,
            ),
          "INVALID_REPOSITORY",
          "Unknown proposal journal status",
        );
        check(
          record.proposalVersion &&
            (await at(record.proposalVersion)).sourceDigest ===
              record.sourceDigest,
          "INVALID_REPOSITORY",
          "Proposal immutable snapshot changed",
        );
        await at(record.baseVersion);
        if (record.status !== "preparing") {
          const ref = (await this.#git([
            "rev-parse",
            "--verify",
            `refs/heads/${record.branch}`,
          ])).trim();
          check(
            ref === sha(record.proposalVersion),
            "INVALID_REPOSITORY",
            "Proposal branch differs from review snapshot",
          );
        }
        if (record.status === "preparing") {
          check(
            record.proposalVersion,
            "INVALID_REPOSITORY",
            "Preparing proposal missing immutable version",
          );
          check(
            (await at(record.proposalVersion)).sourceDigest ===
              record.sourceDigest,
            "INVALID_REPOSITORY",
            "Changed proposal snapshot",
          );
          const ref = `refs/heads/${record.branch}`;
          const existing = (await this.#git(
            ["rev-parse", "--verify", "--quiet", ref],
            undefined,
            false,
            true,
          )).trim();
          if (!existing) await this.#cas(ref, record.proposalVersion);
          else {check(
              existing === sha(record.proposalVersion),
              "INVALID_REPOSITORY",
              "Proposal ref changed",
            );}
          record.status = "proposed";
          await this.#save(record);
        }
        if (record.status === "accepting") {
          check(
            record.targetVersion && record.acceptanceBaseVersion &&
              record.decidedBy && record.decidedAt,
            "INVALID_REPOSITORY",
            "Acceptance journal incomplete",
          );
          const target = await at(record.targetVersion);
          check(
            target.sourceDigest === record.targetSourceDigest,
            "INVALID_REPOSITORY",
            "Acceptance target changed",
          );
          const head = await this.#head();
          check(head, "INVALID_REPOSITORY", "Missing admitted head");
          if (await this.#ancestor(record.targetVersion, head)) {
            const body = await this.#git([
              "show",
              "-s",
              "--format=%B",
              sha(record.targetVersion),
            ]);
            const command = this.#commandFromBody(body);
            if (command) {
              const ref = commandRef(command.commandId);
              const anchored = (await this.#git([
                "for-each-ref",
                "--format=%(objectname)",
                ref,
              ])).trim();
              check(
                anchored === sha(record.targetVersion),
                "INVALID_REPOSITORY",
                "Accepted write command is missing its atomic anchor",
              );
            }
            record.status = "accepted";
            record.acceptedVersion = record.targetVersion;
            await this.#save(record);
          } else if (head === record.acceptanceBaseVersion) {
            const targetBody = await this.#git([
              "show",
              "-s",
              "--format=%B",
              sha(record.targetVersion),
            ]);
            const command = this.#commandFromBody(targetBody);
            if (command) {
              check(
                command.commandId === record.id,
                "INVALID_REPOSITORY",
                "Acceptance target names another write command",
              );
              // A queued owner may have lost its lease after writing this
              // journal but before the guarded CAS. Recovery cannot publish
              // on that owner's behalf. The worker must claim and revalidate
              // the proposal under a fresh lease.
              record.status = "proposed";
              delete record.targetVersion;
              delete record.targetSourceDigest;
              delete record.acceptanceBaseVersion;
              delete record.decidedBy;
              delete record.decidedAt;
              delete record.decisionAuthorityExercise;
              delete record.evolutionDecision;
              await this.#save(record);
              continue;
            }
            const authority = await at(record.acceptanceBaseVersion);
            await this.#authorize({
              authority,
              before: authority,
              after: target,
              authorization: record.authorization,
              decisionAuthorityExercise: record.decisionAuthorityExercise,
              evolutionDecision: record.evolutionDecision,
              author: record.author,
              phase: "recovery",
            });
            // A queued acceptance carries its (id, digest) in the target
            // commit trailer: recreate its anchor atomically with HEAD.
            await this.#cas(main, record.targetVersion, head);
            record.status = "accepted";
            record.acceptedVersion = record.targetVersion;
            await this.#save(record);
          } else {throw new ModelRepositoryError(
              "INVALID_REPOSITORY",
              "Interrupted acceptance has an unrelated admitted head",
            );}
        }
        if (record.status === "accepted") {
          const head = await this.#head();
          check(
            record.acceptedVersion && head &&
              await this.#ancestor(record.acceptedVersion, head),
            "INVALID_REPOSITORY",
            "Accepted revision is absent from admitted history",
          );
          check(
            (await at(record.acceptedVersion)).sourceDigest ===
              record.targetSourceDigest,
            "INVALID_REPOSITORY",
            "Accepted revision digest changed",
          );
        }
      }
    } finally {
      this.#collectingRecoveryObjects = undefined;
    }
    this.#recoveryObjects = recoveryObjects;
    // New dependencies require another complete validation: their metadata was
    // not part of the pre-validation fingerprint. Likewise never certify state
    // changed by concurrent activity or recovery's own durable writes.
    if (
      fingerprint &&
      previousObjects.size === recoveryObjects.size &&
      [...recoveryObjects].every((oid) => previousObjects.has(oid)) &&
      fingerprint ===
        await this.#recoveryFingerprint(await this.#records()).catch(() =>
          undefined
        )
    ) {
      this.#recoveredState = fingerprint;
    }
  }
  async readProposalJournal(): Promise<ProposalRecord[]> {
    // #write fsyncs a .tmp file then renames it atomically to .json. Readers
    // see whole old/new dossiers; #records ignores temporaries. An unreadable
    // dossier is advisory here, while listProposals/recovery remain strict.
    return await this.#records((path, error) => {
      log.warn("Proposal journal record skipped", {
        code: "PROPOSAL_JOURNAL_RECORD_SKIPPED",
        context: {
          path,
          message: error instanceof Error ? error.message : String(error),
        },
        recovery: "Repair the proposal journal and reload this advisory view.",
      });
    });
  }
  async listProposals(): Promise<ProposalRecord[]> {
    return await this.#exclusive(async () => {
      await this.#recover();
      return await this.#records();
    });
  }
  /** A server-bound staging surface. Main and human proposal journals are never
   * consulted; ordinary source rights and the actual runtime actor intersect. */
  scopedSoftwarePreparationRepository(input: {
    scope: ScopedSoftwareContextV2;
    assertCurrent(): Promise<void>;
    /** Historical readers omit this; staging requires a host transaction
     * that holds the exact current admission through every Git effect. */
    guardNewEffect?<T>(effect: () => Promise<T>): Promise<T>;
  }): Pick<
    ModelRepositoryPort,
    | "current"
    | "at"
    | "header"
    | "propose"
    | "proposal"
    | "accept"
    | "descriptorAt"
    | "findPublicationByCommand"
  > {
    const scope = parseScopedSoftwareContext(input.scope);
    check(
      scope.destination.repositoryId === this.repositoryId,
      "INVALID_REQUEST",
      "The software Request repository differs",
    );
    const base = scope.destination.expectedAdmittedSource.source.version;
    const current = async () => {
      const head = await this.#directScopedSoftwareRef(scope.destination.ref);
      check(head, "NOT_FOUND", "The software Request source ref is missing");
      return await this.#atWithBuildPolicy(head, false);
    };
    const proposal = async (
      id: string,
    ): Promise<ScopedSoftwareProposalRecord> => {
      scopedSoftwareSourceAdmissionRef(id, base);
      const record = await this.#read<ScopedSoftwareProposalRecord>(
        `software-proposals/${id}.json`,
      );
      check(
        record && record.id === id &&
          record.softwareRequestSource?.format ===
            "request-software-source-proposal/v2" &&
          canonical(record.softwareRequestSource.scope) === canonical(scope) &&
          record.baseVersion === base &&
          record.proposalVersion &&
          record.authorization?.kind === "operator-evolution" &&
          record.authorization.operatorNativeId === scope.actor.operatorId &&
          await this.#requestRef(`refs/heads/software-proposals/${id}`) ===
            record.proposalVersion,
        "SOURCE_CONFLICT",
        "The exact software Request proposal is unavailable",
      );
      return structuredClone(record);
    };
    return {
      current,
      at: (version) => this.#atWithBuildPolicy(version, false),
      header: (version) => this.header(version),
      descriptorAt: (version) => this.descriptorAt(version),
      proposal,
      accept() {
        throw new ModelRepositoryError(
          "EDIT_SCOPE_DENIED",
          "Software Request publication requires its dedicated queued command",
        );
      },
      findPublicationByCommand() {
        throw new ModelRepositoryError(
          "EDIT_SCOPE_DENIED",
          "Software Request recovery requires its dedicated publication proof",
        );
      },
      propose: async (value) => {
        const request = structuredClone(value),
          authorization = request.authorization;
        check(
          request.baseVersion === base &&
            authorization?.kind === "operator-evolution" &&
            authorization.operatorNativeId === scope.actor.operatorId &&
            request.author === `agent:${scope.actor.operatorId}`,
          "EDIT_SCOPE_DENIED",
          "The software Request staging authority differs",
        );
        const reason = reasonText(request.reason);
        check(
          !/^(?:ASE-Software-Source|ASE-Request-Source|ASE-Write-Command|ASE-Approval|ASE-Author):/m
            .test(reason),
          "INVALID_REQUEST",
          "Software proposal reason contains a reserved trailer",
        );
        const before = await current();
        check(
          before.version === base &&
            before.sourceDigest ===
              scope.destination.expectedAdmittedSource.sourceDigest,
          "STALE_REVISION",
          "The software Request admitted source changed before preparation",
        );
        const compiled = await this.#pool.run(() =>
          this.#compiler.compile(request.sources)
        );
        const diff = diffSources(before.sources, compiled.sources);
        check(
          diff.length > 0,
          "INVALID_REQUEST",
          "Software proposal changes no source",
        );
        const guardNewEffect = input.guardNewEffect;
        check(
          guardNewEffect,
          "EDIT_SCOPE_DENIED",
          "Software proposal requires its live transactional authority guard",
        );
        const authorize = async () => {
          await input.assertCurrent();
          await this.#authorizeScopedSoftware({
            authority: before,
            before,
            after: compiled,
            authorization,
            author: request.author,
            phase: "proposal",
          }, scope);
        };
        await authorize();
        return await this.#exclusive(() =>
          guardNewEffect(async () => {
            await this.#directScopedSoftwareRef(scope.destination.ref, base);
            await authorize();
            // A fresh current-authority check precedes all new Git object/ref effects.
            const version = await this.#snapshot(
              compiled,
              [base],
              request.author,
              reason,
            );
            const id = crypto.randomUUID();
            const record: ScopedSoftwareProposalRecord = {
              id,
              branch: `software-proposals/${id}`,
              author: request.author,
              reason,
              baseVersion: base,
              createdAt: this.#clock.now(),
              status: "proposed",
              validation: "validated",
              sourceDigest: compiled.sourceDigest,
              proposalVersion: version,
              diff,
              authorization,
              ...(request.addresses ? { addresses: request.addresses } : {}),
              softwareRequestSource: {
                format: "request-software-source-proposal/v2",
                scope,
              },
            };
            await authorize();
            await this.#cas(`refs/heads/${record.branch}`, version);
            await Deno.mkdir(`${this.stateDir}/software-proposals`, {
              recursive: true,
            });
            await this.#write(`software-proposals/${id}.json`, record);
            return structuredClone(record);
          })
        );
      },
    };
  }

  /** Bind only immutable durable software evidence; recovery runs before any
   * current-authority requirement so a past effect remains recoverable. */
  async scopedSoftwareSourceWrite(
    input: ScopedSoftwareSourceWriteOptions,
  ): Promise<ScopedSoftwareSourceWriteFacade> {
    const { write: dossier, evolution } =
      await assertScopedSoftwareWriteMatchesEvolution(
        input.dossier,
        input.evolution,
      );
    check(
      dossier.command.repositoryId === this.repositoryId,
      "INVALID_REQUEST",
      "The software Request source belongs to another repository",
    );
    const options: ScopedSoftwareSourceWriteOptions = {
      dossier,
      evolution,
      protocol: input.protocol,
    };
    return Object.freeze({
      destination: structuredClone(dossier.command.destination),
      recover: (lease?: WriteLease) =>
        this.#recoverScopedSoftwareSource(options, lease),
      accept: (lease: WriteLease) =>
        this.#acceptScopedSoftwareSource(options, lease),
    });
  }
  async #scopedSoftwareProof(
    options: ScopedSoftwareSourceWriteOptions,
    result: ModelRevision,
  ): Promise<ScopedSoftwareSourceGitReceipt> {
    const { dossier, evolution } = options, command = dossier.command;
    const before = await this.#atWithBuildPolicy(
      command.approvedBase.version,
      false,
    );
    const staged = await this.#atWithBuildPolicy(
      evolution.proposal.version,
      false,
    );
    check(
      before.sourceDigest ===
          command.destination.expectedAdmittedSource.sourceDigest &&
        staged.sourceDigest === evolution.proposal.sourceDigest &&
        result.sourceDigest === staged.sourceDigest &&
        canonical(staged.sources) === canonical(result.sources),
      "SOURCE_CONFLICT",
      "Software Request exact sources differ",
    );
    let replay = { ...before.sources };
    if (dossier.operations.kind === "whole-files") {
      for (const file of dossier.operations.files.files) {
        const text = before.sources[file.path];
        check(
          (text === undefined ? null : await sha256(text)) === file.baseDigest,
          "SOURCE_CONFLICT",
          "Software source operation preimage differs",
        );
        if (file.text === null) delete replay[file.path];
        else replay[file.path] = file.text;
      }
    } else {
      const executor = this.options.requestSourceExecutor;
      check(
        executor,
        "EDIT_SCOPE_DENIED",
        "Software source host executor is unavailable",
      );
      const edits = dossier.operations.journal.entries.map((entry) =>
        entry.edit
      );
      const applied = await executor.apply(before, edits);
      check(
        canonical(applied.resolvedEdits) === canonical(edits),
        "SOURCE_CONFLICT",
        "Software source operations differ",
      );
      replay = applied.sources;
      await executor.verify(result, edits, before);
    }
    check(
      canonical(replay) === canonical(result.sources),
      "SOURCE_CONFLICT",
      "Software source operations do not reproduce the exact candidate",
    );
    const [priorUnits, resultUnits] = await Promise.all([
      validateSourceEvolutionExecutables(before, this.projectId),
      validateSourceEvolutionExecutables(result, this.projectId),
    ]);
    const effects = classifyEvolutionEffects(priorUnits, resultUnits);
    // This proof observes source S→candidate only. The signed category set is
    // the exact union with executed R→candidate, verified by scoped current
    // authority. A runtime pin may lag S; Git must not demand those sets equal.
    check(
      effects.length > 0 &&
        canonical(
            [...new Set(effects.map((effect) => effect.targetNativeId))].sort(),
          ) === canonical(
            evolution.proposal.targets.map((target) => target.operatorId)
              .sort(),
          ) &&
        effects.every((effect) =>
          evolution.proposal.categories.includes(effect.category)
        ),
      "SOURCE_CONFLICT",
      "Software source native effects differ from the scoped proposal",
    );
    const targets = evolution.proposal.targets.map((target) => {
      const selected = resultUnits.filter(({ model }) =>
        model.identity.builderId === target.operatorId
      );
      check(
        selected.length === 1 &&
          selected[0].model.version.digest === target.candidateDigest,
        "SOURCE_CONFLICT",
        "Software source target identity/digest differs",
      );
      return {
        operatorId: target.operatorId,
        identity: structuredClone(selected[0].model.identity),
        digest: selected[0].model.version.digest,
      };
    });
    const build = await this.descriptorAt(result.version);
    check(
      build && canonical(build) === canonical(evolution.proposal.build) &&
        build.recipe.digest === command.recipeDigest,
      "SOURCE_CONFLICT",
      "Software source exact retained build differs",
    );
    return {
      format: "request-software-source-publication/v2",
      proposalVersion: evolution.proposal.version,
      destination: command.destination,
      openingBaseDigest: evolution.scope.openingBaseDigest,
      predecessor: {
        ...command.destination.expectedAdmittedSource,
        manifestDigest: evolution.scope.predecessorManifestDigest,
      },
      result: {
        sourceDigest: result.sourceDigest,
        build,
        buildDigest: await sha256(canonical(build)),
        targets,
      },
      command,
      commandDigest: await scopedSoftwareWriteCommandDigest(command),
      writeDossierDigest: await scopedSoftwareWriteDossierDigest(dossier),
      evolutionDossierId: evolution.id,
      evolutionIntentDigest: evolution.intentDigest,
      proposalDigest: evolution.proposal.digest,
      decisionDigest: command.decisionRef.digest,
    };
  }
  async #scopedSoftwareContext(
    options: ScopedSoftwareSourceWriteOptions,
    proof: ScopedSoftwareSourceGitReceipt,
    version: string,
  ): Promise<ScopedSoftwareSourcePublicationContext> {
    const { proposalVersion: _proposalVersion, ...admissionProof } = proof;
    const admission = await parseScopedSoftwareSourceAdmission({
      ...admissionProof,
      format: "request-software-source-admission/v2",
      result: {
        ...proof.result,
        source: { repositoryId: this.repositoryId, version },
      },
      publication: {
        repositoryId: this.repositoryId,
        commandId: options.dossier.command.commandId,
        commandRef: scopedSoftwareSourceCommandRef(
          options.dossier.command.commandId,
        ),
        publicationRef: scopedSoftwareSourceAdmissionRef(
          options.dossier.command.commandId,
          version,
        ),
        commit: version,
        receiptDigest: await sha256(canonical(proof)),
      },
    });
    await assertScopedSoftwareAdmissionEvidence(
      admission,
      options.dossier,
      options.evolution,
    );
    return {
      dossier: options.dossier,
      evolution: options.evolution,
      admission,
    };
  }
  async #directScopedSoftwareRef(
    ref: string,
    expected?: string,
  ): Promise<string | undefined> {
    const listing = new TextDecoder().decode(
      await this.#gitBytes(
        [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(symref)",
          ref,
        ],
        undefined,
        false,
        false,
        65_536,
      ),
    );
    const rows = listing.split("\n").filter(Boolean).map((line) =>
      line.split("\0")
    ).filter((row) => row[0] === ref);
    if (!rows.length && expected === undefined) return undefined;
    check(
      rows.length === 1 && rows[0].length === 3 && rows[0][2] === "" &&
        (expected === undefined || rows[0][1] === sha(expected)),
      "SOURCE_CONFLICT",
      "Software publication ref is missing, symbolic or moved",
    );
    return String(parseModelRevisionId(`commit:${rows[0][1]}`));
  }
  /** Historical SQL receipt verification only. No journal repair, current
   * runtime, grant replay or source compilation is used by this read path. */
  async verifyScopedSoftwareSourceAdmission(
    value: ScopedSoftwareSourceAdmissionV2,
  ): Promise<void> {
    const admission = await parseScopedSoftwareSourceAdmission(value);
    const version = admission.result.source.version;
    check(
      admission.command.repositoryId === this.repositoryId,
      "SOURCE_CONFLICT",
      "The software source receipt belongs to another repository",
    );
    await this.#directScopedSoftwareRef(
      admission.publication.commandRef,
      version,
    );
    await this.#directScopedSoftwareRef(
      admission.publication.publicationRef,
      version,
    );
    const body = new TextDecoder().decode(
      await this.#gitBytes(
        ["show", "-s", "--format=%B", sha(version)],
        undefined,
        false,
        false,
        MAX_APPROVAL_RECEIPT_BYTES + 16_384,
      ),
    );
    const trailers = body.split("\n").filter((line) =>
      line.startsWith("ASE-Software-Source: ")
    );
    check(
      trailers.length === 1 &&
        new TextEncoder().encode(trailers[0]).byteLength <=
          MAX_APPROVAL_RECEIPT_BYTES,
      "SOURCE_CONFLICT",
      "The software source receipt is missing or unbounded",
    );
    const raw = JSON.parse(
      trailers[0].slice("ASE-Software-Source: ".length),
    ) as ScopedSoftwareSourceGitReceipt;
    check(
      raw && typeof raw === "object" && !Array.isArray(raw),
      "SOURCE_CONFLICT",
      "The software Git receipt is invalid",
    );
    parseModelRevisionId(raw.proposalVersion);
    const { result, publication: _publication, format: _format, ...stable } =
      admission;
    const { source: _source, ...target } = result;
    const expected: ScopedSoftwareSourceGitReceipt = {
      ...stable,
      format: "request-software-source-publication/v2",
      proposalVersion: raw.proposalVersion,
      result: target,
    };
    const anchor = this.#commandFromBody(body);
    const parents =
      (await this.#git(["rev-list", "--parents", "-n", "1", sha(version)]))
        .trim().split(" ").slice(1);
    check(
      canonical(raw) === canonical(expected) &&
        await sha256(canonical(raw)) === admission.publication.receiptDigest &&
        anchor?.commandId === admission.command.commandId &&
        anchor.commandDigest === admission.commandDigest &&
        canonical(parents) ===
          canonical([
            sha(admission.command.approvedBase.version),
            sha(raw.proposalVersion),
          ]),
      "SOURCE_CONFLICT",
      "The software source Git receipt or original parents differ",
    );
    const revision = await this.#atWithBuildPolicy(version, false);
    const staged = await this.#atWithBuildPolicy(raw.proposalVersion, false);
    const build = await this.descriptorAt(version);
    check(
      revision.sourceDigest === admission.result.sourceDigest &&
        staged.sourceDigest === revision.sourceDigest &&
        canonical(staged.sources) === canonical(revision.sources) &&
        build && canonical(build) === canonical(admission.result.build),
      "SOURCE_CONFLICT",
      "The software source retained bytes/build differ",
    );
    const units = await validateSourceEvolutionExecutables(
      revision,
      this.projectId,
    );
    for (const target of admission.result.targets) {
      const selected = units.filter(({ model }) =>
        model.identity.builderId === target.operatorId
      );
      check(
        selected.length === 1 &&
          selected[0].model.version.digest === target.digest &&
          canonical(selected[0].model.identity) === canonical(target.identity),
        "SOURCE_CONFLICT",
        "The software source retained target differs",
      );
    }
  }
  async #recoverScopedSoftwareSource(
    options: ScopedSoftwareSourceWriteOptions,
    lease?: WriteLease,
  ): Promise<ModelRevision | null> {
    const run = async () => {
      const command = options.dossier.command;
      const version = await this.#directScopedSoftwareRef(
        scopedSoftwareSourceCommandRef(command.commandId),
      );
      if (!version) return null;
      await this.#directScopedSoftwareRef(
        scopedSoftwareSourceAdmissionRef(command.commandId, version),
        version,
      );
      const body = new TextDecoder().decode(
        await this.#gitBytes(
          ["show", "-s", "--format=%B", sha(version)],
          undefined,
          false,
          false,
          MAX_APPROVAL_RECEIPT_BYTES + 16_384,
        ),
      );
      const trailers = body.split("\n").filter((line) =>
        line.startsWith("ASE-Software-Source: ")
      );
      check(
        trailers.length === 1 &&
          new TextEncoder().encode(trailers[0]).byteLength <=
            MAX_APPROVAL_RECEIPT_BYTES,
        "SOURCE_CONFLICT",
        "Software publication lacks one bounded exact receipt",
      );
      const raw: unknown = JSON.parse(
        trailers[0].slice("ASE-Software-Source: ".length),
      );
      const parents =
        (await this.#git(["rev-list", "--parents", "-n", "1", sha(version)]))
          .trim().split(" ").slice(1);
      const anchor = this.#commandFromBody(body);
      check(
        canonical(parents) ===
            canonical([
              sha(command.approvedBase.version),
              sha(options.evolution.proposal.version),
            ]) &&
          await this.#requestFirstParent(
            version,
            (await this.#directScopedSoftwareRef(command.destination.ref)) ??
              "",
          ) &&
          anchor?.commandId === command.commandId &&
          anchor.commandDigest ===
            await scopedSoftwareWriteCommandDigest(command),
        "SOURCE_CONFLICT",
        "Software publication original parents, command or destination lineage differs",
      );
      const result = await this.#atWithBuildPolicy(version, false);
      const proof = await this.#scopedSoftwareProof(options, result);
      check(
        canonical(raw) === canonical(proof),
        "SOURCE_CONFLICT",
        "Software publication receipt differs from exact durable/native evidence",
      );
      const context = await this.#scopedSoftwareContext(
        options,
        proof,
        version,
      );
      try {
        await options.protocol.settleHistorical(context, lease);
      } catch (error) {
        if (lease) throw new RequestSourcePublicationPending(error);
        throw error;
      }
      return result;
    };
    try {
      return lease ? await this.#exclusive(run) : await run();
    } catch (error) {
      if (lease && isRequestSourceProofUnavailable(error)) {
        throw new RequestSourcePublicationPending(error);
      }
      throw error;
    }
  }
  async #acceptScopedSoftwareSource(
    options: ScopedSoftwareSourceWriteOptions,
    lease: WriteLease,
  ): Promise<ModelRevision> {
    const { dossier, evolution, protocol } = options, command = dossier.command;
    check(
      lease.repositoryId === this.repositoryId &&
        lease.commandId === command.commandId,
      "INVALID_REQUEST",
      "Software publication lease differs",
    );
    const recovered = await this.#recoverScopedSoftwareSource(options, lease);
    if (recovered) return recovered;
    const staging = this.scopedSoftwarePreparationRepository({
      scope: evolution.scope,
      assertCurrent: async () => {},
    });
    const record = await staging.proposal(command.commandId);
    check(
      record.proposalVersion === evolution.proposal.version &&
        record.sourceDigest === evolution.proposal.sourceDigest &&
        record.baseVersion === command.approvedBase.version &&
        record.authorization?.kind === "operator-evolution" &&
        record.authorization.exercise.proposalDigest ===
          evolution.scopedProposal.sourceAssessmentDigest,
      "SOURCE_CONFLICT",
      "Software publication proposal differs from its exact preparation",
    );
    const before = await this.#atWithBuildPolicy(
      command.approvedBase.version,
      false,
    );
    const proposed = await this.#atWithBuildPolicy(
      evolution.proposal.version,
      false,
    );
    const compiled = await this.#pool.run(() =>
      this.#compiler.compile(proposed.sources)
    );
    check(
      compiled.sourceDigest === evolution.proposal.sourceDigest &&
        this.options.buildService,
      "SOURCE_CONFLICT",
      "Software publication source/build service differs",
    );
    const authorize = async () => {
      await protocol.assertNewEffect(evolution, dossier, before, compiled);
      // Retain the exact ordinary file/root and original preparation grant check.
      // Scoped acceptance/adoption grants are independently checked by protocol.
      await this.#authorizeScopedSoftware({
        authority: before,
        before,
        after: compiled,
        authorization: record.authorization,
        author: record.author,
        phase: "proposal",
      }, evolution.scope);
    };
    await authorize();
    const descriptor = await this.options.buildService.ensure(
      compiled,
      await this.#compiler.recipe(),
    );
    check(
      canonical(descriptor) === canonical(evolution.proposal.build),
      "SOURCE_CONFLICT",
      "Software publication compiler recipe/build changed",
    );
    return await this.#exclusive(async () => {
      await this.#directScopedSoftwareRef(
        command.destination.ref,
        command.approvedBase.version,
      );
      await authorize();
      const parents = [
        command.approvedBase.version,
        evolution.proposal.version,
      ];
      const candidate = await this.#snapshot(
        compiled,
        parents,
        record.author,
        `Prepare software Request ${command.commandId}`,
        undefined,
        undefined,
        descriptor,
      );
      const proof = await this.#scopedSoftwareProof(
        options,
        await this.#atWithBuildPolicy(candidate, false),
      );
      check(
        new TextEncoder().encode(`ASE-Software-Source: ${canonical(proof)}`)
          .byteLength <= MAX_APPROVAL_RECEIPT_BYTES,
        "INVALID_REQUEST",
        "Software publication receipt exceeds its bound",
      );
      await authorize();
      const target = await this.#snapshot(
        compiled,
        parents,
        record.author,
        `Publish software Request ${command.commandId}`,
        undefined,
        { commandId: command.commandId, commandDigest: proof.commandDigest },
        descriptor,
        undefined,
        proof,
      );
      const result = await this.#atWithBuildPolicy(target, false);
      check(
        canonical(await this.#scopedSoftwareProof(options, result)) ===
          canonical(proof),
        "SOURCE_CONFLICT",
        "Software prepared commit differs from its immutable proof",
      );
      const context = await this.#scopedSoftwareContext(options, proof, target);
      await authorize();
      let gitStarted = false;
      try {
        return await protocol.guardNewPublication(lease, context, async () => {
          gitStarted = true;
          await this.#git(
            ["update-ref", "--no-deref", "--stdin"],
            `start\nupdate ${command.destination.ref} ${sha(target)} ${
              sha(command.approvedBase.version)
            }\ncreate ${scopedSoftwareSourceCommandRef(command.commandId)} ${
              sha(target)
            }\ncreate ${
              scopedSoftwareSourceAdmissionRef(command.commandId, target)
            } ${sha(target)}\nprepare\ncommit\n`,
          );
          return result;
        });
      } catch (error) {
        if (gitStarted || isRequestSourceSettlementUnavailable(error)) {
          throw new RequestSourcePublicationPending(error);
        }
        throw error;
      }
    });
  }

  /** Server-only immutable target. Construct only after the resolver has joined
   * durable Opening/Case/host identity; decoding this object grants nothing. */
  requestSourceTarget(input: RequestSourceTargetOptions): RequestSourceTarget {
    const destination = parseRequestModelWriteDestination(
      structuredClone(input.destination),
    );
    const openingBaseDigest = input.openingBaseDigest,
      predecessorManifestDigest = input.predecessorManifestDigest;
    check(
      destination.repositoryId === this.repositoryId &&
        /^[a-f0-9]{64}$/.test(openingBaseDigest) &&
        /^[a-f0-9]{64}$/.test(predecessorManifestDigest),
      "INVALID_REQUEST",
      "Invalid Request repository binding",
    );
    const options: RequestSourceTargetOptions = {
      destination,
      openingBaseDigest,
      predecessorManifestDigest,
      protocol: input.protocol,
    };
    return Object.freeze({
      get destination() {
        return structuredClone(destination);
      },
      current: async () =>
        await this.#atWithBuildPolicy(
          await this.#requestHead(destination),
          false,
        ),
      proposal: async (id: string) =>
        structuredClone(await this.#requestProposal(destination, id)),
      propose: async (request: Parameters<RequestSourceTarget["propose"]>[0]) =>
        await this.#proposeRequest(options, request),
      bind: async (value: ModelWriteDossierV2) => {
        const dossier = await parseModelWriteDossierV2(value);
        if (dossier.command.kind === "approved-change") {
          assertRequestChangeDossier(dossier);
        } else {check(
            dossier.command.kind === "accept-proposal" &&
              dossier.decision.kind === "accept-proposal" &&
              dossier.decision.author === "local-owner" &&
              dossier.operations.kind === "whole-files",
            "INVALID_REQUEST",
            "Unsupported Request source write route",
          );}
        assertModelWriteDestinationMatches(dossier.command, destination);
        return Object.freeze({
          get destination() {
            return structuredClone(destination);
          },
          current: async () =>
            await this.#atWithBuildPolicy(
              await this.#requestHead(destination),
              false,
            ),
          at: async (version: string) => {
            check(
              await this.#requestFirstParent(
                version,
                await this.#requestHead(destination),
              ),
              "NOT_FOUND",
              "Version is outside the Request source history",
            );
            return await this.#atWithBuildPolicy(version, false);
          },
          proposal: async (id: string) =>
            structuredClone(await this.#requestProposal(destination, id)),
          recover: async (lease?: WriteLease) =>
            await this.#recoverRequest(options, dossier, lease),
          accept: async (lease: WriteLease) =>
            await this.#acceptRequest(options, dossier, lease),
        });
      },
    });
  }
  async #requestRef(ref: string): Promise<string | undefined> {
    const output = await this.#git([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      ref,
    ]);
    const rows = output.trim().split("\n").filter(Boolean).map((line) =>
      line.split(" ")
    );
    const exact = rows.filter(([name]) => name === ref);
    check(exact.length <= 1, "INVALID_REPOSITORY", "Ambiguous Request ref");
    const oid = exact[0]?.[1];
    return oid ? String(parseModelRevisionId(`commit:${oid}`)) : undefined;
  }
  /** Reuses the publication receipt codec and command trailer checks from
   * recovery, but does not require the current physical Request head. */
  async verifyRequestSourceAdmission(
    input: RequestSourceAdmission,
  ): Promise<void> {
    const admission = await parseRequestSourceAdmission(structuredClone(input));
    const version = admission.result.source.version;
    const directRef = async (ref: string) => {
      const listing = new TextDecoder().decode(
        await this.#gitBytes(
          [
            "for-each-ref",
            "--format=%(refname)%00%(objectname)%00%(symref)",
            ref,
          ],
          undefined,
          false,
          false,
          65_536,
        ),
      );
      const rows = listing.split("\n").filter(Boolean).map((line) =>
        line.split("\0")
      );
      const matches = rows.filter((row) => row[0] === ref);
      check(
        matches.length === 1 && matches[0].length === 3 &&
          matches[0][2] === "" &&
          matches[0][1] === sha(version),
        "SOURCE_CONFLICT",
        "Request publication ref is unavailable or changed",
      );
    };
    check(
      admission.result.source.repositoryId === this.repositoryId &&
        admission.publication.repositoryId === this.repositoryId,
      "SOURCE_CONFLICT",
      "Request publication anchors differ from the admitted source",
    );
    await directRef(admission.publication.commandRef);
    await directRef(admission.publication.publicationRef);
    const body = new TextDecoder().decode(
      await this.#gitBytes(
        ["show", "-s", "--format=%B", sha(version)],
        undefined,
        false,
        false,
        MAX_APPROVAL_RECEIPT_BYTES + 16_384,
      ),
    );
    const trailers = body.split("\n").filter((line) =>
      line.startsWith("ASE-Request-Source: ")
    );
    check(
      trailers.length === 1 &&
        new TextEncoder().encode(trailers[0]).byteLength <=
          MAX_APPROVAL_RECEIPT_BYTES,
      "INVALID_REPOSITORY",
      "Request source publication receipt is unavailable",
    );
    const raw = JSON.parse(trailers[0].slice("ASE-Request-Source: ".length));
    const anchoredCommand = this.#commandFromBody(body);
    const { source: _source, ...result } = admission.result;
    const expected: RequestSourceGitReceipt = {
      format: "request-source-publication/v1",
      destination: admission.destination,
      openingBaseDigest: admission.openingBaseDigest,
      predecessor: admission.predecessor,
      result,
      commandDigest: admission.commandDigest,
      dossierDigest: admission.dossierDigest,
      decisionDigest: admission.decisionDigest,
      authorityDigest: admission.authorityDigest,
    };
    check(
      anchoredCommand?.commandId === admission.command.commandId &&
        anchoredCommand.commandDigest === admission.commandDigest &&
        canonical(raw) === canonical(expected) &&
        await sha256(canonical(raw)) === admission.publication.receiptDigest,
      "SOURCE_CONFLICT",
      "Request source receipt differs from its immutable Git proof",
    );
    const descriptor = await this.descriptorAt(version);
    check(
      descriptor && canonical(descriptor) === canonical(admission.result.build),
      "SOURCE_CONFLICT",
      "Request source build differs from its admitted proof",
    );
    const revision = await this.#atWithBuildPolicy(version, false);
    check(
      revision.sourceDigest === admission.result.sourceDigest,
      "SOURCE_CONFLICT",
      "Request source bytes differ from the admitted proof",
    );
  }
  async #requestHead(
    destination: RequestModelWriteDestination,
  ): Promise<string> {
    const version = await this.#requestRef(destination.ref);
    check(version, "NOT_FOUND", "Request source ref is missing");
    return version;
  }
  /** The host authorizes and binds this static Opening locator before lookup.
   * The original A0 is read from the private journal, never today's head. */
  async readRequestSourceProposal(input: RequestModelWriteLocator, id: string) {
    const locator = parseRequestModelWriteLocator(input);
    check(
      locator.repositoryId === this.repositoryId &&
        locator.host.projectId === this.projectId,
      "INVALID_REQUEST",
      "Request proposal belongs to another repository",
    );
    requestSourceCommandRef(id);
    const record = await this.#read<RequestProposalRecord>(
      `proposals/${id}.json`,
    );
    if (!record || !Object.hasOwn(record, "requestSource")) return null;
    const destination = parseRequestSourceOwnerPhaseBinding(
      record.requestSource?.authority,
      "proposal",
    ).destination;
    const { expectedAdmittedSource: _source, ...storedLocator } = destination;
    if (canonical(locator) !== canonical(storedLocator)) return null;
    const validated = this.#validateRequestProposal(record, destination, id);
    return structuredClone({
      record: validated,
      authority: validated.requestSource.authority,
      destination,
    });
  }
  async #requestProposal(
    destination: RequestModelWriteDestination,
    id: string,
  ): Promise<RequestProposalRecord> {
    requestSourceAdmissionRef(
      id,
      destination.expectedAdmittedSource.source.version,
    );
    const record = await this.#read<RequestProposalRecord>(
      `proposals/${id}.json`,
    );
    return this.#validateRequestProposal(record, destination, id);
  }
  #validateRequestProposal(
    record: RequestProposalRecord | undefined,
    destination: RequestModelWriteDestination,
    id: string,
  ): RequestProposalRecord {
    requestSourceAdmissionRef(
      id,
      destination.expectedAdmittedSource.source.version,
    );
    check(
      record?.id === id &&
        record.requestSource?.format === "request-source-proposal/v1" &&
        Object.keys(record.requestSource).sort().join(",") ===
          "authority,destination,format" &&
        canonical(record.requestSource.destination) === canonical(destination),
      "NOT_FOUND",
      "Request proposal is missing or belongs to another destination",
    );
    const binding = parseRequestSourceOwnerPhaseBinding(
      record.requestSource.authority,
      "proposal",
    );
    check(
      !/^(?:ASE-Request-Source|ASE-Write-Command|ASE-Approval|ASE-Author):/m
        .test(reasonText(record.reason)),
      "INVALID_REPOSITORY",
      "Request proposal reason contains a reserved publication trailer",
    );
    check(
      canonical(binding.destination) === canonical(destination) &&
        record.baseVersion ===
          destination.expectedAdmittedSource.source.version &&
        record.branch === `proposal_${id}` &&
        record.validation === "validated" && record.author === "local-owner",
      "INVALID_REPOSITORY",
      "Request proposal binding changed",
    );
    return record;
  }
  async #requestFirstParent(
    ancestor: string,
    descendant: string,
  ): Promise<boolean> {
    return (await this.#git(["rev-list", "--first-parent", sha(descendant)]))
      .trim().split("\n").includes(sha(ancestor));
  }
  async #authorizeRequest(
    before: ModelRevision,
    after: CompiledModel,
    proposal: RequestSourceOwnerPhaseBinding<"proposal">,
    acceptance?: RequestSourceOwnerPhaseBinding<"acceptance">,
    recovery = false,
    teamCreationRoot?: string,
  ): Promise<void> {
    if (!this.options.sourceAuthorization) {
      if (recovery) {
        throw new RequestSourcePublicationPending(
          new Error(
            "Native Request source authorization adapter is unavailable",
          ),
        );
      }
      throw new ModelRepositoryError(
        "EDIT_SCOPE_DENIED",
        "Request source writes require the native source authorizer",
      );
    }
    try {
      await this.#authorize({
        authority: before,
        before,
        after,
        authorization: {
          kind: "local-owner",
          authorityExercise: proposal.exercise,
        },
        ...(acceptance
          ? { decisionAuthorityExercise: acceptance.exercise }
          : {}),
        ...(teamCreationRoot ? { teamCreationRoot } : {}),
        author: "local-owner",
        phase: recovery ? "recovery" : acceptance ? "acceptance" : "proposal",
      });
    } catch (error) {
      if (
        isRequestSourceProofUnavailable(error) ||
        error instanceof ModelRepositoryError
      ) throw error;
      throw new ModelRepositoryError(
        "EDIT_SCOPE_DENIED",
        error instanceof Error
          ? error.message
          : "Native Request source authority refused",
      );
    }
  }
  /** A person's team decision creates exactly the requester's teammate named
   * after the change; its effect is verified by the network evidence. */
  async #teamCreationRoot(
    dossier: RequestChangeDossier,
  ): Promise<string | undefined> {
    const change = dossier.decision.change;
    const scope = requestWriteAuthorityPrior(dossier.authority).identity
      .systemQualifiedName;
    return requestChangeEffect(change) === "team-member" && scope
      ? await requestOperatorSystemName(scope, change.id)
      : undefined;
  }
  async #instructionEvidence(
    before: ModelRevision,
    after: ModelRevision,
    authority: RequestSourceOwnerPhaseBinding,
  ): Promise<{ identity: ModelIdentity; digest: string }> {
    const [a, b] = await Promise.all([
      validateSourceEvolutionExecutables(before, this.projectId),
      validateSourceEvolutionExecutables(after, this.projectId),
    ]);
    const prior = a.filter(({ model }) =>
      canonical(model.identity) === canonical(authority.priorModel.identity)
    );
    const result = b.filter(({ model }) =>
      canonical(model.identity) === canonical(authority.priorModel.identity)
    );
    check(
      prior.length === 1 && result.length === 1 &&
        prior[0].model.version.authoritySchema === 2 &&
        result[0].model.version.authoritySchema === 2 &&
        prior[0].model.version.digest === authority.priorModel.version.digest &&
        canonical(prior[0].model.ownerAuthority) ===
          canonical(authority.principal.priorOwner),
      "EDIT_SCOPE_DENIED",
      "Request prior owner/model evidence differs from the exact admitted source",
    );
    let effects: ReturnType<typeof classifyEvolutionEffects>;
    try {
      effects = classifyEvolutionEffects(a, b);
    } catch (error) {
      throw new ModelRepositoryError(
        "EDIT_SCOPE_DENIED",
        error instanceof Error
          ? error.message
          : "Protected Request model effect",
      );
    }
    check(
      effects.length > 0 &&
        effects.every((effect) =>
          effect.category === "instructions" &&
          effect.targetNativeId === authority.priorModel.identity.builderId &&
          effect.systemQualifiedName === prior[0].systemQualifiedName
        ),
      "EDIT_SCOPE_DENIED",
      "Only the selected Request owner's instructions may change",
    );
    return {
      identity: structuredClone(result[0].model.identity),
      digest: result[0].model.version.digest,
    };
  }
  async #proposeRequest(
    options: RequestSourceTargetOptions,
    value: Parameters<RequestSourceTarget["propose"]>[0],
  ): Promise<ProposalRecord> {
    const request = structuredClone(value),
      authority = parseRequestSourceOwnerPhaseBinding(
        request.authority,
        "proposal",
      );
    const destination = options.destination,
      baseVersion = destination.expectedAdmittedSource.source.version;
    check(
      canonical(authority.destination) === canonical(destination),
      "EDIT_SCOPE_DENIED",
      "Proposal names another Request destination",
    );
    await options.protocol.assertProposal(authority);
    check(
      await this.#requestHead(destination) === baseVersion,
      "STALE_REVISION",
      "Request source changed before proposal preparation",
    );
    const reason = reasonText(request.reason), author = "local-owner";
    check(
      !/^(?:ASE-Request-Source|ASE-Write-Command|ASE-Approval|ASE-Author):/m
        .test(reason),
      "INVALID_REQUEST",
      "Request reason contains a reserved publication trailer",
    );
    const base = await this.#atWithBuildPolicy(baseVersion, false);
    check(
      base.sourceDigest === destination.expectedAdmittedSource.sourceDigest,
      "INVALID_REPOSITORY",
      "Request base source digest differs",
    );
    const compiled = await this.#pool.run(() =>
      this.#compiler.compile(request.sources)
    );
    const diff = diffSources(base.sources, compiled.sources);
    check(
      diff.length > 0,
      "INVALID_REQUEST",
      "Proposal does not change sources",
    );
    await this.#authorizeRequest(base, compiled, authority);
    await this.#instructionEvidence(
      base,
      { ...compiled, version: baseVersion },
      authority,
    );
    const version = await this.#snapshot(
      compiled,
      [baseVersion],
      author,
      reason,
    );
    return await this.#exclusive(async () => {
      await options.protocol.assertProposal(authority);
      check(
        await this.#requestHead(destination) === baseVersion,
        "STALE_REVISION",
        "Request source changed during proposal preparation",
      );
      const id = crypto.randomUUID();
      const record: RequestProposalRecord = {
        id,
        branch: `proposal_${id}`,
        author,
        reason,
        baseVersion,
        createdAt: this.#clock.now(),
        status: "preparing",
        validation: "validated",
        sourceDigest: compiled.sourceDigest,
        proposalVersion: version,
        diff,
        requestSource: {
          format: "request-source-proposal/v1",
          destination,
          authority,
        },
      };
      await this.#cas(`refs/heads/${record.branch}`, version);
      await this.#save(record);
      record.status = "proposed";
      await this.#save(record);
      return structuredClone(record);
    });
  }
  async #networkRequestEvidence(
    before: ModelRevision,
    after: ModelRevision,
    dossier: RequestChangeDossier,
  ): Promise<{ identity: ModelIdentity; digest: string }> {
    assertRequestChangeDossier(dossier);
    const [a, b] = await Promise.all([
      validateSourceEvolutionExecutables(before, this.projectId),
      validateSourceEvolutionExecutables(after, this.projectId),
    ]);
    const authority = dossier.authority;
    const identity = requestWriteAuthorityPrior(authority).identity;
    const selected = a.filter(({ model }) =>
      canonical(model.identity) === canonical(identity)
    );
    const target = b.filter(({ model }) =>
      canonical(model.identity) === canonical(identity)
    );
    // The person's proof names the prior owner; the MO's delegated exercise
    // carries the requester model's owner authority it was computed from.
    check(
      selected.length === 1 && target.length === 1 &&
        requestWriteAuthorityMemberProvenanceMatches(
          authority,
          selected[0].model,
        ) &&
        (isSessionlessRequestAuthority(authority)
          ? !!selected[0].model.ownerAuthority &&
            sameOwnerAuthorityIdentity(
              selected[0].model.ownerAuthority,
              authority.exercise,
            )
          : canonical(selected[0].model.ownerAuthority) ===
            canonical(authority.acceptance.principal.priorOwner)),
      "EDIT_SCOPE_DENIED",
      "The Case network source owner differs",
    );
    try {
      const change = dossier.decision.change;
      if (requestChangeEffect(change) === "team-member") {
        await requestTeamCompatibility(
          selected[0].model,
          target[0].model,
          change,
        );
        // Exactly one new unit: the provisioned teammate of this Request.
        const beforeNames = new Set(a.map((item) => item.systemQualifiedName));
        const added = b.filter((item) =>
          !beforeNames.has(item.systemQualifiedName)
        );
        const spec = change.operator;
        const child = added[0]?.model;
        check(
          added.length === 1 && !!child?.operatorTeam && !!spec &&
            isTeamOperatorSpec(spec) &&
            child.operatorTeam.parentOperatorId ===
              selected[0].model.identity.builderId &&
            child.operatorTeam.requestOwnerId ===
              change.teamOrigin!.operatorId &&
            child.operatorTeam.requestId === change.teamOrigin!.requestId &&
            !child.caseTypes?.length &&
            child.operatorEntries?.filter((entry) => entry.kind === "inbox")
                .length === 1 &&
            child.operator?.instruction === spec.instruction &&
            matchesTeamProvision(child, spec.provision),
          "EDIT_SCOPE_DENIED",
          "The Case team creation differs from its exact provision",
        );
        check(
          b.length === a.length + 1,
          "EDIT_SCOPE_DENIED",
          "A Case team change cannot alter another operator",
        );
        requestTeamBystanders(
          selected[0].model,
          target[0].model,
          a.filter((item) =>
            item.systemQualifiedName !== selected[0].systemQualifiedName
          ).map((item) => item.model),
          b.filter((item) =>
            item.systemQualifiedName !== target[0].systemQualifiedName &&
            item.systemQualifiedName !== added[0].systemQualifiedName
          ).map((item) => item.model),
        );
      } else {
        await requestNetworkCompatibility(
          selected[0].model,
          target[0].model,
          change,
        );
        const restBefore = a.filter((item) =>
          item.systemQualifiedName !== selected[0].systemQualifiedName
        );
        const restAfter = b.filter((item) =>
          item.systemQualifiedName !== target[0].systemQualifiedName
        );
        check(
          a.length === b.length && restBefore.length === restAfter.length &&
            (!restBefore.length ||
              classifyEvolutionEffects(restBefore, restAfter).length === 0),
          "EDIT_SCOPE_DENIED",
          "A Case network change cannot alter another operator",
        );
      }
    } catch (error) {
      if (error instanceof ModelRepositoryError) throw error;
      throw new ModelRepositoryError(
        "EDIT_SCOPE_DENIED",
        error instanceof Error
          ? error.message
          : "The exact Case network delta differs",
      );
    }
    return {
      identity: structuredClone(target[0].model.identity),
      digest: target[0].model.version.digest,
    };
  }
  async #networkRequestProof(
    options: RequestSourceTargetOptions,
    dossier: RequestChangeDossier,
    result: ModelRevision,
    recovery: boolean,
  ): Promise<RequestSourceGitReceipt> {
    assertRequestChangeDossier(dossier);
    const before = await this.#atWithBuildPolicy(
      dossier.command.approvedBase.version,
      false,
    );
    check(
      before.sourceDigest ===
          options.destination.expectedAdmittedSource.sourceDigest &&
        result.sourceDigest === dossier.decision.change.diff?.sourceDigest,
      "SOURCE_CONFLICT",
      "The Case network sources differ from the exact approved preview",
    );
    const executor = this.options.requestSourceExecutor;
    check(
      executor,
      "EDIT_SCOPE_DENIED",
      "The native Case source executor is unavailable",
    );
    await executor.verify(
      result,
      dossier.operations.journal.entries.map((entry) => entry.edit),
      before,
    );
    // A delegated decision was revalidated when it was recorded (4.8c A2);
    // the native owner authorizer only knows the person's two phases.
    if (recovery && !isSessionlessRequestAuthority(dossier.authority)) {
      await this.#authorizeRequest(
        before,
        result,
        dossier.authority.proposal,
        dossier.authority.acceptance,
        true,
        await this.#teamCreationRoot(dossier),
      );
    }
    const model = await this.#networkRequestEvidence(before, result, dossier),
      build = await this.descriptorAt(result.version);
    check(
      build && build.repositoryId === this.repositoryId &&
        build.sourceDigest === result.sourceDigest &&
        build.recipe.digest === dossier.command.recipeDigest,
      "INVALID_REPOSITORY",
      "The Case network result build differs",
    );
    if (recovery) {
      const body = await this.#git([
        "show",
        "-s",
        "--format=%B",
        sha(result.version),
      ]);
      const approvals = body.split("\n").filter((line) =>
        line.startsWith("ASE-Approval: ")
      );
      const expected = {
        ...dossier.decision.approval,
        edits: dossier.operations.journal.entries.map((entry) => entry.edit),
      };
      check(
        approvals.length === 1 &&
          canonical(JSON.parse(approvals[0].slice("ASE-Approval: ".length))) ===
            canonical(expected),
        "SOURCE_CONFLICT",
        "The Case network commit lacks its exact approved change receipt",
      );
    }
    return {
      format: "request-source-publication/v1",
      destination: options.destination,
      openingBaseDigest: options.openingBaseDigest,
      predecessor: {
        ...options.destination.expectedAdmittedSource,
        manifestDigest: options.predecessorManifestDigest,
      },
      result: {
        sourceDigest: result.sourceDigest,
        build,
        buildDigest: await sha256(canonical(build)),
        model,
      },
      commandDigest: await modelWriteCommandDigestV2(dossier.command),
      dossierDigest: await modelWriteDossierDigestV2(dossier),
      decisionDigest: dossier.command.decisionRef.digest,
      authorityDigest: dossier.command.authorityRef.digest,
    };
  }
  async #requestProof(
    options: RequestSourceTargetOptions,
    dossier: ModelWriteDossierV2,
    result: ModelRevision,
    recovery = false,
  ): Promise<RequestSourceGitReceipt> {
    if (dossier.command.kind === "approved-change") {
      assertRequestChangeDossier(dossier);
      return await this.#networkRequestProof(
        options,
        dossier,
        result,
        recovery,
      );
    }
    check(
      dossier.decision.kind === "accept-proposal" &&
        dossier.operations.kind === "whole-files",
      "INVALID_REQUEST",
      "Unsupported Request source write route",
    );
    const before = await this.#atWithBuildPolicy(
      dossier.command.approvedBase.version,
      false,
    );
    check(
      before.sourceDigest ===
        options.destination.expectedAdmittedSource.sourceDigest,
      "INVALID_REPOSITORY",
      "Request predecessor source differs",
    );
    const proposed = await this.#atWithBuildPolicy(
      dossier.decision.proposalVersion,
      false,
    );
    const replay = { ...before.sources };
    for (const file of dossier.operations.files.files) {
      const text = before.sources[file.path];
      check(
        (text === undefined ? null : await sha256(text)) === file.baseDigest,
        "SOURCE_CONFLICT",
        "Request operation preimage differs",
      );
      if (file.text === null) delete replay[file.path];
      else replay[file.path] = file.text;
    }
    check(
      canonical(replay) === canonical(proposed.sources) &&
        canonical(result.sources) === canonical(proposed.sources) &&
        proposed.sourceDigest === dossier.decision.proposalSourceDigest,
      "SOURCE_CONFLICT",
      "Request sources differ from the exact accepted operations/proposal",
    );
    const authority = dossier.authority;
    check(
      !isSessionlessRequestAuthority(authority),
      "INVALID_REQUEST",
      "Instruction acceptance requires the person's decision",
    );
    if (recovery) {
      await this.#authorizeRequest(
        before,
        result,
        authority.proposal,
        authority.acceptance,
        true,
      );
    }
    const model = await this.#instructionEvidence(
      before,
      result,
      authority.acceptance,
    );
    const build = await this.descriptorAt(result.version);
    check(
      build && build.repositoryId === this.repositoryId &&
        build.sourceDigest === result.sourceDigest &&
        build.recipe.digest === dossier.command.recipeDigest,
      "INVALID_REPOSITORY",
      "Request result requires its exact retained build descriptor",
    );
    return {
      format: "request-source-publication/v1",
      destination: options.destination,
      openingBaseDigest: options.openingBaseDigest,
      predecessor: {
        ...options.destination.expectedAdmittedSource,
        manifestDigest: options.predecessorManifestDigest,
      },
      result: {
        sourceDigest: result.sourceDigest,
        build,
        buildDigest: await sha256(canonical(build)),
        model,
      },
      commandDigest: await modelWriteCommandDigestV2(dossier.command),
      dossierDigest: await modelWriteDossierDigestV2(dossier),
      decisionDigest: dossier.command.decisionRef.digest,
      authorityDigest: dossier.command.authorityRef.digest,
    };
  }
  async #requestContext(
    dossier: ModelWriteDossierV2,
    proof: RequestSourceGitReceipt,
    version: string,
  ): Promise<RequestSourcePublicationContext> {
    const admission = await parseRequestSourceAdmission({
      ...proof,
      format: "request-source-admission/v1",
      command: dossier.command,
      authority: dossier.authority,
      result: {
        ...proof.result,
        source: { repositoryId: this.repositoryId, version },
      },
      publication: {
        repositoryId: this.repositoryId,
        commandId: dossier.command.commandId,
        commandRef: requestSourceCommandRef(dossier.command.commandId),
        publicationRef: requestSourceAdmissionRef(
          dossier.command.commandId,
          version,
        ),
        commit: version,
        receiptDigest: await sha256(canonical(proof)),
      },
    });
    return { dossier, admission };
  }
  async #recoverRequest(
    options: RequestSourceTargetOptions,
    dossier: ModelWriteDossierV2,
    lease?: WriteLease,
  ): Promise<ModelRevision | null> {
    const command = dossier.command;
    const recover = async () => {
      const version = await this.#requestRef(
        requestSourceCommandRef(command.commandId),
      );
      if (!version) return null;
      if (dossier.command.kind === "approved-change") {
        assertRequestChangeDossier(dossier);
      } else {check(
          dossier.decision.kind === "accept-proposal",
          "INVALID_REQUEST",
          "Unsupported Request source recovery route",
        );}
      const body = await this.#git(["show", "-s", "--format=%B", sha(version)]);
      const trailers = body.split("\n").filter((line) =>
        line.startsWith("ASE-Request-Source: ")
      );
      check(
        trailers.length === 1,
        "INVALID_REPOSITORY",
        "Request command lacks one exact destination-bound publication receipt",
      );
      check(
        new TextEncoder().encode(trailers[0]).byteLength <=
          MAX_APPROVAL_RECEIPT_BYTES,
        "INVALID_REPOSITORY",
        "Request source publication receipt exceeds its bound",
      );
      const raw = JSON.parse(trailers[0].slice("ASE-Request-Source: ".length));
      check(
        raw && typeof raw === "object" && !Array.isArray(raw),
        "INVALID_REPOSITORY",
        "Request publication receipt is not an object",
      );
      const anchoredCommand = this.#commandFromBody(body);
      check(
        anchoredCommand?.commandId === command.commandId &&
          anchoredCommand.commandDigest === raw.commandDigest,
        "SOURCE_CONFLICT",
        "Request command trailer differs from its attestation",
      );
      const parents =
        (await this.#git(["rev-list", "--parents", "-n", "1", sha(version)]))
          .trim().split(" ").slice(1);
      check(
        canonical(parents) ===
            canonical([
              sha(command.approvedBase.version),
              ...(dossier.decision.kind === "accept-proposal"
                ? [sha(dossier.decision.proposalVersion)]
                : []),
            ]) &&
          await this.#requestRef(
              requestSourceAdmissionRef(command.commandId, version),
            ) === version &&
          await this.#requestFirstParent(
            version,
            await this.#requestHead(options.destination),
          ),
        "SOURCE_CONFLICT",
        "Request publication anchors/parents/ref lineage differ",
      );
      const result = await this.#atWithBuildPolicy(version, false);
      const proof = await this.#requestProof(options, dossier, result, true);
      check(
        canonical(raw) === canonical(proof),
        "SOURCE_CONFLICT",
        "Request immutable receipt differs from its exact dossier, destination or native evidence",
      );
      const context = await this.#requestContext(dossier, proof, version);
      // No current credential/open lifecycle required for this past exact effect.
      try {
        await options.protocol.settleHistorical(context, lease);
      } catch (error) {
        if (lease && isRequestSourceSettlementUnavailable(error)) {
          throw new RequestSourcePublicationPending(error);
        }
        throw error;
      }
      // Exact Git + immutable dossier + committed D2 are authoritative. A
      // missing/corrupt/unwritable proposal journal cannot veto this settlement.
      return result;
    };
    // Retain the canonical writer lock until verified historical SQL settlement.
    // Published/read-only verification never opens or writes a journal/lock.
    try {
      return lease ? await this.#exclusive(recover) : await recover();
    } catch (error) {
      if (lease && isRequestSourceProofUnavailable(error)) {
        throw new RequestSourcePublicationPending(error);
      }
      throw error;
    }
  }
  async #acceptNetworkRequest(
    options: RequestSourceTargetOptions,
    dossier: RequestChangeDossier,
    lease: WriteLease,
  ): Promise<ModelRevision> {
    assertRequestChangeDossier(dossier);
    check(
      lease.repositoryId === this.repositoryId &&
        lease.commandId === dossier.command.commandId,
      "INVALID_REQUEST",
      "The Case network write lease differs",
    );
    await options.protocol.assertNewEffect(dossier);
    const version = dossier.command.approvedBase.version;
    check(
      await this.#requestHead(options.destination) === version,
      "STALE_REVISION",
      "The Case network source moved",
    );
    const before = await this.#atWithBuildPolicy(version, false),
      executor = this.options.requestSourceExecutor;
    check(
      executor && this.options.buildService,
      "EDIT_SCOPE_DENIED",
      "The Case network source executor/build service is unavailable",
    );
    const edits = dossier.operations.journal.entries.map((entry) => entry.edit);
    const applied = await executor.apply(before, edits);
    check(
      canonical(applied.resolvedEdits) === canonical(edits),
      "SOURCE_CONFLICT",
      "The Case network host operations differ from the accepted dossier",
    );
    const compiled = await this.#pool.run(() =>
      this.#compiler.compile(applied.sources)
    );
    await executor.verify({ ...compiled, version }, edits, before);
    // A delegated decision was revalidated atomically with its record (A2).
    if (!isSessionlessRequestAuthority(dossier.authority)) {
      await this.#authorizeRequest(
        before,
        compiled,
        dossier.authority.proposal,
        dossier.authority.acceptance,
        false,
        await this.#teamCreationRoot(dossier),
      );
    }
    const descriptor = await this.options.buildService.ensure(
      compiled,
      await this.#compiler.recipe(),
    );
    const candidate = await this.#snapshot(
      compiled,
      [version],
      "local-owner",
      `Prepare Case network ${dossier.command.commandId}`,
      undefined,
      undefined,
      descriptor,
    );
    const proof = await this.#requestProof(
      options,
      dossier,
      await this.#atWithBuildPolicy(candidate, false),
    );
    check(
      new TextEncoder().encode(`ASE-Request-Source: ${canonical(proof)}`)
        .byteLength <= MAX_APPROVAL_RECEIPT_BYTES,
      "INVALID_REQUEST",
      "The Case source receipt exceeds its bound",
    );
    const approval = {
      ...dossier.decision.approval,
      edits: structuredClone(edits),
    };
    const target = await this.#snapshot(
      compiled,
      [version],
      `ase:approved-change:${dossier.command.commandId}`,
      `Approve Case network ${dossier.command.commandId}`,
      approval,
      {
        commandId: dossier.command.commandId,
        commandDigest: proof.commandDigest,
      },
      descriptor,
      proof,
    );
    const result = await this.#atWithBuildPolicy(target, false);
    check(
      canonical(await this.#requestProof(options, dossier, result)) ===
        canonical(proof),
      "SOURCE_CONFLICT",
      "The Case network prepared commit differs",
    );
    const context = await this.#requestContext(dossier, proof, target);
    return await this.#exclusive(async () => {
      check(
        await this.#requestHead(options.destination) === version,
        "STALE_REVISION",
        "The Case network source moved during preparation",
      );
      await options.protocol.assertNewEffect(dossier);
      let gitStarted = false;
      try {
        return await options.protocol.guardNewPublication(
          lease,
          context,
          async () => {
            gitStarted = true;
            await this.#git(
              ["update-ref", "--stdin"],
              `start\nupdate ${options.destination.ref} ${sha(target)} ${
                sha(version)
              }\ncreate ${requestSourceCommandRef(dossier.command.commandId)} ${
                sha(target)
              }\ncreate ${
                requestSourceAdmissionRef(dossier.command.commandId, target)
              } ${sha(target)}\nprepare\ncommit\n`,
            );
            return result;
          },
        );
      } catch (error) {
        if (
          gitStarted && !isRequestSourceHistoryConflict(error) &&
          !(error instanceof ModelRepositoryError) &&
          !(error instanceof Error && error.name === "ModelWriteQueueError")
        ) throw new RequestSourcePublicationPending(error);
        throw error;
      }
    });
  }
  async #acceptRequest(
    options: RequestSourceTargetOptions,
    dossier: ModelWriteDossierV2,
    lease: WriteLease,
  ): Promise<ModelRevision> {
    if (dossier.command.kind === "approved-change") {
      assertRequestChangeDossier(dossier);
      return await this.#acceptNetworkRequest(options, dossier, lease);
    }
    check(
      dossier.decision.kind === "accept-proposal" &&
        dossier.operations.kind === "whole-files" &&
        lease.repositoryId === this.repositoryId &&
        lease.commandId === dossier.command.commandId,
      "INVALID_REQUEST",
      "Request acceptance needs its exact lease and supported route",
    );
    const decision = dossier.decision;
    const authority = dossier.authority;
    check(
      !isSessionlessRequestAuthority(authority),
      "INVALID_REQUEST",
      "Instruction acceptance requires the person's decision",
    );
    await options.protocol.assertNewEffect(dossier);
    const record = await this.#requestProposal(
      options.destination,
      decision.proposalId,
    );
    check(
      record.status === "proposed" &&
        record.proposalVersion === decision.proposalVersion &&
        record.sourceDigest === decision.proposalSourceDigest &&
        record.baseVersion === decision.baseVersion &&
        canonical(record.requestSource.authority) ===
          canonical(authority.proposal),
      "SOURCE_CONFLICT",
      "Request proposal differs from the captured decision",
    );
    check(
      await this.#requestHead(options.destination) === decision.expectedVersion,
      "STALE_REVISION",
      "Request admitted source changed",
    );
    const proposed = await this.#atWithBuildPolicy(
      decision.proposalVersion,
      false,
    );
    const compiled = await this.#pool.run(() =>
      this.#compiler.compile(proposed.sources)
    );
    check(
      compiled.sourceDigest === record.sourceDigest,
      "SOURCE_CONFLICT",
      "Request acceptance needs the exact proposal sources",
    );
    const prior = await this.#atWithBuildPolicy(record.baseVersion, false);
    await this.#authorizeRequest(
      prior,
      compiled,
      authority.proposal,
      authority.acceptance,
    );
    check(
      this.options.buildService,
      "INVALID_REQUEST",
      "Request acceptance requires its retained build service",
    );
    const descriptor = await this.options.buildService.ensure(
      compiled,
      await this.#compiler.recipe(),
    );
    // Build/native preparation and complete evidence are outside SQL locks.
    const candidate = await this.#snapshot(
      compiled,
      [record.baseVersion, record.proposalVersion!],
      "local-owner",
      `Prepare Request ${record.id}`,
      undefined,
      undefined,
      descriptor,
    );
    const candidateRevision = await this.#atWithBuildPolicy(candidate, false);
    const proof = await this.#requestProof(options, dossier, candidateRevision);
    check(
      new TextEncoder().encode(`ASE-Request-Source: ${canonical(proof)}`)
        .byteLength <= MAX_APPROVAL_RECEIPT_BYTES,
      "INVALID_REQUEST",
      "Request source publication receipt exceeds its bounded Git trailer",
    );
    const target = await this.#snapshot(
      compiled,
      [record.baseVersion, record.proposalVersion!],
      "local-owner",
      `Accept Request ${record.id}: ${record.reason}`,
      undefined,
      {
        commandId: dossier.command.commandId,
        commandDigest: proof.commandDigest,
      },
      descriptor,
      proof,
    );
    const result = await this.#atWithBuildPolicy(target, false);
    check(
      canonical(await this.#requestProof(options, dossier, result)) ===
        canonical(proof),
      "INVALID_REPOSITORY",
      "Final Request commit differs from its prepared native/build evidence",
    );
    const context = await this.#requestContext(dossier, proof, target);
    return await this.#exclusive(async () => {
      const latest = await this.#requestProposal(
        options.destination,
        decision.proposalId,
      );
      check(
        canonical(latest) === canonical(record) &&
          await this.#requestHead(options.destination) ===
            decision.expectedVersion,
        "STALE_REVISION",
        "Request proposal/source changed during preparation",
      );
      await options.protocol.assertNewEffect(dossier);
      let gitStarted = false;
      let published: ModelRevision;
      try {
        published = await options.protocol.guardNewPublication(
          lease,
          context,
          async () => {
            gitStarted = true;
            // Short Git CAS only under SQL fence. All three refs are one effect.
            await this.#git(
              ["update-ref", "--stdin"],
              `start\nupdate ${options.destination.ref} ${sha(target)} ${
                sha(record.baseVersion)
              }\ncreate ${requestSourceCommandRef(record.id)} ${
                sha(target)
              }\ncreate ${requestSourceAdmissionRef(record.id, target)} ${
                sha(target)
              }\nprepare\ncommit\n`,
            );
            return result;
          },
        );
      } catch (error) {
        const queueConflict = error instanceof Error &&
          error.name === "ModelWriteQueueError" && "code" in error &&
          ["WRITE_FENCE_LOST", "WRITE_QUEUE_CONFLICT", "WRITE_QUEUE_INVALID"]
            .includes(String(error.code));
        const immutableConflict = isRequestSourceHistoryConflict(error) ||
          error instanceof ModelRepositoryError &&
            !isRequestSourceProofUnavailable(error) &&
            ["SOURCE_CONFLICT", "EDIT_SCOPE_DENIED", "INVALID_REPOSITORY"]
              .includes(error.code);
        if (queueConflict || immutableConflict) throw error;
        if (gitStarted) throw new RequestSourcePublicationPending(error);
        throw error;
      }
      latest.status = "accepted";
      latest.acceptedVersion = target;
      latest.decidedBy = "local-owner";
      latest.decidedAt = this.#clock.now();
      try {
        await this.#save(latest);
      } catch (error) {
        throw new RequestSourcePublicationPending(error);
      }
      return published;
    });
  }
  async propose(
    input: {
      baseVersion: string;
      sources: Sources;
      author: string;
      reason: string;
      authorization?: ModelProposalAuthorization;
      addresses?: ModelDiagnosticAddress[];
    },
  ): Promise<ProposalRecord> {
    const request = structuredClone(input);
    if (request.addresses !== undefined) {
      try {
        request.addresses = modelDiagnosticAddresses(request.addresses);
      } catch (error) {
        throw new ModelRepositoryError(
          "INVALID_REQUEST",
          error instanceof Error
            ? error.message
            : "Invalid diagnostic addresses",
        );
      }
    }
    const author = actor(request.author), reason = reasonText(request.reason);
    const authority = await this.current();
    const prepared = await this.#pool.run(async () => {
      const base = await this.at(request.baseVersion);
      const compiled = await this.#compiler.compile(request.sources);
      const diff = diffSources(base.sources, compiled.sources);
      check(diff.length, "INVALID_REQUEST", "Proposal does not change sources");
      await this.#authorize({
        authority,
        before: base,
        after: compiled,
        authorization: request.authorization,
        author,
        phase: "proposal",
      });
      return { compiled, diff };
    });
    const version = await this.#snapshot(
      prepared.compiled,
      [request.baseVersion],
      author,
      reason,
    );
    return await this.#exclusive(async () => {
      if (
        request.authorization || this.options.sourceAuthorization ||
        author.startsWith("agent:")
      ) {
        check(
          (await this.current()).version === authority.version,
          "STALE_REVISION",
          "Authorization authority changed during proposal preparation",
        );
      }
      const id = crypto.randomUUID();
      const record: ProposalRecord = {
        id,
        branch: `proposal_${id}`,
        author,
        ...(request.authorization
          ? { authorization: request.authorization }
          : {}),
        reason,
        ...(request.addresses !== undefined
          ? { addresses: request.addresses }
          : {}),
        baseVersion: request.baseVersion,
        createdAt: this.#clock.now(),
        status: "preparing",
        validation: "validated",
        sourceDigest: prepared.compiled.sourceDigest,
        proposalVersion: version,
        diff: prepared.diff,
      };
      // Pin before the durable receipt so Git GC cannot collect an interrupted proposal.
      await this.#cas(`refs/heads/${record.branch}`, version);
      await this.#save(record);
      record.status = "proposed";
      await this.#save(record);
      return record;
    });
  }
  async accept(
    input: Parameters<ModelRepositoryPort["accept"]>[0],
  ): Promise<ModelRevision> {
    const request = structuredClone(input);
    const author = actor(request.author);
    check(
      Boolean(request.command) === Boolean(request.fence),
      "INVALID_REQUEST",
      "Queued acceptance requires both command anchor and publication fence",
    );
    if (request.command) {
      commandTrailer(request.command);
      check(
        request.command.commandId === request.id,
        "INVALID_REQUEST",
        "Acceptance command names another proposal",
      );
    }
    const captured = await this.#exclusive(async () => {
      await this.#recover();
      const record = await this.proposal(request.id);
      if (record.status === "accepted") {
        return { completed: await this.at(record.acceptedVersion!) };
      }
      check(
        record.status === "proposed" && record.proposalVersion,
        "INVALID_REQUEST",
        "Proposal is not available for acceptance",
      );
      const current = await this.current();
      check(
        current.version === request.expectedVersion,
        "STALE_REVISION",
        "Admitted revision changed",
      );
      return { record, current };
    });
    if (captured.completed) return captured.completed;
    const { record, current } = captured;
    if (record.authorization?.kind === "operator-evolution") {
      check(
        record.baseVersion === current.version && request.evolutionDecision,
        "EDIT_SCOPE_DENIED",
        "Evolution admission requires its exact base and a separate evolution decision",
      );
    }
    const compiled = await this.#pool.run(async () => {
      const base = await this.at(record.baseVersion),
        proposed = await this.at(record.proposalVersion!);
      check(
        proposed.sourceDigest === record.sourceDigest,
        "INVALID_REPOSITORY",
        "Proposal changed after review",
      );
      return await this.#compiler.compile(
        await mergeSources(base.sources, current.sources, proposed.sources),
      );
    });
    if (record.authorization?.kind === "operator-evolution") {
      check(
        compiled.sourceDigest === record.sourceDigest,
        "SOURCE_CONFLICT",
        "Evolution admission cannot merge or rebase its frozen sources",
      );
    }
    await this.#authorize({
      authority: current,
      before: current,
      after: compiled,
      authorization: record.authorization,
      decisionAuthorityExercise: request.decisionAuthorityExercise,
      evolutionDecision: request.evolutionDecision,
      author: record.author,
      phase: "acceptance",
    });
    const target = await this.#snapshot(
      compiled,
      [current.version, record.proposalVersion!],
      author,
      `Accept ${record.id}: ${record.reason}`,
      undefined,
      request.command,
    );
    return await this.#exclusive(async () => {
      await this.#recover();
      const latest = await this.proposal(record.id);
      if (latest.status === "accepted") {
        return await this.at(latest.acceptedVersion!);
      }
      check(
        canonical(latest) === canonical(record) &&
          (await this.current()).version === current.version,
        "STALE_REVISION",
        "Proposal or admitted model changed during preparation",
      );
      // Fence before the accepting journal exists: a stale owner must not
      // leave recovery an effect to complete on its behalf.
      await this.#assertFence(request.fence);
      Object.assign(latest, {
        status: "accepting",
        targetVersion: target,
        targetSourceDigest: compiled.sourceDigest,
        acceptanceBaseVersion: current.version,
        decidedBy: author,
        decidedAt: this.#clock.now(),
        ...(request.evolutionDecision
          ? { evolutionDecision: request.evolutionDecision }
          : {}),
        ...(request.decisionAuthorityExercise
          ? { decisionAuthorityExercise: request.decisionAuthorityExercise }
          : {}),
      });
      const admissionRef = `refs/ase/admissions/${latest.id}/${sha(target)}`;
      const pinned = (await this.#git([
        "for-each-ref",
        "--format=%(objectname)",
        admissionRef,
      ])).trim();
      check(
        !pinned || pinned === sha(target),
        "INVALID_REPOSITORY",
        "Admission pin points to another immutable target",
      );
      if (!pinned) await this.#cas(admissionRef, target);
      await this.#save(latest);
      await this.#assertFence(request.fence);
      if (request.command) {
        const command = request.command;
        // HEAD and the command anchor move in one ref transaction: a crash
        // can never leave an accepted effect without its (id, digest) proof.
        await this.#guardedRefUpdate(request.fence, () =>
          this.#git(
            ["update-ref", "--stdin"],
            `start\nupdate ${main} ${sha(target)} ${
              sha(current.version)
            }\ncreate ${commandRef(command.commandId)} ${
              sha(target)
            }\nprepare\ncommit\n`,
          ));
      } else {
        await this.#guardedRefUpdate(
          request.fence,
          () => this.#cas(main, target, current.version),
        );
      }
      latest.status = "accepted";
      latest.acceptedVersion = target;
      await this.#save(latest);
      return await this.at(target);
    });
  }
  async reject(
    input: Parameters<ModelRepositoryPort["reject"]>[0],
  ): Promise<ProposalRecord> {
    const request = structuredClone(input);
    return await this.#exclusive(async () => {
      await this.#recover();
      const record = await this.proposal(request.id);
      check(
        record.status === "proposed" || record.status === "rejected",
        "INVALID_REQUEST",
        "Only pending proposals can be rejected",
      );
      if (record.status === "rejected") return record;
      Object.assign(record, {
        status: "rejected",
        decidedBy: actor(request.author),
        decidedAt: this.#clock.now(),
        ...(request.decisionAuthorityExercise
          ? { decisionAuthorityExercise: request.decisionAuthorityExercise }
          : {}),
        ...(request.reason === undefined
          ? {}
          : { rejectionReason: reasonText(request.reason) }),
      });
      await this.#save(record);
      return record;
    });
  }
  async publishSystemSources(
    sources: Sources,
    expectedVersion: string,
    author: string,
  ): Promise<ModelRevision> {
    const requested = structuredClone(sources);
    const current = await this.current();
    if (canonical(current.sources) === canonical(requested)) return current;
    check(
      current.version === expectedVersion,
      "STALE_REVISION",
      "Admitted model changed before publication",
    );
    const compiled = await this.#pool.run(() =>
      this.#compiler.compile(requested)
    );
    const version = await this.#snapshot(
      compiled,
      [current.version],
      actor(author),
      "Apply validated system model update",
    );
    return await this.#exclusive(async () => {
      await this.#recover();
      check(
        await this.#head() === current.version,
        "STALE_REVISION",
        "Admitted model changed during preparation",
      );
      await this.#cas(main, version, current.version);
      return await this.at(version);
    });
  }
  async updateSystemSources(
    update: (current: ModelRevision) => Sources | Promise<Sources>,
    author: string,
    options: SystemSourcesUpdateOptions = {},
  ): Promise<ModelRevision> {
    const publication = structuredClone(options.publication);
    const context = {
      changeId: publication?.changeId ?? "",
      systemId: publication ? publicationSystemId(publication) : undefined,
    };
    // Scheduling boundary for the pure host pipeline. Today preparation, native
    // compilation and verification run under this lock. Moving this callback to
    // optimistic prepare/replay must retain its exact base and whole receipt;
    // writers and declaration builders need no Git or lock-specific changes.
    try {
      return await this.#exclusive(async () => {
        await this.#recover();
        if (publication) {
          publicationRef(publication.changeId);
          check(
            author === publicationAuthor(publication),
            "INVALID_REQUEST",
            "Publication author differs from receipt",
          );
          const existing = await this.findPublication(publication.changeId);
          if (existing) {
            // A fresh approval has not prepared its edits. Recover them only from
            // an otherwise identical receipt, without calling the updater again.
            const expected = publication.edits.length === 0 && existing.receipt
              ? { ...publication, edits: existing.receipt.edits }
              : publication;
            if (canonical(existing.receipt) !== canonical(expected)) {
              throw new ChangePublicationError(
                "PUBLICATION_RECEIPT_MISMATCH",
                context,
                "Publication receipt differs from existing commit",
              );
            }
            options.publication!.edits = structuredClone(
              existing.receipt!.edits,
            );
            return existing.revision;
          }
        }
        const current = await this.current();
        let sources: Sources;
        let compiled: CompiledModel;
        try {
          sources = structuredClone(await update(structuredClone(current)));
          if (publication) {
            publication.edits = structuredClone(options.publication!.edits);
            assertPublicationSize(publication);
          }
          if (canonical(sources) === canonical(current.sources)) {
            check(
              !publication || publication.type === "candidate-activation",
              "INVALID_REQUEST",
              "Approved publication must change sources",
            );
            await options.verify?.(structuredClone(current));
            return current;
          }
          compiled = await this.#pool.run(() =>
            this.#compiler.compile(sources)
          );
          await options.verify?.(
            structuredClone({ ...compiled, version: current.version }),
          );
        } catch (error) {
          if (!publication) throw error;
          throw publicationFailure(error, context, "refuse");
        }
        const version = await this.#snapshot(
          compiled,
          [current.version],
          actor(author),
          "Apply validated system model update",
          publication,
        );
        if (publication) {
          await this.#git(
            ["update-ref", "--stdin"],
            `start\nupdate ${main} ${sha(version)} ${
              sha(current.version)
            }\ncreate ${publicationRef(publication.changeId)} ${
              sha(version)
            }\nprepare\ncommit\n`,
          );
        } else await this.#cas(main, version, current.version);
        return await this.at(version);
      });
    } catch (error) {
      if (!publication) throw error;
      throw publicationFailure(error, context, "retry");
    }
  }

  /** W3: publish a candidate prepared outside this lock. Under the lock:
   * recover, idempotence by changeId/commandId, fence revalidation, HEAD
   * fence, verified candidate from the descriptor hand-off with rebuild
   * disabled, S/R/K/A bound to the receipt result,
   * fence revalidation again, then HEAD, the publication ref and the command
   * ref move in one ref transaction. A moved HEAD stays a STALE_REVISION
   * repository error so callers re-prepare; the attempt's evidence is never
   * reused on another base. */
  async publishPrepared(input: {
    expectedHeadVersion: string;
    sources: Sources;
    author: string;
    receipt: PreparedPublication;
    descriptor?: BuildDescriptor;
    fence?: PublicationFence;
  }): Promise<ModelRevision> {
    const receipt = structuredClone(input.receipt);
    const changeId = receipt.approval.changeId;
    const context = {
      changeId,
      systemId: publicationSystemId(receipt.approval),
    };
    try {
      return await this.#exclusive(async () => {
        check(
          Boolean(receipt.command) === Boolean(input.fence),
          "INVALID_REQUEST",
          "Queued publication requires both command anchor and publication fence",
        );
        await this.#recover(false);
        publicationRef(changeId);
        check(
          input.author === anyPublicationAuthor(receipt),
          "INVALID_REQUEST",
          "Publication author differs from receipt",
        );
        check(
          receipt.executionBase.repositoryVersion === input.expectedHeadVersion,
          "INVALID_REQUEST",
          "Prepared receipt names another execution base",
        );
        const anchored = receipt.command
          ? await this.findPublicationByCommand(
            receipt.command.commandId,
            false,
          )
          : null;
        const existing = anchored ??
          await this.findPublication(changeId, false);
        if (existing) {
          if (
            receipt.command &&
            (!anchored ||
              anchored.commandDigest !== receipt.command.commandDigest)
          ) {
            throw new ChangePublicationError(
              "PUBLICATION_RECEIPT_MISMATCH",
              context,
              "Published effect lacks this command's atomic digest anchor",
            );
          }
          const stored = existing.receipt;
          if (stored) {
            const same = isPreparedPublication(stored)
              ? canonical(stored.approval) === canonical(receipt.approval) &&
                stored.command?.commandDigest ===
                  receipt.command?.commandDigest &&
                stored.result.sourceDigest === receipt.result.sourceDigest
              : canonical({ ...stored, edits: [] }) ===
                canonical(receipt.approval);
            if (!same) {
              throw new ChangePublicationError(
                "PUBLICATION_RECEIPT_MISMATCH",
                context,
                "Publication receipt differs from existing commit",
              );
            }
          }
          return existing.revision;
        }
        if (
          input.fence && receipt.command &&
          input.fence.commandId !== receipt.command.commandId
        ) {
          throw new ModelRepositoryError(
            "INVALID_REQUEST",
            "Publication fence names another write command",
          );
        }
        await this.#assertFence(input.fence);
        const head = await this.#head();
        check(
          head === input.expectedHeadVersion,
          "STALE_REVISION",
          "Admitted model changed during preparation",
        );
        const current = await this.#atWithBuildPolicy(head, false);
        const sources = structuredClone(input.sources);
        let compiled: CompiledModel;
        try {
          check(
            canonical(sources) !== canonical(current.sources),
            "INVALID_REQUEST",
            "Prepared publication must change sources",
          );
          if (input.descriptor) {
            // W3 hand-off: resolve the bytes verified during preparation.
            // No native compilation happens under this lock. The service
            // revalidates S/R/K/A and materialization compatibility on a hit.
            if (!this.options.buildService) {
              throw new ModelBuildServiceError(
                "BUILD_UNAVAILABLE",
                {
                  reason: "descriptor hand-off requires the W2 build service",
                  artifactDigest: input.descriptor.artifactDigest,
                },
                "Descriptor hand-off is unavailable without the build service",
              );
            }
            const descriptor = input.descriptor;
            const binds = descriptor.repositoryId === this.#identity &&
              descriptor.sourceDigest === receipt.result.sourceDigest &&
              (receipt.result.recipeDigest === undefined ||
                descriptor.recipe.digest === receipt.result.recipeDigest) &&
              (receipt.result.buildKey === undefined ||
                descriptor.buildKey === receipt.result.buildKey) &&
              (receipt.result.artifactDigest === undefined ||
                descriptor.artifactDigest === receipt.result.artifactDigest);
            if (!binds) {
              throw new ChangePublicationError(
                "PUBLICATION_RECEIPT_MISMATCH",
                context,
                "Build hand-off differs from the prepared receipt result",
              );
            }
            compiled =
              (await this.options.buildService.resolve(descriptor, sources, {
                allowRebuild: false,
              })).compiled;
          } else {
            throw new ModelBuildServiceError(
              "BUILD_UNAVAILABLE",
              { reason: "prepared publication has no verified build hand-off" },
              "Prepared publication requires a verified build descriptor",
            );
          }
          check(
            compiled.sourceDigest ===
                receipt.result.sourceDigest &&
              await modelSourceDigest(sources) === receipt.result.sourceDigest,
            "INVALID_REQUEST",
            "Prepared sources differ from the receipt result digest",
          );
        } catch (error) {
          if (
            error instanceof ModelRepositoryError ||
            error instanceof ChangePublicationError ||
            error instanceof ModelBuildServiceError || isFenceLost(error)
          ) throw error;
          throw publicationFailure(error, context, "refuse");
        }
        const version = await this.#snapshot(
          compiled,
          [current.version],
          actor(input.author),
          "Apply validated system model update",
          receipt,
          undefined,
          input.descriptor,
        );
        // Last fence revalidation, still under the lock, before any ref moves.
        await this.#assertFence(input.fence);
        await this.#guardedRefUpdate(input.fence, () =>
          this.#git(
            ["update-ref", "--stdin"],
            `start\nupdate ${main} ${sha(version)} ${
              sha(current.version)
            }\ncreate ${publicationRef(changeId)} ${sha(version)}\n${
              receipt.command
                ? `create ${commandRef(receipt.command.commandId)} ${
                  sha(version)
                }\n`
                : ""
            }prepare\ncommit\n`,
          ));
        return await this.#atWithBuildPolicy(version, false);
      });
    } catch (error) {
      if (
        error instanceof ModelRepositoryError ||
        error instanceof ChangePublicationError ||
        error instanceof ModelBuildServiceError || isFenceLost(error)
      ) throw error;
      throw publicationFailure(error, context, "retry");
    }
  }
}
