import { equal, notEqual, rejects, throws } from "node:assert/strict";
import { OperatorAuthorityError } from "../operator-authority-error.ts";
import type { PendingChange } from "./pending-change.ts";
import {
  assertRequestChange,
  assertRequestCreationPolicyChange,
  assertRequestTeamChange,
  requestChangeEffect,
  requestChangeProposalDigest,
} from "./request-change.ts";
import { requestNetworkProposalDigest } from "./request-network-change.ts";

const base = {
  id: "change-1",
  status: "pending",
  requestedBy: "builder",
  caseId: "case-1",
  baseRevision: 1,
  baseModelDigest: "a".repeat(64),
  reason: "because",
  requestedAt: "2026-11-01T00:00:00.000Z",
} as const;

Deno.test("4.8e E4: the effect of a Request change is derived, never stored", () => {
  equal(
    requestChangeEffect({
      ...base,
      kind: "mandate-change",
      requestedRights: { addNetworkHosts: ["example.com"] },
    } as PendingChange),
    "network",
  );
  equal(
    requestChangeEffect({
      ...base,
      kind: "operator-creation",
      name: "Helper",
      operator: {
        kind: "request-team-member",
        instruction: "Help with the Request.",
        provision: {
          budget: {
            maxAgentDecisions: 1,
            maxToolProposals: 1,
            maxFlowSteps: 1,
          },
          networkHosts: [],
          mayPropose: [],
          mayInvokeActiveCatalog: false,
        },
      },
      teamOrigin: { operatorId: "owner", requestId: "case-1" },
    } as unknown as PendingChange),
    "team-member",
  );
  // A team creation without its exact Request origin is not a team effect.
  equal(
    requestChangeEffect({
      ...base,
      kind: "operator-creation",
      operator: {
        kind: "request-team-member",
        instruction: "Help.",
        provision: {
          budget: {
            maxAgentDecisions: 1,
            maxToolProposals: 1,
            maxFlowSteps: 1,
          },
          networkHosts: [],
          mayPropose: [],
          mayInvokeActiveCatalog: false,
        },
      },
    } as unknown as PendingChange),
    undefined,
  );
  // Other mandate changes have no Request change effect.
  equal(
    requestChangeEffect({
      ...base,
      kind: "mandate-change",
      requestedRights: { mayAdmitOwnCandidates: true },
    } as PendingChange),
    undefined,
  );
});

const diff = {
  title: "Create Helper",
  author: "builder",
  base: {
    repositoryVersion: `commit:${"b".repeat(40)}`,
    modelDigest: "a".repeat(64),
    sourceDigest: "c".repeat(64),
  },
  sourceDigest: "d".repeat(64),
  files: [{ path: "model.sysml", kind: "changed", additions: 3, deletions: 0 }],
  patch: "+helper",
  additions: 3,
  deletions: 0,
} as const;

function teamChange(overrides: Record<string, unknown> = {}): PendingChange {
  return {
    ...base,
    kind: "operator-creation",
    name: "Helper",
    role: "operator",
    operator: {
      kind: "request-team-member",
      instruction: "Help with the Request.",
      provision: {
        budget: { maxAgentDecisions: 2, maxToolProposals: 3, maxFlowSteps: 4 },
        networkHosts: ["example.com"],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
    teamOrigin: { operatorId: "owner", requestId: "case-1" },
    diff,
    ...overrides,
  } as unknown as PendingChange;
}

Deno.test("4.8e E4: an exact Case team creation is closed like the network change", () => {
  assertRequestTeamChange(teamChange());
  // Another Request's origin, a designer scope, stored rights or an extra
  // field are each a different change, never this effect.
  for (
    const foreign of [
      { teamOrigin: { operatorId: "owner", requestId: "case-2" } },
      { designerScopeId: "scope-1" },
      { requestedRights: { addNetworkHosts: ["example.com"] } },
      { mandate: { mayReviewExactCandidate: true } },
      { effect: "team-member" },
      { operator: { instruction: "No provision." } },
    ]
  ) {
    throws(() => assertRequestTeamChange(teamChange(foreign)));
  }
});

Deno.test("4.8e E4: one proposal digest entry, network bytes unchanged", async () => {
  const network = {
    ...base,
    kind: "mandate-change",
    requestedRights: { addNetworkHosts: ["example.com"] },
    diff,
  } as unknown as PendingChange;
  equal(
    await requestChangeProposalDigest(network),
    await requestNetworkProposalDigest(network),
  );
  const first = await requestChangeProposalDigest(teamChange());
  equal(first, await requestChangeProposalDigest(teamChange()));
  // The provision is part of the proposal's immutable meaning.
  notEqual(
    first,
    await requestChangeProposalDigest(teamChange({
      operator: {
        kind: "request-team-member",
        instruction: "Help with the Request.",
        provision: {
          budget: {
            maxAgentDecisions: 9,
            maxToolProposals: 3,
            maxFlowSteps: 4,
          },
          networkHosts: ["example.com"],
          mayPropose: [],
          mayInvokeActiveCatalog: false,
        },
      },
    })),
  );
});

Deno.test("unsupported Request changes return a coded refusal instead of a network fallback", async () => {
  const change: PendingChange = {
    ...base,
    kind: "mandate-change",
    requestedRights: { mayAdmitOwnCandidates: true },
  };
  await rejects(
    () => requestChangeProposalDigest(change),
    (error) =>
      error instanceof OperatorAuthorityError &&
      error.code === "INVALID_OPERATOR_REQUEST",
  );
});

Deno.test("a creation grant is an exact Request mandate change whose bounds enter its digest", async () => {
  const change = {
    ...base,
    kind: "mandate-change",
    diff,
    requestedRights: {
      operatorCreation: {
        networkHosts: ["example.com"],
        maxChildren: 3,
        mode: "autonomous",
      },
    },
  } as unknown as PendingChange;
  equal(requestChangeEffect(change), "creation-policy");
  assertRequestChange(change);
  assertRequestCreationPolicyChange(change);
  const digest = await requestChangeProposalDigest(change);
  notEqual(
    digest,
    await requestChangeProposalDigest({
      ...change,
      requestedRights: {
        operatorCreation: {
          ...change.requestedRights.operatorCreation,
          mode: "per-creation",
        },
      },
    }),
  );
  equal(
    digest,
    await requestChangeProposalDigest({
      ...change,
      status: "approved",
      authority: "human",
      decidedAt: "2026-11-02T00:00:00Z",
    }),
  );
  for (
    const altered of [
      { ...change, designerScopeId: "main" },
      { ...change, operator: teamChange().operator },
      {
        ...change,
        requestedRights: {
          ...change.requestedRights,
          addNetworkHosts: ["example.com"],
        },
      },
    ]
  ) {
    throws(() => assertRequestCreationPolicyChange(altered as PendingChange), {
      code: "INVALID_OPERATOR_REQUEST",
    });
  }
});
