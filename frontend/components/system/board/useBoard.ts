import { useEffect, useMemo } from "preact/hooks";
import {
  type BoardApi,
  createBoardApi,
} from "../../../lib/system/board/api.ts";
import {
  type BoardStore,
  createBoardStore,
} from "../../../lib/system/board/store.ts";
import type { ModelLive } from "../../../lib/model/live.ts";
import { useModelLive } from "../../view/useModelLive.ts";

export interface BoardProps {
  /** The board, when the caller owns it; the place reads its own otherwise. */
  board?: BoardStore;
  /** What the place's own board reads from; the host's route when absent. */
  api?: Pick<BoardApi, "read">;
  /** The version the address asks for; none is the admitted head. */
  asked: string | undefined;
  /**
   * Changes when a decision anywhere moves the model: the head is read again.
   * A version named in the address never moves.
   */
  moves: number | undefined;
  /** The host's word on the model, when it moves; the tab's own when absent. */
  live?: ModelLive;
}

/**
 * What the System place lives on: the board of the version the address asks
 * for (the admitted head without one), read when the place opens and again
 * when that version, or the head, changes. The place's own board is closed
 * with it; one handed in is the caller's. The head is also read when the host
 * announces that it moved (an agent's proposal accepted elsewhere, an
 * adoption), at the new commit's address. The pages only draw what the board
 * holds.
 */
export function useBoard(props: BoardProps): BoardStore {
  const store = useMemo(
    () =>
      props.board ?? createBoardStore({ api: props.api ?? createBoardApi() }),
    [props.board],
  );
  useEffect(() => () => {
    if (!props.board) store.dispose();
  }, [store]);
  // The head moves with the decisions made anywhere; a version never does.
  const moves = props.asked === undefined ? props.moves : undefined;
  useEffect(() => {
    void store.open(props.asked);
  }, [store, props.asked, moves]);
  // The decisions made here are known at once (`moves`); the host tells the
  // rest. A board that already holds the announced head reads nothing.
  useModelLive((head) => store.moved(head.version), props.live);
  return store;
}
