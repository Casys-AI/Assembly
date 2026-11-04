import assert from "node:assert/strict";
import { sourceSnapshot } from "../projections/source-facts.ts";
import type { SourceRevision } from "../records/source-revision.ts";
import {
  accountabilityLibrary,
  declaresAccountableHuman,
} from "./accountability.ts";

function accountabilityElements(unitId = "first"): SourceRevision["elements"] {
  const ref = (id: string) => ({ "@id": id });
  return [
    {
      "@id": "operator-type",
      "@type": "PartDefinition",
      qualifiedName: "AssemblyCore::Operator",
    },
    {
      "@id": "human-type",
      "@type": "PartDefinition",
      qualifiedName: "AssemblyCore::HumanOperator",
      general: [ref("operator-type")],
    },
    {
      "@id": "assignment-type",
      "@type": "PartDefinition",
      qualifiedName: "APEAccountability::AccountabilityAssignment",
    },
    {
      "@id": "accountable",
      "@type": "PartUsage",
      declaredName: "accountable",
      owner: ref("assignment-type"),
      type: [ref("human-type")],
      isReference: true,
    },
    {
      "@id": "human",
      "@type": "PartUsage",
      owner: ref("first"),
      type: [ref("human-type")],
    },
    {
      "@id": "assignment",
      "@type": "PartUsage",
      owner: ref(unitId),
      type: [ref("assignment-type")],
    },
    {
      "@id": "accountable-chain",
      "@type": "Feature",
      chainingFeature: [ref("assignment"), ref("accountable")],
    },
    {
      "@id": "assignment-binding",
      "@type": "BindingConnectorAsUsage",
      owner: ref(unitId),
      sourceFeature: [ref("accountable-chain")],
      targetFeature: [ref("human")],
    },
  ];
}

Deno.test("diagnostic accountability requires an explicit local typed assignment", () => {
  const elements = accountabilityElements();
  const declared = (input: typeof elements) => {
    const snapshot = sourceSnapshot(input, "root");
    const library = accountabilityLibrary(snapshot);
    return ["first", "second"].map((id) =>
      declaresAccountableHuman(snapshot, library, id)
    );
  };
  assert.deepEqual(declared(elements), [true, false]);
  const withoutAssignment = elements.filter((element) =>
    element["@id"] !== "assignment"
  );
  assert.deepEqual(declared(withoutAssignment), [false, false]);
  const mutations: Array<[string, SourceRevision["elements"][number]]> = [
    ["human", { owner: { "@id": "second" } }],
    ["human", { type: [{ "@id": "software-type" }] }],
    ["human-type", { general: [] }],
    ["assignment-binding", { owner: { "@id": "second" } }],
    ["assignment-binding", { targetFeature: [{ "@id": "missing" }] }],
    ["assignment-binding", { targetFeature: [{ "@id": "accountable-chain" }] }],
    ["assignment", { isReference: true }],
    ["accountable", { isReference: false }],
    ["accountable", { type: [{ "@id": "software-type" }] }],
  ];
  for (const [id, changes] of mutations) {
    assert.deepEqual(
      declared(
        elements.map((element) =>
          element["@id"] === id ? { ...element, ...changes } : element
        ),
      ),
      [false, false],
      id,
    );
  }
  for (const id of ["assignment", "assignment-binding", "assignment-type"]) {
    assert.deepEqual(
      declared([
        ...elements,
        {
          ...elements.find((element) => element["@id"] === id)!,
          "@id": `${id}-duplicate`,
        },
      ]),
      [false, false],
      id,
    );
  }
});

Deno.test("diagnostic accountability has direct unit scope and plans do not inherit their conversation assignment", () => {
  const units = (elements: ReturnType<typeof accountabilityElements>) => {
    const snapshot = sourceSnapshot(elements, "root");
    const library = accountabilityLibrary(snapshot);
    return [
      ["conversation", declaresAccountableHuman(snapshot, library, "first")],
      ["plan", declaresAccountableHuman(snapshot, library, "plan", "first")],
    ];
  };
  assert.deepEqual(units(accountabilityElements()), [
    ["conversation", true],
    ["plan", false],
  ]);
  assert.deepEqual(units(accountabilityElements("plan")), [
    ["conversation", false],
    ["plan", true],
  ]);
});
