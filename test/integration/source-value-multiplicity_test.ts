import assert from "node:assert/strict";
import { sourceValues } from "../../src/adapters/out/sysml-toolkit/graph/values/source-values.ts";
import {
  SourceValueReadError,
  sourceValueReaders,
} from "../../src/domain/model/value-objects/readers.ts";
import { loadSysmlToolkit } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

type Raw = Record<string, unknown>;
const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const sourceName = "multiplicity.sysml";
const literal = String.raw`"[\"a\"]"`;
const refId = (reference: unknown) => (reference as Raw)["@id"];

Deno.test({
  name:
    "real Toolkit leaves package and part default multiplicities unmaterialized",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const runtime = await loadSysmlToolkit(packageDir!);
    for (const nested of [false, true]) {
      // Observe the exact unqualified String example, then resolve its type.
      for (const imported of [false, true]) {
        const attribute = `attribute hosts : String = ${literal};`;
        const text = `package P {
          ${imported ? "private import ScalarValues::*;" : ""}
          ${nested ? `part p { ${attribute} }` : attribute}
        }`;
        const input = JSON.stringify([{ name: sourceName, text }]);
        assert.deepEqual(JSON.parse(runtime.checkSyntax(input)), []);
        const session = runtime.createSession(input);
        try {
          const diagnostics = JSON.parse(session.check()) as Raw[];
          assert.deepEqual(
            diagnostics.filter((d) => d.severity === "error"),
            [],
          );
          if (imported) assert.deepEqual(diagnostics, []);
          else {
            assert(diagnostics.some((d) =>
              d.stage === "referential" &&
              d.message === "unresolved reference `String`"
            ));
          }
          assert(session.toFullJson);
          const elements = JSON.parse(session.toFullJson(true)) as Raw[];
          const feature = elements.find((e) =>
            e.qualifiedName === (nested ? "P::p::hosts" : "P::hosts")
          );
          assert(feature);
          assert.equal(feature.multiplicity, null);
          const owner = elements.find((e) => e["@id"] === refId(feature.owner));
          assert.equal(owner?.["@type"], nested ? "PartUsage" : "Package");
          if (nested) assert.equal(refId(feature.owningType), owner?.["@id"]);
          else assert.equal(feature.owningType, null);
        } finally {
          session.free();
        }
      }
    }
  },
});

Deno.test({
  name:
    "real normalized Toolkit permits legacy JSON only with established single multiplicity",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const text = `package P {
      private import ScalarValues::*;
      attribute hosts : String = ${literal};
      attribute single : String[1] = ${literal};
      part p {
        attribute hosts : String = ${literal};
        attribute selected subsets P::hosts = ${literal};
      }
      part def Base {
        attribute hosts : String;
        attribute explicit : String[1];
      }
      part instance : Base {
        attribute :>> hosts = ${literal};
        attribute :>> explicit = ${literal};
      }
    }`;
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile({ [sourceName]: text });
    const entries = sourceValues(compiled.elements);
    const readers = sourceValueReaders(entries);
    for (
      const [name, single] of [
        ["hosts", false],
        ["p::selected", false],
        ["single", true],
        ["p::hosts", true],
        ["instance::hosts", true],
        ["instance::explicit", true],
      ] as const
    ) {
      const entry = entries.find((e) => e.qualifiedName === `P::${name}`);
      assert(entry, name);
      assert.equal(entry.multiplicity, single ? "single" : "unknown", name);
      assert.deepEqual(entry.typeNames, ["ScalarValues::String"]);
      assert.deepEqual(entry.value, { kind: "LiteralString", value: '["a"]' });
      const read = () =>
        readers.stringList(entry.owner, entry.name, { legacy: "json" });
      if (single) {
        assert.deepEqual(read(), ["a"]);
        assert.throws(
          () => readers.stringList(entry.owner, entry.name),
          /requires an explicit encoding/,
        );
      } else {
        assert.throws(read, (error) => {
          assert(error instanceof SourceValueReadError);
          assert.equal(error.code, "INVALID_TYPE");
          assert.equal(error.ownerId, entry.owner);
          assert.equal(error.featureName, entry.name);
          assert(error.message.includes(entry.qualifiedName));
          assert.match(error.message, /multiplicity\.sysml:\d+:\d+/);
          assert.match(error.message, /single-valued String feature/);
          return true;
        });
      }
    }
  },
});
