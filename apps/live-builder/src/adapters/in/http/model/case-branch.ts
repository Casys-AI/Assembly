import type { SpaceController } from "../../../../domain/work/request-spaces.ts";
import type { createCaseBranchReader } from "../../../../application/model/case-branch-reader.ts";

type Handler = (request: Request) => Promise<Response | null>;
const PATHS = new Set([
  "/api/model/board",
  "/api/model/authority-matrix",
  "/api/model/diagnostics",
  "/api/model/diagnostics/shapes",
  "/api/model/attention",
  "/api/model/views",
  "/api/model/views/diagram",
  "/api/model/views/plantuml",
  "/api/model/sources/tokens",
  "/api/model-files",
  "/api/model-sources",
]);
/** Scoped, read-only facade. Each request resolves and authorizes its Case and
 * exact commit before delegating to the normal immutable projection readers. */
export function createCaseBranchHandler(options: {
  reader: Pick<ReturnType<typeof createCaseBranchReader>, "resolve">;
  authenticate(request: Request): Promise<SpaceController>;
  revalidate?(controller: SpaceController): Promise<void>;
  handlers: readonly Handler[];
}): Handler {
  return async (request) => {
    const url = new URL(request.url);
    const match = /^\/api\/case-model\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!match) return null;
    const fail = (status: number, message: string) =>
      Response.json({ code: "CASE_MODEL_UNAVAILABLE", message }, {
        status,
        headers: { "cache-control": "no-store" },
      });
    if (request.method !== "GET") {
      return fail(405, "Only read-only Request model access is available.");
    }
    let caseId: string;
    try {
      caseId = decodeURIComponent(match[1]);
    } catch {
      return fail(400, "Invalid Request identity.");
    }
    const path = match[2] || "";
    if (path && !PATHS.has(path)) {
      return fail(404, "This Request model view is unavailable.");
    }
    if (
      !path && [...url.searchParams.keys()].some((key) => key !== "version")
    ) {
      return fail(400, "Unsupported Request model parameter.");
    }
    if (url.searchParams.getAll("version").length > 1) {
      return fail(400, "Only one version may be inspected.");
    }
    try {
      const controller = await options.authenticate(request);
      const scope = await options.reader.resolve(
        caseId,
        controller,
        url.searchParams.get("version") ?? undefined,
      );
      await options.revalidate?.(controller);
      if (!path) {
        return Response.json(scope, {
          headers: { "cache-control": "no-store" },
        });
      }
      url.pathname = path;
      url.searchParams.set("version", scope.version);
      const delegated = new Request(url, {
        method: "GET",
        headers: request.headers,
        signal: request.signal,
      });
      for (const handler of options.handlers) {
        const response = await handler(delegated);
        if (response) {
          await options.revalidate?.(controller);
          const headers = new Headers(response.headers);
          headers.set("cache-control", "no-store");
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        }
      }
      return fail(503, "This Request model view is unavailable.");
    } catch {
      return fail(404, "Request model or requested version is unavailable.");
    }
  };
}
