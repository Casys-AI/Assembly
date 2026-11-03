import { useMemo, useRef } from "preact/hooks";
import {
  type CodeLines,
  codeWindow,
  MAX_SHOWN_LINES,
  textLines,
} from "../../../lib/model/sources/files.ts";

/**
 * The lines of a file that are drawn. The window of a long file stays where it
 * is while the same file is on show: clearing the highlighted line, or
 * highlighting another one inside the window, does not swap the text under the
 * reader. Another file (`key`), or a line outside the window, moves it.
 */
export function useCodeLines(
  /** What file on show this is: the window is kept only for the same one. */
  key: string,
  /** The text, once it is read. */
  text: string | null,
  /** The line the address points at. */
  line: number | null,
): CodeLines | null {
  const all = useMemo(() => text === null ? null : textLines(text), [text]);
  const kept = useRef<{ key: string; first: number }>();
  if (all === null) return null;
  const drawn = codeWindow(
    all,
    line,
    MAX_SHOWN_LINES,
    kept.current?.key === key ? kept.current.first : undefined,
  );
  kept.current = { key, first: drawn.first };
  return drawn;
}
