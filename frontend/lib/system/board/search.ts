import type {
  BoardItem,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";
import { type BoardElement, indexBoard } from "./lookup.ts";
import { systemHref, systemPageFor } from "../../workbench/desk.ts";
import { inheritModelViewContext } from "../../workbench/model-context.ts";

/** Search exactly the elements represented by the board's existing registry. */
export function searchBoard(board: ModelBoard, query: string): BoardElement[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  const index = indexBoard(board);
  const ids: string[] = [];
  const walk = (item: BoardItem) => {
    ids.push(item.id);
    for (const entry of item.ports ?? []) ids.push(entry.id);
    for (const entry of item.steps ?? []) ids.push(entry.id);
    for (const entry of item.clauses ?? []) ids.push(entry.id);
    for (const entry of item.track?.states ?? []) ids.push(entry.id);
    for (const child of item.children ?? []) walk(child);
  };
  for (const column of board.columns) {
    for (const item of column.items) walk(item);
  }
  const found: BoardElement[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const element = index.get(id);
    if (!element || seen.has(element.id)) continue;
    seen.add(element.id);
    if (
      [element.title, element.qname].some((value) =>
        value?.toLocaleLowerCase().includes(term)
      )
    ) {
      found.push(element);
      if (found.length === 12) break;
    }
  }
  return found;
}

export function searchResultHref(
  element: BoardElement,
  version: string | undefined,
  locationSearch: string,
): string {
  return inheritModelViewContext(
    systemHref(systemPageFor(element.home), { select: element.id, version }),
    locationSearch,
  );
}
