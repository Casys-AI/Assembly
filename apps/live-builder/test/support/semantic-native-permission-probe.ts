import { dirname, join } from "node:path";
import { KvModelBuildStore } from "../../src/adapters/out/deno-kv/kv-store.ts";

// Uses exactly the production native command flags, replacing only its entry.
const cachePath = Deno.args[5];
if (!cachePath) throw new Error("Missing host-configured cache path");
const cache = await KvModelBuildStore.open({
  path: cachePath,
  existingOnly: true,
});
try {
  const bytes = await cache.getProjectionBounded(
    "rdf-quads",
    "permissions-v1",
    "a".repeat(64),
    {
      maxUncompressedBytes: 32,
      maxCompressedBytes: 128,
    },
  );
  if (bytes.length !== 3 || bytes[0] !== 1) throw new Error("KV read failed");
  // Proves SQLite write permission is usable on the exact file. Production
  // native consumption does not call these lease operations.
  if (!await cache.acquireLease("native-permission-probe", "fixture", 1000)) {
    throw new Error("KV operation failed");
  }
  await cache.releaseLease("native-permission-probe", "fixture");
} finally {
  await cache.close();
}
const vaultDirectory = join(dirname(cachePath), "vault");
const sentinel = join(vaultDirectory, "durable-sentinel");
for (
  const operation of [
    () => Deno.writeTextFile(sentinel, "overwritten"),
    () => Deno.remove(sentinel),
    () => Deno.writeTextFile(join(vaultDirectory, "new-file"), "created"),
  ]
) {
  let denied = false;
  try {
    await operation();
  } catch (error) {
    denied = error instanceof Deno.errors.NotCapable;
  }
  if (!denied) throw new Error("Nested durable vault mutation was not denied");
}
console.log("KV works; vault mutations denied");
