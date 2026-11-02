import type { ModelBoardService } from "../../../../application/model/projections/board.ts";
import { createVersionedModelHandler } from "../versioning/handler.ts";

type BoardService = Pick<ModelBoardService, "read">;

/** Immutable commit reads are cacheable; an optional moving head is no-store. */
export function createModelBoardHandler(
  service: BoardService,
  head?: () => Promise<string>,
) {
  return createVersionedModelHandler({
    path: "/api/model/board",
    name: "board",
    failureCode: "MODEL_BOARD_FAILED",
    read: (version) => service.read(version),
    digest: (board) => board.meta.digest,
    head,
  });
}
