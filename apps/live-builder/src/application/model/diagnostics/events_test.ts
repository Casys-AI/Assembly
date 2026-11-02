import assert from "node:assert/strict";
import { observeModelRevisions, revalidateModelDiagnostics } from "./events.ts";
import type { ModelDiagnosticsEvent } from "./ports/out/diagnostics-notifications.port.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../domain/model/records/revision.ts";

function fixture() {
  let current: ModelRevision = {
    version: "commit:base",
    sourceDigest: "base",
    sources: {},
    elements: [],
    documents: [],
    semanticDigest: "",
    provenanceDigest: "",
    sourceHashes: {},
    engineVersion: "test",
  };
  const proposal: ProposalRecord = {
    id: "fix",
    branch: "proposal_fix",
    author: "agent:primary",
    reason: "Add budget",
    baseVersion: current.version,
    createdAt: "2026-10-23T00:00:00Z",
    status: "proposed",
    validation: "validated",
    sourceDigest: "fixed",
    proposalVersion: "commit:proposal",
    diff: [],
  };
  const repository: ModelRepositoryPort = {
    findPublication: () => Promise.resolve(null),
    initialize: () => Promise.resolve(current),
    current: () => Promise.resolve(current),
    at: (version) => Promise.resolve({ ...current, version }),
    header: (version) =>
      Promise.resolve({
        version,
        sources: current.sources,
        sourceDigest: current.sourceDigest,
      }),
    history: () =>
      Promise.resolve({
        headVersion: current.version,
        commits: [],
        truncated: false,
      }),
    changedFiles: () => Promise.resolve([]),
    lastChangeByPath: () => Promise.resolve([]),
    graphDiff: () => {
      throw new Error("Not used");
    },
    propose: () => Promise.resolve(proposal),
    proposal: () => Promise.resolve(proposal),
    listProposals: () => Promise.resolve([proposal]),
    readProposalJournal: () => Promise.resolve([proposal]),
    accept() {
      current = {
        ...current,
        version: "commit:accepted",
        sourceDigest: "fixed",
      };
      return Promise.resolve(current);
    },
    reject: () => Promise.resolve({ ...proposal, status: "rejected" }),
    publishSystemSources() {
      current = { ...current, version: "commit:published" };
      return Promise.resolve(current);
    },
    updateSystemSources() {
      current = { ...current, version: "commit:updated" };
      return Promise.resolve(current);
    },
  };
  return { repository, proposal };
}

Deno.test("diagnostics observes completed proposed and accepted versions without changing authority", async () => {
  const { repository, proposal } = fixture();
  const versions: string[] = [];
  const observed = observeModelRevisions(repository, async (version) => {
    // A callback can read repository state after the write has completed.
    assert((await repository.current()).version);
    versions.push(version);
  });
  await observed.initialize({});
  assert.equal(
    await observed.propose({
      baseVersion: "commit:base",
      sources: {},
      author: "agent:primary",
      reason: "Add budget",
    }),
    proposal,
  );
  assert.equal((await observed.current()).version, "commit:base");
  await observed.accept({
    id: proposal.id,
    expectedVersion: "commit:base",
    author: "owner",
  });
  await observed.publishSystemSources({}, "commit:accepted", "host");
  await observed.updateSystemSources(() => ({}), "host");
  await observed.reject({ id: proposal.id, author: "owner" });
  await observed.at("commit:base");
  assert.deepEqual(await observed.header("commit:base"), {
    version: "commit:base",
    sources: {},
    sourceDigest: "fixed",
  });
  await observed.listProposals();
  assert.deepEqual(versions, [
    "commit:base",
    "commit:proposal",
    "commit:accepted",
    "commit:published",
    "commit:updated",
    "commit:updated",
  ]);
});

Deno.test("diagnostics emits no success event for failed writes and cannot fail a completed mutation", async () => {
  const { repository } = fixture();
  let notifications = 0;
  const observed = observeModelRevisions(repository, () => {
    notifications++;
    return Promise.reject(new Error("Diagnostics unavailable"));
  });
  const accepted = await observed.accept({
    id: "fix",
    expectedVersion: "commit:base",
    author: "owner",
  });
  assert.equal(accepted.version, "commit:accepted");
  assert.equal(notifications, 1);
  repository.propose = () => Promise.reject(new Error("Invalid source"));
  await assert.rejects(
    () =>
      observed.propose({
        baseVersion: "commit:base",
        sources: {},
        author: "agent:primary",
        reason: "Fix",
      }),
    /Invalid source/,
  );
  assert.equal(notifications, 1);
});

Deno.test("diagnostics event carries the exact revalidated version, source digest and all severity counts", async () => {
  const events: Array<[string, ModelDiagnosticsEvent]> = [];
  const diagnostics = {
    list(version?: string) {
      assert.equal(version, "commit:proposal");
      return Promise.resolve({
        version,
        sourceDigest: "source-digest",
        diagnostics: [
          {
            code: "E",
            severity: "error" as const,
            finding: "absent" as const,
            message: "Error",
            masked: false,
          },
          {
            code: "W",
            severity: "warning" as const,
            finding: "absent" as const,
            message: "Warning",
            masked: true,
          },
          {
            code: "I",
            severity: "info" as const,
            finding: "present" as const,
            message: "Info",
            masked: false,
          },
        ],
      });
    },
  };
  await revalidateModelDiagnostics(
    diagnostics,
    "commit:proposal",
    (event, value) => {
      events.push([event, value]);
    },
  );
  assert.deepEqual(events, [["diagnostics", {
    version: "commit:proposal",
    sourceDigest: "source-digest",
    counts: { error: 1, warning: 1, info: 1 },
  }]]);
  await assert.rejects(() =>
    revalidateModelDiagnostics(
      { list: () => Promise.reject(new Error("Unavailable")) },
      "commit:failed",
      (event, value) => {
        events.push([event, value]);
      },
    )
  );
  assert.equal(events.length, 1);
});

Deno.test("diagnostics forwards immutable publication receipts and direct lookup unchanged", async () => {
  const { repository } = fixture();
  const { exerciseOwnerAuthority } = await import(
    "../../../domain/governance/authority.ts"
  );
  const receipt = {
    changeId: crypto.randomUUID(),
    authorityExercise: exerciseOwnerAuthority({
      identity: { systemId: "system" },
      version: { digest: "base" },
    }, "mandate-change"),
    baseModelDigest: "base",
    baseRevision: 0,
    adoptedPin: { digest: "base", repositoryVersion: "commit:base" },
    decidedAt: "now",
    edits: [],
  };
  const revision = await repository.current();
  const verify = () => {};
  let calls = 0;
  repository.updateSystemSources = (_update, author, publication) => {
    assert.equal(author, `ase:approved-change:${receipt.changeId}`);
    assert.deepEqual(publication, { publication: receipt, verify });
    calls++;
    return Promise.resolve(revision);
  };
  repository.findPublication = (id) => {
    assert.equal(id, receipt.changeId);
    return Promise.resolve({ revision, receipt });
  };
  const observed = observeModelRevisions(repository, () => Promise.resolve());
  await observed.updateSystemSources(
    () => ({}),
    `ase:approved-change:${receipt.changeId}`,
    { publication: receipt, verify },
  );
  assert.equal(calls, 1);
  assert.deepEqual(await observed.findPublication(receipt.changeId), {
    revision,
    receipt,
  });
});
