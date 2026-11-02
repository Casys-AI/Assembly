import { signal } from "@preact/signals";
const sourceMetadataRevisions = signal<Record<string, number>>({});
/** Changes only metadata of this Case; exact inspection and execution stay put. */
export function caseSourceMetadataRevision(caseId: string): number {
  return sourceMetadataRevisions.value[caseId] ?? 0;
}
export function refreshCaseSourceMetadata(caseId: string): void {
  const previous = sourceMetadataRevisions.peek();
  sourceMetadataRevisions.value = {
    ...previous,
    [caseId]: (previous[caseId] ?? 0) + 1,
  };
}
/** A Request scope is resolved by the host; Case IDs never become Git refs. */
export interface CaseModelScope {
  caseId: string;
  branchId: string;
  executionSpaceId: string;
  branchVersion: string;
  executionVersion: string;
  /** Immutable birth source, independent from current source and execution. */
  baseVersion?: string;
  version: string;
  release: { id: string; digest: string } | null;
  readOnly: true;
}
const exactVersion = (value: unknown): value is string =>
  typeof value === "string" && /^commit:[a-f0-9]{40}$/.test(value);

export async function readCaseModelScope(
  caseId: string,
  version?: string,
  request: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<CaseModelScope> {
  const query = version ? `?${new URLSearchParams({ version })}` : "";
  const response = await request(
    `/api/case-model/${encodeURIComponent(caseId)}${query}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error("Request model or requested version is unavailable.");
  }
  const value = await response.json() as CaseModelScope;
  if (
    value.caseId !== caseId || !value.branchId || !value.executionSpaceId ||
    value.readOnly !== true ||
    !exactVersion(value.version) || !exactVersion(value.branchVersion) ||
    !exactVersion(value.executionVersion) ||
    (value.baseVersion !== undefined && !exactVersion(value.baseVersion)) ||
    (version !== undefined && value.version !== version)
  ) throw new Error("Invalid Request model scope.");
  return value;
}

/** Adapter for existing immutable readers: every read goes back through the
 * Case facade; unknown paths and writes are rejected before reaching the host. */
export function caseModelFetch(
  caseId: string,
  request: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  const allowed = new Set([
    "/api/model/board",
    "/api/model/diagnostics",
    "/api/model/diagnostics/shapes",
    "/api/model/attention",
    "/api/model/authority-matrix",
    "/api/model/views",
    "/api/model/views/diagram",
    "/api/model/views/plantuml",
    "/api/model/sources/tokens",
    "/api/model-files",
    "/api/model-sources",
  ]);
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const original = input instanceof Request ? input : new Request(
      new URL(
        String(input),
        globalThis.location?.origin ?? "http://localhost",
      ),
      init,
    );
    const url = new URL(original.url);
    if (original.method !== "GET" || !allowed.has(url.pathname)) {
      return Promise.reject(
        new Error("Request model operation is unavailable."),
      );
    }
    url.pathname = `/api/case-model/${
      encodeURIComponent(caseId)
    }${url.pathname}`;
    return request(new Request(url, original));
  }) as typeof fetch;
}
