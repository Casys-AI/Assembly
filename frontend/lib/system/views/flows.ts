import type {
  BoardItem,
  BoardTrackState,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";
import { type BoardElement, indexBoard } from "../board/lookup.ts";
import { twinKey, twinsOf } from "./twins.ts";

/**
 * What System > Flows lays out: what the model describes as behavior, in two
 * kinds (the flows, which are steps in order, and the lifecycles, which are
 * states), as the entries of a list the person picks one from. The same flow
 * declared in several units is one entry marked with how many, as Explore
 * marks it. Pure.
 */

export interface FlowEntry {
  kind: "flow" | "lifecycle";
  /** The item and its twins (the same item declared in other units), the item first. */
  items: readonly BoardItem[];
}

export interface FlowsModel {
  flows: readonly FlowEntry[];
  lifecycles: readonly FlowEntry[];
}

/**
 * What the page draws of a behavior, to the last step and state: twins are one
 * entry only when nothing it draws tells them apart. `twinKey` compares what a
 * person reads of an item; a flow also draws the shape of its thread (each
 * step's depth, branch, guard, jump and loops) and a lifecycle the shape of
 * its track (states, ranks, ends, transitions), which a twin must share too,
 * or the second behavior would be hidden behind the first.
 */
const drawnKey = (item: BoardItem): string =>
  JSON.stringify([
    twinKey(item),
    (item.steps ?? []).map((step) => [
      step.keyword,
      step.type?.title,
      step.depth,
      step.branch,
      step.guard,
      step.toTitle,
      step.unreachable,
      (step.loops ?? []).map((loop) => loop.toTitle),
    ]),
    item.track && [
      item.track.extends?.title,
      item.track.states.map((state) => [
        state.keyword,
        state.title,
        state.rank,
        state.initial,
        state.terminal,
        state.inherited,
        state.out.map((out) => [out.on, out.name, out.guard, out.toTitle]),
      ]),
    ],
  ]);

/**
 * The entries of the board. What is behavior is what the index says is at home
 * on this page (a flow in Can do, a lifecycle in Guarantees), so the page that
 * "Open" leads to is the page that draws the element.
 */
export function flowsOf(board: ModelBoard): FlowsModel {
  const index = indexBoard(board);
  const behavior = board.columns.flatMap((column) => column.items).filter(
    (item) => index.get(item.id)?.home === "behavior",
  );
  const entries = (kind: FlowEntry["kind"], items: readonly BoardItem[]) =>
    twinsOf(items, drawnKey).map((twins): FlowEntry => ({
      kind,
      items: twins,
    }));
  return {
    flows: entries("flow", behavior.filter((item) => item.steps?.length)),
    lifecycles: entries(
      "lifecycle",
      behavior.filter((item) => !item.steps?.length && item.track),
    ),
  };
}

/** The entry on show, and the twin of it that is read. */
export interface ShownFlow {
  entry: FlowEntry;
  item: BoardItem;
}

/**
 * Which flow the page reads. What the address selects wins, so that an element
 * is always drawn where it is: the flow a step or a state belongs to, or the
 * flow itself. Then the flow the address asks for (`?flow=`, a board id); and
 * when it asks for none, or one that is none, the first entry (flows before
 * lifecycles). None when the model describes no behavior.
 */
export function shownFlow(
  model: FlowsModel,
  options: { selected: BoardElement | undefined; flow: string | null },
): ShownFlow | undefined {
  const entries = [...model.flows, ...model.lifecycles];
  const find = (id: string | null | undefined): ShownFlow | undefined => {
    if (!id) return undefined;
    for (const entry of entries) {
      const item = entry.items.find((twin) => twin.id === id);
      if (item) return { entry, item };
    }
    return undefined;
  };
  return find(options.selected?.id) ?? find(options.selected?.parent) ??
    find(options.flow) ??
    (entries[0] ? { entry: entries[0], item: entries[0].items[0] } : undefined);
}

/** One column of a lifecycle: the states at one rank, or the ones that stand apart. */
export interface LifecycleColumn {
  /** The states at `rank`; those no path from the initial state reaches; those that end it. */
  kind: "rank" | "unreached" | "end";
  rank: number | null;
  states: readonly BoardTrackState[];
}

/**
 * A lifecycle's states in columns, left to right: by the rank the board gives
 * them (their distance from the initial state), then the states no path from
 * the initial one reaches, then the states that end it. Within a column the
 * board's order stays.
 */
export function lifecycleColumns(
  states: readonly BoardTrackState[],
): readonly LifecycleColumn[] {
  const byRank = new Map<number, BoardTrackState[]>();
  const unreached: BoardTrackState[] = [];
  const end: BoardTrackState[] = [];
  for (const state of states) {
    if (state.terminal) end.push(state);
    else if (state.rank === null) unreached.push(state);
    else byRank.set(state.rank, [...byRank.get(state.rank) ?? [], state]);
  }
  return [
    ...[...byRank].sort(([a], [b]) => a - b).map(([rank, held]) => ({
      kind: "rank" as const,
      rank,
      states: held,
    })),
    ...(unreached.length > 0
      ? [{ kind: "unreached" as const, rank: null, states: unreached }]
      : []),
    ...(end.length > 0
      ? [{ kind: "end" as const, rank: null, states: end }]
      : []),
  ];
}
