/** One request, one disposable process. Only this process parses/validates A
 * and projects/compresses RDF. The parent receives a bounded ProjectionRef. */
import { KvModelBuildStore } from "../deno-kv/kv-store.ts";
import { FileBuildVault } from "../filesystem/build-vault.ts";
import { prepareSemanticProjection } from "./preparation.ts";
import {
  encodeSemanticPreparationControl,
  parseSemanticPreparationRequest,
  readSemanticPreparationControl,
  semanticPreparationFailure,
  type SemanticPreparationResponse,
} from "./protocol.ts";

export async function runSemanticProjectionProcess(): Promise<void> {
  const [cachePath, vaultDirectory] = Deno.args;
  if (Deno.args.length !== 2 || !cachePath || !vaultDirectory) {
    throw new Error(
      "Semantic preparation requires host-configured cache and vault paths",
    );
  }
  const request = parseSemanticPreparationRequest(
    JSON.parse(await readSemanticPreparationControl(Deno.stdin.readable)),
  );
  let store: KvModelBuildStore | undefined;
  let response: SemanticPreparationResponse;
  try {
    // Host composition initializes the cache. An exact-file write grant lets
    // KV manage SQLite without granting mutation of the nested durable vault.
    store = await KvModelBuildStore.open({
      path: cachePath,
      existingOnly: true,
    });
    const prepared = await prepareSemanticProjection(request.input, {
      store,
      vault: new FileBuildVault({ directory: vaultDirectory }),
      leaseOwner: `semantic-preparation:${crypto.randomUUID()}`,
    });
    response = {
      v: 1,
      id: request.id,
      ok: true,
      projection: prepared.projection,
    };
  } catch (error) {
    response = {
      v: 1,
      id: request.id,
      ok: false,
      error: semanticPreparationFailure(error),
    };
  } finally {
    await store?.close();
  }
  let bytes: Uint8Array;
  try {
    bytes = encodeSemanticPreparationControl(response);
  } catch {
    response = {
      v: 1,
      id: request.id,
      ok: false,
      error: {
        code: response.ok ? "INDEX_UNAVAILABLE" : response.error.code,
        message: response.ok
          ? "Preparation result exceeds its control budget"
          : response.error.message,
        context: { reason: "failure detail exceeded the control budget" },
        recovery: "Inspect the exact pinned artifact and retry preparation.",
      },
    };
    bytes = encodeSemanticPreparationControl(response);
  }
  const writer = Deno.stdout.writable.getWriter();
  try {
    await writer.write(bytes);
  } finally {
    writer.releaseLock();
  }
}

if (import.meta.main) {
  await runSemanticProjectionProcess();
}
