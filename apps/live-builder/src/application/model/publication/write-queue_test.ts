// deno-lint-ignore-file require-await -- Async port doubles return deterministic in-memory responses.
import assert from "node:assert/strict";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import type { ModelSources as Sources } from "../../../domain/model/value-objects/sources.ts";
import type { HostEdit } from "../../../domain/model/editing/host-edit.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../domain/model/records/revision.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  buildOperationJournal,
  modelWriteCommandDigest,
  modelWriteDecisionDigest,
  type ModelWriteDossier,
  modelWriteDossierDigest,
  modelWriteIntentDigest,
} from "../../../domain/model/editing/write-command.ts";
import { changePublication } from "../../../domain/model/publication/change.ts";
import type { PrepareOutcome, PublishOutcome } from "./service.ts";
import type {
  AcquiredWrite,
  EnqueueOutcome,
  ModelWriteQueueEntry,
  ModelWriteQueuePort,
  SettleOutcome,
  WriteLease,
} from "./ports/out/model-write-queue.port.ts";
import type { WriteWorkerRepositoryPort } from "./ports/out/write-worker-repository.port.ts";
import {
  buildAcceptProposalCommand,
  buildApprovedChangeCommand,
  ModelWriteQueueError,
  ModelWriteWorker,
} from "./write-queue.ts";

const hex = (char: string) => char.repeat(64);
const repositoryId = "git:repo-1";
const baseVersion = "commit:" + "1".repeat(40);
const publishedVersion = "commit:" + "3".repeat(40);

type MutableEntry = {
  -readonly [K in keyof ModelWriteQueueEntry]: ModelWriteQueueEntry[K];
};

/** In-memory port double honoring the queue contract (FIFO, single owner,
 * fencing, digest conflict, bound). The SQLite adapter proves durability. */
class FakeQueue implements ModelWriteQueuePort {
  entries: MutableEntry[] = [];
  dossiers = new Map<string, ModelWriteDossier>();
  transitions: string[] = [];
  now = Date.parse("2026-10-25T12:00:00.000Z");
  constructor(readonly bound = 2) {}

  #key(repository: string, command: string) {
    return `${repository}/${command}`;
  }
  #find(repository: string, command: string) {
    return this.entries.find((entry) =>
      entry.command.repositoryId === repository &&
      entry.command.commandId === command
    );
  }
  #fence(lease: WriteLease): MutableEntry {
    const entry = this.#find(lease.repositoryId, lease.commandId);
    if (
      !entry || entry.owner !== lease.owner || entry.fence !== lease.fence ||
      Date.parse(entry.leaseExpiresAt!) <= this.now
    ) {
      throw new ModelWriteQueueError("WRITE_FENCE_LOST", {
        repositoryId: lease.repositoryId,
        commandId: lease.commandId,
        reason: "lease lost",
      }, "lease lost");
    }
    return entry;
  }
  async enqueue(dossier: ModelWriteDossier): Promise<EnqueueOutcome> {
    const commandDigest = await modelWriteCommandDigest(dossier.command);
    const existing = this.#find(
      dossier.command.repositoryId,
      dossier.command.commandId,
    );
    if (existing) {
      if (existing.commandDigest !== commandDigest) {
        throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
          reason: "digest differs",
        }, "digest differs");
      }
      return { status: "duplicate", entry: existing };
    }
    const pending = this.entries.filter((entry) =>
      entry.command.repositoryId === dossier.command.repositoryId &&
      !["published", "refused", "needs-decision"].includes(entry.state)
    );
    if (pending.length >= this.bound) {
      throw new ModelWriteQueueError("WRITE_QUEUE_FULL", {
        reason: "bound reached",
      }, "bound reached");
    }
    const entry: MutableEntry = {
      command: dossier.command,
      commandDigest,
      dossierDigest: await modelWriteDossierDigest(dossier),
      state: "queued",
      enqueuedAt: new Date(this.now).toISOString(),
      updatedAt: new Date(this.now).toISOString(),
      attempts: 0,
      fence: 0,
    };
    this.entries.push(entry);
    this.dossiers.set(
      this.#key(entry.command.repositoryId, entry.command.commandId),
      dossier,
    );
    return { status: "queued", entry };
  }
  async acquire(
    repository: string,
    owner: string,
    leaseMs: number,
  ): Promise<AcquiredWrite | null> {
    const busy = this.entries.some((entry) =>
      entry.command.repositoryId === repository &&
      ["preparing", "prepared", "publishing"].includes(entry.state) &&
      Date.parse(entry.leaseExpiresAt!) > this.now
    );
    if (busy) return null;
    const entry = this.entries.find((candidate) =>
      candidate.command.repositoryId === repository &&
      (candidate.state === "queued" || candidate.state === "retryable")
    );
    if (!entry) return null;
    const expiresAt = new Date(this.now + leaseMs).toISOString();
    Object.assign(entry, {
      state: "preparing",
      owner,
      fence: entry.fence + 1,
      leaseExpiresAt: expiresAt,
    });
    return {
      entry: structuredClone(entry),
      dossier: this.dossiers.get(
        this.#key(repository, entry.command.commandId),
      )!,
      lease: {
        repositoryId: repository,
        commandId: entry.command.commandId,
        owner,
        fence: entry.fence,
        expiresAt,
      },
    };
  }
  async heartbeat(lease: WriteLease, leaseMs: number): Promise<void> {
    this.#fence(lease).leaseExpiresAt = new Date(this.now + leaseMs)
      .toISOString();
  }
  async guardPublication<T>(
    lease: WriteLease,
    leaseMs: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    const entry = this.#fence(lease);
    if (entry.state !== "publishing") {
      throw new ModelWriteQueueError("WRITE_FENCE_LOST", {
        repositoryId: lease.repositoryId,
        commandId: lease.commandId,
        reason: "not publishing",
      }, "not publishing");
    }
    const result = await operation();
    entry.leaseExpiresAt = new Date(this.now + leaseMs).toISOString();
    return result;
  }
  async transition(
    lease: WriteLease,
    to: "prepared" | "publishing",
  ): Promise<void> {
    const entry = this.#fence(lease);
    entry.state = to;
    this.transitions.push(to);
  }
  async settle(lease: WriteLease, outcome: SettleOutcome): Promise<void> {
    const entry = this.#fence(lease);
    entry.state = outcome.status;
    entry.owner = undefined;
    if (outcome.status === "published") {
      entry.publishedVersion = outcome.version;
    } else {
      entry.lastError = outcome.error;
      if (outcome.status === "retryable") entry.attempts++;
    }
  }
  async get(repository: string, command: string) {
    return this.#find(repository, command) ?? null;
  }
  async list(repository: string) {
    return this.entries.filter((entry) =>
      entry.command.repositoryId === repository
    );
  }
  async recoverExpired(): Promise<number> {
    let recovered = 0;
    for (const entry of this.entries) {
      if (
        ["preparing", "prepared", "publishing"].includes(entry.state) &&
        Date.parse(entry.leaseExpiresAt!) <= this.now
      ) {
        entry.state = "retryable";
        entry.owner = undefined;
        recovered++;
      }
    }
    return recovered;
  }
}

async function revision(
  version: string,
  sources: Sources,
): Promise<ModelRevision> {
  return {
    version,
    sources,
    elements: [],
    documents: [],
    sourceDigest: await modelSourceDigest(sources),
    semanticDigest: hex("c"),
    provenanceDigest: hex("d"),
    sourceHashes: {},
    engineVersion: "engine-1",
  };
}

const edit: HostEdit = {
  op: "setFeatureValue",
  target: {
    id: "el-1",
    qualifiedName: "Sys::a",
    metaclass: "PartUsage",
    preimage: hex("a"),
  },
  value: "x",
  format: 1,
};

async function approvedDossier(
  changeId = "11111111-1111-4111-8111-111111111111",
) {
  const pin = {
    digest: "base-model",
    repositoryVersion: baseVersion,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  };
  const change: PendingChange = {
    id: changeId,
    kind: "mandate-change",
    status: "approved",
    baseRevision: 0,
    baseModelDigest: pin.digest,
    requestedAt: "now",
    decidedAt: "later",
    reason: "Exact extension",
    authorityExercise: exerciseOwnerAuthority(
      { identity: { systemId: "system" }, version: pin },
      "mandate-change",
    ),
  };
  const base = await revision(baseVersion, { "core.sysml": "package Sys;" });
  return await buildApprovedChangeCommand({
    repositoryId,
    change,
    pin,
    journal: buildOperationJournal({
      base: parseModelRevisionRef({ repositoryId, version: baseVersion }),
      baseSourceDigest: base.sourceDigest,
      edits: [edit],
    }),
    recipeDigest: hex("b"),
  });
}

function fakeRepository(): WriteWorkerRepositoryPort & {
  proposalRecord?: ProposalRecord;
  byCommand?: {
    revision: ModelRevision;
    receipt?: unknown;
    commandDigest?: string;
  } | null;
  acceptCalls: number;
  acceptInput?: Parameters<WriteWorkerRepositoryPort["accept"]>[0];
} {
  const repo = {
    acceptCalls: 0,
    acceptInput: undefined as
      | Parameters<WriteWorkerRepositoryPort["accept"]>[0]
      | undefined,
    proposalRecord: undefined as ProposalRecord | undefined,
    byCommand: null as {
      revision: ModelRevision;
      receipt?: unknown;
      commandDigest?: string;
    } | null,
    async current() {
      return await revision(baseVersion, { "core.sysml": "package Sys;" });
    },
    async proposal() {
      if (!repo.proposalRecord) throw new Error("missing proposal fixture");
      return structuredClone(repo.proposalRecord);
    },
    async accept(input: Parameters<WriteWorkerRepositoryPort["accept"]>[0]) {
      repo.acceptCalls++;
      repo.acceptInput = input;
      const published = await revision(publishedVersion, {
        "core.sysml": "package Sys; // accepted",
      });
      if (input.command) {
        repo.byCommand = {
          revision: published,
          commandDigest: input.command.commandDigest,
        };
      }
      return published;
    },
    async findPublicationByCommand() {
      return repo.byCommand;
    },
  };
  return repo;
}

function fakePublication(outcomes: {
  prepare?: PrepareOutcome;
  publish?: PublishOutcome;
} = {}) {
  const calls: string[] = [];
  return {
    calls,
    async prepare(): Promise<PrepareOutcome> {
      calls.push("prepare");
      if (outcomes.prepare) return outcomes.prepare;
      throw new Error("prepare fixture missing");
    },
    async publish(): Promise<PublishOutcome> {
      calls.push("publish");
      if (outcomes.publish) return outcomes.publish;
      throw new Error("publish fixture missing");
    },
  };
}

async function preparedOutcome(
  dossier: ModelWriteDossier,
): Promise<PrepareOutcome> {
  const decision = dossier.decision;
  if (decision.kind !== "approved-change") throw new Error("fixture kind");
  return {
    status: "prepared",
    candidateSources: { "core.sysml": "package Sys; // edited" },
    prepared: {
      v: 2,
      approval: decision.approval,
      executionBase: {
        repositoryVersion: baseVersion,
        sourceDigest: hex("d"),
      },
      replayedEdits: [edit],
      revalidation: {
        checkedAt: "2026-10-25T12:00:00.000Z",
        executionBaseVersion: baseVersion,
        scopeDigest: hex("f"),
        authorityStillValid: true,
        preconditionsChecked: 1,
        baseUnchanged: true,
      },
      result: { sourceDigest: hex("a") },
      command: {
        commandId: dossier.command.commandId,
        commandDigest: await modelWriteCommandDigest(dossier.command),
      },
    },
  };
}

function worker(
  queue: FakeQueue,
  publication:
    & { calls: string[] }
    & Pick<
      import("./service.ts").ModelPublicationService,
      "prepare" | "publish"
    >,
  repo: WriteWorkerRepositoryPort,
  options: {
    maxAttempts?: number;
    recipeDigest?: () => Promise<string>;
  } = {},
) {
  return new ModelWriteWorker({
    queue,
    publication,
    repository: repo,
    owner: "worker-1",
    leaseMs: 60_000,
    ...options,
  });
}

Deno.test("worker prepares, fences, publishes and settles one approved command", async () => {
  const dossier = await approvedDossier();
  const queue = new FakeQueue();
  await queue.enqueue(dossier);
  const publication = fakePublication({
    prepare: await preparedOutcome(dossier),
    publish: {
      status: "published",
      revision: await revision(publishedVersion, { "core.sysml": "x" }),
    },
  });
  const outcome = await worker(queue, publication, fakeRepository())
    .runOnce(repositoryId);
  assert.equal(outcome.status, "published");
  assert.deepStrictEqual(publication.calls, ["prepare", "publish"]);
  assert.deepStrictEqual(queue.transitions, ["prepared", "publishing"]);
  const entry = await queue.get(repositoryId, dossier.command.commandId);
  assert.equal(entry?.state, "published");
  assert.equal(entry?.publishedVersion, publishedVersion);
});

Deno.test("approved command retains the recorded approval instead of regenerating it", async () => {
  const base = await approvedDossier();
  if (
    base.decision.kind !== "approved-change" ||
    base.operations.kind !== "host-edits"
  ) throw new Error("fixture kind");
  const change = base.decision.change;
  const journal = base.operations.journal;
  const original = structuredClone(base.decision.approval);
  delete original.proposal; // admissible historical receipt shape
  const rebuilt = await buildApprovedChangeCommand({
    repositoryId,
    change,
    pin: {
      digest: original.adoptedPin.digest,
      repositoryVersion: original.adoptedPin.repositoryVersion,
      rootId: "root",
      configurationId: "configuration",
      configurationRevision: 0,
      sourceIds: ["source"],
    },
    journal,
    recipeDigest: hex("b"),
    approval: original,
  });
  assert.deepStrictEqual(
    rebuilt.decision.kind === "approved-change"
      ? rebuilt.decision.approval
      : null,
    original,
  );
  await assert.rejects(
    () =>
      buildApprovedChangeCommand({
        repositoryId,
        change,
        pin: {
          digest: original.adoptedPin.digest,
          repositoryVersion: original.adoptedPin.repositoryVersion,
          rootId: "root",
          configurationId: "configuration",
          configurationRevision: 0,
          sourceIds: ["source"],
        },
        journal,
        recipeDigest: hex("b"),
        approval: {
          ...original,
          edits: [edit],
        },
      }),
    { code: "WRITE_DOSSIER_MISMATCH" },
  );
});

Deno.test("queued approved source base differs from execution pin without rewriting the recorded approval", async () => {
  const base = await approvedDossier();
  if (
    base.decision.kind !== "approved-change" ||
    base.operations.kind !== "host-edits"
  ) throw new Error("fixture kind");
  const change = structuredClone(base.decision.change);
  change.diff = {
    title: "Exact",
    author: "owner",
    base: {
      repositoryVersion: baseVersion,
      modelDigest: "base-model",
      sourceDigest: base.operations.journal.baseSourceDigest,
    },
    sourceDigest: hex("d"),
    files: [],
    patch: "",
    additions: 0,
    deletions: 0,
  };
  const pin = {
    digest: "base-model",
    repositoryVersion: baseVersion,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: [],
  };
  const approval = changePublication(change, {
    ...pin,
    repositoryVersion: "commit:" + "0".repeat(40),
  });
  const args = {
    repositoryId,
    change,
    pin,
    journal: base.operations.journal,
    recipeDigest: hex("b"),
    approval,
  };
  const queued = await buildApprovedChangeCommand(args);
  assert.equal(queued.command.approvedBase.version, baseVersion);
  assert.deepStrictEqual(
    queued.decision.kind === "approved-change"
      ? queued.decision.approval
      : undefined,
    approval,
  );
  await assert.rejects(
    () =>
      buildApprovedChangeCommand({
        ...args,
        journal: { ...args.journal, baseSourceDigest: hex("f") },
      }),
    { code: "WRITE_DOSSIER_MISMATCH" },
  );
  const legacy = { ...approval };
  delete legacy.approvedSourceBase;
  await assert.rejects(
    () => buildApprovedChangeCommand({ ...args, approval: legacy }),
    { code: "WRITE_DOSSIER_MISMATCH" },
  );
});

Deno.test("enqueue refuses a repeated commandId with another digest and enforces the bound", async () => {
  const queue = new FakeQueue(1);
  const first = await approvedDossier();
  await queue.enqueue(first);
  assert.equal((await queue.enqueue(first)).status, "duplicate");
  const forged = structuredClone(first);
  if (forged.decision.kind !== "approved-change") throw new Error("fixture");
  forged.decision.change.reason = "forged";
  // Recompute nothing: digest of the stored command stays first's, but a
  // rebuilt dossier for the same change with another reason must conflict.
  const rebuilt = await buildApprovedChangeCommand({
    repositoryId,
    change: { ...forged.decision.change },
    pin: {
      digest: "base-model",
      repositoryVersion: baseVersion,
      rootId: "root",
      configurationId: "configuration",
      configurationRevision: 0,
      sourceIds: ["source"],
    },
    journal: first.operations.kind === "host-edits"
      ? first.operations.journal
      : (() => {
        throw new Error("fixture");
      })(),
    recipeDigest: hex("b"),
  });
  await assert.rejects(() => queue.enqueue(rebuilt), {
    code: "WRITE_QUEUE_CONFLICT",
  });
  const second = await approvedDossier("22222222-2222-4222-8222-222222222222");
  await assert.rejects(() => queue.enqueue(second), {
    code: "WRITE_QUEUE_FULL",
  });
});

Deno.test("crash after publication: recovery settles from the real anchor without re-applying", async () => {
  const dossier = await approvedDossier();
  const queue = new FakeQueue();
  await queue.enqueue(dossier);
  const acquired = await queue.acquire(repositoryId, "dead-owner", 1_000);
  assert(acquired);
  queue.now += 5_000; // lease expires: owner crashed after commit, before ack
  const repo = fakeRepository();
  repo.byCommand = {
    revision: await revision(publishedVersion, { "core.sysml": "x" }),
    commandDigest: await modelWriteCommandDigest(dossier.command),
    receipt: {
      v: 2,
      command: {
        commandId: dossier.command.commandId,
        commandDigest: await modelWriteCommandDigest(dossier.command),
      },
    },
  };
  const publication = fakePublication();
  const outcome = await worker(queue, publication, repo).runOnce(repositoryId);
  assert.equal(outcome.status, "published");
  if (outcome.status === "published") assert.equal(outcome.already, true);
  assert.deepStrictEqual(publication.calls, []);
});

Deno.test("an owner that lost its fence never reaches publication", async () => {
  const dossier = await approvedDossier();
  const queue = new FakeQueue();
  await queue.enqueue(dossier);
  const publication = fakePublication({
    prepare: await preparedOutcome(dossier),
  });
  const losing = worker(queue, publication, fakeRepository());
  const originalTransition = queue.transition.bind(queue);
  queue.transition = async (lease, to) => {
    // Simulate a takeover between prepare and the publishing checkpoint.
    const entry = queue.entries[0]!;
    entry.fence++;
    entry.owner = "worker-2";
    return await originalTransition(lease, to);
  };
  const outcome = await losing.runOnce(repositoryId);
  assert.equal(outcome.status, "fence-lost");
  assert.deepStrictEqual(publication.calls, ["prepare"]);
});

Deno.test("accept-proposal sends its command digest and fence to atomic repository CAS", async () => {
  const proposalVersion = "commit:" + "4".repeat(40);
  const proposal: ProposalRecord = {
    id: "33333333-3333-4333-8333-333333333333",
    branch: "refs/ase/proposals/x",
    author: "agent:builder",
    reason: "Add part",
    baseVersion,
    createdAt: "now",
    status: "proposed",
    validation: "validated",
    sourceDigest: hex("e"),
    proposalVersion,
    diff: [{
      path: "core.sysml",
      kind: "changed",
      before: "old",
      after: "new",
    }],
  };
  const dossier = await buildAcceptProposalCommand({
    repositoryId,
    proposal,
    expectedVersion: baseVersion,
    author: "local-owner",
    baseSourceDigest: hex("d"),
    recipeDigest: hex("b"),
  });
  const queue = new FakeQueue();
  await queue.enqueue(dossier);
  const repo = fakeRepository();
  repo.proposalRecord = proposal;
  const outcome = await worker(queue, fakePublication(), repo)
    .runOnce(repositoryId);
  assert.equal(outcome.status, "published");
  assert.equal(repo.acceptCalls, 1);
  assert.deepStrictEqual(repo.acceptInput?.command, {
    commandId: proposal.id,
    commandDigest: await modelWriteCommandDigest(dossier.command),
  });
  assert.equal(repo.acceptInput?.fence?.commandId, proposal.id);
  assert.equal(
    repo.byCommand?.commandDigest,
    repo.acceptInput?.command?.commandDigest,
  );

  // A proposal rejected after the decision refuses the command.
  const rejectedQueue = new FakeQueue();
  await rejectedQueue.enqueue(dossier);
  const rejectedRepo = fakeRepository();
  rejectedRepo.proposalRecord = { ...proposal, status: "rejected" };
  const refused = await worker(rejectedQueue, fakePublication(), rejectedRepo)
    .runOnce(repositoryId);
  assert.equal(refused.status, "refused");
  assert.equal(rejectedRepo.acceptCalls, 0);

  // An externally accepted proposal has no proof that this queued command
  // caused the effect. Neither a legacy journal nor a bare ref is sufficient.
  const legacyQueue = new FakeQueue();
  await legacyQueue.enqueue(dossier);
  const legacyRepo = fakeRepository();
  legacyRepo.proposalRecord = {
    ...proposal,
    status: "accepted",
    acceptedVersion: publishedVersion,
  };
  const legacy = await worker(legacyQueue, fakePublication(), legacyRepo)
    .runOnce(repositoryId);
  assert.equal(legacy.status, "needs-decision");
  assert.equal(legacyRepo.acceptCalls, 0);

  const bareAnchorQueue = new FakeQueue();
  await bareAnchorQueue.enqueue(dossier);
  const bareAnchorRepo = fakeRepository();
  bareAnchorRepo.proposalRecord = proposal;
  bareAnchorRepo.byCommand = {
    revision: await revision(publishedVersion, { "core.sysml": "x" }),
  };
  const bareAnchor = await worker(
    bareAnchorQueue,
    fakePublication(),
    bareAnchorRepo,
  ).runOnce(repositoryId);
  assert.equal(bareAnchor.status, "needs-decision");
  assert.equal(bareAnchorRepo.acceptCalls, 0);

  const mismatchedQueue = new FakeQueue();
  await mismatchedQueue.enqueue(dossier);
  const mismatchedRepo = fakeRepository();
  mismatchedRepo.proposalRecord = proposal;
  mismatchedRepo.byCommand = {
    revision: await revision(publishedVersion, { "core.sysml": "x" }),
    commandDigest: hex("0"),
  };
  const mismatched = await worker(
    mismatchedQueue,
    fakePublication(),
    mismatchedRepo,
  ).runOnce(repositoryId);
  assert.equal(mismatched.status, "needs-decision");
  assert.equal(mismatchedRepo.acceptCalls, 0);

  const recipeChangedQueue = new FakeQueue();
  await recipeChangedQueue.enqueue(dossier);
  const recipeChangedRepo = fakeRepository();
  recipeChangedRepo.proposalRecord = proposal;
  const recipeChanged = await worker(
    recipeChangedQueue,
    fakePublication(),
    recipeChangedRepo,
    { recipeDigest: async () => hex("0") },
  ).runOnce(repositoryId);
  assert.equal(recipeChanged.status, "needs-decision");
  assert.equal(
    (await recipeChangedQueue.get(repositoryId, proposal.id))?.lastError?.code,
    "RECIPE_CHANGED",
  );
  assert.equal(recipeChangedRepo.acceptCalls, 0);

  const staleBaseQueue = new FakeQueue();
  const staleBaseDossier = await buildAcceptProposalCommand({
    repositoryId,
    proposal,
    expectedVersion: "commit:" + "5".repeat(40),
    author: "local-owner",
    baseSourceDigest: hex("d"),
    recipeDigest: hex("b"),
  });
  assert.notEqual(
    await modelWriteDecisionDigest(dossier.decision),
    await modelWriteDecisionDigest(staleBaseDossier.decision),
  );
  assert.notEqual(
    await modelWriteCommandDigest(dossier.command),
    await modelWriteCommandDigest(staleBaseDossier.command),
  );
  await staleBaseQueue.enqueue(staleBaseDossier);
  const staleBaseRepo = fakeRepository();
  staleBaseRepo.proposalRecord = proposal;
  const staleBase = await worker(
    staleBaseQueue,
    fakePublication(),
    staleBaseRepo,
  ).runOnce(repositoryId);
  assert.equal(staleBase.status, "needs-decision");
  assert.equal(
    (await staleBaseQueue.get(repositoryId, proposal.id))?.lastError?.code,
    "SOURCE_CONFLICT",
  );
  assert.equal(staleBaseRepo.acceptCalls, 0);

  if (dossier.decision.kind !== "accept-proposal") {
    throw new Error("fixture");
  }
  const { expectedVersion: _expected, ...missingBaseDecision } =
    dossier.decision;
  const decisionRef = {
    ...dossier.command.decisionRef,
    digest: await modelWriteDecisionDigest(missingBaseDecision),
  };
  const { v: _v, intentDigest: _intent, ...intent } = dossier.command;
  const missingBaseDossier: ModelWriteDossier = {
    ...dossier,
    command: {
      ...dossier.command,
      decisionRef,
      intentDigest: await modelWriteIntentDigest({ ...intent, decisionRef }),
    },
    decision: missingBaseDecision,
  };
  const missingBaseQueue = new FakeQueue();
  await missingBaseQueue.enqueue(missingBaseDossier);
  const missingBaseRepo = fakeRepository();
  missingBaseRepo.proposalRecord = proposal;
  const missingBase = await worker(
    missingBaseQueue,
    fakePublication(),
    missingBaseRepo,
  ).runOnce(repositoryId);
  assert.equal(missingBase.status, "needs-decision");
  assert.equal(missingBaseRepo.acceptCalls, 0);
});

Deno.test("three disjoint commands publish in FIFO order, one per run", async () => {
  const queue = new FakeQueue(8);
  const dossiers = [
    await approvedDossier("11111111-1111-4111-8111-111111111111"),
    await approvedDossier("22222222-2222-4222-8222-222222222222"),
    await approvedDossier("33333333-3333-4333-8333-333333333333"),
  ];
  for (const dossier of dossiers) await queue.enqueue(dossier);
  const order: string[] = [];
  const publication = {
    calls: order,
    async prepare(
      input: import("./commands/inputs.ts").PreparePublicationInput,
    ): Promise<PrepareOutcome> {
      const dossier = dossiers.find((candidate) =>
        candidate.command.commandId === input.approval.changeId
      )!;
      return await preparedOutcome(dossier);
    },
    async publish(
      prepared:
        import("../../../domain/model/publication/change.ts").PreparedPublication,
    ): Promise<PublishOutcome> {
      order.push(prepared.approval.changeId);
      return {
        status: "published",
        revision: await revision(publishedVersion, { "core.sysml": "x" }),
      };
    },
  };
  const runner = worker(queue, publication, fakeRepository());
  for (let run = 0; run < 3; run++) {
    assert.equal((await runner.runOnce(repositoryId)).status, "published");
  }
  assert.deepStrictEqual(
    order,
    dossiers.map((dossier) => dossier.command.commandId),
  );
  assert.equal((await runner.runOnce(repositoryId)).status, "idle");
});

Deno.test("stale retries are bounded, then escalate to needs-decision", async () => {
  const dossier = await approvedDossier();
  const queue = new FakeQueue();
  await queue.enqueue(dossier);
  queue.entries[0]!.attempts = 4;
  const publication = fakePublication({
    prepare: await preparedOutcome(dossier),
    publish: { status: "stale", headVersion: "commit:" + "9".repeat(40) },
  });
  const outcome = await worker(queue, publication, fakeRepository(), {
    maxAttempts: 5,
  }).runOnce(repositoryId);
  assert.equal(outcome.status, "needs-decision");
  if (outcome.status === "needs-decision") {
    assert.equal(outcome.error.code, "RETRY_BUDGET_EXHAUSTED");
  }
});

Deno.test("evolution acceptance survives queue serialization separately from owner authority", async () => {
  const proposal: ProposalRecord = {
    id: "66666666-6666-4666-8666-666666666666",
    branch: "proposal-evolution",
    author: "agent:preparer",
    reason: "Evolve instructions",
    baseVersion,
    createdAt: "now",
    status: "proposed",
    validation: "validated",
    sourceDigest: hex("e"),
    proposalVersion: "commit:" + "4".repeat(40),
    diff: [{
      path: "core.sysml",
      kind: "changed",
      before: "old",
      after: "new",
    }],
  };
  const evolutionDecision = {
    act: "accept" as const,
    operatorNativeId: "acceptor",
    systemQualifiedName: "System",
    authorityDigest: hex("a"),
    policyId: "evolution-policy",
    policyRevision: 1,
    mandateNativeId: "mandate-native",
    mandateId: "mandate",
    mandateRevision: 1,
    targets: ["target"],
    categories: ["instructions" as const],
    proposalDigest: hex("b"),
  };
  const dossier = await buildAcceptProposalCommand({
    repositoryId,
    proposal,
    expectedVersion: baseVersion,
    author: "agent:acceptor",
    baseSourceDigest: hex("d"),
    recipeDigest: hex("b"),
    evolutionDecision,
  });
  const legacy = await buildAcceptProposalCommand({
    repositoryId,
    proposal,
    expectedVersion: baseVersion,
    author: "agent:acceptor",
    baseSourceDigest: hex("d"),
    recipeDigest: hex("b"),
  });
  assert(!Object.hasOwn(legacy.decision, "evolutionDecision"));
  assert.notEqual(
    await modelWriteCommandDigest(dossier.command),
    await modelWriteCommandDigest(legacy.command),
  );
  const queue = new FakeQueue();
  await queue.enqueue(JSON.parse(JSON.stringify(dossier)));
  const repo = fakeRepository();
  repo.proposalRecord = proposal;
  assert.equal(
    (await worker(queue, fakePublication(), repo).runOnce(repositoryId)).status,
    "published",
  );
  assert.deepEqual(repo.acceptInput?.evolutionDecision, evolutionDecision);
  assert.equal(repo.acceptInput?.decisionAuthorityExercise, undefined);
});
