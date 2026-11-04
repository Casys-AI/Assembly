import type { PreparedChangeDiff } from "../../../src/domain/governance/operator-authority.ts";
import type { ConversationsSnapshot } from "../../../src/application/work/operators/conversation-types.ts";
import type { ChangeWithDiff } from "../../lib/model/revisions/change.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";

/** Changes that carry the diff of prepared sources, and the operators asking. */
export const BASE = "commit:0123456789abcdef0123456789abcdef01234567";
export const PATCH = [
  "diff --git a/configuration.sysml b/configuration.sysml",
  "index 1111111..2222222 100644",
  "--- a/configuration.sysml",
  "+++ b/configuration.sysml",
  "@@ -1,2 +1,4 @@",
  " part def Configuration {",
  "+  attribute editing;",
  "+  doc /* <img src=x onerror=attack()> */",
  " }",
  "",
].join("\n");

export function diff(patch = PATCH): PreparedChangeDiff {
  return {
    title: "Compose the system",
    author: "native:designer",
    base: {
      repositoryVersion: BASE,
      modelDigest: "model",
      sourceDigest: "source",
    },
    sourceDigest: "next",
    files: [{
      path: "configuration.sysml",
      kind: "changed",
      additions: 2,
      deletions: 0,
    }],
    patch,
    additions: 2,
    deletions: 0,
  };
}
export function grant(patch: Partial<ChangeWithDiff> = {}): ChangeWithDiff {
  return {
    id: "grant",
    kind: "mandate-change",
    status: "pending",
    requestedBy: "native:designer",
    caseId: "ui-fixture:case:1",
    baseRevision: 1,
    reason: "Compose the system",
    requestedAt: "2026-10-24T10:00:00Z",
    requestedRights: {
      grantModelEditing: {
        file: "configuration.sysml",
        root: "ASELiveBuilder",
        operations: ["insert-member"],
      },
    },
    diff: diff(),
    ...patch,
  };
}
export function creation(patch: Partial<ChangeWithDiff> = {}): ChangeWithDiff {
  return grant({
    id: "creation",
    kind: "operator-creation",
    role: "operator",
    name: "Research",
    requestedRights: undefined,
    operator: {
      instruction: "Answer concise research requests.",
      networkHosts: [],
      requestType: { name: "Research request", maxInvocations: 4 },
      firstRequest: { objective: "Ask for permission to read example.org." },
    },
    ...patch,
  });
}

const operator = {
  responsibility: "Operate",
  revision: 3,
  busy: false,
  phase: "Ready",
  modelDigest: "digest",
  runtimeOwned: true,
};
/** The designer, and Research: an operator that takes messages only in its Requests. */
export function operatorRoster(
  changes: PendingChange[] = [],
  research: PendingChange[] = [],
): ConversationsSnapshot {
  const context = (list: PendingChange[]) => ({
    configurationRevision: 1,
    before: {
      network: { allowedHosts: [] },
      builder: { admissionAuthority: "human" as const },
    },
    changes: list,
  });
  return {
    systemId: "ui-fixture",
    defaultAgentId: "designer",
    version: "operators-1",
    conversations: [{
      ...operator,
      agentId: "designer",
      nativeId: "native:designer",
      name: "Designer",
      primary: true,
      canSend: true,
      messages: [],
      proposalContext: context(changes),
    }, {
      ...operator,
      agentId: "research",
      nativeId: "native:research",
      name: "Research",
      primary: false,
      canSend: false,
      readOnlyReason: "This mandate receives requests from the coordinator.",
      messages: [],
      proposalContext: context(research),
    }],
  };
}
