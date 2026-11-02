import { equal } from "node:assert/strict";
import { isCaseChangeDecision } from "./case-change.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";

const diff = {
  title: "Change",
  author: "operator",
  base: {
    repositoryVersion: `commit:${"b".repeat(40)}`,
    modelDigest: "a".repeat(64),
    sourceDigest: "c".repeat(64),
  },
  sourceDigest: "d".repeat(64),
  files: [],
  patch: "",
  additions: 0,
  deletions: 0,
};
const common = {
  status: "pending",
  requestedBy: "operator",
  caseId: "case",
  baseRevision: 1,
  baseModelDigest: "a".repeat(64),
  reason: "Needed",
  requestedAt: "2026-11-01T00:00:00.000Z",
  diff,
};
const network = {
  ...common,
  id: "network",
  kind: "mandate-change",
  requestedRights: { addNetworkHosts: ["example.org"] },
} as unknown as PendingChange;
const team = {
  ...common,
  id: "team",
  kind: "operator-creation",
  name: "Helper",
  role: "operator",
  operator: {
    kind: "request-team-member",
    instruction: "Extract one passage.",
    provision: {
      budget: { maxAgentDecisions: 1, maxToolProposals: 1, maxFlowSteps: 8 },
      networkHosts: [],
      mayPropose: [],
      mayInvokeActiveCatalog: false,
    },
  },
  teamOrigin: { operatorId: "operator", requestId: "case" },
} as unknown as PendingChange;

Deno.test("4.8e E4c: a Case card decides a network request or a team creation of its own BO", () => {
  equal(isCaseChangeDecision(network, "case", "operator"), true);
  equal(isCaseChangeDecision(team, "case", "operator"), true);
  // Another Case, another agent, no preview, another kind: not this card's.
  equal(isCaseChangeDecision(team, "other", "operator"), false);
  equal(isCaseChangeDecision(team, "case", "someone"), false);
  equal(
    isCaseChangeDecision({ ...team, diff: undefined }, "case", "operator"),
    false,
  );
  equal(
    isCaseChangeDecision(
      { ...team, teamOrigin: { operatorId: "operator", requestId: "other" } },
      "case",
      "operator",
    ),
    false,
  );
  equal(
    isCaseChangeDecision(
      { ...team, kind: "reviewer-creation" } as PendingChange,
      "case",
      "operator",
    ),
    false,
  );
});
