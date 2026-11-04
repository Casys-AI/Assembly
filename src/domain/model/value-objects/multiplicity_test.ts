import assert from "node:assert/strict";
import { sourceValues } from "../../../adapters/out/sysml-toolkit/graph/values/source-values.ts";
import { sourceLiterals } from "../projections/source-facts.ts";
import { sourceValueReaders } from "./readers.ts";

type Raw = Record<string, unknown>;
const ref = (id: string) => ({ "@id": id });
const row = (id: string, kind: string, extra: Raw = {}): Raw => ({
  "@id": id,
  "@type": kind,
  ...extra,
});
function fixture(value = "a") {
  return [
    row("policy", "PartUsage"),
    row("string", "DataType", { qualifiedName: "ScalarValues::String" }),
    row("base", "AttributeUsage", {
      declaredName: "hosts",
      type: [ref("string")],
      multiplicity: ref("range"),
    }),
    row("range", "MultiplicityRange", { upperBound: ref("upper") }),
    row("upper", "LiteralInfinity"),
    row("feature", "AttributeUsage", {
      declaredName: "hosts",
      owner: ref("policy"),
      qualifiedName: "P::policy::hosts",
      type: [ref("string")],
      ownedRedefinition: [ref("redefinition")],
    }),
    row("redefinition", "Redefinition", {
      redefinedFeature: ref("base"),
      general: ref("base"),
    }),
    row("assignment", "FeatureValue", {
      featureWithValue: ref("feature"),
      value: ref("value"),
    }),
    row("value", "LiteralString", { value }),
  ];
}
const node = (elements: Raw[], id: string) =>
  elements.find((element) => element["@id"] === id)!;
const projected = (elements: Raw[]) => sourceValues(elements)[0];

Deno.test("effective multiplicity preserves inherited singleton strings and JSON contents", () => {
  for (const text of ["a", '["literal"]']) {
    for (const levels of [1, 2]) {
      const elements = fixture(text);
      if (levels === 2) {
        node(elements, "redefinition").redefinedFeature = ref("middle");
        node(elements, "redefinition").general = ref("middle");
        elements.push(
          row("middle", "AttributeUsage", { redefines: [ref("base")] }),
        );
      }
      const before = sourceLiterals(elements);
      assert.equal(projected(elements).multiplicity, "many");
      assert.deepEqual(projected(elements).value, {
        kind: "sequence",
        items: [{ kind: "LiteralString", value: text }],
      });
      for (const options of [{}, { legacy: "json" as const }]) {
        assert.deepEqual(
          sourceValueReaders(sourceValues(elements)).stringList(
            "policy",
            "hosts",
            options,
          ),
          [text],
        );
      }
      assert.deepEqual(sourceLiterals(elements), before);
      assert.equal(before[0].value, text);
    }
  }
});

Deno.test("effective multiplicity follows subsetting and feature typing contracts", () => {
  for (const kind of ["Subsetting", "ReferenceSubsetting", "FeatureTyping"]) {
    const elements = fixture();
    const feature = node(elements, "feature");
    feature.ownedRedefinition = [];
    feature.ownedSpecialization = [ref("relation")];
    elements.push(
      row("relation", kind, { general: ref("base"), target: ref("base") }),
    );
    assert.equal(projected(elements).multiplicity, "many");
  }
  const elements = fixture();
  node(elements, "feature").ownedRedefinition = [];
  node(elements, "feature").type = [ref("base")];
  assert.equal(projected(elements).multiplicity, "many");
});

Deno.test("effective multiplicity honors local narrowing and inherited intersections", () => {
  for (const local of [true, false]) {
    const elements = fixture('["legacy"]');
    elements.push(
      row("single", "MultiplicityRange", { upperBound: ref("one") }),
      row("one", "LiteralInteger", { value: 1 }),
    );
    if (local) node(elements, "feature").multiplicity = ref("single");
    else {
      elements.push(
        row("narrow", "AttributeUsage", { multiplicity: ref("single") }),
      );
      node(elements, "feature").subsettedFeature = [ref("narrow")];
    }
    const value = projected(elements);
    assert.equal(value.multiplicity, "single");
    assert.deepEqual(value.value, {
      kind: "LiteralString",
      value: '["legacy"]',
    });
    assert.deepEqual(
      sourceValueReaders([value]).stringList("policy", "hosts", {
        legacy: "json",
      }),
      ["legacy"],
    );
  }
});

Deno.test("effective multiplicity ignores implied library subsetting and checks the default owner", () => {
  const elements = fixture();
  const relation = node(elements, "redefinition");
  relation.isImplied = true;
  relation.redefinedFeature = ref("absent-library-feature");
  relation.general = ref("absent-library-feature");
  assert.equal(projected(elements).multiplicity, "single");
  // A parent without a bound must not inject default 1 before another parent
  // supplies its inherited collection contract.
  relation.isImplied = false;
  relation.redefinedFeature = ref("base");
  relation.general = ref("base");
  elements.push(row("unbounded-parent", "AttributeUsage"));
  node(elements, "feature").subsettedFeature = [ref("unbounded-parent")];
  assert.equal(projected(elements).multiplicity, "many");
});

Deno.test("effective multiplicity requires an established single-valued owner default", () => {
  for (const ownerKind of ["Package", "Namespace", "Class", "missing"]) {
    const elements = fixture('["legacy"]');
    node(elements, "feature").ownedRedefinition = [];
    node(elements, "policy")["@type"] = ownerKind;
    if (ownerKind === "missing") node(elements, "policy")["@id"] = "other";
    const entry = projected(elements);
    assert.equal(entry.multiplicity, "unknown");
    assert.deepEqual(entry.value, {
      kind: "LiteralString",
      value: '["legacy"]',
    });
    assert.throws(
      () =>
        sourceValueReaders([entry]).stringList("policy", "hosts", {
          legacy: "json",
        }),
      /P::policy::hosts.*single-valued String feature/,
    );
  }
});

Deno.test("effective multiplicity inherits known defaults but never invents one for a subsetting", () => {
  const elements = fixture('["legacy"]');
  node(elements, "base").multiplicity = null;
  assert.equal(projected(elements).multiplicity, "unknown");
  for (const ownerKind of ["PartDefinition", "PartUsage"]) {
    elements.push(row("base-owner", ownerKind));
    node(elements, "base").owner = ref("base-owner");
    const entry = projected(elements);
    assert.equal(entry.multiplicity, "single");
    assert.deepEqual(
      sourceValueReaders([entry]).stringList("policy", "hosts", {
        legacy: "json",
      }),
      ["legacy"],
    );
    elements.pop();
  }
  node(elements, "feature").ownedRedefinition = [];
  for (const kind of ["ReferenceUsage", "ActionUsage", "ConnectionUsage"]) {
    node(elements, "feature")["@type"] = kind;
    assert.equal(projected(elements).multiplicity, "unknown");
  }
});

Deno.test("effective multiplicity refuses unresolved, cyclic and unsupported contracts", () => {
  const cases: Array<[string, (elements: Raw[]) => void]> = [
    ["Unresolved", (elements) => {
      node(elements, "base").multiplicity = ref("missing");
    }],
    ["Cyclic", (elements) => {
      node(elements, "base").multiplicity = null;
      node(elements, "base").redefines = [ref("feature")];
    }],
    ["Unsupported", (elements) => {
      node(elements, "upper")["@type"] = "OperatorExpression";
    }],
    ["Ambiguous", (elements) => {
      node(elements, "redefinition").general = ref("other");
    }],
  ];
  for (const [message, change] of cases) {
    const elements = fixture();
    change(elements);
    const entry = projected(elements);
    assert.equal(entry.multiplicity, "unknown");
    assert.equal(entry.value.kind, "unsupported");
    assert(entry.value.kind === "unsupported");
    assert.match(entry.value.reason, new RegExp(message));
    assert.throws(
      () =>
        sourceValueReaders([entry]).stringList("policy", "hosts", {
          legacy: "json",
        }),
      /P::policy::hosts/,
    );
  }
});
