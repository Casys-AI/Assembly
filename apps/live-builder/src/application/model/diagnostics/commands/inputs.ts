export interface ModelDiagnosticMask {
  code: string;
  /** Absent or null applies to this code throughout the model. */
  elementId?: string | null;
}
export interface ModelDiagnosticMaskChange extends ModelDiagnosticMask {
  masked: boolean;
}
