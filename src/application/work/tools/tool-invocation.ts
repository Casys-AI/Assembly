/** Safe structured feedback for the next bounded conversational decision. */
export interface ToolFailure {
  code:
    | "URL_INVALID"
    | "URL_NOT_USER_SUPPLIED"
    | "NETWORK_SCOPE_DENIED"
    | "FETCH_FAILED"
    | "FETCH_TIMEOUT"
    | "TOOL_EXECUTION_FAILED"
    | "TOOL_UNAVAILABLE"
    | "REPEATED_FAILURE";
  message: string;
  retryable: boolean;
  toolId: string;
  url?: string;
  missingPermission?: { kind: "network-host"; host: string };
  allowedHosts?: string[];
}

/** A bounded diagnostic describing an invocation failure, never raw tool/provider output. */
export class ToolInvocationError extends Error {
  readonly failure: ToolFailure;

  constructor(failure: ToolFailure) {
    const message = boundedText(failure.message, 400);
    super(message);
    this.name = "ToolInvocationError";
    this.failure = {
      code: failure.code,
      message,
      retryable: failure.retryable,
      toolId: boundedText(failure.toolId, 128),
      ...(failure.url ? { url: safeUrl(failure.url) } : {}),
      ...(failure.missingPermission
        ? {
          missingPermission: {
            kind: "network-host",
            host: boundedText(failure.missingPermission.host, 253),
          },
        }
        : {}),
      ...(failure.allowedHosts
        ? {
          allowedHosts: failure.allowedHosts.slice(0, 32).map((host) =>
            boundedText(host, 253)
          ),
        }
        : {}),
    };
  }
}

function boundedText(value: string, limit: number): string {
  // deno-lint-ignore no-control-regex -- Invocation diagnostics intentionally exclude controls.
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .trim().slice(0, limit);
}

function safeUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (
      raw.length > 4096 || url.protocol !== "https:" || url.username ||
      url.password || (url.port && url.port !== "443")
    ) return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}
