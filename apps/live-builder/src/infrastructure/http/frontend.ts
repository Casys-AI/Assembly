/** Presentation-only dispatch. Fresh never constructs an executor or a database. */
export interface BuiltFrontend {
  fetch(
    request: Request,
    info?: Deno.ServeHandlerInfo,
  ): Response | Promise<Response>;
}

const views = new Set([
  "/",
  "/chat",
  "/tools",
  "/cases",
  "/system",
  "/model",
  "/revisions",
  "/decide",
]);

export function createFrontendDispatcher(frontend: BuiltFrontend) {
  return async (
    request: Request,
    info?: Deno.ServeHandlerInfo,
  ): Promise<Response | null> => {
    const pathname = new URL(request.url).pathname;
    const view = views.has(pathname);
    if (!view && !pathname.startsWith("/assets/")) return null;
    const response = await frontend.fetch(request, info);
    if (!view) return response;
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** Use the generated AOT handler, not compiled-entry.js which starts a listener. */
export async function loadFreshFrontend(options: {
  entry?: URL;
  importModule?: (url: string) => Promise<unknown>;
} = {}) {
  const entry = options.entry ??
    new URL("../../../frontend/_fresh/server.js", import.meta.url);
  const importer = options.importModule ?? ((url: string) => import(url));
  let module: unknown;
  try {
    module = await importer(entry.href);
  } catch (cause) {
    throw new Error(
      "Fresh frontend unavailable. Run `deno task ui:build` in apps/live-builder before starting the atelier.",
      { cause },
    );
  }
  const frontend = (module as { default?: BuiltFrontend } | null)?.default;
  if (!frontend || typeof frontend.fetch !== "function") {
    throw new Error("The Fresh build does not export a request handler.");
  }
  return createFrontendDispatcher(frontend);
}
