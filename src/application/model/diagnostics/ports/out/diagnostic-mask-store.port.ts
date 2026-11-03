import type {
  ModelDiagnosticMask,
  ModelDiagnosticMaskChange,
} from "../../commands/inputs.ts";

/** Instance preferences, deliberately separate from versioned model sources. */
export interface ModelDiagnosticMaskStore {
  list(): Promise<readonly ModelDiagnosticMask[]>;
  set(change: ModelDiagnosticMaskChange): Promise<void>;
}
