/** Initial selection is native SysML; selection itself creates no active tool. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { join } from "node:path";
import {
  compileInitialTools,
  withInitialTools,
} from "../../src/adapters/out/sysml-toolkit/compilation-policies/work/initial-catalog.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../src/domain/model/projections/source-facts.ts";
import type { ModelIdentity } from "../../src/domain/shared-kernel/model-identity.ts";
import { preparedSources } from "../../tools/system-workspace.ts";

const base = `package AssemblyLiveBuilder {
    part def ConversationSystem;
    part def ToolCatalog;
    part def ConversationBuilder;
    part liveBuilder : ConversationSystem {
        part builder : ConversationBuilder;
        part catalog : ToolCatalog { }
    }
}`;
const selected = {
  format: 1,
  tools: [{
    id: "reader-v1",
    name: "reader",
    description:
      "Code exact sélectionné pour les tests et l'admission habituels",
    kind: "read_web_page",
    code:
      `export default ({url,html}) => ({title: "x", text: html + "\\n" + url});`,
  }],
};

Deno.test("named system preparation stores an optional exact source selection and preserves empty sources", async () => {
  const directory = await Deno.makeTempDir({ prefix: "ase-initial-tools-" });
  try {
    const sourceFile = join(directory, "sources.json"),
      manifest = join(directory, "initial-tools.json");
    const sources = { "configuration.sysml": base };
    await Deno.writeTextFile(sourceFile, JSON.stringify({ sources }));
    deepStrictEqual(
      await preparedSources({ fromSources: sourceFile }),
      sources,
    );
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({ format: 1, tools: [] }),
    );
    deepStrictEqual(
      await preparedSources({
        fromSources: sourceFile,
        initialTools: manifest,
      }),
      sources,
    );
    await Deno.writeTextFile(manifest, JSON.stringify(selected));
    const prepared = await preparedSources({
      fromSources: sourceFile,
      initialTools: manifest,
    });
    ok(prepared["initial-tools.sysml"]!.includes("item def ToolSeed"));
    ok(
      prepared["configuration.sysml"]!.includes(
        'attribute :>> id = "reader-v1";',
      ),
    );
    equal(prepared["configuration.sysml"]!.includes("ToolCandidate"), false);
    equal(
      prepared["configuration.sysml"]!.includes('status = "active"'),
      false,
    );
    await Deno.writeTextFile(
      manifest,
      JSON.stringify({ ...selected, admitted: true }),
    );
    await rejects(
      () =>
        preparedSources({ fromSources: sourceFile, initialTools: manifest }),
      /manifest/,
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
Deno.test({
  name:
    "real compiler preserves selected code bytes, source ownership and absence of activation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const definition = await Deno.readTextFile(
      new URL("../../models/initial-tools.sysml", import.meta.url),
    );
    const sources = withInitialTools(
      { "configuration.sysml": base },
      selected,
      definition,
    );
    const compiled = await new ToolkitCompiler({ packageDir: packageDir! })
      .compile(
        sources,
      );
    const id = (name: string) =>
      String(
        compiled.elements.find((element) =>
          element.qualifiedName === name
        )!["@id"],
      );
    const identity: ModelIdentity = {
      projectId: "git:edd772dc-6a47-57c1-b265-5ffc9ee35aa5",
      editingContextId: "context",
      rootId: "root",
      systemId: id("AssemblyLiveBuilder::liveBuilder"),
      catalogId: id("AssemblyLiveBuilder::liveBuilder::catalog"),
      builderId: id("AssemblyLiveBuilder::liveBuilder::builder"),
    };
    const snapshot = sourceSnapshot(compiled.elements, identity.rootId),
      literals = sourceLiterals(compiled.elements);
    const seeds = compileInitialTools(snapshot, literals, identity);
    equal(seeds.length, 1);
    equal(seeds[0]!.id, selected.tools[0]!.id);
    equal(seeds[0]!.draft.code, selected.tools[0]!.code);
    ok(seeds[0]!.sourceIds.includes(identity.catalogId));
    equal(
      snapshot.elements.some((element) =>
        element.metaclass === "PartUsage" && element.name === "initialTool1"
      ),
      false,
    );
    // Scalar value features are normatively referential in the toolkit.
    ok(
      snapshot.elements.filter((element) =>
        element.qualifiedName.startsWith("AssemblyInitialTools::ToolSeed::") &&
        element.metaclass === "AttributeUsage"
      ).every((element) => element.isReference),
    );
    const aliasSystem = structuredClone(snapshot);
    aliasSystem.elements.find((element) => element.id === identity.systemId)!
      .declaredReference = true;
    throws(
      () => compileInitialTools(aliasSystem, literals, identity),
      /local system/,
    );
    const aliasField = structuredClone(snapshot);
    aliasField.elements.find((element) =>
      element.qualifiedName === "AssemblyInitialTools::ToolSeed::id"
    )!.declaredReference = true;
    throws(
      () => compileInitialTools(aliasField, literals, identity),
      /exact String fields/,
    );
    const occurrence = snapshot.elements.find((element) =>
      element.id === seeds[0]!.nativeId
    )!;
    occurrence.ownerId = identity.systemId;
    throws(
      () => compileInitialTools(snapshot, literals, identity),
      /local catalog/,
    );
  },
});
