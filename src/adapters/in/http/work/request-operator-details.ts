import { formatPatch, structuredPatch } from "diff";
import type {
  RequestOperatorDetailsReadPort,
  RequestOperatorSourceCommand,
} from "../../../../application/work/request-spaces/operator-details-view.ts";
import type { ArtifactSourceInspection } from "../../../../domain/work/records/artifact-source-inspection.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces.ts";
import { requireLocalJsonCommand } from "../../../../infrastructure/http/local-security.ts";
import {
  boundedSpaceCommand,
  spaceHttpError,
  spaceJson,
  spaceSessionSecret,
} from "./space-session.ts";
import { inspectedSourceText } from "./artifact-sources.ts";

export function compareRequestOperatorSources(
  sources: ArtifactSourceInspection["sources"],
): string {
  const before = inspectedSourceText(sources[0]),
    after = inspectedSourceText(sources[1]);
  if (before === after) return "";
  const patch = structuredPatch(
    "a/source",
    "b/source",
    before,
    after,
    undefined,
    undefined,
    { context: 3, timeout: 1000, maxEditLength: 20_000 },
  );
  if (!patch) {
    throw new RequestSpaceError(
      "UNAVAILABLE",
      "The retained source comparison exceeds its bounds.",
    );
  }
  patch.isGit = true;
  const result = formatPatch(patch);
  if (new TextEncoder().encode(result).byteLength > 2_097_152) {
    throw new RequestSpaceError(
      "UNAVAILABLE",
      "The retained source comparison exceeds its bounds.",
    );
  }
  return result;
}
export function createRequestOperatorDetailsHandler(
  service: RequestOperatorDetailsReadPort,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const match = url.pathname.match(
      /^\/api\/request-cases\/([^/]+)\/operators\/([^/]+)\/(details|sources\/read)$/,
    );
    if (!match) return null;
    const method = match[3] === "details" ? "GET" : "POST";
    if (request.method !== method) {
      return new Response(null, {
        status: 405,
        headers: { allow: method, "cache-control": "no-store" },
      });
    }
    try {
      const secret = spaceSessionSecret(request);
      if (url.search) {
        throw new RequestSpaceError(
          "INVALID_COMMAND",
          "Query parameters are not accepted.",
        );
      }
      const caseId = decodeURIComponent(match[1]),
        operatorId = decodeURIComponent(match[2]);
      if (method === "GET") {
        return spaceJson(await service.read(secret, caseId, operatorId));
      }
      requireLocalJsonCommand(request, servedOrigin);
      const body = await boundedSpaceCommand(request, 16_384);
      return spaceJson(
        await service.source(
          secret,
          caseId,
          operatorId,
          body as RequestOperatorSourceCommand,
        ),
      );
    } catch (error) {
      return spaceHttpError(error);
    }
  };
}
