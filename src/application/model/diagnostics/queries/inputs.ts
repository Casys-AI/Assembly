import type {
  ModelDiagnosticFacts,
} from "../../../../domain/model/policies/diagnostics.ts";
import type { BuildRef } from "../../../../domain/model/value-objects/element-ref.ts";
import type { ShaclEngineOptions } from "../shapes.ts";

export interface ValidateShaclShapesInput {
  readonly build: BuildRef;
  readonly facts: ModelDiagnosticFacts;
  readonly options?: ShaclEngineOptions;
}
