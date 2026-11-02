// deno-lint-ignore-file require-await -- Deterministic port doubles.
import assert from "node:assert/strict";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { modelWriteOperationsDigest } from "../../../domain/model/editing/write-command.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import {
  parseScopedSoftwareWriteDossier,
  scopedSoftwareWriteCommandDigest,
  scopedSoftwareWriteDossierDigest,
} from "./scoped-software-write.ts";
import {
  parseVersionedModelWriteCommand,
  parseVersionedModelWriteDossier,
} from "./write-command-v2.ts";
import {
  versionedWriteCommandDigest,
  versionedWriteDossierDigest,
} from "./versioned-dossier.ts";
import { ModelWriteWorker } from "./write-queue.ts";
import type { ModelWriteWorkerOptions } from "./write-queue.ts";
import type {
  ModelWriteQueuePort,
  SettleOutcome,
  WriteLease,
} from "./ports/out/model-write-queue.port.ts";

async function fixture() {
  const f = await requestAdoptionFixture();
  const { operatorId: _operatorId, ...locator } = f.target;
  const destination = {
    ...locator,
    expectedAdmittedSource: {
      revision: 1,
      source: f.intent.previous.pin.source,
      sourceDigest: "a".repeat(64),
    },
  };
  const operations = {
    kind: "whole-files" as const,
    files: {
      v: 1 as const,
      base: destination.expectedAdmittedSource.source,
      baseSourceDigest: destination.expectedAdmittedSource.sourceDigest,
      files: [{
        path: "models/main.sysml",
        baseDigest: null,
        text: "package Changed;",
      }],
    },
  };
  const proposalDigest = "b".repeat(64);
  const exercise = (act: "prepare" | "accept" | "adopt") => ({
    act,
    operatorNativeId: "owner",
    systemQualifiedName: "System",
    authorityDigest: "c".repeat(64),
    policyId: "policy",
    policyRevision: 1,
    mandateNativeId: "mandate",
    mandateId: "mandate",
    mandateRevision: 1,
    targets: [f.target.operatorId],
    categories: ["instructions"],
    proposalDigest,
  });
  const decision = {
    dossierId: "evolution",
    evolutionIntentDigest: "d".repeat(64),
    proposalDigest,
    preparation: exercise("prepare"),
    acceptance: exercise("accept"),
    adoptionAuthorization: exercise("adopt"),
  };
  const intent = {
    v: 2,
    kind: "publish-software-evolution",
    repositoryId: destination.repositoryId,
    commandId: "11111111-1111-4111-8111-111111111111",
    approvedBase: destination.expectedAdmittedSource.source,
    destination,
    operationsRef: { digest: await modelWriteOperationsDigest(operations) },
    decisionRef: {
      id: "11111111-1111-4111-8111-111111111111",
      digest: await sha256(canonical(decision)),
    },
    recipeDigest: "e".repeat(64),
    authorityRef: {
      kind: "software-evolution-scoped-authority/v2",
      digest: await sha256(canonical({
        format: "software-evolution-scoped-authority/v2",
        preparation: decision.preparation,
        acceptance: decision.acceptance,
        adoptionAuthorization: decision.adoptionAuthorization,
      })),
    },
  };
  const dossier = await parseScopedSoftwareWriteDossier({
    v: 2,
    kind: "software-evolution-scoped-publication",
    operations,
    decision,
    command: { ...intent, intentDigest: await sha256(canonical(intent)) },
  });
  return { dossier, destination };
}

Deno.test("versioned dispatch preserves the separate software grammar and hashes", async () => {
  const { dossier } = await fixture();
  assert.deepEqual(
    parseVersionedModelWriteCommand(dossier.command),
    dossier.command,
  );
  assert.deepEqual(await parseVersionedModelWriteDossier(dossier), dossier);
  assert.equal(
    await versionedWriteCommandDigest(dossier.command),
    await scopedSoftwareWriteCommandDigest(dossier.command),
  );
  assert.equal(
    await versionedWriteDossierDigest(dossier),
    await scopedSoftwareWriteDossierDigest(dossier),
  );
  const disguised = { ...dossier, kind: undefined };
  await assert.rejects(() => parseVersionedModelWriteDossier(disguised));
  assert.throws(() =>
    parseVersionedModelWriteCommand({
      ...dossier.command,
      kind: "accept-proposal",
    })
  );
});

async function workerFixture(
  recovered: boolean,
  withSoftware = true,
  confirm = true,
) {
  const { dossier, destination } = await fixture();
  const lease: WriteLease = {
    repositoryId: dossier.command.repositoryId,
    commandId: dossier.command.commandId,
    owner: "worker",
    fence: 1,
    expiresAt: "2026-11-01T00:00:00.000Z",
  };
  const entry = {
    command: dossier.command,
    commandDigest: await versionedWriteCommandDigest(dossier.command),
    dossierDigest: await versionedWriteDossierDigest(dossier),
    state: "preparing" as const,
    enqueuedAt: "2026-10-31T00:00:00.000Z",
    updatedAt: "2026-10-31T00:00:00.000Z",
    attempts: 0,
    fence: 1,
  };
  const settled: SettleOutcome[] = [], transitions: string[] = [];
  const queue: ModelWriteQueuePort = {
    enqueue: async () => ({ status: "duplicate", entry }),
    acquire: async () => ({ entry, dossier, lease }),
    heartbeat: async () => {},
    guardPublication: async (_lease, _ms, operation) => await operation(),
    transition: async (_lease, to) => {
      transitions.push(to);
    },
    settle: async (_lease, outcome) => {
      settled.push(outcome);
    },
    get: async () => entry,
    getDossier: async () => dossier,
    list: async () => [entry],
    recoverExpired: async () => 0,
  };
  const unexpected = () => {
    throw new Error("Main/human publication must not be reached");
  };
  let accepted = 0, recoveries = 0;
  const revision = { version: `commit:${"f".repeat(40)}` } as ModelRevision;
  const options: ModelWriteWorkerOptions = {
    queue,
    owner: "worker",
    repository: new Proxy({} as ModelWriteWorkerOptions["repository"], {
      get: unexpected,
    }),
    publication: { prepare: unexpected, publish: unexpected },
    requestSources: { resolve: unexpected },
    recipeDigest: async () => dossier.command.recipeDigest,
    ...(withSoftware
      ? {
        scopedSoftwareSources: {
          resolve: async (actual: typeof dossier) => {
            assert.deepEqual(actual, dossier);
            return {
              destination,
              recover: async (actualLease?: WriteLease) => {
                assert.deepEqual(actualLease, lease);
                recoveries++;
                return recovered || accepted > 0 && confirm ? revision : null;
              },
              accept: async (actualLease: WriteLease) => {
                assert.deepEqual(actualLease, lease);
                accepted++;
                return revision;
              },
            };
          },
        },
      }
      : {}),
  };
  return {
    worker: new ModelWriteWorker(options),
    dossier,
    settled,
    transitions,
    accepted: () => accepted,
    recoveries: () => recoveries,
  };
}

Deno.test("software worker publishes only through its explicit software facade and confirms its anchor", async () => {
  const f = await workerFixture(false);
  const outcome = await f.worker.runOnce(f.dossier.command.repositoryId);
  assert.equal(outcome.status, "published");
  assert.equal(f.accepted(), 1);
  assert.equal(f.recoveries(), 2);
  assert.deepEqual(f.transitions, ["publishing"]);
  assert.equal(f.settled[0].status, "published");
});

Deno.test("software worker recovers an exact historical effect without new acceptance", async () => {
  const f = await workerFixture(true);
  const outcome = await f.worker.runOnce(f.dossier.command.repositoryId);
  assert.equal(outcome.status, "published");
  assert.equal(f.accepted(), 0);
  assert.deepEqual(f.transitions, []);
});

Deno.test("software worker refuses a missing software resolver without falling through to human/Main", async () => {
  const f = await workerFixture(false, false);
  const outcome = await f.worker.runOnce(f.dossier.command.repositoryId);
  assert.equal(outcome.status, "refused");
  assert.equal(f.accepted(), 0);
  assert.deepEqual(f.transitions, []);
});

Deno.test("software worker never acknowledges an unconfirmed publication result", async () => {
  const f = await workerFixture(false, true, false);
  const outcome = await f.worker.runOnce(f.dossier.command.repositoryId);
  assert.equal(outcome.status, "refused");
  assert.equal(f.accepted(), 1);
  assert.equal(f.settled.some((entry) => entry.status === "published"), false);
});
