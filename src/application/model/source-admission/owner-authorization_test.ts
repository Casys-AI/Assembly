import { mutableTestSnapshot } from "../../../../test/support/mutable-test-snapshot.ts";
import assert from "node:assert/strict";
import { normalOwnerInput } from "../../../../test/support/request-source-owner.ts";
import {
  RequestSourceOwnerAuthorization,
  type RequestSourceOwnerSessionEvidence,
} from "./owner-authorization.ts";
import { RequestSourceOwnerError } from "./request-source-owner.ts";
function fixture() {
  const seed = normalOwnerInput();
  let context = structuredClone(seed.context),
    unavailable = false,
    revokeOnRead = false,
    oldRevoked = false,
    software = false,
    sourceReads = 0,
    currentChecks = 0,
    authCalls = 0;
  const checkedSessions: string[] = [];
  const service = new RequestSourceOwnerAuthorization({
    binding: seed.binding,
    now: () => "2026-10-30T02:00:00.000Z",
    sessions: {
      authenticate(secret) {
        authCalls++;
        const controller = structuredClone(seed.controller);
        if (secret === "replacement-local-channel") {
          controller.sessionId = "replacement-session";
        }
        return Promise.resolve(
          {
            kind: software
              ? "runtime-operator"
              : "request-source-owner-session",
            controller,
            sessionRevision: secret === "replacement-local-channel"
              ? 2
              : seed.sessionRevision,
          } as RequestSourceOwnerSessionEvidence,
        );
      },
      revalidate(evidence) {
        checkedSessions.push(evidence.controller.sessionId);
        if (
          unavailable ||
          oldRevoked &&
            evidence.controller.sessionId === seed.controller.sessionId
        ) {
          throw new RequestSourceOwnerError(
            "current-session-revoked-expired-or-authority-changed",
          );
        }
        return Promise.resolve();
      },
    },
    source: {
      resolve() {
        sourceReads++;
        if (revokeOnRead) unavailable = true;
        return Promise.resolve(structuredClone(context));
      },
      assertCurrent(binding) {
        currentChecks++;
        if (
          binding.destination.expectedAdmittedSource.revision !==
            context.destination.expectedAdmittedSource.revision
        ) throw new RequestSourceOwnerError("target-moved");
        return Promise.resolve();
      },
    },
  });
  return {
    service,
    seed,
    checkedSessions,
    counts: () => ({ sourceReads, currentChecks, authCalls }),
    unavailable() {
      unavailable = true;
    },
    revokeDuringSourceRead() {
      revokeOnRead = true;
    },
    revokeOriginal() {
      oldRevoked = true;
    },
    software() {
      software = true;
    },
    changeContext(value: typeof context) {
      context = value;
    },
  };
}
Deno.test("human source authority captures two independent phases and preserves historical proposal across reconnect", async () => {
  const f = fixture(),
    proposal = await f.service.captureProposal(
      "original-local-channel",
      f.seed.context.destination.caseId,
    ),
    old = structuredClone(proposal);
  f.revokeOriginal();
  const checked = f.checkedSessions.length;
  const envelope = await f.service.captureAcceptance(
    "replacement-local-channel",
    proposal,
  );
  assert.deepEqual(envelope.proposal, old);
  assert.notEqual(
    envelope.acceptance.principal.controller.sessionId,
    proposal.principal.controller.sessionId,
  );
  assert(
    f.checkedSessions.slice(checked).every((session) =>
      session === "replacement-session"
    ),
  );
  await f.service.revalidateAcceptance(envelope, "accept-proposal");
  assert(
    f.checkedSessions.slice(checked).every((session) =>
      session === "replacement-session"
    ),
  );
  assert.equal(f.counts().authCalls, 2);
  assert(!JSON.stringify(envelope).includes("local-channel"));
  await assert.rejects(
    f.service.revalidateProposal(proposal),
    /current-session/,
  );
});
Deno.test("current credential or source changes refuse independently before any publication port exists", async () => {
  const denied = fixture();
  denied.unavailable();
  await assert.rejects(
    denied.service.captureProposal(
      "original-local-channel",
      denied.seed.context.destination.caseId,
    ),
    /current-session/,
  );
  assert.equal(denied.counts().sourceReads, 0);
  const stale = fixture(),
    proposal = await stale.service.captureProposal(
      "original-local-channel",
      stale.seed.context.destination.caseId,
    );
  const moved = mutableTestSnapshot(stale.seed.context);
  moved.destination.expectedAdmittedSource.revision++;
  stale.changeContext(moved);
  await assert.rejects(
    stale.service.captureAcceptance("replacement-local-channel", proposal),
  );
  const changed = fixture(), otherRoot = structuredClone(changed.seed.context);
  otherRoot.priorModel.ownerAuthority!.rootGrantNativeId += "-changed";
  changed.changeContext(otherRoot);
  await assert.rejects(
    changed.service.captureProposal(
      "original-local-channel",
      changed.seed.context.destination.caseId,
    ),
  );
});
Deno.test("software channel and unsupported generic v2 command kinds cannot enter the human source path", async () => {
  const software = fixture();
  software.software();
  await assert.rejects(
    software.service.captureProposal(
      "runtime",
      software.seed.context.destination.caseId,
    ),
    /human-local-channel/,
  );
  assert.equal(software.counts().sourceReads, 0);
  const f = fixture(),
    proposal = await f.service.captureProposal(
      "original-local-channel",
      f.seed.context.destination.caseId,
    );
  const envelope = await f.service.captureAcceptance(
      "replacement-local-channel",
      proposal,
    ),
    before = f.counts();
  for (
    const kind of [
      "approved-change",
      "activate-candidate",
      "retain-artifact-source",
    ]
  ) {
    await assert.rejects(
      f.service.revalidateAcceptance(envelope, kind),
      /unsupported-human-source-command/,
    );
  }
  assert.deepEqual(f.counts(), before);
});
Deno.test("stored proposal snapshot is owned before asynchronous independent acceptance", async () => {
  const f = fixture(),
    proposal = await f.service.captureProposal(
      "original-local-channel",
      f.seed.context.destination.caseId,
    ),
    original = structuredClone(proposal);
  const pending = f.service.captureAcceptance(
    "replacement-local-channel",
    proposal,
  );
  proposal.principal.controller.sessionId = "caller-mutated-history";
  assert.deepEqual((await pending).proposal, original);
});

Deno.test("source read await cannot hide a later credential refusal and foreign Case never falls through", async () => {
  const racing = fixture();
  racing.revokeDuringSourceRead();
  await assert.rejects(
    racing.service.captureProposal(
      "original-local-channel",
      racing.seed.context.destination.caseId,
    ),
    /current-session/,
  );
  assert.equal(racing.counts().sourceReads, 1);
  const foreign = fixture();
  await assert.rejects(
    foreign.service.captureProposal("original-local-channel", "foreign-case"),
    /resolved-case-differs/,
  );
  assert.equal(foreign.counts().currentChecks, 0);
});
