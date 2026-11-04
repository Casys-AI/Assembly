import { SYSML_TOOLKIT_VERSION } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import assert from "node:assert/strict";
import { memoryUsage } from "node:process";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { ToolkitModelBoardReader } from "../../src/adapters/out/sysml-toolkit/projections/board-reader.ts";
import { ModelBoardService } from "../../src/application/model/projections/board.ts";
import { createModelBoardHandler } from "../../src/adapters/in/http/model/board.ts";
import type {
  BoardItem,
  ModelBoard,
} from "../../src/domain/model/records/board.ts";
import type * as Board from "../../src/domain/model/records/board.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

function items(board: ModelBoard): BoardItem[] {
  const visit = (
    item: BoardItem,
  ): BoardItem[] => [item, ...(item.children ?? []).flatMap(visit)];
  return board.columns.flatMap((column) => column.items.flatMap(visit));
}

/** Every closed record has a compiler-exhaustive key set. Open contract maps
 * (rule, diagnostic.context, anchors, fieldSources, timingMs) retain their
 * explicitly declared arbitrary keys. No prototype-only fields may escape. */
const boardKeys = {
  model: {
    schema: true,
    meta: true,
    columns: true,
    links: true,
    index: true,
  } satisfies Record<keyof Board.ModelBoard, true>,
  meta: {
    model: true,
    mode: true,
    toolkit: true,
    sourceDigest: true,
    modeRule: true,
    anchors: true,
    linkLabels: true,
    counts: true,
    packages: true,
    diagnostics: true,
    fieldSources: true,
    timingMs: true,
    digest: true,
  } satisfies Record<keyof Board.BoardMeta, true>,
  column: { id: true, title: true, rule: true, items: true } satisfies Record<
    keyof Board.BoardColumn,
    true
  >,
  item: {
    id: true,
    element: true,
    keyword: true,
    title: true,
    summary: true,
    summarySource: true,
    qname: true,
    file: true,
    line: true,
    col: true,
    kind: true,
    type: true,
    definition: true,
    group: true,
    scope: true,
    family: true,
    operatorKind: true,
    titleSource: true,
    subject: true,
    satisfiedBy: true,
    owner: true,
    expression: true,
    inForce: true,
    values: true,
    access: true,
    children: true,
    ports: true,
    steps: true,
    io: true,
    flow: true,
    track: true,
    clauses: true,
    depth: true,
    open: true,
  } satisfies Record<keyof Board.BoardItem, true>,
  ref: { title: true, qname: true } satisfies Record<
    keyof Board.BoardRef,
    true
  >,
  value: {
    name: true,
    line: true,
    defines: true,
    value: true,
  } satisfies Record<keyof Board.BoardValueEntry, true>,
  grant: { file: true, qualifiedRoots: true } satisfies Record<
    keyof Board.BoardGrant,
    true
  >,
  access: {
    access: true,
    title: true,
    caller: true,
    enabled: true,
  } satisfies Record<keyof Board.BoardAccess, true>,
  port: {
    id: true,
    element: true,
    keyword: true,
    title: true,
    qname: true,
    file: true,
    line: true,
    col: true,
    type: true,
    conjugated: true,
    inherited: true,
    items: true,
    linked: true,
  } satisfies Record<keyof Board.BoardPort, true>,
  portItem: { dir: true, title: true, type: true } satisfies Record<
    keyof Board.BoardPortItem,
    true
  >,
  io: { dir: true, title: true, type: true, element: true } satisfies Record<
    keyof Board.BoardIo,
    true
  >,
  loop: { to: true, toTitle: true } satisfies Record<
    keyof Board.BoardLoop,
    true
  >,
  step: {
    id: true,
    element: true,
    kind: true,
    branch: true,
    col: true,
    depth: true,
    file: true,
    forward: true,
    guard: true,
    keyword: true,
    line: true,
    loops: true,
    n: true,
    qname: true,
    title: true,
    to: true,
    toTitle: true,
    type: true,
    unreachable: true,
  } satisfies Record<keyof Board.BoardStep, true>,
  clause: {
    id: true,
    element: true,
    keyword: true,
    title: true,
    qname: true,
    file: true,
    line: true,
    col: true,
    expression: true,
  } satisfies Record<keyof Board.BoardClause, true>,
  flow: {
    nodes: true,
    edges: true,
    back: true,
    supplemented: true,
    unresolved: true,
    sequential: true,
    summary: true,
  } satisfies Record<keyof Board.BoardFlow, true>,
  flowSummary: {
    steps: true,
    decisions: true,
    merges: true,
    forks: true,
    loops: true,
    unreachable: true,
  } satisfies Record<keyof Board.BoardFlow["summary"], true>,
  transition: {
    id: true,
    element: true,
    name: true,
    on: true,
    guard: true,
    to: true,
    toTitle: true,
    back: true,
    inherited: true,
    file: true,
    line: true,
  } satisfies Record<keyof Board.BoardTrackTransition, true>,
  state: {
    id: true,
    element: true,
    keyword: true,
    title: true,
    qname: true,
    file: true,
    line: true,
    col: true,
    rank: true,
    initial: true,
    terminal: true,
    inherited: true,
    out: true,
  } satisfies Record<keyof Board.BoardTrackState, true>,
  track: {
    initial: true,
    mainCount: true,
    transitions: true,
    extends: true,
    states: true,
  } satisfies Record<keyof Board.BoardTrack, true>,
  group: { element: true, title: true } satisfies Record<
    keyof Board.BoardGroup,
    true
  >,
  link: {
    id: true,
    kind: true,
    role: true,
    from: true,
    to: true,
    via: true,
    file: true,
    line: true,
    exact: true,
    derived: true,
    enabled: true,
    strength: true,
  } satisfies Record<keyof Board.BoardLink, true>,
  index: { column: true, card: true } satisfies Record<
    keyof Board.BoardIndexEntry,
    true
  >,
  diagnostic: {
    code: true,
    severity: true,
    context: true,
    recovery: true,
  } satisfies Record<keyof Board.BoardDiagnostic, true>,
  counts: {
    files: true,
    namedElements: true,
    items: true,
    linksTotal: true,
    invariants: true,
  } satisfies Record<keyof NonNullable<Board.BoardMeta["counts"]>, true>,
  countItem: { column: true, items: true } satisfies Record<
    keyof NonNullable<Board.BoardMeta["counts"]>["items"][number],
    true
  >,
  invariants: { checked: true, violations: true } satisfies Record<
    keyof NonNullable<NonNullable<Board.BoardMeta["counts"]>["invariants"]>,
    true
  >,
  package: { qname: true, doc: true, file: true, line: true } satisfies Record<
    keyof NonNullable<Board.BoardMeta["packages"]>[number],
    true
  >,
  linkLabel: { forward: true, reverse: true, derived: true } satisfies Record<
    keyof NonNullable<Board.BoardMeta["linkLabels"]>[string],
    true
  >,
  toolkit: { version: true } satisfies Record<
    keyof NonNullable<Board.BoardMeta["toolkit"]>,
    true
  >,
};

function verifyClosedBoard(board: ModelBoard): void {
  const keys = (value: object, allowed: object, path: string) => {
    assert.deepEqual(
      Object.keys(value).filter((key) => !Object.hasOwn(allowed, key)),
      [],
      `undeclared board field at ${path}`,
    );
  };
  const ref = (value: Board.BoardRef | undefined, path: string) => {
    if (value) {
      keys(value, boardKeys.ref, path);
      assert.ok(
        value.title && value.title !== "?",
        `${path}: a reference has a real title`,
      );
      assert.ok(value.qname, `${path}: a reference has a qualified name`);
    }
  };
  const visit = (item: BoardItem, path: string) => {
    keys(item, boardKeys.item, path);
    for (const name of ["type", "subject", "owner"] as const) {
      ref(item[name], `${path}.${name}`);
    }
    item.group?.forEach((group) =>
      keys(group, boardKeys.group, `${path}.group`)
    );
    item.values?.forEach((value) => {
      keys(value, boardKeys.value, `${path}.values`);
      if (Array.isArray(value.value)) {
        for (const grant of value.value) {
          if (typeof grant === "object" && grant !== null) {
            keys(grant, boardKeys.grant, `${path}.values.grant`);
          }
        }
      }
    });
    item.access?.forEach((access) =>
      keys(access, boardKeys.access, `${path}.access`)
    );
    item.ports?.forEach((port) => {
      keys(port, boardKeys.port, `${path}.ports`);
      ref(port.type, `${path}.ports.type`);
      port.items.forEach((entry) => {
        keys(entry, boardKeys.portItem, `${path}.ports.items`);
        assert.ok(
          entry.type === undefined ||
            (entry.type.length > 0 && entry.type !== "?"),
        );
      });
    });
    item.steps?.forEach((step) => {
      keys(step, boardKeys.step, `${path}.steps`);
      ref(step.type, `${path}.steps.type`);
      step.loops?.forEach((loop) =>
        keys(loop, boardKeys.loop, `${path}.steps.loops`)
      );
    });
    item.io?.forEach((io) => {
      keys(io, boardKeys.io, `${path}.io`);
      assert.ok(
        io.type === undefined || (io.type.length > 0 && io.type !== "?"),
      );
    });
    item.clauses?.forEach((clause) =>
      keys(clause, boardKeys.clause, `${path}.clauses`)
    );
    if (item.flow) {
      keys(item.flow, boardKeys.flow, `${path}.flow`);
      keys(item.flow.summary, boardKeys.flowSummary, `${path}.flow.summary`);
    }
    if (item.track) {
      keys(item.track, boardKeys.track, `${path}.track`);
      ref(item.track.extends, `${path}.track.extends`);
      item.track.states.forEach((state) => {
        keys(state, boardKeys.state, `${path}.track.states`);
        state.out.forEach((transition) =>
          keys(transition, boardKeys.transition, `${path}.track.states.out`)
        );
      });
    }
    item.children?.forEach((child, index) =>
      visit(child, `${path}.children[${index}]`)
    );
  };
  keys(board, boardKeys.model, "board");
  keys(board.meta, boardKeys.meta, "meta");
  if (board.meta.toolkit) {
    keys(board.meta.toolkit, boardKeys.toolkit, "meta.toolkit");
  }
  if (board.meta.counts) {
    keys(board.meta.counts, boardKeys.counts, "meta.counts");
    board.meta.counts.items.forEach((item) =>
      keys(item, boardKeys.countItem, "meta.counts.items")
    );
    if (board.meta.counts.invariants) {
      keys(
        board.meta.counts.invariants,
        boardKeys.invariants,
        "meta.counts.invariants",
      );
    }
  }
  board.meta.packages?.forEach((pkg) =>
    keys(pkg, boardKeys.package, "meta.packages")
  );
  Object.values(board.meta.linkLabels ?? {}).forEach((label) =>
    keys(label, boardKeys.linkLabel, "meta.linkLabels")
  );
  board.meta.diagnostics.forEach((diagnostic) =>
    keys(diagnostic, boardKeys.diagnostic, "meta.diagnostics")
  );
  board.columns.forEach((column) => {
    keys(column, boardKeys.column, `columns.${column.id}`);
    column.items.forEach((item, index) =>
      visit(item, `columns.${column.id}.items[${index}]`)
    );
  });
  board.links.forEach((link) => keys(link, boardKeys.link, "links"));
  Object.values(board.index).forEach((entry) =>
    keys(entry, boardKeys.index, "index")
  );
}

function verifyTypedValues(
  board: ModelBoard,
): { grants: number; lists: number; families: Set<string> } {
  let grants = 0;
  let lists = 0;
  const families = new Set<string>();
  const policyFamilies: Record<string, string> = {
    "APEContext::DecisionContextPolicy": "context",
    "APESkills::SkillPolicy": "skill",
    "APEMemory::GovernedMemoryPolicy": "memory",
  };
  for (const item of items(board)) {
    if (item.satisfiedBy !== undefined) {
      assert.ok(Array.isArray(item.satisfiedBy));
      assert.ok(item.satisfiedBy.every((owner) => typeof owner === "string"));
    }
    for (const value of item.values ?? []) {
      if (value.defines && typeof value.value === "string") {
        let decoded: unknown;
        try {
          decoded = JSON.parse(value.value);
        } catch {
          // Ordinary strings are valid scalar values.
        }
        assert.ok(
          decoded === null || typeof decoded !== "object",
          `${value.defines} must not expose an array/object encoded as a string`,
        );
      }
      if (
        value.defines?.endsWith("Policy::grants") &&
        [
          "AssemblyModelEditing::ModelEditPolicy::grants",
          "ASEModelEditing::ModelEditPolicy::grants",
          "AssemblyModelAdministration::ModelAdministrationPolicy::grants",
          "ASEModelAdministration::ModelAdministrationPolicy::grants",
        ].includes(value.defines)
      ) {
        grants++;
        assert.ok(
          Array.isArray(value.value),
          `${value.defines} is a typed grant array`,
        );
        for (const grant of value.value) {
          assert.ok(typeof grant === "object" && grant !== null);
          assert.equal(typeof grant.file, "string");
          assert.ok(Array.isArray(grant.qualifiedRoots));
          assert.ok(
            grant.qualifiedRoots.every((root: unknown) =>
              typeof root === "string"
            ),
          );
        }
      }
      const definition = value.defines?.split("::").slice(0, 2).join("::");
      const expected = definition && policyFamilies[definition];
      if (expected) {
        assert.equal(item.kind, "policy");
        assert.equal(
          item.family,
          expected,
          `${value.defines} determines the context family`,
        );
        families.add(expected);
      }
      if (value.defines === "APESkills::SkillPolicy::allowedHosts") {
        lists++;
        assert.ok(Array.isArray(value.value));
        assert.ok(value.value.every((host) => typeof host === "string"));
      }
    }
  }
  return { grants, lists, families };
}

/** Recalculate the prototype's invariants from the public output. This does
 * not trust the projector's diagnostic list or its own invariant counter. */
function verifyInvariants(board: ModelBoard): number {
  let checked = 0;
  const links = new Set<string>();
  for (const link of board.links) {
    checked += 3;
    assert.ok(!links.has(link.id), `duplicate link ${link.id}`);
    links.add(link.id);
    assert.ok(board.index[link.from], `unknown source ${link.from}`);
    assert.ok(board.index[link.to], `unknown target ${link.to}`);
  }
  const source = (
    thing: { id: string; element?: string; file?: string; line?: number },
  ) => {
    checked++;
    assert.ok(thing.element, `missing native element on ${thing.id}`);
    assert.ok(thing.file, `missing source file on ${thing.id}`);
    assert.ok((thing.line ?? 0) > 0, `missing source line on ${thing.id}`);
  };
  for (const item of items(board)) {
    source(item);
    item.ports?.forEach(source);
    item.steps?.filter((step) => step.kind !== "goto" && step.element).forEach(
      source,
    );
    item.track?.states?.forEach(source);
    item.clauses?.forEach(source);
  }
  assert.ok(checked > 0, "the fixture exercised public board invariants");
  const invariantCodes = new Set([
    "DUPLICATE_LINK_ID",
    "LINK_ENDPOINT_UNKNOWN",
    "THING_WITHOUT_SOURCE",
  ]);
  assert.deepEqual(
    board.meta.diagnostics.filter((diagnostic) =>
      invariantCodes.has(diagnostic.code)
    ),
    [],
  );
  if (board.meta.counts?.invariants) {
    assert.equal(board.meta.counts.invariants.violations, 0);
    assert.equal(board.meta.counts.invariants.checked, checked);
  }
  return checked;
}

Deno.test({
  name:
    "real Toolkit board: initial invariants, source-order determinism, ASE absence and generic mode",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const tooling = new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = await loadInitialSources();
    const version = `commit:${"a".repeat(40)}`;
    const reads: string[] = [];
    const service = new ModelBoardService(
      new ToolkitModelBoardReader({
        at(requested) {
          reads.push(requested);
          return Promise.resolve({
            version,
            sources,
            elements: [],
            documents: [],
            sourceDigest: "repository digest",
            semanticDigest: "",
            provenanceDigest: "",
            sourceHashes: {},
            engineVersion: "test",
          });
        },
      }, tooling),
    );
    const handle = createModelBoardHandler(
      service,
      () => Promise.resolve(version),
    );
    const start = performance.now();
    const response = await handle(
      new Request(`http://atelier.test/api/model/board?version=${version}`),
    );
    assert.equal(response?.status, 200);
    assert.equal(
      response?.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    const initial = await response?.json() as ModelBoard;
    const coldMs = performance.now() - start;
    assert.equal(initial.schema, "ase.board/1");
    assert.equal(initial.meta.mode, "ase");
    assert.equal(initial.meta.toolkit?.version, SYSML_TOOLKIT_VERSION);
    assert.equal(response?.headers.get("etag"), `"${initial.meta.digest}"`);
    assert.ok(initial.columns.some((column) => column.items.length > 0));
    const invariants = verifyInvariants(initial);
    verifyClosedBoard(initial);
    assert.equal(initial.meta.sourceDigest, await modelSourceDigest(sources));
    assert.ok(items(initial).some((item) => item.kind === "authority"));
    const typed = verifyTypedValues(initial);
    assert.ok(typed.lists > 0, "initial model exercises typed host lists");
    assert.deepEqual([...typed.families].sort(), [
      "context",
      "memory",
      "skill",
    ]);
    const liveBuilder = items(initial)
      .filter((item) => item.kind === "scope")
      .find((item) =>
        item.values?.some((value) =>
          value.name === "operatorName" && value.value === "Main Operator"
        )
      );
    assert.ok(liveBuilder, "liveBuilder operatorName is displayed");
    assert.equal(
      liveBuilder.values?.find((value) => value.name === "primaryContact")
        ?.value,
      true,
    );
    assert.equal(
      liveBuilder.values?.find((value) => value.name === "humanInputEnabled")
        ?.value,
      true,
    );
    const headResponse = await handle(
      new Request("http://atelier.test/api/model/board"),
    );
    assert.equal(headResponse?.status, 200);
    assert.equal(headResponse?.headers.get("cache-control"), "no-store");
    assert.deepEqual(await headResponse?.json(), initial);
    const cachedResponse = await handle(
      new Request(`http://atelier.test/api/model/board?version=${version}`, {
        headers: { "if-none-match": `"${initial.meta.digest}"` },
      }),
    );
    assert.equal(cachedResponse?.status, 304);
    assert.equal(await cachedResponse?.text(), "");
    for (const query of ["version=branch:main", `version=${version}&extra=1`]) {
      const invalid = await handle(
        new Request(`http://atelier.test/api/model/board?${query}`),
      );
      assert.equal(invalid?.status, 400);
      assert.equal(invalid?.headers.get("cache-control"), "no-store");
      await invalid?.body?.cancel();
    }
    assert.deepEqual(
      reads,
      [version],
      "immutable reader/service/HTTP composition shares the board computation",
    );
    const warmStart = performance.now();
    const reversed = JSON.parse(JSON.stringify(
      await tooling.board(
        Object.fromEntries(Object.entries(sources).reverse()),
      ),
    )) as ModelBoard;
    const warmMs = performance.now() - warmStart;
    assert.equal(reversed.meta.digest, initial.meta.digest);
    assert.equal(reversed.meta.sourceDigest, initial.meta.sourceDigest);
    assert.deepEqual(reversed.columns, initial.columns);
    assert.deepEqual(reversed.links, initial.links);
    assert.deepEqual(reversed.index, initial.index);
    console.log(
      JSON.stringify({
        qualification: "real Toolkit board",
        coldMs,
        warmMs,
        invariants,
        digest: initial.meta.digest,
      }),
    );

    const minimal = {
      "minimal.sysml":
        "package Minimal { part def Machine; part machine : Machine; }",
    };
    const absent = await tooling.board(minimal);
    assert.equal(absent.meta.mode, "ase");
    assert.ok(absent.columns.every((column) => column.items.length === 0));
    assert.ok(
      absent.meta.diagnostics.some((diagnostic) =>
        diagnostic.code === "ANCHOR_UNRESOLVED"
      ),
    );
    for (const diagnostic of absent.meta.diagnostics) {
      assert.equal(typeof diagnostic.code, "string");
      assert.ok(diagnostic.context && typeof diagnostic.context === "object");
      assert.ok(diagnostic.recovery.length > 0);
    }
    const generic = await tooling.board(minimal, { mode: "generic" });
    assert.equal(generic.meta.mode, "generic");
    assert.ok(generic.columns.some((column) => column.items.length > 0));
    assert.deepEqual(
      generic.meta.diagnostics.filter((diagnostic) =>
        diagnostic.severity === "error"
      ),
      [],
    );
    verifyInvariants(generic);
    verifyClosedBoard(generic);
  },
});

Deno.test({
  name:
    "real Toolkit board preserves commercial-watch operatorName and typed primaryContact",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const tooling = new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = JSON.parse(
      await Deno.readTextFile(
        new URL(
          "../fixtures/commercial-watch/sources.json",
          import.meta.url,
        ),
      ),
    ) as Record<string, string>;
    const board = await tooling.board(sources, { model: "commercial-watch" });
    verifyInvariants(board);
    verifyClosedBoard(board);
    assert.ok(
      verifyTypedValues(board).grants >= 2,
      "commercial-watch exercises both specialists' typed grants",
    );
    const scopes = items(board).filter((item) => item.kind === "scope");
    for (
      const [name, primary] of [["Coordinateur veille", true], [
        "Collecteur",
        false,
      ], ["Analyste", false]] as const
    ) {
      const scope = scopes.find((item) =>
        item.values?.some((value) =>
          value.name === "operatorName" && value.value === name
        )
      );
      assert.ok(scope, `operatorName ${name} is displayed`);
      assert.equal(
        scope.values?.find((value) => value.name === "primaryContact")?.value,
        primary,
      );
    }
  },
});

Deno.test({
  name:
    "real Toolkit board bounds recursive panels and retains repeated sibling types",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const tooling = new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = {
      ...await loadInitialSources(),
      "board-recursion.sysml": await Deno.readTextFile(
        new URL("../fixtures/model-board-recursion.sysml", import.meta.url),
      ),
    };
    const board = await tooling.board(sources);
    verifyClosedBoard(board);
    const tree = items(board).find((item) => item.qname === "RecLab::tree");
    assert.ok(tree, "recursive root remains visible");
    assert.ok(
      tree.children?.some((item) =>
        item.kind === "operator" && item.title === "op"
      ),
      "operator survives recursive truncation",
    );
    assert.ok(
      tree.children?.some((item) => item.title === "kids"),
      "cycle is represented as a leaf",
    );
    const diagnostics = board.meta.diagnostics.filter((diagnostic) =>
      diagnostic.code === "PANEL_RECURSION_TRUNCATED"
    );
    assert.ok(
      diagnostics.some((diagnostic) =>
        diagnostic.context.definition === "RecLab::Node"
      ),
    );
    assert.ok(
      diagnostics.every((diagnostic) => diagnostic.severity === "info"),
    );
    const twins = items(board).find((item) => item.qname === "RecLab::twins");
    assert.ok(twins);
    for (const name of ["left", "right"]) {
      const sibling: BoardItem | undefined = twins.children?.find(
        (child: BoardItem) => child.title === name,
      );
      assert.ok(
        sibling?.children?.some((child: BoardItem) =>
          child.title === "op" && child.kind === "operator"
        ),
        `${name} expands its shared Leaf definition`,
      );
    }
    assert.ok(
      !diagnostics.some((diagnostic) =>
        diagnostic.context.definition === "RecLab::Leaf"
      ),
      "sibling reuse is not a cycle",
    );
    const deep = items(board).find((item) => item.qname === "RecLab::deep");
    assert.ok(deep, "acyclic deep hierarchy remains visible");
    const descendants = (item: BoardItem): BoardItem[] => [
      item,
      ...(item.children ?? []).flatMap(descendants),
    ];
    const deepItems = descendants(deep);
    assert.ok(
      deepItems.some((item) => item.depth === 12 && !item.children?.length),
      "the acyclic depth boundary is represented as a leaf",
    );
    assert.ok(
      deepItems.every((item) => (item.depth ?? 0) <= 12),
      "no panel exceeds the hard depth cap",
    );
    assert.ok(
      diagnostics.some((diagnostic) =>
        diagnostic.context.definition === "RecLab::Layer12"
      ),
      "distinct acyclic typing definitions trigger the independent depth cap",
    );
    const generic = await tooling.board({
      "recursive.sysml":
        "package RecM { part def Node { part kids : Node; } part tree : Node; }",
    }, { mode: "generic" });
    verifyClosedBoard(generic);
    assert.ok(items(generic).some((item) => item.qname === "RecM::tree"));
    assert.ok(
      generic.meta.diagnostics.some((diagnostic) =>
        diagnostic.code === "PANEL_RECURSION_TRUNCATED" &&
        diagnostic.severity === "info"
      ),
    );
  },
});

Deno.test({
  name: "real Toolkit board keeps closed loop, port and documentation records",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const tooling = new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const initial = await loadInitialSources();
    const board = await tooling.board({
      ...initial,
      "board-loops.sysml": await Deno.readTextFile(
        new URL("../fixtures/model-board-loops.sysml", import.meta.url),
      ),
      "board-odd.sysml": await Deno.readTextFile(
        new URL("../fixtures/model-board-odd.sysml", import.meta.url),
      ),
    });
    verifyClosedBoard(board);
    verifyTypedValues(board);
    const ring = items(board).find((item) => item.qname === "Loops::Ring");
    assert.ok(
      ring?.track?.states.some((state) =>
        state.out.some((transition) => transition.back)
      ),
      "cyclic lifecycle transitions are exercised",
    );
    assert.ok(
      items(board).some((item) => item.steps?.some((step) => step.unreachable)),
      "unreachable flow step is exercised",
    );
    const port = items(board).find((item) => item.qname === "Odd::host")?.ports
      ?.find((port) => port.title === "p");
    assert.ok(port, "untyped native port is visible");
    assert.equal(
      port.type,
      undefined,
      "absent port type has no sentinel reference",
    );
    const noInitial = items(board).find((item) =>
      item.qname === "Odd::NoInitial"
    );
    assert.ok(
      noInitial?.track,
      "state definition without an initial state is exercised",
    );
    assert.equal(
      noInitial.track.initial,
      undefined,
      "absent initial state has no empty-string sentinel",
    );
    for (const item of items(board)) {
      for (const step of item.steps ?? []) {
        assert.notEqual(step.element, "", "missing step elements are optional");
      }
    }
    assert.equal(
      board.meta.packages?.find((pkg) => pkg.qname === "DocProbe")?.doc,
      // The real Toolkit removes these comment-leading stars before docs()
      // returns. Literal stars supplied by the API are covered in the unit test.
      "Rules apply: first rule second rule",
    );
    assert.equal(
      board.meta.packages?.find((pkg) => pkg.qname === "'Weird::Pkg'")?.doc,
      "A quoted package.",
    );
  },
});

Deno.test({
  name:
    "real Toolkit long-lived worker RSS smoke across thirty warm board projections",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const tooling = new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    const sources = await loadInitialSources();
    const warmup = await tooling.board(sources);
    const baseline = memoryUsage().rss;
    const samples: number[] = [];
    const timings: number[] = [];
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const board = await tooling.board(sources);
      timings.push(performance.now() - start);
      assert.equal(board.meta.digest, warmup.meta.digest);
      samples.push(memoryUsage().rss);
    }
    const limit = 128 * 1024 * 1024;
    const final = samples.at(-1)!;
    const peak = Math.max(...samples);
    console.log(JSON.stringify({
      qualification: "real Toolkit board RSS; process includes worker threads",
      calls: 30,
      baseline,
      final,
      peak,
      growth: final - baseline,
      peakGrowth: peak - baseline,
      limit,
      timingsMs: timings,
    }));
    assert.ok(
      final - baseline < limit,
      `final RSS growth ${final - baseline} exceeds ${limit}`,
    );
    assert.ok(
      peak - baseline < limit,
      `peak RSS growth ${peak - baseline} exceeds ${limit}`,
    );
  },
});
