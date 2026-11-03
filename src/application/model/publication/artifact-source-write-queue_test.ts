import assert from "node:assert/strict";
import type {
  AcquiredWrite,
  ModelWriteQueuePort,
  SettleOutcome,
} from "./ports/out/model-write-queue.port.ts";
import {
  buildArtifactSourceRetentionCommand,
  ModelWriteWorker,
} from "./write-queue.ts";
import { ModelRepositoryError } from "../repository.ts";
import {
  modelWriteCommandDigest,
  modelWriteDossierDigest,
} from "../../../domain/model/editing/write-command.ts";
import type { QueuedArtifactSourcePublication } from "../../../domain/work/artifacts/source-publication.ts";
import type {
  ArtifactSourcePublicationReceipt,
  ArtifactSourceRepositoryPort,
} from "../../work/artifacts/source-repository.ts";

async function fixture(
  options: {
    recovered?: boolean;
    mismatch?: boolean;
    revoked?: boolean;
    noPort?: boolean;
  } = {},
) {
  const publication: QueuedArtifactSourcePublication = {
    publicationId: "source-effect-one",
    source: {
      artifactId: "draft-one",
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
      flowRootNativeId: "flow",
      nativeActionId: "action",
      mechanism: "propose_candidate",
      invocationId: "effect-one",
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
  const entry = {
    command: dossier.command,
    commandDigest,
    dossierDigest: await modelWriteDossierDigest(dossier),
    state: "preparing" as const,
    enqueuedAt: "now",
    updatedAt: "now",
    attempts: 0,
    fence: 1,
  };
  const acquired: AcquiredWrite = {
    dossier,
    entry,
    lease: {
      repositoryId: "repository",
      commandId: publication.publicationId,
      owner: "worker",
      fence: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  let settled: SettleOutcome | undefined;
  let retains = 0, reads = 0, authorizations = 0, lookups = 0;
  const transitions: string[] = [];
  const receipt: ArtifactSourcePublicationReceipt = {
    version: 1,
    baseVersion: publication.baseVersion,
    baseSourceDigest: publication.baseSourceDigest,
    command: { commandId: publication.publicationId, commandDigest },
    reference: {
      version: 2,
      scopeId: "sources",
      repositoryId: "repository",
      artifactId: options.mismatch ? "other-draft" : "draft-one",
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
  const sourceRepository: ArtifactSourceRepositoryPort = {
    findByCommand: () => {
      lookups++;
      return Promise.resolve(options.recovered ? receipt : null);
    },
    retain: async (input, options) => {
      retains++;
      assert.deepEqual(input.command, receipt.command);
      assert.deepEqual(input.fence, acquired.lease);
      assert.equal(typeof options?.assertCurrent, "function");
      await options?.assertCurrent?.();
      return receipt;
    },
    read: () => {
      reads++;
      return Promise.resolve(structuredClone(publication.source));
    },
  };
  const queue: ModelWriteQueuePort = {
    enqueue: () => Promise.resolve({ status: "duplicate", entry }),
    acquire: () => Promise.resolve(acquired),
    recoverExpired: () => Promise.resolve(0),
    heartbeat: () => Promise.resolve(),
    transition: (_lease, to) => {
      transitions.push(to);
      return Promise.resolve();
    },
    settle: (_lease, outcome) => {
      settled = outcome;
      return Promise.resolve();
    },
    guardPublication: (_lease, _ms, operation) => operation(),
    get: () => Promise.resolve(entry),
    list: () => Promise.resolve([entry]),
  };
  const unexpected = () => {
    throw new Error(
      "Source retention must not call admitted-model publication",
    );
  };
  const worker = new ModelWriteWorker({
    queue,
    owner: "worker",
    publication: { prepare: unexpected, publish: unexpected },
    repository: {
      current: unexpected,
      proposal: unexpected,
      accept: unexpected,
      findPublicationByCommand: unexpected,
    },
    ...(options.noPort ? {} : {
      artifactSourceWrites: {
        scopeId: "sources",
        repository: sourceRepository,
        assertCurrent: (captured: QueuedArtifactSourcePublication) => {
          authorizations++;
          assert.deepEqual(captured, publication);
          if (options.revoked) {
            throw new ModelRepositoryError(
              "EDIT_SCOPE_DENIED",
              "Source storage permission revoked",
            );
          }
          return Promise.resolve();
        },
      },
    }),
  });
  return {
    worker,
    publication,
    dossier,
    receipt,
    inspect: () => ({
      settled,
      retains,
      reads,
      authorizations,
      lookups,
      transitions,
    }),
  };
}

Deno.test("source W4 command retains exact bytes with the same fence without model publication", async () => {
  const f = await fixture();
  const outcome = await f.worker.runOnce("repository");
  assert.equal(outcome.status, "published");
  if (outcome.status !== "published") {
    throw new Error("source publication failed");
  }
  assert.equal(outcome.already, false);
  assert.equal(outcome.version, `commit:${f.receipt.reference.commitOid}`);
  assert.deepEqual(f.inspect().transitions, ["publishing"]);
  assert.equal(f.inspect().retains, 1);
  assert.equal(f.inspect().reads, 1);
  assert.equal(f.inspect().authorizations, 3);
});

Deno.test("source W4 recovery uses only exact source namespace anchor and current authority", async () => {
  const f = await fixture({ recovered: true });
  const outcome = await f.worker.runOnce("repository");
  assert.equal(outcome.status, "published");
  if (outcome.status !== "published") throw new Error("source recovery failed");
  assert.equal(outcome.already, true);
  assert.equal(f.inspect().retains, 0);
  assert.deepEqual(f.inspect().transitions, []);
  assert.equal(f.inspect().authorizations, 2);
});

Deno.test("source W4 refuses a conflicting recovered artifact rather than settling another result", async () => {
  const f = await fixture({ recovered: true, mismatch: true });
  const outcome = await f.worker.runOnce("repository");
  assert.equal(outcome.status, "needs-decision");
  assert.equal(f.inspect().retains, 0);
  assert.notEqual(f.inspect().settled?.status, "published");
});

Deno.test("source W4 current authority is required even when exact anchor already exists", async () => {
  const f = await fixture({ recovered: true, revoked: true });
  assert.equal((await f.worker.runOnce("repository")).status, "needs-decision");
  assert.equal(f.inspect().lookups, 0);
  assert.equal(f.inspect().retains, 0);
});

Deno.test("source W4 fails closed without host-bound source writer", async () => {
  const f = await fixture({ noPort: true });
  assert.equal((await f.worker.runOnce("repository")).status, "refused");
  assert.equal(f.inspect().retains, 0);
});
