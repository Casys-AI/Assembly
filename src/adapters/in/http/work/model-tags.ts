import { noStoreJson as json } from "../versioning/responses.ts";
import type { RequestReleases } from "../../../../application/work/saved-systems/request-releases.ts";
import { assertReleaseTagName } from "../../../../domain/work/release-tags.ts";
import {
  assertSavedSourceSelection,
  SavedSystemError,
} from "../../../../domain/work/saved-systems.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces.ts";
import {
  LocalHttpFailure,
  requireLocalJsonCommand,
} from "../../../../infrastructure/http/local-security.ts";
import { readWorkCommandBody } from "./command-body.ts";
import { spaceHttpError, spaceSessionSecret } from "./space-session.ts";

/** Exact standalone tag command. No browser scope/ref/actor or Release DTO. */
export function createModelTagsHandler(
  service: Pick<RequestReleases, "createTag">,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/model-tags/create") return null;
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    try {
      requireLocalJsonCommand(request, servedOrigin);
      if (url.search) {
        throw new SavedSystemError(
          "INVALID_COMMAND",
          "Select one exact tag source.",
        );
      }
      const body = await readWorkCommandBody(request);
      if (Object.keys(body).sort().join(",") !== "name,source") {
        throw new SavedSystemError(
          "INVALID_COMMAND",
          "Only an exact source and tag name are accepted.",
        );
      }
      assertSavedSourceSelection(body.source);
      assertReleaseTagName(body.name);
      return json(
        await service.createTag(spaceSessionSecret(request), {
          source: body.source,
          name: body.name,
        }),
      );
    } catch (error) {
      if (error instanceof RequestSpaceError) return spaceHttpError(error);
      if (error instanceof LocalHttpFailure) {
        return json({ code: error.code, error: error.message }, error.status);
      }
      if (error instanceof SavedSystemError) {
        const status = error.code === "INVALID_COMMAND"
          ? 400
          : error.code === "FORBIDDEN"
          ? 403
          : error.code === "UNAVAILABLE"
          ? 404
          : 409;
        return json({ code: error.code, error: error.message }, status);
      }
      if (error instanceof SyntaxError || error instanceof TypeError) {
        return json(
          { code: "INVALID_COMMAND", error: "Invalid tag command." },
          400,
        );
      }
      return json({
        code: "UNAVAILABLE",
        error: "Exact tag creation is unavailable.",
      }, 503);
    }
  };
}
