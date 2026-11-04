import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { RequestChangeDecision } from "./request-change-decision.ts";
import {
  requestControlState,
  requestOpeningBase,
  requestSpaceScope,
} from "../../../../test/support/request-space-fixture.ts";
import { type OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import {
  requestSpaceDigest,
  RequestSpaceError,
} from "../../../domain/work/request-spaces/scope.ts";
import { type SpaceController } from "../../../domain/work/request-spaces/space-control.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import { requestNetworkProposalDigest } from "../../../domain/governance/records/request-network-change.ts";
import type { SystemRuntime } from "../runtime/system.ts";

import { branchAuthorityFixture } from "../../../../test/support/branch-authority-fixture.ts";
import { requestAuthorityRoute } from "../../governance/request-authority-routing.ts";
import {
  assertRequestCreationGrantAuthorityCurrent,
  assertRequestDelegatedAuthorityCurrent,
  buildRequestCreationGrantAuthority,
  buildRequestDelegatedAuthority,
  requestCreationGrantAuthorityDigest,
  requestDelegatedAuthorityDigest,
} from "../../model/source-admission/request-delegated-authority.ts";
import { requestChangeProposalDigest } from "../../../domain/governance/records/request-change.ts";
import {
  exerciseOwnerAuthority,
  mainExecutionSpace,
} from "../../../domain/governance/authority.ts";
import type { OperatorCommandOrigin } from "../operators/command-delivery.ts";
import { invocationKey } from "../operators/journal.ts";

const human = { kind: "human", secret: "secret" } as const;
const unexpectedDelegation = {
  revalidate: (): Promise<void> => {
    throw new Error("The person's decision never uses delegated authority");
  },
};
const unexpectedDelegatedAdoption = {
  statusDelegated: (): Promise<null> => {
    throw new Error("The person's decision never adopts as delegated");
  },
  prepareNetworkDelegated: (): Promise<{ status: string }> => {
    throw new Error("The person's decision never adopts as delegated");
  },
  resumeDelegated: (): Promise<{ status: string }> => {
    throw new Error("The person's decision never adopts as delegated");
  },
};
const unexpectedCreationGrant = {
  revalidate: (): Promise<void> => {
    throw new Error("This decision never uses a creation grant");
  },
};
const unexpectedTeamAdoption = {
  prepareTeam: (): Promise<{ status: string }> => {
    throw new Error("A network decision never adopts a teammate");
  },
  statusCreationGrant: (): Promise<null> => {
    throw new Error("A network decision never reads a creation grant");
  },
  prepareTeamCreationGrant: (): Promise<{ status: string }> => {
    throw new Error("A network decision never adopts a teammate");
  },
  resumeCreationGrant: (): Promise<{ status: string }> => {
    throw new Error("A network decision never adopts a teammate");
  },
};

/** Port-order test only; it does not establish SQL, native or session validity. */
Deno.test("network human decision persists before publishing and refuses a changed replay", async () => {
  const base = await requestOpeningBase("c"), state = requestControlState();
  state.configuration = structuredClone(state.executionModel!.configuration);
  const caseId = "case", changeId = "change";
  const opening = {
    id: "opening",
    scope: requestSpaceScope,
    ownerId: "owner",
    executionSpaceId: "space",
    caseId,
    base,
    baseDigest: await requestSpaceDigest(base),
  } as OpeningRecord;
  const change = {
    id: changeId,
    kind: "mandate-change",
    caseId,
    requestedBy: "operator",
    status: "pending",
    baseRevision: state.configuration.revision,
    baseModelDigest: state.executionModel!.version.digest,
    reason: "Allow an exact host",
    requestedAt: "2026-10-30T00:00:00.000Z",
    requestedRights: { addNetworkHosts: ["example.org"] },
    diff: {
      title: "Allow an exact host",
      author: "operator",
      base: {
        repositoryVersion: state.executionModel!.version.repositoryVersion,
        modelDigest: state.executionModel!.version.digest,
        sourceDigest: "a".repeat(64),
      },
      sourceDigest: "b".repeat(64),
      files: [{
        path: "model.sysml",
        kind: "changed",
        additions: 1,
        deletions: 1,
      }],
      patch: "exact compiled diff",
      additions: 1,
      deletions: 1,
    },
  } as unknown as PendingChange;
  state.configuration.changes = [change];
  const intentDigest = await requestNetworkProposalDigest(change);
  const command = {
    caseId,
    agentId: "operator",
    changeId,
    expectedRevision: state.revision,
    configurationRevision: state.configuration.revision,
    verdict: "approve" as const,
  };
  const calls: string[] = [];
  const controller = { ownerId: "owner" } as SpaceController;
  const proposal = {} as never, authority = {} as never;
  const runtime = {
    async recordRequestNetworkDecision() {
      calls.push("persist");
      change.status = "approved";
      change.authority = "human";
      state.requestNetworkDecisions = {
        [changeId]: {
          openingId: opening.id,
          executionSpaceId: opening.executionSpaceId,
          caseId,
          commandId: changeId,
          expectedRevision: command.expectedRevision,
          configurationRevision: command.configurationRevision,
          proposalIntentDigest: intentDigest,
          verdict: "approve",
        },
      };
      return await structuredClone(change);
    },
  } as unknown as SystemRuntime;
  const app = new RequestChangeDecision({
    repositoryId: "repository",
    access: {
      authorizeRead: () => Promise.resolve(controller),
      assertOwnedDestination: () => Promise.resolve(),
      revalidateRead: () => Promise.resolve(),
    },
    authority: {
      captureProposal: () => Promise.resolve(proposal),
      captureAcceptance: () => Promise.resolve(authority),
      revalidateProposal: () => Promise.resolve(),
      revalidateHumanDecision: () => Promise.resolve(),
    },
    runtime: {
      read: () => Promise.resolve(structuredClone(state)),
      networkRefusalStatus: () => Promise.resolve("pending"),
      ensureNetworkRefusal: () => Promise.resolve(),
    },
    delegation: unexpectedDelegation,
    creationGrant: unexpectedCreationGrant,
    branchTeamSize: () => Promise.resolve(0),
    decisionCommit: {
      record: (_record, input) =>
        runtime.recordRequestNetworkDecision(input, () => Promise.resolve()),
    },
    preparation: {
      prepare: () =>
        Promise.resolve({
          proposalIntentDigest: intentDigest,
          expectedVersion: state.executionModel!.version.repositoryVersion!,
        }),
    },
    publisher: {
      publish: () => {
        calls.push("publish");
        equal(change.status, "approved");
        return Promise.resolve(structuredClone(state.executionModel!));
      },
      resume: () => Promise.resolve(null),
    },
    queue: {
      getDossier: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
    },
    admittedSource: () => Promise.resolve({ receipts: [] }),
    adoption: {
      status: () => Promise.resolve(null),
      prepareNetwork: () => {
        calls.push("adoption");
        return Promise.resolve({ status: "armed" });
      },
      resume: () => Promise.resolve({ status: "armed" }),
      ...unexpectedDelegatedAdoption,
      ...unexpectedTeamAdoption,
    },
  });
  deepStrictEqual(await app.decide(human, opening, command), {
    status: "blocked",
    caseId,
    changeId,
  });
  deepStrictEqual(calls, ["persist", "publish", "adoption"]);
  await rejects(() =>
    app.decide(human, opening, { ...command, verdict: "refuse" })
  );
  deepStrictEqual(calls, ["persist", "publish", "adoption"]);
  deepStrictEqual(await app.status(human, opening, "operator", changeId), {
    caseId,
    changeId,
    status: "decision-recorded",
    canResume: true,
  });
  // Resume uses the stored original revisions, even after the current state advances.
  state.revision += 1;
  deepStrictEqual(await app.resume(human, opening, "operator", changeId), {
    caseId,
    changeId,
    status: "blocked",
    canResume: true,
  });
  deepStrictEqual(calls, [
    "persist",
    "publish",
    "adoption",
    "publish",
    "adoption",
  ]);
});

async function checkRefusedDecision(
  requestedRights: NonNullable<PendingChange["requestedRights"]>,
) {
  const base = await requestOpeningBase("c"), state = requestControlState();
  state.configuration = structuredClone(state.executionModel!.configuration);
  const caseId = "case", changeId = "refusal";
  const opening = {
    id: "opening",
    scope: requestSpaceScope,
    ownerId: "owner",
    executionSpaceId: "space",
    caseId,
    base,
    baseDigest: await requestSpaceDigest(base),
  } as OpeningRecord;
  const change = {
    id: changeId,
    kind: "mandate-change",
    caseId,
    requestedBy: "operator",
    status: "pending",
    baseRevision: state.configuration.revision,
    baseModelDigest: state.executionModel!.version.digest,
    reason: "Read a host",
    requestedAt: "2026-10-30T00:00:00.000Z",
    requestedRights,
    diff: {
      title: "Read a host",
      author: "operator",
      base: {
        repositoryVersion: state.executionModel!.version.repositoryVersion,
        modelDigest: state.executionModel!.version.digest,
        sourceDigest: "a".repeat(64),
      },
      sourceDigest: "b".repeat(64),
      files: [{
        path: "model.sysml",
        kind: "changed",
        additions: 1,
        deletions: 1,
      }],
      patch: "exact compiled diff",
      additions: 1,
      deletions: 1,
    },
  } as unknown as PendingChange;
  state.configuration.changes = [change];
  const digest = await requestChangeProposalDigest(change);
  const command = {
    caseId,
    agentId: "operator",
    changeId,
    expectedRevision: state.revision,
    configurationRevision: change.baseRevision,
    verdict: "refuse" as const,
  };
  let decisions = 0, wakeAvailable = false, wakeAccepted = false;
  const controller = { ownerId: "owner" } as SpaceController;
  const app = new RequestChangeDecision({
    repositoryId: "repository",
    access: {
      authorizeRead: () => Promise.resolve(controller),
      assertOwnedDestination: () => Promise.resolve(),
      revalidateRead: () => Promise.resolve(),
    },
    authority: {
      captureProposal: () => Promise.resolve({} as never),
      captureAcceptance: () => Promise.resolve({} as never),
      revalidateProposal: () => Promise.resolve(),
      revalidateHumanDecision: () => Promise.resolve(),
    },
    runtime: {
      read: () => Promise.resolve(structuredClone(state)),
      networkRefusalStatus: () =>
        Promise.resolve(wakeAccepted ? "accepted" : "pending"),
      ensureNetworkRefusal: () => {
        if (!wakeAvailable) {
          return Promise.reject(
            new RequestSpaceError("UNAVAILABLE", "Exact wait unavailable"),
          );
        }
        wakeAccepted = true;
        return Promise.resolve();
      },
    },
    delegation: unexpectedDelegation,
    creationGrant: unexpectedCreationGrant,
    branchTeamSize: () => Promise.resolve(0),
    decisionCommit: {
      record: (_record, input) => {
        decisions++;
        change.status = "refused";
        change.authority = "human";
        state.requestNetworkDecisions = {
          [changeId]: {
            openingId: opening.id,
            executionSpaceId: opening.executionSpaceId,
            caseId,
            commandId: changeId,
            expectedRevision: input.expectedRevision,
            configurationRevision: input.configurationRevision,
            proposalIntentDigest: digest,
            verdict: "refuse",
          },
        };
        return Promise.resolve(structuredClone(change));
      },
    },
    preparation: {
      prepare: () =>
        Promise.resolve({
          proposalIntentDigest: digest,
          expectedVersion: state.executionModel!.version.repositoryVersion!,
        }),
    },
    publisher: {
      publish: () => {
        throw new Error("A refusal never publishes");
      },
      resume: () => {
        throw new Error("A refusal never resumes a source writer");
      },
    },
    queue: {
      get: () => Promise.resolve(null),
      getDossier: () => Promise.resolve(null),
    },
    admittedSource: () => Promise.resolve({ receipts: [] }),
    adoption: {
      status: () => {
        throw new Error("A refusal never adopts R1");
      },
      prepareNetwork: () => {
        throw new Error("A refusal never adopts R1");
      },
      resume: () => {
        throw new Error("A refusal never adopts R1");
      },
      ...unexpectedDelegatedAdoption,
      ...unexpectedTeamAdoption,
    },
  });
  deepStrictEqual(await app.decide(human, opening, command), {
    status: "refused-awaiting-continuation",
    caseId,
    changeId,
  });
  deepStrictEqual(await app.status(human, opening, "operator", changeId), {
    status: "refused-awaiting-continuation",
    caseId,
    changeId,
    canResume: true,
  });
  state.revision++;
  wakeAvailable = true;
  deepStrictEqual(await app.resume(human, opening, "operator", changeId), {
    status: "refused",
    caseId,
    changeId,
    canResume: true,
  });
  deepStrictEqual(await app.resume(human, opening, "operator", changeId), {
    status: "refused",
    caseId,
    changeId,
    canResume: true,
  });
  equal(decisions, 1);
}

for (
  const requestedRights of [
    { addNetworkHosts: ["example.org"] },
    {
      operatorCreation: {
        networkHosts: [],
        maxChildren: 3,
        mode: "per-creation" as const,
      },
    },
  ]
) {
  Deno.test(`refused ${"operatorCreation" in requestedRights ? "creation policy" : "network"} decision keeps retry identity while the native checkpoint is unavailable`, () =>
    checkRefusedDecision(requestedRights));
}

// Spec 4.8c C9 and amendments A1, A2, A4: the MO's decision under main's policy.
async function delegatedFixture(
  verdict: "approve" | "refuse" = "approve",
  member = false,
) {
  let personReads = false;
  const f = await branchAuthorityFixture();
  f.mandate("branch");
  const { opening, admission, request, main } = f.snapshot;
  const owner = structuredClone(request);
  if (member) {
    request.executionModel!.identity.builderId = "member";
    request.model!.builderId = "member";
    request.executionModel!.operatorTeam = {
      parentOperatorId: "operator",
      requestOwnerId: "operator",
      requestId: opening.caseId,
      creationPolicyId: "creation",
    };
    request.configuration!.changes[0].requestedBy = "member";
    main!.executionModel!.operatorAuthorityPolicies![0].recipients = ["member"];
    admission.permissions.operatorIds.push("member");
    admission.permissions.modelDigests.push(
      request.executionModel!.version.digest,
    );
    const work = {
      callerId: "operator",
      correlationId: "member-work",
      invocationId: "member-work",
      behaviorId: "member-inbox",
      targetNativeId: "member-inbox",
      modelVersion: {
        digest: owner.executionModel!.version.digest,
        repositoryVersion: owner.executionModel!.version.repositoryVersion!,
      },
      fingerprint: "member-work",
      priorCandidateIds: [],
      caseId: opening.caseId,
      caseContext: {
        caseId: opening.caseId,
        record: owner.cases![0],
        modelPin: owner.cases![0].modelPin!,
      },
    };
    request.messages.push({
      id: "member-input",
      role: "user",
      text: "Read",
      at: "2026-11-02T00:00:00Z",
      caseId: opening.caseId,
      work,
    });
    request.changeWorkContinuations = {
      change: {
        inputMessageId: "member-input",
        invocationKey: invocationKey({ kind: "delegated", work }),
      },
    };
  }
  const change = request.configuration!.changes[0];
  change.requestedAt = "2026-10-31T00:00:00.000Z";
  change.diff = {
    title: "Allow an exact host",
    author: change.requestedBy!,
    base: {
      repositoryVersion: request.executionModel!.version.repositoryVersion!,
      modelDigest: request.executionModel!.version.digest,
      sourceDigest: "a".repeat(64),
    },
    sourceDigest: "b".repeat(64),
    files: [{
      path: "model.sysml",
      kind: "changed",
      additions: 1,
      deletions: 1,
    }],
    patch: "exact compiled diff",
    additions: 1,
    deletions: 1,
  };
  const facts = () => ({
    opening,
    admission,
    request,
    space: f.space,
    main: main!,
    change: request.configuration!.changes[0],
    states: member ? [owner, request] : [request],
  });
  const route = () =>
    requestAuthorityRoute({
      space: f.space,
      requester: request,
      change: request.configuration!.changes[0],
      states: member ? [owner, request] : [request],
      root: {
        kind: "verified-opening",
        openingId: opening.id,
        parent: {
          space: mainExecutionSpace(main!.executionModel!.identity),
          state: main!,
        },
      },
    });
  const envelopeFor = (effectKey: string) => {
    const routed = route();
    return buildRequestDelegatedAuthority({
      ...facts(),
      route: routed,
      destination: f.destination,
      origin: {
        effectKey,
        inputMessageId: "authority-escalation:change",
      } as unknown as OperatorCommandOrigin,
      capturedAt: "2026-10-31T00:00:00.000Z",
    });
  };
  const envelope = envelopeFor("mo-effect");
  const calls: string[] = [];
  let raceBeforeCommit: (() => void) | undefined;
  const intentDigest = await requestNetworkProposalDigest(change);
  const command = {
    caseId: opening.caseId,
    agentId: member ? "member" : "operator",
    changeId: change.id,
    expectedRevision: request.revision,
    configurationRevision: change.baseRevision,
    verdict,
  };
  const app = new RequestChangeDecision({
    repositoryId: "repository",
    access: {
      authorizeRead: () => {
        if (!personReads) {
          throw new Error("A delegated decision reads no person's session");
        }
        return Promise.resolve(
          { ownerId: opening.ownerId } as SpaceController,
        );
      },
      assertOwnedDestination: () => {
        throw new Error("A delegated decision reads no person's session");
      },
      revalidateRead: () => {
        if (!personReads) {
          throw new Error("A delegated decision reads no person's session");
        }
        return Promise.resolve();
      },
    },
    authority: {
      captureProposal: () => {
        throw new Error("A delegated decision captures no human phase");
      },
      captureAcceptance: () => {
        throw new Error("A delegated decision captures no human phase");
      },
      revalidateProposal: () => Promise.reject(new Error("unexpected")),
      revalidateHumanDecision: () => Promise.reject(new Error("unexpected")),
    },
    delegation: {
      revalidate: (value) => {
        calls.push("revalidate");
        assertRequestDelegatedAuthorityCurrent(value, facts());
        raceBeforeCommit?.();
        return Promise.resolve();
      },
    },
    creationGrant: unexpectedCreationGrant,
    branchTeamSize: () => Promise.resolve(0),
    runtime: {
      read: (_opening, requester) => {
        if (member) deepStrictEqual(requester, envelope.requester);
        return Promise.resolve(structuredClone(request));
      },
      networkRefusalStatus: () => Promise.resolve("accepted"),
      ensureNetworkRefusal: () => {
        calls.push("refusal-continuation");
        return Promise.resolve();
      },
    },
    decisionCommit: {
      record: async (_record, input) => {
        // The commit's fenced step re-reads Main and the route (A2).
        if (input.authority.kind !== "request-delegated-authority") {
          throw new Error("expected a delegated record");
        }
        assertRequestDelegatedAuthorityCurrent(input.authority, facts());
        calls.push("record");
        const current = request.configuration!.changes[0];
        current.status = input.verdict === "approve" ? "approved" : "refused";
        current.authority = "builder";
        current.authorityExercise = structuredClone(input.authority.exercise);
        request.revision++;
        request.requestNetworkDecisions = {
          [current.id]: {
            openingId: opening.id,
            executionSpaceId: opening.executionSpaceId,
            caseId: opening.caseId,
            commandId: current.id,
            expectedRevision: input.expectedRevision,
            configurationRevision: input.configurationRevision,
            proposalIntentDigest: intentDigest,
            verdict: input.verdict,
            authority: {
              kind: "delegated",
              digest: await requestDelegatedAuthorityDigest(input.authority),
              envelope: structuredClone(input.authority),
            },
          },
        };
        return structuredClone(current);
      },
    },
    preparation: {
      prepare: () =>
        Promise.resolve({
          proposalIntentDigest: intentDigest,
          expectedVersion: request.executionModel!.version.repositoryVersion!,
        }),
    },
    publisher: {
      publish: (value) => {
        calls.push(`publish:${value.authority.kind}`);
        return Promise.resolve(structuredClone(request.executionModel!));
      },
      resume: () => Promise.resolve(null),
    },
    queue: {
      getDossier: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
    },
    admittedSource: () => Promise.resolve({ receipts: [] }),
    adoption: {
      status: () => Promise.reject(new Error("no person's adoption")),
      prepareNetwork: () => Promise.reject(new Error("no person's adoption")),
      resume: () => Promise.reject(new Error("no person's adoption")),
      statusDelegated: () => Promise.resolve(null),
      prepareNetworkDelegated: () => {
        calls.push("adopt");
        return Promise.resolve({ status: "armed" });
      },
      resumeDelegated: () =>
        Promise.resolve({ status: "adopted", receipt: { ok: true } }),
      ...unexpectedTeamAdoption,
    },
  });
  const delegated = {
    kind: "delegated" as const,
    envelope,
    policyModel: main!.executionModel!,
  };
  return {
    app,
    calls,
    command,
    delegated,
    envelopeFor,
    main: main!,
    request,
    opening,
    race(value: () => void) {
      raceBeforeCommit = value;
    },
    /** The person opens the card after the MO decided. */
    personOpens() {
      personReads = true;
    },
  };
}

Deno.test("4.8e E5: delegated member decisions target the requester's state through publication, refusal and replay", async () => {
  for (const verdict of ["approve", "refuse"] as const) {
    const f = await delegatedFixture(verdict, true);
    const result = await f.app.decide(f.delegated, f.opening, f.command);
    equal(result.status, verdict === "approve" ? "adopted" : "refused");
    const saved = f.request.requestNetworkDecisions![f.command.changeId];
    equal(saved.authority?.kind, "delegated");
    equal(
      (saved.authority!.envelope as typeof f.delegated.envelope).requester
        .operatorId,
      "member",
    );
    await f.app.resume(
      { kind: "delegated", envelope: f.delegated.envelope },
      f.opening,
      "member",
      f.command.changeId,
    );
    equal(f.calls.filter((call) => call === "record").length, 1);
  }
});

Deno.test("4.8c A2: a revocation before the record refuses with no effect", async () => {
  const f = await delegatedFixture();
  f.main.executionModel!.operatorAuthorityPolicies = [];
  await rejects(() => f.app.decide(f.delegated, f.opening, f.command), {
    code: "AUTHORITY_POLICY_STALE",
  });
  deepStrictEqual(f.calls, ["revalidate"], "refused before any record");
  equal(f.request.configuration!.changes[0].status, "pending");
  // Revoked between the early check and the record: the fenced step refuses.
  const g = await delegatedFixture();
  g.race(() => g.main.executionModel!.operatorAuthorityPolicies = []);
  await rejects(() => g.app.decide(g.delegated, g.opening, g.command), {
    code: "AUTHORITY_POLICY_STALE",
  });
  deepStrictEqual(g.calls, ["revalidate"]);
  equal(g.request.configuration!.changes[0].status, "pending");
  equal(g.request.requestNetworkDecisions, undefined);
});

Deno.test("4.8c A2: after the record the decision stands, is published in the branch and adopted", async () => {
  const f = await delegatedFixture();
  deepStrictEqual(await f.app.decide(f.delegated, f.opening, f.command), {
    status: "adopted",
    caseId: f.opening.caseId,
    changeId: f.command.changeId,
  });
  deepStrictEqual(f.calls, [
    "revalidate",
    "record",
    "publish:request-delegated-authority",
    "adopt",
  ]);
  // Revocation after the record does not withdraw what it granted.
  f.main.executionModel!.operatorAuthorityPolicies = [];
  deepStrictEqual(
    await f.app.resume(
      { kind: "delegated", envelope: f.delegated.envelope },
      f.opening,
      "operator",
      f.command.changeId,
    ),
    {
      status: "adopted",
      caseId: f.opening.caseId,
      changeId: f.command.changeId,
      canResume: true,
    },
  );
  equal(f.calls.filter((call) => call === "record").length, 1);
});

Deno.test("4.8c A4: a replayed command reaches its record; another command or the person cannot decide again", async () => {
  const f = await delegatedFixture();
  await f.app.decide(f.delegated, f.opening, f.command);
  // Replay after a crash: the same envelope, the original revisions.
  await f.app.decide(
    { kind: "delegated", envelope: f.delegated.envelope },
    f.opening,
    f.command,
  );
  equal(f.calls.filter((call) => call === "record").length, 1);
  const other = await delegatedFixture();
  const otherCommand = other.envelopeFor("another-effect");
  await other.app.decide(other.delegated, other.opening, other.command);
  await rejects(
    () =>
      other.app.decide(
        { kind: "delegated", envelope: otherCommand },
        other.opening,
        other.command,
      ),
    { code: "OPENING_CONFLICT" },
  );
  // A delegated main destination never even parses.
  const forged = structuredClone(f.delegated.envelope) as unknown as {
    destination: { executionSpaceId: string };
  };
  forged.destination.executionSpaceId = "main";
  await rejects(() =>
    f.app.decide(
      { kind: "delegated", envelope: forged as never },
      f.opening,
      f.command,
    )
  );
});

Deno.test("4.8c A4: the MO's refusal is final and reuses the refusal continuation", async () => {
  const f = await delegatedFixture("refuse");
  deepStrictEqual(await f.app.decide(f.delegated, f.opening, f.command), {
    status: "refused",
    caseId: f.opening.caseId,
    changeId: f.command.changeId,
  });
  deepStrictEqual(f.calls, ["revalidate", "record", "refusal-continuation"]);
  equal(f.request.configuration!.changes[0].status, "refused");
  equal(f.request.configuration!.changes[0].authority, "builder");
  // No approver shopping: an approval after the refusal is refused.
  await rejects(
    () =>
      f.app.decide(f.delegated, f.opening, {
        ...f.command,
        verdict: "approve",
      }),
    { code: "OPENING_CONFLICT" },
  );
});

Deno.test("4.8d: the person reads and resumes a decision the MO recorded", async () => {
  const f = await delegatedFixture();
  await f.app.decide(f.delegated, f.opening, f.command);
  f.personOpens();
  const person = { kind: "human" as const, secret: "f".repeat(64) };
  const status = await f.app.status(
    person,
    f.opening,
    "operator",
    f.command.changeId,
  );
  equal(status.canResume, true);
  equal(status.changeId, f.command.changeId);
  deepStrictEqual(
    await f.app.resume(person, f.opening, "operator", f.command.changeId),
    {
      status: "adopted",
      caseId: f.opening.caseId,
      changeId: f.command.changeId,
      canResume: true,
    },
  );
  equal(f.calls.filter((call) => call === "record").length, 1);
});

/** Spec 4.8e E4: one coordinator, two effects. The team harness mirrors the
 * delegated one: fake ports record their order; the commit fake re-runs the
 * real current-authority check, as the PostgreSQL commit does. */
async function teamFixture(
  mode?: "autonomous" | "per-creation",
  member = false,
) {
  const f = await branchAuthorityFixture();
  const change = f.teamProposal(mode);
  const { opening, admission, request } = f.snapshot;
  const model = request.executionModel!;
  if (member) {
    model.identity.builderId = "member";
    model.operatorCreationPolicies![0].holderNativeId = "member";
    change.requestedBy = "member";
    admission.permissions.operatorIds.push("member");
    admission.permissions.modelDigests.push(model.version.digest);
  }
  change.diff = {
    title: "Create Helper",
    author: "operator",
    base: {
      repositoryVersion: model.version.repositoryVersion!,
      modelDigest: model.version.digest,
      sourceDigest: "a".repeat(64),
    },
    sourceDigest: "b".repeat(64),
    files: [{
      path: "model.sysml",
      kind: "changed",
      additions: 3,
      deletions: 0,
    }],
    patch: "exact compiled diff",
    additions: 3,
    deletions: 0,
  };
  const intentDigest = await requestChangeProposalDigest(change);
  const facts = () => ({
    opening,
    admission,
    request,
    space: f.space,
    branchTeamSize: 0,
    change: request.configuration!.changes[0],
  });
  const envelope = mode === "per-creation"
    ? undefined
    : buildRequestCreationGrantAuthority({
      ...facts(),
      destination: f.destination,
      capturedAt: "2026-11-01T00:00:00.000Z",
    });
  const calls: string[] = [];
  const app = new RequestChangeDecision({
    repositoryId: "repository",
    access: {
      authorizeRead: () =>
        Promise.resolve({ ownerId: opening.ownerId } as SpaceController),
      assertOwnedDestination: () => Promise.resolve(),
      revalidateRead: () => Promise.resolve(),
    },
    authority: {
      captureProposal: () => Promise.resolve({} as never),
      captureAcceptance: () =>
        Promise.resolve({ kind: "request-source-owner-authority" } as never),
      revalidateProposal: () => Promise.resolve(),
      revalidateHumanDecision: () => Promise.resolve(),
    },
    delegation: unexpectedDelegation,
    creationGrant: {
      revalidate: (value) => {
        calls.push("revalidate");
        assertRequestCreationGrantAuthorityCurrent(value, facts());
        return Promise.resolve();
      },
    },
    branchTeamSize: () => Promise.resolve(0),
    runtime: {
      read: (_opening, requester) => {
        if (member) deepStrictEqual(requester, envelope!.requester);
        return Promise.resolve(structuredClone(request));
      },
      networkRefusalStatus: () => Promise.resolve("accepted"),
      ensureNetworkRefusal: () => {
        calls.push("refusal-continuation");
        return Promise.resolve();
      },
    },
    decisionCommit: {
      record: async (_record, input) => {
        calls.push("record");
        const current = request.configuration!.changes[0];
        if (input.authority.kind === "request-creation-grant") {
          assertRequestCreationGrantAuthorityCurrent(
            input.authority,
            facts(),
          );
          current.authority = "builder";
          current.authorityExercise = structuredClone(
            input.authority.exercise,
          );
        } else if (input.authority.kind === "request-delegated-authority") {
          throw new Error("a delegated envelope never creates a teammate");
        } else {
          current.authority = "human";
          current.authorityExercise = exerciseOwnerAuthority(
            model,
            "mandate-change",
          );
        }
        current.status = input.verdict === "approve" ? "approved" : "refused";
        current.decidedAt = "2026-11-01T00:00:00.000Z";
        request.revision++;
        request.requestNetworkDecisions = {
          [current.id]: {
            openingId: opening.id,
            executionSpaceId: opening.executionSpaceId,
            caseId: opening.caseId,
            commandId: current.id,
            expectedRevision: input.expectedRevision,
            configurationRevision: input.configurationRevision,
            proposalIntentDigest: intentDigest,
            verdict: input.verdict,
            ...(input.authority.kind === "request-creation-grant"
              ? {
                authority: {
                  kind: "creation-grant" as const,
                  digest: await requestCreationGrantAuthorityDigest(
                    input.authority,
                  ),
                  envelope: structuredClone(input.authority),
                },
              }
              : {}),
          },
        };
        return structuredClone(current);
      },
    },
    preparation: {
      prepare: () =>
        Promise.resolve({
          proposalIntentDigest: intentDigest,
          expectedVersion: model.version.repositoryVersion!,
        }),
    },
    publisher: {
      publish: (value) => {
        calls.push(`publish:${value.authority.kind}`);
        return Promise.resolve(structuredClone(model));
      },
      resume: () => Promise.resolve(null),
    },
    queue: {
      getDossier: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
    },
    admittedSource: () => Promise.resolve({ receipts: [] }),
    adoption: {
      status: () => Promise.resolve(null),
      prepareNetwork: () => {
        throw new Error("A team creation never prepares a network adoption");
      },
      resume: () =>
        Promise.resolve({ status: "adopted", receipt: { ok: true } }),
      ...unexpectedDelegatedAdoption,
      ...unexpectedTeamAdoption,
      statusCreationGrant: () => Promise.resolve(null),
      prepareTeam: () => {
        calls.push("adopt:team");
        return Promise.resolve({ status: "armed" });
      },
      prepareTeamCreationGrant: () => {
        calls.push("adopt:team");
        return Promise.resolve({ status: "armed" });
      },
      resumeCreationGrant: () =>
        Promise.resolve({ status: "adopted", receipt: { ok: true } }),
    },
  });
  const command = {
    caseId: opening.caseId,
    agentId: member ? "member" : "operator",
    changeId: change.id,
    expectedRevision: request.revision,
    configurationRevision: change.baseRevision,
    verdict: "approve" as const,
  };
  return { app, calls, command, envelope, opening, request };
}

Deno.test("4.8e Q5: a member's explicit creation grant targets its own state and records only one decision", async () => {
  const f = await teamFixture("autonomous", true);
  equal(
    (await f.app.decide(
      { kind: "creation-grant", envelope: f.envelope! },
      f.opening,
      f.command,
    )).status,
    "adopted",
  );
  equal(f.envelope!.requester.operatorId, "member");
  await f.app.resume(
    { kind: "creation-grant", envelope: f.envelope! },
    f.opening,
    "member",
    f.command.changeId,
  );
  equal(f.calls.filter((call) => call === "record").length, 1);
});

Deno.test("4.8e E4: an autonomous creation is recorded, published in its branch and adopted under its grant", async () => {
  const f = await teamFixture();
  deepStrictEqual(
    await f.app.decide(
      { kind: "creation-grant", envelope: f.envelope! },
      f.opening,
      f.command,
    ),
    { status: "adopted", caseId: f.opening.caseId, changeId: "team-change" },
  );
  deepStrictEqual(f.calls, [
    "revalidate",
    "record",
    "publish:request-creation-grant",
    "adopt:team",
  ]);
  // Replay of the same decision creates no second child: one record.
  deepStrictEqual(
    await f.app.resume(
      { kind: "creation-grant", envelope: f.envelope! },
      f.opening,
      "operator",
      "team-change",
    ),
    {
      status: "adopted",
      caseId: f.opening.caseId,
      changeId: "team-change",
      canResume: true,
    },
  );
  equal(f.calls.filter((call) => call === "record").length, 1);
  // Withdrawing the grant after the record does not unmake the member.
  f.request.executionModel!.operatorCreationPolicies = [];
  equal(
    (await f.app.status(
      { kind: "creation-grant", envelope: f.envelope! },
      f.opening,
      "operator",
      "team-change",
    )).canResume,
    true,
  );
});

Deno.test("4.8e E4: a withdrawn grant refuses before the record, with no effect", async () => {
  const f = await teamFixture();
  f.request.executionModel!.operatorCreationPolicies = [];
  await rejects(
    () =>
      f.app.decide(
        { kind: "creation-grant", envelope: f.envelope! },
        f.opening,
        f.command,
      ),
    { code: "AUTHORITY_POLICY_STALE" },
  );
  deepStrictEqual(f.calls, ["revalidate"]);
  equal(f.request.configuration!.changes[0].status, "pending");
});

Deno.test("4.8e E4: a per-creation team member is decided by the person on the same coordinator", async () => {
  const f = await teamFixture("per-creation");
  deepStrictEqual(await f.app.decide(human, f.opening, f.command), {
    status: "adopted",
    caseId: f.opening.caseId,
    changeId: "team-change",
  });
  deepStrictEqual(f.calls, [
    "record",
    "publish:request-source-owner-authority",
    "adopt:team",
  ]);
  equal(f.request.configuration!.changes[0].authority, "human");
});
