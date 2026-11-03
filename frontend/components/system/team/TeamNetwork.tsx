import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import { useRef } from "preact/hooks";
import { monogram } from "../../../lib/workbench/desk.ts";
import {
  edgesOf,
  layoutTeam,
  nodesOf,
  wireBetween,
} from "../../../lib/system/team/layout.ts";
import {
  MAIN,
  resourceTitle,
  type Team,
  type TeamAgent,
  type TeamResource,
  YOU,
} from "../../../lib/system/team/projection.ts";
import { Icon, type IconName } from "../../view/Icon.tsx";
import { useNodeDrag } from "./useNodeDrag.ts";
import { useRoomWidth, useTeamLayout } from "./useTeamLayout.ts";

const RESOURCE_ICON: Record<TeamResource["kind"], IconName> = {
  tool: "wrench",
  skill: "book",
  context: "eye",
  memory: "archive",
  information: "file",
};

/**
 * The team as a network, not an org chart: the agents in the middle, what they
 * work with around them; a line says who uses what, and a dark one who the
 * person talks with. A thing several agents use is one node with its count.
 * Selecting an agent is following its link, and draws the same layout again:
 * the simulation runs when the team or the width changes, not for a click.
 * Nodes can be dragged (pointer events, no library); a press that does not
 * move is a click, and a drag never follows the link under it.
 */
export function TeamNetwork(
  { team, selected, hrefOf, mainHref, layout: simulate = layoutTeam }: {
    team: Team;
    /** The agent shown beside the network. */
    selected: string;
    /** The address that selects an agent. */
    hrefOf(agentId: string): string;
    /** Where the main system shows its Main, when the team is a Case's. */
    mainHref?: string;
    /** The simulation; a test counts its runs. */
    layout?: typeof layoutTeam;
  },
) {
  const room = useRef<HTMLDivElement>(null);
  const width = useRoomWidth(room);
  const nodes = nodesOf(team);
  const edges = edgesOf(team);
  const { layout, key } = useTeamLayout(nodes, edges, width, simulate);
  const agents = new Map(team.agents.map((agent) => [agent.id, agent]));
  const branches = new Map(
    (team.branches ?? []).map((branch) => [branch.id, branch]),
  );
  const resources = new Map(
    team.resources.map((resource) => [resource.key, resource]),
  );
  const { boxes: placed, grab, clicked } = useNodeDrag(layout, key);
  const at = new Map(placed.map((box) => [box.id, box]));

  return (
    <div
      class="tmap"
      ref={room}
      role="group"
      aria-label="Team network"
      style={{ height: `${layout.height}px` }}
    >
      <svg class="wires" aria-hidden="true">
        {edges.map((edge) => {
          const from = at.get(edge.from), to = at.get(edge.to);
          if (!from || !to) return null;
          const { x1, y1, x2, y2 } = wireBetween(from, to);
          return (
            <line
              key={edge.id}
              class={`wire ${edge.kind}`}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
            />
          );
        })}
      </svg>
      {placed.map((box) => {
        const place = {
          transform: `translate(${box.x - box.w / 2}px, ${
            box.y - box.h / 2
          }px)`,
          width: `${box.w}px`,
        };
        if (box.id === YOU && box.kind === "you") {
          return (
            <div
              key={box.id}
              class="tnode is-you"
              style={place}
              data-node={box.id}
              {...grab(box)}
            >
              <span class="tavatar">
                <Icon name="person" />
              </span>
              <span class="tname">You</span>
            </div>
          );
        }
        if (box.id === MAIN && box.kind === "main") {
          // A plain link: the main system, not this Case's view of it.
          return (
            <a
              key={box.id}
              class="tnode is-main"
              style={place}
              href={mainHref}
              title="Runs the main system"
              draggable={false}
              data-node={box.id}
              onClick={(event) => {
                if (!clicked(box.id)) event.preventDefault();
              }}
              {...grab(box)}
            >
              <span class="tavatar">{monogram("Main Operator")}</span>
              <span class="tname">Main Operator</span>
            </a>
          );
        }
        const branch = box.kind === "branch" ? branches.get(box.id) : undefined;
        if (branch) {
          // A plain link to the Case's own Team; the fold leads to the Requests.
          const fold = branch.id === "branch:more";
          return (
            <a
              key={box.id}
              class="tnode is-branch"
              style={place}
              href={branch.href}
              title={branch.title}
              draggable={false}
              data-node={box.id}
              onClick={(event) => {
                if (!clicked(box.id)) event.preventDefault();
              }}
              {...grab(box)}
            >
              <span class="tavatar">
                {fold ? branch.label : monogram(branch.label)}
              </span>
              <span class="tname">{fold ? "earlier" : branch.label}</span>
            </a>
          );
        }
        const agent: TeamAgent | undefined = agents.get(box.id);
        if (agent) {
          const picked = agent.id === selected;
          return (
            <ModelContextLink
              key={box.id}
              class={`tnode is-agent${picked ? " is-picked" : ""}`}
              style={place}
              href={hrefOf(agent.id)}
              // Fresh marks every link to the page's own path as current unless
              // the link says what it is.
              aria-current={picked ? "true" : "false"}
              title={agent.qname ?? agent.name}
              draggable={false}
              data-agent={agent.id}
              data-busy={agent.busy ? "true" : undefined}
              onClick={(event) => {
                if (!clicked(agent.id)) event.preventDefault();
              }}
              {...grab(box)}
            >
              <span class="tavatar">{monogram(agent.name)}</span>
              <span class="tname">{agent.name}</span>
            </ModelContextLink>
          );
        }
        const resource = resources.get(box.id);
        if (!resource) return null;
        const shared = resource.agents.length > 1;
        return (
          <div
            key={box.id}
            class={`tres${shared ? " is-shared" : ""}`}
            style={place}
            title={resourceTitle(team, resource)}
            data-resource={resource.key}
            {...grab(box)}
          >
            <span class="tanchor">
              <Icon name={RESOURCE_ICON[resource.kind]} />
              {resource.label}
              {shared && (
                <span
                  class="times"
                  aria-label={`${resource.agents.length} agents`}
                >
                  ×{resource.agents.length}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
