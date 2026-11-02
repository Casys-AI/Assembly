import assert from "node:assert/strict";
import { ModelRevisionsService } from "./service.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import type {
  ModelCommit,
  ProposalRecord,
} from "../../../domain/model/records/revision.ts";

Deno.test("revision queries attach current proposal links without caching mutable journal facts", async () => {
  const version = `commit:${"a".repeat(40)}`;
  const commit: ModelCommit = {
    version,
    parents: [],
    author: "local-control",
    parsedAuthor: { kind: "host", ref: "local-control" },
    message: "Accept",
    createdAt: "now",
    sourceDigest: "digest",
    files: [],
    additions: 0,
    deletions: 0,
  };
  const proposal: ProposalRecord = {
    id: "proposal",
    branch: "proposal_1",
    author: "local-owner",
    reason: "Change",
    baseVersion: version,
    createdAt: "now",
    status: "proposed",
    validation: "validated",
    sourceDigest: "digest",
    diff: [],
  };
  let limit: number | undefined;
  const service = new ModelRevisionsService({
    history(options) {
      limit = options?.limit;
      return Promise.resolve({
        headVersion: version,
        commits: [commit],
        truncated: false,
      });
    },
    readProposalJournal: () => Promise.resolve([proposal]),
    lastChangeByPath: () => Promise.resolve([]),
  });
  assert.equal(
    (await service.history({ limit: 7 })).commits[0].proposalId,
    undefined,
  );
  assert.equal(limit, 7);
  proposal.acceptedVersion = version;
  proposal.status = "accepted";
  assert.equal((await service.history()).commits[0].proposalId, proposal.id);
  assert.equal(
    commit.proposalId,
    undefined,
    "links never mutate cached immutable metadata",
  );
  proposal.acceptedVersion = undefined;
  assert.equal((await service.history()).commits[0].proposalId, undefined);
});

Deno.test("file queries resolve head through lightweight history and validate explicit immutable identities", async () => {
  const version = `commit:${"b".repeat(40)}`;
  const calls: unknown[] = [];
  const files = [{
    path: "a.sysml",
    lastChange: { version, createdAt: "now", message: "Add" },
  }];
  const reader: Pick<
    ModelRepositoryPort,
    "history" | "readProposalJournal" | "lastChangeByPath"
  > = {
    history(options) {
      calls.push(options);
      return Promise.resolve({
        headVersion: version,
        commits: [],
        truncated: false,
      });
    },
    readProposalJournal() {
      throw new Error("File metadata never reads proposals");
    },
    lastChangeByPath(head) {
      calls.push(head);
      return Promise.resolve(files);
    },
  };
  const service = new ModelRevisionsService(reader);
  assert.deepEqual(await service.files(), { version, files });
  assert.deepEqual(calls, [{ limit: 1 }, version]);
  calls.length = 0;
  assert.deepEqual(await service.files(version), { version, files });
  assert.deepEqual(calls, [version]);
  for (
    const invalid of [
      "branch:main",
      "",
      "commit:abc",
      `commit:${"B".repeat(40)}`,
    ]
  ) {
    await assert.rejects(() => service.files(invalid), {
      code: "INVALID_REQUEST",
    });
  }
  assert.deepEqual(calls, [version], "invalid queries do not reach storage");
});
