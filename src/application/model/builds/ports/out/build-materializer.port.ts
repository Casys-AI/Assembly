import type {
  CompiledModel,
  CompilerDescriptor,
  JsonObject,
} from "../../../../../domain/model/records/compiled-model.ts";
import type { BuildDescriptor } from "../../../../../domain/model/value-objects/build.ts";
import type { ModelSources } from "../../../../../domain/model/value-objects/sources.ts";

export interface BuildArtifactPayload {
  readonly v: number;
  readonly provider?: CompilerDescriptor;
  readonly engineVersion: string;
  readonly elements: JsonObject[];
}

/** Turns verified artifact bytes back into a CompiledModel (adapter-owned
 * IR materialization). Throwing marks the bytes incompatible. */
export interface BuildMaterializer {
  materialize(input: {
    artifact: BuildArtifactPayload;
    sources: ModelSources;
    descriptor: BuildDescriptor;
  }): Promise<CompiledModel>;
}
