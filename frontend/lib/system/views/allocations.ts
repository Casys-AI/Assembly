import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import { indexBoard } from "../board/lookup.ts";
import { grouped } from "./grouped.ts";

/**
 * What System > Allocations lays out: who performs what, as a matrix. The rows
 * are what the model allocates (the steps of a flow, or a whole action), grouped
 * by the flow they belong to and the unit that flow is declared for; the
 * columns are what performs it (an operator, a component), grouped by unit.
 * Pure.
 *
 * Ids are the board's. An end the board does not hold is kept as the link
 * names it, and a unit the board cannot tell is `null`: the page says "?"
 * rather than leave an allocation out.
 */

export interface AllocationRow {
  /** The allocated element's id. */
  id: string;
  /** Who performs it: the ids of the columns it has a cell in. */
  targets: ReadonlySet<string>;
}

/** The rows of one flow in one unit; `flow` is null for an action that is no step. */
export interface AllocationGroup {
  flow: string | null;
  unit: string | null;
  rows: readonly AllocationRow[];
}

/** The performers of one unit, in the order the model allocates to them. */
export interface AllocationColumns {
  unit: string | null;
  targets: readonly string[];
}

export interface AllocationsModel {
  /** How many `allocate` the model declares. */
  allocations: number;
  columns: readonly AllocationColumns[];
  groups: readonly AllocationGroup[];
}

export function allocationsOf(board: ModelBoard): AllocationsModel {
  const index = indexBoard(board);
  const allocated = index.linked("allocate");

  const performers = new Map<string | null, string[]>();
  for (const id of new Set(allocated.map(({ to }) => to))) {
    const unit = index.unitOf(id);
    performers.set(unit, [...performers.get(unit) ?? [], id]);
  }
  // The units in the order of the team, then the performers no unit claims.
  const columns = [...index.units.map((unit) => unit.id), null].flatMap(
    (unit) => {
      const targets = performers.get(unit);
      return targets ? [{ unit, targets }] : [];
    },
  );

  const rows = [...new Set(allocated.map(({ from }) => from))].map((id) => ({
    id,
    targets: new Set(
      allocated.filter(({ from }) => from === id).map(({ to }) => to),
    ),
  }));
  const placed = rows.map((row) => {
    const flow = index.flowOf(row.id);
    return { row, flow, unit: index.unitOf(flow ?? row.id) };
  });
  const groups = grouped(
    placed,
    ({ flow, unit }) => JSON.stringify([flow, unit]),
  ).map(([, held]) => ({
    flow: held[0].flow,
    unit: held[0].unit,
    rows: held.map(({ row }) => row),
  }));
  return { allocations: allocated.length, columns, groups };
}
