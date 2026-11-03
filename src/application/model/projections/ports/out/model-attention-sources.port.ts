import type { AuthorityMatrix } from "../../../../../domain/governance/records/authority-matrix.ts";
import type { ModelBoard } from "../../../../../domain/model/records/board.ts";
import type { ModelDiagnosticsResult } from "../../../diagnostics/service.ts";

/** The existing versioned services attention is composed from. Their own
 * caches are reused as-is; no projection is recomputed here. */
export interface ModelAttentionSources {
  matrix: { read(version: string): Promise<AuthorityMatrix> };
  board: { read(version: string): Promise<ModelBoard> };
  diagnostics: { list(version?: string): Promise<ModelDiagnosticsResult> };
}
