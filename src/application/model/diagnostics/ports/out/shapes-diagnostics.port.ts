import type { ValidateShaclShapesInput } from "../../queries/inputs.ts";
import type { ShaclValidationReport } from "../../shapes.ts";

/** Advisory constraint validation on a leased complete model graph. Compiler
 * associations select focus nodes; facts retain source mapping and TS oracle. */
export interface ModelShapesDiagnostics {
  validateBuild(
    input: ValidateShaclShapesInput,
  ): Promise<ShaclValidationReport>;
}
