import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { toolDraftDigest } from "../../../../src/application/work/artifacts/catalog.ts";
import type { ArtifactSourceBindingReference } from "../../../../src/domain/work/artifacts/source-reference.ts";
import {
  comparableSource,
  readArtifactSources,
  sourceText,
} from "./artifact-sources.ts";

const draft = {
  name: "Tool",
  description: "Read",
  kind: "read_web_page" as const,
  code: "<script>source is data</script>\n",
};
async function fixture() {
  const binding: ArtifactSourceBindingReference = {
    version: 1,
    bindingId: "binding",
    versionId: "version",
    revision: 1,
    ownerId: "owner",
    localArtifactId: "tool",
    invocationId: "invocation",
    reference: {
      version: 2,
      scopeId: "scope",
      repositoryId: "repository",
      artifactId: "tool",
      kind: "tool-draft",
      commitOid: "a".repeat(40),
      entryPath: `artifacts/${"b".repeat(64)}/source.json`,
      manifestPath: `artifacts/${"b".repeat(64)}/manifest.json`,
      contentEncoding: "tool-draft-json-v1",
      contentDigest: await toolDraftDigest(draft),
      manifestFormat: "assembly-artifact-package-v2",
      manifestDigestVersion: "sha256-canonical-json-v1",
      manifestDigest: "b".repeat(64),
    },
  };
  return { binding, response: { sources: [{ binding, content: draft }] } };
}

Deno.test("source client sends captured complete binding only to its exact operator read route", async () => {
  const f = await fixture();
  let calls = 0;
  const request: typeof fetch = (input, options) => {
    calls++;
    equal(input, "/api/conversations/native%3Aowner/artifact-sources/read");
    equal(options?.method, "POST");
    equal(options?.cache, "no-store");
    deepStrictEqual(JSON.parse(String(options?.body)), {
      bindings: [f.binding],
    });
    return Promise.resolve(Response.json(f.response));
  };
  deepStrictEqual(
    await readArtifactSources("native:owner", [f.binding], undefined, request),
    f.response,
  );
  equal(calls, 1);
  equal(
    sourceText(f.response.sources[0]!),
    JSON.stringify(draft, null, 2) + "\n",
  );
});

Deno.test("source client refuses changed complete binding, bytes or missing comparison instead of drawing cached fields", async () => {
  const f = await fixture();
  for (
    const changed of [
      { sources: [{ binding: { ...f.binding, revision: 2 }, content: draft }] },
      {
        sources: [{
          binding: { ...f.binding, versionId: "another" },
          content: draft,
        }],
      },
      {
        sources: [{
          binding: {
            ...f.binding,
            reference: { ...f.binding.reference, commitOid: "c".repeat(40) },
          },
          content: draft,
        }],
      },
      {
        sources: [{
          binding: f.binding,
          content: { ...draft, code: "replacement" },
        }],
      },
      { sources: [] },
    ]
  ) {
    await rejects(
      readArtifactSources(
        "owner",
        [f.binding],
        undefined,
        () => Promise.resolve(Response.json(changed)),
      ),
      /unavailable/,
    );
  }
  await rejects(
    readArtifactSources(
      "owner",
      [f.binding, f.binding],
      undefined,
      () =>
        Promise.resolve(Response.json({
          sources: [f.response.sources[0], f.response.sources[0]],
        })),
    ),
    /unavailable/,
  );
  await rejects(
    readArtifactSources(
      "owner",
      [f.binding],
      undefined,
      () =>
        Promise.resolve(Response.json({ error: draft.code }, { status: 404 })),
    ),
    /unavailable/,
  );
});

Deno.test("comparison pins require same currently selected operator, source scope and kind", async () => {
  const { binding } = await fixture();
  const first = { agentId: "owner", label: "Old", binding };
  const next = {
    ...first,
    label: "Next",
    binding: { ...binding, bindingId: "another", revision: 2 },
  };
  equal(comparableSource(first, next), true);
  equal(comparableSource(first, first), false);
  equal(comparableSource(first, { ...next, agentId: "other" }), false);
  equal(
    comparableSource(first, {
      ...next,
      binding: { ...next.binding, ownerId: "other" },
    }),
    false,
  );
  equal(
    comparableSource(first, {
      ...next,
      binding: {
        ...next.binding,
        reference: { ...next.binding.reference, scopeId: "other" },
      },
    }),
    false,
  );
});
