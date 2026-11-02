import type { HostEdit } from "../../../../../domain/model/editing/host-edit.ts";
import type { IncarnationInventory } from "../../../../../domain/model/editing/write-command.ts";
import type { ModelSources as Sources } from "../../../../../domain/model/value-objects/sources.ts";
import type { ModelRevision } from "../../../../../domain/model/records/revision.ts";

/** Host edit execution on immutable bases, realized by the source writer. */
export interface HostEditExecutorPort {
  apply(
    base: ModelRevision,
    edits: readonly HostEdit[],
  ): Promise<{ sources: Sources; resolvedEdits: HostEdit[] }>;
  verify(
    candidate: ModelRevision,
    edits: readonly HostEdit[],
    base: ModelRevision,
  ): Promise<void>;
  incarnationInventory(
    base: ModelRevision,
    query: {
      nativeIds: readonly string[];
      qualifiedNames: readonly string[];
    },
  ): Promise<IncarnationInventory>;
}
