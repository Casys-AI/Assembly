import type {
  BoardClause,
  BoardColumnId,
  BoardItem,
  BoardPort,
  BoardStep,
  BoardTrackState,
  BoardValue,
  ModelBoard,
} from "../../../src/domain/model/records/board.ts";
import type { RosterEntry } from "../../lib/system/team/projection.ts";
import { type HostFailure, versionedHost } from "./versioned-host.ts";

/**
 * Boards as the host projects them (schema ase.board/1), reduced to what the
 * System pages read. The two models are the host's own: the initial model,
 * whose one unit declares no operator name and no primary contact, and the
 * commercial-watch example, three units that share two tools. Both were
 * checked against the real projector's output (every property they hold is one
 * the strict parser keeps); `KITCHEN_SINK` holds one of every other shape.
 */

export const HEAD = `commit:${"a".repeat(40)}`;
export const OLDER = `commit:${"b".repeat(40)}`;

type Over = Partial<BoardItem>;
const KEYWORDS: Partial<Record<BoardItem["kind"], string>> = {
  scope: "part",
  operator: "part",
  machine: "part",
  skill: "part",
  policy: "part",
  tool: "item",
  mandate: "item",
  capability: "perform action",
};

/** An item of the board with the properties every item has. */
export function item(
  id: string,
  kind: BoardItem["kind"],
  title: string,
  over: Over = {},
): BoardItem {
  return {
    id,
    element: id,
    keyword: KEYWORDS[kind] ?? "part",
    title,
    qname: null,
    file: "model.sysml",
    line: 1,
    kind,
    ...over,
  };
}

/** Values as the host lists them: in order, typed, each on a line of its file. */
export function values(
  declared: Readonly<Record<string, BoardValue>>,
  defines: Readonly<Record<string, string>> = {},
): NonNullable<BoardItem["values"]> {
  return Object.entries(declared).map(([name, value], index) => ({
    name,
    line: index + 1,
    ...(defines[name] ? { defines: defines[name] } : {}),
    value,
  }));
}

export interface UnitSpec {
  id: string;
  title: string;
  /** `operatorName`, `primaryContact`, `humanInputEnabled` and the like. */
  declared?: Readonly<Record<string, BoardValue>>;
  summary?: string;
  /** The element of the unit's software operator: how the runtime names it. */
  operator?: string;
}

/** A unit of the model: its software operator, and the machines around it. */
export function unit(spec: UnitSpec): BoardItem {
  return item(spec.id, "scope", spec.title, {
    qname: `Model::${spec.title}`,
    ...(spec.summary ? { summary: spec.summary } : {}),
    depth: 0,
    open: true,
    values: values({
      envelopeKind: "conversational-case-management",
      ...spec.declared,
    }),
    children: [
      item(spec.operator ?? `${spec.id}.operator`, "operator", "builder", {
        operatorKind: "software",
        depth: 1,
        open: true,
      }),
      item(`${spec.id}.sandbox`, "machine", "testSandbox", { depth: 1 }),
      item(`${spec.id}.catalog`, "machine", "catalog", { depth: 1 }),
    ],
  });
}

export const tool = (
  id: string,
  scope: string,
  title: string,
  summary = "Return the actual nonempty HTML document title and readable text.",
) =>
  item(id, "tool", title, {
    scope,
    summary,
    type: {
      title: "CapabilityContract",
      qname: "ASEExecution::CapabilityContract",
    },
  });

export const skill = (id: string, scope: string, title: string) =>
  item(id, "skill", title, {
    scope,
    summary: "Source bundle:assembly-modeling",
    type: { title: "SkillDefinition", qname: "APESkills::SkillDefinition" },
  });

export const mandate = (id: string, scope: string, summary: string) =>
  item(id, "mandate", "builderMandate", {
    scope,
    summary,
    type: { title: "ConfiguredMandate", qname: "ASECore::ConfiguredMandate" },
  });

/** A policy of a context family, or an execution policy when it has none. */
export function policy(
  id: string,
  scope: string,
  type: string,
  declared: Readonly<Record<string, BoardValue>>,
  family?: "context" | "skill" | "memory",
  defines: Readonly<Record<string, string>> = {},
) {
  return item(id, "policy", type.replace(/^./, (c) => c.toLowerCase()), {
    scope,
    ...(family ? { family } : {}),
    type: { title: type, qname: `Model::${type}` },
    values: values(declared, defines),
  });
}

export const capability = (
  id: string,
  scope: string,
  title: string,
  steps = 0,
) =>
  item(id, "capability", title, {
    scope,
    ...(steps
      ? {
        steps: Array.from({ length: steps }, (_, n) => ({
          id: `${id}.step${n}`,
          kind: "action",
          title: `step ${n + 1}`,
        })),
      }
      : {}),
  });

/** A board with these items in these columns, and none in the others. */
export function board(
  columns: Partial<Record<BoardColumnId, readonly BoardItem[]>>,
  over: {
    digest?: string;
    mode?: "ase" | "generic";
    model?: string;
    /** What the host noted while projecting. */
    diagnostics?: ModelBoard["meta"]["diagnostics"];
  } = {},
): ModelBoard {
  const titles: Record<BoardColumnId, string> = {
    team: "Team",
    cando: "Can do",
    rules: "Rules",
    guarantees: "Guarantees",
    information: "Information",
  };
  return {
    schema: "ase.board/1",
    meta: {
      model: over.model ?? "fixture",
      mode: over.mode ?? "ase",
      sourceDigest: "s".repeat(64),
      diagnostics: over.diagnostics ?? [],
      digest: over.digest ?? "d".repeat(64),
    },
    columns: (Object.keys(titles) as BoardColumnId[]).map((id) => ({
      id,
      title: titles[id],
      rule: {},
      items: columns[id] ?? [],
    })),
    links: [],
    index: {},
  };
}

/** What the runtime calls the operator of the initial model's one unit. */
export const BUILDER = "8605dd44-e5bd-5972-8c31-a7e88130f911";
export const LIVE_BUILDER = "8b3f8667-398d-5c87-9d4b-6a90fc2a4c94";

/**
 * The initial model: one unit, `liveBuilder`, with the human owner and the
 * software builder in it. It declares no operator name and no primary contact:
 * the runtime's roster is all that says who the person talks with.
 */
export function initialBoard(): ModelBoard {
  const id = LIVE_BUILDER;
  const builder = unit({
    id,
    title: "liveBuilder",
    summary:
      "A conversational builder starts alone and proposes candidate capabilities.",
    operator: BUILDER,
    declared: {
      authoritySchema: 2,
      admissionMode: "human",
      networkHosts: "[]",
    },
  });
  const bind = (
    role: "mandate" | "holder",
    from: string,
    to: string,
  ): ModelBoard["links"][number] => ({
    id: `${from}>${role}>${to}`,
    kind: "bind",
    role,
    from,
    to,
    via: null,
    file: "configuration.sysml",
    line: 300,
    exact: true,
  });
  return {
    ...board({
      team: [{
        ...builder,
        qname: "ASELiveBuilder::liveBuilder",
        children: [
          item("owner-operator", "operator", "owner", {
            operatorKind: "human",
            depth: 1,
            open: true,
          }),
          ...builder.children!,
        ],
      }],
      cando: [
        skill("aseModeling", id, "aseModeling"),
        tool("read-web-page", id, "read_web_page"),
        tool("read-web-page-outline", id, "read_web_page_outline"),
        capability("promotion", id, "promotion", 13),
        capability("conversation", id, "conversation", 20),
        capability("reply", id, "reply"),
      ],
      rules: [
        // The owner's mandate comes first: it is the human's, not the agent's.
        item("owner-mandate", "mandate", "ownerMandate", {
          scope: id,
          summary: "Stable authority identity and its revision.",
          summarySource: "type-doc",
          type: { title: "Mandate", qname: "ASEAuthority::Mandate" },
        }),
        mandate(
          "builder-mandate",
          id,
          "Propose read_web_page and read_web_page_outline; invoke active catalog tools",
        ),
        policy("context-policy", id, "DecisionContextPolicy", {
          id: "live-builder-context-v1",
          revision: 1,
          recentMessages: 8,
          maxMessageCharacters: 2000,
          maxCollectionItems: 12,
          maxContextCharacters: 250000,
        }, "context"),
        policy("skill-policy", id, "SkillPolicy", {
          id: "live-builder-skills-v1",
          revision: 1,
          maxInstalledSkills: 32,
          maxLoadedSkills: 4,
          allowedHosts: ["raw.githubusercontent.com"],
        }, "skill"),
        policy("memory-policy", id, "GovernedMemoryPolicy", {
          id: "live-builder-memory-v1",
          revision: 1,
          maxValidityMs: 86_400_000,
          allowedScopes: ["modeling"],
          requireSourceRefs: true,
          allowSelfAdmission: false,
        }, "memory"),
        policy("execution-policy", id, "ExecutionPolicy", {
          id: "live-builder-execution-v1",
          maxAgentDecisions: 12,
          maxToolProposals: 2,
          maxFlowSteps: 256,
          mayAddNetworkHosts: false,
        }),
      ],
    }),
    links: [
      bind("holder", "owner-mandate", "owner-operator"),
      bind("mandate", BUILDER, "builder-mandate"),
      bind("holder", "builder-mandate", BUILDER),
    ],
  };
}

export const COORDINATOR = "unit-coordinator";
export const ANALYST = "unit-analyst";
export const COLLECTOR = "unit-collector";

const EDITING = "ASEModelEditing::ModelEditPolicy::grants";

/**
 * Commercial-watch: a coordinator the person talks with, and two specialists it
 * hands work to. All three use the same two tools; each specialist may edit a
 * root of the model.
 */
export function watchBoard(): ModelBoard {
  const units = [
    unit({
      id: COORDINATOR,
      title: "liveBuilder",
      declared: {
        operatorName: "Coordinateur veille",
        primaryContact: true,
        humanInputEnabled: true,
      },
    }),
    unit({
      id: ANALYST,
      title: "analyst",
      declared: {
        operatorName: "Analyste",
        primaryContact: false,
        humanInputEnabled: false,
      },
    }),
    unit({
      id: COLLECTOR,
      title: "collector",
      declared: {
        operatorName: "Collecteur",
        primaryContact: false,
        humanInputEnabled: false,
      },
    }),
  ];
  const tools = units.flatMap((u) => [
    tool(`${u.id}.read`, u.id, "read_web_page"),
    tool(`${u.id}.outline`, u.id, "read_web_page_outline"),
  ]);
  return board({
    team: units,
    cando: [
      ...tools,
      capability(`${COORDINATOR}.promotion`, COORDINATOR, "promotion", 4),
    ],
    rules: [
      mandate(
        `${COORDINATOR}.mandate`,
        COORDINATOR,
        "Planifier les travaux exposés et réintégrer leurs résultats",
      ),
      mandate(
        `${ANALYST}.mandate`,
        ANALYST,
        "Qualifier les sources collectées",
      ),
      policy(`${COORDINATOR}.context`, COORDINATOR, "DecisionContextPolicy", {
        recentMessages: 8,
      }, "context"),
      policy(`${ANALYST}.memory`, ANALYST, "GovernedMemoryPolicy", {
        maxValidityMs: 3_600_000,
      }, "memory"),
      policy(`${ANALYST}.execution`, ANALYST, "ExecutionPolicy", {
        maxAgentDecisions: 12,
        maxToolProposals: 2,
      }),
      policy(
        `${ANALYST}.editing`,
        ANALYST,
        "ModelEditPolicy",
        {
          grants: [{
            file: "mission.sysml",
            qualifiedRoots: ["CommercialWatchMission::qualificationPolicy"],
          }],
        },
        undefined,
        { grants: EDITING },
      ),
      policy(
        `${COLLECTOR}.editing`,
        COLLECTOR,
        "ModelEditPolicy",
        {
          grants: [{
            file: "mission.sysml",
            qualifiedRoots: ["CommercialWatchMission::sourcePolicy"],
          }],
        },
        undefined,
        { grants: EDITING },
      ),
    ],
  });
}

/** The words the host gives the links of a model, as the real board carries them. */
export const LINK_LABELS: NonNullable<ModelBoard["meta"]["linkLabels"]> = {
  allocate: { forward: "performed by", reverse: "performs" },
  connect: { forward: "connected to", reverse: "connected to" },
  "bind:mandate": { forward: "holds mandate", reverse: "mandate of" },
  "bind:holder": { forward: "held by", reverse: "holds" },
  "can-call": { forward: "may call", reverse: "callable by", derived: true },
  perform: { forward: "performs", reverse: "performed within" },
  satisfy: { forward: "satisfies", reverse: "satisfied by" },
  constrain: { forward: "constrains", reverse: "constrained by" },
  own: { forward: "contains", reverse: "contained in" },
};

/** A link of the board between two ids, with the properties every link has. */
export function link(
  kind: ModelBoard["links"][number]["kind"],
  from: string,
  to: string,
  over: Partial<ModelBoard["links"][number]> = {},
): ModelBoard["links"][number] {
  return {
    id: `${from}>${kind}>${to}`,
    kind,
    from,
    to,
    via: null,
    file: "configuration.sysml",
    line: 10,
    exact: true,
    ...over,
  };
}

/** The board with these links, and the host's words for them unless told otherwise. */
export function withLinks(
  source: ModelBoard,
  links: ModelBoard["links"],
  labels: ModelBoard["meta"]["linkLabels"] = LINK_LABELS,
): ModelBoard {
  return {
    ...source,
    meta: { ...source.meta, linkLabels: labels },
    links,
  };
}

/**
 * Commercial-watch with the links between what it declares. The operator of a
 * unit is the part inside it that calls its tools, holds its mandate and
 * performs the steps of its flow; links that say nothing a person asked for
 * (a unit owning its parts, a unit performing what it holds) are there too.
 */
export function linkedBoard(): ModelBoard {
  const operator = (unit: string) => `${unit}.operator`;
  return withLinks(watchBoard(), [
    link("perform", COORDINATOR, `${COORDINATOR}.promotion`, {
      strength: "scope",
    }),
    link("own", COORDINATOR, operator(COORDINATOR), { strength: "direct" }),
    link("can-call", operator(COORDINATOR), `${COORDINATOR}.read`, {
      derived: true,
    }),
    link("can-call", operator(ANALYST), `${ANALYST}.read`, { derived: true }),
    link("bind", operator(COORDINATOR), `${COORDINATOR}.mandate`, {
      role: "mandate",
    }),
    link("allocate", `${COORDINATOR}.promotion.step0`, operator(COORDINATOR)),
    link("connect", `${COORDINATOR}.sandbox`, `${COORDINATOR}.catalog`),
  ]);
}

/** A clause of a requirement, as the projector lists it. */
export const clause = (
  id: string,
  title: string,
  expression?: string,
): BoardClause => ({
  id,
  element: id,
  keyword: "require constraint",
  title,
  qname: `Model::${title}`,
  file: "requirements.sysml",
  line: 5,
  ...(expression ? { expression } : {}),
});

/** A requirement of the guarantees column, satisfied by these units. */
export const requirement = (
  id: string,
  title: string,
  over: Over = {},
) =>
  item(id, "requirement", title, {
    keyword: "requirement",
    file: "requirements.sysml",
    ...over,
  });

/** A constraint, in force or not. */
export const constraint = (
  id: string,
  title: string,
  inForce: boolean,
  over: Over = {},
) =>
  item(id, "constraint", title, {
    keyword: "constraint",
    file: "requirements.sysml",
    inForce,
    ...over,
  });

/**
 * What the Requirements page lays out, with one of every state: a requirement
 * several units answer for, one a single unit answers for, one nobody answers
 * for, a constraint in force and one nothing performs, and a lifecycle, which
 * is not a requirement. Two units, so that "owners" can be counted.
 */
export function guaranteeBoard(): ModelBoard {
  return withLinks(
    board({
      team: [
        unit({ id: COORDINATOR, title: "liveBuilder" }),
        unit({ id: ANALYST, title: "analyst" }),
      ],
      cando: [
        capability(`${COORDINATOR}.promotion`, COORDINATOR, "promotion", 2),
      ],
      guarantees: [
        requirement("req.exact", "ExactReviewedCandidate", {
          summary:
            "Activation requires approval for the same candidate digest.",
          satisfiedBy: [COORDINATOR, ANALYST],
          clauses: [
            clause(
              "req.exact.same",
              "sameReviewedBytes",
              "activationRequested implies review.approved",
            ),
            clause("req.exact.fresh", "freshReview"),
          ],
        }),
        requirement("req.fail", "FailClosedPromotion", {
          summary: "A refused candidate remains outside the active catalog.",
          satisfiedBy: [COORDINATOR],
        }),
        requirement("req.orphan", "ActiveOnlyCallable", {
          summary: "A later invocation resolves an active candidate.",
          satisfiedBy: [],
          clauses: [clause("req.orphan.gate", "invocationGate", "active")],
        }),
        requirement("req.plain", "NamedOnly"),
        constraint("chk.live", "testedAdmission", true, {
          owner: {
            title: "ConfiguredAdmission",
            qname: "ASELiveBuilder::ConfiguredAdmission",
          },
          expression: "decision.admitted implies tests.passed",
        }),
        constraint("chk.idle", "exactAdmission", false, {
          type: {
            title: "AdmitCandidate",
            qname: "APEPromotion::AdmitCandidate",
          },
          expression: "decision.admitted and exactBytesUnchanged",
        }),
        item("life", "lifecycle", "AdmissionLifecycle", {
          track: { mainCount: 0, transitions: 0, states: [] },
        }),
      ],
    }),
    [
      link("satisfy", COORDINATOR, "req.exact"),
      link("satisfy", ANALYST, "req.exact"),
      link("constrain", "chk.live", `${COORDINATOR}.promotion.step0`),
    ],
  );
}

/** A port of a part, as the projector lists it. */
export const port = (
  id: string,
  title: string,
  over: Partial<BoardPort> = {},
): BoardPort => ({
  id,
  element: id,
  keyword: "port",
  title,
  qname: `Model::${title}`,
  file: "structure.sysml",
  line: 12,
  conjugated: false,
  inherited: false,
  items: [],
  ...over,
});

/**
 * Commercial-watch with its structure told: the coordinator's operator hands
 * candidates to a sandbox (a part with a part nested in it), which hands its
 * results nowhere (an open port), and the catalog is reached by a connection
 * the board counts only as a `connect` link. The analyst declares no port.
 */
export function structuredBoard(): ModelBoard {
  const base = watchBoard();
  const operator = `${COORDINATOR}.operator`;
  const sandbox = `${COORDINATOR}.sandbox`;
  const catalog = `${COORDINATOR}.catalog`;
  const candidate = {
    dir: "out",
    title: "candidate",
    type: "CandidateIdentity",
  };
  const team = base.columns.find((column) => column.id === "team")!.items.map(
    (unit) =>
      unit.id !== COORDINATOR ? unit : {
        ...unit,
        summary: "Plans the work and hands it on.",
        children: unit.children!.map((part) => {
          if (part.id === operator) {
            return {
              ...part,
              summary: "The software operator.",
              ports: [port(`${operator}.proposals`, "proposals", {
                type: {
                  title: "CandidatePort",
                  qname: "ASECore::CandidatePort",
                },
                items: [candidate],
                linked: 1,
              })],
            };
          }
          if (part.id === sandbox) {
            return {
              ...part,
              ports: [
                port(`${sandbox}.proposals`, "proposals", {
                  type: {
                    title: "CandidatePort",
                    qname: "ASECore::CandidatePort",
                  },
                  conjugated: true,
                  items: [{ ...candidate, dir: "in" }],
                  linked: 1,
                }),
                port(`${sandbox}.results`, "results", {
                  items: [{ dir: "out", title: "result", type: "TestResult" }],
                }),
              ],
              children: [
                item(`${sandbox}.runner`, "machine", "runner", {
                  summary: "Runs the candidate.",
                  depth: 2,
                  ports: [port(`${sandbox}.runner.runs`, "runs")],
                }),
              ],
            };
          }
          return part.id === catalog
            ? {
              ...part,
              ports: [port(`${catalog}.candidates`, "candidates", {
                conjugated: true,
                items: [{ ...candidate, dir: "in" }],
              })],
            }
            : part;
        }),
      },
  );
  return withLinks({
    ...base,
    columns: base.columns.map((column) =>
      column.id === "team" ? { ...column, items: team } : column
    ),
  }, [
    link("connect", `${operator}.proposals`, `${sandbox}.proposals`),
    link("connect", `${sandbox}.runner.runs`, `${catalog}.candidates`),
  ]);
}

/**
 * Commercial-watch with what each flow is allocated to: steps of the
 * coordinator's promotion go to its operator and its sandbox, one goes to the
 * analyst's operator (a performer of another unit), the analyst's whole `reply`
 * action goes to its operator, and two ends the board cannot place: an element
 * it does not hold, and a machine no unit claims.
 */
export function allocatedBoard(): ModelBoard {
  const base = watchBoard();
  const promotion = `${COORDINATOR}.promotion`;
  const loose = item("loose", "machine", "looseMachine");
  return withLinks({
    ...base,
    columns: base.columns.map((column) =>
      column.id === "cando"
        ? {
          ...column,
          items: [
            ...column.items,
            capability(`${ANALYST}.reply`, ANALYST, "reply"),
          ],
        }
        : column.id === "information"
        ? { ...column, items: [loose] }
        : column
    ),
  }, [
    link("allocate", `${promotion}.step0`, `${COORDINATOR}.operator`),
    link("allocate", `${promotion}.step1`, `${COORDINATOR}.operator`),
    link("allocate", `${promotion}.step2`, `${COORDINATOR}.sandbox`),
    link("allocate", `${promotion}.step3`, `${ANALYST}.operator`),
    link("allocate", `${ANALYST}.reply`, `${ANALYST}.operator`),
    link("allocate", "ghost", `${ANALYST}.operator`),
    link("allocate", `${promotion}.step1`, "loose"),
  ]);
}

/**
 * A step of a flow, as the projector lists it: its id is the flow's card and
 * its element, which a flow declared in several units shares among its twins.
 */
export const flowStep = (
  flow: string,
  key: string,
  kind: string,
  title: string,
  over: Partial<BoardStep> = {},
): BoardStep => ({
  id: `${flow}#${key}`,
  element: key,
  kind,
  keyword: kind === "action" ? "action" : kind === "decision" ? "decide" : kind,
  title,
  depth: 0,
  qname: `Model::${title}`,
  file: "flows.sysml",
  line: 10,
  ...over,
});

/** A jump to a step the thread reaches elsewhere; it names where it goes. */
export const flowGoto = (
  flow: string,
  from: string,
  to: string,
  depth: number,
  over: Partial<BoardStep> = {},
): BoardStep => ({
  id: `${flow}#goto:${from}`,
  element: from,
  kind: "goto",
  depth,
  to: `${flow}#${to}`,
  toTitle: to,
  forward: true,
  ...over,
});

/** The end of a flow: the library's own, with no element behind it. */
export const flowEnd = (flow: string): BoardStep => ({
  id: `${flow}#@done`,
  kind: "end",
  title: "done",
  depth: 0,
});

/**
 * The promotion flow of the real model, in the projector's order: two steps,
 * a decision whose first branch holds a step and a decision of its own, whose
 * second branch holds only a jump, two merges that jumps lead to, a step that
 * loops back to the first, and the end.
 */
export function promotionSteps(flow: string): BoardStep[] {
  const step = (key: string, kind: string, title: string, over = {}) =>
    flowStep(flow, key, kind, title, over);
  return [
    step("propose", "action", "propose", {
      type: { title: "ProposeCandidate", qname: "APEPromotion::Propose" },
    }),
    step("test", "action", "test"),
    step("testOutcome", "decision", "testOutcome"),
    step("admit", "action", "admit", {
      depth: 1,
      branch: "if",
      guard: "test.result.passed",
    }),
    step("admissionOutcome", "decision", "admissionOutcome", { depth: 1 }),
    step("activate", "action", "activate", {
      depth: 2,
      branch: "if",
      guard: "admit.decision.admitted",
    }),
    flowGoto(flow, "afterActivate", "completion", 2),
    flowGoto(flow, "afterRefusedAdmission", "refusal", 2, { branch: "else" }),
    flowGoto(flow, "afterRefusedTests", "refusal", 1, { branch: "else" }),
    step("refusal", "merge", "refusal"),
    step("refuse", "action", "refuse", {
      loops: [{ to: `${flow}#propose`, toTitle: "propose" }],
    }),
    step("completion", "merge", "completion"),
    flowEnd(flow),
  ];
}

/**
 * The states of the admission lifecycle, in the projector's order: the states
 * the lifecycle goes through by rank, the one this model adds beside
 * `reviewing`, then the ends. `proposed` is where it starts.
 */
export function admissionStates(life: string): BoardTrackState[] {
  const id = (name: string) => `${life}#${name}`;
  const out = (
    from: string,
    on: string,
    to: string,
    over: Partial<BoardTrackState["out"][number]> = {},
  ): BoardTrackState["out"][number] => ({
    id: `${life}#${from}-${on}`,
    element: `${from}-${on}`,
    name: null,
    on,
    guard: null,
    to: id(to),
    toTitle: to,
    back: false,
    inherited: true,
    file: "lifecycle.sysml",
    line: 26,
    ...over,
  });
  const state = (
    name: string,
    rank: number | null,
    transitions: BoardTrackState["out"],
    over: Partial<BoardTrackState> = {},
  ): BoardTrackState => ({
    id: id(name),
    element: name,
    keyword: "state",
    title: name,
    qname: `Model::${name}`,
    file: "lifecycle.sysml",
    line: 20,
    col: 3,
    rank,
    initial: false,
    terminal: transitions.length === 0,
    inherited: true,
    out: transitions,
    ...over,
  });
  return [
    state("proposed", 0, [out("proposed", "TestingStarted", "testing")], {
      initial: true,
    }),
    state("testing", 1, [out("testing", "TestsPassed", "reviewing")]),
    state("reviewing", 2, [
      out("reviewing", "AdmissionAccepted", "activating"),
      out("reviewing", "ReviewRefused", "refused"),
    ]),
    state("awaiting-admission", 2, [
      out("awaiting-admission", "HumanAdmissionAccepted", "activating", {
        guard: "owner.present",
        inherited: false,
      }),
    ], { inherited: false }),
    state("activating", 3, [
      out("activating", "ActivationCompleted", "active"),
    ]),
    state("active", 4, []),
    state("refused", 3, []),
  ];
}

/**
 * Two units that each declare the promotion flow (twins: the same flow, its
 * own steps), the coordinator's conversation flow that loops, and the
 * admission lifecycle every unit shares. Steps are allocated: the
 * coordinator's `propose` to its operator and `test` to its sandbox, the
 * analyst's `propose` to its own operator, and `admit` of both by the
 * Toolkit's id of the step to the coordinator's catalog (a performer of the
 * coordinator's unit: the analyst's twin must not borrow it). One allocation
 * ends at an element the board does not hold.
 */
export function flowBoard(): ModelBoard {
  const flow = (unitId: string) => `${unitId}.promotion`;
  const promotion = (unitId: string) =>
    item(flow(unitId), "capability", "promotion", {
      scope: unitId,
      keyword: "perform action",
      summary: "Propose a candidate, test it, admit it, activate it.",
      type: { title: "CapabilityPromotion", qname: "APEPromotion::Promotion" },
      steps: promotionSteps(flow(unitId)),
    });
  const conversation = `${COORDINATOR}.conversation`;
  const base = watchBoard();
  const life = "life";
  return withLinks({
    ...base,
    columns: base.columns.map((column) =>
      column.id === "cando"
        ? {
          ...column,
          items: [
            ...column.items.filter((entry) => entry.kind !== "capability"),
            promotion(COORDINATOR),
            promotion(ANALYST),
            item(conversation, "capability", "conversation", {
              scope: COORDINATOR,
              keyword: "perform action",
              steps: [
                flowStep(conversation, "resume", "merge", "resumeCase"),
                flowStep(conversation, "wait", "action", "waitForInput", {
                  loops: [{
                    to: `${conversation}#resume`,
                    toTitle: "resumeCase",
                  }],
                }),
                flowEnd(conversation),
              ],
            }),
          ],
        }
        : column.id === "guarantees"
        ? {
          ...column,
          items: [
            item(life, "lifecycle", "AdmissionCandidateLifecycle", {
              keyword: "state",
              track: {
                initial: `${life}#proposed`,
                mainCount: 5,
                transitions: 8,
                extends: {
                  title: "CandidateLifecycle",
                  qname: "ASELifecycle::CandidateLifecycle",
                },
                states: admissionStates(life),
              },
            }),
          ],
        }
        : column
    ),
  }, [
    link("allocate", `${flow(COORDINATOR)}#propose`, `${COORDINATOR}.operator`),
    link("allocate", `${flow(COORDINATOR)}#test`, `${COORDINATOR}.sandbox`),
    link("allocate", `${flow(ANALYST)}#propose`, `${ANALYST}.operator`),
    link("allocate", "admit", `${COORDINATOR}.catalog`),
    link("allocate", `${flow(COORDINATOR)}#refuse`, "ghost"),
  ]);
}

/** A model of `count` units, each its own agent, for a team too large to draw. */
export function crowdBoard(count: number): ModelBoard {
  const units = Array.from({ length: count }, (_, n) =>
    unit({
      id: `unit-${n + 1}`,
      title: `agent${n + 1}`,
      declared: {
        operatorName: `Agent ${n + 1}`,
        primaryContact: n === 0,
        humanInputEnabled: n === 0,
      },
    }));
  return board({
    team: units,
    cando: units.map((u) => tool(`${u.id}.read`, u.id, "read_web_page")),
  });
}

/** The runtime's view of an operator: what the roster says of it. */
export function rosterEntry(
  nativeId: string,
  over: Partial<RosterEntry> = {},
): RosterEntry {
  return {
    nativeId,
    name: "Concepteur",
    primary: true,
    canSend: true,
    busy: false,
    ...over,
  };
}

/** Every other shape the contract has, once: for the parser to meet them all. */
export function kitchenSink(): ModelBoard {
  const flowing = item("flow", "capability", "promotion", {
    scope: LIVE_BUILDER,
    steps: [
      {
        id: "s1",
        kind: "decision",
        depth: 0,
        branch: "a",
        guard: "ok",
        loops: [{ to: "s0", toTitle: "start" }],
      },
      {
        id: "s2",
        kind: "action",
        element: "e2",
        title: "go",
        type: { title: "Go", qname: "M::Go" },
        unreachable: false,
      },
    ],
    io: [{ dir: "in", title: "request", type: "Request", element: "io1" }],
    flow: {
      nodes: 2,
      edges: 1,
      back: 0,
      supplemented: 0,
      unresolved: 0,
      sequential: true,
      summary: {
        steps: 2,
        decisions: 1,
        merges: 0,
        forks: 0,
        loops: 1,
        unreachable: 0,
      },
    },
    access: [{
      access: "acc",
      title: "Read",
      caller: "builder",
      enabled: true,
    }],
    group: [{ element: "g", title: "Group" }],
  });
  const lifecycle = item("life", "lifecycle", "Lifecycle", {
    track: {
      initial: "st1",
      mainCount: 1,
      transitions: 1,
      extends: { title: "Base", qname: "M::Base" },
      states: [{
        id: "st1",
        element: "st1",
        keyword: "state",
        title: "idle",
        qname: "M::idle",
        file: "model.sysml",
        line: 1,
        col: 1,
        rank: null,
        initial: true,
        terminal: false,
        inherited: false,
        out: [{
          id: "t1",
          element: "t1",
          name: null,
          on: "go",
          guard: null,
          to: "st1",
          toTitle: "idle",
          back: true,
          inherited: false,
          file: "model.sysml",
          line: 2,
        }],
      }],
    },
  });
  const requirement = item("req", "requirement", "Requirement", {
    subject: { title: "Subject", qname: "M::Subject" },
    satisfiedBy: [LIVE_BUILDER],
    expression: null,
    inForce: true,
    clauses: [{
      id: "c1",
      element: "c1",
      keyword: "require",
      title: "limit",
      qname: "M::limit",
      file: "model.sysml",
      line: 3,
      expression: "a < b",
    }],
  });
  const panel = item("panel", "scope", "panel", {
    ports: [{
      id: "p1",
      element: "p1",
      keyword: "port",
      title: "out",
      qname: "M::out",
      file: "model.sysml",
      line: 4,
      conjugated: false,
      inherited: false,
      items: [{ dir: "out", title: "result", type: "Result" }],
      linked: 1,
      type: { title: "Port", qname: "M::Port" },
    }],
    owner: { title: "Owner", qname: "M::Owner" },
    definition: true,
    titleSource: "name",
    summarySource: "doc",
    col: 5,
  });
  return {
    ...board({
      team: [panel],
      cando: [flowing],
      rules: [
        policy(
          "editing",
          LIVE_BUILDER,
          "ModelEditPolicy",
          {
            grants: [{ file: "a.sysml", qualifiedRoots: ["A::b", "A::c"] }],
            operations: ["set-value", "rename"],
            enabled: true,
            ratio: 0.5,
            nothing: [],
          },
          undefined,
          { grants: EDITING },
        ),
      ],
      guarantees: [lifecycle, requirement],
    }),
    links: [{
      id: "l1",
      kind: "bind",
      role: "caller",
      from: "a",
      to: "b",
      via: null,
      file: "model.sysml",
      line: 6,
      exact: true,
      derived: false,
      enabled: true,
      strength: "scope",
    }],
    index: { a: { column: "team", card: "panel" } },
  };
}

export interface BoardHostOptions {
  /** The commit the head is at; the boards by commit. */
  head?: string;
  boards?: Readonly<Record<string, ModelBoard>>;
  /** Answers the next reads with this failure instead, as the host would. */
  fail?: HostFailure;
  /** Holds each read until released: for reads that overlap. */
  gate?: (n: number) => Promise<void> | undefined;
}

/** The host's board route: a `fetch` that answers as it does, and what it was asked. */
export function boardHost(options: BoardHostOptions = {}) {
  const host = versionedHost({
    path: "/api/model/board",
    recovery: "Read the board again.",
    head: options.head ?? HEAD,
    bodies: options.boards ?? { [HEAD]: initialBoard() },
    fail: options.fail,
    gate: options.gate,
  });
  return {
    fetch: host.fetch,
    requests: host.requests,
    state: host.state,
    boards: host.bodies,
  };
}
