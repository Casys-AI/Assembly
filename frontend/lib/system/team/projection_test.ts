import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  ANALYST,
  board,
  BUILDER,
  capability,
  COLLECTOR,
  COORDINATOR,
  crowdBoard,
  initialBoard,
  item,
  link,
  LIVE_BUILDER,
  mandate,
  policy,
  rosterEntry,
  skill,
  tool,
  unit,
  values,
  watchBoard,
  withLinks,
} from "../../../test/support/board-fixture.ts";
import { factsOf } from "../board/detail.ts";
import { indexBoard } from "../board/lookup.ts";
import {
  agentsByOperator,
  agentsOnly,
  profileOf,
  resourceTitle,
  shownAgent,
  teamOf,
  YOU,
} from "./projection.ts";

const labels = (team: ReturnType<typeof teamOf>) =>
  team.resources.map((resource) =>
    `${resource.kind}:${resource.label}${
      resource.agents.length > 1 ? ` ×${resource.agents.length}` : ""
    }`
  );

Deno.test("Case Team labels only its exact inherited Main owner as Branch Operator and preserves global, custom and sub-operator names", () => {
  const modeled = board({
    team: [
      unit({
        id: "owner-unit",
        title: "Owner",
        operator: "owner-op",
        declared: { operatorName: "Main Operator" },
      }),
      unit({
        id: "peer-unit",
        title: "Peer",
        operator: "peer-op",
        declared: { operatorName: "Main Operator" },
      }),
      unit({
        id: "custom-unit",
        title: "Custom",
        operator: "custom-op",
        declared: { operatorName: "Researcher" },
      }),
    ],
  });
  const before = structuredClone(modeled);
  const global = teamOf(modeled);
  deepStrictEqual(global.agents.map((agent) => agent.name), [
    "Main Operator",
    "Main Operator",
    "Researcher",
  ]);
  const scoped = teamOf(modeled, [], "owner-op");
  deepStrictEqual(scoped, {
    ...global,
    agents: global.agents.map((agent) =>
      agent.id === "owner-unit"
        ? {
          ...agent,
          name: "Branch Operator",
          nameSource: "request-context",
          branch: true,
        }
        : agent
    ),
  });
  // A custom-named owner keeps its name, and is still the Case's own unit.
  deepStrictEqual(teamOf(modeled, [], "custom-op"), {
    ...global,
    agents: global.agents.map((agent) =>
      agent.id === "custom-unit" ? { ...agent, branch: true } : agent
    ),
  });
  deepStrictEqual(teamOf(modeled, [], "unknown"), global);
  deepStrictEqual(modeled, before);

  // The same exact match also holds when the inherited generic name comes
  // from the scoped runtime roster instead of the board's declaration.
  const unnamed = board({
    team: [unit({ id: "u", title: "Unit", operator: "op" })],
  });
  const roster = [
    rosterEntry("op", {
      name: "Main Operator",
      primary: false,
      canSend: false,
    }),
  ];
  const originalRoster = structuredClone(roster);
  equal(teamOf(unnamed, roster).agents[0].name, "Main Operator");
  const branch = teamOf(unnamed, roster, "op").agents[0];
  equal(branch.name, "Branch Operator");
  equal(branch.contact, "indirect");
  deepStrictEqual(branch.nativeIds, ["op"]);
  deepStrictEqual(roster, originalRoster);
});

Deno.test("an operator identity resolves to its agent, the Case owner to its branch name, and nothing else", () => {
  const modeled = board({
    team: [
      unit({
        id: "owner-unit",
        title: "Owner",
        operator: "owner-op",
        declared: { operatorName: "Main Operator" },
      }),
      unit({
        id: "custom-unit",
        title: "Custom",
        operator: "custom-op",
        declared: { operatorName: "Researcher" },
      }),
    ],
  });
  const agents = agentsByOperator(modeled, [], "owner-op", "Lothvane Tyrolis");
  deepStrictEqual(
    ["owner-op", "custom-op"].map((id) => [
      agents.get(id)?.id,
      agents.get(id)?.name,
    ]),
    [["owner-unit", "Lothvane Tyrolis"], ["custom-unit", "Researcher"]],
  );
  equal(agents.get("former-op"), undefined);
});

Deno.test("the initial model's one unit is one agent, named by the model when it names it and by nothing made up when not", () => {
  const team = teamOf(initialBoard());
  equal(team.agents.length, 1);
  const [agent] = team.agents;
  equal(agent.id, LIVE_BUILDER);
  // The model declares no operator name: the unit's own title, nothing else.
  equal(agent.name, "liveBuilder");
  equal(agent.nameSource, "unit");
  equal(agent.qname, "ASELiveBuilder::liveBuilder");
  // Neither the model nor a runtime says whom the person talks with.
  equal(agent.contact, "undeclared");
  equal(agent.busy, false);
  deepStrictEqual(agent.nativeIds, []);
  equal(team.talks, false);
  ok(!team.edges.some((edge) => edge.kind === "talk"));
});

Deno.test("the roster joins the unit by the native id of its operator: who the person talks with, and who is busy", () => {
  const roster = [rosterEntry(BUILDER, { busy: true })];
  const team = teamOf(initialBoard(), roster);
  const [agent] = team.agents;
  // The runtime's name for the operator, since the model gives none.
  equal(agent.name, "Concepteur");
  equal(agent.nameSource, "roster");
  equal(agent.contact, "direct");
  equal(agent.busy, true);
  deepStrictEqual(agent.nativeIds, [BUILDER]);
  equal(team.talks, true);
  deepStrictEqual(
    team.edges.filter((edge) => edge.kind === "talk").map((edge) => [
      edge.id,
      edge.from,
      edge.to,
    ]),
    [[`${YOU}>${LIVE_BUILDER}`, YOU, LIVE_BUILDER]],
  );
  // The unit's own id and the other operator's, the human owner's, join too.
  for (const nativeId of [LIVE_BUILDER, "owner-operator"]) {
    deepStrictEqual(
      teamOf(initialBoard(), [rosterEntry(nativeId)]).agents[0].nativeIds,
      [nativeId],
    );
  }
  // An entry that is no operator of the unit joins nothing.
  const other = teamOf(initialBoard(), [rosterEntry("native:elsewhere")]);
  equal(other.agents[0].nameSource, "unit");
  equal(other.agents[0].contact, "undeclared");
  deepStrictEqual(other.agents[0].nativeIds, []);
});

Deno.test("what the runtime says of an operator wins over what the model declares, and the model speaks when the runtime does not know it", () => {
  const declared = (primary: boolean, human: boolean) =>
    board({
      team: [unit({
        id: "u",
        title: "u",
        operator: "op",
        declared: {
          operatorName: "Modeled",
          primaryContact: primary,
          humanInputEnabled: human,
        },
      })],
    });
  // The model says the person talks with it; the runtime says it cannot take a message.
  const refuses = teamOf(declared(true, true), [
    rosterEntry("op", { primary: true, canSend: false }),
  ]);
  equal(refuses.agents[0].contact, "indirect");
  equal(
    teamOf(declared(true, true), [rosterEntry("op", { primary: false })])
      .agents[0].contact,
    "indirect",
  );
  // The model says it does not; the runtime says it does.
  equal(
    teamOf(declared(false, false), [rosterEntry("op")]).agents[0].contact,
    "direct",
  );
  // The model's own name stays the name, whatever the roster calls it.
  equal(
    teamOf(declared(false, false), [rosterEntry("op")]).agents[0].name,
    "Modeled",
  );
  equal(
    teamOf(declared(false, false), [rosterEntry("op")]).agents[0].nameSource,
    "model",
  );
  // No roster entry: the model's two declarations.
  equal(teamOf(declared(true, true)).agents[0].contact, "direct");
  equal(teamOf(declared(false, false)).agents[0].contact, "indirect");
  equal(teamOf(declared(false, true)).agents[0].contact, "indirect");
  // Primary but closed to human input is not someone the person talks with.
  equal(teamOf(declared(true, false)).agents[0].contact, "undeclared");
  // A declaration that is not a boolean is no declaration.
  const text = board({
    team: [unit({
      id: "t",
      title: "t",
      declared: { primaryContact: "true", humanInputEnabled: "true" },
    })],
  });
  equal(teamOf(text).agents[0].contact, "undeclared");
});

Deno.test("several runtime operators of one unit are one agent: it talks with the person if any does, works if any does", () => {
  const unitWithTwo = board({
    team: [{
      ...unit({ id: "u", title: "u", operator: "first" }),
      children: [
        item("first", "operator", "first", { operatorKind: "software" }),
        item("second", "operator", "second", { operatorKind: "software" }),
      ],
    }],
  });
  const team = teamOf(unitWithTwo, [
    rosterEntry("first", { name: "First", primary: false, canSend: false }),
    rosterEntry("second", { name: "Second", busy: true }),
  ]);
  equal(team.agents.length, 1);
  equal(team.agents[0].contact, "direct");
  equal(team.agents[0].busy, true);
  // The name is the one the person talks with.
  equal(team.agents[0].name, "Second");
  deepStrictEqual(team.agents[0].nativeIds, ["first", "second"]);
});

Deno.test("what an agent works with is what the model declares in its scope: skills, tools, policies of a family, and the roots it may edit", () => {
  const team = teamOf(initialBoard());
  deepStrictEqual(labels(team), [
    "skill:aseModeling",
    "tool:read_web_page",
    "tool:read_web_page_outline",
    "context:Decision context policy",
    "skill:Skill policy",
    "memory:Governed memory policy",
  ]);
  // An execution policy has no family: it is a limit of the mandate, not a thing.
  ok(!labels(team).some((label) => label.includes("Execution")));
  // Every resource is an edge of the agent, said by how the agent relates to it.
  deepStrictEqual(
    team.edges.map((edge) => [edge.from, edge.to, edge.title]),
    [
      [LIVE_BUILDER, "skill:APESkills::SkillDefinition", "has"],
      [LIVE_BUILDER, "tool:read_web_page", "has"],
      [LIVE_BUILDER, "tool:read_web_page_outline", "has"],
      [LIVE_BUILDER, "context:Model::DecisionContextPolicy", "sees"],
      [LIVE_BUILDER, "skill:Model::SkillPolicy", "loads"],
      [LIVE_BUILDER, "memory:Model::GovernedMemoryPolicy", "keeps"],
    ],
  );
});

Deno.test("a thing several agents use is one resource, counted; each root an agent may edit is its own", () => {
  const team = teamOf(watchBoard());
  deepStrictEqual(labels(team), [
    "tool:read_web_page ×3",
    "tool:read_web_page_outline ×3",
    "context:Decision context policy",
    "memory:Governed memory policy",
    "information:qualificationPolicy",
    "information:sourcePolicy",
  ]);
  const shared = team.resources[0];
  deepStrictEqual(shared.agents.map((use) => use.agentId), [
    COORDINATOR,
    ANALYST,
    COLLECTOR,
  ]);
  // What the tooltip says: who works with it, and how, by name.
  equal(
    resourceTitle(team, shared),
    "Coordinateur veille has\nAnalyste has\nCollecteur has",
  );
  const edited = team.resources.find((resource) =>
    resource.label === "qualificationPolicy"
  )!;
  equal(resourceTitle(team, edited), "Analyste may propose edits");
  // One edge for each use: three agents, one tool, three edges.
  equal(
    team.edges.filter((edge) => edge.to === "tool:read_web_page").length,
    3,
  );
});

Deno.test("legacy and Assembly grant policies keep their distinct edit and administration labels", () => {
  for (const family of ["ASE", "Assembly"]) {
    const model = board({
      team: [unit({ id: "u", title: "Operator" })],
      rules: [
        policy(
          "edit",
          "u",
          "ModelEditPolicy",
          {
            grants: [{
              file: "model.sysml",
              qualifiedRoots: ["Model::editable"],
            }],
          },
          undefined,
          {
            grants: `${family}ModelEditing::ModelEditPolicy::grants`,
          },
        ),
        policy(
          "admin",
          "u",
          "ModelAdministrationPolicy",
          {
            grants: [{
              file: "model.sysml",
              qualifiedRoots: ["Model::managed"],
            }],
          },
          undefined,
          {
            grants:
              `${family}ModelAdministration::ModelAdministrationPolicy::grants`,
          },
        ),
      ],
    });
    const team = teamOf(model);
    deepStrictEqual(
      team.resources.map((
        resource,
      ) => [resource.label, resourceTitle(team, resource)]),
      [
        ["editable", "Operator may propose edits"],
        ["managed", "Operator may administer"],
      ],
      family,
    );
  }
});

Deno.test("only the coordinator talks with the person; the specialists are known not to be in direct contact", () => {
  const team = teamOf(watchBoard());
  deepStrictEqual(
    team.agents.map((agent) => [agent.name, agent.nameSource, agent.contact]),
    [
      ["Coordinateur veille", "model", "direct"],
      ["Analyste", "model", "indirect"],
      ["Collecteur", "model", "indirect"],
    ],
  );
  equal(team.talks, true);
  deepStrictEqual(
    team.edges.filter((edge) => edge.kind === "talk").map((edge) => edge.to),
    [COORDINATOR],
  );
});

Deno.test("an agent that may call another is joined to it once per direction, from caller to callee; a tool of its own or a disabled access is no call", () => {
  const model = withLinks(
    board({
      team: [
        unit({ id: "bo", title: "BO" }),
        unit({ id: "reviewer", title: "Reviewer" }),
        unit({ id: "other", title: "Other" }),
      ],
      cando: [
        capability("reviewer.inbox", "reviewer", "inbox"),
        capability("bo.inbox", "bo", "inbox"),
        capability("other.inbox", "other", "inbox"),
        tool("bo.read", "bo", "read_web_page"),
      ],
    }),
    [
      link("can-call", "bo.operator", "reviewer.inbox"),
      link("can-call", "bo.operator", "reviewer", { id: "again" }),
      link("can-call", "reviewer.operator", "bo.inbox"),
      link("can-call", "bo.operator", "bo.read"),
      link("can-call", "bo.operator", "other.inbox", { enabled: false }),
    ],
  );
  const team = teamOf(model);
  deepStrictEqual(
    team.edges.filter((edge) => edge.kind === "calls")
      .map((edge) => [edge.from, edge.to]),
    [["bo", "reviewer"], ["reviewer", "bo"]],
  );
  // Without what the agents work with, the calls stay.
  deepStrictEqual(agentsOnly(team).edges.map((edge) => edge.kind), [
    "calls",
    "calls",
  ]);
});

Deno.test("a resource an agent holds twice counts it once, and a scope is its children's too", () => {
  const twice = board({
    team: [unit({ id: "u", title: "u" })],
    cando: [
      tool("t1", "u", "read"),
      tool("t2", "u", "read"),
      {
        ...item("group", "capability", "group", { scope: "u" }),
        // A child carries no scope of its own: it is its parent's.
        children: [tool("t3", "", "nested")].map(({ scope: _, ...rest }) =>
          rest
        ),
      },
    ],
  });
  const team = teamOf(twice);
  deepStrictEqual(labels(team), [
    "tool:read",
    "tool:nested",
  ]);
  equal(team.resources[0].agents.length, 1);
});

Deno.test("an agent without a unit is not made up: no team column, no scope item, no agent", () => {
  deepStrictEqual(teamOf(board({})).agents, []);
  const generic = board({
    team: [item("panel", "machine", "panel"), item("op", "operator", "op")],
  }, { mode: "generic" });
  deepStrictEqual(teamOf(generic).agents, []);
  // Items of a scope no unit has belong to no one.
  const stray = board({
    team: [unit({ id: "u", title: "u" })],
    cando: [tool("t", "ghost", "read")],
  });
  deepStrictEqual(teamOf(stray).resources, []);
});

Deno.test("the agent shown is the one named, else the first the person talks with, else the first", () => {
  const team = teamOf(watchBoard());
  equal(shownAgent(team, ANALYST)?.name, "Analyste");
  equal(shownAgent(team, null)?.name, "Coordinateur veille");
  // An id that is no agent of the team is no choice.
  equal(shownAgent(team, "ghost")?.name, "Coordinateur veille");
  const noTalker = teamOf(board({
    team: [unit({ id: "a", title: "a" }), unit({ id: "b", title: "b" })],
  }));
  equal(shownAgent(noTalker, null)?.id, "a");
  equal(shownAgent(noTalker, "b")?.id, "b");
  equal(shownAgent(teamOf(board({})), null), undefined);
});

Deno.test("the team is read from the board and the roster alone: the same input is the same team, and nothing is changed", () => {
  const source = watchBoard();
  const before = JSON.stringify(source);
  const roster = [rosterEntry(COORDINATOR, { name: "Runtime" })];
  deepStrictEqual(teamOf(source, roster), teamOf(source, roster));
  deepStrictEqual(profileOf(source, ANALYST), profileOf(source, ANALYST));
  equal(JSON.stringify(source), before);
  equal(
    JSON.stringify(roster),
    JSON.stringify([rosterEntry(COORDINATOR, { name: "Runtime" })]),
  );
});

Deno.test("a team of any size is read: twelve agents, then thirteen", () => {
  for (const count of [12, 13, 40]) {
    const team = teamOf(crowdBoard(count));
    equal(team.agents.length, count);
    equal(team.agents.filter((agent) => agent.contact === "direct").length, 1);
    equal(team.resources.length, 1);
    equal(team.resources[0].agents.length, count);
  }
});

Deno.test("the profile has what the model declares of the agent, in figures and words", () => {
  const profile = profileOf(initialBoard(), LIVE_BUILDER);
  deepStrictEqual(
    profile.context.stats.map((stat) => [stat.value, stat.label]),
    [
      ["8", "recent messages"],
      ["2,000", "message characters"],
      ["12", "collection items"],
      ["250k", "context characters"],
    ],
  );
  deepStrictEqual(profile.context.rules, []);
  // Skills: the policy's figures and rules, and the skills and tools the agent has.
  deepStrictEqual(
    profile.tools.stats.map((stat) => [stat.value, stat.label]),
    [["32", "installed skills"], ["4", "loaded skills"]],
  );
  deepStrictEqual(profile.tools.rules.map((rule) => rule.text), [
    "allowed hosts: raw.githubusercontent.com",
  ]);
  deepStrictEqual(profile.tools.things.map((thing) => thing.text), [
    "aseModeling",
    "read_web_page",
    "read_web_page_outline",
  ]);
  equal(
    profile.tools.things[1].title,
    "Return the actual nonempty HTML document title and readable text.",
  );
  // Durations are said as durations, booleans as yes and no, lists as lists.
  deepStrictEqual(
    profile.memory.stats.map((stat) => [stat.value, stat.label]),
    [["24h", "validity"]],
  );
  deepStrictEqual(profile.memory.rules.map((rule) => rule.text), [
    "allowed scopes: modeling",
    "require source refs: yes",
    "allow self admission: no",
  ]);
  // The bookkeeping of a policy is not a fact about the agent.
  const everything = JSON.stringify(profile);
  ok(!everything.includes("revision"));
  ok(!everything.includes("-v1"));
  equal(
    profile.context.blank || profile.tools.blank || profile.memory.blank,
    false,
  );
});

Deno.test("the profile leaves out what the detail of the policy leaves out: identity and versioning are one list", () => {
  const model = board({
    team: [unit({ id: "u", title: "u" })],
    rules: [
      policy("p", "u", "GovernedMemoryPolicy", {
        id: "memory-v1",
        version: 2,
        revision: 7,
        configurationId: "cfg",
        configurationRevision: 3,
        evidenceLevel: "strong",
        source: "host configuration",
        operatorName: "Analyste",
        validityMs: 86_400_000,
        requireSourceRefs: true,
        allowedScopes: [],
      }, "memory"),
    ],
  });
  const { memory } = profileOf(model, "u");
  deepStrictEqual(memory.stats.map((stat) => [stat.value, stat.label]), [
    ["24h", "validity"],
  ]);
  // An empty list reads "none", as the detail says it.
  deepStrictEqual(memory.rules.map((rule) => rule.text), [
    "require source refs: yes",
    "allowed scopes: none",
  ]);
  // The same policy, told by the detail of Explore, declares the same facts.
  deepStrictEqual(
    factsOf(indexBoard(model).get("p")!, false).facts.map((fact) => fact.name),
    ["Validity", "Require source refs", "Allowed scopes"],
  );
});

Deno.test("the mandate is the agent's own, bound to its software operator: the human owner's is not shown as the agent's", () => {
  const profile = profileOf(initialBoard(), LIVE_BUILDER);
  equal(
    profile.mandate.summary,
    "Propose read_web_page and read_web_page_outline; invoke active catalog tools",
  );
  equal(profile.mandate.title, "builderMandate");
  // The limits are the execution policy's maxima, apart from the families'.
  deepStrictEqual(
    profile.mandate.limits.map((limit) => [limit.value, limit.label]),
    [["12", "agent decisions"], ["2", "tool proposals"], ["256", "flow steps"]],
  );
  // A mandate bound to no operator may be anyone's: shown; one a human holds never.
  const unbound = board({
    team: [unit({ id: "u", title: "u" })],
    rules: [mandate("m", "u", "Do the work")],
  });
  equal(profileOf(unbound, "u").mandate.summary, "Do the work");
  const humans = initialBoard();
  // Only the human owner's binding is known: the agent's mandate is the one it
  // does not hold.
  humans.links = humans.links.filter((link) => link.from === "owner-mandate");
  equal(
    profileOf(humans, LIVE_BUILDER).mandate.summary,
    "Propose read_web_page and read_web_page_outline; invoke active catalog tools",
  );
  // A mandate without words still has a name; none at all has nothing.
  const wordless = board({
    team: [unit({ id: "u", title: "u" })],
    rules: [item("m", "mandate", "someMandate", { scope: "u" })],
  });
  equal(profileOf(wordless, "u").mandate.summary, undefined);
  equal(profileOf(wordless, "u").mandate.title, "someMandate");
  const none = profileOf(board({ team: [unit({ id: "u", title: "u" })] }), "u");
  equal(none.mandate.title, undefined);
  deepStrictEqual(none.mandate.limits, []);
});

Deno.test("what the model leaves out is blank, not guessed", () => {
  const empty = profileOf(
    board({ team: [unit({ id: "u", title: "u" })] }),
    "u",
  );
  for (const section of [empty.context, empty.tools, empty.memory]) {
    equal(section.blank, true);
    deepStrictEqual(section.stats, []);
    deepStrictEqual(section.things, []);
    deepStrictEqual(section.rules, []);
  }
  deepStrictEqual(empty.works, []);
  // An agent that is not on the board has an empty profile too.
  equal(profileOf(initialBoard(), "ghost").tools.blank, true);
  // A tool alone makes Tools & skills declared, and nothing else.
  const onlyTool = profileOf(
    board({
      team: [unit({ id: "u", title: "u" })],
      cando: [tool("t", "u", "read")],
    }),
    "u",
  );
  equal(onlyTool.tools.blank, false);
  equal(onlyTool.context.blank, true);
  // A skill is a thing, and a skill policy is the figures around it.
  const skilled = profileOf(
    board({
      team: [unit({ id: "u", title: "u" })],
      cando: [skill("s", "u", "writing")],
    }),
    "u",
  );
  deepStrictEqual(skilled.tools.things.map((thing) => thing.text), ["writing"]);
});

Deno.test("the flows an agent performs are the capabilities with steps, said as phrases", () => {
  const profile = profileOf(initialBoard(), LIVE_BUILDER);
  deepStrictEqual(profile.works.map((work) => work.text), [
    "Promotion",
    "Conversation",
  ]);
  // A capability without steps is not a flow.
  ok(!profile.works.some((work) => work.text === "Reply"));
});

Deno.test("an item belongs to the unit the index says, as everywhere else: a child follows its parent, a scope that is no unit holds nothing", () => {
  // The child declares no scope of its own: it is the work of its parent's unit.
  const inner = { ...capability("inner", "u", "inner", 2), scope: undefined };
  const model = board({
    team: [unit({ id: "u", title: "u" })],
    cando: [
      { ...tool("host", "u", "host"), children: [inner] },
      capability("stray", "nowhere", "stray", 2),
    ],
  });
  const index = indexBoard(model);
  equal(index.unitOf("inner"), "u");
  equal(index.unitOf("stray"), null);
  deepStrictEqual(profileOf(model, "u").works.map((work) => work.id), [
    "inner",
  ]);
  // Nothing is held by a name that is no unit, whatever declares itself for it.
  deepStrictEqual(profileOf(model, "nowhere").works, []);
  // Team and the other pages agree on whose work a flow is.
  const watch = watchBoard();
  const watched = indexBoard(watch);
  for (const agent of teamOf(watch).agents) {
    deepStrictEqual(
      profileOf(watch, agent.id).works.map((work) => work.id),
      watch.columns.flatMap((column) => column.items)
        .filter((entry) =>
          entry.steps?.length && watched.unitOf(entry.id) === agent.id
        )
        .map((entry) => entry.id),
      agent.id,
    );
  }
});

Deno.test("a policy's values are read by their type: figures, durations, flags, lists; grants are for the network", () => {
  const odd = board({
    team: [unit({ id: "u", title: "u" })],
    rules: [
      {
        ...policy("p", "u", "ContextThing", {}, "context"),
        values: values({
          maxItems: 1_500_000,
          maxWaitMs: 90_000,
          retryDelayMs: 1_500,
          label: "x",
          open: true,
          closed: false,
          hosts: ["a", "b"],
          grants: [{ file: "f.sysml", qualifiedRoots: ["F::g"] }],
          id: "ignored",
          revision: 3,
        }),
      },
    ],
  });
  const context = profileOf(odd, "u").context;
  deepStrictEqual(context.stats.map((stat) => [stat.value, stat.label]), [
    ["1.5M", "items"],
    ["1.5min", "wait"],
    ["1.5s", "retry delay"],
  ]);
  deepStrictEqual(context.rules.map((rule) => rule.text), [
    "label: x",
    "open: yes",
    "closed: no",
    "hosts: a, b",
  ]);
});
