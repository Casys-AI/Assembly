import assert from "node:assert/strict";
import { sourceValues } from "../../src/adapters/model/projections/graph/source.ts";
import {
  SourceValueReadError,
  sourceValueReaders,
} from "../../src/adapters/model/sources/values/readers.ts";
import { loadSysmlToolkit } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

type Raw = Record<string, unknown>;
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const sourceName = "typed-values.sysml";
async function sources() {
  return {
    [sourceName]: await Deno.readTextFile(
      new URL("./fixtures/typed-values.sysml", import.meta.url),
    ),
  };
}

async function inheritedSources() {
  return {
    "typed-inherited-values.sysml": await Deno.readTextFile(
      new URL("./fixtures/typed-inherited-values.sysml", import.meta.url),
    ),
  };
}

function refId(reference: unknown): string {
  assert(reference && typeof reference === "object");
  assert("@id" in reference && typeof reference["@id"] === "string");
  return reference["@id"];
}

function nativeValues(elements: Raw[]) {
  const byId = new Map(elements.map((element) => [element["@id"], element]));
  const resolve = (reference: unknown): Raw => {
    const element = byId.get(refId(reference));
    assert(element, "native value endpoint resolves");
    return element;
  };
  const valueOf = (feature: Raw): Raw => {
    const relations = elements.filter((element) =>
      element["@type"] === "FeatureValue" &&
      refId(element.featureWithValue) === feature["@id"]
    );
    assert.equal(relations.length, 1);
    return resolve(relations[0].value);
  };
  const expression = (name: string): Raw => {
    const feature = elements.find((element) =>
      element.qualifiedName === `TypedValues::policy::${name}`
    );
    assert(feature, `fixture feature ${name} exists`);
    return valueOf(feature);
  };
  return { resolve, valueOf, expression };
}

Deno.test({
  name:
    "real Toolkit full JSON exposes enum, ordered sequence and reference expressions",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const runtime = await loadSysmlToolkit(packageDir!);
    const input = JSON.stringify(
      Object.entries(await sources()).map(([name, text]) => ({ name, text })),
    );
    assert.deepEqual(JSON.parse(runtime.checkSyntax(input)), []);
    const session = runtime.createSession(input);
    try {
      const errors = (JSON.parse(session.check()) as Raw[]).filter((item) =>
        item.severity === "error"
      );
      assert.deepEqual(errors, []);
      assert(session.toFullJson);
      const elements = JSON.parse(session.toFullJson(true)) as Raw[];
      const { resolve, valueOf, expression } = nativeValues(elements);

      const mode = expression("mode");
      assert.equal(mode["@type"], "FeatureReferenceExpression");
      const literal = resolve(mode.referent);
      assert.equal(literal["@type"], "EnumerationUsage");
      assert.equal(literal.declaredName, "execute");
      const enumeration = resolve(literal.owner);
      assert.equal(enumeration["@type"], "EnumerationDefinition");
      assert.equal(enumeration.qualifiedName, "TypedValues::Mode");

      const hosts = expression("hosts");
      assert.equal(hosts["@type"], "OperatorExpression");
      assert.equal(hosts.operator, ",");
      assert(Array.isArray(hosts.argument));
      assert.deepEqual(
        hosts.argument.map((reference) => {
          const item = resolve(reference);
          return { kind: item["@type"], value: item.value };
        }),
        [
          { kind: "LiteralString", value: "a" },
          { kind: "LiteralString", value: "b" },
        ],
      );

      const modes = expression("modes");
      assert.equal(modes["@type"], "OperatorExpression");
      assert.equal(modes.operator, ",");
      assert(Array.isArray(modes.argument));
      assert(Array.isArray(modes.input));
      // 0.10.10 exposes only two derived arguments for a three-item comma;
      // input features and their FeatureValues retain all three in order.
      assert.equal(modes.argument.length, 2);
      assert.equal(modes.input.length, 3);
      const ordered = modes.input.map((reference) => {
        const inputFeature = resolve(reference);
        assert.equal(inputFeature.direction, "in");
        assert.equal(refId(inputFeature.owner), modes["@id"]);
        const item = valueOf(inputFeature);
        assert.equal(item["@type"], "FeatureReferenceExpression");
        const enumerationItem = resolve(item.referent);
        assert.equal(refId(enumerationItem.owner), enumeration["@id"]);
        return enumerationItem.declaredName;
      });
      assert.deepEqual(ordered, ["review", "execute", "propose"]);

      const capability = expression("capability");
      assert.equal(capability["@type"], "FeatureReferenceExpression");
      const action = resolve(capability.referent);
      assert.equal(action["@type"], "ActionUsage");
      assert.equal(action.qualifiedName, "TypedValues::invoke");
      assert.equal(expression("computed")["@type"], "OperatorExpression");
      assert.equal(expression("computed").operator, "+");
      assert.equal(expression("ratio")["@type"], "LiteralRational");
      assert.equal(expression("ratio").value, 1.5);
      assert.equal(expression("singletonHosts")["@type"], "LiteralString");
      assert.equal(expression("singletonHosts").value, "a");
      assert.equal(expression("emptyHosts")["@type"], "NullExpression");
      const singletonModes = expression("singletonModes");
      assert.equal(singletonModes["@type"], "FeatureReferenceExpression");
      assert.equal(resolve(singletonModes.referent)["@id"], literal["@id"]);
    } finally {
      session.free();
    }
  },
});

Deno.test({
  name:
    "real Toolkit exposes inherited multiplicity through redefinition and subsetting endpoints",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const runtime = await loadSysmlToolkit(packageDir!);
    const input = JSON.stringify(
      Object.entries(await inheritedSources()).map(([name, text]) => ({
        name,
        text,
      })),
    );
    assert.deepEqual(JSON.parse(runtime.checkSyntax(input)), []);
    const session = runtime.createSession(input);
    try {
      assert.deepEqual(
        (JSON.parse(session.check()) as Raw[]).filter((item) =>
          item.severity === "error"
        ),
        [],
      );
      assert(session.toFullJson);
      const elements = JSON.parse(session.toFullJson(true)) as Raw[];
      const byId = new Map(
        elements.map((element) => [element["@id"], element]),
      );
      const named = (name: string): Raw => {
        const element = elements.find((element) =>
          element.qualifiedName === `InheritedValues::${name}`
        );
        assert(element, `native element ${name} exists`);
        return element;
      };
      const resolve = (reference: unknown): Raw => {
        const element = byId.get(refId(reference));
        assert(element, "native endpoint resolves");
        return element;
      };
      const base = named("Base::hosts");
      const range = resolve(base.multiplicity);
      assert.equal(range["@type"], "MultiplicityRange");
      assert.equal(resolve(range.upperBound)["@type"], "LiteralInfinity");

      for (
        const [child, parent, relationKind] of [
          ["direct::hosts", "Base::hosts", "Redefinition"],
          ["Middle::hosts", "Base::hosts", "Redefinition"],
          ["twoLevels::hosts", "Middle::hosts", "Redefinition"],
          ["twoLevels::selected", "twoLevels::hosts", "Subsetting"],
          ["jsonItem::hosts", "Base::hosts", "Redefinition"],
        ]
      ) {
        const feature = named(child);
        assert.equal(feature.multiplicity, null);
        assert(Array.isArray(feature.ownedSubsetting));
        assert.equal(feature.ownedSubsetting.length, 1);
        const relation = resolve(feature.ownedSubsetting[0]);
        assert.equal(relation["@type"], relationKind);
        assert.equal(refId(relation.subsettingFeature), feature["@id"]);
        assert.equal(refId(relation.subsettedFeature), named(parent)["@id"]);
        if (relationKind === "Redefinition") {
          assert.equal(refId(relation.redefinedFeature), named(parent)["@id"]);
        }
      }
      const jsonValue = elements.find((element) =>
        element["@type"] === "FeatureValue" &&
        refId(element.featureWithValue) === named("jsonItem::hosts")["@id"]
      );
      assert(jsonValue);
      const jsonExpression = resolve(jsonValue.value);
      assert.equal(jsonExpression["@type"], "LiteralString");
      assert.equal(jsonExpression.value, '["literal"]');
    } finally {
      session.free();
    }
  },
});

Deno.test({
  name:
    "real normalized Toolkit preserves inherited singleton collections and literal JSON content",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(await inheritedSources());
    const entries = sourceValues(compiled.elements);
    const readers = sourceValueReaders(entries);
    const entry = (name: string) => {
      const value = entries.find((value) =>
        value.qualifiedName === `InheritedValues::${name}`
      );
      assert(value, `typed value ${name} exists`);
      return value;
    };
    for (
      const [name, literal] of [
        ["direct::hosts", "a"],
        ["twoLevels::hosts", "b"],
        ["twoLevels::selected", "selected"],
        ["jsonItem::hosts", '["literal"]'],
      ]
    ) {
      const value = entry(name);
      assert.deepEqual(value.value, {
        kind: "sequence",
        items: [{ kind: "LiteralString", value: literal }],
      });
      assert.equal(value.multiplicity, "many");
      assert.deepEqual(readers.stringList(value.owner, value.name), [literal]);
      assert.deepEqual(
        readers.stringList(value.owner, value.name, { legacy: "json" }),
        [literal],
      );
    }
    for (
      const [name, literal] of [
        ["twoLevels::legacyHosts", "legacy"],
        ["narrowed::hosts", "narrowed"],
      ]
    ) {
      const value = entry(name);
      assert.equal(value.multiplicity, "single");
      assert.deepEqual(value.typeNames, ["ScalarValues::String"]);
      assert.deepEqual(value.value, {
        kind: "LiteralString",
        value: JSON.stringify([literal]),
      });
      assert.throws(
        () => readers.stringList(value.owner, value.name),
        (error) =>
          error instanceof SourceValueReadError &&
          error.code === "INVALID_TYPE",
      );
      assert.deepEqual(
        readers.stringList(value.owner, value.name, { legacy: "json" }),
        [literal],
      );
    }
  },
});

Deno.test({
  name:
    "real normalized Toolkit references enumeration usages at package and part scope",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(await inheritedSources());
    const named = (name: string) => {
      const element = compiled.elements.find((element) =>
        element.qualifiedName === `InheritedValues::${name}`
      );
      assert(element, `normalized element ${name} exists`);
      return element;
    };
    const entries = sourceValues(compiled.elements);
    for (
      const [reference, target, ownerType] of [
        ["packageReference", "current", "Package"],
        ["enumOwner::partReference", "enumOwner::current", "PartUsage"],
      ]
    ) {
      const targetElement = named(target);
      assert.equal(targetElement["@type"], "EnumerationUsage");
      const owner = compiled.elements.find((element) =>
        element["@id"] === refId(targetElement.owner)
      );
      assert(owner);
      assert.equal(owner["@type"], ownerType);
      const entry = entries.find((entry) =>
        entry.featureId === named(reference)["@id"]
      );
      assert(entry);
      assert.deepEqual(entry.value, {
        kind: "reference",
        elementId: targetElement["@id"],
        qualifiedName: `InheritedValues::${target}`,
      });
    }
  },
});

Deno.test({
  name:
    "real normalized Toolkit values preserve identities, order, scalars and explicit unsupported values",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(await sources());
    const named = (qualifiedName: string) => {
      const element = compiled.elements.find((element) =>
        element.qualifiedName === qualifiedName
      );
      assert(element, `normalized element ${qualifiedName} exists`);
      return String(element["@id"]);
    };
    const ownerId = named("TypedValues::policy");
    const enumId = named("TypedValues::Mode");
    const entries = sourceValues(compiled.elements);
    const values = entries.filter((entry) => entry.owner === ownerId);
    assert.deepEqual(values.map((entry) => entry.name).sort(), [
      "capability",
      "computed",
      "depth",
      "emptyHosts",
      "enabled",
      "hosts",
      "label",
      "legacyHosts",
      "legacyMode",
      "mode",
      "modes",
      "ratio",
      "singletonHosts",
      "singletonModes",
    ]);
    const entry = (name: string) => {
      const found = values.find((value) => value.name === name);
      assert(found, `typed value ${name} exists`);
      assert.equal(found.featureId, named(`TypedValues::policy::${name}`));
      assert(found.expressionId);
      assert(found.featureValueId);
      assert.equal(found.location?.document, sourceName);
      return found;
    };
    assert.deepEqual(entry("label").value, {
      kind: "LiteralString",
      value: "legacy",
    });
    assert.deepEqual(entry("enabled").value, {
      kind: "LiteralBoolean",
      value: "true",
    });
    assert.deepEqual(entry("depth").value, {
      kind: "LiteralInteger",
      value: "2",
    });
    assert.deepEqual(entry("legacyHosts").value, {
      kind: "LiteralString",
      value: '["a","b"]',
    });
    assert.deepEqual(entry("legacyMode").value, {
      kind: "LiteralString",
      value: "execute",
    });
    assert.deepEqual(entry("hosts").value, {
      kind: "sequence",
      items: [
        { kind: "LiteralString", value: "a" },
        { kind: "LiteralString", value: "b" },
      ],
    });
    const enumeration = (literal: string) => ({
      kind: "enum",
      enumId,
      enumQualifiedName: "TypedValues::Mode",
      literal,
    });
    assert.deepEqual(entry("mode").value, enumeration("execute"));
    assert.deepEqual(entry("modes").value, {
      kind: "sequence",
      items: ["review", "execute", "propose"].map(enumeration),
    });
    assert.deepEqual(entry("singletonHosts").value, {
      kind: "sequence",
      items: [{ kind: "LiteralString", value: "a" }],
    });
    assert.deepEqual(entry("emptyHosts").value, {
      kind: "sequence",
      items: [],
    });
    assert.deepEqual(entry("singletonModes").value, {
      kind: "sequence",
      items: [enumeration("execute")],
    });
    assert.deepEqual(entry("capability").value, {
      kind: "reference",
      elementId: named("TypedValues::invoke"),
      qualifiedName: "TypedValues::invoke",
    });
    for (
      const [name, reason] of [
        ["computed", /OperatorExpression/],
        ["ratio", /LiteralRational/],
      ] as const
    ) {
      const value = entry(name).value;
      assert.equal(value.kind, "unsupported");
      assert(value.kind === "unsupported");
      assert.match(value.reason, reason);
    }
    assert.deepEqual(entry("hosts").location, {
      document: sourceName,
      line: 13,
      column: 9,
    });

    const readers = sourceValueReaders(entries);
    assert.deepEqual(readers.stringList(ownerId, "hosts"), ["a", "b"]);
    assert.deepEqual(readers.stringList(ownerId, "singletonHosts"), ["a"]);
    assert.deepEqual(readers.stringList(ownerId, "emptyHosts"), []);
    assert.deepEqual(
      readers.stringList(ownerId, "hosts"),
      readers.stringList(ownerId, "legacyHosts", { legacy: "json" }),
    );
    assert.throws(
      () => readers.stringList(ownerId, "legacyHosts"),
      (error) =>
        error instanceof SourceValueReadError && error.code === "INVALID_TYPE",
    );
    const expectedEnum = {
      enumQualifiedName: "TypedValues::Mode",
      literals: ["propose", "execute", "review"],
    };
    assert.equal(readers.enumValue(ownerId, "mode", expectedEnum), "execute");
    assert.equal(
      readers.enumValue(ownerId, "mode", expectedEnum),
      readers.enumValue(ownerId, "legacyMode", expectedEnum, {
        legacy: "literal",
      }),
    );
    assert.throws(
      () => readers.enumValue(ownerId, "legacyMode", expectedEnum),
      (error) =>
        error instanceof SourceValueReadError && error.code === "INVALID_TYPE",
    );
    assert.throws(() => readers.stringList(ownerId, "modes"), (error) => {
      assert(error instanceof SourceValueReadError);
      assert.equal(error.code, "INVALID_TYPE");
      assert.equal(error.ownerId, ownerId);
      assert.equal(error.featureName, "modes");
      assert.match(error.message, /typed-values\.sysml:14:9/);
      assert(error.message.includes(entry("modes").featureId));
      assert.match(error.message, /sequence item 0, got enum/);
      return true;
    });
    assert.throws(() => readers.enumValue(ownerId, "computed"), (error) => {
      assert(error instanceof SourceValueReadError);
      assert.equal(error.code, "UNSUPPORTED_VALUE");
      assert.match(error.message, /typed-values\.sysml:17:9/);
      assert.match(error.message, /TypedValues::policy::computed/);
      assert.match(error.message, /OperatorExpression/);
      return true;
    });
  },
});
