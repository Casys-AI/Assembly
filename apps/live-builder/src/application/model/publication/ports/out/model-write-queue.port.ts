import type {
  VersionedModelWriteCommand,
  VersionedModelWriteDossier,
} from "../../write-command-v2.ts";
import type { ModelRevision } from "../../../../../domain/model/records/revision.ts";
import type { RequestSourcePublicationContext } from "./request-source-publication.port.ts";
import type { ScopedSoftwareSourcePublicationContext } from "./scoped-software-source-publication.port.ts";

export type ModelWriteQueueState =
  | "queued"
  | "preparing"
  | "prepared"
  | "publishing"
  | "published"
  | "retryable"
  | "needs-decision"
  | "refused";

export interface ModelWriteQueueEntry {
  readonly command: VersionedModelWriteCommand;
  readonly commandDigest: string;
  readonly dossierDigest: string;
  readonly state: ModelWriteQueueState;
  readonly enqueuedAt: string;
  readonly updatedAt: string;
  readonly attempts: number;
  readonly owner?: string;
  readonly fence: number;
  readonly leaseExpiresAt?: string;
  readonly publishedVersion?: string;
  readonly lastError?: { readonly code: string; readonly message: string };
}

/** Fencing token: every transition must present the current lease. */
export interface WriteLease {
  readonly repositoryId: string;
  readonly commandId: string;
  readonly owner: string;
  readonly fence: number;
  readonly expiresAt: string;
}
export interface AcquiredWrite {
  readonly entry: ModelWriteQueueEntry;
  readonly dossier: VersionedModelWriteDossier;
  readonly lease: WriteLease;
}
export type EnqueueOutcome =
  | { readonly status: "queued"; readonly entry: ModelWriteQueueEntry }
  | { readonly status: "duplicate"; readonly entry: ModelWriteQueueEntry };
export type SettleOutcome =
  | { readonly status: "published"; readonly version: string }
  | {
    readonly status: "retryable" | "needs-decision" | "refused";
    readonly error: { readonly code: string; readonly message: string };
  };

/** Transactional, durable queue store — dedicated to write commands, outside
 * the build cache and outside any Case. Adapters own its atomicity. */
export interface ModelWriteQueuePort {
  /** Same commandId + same digest is a duplicate; same id + other digest
   * throws WRITE_QUEUE_CONFLICT. Beyond the per-repository pending bound,
   * throws WRITE_QUEUE_FULL — never a silent drop. */
  enqueue(dossier: VersionedModelWriteDossier): Promise<EnqueueOutcome>;
  /** FIFO head for one repository, atomically leased with a fresh fence.
   * Null when empty or when another lease is still active for the repository
   * (single owner per repository). */
  acquire(
    repositoryId: string,
    owner: string,
    leaseMs: number,
  ): Promise<AcquiredWrite | null>;
  heartbeat(lease: WriteLease, leaseMs: number): Promise<void>;
  /** Hold the queue's exclusive claim lock from lease validation through the
   * repository's atomic Git CAS. No other owner may claim this command while
   * operation is in flight, even when the lease deadline passes. The adapter
   * renews the lease before releasing the lock. A failed operation releases
   * the lock without acknowledging publication; recovery checks Git first. */
  guardPublication<T>(
    lease: WriteLease,
    leaseMs: number,
    operation: () => Promise<T>,
  ): Promise<T>;
  /** Optional only for legacy compositions: a v2 writer must refuse when
   * these typed same-fence participants are absent. No tx escapes the adapter. */
  guardRequestPublication?(
    lease: WriteLease,
    leaseMs: number,
    context: RequestSourcePublicationContext,
    gitEffect: () => Promise<ModelRevision>,
  ): Promise<ModelRevision>;
  reconcileRequestPublication?(
    lease: WriteLease,
    leaseMs: number,
    context: RequestSourcePublicationContext,
  ): Promise<void>;
  guardScopedSoftwarePublication?(
    lease: WriteLease,
    leaseMs: number,
    context: ScopedSoftwareSourcePublicationContext,
    gitEffect: () => Promise<ModelRevision>,
  ): Promise<ModelRevision>;
  reconcileScopedSoftwarePublication?(
    lease: WriteLease,
    leaseMs: number,
    context: ScopedSoftwareSourcePublicationContext,
  ): Promise<void>;
  transition(lease: WriteLease, to: "prepared" | "publishing"): Promise<void>;
  settle(lease: WriteLease, outcome: SettleOutcome): Promise<void>;
  get(
    repositoryId: string,
    commandId: string,
  ): Promise<ModelWriteQueueEntry | null>;
  /** Read the exact persisted decision and operations for idempotent resume.
   * Adapters validate the dossier and its stored digests before returning it. */
  getDossier?(
    repositoryId: string,
    commandId: string,
  ): Promise<VersionedModelWriteDossier | null>;
  list(repositoryId: string): Promise<ModelWriteQueueEntry[]>;
  /** Expired preparing/prepared/publishing leases return to retryable. */
  recoverExpired(): Promise<number>;
}
