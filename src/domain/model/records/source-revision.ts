import type { ModelSources as Sources } from "../value-objects/sources.ts";
import type { JsonObject as Element } from "./compiled-model.ts";

export interface SourceRevision {
  version: string;
  sources: Sources;
  elements: Element[];
}
