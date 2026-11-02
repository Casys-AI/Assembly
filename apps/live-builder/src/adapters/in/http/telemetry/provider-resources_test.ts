import { deepStrictEqual, equal } from "node:assert/strict";
import { createProviderResourcesHandler } from "./provider-resources.ts";
import {
  type CurrentProviderResourceReadout,
  ProviderResourceAccessError,
} from "../../../../application/telemetry/current-provider-resources.ts";
import { ProviderResourceAggregation } from "../../../../application/telemetry/provider-resource-readout.ts";
import { SPACE_SESSION_COOKIE } from "../work/space-session.ts";

const secret = "a".repeat(64);
const version = `commit:${"b".repeat(40)}`;
const resources = new ProviderResourceAggregation({
  projectId: "host-project",
  systemId: "host-system",
  executionSpaceId: "main",
  repositoryVersion: version,
  modelDigest: "c".repeat(64),
  endedThrough: "2026-10-30T00:00:00.000Z",
}).finish("2026-10-30T00:00:01.000Z");
const answer: CurrentProviderResourceReadout = {
  schemaVersion: 1,
  execution: {
    kind: "main",
    operatorId: "operator",
    runtimeRevision: 7,
    modelVersion: { digest: "c".repeat(64), repositoryVersion: version },
  },
  resources,
};
const request = (
  search = "",
  method = "GET",
  cookie = `${SPACE_SESSION_COOKIE}=${secret}`,
) =>
  new Request(
    `http://127.0.0.1:4311/api/performance/provider-resources${search}`,
    { method, headers: { cookie } },
  );

Deno.test("resource HTTP accepts only exact current selectors with no-store safe transport", async () => {
  const calls: unknown[] = [];
  const handler = createProviderResourcesHandler({
    read(session, selection) {
      calls.push({ session, selection });
      return Promise.resolve(answer);
    },
  });
  const response =
    (await handler(request(`?caseId=caseA&expectedVersion=${version}`)))!;
  equal(response.status, 200);
  equal(response.headers.get("cache-control"), "no-store");
  equal(response.headers.get("x-content-type-options"), "nosniff");
  deepStrictEqual(await response.json(), answer);
  deepStrictEqual(calls, [{
    session: secret,
    selection: { caseId: "caseA", expectedVersion: version },
  }]);
  equal(await handler(new Request("http://127.0.0.1:4311/api/state")), null);
});

Deno.test("resource HTTP rejects forged scopes, cutoffs, duplicated selectors, missing session and writes before reading", async () => {
  let calls = 0;
  const handler = createProviderResourcesHandler({
    read() {
      calls++;
      return Promise.resolve(answer);
    },
  });
  for (
    const search of [
      "?projectId=foreign",
      "?systemId=foreign",
      "?executionSpaceId=main",
      "?modelDigest=fake",
      "?endedThrough=today",
      "?version=HEAD",
      "?branch=foreign",
      "?caseId=A&caseId=B",
      "?expectedVersion=A&expectedVersion=B",
    ]
  ) {
    equal((await handler(request(search)))!.status, 400);
  }
  equal((await handler(request("", "GET", "")))!.status, 403);
  equal(
    (await handler(
      request(
        "",
        "GET",
        `${SPACE_SESSION_COOKIE}=${secret}; ${SPACE_SESSION_COOKIE}=${secret}`,
      ),
    ))!.status,
    403,
  );
  const post = (await handler(request("", "POST")))!;
  equal(post.status, 405);
  equal(post.headers.get("allow"), "GET");
  equal(calls, 0);
});

Deno.test("resource HTTP retains explicit unavailable/mismatch/forbidden errors without private exceptions", async () => {
  for (
    const [code, status] of [
      ["PROVIDER_RESOURCE_VERSION_MISMATCH", 409],
      ["PROVIDER_RESOURCE_FORBIDDEN", 403],
      ["PROVIDER_RESOURCE_UNAVAILABLE", 503],
    ] as const
  ) {
    const handler = createProviderResourcesHandler({
      read() {
        return Promise.reject(new ProviderResourceAccessError(code));
      },
    });
    const response = (await handler(request()))!;
    equal(response.status, status);
    equal((await response.json()).code, code);
  }
  const handler = createProviderResourcesHandler({
    read() {
      return Promise.reject(new Error("private SQL secret"));
    },
  });
  const response = (await handler(request()))!;
  equal(response.status, 503);
  equal((await response.text()).includes("private"), false);
});
