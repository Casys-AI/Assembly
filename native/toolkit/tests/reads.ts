/**
 * Lectures : describe et lectures par élément (familles board/compiler),
 * rows/extents/memberSource, outline, graphe/PlantUML/viewInfo
 * (familles views, branche `else` comprise), query, references UTF-16.
 *
 * Usage: deno run -A tests/reads.ts --addon PATH.node [--out JSON]
 */
import {
  assert,
  assertEqual,
  expectCode,
  finish,
  FLASHLIGHT,
  FLOW,
  loadAddon,
  must,
  requiredArg,
  RIG,
  test,
  type ToolkitSession,
} from "./support.ts";

const addon = await loadAddon(requiredArg("--addon"));

function flashlight(): ToolkitSession {
  return new addon.ToolkitSession([{
    name: "flashlight.sysml",
    text: FLASHLIGHT,
  }]);
}

test("describe: typed description separates name, metaclass and identity", () => {
  const session = flashlight();
  try {
    const description = must(
      session.describeQualified("Flashlight::Battery"),
      "describeQualified",
    );
    assertEqual(description.name, "Battery", "declared name");
    assertEqual(
      description.metaclass,
      "PartDefinition",
      "metaclass is not the name",
    );
    assertEqual(
      description.qualifiedName,
      "Flashlight::Battery",
      "qualified name",
    );
    assertEqual(description.isLibraryElement, false, "user element");
    assertEqual(description.ownedMembers.length, 1, "one owned member");
    assertEqual(
      description.nativeId,
      description.reference.nativeId,
      "id echo",
    );
    assertEqual(
      must(description.declaration, "declaration").unit,
      "flashlight.sysml",
      "declaration unit",
    );
    assertEqual(
      session.describeQualified("Flashlight::Missing"),
      null,
      "missing name describes as null",
    );
    const counted = session.countMetaclass("PartDefinition", 1);
    assertEqual(counted.count, 2, "both definitions counted");
    assertEqual(counted.references.length, 1, "sample is bounded by limit");
  } finally {
    session.close();
  }
});

test("element reads: the board's thirteen answers come from the native model", () => {
  const session = flashlight();
  try {
    const battery = must(session.resolve("Flashlight::Battery"), "battery");
    const usage = must(
      session.resolve("Flashlight::flashlight::battery"),
      "usage",
    );
    assertEqual(session.name(battery), "Battery", "name");
    assertEqual(session.metaclass(battery), "PartDefinition", "metaclass");
    assertEqual(
      session.elementId(battery),
      battery.nativeId,
      "elementId re-derived",
    );
    assertEqual(
      session.qualifiedName(battery),
      "Flashlight::Battery",
      "qualifiedName",
    );
    assertEqual(
      session.referenceSpelling(battery),
      "Flashlight::Battery",
      "referenceSpelling",
    );
    assertEqual(session.isLibraryElement(battery), false, "isLibraryElement");
    assertEqual(session.members(battery).length, 1, "members");
    assertEqual(session.features(battery).length, 1, "features");
    const types = session.typings(usage);
    assertEqual(types.length, 1, "typings");
    assertEqual(types[0]?.nativeId, battery.nativeId, "typing target");
    const owner = must(session.owner(usage), "owner");
    assertEqual(session.name(owner), "flashlight", "owner name");
    assertEqual(session.docs(battery).length, 0, "no documentation");
    assertEqual(
      session.conforms(usage, usage),
      true,
      "an element conforms to itself",
    );
    const root = session.redefinitionRoot(usage);
    assert(root.nativeId.length > 0, "redefinition root resolves");
    const site = JSON.parse(
      must(session.declarationSite(battery), "declarationSite"),
    ) as {
      unit: number;
      start: number;
      end: number;
    };
    assert(site.end > site.start, "declaration site span");
    const voltage = must(
      session.resolve("Flashlight::Battery::voltage"),
      "voltage",
    );
    assertEqual(session.evaluate(voltage), "3", "evaluate");
    assertEqual(session.valueSource(voltage), "3", "valueSource");
    assertEqual(
      JSON.parse(session.derived(voltage, "name")),
      "voltage",
      "derived name",
    );
    const owned = session.derivedElements(battery, "ownedFeature");
    assertEqual(
      owned[0]?.nativeId,
      voltage.nativeId,
      "derivedElements ownedFeature",
    );
    expectCode(
      () => session.derived(voltage, "bogusProperty"),
      "TOOLKIT_ERROR",
      "undeclared derived property",
    );
    const byId = must(session.elementById(battery.nativeId), "elementById");
    assertEqual(byId.nativeId, battery.nativeId, "elementById round-trip");
    assertEqual(session.elementById("no-such-id"), null, "absent id");
    assertEqual(
      session.elementsOfMetaclass("PartDefinition").length,
      2,
      "elementsOfMetaclass",
    );
    assert(session.roots().length >= 1, "roots present");
  } finally {
    session.close();
  }
});

test("rows, extents and memberSource carry byte-exact preimages", () => {
  const session = flashlight();
  try {
    const battery = must(session.resolve("Flashlight::Battery"), "battery");
    const rows = JSON.parse(
      session.rows(
        JSON.stringify([battery.nativeId, "absent"]),
        JSON.stringify([
          "name",
          "qualifiedName",
          "metaclass",
          "isLibraryElement",
          "owner",
          "memberExtent",
        ]),
      ),
    ) as Array<Record<string, unknown> | null>;
    assertEqual(rows[0]?.name, "Battery", "row name");
    assertEqual(rows[0]?.metaclass, "PartDefinition", "row metaclass");
    assertEqual(rows[1], null, "absent id row is null");
    const extent = rows[0]?.memberExtent as {
      unit: number;
      start: number;
      end: number;
    };
    const bytes = new TextEncoder().encode(FLASHLIGHT);
    const slice = new TextDecoder().decode(
      bytes.slice(extent.start, extent.end),
    );
    assert(slice.includes("part def Battery"), "extent covers the declaration");
    assertEqual(
      session.memberSource("Flashlight::Battery"),
      slice,
      "memberSource equals the extent bytes",
    );
    assertEqual(
      session.memberSource(`@${battery.nativeId}`),
      slice,
      "memberSource by @id",
    );
    const catalog = JSON.parse(
      session.rows(
        JSON.stringify([battery.nativeId]),
        JSON.stringify(["property:declaredName", "derived:name"]),
      ),
    ) as Array<Record<string, unknown>>;
    assert(
      catalog[0]?.["derived:name"] === "Battery" ||
        (catalog[0]?.errors as Record<string, unknown>)?.["derived:name"] !==
          undefined,
      "derived row field answered or reported per-field",
    );
    const units = JSON.parse(session.unitsJson()) as Array<
      { unit: number; name: string; text: string }
    >;
    assertEqual(units[0]?.name, "flashlight.sysml", "unitsJson name");
    assertEqual(units[0]?.text, FLASHLIGHT, "unitsJson keeps exact bytes");
    assertEqual(
      session.units()[0]?.text,
      FLASHLIGHT,
      "typed units keep exact bytes",
    );
    const typed = session.check();
    const asJson = JSON.parse(session.checkJson()) as Array<
      Record<string, unknown>
    >;
    assertEqual(asJson.length, typed.length, "check/checkJson parity");
    expectCode(
      () => session.rows("[]", '["bogusField"]'),
      "INVALID_INPUT",
      "unknown row field",
    );
    expectCode(
      () => session.memberSource("Flashlight::Missing"),
      "ELEMENT_NOT_FOUND",
      "memberSource missing target",
    );
  } finally {
    session.close();
  }
});

test("query evaluates at the root and refuses non-expressions", () => {
  const session = flashlight();
  try {
    assertEqual(session.query("3 + 4"), "7", "literal query");
    expectCode(
      () => session.query("not an expression !!"),
      "TOOLKIT_ERROR",
      "bad query",
    );
  } finally {
    session.close();
  }
});

test("outline, graph, PlantUML and viewInfo project list/board/diagram inputs", () => {
  const session = new addon.ToolkitSession([{ name: "rig.sysml", text: RIG }]);
  try {
    const outline = JSON.parse(
      session.outline(JSON.stringify({ shapeNodes: 20_000 })),
    ) as {
      shape: { nodes: Array<{ qualifiedName: string }>; truncated: boolean };
    };
    const names = outline.shape.nodes.map((n) => n.qualifiedName);
    assert(names.includes("Rig::rig::amp"), `shape contains amp: ${names}`);
    assert(names.includes("Rig::shallow"), `shape contains the view: ${names}`);
    assertEqual(outline.shape.truncated, false, "shape not truncated");
    const graph = JSON.parse(
      session.toGraph(JSON.stringify({ view: "tree", element: "Rig" })),
    ) as { nodes: unknown[]; edges: unknown[] };
    assert(graph.nodes.length > 1, "tree graph has nodes");
    const plantuml = session.toPlantuml(
      JSON.stringify({ view: "tree", element: "Rig" }),
    );
    assert(plantuml.startsWith("@startuml"), "PlantUML header");
    assert(plantuml.includes("amp"), "PlantUML mentions amp");
    const info = JSON.parse(session.viewInfo("Rig::shallow")) as {
      exposed: Array<{ qualifiedName: string }>;
    };
    assert(
      info.exposed.some((e) => e.qualifiedName === "Rig::rig::amp"),
      `view exposes amp: ${JSON.stringify(info.exposed)}`,
    );
    expectCode(
      () => session.outline('{"bogusOption": 1}'),
      "INVALID_INPUT",
      "unknown outline option",
    );
    expectCode(
      () =>
        session.toGraph(
          JSON.stringify({ view: "tree", element: "Rig::Missing" }),
        ),
      "ELEMENT_NOT_FOUND",
      "missing diagram element",
    );
  } finally {
    session.close();
  }
});

test("action graph keeps both branches of the corrected else shorthand", () => {
  const session = new addon.ToolkitSession([{
    name: "flow.sysml",
    text: FLOW,
  }]);
  try {
    const graph = JSON.parse(
      session.toGraph(
        JSON.stringify({ view: "action", element: "Flow::Router" }),
      ),
    ) as { nodes: Array<{ label?: string }>; edges: unknown[] };
    const labels = graph.nodes.map((n) => n.label ?? "");
    assert(labels.some((l) => l.includes("fast")), `fast branch: ${labels}`);
    assert(labels.some((l) => l.includes("slow")), `else branch: ${labels}`);
    assert(graph.edges.length > 0, "action edges present");
    const plantuml = session.toPlantuml(
      JSON.stringify({ view: "action", element: "Flow::Router" }),
    );
    assert(plantuml.includes("slow"), "PlantUML keeps the else target");
  } finally {
    session.close();
  }
});

test("references report UTF-16 columns around an emoji", () => {
  const text =
    "package P { /* \u{1F600} */ part def Battery; part b : Battery; }\n";
  const session = new addon.ToolkitSession([{ name: "p.sysml", text }]);
  try {
    // indexOf returns UTF-16 offsets; compare with UTF-8 byte columns rather
    // than incorrectly comparing two equivalent UTF-16 calculations.
    const utf16Col = (index: number) => text.slice(0, index).length + 1;
    const utf8Col = (index: number) =>
      new TextEncoder().encode(text.slice(0, index)).byteLength + 1;
    const declarationAt = text.indexOf("part def Battery") + "part def ".length;
    const referenceAt = text.lastIndexOf("Battery");
    assert(
      utf16Col(referenceAt) !== utf8Col(referenceAt),
      "fixture separates encodings",
    );
    const parsed = JSON.parse(session.references("P::Battery")) as {
      declaration: { col: number } | null;
      references: Array<{ col: number; kind: string }>;
    };
    assertEqual(
      must(parsed.declaration, "declaration").col,
      utf16Col(declarationAt),
      "declaration UTF-16 column",
    );
    assertEqual(parsed.references.length, 1, "one reference site");
    assertEqual(
      parsed.references[0]?.col,
      utf16Col(referenceAt),
      "reference UTF-16 column",
    );
    assertEqual(parsed.references[0]?.kind, "type", "reference kind");
    expectCode(
      () => session.references("P::Missing"),
      "ELEMENT_NOT_FOUND",
      "missing references target",
    );
  } finally {
    session.close();
  }
});

await finish("reads.ts");
