/** Answers the next reads with this failure instead, as the host would. */
export interface HostFailure {
  status: number;
  code: string;
  context?: Record<string, unknown>;
  retryAfter?: number;
}

export interface VersionedHostOptions<Body> {
  /** The route: `/api/model/board`. */
  path: string;
  /** What the host tells to do about a failure. */
  recovery: string;
  /** The commit the head is at. */
  head: string;
  /** The bodies by commit. */
  bodies: Readonly<Record<string, Body>>;
  fail?: HostFailure;
  /** Holds each read until released: for reads that overlap. */
  gate?: (n: number) => Promise<void> | undefined;
}

/**
 * A versioned route of the host (`/api/model/board`, `/api/model/authority-matrix`):
 * a `fetch` that answers as it does, and what it was asked. The head says which
 * commit it read in `x-model-version`; a version is checked for its form and
 * for being a commit the host has.
 */
export function versionedHost<Body>(options: VersionedHostOptions<Body>) {
  const requests: { path: string; cache: RequestCache | undefined }[] = [];
  const state = { head: options.head, fail: options.fail };
  const bodies: Record<string, Body> = { ...options.bodies };
  const fetcher = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = String(input);
    requests.push({ path, cache: init?.cache });
    await options.gate?.(requests.length);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const url = new URL(path, "http://atelier.test");
    if (url.pathname !== options.path) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (state.fail) {
      const { status, code, context, retryAfter } = state.fail;
      return Response.json({
        code,
        context: context ?? {},
        recovery: options.recovery,
      }, {
        status,
        headers: retryAfter ? { "retry-after": String(retryAfter) } : {},
      });
    }
    const version = url.searchParams.get("version");
    if (version === null) {
      return Response.json(bodies[state.head], {
        headers: { "x-model-version": state.head },
      });
    }
    if (!/^commit:[0-9a-f]{40}$/.test(version)) {
      return Response.json({
        code: "INVALID_VERSION",
        context: { version },
        recovery: "Pass ?version=commit:<40 lowercase hex digits>.",
      }, { status: 400 });
    }
    return bodies[version] ? Response.json(bodies[version]) : Response.json({
      code: "NOT_FOUND",
      context: { version },
      recovery: "Choose an existing commit from /api/model-history.",
    }, { status: 404 });
  };
  return { fetch: fetcher as typeof fetch, requests, state, bodies };
}
