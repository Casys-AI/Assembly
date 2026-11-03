import type { ArtifactSourceRepositoryPort } from "../../../../work/artifacts/source-repository.ts";
import type { QueuedArtifactSourcePublication } from "../../../../../domain/work/artifacts/source-publication.ts";

export interface ArtifactSourceWritePort {
  readonly scopeId: string;
  readonly repository: ArtifactSourceRepositoryPort;
  /** Must use the exact target's current admitted business authority. A
   * stored proof or source receipt alone never authorizes retention/replay. */
  assertCurrent(publication: QueuedArtifactSourcePublication): Promise<void>;
}
