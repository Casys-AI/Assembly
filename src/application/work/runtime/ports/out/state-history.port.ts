import type { SystemRuntimeState } from "../../state.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";

/** An immutable accepted state, timestamped when this store observed it. */
export interface StateRevision {
  revision: number;
  recordedAt: string;
  systemId: string;
  catalogRevision: number;
  model?: ModelIdentity;
  eventCount: number;
  label: string;
  agentCount: number;
  activeToolCount: number;
  hasProjection: boolean;
  /** Legacy databases only contain their current state; earlier history is unknown. */
  origin: "commit" | "legacy_backfill";
}

export interface StateHistoryPort {
  /** Accepted revisions in ascending order, including a legacy baseline if any. */
  listRevisions(): Promise<StateRevision[]>;
  loadRevision(revision: number): Promise<SystemRuntimeState | null>;
  /** Latest recorded state at or before a timestamp, breaking ties by revision. */
  loadAt(at: string): Promise<SystemRuntimeState | null>;
}

/** An observed graph projection associated with an accepted local revision. */
export interface ProjectionSnapshot {
  revision: number;
  digest: string;
  graph: unknown;
  recordedAt: string;
}

export interface ProjectionHistoryPort {
  recordProjection(
    revision: number,
    graph: unknown,
    digest: string,
  ): Promise<void>;
  loadProjection(revision: number): Promise<ProjectionSnapshot | null>;
}
