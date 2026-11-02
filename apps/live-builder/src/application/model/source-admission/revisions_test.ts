/** Application port doubles only: no native authority/Git/SQL success claim. */
import type { RequestSourceOwnerAuthorityEnvelope } from "./request-source-owner.ts";
import assert from "node:assert/strict";
import {
  type ProposeRequestSourceRevision,
  RequestSourceRevisions,
} from "./revisions.ts";
import type { RequestSourceRevisionsOptions } from "./revision-ports.ts";
import { requestPublicationFixture } from "../../../../test/support/request-source-publication-fixture.ts";
import {
  buildModelWriteDossierV2,
  isScopedSoftwareWriteDossier,
  type VersionedModelWriteDossier,
} from "../publication/write-command-v2.ts";
import {
  versionedWriteCommandDigest,
  versionedWriteDossierDigest,
} from "../publication/versioned-dossier.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import { RequestSourceOwnerError } from "./request-source-owner.ts";
import {
  buildAcceptProposalCommand,
  ModelWriteQueueError,
} from "../publication/write-queue.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../domain/model/records/revision.ts";

async function harness() {
  const f = await requestPublicationFixture(),
    sources = { "core.sysml": "before" };
  const destination = {
    ...f.dossier.command.destination,
    expectedAdmittedSource: {
      ...f.dossier.command.destination.expectedAdmittedSource,
      sourceDigest: await modelSourceDigest(sources),
    },
  };
  const human = f.dossier.authority as RequestSourceOwnerAuthorityEnvelope;
  const authority = {
    ...human,
    proposal: { ...human.proposal, destination },
    acceptance: { ...human.acceptance, destination },
  };
  const dossier = await buildModelWriteDossierV2({
    ...f.dossier.command,
    destination,
    authority,
    operations: {
      kind: "whole-files",
      files: {
        v: 1,
        base: destination.expectedAdmittedSource.source,
        baseSourceDigest: destination.expectedAdmittedSource.sourceDigest,
        files: [{
          path: "core.sysml",
          baseDigest: f.dossier.operations.kind === "whole-files"
            ? f.dossier.operations.files.files[0].baseDigest
            : null,
          text: "after",
        }],
      },
    },
    decision: f.dossier.decision,
  });
  const record: ProposalRecord = {
    id: dossier.command.commandId,
    branch: `proposal_${dossier.command.commandId}`,
    author: "local-owner",
    reason: "Owned instructions",
    baseVersion: dossier.command.approvedBase.version,
    createdAt: "2026-10-30T01:00:00.000Z",
    status: "proposed",
    validation: "validated",
    sourceDigest: "e".repeat(64),
    proposalVersion: `commit:${"d".repeat(40)}`,
    diff: [{
      path: "core.sysml",
      kind: "changed",
      before: "before",
      after: "after",
    }],
  };
  const current: ModelRevision = {
    ...f.revision,
    sources,
    sourceDigest: destination.expectedAdmittedSource.sourceDigest,
    version: destination.expectedAdmittedSource.source.version,
  };
  const state = {
    raw: null as VersionedModelWriteDossier | null,
    targetCurrent: current,
    newEffectsAllowed: true,
    proposalMissing: false,
    loseEnqueueAck: false,
    secretValid: true,
    captures: 0,
    enqueues: 0,
  };
  const events: string[] = [], resumed: typeof destination[] = [];
  const readController = {
    ...authority.acceptance.principal.controller,
    sessionId: "current-read-session",
  };
  const denied = () => {
    throw new RequestSourceOwnerError("new-authority-must-not-be-exercised");
  };
  const options: RequestSourceRevisionsOptions = {
    repositoryId: destination.repositoryId,
    access: {
      authorizeRead: (_secret, caseId) => {
        events.push("read-auth");
        assert.equal(caseId, destination.caseId);
        if (!state.secretValid) throw new Error("expired current read session");
        return Promise.resolve(structuredClone(readController));
      },
      assertOwnedDestination: (_controller, caseId, target) => {
        events.push("owned");
        assert.equal(caseId, destination.caseId);
        assert.equal(target.caseId, caseId);
        return Promise.resolve();
      },
      revalidateRead: () => {
        events.push("read-revalidate");
        return state.secretValid
          ? Promise.resolve()
          : Promise.reject(new Error("expired current read session"));
      },
    },
    authorization: {
      captureProposal: () => {
        events.push("capture-proposal");
        if (!state.newEffectsAllowed) denied();
        return Promise.resolve(structuredClone(authority.proposal));
      },
      captureAcceptance: (_secret, stored) => {
        events.push("capture-acceptance");
        assert.deepEqual(stored, authority.proposal);
        if (!state.newEffectsAllowed) denied();
        state.captures++;
        return Promise.resolve({
          ...structuredClone(authority),
          acceptance: {
            ...structuredClone(authority.acceptance),
            capturedAt: `2026-10-30T01:0${state.captures}:00.000Z`,
          },
        });
      },
      revalidateProposal: () => {
        events.push("fresh-proposal");
        if (!state.newEffectsAllowed) denied();
        return Promise.resolve();
      },
      revalidateAcceptance: () => {
        events.push("fresh-acceptance");
        if (!state.newEffectsAllowed) denied();
        return Promise.resolve();
      },
    },
    targetForProposal: (binding) => {
      events.push("target");
      assert.deepEqual(binding, authority.proposal);
      return Promise.resolve({
        destination,
        current: () => {
          events.push("physical-read");
          return Promise.resolve(structuredClone(state.targetCurrent));
        },
        proposal: () =>
          Promise.reject(new Error("fresh proposal lookup not expected")),
        bind: () =>
          Promise.reject(new Error("publication not performed by producer")),
        propose: (input) => {
          events.push("propose");
          assert.deepEqual(input.sources, { "core.sysml": "after" });
          return Promise.resolve({
            ...record,
            requestSource: { authority: input.authority },
          });
        },
      });
    },
    readProposal: () => {
      events.push("proposal-read");
      return Promise.resolve(
        state.proposalMissing ? null : {
          record: structuredClone(record),
          authority: structuredClone(authority.proposal),
          destination: structuredClone(destination),
        },
      );
    },
    queue: {
      get: () => Promise.resolve(null),
      getDossier: () => {
        events.push("stored-command");
        return Promise.resolve(state.raw ? structuredClone(state.raw) : null);
      },
      enqueue: async (input) => {
        events.push("enqueue");
        if (state.raw && canonical(input) !== canonical(state.raw)) {
          throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
            reason: "concurrent first winner",
          }, "concurrent first winner");
        }
        state.raw ??= structuredClone(input);
        state.enqueues++;
        if (state.loseEnqueueAck) {
          state.loseEnqueueAck = false;
          throw new Error("lost enqueue acknowledgement");
        }
        assert.equal(input.v, 2);
        const entry = {
          command: input.command,
          commandDigest: await versionedWriteCommandDigest(input.command),
          dossierDigest: await versionedWriteDossierDigest(input),
          state: "queued" as const,
          enqueuedAt: "now",
          updatedAt: "now",
          attempts: 0,
          fence: 0,
        };
        return { status: "queued", entry };
      },
    },
    writer: {
      repositoryId: destination.repositoryId,
      recipeDigest: () => {
        events.push("recipe");
        if (!state.newEffectsAllowed) denied();
        return Promise.resolve(dossier.command.recipeDigest);
      },
      resume: (_id, approval, target) => {
        events.push("resume");
        assert.equal(approval, undefined);
        assert.deepEqual(target, destination);
        resumed.push(structuredClone(target!));
        return Promise.resolve(structuredClone(f.revision));
      },
    },
  };
  return {
    f,
    dossier,
    authority,
    destination,
    record,
    current,
    state,
    events,
    resumed,
    options,
    service: new RequestSourceRevisions(options),
  };
}
Deno.test("Request source producer snapshots bounded edits, derives A0 sources and strips authority from proposal view", async () => {
  const h = await harness();
  const input = {
    caseId: h.destination.caseId,
    expectedVersion: String(
      h.destination.expectedAdmittedSource.source.version,
    ),
    changes: [{ path: "core.sysml", text: "after" }],
    reason: "Instructions only",
  };
  const pending = h.service.propose("valid", input);
  input.changes[0].text = "mutated alias";
  input.expectedVersion = `commit:${"f".repeat(40)}`;
  const proposal = await pending;
  assert.equal(proposal.id, h.record.id);
  assert.equal(proposal.proposalVersion, h.record.proposalVersion);
  assert(!("requestSource" in proposal));
  assert(!("authority" in proposal));
  assert.equal(h.state.enqueues, 0);
});
Deno.test("Git-pending A1 cannot replace D1 admitted A0 during fresh proposal", async () => {
  const h = await harness();
  h.state.targetCurrent = h.f.revision;
  await assert.rejects(() =>
    h.service.propose("valid", {
      caseId: h.destination.caseId,
      expectedVersion: h.destination.expectedAdmittedSource.source.version,
      changes: [{ path: "core.sysml", text: "after" }],
      reason: "unchanged A0 expected",
    })
  );
  assert(!h.events.includes("propose"));
  assert.equal(h.state.enqueues, 0);
});
Deno.test("lost enqueue ACK then reconnect reuses original A0 command without proposal, recipe or new authority", async () => {
  const h = await harness(),
    command = { caseId: h.destination.caseId, proposalId: h.record.id };
  h.state.loseEnqueueAck = true;
  await assert.rejects(
    () => h.service.accept("old-session", command),
    /lost enqueue acknowledgement/,
  );
  assert(h.state.raw);
  const accepted = canonical(h.state.raw);
  h.state.proposalMissing = true;
  h.state.newEffectsAllowed = false;
  h.state.targetCurrent = h.f.revision;
  h.events.length = 0;
  assert.deepEqual(await h.service.accept("reconnected-session", command), {
    caseId: command.caseId,
    commandId: command.proposalId,
  });
  assert.equal(
    (await h.service.resume("reconnected-session", {
      caseId: command.caseId,
      commandId: command.proposalId,
    }))?.version,
    h.f.revision.version,
  );
  assert.equal(canonical(h.state.raw), accepted);
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.enqueues, 1);
  assert(
    !h.events.some((event) =>
      ["proposal-read", "capture-acceptance", "recipe", "physical-read"]
        .includes(event)
    ),
  );
});
Deno.test("fresh acceptance independently captures original proposal and enqueues without executing publication", async () => {
  const h = await harness();
  assert.deepEqual(
    await h.service.accept("new-acceptance-session", {
      caseId: h.destination.caseId,
      proposalId: h.record.id,
    }),
    { caseId: h.destination.caseId, commandId: h.record.id },
  );
  assert.equal(h.state.captures, 1);
  assert.equal(h.state.enqueues, 1);
  assert(!h.events.includes("resume"));
  assert(
    h.events.indexOf("stored-command") < h.events.indexOf("capture-acceptance"),
  );
  assert(h.state.raw?.v === 2 && !isScopedSoftwareWriteDossier(h.state.raw));
  assert.deepEqual(
    (h.state.raw.authority as RequestSourceOwnerAuthorityEnvelope).proposal,
    h.authority.proposal,
  );
});
Deno.test("concurrent independent acceptances return the one durable exact command", async () => {
  const h = await harness(),
    input = { caseId: h.destination.caseId, proposalId: h.record.id };
  const handles = await Promise.all([
    h.service.accept("one", input),
    h.service.accept("two", input),
  ]);
  assert.deepEqual(handles[0], handles[1]);
  assert.equal(h.state.enqueues, 1);
  assert(h.state.raw?.v === 2);
});
Deno.test("expired read authorization prevents even historical command access; Main command never falls through", async () => {
  const h = await harness();
  h.state.secretValid = false;
  await assert.rejects(
    () =>
      h.service.resume("expired", {
        caseId: h.destination.caseId,
        commandId: h.record.id,
      }),
    /expired/,
  );
  assert.deepEqual(h.events, ["read-auth"]);
  h.state.secretValid = true;
  h.events.length = 0;
  h.state.raw = await buildAcceptProposalCommand({
    repositoryId: h.destination.repositoryId,
    proposal: h.record,
    expectedVersion: h.record.baseVersion,
    baseSourceDigest: h.destination.expectedAdmittedSource.sourceDigest,
    recipeDigest: h.dossier.command.recipeDigest,
    author: "local-owner",
  });
  await assert.rejects(() =>
    h.service.accept("valid", {
      caseId: h.destination.caseId,
      proposalId: h.record.id,
    })
  );
  assert(!h.events.includes("capture-acceptance"));
  assert(!h.events.includes("resume"));
});
Deno.test("fresh revoked authority refuses enqueue while existing command replay remains read-authorized", async () => {
  const h = await harness();
  h.state.newEffectsAllowed = false;
  await assert.rejects(
    () =>
      h.service.accept("valid-read", {
        caseId: h.destination.caseId,
        proposalId: h.record.id,
      }),
    /new-authority/,
  );
  assert.equal(h.state.enqueues, 0);
});
Deno.test("public Request source inputs refuse actor, destination, unsafe or duplicate edit paths", async () => {
  const h = await harness(),
    good = {
      caseId: h.destination.caseId,
      expectedVersion: h.destination.expectedAdmittedSource.source.version,
      changes: [{ path: "core.sysml", text: "after" }],
      reason: "bounded",
    };
  for (
    const input of [
      { ...good, expectedVersion: "main" },
      { ...good, actor: "local-owner" },
      { ...good, destination: h.destination },
      { ...good, changes: [{ path: "../outside.sysml", text: "after" }] },
      {
        ...good,
        changes: [{ path: "core.sysml", text: "after" }, {
          path: "CORE.sysml",
          text: null,
        }],
      },
    ]
  ) {
    await assert.rejects(() =>
      h.service.propose("valid", input as ProposeRequestSourceRevision)
    );
  }
  assert.deepEqual(h.events, []);
});

Deno.test("stale displayed source refuses before target or proposal effects", async () => {
  const h = await harness();
  await assert.rejects(() =>
    h.service.propose("valid", {
      caseId: h.destination.caseId,
      expectedVersion: `commit:${"f".repeat(40)}`,
      changes: [{ path: "core.sysml", text: "after" }],
      reason: "stale view",
    }), /differs from its owned immutable destination/);
  assert.deepEqual(h.events, ["read-auth", "capture-proposal"]);
  assert.equal(h.state.enqueues, 0);
});
