import { deepStrictEqual, equal } from "node:assert/strict";
import type { BoardItem } from "../../../../src/domain/model/records/board.ts";
import type { OperatorTool } from "../../../../src/domain/work/records/conversations.ts";
import {
  ANALYST,
  board,
  COLLECTOR,
  COORDINATOR,
  initialBoard,
  item,
  policy,
  tool,
  unit,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import {
  exploreOf,
  exploreToolCardIds,
  exploreToolOccurrences,
  linkedExploreTools,
} from "./explore.ts";
import type { CandidateRead } from "../tools/candidates.ts";

const NAMES: Record<string, string> = {
  [COORDINATOR]: "Coordinateur",
  [ANALYST]: "Analyste",
  [COLLECTOR]: "Collecteur",
};
const namesOf = (ids: readonly string[]) =>
  ids.flatMap((id) => NAMES[id] ?? []);

const cards = (
  columns: ReturnType<typeof exploreOf>["columns"],
  id: string,
) =>
  columns.find((column) => column.id === id)!.groups.map((group) => [
    group.label,
    group.cards.map((card) => [card.item.title, card.ids.length]),
  ]);

Deno.test("the columns that hold nothing are not drawn, the others keep the board's order", () => {
  const { columns, units } = exploreOf(
    board({
      cando: [tool("t", "u", "search")],
      team: [unit({ id: "u", title: "u" })],
    }),
    namesOf,
  );
  deepStrictEqual(columns.map((column) => column.id), ["team", "cando"]);
  equal(units, 1);
  equal(exploreOf(board({}), namesOf).columns.length, 0);
  equal(exploreOf(board({}), namesOf).units, 0);
});

Deno.test("the same tool in every unit is one card marked with how many, under 'In every system'", () => {
  const { columns, units } = exploreOf(watchBoard(), namesOf);
  equal(units, 3);
  const cando = columns.find((column) => column.id === "cando")!;
  // Six tools and a flow are declared; the tools are two cards of three.
  equal(cando.items, 7);
  const [everywhere] = cando.groups;
  equal(everywhere.label, "In every system");
  deepStrictEqual(
    everywhere.cards.map((card) => [card.item.title, card.ids]),
    [
      ["read_web_page", [
        `${COORDINATOR}.read`,
        `${ANALYST}.read`,
        `${COLLECTOR}.read`,
      ]],
      ["read_web_page_outline", [
        `${COORDINATOR}.outline`,
        `${ANALYST}.outline`,
        `${COLLECTOR}.outline`,
      ]],
    ],
  );
  deepStrictEqual(everywhere.cards[0].scopes, [
    COORDINATOR,
    ANALYST,
    COLLECTOR,
  ]);
});

Deno.test("what only some units declare says which, what one declares says it, what none does is shared", () => {
  const model = board({
    team: [
      unit({ id: "a", title: "a" }),
      unit({ id: "b", title: "b" }),
      unit({ id: "c", title: "c" }),
    ],
    cando: [
      tool("a.t", "a", "search"),
      tool("b.t", "b", "search"),
      tool("c.only", "c", "write"),
      item("shared", "capability-type", "ToolCandidate"),
    ],
  });
  const names = (ids: readonly string[]) =>
    ids.flatMap((id) => ({ a: "Alpha", b: "Beta", c: "Gamma" })[id] ?? []);
  const { columns } = exploreOf(model, names);
  deepStrictEqual(cards(columns, "cando"), [
    ["in Alpha and Beta", [["search", 2]]],
    ["in Gamma", [["write", 1]]],
    ["Shared definitions", [["ToolCandidate", 1]]],
  ]);
  // A unit the model does not name leaves its cards without a heading.
  const anonymous = exploreOf(model, () => []).columns;
  deepStrictEqual(cards(anonymous, "cando").map(([label]) => label), [
    "",
    "Shared definitions",
  ]);
});

Deno.test("the model's own heading for an item comes first; the units are never twins, whatever they resemble", () => {
  const model = board({
    team: [
      unit({ id: "a", title: "same" }),
      unit({ id: "b", title: "same" }),
    ],
    rules: [
      {
        ...policy("p", "a", "DecisionContextPolicy", { recentMessages: 8 }),
        group: [
          { element: "g1", title: "context" },
          { element: "g2", title: "skills" },
        ],
      },
    ],
  });
  const { columns } = exploreOf(model, namesOf);
  // Two units with the same name and shape are two cards, under no heading.
  deepStrictEqual(cards(columns, "team"), [[
    "",
    [["same", 1], ["same", 1]],
  ]]);
  deepStrictEqual(cards(columns, "rules"), [[
    "context · skills",
    [["decisionContextPolicy", 1]],
  ]]);
});

Deno.test("items are twins only when nothing a person reads tells them apart", () => {
  const same = (
    id: string,
    scope: string,
    over: Partial<BoardItem> = {},
  ): BoardItem => ({ ...tool(id, scope, "search", "Reads a page."), ...over });
  const model = board({
    team: [
      unit({ id: "a", title: "a" }),
      unit({ id: "b", title: "b" }),
      unit({ id: "c", title: "c" }),
      unit({ id: "d", title: "d" }),
    ],
    cando: [
      same("a.t", "a"),
      same("b.t", "b"),
      // A different summary, value, or type is another card.
      same("c.t", "c", { summary: "Reads a page, then a second." }),
      same("d.t", "d", { values: [{ name: "module", line: 1, value: "x" }] }),
    ],
  });
  const { columns } = exploreOf(model, namesOf);
  deepStrictEqual(
    columns.find((column) => column.id === "cando")!.groups.flatMap((group) =>
      group.cards.map((card) => card.ids)
    ),
    [["a.t", "b.t"], ["c.t"], ["d.t"]],
  );
});

Deno.test("a column that has no twin counts its items as they are", () => {
  const { columns } = exploreOf(initialBoard(), namesOf);
  const counts = columns.map((column) => [
    column.id,
    column.items,
    column.groups.reduce((n, group) => n + group.cards.length, 0),
  ]);
  deepStrictEqual(counts, [
    ["team", 1, 1],
    ["cando", 6, 6],
    ["rules", 6, 6],
  ]);
});

function observedTool(
  owner: string,
  element: string,
  id = "same-id",
): OperatorTool {
  return {
    agentId: owner,
    agentName: "Same owner name",
    revision: 1,
    candidate: {
      id,
      digest: `${owner}-digest`,
      name: "search",
      description: "",
      code: "",
      kind: "read_web_page",
      stage: "active",
      createdAt: "now",
      baseCatalogRevision: 0,
      binding: { elementId: element, graphPath: "model.sysml" },
    },
  };
}

Deno.test("Explore joins every twin through its native binding and exact roster owner", () => {
  const model = board({
    team: [
      unit({ id: "a", title: "same", operator: "native-a" }),
      unit({ id: "b", title: "same", operator: "native-b" }),
    ],
    cando: [
      { ...tool("a.t", "a", "search"), element: "native-tool-a" },
      { ...tool("b.t", "b", "search"), element: "native-tool-b" },
    ],
  });
  const card = exploreOf(model, () => []).columns.find((c) => c.id === "cando")!
    .groups[0].cards[0];
  const read: CandidateRead = {
    catalogue: {
      systemId: "s",
      version: "v",
      tools: [
        observedTool("agent-a", "native-tool-a"),
        observedTool("agent-b", "native-tool-b"),
        // A known tool with the wrong owner, a missing owner, and a mere name.
        observedTool("wrong-owner", "native-tool-a"),
        observedTool("missing", "native-tool-a"),
        observedTool("name-only", "search"),
      ],
    },
    stale: false,
    loading: false,
    error: "",
  };
  const roster = [
    { agentId: "agent-a", nativeId: "native-a" },
    { agentId: "agent-b", nativeId: "native-b" },
    { agentId: "wrong-owner", nativeId: "native-b" },
    { agentId: "name-only", nativeId: "native-a" },
  ];
  deepStrictEqual(
    linkedExploreTools(model, card, read, roster).map((entry) => [
      entry.tool.agentId,
      entry.occurrence,
    ]),
    [["agent-a", "a.t"], ["agent-b", "b.t"]],
  );
  equal(linkedExploreTools(model, card, undefined, roster).length, 0);
  equal(
    linkedExploreTools(model, card, { ...read, catalogue: null }, roster)
      .length,
    0,
  );
  equal(linkedExploreTools(model, card, read, []).length, 0);
  // Ambiguity is explicit absence, never the first matching operator.
  equal(
    linkedExploreTools(model, card, read, [...roster, roster[0]])
      .some((entry) => entry.tool.agentId === "agent-a"),
    false,
  );
});

Deno.test("Explore rejects navigation aliases and does not add tool state to a skill", () => {
  const model = board({
    team: [unit({ id: "a", title: "a", operator: "native-owner" })],
    cando: [
      tool("t", "a", "search"),
      item("s", "skill", "search", { scope: "a" }),
    ],
  });
  model.index["native-alias"] = { column: "cando", card: "t" };
  const cards = exploreOf(model, () => []).columns.find((c) =>
    c.id === "cando"
  )!
    .groups.flatMap((g) => g.cards);
  const read: CandidateRead = {
    catalogue: {
      systemId: "s",
      version: "v",
      tools: [
        observedTool("owner", "native-alias"),
        observedTool("owner", "t", "exact-native-contract"),
        observedTool("owner", "s", "skill-candidate"),
      ],
    },
    stale: false,
    loading: false,
    error: "",
  };
  const roster = [{ agentId: "owner", nativeId: "native-owner" }];
  equal(linkedExploreTools(model, cards[0], read, roster).length, 1);
  equal(
    linkedExploreTools(model, cards[0], read, roster)[0].tool.candidate.id,
    "exact-native-contract",
  );
  equal(linkedExploreTools(model, cards[1], read, roster).length, 0);
});

Deno.test("appearance identities use the native tool and owner, never their labels", () => {
  const first = board({
    team: [unit({ id: "a", title: "a" }), unit({ id: "b", title: "b" })],
    cando: [{ ...tool("t", "a", "search"), element: "native-tool" }],
  });
  const renamed = board({
    team: [unit({ id: "a", title: "renamed" }), unit({ id: "b", title: "b" })],
    cando: [{
      ...tool("new-board-id", "a", "renamed"),
      element: "native-tool",
    }],
  });
  const anotherOwner = board({
    team: [unit({ id: "a", title: "a" }), unit({ id: "b", title: "b" })],
    cando: [{ ...tool("t", "b", "search"), element: "native-tool" }],
  });
  equal(
    [...exploreToolOccurrences(first).values()][0],
    [...exploreToolOccurrences(renamed).values()][0],
  );
  equal(
    [...exploreToolOccurrences(first).values()][0] ===
      [...exploreToolOccurrences(anotherOwner).values()][0],
    false,
  );
});

/** Real projector shape: admitted ToolCandidate parts live below the catalogue. */
function catalogueUnit(id: string, owner: string, candidates: BoardItem[]) {
  const root = unit({ id, title: "Same system", operator: owner });
  return {
    ...root,
    children: root.children!.map((child) =>
      child.id === `${id}.catalog` ? { ...child, children: candidates } : child
    ),
  };
}
function publishedCandidate(id: string, native = id): BoardItem {
  return item(id, "machine", "tool_shared_name", {
    element: native,
    type: { title: "ToolCandidate", qname: "ASELiveBuilder::ToolCandidate" },
  });
}

Deno.test("Explore joins published catalogue parts to their containing unit, not a contract by name", () => {
  const model = board({
    team: [
      catalogueUnit("a", "native-owner-a", [
        publishedCandidate("a.candidate", "native-candidate-a"),
        item("a.impostor", "machine", "tool_shared_name", {
          type: { title: "ToolCandidate", qname: "Other::ToolCandidate" },
        }),
      ]),
      catalogueUnit("b", "native-owner-b", [
        publishedCandidate("b.candidate", "native-candidate-b"),
      ]),
    ],
    // The admission added no contract: this declaration was already present.
    cando: [tool("contract", "a", "tool_shared_name")],
  });
  model.index["native-attribute"] = { column: "team", card: "a.candidate" };
  const cards = exploreOf(model, () => []).columns.flatMap((column) =>
    column.groups.flatMap((group) => group.cards)
  );
  const read: CandidateRead = {
    catalogue: {
      systemId: "s",
      version: "v",
      tools: [
        observedTool("session-a", "native-candidate-a"),
        observedTool("session-b", "native-candidate-b"),
        observedTool("session-b", "native-candidate-a", "wrong-owner"),
        observedTool("session-a", "a.impostor", "same-type-title"),
        observedTool("session-a", "native-attribute", "navigation-only"),
      ],
    },
    stale: false,
    loading: false,
    error: "",
  };
  const roster = [
    { agentId: "session-a", nativeId: "native-owner-a" },
    { agentId: "session-b", nativeId: "native-owner-b" },
  ];
  const linked = (id: string) =>
    linkedExploreTools(
      model,
      cards.find((card) => card.ids.includes(id))!,
      read,
      roster,
    )
      .map((entry) => [entry.tool.agentId, entry.occurrence]);
  deepStrictEqual(linked("a"), [["session-a", "a.candidate"]]);
  deepStrictEqual(linked("b"), [["session-b", "b.candidate"]]);
  deepStrictEqual(linked("contract"), []);
  equal(
    linkedExploreTools(model, cards[0], read, [...roster, roster[0]]).length,
    0,
  );
});

Deno.test("new published parts retain separate native identities but light their existing containing card", () => {
  const before = board({
    team: [catalogueUnit("u", "native-owner", [])],
    cando: [tool("contract", "u", "read_web_page")],
  });
  const after = board({
    team: [catalogueUnit("u", "native-owner", [
      publishedCandidate("candidate-one"),
      publishedCandidate("candidate-two"),
    ])],
    cando: before.columns.find((column) => column.id === "cando")!.items,
  });
  const old = new Set(exploreToolOccurrences(before).values());
  const added = new Set(
    [...exploreToolOccurrences(after)]
      .filter(([, identity]) => !old.has(identity)).map(([id]) => id),
  );
  deepStrictEqual([...added], ["candidate-one", "candidate-two"]);
  deepStrictEqual([...exploreToolCardIds(after, added)], ["u"]);
  deepStrictEqual([...exploreToolCardIds(after, new Set(["contract"]))], [
    "contract",
  ]);
  // A structural machine with the same name or short type title is no tool.
  const impostor = board({
    team: [catalogueUnit("u", "native-owner", [
      item("fake", "machine", "ToolCandidate", {
        type: { title: "ToolCandidate", qname: "Other::ToolCandidate" },
      }),
    ])],
  });
  equal(exploreToolOccurrences(impostor).size, 0);
});

Deno.test("canonical and legacy catalogue candidates retain state and new-occurrence associations", () => {
  for (const namespace of ["AssemblyLiveBuilder", "ASELiveBuilder"]) {
    for (const quoted of [false, true]) {
      const native = "native-candidate";
      const candidate = {
        ...publishedCandidate("candidate", native),
        type: {
          title: "ToolCandidate",
          qname: quoted
            ? `'${namespace}'::'ToolCandidate'`
            : `${namespace}::ToolCandidate`,
        },
      };
      const model = board({
        team: [catalogueUnit("u", "native-owner", [candidate])],
      });
      const card = exploreOf(model, () => []).columns.flatMap((column) =>
        column.groups.flatMap((group) => group.cards)
      ).find((card) => card.ids.includes("u"))!;
      const runtimeTool = observedTool("session", native);
      const read: CandidateRead = {
        catalogue: { systemId: "s", version: "v", tools: [runtimeTool] },
        stale: false,
        loading: false,
        error: "",
      };
      const linked = linkedExploreTools(model, card, read, [{
        agentId: "session",
        nativeId: "native-owner",
      }]);
      deepStrictEqual(
        linked.map(({ occurrence, tool }) => ({ occurrence, tool })),
        [{
          occurrence: "candidate",
          tool: runtimeTool,
        }],
      );
      const occurrences = exploreToolOccurrences(model);
      deepStrictEqual([...occurrences.keys()], ["candidate"]);
      deepStrictEqual([
        ...exploreToolCardIds(model, new Set(occurrences.keys())),
      ], ["u"]);
    }
  }
});
