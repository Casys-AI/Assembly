import type { AuthorityExercise } from "../../../../../domain/governance/authority.ts";
import type { EvolutionAuthorityExercise } from "../../../../../domain/model/evolution/policy.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../../../domain/model/records/revision.ts";
import type {
  PublicationFence,
  WriteCommandAnchor,
} from "../../../repository.ts";

/** Repository surface the worker needs beyond the publication service. */
export interface WriteWorkerRepositoryPort {
  current(): Promise<ModelRevision>;
  proposal(id: string): Promise<ProposalRecord>;
  accept(input: {
    id: string;
    expectedVersion: string;
    author: string;
    decisionAuthorityExercise?: AuthorityExercise;
    evolutionDecision?: EvolutionAuthorityExercise;
    command?: WriteCommandAnchor;
    fence?: PublicationFence;
  }): Promise<ModelRevision>;
  findPublicationByCommand(
    commandId: string,
  ): Promise<
    | { revision: ModelRevision; receipt?: unknown; commandDigest?: string }
    | null
  >;
}
