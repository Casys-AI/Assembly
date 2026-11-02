import type { SpaceControls } from "../../../../application/work/request-spaces/control.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces.ts";
import {
  LocalHttpFailure,
  localServedOrigin,
  requireLocalJsonCommand,
} from "../../../../infrastructure/http/local-security.ts";

export const SPACE_SESSION_COOKIE = "assembly-space-session";
export function spaceSessionSecret(request: Request): string {
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((
    cookie,
  ) => cookie.trim());
  const matches = cookies.filter((cookie) =>
    cookie.startsWith(`${SPACE_SESSION_COOKIE}=`)
  );
  if (matches.length !== 1) {
    throw new RequestSpaceError(
      "FORBIDDEN",
      "A current local control session is required.",
    );
  }
  const value = matches[0].slice(SPACE_SESSION_COOKIE.length + 1);
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new RequestSpaceError(
      "FORBIDDEN",
      "A current local control session is required.",
    );
  }
  return value;
}
export function spaceJson(
  value: unknown,
  status = 200,
  initial?: HeadersInit,
): Response {
  const headers = new Headers(initial);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(value, { status, headers });
}
export async function boundedSpaceCommand(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) {
    throw new RequestSpaceError(
      "INVALID_COMMAND",
      "A bounded JSON command is required.",
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new RequestSpaceError(
          "INVALID_COMMAND",
          "The command exceeds its bounds.",
        );
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RequestSpaceError(
      "INVALID_COMMAND",
      "A JSON command is required.",
    );
  }
}
export function spaceHttpError(error: unknown): Response {
  if (error instanceof LocalHttpFailure) {
    return spaceJson({ code: error.code, error: error.message }, error.status);
  }
  if (error instanceof RequestSpaceError) {
    return spaceJson(
      { code: error.code, error: error.message },
      error.code === "INVALID_COMMAND"
        ? 400
        : error.code === "FORBIDDEN" || error.code === "ADMISSION_REFUSED"
        ? 403
        : error.code === "OPENING_CONFLICT"
        ? 409
        : 503,
    );
  }
  return spaceJson({
    code: "UNAVAILABLE",
    error: "The local space command is unavailable.",
  }, 503);
}
/** Host composition resolves the modeled owner; the browser supplies no
 * principal, capability or authority data on this development-only path. */
export function createDevelopmentSessionIssuer(
  control: Pick<SpaceControls, "issueCapability" | "exchange">,
  currentOwnerId: () => Promise<string>,
): () => Promise<{ secret: string; expiresAt: string }> {
  return async () => {
    const ownerId = await currentOwnerId();
    const capability = await control.issueCapability(ownerId);
    return await control.exchange(capability.secret);
  };
}
/** Production exchanges owned-channel capabilities. Development may also use
 * the host-composed issuer; the session secret only enters the HttpOnly cookie. */
export function createSpaceSessionHandler(
  control: Pick<SpaceControls, "exchange">,
  servedOrigin:
    import("../../../../infrastructure/http/local-security.ts").LocalHttpOrigin,
  issueLocal?: () => Promise<{ secret: string; expiresAt: string }>,
) {
  // Per-handler bounded local attempt gate; no secret or identity is retained.
  let windowStarted = 0, attempts = 0;
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    const local = url.pathname === "/api/space-session/local";
    if (url.pathname !== "/api/space-session/exchange" && !local) return null;
    if (
      local &&
      (!issueLocal || typeof servedOrigin === "string" ||
        servedOrigin.environment !== "development")
    ) return null;
    if (request.method !== "POST") {
      return new Response(null, {
        status: 405,
        headers: { allow: "POST", "cache-control": "no-store" },
      });
    }
    try {
      requireLocalJsonCommand(request, servedOrigin);
      if (url.search) {
        throw new RequestSpaceError(
          "INVALID_COMMAND",
          "Query parameters are not accepted.",
        );
      }
      if (!local) {
        const now = Date.now();
        if (now - windowStarted >= 60_000) {
          windowStarted = now;
          attempts = 0;
        }
        if (++attempts > 12) {
          return spaceJson(
            { code: "FORBIDDEN", error: "Retry local session exchange later." },
            429,
            { "retry-after": "60" },
          );
        }
      }
      const command = await boundedSpaceCommand(request, 256);
      if (
        !command || typeof command !== "object" || Array.isArray(command) ||
        (local
          ? Object.keys(command).length !== 0
          : Object.keys(command).join() !== "capabilitySecret" ||
            typeof (command as { capabilitySecret?: unknown })
                .capabilitySecret !== "string")
      ) {
        throw new RequestSpaceError(
          "INVALID_COMMAND",
          "The local capability exchange requires one secret.",
        );
      }
      const result = local ? await issueLocal!() : await control.exchange(
        (command as { capabilitySecret: string }).capabilitySecret,
      );
      const secure =
        new URL(localServedOrigin(servedOrigin)).protocol === "https:"
          ? "; Secure"
          : "";
      return spaceJson({ expiresAt: result.expiresAt }, 200, {
        "set-cookie":
          `${SPACE_SESSION_COOKIE}=${result.secret}; Path=/; HttpOnly; SameSite=Strict; Expires=${
            new Date(result.expiresAt).toUTCString()
          }${secure}`,
      });
    } catch (error) {
      return spaceHttpError(error);
    }
  };
}
