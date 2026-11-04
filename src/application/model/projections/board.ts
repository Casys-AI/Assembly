import { VersionedReadService } from "./versioned-read.ts";
import type { ModelBoardReader } from "./ports/out/model-board-reader.port.ts";
import { parseModelEditGrants } from "../../../domain/governance/model-access/model-edit-policy.ts";
import type {
  BoardDiagnostic,
  BoardGrant,
  ModelBoard,
} from "../../../domain/model/records/board.ts";

/** Projectors use the authorization parser; invalid display data is a finding. */
export function readBoardGrants(
  value: string,
  context: Record<string, unknown>,
): {
  grants: readonly BoardGrant[];
  diagnostics: BoardDiagnostic[];
} {
  try {
    return {
      grants: Object.freeze(
        parseModelEditGrants(value).map((grant) =>
          Object.freeze({
            ...grant,
            qualifiedRoots: Object.freeze(grant.qualifiedRoots),
          })
        ),
      ),
      diagnostics: [],
    };
  } catch {
    return {
      grants: [],
      diagnostics: [{
        code: "INVALID_MODEL_EDIT_GRANTS",
        severity: "error",
        context,
        recovery:
          "Provide canonical model edit grants with file and qualifiedRoots.",
      }],
    };
  }
}

/** Board cache keyed by commit. Concurrent reads share one computation, a
 * failure evicts its entry so the next read retries, and the table holds at
 * most 16 commits, evicting the least recently read. Boards are immutable. */
export class ModelBoardService extends VersionedReadService<ModelBoard> {
  constructor(reader: ModelBoardReader) {
    super(reader, 16);
  }
}
