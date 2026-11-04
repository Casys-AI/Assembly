import assert from "node:assert/strict";
import { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import type { Prisma, PrismaClient } from "./client.ts";
import type {
  AdmittedSourceChain,
  PostgresRequestSourceAdmissionStore,
} from "./request-source-admission-store.ts";
import type {
  RequestAdoptionManifest,
  RequestAdoptionReceipt,
  RequestExecutionBinding,
} from "../../../application/model/evolution/request-adoption-ports.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import {
  requestControlState,
  requestOpeningBase,
  requestSpaceScope,
  spaceControlAuthority,
} from "../../../../test/support/request-space-fixture.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { requestSpaceDigest } from "../../../domain/work/request-spaces.ts";
import { requestSpaceSeed } from "../../../application/work/runtime/initialization.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";

async function sourceContextFixture() {
  const base = await requestOpeningBase("c");
  const opening = {
    id: "opening",
    scope: requestSpaceScope,
    executionSpaceId: "branch",
    caseId: "case",
    caseNumber: 1,
    ownerId: "owner",
    branchId: "branch-id",
    admissionId: "admission",
    initialContributionId: "initial",
    base,
    baseDigest: await requestSpaceDigest(base),
    command: {
      openingKey: "opening-key",
      text: "Read a passage",
      source: { kind: "current-main" },
    },
    commandDigest: "command-digest",
    createdAt: "2026-11-02T00:00:00Z",
  } as OpeningRecord;
  let owner = requestControlState();
  const seed = requestSpaceSeed(opening);
  owner.id = seed.runtimeId;
  owner.cases = [{
    id: seed.caseId,
    number: seed.caseNumber,
    type: "request",
    caseTypeId: seed.caseTypeId,
    objective: seed.text,
    owner: "operator",
    openedBy: seed.openedBy,
    createdAt: seed.createdAt,
    status: "open",
    openedFrom: {
      conversationId: seed.runtimeId,
      openingId: seed.openingId,
      messageId: seed.initialContributionId,
    },
    modelPin: {
      digest: owner.executionModel!.version.digest,
      repositoryVersion: owner.executionModel!.version.repositoryVersion,
    },
  }];
  let member = structuredClone(owner);
  member.id = "request:branch:member";
  member.cases = [];
  member.executionModel!.identity.builderId = "member";
  member.executionModel!.identity.systemId = "member-system";
  member.executionModel!.version.digest = "e".repeat(64);
  member.executionModel!.operatorTeam = {
    requestId: "case",
    requestOwnerId: "operator",
    parentOperatorId: "operator",
  };
  member.model = structuredClone(member.executionModel!.identity);
  // Both expected states represent persisted JSON, including its omission of
  // undefined optional model fields, before the reader decodes them.
  owner = JSON.parse(JSON.stringify(owner));
  member = JSON.parse(JSON.stringify(member));
  const requester = {
    projectId: member.executionModel!.identity.projectId,
    systemId: "member-system",
    executionSpaceId: "branch",
    operatorId: "member",
  };
  const source = {
    repositoryId: base.manifest.source!.repositoryId,
    version: base.manifest.source!.sourceVersion,
  };
  const pin = {
    source,
    modelDigest: owner.executionModel!.version.digest,
    sourceAdmission: { revision: 1, manifestDigest: base.manifestDigest },
    adoption: null,
  };
  const chain = {
    baseline: {
      revision: 1,
      manifestDigest: base.manifestDigest,
      source,
      sourceDigest: "c".repeat(64),
    },
    head: {
      revision: 1,
      manifestDigest: base.manifestDigest,
      source,
      sourceDigest: "c".repeat(64),
    },
    receipts: [],
    softwareReceipts: [],
    cursor: { revision: 1, digest: base.manifestDigest },
    execution: {
      pin,
      softwareAdoptions: [],
      adoptions: [{
        manifest: {
          intent: {
            target: { operatorId: "operator" },
            candidate: { source, sourceAdmission: pin.sourceAdmission },
            team: {
              team: [{
                operatorId: "member",
                modelDigest: member.executionModel!.version.digest,
              }],
            },
          },
        },
        receipt: {},
      }],
    },
  } as unknown as AdmittedSourceChain;
  const admission = {
    id: "admission",
    ...requestSpaceScope,
    executionSpaceId: "branch",
    openingId: "opening",
    ownerId: "owner",
    capabilityId: "capability",
    capabilityRevision: 0,
    baseDigest: opening.baseDigest,
    authorityJson: JSON.stringify(spaceControlAuthority()),
    permissionsJson: JSON.stringify({
      operatorIds: ["operator", "member"],
      modelDigests: [pin.modelDigest, member.executionModel!.version.digest],
      sourceVersion: source.version,
      acts: ["conversation"],
      resourceIds: [],
    }),
    revision: 0,
    status: "active",
    expiresAt: new Date("2099-01-01T00:00:00Z"),
    createdAt: new Date(opening.createdAt),
  };
  const actorReads: string[] = [];
  const stateFor = (operatorId: string) =>
    operatorId === "operator" ? owner : member;
  const row = (state: SystemRuntimeState) => ({
    revision: BigInt(state.revision),
    payload: JSON.stringify(state),
  });
  const tx = {
    spaceOpening: {
      findUnique: () =>
        Promise.resolve({
          ...opening,
          baseJson: canonical(base),
          commandJson: canonical(opening.command),
        }),
    },
    executionSpace: {
      findUnique: () =>
        Promise.resolve({
          caseId: "case",
          parentExecutionSpaceId: "main",
          lifecycle: "active",
          closedAt: null,
        }),
    },
    runtimeState: {
      findFirst: ({ where }: { where: { operatorId: string } }) => {
        actorReads.push(where.operatorId);
        return Promise.resolve(row(stateFor(where.operatorId)));
      },
    },
    runtimeRevision: {
      findFirst: ({ where }: { where: { operatorId: string } }) => {
        const state = stateFor(where.operatorId);
        return Promise.resolve({
          ...row(state),
          runtimeStateId: state.id,
          catalogRevision: 0n,
          eventCount: 0n,
          modelPayload: JSON.stringify(state.model),
          label: "Révision 0",
          agentCount: 1n,
          activeToolCount: 0n,
          origin: "commit",
        });
      },
    },
    spaceExecutionAdmission: { findFirst: () => Promise.resolve(admission) },
  } as unknown as Prisma.TransactionClient;
  let transactions = 0, journalReads = 0;
  const reader = new PostgresRequestExecutionBindingReader(
    {
      $transaction: (
        run: (selected: Prisma.TransactionClient) => Promise<unknown>,
        options: { isolationLevel: string },
      ) => {
        transactions++;
        assert.equal(options.isolationLevel, "RepeatableRead");
        return run(tx);
      },
    } as unknown as PrismaClient,
    requestSpaceScope,
    {
      readAdmittedSource: (selected: Prisma.TransactionClient) => {
        assert.equal(selected, tx);
        journalReads++;
        return Promise.resolve(structuredClone(chain));
      },
    } as unknown as PostgresRequestSourceAdmissionStore,
  );
  return {
    reader,
    opening,
    requester,
    owner,
    member,
    chain,
    actorReads,
    transactions: () => transactions,
    journalReads: () => journalReads,
  };
}

Deno.test("member source snapshot folds one journal for strict requester and BO bindings in one transaction", async () => {
  const f = await sourceContextFixture();
  const snapshot = await f.reader.readSourceContext(f.opening, f.requester);
  assert.equal(f.transactions(), 1);
  assert.equal(f.journalReads(), 1);
  assert.deepEqual(f.actorReads.sort(), ["member", "operator"]);
  assert.deepEqual(snapshot.binding.state, f.member);
  assert.deepEqual(snapshot.ownerState, f.owner);
  assert.deepEqual(snapshot.chain, f.chain);
  snapshot.binding.state.messages.push({
    id: "changed",
    role: "user",
    text: "owned",
    at: "now",
  });
  snapshot.ownerState.messages.push({
    id: "changed-owner",
    role: "user",
    text: "owned",
    at: "now",
  });
  const next = await f.reader.readSourceContext(f.opening, f.requester);
  assert.equal(f.transactions(), 2);
  assert.equal(
    f.journalReads(),
    2,
    "a separate call never reuses its predecessor's chain",
  );
  assert.deepEqual(next.binding.state.messages, []);
  assert.deepEqual(next.ownerState.messages, []);
  assert.notEqual(next.chain, snapshot.chain);
});

Deno.test("member source snapshot retains strict BO validation", async () => {
  const f = await sourceContextFixture();
  f.owner.cases![0].owner = "foreign-owner";
  await assert.rejects(
    () => f.reader.readSourceContext(f.opening, f.requester),
    { code: "UNAVAILABLE" },
  );
});

Deno.test("member source snapshot refuses a mismatched requester identity", async () => {
  const f = await sourceContextFixture();
  await assert.rejects(
    () =>
      f.reader.readSourceContext(f.opening, {
        ...f.requester,
        systemId: "foreign-system",
      }),
    { code: "UNAVAILABLE" },
  );
});

async function fixture() {
  const f = await requestAdoptionFixture();
  const base = await requestOpeningBase();
  base.requestOwner.operatorId = f.target.operatorId;
  base.manifest.registeredOperatorIds = [f.target.operatorId];
  base.manifest.operators[0].operatorId = f.target.operatorId;
  base.manifestDigest = await requestSpaceDigest(base.manifest);
  const opening = {
    id: f.target.openingId,
    scope: f.target.host,
    executionSpaceId: f.target.executionSpaceId,
    base,
  } as OpeningRecord;
  const birth = {
    manifest: {
      intent: {
        ...f.intent,
        team: { team: [{ operatorId: "member", modelDigest: "c".repeat(64) }] },
      },
    } as unknown as RequestAdoptionManifest,
    receipt: {} as RequestAdoptionReceipt,
  };
  const execution = { pin: f.intent.previous.pin, adoptions: [birth] };
  const owner = {
    admission: {
      ...f.intent.previous.admission,
      permissions: {
        ...f.intent.previous.admission.permissions,
        operatorIds: [f.target.operatorId, "member"],
        modelDigests: [f.intent.previous.pin.modelDigest, "c".repeat(64)],
      },
    },
  } as RequestExecutionBinding;
  let row: unknown = null;
  let history: unknown = null;
  const tx = {
    runtimeState: { findFirst: () => Promise.resolve(row) },
    runtimeRevision: { findFirst: () => Promise.resolve(history) },
  } as unknown as Prisma.TransactionClient;
  const journal = {
    readAdmittedSource: () => Promise.resolve({ execution }),
  } as unknown as PostgresRequestSourceAdmissionStore;
  let strictReads = 0;
  const requesters: unknown[] = [];
  class Reader extends PostgresRequestExecutionBindingReader {
    override readInTransaction(
      ...input: Parameters<
        PostgresRequestExecutionBindingReader["readInTransaction"]
      >
    ) {
      strictReads++;
      requesters.push(input[2]);
      return Promise.resolve(owner);
    }
  }
  const reader = new Reader({} as PrismaClient, f.target.host, journal);
  return {
    f,
    opening,
    execution,
    owner,
    tx,
    reader,
    row: (value: unknown) => row = value,
    history: (value: unknown) => history = value,
    strictReads: () => strictReads,
    requesters,
  };
}

Deno.test("team admission can inspect a verified newborn before its runtime initializes", async () => {
  const f = await fixture();
  assert.equal(
    await f.reader.readInitializedOperatorInTransaction(
      f.tx,
      f.opening,
      "member",
    ),
    null,
  );
  assert.equal(f.strictReads(), 1, "the existing owner binding stays verified");
  await assert.rejects(
    f.reader.readOperatorInTransaction(f.tx, f.opening, "member"),
    { code: "UNAVAILABLE" },
  );
  assert.equal(
    await f.reader.readInitializedOperatorInTransaction(
      f.tx,
      f.opening,
      f.f.target.operatorId,
    ),
    f.owner,
  );
});

Deno.test("missing team states require birth and exact admission, never hide adopted members", async () => {
  const f = await fixture();
  await assert.rejects(
    f.reader.readInitializedOperatorInTransaction(f.tx, f.opening, "outsider"),
    { code: "UNAVAILABLE" },
  );
  f.owner.admission.permissions.modelDigests[1] = "wrong";
  await assert.rejects(
    f.reader.readInitializedOperatorInTransaction(f.tx, f.opening, "member"),
    { code: "UNAVAILABLE" },
  );
  f.owner.admission.permissions.modelDigests[1] = "c".repeat(64);
  f.history({ revision: 0n });
  await assert.rejects(
    f.reader.readInitializedOperatorInTransaction(f.tx, f.opening, "member"),
    { code: "UNAVAILABLE" },
  );
  f.history(null);
  f.execution.adoptions.push({
    manifest: {
      ...f.execution.adoptions[0].manifest,
      intent: {
        ...f.f.intent,
        target: { ...f.f.target, operatorId: "member" },
      },
    },
    receipt: {} as RequestAdoptionReceipt,
  });
  await assert.rejects(
    f.reader.readInitializedOperatorInTransaction(f.tx, f.opening, "member"),
    { code: "UNAVAILABLE" },
  );
});

Deno.test("initialized team reads retain corrupt-state failures", async () => {
  const f = await fixture();
  f.row({ revision: 0n, payload: "{}" });
  await assert.rejects(
    f.reader.readInitializedOperatorInTransaction(f.tx, f.opening, "member"),
    /Invalid/,
  );
  const model = structuredClone(f.f.model);
  model.identity.builderId = "member";
  const state = {
    id: "member-runtime",
    revision: 0,
    catalogRevision: 0,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "ready",
    provider: "controlled",
    executionModel: model,
  };
  f.row({ revision: 0n, payload: JSON.stringify(state) });
  assert.equal(
    await f.reader.readInitializedOperatorInTransaction(
      f.tx,
      f.opening,
      "member",
    ),
    f.owner,
  );
  assert.deepEqual(f.requesters, [{
    projectId: model.identity.projectId,
    systemId: model.identity.systemId,
    executionSpaceId: f.opening.executionSpaceId,
    operatorId: "member",
  }], "an existing member still goes through the exact scoped binding read");
});
