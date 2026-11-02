import { join } from "node:path";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";
import {
  encodeSemanticPreparationControl,
  parseSemanticPreparationRequest,
  readSemanticPreparationControl,
} from "../../src/adapters/out/oxigraph/protocol.ts";

// Runs through the production client's real child command and permissions.
const [cachePath, vaultDirectory] = Deno.args;
const request = parseSemanticPreparationRequest(
  JSON.parse(await readSemanticPreparationControl(Deno.stdin.readable)),
);
const cache = await KvModelBuildStore.open({
  path: cachePath,
  existingOnly: true,
});
try {
  if (!await cache.acquireLease("permission-probe", "fixture", 1000)) {
    throw new Error("KV write unavailable");
  }
  await cache.releaseLease("permission-probe", "fixture");
} finally {
  await cache.close();
}
const sentinel = join(vaultDirectory, "durable-sentinel");
if (await Deno.readTextFile(sentinel) !== "durable artifact") {
  throw new Error("Cannot read durable vault");
}
for (
  const operation of [
    () => Deno.writeTextFile(sentinel, "overwritten"),
    () => Deno.remove(sentinel),
    () =>
      Deno.writeTextFile(join(vaultDirectory, "new-durable-file"), "created"),
  ]
) {
  let denied = false;
  try {
    await operation();
  } catch (error) {
    denied = error instanceof Deno.errors.NotCapable;
  }
  if (!denied) throw new Error("Durable vault mutation was not denied");
}
const response = encodeSemanticPreparationControl({
  v: 1,
  id: request.id,
  ok: true,
  projection: {
    kind: "rdf-quads",
    projectorVersion: "permission-fixture",
    artifactDigest: request.input.build.artifactDigest,
    projectionDigest: "e".repeat(64),
  },
});
await Deno.stdout.write(response);
