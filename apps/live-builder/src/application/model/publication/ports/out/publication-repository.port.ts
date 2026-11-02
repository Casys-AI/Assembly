import type {
  PreparedPublication,
  SourcePublication,
} from "../../../../../domain/model/publication/change.ts";
import type { ModelSources as Sources } from "../../../../../domain/model/value-objects/sources.ts";
import type {
  ModelRevision,
  ModelRevisionHeader,
} from "../../../../../domain/model/records/revision.ts";
import type { BuildDescriptor } from "../../../../../domain/model/value-objects/build.ts";
import type { PublicationFence } from "../../../repository.ts";

/** The repository surface W3 requires (optional port methods made required). */
export interface PublicationRepositoryPort {
  current(): Promise<ModelRevision>;
  at(version: string, signal?: AbortSignal): Promise<ModelRevision>;
  header(version: string, signal?: AbortSignal): Promise<ModelRevisionHeader>;
  headVersion(): Promise<string | null>;
  findPublication(
    changeId: string,
  ): Promise<{ revision: ModelRevision; receipt?: SourcePublication } | null>;
  findPublicationByCommand(
    commandId: string,
  ): Promise<
    {
      revision: ModelRevision;
      receipt?: SourcePublication | PreparedPublication;
      commandDigest?: string;
    } | null
  >;
  publishPrepared(input: {
    expectedHeadVersion: string;
    sources: Sources;
    author: string;
    receipt: PreparedPublication;
    /** Verified build ensured during preparation: the adapter resolves it
     * under the lock instead of compiling natively a second time. */
    descriptor?: BuildDescriptor;
    fence?: PublicationFence;
  }): Promise<ModelRevision>;
}
