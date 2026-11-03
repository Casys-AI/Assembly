import { QueuedModelWriter } from "../publication/queued-writer.ts";
import { ModelWriteWorker } from "../publication/write-queue.ts";
import assert from "node:assert/strict";
import { DurableQueuedArtifactSourcePublisher } from "./queued-artifact-source-publisher.ts";
import type { ModelWriteQueuePort } from "../publication/ports/out/model-write-queue.port.ts";
import { buildArtifactSourceRetentionCommand } from "../publication/write-queue.ts";
import {
  modelWriteCommandDigest,
  modelWriteDossierDigest,
} from "../../../domain/model/editing/write-command.ts";
import type { QueuedArtifactSourcePublication } from "../../../domain/work/artifacts/source-publication.ts";
import type { ArtifactSourcePublicationReceipt } from "../../work/artifacts/source-repository.ts";

async function fixture(
  options: { revoked?: boolean; missingAnchor?: boolean } = {},
) {
  const publication: QueuedArtifactSourcePublication = {
    publicationId: "source-existing",
    source: {
      artifactId: "draft",
      kind: "tool-draft",
      content: {
        name: "Reader",
        description: "Exact",
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
      localArtifactId: "draft",
      invocationId: "effect",
    },
    proof: {
      kind: "native-action",
      ownerId: "operator",
      modelVersion: {
        digest: "b".repeat(64),
        repositoryVersion: `commit:${"1".repeat(40)}`,
      },
      flowRootNativeId: "flow",
      nativeActionId: "action",
      mechanism: "propose_candidate",
      invocationId: "effect",
    },
  };
  const dossier = await buildArtifactSourceRetentionCommand({
    ...publication,
    repositoryId: "repository",
    scopeId: "sources",
  });
  if (dossier.operations.kind !== "artifact-source") {
    throw new Error("fixture kind");
  }
  const commandDigest = await modelWriteCommandDigest(dossier.command);
  const receipt: ArtifactSourcePublicationReceipt = {
    version: 1,
    baseVersion: publication.baseVersion,
    baseSourceDigest: publication.baseSourceDigest,
    command: { commandId: publication.publicationId, commandDigest },
    reference: {
      version: 2,
      scopeId: "sources",
      repositoryId: "repository",
      artifactId: "draft",
      kind: "tool-draft",
      commitOid: "3".repeat(40),
      entryPath: `artifacts/${"c".repeat(64)}/source.json`,
      manifestPath: `artifacts/${"c".repeat(64)}/manifest.json`,
      contentEncoding: "tool-draft-json-v1",
      contentDigest: dossier.operations.contentDigest,
      manifestFormat: "assembly-artifact-package-v2",
      manifestDigestVersion: "sha256-canonical-json-v1",
      manifestDigest: "c".repeat(64),
    },
  };
  const entry = {
    command: dossier.command,
    commandDigest,
    dossierDigest: await modelWriteDossierDigest(dossier),
    state: "published" as const,
    enqueuedAt: "now",
    updatedAt: "now",
    attempts: 0,
    fence: 1,
    publishedVersion: `commit:${receipt.reference.commitOid}`,
  };
  let authorizations = 0, enqueues = 0, reads = 0;
  const unexpected = () => {
    throw new Error(
      "Completed source receipt does not invoke another writer/model",
    );
  };
  const queue: ModelWriteQueuePort = {
    enqueue: () => {
      enqueues++;
      return Promise.resolve({ status: "duplicate", entry });
    },
    get: () => Promise.resolve(entry),
    acquire: unexpected,
    heartbeat: unexpected,
    transition: unexpected,
    settle: unexpected,
    guardPublication: unexpected,
    recoverExpired: unexpected,
    list: unexpected,
  };
  const publisher = new DurableQueuedArtifactSourcePublisher({
    repositoryId: "repository",
    queue,
    pump: unexpected,
    artifactSourceWrites: {
      scopeId: "sources",
      assertCurrent: (captured) => {
        authorizations++;
        assert.deepEqual(captured, publication);
        if (options.revoked) return Promise.reject(new Error("revoked"));
        return Promise.resolve();
      },
      repository: {
        findByCommand: (command) => {
          assert.deepEqual(command, receipt.command);
          return Promise.resolve(
            options.missingAnchor ? null : structuredClone(receipt),
          );
        },
        read: () => {
          reads++;
          return Promise.resolve(structuredClone(publication.source));
        },
        retain: unexpected,
      },
    },
  });
  return {
    publisher,
    publication,
    receipt,
    dossier,
    queue,
    inspect: () => ({ authorizations, enqueues, reads }),
  };
}

Deno.test("completed source publisher retry rechecks current authority and exact retained bytes without another pump", async () => {
  const f = await fixture();
  assert.deepEqual(await f.publisher.publish(f.publication), f.receipt);
  assert.deepEqual(f.inspect(), { authorizations: 2, enqueues: 1, reads: 2 });
});
Deno.test("completed source publisher never uses past SQL success as current authority", async () => {
  const f = await fixture({ revoked: true });
  await assert.rejects(() => f.publisher.publish(f.publication), /revoked/);
  assert.deepEqual(f.inspect(), { authorizations: 1, enqueues: 0, reads: 0 });
});
Deno.test("completed source publisher refuses absent command anchor without model fallback", async () => {
  const f = await fixture({ missingAnchor: true });
  await assert.rejects(() => f.publisher.publish(f.publication), {
    code: "WRITE_QUEUE_CONFLICT",
  });
  assert.equal(f.inspect().reads, 0);
});

Deno.test("source retention cannot use the admitted-model submission or resume surface", async () => {
  const f = await fixture();
  const unexpected = () => {
    throw new Error("No model read/publication is authorized");
  };
  const worker = new ModelWriteWorker({
    queue: f.queue,
    owner: "worker",
    publication: { prepare: unexpected, publish: unexpected },
    repository: {
      current: unexpected,
      proposal: unexpected,
      accept: unexpected,
      findPublicationByCommand: unexpected,
    },
  });
  const writer = new QueuedModelWriter("repository", f.queue, worker, {
    compile: unexpected,
    recipe: unexpected,
  }, { at: unexpected });
  await assert.rejects(() => writer.publish(f.dossier), {
    code: "WRITE_QUEUE_INVALID",
  });
  await assert.rejects(() => writer.resume(f.publication.publicationId), {
    code: "WRITE_QUEUE_INVALID",
  });
  assert.equal(f.inspect().enqueues, 0);
});
