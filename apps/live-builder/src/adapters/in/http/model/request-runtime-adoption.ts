import { isSha256Hex } from "../../../../domain/primitives/execution-digest.ts";
import {
  RequestAdoptionError,
  type RequestRuntimeAdoptionPort,
} from "../../../../application/model/evolution/request-adoption-ports.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
  requestSpaceIdentity,
} from "../../../../domain/work/request-spaces.ts";
import {
  LocalHttpFailure,
  requireLocalJsonCommand,
} from "../../../../infrastructure/http/local-security.ts";
import {
  boundedSpaceCommand,
  spaceJson,
  spaceSessionSecret,
} from "../work/space-session.ts";

function adoptionFailure(error: unknown, action: string): Response {
  let code = "UNAVAILABLE", status = 503;
  if (error instanceof RequestAdoptionError) {
    code = error.code;
    status = code === "INVALID"
      ? 400
      : code === "FORBIDDEN"
      ? 403
      : code === "CONFLICT" || code === "BLOCKED"
      ? 409
      : 503;
  } else if (error instanceof RequestSpaceError) {
    code = error.code;
    status = code === "INVALID_COMMAND"
      ? 400
      : code === "FORBIDDEN" || code === "ADMISSION_REFUSED"
      ? 403
      : code === "OPENING_CONFLICT"
      ? 409
      : 503;
  } else if (
    error instanceof LocalHttpFailure &&
    ["HOST_REFUSED", "ORIGIN_REFUSED", "JSON_REQUIRED"].includes(error.code)
  ) {
    code = error.code;
    status = error.status;
  }
  const message = code === "INVALID" || code === "INVALID_COMMAND" ||
      code === "JSON_REQUIRED"
    ? "A valid exact Request adoption request is required."
    : code === "FORBIDDEN" || code === "ADMISSION_REFUSED"
    ? "Current control or execution permission is unavailable for this Request."
    : code === "HOST_REFUSED" || code === "ORIGIN_REFUSED"
    ? "Use the current local Assembly interface."
    : code === "CONFLICT" || code === "OPENING_CONFLICT"
    ? "The Request source or execution changed. Refresh the current selection."
    : code === "BLOCKED"
    ? "The Request is not ready for instruction adoption."
    : action === "eligibility"
    ? "Instruction adoption eligibility is unavailable. Check again from the current Request."
    : action === "status"
    ? "The Request adoption status could not be read. Inspect the original key again."
    : "The adoption outcome is unknown. Inspect the original adoption key before retrying.";
  return spaceJson({ code, error: message }, status);
}

const invalid = (): never => {
  throw new RequestSpaceError(
    "INVALID_COMMAND",
    "An exact Request adoption command is required.",
  );
};
function fields(input: unknown, expected: string): Record<string, unknown> {
  if (
    !input || typeof input !== "object" || Array.isArray(input) ||
    Object.keys(input).sort().join(",") !== expected
  ) return invalid();
  return input as Record<string, unknown>;
}

/** Local authenticated surface; authority, target and proof are server-resolved. */
export function createRequestRuntimeAdoptionHandler(
  service: RequestRuntimeAdoptionPort,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const routes = [
      "/api/request-runtime-adoption/eligibility",
      "/api/request-runtime-adoption/prepare",
      "/api/request-runtime-adoption/resume",
      "/api/request-runtime-adoption/status",
    ] as const;
    if (!routes.includes(url.pathname as typeof routes[number])) return null;
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }
    try {
      requireLocalJsonCommand(request, servedOrigin);
      if (url.search) return invalid();
      const secret = spaceSessionSecret(request);
      const input = await boundedSpaceCommand(request, 4096);
      if (url.pathname === routes[0]) {
        const body = fields(input, "caseId");
        if (!requestSpaceIdentity(body.caseId)) return invalid();
        const result = await service.eligibility(secret, body.caseId as string);
        if (result.caseId !== body.caseId) {
          throw new RequestSpaceError("UNAVAILABLE", "Request scope differs.");
        }
        return spaceJson(result);
      }
      const body = fields(
        input,
        url.pathname === routes[1]
          ? "adoptionKey,caseId,expectedAdmittedVersion,expectedExecutingDigest"
          : "adoptionKey,caseId",
      );
      if (
        !requestSpaceIdentity(body.caseId) ||
        !requestSpaceIdentity(body.adoptionKey)
      ) return invalid();
      const identity = {
        caseId: body.caseId as string,
        adoptionKey: body.adoptionKey as string,
      };
      const result = url.pathname === routes[1]
        ? await (() => {
          if (
            !exactSourceVersion(body.expectedAdmittedVersion) ||
            !isSha256Hex(body.expectedExecutingDigest)
          ) return invalid();
          return service.prepare(secret, {
            ...identity,
            expectedAdmittedVersion: body.expectedAdmittedVersion as string,
            expectedExecutingDigest: body.expectedExecutingDigest,
          });
        })()
        : url.pathname === routes[2]
        ? await service.resume(secret, identity)
        : await service.status(secret, identity);
      if (!result) {
        return spaceJson({
          code: "UNAVAILABLE",
          error: "The Request adoption is unavailable.",
        }, 404);
      }
      if (
        result.caseId !== identity.caseId ||
        result.adoptionKey !== identity.adoptionKey
      ) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "Request adoption identity differs.",
        );
      }
      return spaceJson(result);
    } catch (error) {
      return adoptionFailure(error, url.pathname.split("/").at(-1)!);
    }
  };
}
