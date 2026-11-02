import { deepStrictEqual, equal, match } from "node:assert/strict";
import type {
  AuthorityExercise,
  OwnerAuthority,
} from "../../../src/domain/governance/authority.ts";
import type { PendingChange } from "../../../src/domain/governance/records/pending-change.ts";
import type { OperatorAuthorityPolicy } from "../../../src/domain/governance/policies/operator-authority-policy.ts";
import {
  authorityChangeForCommit,
  authorityOwner,
  currentAuthorityLabel,
  delegatedDecisionLabel,
  noticeChange,
  recordedCandidateDelegation,
  recordedDelegation,
} from "./operator-authority.ts";
import type { SourceCommit, SourceRevisions } from "../model/revisions/api.ts";
import { grant, operatorRoster } from "../../test/support/operator-fixture.ts";
import type { OperatorNotice } from "./operator-notice.ts";
import { delegatedCandidate } from "../../test/support/candidate-admission-fixture.ts";

const MAIN = "native:designer";
const PEER = "native:research";
const CASE = "ui-fixture:case:2";
const DIGEST = "a".repeat(64);
const HEAD = "commit:" + "b".repeat(40);

Deno.test("candidate delegation presentation binds the exact operator, Request, tests and candidate while retaining historical authority", () => {
  const candidate = delegatedCandidate();
  deepStrictEqual(
    recordedCandidateDelegation(candidate, PEER),
    candidate.admissionDecision!.authorityExercise!.candidateDelegation,
  );
  equal(recordedCandidateDelegation(candidate, MAIN), undefined);
  const mutations: Array<(value: typeof candidate) => void> = [
    (c) => c.digest = "other-digest",
    (c) => c.caseId = "other-request",
    (c) => c.requiredAuthority = "builder",
    (c) => c.tests!.passed = false,
    (c) => c.admission!.authority = "human",
    (c) => c.admission!.actorId = PEER,
    (c) =>
      c.admissionDecision!.authorityExercise!.candidateDelegation!.actorId =
        PEER,
    (c) =>
      c.admissionDecision!.authorityExercise!.candidateDelegation!
        .policyRevision = 2,
    (c) => c.admissionDecision!.authorityExercise!.action = "mandate-change",
    (c) => c.promotionModelDigest = "other-model",
  ];
  for (const mutate of mutations) {
    const invalid = delegatedCandidate();
    mutate(invalid);
    equal(recordedCandidateDelegation(invalid, PEER), undefined);
  }
});

Deno.test("candidate receipt presentation rejects missing or changed captured contracts and incoherent admission outcomes", () => {
  const mutations: Array<
    [string, (candidate: ReturnType<typeof delegatedCandidate>) => void]
  > = [
    ["missing contract pin", (candidate) => {
      delete candidate.toolAdmissionContract;
    }],
    ["changed acceptance criteria", (candidate) => {
      candidate.admissionDecision!.authorityExercise!.candidateDelegation!
        .contract.acceptanceCriteria = ["Different criteria"];
    }],
    ["changed native contract", (candidate) => {
      candidate.admissionDecision!.authorityExercise!.candidateDelegation!
        .contract.nativeId = "other-contract";
    }],
    ["changed module contract", (candidate) => {
      candidate.admissionDecision!.authorityExercise!.candidateDelegation!
        .contract.module = "default() => other" as never;
    }],
    ["identically invalid captured and recorded module", (candidate) => {
      candidate.toolAdmissionContract!.module = "default() => other" as never;
      candidate.admissionDecision!.authorityExercise!.candidateDelegation!
        .contract.module = "default() => other" as never;
    }],
    ["invalid captured contract", (candidate) => {
      candidate.toolAdmissionContract!.acceptanceCriteria = [];
      candidate.admissionDecision!.authorityExercise!.candidateDelegation!
        .contract.acceptanceCriteria = [];
    }],
    ["refusal with admission", (candidate) => {
      candidate.admissionDecision!.verdict = "refuse";
    }],
    ["reason mismatch", (candidate) => {
      candidate.admission!.reason = "A different decision";
    }],
    ["active without admission", (candidate) => {
      delete candidate.admission;
    }],
  ];
  for (const [reason, mutate] of mutations) {
    const candidate = delegatedCandidate();
    mutate(candidate);
    equal(recordedCandidateDelegation(candidate, PEER), undefined, reason);
  }
  const refused = delegatedCandidate();
  refused.stage = "refused";
  refused.admissionDecision!.verdict = "refuse";
  delete refused.admission;
  deepStrictEqual(
    recordedCandidateDelegation(refused, PEER),
    refused.admissionDecision!.authorityExercise!.candidateDelegation,
  );
  for (const authority of ["human", "builder", "reviewer"] as const) {
    const legacy = delegatedCandidate();
    legacy.requiredAuthority = authority;
    legacy.admission!.authority = authority;
    delete legacy.admissionDecision!.authorityExercise;
    delete legacy.admission!.authorityExercise;
    delete legacy.toolAdmissionPolicyPins;
    delete legacy.toolAdmissionContract;
    equal(recordedCandidateDelegation(legacy, PEER), undefined);
  }
});

Deno.test("tool admission grants read their distinct current-source policy and preserve network policy status", () => {
  const change = grant({
    requestedRights: {
      toolAdmission: {
        policyId: "research-tools",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: [PEER],
        toolKinds: ["read_web_page"],
        maxDelegationDepth: 0,
      },
    },
    status: "approved",
    publishedCommit: HEAD,
  });
  equal(authorityOwner(change), MAIN);
  const data = sources();
  data.runtime.sourceRights!.toolAdmissionPolicies = [{
    id: "research-tools",
    revision: 1,
    enabled: true,
    recipients: [PEER],
    toolKinds: ["read_web_page"],
    maxDelegationDepth: 0,
    holderNativeId: MAIN,
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    elementId: "tool-policy:1",
    sourceIds: ["tool-policy:1"],
    rootAuthority: owner("main-system"),
  }];
  equal(
    currentAuthorityLabel(change, { data, fresh: true }),
    "Enabled in current sources · revision 1",
  );
  data.runtime.sourceRights!.toolAdmissionPolicies[0]!.enabled = false;
  equal(
    currentAuthorityLabel(change, { data, fresh: true }),
    "Revoked · current revision 1",
  );
  equal(
    currentAuthorityLabel(exercise(), { data, fresh: true }),
    "Enabled in current sources · revision 1",
  );
  delete data.runtime.sourceRights!.toolAdmissionPolicies;
  equal(
    currentAuthorityLabel(change, { data, fresh: true }),
    "Current policy status unavailable",
  );
});
function owner(systemId: string): OwnerAuthority {
  return {
    ownerSource: "modeled",
    systemId,
    operatorId: "owner",
    operatorNativeId: `${systemId}:owner`,
    mandateId: "owner-mandate",
    mandateNativeId: `${systemId}:owner-mandate`,
    mandateRevision: 1,
    rootAuthorityId: "root",
    rootAuthorityNativeId: `${systemId}:root`,
    rootGrantId: "root-grant",
    rootGrantNativeId: `${systemId}:root-grant`,
    sourceIds: ["owner-source"],
  };
}
function exercise(patch: Partial<PendingChange> = {}): PendingChange {
  const rights = { addNetworkHosts: ["example.org"] };
  const authorityExercise: AuthorityExercise = {
    ...owner("research-system"),
    authoritySchema: 2,
    action: "mandate-change",
    baseModelDigest: DIGEST,
    outOfMandate: false,
    delegation: {
      actorId: MAIN,
      policyId: "research-network",
      policyRevision: 1,
      policyElementId: "policy:1",
      policyIssuer: owner("main-system"),
      requestedBy: PEER,
      changeId: "network-change",
      caseId: CASE,
      requestedRights: structuredClone(rights),
    },
  };
  return grant({
    id: "network-change",
    requestedBy: PEER,
    caseId: CASE,
    status: "approved",
    authority: "builder",
    authorityExercise,
    baseModelDigest: DIGEST,
    requestedRights: rights,
    decidedAt: "2026-10-26T00:00:00Z",
    publishedCommit: HEAD,
    ...patch,
  });
}
function policy(
  patch: Partial<OperatorAuthorityPolicy> = {},
): OperatorAuthorityPolicy {
  return {
    id: "research-network",
    revision: 1,
    enabled: true,
    recipients: [PEER],
    acts: ["addNetworkHosts"],
    networkHosts: ["example.org", "example.net"],
    toolIds: [],
    maxDelegationDepth: 0,
    holderNativeId: MAIN,
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    elementId: "policy:1",
    sourceIds: ["policy:1"],
    rootAuthority: owner("main-system"),
    ...patch,
  };
}
function sources(policies = [policy()]): SourceRevisions {
  return {
    agentId: MAIN,
    version: HEAD,
    sourceDigest: "current-source",
    proposals: [],
    runtime: {
      available: { digest: "current", repositoryVersion: HEAD },
      active: {
        digest: "old-pin",
        repositoryVersion: "commit:" + "c".repeat(40),
      },
      executable: true,
      sourceRights: {
        modelEditPolicy: null,
        modelAdministration: null,
        operatorAuthorityPolicies: policies,
      },
    },
  };
}
const notice: OperatorNotice = {
  kind: "authority-escalation",
  changeId: "network-change",
  requestedBy: PEER,
  caseId: CASE,
  recipient: MAIN,
  decisionAuthority: "human",
  reason: "Request exact hosts",
};

Deno.test("delegated evidence names the exact actor rather than the requester or a homonymous operator", () => {
  const change = exercise();
  const roster = operatorRoster([], [change]).conversations;
  roster[0].name = "Main Operator";
  roster[1].name = "Main Operator";
  equal(authorityOwner(change), MAIN);
  deepStrictEqual(
    recordedDelegation(change),
    change.authorityExercise!.delegation,
  );
  equal(
    delegatedDecisionLabel(change, roster),
    "Decided by Main Operator · research-network revision 1",
  );
  equal(
    delegatedDecisionLabel(exercise({ status: "refused" }), roster),
    "Declined by Main Operator · research-network revision 1",
  );
  const grantProposal = grant({
    requestedRights: {
      operatorAuthority: {
        policyId: "research-network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: [PEER],
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org"],
        toolIds: [],
        maxDelegationDepth: 0,
      },
    },
  });
  equal(authorityOwner(grantProposal), MAIN);
  equal(authorityOwner(grant()), undefined);
});

Deno.test("delegated presentation requires the complete exact change, case, requester, rights and base binding", () => {
  const mutations: Array<(change: PendingChange) => void> = [
    (c) => {
      c.kind = "operator-creation";
    },
    (c) => {
      c.kind = "reviewer-creation";
    },
    (c) => {
      c.designerScopeId = "foreign-design-origin";
    },
    (c) => {
      const rights = {
        addNetworkHosts: ["example.org"],
        setUrlSelectionMode: "authorized-host" as const,
      };
      c.requestedRights = rights;
      c.authorityExercise!.delegation!.requestedRights = structuredClone(
        rights,
      );
    },
    (c) => {
      c.status = "pending";
    },
    (c) => {
      c.authority = "human";
    },
    (c) => {
      delete c.decidedAt;
    },
    (c) => {
      delete c.baseModelDigest;
    },
    (c) => {
      c.baseModelDigest = "foreign-base";
    },
    (c) => {
      c.authorityExercise!.action = "candidate-admission";
    },
    (c) => {
      c.authorityExercise!.outOfMandate = true;
    },
    (c) => {
      c.authorityExercise!.delegation!.changeId = "other-change";
    },
    (c) => {
      c.authorityExercise!.delegation!.requestedBy = MAIN;
    },
    (c) => {
      c.authorityExercise!.delegation!.caseId = "other-case";
    },
    (c) => {
      delete c.caseId;
    },
    (c) => {
      c.authorityExercise!.delegation!.actorId = PEER;
    },
    (c) => {
      c.authorityExercise!.delegation!.policyRevision = 0;
    },
    (c) => {
      c.authorityExercise!.delegation!.requestedRights = {
        addNetworkHosts: ["example.net"],
      };
    },
  ];
  for (const mutate of mutations) {
    const change = exercise();
    mutate(change);
    equal(recordedDelegation(change), undefined);
    equal(delegatedDecisionLabel(change, []), undefined);
  }
});

Deno.test("current policy state comes from available sources despite a different active pin", () => {
  equal(
    currentAuthorityLabel(exercise(), { data: sources(), fresh: true }),
    "Enabled in current sources · revision 1",
  );
  equal(
    currentAuthorityLabel(exercise(), {
      data: sources([policy({ revision: 2, enabled: false })]),
      fresh: true,
    }),
    "Revoked · current revision 2",
  );
  equal(
    currentAuthorityLabel(exercise(), {
      data: sources([policy({ revision: 2 })]),
      fresh: true,
    }),
    "Policy revision changed · current revision 2",
  );
  equal(
    currentAuthorityLabel(exercise(), { data: sources([]), fresh: true }),
    "Not granted in the current model",
  );
});

Deno.test("unavailable, foreign, stale, duplicate or inconsistent source observations never announce an enabled policy", () => {
  const unavailable = "Current policy status unavailable";
  equal(currentAuthorityLabel(exercise()), unavailable);
  equal(
    currentAuthorityLabel(exercise(), { data: sources(), fresh: false }),
    unavailable,
  );
  equal(
    currentAuthorityLabel(exercise(), { data: null, fresh: true }),
    unavailable,
  );
  const variants = [
    (s: SourceRevisions) => {
      s.agentId = PEER;
    },
    (s: SourceRevisions) => {
      s.runtime.executable = false;
    },
    (s: SourceRevisions) => {
      s.runtime.available = null;
    },
    (s: SourceRevisions) => {
      s.runtime.available!.repositoryVersion = "commit:" + "d".repeat(40);
    },
    (s: SourceRevisions) => {
      delete s.runtime.sourceRights!.operatorAuthorityPolicies;
    },
    (s: SourceRevisions) => {
      s.runtime.sourceRights!.operatorAuthorityPolicies!.push(policy());
    },
  ];
  for (const mutate of variants) {
    const data = sources();
    mutate(data);
    equal(
      currentAuthorityLabel(exercise(), { data, fresh: true }),
      unavailable,
    );
  }
  const foreignHolder = sources([policy({ holderNativeId: PEER })]);
  equal(
    currentAuthorityLabel(exercise(), { data: foreignHolder, fresh: true }),
    "Not granted in the current model",
  );
});

Deno.test("the current policy must match the recorded issuer, element, recipients and exercised bounds", () => {
  const differs = "Current policy differs from the recorded authority";
  const variants: Array<Partial<OperatorAuthorityPolicy>> = [
    { elementId: "foreign-policy-element" },
    { rootAuthority: owner("other-issuer") },
    { recipients: ["native:other-recipient"] },
    { networkHosts: ["example.net"] },
    { acts: [] as never },
    { toolIds: ["extra-tool"] as never },
    { maxDelegationDepth: 1 as never },
  ];
  for (const patch of variants) {
    equal(
      currentAuthorityLabel(exercise(), {
        data: sources([policy(patch)]),
        fresh: true,
      }),
      differs,
    );
  }
  const noRoot = policy();
  delete noRoot.rootAuthority;
  equal(
    currentAuthorityLabel(exercise(), { data: sources([noRoot]), fresh: true }),
    "Current policy status unavailable",
  );
  const noPolicyElement = exercise();
  noPolicyElement.authorityExercise!.delegation!.policyElementId = "";
  equal(
    currentAuthorityLabel(noPolicyElement, { data: sources(), fresh: true }),
    "Current policy status unavailable",
  );
  const expanded = policy({
    networkHosts: ["example.org", "example.net", "example.com"],
  });
  equal(
    currentAuthorityLabel(exercise(), {
      data: sources([expanded]),
      fresh: true,
    }),
    "Enabled in current sources · revision 1",
  );
});

Deno.test("a published grant cannot describe altered scope under the same policy identity and revision as enabled", () => {
  const change = grant({
    status: "approved",
    authority: "human",
    baseModelDigest: DIGEST,
    decidedAt: "2026-10-26T00:00:00Z",
    publishedCommit: HEAD,
    authorityExercise: {
      ...owner("main-system"),
      authoritySchema: 2,
      action: "mandate-change",
      baseModelDigest: DIGEST,
      outOfMandate: false,
    },
    requestedRights: {
      operatorAuthority: {
        policyId: "research-network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: [PEER],
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org", "example.net"],
        toolIds: [],
        maxDelegationDepth: 0,
      },
    },
  });
  equal(
    currentAuthorityLabel(change, { data: sources(), fresh: true }),
    "Enabled in current sources · revision 1",
  );
  const rewritten: Array<Partial<OperatorAuthorityPolicy>> = [
    { recipients: ["native:other"] },
    { networkHosts: ["example.org", "example.net", "example.com"] },
    { acts: [] as never },
    { toolIds: ["extra-tool"] as never },
    { maxDelegationDepth: 1 as never },
  ];
  for (const patch of rewritten) {
    equal(
      currentAuthorityLabel(change, {
        data: sources([policy(patch)]),
        fresh: true,
      }),
      "Current policy differs from the recorded authority",
    );
  }
});

Deno.test("a notice is joined only to its exact native owner, change and Request", () => {
  const change = exercise();
  const roster = operatorRoster([], [change]).conversations;
  equal(noticeChange(notice, roster), change);
  for (
    const patch of [
      { requestedBy: MAIN },
      { changeId: "other-change" },
      { caseId: "other-case" },
    ]
  ) equal(noticeChange({ ...notice, ...patch }, roster), undefined);
  equal(
    noticeChange(notice, operatorRoster([change]).conversations),
    undefined,
  );
  const duplicate = structuredClone(roster[1]);
  duplicate.agentId = "same-native-other-session";
  equal(noticeChange(notice, [...roster, duplicate]), undefined);
});

Deno.test("a published change is joined to a commit only by host-parsed author, exact native owner and exact publication", () => {
  const change = exercise();
  const roster = operatorRoster([], [change]).conversations;
  const commit: Pick<SourceCommit, "version" | "parsedAuthor"> = {
    version: HEAD,
    parsedAuthor: { kind: "ase", ref: `approved-change:${change.id}` },
  };
  equal(authorityChangeForCommit(commit, roster), change);
  equal(
    authorityChangeForCommit({ ...commit, version: HEAD.slice(7) }, roster),
    change,
  );
  equal(
    authorityChangeForCommit(
      { ...commit, version: "commit:" + "e".repeat(40) },
      roster,
    ),
    undefined,
  );
  equal(
    authorityChangeForCommit({
      ...commit,
      parsedAuthor: { kind: "agent", ref: `approved-change:${change.id}` },
    }, roster),
    undefined,
  );
  equal(
    authorityChangeForCommit({
      ...commit,
      parsedAuthor: { kind: "ase", ref: "activate-candidate:network-change" },
    }, roster),
    undefined,
  );
  equal(
    authorityChangeForCommit(commit, operatorRoster([change]).conversations),
    undefined,
  );
  for (
    const patch of [{ status: "pending" as const }, {
      publishedCommit: undefined,
    }, { authorityExercise: undefined }]
  ) {
    equal(
      authorityChangeForCommit(
        commit,
        operatorRoster([], [exercise(patch)]).conversations,
      ),
      undefined,
    );
  }
  equal(
    authorityChangeForCommit(commit, [...roster, structuredClone(roster[1])]),
    undefined,
  );
  match(delegatedDecisionLabel(change, [])!, /native:designer/);
});

Deno.test("a policy grant commit requires its prior owner receipt rather than an approved status alone", () => {
  const change = grant({
    id: "owner-policy-grant",
    status: "approved",
    authority: "human",
    decidedAt: "2026-10-26T00:00:00Z",
    baseModelDigest: DIGEST,
    publishedCommit: HEAD,
    requestedRights: {
      operatorAuthority: {
        policyId: "research-network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: [PEER],
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org"],
        toolIds: [],
        maxDelegationDepth: 0,
      },
    },
    authorityExercise: {
      ...owner("main-system"),
      authoritySchema: 2,
      action: "mandate-change",
      baseModelDigest: DIGEST,
      outOfMandate: false,
    },
  });
  const commit: Pick<SourceCommit, "version" | "parsedAuthor"> = {
    version: HEAD,
    parsedAuthor: { kind: "ase", ref: `approved-change:${change.id}` },
  };
  equal(
    authorityChangeForCommit(commit, operatorRoster([change]).conversations),
    change,
  );
  const mutations: Array<(value: PendingChange) => void> = [
    (c) => {
      delete c.authorityExercise;
    },
    (c) => {
      delete c.baseModelDigest;
    },
    (c) => {
      c.authorityExercise!.baseModelDigest = "other-base";
    },
    (c) => {
      c.authorityExercise!.action = "model-adoption";
    },
    (c) => {
      c.authorityExercise!.outOfMandate = true;
    },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(change);
    mutate(invalid);
    equal(
      authorityChangeForCommit(commit, operatorRoster([invalid]).conversations),
      undefined,
    );
  }
});

Deno.test("4.8d D5: a policy with and without a recipient space never compare equal", () => {
  const request = {
    policyId: "research-tools",
    expectedPolicyRevision: 0,
    enabled: true,
    recipients: [PEER],
    toolKinds: ["read_web_page" as const],
    maxDelegationDepth: 0 as const,
  };
  const current = {
    id: "research-tools",
    revision: 1,
    enabled: true,
    recipients: [PEER],
    toolKinds: ["read_web_page" as const],
    maxDelegationDepth: 0 as const,
    holderNativeId: MAIN,
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    elementId: "tool-policy:1",
    sourceIds: ["tool-policy:1"],
    rootAuthority: owner("main-system"),
  };
  const label = (
    asked: Record<string, unknown>,
    policy: Record<string, unknown>,
  ) => {
    const data = sources();
    data.runtime.sourceRights!.toolAdmissionPolicies = [
      policy as typeof current,
    ];
    return currentAuthorityLabel(
      grant({
        requestedRights: { toolAdmission: asked as typeof request },
        status: "approved",
        publishedCommit: HEAD,
      }),
      { data, fresh: true },
    );
  };
  const differs = "Current policy differs from the recorded authority";
  equal(
    label({ ...request, recipientExecutionSpaceId: "space-x" }, current),
    differs,
  );
  equal(
    label(request, { ...current, recipientExecutionSpaceId: "space-x" }),
    differs,
  );
  equal(
    label(
      { ...request, recipientExecutionSpaceId: "space-x" },
      { ...current, recipientExecutionSpaceId: "space-x" },
    ),
    "Enabled in current sources · revision 1",
  );
});
