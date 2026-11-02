import { deepStrictEqual, equal } from "node:assert/strict";
import { createModelTagsHandler } from "./model-tags.ts";
import { SavedSystemError } from "../../../../domain/work/saved-systems.ts";

const origin = "http://127.0.0.1:4311";
const source = {
  branch: { kind: "main" as const },
  sourceVersion: `commit:${"a".repeat(40)}`,
};
function request(body: unknown, cookie = true, from = origin, query = "") {
  return new Request(`${origin}/api/model-tags/create${query}`, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin: from,
      "content-type": "application/json",
      ...(cookie ? { cookie: `assembly-space-session=${"a".repeat(64)}` } : {}),
    },
    body: JSON.stringify(body),
  });
}
Deno.test("standalone model tag HTTP accepts only exact source/name with current session and no Release command", async () => {
  const calls: unknown[] = [];
  const expected = {
    source: {
      ...source,
      repositoryId: "repo",
      branchRef: "refs/heads/admitted",
      admittedHeadVersion: source.sourceVersion,
      sourceDigest: "b".repeat(64),
    },
    tag: { name: "v1", refOid: "a".repeat(40), commitOid: "a".repeat(40) },
  };
  const handler = createModelTagsHandler({
    createTag(secret, command) {
      calls.push({ secret, command });
      return Promise.resolve(expected);
    },
  }, origin);
  const response = await handler(request({ source, name: "v1" }));
  equal(response!.status, 200);
  equal(response!.headers.get("cache-control"), "no-store");
  deepStrictEqual(await response!.json(), expected);
  deepStrictEqual(calls, [{
    secret: "a".repeat(64),
    command: { source, name: "v1" },
  }]);
  for (
    const body of [
      { source, name: "v1", saveKey: "not-a-release" },
      { source, name: "v1", actorId: "owner" },
      { source: { ...source, repositoryId: "foreign" }, name: "v1" },
      { source, name: "bad..name" },
      { source },
    ]
  ) equal((await handler(request(body)))!.status, 400);
  equal((await handler(request({ source, name: "v1" }, false)))!.status, 403);
  equal(
    (await handler(
      request({ source, name: "v1" }, true, "http://foreign.test"),
    ))!.status,
    403,
  );
  equal(
    (await handler(
      request({ source, name: "v1" }, true, origin, "?scope=foreign"),
    ))!.status,
    400,
  );
  equal(calls.length, 1);
});
Deno.test("standalone model tag HTTP reports bounded conflict/current-authority errors and hides technical failures", async () => {
  for (
    const [code, status] of [["TAG_UNAVAILABLE", 409], ["SOURCE_STALE", 409], [
      "FORBIDDEN",
      403,
    ]] as const
  ) {
    const handler = createModelTagsHandler({
      createTag() {
        throw new SavedSystemError(code, "Tag unavailable.");
      },
    }, origin);
    const response = await handler(request({ source, name: "v1" }));
    equal(response!.status, status);
    equal((await response!.json()).code, code);
  }
  const handler = createModelTagsHandler({
    createTag() {
      throw new Error("/private/secret/path");
    },
  }, origin);
  const response = await handler(request({ source, name: "v1" }));
  equal(response!.status, 503);
  equal((await response!.text()).includes("private"), false);
});
