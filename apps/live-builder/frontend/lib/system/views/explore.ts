import type {
  BoardColumnId,
  BoardItem,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";
import type {
  AgentConversation,
  OperatorTool,
} from "../../../../src/domain/work/records/conversations.ts";
import { type BoardElement, indexBoard } from "../board/lookup.ts";
import { listing } from "../board/words.ts";
import { grouped } from "./grouped.ts";
import { groupTitle, twinsOf } from "./twins.ts";
import type { CandidateRead } from "../tools/candidates.ts";
import { operatorToolKey } from "../tools/decisions.ts";
import { sameSysmlQualifiedName } from "../../../../src/domain/model/value-objects/sysml-qualified-name.ts";
import { productNameVariants } from "../../../../src/domain/model/sysml-product-names.ts";

/**
 * What System > Explore lays out: the board's columns that hold something,
 * each a quiet list of cards. The same element declared in several units (a
 * tool every agent has) is one card marked with how many; cards are grouped
 * by what they are declared under, else by the unit that holds them. Pure.
 */

/** One card: an item, and its twins, the same item declared in other units. */
export interface ExploreCard {
  /** The ids of the item and of its twins, the item's first. */
  ids: readonly string[];
  item: BoardItem;
  /** The units the twins belong to, in order; empty for what no unit holds. */
  scopes: readonly string[];
}

export interface ExploreGroup {
  /** Empty when the cards need no heading. */
  label: string;
  cards: readonly ExploreCard[];
}

export interface ExploreModel {
  /** How many units the model has: a card in each is "in every system". */
  units: number;
  columns: readonly ExploreColumn[];
}

export interface ExploreColumn {
  id: BoardColumnId;
  title: string;
  /** How many items the column holds before twins are counted once. */
  items: number;
  groups: readonly ExploreGroup[];
}

export type ExploreRosterEntry = Pick<
  AgentConversation,
  "agentId" | "nativeId"
>;

/** One runtime observation of one occurrence, never a status shared by its twins. */
export interface ExploreToolState {
  key: string;
  occurrence: string;
  tool: OperatorTool;
}

/** The projector keeps published catalogue parts in their unit's structure. */
function modelToolOccurrence(
  item: Pick<BoardElement, "kind" | "keyword" | "type">,
): boolean {
  return item.kind === "tool" || item.kind === "machine" &&
      item.keyword === "part" && Boolean(
        item.type?.qname &&
          productNameVariants("AssemblyLiveBuilder::ToolCandidate").some(
            (name) => sameSysmlQualifiedName(item.type!.qname, name),
          ),
      );
}

/**
 * A candidate belongs on a model card only when both its native binding and
 * its exact operator resolve to that occurrence's unit. Names play no part.
 */
export function linkedExploreTools(
  board: ModelBoard,
  card: ExploreCard,
  read: CandidateRead | undefined,
  roster: readonly ExploreRosterEntry[],
): ExploreToolState[] {
  if (!read?.catalogue) return [];
  const index = indexBoard(board);
  const out: ExploreToolState[] = [];
  for (const tool of read.catalogue.tools) {
    const native = tool.candidate.binding?.elementId;
    if (!native?.trim()) continue;
    const occurrence = index.resolve(native);
    const item = occurrence && index.get(occurrence);
    if (
      !occurrence || !item || item.element !== native ||
      !modelToolOccurrence(item) ||
      !card.ids.some((id) => index.within(occurrence, id))
    ) continue;
    const unit = index.unitOf(occurrence);
    if (!unit) continue;
    const owners = roster.filter((entry) => entry.agentId === tool.agentId);
    // An absent or ambiguous owner never borrows a unit from another operator.
    if (owners.length !== 1 || index.unitOf(owners[0].nativeId) !== unit) {
      continue;
    }
    out.push({
      key: operatorToolKey(tool),
      occurrence,
      tool,
    });
  }
  return out;
}

/** Stable native identities of contracts and published candidates, including nested parts. */
export function exploreToolOccurrences(
  board: ModelBoard,
): ReadonlyMap<string, string> {
  const index = indexBoard(board);
  const out = new Map<string, string>();
  const visit = (items: readonly BoardItem[]) => {
    for (const item of items) {
      if (modelToolOccurrence(item)) {
        const unit = index.unitOf(item.id);
        const owner = unit ? index.get(unit)?.element ?? unit : "";
        out.set(item.id, JSON.stringify([owner, item.element]));
      }
      if (item.children) visit(item.children);
    }
  };
  for (const column of board.columns) visit(column.items);
  return out;
}

/** Light the existing Explore card that actually contains each new occurrence. */
export function exploreToolCardIds(
  board: ModelBoard,
  occurrences: ReadonlySet<string>,
): ReadonlySet<string> {
  const index = indexBoard(board);
  return new Set(
    board.columns.flatMap((column) =>
      column.items.filter((item) =>
        [...occurrences].some((id) => index.within(id, item.id))
      ).map((item) => item.id)
    ),
  );
}

function cardsOf(
  column: BoardColumnId,
  items: readonly BoardItem[],
): ExploreCard[] {
  // Each unit is its own card, whatever it resembles.
  const sets = column === "team" ? items.map((item) => [item]) : twinsOf(items);
  return sets.map((set) => ({
    ids: set.map((item) => item.id),
    item: set[0],
    scopes: set.flatMap((item) => item.scope ? [item.scope] : []),
  }));
}

/**
 * The columns of the board that hold something, in the board's order.
 * `unitNames` says how units are called (an id that is none is left out): it
 * names the units a card is declared in.
 */
export function exploreOf(
  board: ModelBoard,
  unitNames: (ids: readonly string[]) => readonly string[],
): ExploreModel {
  const units = indexBoard(board).units.length;
  const columns = board.columns.filter((column) => column.items.length > 0)
    .map((column) => {
      const label = (card: ExploreCard): string => {
        const named = groupTitle(card.item);
        if (named) return named;
        const scopes = [...new Set(card.scopes)];
        if (scopes.length > 1 && scopes.length === units) {
          return "In every system";
        }
        const names = unitNames(scopes);
        if (scopes.length > 0) {
          return names.length > 0 ? `in ${listing(names)}` : "";
        }
        return column.id === "team" ? "" : "Shared definitions";
      };
      return {
        id: column.id,
        title: column.title,
        items: column.items.length,
        groups: grouped(cardsOf(column.id, column.items), label).map((
          [name, cards],
        ) => ({ label: name, cards })),
      };
    });
  return { units, columns };
}
