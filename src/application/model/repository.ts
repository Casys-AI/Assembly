import type { EvolutionAuthorityExercise } from "../../domain/model/evolution/policy.ts";
import type {
  AnySourcePublication,
  PreparedPublication,
  SourcePublication,
} from "../../domain/model/publication/change.ts";
import type { ModelProposalAuthorization } from "../../domain/governance/records/model-edit-authorization.ts";
import type { AuthorityExercise } from "../../domain/governance/authority.ts";
/** Versioned model storage contract, independent of persistence implementation. */
import type { ModelSources as Sources } from "../../domain/model/value-objects/sources.ts";
import type { GraphDiff } from "../../domain/model/records/graph-diff.ts";
import type { BuildDescriptor } from "../../domain/model/value-objects/build.ts";
import type {
  ModelChangedFile,
  ModelRevision,
  ModelRevisionHeader,
  ProposalRecord,
} from "../../domain/model/records/revision.ts";
import type { RevisionReader } from "./revisions/ports/out/revision-reader.port.ts";

export interface SystemSourcesUpdateOptions {
  /** The updater prepares a candidate from its immutable current revision and
   * fills the receipt. Source planning/application/verification do not depend on
   * repository locks; this boundary owns scheduling, compilation and publication.
   * A future optimistic publisher may move preparation and replay locally here.
   */
  publication?: SourcePublication;
  /** Compiled candidate with its parent version; no commit exists yet. */
  verify?: (compiled: ModelRevision) => void | Promise<void>;
}
/** Serializable fencing token of the durable write queue (W4). The adapter
 * revalidates it while holding the repository lock, immediately before the
 * CAS, through its injected fence port; a stale owner can never publish. */
export interface PublicationFence {
  readonly repositoryId: string;
  readonly commandId: string;
  readonly owner: string;
  readonly fence: number;
  readonly expiresAt: string;
}
/** Durable write-command identity anchored atomically with HEAD (W4). */
export interface WriteCommandAnchor {
  readonly commandId: string;
  readonly commandDigest: string;
}

export class ModelRepositoryError extends Error {
  constructor(
    readonly code:
      | "STALE_REVISION"
      | "SOURCE_CONFLICT"
      | "INVALID_REPOSITORY"
      | "NOT_FOUND"
      | "INVALID_REQUEST"
      | "UPSTREAM_FAILURE"
      | "EDIT_SCOPE_DENIED",
    message: string,
  ) {
    super(message);
    this.name = "ModelRepositoryError";
  }
}

export interface ModelRepositoryPort extends RevisionReader {
  initialize(sources: Sources): Promise<ModelRevision>;
  current(): Promise<ModelRevision>;
  at(version: string, signal?: AbortSignal): Promise<ModelRevision>;
  /** Source-only read; compiler artifact integrity remains the duty of at(). */
  header(
    version: string,
    signal?: AbortSignal,
  ): Promise<ModelRevisionHeader>;
  changedFiles(version: string): Promise<ModelChangedFile[]>;
  graphDiff(
    fromVersion: string | null,
    toVersion: string,
    options?: { limit?: number },
  ): Promise<GraphDiff>;
  propose(
    input: {
      baseVersion: string;
      sources: Sources;
      author: string;
      reason: string;
      addresses?:
        import("../../domain/model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
      authorization?: ModelProposalAuthorization;
    },
  ): Promise<ProposalRecord>;
  proposal(id: string): Promise<ProposalRecord>;
  listProposals(): Promise<ProposalRecord[]>;
  accept(
    input: {
      id: string;
      expectedVersion: string;
      author: string;
      decisionAuthorityExercise?: AuthorityExercise;
      evolutionDecision?: EvolutionAuthorityExercise;
      /** W4: written into the acceptance commit and anchored with HEAD in
       * one ref transaction. Absent on the direct (non-queued) path. */
      command?: WriteCommandAnchor;
      fence?: PublicationFence;
    },
  ): Promise<ModelRevision>;
  reject(
    input: {
      id: string;
      author: string;
      reason?: string;
      decisionAuthorityExercise?: AuthorityExercise;
    },
  ): Promise<ProposalRecord>;
  publishSystemSources(
    sources: Sources,
    expectedVersion: string,
    author: string,
  ): Promise<ModelRevision>;
  updateSystemSources(
    update: (current: ModelRevision) => Sources | Promise<Sources>,
    author: string,
    options?: SystemSourcesUpdateOptions,
  ): Promise<ModelRevision>;
  findPublication(
    changeId: string,
  ): Promise<{ revision: ModelRevision; receipt?: SourcePublication } | null>;
  /** Exact persisted descriptor; legacy snapshots have unknown recipe identity. */
  descriptorAt?(
    version: string,
    signal?: AbortSignal,
  ): Promise<BuildDescriptor | null>;
  reachableArtifactDigests?(): Promise<Set<string>>;
  /** Cheap HEAD fence read; null before initialization. Optional (W3/W4). */
  headVersion?(): Promise<string | null>;
  /** Lookup by durable write-command anchor (W4). Covers every command kind,
   * including accept-proposal, which `findPublication` does not index. */
  findPublicationByCommand?(
    commandId: string,
  ): Promise<
    {
      revision: ModelRevision;
      receipt?: AnySourcePublication;
      /** Command digest bound in the anchored commit (v2 trailer or the
       * accept-proposal command trailer), when the commit carries one. */
      commandDigest?: string;
    } | null
  >;
  /** Publish a preparation completed outside the repository lock (W3).
   * Serializable input only — no updater/verifier closure. The adapter, under
   * its lock, recovers, checks idempotence by changeId/commandId, requires
   * HEAD == expectedHeadVersion, obtains the verified compiled candidate
   * without a second native compilation (resolving `descriptor` through the
   * build service when supplied, otherwise compiling the exact sources),
   * requires S/R/K/A to equal the receipt result, then CAS-publishes HEAD,
   * the publication ref and the command ref atomically. When `fence` is
   * supplied it is revalidated under the lock before the CAS. Candidate
   * scope and authority verification happened during preparation. */
  publishPrepared?(input: {
    expectedHeadVersion: string;
    sources: Sources;
    author: string;
    receipt: PreparedPublication;
    /** Verified build hand-off from preparation (`ModelBuildService.ensure`). */
    descriptor?: BuildDescriptor;
    fence?: PublicationFence;
  }): Promise<ModelRevision>;
  /** Index an already-published revision under its write command (W4).
   * Lookup only; anchoring never activates or authorizes anything. */
  anchorCommandPublication?(input: {
    commandId: string;
    version: string;
  }): Promise<void>;
}
