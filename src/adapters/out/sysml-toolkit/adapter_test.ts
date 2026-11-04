import { NativeToolkitPanicError } from "./runtime/native-addon.ts";
import { deepStrictEqual, equal, notEqual, rejects } from "node:assert/strict";
import type { ModelToolingDiagnostic } from "../../../application/model/tooling.ts";
import type {
  ModelToolingTarget,
  ResolvedModelEdit,
} from "../../../domain/model/editing/tooling.ts";
import { parseSysmlQualifiedName } from "../../../domain/model/value-objects/sysml-qualified-name.ts";
import { SysmlToolkitAdapter, SysmlToolkitError } from "./adapter.ts";
import {
  loadSysmlToolkit,
  type ToolkitElement,
  type ToolkitRuntime,
  type ToolkitSession,
} from "./runtime/loader.ts";

const declaration = "attribute amount : Integer = 1;";
const sources = {
  "model.sysml":
    `package Demo {\n    doc /* mémoire */\n    ${declaration}\n}\n`,
  "unchanged.sysml": "package Unchanged;\n",
};
const target: ModelToolingTarget = {
  qualifiedName: "Demo::amount",
  metaclass: "AttributeUsage",
  source: { path: "model.sysml", text: declaration },
};
const edits: Extract<ResolvedModelEdit, { kind: "set-value" }>[] = [{
  kind: "set-value",
  target,
  expression: "2",
}];

interface Behavior {
  referenceResponse?: unknown;
  syntax?: ModelToolingDiagnostic[];
  diagnostics?: ModelToolingDiagnostic[];
  finalDiagnostic?: ModelToolingDiagnostic;
  findings?: string[];
  libraryTarget?: boolean;
  mutatePreview?: boolean;
  mutateUnrelatedSource?: boolean;
  trap?: boolean;
  freeTrap?: boolean;
  elementFreeTrap?: string;
  boardFailure?: boolean;
  viewShape?: boolean;
  viewFailure?: boolean;
  viewGraphTrap?: boolean;
  plantumlFailure?: boolean;
  plantumlTrap?: boolean;
}

class Element implements ToolkitElement {
  constructor(readonly key: string, readonly onFree: () => void) {}
  free() {
    this.onFree();
  }
}

class Session implements ToolkitSession {
  freed = false;
  freedElements: string[] = [];
  previewCalls = 0;
  operations: unknown[] = [];
  commitCalls = 0;
  tree: Record<string, string>;
  constructor(input: string, readonly behavior: Behavior) {
    const units = JSON.parse(input) as Array<{ name: string; text: string }>;
    this.tree = Object.fromEntries(units.map((unit) => [unit.name, unit.text]));
  }
  free() {
    this.freed = true;
    if (this.behavior.freeTrap) {
      throw new NativeToolkitPanicError("free unreachable");
    }
  }
  check() {
    const after = this.commitCalls && this.behavior.finalDiagnostic
      ? [this.behavior.finalDiagnostic]
      : [];
    return JSON.stringify([...this.behavior.diagnostics ?? [], ...after]);
  }
  query(expression: string) {
    if (this.behavior.trap) throw new NativeToolkitPanicError("unreachable");
    return JSON.stringify({ expression, source: this.tree["model.sysml"] });
  }
  element(key: string) {
    return new Element(key, () => {
      this.freedElements.push(key);
      if (this.behavior.elementFreeTrap === key) {
        throw new NativeToolkitPanicError("element free unreachable");
      }
    });
  }
  resolve(name: string) {
    name = parseSysmlQualifiedName(name)?.join("::") ?? name;
    return ["Demo", "Demo::amount", "ScalarValues::Integer"].includes(name)
      ? this.element(name)
      : undefined;
  }
  elementById(id: string) {
    if (id === "n1") return this.element("Demo");
    if (id === "n2") return this.element("sysNode");
    const key = id.startsWith("id:") ? id.slice(3) : undefined;
    if (!key) return undefined;
    const name = parseSysmlQualifiedName(key)?.join("::") ?? key;
    return ["Demo", "Demo::amount", "ScalarValues::Integer"].includes(name)
      ? this.element(name)
      : undefined;
  }
  elementId(element: ToolkitElement) {
    return `id:${(element as Element).key}`;
  }
  qualifiedName(element: ToolkitElement) {
    return (element as Element).key;
  }
  referenceSpelling(element: ToolkitElement) {
    return (element as Element).key;
  }
  metaclass(element: ToolkitElement) {
    const key = (element as Element).key;
    return key === "Demo"
      ? "Package"
      : key === "ScalarValues::Integer"
      ? "DataType"
      : "AttributeUsage";
  }
  isLibraryElement(element: ToolkitElement) {
    return this.behavior.libraryTarget === true ||
      (element as Element).key === "ScalarValues::Integer";
  }
  owner(element: ToolkitElement) {
    return (element as Element).key === "Demo::amount"
      ? this.element("Demo")
      : undefined;
  }
  typings(element: ToolkitElement) {
    const key = (element as Element).key;
    if (key === "Demo::amount") {
      return [this.element("ScalarValues::Integer")];
    }
    if (key === "sysNode") return [this.element("System")];
    return [];
  }
  rows() {
    return "[]";
  }
  memberSource(name: string) {
    name = parseSysmlQualifiedName(name)?.join("::") ?? name;
    return name === "Demo" ? this.tree["model.sysml"].trimEnd() : declaration;
  }
  memberExtent(element: ToolkitElement) {
    const source = this.tree["model.sysml"];
    const content = this.memberSource((element as Element).key);
    const index = source.indexOf(content);
    const start = new TextEncoder().encode(source.slice(0, index)).length;
    return JSON.stringify({
      unit: 0,
      start,
      end: start + new TextEncoder().encode(content).length,
    });
  }
  references() {
    return JSON.stringify(
      this.behavior.referenceResponse ?? { references: [] },
    );
  }
  units() {
    return JSON.stringify(
      Object.entries(this.tree).map(([name, text], unit) => ({
        unit,
        name,
        text,
      })),
    );
  }
  property() {
    return "null";
  }
  derived() {
    return "null";
  }
  derivedElements() {
    return [];
  }
  valueSource() {
    return undefined;
  }
  redefinitionRoot(element: ToolkitElement) {
    return element;
  }
  outline() {
    if (this.behavior.boardFailure) throw new Error("board outline failed");
    if (this.behavior.viewFailure) throw new Error("view outline failed");
    if (this.behavior.trap) {
      throw new NativeToolkitPanicError("board unreachable");
    }
    const nodes = this.behavior.viewShape
      ? [{
        id: "pkg",
        name: "Demo",
        qualifiedName: "Demo",
        metaclass: "Package",
        owner: -1,
      }, {
        id: "n2",
        name: "system",
        qualifiedName: "Demo::system",
        metaclass: "PartUsage",
        owner: 99,
      }]
      : [];
    return JSON.stringify({ shape: { nodes, truncated: false } });
  }
  toGraph() {
    if (this.behavior.trap || this.behavior.viewGraphTrap) {
      throw new NativeToolkitPanicError("view unreachable");
    }
    return JSON.stringify({
      nodes: [
        { id: "n1", kind: "package", label: "Demo", rows: [] },
        { id: "n2", kind: "part", label: "system : System", rows: [] },
      ],
      edges: [],
    });
  }
  toPlantuml() {
    if (this.behavior.plantumlTrap) {
      throw new NativeToolkitPanicError("export unreachable");
    }
    if (this.behavior.plantumlFailure) throw new Error("export failed");
    return "@startuml\n@enduml";
  }
  viewInfo() {
    return JSON.stringify({ exposed: [] });
  }
  name(element: ToolkitElement) {
    return (element as Element).key;
  }
  members() {
    return [];
  }
  evaluate() {
    return "null";
  }
  elementsOfMetaclass() {
    return [];
  }
  docs() {
    return [];
  }
  conforms() {
    return false;
  }
  declarationSite(element: ToolkitElement) {
    return this.memberExtent(element);
  }
  planned(operations: string) {
    const source = this.tree["model.sysml"];
    this.operations = JSON.parse(operations);
    const operation = (this.operations as Array<{ expr?: string }>)[0];
    const index = source.indexOf("= 1;") + 2;
    const start = new TextEncoder().encode(source.slice(0, index)).length;
    return {
      findings: this.behavior.findings ?? [],
      idMap: [],
      splices: [{
        unit: "model.sysml",
        start,
        end: start + 1,
        text: operation.expr ?? "2",
      }],
    };
  }
  checkEdit(operations: string) {
    this.previewCalls++;
    const report = this.planned(operations);
    if (this.behavior.mutatePreview) {
      this.tree["model.sysml"] += "// unexpected preview mutation\n";
    }
    return JSON.stringify({ ...report, wouldCommit: true });
  }
  edit(operations: string) {
    this.commitCalls++;
    const report = this.planned(operations);
    this.operations = JSON.parse(operations);
    const operation = (this.operations as Array<{ expr?: string }>)[0];
    this.tree["model.sysml"] = this.tree["model.sysml"].replace(
      "= 1;",
      `= ${operation.expr ?? "2"};`,
    );
    if (this.behavior.mutateUnrelatedSource) {
      this.tree["unchanged.sysml"] = "package Unexpected;\n";
    }
    return JSON.stringify(report);
  }
}

function fixture(behavior: Behavior = {}) {
  const sessions: Session[] = [];
  let poisoned = false;
  const runtime: ToolkitRuntime = {
    version: "0.10.10",
    checkSyntax() {
      if (poisoned) throw new Error("runtime poisoned");
      return JSON.stringify(behavior.syntax ?? []);
    },
    createSession(input) {
      const session = new Session(input, behavior);
      sessions.push(session);
      return session;
    },
    invalidate() {
      poisoned = true;
    },
  };
  const adapter = new SysmlToolkitAdapter({
    packageDir: "not-read-by-unit-tests",
    loadRuntime: () => Promise.resolve(runtime),
  });
  return { adapter, sessions, poisoned: () => poisoned };
}

Deno.test("toolkit board uses a separate session and disposes it after asynchronous projection", async () => {
  const { adapter, sessions } = fixture();
  const original = structuredClone(sources);
  const first = await adapter.board(sources, { model: "fake", mode: "ase" });
  equal(first.schema, "ase.board/1");
  equal(first.meta.model, "fake");
  equal(first.meta.mode, "ase");
  equal(sessions[0].freed, true);
  equal(sessions[0].commitCalls, 0);
  const second = await adapter.board(sources, { mode: "generic" });
  equal(second.meta.mode, "generic");
  equal(sessions.length, 2);
  notEqual(sessions[0], sessions[1]);
  equal(sessions.every((session) => session.freed), true);
  deepStrictEqual(sources, original);
});

Deno.test("toolkit board disposes failed sessions and invalidates a trapped runtime", async () => {
  for (const behavior of [{ boardFailure: true }, { trap: true }]) {
    const { adapter, sessions, poisoned } = fixture(behavior);
    await rejects(
      () => adapter.board(sources),
      behavior.trap ? /native runtime failed/ : /board outline failed/,
    );
    equal(sessions.length, 1);
    equal(sessions[0].freed, true);
    equal(sessions[0].commitCalls, 0);
    equal(poisoned(), !!behavior.trap);
  }
});

Deno.test("toolkit calls use separate sessions and native source preimages use UTF-8 byte offsets", async () => {
  const { adapter, sessions } = fixture();
  const description = await adapter.describe(sources, target);
  equal(description.qualifiedName, target.qualifiedName);
  equal(description.source.text, declaration);
  equal(
    description.source.startByte,
    new TextEncoder().encode(
      sources["model.sysml"].slice(
        0,
        sources["model.sysml"].indexOf(declaration),
      ),
    ).length,
  );
  equal(description.types[0].qualifiedName, "ScalarValues::Integer");
  await adapter.query(sources, "ownedFeature(Demo)");
  equal(sessions.length, 2);
  notEqual(sessions[0], sessions[1]);
  equal(sessions.every((session) => session.freed), true);
});

Deno.test("toolkit verified edits preserve the caller snapshot and return exactly reviewed UTF-8 splices", async () => {
  const { adapter, sessions } = fixture();
  const original = structuredClone(sources);
  const result = await adapter.edit(sources, edits);
  deepStrictEqual(sources, original);
  equal(
    result.sources["model.sysml"],
    sources["model.sysml"].replace("= 1;", "= 2;"),
  );
  equal(result.sources["unchanged.sysml"], sources["unchanged.sysml"]);
  equal(result.splices.length, 1);
  equal(result.splices[0].unit, "model.sysml");
  deepStrictEqual(result.provider, {
    name: "sysml-toolkit",
    version: "0.10.10",
  });
  equal(sessions[0].previewCalls, 1);
  equal(sessions[0].commitCalls, 1);
  equal(sessions[0].freed, true);
});

Deno.test("toolkit targets must match the source base, metaclass and exact declared member", async () => {
  const { adapter, sessions } = fixture();
  for (
    const changed of [
      { ...target, qualifiedName: "Demo::missing" },
      { ...target, metaclass: "PartUsage" },
      { ...target, source: { ...target.source, text: declaration + " " } },
      { ...target, source: { ...target.source, path: "../model.sysml" } },
    ]
  ) {
    await rejects(() =>
      adapter.edit(sources, [{ ...edits[0], target: changed }])
    );
  }
  equal(
    sessions.every((session) => session.previewCalls === 0 && session.freed),
    true,
  );
  const library = fixture({ libraryTarget: true });
  await rejects(() => library.adapter.edit(sources, edits), /library targets/);
  equal(library.sessions[0].commitCalls, 0);
});

Deno.test("toolkit refuses dropped renames instead of returning the committed remainder", async () => {
  const { adapter, sessions } = fixture({
    findings: ["rename dropped: sibling exists"],
  });
  await rejects(
    () => adapter.edit(sources, edits),
    /dropped operations|partial findings/,
  );
  equal(sessions[0].commitCalls, 0);
  equal(sessions[0].freed, true);
});

Deno.test("toolkit refuses source changes outside the preview and a preview that mutates its snapshot", async () => {
  for (
    const behavior of [{ mutateUnrelatedSource: true }, { mutatePreview: true }]
  ) {
    const { adapter, sessions } = fixture(behavior);
    await rejects(
      () => adapter.edit(sources, edits),
      /outside its reviewed splices|preview changed/,
    );
    equal(sessions[0].freed, true);
    if (behavior.mutatePreview) equal(sessions[0].commitCalls, 0);
  }
});

Deno.test("toolkit syntax errors prevent session creation and new user reference warnings discard edited sessions", async () => {
  const syntax = fixture({
    syntax: [{
      severity: "error",
      stage: "parse",
      message: "bad source",
      unit: "model.sysml",
    }],
  });
  deepStrictEqual(await syntax.adapter.check(sources), [{
    severity: "error",
    stage: "parse",
    message: "bad source",
    unit: "model.sysml",
  }]);
  await rejects(() => syntax.adapter.query(sources, "1"), /validation refused/);
  equal(syntax.sessions.length, 0);
  const reference = fixture({
    finalDiagnostic: {
      severity: "warning",
      stage: "referential",
      message: "unresolved reference",
      unit: "model.sysml",
    },
  });
  await rejects(
    () => reference.adapter.edit(sources, edits),
    /unresolved reference/,
  );
  equal(reference.sessions[0].commitCalls, 1);
  equal(reference.sessions[0].freed, true);
  const fresh = await reference.adapter.query(sources, "1") as {
    source: string;
  };
  equal(fresh.source, sources["model.sysml"]);
  notEqual(reference.sessions[0], reference.sessions[1]);
});

Deno.test("toolkit rejects unsafe source paths, malformed targeted edits and remote loader configuration", async () => {
  const { adapter, sessions } = fixture();
  await rejects(
    () => adapter.check({ "../outside.sysml": "package X;" }),
    /Unsafe/,
  );
  equal(sessions.length, 0);
  await rejects(() =>
    adapter.edit(sources, [
      { kind: "set-value", target, expression: "2", extra: true },
    ] as unknown as ResolvedModelEdit[]), /fields/);
  await rejects(() =>
    adapter.edit(sources, [
      { kind: "raw-sdk-op", target },
    ] as unknown as ResolvedModelEdit[]), /Unsupported/);
  await rejects(
    () => loadSysmlToolkit("https://example.test/package"),
    /local/,
  );
  equal(
    sessions.every((session) => session.commitCalls === 0 && session.freed),
    true,
  );
});

Deno.test("toolkit refuses inserted text that would close its owner before opening a session", async () => {
  const { adapter, sessions } = fixture();
  await rejects(
    () =>
      adapter.edit(sources, [{
        kind: "insert-member",
        target: {
          qualifiedName: "Demo",
          metaclass: "Package",
          source: { path: "model.sysml", text: sources["model.sysml"] },
        },
        text: "} part def Escaped {",
      }]),
    (error: unknown) =>
      error instanceof SysmlToolkitError &&
      error.code === "INSERT_TEXT_UNBALANCED",
  );
  equal(sessions.length, 0);
});

Deno.test("toolkit traps invalidate the shared runtime and never select a fallback compiler", async () => {
  const { adapter, sessions, poisoned } = fixture({ trap: true });
  await rejects(() => adapter.query(sources, "1"), /native runtime failed/);
  equal(poisoned(), true);
  equal(sessions[0].freed, true);
  await rejects(() => adapter.query(sources, "1"), /runtime poisoned/);
  equal(sessions.length, 1);
});

Deno.test("toolkit session disposal traps invalidate the runtime after successful operations", async () => {
  for (const operation of ["check", "query"] as const) {
    const { adapter, sessions, poisoned } = fixture({ freeTrap: true });
    if (operation === "check") {
      deepStrictEqual(await adapter.check(sources), []);
    } else await adapter.query(sources, "1");
    equal(poisoned(), true);
    equal(sessions[0].freed, true);
    await rejects(() => adapter.query(sources, "1"), /runtime poisoned/);
    equal(sessions.length, 1);
  }
});

Deno.test("toolkit element disposal traps release every handle and invalidate the runtime", async () => {
  const handles = ["Demo::amount", "Demo", "ScalarValues::Integer"];
  for (const elementFreeTrap of handles) {
    const { adapter, sessions, poisoned } = fixture({ elementFreeTrap });
    await rejects(
      () => adapter.describe(sources, target),
      /native runtime failed/,
    );
    equal(poisoned(), true);
    deepStrictEqual(sessions[0].freedElements, handles);
    equal(sessions[0].freed, true);
    await rejects(() => adapter.query(sources, "1"), /runtime poisoned/);
    equal(sessions.length, 1);
  }
});

Deno.test("host replacement and type changes serialize complete Toolkit operations", async () => {
  for (
    const [request, expected] of [
      [{ kind: "replace-member", target, text: declaration }, {
        op: "replaceMember",
        target: "'Demo'::'amount'",
        text: declaration,
      }],
      [{ kind: "set-type", target, type: "ScalarValues::Integer" }, {
        op: "setFeatureType",
        target: "'Demo'::'amount'",
        type: "ScalarValues::Integer",
      }],
    ] as const
  ) {
    const { adapter, sessions } = fixture();
    await adapter.edit(sources, [request]);
    deepStrictEqual(sessions[0].operations, [expected]);
  }
  const { adapter, sessions } = fixture();
  await rejects(
    () =>
      adapter.edit(sources, [{
        kind: "replace-member",
        target,
        text: "} package Escape {",
      }]),
    {
      code: "REPLACE_TEXT_UNBALANCED",
      message: /^Replaced text must be whole members/,
    },
  );
  await rejects(
    () =>
      adapter.edit(sources, [{
        kind: "set-type",
        target: { ...target, qualifiedName: "@anonymous" },
        type: "ScalarValues::Integer",
      }]),
    { code: "INVALID_TARGET_KIND" },
  );
  equal(sessions.length, 0);
});

Deno.test("toolkit anonymous targets resolve by element id for removal only", async () => {
  const anonymous: ModelToolingTarget = {
    qualifiedName: "@id:Demo::amount",
    metaclass: "AttributeUsage",
    source: { path: "model.sysml", text: declaration },
  };
  const { adapter, sessions } = fixture();
  const description = await adapter.describe(sources, anonymous);
  equal(description.qualifiedName, anonymous.qualifiedName);
  equal(description.source.text, declaration);
  await adapter.edit(sources, [{ kind: "remove", target: anonymous }]);
  deepStrictEqual(sessions[1].operations, [{
    op: "remove",
    target: "@id:Demo::amount",
  }]);
  for (
    const edit of [
      { kind: "set-value", target: anonymous, expression: "2" },
      { kind: "rename", target: anonymous, name: "renamed" },
      { kind: "insert-member", target: anonymous, text: declaration },
      { kind: "replace-member", target: anonymous, text: declaration },
      {
        kind: "set-type",
        target: anonymous,
        type: "ScalarValues::Integer",
      },
    ] as const
  ) {
    await rejects(
      () => adapter.edit(sources, [edit]),
      (error: unknown) =>
        error instanceof SysmlToolkitError &&
        error.code === "INVALID_TARGET_KIND",
    );
  }
  equal(sessions.length, 2);
});

Deno.test("toolkit views and diagram use separate sessions disposed after success", async () => {
  const { adapter, sessions } = fixture({ viewShape: true });
  const list = await adapter.views(sources);
  equal(list.toolkit, "0.10.10");
  deepStrictEqual(list.views.map((view) => view.id), ["definitions:Demo"]);
  equal(list.views[0].nodes, 2);
  const view = await adapter.diagram(sources, list.views[0]);
  equal(view.diagram.nodes[1].name, "system");
  equal(view.diagram.nodes[1].typeName, "System");
  equal(await adapter.plantuml(sources, list.views[0]), "@startuml\n@enduml");
  equal(sessions.length, 3);
  equal(sessions.every((session) => session.freed), true);
});

Deno.test("toolkit views rethrow a candidate graph trap, dispose the session and poison the runtime", async () => {
  const { adapter, sessions, poisoned } = fixture({
    viewShape: true,
    viewGraphTrap: true,
  });
  await rejects(() => adapter.views(sources), /native runtime failed/);
  equal(sessions.length, 1);
  equal(sessions[0].freed, true);
  equal(poisoned(), true);
});

Deno.test("toolkit views dispose failed sessions and invalidate a trapped runtime", async () => {
  for (const behavior of [{ viewFailure: true }, { trap: true }]) {
    const { adapter, sessions, poisoned } = fixture({
      viewShape: true,
      ...behavior,
    });
    await rejects(
      () => adapter.views(sources),
      behavior.trap ? /native runtime failed/ : /view outline failed/,
    );
    equal(sessions.length, 1);
    equal(sessions[0].freed, true);
    equal(poisoned(), !!behavior.trap);
  }
});

Deno.test("toolkit PlantUML disposes failed sessions and invalidates a trapped runtime", async () => {
  for (const behavior of [{ plantumlFailure: true }, { plantumlTrap: true }]) {
    const { adapter, sessions, poisoned } = fixture(behavior);
    await rejects(() =>
      adapter.plantuml(sources, {
        id: "definitions:Demo",
        title: "Demo",
        kind: "tree",
        group: "definitions",
        element: "Demo",
        nodes: 2,
        edges: 0,
      }), behavior.plantumlTrap ? /native runtime failed/ : /export failed/);
    equal(sessions.length, 1);
    equal(sessions[0].freed, true);
    equal(poisoned(), !!behavior.plantumlTrap);
  }
});

Deno.test("native reference discovery refuses an old binding even when it returns no sites", async () => {
  const { adapter } = fixture();
  await rejects(
    () => adapter.referenceSites(sources, "id:Demo::amount"),
    (error: unknown) =>
      error instanceof SysmlToolkitError &&
      error.code === "REFERENCE_SITES_UNAVAILABLE",
  );
});

Deno.test("native reference discovery refuses missing, invalid or omitted sites", async () => {
  const format = "assembly-native-reference-site/v1";
  for (const omitted of [undefined, -1, 1, 0.5, "0"]) {
    const { adapter } = fixture({
      referenceResponse: {
        referenceSiteFormat: format,
        references: [],
        ...(omitted === undefined ? {} : { referenceSitesOmitted: omitted }),
      },
    });
    await rejects(
      () => adapter.referenceSites(sources, "id:Demo::amount"),
      (error: unknown) =>
        error instanceof SysmlToolkitError &&
        error.code === "REFERENCE_SITES_INCOMPLETE",
    );
  }
  const { adapter } = fixture({
    referenceResponse: {
      referenceSiteFormat: format,
      referenceSitesOmitted: 0,
      references: [],
    },
  });
  deepStrictEqual(await adapter.referenceSites(sources, "id:Demo::amount"), []);
});
