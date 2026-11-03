import type { ModelDiagnosticsService } from "../../../../application/model/diagnostics/service.ts";
import {
  isDevelopmentOriginAllowed,
  type LocalHttpPolicy,
  requireDevelopmentHost,
} from "../../../../infrastructure/http/local-security.ts";

type DiagnosticsService = Pick<ModelDiagnosticsService, "list" | "setMask">;
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
const failure = (code: string, error: string, status: number) =>
  json({ code, error }, status);

async function readBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > 8192) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}

/** Designer controls on the atelier's existing loopback surface, like model
 * revision routes. This transport does not establish a human identity. */
export function createModelDiagnosticsHandler(
  service: DiagnosticsService,
  security?: LocalHttpPolicy,
) {
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const listing = url.pathname === "/api/model/diagnostics";
    const masking = url.pathname === "/api/model/diagnostics/masks";
    if (!listing && !masking) return null;
    const expectedMethod = listing ? "GET" : "POST";
    if (request.method !== expectedMethod) {
      return json(
        { code: "METHOD_NOT_ALLOWED", error: "Method not allowed." },
        405,
        { allow: expectedMethod },
      );
    }
    try {
      if (listing) {
        const version = url.searchParams.get("version");
        if (
          [...url.searchParams].length > 1 ||
          [...url.searchParams.keys()].some((key) => key !== "version") ||
          version !== null && !/^(branch|commit):[A-Za-z0-9_-]+$/.test(version)
        ) {
          return failure("INVALID_VERSION", "Invalid model version.", 400);
        }
        return json(await service.list(version ?? undefined));
      }
      if ([...url.searchParams].length) {
        return failure(
          "INVALID_REQUEST",
          "No query parameters are accepted.",
          400,
        );
      }
      const origin = request.headers.get("origin");
      if (security?.environment === "development") {
        try {
          requireDevelopmentHost(request);
        } catch {
          return failure("HOST_DENIED", "Local host required.", 403);
        }
        if (!isDevelopmentOriginAllowed(request)) {
          return failure("ORIGIN_DENIED", "Origin denied.", 403);
        }
      }
      if (
        security?.environment !== "development" &&
        (origin && origin !== url.origin ||
          request.headers.get("sec-fetch-site") === "cross-site")
      ) return failure("ORIGIN_DENIED", "Origin denied.", 403);
      if (
        request.headers.get("content-type")?.split(";", 1)[0].trim() !==
          "application/json"
      ) return failure("JSON_REQUIRED", "JSON required.", 415);
      const input = await readBody(request);
      const record = input as Record<string, unknown> | undefined;
      if (
        !record || typeof record !== "object" || Array.isArray(record) ||
        typeof record.code !== "string" ||
        !/^[A-Z][A-Z0-9_]{0,119}$/.test(record.code) ||
        typeof record.masked !== "boolean" ||
        record.elementId != null &&
          (typeof record.elementId !== "string" || !record.elementId.trim() ||
            record.elementId.length > 2048) ||
        Object.keys(record).some((key) =>
          !["code", "elementId", "masked"].includes(key)
        )
      ) {
        return failure(
          "INVALID_MASK",
          "Invalid diagnostic mask preference.",
          400,
        );
      }
      const mask = await service.setMask({
        code: record.code,
        ...(record.elementId == null
          ? {}
          : { elementId: record.elementId as string }),
        masked: record.masked,
      });
      return json({ mask });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "MODEL_DIAGNOSTICS_FAILED";
      const status = ["NOT_FOUND", "DIAGNOSTIC_NOT_FOUND"].includes(code)
        ? 404
        : ["DIAGNOSTIC_NOT_MASKABLE", "INVALID_REQUEST"].includes(code)
        ? 400
        : code === "UPSTREAM_FAILURE"
        ? 502
        : 500;
      const messages: Record<string, string> = {
        NOT_FOUND: "Model version not found.",
        DIAGNOSTIC_NOT_FOUND: "No current diagnostic matches this mask.",
        DIAGNOSTIC_NOT_MASKABLE: "Error diagnostics cannot be masked.",
        INVALID_REQUEST: "Invalid model diagnostics request.",
        UPSTREAM_FAILURE:
          "Failed to load model diagnostics from the model source.",
      };
      return failure(
        code,
        messages[code] ?? "Failed to read model diagnostics.",
        status,
      );
    }
  };
}
