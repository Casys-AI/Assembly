import type {
  RequestSupervisionQuery,
  RequestSupervisionReadPort,
} from "../../../../application/work/request-spaces/supervision-view.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces/scope.ts";
import {
  spaceHttpError,
  spaceJson,
  spaceSessionSecret,
} from "./space-session.ts";

/** Authenticated operational observations only. No commands or source selection. */
export function createRequestSupervisionHandler(
  service: RequestSupervisionReadPort,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/system/supervision") return null;
    if (request.method !== "GET") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET", "cache-control": "no-store" },
      });
    }
    try {
      const secret = spaceSessionSecret(request);
      if (
        [...url.searchParams.keys()].some((key) =>
          !["caseId", "limit", "cursor"].includes(key) ||
          url.searchParams.getAll(key).length !== 1
        )
      ) {
        throw new RequestSpaceError(
          "INVALID_COMMAND",
          "Select only one Case, page limit and cursor.",
        );
      }
      const query: {
        -readonly [K in keyof RequestSupervisionQuery]:
          RequestSupervisionQuery[K];
      } = {};
      if (url.searchParams.has("caseId")) {
        query.caseId = url.searchParams.get("caseId")!;
      }
      if (url.searchParams.has("cursor")) {
        query.cursor = url.searchParams.get("cursor")!;
      }
      if (url.searchParams.has("limit")) {
        const limit = url.searchParams.get("limit")!;
        if (!/^[1-9][0-9]{0,2}$/.test(limit)) {
          throw new RequestSpaceError(
            "INVALID_COMMAND",
            "A bounded integer limit is required.",
          );
        }
        query.limit = Number(limit);
      }
      return spaceJson(await service.read(secret, query));
    } catch (error) {
      return spaceHttpError(error);
    }
  };
}
