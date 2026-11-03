import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import type {
  BoardTrack,
  BoardTrackState,
} from "../../../../src/domain/model/records/board.ts";
import type { Detail } from "../../../lib/system/board/detail.ts";
import { lifecycleColumns } from "../../../lib/system/views/flows.ts";
import { DetailSlot } from "../DetailSlot.tsx";
import { Why } from "../Why.tsx";

/** A transition as a line: what triggers it, where it goes, what it is guarded by. */
function transitionLine(
  transition: BoardTrackState["out"][number],
  detail: Detail,
): string {
  const trigger = transition.on ?? transition.name;
  const when = trigger === null ? "" : detail.said(trigger);
  const guard = transition.guard === null ? "" : ` [${transition.guard}]`;
  return `${when}${guard} → ${detail.said(transition.toTitle)}`.trim();
}

/** What a state says on hover: where it leads, one line each, else where it stands. */
function stateTitle(
  state: BoardTrackState,
  track: BoardTrack,
  detail: Detail,
): string {
  const lines = state.out.map((transition) =>
    transitionLine(transition, detail)
  );
  const from = state.inherited && track.extends
    ? [`from ${detail.said(track.extends.title)}`]
    : [];
  return [...(lines.length > 0 ? lines : [detail.nameOf(state.id)]), ...from]
    .join("\n");
}

/** One state: a pill that opens its detail right under it. */
function State(
  { state, track, detail }: {
    state: BoardTrackState;
    track: BoardTrack;
    detail: Detail;
  },
) {
  const { chosen, why, class: standing } = detail.standing([state.id]);
  const marks = `${state.initial ? " is-initial" : ""}${
    state.terminal ? " is-terminal" : ""
  }${state.inherited ? " is-inherited" : ""}`;
  return (
    <div class="life-cell" data-state={state.id}>
      <ModelContextLink
        class={`life-state ${standing}${marks}`}
        href={detail.toggle([state.id])}
        aria-current={chosen ? "true" : "false"}
        title={stateTitle(state, track, detail)}
      >
        {detail.sysml && <span class="kind-kw">{state.keyword}</span>}
        {detail.nameOf(state.id)}
        <Why labels={why} />
      </ModelContextLink>
      <DetailSlot ids={[state.id]} detail={detail} />
    </div>
  );
}

/**
 * A lifecycle as a track, not a diagram: its states in columns, left to right,
 * by how far they are from the initial state, those that end it last. The
 * initial state is outlined, an end is dashed, a state the lifecycle inherits
 * is quieter than one this model adds, and a state says where it leads when
 * it is pointed at. A state is chosen to open its detail right under it.
 */
export function LifecycleTrack(
  { track, detail }: { track: BoardTrack; detail: Detail },
) {
  return (
    <div class="life" role="group" aria-label="Lifecycle">
      {lifecycleColumns(track.states).map((column) => (
        <div
          key={`${column.kind}:${column.rank}`}
          class="life-col"
          data-column={column.kind}
        >
          {column.states.map((state) => (
            <State key={state.id} state={state} track={track} detail={detail} />
          ))}
        </div>
      ))}
    </div>
  );
}
