import { deepStrictEqual, rejects } from "node:assert/strict";
import { caseModelFetch, readCaseModelScope } from "./case-model-scope.ts";
const version = `commit:${"a".repeat(40)}`;
Deno.test("Case client resolves the requested version and routes reads through the scoped facade", async () => {
  const requests: string[] = [];
  const fetcher = ((input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : input.url;
    requests.push(url);
    return Promise.resolve(
      Response.json({
        caseId: "case1",
        branchId: "branch1",
        executionSpaceId: "space1",
        branchVersion: version,
        executionVersion: version,
        version,
        release: null,
        readOnly: true,
      }),
    );
  }) as typeof fetch;
  deepStrictEqual(
    (await readCaseModelScope("case1", version, fetcher)).executionVersion,
    version,
  );
  const scoped = caseModelFetch("case1", fetcher);
  await scoped("/api/model/board?version=" + encodeURIComponent(version));
  deepStrictEqual(
    new URL(requests[1]).pathname,
    "/api/case-model/case1/api/model/board",
  );
  for (
    const path of [
      "/api/model/diagnostics",
      "/api/model/diagnostics/shapes",
      "/api/model/attention",
    ]
  ) {
    await scoped(`${path}?version=${encodeURIComponent(version)}`);
    const url = new URL(requests.at(-1)!);
    deepStrictEqual(url.pathname, `/api/case-model/case1${path}`);
    deepStrictEqual(url.searchParams.get("version"), version);
    await rejects(() => scoped(path, { method: "POST" }));
  }
  await rejects(() => scoped("/api/model-history"));
  await rejects(() => scoped("/api/model/board", { method: "POST" }));
});
