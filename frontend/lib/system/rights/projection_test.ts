import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  BUILDER,
  legacy,
  legacyBody,
  OWNER,
  ownerModeled,
  ownerModeledBody,
  selfApprovingBody,
  UNIT,
  withCell,
} from "../../../test/support/matrix-fixture.ts";
import { type AuthorityMatrix, parseMatrix } from "./api.ts";
import {
  caveatsOf,
  cellKey,
  codeWords,
  declaredBy,
  dotOf,
  familiesOf,
  foldMarks,
  type Mark,
  markKey,
  markOf,
  rightsOf,
  ruleOf,
  said,
  sourceName,
  type UnitName,
  unusableWords,
  usable,
} from "./projection.ts";

const cell = (
  state: string,
  codes: string[] = [],
  display?: string,
) => ({ state, codes, ...(display ? { display } : {}) });

/** The units of the initial model as a page calls them. */
const UNITS: readonly UnitName[] = [{ qname: UNIT, name: "Builder" }];

const marks = (...entries: Mark[]) => entries;

Deno.test("a right is usable when it is allowed or inherited and no code says it is of no use", () => {
  equal(usable(cell("allowed")), true);
  equal(usable(cell("inherited")), true);
  // Granted, and nothing to act on: not usable.
  for (
    const code of [
      "RIGHT_WITHOUT_OBJECT",
      "EFFECTIVELY_UNREACHABLE",
      "NO_REACHABLE_HOST",
      "NETWORK_SCOPE_UNUSED",
    ]
  ) {
    equal(usable(cell("allowed", [code])), false, code);
    equal(usable(cell("inherited", [code])), false, code);
  }
  // Codes that qualify a right without emptying it leave it usable.
  equal(
    usable(cell("allowed", ["OWNER_IMPLICIT", "ADMISSION_BY_HUMAN"])),
    true,
  );
  equal(usable(cell("propose-only")), false);
  equal(usable(cell("denied")), false);
});

Deno.test("the mark of a right: full, half for a proposal, a lock for what is never given, an empty ring for the rest", () => {
  deepStrictEqual(markOf(cell("allowed")), { kind: "full", unusable: false });
  deepStrictEqual(markOf(cell("inherited")), { kind: "full", unusable: false });
  // Allowed and of no use is not full: it is an empty ring, and says it is granted.
  deepStrictEqual(markOf(cell("allowed", ["RIGHT_WITHOUT_OBJECT"])), {
    kind: "empty",
    unusable: true,
  });
  deepStrictEqual(markOf(cell("propose-only")), {
    kind: "half",
    unusable: false,
  });
  deepStrictEqual(markOf(cell("denied", ["HARD_DENIED"])), {
    kind: "lock",
    unusable: false,
  });
  deepStrictEqual(markOf(cell("denied", ["HOST_RESERVED"])), {
    kind: "lock",
    unusable: false,
  });
  deepStrictEqual(markOf(cell("denied", ["NO_HOSTS_DECLARED"])), {
    kind: "empty",
    unusable: false,
  });
  deepStrictEqual(markOf(cell("denied")), { kind: "empty", unusable: false });
});

Deno.test("a state or a code the host adds is never an error: the state looks as the host says it looks, the code is kept", () => {
  // A delegated right is a proposal, as the host displays it.
  deepStrictEqual(markOf(cell("delegated", [], "propose-only")), {
    kind: "half",
    unusable: false,
  });
  deepStrictEqual(markOf(cell("lent", ["NEW_CODE"], "allowed")), {
    kind: "full",
    unusable: false,
  });
  equal(usable(cell("lent", [], "allowed")), true);
  equal(usable(cell("lent", ["NO_REACHABLE_HOST"], "allowed")), false);
  // A state with no look is not given, and is told as it is.
  const frozen = markOf(cell("frozen"));
  deepStrictEqual(frozen, { kind: "empty", unusable: false, other: "frozen" });
  equal(said(frozen), "frozen");
  // A code unknown to the page has no phrase, and is not hidden.
  equal(codeWords("NEW_CODE"), undefined);
  equal(codeWords("HARD_DENIED"), "never allowed");
  deepStrictEqual(
    unusableWords([{ codes: ["NEW_CODE", "NO_REACHABLE_HOST"] }]),
    [
      "no host declared for tool calls",
    ],
  );
  // Not the prototype's chain: `constructor` is not a code of the host.
  equal(codeWords("constructor"), undefined);
});

Deno.test("marks fold into one: alone if any is, a proposal if any is, a lock only when all are", () => {
  const full: Mark = { kind: "full", unusable: false };
  const half: Mark = { kind: "half", unusable: false };
  const lock: Mark = { kind: "lock", unusable: false };
  const empty: Mark = { kind: "empty", unusable: false };
  const warn: Mark = { kind: "empty", unusable: true };
  equal(foldMarks(marks(lock, half, empty, full)).kind, "full");
  equal(foldMarks(marks(lock, half, warn)).kind, "half");
  equal(foldMarks(marks(lock, lock)).kind, "lock");
  equal(foldMarks(marks(lock, empty)).kind, "empty");
  // Granted to no use stays said while nothing better is held.
  deepStrictEqual(foldMarks(marks(lock, warn)), {
    kind: "empty",
    unusable: true,
  });
  deepStrictEqual(foldMarks(marks(empty, empty)), {
    kind: "empty",
    unusable: false,
  });
  equal(said(full), "yes");
  equal(said(half), "proposes");
  equal(said(lock), "never");
  equal(said(warn), "granted, unusable");
  equal(said(empty), "no");
});

Deno.test("the families come in the host's order with their columns in order; a family the host did not list follows, named by its id, and one with no column is not drawn", () => {
  const body = ownerModeledBody();
  const matrix = parseMatrix({
    ...body,
    // Out of order on purpose: the host's `order` is what counts.
    groups: [...body.groups].reverse(),
    columns: [
      {
        id: "ledger.read",
        group: "ledger",
        label: "Read the ledger",
        mode: "execute",
        order: 0,
      },
      ...[...body.columns].reverse(),
    ],
  });
  const families = familiesOf(matrix);
  // The family of exposed behaviors has no column here, so it is not drawn.
  deepStrictEqual(families.map((family) => family.id), [
    "tools",
    "admission",
    "mandate",
    "model",
    "memory-skills",
    "ledger",
  ]);
  const ledger = families.at(-1)!;
  equal(ledger.label, "ledger");
  equal(ledger.short, "ledger");
  const tools = families.find((family) => family.id === "tools")!;
  equal(tools.label, "Tools");
  equal(tools.short, "Tools");
  deepStrictEqual(tools.columns.map((column) => column.id), [
    "tool.build:read_web_page",
    "tool.invoke",
    "network.reach",
  ]);
  equal(families.find((family) => family.id === "admission")!.short, "Approve");
  // A matrix with no groups still has its families, from its columns.
  const bare = parseMatrix({ ...body, groups: [] });
  deepStrictEqual(
    familiesOf(bare).map((family) => family.id),
    ["tools", "admission", "mandate", "model", "memory-skills"],
  );
});

Deno.test("the actors are you first, then the operators as the team names them; each holds the cells of its rows", () => {
  const rights = rightsOf(ownerModeled(), UNITS);
  deepStrictEqual(rights.actors.map((actor) => [actor.id, actor.label]), [
    ["you", "You"],
    [BUILDER, "Builder"],
  ]);
  const [you, builder] = rights.actors;
  equal(you.you, true);
  deepStrictEqual(you.rows.map((row) => row.id), [OWNER]);
  deepStrictEqual(builder.rows.map((row) => row.id), [BUILDER]);
  // A unit the team has no name for is called by its own last name, never another.
  const unnamed = rightsOf(ownerModeled(), []);
  equal(unnamed.actors[1].label, "liveBuilder");
  // Two operators in a unit are told apart by their role.
  const two = parseMatrix({
    ...ownerModeledBody(),
    rows: [
      ...ownerModeledBody().rows,
      {
        id: "reviewer-1",
        kind: "software",
        role: "reviewer",
        label: `${UNIT}::reviewer`,
        unit: UNIT,
        declared: true,
      },
    ],
  });
  deepStrictEqual(
    rightsOf(two, UNITS).actors.map((actor) => actor.label),
    ["You", "Builder · builder", "Builder · reviewer"],
  );
  // The owner an older model leaves implicit is still you.
  const old = rightsOf(legacy(), UNITS);
  equal(old.actors[0].rows[0].declared, false);
  equal(old.actors[0].label, "You");
});

Deno.test("without the matrix the actors are the team's own and hold nothing", () => {
  const rights = rightsOf(undefined, [
    { qname: UNIT, name: "Builder" },
    { qname: "ASEAnalysis::analyst", name: "Analyste" },
  ]);
  deepStrictEqual(rights.actors.map((actor) => actor.label), [
    "You",
    "Builder",
    "Analyste",
  ]);
  equal(rights.families.length, 0);
  for (const actor of rights.actors) {
    equal(actor.rows.length, 0);
    equal(actor.selfApproves, false);
  }
  equal(rights.at(OWNER, "candidate.admit"), undefined);
});

Deno.test("what an actor holds in a family folds its cells into one mark, and lists its rights line by line", () => {
  const rights = rightsOf(ownerModeled(), UNITS);
  const [you, builder] = rights.actors;
  const family = (id: string) => rights.families.find((one) => one.id === id)!;
  // Builder: a proposal and a right of no use and a refusal: it proposes.
  deepStrictEqual(rights.markIn(builder, family("tools")), {
    kind: "half",
    unusable: false,
  });
  // Both refused by the host's own rule, never given.
  deepStrictEqual(rights.markIn(builder, family("mandate")), {
    kind: "lock",
    unusable: false,
  });
  deepStrictEqual(rights.markIn(builder, family("model")), {
    kind: "full",
    unusable: false,
  });
  // You hold nothing in tools: no mark at all, not an empty one.
  equal(rights.markIn(you, family("tools")), undefined);
  equal(rights.markIn(you, family("admission"))?.kind, "full");
  const tools = rights.lines(builder, family("tools"));
  deepStrictEqual(
    tools.map((line) => [line.column.id, line.mark.kind, line.mark.unusable]),
    [
      ["tool.build:read_web_page", "half", false],
      ["tool.invoke", "empty", true],
      ["network.reach", "empty", false],
    ],
  );
});

Deno.test("an operator that admits its own tools with no one to review them is flagged, in the families of tools and admission", () => {
  const rights = rightsOf(parseMatrix(selfApprovingBody()), UNITS);
  const [you, builder] = rights.actors;
  equal(builder.selfApproves, true);
  equal(you.selfApproves, false);
  const family = (id: string) => rights.families.find((one) => one.id === id)!;
  equal(rights.flagged(builder, family("tools")), true);
  equal(rights.flagged(builder, family("admission")), true);
  equal(rights.flagged(builder, family("model")), false);
  equal(rights.flagged(you, family("tools")), false);
});

Deno.test("nobody is flagged while someone may review: the owner's review makes the builder's own admission reviewed", () => {
  const withReviewer = parseMatrix(
    withCell(selfApprovingBody(), OWNER, "candidate.review", {
      state: "allowed",
      display: "allowed",
      mode: "review",
    }),
  );
  equal(rightsOf(withReviewer, UNITS).actors[1].selfApproves, false);
  // And one that admits by a person is no self-approval at all.
  equal(rightsOf(ownerModeled(), UNITS).actors[1].selfApproves, false);
  equal(rightsOf(legacy(), UNITS).actors[1].selfApproves, false);
  // The right to review that is granted to no use reviews nothing.
  const idle = parseMatrix(
    withCell(selfApprovingBody(), OWNER, "candidate.review", {
      state: "allowed",
      display: "allowed",
      codes: ["RIGHT_WITHOUT_OBJECT"],
    }),
  );
  equal(rightsOf(idle, UNITS).actors[1].selfApproves, true);
});

Deno.test("the builder admitting its own tools is flagged only while it may admit them: the right to admit denied, or granted to no use, flags nothing", () => {
  const flagged = (patch: Record<string, unknown>) =>
    rightsOf(
      parseMatrix(
        withCell(selfApprovingBody(), BUILDER, "candidate.admit", patch),
      ),
      UNITS,
    ).actors[1].selfApproves;
  equal(flagged({}), true);
  // The build cell says the builder admits, but the host does not let it.
  equal(
    flagged({
      state: "denied",
      display: "denied",
      codes: ["ADMISSION_BY_HUMAN"],
    }),
    false,
  );
  equal(
    flagged({ codes: ["ADMISSION_BY_BUILDER", "RIGHT_WITHOUT_OBJECT"] }),
    false,
  );
  // Admitting by proposal only is not admitting.
  equal(flagged({ state: "propose-only", display: "propose-only" }), false);
});

Deno.test("columns are told from what the host types about them, never by taking their identifier apart", () => {
  const body = ownerModeledBody();
  const second = "ASEAnalysis::analyst";
  const columns = [
    ...body.columns,
    {
      // The identifier lies about the unit: the typed target is what counts.
      id: "behavior:inbox@Wrong::unit",
      group: "behaviors",
      label: "Hand over work · analyst",
      mode: "execute",
      order: 1,
      target: { kind: "entry-kind", ref: "inbox", unit: second },
    },
    {
      id: `behavior:memory-recall@${second}`,
      group: "memory-skills",
      label: "Memory · recall · analyst",
      mode: "execute",
      order: 2000,
      target: { kind: "entry-kind", ref: "memory-recall", unit: second },
    },
  ];
  const matrix = parseMatrix({ ...body, columns });
  const rights = rightsOf(matrix, [
    ...UNITS,
    { qname: second, name: "Analyste" },
  ]);
  const column = (id: string) => matrix.columns.find((one) => one.id === id)!;
  equal(
    rights.columnLabel(column("behavior:inbox@Wrong::unit"), false),
    "Hand work to Analyste",
  );
  // Two units: the heading says whose, once, in place of the dotted suffix.
  equal(
    rights.columnLabel(column(`behavior:memory-recall@${second}`), false),
    "Memory · recall of Analyste",
  );
  // SysML's words are the matrix's own.
  equal(
    rights.columnLabel(column(`behavior:memory-recall@${second}`), true),
    "Memory · recall · analyst",
  );
  // One unit alone needs no "of": the heading is the right.
  const alone = rightsOf(ownerModeled(), UNITS);
  equal(
    alone.columnLabel(
      ownerModeled().columns.find((one) => one.id.startsWith("behavior:"))!,
      false,
    ),
    "Memory · capture",
  );
  // A column bound to no unit keeps its label.
  equal(
    alone.columnLabel(
      ownerModeled().columns.find((one) => one.id === "tool.invoke")!,
      false,
    ),
    "Use active tools",
  );
});

Deno.test("a row is called as the page calls its unit; you in a unit, an operator by its role in SysML", () => {
  const matrix = ownerModeled();
  const rights = rightsOf(matrix, UNITS);
  const [owner, builder] = matrix.rows;
  equal(rights.rowLabel(owner, false), "You · in Builder");
  equal(rights.rowLabel(builder, false), "Builder");
  equal(rights.rowLabel(builder, true), "builder · Builder");
  equal(
    rightsOf(matrix, [{ qname: UNIT, name: "liveBuilder" }]).rowLabel(
      builder,
      true,
    ),
    "builder · liveBuilder",
  );
});

Deno.test("the look the host gives a cell decides how it stands, whatever its state is called; a cell with no look stands by its state", () => {
  // `allowed` at the mode propose: the host displays it as a proposal, and so is it drawn everywhere.
  const proposal = cell("allowed", [], "propose-only");
  deepStrictEqual(markOf(proposal), { kind: "half", unusable: false });
  equal(usable(proposal), false);
  equal(dotOf(proposal), "propose");
  // One decision, not two: a state the page knows does not overrule the look.
  deepStrictEqual(markOf(cell("allowed", [], "denied")), {
    kind: "empty",
    unusable: false,
  });
  equal(dotOf(cell("propose-only", [], "allowed")), "allowed");
  // Inherited is still told as inherited in the dot, and is granted like allowed.
  equal(dotOf(cell("inherited", [], "allowed")), "inherited");
  deepStrictEqual(markOf(cell("inherited", [], "allowed")), {
    kind: "full",
    unusable: false,
  });
  // No look (an older snapshot): the state says.
  equal(markOf(cell("propose-only")).kind, "half");
  equal(markOf(cell("allowed")).kind, "full");
});

Deno.test("a state is drawn as a dot of its own; one the host adds looks as the host says", () => {
  equal(dotOf(cell("allowed")), "allowed");
  equal(dotOf(cell("inherited")), "inherited");
  equal(dotOf(cell("propose-only")), "propose");
  equal(dotOf(cell("delegated", [], "propose-only")), "propose");
  equal(dotOf(cell("denied")), "denied");
  equal(dotOf(cell("frozen")), "denied");
  equal(dotOf(cell("lent", [], "allowed")), "allowed");
});

Deno.test("the rule of a cell is told by the kind of rule, and a kind the page does not know is told as it is", () => {
  const rule = (via: Record<string, string | number | boolean>) =>
    ruleOf({ via: via as never });
  equal(ruleOf({}), undefined);
  equal(
    rule({ kind: "host-rule", rule: "only-the-owner-adopts" }),
    "only-the-owner-adopts",
  );
  equal(rule({ kind: "own-declaration" }), "declared by the operator itself");
  equal(
    rule({ kind: "unit-configuration", attribute: "mayAdmit" }),
    "the unit's mayAdmit",
  );
  equal(
    rule({ kind: "exposure", accessName: "memoryAccess" }),
    "exposed as memoryAccess",
  );
  equal(
    rule({ kind: "root-grant", grant: "owner-root-grant", mandate: "owner" }),
    "the root grant owner-root-grant of mandate owner",
  );
  equal(
    rule({ kind: "delegation", record: "rec-1", revision: 3 }),
    "delegated by rec-1, revision 3",
  );
  equal(rule({ kind: "something-new" }), "something-new");
});

Deno.test("a cell is declared by the places of the model's files it cites, each once, those without a file left out", () => {
  const matrix = ownerModeled();
  const admit = matrix.cells.find((one) =>
    one.row === OWNER && one.column === "candidate.admit"
  )!;
  const declared = declaredBy(admit);
  deepStrictEqual(
    declared.map((source) => `${source.file}:${source.line}`),
    [
      "configuration.sysml:293",
      "configuration.sysml:287",
      "configuration.sysml:284",
    ],
  );
  equal(sourceName(declared[0]), "ownerMandate::rootGrant");
  equal(sourceName({ role: "flag" }), "flag");
  // A place that has a file and no name is still a place; it is named by neither.
  equal(sourceName({ file: "configuration.sysml", line: 4 }), undefined);
  equal(
    declaredBy({ sources: [{ file: "configuration.sysml", line: 4 }] }).length,
    1,
  );
  const twice = declaredBy({
    sources: [
      ...admit.sources,
      admit.sources[0],
      { role: "scope", qname: "A::b" },
    ],
  });
  equal(twice.length, 3);
});

Deno.test("the page always says which version the rights are of, the one shown above; the other caveats it tells in its words, or the host's when it has none", () => {
  const adopted = caveatsOf(undefined);
  ok(/version shown above/.test(adopted.version), adopted.version);
  ok(/proposals/.test(adopted.version));
  ok(
    !/in service/.test(adopted.version),
    "the version in service is another act",
  );
  // Nothing more to say before the matrix is read.
  equal(adopted.note, undefined);
  const told = caveatsOf(ownerModeled());
  equal(told.version, adopted.version, "said the same, read or not");
  const lines = told.note?.split("\n") ?? [];
  equal(lines.length, 2);
  ok(/declared/.test(lines[0]));
  ok(/blank cell/.test(lines[1]));
  ok(!lines.some((line) => line.includes("version shown")), "said once");
  // The host spells a caveat as its bare code; one this page does not know is as written.
  const unknown = caveatsOf(parseMatrix({
    ...legacyBody(),
    caveats: ["ADOPTED_VERSION_ONLY", "A_NEW_CAVEAT", "constructor"],
  }));
  equal(unknown.note, "A_NEW_CAVEAT\nconstructor");
  // The matrix saying only the version has nothing to add.
  equal(
    caveatsOf(
      parseMatrix({ ...legacyBody(), caveats: ["ADOPTED_VERSION_ONLY"] }),
    )
      .note,
    undefined,
  );
});

Deno.test("a cell is named by its row and column, and a mark by its actor and family, as the address spells them", () => {
  equal(cellKey(OWNER, "candidate.admit"), `${OWNER}|candidate.admit`);
  equal(markKey("you", "tools"), "you|tools");
  // The matrix itself is the only place a key is looked up: nothing here parses one.
  const matrix: AuthorityMatrix = ownerModeled();
  ok(
    matrix.cells.some((one) =>
      cellKey(one.row, one.column) === cellKey(OWNER, "candidate.admit")
    ),
  );
});
