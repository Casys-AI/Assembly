/** Shared response shape for /api/model/* routes.
 *
 * An explicit version pins an immutable projection: the body carries an ETag
 * over its digest with a long immutable cache lifetime, and If-None-Match
 * short-circuits to 304. The moving head (no version) and every failure stay
 * on no-store. Failures always use {code, context, recovery}. */

export interface VersionedErrorBody {
  code: string;
  context: Record<string, unknown>;
  recovery: string;
}

const DIGEST_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

function etagMatches(header: string, etag: string): boolean {
  return header.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag === etag || tag === `W/${etag}`;
  });
}

export function versionedJson(
  request: Request,
  body: unknown,
  options: { version?: string; digest: unknown; immutable?: boolean },
): Response {
  return versionedResponse(request, body, options, false);
}

/** Plain-text exports share the immutable and conditional-read semantics. */
export function versionedText(
  request: Request,
  body: string,
  options: { version?: string; digest: unknown; immutable?: boolean },
): Response {
  return versionedResponse(request, body, options, true);
}

function versionedResponse(
  request: Request,
  body: unknown,
  options: { version?: string; digest: unknown; immutable?: boolean },
  plainText: boolean,
): Response {
  const respond = (headers: HeadersInit) =>
    plainText
      ? new Response(body as string, { headers })
      : Response.json(body, { headers });
  const base = {
    "x-content-type-options": "nosniff",
    ...(plainText ? { "content-type": "text/plain; charset=utf-8" } : {}),
  };
  if (
    options.version === undefined || typeof options.digest !== "string" ||
    !DIGEST_PATTERN.test(options.digest)
  ) {
    return respond({ ...base, "cache-control": "no-store" });
  }
  const etag = `"${options.digest}"`;
  const headers = {
    ...base,
    "cache-control": options.immutable === false
      ? "no-cache"
      : "public, max-age=31536000, immutable",
    etag,
  };
  const sent = request.headers.get("if-none-match");
  if (sent !== null && etagMatches(sent, etag)) {
    return new Response(null, { status: 304, headers });
  }
  return respond(headers);
}

export function versionedError(
  code: string,
  context: Record<string, unknown>,
  recovery: string,
  status: number,
  headers?: HeadersInit,
): Response {
  const body: VersionedErrorBody = { code, context, recovery };
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-content-type-options", "nosniff");
  return Response.json(body, { status, headers: responseHeaders });
}

/** Legacy payloads retain their envelope and status while sharing HTTP headers. */
export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** B3 failure semantics, owned here for every versioned projection route. */
export function versionedFailure(
  error: unknown,
  options: { code: string; name: string; version?: string },
): Response {
  const { version } = options;
  const record = (
    error && typeof error === "object" ? error : {}
  ) as {
    code?: unknown;
    context?: unknown;
    recovery?: unknown;
    message?: unknown;
  };
  const code = typeof record.code === "string" && CODE_PATTERN.test(record.code)
    ? record.code
    : options.code;
  const providedContext =
    record.context && typeof record.context === "object" &&
      !Array.isArray(record.context)
      ? record.context as Record<string, unknown>
      : {};
  const context = {
    ...(version ? { version } : { selection: "head" }),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...providedContext,
  };
  const recovery = typeof record.recovery === "string" && record.recovery
    ? record.recovery
    : readFailureRecovery(code, options.name);
  // A rejected stored artifact is a server fault, not an invalid request.
  const status = code === options.code || code === "INVALID_REPOSITORY" ||
      code.startsWith("INVALID_PROJECTION_")
    ? 500
    : code.endsWith("NOT_FOUND")
    ? 404
    : code.endsWith("TIMEOUT") || code.endsWith("UNAVAILABLE") ||
        code.endsWith("UPSTREAM_FAILURE")
    ? 502
    : code.startsWith("INVALID_")
    ? 400
    : 500;
  const retryAfterMs = providedContext.retryAfterMs;
  return versionedError(
    code,
    context,
    recovery,
    status,
    (code === "TOOLKIT_TIMEOUT" || code === "PROJECTION_QUEUE_UNAVAILABLE") &&
      typeof retryAfterMs === "number" &&
      Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? { "retry-after": String(Math.ceil(retryAfterMs / 1_000)) }
      : undefined,
  );
}

function readFailureRecovery(code: string, name: string): string {
  if (code.endsWith("NOT_FOUND")) {
    return "Choose an existing commit from /api/model-history.";
  }
  switch (code) {
    case "INVALID_REPOSITORY":
      return "Inspect the model repository and restore a valid snapshot before reading this version.";
    case "TOOLKIT_TIMEOUT":
      return `The ${name} exceeded the Toolkit budget. Wait for context.retryAfterMs before retrying; do not retry in a loop.`;
    case "INVALID_REQUEST":
      return "Pass an immutable model commit as version.";
    case "MODEL_VERSION_MISMATCH":
      return "Correct the projection reader to return the requested model version before requesting it again.";
  }
  if (code.endsWith("UNAVAILABLE")) {
    return "Restore the model read service before requesting this version again.";
  }
  if (code.endsWith("UPSTREAM_FAILURE")) {
    return "Restore the upstream model source before requesting this version again.";
  }
  if (code.endsWith("TOOLKIT_FAILED")) {
    return "Correct the reported model or Toolkit problem; use a corrected commit if sources change.";
  }
  return `Inspect context.message and correct the ${name} read failure before requesting it again.`;
}
