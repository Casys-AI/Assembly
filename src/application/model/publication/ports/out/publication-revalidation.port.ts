import type { HostEdit } from "../../../../../domain/model/editing/host-edit.ts";
import type { ModelRevision } from "../../../../../domain/model/records/revision.ts";
import type {
  RevalidationEvidence,
  SourcePublication,
} from "../../../../../domain/model/publication/change.ts";
import type { Candidate } from "../../../../../domain/work/records/candidates.ts";
import type {
  PendingChange,
} from "../../../../../domain/governance/records/pending-change.ts";

/** Scope/authority re-check on the execution base. Implementations throw
 * `ModelPublicationError` (NEEDS_DECISION or REFUSED) when validity cannot be
 * proven; any other error propagates as infrastructure failure. */
export interface PublicationRevalidationPort {
  revalidate(input: {
    approval: SourcePublication;
    executionBase: ModelRevision;
    candidate: ModelRevision;
    edits: readonly HostEdit[];
    /** Durable decision record of an approved-change command, when the
     * caller holds one (queued dossiers always do). Without it an
     * approved-change revalidation cannot be proven. */
    change?: PendingChange;
    activationCandidate?: Candidate;
  }): Promise<RevalidationEvidence>;
}
