import type {
  ModelOperationJournal,
  ModelWriteDossier,
} from "../../../../domain/model/editing/write-command.ts";
import type {
  PreparedPublication,
  SourcePublication,
} from "../../../../domain/model/publication/change.ts";
import type { ModelSources as Sources } from "../../../../domain/model/value-objects/sources.ts";
import type { BuildDescriptor } from "../../../../domain/model/value-objects/build.ts";
import type { Candidate } from "../../../../domain/work/candidates.ts";
import type {
  PendingChange,
} from "../../../../domain/governance/records/pending-change.ts";
import type { PublicationFence } from "../../repository.ts";

export interface PreparePublicationInput {
  readonly approval: SourcePublication;
  readonly journal: ModelOperationJournal;
  readonly command?: {
    readonly commandId: string;
    readonly commandDigest: string;
  };
  /** When set (queued commands), a different current recipe needs a decision:
   * never a silent recipe swap under the same approval. */
  readonly expectedRecipeDigest?: string;
  /** Durable decision record (queued approved-change dossiers). */
  readonly change?: PendingChange;
  readonly activationCandidate?: Candidate;
}

export interface PublishModelInput {
  readonly prepared: PreparedPublication;
  readonly candidateSources: Sources;
  readonly handOff?: {
    readonly descriptor?: BuildDescriptor;
    readonly fence?: PublicationFence;
  };
}

export interface SubmitModelWriteInput {
  readonly dossier: ModelWriteDossier;
}

export interface ProcessQueuedWriteInput {
  readonly repositoryId: string;
}
