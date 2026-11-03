import {
  type ModelShapesDiagnosticsResult,
  ModelShapesError,
} from "../../../../application/model/diagnostics/shapes.ts";
import { SemanticIndexError } from "../../../../application/model/semantic/index-service.ts";

import { canonicalDigest } from "../../../../domain/primitives/execution-digest.ts";
import { parseModelRevisionId } from "../../../../domain/shared-kernel/revision-id.ts";
import {
  versionedError,
  versionedFailure,
  versionedJson,
} from "../versioning/responses.ts";

/** A read-only transport over the existing semantic validator. It never selects
 * Main, initializes a Request, or substitutes a report for another commit. */
export function createModelShapesHandler(service: {
  validate(version: string): Promise<ModelShapesDiagnosticsResult>;
}) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/model/diagnostics/shapes") return null;
    if (request.method !== "GET") {
      return versionedError(
        "METHOD_NOT_ALLOWED",
        { method: request.method },
        "Read the SHACL report with GET.",
        405,
        { allow: "GET" },
      );
    }
    const names = [...url.searchParams.keys()];
    if (names.length !== 1 || names[0] !== "version") {
      return versionedError(
        "INVALID_REQUEST",
        { parameters: names },
        "Pass exactly one query parameter: version.",
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
    try {
      const result = await service.validate(version);
      if (result.version !== version) {
        throw new ModelShapesError(
          "SHACL_VALIDATION_FAILED",
          { reason: "response-version-mismatch" },
          "The SHACL report does not identify the requested model version.",
        );
      }
      const body: ModelShapesDiagnosticsResult = {
        version,
        report: result.report,
      };
      return versionedJson(request, body, {
        version,
        digest: await canonicalDigest(body),
        // A shapes/engine upgrade changes this report's identity independently
        // of the viewed source commit. Conditional reads must revalidate it.
        immutable: false,
      });
    } catch (error) {
      // Preserve existing public engine/index codes and their fixed recovery,
      // never raw exception messages, filesystem paths or private context.
      const known = error instanceof ModelShapesError ||
        error instanceof SemanticIndexError;
      return versionedFailure({
        code: known ? error.code : "SHACL_VALIDATION_FAILED",
        message:
          "The SHACL report for this exact model version is unavailable.",
        ...(known ? { recovery: error.recovery } : {}),
      }, { code: "SHACL_VALIDATION_FAILED", name: "SHACL report", version });
    }
  };
}
