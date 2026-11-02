import type {
  ModelFileLastChange,
  ModelHistory,
  ProposalRecord,
} from "../../../../../domain/model/records/revision.ts";

/** Source history and advisory proposal links consumed by revision queries. */
export interface RevisionReader {
  history(options?: { limit?: number }): Promise<ModelHistory>;
  lastChangeByPath(head: string): Promise<ModelFileLastChange[]>;
  /** Advisory journal read: no writer lock, recovery or snapshot validation.
   * Unreadable dossiers are omitted with a diagnostic. */
  readProposalJournal(): Promise<ProposalRecord[]>;
}
