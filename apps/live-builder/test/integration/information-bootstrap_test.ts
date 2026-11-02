/** New-system defaults compiled by the real native compiler, without a provider. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { projectSourceGraph } from "../../src/adapters/model/projections/graph/source.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");

Deno.test({
  name:
    "legacy native information bootstrap retains ASE identities and its exact skill pin",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "assembly-old-bootstrap-",
    });
    try {
      const models = join(directory, "models");
      await Deno.mkdir(models);
      const fixture = new URL("../fixtures/legacy-ase-model/", import.meta.url);
      for await (const file of Deno.readDir(fixture)) {
        if (file.isFile && file.name.endsWith(".sysml")) {
          await Deno.copyFile(
            new URL(file.name, fixture),
            join(models, file.name),
          );
        }
      }
      const asset = new URL(
        "../../skills/legacy/ase-modeling/SKILL.md",
        import.meta.url,
      );
      const skillDirectory = join(directory, "skills", "ase-modeling");
      await Deno.mkdir(skillDirectory, { recursive: true });
      await Deno.copyFile(asset, join(skillDirectory, "SKILL.md"));
      const sources = await loadInitialSources(pathToFileURL(`${models}/`));
      const { model, native } = await compile(sources);
      // The historical primary identity omits its scope; retaining that
      // encoding is part of preserving its executable digest.
      assert.equal(model.identity.systemQualifiedName, undefined);
      const system = native.elements.find((element) =>
        element.qualifiedName === "ASELiveBuilder::liveBuilder"
      )!;
      assert(system);
      assert.equal(model.identity.systemId, String(system["@id"]));
      assert(model.contextPolicy && model.memoryPolicy && model.skillPolicy);
      const seed = model.initialSkills![0]!;
      assert.equal(seed.id, "ase-modeling");
      assert.equal(seed.source, "bundle:ase-modeling");
      assert.equal(
        seed.digest,
        createHash("sha256").update(await Deno.readFile(asset)).digest("hex"),
      );
      const part = native.elements.find((element) =>
        element.qualifiedName ===
          "ASELiveBuilder::liveBuilder::context::skills::aseModeling"
      )!;
      assert(part);
      assert(seed.sourceIds.includes(String(part["@id"])));
      assert.equal(
        JSON.stringify(sources).includes("AssemblyLiveBuilder"),
        false,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

async function compile(sources: Record<string, string>) {
  const native = await new ToolkitCompiler({ packageDir: packageDir! }).compile(
    sources,
  );
  return {
    native,
    model: await validateSourceExecutable(
      { ...native, version: "native-information-bootstrap-test" },
      "git:d9db4850-4c32-5b9a-879e-4744cb9e3c3e",
    ),
  };
}

Deno.test({
  name:
    "fresh native bootstrap separates tools, context and memory and pins its loaded Assembly skill",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const { model, native } = await compile(await loadInitialSources());
    assert.equal(model.contextPolicy!.recentMessages, 8);
    assert.equal(model.contextPolicy!.maxContextCharacters, 250_000);
    assert.equal(model.memoryPolicy!.allowSelfAdmission, false);
    assert.equal(model.memoryPolicy!.ownerId, model.identity.builderId);
    assert.deepEqual(model.memoryPolicy!.allowedScopes, ["modeling"]);
    assert.deepEqual(model.skillPolicy!.allowedHosts, [
      "raw.githubusercontent.com",
    ]);
    assert.deepEqual(model.configuration.network!.allowedHosts, []);
    assert.equal(model.catalog.length, 0);
    assert.equal(model.behaviors!.length, 10);
    assert.equal(model.operatorEntries!.length, 10);
    assert(
      model.behaviors!.every((entry) =>
        entry.callerNativeId === model.identity.builderId &&
        model.operatorEntries!.some((operation) =>
          operation.id === entry.targetNativeId
        )
      ),
    );
    const context = native.elements.find((element) =>
      element.qualifiedName === "AssemblyLiveBuilder::liveBuilder::context"
    )!;
    const skills = native.elements.find((element) =>
      element.qualifiedName ===
        "AssemblyLiveBuilder::liveBuilder::context::skills"
    )!;
    const memory = native.elements.find((element) =>
      element.qualifiedName === "AssemblyLiveBuilder::liveBuilder::memory"
    )!;
    assert(model.contextPolicy!.sourceIds.includes(String(context["@id"])));
    assert(model.memoryPolicy!.sourceIds.includes(String(memory["@id"])));
    assert(model.skillPolicy!.sourceIds.includes(String(context["@id"])));
    assert(model.skillPolicy!.sourceIds.includes(String(skills["@id"])));
    const seed = model.initialSkills![0]!;
    assert.equal(seed.id, "assembly-modeling");
    assert.equal(seed.loaded, true);
    assert.equal(seed.source, "bundle:assembly-modeling");
    assert.equal("content" in seed, false);
    const content = await Deno.readTextFile(
      new URL("../../skills/assembly-modeling/SKILL.md", import.meta.url),
    );
    const bodyLine = content.split("\n").find((line) =>
      line.length > 60 && !line.startsWith("description:")
    )!;
    assert(bodyLine);
    assert.equal(
      JSON.stringify(await loadInitialSources()).includes(bodyLine),
      false,
    );
    const digest = [
      ...new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(content),
        ),
      ),
    ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    assert.equal(seed.digest, digest);
    assert(seed.sourceIds.every((id) => model.version.sourceIds.includes(id)));
  },
});

Deno.test({
  name:
    "information views expose nested skills without changing the executable contract",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources();
    const { model, native } = await compile(sources);
    const graph = projectSourceGraph(native.elements, model.identity);
    const byName = new Map(graph.views.map((view) => [view.label, view]));
    for (const name of ["agentOverview", "Contexte", "Mémoire", "Skills"]) {
      assert(byName.has(name), `Missing native view ${name}`);
      assert(
        byName.get(name)!.members.every((m) => m.resolution === "resolved"),
      );
    }
    const context = byName.get("Contexte")!, skills = byName.get("Skills")!;
    assert(context.members.some((m) => m.nestedViewId === skills.id));
    assert(
      byName.get("agentOverview")!.members.some((m) =>
        m.nestedViewId === context.id
      ),
    );
    const skillMembers = new Set(skills.members.flatMap((m) => m.graphNodeIds));
    assert(skillMembers.size > 1);
    assert(
      context.members.every((m) =>
        m.graphNodeIds.every((id) => !skillMembers.has(id))
      ),
    );

    const fragment = (await Deno.readTextFile(
      new URL(
        "../../models/configuration-information-views.sysml",
        import.meta.url,
      ),
    )).trim();
    assert(sources["configuration.sysml"]!.includes(fragment));
    const withoutViews = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!
        .replace(fragment, "")
        .replace("    expose Contexte;\n", "")
        .replace("    expose 'Mémoire';\n", ""),
    };
    const previous = (await compile(withoutViews)).model;
    assert.equal(model.version.digest, previous.version.digest);
    assert.deepEqual(model.behaviors, previous.behaviors);
    assert.deepEqual(model.identity, previous.identity);
  },
});

Deno.test({
  name:
    "uninstantiated information libraries preserve a legacy executable digest and rights",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const withDefinitions = await loadInitialSources(undefined, {
      information: false,
    });
    const historical = { ...withDefinitions };
    for (
      const name of [
        "context",
        "memory",
        "skills",
        "behavior-invocations",
        // Imports AssemblyInvocations, so it leaves with behavior-invocations.
        "verified-effect-closure",
      ]
    ) {
      delete historical[`${name}.sysml`];
    }
    const a = (await compile(historical)).model;
    const b = (await compile(withDefinitions)).model;
    assert.equal(a.version.digest, b.version.digest);
    assert.deepEqual(a.mandate, b.mandate);
    assert.deepEqual(a.policy, b.policy);
    assert.equal(b.contextPolicy, undefined);
    assert.equal(b.memoryPolicy, undefined);
    assert.equal(b.skillPolicy, undefined);
    assert.equal(b.initialSkills, undefined);
    assert.equal(b.behaviors, undefined);
  },
});

Deno.test({
  name:
    "initial skill pins and loading rights are validated without embedding its body in model sources",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources();
    const good = await compile(sources);
    const seed = good.model.initialSkills![0]!;
    const invalidDigest = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        seed.digest,
        "0".repeat(64),
      ),
    };
    const changedPin = await compile(invalidDigest);
    assert.notEqual(changedPin.model.version.digest, good.model.version.digest);
    assert.equal(changedPin.model.initialSkills![0]!.digest, "0".repeat(64));
    // Source publication can validate a pin and its ownership, not the bytes of
    // an external bundle. The runtime resolver must verify the bytes on install.
    await assert.rejects(() =>
      compile({
        ...sources,
        "configuration.sysml": sources["configuration.sysml"]!.replace(
          seed.digest,
          "not-a-sha256",
        ),
      }), /Invalid initial skill digest/);
    await assert.rejects(() =>
      compile({
        ...sources,
        "configuration.sysml": sources["configuration.sysml"]!.replace(
          "bundle:assembly-modeling",
          "bundle:../private",
        ),
      }), /closed bundle identifier/);
    const noLoading = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        /(part loadAccess[^}]*attribute :>> enabled = )true;/,
        "$1false;",
      ),
    };
    assert.notEqual(
      noLoading["configuration.sysml"],
      sources["configuration.sysml"],
    );
    await assert.rejects(
      () => compile(noLoading),
      /listing and loading exposures/,
    );
    const noInstallation = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        /(part installAccess[^}]*attribute :>> enabled = )true;/,
        "$1false;",
      ).replace(
        "attribute :>> loaded = true;",
        "attribute :>> loaded = false;",
      ),
    };
    await assert.rejects(
      () => compile(noInstallation),
      /local installation exposure/,
    );
  },
});

Deno.test({
  name: "native skill policy limits participate in executable identity",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const sources = await loadInitialSources();
    const original = await compile(sources);
    const changed = await compile({
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        "maxLoadedCharacters = 48000",
        "maxLoadedCharacters = 48001",
      ),
    });
    assert.notEqual(
      original.model.version.digest,
      changed.model.version.digest,
    );
    assert.equal(changed.model.skillPolicy!.maxLoadedCharacters, 48_001);
  },
});
