import assert from "node:assert/strict";
import { sourceValues } from "../../../adapters/out/sysml-toolkit/graph/values/source-values.ts";
import { sourceLiterals } from "../projections/source-facts.ts";

type Raw = Record<string, unknown>;
const ref = (id: string) => ({ "@id": id });
const row = (id: string, kind: string, extra: Raw = {}): Raw => ({
  "@id": id,
  "@type": kind,
  ...extra,
});
function fixture(expression: Raw, extra: Raw[] = []): Raw[] {
  return [
    row("owner", "PartUsage", { declaredName: "policy" }),
    row("string", "DataType", { qualifiedName: "ScalarValues::String" }),
    row("feature", "AttributeUsage", {
      declaredName: "hosts",
      qualifiedName: "Policy::hosts",
      owner: ref("owner"),
      type: [ref("string")],
      "sysx:sourceDocument": "policy.sysml",
      "sysx:sourceLine": 4,
      "sysx:sourceColumn": 9,
    }),
    row("assignment", "FeatureValue", {
      featureWithValue: ref("feature"),
      value: ref("expression"),
    }),
    { ...expression, "@id": "expression" },
    ...extra,
  ];
}
const projected = (elements: Raw[]) => {
  const entry = sourceValues(elements).find((value) =>
    value.featureId === "feature"
  );
  assert(entry);
  return entry;
};
const enums = [
  row("mode", "EnumerationDefinition", { qualifiedName: "Policy::Mode" }),
  row("execute", "EnumerationUsage", {
    owner: ref("mode"),
    declaredName: "execute",
    qualifiedName: "Policy::Mode::execute",
  }),
];

Deno.test("sourceValues keeps all four legacy scalar kind/value pairs and native context", () => {
  for (
    const [kind, value] of [
      ["LiteralString", '["b","a"]'],
      ["LiteralBoolean", false],
      ["LiteralInteger", 42],
      ["LiteralReal", 1.25],
    ] as const
  ) {
    const elements = fixture(row("expression", kind, { value }));
    const before = structuredClone(elements);
    const entry = projected(elements);
    assert.deepEqual(entry.value, { kind, value: String(value) });
    assert.deepEqual(entry.typeIds, ["string"]);
    assert.deepEqual(entry.typeNames, ["ScalarValues::String"]);
    assert.deepEqual(entry.location, {
      document: "policy.sysml",
      line: 4,
      column: 9,
    });
    assert.equal(entry.owner, "owner");
    assert.equal(entry.name, "hosts");
    assert.equal(entry.expressionId, "expression");
    assert.equal(entry.featureValueId, "assignment");
    const [legacy] = sourceLiterals(elements);
    assert.deepEqual(entry.value, { kind: legacy.kind, value: legacy.value });
    assert.deepEqual(elements, before);
  }
});

Deno.test("sourceValues resolves enum identity and reference targets without evaluating them", () => {
  const enumElements = fixture(
    row("expression", "FeatureReferenceExpression", {
      referent: ref("execute"),
    }),
    enums,
  );
  assert.deepEqual(projected(enumElements).value, {
    kind: "enum",
    enumId: "mode",
    enumQualifiedName: "Policy::Mode",
    literal: "execute",
  });
  const reference = fixture(
    row("expression", "FeatureReferenceExpression", {
      referent: ref("action"),
    }),
    [row("action", "ActionUsage", { qualifiedName: "Capabilities::invoke" })],
  );
  reference.find((e) => e["@id"] === "feature")!["@type"] = "ReferenceUsage";
  assert.deepEqual(projected(reference).value, {
    kind: "reference",
    elementId: "action",
    qualifiedName: "Capabilities::invoke",
  });
  assert.deepEqual(sourceLiterals(enumElements), []);
  assert.deepEqual(sourceLiterals(reference), []);
});

Deno.test("sourceValues keeps references to enum usages in packages and parts", () => {
  for (const ownerKind of ["Package", "PartUsage"]) {
    const qualifiedName = ownerKind === "Package"
      ? "Policy::current"
      : "Policy::p::current";
    const elements = fixture(
      row("expression", "FeatureReferenceExpression", {
        referent: ref("current"),
      }),
      [
        ...enums,
        row("container", ownerKind),
        row("current", "EnumerationUsage", {
          owner: ref("container"),
          declaredName: "current",
          qualifiedName,
          type: [ref("mode")],
        }),
        row("current-value", "FeatureValue", {
          featureWithValue: ref("current"),
          value: ref("current-expression"),
        }),
        row("current-expression", "FeatureReferenceExpression", {
          referent: ref("execute"),
        }),
      ],
    );
    elements.find((e) => e["@id"] === "feature")!["@type"] = "ReferenceUsage";
    assert.deepEqual(projected(elements).value, {
      kind: "reference",
      elementId: "current",
      qualifiedName,
    });
    assert.deepEqual(
      sourceValues(elements).find((entry) => entry.featureId === "current")
        ?.value,
      {
        kind: "enum",
        enumId: "mode",
        enumQualifiedName: "Policy::Mode",
        literal: "execute",
      },
    );
    assert.deepEqual(sourceLiterals(elements), []);
  }
});

Deno.test("sourceValues localizes malformed enum usage ownership", () => {
  for (
    const [owner, reason] of [
      [null, /enum owner of current: expected one endpoint/],
      [{}, /Malformed native value reference/],
      [[ref("mode"), ref("owner")], /expected one endpoint/],
      [ref("missing"), /Unresolved native value element missing/],
    ] as [unknown, RegExp][]
  ) {
    const entry = projected(fixture(
      row("expression", "FeatureReferenceExpression", {
        referent: ref("current"),
      }),
      [
        ...enums,
        row("current", "EnumerationUsage", {
          owner,
          declaredName: "current",
          qualifiedName: "Policy::current",
        }),
      ],
    ));
    assert.equal(entry.featureId, "feature");
    assert.equal(entry.qualifiedName, "Policy::hosts");
    assert.deepEqual(entry.location, {
      document: "policy.sysml",
      line: 4,
      column: 9,
    });
    assert.equal(entry.value.kind, "unsupported");
    if (entry.value.kind === "unsupported") {
      assert.match(entry.value.reason, reason);
    }
  }
});

Deno.test("sourceValues preserves sequence order and duplicates, including nested comma and enum", () => {
  const elements = fixture(
    row("expression", "OperatorExpression", {
      operator: ",",
      argument: [ref("b"), ref("nested"), ref("b")],
    }),
    [
      row("b", "LiteralString", { value: "b" }),
      row("nested", "OperatorExpression", {
        operator: ",",
        argument: [ref("a"), ref("enum")],
      }),
      row("a", "LiteralString", { value: "a" }),
      row("enum", "FeatureReferenceExpression", { referent: ref("execute") }),
      ...enums,
    ],
  );
  assert.deepEqual(projected(elements).value, {
    kind: "sequence",
    items: [
      { kind: "LiteralString", value: "b" },
      { kind: "LiteralString", value: "a" },
      {
        kind: "enum",
        enumId: "mode",
        enumQualifiedName: "Policy::Mode",
        literal: "execute",
      },
      { kind: "LiteralString", value: "b" },
    ],
  });
});

function inputSequence(): Raw[] {
  return fixture(
    row("expression", "OperatorExpression", {
      operator: ",",
      argument: [ref("a"), ref("b")],
      input: [ref("input-a"), ref("input-b"), ref("input-c")],
    }),
    ["a", "b", "c"].flatMap((id) => [
      row(id, "LiteralString", { value: id }),
      row(`input-${id}`, "Feature", {
        direction: "in",
        owner: ref("expression"),
      }),
      row(`value-${id}`, "FeatureValue", {
        featureWithValue: ref(`input-${id}`),
        value: ref(id),
      }),
    ]),
  );
}
Deno.test("sourceValues reads complete ordered input FeatureValues when Toolkit argument is truncated", () => {
  const elements = inputSequence();
  assert.deepEqual(projected(elements).value, {
    kind: "sequence",
    items: ["a", "b", "c"].map((value) => ({ kind: "LiteralString", value })),
  });
  const all = sourceValues(elements);
  assert.equal(all.length, 4, "input feature values also remain explicit");
});

Deno.test("sourceValues refuses inconsistent or incomplete native input arguments", () => {
  for (
    const mutate of [
      (rows: Raw[]) => {
        rows.find((r) => r["@id"] === "expression")!.argument = [
          ref("b"),
          ref("a"),
        ];
      },
      (rows: Raw[]) => {
        rows.find((r) => r["@id"] === "value-c")!.value = null;
      },
      (rows: Raw[]) => {
        rows.find((r) => r["@id"] === "input-c")!.owner = ref("elsewhere");
      },
      (rows: Raw[]) => {
        rows.find((r) => r["@id"] === "input-c")!.direction = "out";
      },
      (rows: Raw[]) => {
        rows.splice(rows.findIndex((r) => r["@id"] === "value-c"), 1);
      },
      (rows: Raw[]) => {
        rows.find((r) => r["@id"] === "expression")!.input = [
          ref("input-a"),
          {},
        ];
      },
    ]
  ) {
    const elements = inputSequence();
    mutate(elements);
    assert.equal(projected(elements).value.kind, "unsupported");
  }
});

Deno.test("sourceValues reports unsupported forms, cycles and broken references without losing the feature", () => {
  for (
    const [expression, extra, reason] of [
      [
        row("e", "OperatorExpression", { operator: "+", argument: [] }),
        [],
        /operator \+/,
      ],
      [row("e", "LiteralRational", { value: 1.5 }), [], /LiteralRational/],
      [row("e", "InvocationExpression"), [], /InvocationExpression/],
      [
        row("e", "FeatureReferenceExpression", { referent: ref("missing") }),
        [],
        /Unresolved/,
      ],
      [
        row("e", "FeatureReferenceExpression", {
          referent: [ref("a"), ref("b")],
        }),
        [],
        /one endpoint/,
      ],
      [row("e", "FeatureReferenceExpression", { referent: ref("execute") }), [
        enums[1],
      ], /Unresolved/],
      [
        row("e", "OperatorExpression", {
          operator: ",",
          argument: [ref("expression")],
        }),
        [],
        /Cyclic/,
      ],
      [
        row("e", "OperatorExpression", {
          operator: ",",
          argument: [ref("missing")],
        }),
        [],
        /item\[0\].*Unresolved/,
      ],
      [
        row("e", "OperatorExpression", {
          operator: ",",
          argument: [ref("a"), {}],
        }),
        [],
        /Malformed/,
      ],
      [
        row("e", "LiteralInteger", { value: Number.MAX_SAFE_INTEGER + 1 }),
        [],
        /Invalid LiteralInteger/,
      ],
      [
        row("e", "LiteralBoolean", { value: "false" }),
        [],
        /Invalid LiteralBoolean/,
      ],
      [row("e", "LiteralReal", { value: Infinity }), [], /Invalid LiteralReal/],
    ] as [Raw, Raw[], RegExp][]
  ) {
    const result = projected(fixture(expression, extra));
    assert.equal(result.featureId, "feature");
    assert.equal(result.value.kind, "unsupported");
    if (result.value.kind === "unsupported") {
      assert.match(result.value.reason, reason);
    }
  }
});

Deno.test("sourceValues refuses an entire sequence containing a non-enum reference", () => {
  const value = projected(fixture(
    row("e", "OperatorExpression", {
      operator: ",",
      argument: [ref("a"), ref("target-ref")],
    }),
    [
      row("a", "LiteralString", { value: "a" }),
      row("target-ref", "FeatureReferenceExpression", {
        referent: ref("target"),
      }),
      row("target", "ActionUsage", { qualifiedName: "P::target" }),
    ],
  )).value;
  assert.equal(value.kind, "unsupported");
  if (value.kind === "unsupported") {
    assert.match(value.reason, /item\[1\].*reference/);
  }
});

Deno.test("sourceValues localizes missing expression and ambiguous defaults, rejects unattached assignments", () => {
  const elements = fixture(row("e", "LiteralString", { value: "a" }));
  const assignment = elements.find((e) => e["@id"] === "assignment")!;
  assignment.value = ref("missing");
  assert.equal(projected(elements).value.kind, "unsupported");
  assignment.value = [];
  assert.equal(projected(elements).value.kind, "unsupported");
  elements.push({ ...assignment, "@id": "duplicate" });
  const ambiguous = projected(elements).value;
  assert.equal(ambiguous.kind, "unsupported");
  if (ambiguous.kind === "unsupported") {
    assert.match(
      ambiguous.reason,
      /Multiple FeatureValues.*assignment.*duplicate/,
    );
  }
  assignment.featureWithValue = ref("missing-feature");
  assert.throws(
    () => sourceValues(elements),
    /FeatureValue assignment.*featureWithValue/,
  );
  assignment.featureWithValue = [{}];
  assert.throws(
    () => sourceValues(elements),
    /FeatureValue assignment.*Malformed/,
  );
});

Deno.test("sourceValues leaves unvalued declarations absent and rejects duplicate native identities", () => {
  const declaration = row("f", "AttributeUsage", { declaredName: "unset" });
  assert.deepEqual(sourceValues([declaration]), []);
  assert.throws(
    () => sourceValues([declaration, declaration]),
    /duplicate element identities/,
  );
});

Deno.test("sourceValues preserves empty and singleton typed collections using native multiplicity", () => {
  for (
    const upper of [
      row("upper", "LiteralInfinity"),
      row("upper", "LiteralInteger", { value: 3 }),
    ]
  ) {
    for (
      const expression of [
        row("e", "LiteralString", { value: "a" }),
        row("e", "FeatureReferenceExpression", { referent: ref("execute") }),
      ]
    ) {
      const elements = fixture(expression, [
        ...enums,
        row("range", "MultiplicityRange", { upperBound: ref("upper") }),
        upper,
      ]);
      const scalar = projected(elements).value;
      elements.find((e) => e["@id"] === "feature")!.multiplicity = ref("range");
      assert.deepEqual(projected(elements).value, {
        kind: "sequence",
        items: [scalar],
      });
      if (expression["@type"] === "LiteralString") {
        assert.equal(
          sourceLiterals(elements)[0].value,
          "a",
          "legacy scalar output stays unchanged",
        );
      }
    }
  }
  assert.deepEqual(projected(fixture(row("e", "NullExpression"))).value, {
    kind: "sequence",
    items: [],
  });
  const optional = fixture(row("e", "LiteralString", { value: "a" }), [
    row("range", "MultiplicityRange", { bound: [ref("upper")] }),
    row("upper", "LiteralInteger", { value: 1 }),
  ]);
  optional.find((e) => e["@id"] === "feature")!.multiplicity = ref("range");
  assert.deepEqual(projected(optional).value, {
    kind: "LiteralString",
    value: "a",
  });
});
