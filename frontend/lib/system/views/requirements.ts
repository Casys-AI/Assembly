import type {
  BoardClause,
  BoardItem,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";

/**
 * What System > Requirements lays out: the requirements of the model and the
 * constraints it holds itself to, each with the state the board gives it.
 * Pure.
 *
 * The board does not know whether anything was tested. A requirement is told
 * by who owns it (the units declared to satisfy it), a constraint by whether a
 * performed step makes it hold (`inForce`), and nothing here says more.
 */

/** `on`: someone answers for it, or it holds. `off`: no one does. `idle`: nothing performs it. */
export type Mark = "on" | "off" | "idle";

export interface GuaranteeRow {
  item: BoardItem;
  /** Every id the row goes by: the item's, then those of its clauses. */
  ids: readonly string[];
  mark: Mark;
  /** For a requirement, how many units are declared to satisfy it. */
  owners: number;
  clauses: readonly BoardClause[];
}

export interface RequirementsModel {
  requirements: readonly GuaranteeRow[];
  constraints: readonly GuaranteeRow[];
}

function rowOf(item: BoardItem): GuaranteeRow {
  const clauses = item.clauses ?? [];
  const owners = item.satisfiedBy?.length ?? 0;
  return {
    item,
    ids: [item.id, ...clauses.map((clause) => clause.id)],
    mark: item.kind === "requirement"
      ? owners > 0 ? "on" : "off"
      : item.inForce === true
      ? "on"
      : "idle",
    owners,
    clauses,
  };
}

/** The requirements and constraints of the guarantees column, in the board's order. */
export function requirementsOf(board: ModelBoard): RequirementsModel {
  const items = board.columns
    .filter((column) => column.id === "guarantees")
    // A lifecycle is a guarantee too, told by its states on the page of flows.
    .flatMap((column) => column.items);
  return {
    requirements: items.filter((item) => item.kind === "requirement").map(
      rowOf,
    ),
    constraints: items.filter((item) => item.kind === "constraint").map(rowOf),
  };
}

/** What the state of a row says in words, for its tooltip and its reader. */
export function markWords(row: GuaranteeRow): string {
  if (row.item.kind === "requirement") {
    return row.owners === 0
      ? "no owner: nothing is declared to satisfy it"
      : `${row.owners} ${row.owners === 1 ? "owner" : "owners"}`;
  }
  return row.mark === "on"
    ? "used by a performed step"
    : "used by no performed step";
}
