import type { ModelBoardReader } from "../../../../application/model/projections/ports/out/model-board-reader.port.ts";
import type { ModelRepositoryPort } from "../../../../application/model/repository.ts";
import type { ModelBoard } from "../../../../domain/model/records/board.ts";
import type { SysmlToolkitAdapter } from "../adapter.ts";
import { ToolkitVersionedReader } from "./versioned-reader.ts";

export { TOOLKIT_PROJECTION_BACKOFF_MS as BOARD_TIMEOUT_BACKOFF_MS } from "./versioned-reader.ts";

/** A board describes the exact source snapshot of an immutable repository commit. */
export class ToolkitModelBoardReader extends ToolkitVersionedReader<ModelBoard>
  implements ModelBoardReader {
  constructor(
    repository: Pick<ModelRepositoryPort, "at">,
    tooling: Pick<SysmlToolkitAdapter, "board">,
    now?: () => number,
  ) {
    super(
      async (version) => tooling.board((await repository.at(version)).sources),
      "board",
      "MODEL_BOARD_TOOLKIT_FAILED",
      now,
    );
  }
}
