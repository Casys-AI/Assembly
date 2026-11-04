import { deepStrictEqual, equal, throws } from "node:assert/strict";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import { compileOperatorEntries } from "./operator-entries.ts";

type Native = Record<string, unknown>;
const ref = (id: string) => ({ "@id": id });
const identity: ModelIdentity = {
  projectId: "source-repo",
  editingContextId: "source-repo",
  rootId: "root",
  systemId: "worker",
  builderId: "worker-builder",
  catalogId: "worker-catalog",
};
const native = (
  id: string,
  type: string,
  owner: string,
  name: string,
  extra: Native = {},
): Native => ({
  "@id": id,
  "@type": type,
  owner: ref(owner),
  declaredName: name,
  qualifiedName: `Fixture::${name}`,
  ...extra,
});

function fixture() {
  const elements: Native[] = [
    native("pkg", "Package", "", "Fixture"),
    native("worker", "PartUsage", "pkg", "worker"),
    native("peer", "PartUsage", "pkg", "peer"),
    native("worker-builder", "PartUsage", "worker", "builder"),
    native("worker-catalog", "PartUsage", "worker", "catalog"),
    native("peer-builder", "PartUsage", "peer", "builder"),
    native("inbox-type", "ActionDefinition", "pkg", "AgentInbox", {
      qualifiedName: "ASEWork::AgentInbox",
    }),
    native("input-type", "ItemDefinition", "pkg", "WorkRequest", {
      qualifiedName: "ASEWork::WorkRequest",
    }),
    native("input", "ReferenceUsage", "inbox-type", "request", {
      direction: "in",
      type: [ref("input-type")],
    }),
    native("worker-inbox", "PerformActionUsage", "worker", "inbox", {
      type: [ref("inbox-type")],
    }),
    native("peer-inbox", "PerformActionUsage", "peer", "inbox", {
      type: [ref("inbox-type")],
    }),
    native("worker-allocation", "AllocationUsage", "worker", "allocate", {
      sourceFeature: ref("worker-inbox"),
      targetFeature: ref("worker-builder"),
    }),
    native("peer-allocation", "AllocationUsage", "peer", "allocate", {
      sourceFeature: ref("peer-inbox"),
      targetFeature: ref("peer-builder"),
    }),
  ];
  const get = (id: string) => elements.find((entry) => entry["@id"] === id)!;
  return { elements, get };
}

Deno.test("operator entry compilation selects the owned native occurrence and preserves allocation witnesses", () => {
  const { elements } = fixture();
  const before = structuredClone(elements);
  deepStrictEqual(compileOperatorEntries(elements, identity), [{
    id: "worker-inbox",
    kind: "inbox",
    typeId: "inbox-type",
    performerId: "worker-builder",
    allocationId: "worker-allocation",
    sourceIds: [
      "inbox-type",
      "input",
      "input-type",
      "worker",
      "worker-allocation",
      "worker-builder",
      "worker-inbox",
    ],
  }]);
  deepStrictEqual(elements, before);
});

Deno.test("an otherwise identical peer allocation cannot authorize the selected worker entry", () => {
  const f = fixture();
  f.get("worker-allocation").targetFeature = ref("peer-builder");
  throws(
    () => compileOperatorEntries(f.elements, identity),
    /exact native allocation/,
  );
});

Deno.test("operator primitive definitions and merely named ordinary actions grant no entry", () => {
  const f = fixture();
  f.get("worker-inbox")["@type"] = "ActionUsage";
  equal(compileOperatorEntries(f.elements, identity).length, 0);
});

Deno.test("operator input direction, native type and arity are checked before registration", () => {
  for (const change of ["output", "type", "arity"] as const) {
    const f = fixture();
    if (change === "output") f.get("input").direction = "out";
    if (change === "type") f.get("input").type = [ref("worker")];
    if (change === "arity") {
      f.elements.push(
        native("extra-input", "ItemUsage", "inbox-type", "other", {
          direction: "in",
          type: [ref("input-type")],
        }),
      );
    }
    throws(
      () => compileOperatorEntries(f.elements, identity),
      /primitive input/,
    );
  }
});

Deno.test("a same-named reference performer cannot be substituted for the owned native actor", () => {
  const f = fixture();
  f.get("worker-builder").isReference = true;
  throws(() => compileOperatorEntries(f.elements, identity), /performer/);
  f.get("worker-builder").isReference = false;
  throws(
    () =>
      compileOperatorEntries(f.elements, {
        ...identity,
        builderId: "peer-builder",
      }),
    /another actor/,
  );
});

Deno.test("duplicate native allocations of the same primitive are ambiguous and rejected", () => {
  const f = fixture();
  f.elements.push({
    ...f.get("worker-allocation"),
    "@id": "second-allocation",
  });
  throws(
    () => compileOperatorEntries(f.elements, identity),
    /exact native allocation/,
  );
});

Deno.test("a contradictory second native performer does not disappear behind one expected allocation", () => {
  const f = fixture();
  f.elements.push(
    native(
      "conflicting-allocation",
      "AllocationUsage",
      "worker",
      "otherAllocation",
      {
        sourceFeature: ref("worker-inbox"),
        targetFeature: ref("worker-catalog"),
      },
    ),
  );
  throws(() => compileOperatorEntries(f.elements, identity), /allocation/);
});

Deno.test("qualified primitive definitions cannot be replaced by an ambiguous same-qualified-name type", () => {
  const f = fixture();
  f.elements.push({ ...f.get("inbox-type"), "@id": "other-inbox-type" });
  throws(
    () => compileOperatorEntries(f.elements, identity),
    /Ambiguous operator primitive/,
  );
});
