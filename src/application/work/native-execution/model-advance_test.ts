import {
  assertBusinessRevisionReference,
  assertBusinessRevisionState,
} from "./history.ts";
import { nativeFlowContractDigest } from "../../../domain/model/execution/flow-contract.ts";
import assert from "node:assert/strict";
import {
  commandOwnApprovedAdvance,
  nativeCatalogAdvanceEvidence,
  nativeMandateAdvanceEvidence,
  nativePromotionDependencies,
  nativeSettledActionAdvanceEvidence,
  nativeTeamAdvanceEvidence,
  rederiveSettledAdvanceEvidence,
} from "./model-advance.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { requestOwnerAuthority } from "../../../../test/support/request-space-fixture.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import type { NativeSpaceControlPolicy } from "../../../domain/governance/policies/space-execution-policy.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  type NativeExecutionScope,
  runtimeRevisionReference,
} from "./contract.ts";

function reviewerPublication() {
  const previous = executableFixture({
    projectId: "reviewer-project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  previous.version.repositoryVersion = "commit:before";
  const configuration = structuredClone(previous.configuration);
  configuration.revision++;
  configuration.builder.mandateRevision++;
  configuration.builder.admissionAuthority = "reviewer";
  configuration.reviewer = {
    id: "reviewer-change",
    name: "Exact reviewer",
    mandateRevision: 1,
  };
  const adopted = executableFixture({
    ...previous.identity,
    reviewerId: "reviewer-native",
  }, configuration);
  adopted.version.repositoryVersion = "commit:published-reviewer";
  const change: PendingChange = {
    id: "reviewer-change",
    kind: "reviewer-creation",
    status: "approved",
    authority: "human",
    authorityExercise: exerciseOwnerAuthority(previous, "mandate-change"),
    requestedBy: "builder",
    designerScopeId: "designer",
    role: "reviewer",
    name: "Exact reviewer",
    mandate: {
      mayReviewExactCandidate: true,
      mayAdmitReviewedCandidates: true,
    },
    baseRevision: previous.configuration.revision,
    baseModelDigest: previous.version.digest,
    reason: "Separate review and admission",
    requestedAt: "before",
    decidedAt: "decided",
    publishedCommit: adopted.version.repositoryVersion,
    diff: {
      title: "Reviewer creation",
      author: "builder",
      base: {
        repositoryVersion: previous.version.repositoryVersion,
        modelDigest: previous.version.digest,
        sourceDigest: "base-source",
      },
      sourceDigest: "approved-source",
      files: [],
      patch: "",
      additions: 0,
      deletions: 0,
    },
  };
  const state: SystemRuntimeState = {
    id: "runtime",
    revision: 7,
    catalogRevision: 0,
    busy: false,
    phase: "ready",
    provider: "controlled",
    messages: [],
    events: [],
    candidates: [],
    model: adopted.identity,
    executionModel: adopted,
    configuration: { ...configuration, changes: [change] },
  };
  return { previous, adopted, change, state };
}

Deno.test("reviewer publication preserves owner and retained flows while binding every target promotion byte", async () => {
  const f = reviewerPublication();
  const previous = structuredClone(f.previous),
    adopted = structuredClone(f.adopted);
  const proof = await nativeMandateAdvanceEvidence(
    f.previous,
    f.state,
    f.change.id,
  );
  assert.ok(proof);
  assert.deepEqual(proof.from, {
    identity: previous.identity,
    version: previous.version,
  });
  assert.deepEqual(proof.to, {
    identity: adopted.identity,
    version: adopted.version,
  });
  assert.deepEqual(proof.businessRevision, runtimeRevisionReference(f.state));
  assert.equal(
    proof.flowContractDigest,
    await nativeFlowContractDigest(adopted),
  );
  assert.notEqual(
    proof.flowContractDigest,
    await nativeFlowContractDigest(previous),
  );
  const alteredTarget = structuredClone(adopted);
  alteredTarget.flows.promotion.nodes[0].name = "Unapproved target drift";
  assert.notEqual(
    await nativeFlowContractDigest(alteredTarget),
    proof.flowContractDigest,
    "The existing ledger target check cannot accept promotion drift under the same pin",
  );
  assert.deepEqual(f.previous, previous);
  assert.deepEqual(f.adopted, adopted);
  f.change.status = "pending";
  assert.ok(
    await nativeMandateAdvanceEvidence(f.previous, f.state, f.change.id),
    "A publication still completing has the same exact bounded transition",
  );
});

Deno.test("reviewer continuation refuses source, receipt, owner, reviewer, other-flow and authority drift", async () => {
  const mutations: Array<(f: ReturnType<typeof reviewerPublication>) => void> =
    [
      (f) => {
        delete f.previous.version.repositoryVersion;
      },
      (f) => {
        delete f.adopted.version.repositoryVersion;
      },
      (f) => {
        f.change.baseModelDigest = "foreign-base";
      },
      (f) => {
        // The base is the retained model, identified by its digest: a
        // foreign base is a foreign model, whatever its commit.
        f.change.diff!.base.repositoryVersion = "foreign-base";
        f.change.diff!.base.modelDigest = "foreign-base-model";
      },
      (f) => {
        f.change.diff!.base.modelDigest = "foreign-source-digest";
      },
      (f) => {
        f.change.publishedCommit = "foreign-target";
      },
      (f) => {
        f.change.status = "refused";
      },
      (f) => {
        delete f.change.decidedAt;
      },
      (f) => {
        f.adopted.identity.builderId = "foreign-owner";
      },
      (f) => {
        f.adopted.identity.catalogId = "foreign-catalog";
      },
      (f) => {
        f.adopted.identity.systemId = "foreign-system";
      },
      (f) => {
        f.adopted.flows.conversation.maxSteps++;
      },
      (f) => {
        f.previous.caseFlows = {
          scheduled: structuredClone(f.previous.flows.conversation),
        };
        f.adopted.caseFlows = structuredClone(f.previous.caseFlows);
        f.adopted.caseFlows.scheduled.maxSteps++;
      },
      (f) => {
        Reflect.set(
          f.adopted.flows,
          "foreign",
          structuredClone(f.adopted.flows.conversation),
        );
      },
      (f) => {
        delete f.adopted.identity.reviewerId;
      },
      (f) => {
        f.adopted.identity.reviewerId = "different-reviewer";
      },
      (f) => {
        f.adopted.identity.reviewerId = f.previous.identity.builderId;
        f.adopted.flows.promotion.nodes.find((node) =>
          node.mechanism === "review_candidate"
        )!.performerId = f.previous.identity.builderId;
      },
      (f) => {
        f.adopted.configuration.reviewer!.id = "different-change";
      },
      (f) => {
        f.adopted.configuration.reviewer!.name = "different-name";
      },
      (f) => {
        f.adopted.configuration.reviewer!.mandateRevision = 2;
      },
      (f) => {
        f.adopted.flows.promotion.nodes.find((node) =>
          node.mechanism === "review_candidate"
        )!.performerId = "foreign-reviewer";
      },
      (f) => {
        delete f.adopted.flows.promotion.nodes.find((node) =>
          node.mechanism === "review_candidate"
        )!.allocationId;
      },
      (f) => {
        f.adopted.flows.promotion.nodes.push(
          structuredClone(
            f.adopted.flows.promotion.nodes.find((node) =>
              node.mechanism === "review_candidate"
            )!,
          ),
        );
      },
      (f) => {
        f.change.kind = "mandate-change";
      },
      (f) => {
        f.change.role = "operator";
      },
      (f) => {
        delete f.change.mandate;
      },
      (f) => {
        delete f.change.authorityExercise;
      },
      (f) => {
        f.change.authorityExercise!.action = "model-adoption";
      },
      (f) => {
        f.change.authorityExercise!.baseModelDigest = "foreign-authority-base";
      },
      (f) => {
        f.change.authorityExercise!.outOfMandate = true;
      },
      (f) => {
        f.change.authorityExercise!.mandateId = "foreign-mandate";
      },
      (f) => {
        f.change.authority = "builder";
      },
      (f) => {
        f.previous.policy.mayCreateReviewer = false;
      },
      (f) => {
        f.adopted.configuration.revision++;
      },
      (f) => {
        f.adopted.configuration.builder.mandateRevision++;
      },
    ];
  for (const [index, mutate] of mutations.entries()) {
    const f = reviewerPublication();
    mutate(f);
    await assert.rejects(
      () => nativeMandateAdvanceEvidence(f.previous, f.state, f.change.id),
      Error,
      `Reviewer drift ${index}`,
    );
  }
  const fake = reviewerPublication();
  fake.adopted.identity = structuredClone(fake.previous.identity);
  fake.adopted.configuration = structuredClone(fake.previous.configuration);
  fake.adopted.flows = structuredClone(fake.previous.flows);
  await assert.rejects(
    () =>
      nativeMandateAdvanceEvidence(fake.previous, fake.state, fake.change.id),
    /exact approved publication/,
  );
});

Deno.test("native promotion dependencies use actual nonterminal owners and unsettled terminal receipts", () => {
  const f = reviewerPublication();
  const promotion: import("./contract.ts").NativeExecutionSnapshot = {
    identity: {
      operatorId: "builder",
      invocationKey: "designer",
      scope: { kind: "designer", scopeId: "designer", ownerId: "builder" },
      purpose: "promotion",
      subjectId: "candidate",
    },
    threadId: "promotion-thread",
    contributionId: "input",
    modelDigest: f.previous.version.digest,
    repositoryVersion: f.previous.version.repositoryVersion,
    flowRootId: f.previous.flows.promotion.rootNativeId,
    status: "completed",
    waits: [],
    unsettledEffects: [],
    pendingContributions: [],
  };
  assert.deepEqual(nativePromotionDependencies(f.state, [promotion]), []);
  for (
    const status of [
      "waiting",
      "running",
      "failed",
      "uncertain",
      "advancing",
    ] as const
  ) {
    const actual = { ...promotion, status };
    assert.deepEqual(nativePromotionDependencies(f.state, [actual]), [actual]);
  }
  for (
    const actual of [
      { ...promotion, unsettledEffects: ["unknown-effect"] },
      { ...promotion, openImmutableConsultationGroups: ["unpublished-group"] },
      { ...promotion, pendingContributions: ["unsettled-child"] },
    ]
  ) assert.deepEqual(nativePromotionDependencies(f.state, [actual]), [actual]);
  assert.deepEqual(
    nativePromotionDependencies(f.state, [{ ...promotion, status: "refused" }]),
    [],
  );
  assert.deepEqual(
    nativePromotionDependencies(f.state, [{
      ...promotion,
      identity: { ...promotion.identity, purpose: "conversation" },
    }]),
    [],
  );
});

type PolicyAdvance = "mandate" | "reviewer" | "catalog";

function policyAdvancePublication(kind: PolicyAdvance) {
  const f = reviewerPublication();
  if (kind === "mandate") {
    f.change.kind = "mandate-change";
    delete f.change.role;
    delete f.change.name;
    delete f.change.mandate;
    f.change.requestedRights = { mayAdmitOwnCandidates: true };
    f.adopted.identity = structuredClone(f.previous.identity);
    f.adopted.flows = structuredClone(f.previous.flows);
    delete f.adopted.configuration.reviewer;
    f.adopted.configuration.builder.admissionAuthority = "builder";
    f.adopted.mandate = {
      ...structuredClone(f.previous.mandate),
      mayAdmitOwnCandidates: true,
    };
    f.state.configuration = {
      ...structuredClone(f.adopted.configuration),
      changes: [f.change],
    };
  } else if (kind === "catalog") {
    f.adopted = structuredClone(f.previous);
    f.adopted.version.repositoryVersion = "commit:published-catalog";
    const candidateId = "admitted-candidate",
      digest = "exact-candidate-digest",
      elementId = "active-tool";
    f.adopted.catalog.push({
      nativeId: elementId,
      candidateId,
      digest,
      contractId: f.previous.contracts[0]!.nativeId,
      name: "Exact tool",
      kind: "read_web_page",
      status: "active",
    });
    f.state.candidates.push({
      id: candidateId,
      digest,
      name: "Exact tool",
      description: "Admitted catalog addition",
      kind: "read_web_page",
      code: "export default () => ({ title: 'Exact', text: 'Tool' });",
      stage: "active",
      createdAt: "published",
      baseCatalogRevision: 0,
      binding: { elementId, graphPath: "catalog::exact-tool" },
      admission: {
        candidateId,
        candidateDigest: digest,
        authority: "human",
        actorId: "owner",
        mandateRevision: 1,
        configurationRevision: f.previous.configuration.revision,
        reason: "Approve this exact candidate",
        at: "published",
      },
    });
    f.state.events.push({
      id: "exact-tool-active",
      kind: "tool-active",
      label: "Exact tool published",
      at: "published",
      candidateId,
      elementId,
    });
    f.state.configuration = structuredClone(f.adopted.configuration);
  }
  f.previous.ownerAuthority = {
    ...structuredClone(requestOwnerAuthority),
    systemId: f.previous.identity.systemId,
  };
  f.adopted.ownerAuthority = structuredClone(f.previous.ownerAuthority);
  f.change.authorityExercise = exerciseOwnerAuthority(
    f.previous,
    "mandate-change",
  );
  f.state.model = f.adopted.identity;
  f.state.executionModel = f.adopted;
  return f;
}

function presentSpacePolicy(model: ExecutableModel): NativeSpaceControlPolicy {
  const owner = structuredClone(model.ownerAuthority!);
  return {
    id: "request-control",
    revision: 1,
    elementId: "request-control-native",
    sourceIds: ["request-control-source"],
    enabled: true,
    acts: ["open-request", "execute-conversation", "revoke-execution"],
    operatorIds: [model.identity.builderId],
    systemId: model.identity.systemId,
    holderNativeId: owner.operatorNativeId,
    mandateNativeId: owner.mandateNativeId,
    issuerRootNativeId: owner.rootAuthorityNativeId,
    rootAuthority: owner,
  };
}

const spacePolicyDrifts: Array<
  [string, (policy: NativeSpaceControlPolicy) => void]
> = [
  ["identity", (policy) => {
    policy.id = "another-policy";
  }],
  ["native occurrence", (policy) => {
    policy.elementId = "another-policy-occurrence";
  }],
  ["revision", (policy) => {
    policy.revision++;
  }],
  ["disabled", (policy) => {
    policy.enabled = false;
  }],
  ["acts", (policy) => {
    policy.acts = ["open-request", "revoke-execution"];
  }],
  ["system", (policy) => {
    policy.systemId = "another-system";
  }],
  ["holder", (policy) => {
    policy.holderNativeId = "another-holder";
  }],
  ["mandate", (policy) => {
    policy.mandateNativeId = "another-mandate";
  }],
  ["operator", (policy) => {
    policy.operatorIds[0] = "another-operator";
  }],
  ["issuer", (policy) => {
    policy.issuerRootNativeId = "another-issuer";
  }],
  ["owner", (policy) => {
    policy.rootAuthority.operatorId = "another-owner";
  }],
  ["root authority", (policy) => {
    policy.rootAuthority.rootAuthorityNativeId = "another-root";
  }],
  ["root grant", (policy) => {
    policy.rootAuthority.rootGrantNativeId = "another-grant";
  }],
  ["source evidence", (policy) => {
    policy.sourceIds.push("another-policy-source");
  }],
  ["owner source evidence", (policy) => {
    policy.rootAuthority.sourceIds.push("another-owner-source");
  }],
];

for (const kind of ["mandate", "reviewer", "catalog"] as const) {
  Deno.test(`${kind} advance preserves the exact present or absent space policy and rejects unrelated policy drift`, async () => {
    const evidence = (f: ReturnType<typeof policyAdvancePublication>) =>
      kind === "catalog"
        ? nativeCatalogAdvanceEvidence(f.previous, f.state)
        : nativeMandateAdvanceEvidence(f.previous, f.state, f.change.id);
    for (const present of [false, true]) {
      const f = policyAdvancePublication(kind);
      if (present) {
        f.previous.spaceControlPolicy = presentSpacePolicy(f.previous);
        f.adopted.spaceControlPolicy = structuredClone(
          f.previous.spaceControlPolicy,
        );
      }
      const before = structuredClone(f);
      const proof = await evidence(f);
      assert.ok(
        proof,
        `${kind}: unchanged ${
          present ? "present" : "historical absent"
        } policy remains valid`,
      );
      assert.equal(
        proof.kind,
        kind === "catalog"
          ? "verified-catalog-advance"
          : "verified-mandate-advance",
      );
      assert.deepEqual(
        f,
        before,
        "Evidence cannot change source state, pins or approval",
      );
    }
    const mutations: Array<
      [string, (f: ReturnType<typeof policyAdvancePublication>) => void]
    > = [
      ["added", (f) => {
        delete f.previous.spaceControlPolicy;
      }],
      ["removed", (f) => {
        delete f.adopted.spaceControlPolicy;
      }],
      ...spacePolicyDrifts.map((
        [name, mutate],
      ): [string, (f: ReturnType<typeof policyAdvancePublication>) => void] => [
        name,
        (f) => mutate(f.adopted.spaceControlPolicy!),
      ]),
    ];
    for (const [name, mutate] of mutations) {
      const f = policyAdvancePublication(kind);
      f.previous.spaceControlPolicy = presentSpacePolicy(f.previous);
      f.adopted.spaceControlPolicy = structuredClone(
        f.previous.spaceControlPolicy,
      );
      mutate(f);
      const before = structuredClone(f);
      await assert.rejects(
        () => evidence(f),
        kind === "catalog"
          ? /publication changed the owned native execution contract/
          : /mandate publication changed the admitted space-control policy/,
        `${kind}: ${name}`,
      );
      assert.deepEqual(
        f,
        before,
        `${kind}: refusing ${name} cannot mutate source state, pins or approval`,
      );
    }
  });
}

/** What a sibling's publication may move outside this operator's digest. */
const outsideDigestDrifts: Array<
  [string, RegExp, (adopted: ExecutableModel) => void]
> = [
  ["sibling catalog", /CATALOG_ADVANCE_REQUIRED/, (adopted) => {
    adopted.catalog.push({
      nativeId: "sibling-tool",
      candidateId: "sibling-candidate",
      contractId: adopted.contracts[0]!.nativeId,
      name: "Tool a sibling admitted",
      kind: "read_web_page",
      digest: "f".repeat(64),
      status: "active",
    });
  }],
  ["tool admission offer", /tool admission offer/, (adopted) => {
    adopted.mandate.supportedChanges = [
      ...adopted.mandate.supportedChanges,
      {
        kind: "propose_mandate_change",
        requestedRights: "toolAdmission",
        description: "Offered by a library a sibling published",
      },
    ];
  }],
];

// A sibling's publication moves the source commit without changing this
// operator's model: the proposal's displayed base follows that commit (its
// preview reads the current source) while the retained dialogue keeps its
// admitted pin (the request-value-flow case).
Deno.test("a mandate advance is based at its retained model when a sibling publication moved the source commit", async () => {
  const reanchored = () => {
    const f = policyAdvancePublication("mandate");
    f.change.diff!.base.repositoryVersion = "commit:after-sibling-publication";
    return f;
  };
  const f = reanchored();
  const previous = structuredClone(f.previous),
    adopted = structuredClone(f.adopted);
  const proof = await nativeMandateAdvanceEvidence(
    f.previous,
    f.state,
    f.change.id,
  );
  assert.ok(proof);
  assert.deepEqual(proof.from, {
    identity: previous.identity,
    version: previous.version,
  });
  assert.deepEqual(proof.to, {
    identity: adopted.identity,
    version: adopted.version,
  });
  const drifts: Array<
    [string, RegExp, (g: ReturnType<typeof policyAdvancePublication>) => void]
  > = [
    ["displayed base model", /not based at the retained model/, (g) => {
      g.change.diff!.base.modelDigest = "sibling-changed-this-model";
    }],
    ["authority base model", /not based at the retained model/, (g) => {
      g.change.baseModelDigest = "another-retained-model";
    }],
    ["no displayed base", /not based at the retained model/, (g) => {
      delete g.change.diff;
    }],
    ...outsideDigestDrifts.map((
      [name, error, mutate],
    ): [
      string,
      RegExp,
      (g: ReturnType<typeof policyAdvancePublication>) => void,
    ] => [name, error, (g) => mutate(g.adopted)]),
  ];
  for (const [name, error, mutate] of drifts) {
    const g = reanchored();
    mutate(g);
    await assert.rejects(
      () => nativeMandateAdvanceEvidence(g.previous, g.state, g.change.id),
      error,
      name,
    );
  }
});

/** A creator publishes one teammate under its own admitted creation grant in
 * the middle of its Request turn: its contract changes (behaviors, creation
 * policies, configuration), its flows do not. */
function teamPublication() {
  const previous = executableFixture({
    projectId: "team-project",
    editingContextId: "context",
    rootId: "root",
    systemId: "creator-system",
    catalogId: "catalog",
    builderId: "creator",
  });
  previous.version.repositoryVersion = "commit:before-team";
  const adopted = structuredClone(previous);
  adopted.version.digest = "team-published-digest";
  adopted.version.repositoryVersion = "commit:published-team";
  adopted.configuration.revision++;
  adopted.behaviors = [{
    id: "teammate-inbox",
    name: "Teammate inbox",
    callerNativeId: "creator",
  } as never];
  const operator = {
    kind: "request-team-member" as const,
    instruction: "Contribute to the same Request.",
    provision: {
      budget: { maxAgentDecisions: 7, maxToolProposals: 2, maxFlowSteps: 128 },
      networkHosts: [],
      mayPropose: [],
      mayInvokeActiveCatalog: false,
    },
  };
  // A second-generation creator: the Request owner is someone else.
  const teamOrigin = { operatorId: "request-owner", requestId: "request-1" };
  const owner = exerciseOwnerAuthority(previous, "mandate-change");
  const change: PendingChange = {
    id: "team-change",
    kind: "operator-creation",
    status: "approved",
    authority: "builder",
    requestedBy: "creator",
    caseId: "request-1",
    role: "operator",
    name: "Teammate",
    operator,
    teamOrigin,
    authorityExercise: {
      ...owner,
      creationDelegation: {
        actorId: "creator",
        policyId: "team-grant",
        policyRevision: 1,
        policyElementId: "team-grant-native",
        policyIssuer: structuredClone(owner),
        requestedBy: "creator",
        changeId: "team-change",
        caseId: "request-1",
        teamOrigin,
        operator,
      },
    },
    baseRevision: previous.configuration.revision,
    baseModelDigest: previous.version.digest,
    reason: "Compose a teammate",
    requestedAt: "before",
    decidedAt: "decided",
    publishedCommit: adopted.version.repositoryVersion,
    diff: {
      title: "Team creation",
      author: "creator",
      base: {
        repositoryVersion: previous.version.repositoryVersion,
        modelDigest: previous.version.digest,
        sourceDigest: "base-source",
      },
      sourceDigest: "team-source",
      files: [],
      patch: "",
      additions: 0,
      deletions: 0,
    },
  };
  const state: SystemRuntimeState = {
    id: "runtime",
    revision: 9,
    catalogRevision: 0,
    busy: true,
    phase: "active",
    provider: "controlled",
    messages: [],
    events: [],
    candidates: [],
    model: adopted.identity,
    executionModel: adopted,
    configuration: { ...adopted.configuration, changes: [change] },
  };
  const scope: NativeExecutionScope = {
    kind: "request",
    scopeId: "request-1",
    rootRequestId: "request-1",
  };
  return { previous, adopted, change, state, scope };
}

Deno.test("a creator's own team publication advances its turn with unchanged flows", async () => {
  const f = teamPublication();
  const before = structuredClone(f);
  const proof = await nativeTeamAdvanceEvidence(
    f.previous,
    f.state,
    f.change.id,
    f.scope,
  );
  assert.ok(proof);
  assert.equal(proof.kind, "verified-team-advance");
  assert.equal(proof.changeId, f.change.id);
  assert.equal(proof.caseId, "request-1");
  assert.equal(proof.decidedAt, "decided");
  assert.deepEqual(proof.from, {
    identity: f.previous.identity,
    version: f.previous.version,
  });
  assert.deepEqual(proof.to, {
    identity: f.adopted.identity,
    version: f.adopted.version,
  });
  assert.deepEqual(proof.businessRevision, runtimeRevisionReference(f.state));
  assert.equal(
    proof.flowContractDigest,
    await nativeFlowContractDigest(f.adopted),
  );
  assert.deepEqual(f, before, "Evidence cannot change state or pins");
  // The settled turn action selects the team proof, and the ledger re-derives
  // the same one from the accepted revision.
  assert.deepEqual(
    await nativeSettledActionAdvanceEvidence(f.previous, f.state, f.scope),
    proof,
  );
  assert.deepEqual(
    await rederiveSettledAdvanceEvidence(f.previous, f.state, proof, f.scope),
    proof,
  );
  // Without a team publication at the adopted pin, the catalog rule applies.
  f.change.publishedCommit = "commit:elsewhere";
  await assert.rejects(
    () => nativeSettledActionAdvanceEvidence(f.previous, f.state, f.scope),
    /publication changed the owned native execution contract/,
  );
  f.change.status = "pending";
  f.change.publishedCommit = f.adopted.version.repositoryVersion;
  assert.ok(
    await nativeTeamAdvanceEvidence(f.previous, f.state, f.change.id, f.scope),
    "A team publication still completing has the same exact transition",
  );
});

Deno.test("a team advance is based at its retained model when a sibling publication moved the source commit", async () => {
  const f = teamPublication();
  f.change.diff!.base.repositoryVersion = "commit:after-sibling-publication";
  const proof = await nativeTeamAdvanceEvidence(
    f.previous,
    f.state,
    f.change.id,
    f.scope,
  );
  assert.ok(proof);
  assert.deepEqual(proof.from.version, f.previous.version);
  assert.deepEqual(proof.to.version, f.adopted.version);
});

Deno.test("a team advance refuses anything but the creator's own exact team publication", async () => {
  const drifts: Array<
    [string, (f: ReturnType<typeof teamPublication>) => void]
  > = [
    ["not a team member", (f) => {
      f.change.operator = { ...f.change.operator!, kind: undefined } as never;
    }],
    ["no creation delegation", (f) => {
      delete f.change.authorityExercise!.creationDelegation;
    }],
    ["delegation for another change", (f) => {
      f.change.authorityExercise!.creationDelegation!.changeId = "other";
    }],
    ["another creator", (f) => {
      f.change.requestedBy = "someone-else";
    }],
    ["decided by another holder", (f) => {
      f.change.authorityExercise!.creationDelegation!.actorId = "other-holder";
    }],
    ["outside its originating Request", (f) => {
      f.change.caseId = "request-2";
    }],
    ["refused", (f) => {
      f.change.status = "refused";
    }],
    ["undecided", (f) => {
      delete f.change.decidedAt;
    }],
    ["another base digest", (f) => {
      f.change.baseModelDigest = "other-digest";
    }],
    ["another base model", (f) => {
      f.change.diff!.base.repositoryVersion = "commit:other-base";
      f.change.diff!.base.modelDigest = "other-base-model";
    }],
    ...outsideDigestDrifts.map((
      [name, _error, mutate],
    ): [string, (f: ReturnType<typeof teamPublication>) => void] => [
      name,
      (f) => mutate(f.adopted),
    ]),
    ["published elsewhere", (f) => {
      f.change.publishedCommit = "commit:elsewhere";
    }],
    ["changed flows", (f) => {
      f.adopted.flows.conversation.nodes[0].name = "Unapproved flow drift";
    }],
    ["changed identity", (f) => {
      f.adopted.identity = { ...f.adopted.identity, systemId: "other" };
    }],
    ["changed space policy", (f) => {
      f.adopted.spaceControlPolicy = { id: "added-policy" } as never;
    }],
  ];
  for (const [name, mutate] of drifts) {
    const f = teamPublication();
    mutate(f);
    await assert.rejects(
      () =>
        nativeTeamAdvanceEvidence(f.previous, f.state, f.change.id, f.scope),
      Error,
      name,
    );
  }
  const unknown = teamPublication();
  await assert.rejects(
    () =>
      nativeTeamAdvanceEvidence(
        unknown.previous,
        unknown.state,
        "missing",
        unknown.scope,
      ),
    /team publication receipt/,
  );
});

Deno.test("a team advance belongs to the turn of its originating Request only", async () => {
  const turns: Array<[string, NativeExecutionScope]> = [
    ["another Request", {
      kind: "request",
      scopeId: "request-2",
      rootRequestId: "request-2",
    }],
    ["a main design turn", {
      kind: "designer",
      scopeId: "request-1",
      ownerId: "creator",
    }],
  ];
  for (const [name, scope] of turns) {
    const f = teamPublication();
    await assert.rejects(
      () => nativeTeamAdvanceEvidence(f.previous, f.state, f.change.id, scope),
      /exact team publication receipt/,
      name,
    );
    // The settled action does not pick another turn's team publication: the
    // catalog rule applies and refuses the changed contract.
    await assert.rejects(
      () => nativeSettledActionAdvanceEvidence(f.previous, f.state, scope),
      /publication changed the owned native execution contract/,
      name,
    );
    // Recovery re-derives under the recovered turn's scope, never the proof's.
    const proof = (await nativeTeamAdvanceEvidence(
      f.previous,
      f.state,
      f.change.id,
      f.scope,
    ))!;
    await assert.rejects(
      () => rederiveSettledAdvanceEvidence(f.previous, f.state, proof, scope),
      /exact team publication receipt/,
      name,
    );
  }
});

Deno.test("command own advance keeps early false results and history failures conditional", async () => {
  const { previous, adopted, state, change } = reviewerPublication();
  const request: import("./contract.ts").NativeExecutionRequest = {
    identity: {
      operatorId: adopted.identity.builderId,
      invocationKey: "invocation",
      scope: { kind: "designer", scopeId: "designer", ownerId: "builder" },
      purpose: "conversation",
    },
    model: adopted,
    flow: adopted.flows.conversation,
    maxSteps: 128,
    businessRevision: runtimeRevisionReference(state),
    contribution: { id: "approval", kind: "input" },
  };
  const delivery:
    import("../operators/execution.ts").OperatorExecutionDelivery = {
      id: "approval",
      identity: request.identity,
      kind: "command",
      modelPin: {
        modelDigest: previous.version.digest,
        repositoryVersion: previous.version.repositoryVersion,
      },
      payload: {
        __assemblyOperatorCommand: 1,
        command: {
          kind: "decide-change",
          input: { changeId: change.id, verdict: "approve" },
        },
      },
    };
  let reads = 0, unavailable = false;
  const read: import("./model-advance.ts").CommandAdvanceReader = {
    hasPredecessorSnapshot: false,
    predecessorSnapshot: () => {
      throw new Error("Unexpected predecessor read");
    },
    predecessorRequest: () => {
      throw new Error("Unexpected predecessor recovery");
    },
    businessRevision: () => {
      reads++;
      if (unavailable) throw new Error("Historical source unavailable");
      return Promise.resolve(state);
    },
  };
  assert.equal(
    await commandOwnApprovedAdvance("builder", delivery, request, read),
    false,
  );
  assert.equal(reads, 0);
  request.contribution.kind = "resume";
  unavailable = true;
  assert.equal(
    await commandOwnApprovedAdvance("builder", delivery, request, read),
    false,
  );
  assert.equal(reads, 1);
  unavailable = false;
  assert.equal(
    await commandOwnApprovedAdvance("builder", delivery, request, read),
    true,
  );
  assert.equal(reads, 2);
});

Deno.test("source history validates the captured revision when its wrapper is replaced", () => {
  const { state } = reviewerPublication();
  const reference = runtimeRevisionReference(state);
  const captured = assertBusinessRevisionReference(
    state.executionModel!.identity.builderId,
    reference,
  );
  reference.__assemblyRuntimeRevision = {
    ...captured,
    revision: captured.revision + 1,
  };
  assert.doesNotThrow(() => assertBusinessRevisionState(captured, state));
  assert.throws(
    () =>
      assertBusinessRevisionState(reference.__assemblyRuntimeRevision, state),
    /Canonical business revision reference does not match its source/,
  );
});
