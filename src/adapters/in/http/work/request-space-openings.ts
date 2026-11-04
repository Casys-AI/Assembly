import type { RequestSpaceOpenings } from "../../../../application/work/request-spaces/opening.ts";
import { openingCommand } from "../../../../domain/work/request-spaces/opening.ts";
import {
  RequestSpaceError,
  type RequestSpaceScope,
} from "../../../../domain/work/request-spaces/scope.ts";
import { requireLocalJsonCommand } from "../../../../infrastructure/http/local-security.ts";
import {
  boundedSpaceCommand,
  spaceHttpError,
  spaceJson,
  spaceSessionSecret,
} from "./space-session.ts";
/** Authenticated opening and read-only host metadata. Existing message routes
 * retain their contract. No actor, scope or branch ref is accepted from a body. */
export function createRequestSpaceOpeningHandler(
  service: Pick<RequestSpaceOpenings, "open">,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
  hostScope?: Readonly<RequestSpaceScope>,
) {
  // Capture only host identity, independently of caller-owned objects, runtime
  // state IDs, source selection, controller credentials and execution authority.
  const context = hostScope
    ? Object.freeze({
      projectId: hostScope.projectId,
      systemId: hostScope.systemId,
    })
    : undefined;
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const metadata = url.pathname === "/api/request-space-openings/context";
    if (!metadata && url.pathname !== "/api/request-space-openings/open") {
      return null;
    }
    const method = metadata ? "GET" : "POST";
    if (request.method !== method) {
      return new Response(null, {
        status: 405,
        headers: { allow: method, "cache-control": "no-store" },
      });
    }
    try {
      if (metadata) {
        if (url.search) {
          throw new RequestSpaceError(
            "INVALID_COMMAND",
            "Query parameters are not accepted.",
          );
        }
        if (!context) {
          throw new RequestSpaceError(
            "UNAVAILABLE",
            "The host Request context is unavailable.",
          );
        }
        // Public identity metadata grants no rights and performs no service,
        // session, source/model resolution or mutation.
        return spaceJson(context);
      }
      requireLocalJsonCommand(request, servedOrigin);
      if (url.search) {
        throw new RequestSpaceError(
          "INVALID_COMMAND",
          "Query parameters are not accepted.",
        );
      }
      const secret = spaceSessionSecret(request);
      const command = openingCommand(
        await boundedSpaceCommand(request, 410_000),
      );
      return spaceJson(await service.open(command, secret));
    } catch (error) {
      return spaceHttpError(error);
    }
  };
}
