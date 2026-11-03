import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import { ownSummary, perSystem } from "../../../lib/system/board/words.ts";
import type { Detail } from "../../../lib/system/board/detail.ts";
import {
  choosable,
  flattened,
  type FlowNode,
  flowTreeOf,
} from "../../../lib/system/views/flow-tree.ts";
import {
  type FlowEntry,
  flowsOf,
  type ShownFlow,
  shownFlow,
} from "../../../lib/system/views/flows.ts";
import { Empty } from "../../view/Empty.tsx";
import { DetailUnderTitle } from "../DetailSlot.tsx";
import { FlowThread } from "./FlowThread.tsx";
import { LifecycleTrack } from "./LifecycleTrack.tsx";

/** One entry of the list: a link to the flow, marked with how many units declare it. */
function Pick(
  { entry, shown, detail, alike }: {
    entry: FlowEntry;
    shown: ShownFlow;
    detail: Detail;
    /** Another entry goes by the same name: the unit says which this one is. */
    alike: boolean;
  },
) {
  const current = entry === shown.entry;
  // The twin on show stays on show; the others open their first.
  const id = current ? shown.item.id : entry.items[0].id;
  const units = detail.unitNames(
    entry.items.flatMap((item) => item.scope ?? []),
  );
  return (
    <ModelContextLink
      class="flows-pick"
      // This page, reading that flow, with nothing selected.
      href={detail.keeping({ flow: id }).closeHref}
      aria-current={current ? "true" : "false"}
      data-flow={id}
      title={ownSummary(entry.items[0])}
    >
      <span class="flows-pick-name">{detail.nameOf(entry.items[0].id)}</span>
      {entry.items.length > 1
        ? (
          <span class="flows-times" title={perSystem(units)}>
            ×{entry.items.length}
          </span>
        )
        : alike && units.length > 0 && (
          <span class="flows-times" title={`declared in ${units[0]}`}>
            {units[0]}
          </span>
        )}
    </ModelContextLink>
  );
}

function Picker(
  { flows, lifecycles, shown, detail }: {
    flows: readonly FlowEntry[];
    lifecycles: readonly FlowEntry[];
    shown: ShownFlow;
    detail: Detail;
  },
) {
  // Behaviors that differ in what the page draws can still go by one name.
  const named = (entry: FlowEntry) => detail.nameOf(entry.items[0].id);
  const names = new Map<string, number>();
  for (const entry of [...flows, ...lifecycles]) {
    names.set(named(entry), (names.get(named(entry)) ?? 0) + 1);
  }
  const group = (name: string, entries: readonly FlowEntry[]) =>
    entries.length > 0 && (
      <>
        <div class="flows-group">{name}</div>
        {entries.map((entry) => (
          <Pick
            key={entry.items[0].id}
            entry={entry}
            shown={shown}
            detail={detail}
            alike={(names.get(named(entry)) ?? 0) > 1}
          />
        ))}
      </>
    );
  return (
    <nav class="flows-picker" aria-label="Flows and lifecycles">
      {group("Flows", flows)}
      {group("Lifecycles", lifecycles)}
    </nav>
  );
}

/** The ids the page draws an element for: every step and state of what is on show. */
function carriedBy(
  shown: ShownFlow,
  tree: readonly FlowNode[] | undefined,
): ReadonlySet<string> {
  return new Set(
    tree
      ? flattened(tree).filter(choosable).map((node) => node.id)
      : (shown.item.track?.states ?? []).map((state) => state.id),
  );
}

/**
 * System > Flows: the behavior the model describes, one flow or lifecycle at a
 * time, picked from a list at the left. A flow is a thread of steps, a
 * lifecycle a track of states; steps and states are links, and choosing one
 * opens its detail right under it. The first entry is read until another is
 * asked for (`flow`), and what the address selects is always read where it
 * is. Choosing or closing an element keeps the flow being read.
 */
export function FlowsPage(
  { board, detail, flow }: {
    board: ModelBoard;
    detail: Detail;
    /** `?flow=`: the board id of the flow or lifecycle the address asks for. */
    flow: string | null;
  },
) {
  const { flows, lifecycles } = flowsOf(board);
  const shown = shownFlow({ flows, lifecycles }, {
    selected: detail.selected,
    flow,
  });
  if (!shown) return <Empty code="no-flow">No flows yet</Empty>;
  // What the page does to the address keeps the flow it is reading.
  const here = detail.keeping({ flow: shown.item.id });
  const tree = shown.entry.kind === "flow"
    ? flowTreeOf(detail.index, shown.item)
    : undefined;
  const track = shown.item.track;
  return (
    <div class="flows-page">
      <DetailUnderTitle detail={here} carried={carriedBy(shown, tree)} />
      <div class="flows-split">
        <Picker
          flows={flows}
          lifecycles={lifecycles}
          shown={shown}
          detail={detail}
        />
        <div
          class={`flows-stage${detail.selected ? " has-selection" : ""}`}
          data-kind={shown.entry.kind}
          data-flow={shown.item.id}
        >
          {tree && <FlowThread nodes={tree} detail={here} />}
          {!tree && track && track.states.length > 0 &&
            <LifecycleTrack track={track} detail={here} />}
          {!tree && (!track || track.states.length === 0) && (
            <Empty code="no-state">No states yet</Empty>
          )}
        </div>
      </div>
    </div>
  );
}
