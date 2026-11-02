export interface ModelDiagnosticsEvent {
  version: string;
  sourceDigest: string;
  counts: { error: number; warning: number; info: number };
}

/** Advisory broadcast of a revalidated version (SSE in production). */
export type ModelDiagnosticsEmitter = (
  event: "diagnostics",
  value: ModelDiagnosticsEvent,
) => void;

/** Post-publication revalidation trigger for one completed version. */
export type ModelDiagnosticsRevalidator = (
  version: string,
) => Promise<void>;
