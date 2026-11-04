import assert from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../domain/model/records/native-literal.ts";
import { compileWorkBudgetPolicy } from "./budget-policy.ts";
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
    name: string,
    metaclass: string,
    ownerId: string,
    typeIds: string[] = [],
  ) => {
    const e: ElementRecord = {
      id,
      name: name.split("::").at(-1)!,
      qualifiedName: name,
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
    snapshot.elements.push(e);
    return e;
  };
  add("pkg", "APEWorkBudget", "Package", "root");
  add("def", "APEWorkBudget::InvocationBudgetPolicy", "PartDefinition", "pkg");
  add("sysdef", "ASELiveBuilder::ConversationSystem", "PartDefinition", "root");
  add("system", "system", "PartUsage", "root", ["sysdef"]);
  add("builder", "builder", "PartUsage", "system", ["operatorType"]);
  add("policy", "budget", "PartUsage", "system", ["def"]);
  const values = {
    id: "budget",
    revision: 1,
    unit: "agent-invocation",
    limit: 12,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  for (const [name, value] of Object.entries(values)) {
    const scalar = typeof value === "number" ? "Integer" : "String";
    add(
      `base-${name}`,
      `APEWorkBudget::InvocationBudgetPolicy::${name}`,
      "AttributeUsage",
      "def",
      [scalar],
    );
    const e = add(`attr-${name}`, name, "AttributeUsage", "policy", [scalar]);
    e.redefinedIds = [`base-${name}`];
    literals.push({
      owner: "policy",
      name,
      attributeId: e.id,
      literalId: `lit-${name}`,
      kind: `Literal${scalar}`,
      typeIds: [scalar],
      typeNames: [`ScalarValues::${scalar}`],
      value: String(value),
    });
  }
  const identity = {
    systemId: "system",
    builderId: "builder",
  } as ModelIdentity;
  return { snapshot, literals, identity };
}
Deno.test("work budget compiles exact native fields and definitions alone are inert", () => {
  const f = fixture();
  assert.equal(
    compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity)!.limit,
    12,
  );
  f.snapshot.elements = f.snapshot.elements.filter((e) =>
    e.id !== "policy" && e.ownerId !== "policy"
  );
  assert.equal(compileWorkBudgetPolicy(f.snapshot, [], f.identity), undefined);
});
Deno.test("work budget fails closed on forged values and native ownership", () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.literals.find((l) => l.name === "limit")!.value = "-1";
    },
    (f) => {
      f.literals.find((l) => l.name === "limit")!.value = "1000001";
    },
    (f) => {
      f.literals.find((l) => l.name === "limit")!.value = "01";
    },
    (f) => {
      f.literals.find((l) => l.name === "revision")!.value = "0";
    },
    (f) => {
      f.literals.find((l) => l.name === "unit")!.value = "provider-dispatch";
    },
    (f) => {
      f.literals.find((l) => l.name === "exhaustionRecipient")!.value = "human";
    },
    (f) => {
      f.literals.pop();
    },
    (f) => {
      f.snapshot.elements.push({
        ...f.snapshot.elements.find((e) => e.id === "policy")!,
        id: "second",
      });
    },
    (f) => {
      f.snapshot.elements.find((e) => e.id === "policy")!.isReference = true;
    },
    (f) => {
      f.snapshot.elements.find((e) => e.id === "policy")!.ownerId = "external";
    },
    (f) => {
      f.snapshot.elements.find((e) => e.id === "policy")!.typeIds.push(
        "anotherType",
      );
    },
    (f) => {
      f.snapshot.elements.find((e) => e.id === "attr-limit")!.redefinedIds = [
        "wrong",
      ];
    },
    (f) => {
      f.literals.find((l) => l.name === "limit")!.kind = "LiteralString";
    },
    (f) => {
      f.snapshot.elements.push({
        ...f.snapshot.elements.find((e) => e.id === "attr-limit")!,
        id: "extra",
        name: "extra",
      });
    },
    (f) => {
      f.literals.push({ ...f.literals[0]!, name: "extra", literalId: "extra" });
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    mutate(f);
    assert.throws(
      () => compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity),
      /Invalid native work budget/,
    );
  }
});

Deno.test("work budget isolates independent conversation systems", () => {
  const f = fixture();
  const own = f.snapshot.elements.find((e) => e.id === "system")!;
  f.snapshot.elements.push({ ...own, id: "other-system" }, {
    ...f.snapshot.elements.find((e) => e.id === "builder")!,
    id: "other-builder",
    ownerId: "other-system",
  });
  const policyElements = f.snapshot.elements.filter((e) =>
    e.id === "policy" || e.ownerId === "policy"
  );
  f.snapshot.elements.push(
    ...policyElements.map((e) => ({
      ...e,
      id: `other-${e.id}`,
      ownerId: e.id === "policy" ? "other-system" : "other-policy",
    })),
  );
  f.literals.push(
    ...f.literals.map((l) => ({
      ...l,
      owner: "other-policy",
      attributeId: `other-${l.attributeId}`,
      literalId: `other-${l.literalId}`,
      value: l.name === "limit" ? "34" : l.value,
    })),
  );
  const other = {
    ...f.identity,
    systemId: "other-system",
    builderId: "other-builder",
  };
  assert.equal(
    compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity)!.limit,
    12,
  );
  assert.equal(
    compileWorkBudgetPolicy(f.snapshot, f.literals, other)!.limit,
    34,
  );
  f.snapshot.elements = f.snapshot.elements.filter((e) =>
    e.id !== "policy" && e.ownerId !== "policy"
  );
  assert.equal(
    compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity),
    undefined,
  );
});

Deno.test("work budgets retain native value reference flags and require direct package part evidence", () => {
  const f = fixture();
  const system = f.snapshot.elements.find((e) => e.id === "system")!;
  system.ownerId = "pkg";
  system.isReference = true;
  system.declaredReference = false;
  for (
    const member of f.snapshot.elements.filter((e) =>
      e.metaclass === "AttributeUsage"
    )
  ) member.isReference = true;
  assert(compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity));
  system.declaredReference = true;
  assert.throws(
    () => compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity),
    /conversation system/,
  );
  system.declaredReference = false;
  system.ownerId = "builder";
  assert.throws(
    () => compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity),
    /conversation system/,
  );
});

Deno.test("Assembly system names preserve an APE invocation budget's native contract", () => {
  const f = fixture();
  const legacy = compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity);
  f.snapshot.elements.find((element) => element.id === "sysdef")!
    .qualifiedName = "AssemblyLiveBuilder::ConversationSystem";
  assert.deepEqual(
    compileWorkBudgetPolicy(f.snapshot, f.literals, f.identity),
    legacy,
  );
});
