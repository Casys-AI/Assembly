import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  rejects,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { createModelTag, CreateTag } from "./CreateTag.tsx";

const oid = "a".repeat(40);
const source = {
  branch: { kind: "main" as const },
  sourceVersion: `commit:${oid}`,
};
const evidence = {
  ...source,
  repositoryId: "repo",
  branchRef: "refs/heads/main",
  admittedHeadVersion: source.sourceVersion,
  sourceDigest: "b".repeat(64),
};
const tag = { name: "v1", refOid: oid, commitOid: oid };

Deno.test("Create tag sends the exact source and rejects a different returned binding", async () => {
  let body: unknown;
  const request: typeof fetch = (_input, init) => {
    body = JSON.parse(String(init?.body));
    return Promise.resolve(Response.json({ source: evidence, tag }));
  };
  deepStrictEqual(await createModelTag(source, "v1", request), tag);
  deepStrictEqual(body, { source, name: "v1" });
  await rejects(() =>
    createModelTag(
      source,
      "v1",
      () =>
        Promise.resolve(
          Response.json({ source: evidence, tag: { ...tag, name: "other" } }),
        ),
    )
  );
  await rejects(() =>
    createModelTag(
      source,
      "v1",
      () =>
        Promise.resolve(
          Response.json({
            source: { ...evidence, sourceVersion: `commit:${"c".repeat(40)}` },
            tag,
          }),
        ),
    )
  );
});

Deno.test("historical Request source cannot offer an active tag action", () => {
  const html = renderToString(
    <CreateTag
      source={{
        branch: { kind: "case", caseId: "r1" },
        sourceVersion: source.sourceVersion,
      }}
      eligible={false}
    />,
  );
  match(html, /Only the current admitted Request version can be tagged/);
  doesNotMatch(html, /<button/);
  equal(
    renderToString(<CreateTag source={source} />).includes("Create tag"),
    true,
  );
});

Deno.test("Create tag is a chip action, not a panel", () => {
  const html = renderToString(<CreateTag source={source} />);
  match(
    html,
    /^<div class="create-tag" aria-label="Create tag"><button type="button" class="chip is-action"\s*>Create tag<\/button><\/div>$/,
  );
  doesNotMatch(html, /proposal-adjustment|panel/);
});
