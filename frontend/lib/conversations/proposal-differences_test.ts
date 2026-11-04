import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  creation,
  operatorRoster,
} from "../../test/support/operator-fixture.ts";
import {
  changeDifferences,
  changeScope,
  changeTitle,
  memberFacts,
} from "./proposal-differences.ts";
import { changeOutcome } from "../model/revisions/change.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";

const provision = (networkHosts: string[] = []) => ({
  budget: { maxAgentDecisions: 3, maxToolProposals: 1, maxFlowSteps: 20 },
  networkHosts,
  mayPropose: [],
  mayInvokeActiveCatalog: false,
});

Deno.test("a creation grant card states the branch, whole-team limit, hosts, mode and no redelegation", () => {
  const context = operatorRoster().conversations[0]!.proposalContext!;
  const change: PendingChange = {
    id: "grant",
    kind: "mandate-change",
    status: "pending",
    reason: "Review",
    requestedAt: "2026-11-02T00:00:00Z",
    caseId: "case",
    requestedBy: "bo",
    baseRevision: context.configurationRevision,
    requestedRights: {
      operatorCreation: {
        networkHosts: ["example.org"],
        maxChildren: 2,
        mode: "per-creation",
      },
    },
  };
  equal(changeTitle(change), "Grant team creation rights");
  deepStrictEqual(changeScope(change), [
    "This Request branch only",
    "Up to 2 members across the whole team",
    "Network hosts: example.org",
    "Approval for each creation",
    "No further delegation",
  ]);
  deepStrictEqual(changeDifferences(change, context), [{
    id: "operator-creation-policy",
    label: "Team creation rights",
    before: "None",
    after: changeScope(change).join("\n"),
  }]);
  change.requestedRights = {
    operatorCreation: { networkHosts: [], maxChildren: 3, mode: "autonomous" },
  };
  ok(changeScope(change).includes("Network hosts: none"));
  ok(changeScope(change).includes("Autonomous creation within these bounds"));
  deepStrictEqual(
    changeDifferences({ ...change, status: "approved" }, context),
    [],
  );
});

Deno.test("team creation shows originating Request without inventing a child Request", () => {
  const change = creation({
    operator: {
      kind: "request-team-member",
      instruction: "Contribute",
      provision: provision(),
    },
    teamOrigin: {
      operatorId: "native:designer",
      requestId: "ui-fixture:case:1",
    },
  });
  equal(changeTitle(change), "Create team operator Research");
  deepStrictEqual(changeScope(change), [
    "Originating Request: ui-fixture:case:1",
    "Contributes within the same Request; no new Request",
    "no network",
    "No further operator creation rights",
  ]);
  const context = operatorRoster().conversations[0]!.proposalContext!;
  const rows = changeDifferences(change, context);
  ok(
    rows.some((row) =>
      row.id === "request-team" && row.label === "Request team"
    ),
  );
  ok(!rows.some((row) => row.id === "request-type"));
  equal(changeOutcome(change), "pending");
  equal(
    changeOutcome({ ...change, status: "approved", diff: undefined }),
    "accepted",
  );
  equal(
    changeOutcome({
      ...change,
      status: "approved",
      publishedCommit: "commit:published",
    }),
    "applied",
  );
  equal(changeOutcome({ ...change, status: "refused" }), "declined");
  deepStrictEqual(
    changeDifferences({ ...change, status: "approved" }, context),
    [],
  );
  ok(changeScope(creation()).includes("Research request"));
});

Deno.test("team proposal displays bounded transmitted creation rights", () => {
  const change = creation({
    operator: {
      kind: "request-team-member",
      instruction: "Contribute",
      provision: provision(["example.org"]),
      creationGrant: {
        networkHosts: ["example.org"],
        maxChildren: 2,
        maxDelegationDepth: 0,
      },
    },
  });
  const scope = changeScope(change);
  ok(scope.includes("Creation grant: up to 2 operators"));
  ok(scope.includes("Delegation depth: 0"));
  ok(scope.includes("Creation hosts: example.org"));
  ok(scope.includes("Originating Request not recorded"));
});

Deno.test("a new member's rights read as three facts: its Request, its network, whom it creates", () => {
  const bare = {
    kind: "request-team-member" as const,
    instruction: "Contribute",
    provision: provision(),
  };
  deepStrictEqual(memberFacts(bare).map(({ kind, label }) => [kind, label]), [
    ["request", "this Request"],
    ["network", "no network"],
    ["creation", "creates no one"],
  ]);
  const granted = memberFacts({
    ...bare,
    provision: provision(["example.org"]),
    creationGrant: {
      networkHosts: [],
      maxChildren: 2,
      maxDelegationDepth: 0,
    },
  });
  deepStrictEqual(granted.slice(1), [{
    kind: "network",
    label: "example.org",
    detail: "Network hosts: example.org",
  }, {
    kind: "creation",
    label: "creates ≤ 2",
    detail:
      "Creation grant: up to 2 operators · delegation depth 0 · hosts none",
  }]);
  // Hosts recorded at the spec root before provisions existed still count.
  equal(
    memberFacts(
      { ...bare, provision: undefined, networkHosts: ["a.org"] } as never,
    )[1]
      .label,
    "a.org",
  );
});

Deno.test("a team creation persisted before provision existed displays without crashing", () => {
  // Pre-E2 shape: hosts at the spec root, no provision. Display falls back to
  // those recorded hosts; it never invents the missing provision.
  const change = creation({
    operator: {
      kind: "request-team-member",
      instruction: "Contribute",
      networkHosts: ["legacy.example.org"],
    } as never,
    teamOrigin: {
      operatorId: "native:designer",
      requestId: "ui-fixture:case:1",
    },
  });
  equal(changeTitle(change), "Create team operator Research");
  deepStrictEqual(changeScope(change), [
    "Originating Request: ui-fixture:case:1",
    "Contributes within the same Request; no new Request",
    "legacy.example.org",
    "No further operator creation rights",
  ]);
  const bare = {
    ...change,
    operator: {
      kind: "request-team-member",
      instruction: "Contribute",
    } as never,
  };
  ok(changeScope(bare).includes("no network"));
});

Deno.test("initial Request operator proposals display explicitly requested team creation bounds", () => {
  const original = creation();
  const legacy = original.operator!;
  const creationGrant = {
    networkHosts: ["example.org"],
    maxChildren: 3,
    maxDelegationDepth: 1,
  };
  const granted = { ...original, operator: { ...legacy, creationGrant } };
  deepStrictEqual(changeScope(original), [
    "Research request",
    "up to 4 invocations",
    "no network",
  ]);
  deepStrictEqual(changeScope(granted), [
    ...changeScope(original),
    "Creation grant: up to 3 operators",
    "Workspace limit: 64 operators",
    "Delegation depth: 1",
    "Creation hosts: example.org",
  ]);
  const context = operatorRoster().conversations[0]!.proposalContext!;
  const rows = changeDifferences(granted, context);
  ok(
    rows.some((row) => row.after.includes("Creation grant: up to 3 operators")),
  );
  equal(changeTitle(granted), "Create operator Research");
});
