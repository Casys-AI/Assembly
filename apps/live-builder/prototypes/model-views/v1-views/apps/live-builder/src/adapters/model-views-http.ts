/** Read-only native views of a model revision. The diagrams are SysML Toolkit
 * projections of the exact admitted sources; this route grants no authority. */
import type {
  ModelView,
  ModelViewProjection,
  ModelViewProjector,
  ModelViewSummary,
} from "../domain/model-views.ts";

interface ViewRevision {
  version: string;
  sources: Record<string, string>;
}

export interface ModelViewsSource {
  current(): Promise<ViewRevision>;
  at(version: string): Promise<ViewRevision>;
}

type Projected = ModelViewProjection & { version: string };

const VERSION = /^(branch|commit):[A-Za-z0-9_-]{1,120}$/;
const CACHED_VERSIONS = 6;

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
const failure = (
  status: number,
  code: string,
  error: string,
  recovery: string,
  context: Record<string, unknown> = {},
) => json({ code, error, recovery, context }, status);

const summary = (
  { diagram: _diagram, ...view }: ModelView,
): ModelViewSummary => view;

export function createModelViewsHandler(
  source: ModelViewsSource,
  projector: ModelViewProjector,
) {
  // The repository resolves every request to an immutable commit version.
  const cache = new Map<string, Promise<Projected>>();
  const project = async (requested: string | null): Promise<Projected> => {
    const revision = requested === null
      ? await source.current()
      : await source.at(requested);
    let pending = cache.get(revision.version);
    if (!pending) {
      pending = projector.views(revision.sources).then((projection) => ({
        ...projection,
        version: revision.version,
      }));
      pending.catch(() => cache.delete(revision.version));
      cache.set(revision.version, pending);
      while (cache.size > CACHED_VERSIONS) {
        cache.delete(cache.keys().next().value!);
      }
    }
    return await pending;
  };

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const listing = url.pathname === "/api/model-views";
    const single = url.pathname === "/api/model-views/diagram";
    if (!listing && !single) return null;
    if (request.method !== "GET") {
      return failure(
        405,
        "METHOD_NOT_ALLOWED",
        "Model views are read-only.",
        "use-get",
      );
    }
    const allowed = listing ? ["modelVersion"] : ["modelVersion", "view"];
    const unknown = [...url.searchParams.keys()].filter((key) =>
      !allowed.includes(key)
    );
    if (unknown.length) {
      return failure(
        400,
        "INVALID_REQUEST",
        "Unknown query parameter.",
        "fix-input",
        { unknown, allowed },
      );
    }
    const version = url.searchParams.get("modelVersion");
    if (version !== null && !VERSION.test(version)) {
      return failure(
        400,
        "INVALID_REQUEST",
        "Invalid model version.",
        "fix-input",
        { modelVersion: version, expected: VERSION.source },
      );
    }
    const viewId = url.searchParams.get("view");
    if (single && !viewId) {
      return failure(
        400,
        "INVALID_REQUEST",
        "A view id is required.",
        "fix-input",
        { required: ["view"] },
      );
    }
    let projected: Projected;
    try {
      projected = await project(version);
    } catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (code === "NOT_FOUND" || code === "INVALID_REQUEST") {
        return failure(
          code === "NOT_FOUND" ? 404 : 400,
          code === "NOT_FOUND" ? "VERSION_NOT_FOUND" : "INVALID_REQUEST",
          code === "NOT_FOUND"
            ? "No such model version."
            : "Model views need an immutable commit version.",
          code === "NOT_FOUND" ? "refresh-model-version" : "fix-input",
          { modelVersion: version ?? "current" },
        );
      }
      return failure(
        503,
        "VIEWS_UNAVAILABLE",
        "The model views could not be projected.",
        "retry",
        {
          modelVersion: version ?? "current",
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (listing) {
      return json({
        version: projected.version,
        toolkit: projected.toolkit,
        views: projected.views.map(summary),
        problems: projected.problems,
      });
    }
    const view = projected.views.find((v) => v.id === viewId);
    return view
      ? json({
        version: projected.version,
        toolkit: projected.toolkit,
        view,
      })
      : failure(
        404,
        "VIEW_NOT_FOUND",
        "No such view in this model version.",
        "refresh-view-list",
        { view: viewId, modelVersion: projected.version },
      );
  };
}
