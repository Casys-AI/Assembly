// A body from the wire is edited at any depth to break it in one place: what
// each case breaks is named by its path, so the test does not type the tree.
// deno-lint-ignore-file no-explicit-any
import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import {
  board,
  crowdBoard,
  initialBoard,
  item,
  kitchenSink,
  watchBoard,
} from "../../../test/support/board-fixture.ts";
import { BoardParseError, parseModelBoard } from "./parse.ts";

/** A board as it comes over the wire: JSON, nothing shared with the fixture. */
const wire = (value: ModelBoard): Record<string, any> =>
  JSON.parse(JSON.stringify(value));

/** What reading `body` is refused with: where, and what was expected. */
function refusal(body: unknown): { path: string; expected: string } {
  try {
    parseModelBoard(body);
  } catch (failure) {
    ok(failure instanceof BoardParseError, String(failure));
    return { path: failure.path, expected: failure.expected };
  }
  throw new Error("the body was read as a board");
}

Deno.test("a board the host projects is read whole: every property it holds is kept", () => {
  for (
    const projected of [
      initialBoard(),
      watchBoard(),
      crowdBoard(15),
      kitchenSink(),
    ]
  ) {
    deepStrictEqual(parseModelBoard(wire(projected)), wire(projected));
  }
});

Deno.test("absence is how the contract says optional: nothing is made up, no property is undefined or null", () => {
  const read = parseModelBoard(
    wire(board({ team: [item("a", "scope", "A")] })),
  );
  const unit = read.columns[0].items[0];
  deepStrictEqual(Object.keys(unit).sort(), [
    "element",
    "file",
    "id",
    "keyword",
    "kind",
    "line",
    "qname",
    "title",
  ]);
  equal(unit.qname, null);
  // The columns the model fills no item of are still there, empty.
  deepStrictEqual(read.columns.map((column) => column.items.length), [
    1,
    0,
    0,
    0,
    0,
  ]);
});

Deno.test("what the contract does not name is dropped, at every depth", () => {
  const body = wire(initialBoard());
  body.extra = 1;
  body.meta.extra = 2;
  body.columns[0].extra = 3;
  body.columns[0].items[0].extra = 4;
  body.columns[0].items[0].children[0].extra = 5;
  body.columns[2].items[2].values[0].extra = 6;
  body.links[0].extra = 7;
  const read = JSON.stringify(parseModelBoard(body));
  equal(read, JSON.stringify(parseModelBoard(wire(initialBoard()))));
  ok(!read.includes('"extra"'));
});

Deno.test("a body that is not a board of this schema is refused, with where it stopped being one", () => {
  for (const body of [null, undefined, "board", 3, [], true]) {
    deepStrictEqual(refusal(body), { path: "board", expected: "an object" });
  }
  const other = wire(initialBoard());
  other.schema = "ase.board/2";
  deepStrictEqual(refusal(other), {
    path: "board.schema",
    expected: "one of ase.board/1",
  });
  for (const key of ["schema", "meta", "columns", "links", "index"]) {
    const missing = wire(initialBoard());
    delete missing[key];
    deepStrictEqual(refusal(missing), {
      path: `board.${key}`,
      expected: "a value",
    });
  }
  const meta = wire(initialBoard());
  delete meta.meta.digest;
  equal(refusal(meta).path, "board.meta.digest");
});

Deno.test("the unions are closed: a name the contract lacks is the contract moving, and says where", () => {
  const cases: [string, (body: Record<string, any>) => void][] = [
    ["board.columns[1].id", (b) => (b.columns[1].id = "extras")],
    [
      "board.columns[0].items[0].kind",
      (b) => (b.columns[0].items[0].kind = "widget"),
    ],
    [
      "board.columns[0].items[0].children[1].operatorKind",
      (b) => (b.columns[0].items[0].children[1].operatorKind = "robot"),
    ],
    [
      "board.columns[2].items[3].family",
      (b) => (b.columns[2].items[3].family = "habit"),
    ],
    ["board.links[0].kind", (b) => (b.links[0].kind = "teleport")],
    ["board.links[0].role", (b) => (b.links[0].role = "boss")],
    ["board.meta.mode", (b) => (b.meta.mode = "wild")],
  ];
  for (const [path, change] of cases) {
    const body = wire(initialBoard());
    change(body);
    equal(refusal(body).path, path);
  }
  const severity = wire(kitchenSink());
  severity.meta.diagnostics = [{
    code: "X",
    severity: "fatal",
    context: {},
    recovery: "",
  }];
  equal(refusal(severity).path, "board.meta.diagnostics[0].severity");
});

Deno.test("a property that is optional is absent, never null; one that may be null says so", () => {
  const body = wire(initialBoard());
  // qname, expression, defines and the like are null when the host says so...
  body.columns[0].items[0].qname = null;
  parseModelBoard(body);
  // ...but an optional property that is not there is not there.
  for (const name of ["summary", "scope", "family", "type", "children"]) {
    const nulled = wire(initialBoard());
    nulled.columns[0].items[0][name] = null;
    equal(refusal(nulled).path, `board.columns[0].items[0].${name}`, name);
  }
  const required = wire(initialBoard());
  required.columns[0].items[0].title = null;
  equal(refusal(required).path, "board.columns[0].items[0].title");
});

Deno.test("values are typed: a scalar, a list of strings or a list of grants, never anything else", () => {
  const read = (value: unknown) => {
    const body = wire(initialBoard());
    body.columns[2].items[1].values = [{ name: "v", line: 1, value }];
    return parseModelBoard(body).columns[2].items[1].values![0].value;
  };
  equal(read("text"), "text");
  equal(read(3), 3);
  equal(read(false), false);
  // JSON held in a string stays the string the host wrote.
  equal(read("[]"), "[]");
  deepStrictEqual(read(["a", "b"]), ["a", "b"]);
  deepStrictEqual(read([]), []);
  const grants = [{ file: "a.sysml", qualifiedRoots: ["A::b"] }];
  deepStrictEqual(read(grants), grants);
  const unreadable = (value: unknown) => {
    const body = wire(initialBoard());
    body.columns[2].items[1].values = [{ name: "v", line: 1, value }];
    return refusal(body).path;
  };
  const path = "board.columns[2].items[1].values[0].value";
  equal(unreadable({ a: 1 }), path);
  equal(unreadable(null), path);
  equal(unreadable(Number.NaN), path);
  equal(unreadable(Infinity), path);
  // A list that mixes strings and grants is neither.
  equal(
    unreadable(["a", { file: "a", qualifiedRoots: [] }]).startsWith(path),
    true,
  );
  equal(unreadable([{ file: "a" }]), `${path}[0].qualifiedRoots`);
  equal(unreadable([{ file: 1, qualifiedRoots: [] }]), `${path}[0].file`);
});

Deno.test("numbers must be numbers: a line that is text is refused where it is", () => {
  const body = wire(initialBoard());
  body.columns[0].items[0].line = "12";
  deepStrictEqual(refusal(body), {
    path: "board.columns[0].items[0].line",
    expected: "a finite number",
  });
  const flows = wire(kitchenSink());
  flows.columns[1].items[0].flow.summary.steps = "2";
  equal(
    refusal(flows).path,
    "board.columns[1].items[0].flow.summary.steps",
  );
});

Deno.test("nested shapes are read at their depth: steps, ports, tracks, clauses, access", () => {
  const sink = () => wire(kitchenSink());
  const at = [
    [
      "board.columns[1].items[0].steps[1].type.qname",
      (b: any) => delete b.columns[1].items[0].steps[1].type.qname,
    ],
    [
      "board.columns[1].items[0].steps[0].loops[0].to",
      (b: any) => (b.columns[1].items[0].steps[0].loops[0].to = 1),
    ],
    [
      "board.columns[1].items[0].access[0].enabled",
      (b: any) => (b.columns[1].items[0].access[0].enabled = "yes"),
    ],
    [
      "board.columns[0].items[0].ports[0].items[0].dir",
      (b: any) => (b.columns[0].items[0].ports[0].items[0].dir = 1),
    ],
    [
      "board.columns[3].items[0].track.states[0].out[0].back",
      (b: any) => (b.columns[3].items[0].track.states[0].out[0].back = 0),
    ],
    [
      "board.columns[3].items[1].clauses[0].line",
      (b: any) => (b.columns[3].items[1].clauses[0].line = "3"),
    ],
    ["board.index.a.column", (b: any) => (b.index.a.column = "nowhere")],
    ["board.meta.diagnostics", (b: any) => (b.meta.diagnostics = {})],
  ] as const;
  for (const [path, change] of at) {
    const body = sink();
    change(body);
    equal(refusal(body).path, path);
  }
});

Deno.test("reading never throws anything but a refusal, whatever the body", () => {
  const bodies: unknown[] = [
    {},
    { schema: "ase.board/1" },
    { schema: "ase.board/1", meta: {}, columns: [], links: [], index: {} },
    { schema: "ase.board/1", meta: null, columns: null },
    wire(initialBoard()).columns,
    JSON.parse(`{"schema":"ase.board/1","columns":"[]"}`),
  ];
  for (const body of bodies) {
    throws(() => parseModelBoard(body), BoardParseError);
  }
});

Deno.test("a deeply nested board is read, and a refusal inside it names the whole path", () => {
  let panel = item("leaf", "machine", "leaf");
  for (let depth = 0; depth < 40; depth++) {
    panel = item(`p${depth}`, "machine", `p${depth}`, { children: [panel] });
  }
  const body = wire(board({ team: [panel] }));
  parseModelBoard(body);
  let node = body.columns[0].items[0];
  let path = "board.columns[0].items[0]";
  while (node.children) {
    node = node.children[0];
    path += ".children[0]";
  }
  node.kind = "widget";
  equal(refusal(body).path, `${path}.kind`);
});
