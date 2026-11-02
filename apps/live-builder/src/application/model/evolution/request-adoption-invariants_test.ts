import assert from "node:assert/strict";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import type { RequestAdoptionIntent } from "./request-adoption-ports.ts";
import {
  assertRequestTeamPublicationBase,
  assertSameRequestAdoptionCompletion,
  parseRequestAdoptionDecision,
  parseRequestAdoptionIntent,
  parseRequestAdoptionManifest,
  parseRequestAdoptionReceipt,
  parseRequestAdoptionTarget,
  parseRequestOwnerAdoptionDossier,
  requestAdoptionReceiptDigest,
  requestAdoptionScopeKey,
  requestInstructionCompatibility,
  requestNetworkCompatibility,
  requestTeamBystanders,
  requestTeamCompatibility,
} from "./request-adoption-invariants.ts";

Deno.test("Request adoption target is closed and never defaults to Main", async () => {
  const { target } = await requestAdoptionFixture();
  assert.equal(requestAdoptionScopeKey(target), "request:space_A");
  assert.notEqual(
    requestAdoptionScopeKey({ ...target, executionSpaceId: "space_B" }),
    requestAdoptionScopeKey(target),
  );
  for (
    const invalid of [
      { ...target, executionSpaceId: "main" },
      { ...target, ref: "refs/heads/main" },
      { ...target, operatorId: "*" },
      { ...target, authority: {} },
      { ...target, executionSpaceId: undefined },
    ]
  ) {
    assert.throws(() => parseRequestAdoptionTarget(invalid));
  }
});

Deno.test("Request network compatibility admits exactly the approved additive host delta", async () => {
  const { previous } = await requestAdoptionFixture();
  previous.policy.mayAddNetworkHosts = true;
  previous.configuration.network = { allowedHosts: ["example.org"] };
  previous.mandate.network = { allowedHosts: ["example.org"] };
  const candidate = structuredClone(previous);
  candidate.version.digest = "c".repeat(64);
  candidate.version.repositoryVersion = `commit:${"2".repeat(40)}`;
  candidate.configuration.revision++;
  candidate.version.configurationRevision = candidate.configuration.revision;
  candidate.configuration.builder.mandateRevision++;
  candidate.mandate.id =
    `builder-v${candidate.configuration.builder.mandateRevision}`;
  candidate.configuration.network = {
    allowedHosts: ["example.org", "deno.com"],
  };
  candidate.mandate.network = structuredClone(candidate.configuration.network);
  const change:
    import("../../../domain/governance/records/pending-change.ts").PendingChange =
      {
        id: "change",
        kind: "mandate-change",
        status: "approved",
        authority: "human",
        requestedAt: "2026-10-30T00:00:00.000Z",
        decidedAt: "2026-10-30T00:01:00.000Z",
        reason: "Need exact host",
        requestedBy: previous.identity.builderId,
        caseId: "case_A",
        baseRevision: previous.configuration.revision,
        baseModelDigest: previous.version.digest,
        requestedRights: { addNetworkHosts: ["deno.com"] },
        diff: {
          title: "Network",
          author: "owner",
          base: {
            repositoryVersion: previous.version.repositoryVersion!,
            modelDigest: previous.version.digest,
            sourceDigest: "e".repeat(64),
          },
          sourceDigest: "f".repeat(64),
          files: [],
          patch: "",
          additions: 1,
          deletions: 1,
        },
      };
  assert.match(
    await requestNetworkCompatibility(previous, candidate, change),
    /^[a-f0-9]{64}$/,
  );
  for (
    const mutate of [
      (next: typeof candidate) =>
        next.configuration.network!.allowedHosts.push("other.example"),
      (next: typeof candidate) =>
        next.mandate.network.allowedHosts.push("other.example"),
      (next: typeof candidate) => {
        next.policy.urlSelectionMode = "authorized-host";
      },
      (next: typeof candidate) => {
        next.operator!.instruction += " changed";
      },
    ]
  ) {
    const changed = structuredClone(candidate);
    mutate(changed);
    await assert.rejects(() =>
      requestNetworkCompatibility(previous, changed, change)
    );
  }
  await assert.rejects(() =>
    requestNetworkCompatibility(previous, candidate, {
      ...change,
      requestedRights: { addNetworkHosts: ["other.example"] },
    })
  );
  await assert.rejects(() =>
    requestNetworkCompatibility(previous, candidate, {
      ...change,
      status: "pending",
    })
  );
  await assert.rejects(() =>
    requestNetworkCompatibility(previous, candidate, {
      ...change,
      authority: "builder",
    })
  );
  // A sessionless member may execute at R while its unchanged model is
  // verified at the newer published source A.
  const delegated = {
    ...change,
    authority: "builder" as const,
    authorityExercise: {
      delegation: { actorId: previous.identity.builderId },
    } as unknown as typeof change.authorityExercise,
    diff: {
      ...change.diff!,
      base: {
        ...change.diff!.base,
        repositoryVersion: `commit:${"a".repeat(40)}`,
      },
    },
  };
  await assert.rejects(() =>
    requestNetworkCompatibility(previous, candidate, delegated)
  );
  const memberBefore = structuredClone(previous),
    memberAfter = structuredClone(candidate);
  memberBefore.operatorTeam = memberAfter.operatorTeam = {
    parentOperatorId: "branch-owner",
    requestOwnerId: "branch-owner",
    requestId: change.caseId!,
  };
  assert.match(
    await requestNetworkCompatibility(memberBefore, memberAfter, delegated),
    /^[a-f0-9]{64}$/,
  );
  await assert.rejects(() =>
    requestNetworkCompatibility(previous, candidate, {
      ...change,
      diff: delegated.diff,
    })
  );
  await assert.rejects(() =>
    requestNetworkCompatibility(previous, candidate, {
      ...delegated,
      diff: {
        ...delegated.diff,
        base: { ...delegated.diff.base, repositoryVersion: "not-a-commit" },
      },
    })
  );
  await assert.rejects(() =>
    requestNetworkCompatibility(previous, candidate, {
      ...delegated,
      diff: {
        ...delegated.diff,
        base: { ...delegated.diff.base, modelDigest: "d".repeat(64) },
      },
    })
  );
  // 4.8d D1: the Main Operator's delegated decision (its receipt is checked
  // by the dossier gate) adopts the same exact delta.
  assert.match(
    await requestNetworkCompatibility(previous, candidate, {
      ...change,
      authority: "builder",
      authorityExercise: {
        delegation: { actorId: previous.identity.builderId },
      } as unknown as typeof change.authorityExercise,
    }),
    /^[a-f0-9]{64}$/,
  );
});

Deno.test("4.8e E4: team compatibility admits exactly one new child slot and its parent access", async () => {
  const { previous } = await requestAdoptionFixture();
  previous.operatorCreationPolicies = [{
    id: "bo-create",
    revision: 1,
    elementId: "bo-create-native",
    sourceIds: ["bo-create-native"],
    rootAuthority: structuredClone(previous.ownerAuthority!),
    holderNativeId: previous.identity.builderId,
    mandateNativeId: "operator-mandate",
    systemId: previous.identity.systemId,
    enabled: true,
    networkHosts: ["example.org"],
    maxChildren: 5,
    maxDelegationDepth: 0,
    children: [],
  }];
  previous.behaviors = [];
  const candidate = structuredClone(previous);
  candidate.version.digest = "c".repeat(64);
  candidate.version.repositoryVersion = `commit:${"2".repeat(40)}`;
  candidate.version.sourceIds = [...previous.version.sourceIds, "access-1"];
  candidate.configuration.revision++;
  candidate.version.configurationRevision = candidate.configuration.revision;
  candidate.configuration.builder.mandateRevision++;
  candidate.mandate.id =
    `builder-v${candidate.configuration.builder.mandateRevision}`;
  candidate.operatorCreationPolicies![0].children = ["helper-system"];
  candidate.behaviors = [{
    id: "access-1",
    name: "ContributeTo_helper",
    description: "Contribute bounded work to Helper.",
    targetNativeId: "helper-inbox",
    targetTypeId: "inbox-type",
    inputTypeId: "work-request",
    callerNativeId: previous.identity.builderId,
    inputSchema: {},
    sourceIds: ["access-1"],
  }];
  type PendingChange =
    import("../../../domain/governance/records/pending-change.ts").PendingChange;
  const change: PendingChange = {
    id: "team-change",
    kind: "operator-creation",
    status: "approved",
    authority: "builder",
    requestedAt: "2026-11-01T00:00:00.000Z",
    decidedAt: "2026-11-01T00:01:00.000Z",
    reason: "A helper is needed",
    requestedBy: previous.identity.builderId,
    caseId: "case_A",
    name: "Helper",
    role: "operator",
    operator: {
      kind: "request-team-member",
      instruction: "Extract one referenced passage.",
      provision: {
        budget: { maxAgentDecisions: 3, maxToolProposals: 1, maxFlowSteps: 20 },
        networkHosts: ["example.org"],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
    teamOrigin: {
      operatorId: previous.identity.builderId,
      requestId: "case_A",
    },
    baseRevision: previous.configuration.revision,
    baseModelDigest: previous.version.digest,
    authorityExercise: {
      creationDelegation: {
        actorId: previous.identity.builderId,
        policyId: "bo-create",
        policyRevision: 1,
      },
    } as unknown as PendingChange["authorityExercise"],
    diff: {
      title: "Create Helper",
      author: "owner",
      base: {
        repositoryVersion: previous.version.repositoryVersion!,
        modelDigest: previous.version.digest,
        sourceDigest: "e".repeat(64),
      },
      sourceDigest: "f".repeat(64),
      files: [],
      patch: "",
      additions: 3,
      deletions: 0,
    },
  };
  assert.match(
    await requestTeamCompatibility(previous, candidate, change),
    /^[a-f0-9]{64}$/,
  );
  const advancedSource = {
    ...change,
    diff: {
      ...change.diff!,
      base: {
        ...change.diff!.base,
        repositoryVersion: `commit:${"a".repeat(40)}`,
      },
    },
  };
  await assert.rejects(() =>
    requestTeamCompatibility(previous, candidate, advancedSource)
  );
  const memberBefore = structuredClone(previous),
    memberAfter = structuredClone(candidate);
  memberBefore.operatorTeam = memberAfter.operatorTeam = {
    parentOperatorId: "branch-owner",
    requestOwnerId: "branch-owner",
    requestId: change.caseId!,
  };
  assert.match(
    await requestTeamCompatibility(memberBefore, memberAfter, advancedSource),
    /^[a-f0-9]{64}$/,
  );
  await assert.rejects(() =>
    requestTeamCompatibility(previous, candidate, {
      ...advancedSource,
      authority: "human",
      authorityExercise: exerciseOwnerAuthority(previous, "mandate-change"),
    })
  );
  await assert.rejects(() =>
    requestTeamCompatibility(previous, candidate, {
      ...advancedSource,
      diff: {
        ...advancedSource.diff,
        base: { ...advancedSource.diff.base, repositoryVersion: "invalid" },
      },
    })
  );
  await assert.rejects(() =>
    requestTeamCompatibility(previous, candidate, {
      ...advancedSource,
      diff: {
        ...advancedSource.diff,
        base: { ...advancedSource.diff.base, modelDigest: "d".repeat(64) },
      },
    })
  );
  // The person's per-creation decision adopts the same exact delta.
  assert.match(
    await requestTeamCompatibility(previous, candidate, {
      ...change,
      authority: "human",
      authorityExercise: exerciseOwnerAuthority(previous, "mandate-change"),
    }),
    /^[a-f0-9]{64}$/,
  );
  // The new child system brings its own model-editing authority roots: the
  // only roots a creation may add, all under that one new system.
  previous.modelEditingAuthorityRoots = [
    "AssemblyLiveBuilder::liveBuilder::owner::ownerMandate",
    "AssemblyModelEditing::ModelEditPolicy::issuer",
  ];
  candidate.modelEditingAuthorityRoots = [
    "AssemblyLiveBuilder::liveBuilder::owner::ownerMandate",
    "AssemblyLiveBuilder::operator_helper::builderMandate",
    "AssemblyLiveBuilder::operator_helper::owner::ownerMandate",
    "AssemblyModelEditing::ModelEditPolicy::issuer",
  ];
  assert.match(
    await requestTeamCompatibility(previous, candidate, change),
    /^[a-f0-9]{64}$/,
  );
  for (
    const mutate of [
      // A root outside the new child, a removed root, two new systems.
      (next: typeof candidate) =>
        next.modelEditingAuthorityRoots!.push(
          "AssemblyLiveBuilder::liveBuilder::extraRoot",
        ),
      (next: typeof candidate) => next.modelEditingAuthorityRoots!.shift(),
      (next: typeof candidate) =>
        next.modelEditingAuthorityRoots!.push(
          "AssemblyLiveBuilder::operator_other::builderMandate",
        ),
      (next: typeof candidate) =>
        next.operatorCreationPolicies![0].children.push("second-system"),
      (next: typeof candidate) =>
        next.operatorCreationPolicies![0].maxChildren = 9,
      (next: typeof candidate) => {
        next.behaviors = [];
      },
      (next: typeof candidate) => {
        next.operator!.instruction += " changed";
      },
      (next: typeof candidate) =>
        next.configuration.network = { allowedHosts: ["evil.example"] },
    ]
  ) {
    const changed = structuredClone(candidate);
    mutate(changed);
    await assert.rejects(
      () => requestTeamCompatibility(previous, changed, change),
      Error,
      mutate.toString(),
    );
  }
  await assert.rejects(() =>
    requestTeamCompatibility(previous, candidate, {
      ...change,
      status: "pending",
    })
  );
  // A builder decision without its creation receipt never adopts.
  await assert.rejects(() =>
    requestTeamCompatibility(previous, candidate, {
      ...change,
      authorityExercise: exerciseOwnerAuthority(previous, "mandate-change"),
    })
  );
});

async function retainedMemberTeamFixture() {
  const { previous } = await requestAdoptionFixture();
  previous.operatorTeam = {
    parentOperatorId: "branch-owner",
    requestOwnerId: "branch-owner",
    requestId: "case_A",
  };
  previous.operatorCreationPolicies = [{
    id: "member-create",
    revision: 1,
    elementId: "member-create-native",
    sourceIds: ["member-create-native"],
    rootAuthority: structuredClone(previous.ownerAuthority!),
    holderNativeId: previous.identity.builderId,
    mandateNativeId: "operator-mandate",
    systemId: previous.identity.systemId,
    enabled: true,
    networkHosts: ["example.org"],
    maxChildren: 3,
    maxDelegationDepth: 0,
    children: [],
  }];
  previous.behaviors = [];
  previous.modelEditingAuthorityRoots = [
    "AssemblyLiveBuilder::member::owner::ownerMandate",
    "AssemblyModelEditing::ModelEditPolicy::issuer",
  ];
  // A sibling was published at A without changing this member's native
  // executable digest or its own contract, which still executes at R.
  const publicationBase = structuredClone(previous);
  publicationBase.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  publicationBase.modelEditingAuthorityRoots!.push(
    "AssemblyLiveBuilder::operator_sibling::builderMandate",
    "AssemblyLiveBuilder::operator_sibling::owner::ownerMandate",
  );
  publicationBase.flows.conversation.source.line = 200;
  publicationBase.flows.conversation.nodes[0].source.line = 201;
  const candidate = structuredClone(publicationBase);
  candidate.version.digest = "c".repeat(64);
  candidate.version.repositoryVersion = `commit:${"2".repeat(40)}`;
  candidate.version.sourceIds.push("member-child-access");
  candidate.configuration.revision++;
  candidate.version.configurationRevision = candidate.configuration.revision;
  candidate.configuration.builder.mandateRevision++;
  candidate.mandate.id =
    `builder-v${candidate.configuration.builder.mandateRevision}`;
  candidate.operatorCreationPolicies![0].children.push("child-system");
  candidate.behaviors = [{
    id: "member-child-access",
    name: "ContributeTo_child",
    description: "Contribute bounded work to the member's child.",
    targetNativeId: "child-inbox",
    targetTypeId: "inbox-type",
    inputTypeId: "work-request",
    callerNativeId: previous.identity.builderId,
    inputSchema: {},
    sourceIds: ["member-child-access"],
  }];
  candidate.modelEditingAuthorityRoots!.push(
    "AssemblyLiveBuilder::operator_child::builderMandate",
    "AssemblyLiveBuilder::operator_child::owner::ownerMandate",
  );
  const change = {
    id: "member-child",
    kind: "operator-creation",
    status: "approved",
    authority: "builder",
    requestedAt: "2026-11-01T00:00:00.000Z",
    decidedAt: "2026-11-01T00:01:00.000Z",
    reason: "The member needs a child",
    requestedBy: previous.identity.builderId,
    caseId: "case_A",
    name: "Child",
    role: "operator",
    operator: {
      kind: "request-team-member",
      instruction: "Extract one passage.",
      provision: {
        budget: { maxAgentDecisions: 3, maxToolProposals: 1, maxFlowSteps: 20 },
        networkHosts: ["example.org"],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
    teamOrigin: { operatorId: "branch-owner", requestId: "case_A" },
    baseRevision: previous.configuration.revision,
    baseModelDigest: previous.version.digest,
    authorityExercise: {
      creationDelegation: {
        actorId: previous.identity.builderId,
        policyId: "member-create",
        policyRevision: 1,
      },
    } as unknown as PendingChange["authorityExercise"],
    diff: {
      title: "Create member child",
      author: "owner",
      base: {
        repositoryVersion: publicationBase.version.repositoryVersion!,
        modelDigest: previous.version.digest,
        sourceDigest: "e".repeat(64),
      },
      sourceDigest: "f".repeat(64),
      files: [],
      patch: "",
      additions: 3,
      deletions: 0,
    },
  } as PendingChange;
  return { previous, publicationBase, candidate, change };
}

Deno.test("retained member team compatibility joins ambient sibling roots at A with the strict child delta A to B", async () => {
  const { previous, publicationBase, candidate, change } =
    await retainedMemberTeamFixture();
  // The ordinary publication comparison already accepts exactly A → B.
  const publicationDigest = await requestTeamCompatibility(
    publicationBase,
    candidate,
    change,
  );
  assert.match(publicationDigest, /^[a-f0-9]{64}$/);
  // R → B contains two new systems and must remain refused without A.
  await assert.rejects(
    () => requestTeamCompatibility(previous, candidate, change),
    /non-team contract changed/,
  );
  const digest = await requestTeamCompatibility(
    previous,
    candidate,
    change,
    publicationBase,
  );
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.notEqual(
    digest,
    publicationDigest,
    "the adoption digest also binds retained execution R",
  );
  const reorderedBase = structuredClone(publicationBase);
  reorderedBase.modelEditingAuthorityRoots!.reverse();
  assert.notEqual(
    await requestTeamCompatibility(
      previous,
      candidate,
      change,
      reorderedBase,
    ),
    digest,
    "the compatibility digest binds the supplied publication-base facts",
  );
});

Deno.test("retained member team compatibility refuses an unrelated or widened publication base", async () => {
  const { previous, publicationBase, candidate, change } =
    await retainedMemberTeamFixture();
  const mutations: Array<[string, (base: ExecutableModel) => void]> = [
    [
      "wrong displayed source",
      (base) => base.version.repositoryVersion = `commit:${"b".repeat(40)}`,
    ],
    [
      "different native identity",
      (base) => base.identity.systemId = "foreign-system",
    ],
    ["different native digest", (base) => base.version.digest = "d".repeat(64)],
    [
      "different instruction",
      (base) => base.operator!.instruction += " widened",
    ],
    ["different configuration", (base) => base.configuration.revision++],
    ["different own rights", (base) => base.policy.maxFlowSteps++],
    [
      "different native source identities",
      (base) => base.version.sourceIds.push("foreign-source"),
    ],
    [
      "extra root under an existing system",
      (base) =>
        base.modelEditingAuthorityRoots!.push(
          "AssemblyLiveBuilder::member::extraRoot",
        ),
    ],
    [
      "different native flow",
      (base) => base.flows.conversation.rootNativeId = "foreign-flow",
    ],
    [
      "different Request provenance",
      (base) => base.operatorTeam!.requestId = "foreign-case",
    ],
    [
      "removed prior authority root",
      (base) => base.modelEditingAuthorityRoots!.shift(),
    ],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(publicationBase);
    mutate(changed);
    await assert.rejects(
      () => requestTeamCompatibility(previous, candidate, change, changed),
      Error,
      label,
    );
  }
});

Deno.test("retained member team compatibility preserves the strict one-child publication delta", async () => {
  const { previous, publicationBase, candidate, change } =
    await retainedMemberTeamFixture();
  const mutations: Array<[string, (next: ExecutableModel) => void]> = [
    [
      "two newly published systems",
      (next) =>
        next.modelEditingAuthorityRoots!.push(
          "AssemblyLiveBuilder::operator_second_child::builderMandate",
        ),
    ],
    [
      "removed retained root",
      (next) => next.modelEditingAuthorityRoots!.shift(),
    ],
    [
      "removed sibling root from publication base",
      (next) => next.modelEditingAuthorityRoots!.splice(2, 1),
    ],
    [
      "another new child slot",
      (next) => next.operatorCreationPolicies![0].children.push("second-child"),
    ],
    [
      "changed creator instruction",
      (next) => next.operator!.instruction += " widened",
    ],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(candidate);
    mutate(changed);
    await assert.rejects(
      () =>
        requestTeamCompatibility(
          previous,
          changed,
          change,
          publicationBase,
        ),
      Error,
      label,
    );
  }
});

Deno.test("retained member team compatibility never lends its publication baseline to a BO or a human decision", async () => {
  const f = await retainedMemberTeamFixture();
  const bo = structuredClone(f);
  delete bo.previous.operatorTeam;
  delete bo.publicationBase.operatorTeam;
  delete bo.candidate.operatorTeam;
  bo.change.teamOrigin!.operatorId = bo.previous.identity.builderId;
  await assert.rejects(() =>
    requestTeamCompatibility(
      bo.previous,
      bo.candidate,
      bo.change,
      bo.publicationBase,
    )
  );
  const masqueradingBo = structuredClone(f);
  for (
    const model of [
      masqueradingBo.previous,
      masqueradingBo.publicationBase,
      masqueradingBo.candidate,
    ]
  ) {
    model.operatorTeam!.requestOwnerId = model.identity.builderId;
  }
  await assert.rejects(() =>
    requestTeamCompatibility(
      masqueradingBo.previous,
      masqueradingBo.candidate,
      masqueradingBo.change,
      masqueradingBo.publicationBase,
    )
  );
  await assert.rejects(() =>
    requestTeamCompatibility(f.previous, f.candidate, {
      ...f.change,
      authority: "human",
      authorityExercise: exerciseOwnerAuthority(f.previous, "mandate-change"),
    }, f.publicationBase)
  );
});

async function rehashIntent(intent: RequestAdoptionIntent) {
  const { commandDigest: _command, accountingDigest: _accounting, ...facts } =
    intent;
  return { ...intent, commandDigest: await sha256(canonical(facts)) };
}

async function retainedMemberTeamIntent() {
  const f = await retainedMemberTeamFixture();
  const { intent } = await requestAdoptionFixture();
  const receipt = {
    actorId: f.previous.identity.builderId,
    policyId: "member-create",
    policyRevision: 1,
    policyElementId: "member-create-native",
    policyIssuer: f.previous.ownerAuthority!,
    requestedBy: f.previous.identity.builderId,
    changeId: f.change.id,
    caseId: f.change.caseId,
    teamOrigin: f.change.teamOrigin,
    operator: f.change.operator!,
  };
  const complete: RequestAdoptionIntent = {
    ...intent,
    previous: {
      ...intent.previous,
      admission: {
        ...intent.previous.admission,
        permissions: {
          ...intent.previous.admission.permissions,
          operatorIds: ["branch-owner", f.previous.identity.builderId],
          modelDigests: ["d".repeat(64), f.previous.version.digest],
          sourceVersion: f.publicationBase.version.repositoryVersion!,
        },
      },
    },
    candidate: { ...intent.candidate, model: f.candidate },
    decision: {
      kind: "request-creation-grant-adoption-decision",
      authorityDigest: "a".repeat(64),
      exercise: {
        ...exerciseOwnerAuthority(f.previous, "model-adoption"),
        creationDelegation: receipt,
      },
      capturedAt: "2026-11-01T00:01:00.000Z",
    },
    team: {
      kind: "request-team-creation-adoption/v1",
      changeId: f.change.id,
      proposalIntentDigest: "b".repeat(64),
      approvedChangeDigest: "c".repeat(64),
      childSystemId: "child-system",
      publicationBase: f.publicationBase,
      team: [{
        operatorId: f.previous.identity.builderId,
        modelDigest: f.candidate.version.digest,
      }, { operatorId: "child-operator", modelDigest: "e".repeat(64) }],
      sourceAdmission: {
        ...intent.candidate.sourceAdmission,
        commandId: f.change.id,
        publicationReceiptDigest: "d".repeat(64),
        resultVersion: intent.candidate.source.version,
      },
    },
  };
  return { ...f, intent: await rehashIntent(complete) };
}

Deno.test("member team publication baseline parser retains the exact optional member A and old intents without it", async () => {
  const f = await retainedMemberTeamIntent();
  const without = structuredClone(f.intent);
  delete (without.team as { publicationBase?: ExecutableModel })
    .publicationBase;
  const old = await rehashIntent(without);
  assert.deepEqual(await parseRequestAdoptionIntent(old), old);
  assert.deepEqual(await parseRequestAdoptionIntent(f.intent), f.intent);
});

Deno.test("member team publication baseline parser refuses foreign source provenance and non-member authority", async () => {
  const f = await retainedMemberTeamIntent();
  const fixtureHumanDecision = (await requestAdoptionFixture()).decision;
  type MutableIntent = {
    -readonly [Key in keyof RequestAdoptionIntent]: RequestAdoptionIntent[Key];
  };
  const mutations: Array<[string, (intent: MutableIntent) => void]> = [
    [
      "incomplete model",
      (intent) =>
        intent.team = {
          ...intent.team!,
          publicationBase: {} as ExecutableModel,
        },
    ],
    [
      "wrong prior identity",
      (intent) =>
        intent.team!.publicationBase!.identity.systemId = "foreign-system",
    ],
    [
      "wrong prior native digest",
      (intent) => intent.team!.publicationBase!.version.digest = "f".repeat(64),
    ],
    [
      "same source as R",
      (intent) =>
        intent.team!.publicationBase!.version.repositoryVersion =
          intent.previous.pin.source.version,
    ],
    [
      "same source as B",
      (intent) =>
        intent.team!.publicationBase!.version.repositoryVersion =
          intent.candidate.source.version,
    ],
    [
      "foreign Request",
      (intent) =>
        intent.team!.publicationBase!.operatorTeam!.requestId = "foreign-case",
    ],
    [
      "foreign Request owner",
      (intent) =>
        intent.team!.publicationBase!.operatorTeam!.requestOwnerId =
          "foreign-owner",
    ],
    ["absent member provenance", (intent) => {
      delete intent.team!.publicationBase!.operatorTeam;
    }],
    ["BO in admission slot zero", (intent) => {
      intent.previous.admission.permissions.operatorIds = [
        intent.target.operatorId,
      ];
      intent.previous.admission.permissions.modelDigests = [
        intent.previous.pin.modelDigest,
      ];
      intent.previous.admission.permissions.sourceVersion =
        intent.previous.pin.source.version;
    }],
    ["human adoption authority", (intent) => {
      intent.decision = structuredClone(fixtureHumanDecision);
    }],
  ];
  for (const [label, mutate] of mutations) {
    const changed = structuredClone(f.intent);
    mutate(changed);
    await assert.rejects(
      () => rehashIntent(changed).then(parseRequestAdoptionIntent),
      { code: "INVALID" },
      label,
    );
  }
});

Deno.test("member team publication baseline helper anchors A to the publication predecessor and exact prior native model", async () => {
  const assertPublicationBase = assertRequestTeamPublicationBase;
  assert.equal(typeof assertPublicationBase, "function");
  const f = await retainedMemberTeamFixture();
  const prior = {
    identity: f.previous.identity,
    version: { digest: f.previous.version.digest },
  };
  assert.equal(assertPublicationBase(undefined, "unused", prior), undefined);
  assert.equal(
    assertPublicationBase(
      f.publicationBase,
      f.publicationBase.version.repositoryVersion!,
      prior,
    ),
    undefined,
  );
  for (
    const [base, sourceVersion, expectedPrior] of [
      [f.publicationBase, `commit:${"b".repeat(40)}`, prior],
      [f.publicationBase, f.publicationBase.version.repositoryVersion!, {
        ...prior,
        identity: { ...prior.identity, systemId: "foreign-system" },
      }],
      [f.publicationBase, f.publicationBase.version.repositoryVersion!, {
        ...prior,
        version: { digest: "f".repeat(64) },
      }],
    ] as const
  ) {
    assert.throws(
      () => assertPublicationBase(base, sourceVersion, expectedPrior),
      { code: "INVALID" },
    );
  }
});

Deno.test("Request human decision rejects schema legacy, software fields and widened completion", async () => {
  const { decision, intent } = await requestAdoptionFixture();
  assert.deepEqual(parseRequestAdoptionDecision(decision), decision);
  for (
    const exercise of [
      { ...decision.exercise, authoritySchema: 1 },
      { ...decision.exercise, action: "model-revision" },
      { ...decision.exercise, outOfMandate: true },
      { ...decision.exercise, delegation: { actorId: "software" } },
    ]
  ) {
    assert.throws(() =>
      parseRequestAdoptionDecision({ ...decision, exercise })
    );
  }
  // The same person completes through any current credential of the same
  // effective authority: another session, a reissued or renewed capability,
  // or a capability issued after Main moved (audit references only).
  for (
    const controller of [{
      ...decision.controller,
      sessionId: "another-current-session",
    }, {
      ...decision.controller,
      capabilityId: "replacement",
      sessionId: "replacement-session",
    }, {
      ...decision.controller,
      capabilityRevision: decision.controller.capabilityRevision + 1,
    }, {
      ...decision.controller,
      capabilityId: "issued-after-main-moved",
      authority: {
        ...decision.controller.authority,
        sourceVersion: `commit:${"3".repeat(40)}`,
        modelDigest: "e".repeat(64),
      },
    }]
  ) {
    assert.doesNotThrow(() =>
      assertSameRequestAdoptionCompletion(intent, {
        ...decision,
        controller,
        sessionRevision: 2,
      })
    );
  }
  for (
    const completion of [
      {
        ...decision,
        controller: { ...decision.controller, ownerId: "another-account" },
      },
      {
        ...decision,
        controller: {
          ...decision.controller,
          authority: { ...decision.controller.authority, policyRevision: 2 },
        },
      },
      {
        ...decision,
        controller: {
          ...decision.controller,
          authority: {
            ...decision.controller.authority,
            operatorIds: ["builder", "sibling"],
          },
        },
      },
      {
        ...decision,
        exercise: { ...decision.exercise, baseModelDigest: "e".repeat(64) },
      },
    ]
  ) {
    assert.throws(
      () => assertSameRequestAdoptionCompletion(intent, completion),
      /same original human intent/,
    );
  }
});

/** The human decision joins the admission by person and effective authority,
 * not by credential: the development host issues one capability per page load. */
Deno.test("4.8b: a person back with another capability decides under the unchanged admission", async () => {
  const { decision, intent } = await requestAdoptionFixture();
  const decidedBy = async (
    controller: Partial<typeof decision.controller>,
    admission: Partial<typeof intent.previous.admission> = {},
  ) => {
    const changed = {
      ...structuredClone(intent),
      decision: {
        ...decision,
        controller: { ...decision.controller, ...controller },
      },
      previous: {
        ...structuredClone(intent.previous),
        admission: { ...intent.previous.admission, ...admission },
      },
    };
    const {
      commandDigest: _digest,
      accountingDigest: _accounting,
      ...immutable
    } = changed;
    return { ...changed, commandDigest: await sha256(canonical(immutable)) };
  };
  for (
    const controller of [
      { capabilityId: "after-reload", sessionId: "after-reload-session" },
      { capabilityId: "after-reload", capabilityRevision: 0 },
      {
        capabilityId: "issued-after-main-moved",
        authority: {
          ...decision.controller.authority,
          sourceVersion: `commit:${"3".repeat(40)}`,
          modelDigest: "e".repeat(64),
        },
      },
    ]
  ) {
    const reloaded = await decidedBy(controller);
    assert.deepEqual(await parseRequestAdoptionIntent(reloaded), reloaded);
  }
  for (
    const [controller, admission] of [
      [{ ownerId: "another-account" }, {}],
      [{
        capabilityId: "after-reload",
        authority: { ...decision.controller.authority, policyRevision: 2 },
      }, {}],
      [{
        capabilityId: "after-reload",
        authority: {
          ...decision.controller.authority,
          acts: ["open-request", "execute-conversation", "revoke-execution"],
        },
      }, {}],
      [{ capabilityId: "after-reload" }, { status: "revoked" }],
      [{ capabilityId: "after-reload" }, { baseDigest: "0".repeat(64) }],
    ] as const
  ) {
    await assert.rejects(
      async () =>
        parseRequestAdoptionIntent(
          await decidedBy(
            controller as Partial<typeof decision.controller>,
            admission as Partial<typeof intent.previous.admission>,
          ),
        ),
      /unchanged exact admission required/,
    );
  }
});

Deno.test("Request compatibility admits instruction bytes only and snapshots before yielding", async () => {
  const { previous, model } = await requestAdoptionFixture();
  const expected = await requestInstructionCompatibility(previous, model);
  const oldBytes = canonical(previous), newBytes = canonical(model);
  assert.match(expected, /^[a-f0-9]{64}$/);
  assert.equal(canonical(previous), oldBytes);
  assert.equal(canonical(model), newBytes);
  const mutations = [
    (next: typeof model) => {
      next.policy.maxFlowSteps++;
    },
    (next: typeof model) => {
      next.mandate.mayReview = !next.mandate.mayReview;
    },
    (next: typeof model) => {
      next.flows.conversation.rootNativeId += "-changed";
    },
    (next: typeof model) => {
      next.ownerAuthority!.mandateRevision++;
    },
    (next: typeof model) => {
      next.identity.builderId = "sibling";
    },
    (next: typeof model) => {
      next.operator!.instruction = previous.operator!.instruction;
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(model);
    mutate(changed);
    await assert.rejects(() =>
      requestInstructionCompatibility(previous, changed)
    );
  }
  const pending = requestInstructionCompatibility(previous, model);
  model.policy.maxFlowSteps++;
  assert.equal(await pending, expected);
});

Deno.test("Request intent and dossier recompute immutable command and accounting digests", async () => {
  const { intent, dossier } = await requestAdoptionFixture();
  assert.deepEqual(await parseRequestAdoptionIntent(intent), intent);
  assert.deepEqual(await parseRequestOwnerAdoptionDossier(dossier), dossier);
  for (
    const changed of [{ ...intent, adoptionKey: "different-key" }, {
      ...intent,
      commandDigest: "0".repeat(64),
    }]
  ) {
    await assert.rejects(() => parseRequestAdoptionIntent(changed));
  }
  await assert.rejects(() =>
    parseRequestOwnerAdoptionDossier({
      ...dossier,
      intent: { ...intent, accountingDigest: "0".repeat(64) },
    })
  );
  await assert.rejects(() =>
    parseRequestOwnerAdoptionDossier({ ...dossier, id: "foreign-command" })
  );
});

Deno.test("Request adoption accepts bounded retained resources and rejects malformed or duplicate entries", async () => {
  const { intent } = await requestAdoptionFixture();
  const resource = `retained-tool:v1:${"a".repeat(64)}`;
  const changed = structuredClone(intent);
  changed.previous.admission.permissions.resourceIds = [resource];
  const {
    commandDigest: _digest,
    accountingDigest: _accounting,
    ...immutable
  } = changed;
  const withResources = {
    ...changed,
    commandDigest: await sha256(canonical(immutable)),
  };
  assert.deepEqual(
    await parseRequestAdoptionIntent(withResources),
    withResources,
  );
  for (const ids of [["invalid"], [resource, resource]]) {
    const invalid = structuredClone(withResources);
    invalid.previous.admission.permissions.resourceIds = ids;
    await assert.rejects(() => parseRequestAdoptionIntent(invalid));
  }
});

Deno.test("network adoption intent binds its source receipt to the selected candidate", async () => {
  const { intent } = await requestAdoptionFixture();
  const network = {
    kind: "request-network-host-adoption/v1" as const,
    changeId: "change",
    proposalIntentDigest: "a".repeat(64),
    approvedChangeDigest: "b".repeat(64),
    addedHosts: ["deno.com"],
    sourceAdmission: {
      ...intent.candidate.sourceAdmission,
      commandId: "change",
      publicationReceiptDigest: "c".repeat(64),
      resultVersion: intent.candidate.source.version,
    },
  };
  const {
    commandDigest: _digest,
    accountingDigest: _accounting,
    ...immutable
  } = intent;
  const complete = {
    ...intent,
    network,
    commandDigest: await sha256(canonical({ ...immutable, network })),
  };
  assert.deepEqual(await parseRequestAdoptionIntent(complete), complete);
  await assert.rejects(() =>
    parseRequestAdoptionIntent({
      ...complete,
      network: {
        ...network,
        sourceAdmission: { ...network.sourceAdmission, commandId: "foreign" },
      },
    })
  );
});

Deno.test("Request receipt digest covers every exact completion field", async () => {
  const payload = {
    commandId: "command",
    committedRuntimeRevision: 12,
    journalRevision: 3,
    journalDigest: "a".repeat(64),
    recordedAt: "2026-10-30T00:00:00.000Z",
  };
  const receipt = {
    ...payload,
    receiptDigest: await requestAdoptionReceiptDigest(payload),
  };
  assert.deepEqual(await parseRequestAdoptionReceipt(receipt), receipt);
  for (
    const changed of [
      { ...receipt, committedRuntimeRevision: 13 },
      { ...receipt, journalRevision: 4 },
      { ...receipt, journalDigest: "b".repeat(64) },
      { ...receipt, recordedAt: "2026-10-30T00:00:01.000Z" },
      { ...receipt, extra: true },
    ]
  ) await assert.rejects(() => parseRequestAdoptionReceipt(changed));
});

Deno.test("Request manifest requires exact revision chain and paired retirement lineage", async () => {
  const { intent, decision, dossier } = await requestAdoptionFixture();
  const manifest = {
    format: "request-runtime-adoption/v2",
    commandId: dossier.id,
    intent,
    completion: decision,
    predecessor: { revision: 2, digest: "f".repeat(64) },
    sourceHead: intent.candidate.sourceAdmission,
    previousRuntimeRevision: 10,
    authorizationRuntimeRevision: 11,
    committedRuntimeRevision: 12,
    admissionRevision: intent.previous.admission.revision + 1,
    nativeRetirement: {
      digest: "a".repeat(64),
      predecessorThreadIds: [],
      successorThreadIds: [],
    },
  };
  assert.deepEqual(await parseRequestAdoptionManifest(manifest), manifest);
  for (
    const changed of [
      { ...manifest, authorizationRuntimeRevision: 12 },
      { ...manifest, committedRuntimeRevision: 13 },
      { ...manifest, admissionRevision: 0 },
      {
        ...manifest,
        nativeRetirement: {
          ...manifest.nativeRetirement,
          predecessorThreadIds: ["old"],
          successorThreadIds: [],
        },
      },
      {
        ...manifest,
        nativeRetirement: {
          ...manifest.nativeRetirement,
          predecessorThreadIds: ["old", "old"],
          successorThreadIds: ["new", "new"],
        },
      },
    ]
  ) {
    await assert.rejects(() => parseRequestAdoptionManifest(changed));
  }
});

/** Spec 4.8c: the same intent authorized by the MO's recorded delegated
 * network decision instead of the person's session. */
async function delegatedAdoptionFixture() {
  const base = await requestAdoptionFixture();
  const { intent, previous, target } = base;
  const owner = exerciseOwnerAuthority(previous, "model-adoption");
  const actor = {
    projectId: previous.identity.projectId,
    systemId: previous.identity.systemId,
    executionSpaceId: "main",
    operatorId: target.operatorId,
  };
  const decision = {
    kind: "request-delegated-adoption-decision" as const,
    authorityDigest: "7".repeat(64),
    exercise: {
      ...owner,
      delegation: {
        actorId: actor.operatorId,
        actor,
        requester: { ...actor, executionSpaceId: target.executionSpaceId },
        policyId: "bo-network",
        policyRevision: 1,
        policyElementId: "bo-network-native",
        policyIssuer: previous.ownerAuthority!,
        requestedBy: target.operatorId,
        changeId: "change",
        caseId: target.caseId,
        requestedRights: { addNetworkHosts: ["deno.com"] },
      },
    },
    capturedAt: base.decision.capturedAt,
  };
  const network = {
    kind: "request-network-host-adoption/v1" as const,
    changeId: "change",
    proposalIntentDigest: "a".repeat(64),
    approvedChangeDigest: "b".repeat(64),
    addedHosts: ["deno.com"],
    sourceAdmission: {
      ...intent.candidate.sourceAdmission,
      commandId: "change",
      publicationReceiptDigest: "c".repeat(64),
      resultVersion: intent.candidate.source.version,
    },
  };
  const {
    commandDigest: _digest,
    accountingDigest: _accounting,
    ...immutable
  } = intent;
  const body = { ...immutable, decision, network };
  const id = `request-adoption:${await sha256(
    canonical({
      host: target.host,
      ownerId: intent.previous.admission.ownerId,
      openingId: target.openingId,
      adoptionKey: intent.adoptionKey,
    }),
  )}`;
  const delegated = {
    ...body,
    commandDigest: await sha256(canonical(body)),
    accountingDigest: await sha256(
      canonical({
        id: `evolution:${target.repositoryId}:${id}`,
        agentInvocations: 0,
      }),
    ),
  };
  return {
    ...base,
    delegatedDecision: decision,
    delegatedIntent: delegated,
    delegatedDossier: { ...base.dossier, id, intent: delegated },
    resign: async (value: Record<string, unknown>) => {
      const { commandDigest: _c, accountingDigest: _a, ...rest } = value;
      return { ...value, commandDigest: await sha256(canonical(rest)) };
    },
  };
}

Deno.test("4.8c: a delegated network decision authorizes its own approved delta without a session", async () => {
  const f = await delegatedAdoptionFixture();
  assert.deepEqual(
    parseRequestAdoptionDecision(f.delegatedDecision),
    f.delegatedDecision,
  );
  assert.deepEqual(
    await parseRequestAdoptionIntent(f.delegatedIntent),
    f.delegatedIntent,
  );
  assert.deepEqual(
    await parseRequestOwnerAdoptionDossier(f.delegatedDossier),
    f.delegatedDossier,
  );
  // The adoption key stays deterministic: the admission's owner.
  assert.equal(f.delegatedDossier.id, f.dossier.id);
  assert.deepEqual(
    assertSameRequestAdoptionCompletion(f.delegatedIntent, {
      ...f.delegatedDecision,
      capturedAt: "2026-10-30T00:05:00.000Z",
    }).kind,
    "request-delegated-adoption-decision",
  );
  for (
    const completion of [
      f.decision,
      { ...f.delegatedDecision, authorityDigest: "6".repeat(64) },
    ]
  ) {
    assert.throws(() =>
      assertSameRequestAdoptionCompletion(f.delegatedIntent, completion)
    );
  }
  assert.throws(() =>
    assertSameRequestAdoptionCompletion(f.intent, f.delegatedDecision)
  );
});

Deno.test("legacy Main-to-BO adoption completion may add its validated route without rewriting the intent", async () => {
  const f = await delegatedAdoptionFixture();
  const delegation = f.delegatedDecision.exercise.delegation;
  const route = {
    version: 2 as const,
    status: "actor-decision" as const,
    changeId: delegation.changeId,
    caseId: delegation.caseId,
    requestedBy: delegation.requestedBy,
    requester: delegation.requester,
    targetOperatorId: delegation.requester.operatorId,
    baseRevision: 0,
    modelDigest: f.previous.version.digest,
    designatedDecider: {
      operatorId: delegation.actor.operatorId,
      executionSpaceId: "main",
      policyId: delegation.policyId,
      policyRevision: delegation.policyRevision,
    },
    trace: [],
  };
  const completion = { ...f.delegatedDecision, route };
  assert.deepEqual(
    assertSameRequestAdoptionCompletion(f.delegatedIntent, completion),
    completion,
  );
  assert.equal(Object.hasOwn(f.delegatedIntent.decision, "route"), false);
  const routedIntent = { ...f.delegatedIntent, decision: completion };
  assert.throws(() =>
    assertSameRequestAdoptionCompletion(routedIntent, f.delegatedDecision)
  );
  assert.throws(() =>
    assertSameRequestAdoptionCompletion(routedIntent, {
      ...completion,
      route: { ...route, baseRevision: 1 },
    })
  );
});

Deno.test("4.8e E5b: a branch decider may adopt the covered member change only in the same Request space", async () => {
  const f = await delegatedAdoptionFixture();
  const decision = structuredClone(f.delegatedDecision);
  decision.exercise.delegation.actor.executionSpaceId =
    f.target.executionSpaceId;
  decision.exercise.delegation.actor.operatorId = "branch-bo";
  decision.exercise.delegation.actorId = "branch-bo";
  assert.throws(() => parseRequestAdoptionDecision(decision));
  const routed = {
    ...decision,
    route: {
      version: 2 as const,
      status: "actor-decision" as const,
      changeId: decision.exercise.delegation.changeId,
      caseId: f.target.caseId,
      requestedBy: f.target.operatorId,
      requester: decision.exercise.delegation.requester,
      targetOperatorId: decision.exercise.delegation.requester.operatorId,
      baseRevision: 0,
      modelDigest: f.previous.version.digest,
      trace: [],
      designatedDecider: {
        operatorId: "branch-bo",
        executionSpaceId: f.target.executionSpaceId,
        policyId: decision.exercise.delegation.policyId,
        policyRevision: decision.exercise.delegation.policyRevision,
      },
    },
  };
  assert.deepEqual(parseRequestAdoptionDecision(routed), routed);
  for (
    const mutate of [
      (v: typeof routed) => v.route.designatedDecider.operatorId = "other",
      (v: typeof routed) => v.route.designatedDecider.policyRevision++,
      (v: typeof routed) => v.route.changeId = "other",
      (v: typeof routed) => v.route.caseId = "other",
      (v: typeof routed) => v.route.modelDigest = "1".repeat(64),
      (v: typeof routed) => v.exercise.delegation.actor.projectId = "",
      (v: typeof routed) => v.exercise.delegation.requester.systemId = "",
      (v: typeof routed) =>
        v.exercise.delegation.actor.projectId = "foreign-project",
      (v: typeof routed) => {
        v.exercise.delegation.actor = { ...v.exercise.delegation.requester };
        v.exercise.delegation.actorId =
          v.exercise.delegation.requester.operatorId;
      },
    ]
  ) {
    const forged = structuredClone(routed);
    mutate(forged);
    assert.throws(() => parseRequestAdoptionDecision(forged));
  }
  Object.assign(decision, { route: routed.route });
  assert.deepEqual(parseRequestAdoptionDecision(decision), decision);
  const intent = await f.resign({ ...f.delegatedIntent, decision });
  assert.deepEqual(await parseRequestAdoptionIntent(intent), intent);
  const memberIntent = structuredClone(f.delegatedIntent);
  memberIntent.previous.admission.permissions.operatorIds.unshift("branch-bo");
  memberIntent.previous.admission.permissions.modelDigests.unshift(
    "9".repeat(64),
  );
  memberIntent.candidate.model.operatorTeam = {
    parentOperatorId: "branch-bo",
    requestOwnerId: "branch-bo",
    requestId: f.target.caseId,
  };
  await assert.rejects(async () =>
    parseRequestAdoptionIntent(await f.resign(memberIntent))
  );
  const routedMember = await f.resign({ ...memberIntent, decision: routed });
  assert.deepEqual(
    await parseRequestAdoptionIntent(routedMember),
    routedMember,
  );
  const foreign = structuredClone(decision);
  foreign.exercise.delegation.actor.executionSpaceId = "space_B";
  assert.throws(() => parseRequestAdoptionDecision(foreign));
  const unscoped = structuredClone(decision);
  unscoped.exercise.delegation.actor.executionSpaceId = "";
  unscoped.exercise.delegation.requester.executionSpaceId = "";
  assert.throws(() => parseRequestAdoptionDecision(unscoped));
  await assert.rejects(async () =>
    parseRequestAdoptionIntent(
      await f.resign({ ...f.delegatedIntent, decision: foreign }),
    )
  );
});

Deno.test("4.8c: a delegated decision never adopts general instructions or another change", async () => {
  const f = await delegatedAdoptionFixture();
  const { network: _network, ...general } = f.delegatedIntent;
  await assert.rejects(
    async () =>
      parseRequestAdoptionIntent(
        await f.resign(general as unknown as Record<string, unknown>),
      ),
    { message: /prior authority\/exact target join required/ },
  );
  await assert.rejects(
    async () =>
      parseRequestAdoptionIntent(
        await f.resign({
          ...f.delegatedIntent,
          network: {
            ...f.delegatedIntent.network,
            changeId: "another-change",
            sourceAdmission: {
              ...f.delegatedIntent.network.sourceAdmission,
              commandId: "another-change",
            },
          },
        }),
      ),
    { message: /prior authority\/exact target join required/ },
  );
  for (
    const exercise of [
      { ...f.delegatedDecision.exercise, action: "mandate-change" },
      { ...f.delegatedDecision.exercise, delegation: undefined },
      {
        ...f.delegatedDecision.exercise,
        delegation: {
          ...f.delegatedDecision.exercise.delegation,
          actor: {
            ...f.delegatedDecision.exercise.delegation.actor,
            executionSpaceId: "space_B",
          },
        },
      },
    ]
  ) {
    assert.throws(() =>
      parseRequestAdoptionDecision({ ...f.delegatedDecision, exercise })
    );
  }
});

Deno.test("4.8e E4: a team creation leaves every other operator's executable as it was, but for the child's roots", async () => {
  const { previous } = await requestAdoptionFixture();
  previous.modelEditingAuthorityRoots = [
    "AssemblyLiveBuilder::collector::owner::ownerMandate",
  ];
  const creatorBefore = structuredClone(previous);
  const creatorAfter = structuredClone(previous);
  creatorAfter.modelEditingAuthorityRoots = [
    ...previous.modelEditingAuthorityRoots,
    "AssemblyLiveBuilder::operator_helper::builderMandate",
  ];
  const bystander = structuredClone(previous);
  bystander.identity = { ...bystander.identity, builderId: "collector" };
  const same = structuredClone(bystander);
  same.modelEditingAuthorityRoots = structuredClone(
    creatorAfter.modelEditingAuthorityRoots,
  );
  requestTeamBystanders(creatorBefore, creatorAfter, [bystander], [same]);
  for (
    const mutate of [
      (next: typeof same) => next.operator!.instruction += " changed",
      (next: typeof same) => next.modelEditingAuthorityRoots!.pop(),
      (next: typeof same) =>
        next.modelEditingAuthorityRoots!.push(
          "AssemblyLiveBuilder::operator_other::builderMandate",
        ),
      (next: typeof same) => next.policy.maxFlowSteps++,
    ]
  ) {
    const changed = structuredClone(same);
    mutate(changed);
    assert.throws(
      () =>
        requestTeamBystanders(creatorBefore, creatorAfter, [bystander], [
          changed,
        ]),
      Error,
      mutate.toString(),
    );
  }
  // A bystander that disappears or appears is never a team creation.
  assert.throws(() =>
    requestTeamBystanders(creatorBefore, creatorAfter, [bystander], [])
  );
});
