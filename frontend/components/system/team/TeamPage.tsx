import { ModelContextLink } from "../../view/ModelContextLink.tsx";
import { useMemo, useState } from "preact/hooks";
import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import { monogram } from "../../../lib/workbench/desk.ts";
import {
  type CandidateRead,
  candidateReadMessage,
  candidatesFor,
  hasToolChips,
  ownerIdsFor,
} from "../../../lib/system/tools/candidates.ts";
import type { ToolServer } from "../../../lib/system/tools/servers.ts";
import {
  agentsOnly,
  boardNotes,
  type BranchRef,
  profileOf,
  type RosterEntry,
  shownAgent,
  teamOf,
  withBranches,
  withMain,
} from "../../../lib/system/team/projection.ts";
import { Empty } from "../../view/Empty.tsx";
import { AgentProfile } from "./AgentProfile.tsx";
import { BoardNotes } from "../board/BoardNotes.tsx";
import { TeamNetwork } from "./TeamNetwork.tsx";

/** Up to this many agents the team reads as a network; beyond, as a list. */
export const NETWORK_LIMIT = 12;

const NO_BRANCHES: readonly BranchRef[] = [];

/**
 * System > Team: who acts in the model, what each works with, and one agent
 * at a time in full. Up to a dozen agents the team is a network and the agent
 * shown is under it; with more, the agents are a list at the left of the
 * profile. The network shows the agents first; "Resources" adds what they work
 * with, a choice of the person looking that changes the page in place. Every
 * agent is a link: choosing one is following it. Nothing here changes the
 * model.
 */
export function TeamPage(
  {
    board,
    roster,
    selected,
    hrefOf,
    serversOf,
    runtime,
    requestOwnerId,
    branchName,
    mainHref,
    branches = NO_BRANCHES,
    branchesHref = "/cases",
  }: {
    board: ModelBoard;
    runtime?: CandidateRead;
    /** The runtime's operators: they say who the person talks with, and who is busy. */
    roster: readonly RosterEntry[];
    /** Exact Case owner: the unit it names is the Case's Branch Operator. */
    requestOwnerId?: string;
    /** What the Case's Branch Operator goes by, in place of the generic name. */
    branchName?: string;
    /** In a Case, where the main system shows its Main, which joins the team. */
    mainHref?: string;
    /** On the main system, the open Cases' Branch Operators, newest first. */
    branches?: readonly BranchRef[];
    /** Where the folded oldest Branch Operators lead. */
    branchesHref?: string;
    /** The agent the address names, if it names one. */
    selected: string | null;
    /** The address that selects an agent. */
    hrefOf(agentId: string): string;
    /** The tools an agent has in the runtime, by server; none when unknown. */
    serversOf?(nativeIds: readonly string[]): readonly ToolServer[] | undefined;
  },
) {
  const team = useMemo(() => {
    const own = teamOf(board, roster, requestOwnerId, branchName);
    return mainHref
      ? withMain(own)
      : withBranches(own, board, branches, branchesHref);
  }, [
    board,
    roster,
    requestOwnerId,
    branchName,
    mainHref,
    branches,
    branchesHref,
  ]);
  const [withResources, setWithResources] = useState(false);
  const agent = shownAgent(team, selected);
  const profile = useMemo(
    () => agent ? profileOf(board, agent.id) : undefined,
    [board, agent?.id],
  );
  const notes = boardNotes(board, team);
  if (!agent || !profile) {
    // The host may have said why: the projector places agents by the library
    // definitions of the model, and without them it finds none to place.
    return (
      <>
        {notes.length > 0
          ? <Empty code="no-agent-found">No agent could be read</Empty>
          : <Empty code="no-agent">No agent declared</Empty>}
        <BoardNotes notes={notes} />
      </>
    );
  }
  const detail = (
    <AgentProfile
      agent={agent}
      profile={profile}
      servers={serversOf?.(agent.nativeIds)}
      runtime={runtime}
      toolChips={runtime
        ? hasToolChips(
          board,
          profile.tools.things,
          candidatesFor(runtime, ownerIdsFor(agent.nativeIds, roster)),
        )
        : undefined}
      toolStatus={runtime ? candidateReadMessage(runtime) : undefined}
    />
  );
  if (team.agents.length <= NETWORK_LIMIT) {
    return (
      <>
        <BoardNotes notes={notes} />
        <div class="team-page">
          <div class="tmap-pane">
            {team.resources.length > 0 && (
              <div class="seg">
                <button
                  type="button"
                  aria-pressed={withResources ? "true" : "false"}
                  title="Tools, skills and policies the agents work with"
                  onClick={() => setWithResources((on) => !on)}
                >
                  Resources
                </button>
              </div>
            )}
            <TeamNetwork
              team={withResources ? team : agentsOnly(team)}
              selected={agent.id}
              hrefOf={hrefOf}
              mainHref={mainHref}
            />
          </div>
          {detail}
        </div>
      </>
    );
  }
  return (
    <>
      <BoardNotes notes={notes} />
      <div class="team-page is-list">
        <nav class="team-picker" aria-label="Agents">
          {mainHref && (
            <a
              class="team-pick is-main"
              href={mainHref}
              title="Runs the main system"
            >
              <span class="tavatar is-mini" aria-hidden="true">
                {monogram("Main Operator")}
              </span>
              <span class="team-pick-name">Main Operator</span>
            </a>
          )}
          {team.agents.map((entry) => (
            <ModelContextLink
              key={entry.id}
              class="team-pick"
              href={hrefOf(entry.id)}
              aria-current={entry.id === agent.id ? "true" : "false"}
              data-agent={entry.id}
              title={entry.qname ?? entry.name}
            >
              <span class="tavatar is-mini" aria-hidden="true">
                {monogram(entry.name)}
              </span>
              <span class="team-pick-name">{entry.name}</span>
            </ModelContextLink>
          ))}
        </nav>
        {detail}
      </div>
    </>
  );
}
