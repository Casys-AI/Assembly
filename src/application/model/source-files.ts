import type { ModelSources } from "../../domain/model/value-objects/sources.ts";

export type ModelSourceTemplate =
  | "configuration-reviewer.sysml"
  | "configuration-reviewer-views.sysml"
  | "configuration-reviewed-promotion.sysml";

/** Source bundles and reviewer templates read by source-model orchestration. */
export interface ModelSourceFilesPort {
  initialSources(
    options?: { information?: boolean },
  ): Promise<ModelSources>;
  template(name: ModelSourceTemplate): Promise<string>;
}
