import type { ModelSources as Sources } from "../../domain/model/value-objects/sources.ts";
import type { SourceRevision } from "../../domain/model/records/source-revision.ts";
import type {
  ModelSourceProposalStatus,
  PublishedModelRevision,
} from "../../domain/work/dialogue.ts";
import type { SourcePublication } from "../../domain/model/publication/change.ts";
import type { ModelProposalAuthorization } from "../../domain/governance/records/model-edit-authorization.ts";
import type { SystemSourcesUpdateOptions } from "./repository.ts";

export interface SourceRepository {
  initialize(sources: Sources): Promise<SourceRevision>;
  current(): Promise<SourceRevision>;
  headVersion?(): Promise<string | null>;
  at(version: string): Promise<SourceRevision>;
  listProposals?(): Promise<
    readonly (ModelSourceProposalStatus & { author: string })[]
  >;
  history?(options?: { limit?: number }): Promise<{
    headVersion: string;
    truncated: boolean;
    commits: readonly Pick<
      PublishedModelRevision,
      "version" | "sourceDigest" | "author" | "createdAt"
    >[];
  }>;
  propose(
    input: {
      baseVersion: string;
      sources: Sources;
      author: string;
      reason: string;
      addresses?:
        import("../../domain/model/value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
      authorization?: ModelProposalAuthorization;
    },
  ): Promise<{ id: string; baseVersion: string; status: string }>;
  /** Pure source transformation, once under the repository's shared writer lock. */
  updateSystemSources(
    update: (current: SourceRevision) => Sources | Promise<Sources>,
    author: string,
    options?: SystemSourcesUpdateOptions,
  ): Promise<SourceRevision>;
  findPublication(
    changeId: string,
  ): Promise<{ revision: SourceRevision; receipt?: SourcePublication } | null>;
}
