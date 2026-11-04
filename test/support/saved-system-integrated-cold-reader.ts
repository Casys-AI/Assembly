/** Fresh process: no Toolkit/compiler, no runtime, no write permission/cache. */
import { createPostgresClient } from "../../src/adapters/out/postgres/client.ts";
import { postgresClientConfiguration } from "../../src/adapters/out/postgres/config.ts";
import { ModelBuildService } from "../../src/application/model/builds/service.ts";
import { createColdBuildStore } from "./cold-build-store.ts";
import { FileBuildVault } from "../../src/adapters/out/filesystem/build-vault.ts";
import { storedBuildMaterializer } from "../../src/adapters/out/sysml-toolkit/compilation/stored-materializer.ts";
import { savedSystemReadFixture } from "./saved-system-read-fixture.ts";
import {
  savedSystemDigest,
  type SavedSystemScope,
} from "../../src/domain/work/records/saved-systems.ts";

const [
  schema,
  projectDir,
  repositoryId,
  vaultDirectory,
  primaryOperatorId,
  savedId,
  serializedScope,
] = Deno.args;
const connectionString = Deno.env.get("ASSEMBLY_POSTGRES_TEST_URL");
const configuration = postgresClientConfiguration(connectionString, 2, schema);
const url = new URL(configuration.connectionString);
if (
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  url.pathname !== "/assembly_pg1_test"
) {
  throw new Error(
    "The cold witness requires the dedicated local test database",
  );
}
const client = createPostgresClient(configuration);
const scope: SavedSystemScope = JSON.parse(serializedScope);
const vault = new FileBuildVault({ directory: vaultDirectory });
const cache = createColdBuildStore();
const buildService = new ModelBuildService({
  repositoryId,
  store: cache,
  vault,
  materializer: storedBuildMaterializer,
});
let stage = "open-saved-system";
try {
  const read = savedSystemReadFixture({
    client,
    scope,
    projectDir,
    repositoryId,
    sourceScopeId: scope.systemId,
    primaryOperatorId,
    buildService,
    vault,
    cache,
    retainCommit() {
      throw new Error("Cold inspection cannot retain/write");
    },
  });
  const view = await read.service.inspect(savedId);
  if (view.assetAvailability !== "verified") {
    throw new Error("Saved assets failed cold verification");
  }
  const selectedTool = view.manifest!.operators.flatMap((operator) =>
    operator.tools.map((tool) => ({
      operatorId: operator.operatorId,
      candidateId: tool.candidateId,
    }))
  )[0];
  if (!selectedTool) {
    throw new Error("Saved tool missing");
  }
  stage = "read-exact-saved-tool";
  const tool = await read.service.readTool(
    savedId,
    selectedTool.operatorId,
    selectedTool.candidateId,
  );
  stage = "scope-isolation";
  const foreign = savedSystemReadFixture({
    client,
    scope: { ...scope, executionSpaceId: "foreign-space" },
    projectDir,
    repositoryId,
    sourceScopeId: scope.systemId,
    primaryOperatorId,
    buildService,
    vault,
    cache,
    retainCommit() {
      throw new Error("Foreign inspection cannot write");
    },
  });
  let foreignRefused = false;
  try {
    await foreign.service.inspect(savedId);
  } catch {
    foreignRefused = true;
  }
  const states = await client.runtimeState.findMany({
    where: scope,
    orderBy: { operatorId: "asc" },
    select: { operatorId: true, revision: true, payload: true },
  });
  console.log(
    JSON.stringify({
      view,
      tool,
      foreignRefused,
      stateDigest: await savedSystemDigest(
        states.map((row) => ({ ...row, revision: String(row.revision) })),
      ),
    }),
  );
} catch (error) {
  const code = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_-]{1,64}$/.test(error.code)
    ? error.code
    : "COLD_INSPECTION_FAILED";
  console.log(JSON.stringify({ unavailable: true, stage, code }));
  Deno.exitCode = 2;
} finally {
  await client.$disconnect();
}
