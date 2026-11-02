import type { CompiledModel } from "../../../../../domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../../../../domain/model/value-objects/sources.ts";
import type { BuildRecipeInputs } from "../../../../../domain/model/value-objects/build.ts";

/** Pipeline identity inputs for recipe R; the digest itself lives in domain. */
export type ModelCompilerRecipe = BuildRecipeInputs;

/** Builds-owned compilation contract under the exact recipe R. */
export interface ModelCompiler {
  compile(sources: Sources): Promise<CompiledModel>;
  recipe(): Promise<ModelCompilerRecipe>;
}
