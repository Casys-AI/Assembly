import { deepStrictEqual, equal, ok, throws } from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../domain/work/dialogue.ts";
import type { NativeLiteral } from "../../out/sysml-toolkit/compilation-policies/work/execution-model.ts";
import { compileInitialTools, withInitialTools } from "./initial-catalog.ts";

const fields = {
  id: "reader-v1",
  name: "reader",
  description: "Lire une page fournie",
  kind: "read_web_page",
  code: "export default ({url,html}) => ({title:url,text:html})",
};
const manifest = { format: 1, tools: [fields] };
const definition = "package ASEInitialTools { item def ToolSeed; }";

function fixture() {
  const snapshot: ModelSnapshot = {
    rootId: "root",
    elements: [],
    connectors: [],
    invocations: [],
    patternIds: [],
  };
  const literals: NativeLiteral[] = [];
  const add = (
    id: string,
    qualifiedName: string,
    metaclass: string,
    ownerId: string,
    typeIds: string[] = [],
    redefinedIds: string[] = [],
  ): ElementRecord => {
    const element: ElementRecord = {
      id,
      qualifiedName,
      metaclass,
      ownerId,
      typeIds,
      redefinedIds,
      name: qualifiedName.split("::").at(-1)!,
      direction: "",
      generalIds: [],
      isReference: false,
      multiplicity: "",
      doc: "",
    };
    snapshot.elements.push(element);
    return element;
  };
  add("model", "ASELiveBuilder", "Package", "root");
  add(
    "system-type",
    "ASELiveBuilder::ConversationSystem",
    "PartDefinition",
    "model",
  );
  add("system", "ASELiveBuilder::liveBuilder", "PartUsage", "model", [
    "system-type",
  ]);
  add("peer", "ASELiveBuilder::peer", "PartUsage", "model", ["system-type"]);
  add(
    "catalog",
    "ASELiveBuilder::liveBuilder::catalog",
    "PartUsage",
    "system",
    ["catalog-type"],
  );
  add("peer-catalog", "ASELiveBuilder::peer::catalog", "PartUsage", "peer", [
    "catalog-type",
  ]);
  add("String", "ScalarValues::String", "DataType", "scalars");
  add("package", "ASEInitialTools", "Package", "root");
  add("ToolSeed", "ASEInitialTools::ToolSeed", "ItemDefinition", "package");
  for (const name of Object.keys(fields)) {
    add(
      "base-" + name,
      "ASEInitialTools::ToolSeed::" + name,
      "AttributeUsage",
      "ToolSeed",
      ["String"],
    );
  }
  const occurrence = (id: string, owner = "catalog") => {
    const seed = add(
      id,
      `ASELiveBuilder::${owner}::${id}`,
      "ItemUsage",
      owner,
      ["ToolSeed"],
    );
    for (const [name, value] of Object.entries(fields)) {
      add(
        `${id}-${name}`,
        `${seed.qualifiedName}::${name}`,
        "AttributeUsage",
        id,
        ["String"],
        ["base-" + name],
      );
      literals.push({
        owner: id,
        name,
        attributeId: `${id}-${name}`,
        literalId: `${id}-${name}-literal`,
        kind: "LiteralString",
        value,
        typeIds: ["String"],
        typeNames: ["ScalarValues::String"],
      });
    }
    return seed;
  };
  const seed = occurrence("seed");
  const identity: ModelIdentity = {
    projectId: "project",
    editingContextId: "editing",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  };
  return { snapshot, literals, identity, seed, occurrence };
}

Deno.test("initial seeds compile only for their exact local catalog and retain native source evidence", () => {
  const f = fixture();
  f.occurrence("peer-seed", "peer-catalog");
  const selected = compileInitialTools(f.snapshot, f.literals, f.identity);
  equal(selected.length, 1);
  equal(selected[0]!.nativeId, "seed");
  equal(selected[0]!.draft.code, fields.code);
  for (
    const id of [
      "ToolSeed",
      "seed",
      "base-code",
      "seed-code",
      "seed-code-literal",
    ]
  ) ok(selected[0]!.sourceIds.includes(id));
  deepStrictEqual(
    compileInitialTools(
      {
        ...f.snapshot,
        elements: f.snapshot.elements.filter((e) =>
          !e.qualifiedName.startsWith("ASEInitialTools")
        ),
      },
      [],
      f.identity,
    ),
    [],
  );
});

Deno.test("initial seed compilation rejects wrong owner, reference, typing and unaudited metadata", () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => f.seed.ownerId = "system",
      (f: ReturnType<typeof fixture>) => f.seed.isReference = true,
      (f: ReturnType<typeof fixture>) => f.seed.metaclass = "PartUsage",
      (f: ReturnType<typeof fixture>) => f.literals[0]!.kind = "LiteralInteger",
      (f: ReturnType<typeof fixture>) =>
        f.snapshot.elements.find((e) => e.id === "seed-id")!.redefinedIds = [],
      (f: ReturnType<typeof fixture>) =>
        f.snapshot.elements.push({
          ...f.seed,
          id: "extra",
          name: "status",
          metaclass: "AttributeUsage",
          ownerId: f.seed.id,
        }),
    ]
  ) {
    const f = fixture();
    mutate(f);
    throws(() => compileInitialTools(f.snapshot, f.literals, f.identity));
  }
});

Deno.test("initial selection source patch cannot select catalog-shaped strings/comments or grant activation", () => {
  const source = `package ASELiveBuilder {
    doc /* part catalog : ToolCatalog { fake } */
    attribute example : String = "part catalog : ToolCatalog { fake }";
    part liveBuilder : ConversationSystem { part catalog : ToolCatalog { } }
  }`;
  const sources = { "configuration.sysml": source };
  deepStrictEqual(
    withInitialTools(sources, { format: 1, tools: [] }, definition),
    sources,
  );
  const prepared = withInitialTools(sources, manifest, definition);
  ok(
    prepared["configuration.sysml"]!.includes(
      "item initialTool1 : ASEInitialTools::ToolSeed",
    ),
  );
  ok(prepared["configuration.sysml"]!.includes(JSON.stringify(fields.code)));
  equal(prepared["initial-tools.sysml"], definition);
  equal(sources["configuration.sysml"], source);
  equal(prepared["configuration.sysml"]!.includes('status = "active"'), false);
  throws(
    () =>
      withInitialTools(
        { ...sources, "other.sysml": "part catalog : ToolCatalog {}" },
        manifest,
        definition,
      ),
    /unambiguous/,
  );
  throws(
    () => withInitialTools(prepared, manifest, definition),
    /already exists/,
  );
  throws(
    () =>
      withInitialTools(
        { "configuration.sysml": "// part catalog : ToolCatalog {}" },
        manifest,
        definition,
      ),
    /unambiguous/,
  );
});

Deno.test("canonical initial seeds retain native IDs and legacy definition source selects its own namespace", () => {
  const legacy = fixture();
  const expected = compileInitialTools(
    legacy.snapshot,
    legacy.literals,
    legacy.identity,
  );
  const canonical = structuredClone(legacy.snapshot);
  for (const element of canonical.elements) {
    element.qualifiedName = element.qualifiedName.replace(
      /^ASE(InitialTools|LiveBuilder)(?=::|$)/,
      "Assembly$1",
    );
  }
  deepStrictEqual(
    compileInitialTools(canonical, legacy.literals, legacy.identity),
    expected,
  );
  const currentDefinition = definition.replace(
    "ASEInitialTools",
    "AssemblyInitialTools",
  );
  const prepared = withInitialTools(
    {
      "configuration.sysml":
        "package AssemblyLiveBuilder { part liveBuilder : ConversationSystem { part catalog : AssemblyLiveBuilder::ToolCatalog {} } }",
    },
    manifest,
    currentDefinition,
  );
  ok(
    prepared["configuration.sysml"]!.includes(
      "item initialTool1 : AssemblyInitialTools::ToolSeed",
    ),
  );
  equal(prepared["initial-tools.sysml"], currentDefinition);
  throws(
    () => withInitialTools(prepared, manifest, currentDefinition),
    /already exists/,
  );
  throws(() =>
    withInitialTools(
      {
        "configuration.sysml": "part catalog : ToolCatalog {}",
      },
      manifest,
      currentDefinition + "\npackage ASEInitialTools {}",
    ), /one qualified/);
});
