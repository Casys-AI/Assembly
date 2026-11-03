import type { ValidateShaclShapesInput } from "../../queries/inputs.ts";
import type { ShaclValidationReport } from "../../shapes.ts";

/** W6 consumer port, implemented by the SHACL adapter. Facts come from
 * the existing diagnostics fact projection (`ModelDiagnosticFacts`); the
 * adapter re-projects them as RDF and must not reinterpret rights. */
export interface ModelShapesDiagnostics {
  validateBuild(
    input: ValidateShaclShapesInput,
  ): Promise<ShaclValidationReport>;
}
