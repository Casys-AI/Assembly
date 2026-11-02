import type {
  ModelDiagnosticFacts,
} from "../../../../../domain/model/policies/diagnostics.ts";

export interface ModelDiagnosticsReader {
  read(version?: string): Promise<{
    version: string;
    /** Digest of all model sources, including source positions. */
    digest: string;
    input: ModelDiagnosticFacts | (() => Promise<ModelDiagnosticFacts>);
  }>;
}
