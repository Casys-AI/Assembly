import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import { type BoardApi, type BoardProblem, boardProblem } from "./api.ts";
import {
  createVersionedStore,
  type VersionedState,
  type VersionedStore,
} from "../../model/versioned-store.ts";

/**
 * What the System pages hold of the board: the one they are drawn from, the
 * commit it describes, whether it is being read, and why the last read failed
 * (see `VersionedState`). A board is the board of one version: it is never
 * shown for another.
 */
export type BoardState = VersionedState<"board", ModelBoard, BoardProblem>;

export type BoardStore = VersionedStore<"board", ModelBoard, BoardProblem>;

export function createBoardStore(options: {
  api: Pick<BoardApi, "read">;
}): BoardStore {
  return createVersionedStore({
    key: "board",
    read: async (asked, signal) => {
      const { board, version } = await options.api.read(asked, signal);
      return { value: board, version };
    },
    same: (kept, answer) => kept.meta.digest === answer.meta.digest,
    problem: boardProblem,
  });
}
