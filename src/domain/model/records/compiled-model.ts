/** Immutable compiler output consumed by model repositories. Provider normalization remains versioned separately. */
export type JsonObject = Record<string, unknown>;
import type { ModelSources } from "../value-objects/sources.ts";
export type { ModelSources } from "../value-objects/sources.ts";
export interface CompilerDescriptor {
  name: string;
  version: string;
  format: string;
}
export interface CompiledModel {
  provider?: CompilerDescriptor;
  sources: ModelSources;
  elements: JsonObject[];
  documents: JsonObject[];
  sourceDigest: string;
  /** Informational digest limited to the reduced IR; not a model identity. */
  semanticDigest: string;
  provenanceDigest: string;
  sourceHashes: Record<string, string>;
  engineVersion: string;
}
