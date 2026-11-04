import { noStoreJson as json } from "../versioning/responses.ts";
import { readWorkCommandBody as body } from "./command-body.ts";
import type { RequestReleases } from "../../../../application/work/saved-systems/request-releases.ts";
import type { SavedSystemOpeningReadinessPort } from "../../../../application/work/saved-systems/ports.ts";
import {
  RequestSpaceError,
  requestSpaceIdentity,
} from "../../../../domain/work/request-spaces/scope.ts";
import { spaceHttpError, spaceSessionSecret } from "./space-session.ts";
import type { SavedSystemsService } from "../../../../application/work/saved-systems/service.ts";
import {
  assertSavedSourceSelection,
  SavedSystemError,
  type SavedSystemSourceSelection,
} from "../../../../domain/work/records/saved-systems.ts";
import { type SavedSystemView } from "../../../../application/work/saved-systems/release-view.ts";
import {
  assertReleaseTagSelection,
  type ReleaseTagSelection,
} from "../../../../domain/work/records/release-tags.ts";
import {
  LocalHttpFailure,
  requireLocalJsonCommand,
} from "../../../../infrastructure/http/local-security.ts";

/** Arrays retain the existing wire format. Every scoped SQL catalogue is a
 * bounded recent window, never an asserted complete publication history. */
const catalogue = (value: unknown) => {
  const response = json(value);
  response.headers.set("x-assembly-catalogue-limit", "100");
  response.headers.set("x-assembly-catalogue-history", "bounded");
  return response;
};
/** Host-local interface command boundary, never human authentication. */
export function createSavedSystemsHandler(
  service: Pick<SavedSystemsService, "save" | "list" | "inspect" | "readTool">,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
  requests?:
    & Pick<RequestReleases, "save" | "list" | "inspect" | "readTool">
    & Partial<Pick<RequestReleases, "listTags">>,
  openingReadiness?: SavedSystemOpeningReadinessPort,
) {
  async function inspected(view: SavedSystemView): Promise<SavedSystemView> {
    if (!openingReadiness) {
      return { ...view, openingAvailability: "unchecked", openingIssues: [] };
    }
    try {
      const readiness = await openingReadiness.inspect(structuredClone(view));
      return {
        ...view,
        openingAvailability: readiness.openingAvailability,
        openingIssues: [...readiness.openingIssues],
      };
    } catch {
      return {
        ...view,
        openingAvailability: "unavailable",
        openingIssues: ["SOURCE_OPENING_UNAVAILABLE"],
      };
    }
  }
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/saved-systems")) return null;
    const inspect = url.pathname.match(
      /^\/api\/saved-systems\/([a-zA-Z0-9_-]{1,128})\/inspect$/,
    );
    const source = url.pathname.match(
      /^\/api\/saved-systems\/([a-zA-Z0-9_-]{1,128})\/tools\/([^/]{1,768})\/([^/]{1,768})\/read$/,
    );
    const save = url.pathname === "/api/saved-systems/save";
    const list = url.pathname === "/api/saved-systems/list";
    const tags = url.pathname === "/api/saved-systems/tags";
    if (!save && !list && !inspect && !source && !tags) {
      return json(
        { code: "UNAVAILABLE", error: "Release unavailable." },
        404,
      );
    }
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }
    try {
      requireLocalJsonCommand(request, servedOrigin);
      const query = url.searchParams;
      const space = query.get("space");
      const caseId = query.get("caseId");
      if (
        query.getAll("space").length > 1 || query.getAll("caseId").length > 1 ||
        [...query.keys()].some((key) => !["space", "caseId"].includes(key)) ||
        space !== null && space !== "requests" ||
        caseId !== null && !requestSpaceIdentity(caseId) ||
        space !== null && caseId !== null || (save || tags) && url.search ||
        caseId !== null && !list
      ) {
        throw new SavedSystemError(
          "INVALID_COMMAND",
          "Select one explicit Release catalogue.",
        );
      }
      const scoped = space === "requests" || caseId !== null;
      if (scoped && !requests) {
        throw new SavedSystemError(
          "UNAVAILABLE",
          "The Request Release catalogue is unavailable.",
        );
      }
      const command = await body(request);
      if (tags) {
        if (Object.keys(command).length !== 1 || !("source" in command)) {
          throw new SavedSystemError(
            "INVALID_COMMAND",
            "Select one exact model source.",
          );
        }
        assertSavedSourceSelection(command.source);
        if (!requests?.listTags) {
          throw new SavedSystemError(
            "UNAVAILABLE",
            "Release tag selection is unavailable.",
          );
        }
        return json(
          await requests.listTags(spaceSessionSecret(request), command.source),
        );
      }
      if (save) {
        if (
          ![4, 5].includes(Object.keys(command).length) ||
          Object.keys(command).some((key) =>
            !["saveKey", "name", "purpose", "source", "tag"].includes(key)
          )
        ) {
          throw new SavedSystemError(
            "INVALID_COMMAND",
            "Only save key, name, purpose, exact model source and tag are accepted.",
          );
        }
        assertSavedSourceSelection(command.source);
        if ("tag" in command) assertReleaseTagSelection(command.tag);
        if (!requests) {
          throw new SavedSystemError(
            "FORBIDDEN",
            "Current modeled Release creation authority is unavailable.",
          );
        }
        return json(
          await requests.save(
            spaceSessionSecret(request),
            command as {
              saveKey: string;
              name: string;
              purpose: string;
              source: SavedSystemSourceSelection;
              tag?: ReleaseTagSelection;
            },
          ),
        );
      }
      if (Object.keys(command).length) {
        throw new SavedSystemError(
          "INVALID_COMMAND",
          "This read takes no command fields.",
        );
      }
      if (scoped) {
        const secret = spaceSessionSecret(request);
        if (list) {
          return catalogue(await requests!.list(secret, caseId ?? undefined));
        }
        if (source) {
          return json(
            await requests!.readTool(
              secret,
              source[1]!,
              decodeURIComponent(source[2]!),
              decodeURIComponent(source[3]!),
            ),
          );
        }
        return json(
          await inspected(await requests!.inspect(secret, inspect![1]!)),
        );
      }
      if (source) {
        return json(
          await service.readTool(
            source[1]!,
            decodeURIComponent(source[2]!),
            decodeURIComponent(source[3]!),
          ),
        );
      }
      return list
        ? catalogue(await service.list())
        : json(await inspected(await service.inspect(inspect![1]!)));
    } catch (error) {
      if (error instanceof RequestSpaceError) return spaceHttpError(error);
      if (error instanceof LocalHttpFailure) {
        return json({ code: error.code, error: error.message }, error.status);
      }
      if (error instanceof SavedSystemError) {
        return json(
          { code: error.code, error: error.message },
          error.code === "FORBIDDEN"
            ? 403
            : error.code === "UNAVAILABLE"
            ? 404
            : error.code === "INVALID_COMMAND"
            ? 400
            : 409,
        );
      }
      return json({
        code: "UNAVAILABLE",
        error:
          "The release could not be read or retained. Retry the same creation command.",
      }, 503);
    }
  };
}
