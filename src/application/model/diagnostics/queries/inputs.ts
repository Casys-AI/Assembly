import type {
  ModelDiagnosticFacts,
} from "../../../../domain/model/policies/diagnostics.ts";
import type {
  BuildRef,
  ProjectionRef,
} from "../../../../domain/model/value-objects/element-ref.ts";
import type { ShaclEngineOptions } from "../shapes.ts";

import type {
  SemanticQueryLimits,
  SemanticQueryResult,
} from "../../semantic/queries/inputs.ts";

/** A leased read of the exact complete native projection. */
export interface ShaclGraphRead {
  readonly build: BuildRef;
  readonly projection?: ProjectionRef;
  query(
    sparql: string,
    limits?: Partial<SemanticQueryLimits>,
  ): Promise<SemanticQueryResult>;
}

export interface ValidateShaclShapesInput {
  readonly build: BuildRef;
  readonly facts: ModelDiagnosticFacts;
  readonly graph: ShaclGraphRead;
  readonly options?: ShaclEngineOptions;
}
