import type { ModelFirstParentInterval } from "../../../../../domain/model/records/revision.ts";

export interface NetworkImpactLineageReader {
  readFirstParentInterval(
    fromVersion: string,
    toVersion: string,
    maxVersions: number,
    signal?: AbortSignal,
  ): Promise<ModelFirstParentInterval>;
}
