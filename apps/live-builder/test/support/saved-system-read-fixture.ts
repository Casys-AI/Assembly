/** Test composition of the production saved-system use cases and real adapters.
 * The host-local repository boundary is scope/integrity, not a principal ACL. */
import {
  createSavedSystemsComposition,
  type SavedSystemsCompositionOptions,
} from "../../src/composition/saved-systems.ts";
import { createSavedSystemsHandler } from "../../src/adapters/in/http/work/saved-systems.ts";
import {
  createSavedSystemsApi,
  createSavedSystemsController,
} from "../../frontend/lib/system/saved-systems.ts";

export function savedSystemReadFixture(
  options: SavedSystemsCompositionOptions,
) {
  const { service, assets } = createSavedSystemsComposition(options);
  const origin = "http://127.0.0.1:4311";
  const handler = createSavedSystemsHandler(service, origin);
  const api = createSavedSystemsApi({
    fetch: async (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("host", "127.0.0.1:4311");
      headers.set("origin", origin);
      return await handler(
        new Request(new URL(String(path), origin), { ...init, headers }),
      ) ?? new Response(null, { status: 404 });
    },
  });
  return {
    service,
    assets,
    handler,
    api,
    controller: () => createSavedSystemsController(api),
  };
}
