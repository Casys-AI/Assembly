import type { BoardItem } from "../../../../src/domain/model/records/board.ts";
import { grouped } from "./grouped.ts";

/**
 * Twins: the same thing declared in several units (a tool every agent has, a
 * flow each unit follows). Whether two items are twins is a fact about the
 * board, not about a page: every page that stands twins for one element asks
 * here. Pure.
 */

/** What the model puts an item under (a package, a facet), as a heading. */
export const groupTitle = (item: BoardItem): string =>
  (item.group ?? []).map((entry) => entry.title).join(" · ");

/**
 * Items are twins when nothing a person reads tells them apart: the same kind,
 * name, type, heading, summary, values, steps and accesses.
 */
export const twinKey = (item: BoardItem): string =>
  JSON.stringify([
    item.kind,
    item.keyword,
    item.title,
    item.type?.qname ?? "",
    groupTitle(item),
    item.summary ?? "",
    (item.values ?? []).map((entry) => [entry.name, entry.value]),
    (item.steps ?? []).map((step) => [step.kind, step.title]),
    (item.access ?? []).map((access) => access.title),
  ]);

/**
 * The items in sets of twins, in the order each set first appears, each set
 * in the order of its items. A page that draws more than `twinKey` compares
 * gives its own `key`, which should start from it.
 */
export function twinsOf(
  items: readonly BoardItem[],
  key: (item: BoardItem) => string = twinKey,
): BoardItem[][] {
  return grouped(items, key).map(([, twins]) => twins);
}
