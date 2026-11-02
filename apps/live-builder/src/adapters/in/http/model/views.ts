import { parseModelRevisionId } from "../../../../domain/shared-kernel/revision-id.ts";
import type {
  ModelViewDiagramDocument,
  ModelViewList,
  ModelViewPlantumlDocument,
} from "../../../../domain/model/records/diagram-views.ts";
import { createVersionedModelHandler } from "../versioning/handler.ts";
import {
  versionedError,
  versionedFailure,
  versionedJson,
  versionedText,
} from "../versioning/responses.ts";

/** Read-only native views of an immutable commit: view summaries grouped by
 * structure, behavior, state, definitions and declared, plus one diagram per
 * view reprojected on demand. An untraceable view is omitted with a diagnostic,
 * never served silently and never failing the list. The list route is the
 * shared versioned handler (digest supplied by the value, computed once per
 * projection); the diagram route adds only its second `view` parameter. */
export function createModelViewsHandler(options: {
  list: { read(version: string): Promise<ModelViewList> };
  diagram: {
    read(version: string, viewId: string): Promise<ModelViewDiagramDocument>;
  };
  plantuml: {
    read(version: string, viewId: string): Promise<ModelViewPlantumlDocument>;
  };
  head?: () => Promise<string>;
}): (request: Request) => Promise<Response | null> {
  const listHandler = createVersionedModelHandler<ModelViewList>({
    path: "/api/model/views",
    name: "model views",
    failureCode: "MODEL_VIEWS_FAILED",
    read: (version) => options.list.read(version),
    digest: (value) => value.digest,
    head: options.head,
  });
  return async (request: Request): Promise<Response | null> => {
    const listed = await listHandler(request);
    if (listed) return listed;
    const url = new URL(request.url);
    const isPlantuml = url.pathname === "/api/model/views/plantuml";
    if (url.pathname !== "/api/model/views/diagram" && !isPlantuml) return null;
    if (request.method !== "GET") {
      return versionedError(
        "METHOD_NOT_ALLOWED",
        { method: request.method },
        "Read the model views with GET.",
        405,
        { allow: "GET" },
      );
    }
    const names = [...url.searchParams.keys()];
    if (
      names.length !== 2 || !names.includes("version") ||
      !names.includes("view")
    ) {
      return versionedError(
        "INVALID_REQUEST",
        { parameters: names },
        "Pass exactly two query parameters: version and view.",
        400,
      );
    }
    const version = url.searchParams.get("version") ?? "";
    try {
      parseModelRevisionId(version);
    } catch {
      return versionedError(
        "INVALID_VERSION",
        { version },
        "Pass ?version=commit:<40 lowercase hex digits>.",
        400,
      );
    }
    const view = url.searchParams.get("view") ?? "";
    if (!view) {
      return versionedError(
        "INVALID_REQUEST",
        { parameters: names },
        "Pass exactly two query parameters: version and view.",
        400,
      );
    }
    try {
      if (isPlantuml) {
        const value = await options.plantuml.read(version, view);
        return versionedText(request, value.text, {
          version,
          digest: value.digest,
        });
      }
      const value = await options.diagram.read(version, view);
      const body = { toolkit: value.toolkit, view: value.view };
      return versionedJson(request, body, {
        version,
        digest: value.digest,
      });
    } catch (error) {
      return versionedFailure(error, {
        code: "MODEL_VIEWS_FAILED",
        name: "model views",
        version,
      });
    }
  };
}
