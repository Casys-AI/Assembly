import { ModelContextLink } from "../view/ModelContextLink.tsx";
import { Fragment } from "preact";
import type {
  BoardColumnId,
  ModelBoard,
} from "../../../src/domain/model/records/board.ts";
import { ownSummary, perSystem } from "../../lib/system/board/words.ts";
import type { Detail } from "../../lib/system/board/detail.ts";
import {
  type ExploreCard,
  exploreOf,
  type ExploreRosterEntry,
  linkedExploreTools,
} from "../../lib/system/views/explore.ts";
import type { CandidateRead } from "../../lib/system/tools/candidates.ts";
import { ToolCandidateChip } from "./ToolCandidateChip.tsx";
import { Empty } from "../view/Empty.tsx";
import { Icon, type IconName } from "../view/Icon.tsx";
import { DetailSlot, DetailUnderTitle } from "./DetailSlot.tsx";
import { KindMark } from "./KindMark.tsx";
import { Why } from "./Why.tsx";
import { TOOL_APPEARANCE_MS, useToolAppearance } from "./useToolAppearance.ts";

const COLUMN_ICON: Readonly<Record<BoardColumnId, IconName>> = {
  team: "spark",
  cando: "wrench",
  rules: "key",
  guarantees: "shield",
  information: "book",
};

/**
 * One element of the model, as a line of its column. It is a link: choosing it
 * opens it in place, choosing it again closes it. While one is chosen, what
 * it is related to stays lit, with the reason, and the rest steps back.
 */
function Card(
  { card, detail, appearing }: {
    card: ExploreCard;
    detail: Detail;
    appearing: boolean;
  },
) {
  const { item, ids } = card;
  const { sysml } = detail;
  const { chosen, why, class: state } = detail.standing(ids);
  return (
    <ModelContextLink
      class={`explore-card ${state}${appearing ? " is-appearing" : ""}`}
      href={detail.toggle(ids)}
      aria-current={chosen ? "true" : "false"}
      data-id={item.id}
      title={ownSummary(item)}
    >
      <KindMark element={item} sysml={sysml} />
      <span class="explore-t">
        {detail.nameOf(item.id)}
        {sysml && item.type && (
          <span class="explore-ty">: {item.type.title}</span>
        )}
      </span>
      {ids.length > 1 && (
        <span
          class="explore-times"
          title={perSystem(detail.unitNames(card.scopes))}
        >
          ×{ids.length}
        </span>
      )}
      <Why labels={why} />
      {appearing && <span class="sr-only">New tool</span>}
    </ModelContextLink>
  );
}

/**
 * System > Explore: everything the model declares, a quiet list per concept
 * (who acts, what they can do, the rules they follow, what is guaranteed, the
 * information they work with). The same element declared in several units is
 * one line marked with how many. Choosing a line opens its detail right under
 * it; a selection the page has no line for opens under the title.
 */
export function ExplorePage(
  {
    board,
    detail,
    runtime,
    roster = [],
    historical = false,
    appearanceMs = TOOL_APPEARANCE_MS,
  }: {
    board: ModelBoard;
    detail: Detail;
    runtime?: CandidateRead;
    roster?: readonly ExploreRosterEntry[];
    historical?: boolean;
    /** How long a new tool is marked; tests shorten it rather than wait. */
    appearanceMs?: number;
  },
) {
  const appearing = useToolAppearance(
    board,
    historical,
    undefined,
    appearanceMs,
  );
  const { units, columns } = exploreOf(board, detail.unitNames);
  if (columns.length === 0) {
    return <Empty code="no-element">Nothing declared yet</Empty>;
  }
  const carried = new Set(
    columns.flatMap((column) =>
      column.groups.flatMap((group) => group.cards.flatMap((c) => c.ids))
    ),
  );
  return (
    <div class="explore">
      <DetailUnderTitle detail={detail} carried={carried} />
      <div
        class={`explore-board${detail.selected ? " has-selection" : ""}`}
      >
        {columns.map((column) => {
          const cards = column.groups.reduce(
            (count, group) => count + group.cards.length,
            0,
          );
          return (
            <section
              key={column.id}
              class="explore-col"
              data-column={column.id}
            >
              <h3
                class="explore-head"
                title={cards !== column.items
                  ? `${column.items} across ${units} systems`
                  : undefined}
              >
                <Icon name={COLUMN_ICON[column.id]} />
                {column.title}
                <span class="explore-n">{cards}</span>
              </h3>
              {column.groups.map((group) => (
                <Fragment key={group.label}>
                  {group.label && columns.length > 1 && (
                    <div class="explore-group">{group.label}</div>
                  )}
                  {group.cards.map((card) => {
                    const states = historical
                      ? []
                      : linkedExploreTools(board, card, runtime, roster);
                    return (
                      <Fragment key={card.ids[0]}>
                        <Card
                          card={card}
                          detail={detail}
                          appearing={card.ids.some((id) => appearing.has(id))}
                        />
                        {runtime && states.length > 0 && (
                          <div class="explore-tool-states">
                            {states.map(({ key, tool, occurrence }) => (
                              <ToolCandidateChip
                                key={key}
                                tool={tool}
                                read={runtime}
                                occurrence={occurrence}
                                label={tool.agentName || tool.agentId}
                              />
                            ))}
                          </div>
                        )}
                        <DetailSlot ids={card.ids} detail={detail} narrow />
                      </Fragment>
                    );
                  })}
                </Fragment>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
