import type { SourcePublication } from "../../../domain/model/publication/change.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { VersionedModelWriteDossier } from "./write-command-v2.ts";
import type { RequestModelWriteDestination } from "../../../domain/model/editing/request-write-destination.ts";

/** Producer boundary. Commands are persisted before any publication begins. */
export interface ModelWriteSubmissionPort {
  readonly repositoryId: string;
  recipeDigest(): Promise<string>;
  publish(dossier: VersionedModelWriteDossier): Promise<ModelRevision>;
  /** Resume the existing immutable dossier without regenerating operations. */
  resume(
    commandId: string,
    expectedApproval?: SourcePublication,
    expectedDestination?: RequestModelWriteDestination,
  ): Promise<ModelRevision | null>;
}
