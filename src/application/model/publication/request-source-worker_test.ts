import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import { ModelWriteQueueError } from "./write-queue.ts";
import {
  isRequestSourceSettlementUnavailable,
  ModelRepositoryInspectionUnavailableError,
} from "./request-source-context.ts";
import { ModelBuildServiceError } from "../builds/service.ts";
import { isRequestSourceProofUnavailable } from "./request-source-context.ts";
import { ModelRepositoryError } from "../repository.ts";
import { RequestSourceOwnerError } from "../source-admission/request-source-owner.ts";
import assert from "node:assert/strict";
import { requestPublicationFixture } from "../../../../test/support/request-source-publication-fixture.ts";
import { ModelWriteWorker } from "./write-queue.ts";
import { QueuedModelWriter } from "./queued-writer.ts";
import {
  RequestSourcePublicationPending,
  type RequestSourceWriteFacade,
  type RequestSourceWriteResolver,
} from "./ports/out/request-source-publication.port.ts";
import type {
  ModelWriteQueueEntry,
  ModelWriteQueuePort,
  SettleOutcome,
  WriteLease,
} from "./ports/out/model-write-queue.port.ts";
import { buildOperationJournal } from "../../../domain/model/editing/write-command.ts";
import {
  buildModelWriteDossierV2,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
  type ModelWriteDossierV2,
} from "./write-command-v2.ts";

async function harness(input?: ModelWriteDossierV2) {
  const fixture = await requestPublicationFixture(),
    revision = fixture.revision,
    dossier = input ?? fixture.dossier;
  let entry: ModelWriteQueueEntry = {
    command: dossier.command,
    commandDigest: await modelWriteCommandDigestV2(dossier.command),
    dossierDigest: await modelWriteDossierDigestV2(dossier),
    state: "queued",
    enqueuedAt: "now",
    updatedAt: "now",
    attempts: 12,
    fence: 1,
  };
  const lease: WriteLease = {
    repositoryId: dossier.command.repositoryId,
    commandId: dossier.command.commandId,
    owner: "worker",
    fence: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const events: string[] = [], outcomes: SettleOutcome[] = [];
  const forbidden = () => {
    events.push("MAIN");
    return Promise.reject(new Error("Main must never be touched"));
  };
  const queue: ModelWriteQueuePort = {
    enqueue: () => Promise.resolve({ status: "duplicate", entry }),
    acquire: () =>
      Promise.resolve(
        entry.state === "published" ? null : { entry, dossier, lease },
      ),
    getDossier: () => Promise.resolve(dossier),
    get: () => Promise.resolve(entry),
    list: () => Promise.resolve([entry]),
    heartbeat: () => Promise.resolve(),
    recoverExpired: () => Promise.resolve(0),
    guardPublication: forbidden,
    transition: (_lease, state) => {
      events.push(state);
      entry = { ...entry, state };
      return Promise.resolve();
    },
    settle: (_lease, outcome) => {
      outcomes.push(outcome);
      entry = {
        ...entry,
        state: outcome.status,
        ...(outcome.status === "published"
          ? { publishedVersion: outcome.version }
          : {}),
      };
      return Promise.resolve();
    },
  };
  let anchored = false;
  const facade: RequestSourceWriteFacade = {
    destination: dossier.command.destination,
    at: forbidden,
    current: forbidden,
    proposal: forbidden,
    recover: () => {
      events.push("recover");
      return Promise.resolve(anchored ? revision : null);
    },
    accept: () => {
      events.push("fresh-D1-and-accept");
      anchored = true;
      return Promise.resolve(revision);
    },
  };
  const resolver: RequestSourceWriteResolver = {
    resolve: () => {
      events.push("bind");
      return Promise.resolve(facade);
    },
  };
  const worker = new ModelWriteWorker({
    queue,
    repository: {
      current: forbidden,
      proposal: forbidden,
      accept: forbidden,
      findPublicationByCommand: forbidden,
    },
    publication: { prepare: forbidden, publish: forbidden },
    owner: "worker",
    requestSources: resolver,
    recipeDigest: () => {
      events.push("recipe");
      return Promise.resolve(dossier.command.recipeDigest);
    },
  });
  return {
    ...fixture,
    dossier,
    facade,
    resolver,
    worker,
    queue,
    events,
    outcomes,
    setAnchored: () => {
      anchored = true;
    },
    setPublished: () => {
      entry = {
        ...entry,
        state: "published",
        publishedVersion: revision.version,
      };
    },
  };
}
Deno.test("Request worker binds before recovery and every new effect, without Main reads", async () => {
  const h = await harness();
  assert.equal(
    (await h.worker.runOnce(h.dossier.command.repositoryId)).status,
    "published",
  );
  assert.deepEqual(h.events, [
    "bind",
    "recover",
    "recipe",
    "publishing",
    "fresh-D1-and-accept",
    "recover",
  ]);
});
Deno.test("historical Request recovery precedes fresh credential and recipe checks", async () => {
  const h = await harness();
  h.setAnchored();
  h.facade.accept = () =>
    Promise.reject(
      new Error("revoked authority must not be freshly exercised"),
    );
  assert.equal(
    (await h.worker.runOnce(h.dossier.command.repositoryId)).status,
    "published",
  );
  assert.deepEqual(h.events, ["bind", "recover"]);
});
Deno.test("Git pending admission remains recoverable beyond ordinary retry budget", async () => {
  const h = await harness();
  h.facade.accept = () =>
    Promise.reject(
      new RequestSourcePublicationPending(new Error("SQL rollback after Git")),
    );
  assert.equal(
    (await h.worker.runOnce(h.dossier.command.repositoryId)).status,
    "retryable",
  );
  assert.equal(h.outcomes[0].status, "retryable");
  assert(!h.events.includes("MAIN"));
});
Deno.test("published Request resume requires expected destination and exact settled historical proof", async () => {
  const h = await harness();
  h.setPublished();
  h.setAnchored();
  const never = () =>
    Promise.reject(new Error("Main/compiler must not be touched"));
  const writer = new QueuedModelWriter(
    h.dossier.command.repositoryId,
    h.queue,
    h.worker,
    { compile: never, recipe: never },
    { at: never },
    h.resolver,
  );
  await assert.rejects(
    () => writer.resume(h.dossier.command.commandId),
    /exact stored dossier/,
  );
  const wrong = { ...h.dossier.command.destination, caseId: "foreign-case" };
  await assert.rejects(() =>
    writer.resume(h.dossier.command.commandId, undefined, wrong)
  );
  assert.equal(
    (await writer.resume(
      h.dossier.command.commandId,
      undefined,
      h.dossier.command.destination,
    ))?.version,
    h.revision.version,
  );
  assert.deepEqual(h.events, ["bind", "recover"]);
  await writer.close();
});

Deno.test("codec-valid but unsupported Request host-edit route refuses before resolver or Main lookup", async () => {
  const { dossier } = await requestPublicationFixture();
  const unsupported = await buildModelWriteDossierV2({
    ...dossier.command,
    authority: dossier.authority,
    decision: dossier.decision,
    operations: {
      kind: "host-edits",
      journal: buildOperationJournal({
        base: dossier.command.approvedBase,
        baseSourceDigest:
          dossier.command.destination.expectedAdmittedSource.sourceDigest,
        edits: [{
          op: "setFeatureValue",
          format: 1,
          target: {
            id: "instruction",
            qualifiedName: "Sys::instruction",
            metaclass: "AttributeUsage",
            preimage: "a".repeat(64),
          },
          value: "new",
        }],
      }),
    },
  });
  const h = await harness(unsupported);
  assert.equal(
    (await h.worker.runOnce(unsupported.command.repositoryId)).status,
    "refused",
  );
  assert.deepEqual(h.events, []);
});

Deno.test("an unanchored Request command refuses fresh revoked owner authority before any effect", async () => {
  const h = await harness();
  h.facade.accept = () =>
    Promise.reject(new RequestSourceOwnerError("revoked-current-session"));
  assert.equal(
    (await h.worker.runOnce(h.dossier.command.repositoryId)).status,
    "refused",
  );
  assert.deepEqual(h.events, ["bind", "recover", "recipe", "publishing"]);
  assert.equal(h.outcomes[0].status, "refused");
});

Deno.test("unavailable Request proof cannot exhaust retries before historical presence is resolved", async () => {
  const h = await harness();
  h.facade.recover = () =>
    Promise.reject(
      new ModelBuildServiceError("BUILD_UNAVAILABLE", {
        reason: "retained store offline",
      }, "retained store unavailable"),
    );
  assert.equal(
    (await h.worker.runOnce(h.dossier.command.repositoryId)).status,
    "retryable",
  );
  assert.equal(h.outcomes[0].status, "retryable");
  assert.deepEqual(h.events, ["bind"]);
  assert.equal(
    isRequestSourceProofUnavailable(
      new ModelBuildServiceError(
        "BUILD_CORRUPT",
        { reason: "wrong bytes" },
        "wrong bytes",
      ),
    ),
    false,
  );
  assert.equal(
    isRequestSourceProofUnavailable(
      new ModelRepositoryError("SOURCE_CONFLICT", "wrong immutable lineage"),
    ),
    false,
  );
  assert.equal(
    isRequestSourceProofUnavailable(
      new ModelRepositoryError("EDIT_SCOPE_DENIED", "native grant refused"),
    ),
    false,
  );
});

Deno.test("contradictory immutable Request proof refuses instead of masquerading as unavailable", async () => {
  const h = await harness();
  h.facade.recover = () =>
    Promise.reject(
      new ModelRepositoryError(
        "SOURCE_CONFLICT",
        "publication is only a second parent",
      ),
    );
  assert.equal(
    (await h.worker.runOnce(h.dossier.command.repositoryId)).status,
    "refused",
  );
  assert.deepEqual(h.events, ["bind"]);
});

Deno.test("actual D2, fence, build materialization and Git corruption error shapes are not temporary settlement", async () => {
  const conflicts = [
    new RequestSpaceError(
      "OPENING_CONFLICT",
      "The Request source admission changed.",
    ),
    new RequestSpaceError(
      "UNAVAILABLE",
      "The admitted Request source history is unavailable.",
    ),
    new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
      reason: "locked dossier differs",
    }, "locked dossier differs"),
    new ModelBuildServiceError("BUILD_MATERIALIZATION_INCOMPATIBLE", {
      reason: "materialized model disagrees with descriptor/artifact",
      artifactDigest: "a".repeat(64),
    }, "Materialized model does not match the verified artifact"),
    new ModelRepositoryError(
      "INVALID_REPOSITORY",
      "Local Git show failed: fatal: bad object deadbeef",
    ),
    new ModelRepositoryError(
      "INVALID_REPOSITORY",
      "Local Git rev-list failed: fatal: object corrupt",
    ),
  ];
  for (const conflict of conflicts) {
    assert.equal(isRequestSourceSettlementUnavailable(conflict), false);
    const h = await harness();
    h.facade.recover = () => Promise.reject(conflict);
    assert.equal(
      (await h.worker.runOnce(h.dossier.command.repositoryId)).status,
      "refused",
    );
    assert.deepEqual(h.events, ["bind"]);
  }
  const fence = new ModelWriteQueueError("WRITE_FENCE_LOST", {
    reason: "old owner",
  }, "old owner");
  assert.equal(isRequestSourceSettlementUnavailable(fence), false);
  const h = await harness();
  h.facade.recover = () => Promise.reject(fence);
  assert.equal(
    (await h.worker.runOnce(h.dossier.command.repositoryId)).status,
    "fence-lost",
  );
  assert.deepEqual(h.outcomes, []);
  assert.equal(
    isRequestSourceSettlementUnavailable(new Error("unknown failure")),
    false,
  );
  assert.equal(
    isRequestSourceSettlementUnavailable(
      new ModelRepositoryInspectionUnavailableError(
        "git-executable",
        "Local Git executable could not be started",
      ),
    ),
    true,
  );
  assert.equal(
    isRequestSourceSettlementUnavailable(
      new ModelWriteQueueError("WRITE_QUEUE_UNAVAILABLE", {
        reason: "connection unavailable",
      }, "connection unavailable"),
    ),
    true,
  );
});
