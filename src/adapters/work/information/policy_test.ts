import assert from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../domain/work/dialogue.ts";
import type { NativeLiteral } from "../../out/sysml-toolkit/compilation-policies/work/execution-model.ts";
import { compileInformationPolicies } from "./policy.ts";

const contextValues = {
  id: "context-v1",
  revision: 1,
  recentMessages: 12,
  maxMessageCharacters: 2000,
  maxCollectionItems: 16,
  maxContextCharacters: 32_000,
};
const memoryValues = {
  id: "memory-v1",
  revision: 2,
  allowedScopes: '["modeling","operations"]',
  requireSourceRefs: true,
  requireKnownOutcome: true,
  maxValidityMs: 86_400_000,
  allowSelfAdmission: false,
};
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
  ): ElementRecord => {
    const element: ElementRecord = {
      id,
      qualifiedName,
      name: qualifiedName.split("::").at(-1)!,
      metaclass,
      ownerId,
      typeIds,
      direction: "",
      generalIds: [],
      isReference: false,
      redefinedIds: [],
      multiplicity: "",
      doc: "",
    };
    snapshot.elements.push(element);
    return element;
  };
  add("pkg", "ASELiveBuilder", "Package", "root");
  add(
    "system-type",
    "ASELiveBuilder::ConversationSystem",
    "PartDefinition",
    "pkg",
  );
  add("system", "ASELiveBuilder::liveBuilder", "PartUsage", "pkg", [
    "system-type",
  ]);
  add("builder", "ASELiveBuilder::liveBuilder::builder", "PartUsage", "system");
  for (const scalar of ["String", "Integer", "Boolean"]) {
    add(`${scalar}-type`, `ScalarValues::${scalar}`, "DataType", "scalars");
  }
  const define = (
    packageName: string,
    typeName: string,
    fields: Record<string, unknown>,
  ) => {
    if (!snapshot.elements.some((element) => element.id === packageName)) {
      add(packageName, packageName, "Package", "root");
    }
    add(typeName, `${packageName}::${typeName}`, "PartDefinition", packageName);
    for (const [name, value] of Object.entries(fields)) {
      const scalar = typeof value === "number"
        ? "Integer"
        : typeof value === "boolean"
        ? "Boolean"
        : "String";
      add(
        `${typeName}-${name}`,
        `${packageName}::${typeName}::${name}`,
        "AttributeUsage",
        typeName,
        [`${scalar}-type`],
      );
    }
  };
  define("APEContext", "DecisionContextPolicy", contextValues);
  define("APEContext", "ModelingGuidance", {
    id: "guidance",
    revision: 1,
    content: "Use exact admitted revisions.",
  });
  define("APEMemory", "GovernedMemoryPolicy", memoryValues);
  const part = (
    id: string,
    typeName: string,
    values: Record<string, unknown>,
    ownerId = "system",
  ) => {
    const owner = snapshot.elements.find((element) => element.id === ownerId)!;
    const occurrence = add(
      id,
      `${owner.qualifiedName}::${id}`,
      "PartUsage",
      ownerId,
      [typeName],
    );
    for (const [name, value] of Object.entries(values)) {
      const scalar = typeof value === "number"
        ? "Integer"
        : typeof value === "boolean"
        ? "Boolean"
        : "String";
      const attribute = add(
        `${id}-${name}`,
        `${occurrence.qualifiedName}::${name}`,
        "AttributeUsage",
        id,
        [`${scalar}-type`],
      );
      attribute.redefinedIds = [`${typeName}-${name}`];
      literals.push({
        owner: id,
        name,
        attributeId: attribute.id,
        literalId: `${attribute.id}-literal`,
        kind: `Literal${scalar}`,
        value: String(value),
        typeIds: [`${scalar}-type`],
        typeNames: [`ScalarValues::${scalar}`],
      });
    }
    return occurrence;
  };
  const identity: ModelIdentity = {
    projectId: "git:faae0774-34aa-5bf4-b2ed-6387bceda008",
    editingContextId: "edit",
    rootId: "root",
    systemId: "system",
    builderId: "builder",
    catalogId: "catalog",
  };
  const compile = () =>
    compileInformationPolicies(snapshot, literals, identity);
  return { snapshot, literals, identity, add, part, compile };
}

Deno.test("information policies are opt-in and never fabricated from library definitions", () => {
  const f = fixture();
  assert.deepEqual(f.compile(), {});
  f.snapshot.elements = f.snapshot.elements.filter((element) =>
    !["APEContext", "APEMemory"].includes(element.qualifiedName)
  );
  assert.deepEqual(f.compile(), {});
});

Deno.test("information policies read exact native values and preserve all evidence identities", () => {
  const f = fixture();
  f.part("context", "DecisionContextPolicy", contextValues);
  f.part("memory", "GovernedMemoryPolicy", memoryValues);
  const result = f.compile();
  assert.deepEqual(
    result.contextPolicy && {
      id: result.contextPolicy.id,
      revision: result.contextPolicy.revision,
      recentMessages: result.contextPolicy.recentMessages,
      maxMessageCharacters: result.contextPolicy.maxMessageCharacters,
      maxCollectionItems: result.contextPolicy.maxCollectionItems,
      maxContextCharacters: result.contextPolicy.maxContextCharacters,
    },
    contextValues,
  );
  assert.equal(result.contextPolicy!.kind, "separated-context");
  assert.equal(result.contextPolicy!.pattern, "5.1");
  assert.equal(result.memoryPolicy!.ownerId, "builder");
  assert.equal(result.memoryPolicy!.kind, "governed-memory");
  assert.equal(result.memoryPolicy!.pattern, "5.2");
  assert.deepEqual(result.memoryPolicy!.allowedScopes, [
    "modeling",
    "operations",
  ]);
  assert.equal(result.memoryPolicy!.allowSelfAdmission, false);
  for (const policy of [result.contextPolicy!, result.memoryPolicy!]) {
    assert.deepEqual(
      policy.sourceIds,
      [...new Set(policy.sourceIds)].toSorted(),
    );
    assert(policy.sourceIds.includes(policy.elementId));
    assert(policy.sourceIds.includes("system"));
    const literalIds = f.literals.filter((literal) =>
      literal.owner === policy.elementId
    ).map((literal) => literal.literalId);
    assert(literalIds.every((id) => policy.sourceIds.includes(id)));
    assert.equal("permissions" in policy, false);
  }
});

Deno.test("information policies are isolated to the exact concrete system", () => {
  const f = fixture();
  f.add("other-system", "Other::system", "PartUsage", "pkg", ["system-type"]);
  f.part("other-context", "DecisionContextPolicy", {
    ...contextValues,
    recentMessages: 99,
  }, "other-system");
  f.part("context", "DecisionContextPolicy", contextValues);
  assert.equal(f.compile().contextPolicy!.recentMessages, 12);
  f.identity.systemId = "other-system";
  assert.equal(f.compile().contextPolicy!.recentMessages, 99);
});

Deno.test("information policies accept concrete nested groups and retain their owner provenance", () => {
  const f = fixture();
  f.add(
    "context-group",
    "ASELiveBuilder::liveBuilder::context",
    "PartUsage",
    "system",
  );
  f.add(
    "local-group",
    "ASELiveBuilder::liveBuilder::context::local",
    "PartUsage",
    "context-group",
  );
  f.part("context", "DecisionContextPolicy", contextValues, "local-group");
  const policy = f.compile().contextPolicy!;
  assert.equal(policy.recentMessages, contextValues.recentMessages);
  assert.equal(policy.elementId, "context");
  for (const id of ["system", "context-group", "local-group", "context"]) {
    assert(policy.sourceIds.includes(id));
  }
});

Deno.test("information policies reject ambiguity, references, type ownership, cycles and orphans", () => {
  for (
    const change of [
      "duplicate",
      "reference",
      "referenced-owner",
      "type-owner",
      "cycle",
      "orphan",
      "multi-type",
    ]
  ) {
    const f = fixture();
    const part = f.part("context", "DecisionContextPolicy", contextValues);
    if (change === "duplicate") {
      f.part("context2", "DecisionContextPolicy", contextValues);
    }
    if (change === "reference") part.isReference = true;
    if (["referenced-owner", "type-owner", "cycle"].includes(change)) {
      const owner = f.add(
        "group",
        "ASELiveBuilder::liveBuilder::group",
        "PartUsage",
        "system",
      );
      part.ownerId = owner.id;
      if (change === "referenced-owner") owner.isReference = true;
      if (change === "type-owner") owner.metaclass = "PartDefinition";
      if (change === "cycle") owner.ownerId = owner.id;
    }
    if (change === "orphan") part.ownerId = "pkg";
    if (change === "multi-type") part.typeIds.push("another-type");
    assert.throws(
      () => f.compile(),
      /native information policy|Information policy/,
    );
  }
});

Deno.test("information policies require every exact typed native field", () => {
  for (
    const change of [
      "missing",
      "extra",
      "wrong-attribute",
      "wrong-kind",
      "wrong-type",
      "wrong-name",
      "wrong-redefinition",
      "duplicate-value",
      "duplicate-literal",
    ]
  ) {
    const f = fixture();
    f.part("context", "DecisionContextPolicy", contextValues);
    const literal = f.literals.find((literal) =>
      literal.name === "recentMessages"
    )!;
    if (change === "missing") f.literals.splice(f.literals.indexOf(literal), 1);
    if (change === "extra") {
      f.add("extra", "context::extra", "AttributeUsage", "context");
    }
    if (change === "wrong-attribute") literal.attributeId = "other";
    if (change === "wrong-kind") literal.kind = "LiteralString";
    if (change === "wrong-type") literal.typeIds = ["String-type"];
    if (change === "wrong-name") literal.typeNames = ["Untrusted::Integer"];
    if (change === "wrong-redefinition") {
      f.snapshot.elements.find((element) => element.id === literal.attributeId)!
        .redefinedIds = [];
    }
    if (change === "duplicate-value") {
      f.literals.push({ ...literal, literalId: "another-literal" });
    }
    if (change === "duplicate-literal") {
      literal.literalId = f.literals[0]!.literalId;
    }
    assert.throws(() => f.compile(), /native information/);
  }
});

Deno.test("native context limits reject malformed and out-of-range values", () => {
  const cases: Array<[string, string]> = [
    ["revision", "0"],
    ["recentMessages", "0"],
    ["recentMessages", "101"],
    ["recentMessages", "01"],
    ["recentMessages", "1.0"],
    ["maxMessageCharacters", "255"],
    ["maxMessageCharacters", "100001"],
    ["maxCollectionItems", "0"],
    ["maxCollectionItems", "129"],
    ["maxContextCharacters", "4095"],
    ["maxContextCharacters", "2000001"],
    ["revision", "9007199254740992"],
  ];
  for (const [name, value] of cases) {
    const f = fixture();
    f.part("context", "DecisionContextPolicy", contextValues);
    f.literals.find((literal) => literal.name === name)!.value = value;
    assert.throws(() => f.compile(), new RegExp(`Integer ${name}`));
  }
});

Deno.test("native memory scopes and validity are explicit, bounded and local", () => {
  for (
    const scopes of [
      "null",
      "{}",
      "[]",
      '["a","a"]',
      '[" "]',
      "[1]",
      "bad",
      JSON.stringify(
        Array.from({ length: 33 }, (_, index) => `scope-${index}`),
      ),
    ]
  ) {
    const f = fixture();
    f.part("memory", "GovernedMemoryPolicy", {
      ...memoryValues,
      allowedScopes: scopes,
    });
    assert.throws(() => f.compile(), /memory allowedScopes/);
  }
  for (const validity of [0, 31_536_000_001]) {
    const f = fixture();
    f.part("memory", "GovernedMemoryPolicy", {
      ...memoryValues,
      maxValidityMs: validity,
    });
    assert.throws(() => f.compile(), /Integer maxValidityMs/);
  }
  const f = fixture();
  f.part("memory", "GovernedMemoryPolicy", memoryValues);
  f.literals.find((literal) => literal.name === "requireSourceRefs")!.value =
    "TRUE";
  assert.throws(() => f.compile(), /Boolean requireSourceRefs/);
});

Deno.test("native modeling guidance stays source-owned advice and requires unique bounded content", () => {
  const f = fixture();
  f.part("guidance-b", "ModelingGuidance", {
    id: "second",
    revision: 1,
    content: "Keep proposals distinct from admission.",
  });
  f.part("guidance-a", "ModelingGuidance", {
    id: "first",
    revision: 2,
    content: "Keep current evidence distinct from history.",
  });
  const result = f.compile();
  assert.deepEqual(result.modelingGuidance!.map((entry) => entry.id), [
    "first",
    "second",
  ]);
  assert.equal(
    result.modelingGuidance![0]!.content,
    "Keep current evidence distinct from history.",
  );
  assert(
    result.modelingGuidance![0]!.sourceIds.includes(
      "guidance-a-content-literal",
    ),
  );
  assert.equal(result.contextPolicy, undefined);
  assert.equal(result.memoryPolicy, undefined);
  f.literals.find((literal) =>
    literal.owner === "guidance-b" && literal.name === "id"
  )!.value = "first";
  assert.throws(() => f.compile(), /Duplicate native modeling guidance/);
  for (const content of ["  ", "x".repeat(16_001), "x\0y"]) {
    const g = fixture();
    g.part("guidance", "ModelingGuidance", {
      id: "guide",
      revision: 1,
      content,
    });
    assert.throws(() => g.compile(), /modeling guidance content/);
  }
});

Deno.test("native modeling guidance rejects more than sixteen local occurrences", () => {
  const f = fixture();
  for (let i = 0; i < 17; i++) {
    f.part(`guidance-${i}`, "ModelingGuidance", {
      id: `guide-${i}`,
      revision: 1,
      content: "Explicit advice.",
    });
  }
  assert.throws(
    () => f.compile(),
    /Ambiguous native information policy ModelingGuidance/,
  );
});

Deno.test("information policies accept source-proven package-owned parts while rejecting nested references", () => {
  const f = fixture();
  const system = f.snapshot.elements.find((e) => e.id === "system")!;
  system.isReference = true;
  system.declaredReference = false;
  assert.deepEqual(f.compile(), {});
  system.declaredReference = true;
  assert.throws(
    () => f.compile(),
    /Missing concrete native information policy system/,
  );
  system.declaredReference = false;
  system.ownerId = "builder";
  assert.throws(
    () => f.compile(),
    /Missing concrete native information policy system/,
  );
});
