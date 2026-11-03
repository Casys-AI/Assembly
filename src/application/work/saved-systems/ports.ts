import type {
  ReleasePublicationEvent,
  ReleasePublicationOutcome,
} from "../../../domain/work/release-publication.ts";
import type { ReleaseRetentionAuthorization } from "../../../domain/work/release-retention.ts";
import type {
  ReleaseTagBinding,
  ReleaseTagRejection,
  ReleaseTagSelection,
  SavedSystemTag,
} from "../../../domain/work/release-tags.ts";
import type {
  SavedOperatorManifest,
  SavedOperatorSelection,
  SavedSystemCapture,
  SavedSystemManifest,
  SavedSystemMetadata,
  SavedSystemRecord,
  SavedSystemScope,
  SavedSystemSourceEvidence,
  SavedSystemSourceSelection,
  SavedSystemStatus,
  SavedSystemView,
} from "../../../domain/work/saved-systems.ts";
/** Current selected host compatibility only; no allocation, preparation or grant. */
export interface SavedSystemOpeningReadiness {
  openingAvailability: "ready" | "unavailable";
  openingIssues: readonly string[];
}
export interface SavedSystemOpeningReadinessPort {
  inspect(view: SavedSystemView): Promise<SavedSystemOpeningReadiness>;
}
/** Caller holds the repository writer lock before the bounded current-control
 * fence. This operation creates no SavedSystem intention or execution grant. */
export interface ModelTagMutationPort {
  run(
    authorization: ReleaseRetentionAuthorization,
    operation: (signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
}
export interface SavedSystemStorePort {
  /** Persist a host-resolved immutable source capture under the scope lock. */
  begin(
    input: {
      scope: SavedSystemScope;
      saveKey: string;
      commandDigest: string;
      metadata: SavedSystemMetadata;
      capture: SavedSystemCapture;
      tag?: SavedSystemTag;
      authorization?: ReleaseRetentionAuthorization;
    },
  ): Promise<SavedSystemRecord>;
  /** Serialized with begin: an existing same-command winner always survives.
   * Otherwise this terminal row fences all late requests for the exact key. */
  rejectTag?(
    input: {
      scope: SavedSystemScope;
      saveKey: string;
      commandDigest: string;
      metadata: SavedSystemMetadata;
      capture: SavedSystemCapture;
      tag: ReleaseTagSelection;
      reason?: ReleaseTagRejection["code"];
      authorization?: ReleaseRetentionAuthorization;
    },
  ): Promise<SavedSystemRecord>;
  /** Caller holds the Git writer lock before this short current-control fence.
   * The callback performs only exact create-only CAS/readback, never lock waits. */
  confirmTag?(
    input: {
      scope: SavedSystemScope;
      id: string;
      expectedRevision: number;
      authorization?: ReleaseRetentionAuthorization;
      preparationId?: string;
      ensure(signal?: AbortSignal): Promise<void>;
    },
  ): Promise<SavedSystemRecord>;
  availableTags?(
    scope: SavedSystemScope,
    repositoryId: string,
    names: string[],
  ): Promise<string[]>;
  /** CAS over the immutable selected source capture; runtime movement is independent. */
  finalize(
    input: {
      id: string;
      scope: SavedSystemScope;
      expectedRevision: number;
      capture: SavedSystemCapture;
      authorization?: ReleaseRetentionAuthorization;
      preparationId?: string;
      manifest: SavedSystemManifest;
      digest: string;
      status: "retained" | "incomplete";
      issues: string[];
    },
  ): Promise<SavedSystemRecord>;
  markIncomplete(
    input: {
      id: string;
      scope: SavedSystemScope;
      expectedRevision: number;
      issues: string[];
      preparationId?: string;
      failure?: "technical" | "asset" | "tag";
      authorization?: ReleaseRetentionAuthorization;
    },
  ): Promise<SavedSystemRecord>;
  /** Durable progress under the existing current-authority/scope fence. A new
   * run supersedes earlier interrupted work; stale run/revision returns its winner.
   * No progress record is fabricated for historical rows during reads. */
  progress?(
    input: {
      id: string;
      scope: SavedSystemScope;
      expectedRevision: number;
      runId: string;
      start?: boolean;
      event: Omit<ReleasePublicationEvent, "sequence" | "attempt" | "at">;
      outcome: ReleasePublicationOutcome;
      authorization?: ReleaseRetentionAuthorization;
    },
  ): Promise<SavedSystemRecord>;
  /** Existing exact intention, before capture or any new retention mutation. */
  find?(
    scope: SavedSystemScope,
    saveKey: string,
  ): Promise<SavedSystemRecord | null>;
  list(scope: SavedSystemScope): Promise<SavedSystemRecord[]>;
  get(scope: SavedSystemScope, id: string): Promise<SavedSystemRecord | null>;
}
export interface SavedSystemRegistryPort {
  /** Resolve one locally admitted branch revision and its source-derived closure.
   * Never use operator runtime pins or fall back to a moving head. */
  resolveSource(
    selection: SavedSystemSourceSelection,
    scope: SavedSystemScope,
  ): Promise<SavedSystemCapture>;
  recoverSource?(
    accepted: SavedSystemCapture,
    scope: SavedSystemScope,
  ): Promise<SavedSystemCapture>;
}
export interface SavedSystemAssetsPort {
  /** Exact read-only historical resolution and idempotent durable retention. */
  retain(selection: SavedOperatorSelection): Promise<SavedOperatorManifest>;
  /** Selected retained public tool bytes, with exact model/binding checks. */
  readTool(
    manifest: SavedSystemManifest,
    operatorId: string,
    candidateId: string,
  ): Promise<import("../../../domain/work/candidates.ts").ToolDraft>;
  /** Cold exact read, no rebuild, no HEAD fallback, no invocation. */
  inspect(manifest: SavedSystemManifest): Promise<void>;
}
export interface SavedSystemVisibilityPort {
  /** Current host source scope, independent of active runtime membership.
   * Retained exact identities and current scoped source bindings remain required;
   * neither actor DTO nor Host is human authentication. */
  canRead(
    scope: SavedSystemScope,
    operatorIds: readonly string[],
  ): Promise<boolean>;
}
/** Native facts only. Neither this port nor a Git tag grants model authority. */
export interface ReleaseTagsPort {
  prepare(
    selection: ReleaseTagSelection,
    source: SavedSystemSourceEvidence,
  ): Promise<ReleaseTagBinding>;
  list(source: SavedSystemSourceEvidence): Promise<ReleaseTagBinding[]>;
  inspect(binding: ReleaseTagBinding): Promise<"verified" | "unavailable">;
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
  /** The caller already holds runExclusive. Never overwrite another ref. */
  ensure(
    selection: ReleaseTagSelection,
    binding: ReleaseTagBinding,
    signal?: AbortSignal,
  ): Promise<void>;
}
export type { SavedSystemStatus };
