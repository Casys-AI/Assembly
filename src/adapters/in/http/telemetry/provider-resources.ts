import {
  type CurrentProviderResources,
  ProviderResourceAccessError,
} from "../../../../application/telemetry/current-provider-resources.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces.ts";
import { spaceJson, spaceSessionSecret } from "../work/space-session.ts";

/** GET authorizes the current selection; a Request includes its historical pins. */
export function createProviderResourcesHandler(
  service: Pick<CurrentProviderResources, "read">,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/performance/provider-resources") return null;
    if (request.method !== "GET") {
      return new Response(null, {
        status: 405,
        headers: { allow: "GET", "cache-control": "no-store" },
      });
    }
    try {
      if (
        [...url.searchParams.keys()].some((key) =>
          !["caseId", "expectedVersion"].includes(key) ||
          url.searchParams.getAll(key).length !== 1
        )
      ) {
        throw new ProviderResourceAccessError(
          "PROVIDER_RESOURCE_INVALID_SELECTION",
        );
      }
      const secret = spaceSessionSecret(request);
      return spaceJson(
        await service.read(secret, {
          ...(url.searchParams.has("caseId")
            ? { caseId: url.searchParams.get("caseId")! }
            : {}),
          ...(url.searchParams.has("expectedVersion")
            ? { expectedVersion: url.searchParams.get("expectedVersion")! }
            : {}),
        }),
      );
    } catch (error) {
      const code = error instanceof ProviderResourceAccessError
        ? error.code
        : error instanceof RequestSpaceError && error.code === "FORBIDDEN"
        ? "PROVIDER_RESOURCE_FORBIDDEN"
        : "PROVIDER_RESOURCE_UNAVAILABLE";
      const status = code === "PROVIDER_RESOURCE_INVALID_SELECTION"
        ? 400
        : code === "PROVIDER_RESOURCE_FORBIDDEN"
        ? 403
        : code === "PROVIDER_RESOURCE_VERSION_MISMATCH"
        ? 409
        : 503;
      const safe = new ProviderResourceAccessError(code);
      return spaceJson({
        code,
        error: safe.message,
      }, status);
    }
  };
}
