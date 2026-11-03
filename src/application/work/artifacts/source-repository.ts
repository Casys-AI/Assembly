import type { ArtifactSource } from "../../../domain/work/artifacts/source-publication.ts";
import type { ArtifactSourceReference } from "../../../domain/work/artifacts/source-reference.ts";
import type {
  PublicationFence,
  WriteCommandAnchor,
} from "../../model/repository.ts";

export interface ArtifactSourcePublication {
  source: ArtifactSource;
  /** Captured immutable base, never silently replaced with the current head. */
  baseVersion: string;
  command?: WriteCommandAnchor;
  fence?: PublicationFence;
}
export interface ArtifactSourcePublicationReceipt {
  version: 1;
  reference: ArtifactSourceReference;
  baseVersion: string;
  baseSourceDigest: string;
  command?: WriteCommandAnchor;
}
/** Host callback is not serialized into a source intent or receipt. */
export interface ArtifactSourceRetentionOptions {
  assertCurrent?(): Promise<void>;
}
/** Host-bound scope. Retention never advances the admitted model or installs an artifact. */
export interface ArtifactSourceRepositoryPort {
  retain(
    publication: ArtifactSourcePublication,
    options?: ArtifactSourceRetentionOptions,
  ): Promise<ArtifactSourcePublicationReceipt>;
  read(reference: ArtifactSourceReference): Promise<ArtifactSource>;
  findByCommand(
    command: WriteCommandAnchor,
  ): Promise<ArtifactSourcePublicationReceipt | null>;
}
