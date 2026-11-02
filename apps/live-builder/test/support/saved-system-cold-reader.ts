/** Fresh process witness: no write permission and no compiler available. */
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import { createColdBuildStore } from "./cold-build-store.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";
const [projectDir, repositoryId, vaultDirectory, version, serializedReference] =
  Deno.args;
const vault = new FileBuildVault({ directory: vaultDirectory });
const store = createColdBuildStore();
const buildService = new ModelBuildService({
  repositoryId,
  store,
  vault,
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
let stage = "open-read-only-repository";
try {
  const reader = await GitModelRepository.openReadOnly({
    projectDir,
    repositoryId,
    buildService,
  });
  stage = "read-exact-revision";
  const revision = await reader.at(version);
  stage = "read-exact-descriptor";
  const descriptor = await reader.descriptorAt(version);
  stage = "read-retained-tool-source";
  const artifact = await (await GitModelRepository.openArtifactSourcesReadOnly({
    projectDir,
    repositoryId,
    scopeId: "fixture-scope",
  })).read(JSON.parse(serializedReference));
  console.log(
    JSON.stringify({
      version: revision.version,
      sources: revision.sources,
      sourceDigest: revision.sourceDigest,
      descriptor,
      artifact,
    }),
  );
} catch (error) {
  // Emit only bounded technical categories; exception messages/context can carry
  // paths or source bytes and are deliberately excluded from witness output.
  const code = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(error.code)
    ? error.code
    : "UNCODED_FAILURE";
  const errorName =
    error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name)
      ? error.name
      : "UnknownError";
  console.log(JSON.stringify({ unavailable: true, stage, code, errorName }));
  Deno.exitCode = 2;
}
