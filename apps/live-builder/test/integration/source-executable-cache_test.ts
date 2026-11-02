import assert from "node:assert/strict";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  sourceModelIdentity,
  type SourceRevision,
  validateSourceExecutables,
} from "../../src/adapters/model/sources/source-model.ts";
import { sourceLiterals } from "../../src/adapters/model/projections/graph/source.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const projectId = "git:4a371eb8-cf83-5c61-8688-48d1cdbd3d87";
const version = (n: number) => `commit:${n.toString(16).padStart(40, "0")}`;

Deno.test({
  name:
    "executable validation memo retains exact source authority and isolated results",
  ignore: !toolkitIntegrationEnabled,
  async fn(t) {
    const compiled = await new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    }).compile(await loadInitialSources(undefined, { information: false }));
    const revision = (n: number): SourceRevision => ({
      version: version(n),
      sources: compiled.sources,
      elements: compiled.elements,
    });
    const cachedOnly = (source: SourceRevision): SourceRevision => ({
      version: source.version,
      sources: source.sources,
      get elements(): SourceRevision["elements"] {
        throw new Error("An identical source revision was compiled again");
      },
    });

    await t.step(
      "concurrent and later readers receive independent cached copies",
      async () => {
        const source = revision(1);
        const started = Promise.withResolvers<void>();
        const first = validateSourceExecutables({
          ...source,
          get elements() {
            started.resolve();
            return source.elements;
          },
        }, projectId);
        await started.promise;
        const second = validateSourceExecutables(cachedOnly(source), projectId);
        const [a, b] = await Promise.all([first, second]);
        assert.deepEqual(a, b);
        a[0]!.model.configuration.network!.allowedHosts.push("mutated.example");
        a[0]!.unit.identity.builderId = "mutated-builder";
        a.pop();
        assert.deepEqual(
          await validateSourceExecutables(cachedOnly(source), projectId),
          b,
        );
      },
    );

    await t.step("project and commit identities are independent", async () => {
      const otherProject = "git:1b01baee-66c7-558a-9c89-cbbdeae334c8";
      const [otherVersion] = await validateSourceExecutables(
        revision(2),
        projectId,
      );
      const [other] = await validateSourceExecutables(
        revision(1),
        otherProject,
      );
      assert.equal(otherVersion!.model.version.repositoryVersion, version(2));
      assert.equal(other!.model.identity.projectId, otherProject);
      await validateSourceExecutables(cachedOnly(revision(2)), projectId);
      await validateSourceExecutables(cachedOnly(revision(1)), otherProject);
    });

    await t.step(
      "changed candidate sources under their base commit cannot hit its result",
      async () => {
        const base = revision(3);
        const [before] = await validateSourceExecutables(base, projectId);
        const candidate = structuredClone(base);
        const systemId = sourceModelIdentity(base, projectId).systemId;
        const literal = sourceLiterals(candidate.elements).find((value) =>
          value.owner === systemId && value.name === "configurationId"
        )!;
        candidate.elements.find((element) =>
          element["@id"] === literal.literalId
        )!
          .value = "cache-candidate";
        candidate.sources["configuration.sysml"] = candidate.sources[
          "configuration.sysml"
        ]!.replace(JSON.stringify(literal.value), '"cache-candidate"');
        assert.notEqual(
          candidate.sources["configuration.sysml"],
          base.sources["configuration.sysml"],
        );
        const [after] = await validateSourceExecutables(candidate, projectId);
        assert.equal(after!.model.configuration.id, "cache-candidate");
        assert.notEqual(
          after!.model.configuration.id,
          before!.model.configuration.id,
        );
        const [readback] = await validateSourceExecutables(base, projectId);
        assert.deepEqual(readback, before);
      },
    );

    await t.step(
      "failed entries are retried and temporary identities always bypass",
      async () => {
        const base = revision(4);
        await assert.rejects(
          () => validateSourceExecutables(cachedOnly(base), projectId),
          /compiled again/,
        );
        await validateSourceExecutables(base, projectId);
        for (
          const temporary of [
            "compiled-before-publication",
            "compiled-before-owner-admission",
            "compiled-before-scope-admission",
            "branch:current",
            "memory:1",
          ]
        ) {
          const source = { ...base, version: temporary };
          await validateSourceExecutables(source, projectId);
          await assert.rejects(
            () => validateSourceExecutables(cachedOnly(source), projectId),
            /compiled again/,
          );
        }
      },
    );

    await t.step(
      "an older pending refusal cannot evict its successful replacement",
      async () => {
        const base = revision(5);
        const replacement = {
          ...base,
          sources: {
            ...base.sources,
            "configuration.sysml": base.sources["configuration.sysml"] +
              "\n// replacement\n",
          },
        };
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const digest = crypto.subtle.digest;
        let block = true;
        crypto.subtle.digest = async (algorithm, data) => {
          const text = new TextDecoder().decode(data);
          if (
            block && text.startsWith("{") && text.includes('"configuration"')
          ) {
            block = false;
            started.resolve();
            await release.promise;
            throw new Error("transient executable digest failure");
          }
          return await digest.call(crypto.subtle, algorithm, data);
        };
        try {
          const refused = assert.rejects(
            () => validateSourceExecutables(base, projectId),
            /transient executable digest failure/,
          );
          await started.promise;
          await validateSourceExecutables(replacement, projectId);
          release.resolve();
          await refused;
          await validateSourceExecutables(cachedOnly(replacement), projectId);
        } finally {
          release.resolve();
          crypto.subtle.digest = digest;
        }
      },
    );
  },
});
