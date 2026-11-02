import {
  type SourceEnumReadOptions,
  SourceValueReadError,
  type SourceValueReadErrorCode,
  sourceValueReaders,
} from "./readers.ts";
import type { SourceValueEntry } from "./expressions.ts";

function entry(
  value: SourceValueEntry["value"],
  overrides: Partial<SourceValueEntry> = {},
): SourceValueEntry {
  return {
    owner: "policy",
    name: "setting",
    featureId: "setting-id",
    expressionId: "expression-id",
    featureValueId: "feature-value-id",
    qualifiedName: "P::policy::setting",
    typeIds: ["string"],
    typeNames: ["ScalarValues::String"],
    multiplicity: "single",
    location: { document: "policy.sysml", line: 12, column: 5 },
    value,
    ...overrides,
  };
}

function equal(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function rejects(
  read: () => unknown,
  code: SourceValueReadErrorCode,
  ...fragments: string[]
): void {
  try {
    read();
  } catch (error) {
    if (!(error instanceof SourceValueReadError)) throw error;
    equal(error.code, code);
    for (const fragment of fragments) {
      if (!error.message.includes(fragment)) {
        throw new Error(`Missing ${fragment} in ${error.message}`);
      }
    }
    return;
  }
  throw new Error(`Expected ${code}`);
}

const enumType = {
  enumQualifiedName: "P::Mode",
  literals: ["strict", "permissive"],
};
const nativeEnum = {
  kind: "enum" as const,
  enumId: "mode-id",
  enumQualifiedName: "P::Mode",
  literal: "strict",
};

Deno.test("stringList preserves native and legacy order, duplicates and empty strings", () => {
  const expected = ["b", "", "a", "b"];
  const typed = sourceValueReaders([
    entry({
      kind: "sequence",
      items: expected.map((value) => ({ kind: "LiteralString", value })),
    }),
  ]);
  const legacy = sourceValueReaders([
    entry({ kind: "LiteralString", value: JSON.stringify(expected) }),
  ]);
  equal(typed.stringList("policy", "setting"), expected);
  equal(legacy.stringList("policy", "setting", { legacy: "json" }), expected);
  // A consumer cannot mutate the source through the returned list.
  typed.stringList("policy", "setting").pop();
  equal(typed.stringList("policy", "setting"), expected);
});

Deno.test("stringList accepts empty native and legacy lists", () => {
  for (
    const value of [
      { kind: "sequence" as const, items: [] },
      { kind: "LiteralString" as const, value: "[]" },
    ]
  ) {
    equal(
      sourceValueReaders([entry(value)]).stringList("policy", "setting", {
        legacy: "json",
      }),
      [],
    );
  }
});

Deno.test("typed readers scope name lookup to the exact owner", () => {
  const readers = sourceValueReaders([
    entry({ kind: "LiteralString", value: '["local"]' }),
    entry({ kind: "LiteralString", value: '["other"]' }, {
      owner: "other-policy",
    }),
  ]);
  equal(readers.stringList("policy", "setting", { legacy: "json" }), ["local"]);
  equal(readers.stringList("other-policy", "setting", { legacy: "json" }), [
    "other",
  ]);
  rejects(
    () => readers.stringList("missing-policy", "setting"),
    "MISSING_VALUE",
    "missing-policy::setting",
  );
  rejects(
    () => readers.enumValue("policy", "missing-setting"),
    "MISSING_VALUE",
    "policy::missing-setting",
  );
});

Deno.test("typed readers reject duplicates and retain both source locations", () => {
  const readers = sourceValueReaders([
    entry(nativeEnum),
    entry(nativeEnum, {
      featureId: "duplicate-id",
      location: { document: "duplicate.sysml", line: 3, column: 9 },
    }),
  ]);
  for (const read of [readers.stringList, readers.enumValue]) {
    rejects(
      () => read("policy", "setting"),
      "DUPLICATE_VALUE",
      "policy.sysml:12:5",
      "duplicate.sysml:3:9",
      "setting-id",
      "duplicate-id",
      "found 2",
    );
  }
});

Deno.test("stringList localizes a non-string sequence member without coercion", () => {
  for (
    const item of [
      nativeEnum,
      { kind: "LiteralInteger" as const, value: "2" },
    ]
  ) {
    const readers = sourceValueReaders([
      entry({
        kind: "sequence",
        items: [{ kind: "LiteralString", value: "valid" }, item],
      }),
    ]);
    rejects(
      () => readers.stringList("policy", "setting"),
      "INVALID_TYPE",
      "policy.sysml:12:5",
      "P::policy::setting",
      "setting-id",
      "sequence item 1",
      item.kind,
    );
  }
});

Deno.test("stringList reports malformed legacy JSON and invalid array contents", () => {
  for (
    const value of ['["unfinished"', "plain string", '["a",]']
  ) {
    rejects(
      () =>
        sourceValueReaders([entry({ kind: "LiteralString", value })])
          .stringList("policy", "setting", { legacy: "json" }),
      "INVALID_JSON",
      "policy.sysml:12:5",
      "setting-id",
    );
  }
  for (const value of ['"string"', "null", '{"a":[]}']) {
    rejects(
      () =>
        sourceValueReaders([entry({ kind: "LiteralString", value })])
          .stringList("policy", "setting", { legacy: "json" }),
      "INVALID_TYPE",
      "Expected a legacy JSON array",
    );
  }
  for (const value of ['["a",2]', '["a",null]', '["a",["nested"]]']) {
    rejects(
      () =>
        sourceValueReaders([entry({ kind: "LiteralString", value })])
          .stringList("policy", "setting", { legacy: "json" }),
      "INVALID_TYPE",
      "array item 1",
    );
  }
});

Deno.test("enumValue accepts a native enum and plain or JSON legacy spellings", () => {
  for (
    const [value, options] of [
      [nativeEnum, {}],
      [{ kind: "LiteralString", value: "strict" }, { legacy: "literal" }],
      [{ kind: "LiteralString", value: ' "strict" ' }, { legacy: "json" }],
    ] as [SourceValueEntry["value"], SourceEnumReadOptions][]
  ) {
    const readers = sourceValueReaders([entry(value)]);
    equal(readers.enumValue("policy", "setting", undefined, options), "strict");
    equal(readers.enumValue("policy", "setting", enumType, options), "strict");
  }
});

Deno.test("enumValue checks native enum identity even with the same literal", () => {
  rejects(
    () =>
      sourceValueReaders([
        entry({
          ...nativeEnum,
          enumId: "foreign-id",
          enumQualifiedName: "Q::Mode",
        }),
      ]).enumValue("policy", "setting", enumType),
    "ENUM_MISMATCH",
    "policy.sysml:12:5",
    "P::policy::setting",
    "setting-id",
    "P::Mode",
    "Q::Mode",
    "foreign-id",
  );
});

Deno.test("enumValue validates both native and legacy spellings against the vocabulary", () => {
  for (
    const [value, options] of [
      [{ ...nativeEnum, literal: "unknown" }, {}],
      [{ kind: "LiteralString", value: "unknown" }, { legacy: "literal" }],
      [{ kind: "LiteralString", value: '"unknown"' }, { legacy: "json" }],
      [{ kind: "LiteralString", value: " strict " }, { legacy: "literal" }],
    ] as [SourceValueEntry["value"], SourceEnumReadOptions][]
  ) {
    rejects(
      () =>
        sourceValueReaders([entry(value)]).enumValue(
          "policy",
          "setting",
          enumType,
          options,
        ),
      "INVALID_ENUM_LITERAL",
      "policy.sysml:12:5",
      "P::Mode",
    );
  }
});

Deno.test("enumValue rejects malformed quoted legacy JSON", () => {
  for (const value of ['"strict', '"strict" trailing']) {
    rejects(
      () =>
        sourceValueReaders([entry({ kind: "LiteralString", value })])
          .enumValue("policy", "setting", undefined, { legacy: "json" }),
      "INVALID_JSON",
      "policy.sysml:12:5",
      "P::policy::setting",
    );
  }
});

Deno.test("legacy readers require an explicit encoding even for valid JSON", () => {
  for (const value of ['["a"]', '"strict"', "strict", "[malformed"]) {
    const readers = sourceValueReaders([
      entry({ kind: "LiteralString", value }),
    ]);
    for (const read of [readers.stringList, readers.enumValue]) {
      rejects(
        () => read("policy", "setting"),
        "INVALID_TYPE",
        "explicit encoding",
        "policy.sysml:12:5",
        "P::policy::setting",
        "setting-id",
      );
    }
  }
});

Deno.test("legacy readers require an effectively single-valued String feature", () => {
  for (
    const overrides of [
      { typeIds: ["boolean"], typeNames: ["ScalarValues::Boolean"] },
      { typeIds: [], typeNames: [] },
      { typeIds: ["custom"], typeNames: ["P::String"] },
      {
        typeIds: ["string", "other"],
        typeNames: ["ScalarValues::String", "P::Other"],
      },
      { multiplicity: "many" },
      { multiplicity: "unknown" },
    ] as Partial<SourceValueEntry>[]
  ) {
    const list = sourceValueReaders([
      entry({ kind: "LiteralString", value: '["a"]' }, overrides),
    ]);
    rejects(
      () => list.stringList("policy", "setting", { legacy: "json" }),
      "INVALID_TYPE",
      "single-valued String feature",
      "policy.sysml:12:5",
      "setting-id",
    );
    for (const legacy of ["literal", "json"] as const) {
      const enumeration = sourceValueReaders([
        entry({
          kind: "LiteralString",
          value: legacy === "json" ? '"strict"' : "strict",
        }, overrides),
      ]);
      rejects(
        () => enumeration.enumValue("policy", "setting", enumType, { legacy }),
        "INVALID_TYPE",
        "single-valued String feature",
        "policy.sysml:12:5",
        "setting-id",
      );
    }
  }
});

Deno.test("enumValue uses the selected legacy encoding without inspecting content", () => {
  const quoted = sourceValueReaders([
    entry({ kind: "LiteralString", value: ' "strict" ' }),
  ]);
  equal(
    quoted.enumValue("policy", "setting", undefined, { legacy: "json" }),
    "strict",
  );
  equal(
    quoted.enumValue("policy", "setting", undefined, { legacy: "literal" }),
    ' "strict" ',
  );
  rejects(
    () =>
      quoted.enumValue("policy", "setting", enumType, { legacy: "literal" }),
    "INVALID_ENUM_LITERAL",
    "P::Mode",
  );
  for (const value of ["strict", '"strict', '"strict" trailing']) {
    const readers = sourceValueReaders([
      entry({ kind: "LiteralString", value }),
    ]);
    equal(
      readers.enumValue("policy", "setting", undefined, { legacy: "literal" }),
      value,
    );
    rejects(
      () =>
        readers.enumValue("policy", "setting", undefined, { legacy: "json" }),
      "INVALID_JSON",
      "policy.sysml:12:5",
    );
  }
  for (const value of ["null", '["strict"]', '{"literal":"strict"}']) {
    const readers = sourceValueReaders([
      entry({ kind: "LiteralString", value }),
    ]);
    equal(
      readers.enumValue("policy", "setting", undefined, { legacy: "literal" }),
      value,
    );
    rejects(
      () =>
        readers.enumValue("policy", "setting", undefined, { legacy: "json" }),
      "INVALID_TYPE",
      "Expected a legacy enum string",
    );
  }
});

Deno.test("stringList keeps a singleton collection's JSON text literal even in legacy mode", () => {
  const value = '["a","b"]';
  const readers = sourceValueReaders([
    entry({ kind: "sequence", items: [{ kind: "LiteralString", value }] }, {
      multiplicity: "many",
    }),
  ]);
  equal(readers.stringList("policy", "setting"), [value]);
  equal(readers.stringList("policy", "setting", { legacy: "json" }), [value]);
});

Deno.test("typed readers retain unsupported reasons and reject unrelated kinds", () => {
  const unsupported = sourceValueReaders([
    entry({ kind: "unsupported", reason: "Operator + is not supported" }),
  ]);
  for (const read of [unsupported.stringList, unsupported.enumValue]) {
    rejects(
      () => read("policy", "setting"),
      "UNSUPPORTED_VALUE",
      "policy.sysml:12:5",
      "Operator + is not supported",
    );
  }
  for (
    const value of [
      { kind: "LiteralBoolean" as const, value: "true" },
      {
        kind: "reference" as const,
        elementId: "target",
        qualifiedName: "A::b",
      },
    ]
  ) {
    const readers = sourceValueReaders([entry(value)]);
    for (const read of [readers.stringList, readers.enumValue]) {
      rejects(
        () => read("policy", "setting"),
        "INVALID_TYPE",
        "policy.sysml:12:5",
        value.kind,
      );
    }
  }
  rejects(
    () =>
      sourceValueReaders([entry({ kind: "sequence", items: [] })])
        .enumValue("policy", "setting"),
    "INVALID_TYPE",
    "sequence",
  );
});

Deno.test("typed reader errors identify a feature even without source coordinates", () => {
  rejects(
    () =>
      sourceValueReaders([
        entry({ kind: "LiteralInteger", value: "1" }, {
          location: undefined,
          qualifiedName: "",
        }),
      ]).stringList("policy", "setting"),
    "INVALID_TYPE",
    "policy::setting (setting-id)",
  );
});

Deno.test("natural reads exact typed scalar values and rejects text coercion", () => {
  const natural = (
    value: SourceValueEntry["value"],
    overrides: Partial<SourceValueEntry> = {},
  ) =>
    sourceValueReaders([
      entry(value, {
        typeIds: ["natural"],
        typeNames: ["ScalarValues::Natural"],
        ...overrides,
      }),
    ]).natural("policy", "setting");
  equal(natural({ kind: "LiteralInteger", value: "0" }), 0);
  equal(natural({ kind: "LiteralInteger", value: "15" }), 15);
  for (
    const value of [
      { kind: "LiteralString", value: "15" },
      { kind: "LiteralReal", value: "1.5" },
      { kind: "LiteralInteger", value: "-1" },
      { kind: "LiteralInteger", value: "9007199254740992" },
    ] as SourceValueEntry["value"][]
  ) {
    rejects(() => natural(value), "INVALID_TYPE");
  }
  rejects(
    () =>
      natural({ kind: "LiteralInteger", value: "15" }, {
        typeNames: ["ScalarValues::Integer"],
      }),
    "INVALID_TYPE",
  );
});
