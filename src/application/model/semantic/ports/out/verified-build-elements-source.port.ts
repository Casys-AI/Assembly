import type { JsonObject } from "../../../../../domain/model/records/compiled-model.ts";
import type { BuildRef } from "../../../../../domain/model/value-objects/element-ref.ts";

/** W2 raccord: verified `A.elements` for a build. The coordinator wires
 * `ModelBuildService.resolve` here; this module never imports the KV
 * store or Git. `libraryNativeIds` names the normative-library elements
 * (known from Toolkit rows, never guessed from names). */
export interface VerifiedBuildElementsSource {
  verifiedElements(build: BuildRef): Promise<{
    readonly elements: readonly JsonObject[];
    readonly libraryNativeIds: readonly string[];
  }>;
}
