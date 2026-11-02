import assert from "node:assert/strict";
import { toolDraftDigest } from "../../../application/work/artifacts/catalog.ts";
import { skillContentDigest } from "../../skills/context-skills.ts";
import {
  artifactSourceContentDigest,
  assertArtifactSourceBusinessProof,
  assertQueuedArtifactSourcePublication,
  type QueuedArtifactSourcePublication,
} from "./source-publication.ts";

function publication(): QueuedArtifactSourcePublication {
  return {
    publicationId: "source-invocation-one",
    source: {
      artifactId: "draft-one",
      kind: "tool-draft",
      content: {
        name: "Reader",
        description: "Exact text",
        kind: "read_web_page",
        code: "export default () => ({title:'x',text:'y'});",
      },
    },
    baseVersion: `commit:${"1".repeat(40)}`,
    baseSourceDigest: "a".repeat(64),
    target: {
      projectId: "project",
      systemId: "system",
      executionSpaceId: "space",
      operatorId: "operator",
      ownerId: "operator",
      localArtifactId: "draft-one",
      invocationId: "effect-one",
    },
    proof: {
      kind: "native-action",
      ownerId: "operator",
      modelVersion: {
        digest: "b".repeat(64),
        repositoryVersion: `commit:${"1".repeat(40)}`,
      },
      flowRootNativeId: "flow-root",
      nativeActionId: "propose-node",
      mechanism: "propose_candidate",
      invocationId: "effect-one",
    },
  };
}

Deno.test("artifact source intent preserves existing tool and skill byte digests", async () => {
  const request = publication();
  assert.equal(request.source.kind, "tool-draft");
  if (request.source.kind !== "tool-draft") throw new Error("fixture kind");
  assert.equal(
    await artifactSourceContentDigest(request.source),
    await toolDraftDigest(request.source.content),
  );
  const text = "# Skill\r\n\nExact UTF-8 漢字.";
  assert.equal(
    await artifactSourceContentDigest({
      artifactId: "skill",
      kind: "skill-document",
      content: text,
    }),
    await skillContentDigest(text),
  );
});

Deno.test("artifact source intent binds actual native action, caller, invocation and exact model pin", async () => {
  const request = publication();
  await assertQueuedArtifactSourcePublication(request, "repository");
  const caller = structuredClone(request);
  caller.target.ownerId = "other";
  await assert.rejects(() =>
    assertQueuedArtifactSourcePublication(caller, "repository")
  );
  const invocation = structuredClone(request);
  invocation.target.invocationId = "another-effect";
  await assert.rejects(() =>
    assertQueuedArtifactSourcePublication(invocation, "repository")
  );
  const base = structuredClone(request);
  base.baseVersion = `commit:${"2".repeat(40)}`;
  await assert.rejects(() =>
    assertQueuedArtifactSourcePublication(base, "repository")
  );
});

Deno.test("artifact source proof rejects raw invocation inputs and invented grant booleans", () => {
  const proof = publication().proof;
  assert.throws(() =>
    assertArtifactSourceBusinessProof(
      { ...proof, approved: true } as unknown as Parameters<
        typeof assertArtifactSourceBusinessProof
      >[0],
    )
  );
  assert.throws(() =>
    assertArtifactSourceBusinessProof(
      {
        kind: "modeled-behavior",
        invocation: {
          callerId: "operator",
          invocationId: "effect-one",
          input: { private: "not persisted here" },
          modelVersion: {
            digest: "a".repeat(64),
            repositoryVersion: `commit:${"1".repeat(40)}`,
          },
          behavior: { id: "behavior", callerNativeId: "operator" },
        },
      } as unknown as Parameters<typeof assertArtifactSourceBusinessProof>[0],
    )
  );
});

Deno.test("artifact source intent rejects oversized content, noncanonical tool keys and malformed target", async () => {
  await assert.rejects(() =>
    artifactSourceContentDigest({
      artifactId: "large",
      kind: "skill-document",
      content: "x".repeat(1_048_577),
    })
  );
  const extra = publication();
  if (extra.source.kind !== "tool-draft") throw new Error("fixture kind");
  Object.assign(extra.source.content, { importedAuthority: true });
  await assert.rejects(() =>
    assertQueuedArtifactSourcePublication(extra, "repository")
  );
  const target = publication();
  target.target.executionSpaceId = "";
  await assert.rejects(() =>
    assertQueuedArtifactSourcePublication(target, "repository")
  );
});
