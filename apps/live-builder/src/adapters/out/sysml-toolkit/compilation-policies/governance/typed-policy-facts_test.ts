import assert from "node:assert/strict";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { NativeLiteral } from "../work/execution-model.ts";
import {
  bindPolicyReferences,
  typedPolicyLiterals,
} from "./typed-policy-facts.ts";

function facts(scalar = "String") {
  const base: ElementRecord = {
    id: "declared-id",
    name: "id",
    ownerId: "definition",
    qualifiedName: "Policy::id",
    metaclass: "AttributeUsage",
    typeIds: ["scalar"],
    redefinedIds: [],
    generalIds: [],
    direction: "",
    isReference: false,
    multiplicity: "",
    doc: "",
  };
  const attribute = {
    ...base,
    id: "instance-id",
    ownerId: "instance",
    redefinedIds: [base.id],
  };
  const literal: NativeLiteral = {
    owner: "instance",
    name: "id",
    attributeId: attribute.id,
    literalId: "literal",
    kind: `Literal${scalar}`,
    value: "unchanged",
    typeIds: ["scalar"],
    typeNames: [`ScalarValues::${scalar}`],
  };
  return { base, attribute, literal };
}

Deno.test("typed policy facts preserve String, Integer and Boolean lexemes", () => {
  for (
    const [scalar, value] of [["String", '["x"]'], ["Integer", "01"], [
      "Boolean",
      "false",
    ]]
  ) {
    const f = facts(scalar);
    f.literal.value = value!;
    const before = structuredClone(f);
    assert(
      typedPolicyLiterals(f.attribute, f.base, f.literal, scalar!, true, [
        f.literal,
      ]),
    );
    assert.deepEqual(f, before);
  }
});

Deno.test("typed policy facts reject altered native identity and typing", () => {
  const corruptions: Array<(f: ReturnType<typeof facts>) => void> = [
    (f) => {
      f.attribute.metaclass = "ReferenceUsage";
    },
    (f) => {
      f.attribute.redefinedIds = [];
    },
    (f) => {
      f.attribute.redefinedIds.push("foreign");
    },
    (f) => {
      f.attribute.typeIds = ["foreign"];
    },
    (f) => {
      f.attribute.typeIds.push("foreign");
    },
    (f) => {
      f.literal.typeIds.push("foreign");
    },
    (f) => {
      f.literal.attributeId = "foreign";
    },
    (f) => {
      f.literal.literalId = "";
    },
    (f) => {
      f.literal.kind = "LiteralInteger";
    },
    (f) => {
      f.literal.typeIds = ["foreign"];
    },
    (f) => {
      f.literal.typeNames = ["Business::String"];
    },
    (f) => {
      f.literal.typeNames.push("ScalarValues::String");
    },
  ];
  for (const corrupt of corruptions) {
    const f = facts();
    corrupt(f);
    assert.equal(
      typedPolicyLiterals(f.attribute, f.base, f.literal, "String", true, [
        f.literal,
      ]),
      false,
    );
  }
  const f = facts();
  assert.equal(
    typedPolicyLiterals(f.attribute, f.base, undefined, "String", true, []),
    false,
  );
});

Deno.test("typed policy facts retain compiler-specific literal identity uniqueness", () => {
  const f = facts();
  const literals = [f.literal, { ...f.literal, owner: "other-instance" }];
  assert.equal(
    typedPolicyLiterals(
      f.attribute,
      f.base,
      f.literal,
      "String",
      true,
      literals,
    ),
    false,
  );
  assert.equal(
    typedPolicyLiterals(
      f.attribute,
      f.base,
      f.literal,
      "String",
      false,
      literals,
    ),
    true,
  );
});

function bindings(): ModelSnapshot {
  return {
    rootId: "root",
    elements: [],
    invocations: [],
    patternIds: [],
    connectors: [{
      id: "binding",
      metaclass: "BindingConnectorAsUsage",
      ownerId: "system",
      name: "",
      ends: [
        { chain: [{ id: "instance", name: "" }, { id: "holder", name: "" }] },
        { chain: [{ id: "builder", name: "" }] },
      ],
    }],
  };
}
const fail = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const messages = {
  ambiguous: "ambiguous reference binding",
  invalid: "wrong holder or mandate binding",
};
const bind = (snapshot: ModelSnapshot, errors = messages) =>
  bindPolicyReferences(
    snapshot,
    "instance",
    "holder",
    "system",
    "builder",
    fail,
    errors,
  );

Deno.test("policy binding matches exact paths in either orientation without mutation", () => {
  const snapshot = bindings();
  snapshot.connectors[0]!.ends.reverse();
  snapshot.connectors.push({
    ...snapshot.connectors[0]!,
    id: "unrelated",
    ends: [
      {
        chain: [{ id: "other-instance", name: "" }, { id: "holder", name: "" }],
      },
    ],
  });
  const before = structuredClone(snapshot);
  assert.equal(bind(snapshot).id, "binding");
  assert.deepEqual(snapshot, before);
});

Deno.test("policy binding distinguishes missing or duplicate paths from invalid targets", () => {
  for (const count of [0, 2]) {
    const snapshot = bindings();
    snapshot.connectors = count
      ? [snapshot.connectors[0]!, {
        ...snapshot.connectors[0]!,
        id: "duplicate",
      }]
      : [];
    assert.throws(() => bind(snapshot), { message: messages.ambiguous });
  }
  const corruptions: Array<(s: ModelSnapshot) => void> = [
    (s) => {
      s.connectors[0]!.ownerId = "foreign-system";
    },
    (s) => {
      s.connectors[0]!.ends[1]!.chain[0]!.id = "foreign-builder";
    },
    (s) => {
      s.connectors[0]!.ends[1]!.chain.push({ id: "nested", name: "" });
    },
    (s) => {
      s.connectors[0]!.ends.push({ chain: [] });
    },
  ];
  for (const corrupt of corruptions) {
    const snapshot = bindings();
    corrupt(snapshot);
    assert.throws(() => bind(snapshot), { message: messages.invalid });
  }
});

Deno.test("operator policy binding keeps one diagnostic for both refusal stages", () => {
  const errors = {
    ambiguous: "Invalid policy holder binding",
    invalid: "Invalid policy holder binding",
  };
  const missing = bindings();
  missing.connectors = [];
  assert.throws(() => bind(missing, errors), { message: errors.ambiguous });
  const foreign = bindings();
  foreign.connectors[0]!.ownerId = "other-system";
  assert.throws(() => bind(foreign, errors), { message: errors.invalid });
});

Deno.test("policy binding rejects nonbinding and partial source paths", () => {
  assert.equal(bind(bindings()).id, "binding");
  const corruptions: Array<(s: ModelSnapshot) => void> = [
    (s) => {
      s.connectors[0]!.metaclass = "ConnectionUsage";
    },
    (s) => {
      s.connectors[0]!.ends[0]!.chain.pop();
    },
    (s) => {
      s.connectors[0]!.ends[0]!.chain.push({ id: "nested", name: "" });
    },
  ];
  for (const corrupt of corruptions) {
    const snapshot = bindings();
    corrupt(snapshot);
    assert.throws(() => bind(snapshot), { message: messages.ambiguous });
  }
});
