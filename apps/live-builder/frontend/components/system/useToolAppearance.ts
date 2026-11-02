import { useEffect, useRef, useState } from "preact/hooks";
import type { ModelBoard } from "../../../src/domain/model/records/board.ts";
import {
  exploreToolCardIds,
  exploreToolOccurrences,
} from "../../lib/system/views/explore.ts";

/** A quiet indication lasts long enough to notice, without moving a card. */
export const TOOL_APPEARANCE_MS = 2_400;
const NONE: ReadonlySet<string> = new Set();
export interface AppearanceTimer {
  /** Schedule once and return the cleanup of that exact scheduled callback. */
  after(callback: () => void, delay: number): () => void;
}
const browserTimer: AppearanceTimer = {
  after(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

/**
 * Compare consecutive current boards. Opening Explore, renaming an element,
 * or returning from a historical view establishes a baseline without a flash.
 * The CSS keeps the same static indication when reduced motion is requested.
 */
export function useToolAppearance(
  board: ModelBoard,
  historical: boolean,
  clock: AppearanceTimer = browserTimer,
  delay: number = TOOL_APPEARANCE_MS,
) {
  const previous = useRef<ReadonlySet<string> | null>(null);
  const [appearing, setAppearing] = useState<
    {
      board: ModelBoard;
      ids: ReadonlySet<string>;
    } | null
  >(null);
  useEffect(() => {
    if (historical) {
      previous.current = null;
      setAppearing(null);
      return;
    }
    const occurrences = exploreToolOccurrences(board);
    const before = previous.current;
    previous.current = new Set(occurrences.values());
    const added = new Set(
      before
        ? [...occurrences].filter(([, identity]) => !before.has(identity))
          .map(([id]) => id)
        : [],
    );
    const ids = exploreToolCardIds(board, added);
    if (ids.size === 0) {
      setAppearing(null);
      return;
    }
    const next = { board, ids };
    setAppearing(next);
    const cancel = clock.after(() => {
      setAppearing((current) => current === next ? null : current);
    }, delay);
    return cancel;
  }, [board, historical, clock, delay]);
  // A changed address/board never draws the previous board's transient state.
  return !historical && appearing?.board === board ? appearing.ids : NONE;
}
