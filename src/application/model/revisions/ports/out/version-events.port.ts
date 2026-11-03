import type {
  ModelRevisionId,
} from "../../../../../domain/shared-kernel/revision-id.ts";
import type { ModelRepositoryPort } from "../../../repository.ts";

export interface ModelVersionEvent {
  head: ModelRevisionId;
  sourceDigest: string;
  proposals: { pending: number; digest: string };
  /** Attention count for `head`, present only when it was already computed
   * for that exact version when the event was built. Absent never means
   * zero: the badge reads /api/model/attention instead. Building the event
   * never waits for the attention computation (the matrix takes seconds at
   * cold start); a warm is started in the background and a follow-up event
   * carrying the count is published once it lands. */
  attention?: { count: number };
}

/** Advisory broadcast of the admitted head (SSE in production). */
export type ModelVersionEventEmitter = (
  event: "model-version",
  value: ModelVersionEvent,
) => void;

/** Already-computed attention counts, by immutable version. */
export interface ModelVersionAttentionPort {
  peekCount(version: string): number | undefined;
  warm(version: string): Promise<void>;
}

/** Admitted-head and proposal-journal reads behind version events. */
export type ModelVersionEventSource =
  & Pick<
    ModelRepositoryPort,
    "current" | "readProposalJournal"
  >
  & Partial<Pick<ModelRepositoryPort, "headVersion" | "header">>;
