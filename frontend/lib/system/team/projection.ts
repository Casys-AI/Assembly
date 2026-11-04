import type { AgentConversation } from "../../../../src/domain/work/records/conversations.ts";
import { canonicalProductName } from "../../../../src/domain/model/sysml-product-names.ts";
import type {
  BoardContextFamily,
  BoardDiagnostic,
  BoardItem,
  BoardValueEntry,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";
import { agentUnits, indexBoard } from "../board/lookup.ts";
import { flagOf, isGrantList, textOf } from "../board/values.ts";
import {
  figure,
  humanize,
  isMasked,
  lastName,
  readableValue,
  withoutUnit,
} from "../board/words.ts";

/**
 * The team, read from the board: the agents (one per unit of the model), what
 * they work with, who talks with whom, and the profile of one agent. Pure: the
 * same board and roster always give the same team, and nothing is invented.
 * What the model does not declare is absent here, and the page says so.
 *
 * The board is the model at one commit; the roster is the runtime's own view
 * of the operators it runs. They are joined by `nativeId`, which the runtime
 * takes from the element of the operator in the model: whether an agent is the
 * one the person talks with, and whether it is working, is what the runtime
 * says whenever it knows the agent, and what the model declares otherwise.
 */

/** The part of a roster entry the join reads. */
export type RosterEntry =
  & Pick<
    AgentConversation,
    "nativeId" | "name" | "primary" | "canSend" | "busy"
  >
  & Partial<Pick<AgentConversation, "agentId">>;

/** The node of the person in the network. */
export const YOU = "you";

/** The node of the global Main in a Case's network: it runs the main system. */
export const MAIN = "main-operator";

/** How many Branch Operators the main system's network draws before folding the oldest. */
export const BRANCH_LIMIT = 6;

/** An open Case seen from the main system: its Branch Operator. */
export interface BranchRef {
  caseId: string;
  /** The Request's name, as its Dock tile says it. */
  title: string;
  /** What its Branch Operator goes by. */
  name: string;
  /** The operator the Case runs, the same one the Main runs here. */
  owner: string;
  /** The Case's own Team. */
  href: string;
}

/** A Branch Operator in the network, or the fold of the oldest ones. */
export interface TeamBranch {
  /** The node's id: `branch:<caseId>`, or `branch:more` for the fold. */
  id: string;
  label: string;
  /** Its tooltip. */
  title: string;
  href: string;
}

/** How an agent stands with the person. */
export type Contact =
  /** The person talks with it: the primary contact, open to human input. */
  | "direct"
  /** It is known not to be: another agent hands it the work. */
  | "indirect"
  /** Neither the model nor the runtime says. */
  | "undeclared";

export interface TeamAgent {
  /** The id of the unit on the board. */
  id: string;
  name: string;
  /** Where the name comes from; a unit with no operator name never gets one made up. */
  nameSource: "model" | "roster" | "unit" | "request-context";
  /** The unit a Case runs: its Branch Operator, whatever it is called. */
  branch?: true;
  /** The unit's qualified name in the model. */
  qname: string | null;
  contact: Contact;
  /** An operator of this unit is working now (the roster knows it). */
  busy: boolean;
  /** The roster entries that are operators of this unit. */
  nativeIds: readonly string[];
}

export type ResourceKind =
  | "tool"
  | "skill"
  | "context"
  | "memory"
  | "information";

/** Something agents work with, shared when more than one of them does. */
export interface TeamResource {
  key: string;
  label: string;
  kind: ResourceKind;
  /** Who works with it, and how: "has", "sees", "keeps"... */
  agents: readonly { agentId: string; how: string }[];
}

export interface TeamEdge {
  id: string;
  from: string;
  to: string;
  kind: "talk" | "calls" | "uses" | "supervises";
  /** What the line says, for its tooltip. */
  title?: string;
}

export interface Team {
  agents: readonly TeamAgent[];
  resources: readonly TeamResource[];
  edges: readonly TeamEdge[];
  /** The person is in the network: some agent talks with them. */
  talks: boolean;
  /** A Case: the global Main is in the network, beside the team (`withMain`). */
  main?: boolean;
  /** The main system: the Branch Operators its Main supervises (`withBranches`). */
  branches?: readonly TeamBranch[];
}

/**
 * Items declared inside a unit, by the unit: the unit the board says an item
 * belongs to (`unitOf`, the one rule every System page asks), a child with the
 * unit of its parent. Only what units can do and the rules they follow.
 */
function itemsByScope(board: ModelBoard): Map<string, BoardItem[]> {
  const index = indexBoard(board);
  const out = new Map<string, BoardItem[]>();
  const visit = (item: BoardItem) => {
    const unit = index.unitOf(item.id);
    if (unit) out.set(unit, [...out.get(unit) ?? [], item]);
    for (const child of item.children ?? []) visit(child);
  };
  for (const column of board.columns) {
    if (column.id !== "cando" && column.id !== "rules") continue;
    for (const item of column.items) visit(item);
  }
  return out;
}

/** Every id a unit and its parts go by: the roster names an operator by its element. */
function identities(unit: BoardItem): Set<string> {
  const out = new Set<string>();
  const visit = (item: BoardItem) => {
    out.add(item.id).add(item.element);
    for (const child of item.children ?? []) visit(child);
  };
  visit(unit);
  return out;
}

function contactOf(
  unit: BoardItem,
  known: readonly RosterEntry[],
): Contact {
  if (known.length > 0) {
    return known.some((entry) => entry.primary && entry.canSend)
      ? "direct"
      : "indirect";
  }
  const primary = flagOf(unit, "primaryContact");
  if (primary === true && flagOf(unit, "humanInputEnabled") === true) {
    return "direct";
  }
  return primary === false ? "indirect" : "undeclared";
}

function agentOf(
  unit: BoardItem,
  roster: readonly RosterEntry[],
  requestOwnerId?: string,
  branchName = "Branch Operator",
): TeamAgent {
  const own = identities(unit);
  const known = roster.filter((entry) => own.has(entry.nativeId));
  const declared = textOf(unit, "operatorName");
  // The runtime's name for the operator the person talks with, else the first.
  const named = known.find((entry) => entry.primary && entry.name) ??
    known.find((entry) => entry.name);
  const name = declared ?? named?.name ?? unit.title;
  // In a Case, the unit the Case runs is its Branch Operator; only the
  // inherited generic name is replaced (by the Case's name for it), a custom
  // name is kept.
  const branch = Boolean(requestOwnerId && own.has(requestOwnerId));
  const branchOwner = name === "Main Operator" && branch;
  return {
    id: unit.id,
    name: branchOwner ? branchName : name,
    ...(branch ? { branch: true as const } : {}),
    nameSource: branchOwner
      ? "request-context"
      : declared
      ? "model"
      : named
      ? "roster"
      : "unit",
    qname: unit.qname,
    contact: contactOf(unit, known),
    busy: known.some((entry) => entry.busy),
    nativeIds: known.map((entry) => entry.nativeId),
  };
}

/** The unit's grants are listed under their policy; what they allow depends on it. */
const GRANTS: Readonly<Record<string, string>> = {
  "AssemblyModelEditing::ModelEditPolicy::grants": "may propose edits",
  "AssemblyModelAdministration::ModelAdministrationPolicy::grants":
    "may administer",
};

/** How a policy of each family relates the agent to it. */
const FAMILY: Record<BoardContextFamily, { kind: ResourceKind; how: string }> =
  {
    context: { kind: "context", how: "sees" },
    skill: { kind: "skill", how: "loads" },
    memory: { kind: "memory", how: "keeps" },
  };

interface Draft {
  key: string;
  label: string;
  kind: ResourceKind;
  agents: Map<string, string>;
}

/** The things one unit works with: skills, tools, policies, and what it may edit. */
function* usedBy(
  items: readonly BoardItem[],
): Generator<{ key: string; label: string; kind: ResourceKind; how: string }> {
  for (const item of items) {
    if (item.kind === "skill") {
      yield {
        key: `skill:${item.type?.qname ?? item.title}`,
        label: item.title,
        kind: "skill",
        how: "has",
      };
    } else if (item.kind === "tool") {
      yield {
        key: `tool:${item.title}`,
        label: item.title,
        kind: "tool",
        how: "has",
      };
    } else if (item.kind === "policy") {
      if (item.family) {
        const { kind, how } = FAMILY[item.family];
        yield {
          key: `${item.family}:${item.type?.qname ?? item.title}`,
          label: humanize(item.type?.title ?? item.title),
          kind,
          how,
        };
      }
      for (const entry of item.values ?? []) {
        if (!isGrantList(entry.value)) continue;
        const how = GRANTS[canonicalProductName(entry.defines ?? "")] ??
          "may change";
        for (const grant of entry.value) {
          for (const root of grant.qualifiedRoots) {
            yield {
              key: `information:${root}`,
              label: lastName(root),
              kind: "information",
              how,
            };
          }
        }
      }
    }
  }
}

/**
 * Who may call whom among the agents: the model's accesses (`can-call`) from
 * the operator of one agent to what another performs, such as the inbox of a
 * member its Request created. One call per direction: two accesses from A
 * to B are one arrow, and B calling A is another. An access within one agent
 * is a tool it uses, and a disabled one allows no call.
 */
function callsBetween(
  board: ModelBoard,
  agents: readonly TeamAgent[],
): TeamEdge[] {
  const index = indexBoard(board);
  const ids = new Set(agents.map((agent) => agent.id));
  const calls = new Map<string, TeamEdge>();
  for (const { link, from, to } of index.linked("can-call")) {
    const caller = index.unitOf(from), callee = index.unitOf(to);
    if (
      link.enabled === false || !caller || !callee || caller === callee ||
      !ids.has(caller) || !ids.has(callee)
    ) continue;
    const id = `${caller}>${callee}`;
    calls.set(id, {
      id,
      from: caller,
      to: callee,
      kind: "calls",
      title: "may call",
    });
  }
  return [...calls.values()];
}

export function teamOf(
  board: ModelBoard,
  roster: readonly RosterEntry[] = [],
  /** Exact Case owner from the scoped Request read; absent in global views. */
  requestOwnerId?: string,
  /** What the Case's Branch Operator goes by, in place of the generic name. */
  branchName?: string,
): Team {
  const units = agentUnits(indexBoard(board));
  const mine = itemsByScope(board);
  const agents = units.map((unit) =>
    agentOf(unit, roster, requestOwnerId, branchName)
  );
  const drafts = new Map<string, Draft>();
  for (const agent of agents) {
    for (const used of usedBy(mine.get(agent.id) ?? [])) {
      const draft = drafts.get(used.key) ?? {
        key: used.key,
        label: used.label,
        kind: used.kind,
        agents: new Map<string, string>(),
      };
      drafts.set(used.key, draft);
      if (!draft.agents.has(agent.id)) draft.agents.set(agent.id, used.how);
    }
  }
  const resources: TeamResource[] = [...drafts.values()].map((draft) => ({
    key: draft.key,
    label: draft.label,
    kind: draft.kind,
    agents: [...draft.agents].map(([agentId, how]) => ({ agentId, how })),
  }));
  const talkers = agents.filter((agent) => agent.contact === "direct");
  const edges: TeamEdge[] = [
    ...talkers.map((agent) => ({
      id: `${YOU}>${agent.id}`,
      from: YOU,
      to: agent.id,
      kind: "talk" as const,
    })),
    ...callsBetween(board, agents),
    ...resources.flatMap((resource) =>
      resource.agents.map(({ agentId, how }) => ({
        id: `${agentId}>${resource.key}`,
        from: agentId,
        to: resource.key,
        kind: "uses" as const,
        title: how,
      }))
    ),
  ];
  return { agents, resources, edges, talks: talkers.length > 0 };
}

/**
 * The agent each operator identity belongs to, named as in `teamOf`. Provider
 * calls name the operator by its element, one of its unit's identities; an
 * identity the board does not hold (a former member) has no agent.
 */
export function agentsByOperator(
  board: ModelBoard,
  roster: readonly RosterEntry[] = [],
  requestOwnerId?: string,
  branchName?: string,
): ReadonlyMap<string, TeamAgent> {
  const out = new Map<string, TeamAgent>();
  for (const unit of agentUnits(indexBoard(board))) {
    const agent = agentOf(unit, roster, requestOwnerId, branchName);
    for (const id of identities(unit)) out.set(id, agent);
  }
  return out;
}

/**
 * The main system's team with the Branch Operators of its open Cases beside
 * it, newest first: each joined by a "supervises" line to the unit its Case
 * runs (the Main's own unit here). Past `BRANCH_LIMIT`, the oldest fold into
 * one node that leads to `moreHref`. Like the Main in a Case, they are not
 * units of this model.
 */
export function withBranches(
  team: Team,
  board: ModelBoard,
  branches: readonly BranchRef[],
  moreHref: string,
): Team {
  if (branches.length === 0) return team;
  const units = new Map<string, string | undefined>();
  const unitOf = (owner: string) => {
    if (!units.has(owner)) {
      units.set(
        owner,
        teamOf(board, [], owner).agents.find((agent) => agent.branch)?.id,
      );
    }
    return units.get(owner);
  };
  const folds = branches.length > BRANCH_LIMIT;
  const drawn = folds ? branches.slice(0, BRANCH_LIMIT - 1) : branches;
  const folded = folds ? branches.slice(BRANCH_LIMIT - 1) : [];
  const nodes: TeamBranch[] = drawn.map((branch) => ({
    id: `branch:${branch.caseId}`,
    label: branch.name,
    title: `Branch Operator · ${branch.title}`,
    href: branch.href,
  }));
  if (folded.length > 0) {
    nodes.push({
      id: "branch:more",
      label: `+${folded.length}`,
      title: folded.map((branch) => `${branch.name} · ${branch.title}`)
        .join("\n"),
      href: moreHref,
    });
  }
  const edges: TeamEdge[] = [
    ...drawn.map((branch) => [branch.owner, `branch:${branch.caseId}`]),
    ...(folded.length > 0 ? [[folded[0].owner, "branch:more"]] : []),
  ].flatMap(([owner, to]) => {
    const unit = unitOf(owner);
    return unit
      ? [{
        id: `${unit}>${to}`,
        from: unit,
        to,
        kind: "supervises" as const,
        title: "supervises",
      }]
      : [];
  });
  return { ...team, branches: nodes, edges: [...team.edges, ...edges] };
}

/**
 * A Case's team with the global Main beside it. The Main is not a unit of the
 * Case's model: it is the same unit running on the main system, and it
 * supervises the Branch Operator, to which a line joins it.
 */
export function withMain(team: Team): Team {
  const branch = team.agents.find((agent) => agent.branch);
  return {
    ...team,
    main: true,
    edges: branch
      ? [...team.edges, {
        id: `${MAIN}>${branch.id}`,
        from: MAIN,
        to: branch.id,
        kind: "supervises",
        title: "supervises",
      }]
      : team.edges,
  };
}

/**
 * The team as its network shows it at first: the agents and who talks with,
 * calls or supervises whom, without what they work with (each agent's profile
 * still lists it).
 */
export function agentsOnly(team: Team): Team {
  return {
    ...team,
    resources: [],
    edges: team.edges.filter((edge) => edge.kind !== "uses"),
  };
}

/**
 * The agent a page shows: the one it is told to, else the first the person
 * talks with, else the first. None only when the model declares no agent.
 */
export function shownAgent(
  team: Team,
  selected: string | null,
): TeamAgent | undefined {
  return team.agents.find((agent) => agent.id === selected) ??
    team.agents.find((agent) => agent.contact === "direct") ??
    team.agents[0];
}

/** An agent's name, for a sentence. */
export const agentName = (team: Team, id: string): string =>
  team.agents.find((agent) => agent.id === id)?.name ?? id;

/** What a resource's tooltip says: who works with it, and how. */
export function resourceTitle(team: Team, resource: TeamResource): string {
  return resource.agents.map(({ agentId, how }) =>
    `${agentName(team, agentId)} ${how}`
  ).join("\n");
}

/**
 * What the host noted while it projected the board that the page should say,
 * as it gave it (code, severity, recovery). Where the team came out empty any
 * note may be the reason, whatever its severity: the model can declare agents
 * the projector could not place. Where it did not, only the warnings and the
 * errors are worth a person's attention.
 */
export function boardNotes(
  board: ModelBoard,
  team: Pick<Team, "agents">,
): readonly BoardDiagnostic[] {
  return team.agents.length === 0
    ? board.meta.diagnostics
    : board.meta.diagnostics.filter((note) => note.severity !== "info");
}

/** A short fact about the agent: a figure and what it counts. */
export interface ProfileStat {
  id: string;
  value: string;
  label: string;
  /** A ceiling the model declares (`max…`), not a measurement. */
  limit?: true;
}
/** A word about the agent: a skill, a rule, a flow it works on. */
export interface ProfileChip {
  id: string;
  text: string;
  title?: string;
}
export interface ProfileSection {
  stats: readonly ProfileStat[];
  things: readonly ProfileChip[];
  rules: readonly ProfileChip[];
  /** The model declares nothing for it. */
  blank: boolean;
}
export interface AgentProfile {
  context: ProfileSection;
  tools: ProfileSection;
  memory: ProfileSection;
  mandate: {
    /** The mandate in the model's words; absent when it declares none. */
    summary?: string;
    /** The mandate's own name in the model. */
    title?: string;
    limits: readonly ProfileStat[];
  };
  /** The flows the agent performs. */
  works: readonly ProfileChip[];
}

const statOf = (
  policy: BoardItem,
  entry: BoardValueEntry,
): ProfileStat | undefined =>
  typeof entry.value === "number"
    ? {
      id: `${policy.id}:${entry.name}`,
      // A stat is tight: "24h", not "24 h".
      value: figure(entry.value, entry.name).replace(" ", ""),
      label: humanize(withoutUnit(entry.name.replace(/^max/, "")))
        .toLowerCase(),
      ...(/^max[A-Z]/.test(entry.name) ? { limit: true as const } : {}),
    }
    : undefined;

const ruleOf = (
  policy: BoardItem,
  entry: BoardValueEntry,
): ProfileChip | undefined =>
  typeof entry.value === "number" || isGrantList(entry.value) ? undefined : {
    id: `${policy.id}:${entry.name}`,
    text: `${humanize(entry.name).toLowerCase()}: ${
      readableValue(entry.value, entry.name)
    }`,
  };

function sectionOf(
  items: readonly BoardItem[],
  family: BoardContextFamily,
  withThings: boolean,
): ProfileSection {
  const policies = items.filter((item) =>
    item.kind === "policy" && item.family === family
  );
  const facts = policies.flatMap((policy) =>
    (policy.values ?? []).filter((entry) => !isMasked(entry.name))
      .map((entry) => ({ policy, entry }))
  );
  const things = withThings
    ? items.filter((item) => item.kind === "skill" || item.kind === "tool")
      .map((item) => ({
        id: item.id,
        text: item.title,
        ...(item.summary ? { title: item.summary } : {}),
      }))
    : [];
  const stats = facts.flatMap(({ policy, entry }) =>
    statOf(policy, entry) ?? []
  );
  const rules = facts.flatMap(({ policy, entry }) =>
    ruleOf(policy, entry) ?? []
  );
  return {
    stats,
    things,
    rules,
    blank: policies.length === 0 && things.length === 0,
  };
}

/**
 * The mandate the agent holds. A unit can hold several (the human owner's
 * stands beside the software agent's): the agent's is the one bound to one of
 * its software operators. A mandate that is bound to no operator at all may
 * be anyone's and is kept as a last resort; one a human holds never is.
 */
function mandateOf(
  board: ModelBoard,
  unit: BoardItem | undefined,
  items: readonly BoardItem[],
): BoardItem | undefined {
  const mandates = items.filter((item) => item.kind === "mandate");
  const operators: BoardItem[] = [];
  const collect = (item: BoardItem) => {
    if (item.kind === "operator") operators.push(item);
    item.children?.forEach(collect);
  };
  if (unit) collect(unit);
  const holds = (mandate: BoardItem, operator: BoardItem) =>
    board.links.some((link) =>
      link.kind === "bind" &&
      (link.role === "mandate" || link.role === "holder") &&
      [[link.from, link.to], [link.to, link.from]].some(([a, b]) =>
        (a === mandate.id || a === mandate.element) &&
        (b === operator.id || b === operator.element)
      )
    );
  const human = (operator: BoardItem) => operator.operatorKind === "human";
  return mandates.find((mandate) =>
    operators.some((operator) => !human(operator) && holds(mandate, operator))
  ) ?? mandates.find((mandate) =>
    !operators.some((operator) =>
      human(operator) && holds(mandate, operator)
    )
  );
}

/**
 * What the model declares for one agent: its context, tools and skills, memory,
 * mandate, and the flows it performs. Read-only: the rights it holds and who
 * hands work to whom come from the authority matrix, not from here.
 */
export function profileOf(board: ModelBoard, agentId: string): AgentProfile {
  const items = itemsByScope(board).get(agentId) ?? [];
  const unit = indexBoard(board).units.find((item) => item.id === agentId);
  const mandate = mandateOf(board, unit, items);
  // The limits of the execution policies: what is not a family's own facts.
  const limits = items.filter((item) => item.kind === "policy" && !item.family)
    .flatMap((policy) =>
      (policy.values ?? []).filter((entry) => /^max[A-Z]/.test(entry.name))
        .flatMap((entry) => statOf(policy, entry) ?? [])
    );
  return {
    context: sectionOf(items, "context", false),
    tools: sectionOf(items, "skill", true),
    memory: sectionOf(items, "memory", false),
    mandate: {
      ...(mandate?.summary ? { summary: mandate.summary } : {}),
      ...(mandate ? { title: mandate.title } : {}),
      limits,
    },
    works: items.filter((item) => item.steps?.length).map((item) => ({
      id: item.id,
      text: humanize(item.title),
      ...(item.summary ? { title: item.summary } : {}),
    })),
  };
}
