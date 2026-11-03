import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";

Deno.test("saved commit and verified vault survive HEAD advance and a cold read-only process; corrupt/missing bytes never rebuild", async () => {
  const directory = await Deno.makeTempDir({
    prefix: "assembly-saved-system-",
  });
  const repositoryId = "33333333-3333-4333-8333-333333333333";
  const vaultDirectory = `${directory}/vault`;
  const vault = new FileBuildVault({ directory: vaultDirectory });
  const cache = await KvModelBuildStore.open({ path: `${directory}/cache.kv` });
  let compiles = 0;
  const recipe = {
    toolkit: { version: "saved-fixture", bundleDigest: "b".repeat(64) },
    format: "fixture-json-v1",
    normalizerVersion: 1,
    irVersion: "0.1",
    artifactSchema: 1,
    engineVersion: "saved-fixture-engine",
  };
  const compiler = {
    compile(sources: Sources) {
      compiles++;
      return materialize([], sources, recipe.engineVersion);
    },
    recipe: () => Promise.resolve(recipe),
  };
  const buildService = new ModelBuildService({
    repositoryId,
    store: cache,
    vault,
    compiler,
    materializer: {
      materialize: ({ artifact, sources }) =>
        materialize(
          artifact.elements,
          sources,
          artifact.engineVersion,
          artifact.provider,
        ),
    },
  });
  let closed = false;
  try {
    await Deno.mkdir(`${directory}/model`);
    const repository = await GitModelRepository.open({
      projectDir: `${directory}/model`,
      repositoryId,
      compiler,
      buildService,
      buildVault: vault,
    });
    const first = await repository.initialize({
      "main.sysml": "package ExactSaved;\n",
    });
    const descriptor = await repository.descriptorAt(first.version);
    ok(descriptor);
    const tool = {
      artifactId: "fixture-tool",
      kind: "tool-draft" as const,
      content: {
        name: "Tool",
        description: "Self contained public source",
        kind: "read_web_page" as const,
        code: "export default ({html}) => ({title:'Page',text:html})",
      },
    };
    const publication = await repository.artifactSources("fixture-scope")
      .retain({ baseVersion: first.version, source: tool });
    const savedRef = await repository.retainSavedSystemCommit(first.version);
    equal(await repository.retainSavedSystemCommit(first.version), savedRef);
    await repository.retainSavedSystemCommit(
      `commit:${publication.reference.commitOid}`,
    );
    equal((await repository.current()).version, first.version);
    const head = await repository.publishSystemSources(
      { "main.sysml": "package WorkingHead;\n" },
      first.version,
      "local-control",
    );
    ok(head.version !== first.version);
    const proposed = await repository.propose({
      baseVersion: head.version,
      sources: { "main.sysml": "package Unapproved;\n" },
      author: "operator",
      reason: "Unapproved source remains consultation only",
    });
    ok(proposed.proposalVersion);
    const admitted = await GitModelRepository.openReadOnly({
      projectDir: `${directory}/model`,
      repositoryId,
      buildService,
    });
    await admitted.at(proposed.proposalVersion!);
    await rejects(
      () => admitted.admittedMainSource(proposed.proposalVersion!),
      /not admitted on main/,
    );
    const historical = await admitted.admittedMainSource(first.version);
    equal(historical.headVersion, head.version);
    equal(historical.sourceDigest, first.sourceDigest);
    equal((await admitted.at(first.version)).version, first.version);
    // Artifact source publications create readable Git objects; they do not
    // admit a whole-system model on main and cannot become Release sources.
    await rejects(
      () =>
        admitted.admittedMainSource(
          `commit:${publication.reference.commitOid}`,
        ),
      /not admitted on main/,
    );
    await rejects(
      () => admitted.admittedMainSource(`commit:${"f".repeat(40)}`),
      /not admitted on main/,
    );
    equal(compiles > 0, true);
    // Remove the in-process store and service cache from the reader's reach.
    await cache.close();
    closed = true;
    const counts = compiles;
    const cold = async () => {
      const output = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-prompt",
          "--frozen",
          "--allow-read",
          "--allow-env",
          "--allow-sys",
          "--allow-run=git",
          fileURLToPath(
            new URL("../support/saved-system-cold-reader.ts", import.meta.url),
          ),
          `${directory}/model`,
          repositoryId,
          vaultDirectory,
          first.version,
          JSON.stringify(publication.reference),
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      let value;
      try {
        value = JSON.parse(new TextDecoder().decode(output.stdout));
      } catch {
        value = {
          unavailable: true,
          stage: "child-startup",
          code: "INVALID_CHILD_OUTPUT",
          errorName: "MalformedOutput",
        };
      }
      return { output, value };
    };
    const retained = await cold();
    ok(
      retained.output.success,
      JSON.stringify({
        exitCode: retained.output.code,
        stage: retained.value.stage,
        code: retained.value.code,
        errorName: retained.value.errorName,
        stderr: new TextDecoder().decode(retained.output.stderr)
          .replaceAll(directory, "<owned-test-directory>").slice(0, 2000),
      }),
    );
    equal(retained.value.version, first.version);
    equal(retained.value.sourceDigest, first.sourceDigest);
    deepStrictEqual(retained.value.sources, first.sources);
    deepStrictEqual(retained.value.descriptor, descriptor);
    deepStrictEqual(retained.value.artifact, tool);
    equal(compiles, counts);
    const before = await vault.getVerified(descriptor.artifactDigest);
    ok(before);
    await Deno.writeFile(
      `${vaultDirectory}/${descriptor.artifactDigest}.zst`,
      new Uint8Array([0, 1, 2]),
    );
    const corrupt = await cold();
    equal(corrupt.output.success, false);
    equal(corrupt.value.unavailable, true);
    equal(corrupt.value.stage, "read-exact-revision");
    equal(corrupt.value.code, "BUILD_UNAVAILABLE");
    await vault.remove(descriptor.artifactDigest);
    const missing = await cold();
    equal(missing.output.success, false);
    equal(missing.value.unavailable, true);
    equal(missing.value.stage, "read-exact-revision");
    equal(missing.value.code, "BUILD_UNAVAILABLE");
    equal(compiles, counts);
  } finally {
    if (!closed) await cache.close();
    await Deno.remove(directory, { recursive: true });
  }
});
