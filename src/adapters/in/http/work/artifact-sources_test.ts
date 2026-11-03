import { deepStrictEqual, equal, match } from "node:assert/strict";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";
import { toolDraftDigest } from "../../../../application/work/artifacts/catalog.ts";
import { skillContentDigest } from "../../../../domain/skills/context-skills.ts";
import {
  type ArtifactSourceBindingReference,
  ArtifactSourceError,
} from "../../../../domain/work/artifacts/source-reference.ts";
import type { AgentConversation } from "../../../../domain/work/records/conversations.ts";
import type { ToolDraft } from "../../../../domain/work/candidates.ts";
import { createArtifactSourcesHandler } from "./artifact-sources.ts";

const draft: ToolDraft = {
  name: "Tool",
  description: "Read",
  kind: "read_web_page",
  code: "export default () => 'old';\n",
};
async function binding(
  content: ToolDraft | string,
  revision = 1,
): Promise<ArtifactSourceBindingReference> {
  const manifest = String(revision).repeat(64);
  const kind = typeof content === "string" ? "skill-document" : "tool-draft";
  return {
    version: 1,
    bindingId: `binding-${revision}`,
    versionId: `version-${revision}`,
    revision,
    ownerId: "native:owner",
    localArtifactId: "local-artifact",
    invocationId: `invocation-${revision}`,
    reference: {
      version: 2,
      scopeId: "space",
      repositoryId: "repo",
      artifactId: "artifact",
      kind,
      commitOid: String(revision).repeat(40),
      entryPath: `artifacts/${manifest}/${
        kind === "tool-draft" ? "source.json" : "SKILL.md"
      }`,
      manifestPath: `artifacts/${manifest}/manifest.json`,
      contentEncoding: kind === "tool-draft" ? "tool-draft-json-v1" : "utf8-v1",
      contentDigest: typeof content === "string"
        ? await skillContentDigest(content)
        : await toolDraftDigest(content),
      manifestFormat: "assembly-artifact-package-v2",
      manifestDigestVersion: "sha256-canonical-json-v1",
      manifestDigest: manifest,
    },
  };
}
async function fixture(contents: Array<ToolDraft | string> = [draft]) {
  let visible = true, reads = 0, contexts = 0;
  const bindings = await Promise.all(
    contents.map((content, index) => binding(content, index + 1)),
  );
  const conversation: AgentConversation = {
    agentId: "session-owner",
    nativeId: "native:owner",
    name: "Owner",
    responsibility: "",
    primary: true,
    canSend: false,
    revision: 4,
    busy: false,
    phase: "Ready",
    messages: [],
    modelDigest: "model",
  };
  const resolve = (
    selection: { expectedBinding: ArtifactSourceBindingReference },
  ) => {
    reads++;
    const index = bindings.findIndex((known) =>
      canonical(known) === canonical(selection.expectedBinding)
    );
    if (index < 0) throw new ArtifactSourceError("integrity");
    return structuredClone(contents[index]!);
  };
  const handler = createArtifactSourcesHandler({
    conversations: () => ({
      systemId: "system",
      defaultAgentId: "session-owner",
      version: "v1",
      conversations: visible ? [conversation] : [],
    }),
    sourceContext: (current) => {
      contexts++;
      equal(current.nativeId, "native:owner");
      return Promise.resolve({
        ownerId: current.nativeId,
        sources: {
          resolveTool: async (selection) =>
            await resolve(selection) as ToolDraft,
          resolveSkill: async (selection) => await resolve(selection) as string,
        },
      });
    },
  }, "http://127.0.0.1:4311");
  const read = (body: unknown = { bindings }, agentId = "session-owner") =>
    handler(
      new Request(
        `http://127.0.0.1:4311/api/conversations/${
          encodeURIComponent(agentId)
        }/artifact-sources/read`,
        {
          method: "POST",
          headers: {
            host: "127.0.0.1:4311",
            origin: "http://127.0.0.1:4311",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
      ),
    );
  return {
    bindings,
    read,
    handler,
    counts: () => ({ reads, contexts }),
    revoke: () => {
      visible = false;
    },
  };
}

Deno.test("exact historical source read preserves the entire binding and exposes no command path", async () => {
  const f = await fixture();
  const response = await f.read();
  equal(response?.status, 200);
  equal(response?.headers.get("cache-control"), "no-store");
  deepStrictEqual(await response!.json(), {
    sources: [{ binding: f.bindings[0], content: draft }],
  });
  deepStrictEqual(f.counts(), { reads: 1, contexts: 2 });
});

Deno.test("two exact tool and skill versions compare without admission, activation or load callbacks", async () => {
  for (
    const contents of [[draft, {
      ...draft,
      code: "export default () => 'new';\n",
    }], ["# Old skill\n", "# New skill\n"]]
  ) {
    const f = await fixture(contents);
    const response = await f.read();
    equal(response?.status, 200);
    const result = await response!.json();
    deepStrictEqual(
      result.sources.map((source: { binding: unknown }) => source.binding),
      f.bindings,
    );
    match(result.patch, /[-].*old|[-]# Old/i);
    match(result.patch, /[+].*new|[+]# New/i);
    equal(f.counts().reads, 2);
  }
});

Deno.test("foreign owners, arbitrary selectors and unknown conversations share a safe refusal", async () => {
  const f = await fixture();
  const foreign = structuredClone(f.bindings[0]!);
  foreign.ownerId = "another-owner";
  const responses = [
    await f.read({ bindings: [foreign] }),
    await f.read({ bindings: f.bindings, ownerId: "native:owner" }),
    await f.read({ bindings: f.bindings, path: "/private/repository" }),
    await f.read(undefined, "unknown"),
  ];
  for (const response of responses) {
    equal(response?.status, 404);
    equal(
      JSON.stringify(await response!.json()).includes("another-owner"),
      false,
    );
  }
  equal(f.counts().reads, 0);
});

Deno.test("changed full binding or source failure refuses with no cached fallback", async () => {
  const f = await fixture();
  for (const field of ["revision", "versionId", "invocationId"] as const) {
    const altered = {
      ...f.bindings[0]!,
      [field]: field === "revision" ? 99 : "forged",
    };
    const response = await f.read({ bindings: [altered] });
    equal(response?.status, 404);
    equal(JSON.stringify(await response!.json()).includes(draft.code), false);
  }
});

Deno.test("current conversation read scope is required even for a previously known exact binding", async () => {
  const f = await fixture();
  f.revoke();
  equal((await f.read())?.status, 404);
  equal(f.counts().reads, 0);
});

Deno.test("source read refuses cross-origin and wrong method before service access", async () => {
  const f = await fixture();
  const url =
    "http://127.0.0.1:4311/api/conversations/session-owner/artifact-sources/read";
  equal((await f.handler(new Request(url)))?.status, 405);
  equal(
    (await f.handler(
      new Request(url, {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin: "https://foreign.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ bindings: f.bindings }),
      }),
    ))?.status,
    403,
  );
  equal(f.counts().reads, 0);
});
