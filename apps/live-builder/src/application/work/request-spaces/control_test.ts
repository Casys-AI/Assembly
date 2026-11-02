import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { retainedToolAdmissionId } from "../../../domain/work/retained-tool-dependencies.ts";
import {
  ADMISSION_MAX_MS,
  SESSION_MAX_MS,
  SpaceAdmissions,
  SpaceControls,
} from "./control.ts";
import type {
  SpaceAdmissionStorePort,
  SpaceControlCredential,
  SpaceCredentialStorePort,
} from "./control-ports.ts";
import {
  type OpeningRecord,
  requestSpaceDigest,
  type SpaceControlAuthority,
  type SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
import {
  requestControlAdoptedState,
  requestOpeningBase,
  requestSpaceScope,
  spaceControlAuthority,
} from "../../../../test/support/request-space-fixture.ts";
const clone = <T>(value: T): T => structuredClone(value);
async function fixture(
  options: {
    executionBindings?:
      import("../../model/evolution/request-adoption-ports.ts").RequestExecutionBindingPort;
  } = {},
) {
  let now = Date.parse("2026-10-29T00:00:00Z"), nextId = 0, nextSecret = 0;
  const current = spaceControlAuthority();
  const rows = new Map<string, SpaceControlCredential>();
  const credentials: SpaceCredentialStorePort = {
    insert(row) {
      rows.set(row.id, clone(row));
      return Promise.resolve();
    },
    findHash(hash) {
      return Promise.resolve(
        clone(
          [...rows.values()].find((row) => row.secretHash === hash) ?? null,
        ),
      );
    },
    get(id) {
      return Promise.resolve(clone(rows.get(id) ?? null));
    },
    revokeCapability(id, ownerId, revision) {
      const row = rows.get(id)!;
      equal(row.ownerId, ownerId);
      equal(row.revision, revision);
      row.status = "revoked";
      row.revision++;
      return Promise.resolve(clone(row));
    },
  };
  const authority = {
    current: () => Promise.resolve(clone(current)),
    capture: () =>
      Promise.resolve({
        authority: clone(current),
        adoptedState: requestControlAdoptedState(),
      }),
  };
  const controls = new SpaceControls(
    credentials,
    authority,
    { randomSecret: () => (++nextSecret).toString(16).padStart(64, "0") },
    () => now,
    () => `credential-${++nextId}`,
  );
  const granted = new Map<string, SpaceExecutionAdmission>();
  const store: SpaceAdmissionStorePort = {
    admit(input) {
      let row = [...granted.values()].find((entry) =>
        entry.openingId === input.openingId
      );
      if (!row) {
        row = {
          ...clone(input),
          revision: 0,
          status: "active",
          createdAt: new Date(now).toISOString(),
        };
        granted.set(row.id, row);
      }
      return Promise.resolve(clone(row));
    },
    get: (id) => Promise.resolve(clone(granted.get(id) ?? null)),
    revoke(id) {
      const row = granted.get(id)!;
      row.status = "revoked";
      row.revision++;
      return Promise.resolve(clone(row));
    },
  };
  const admissions = new SpaceAdmissions(
    store,
    credentials,
    authority,
    controls,
    () => now,
    () => `admission-${++nextId}`,
    options.executionBindings,
  );
  const base = await requestOpeningBase();
  const record: OpeningRecord = {
    id: "opening",
    scope: requestSpaceScope,
    ownerId: "owner",
    caseId: "case",
    caseNumber: 1,
    executionSpaceId: "space",
    branchId: "branch",
    initialContributionId: "input",
    command: {
      openingKey: "key",
      text: "Request",
      source: { kind: "current-main" },
    },
    commandDigest: "command",
    base,
    baseDigest: await requestSpaceDigest(base),
    phase: "runtime-ready",
    admissionId: null,
    revision: 3,
    issues: [],
    createdAt: new Date(now).toISOString(),
  };
  return {
    rows,
    controls,
    admissions,
    record,
    tick: (ms: number) => {
      now += ms;
    },
    changePolicy: () => {
      current.policyRevision++;
    },
    changeCurrent: (update: (authority: SpaceControlAuthority) => void) =>
      update(current),
    setLegacy: () => {
      current.owner.ownerSource = "implicit-legacy";
    },
  };
}
Deno.test("local capability/session exchange stores hashes only and resolves the modeled owner server-side", async () => {
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  equal(actor.ownerId, "owner");
  equal(actor.capabilityId, capability.credentialId);
  equal(
    JSON.stringify([...f.rows.values()]).includes(capability.secret),
    false,
  );
  equal(JSON.stringify([...f.rows.values()]).includes(session.secret), false);
  deepStrictEqual([...f.rows.values()].map((row) => row.kind), [
    "capability",
    "session",
  ]);
  await rejects(() => f.controls.exchange("f".repeat(64)), /unavailable/);
  f.changePolicy();
  await rejects(
    () => f.controls.authenticateSession(session.secret),
    /unavailable/,
  );
});
Deno.test("dated conversation admission evaluates only the exact observed source and still refuses revocation", async () => {
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const admission = await f.admissions.ensure(f.record, actor);
  f.record.admissionId = admission.id;
  f.record.phase = "admitted";
  const expected = {
    sourceVersion: admission.permissions.sourceVersion,
    modelDigest: admission.permissions.modelDigests[0],
  };
  await f.admissions.assertConversation(f.record, actor, expected);
  await rejects(
    () =>
      f.admissions.assertConversation(f.record, actor, {
        ...expected,
        sourceVersion: `commit:${"f".repeat(40)}`,
      }),
    /observed source/,
  );
  await rejects(
    () =>
      f.admissions.assertConversation(f.record, actor, {
        ...expected,
        modelDigest: "f".repeat(64),
      }),
    /observed source/,
  );
  await f.admissions.revoke(admission.id, actor);
  await rejects(
    () => f.admissions.assertConversation(f.record, actor, expected),
    /unavailable/,
  );
});
Deno.test("retained admission retries recover one deterministic resource", async () => {
  const f = await fixture();
  const manifestDigest = "b".repeat(64), toolDigest = "d".repeat(64);
  f.record.base!.manifest.operators[0].tools = [{
    candidateId: "tool-1",
    digest: toolDigest,
    sourceBinding: {
      version: 1,
      bindingId: "binding",
      versionId: "version",
      revision: 1,
      ownerId: "operator",
      localArtifactId: "tool-1",
      invocationId: "invoke",
      reference: {
        version: 2,
        scopeId: "scope",
        repositoryId: "repo",
        artifactId: "tool-1",
        kind: "tool-draft",
        commitOid: "c".repeat(40),
        entryPath: `artifacts/${manifestDigest}/source.json`,
        manifestPath: `artifacts/${manifestDigest}/manifest.json`,
        contentEncoding: "tool-draft-json-v1",
        contentDigest: toolDigest,
        manifestFormat: "assembly-artifact-package-v2",
        manifestDigestVersion: "sha256-canonical-json-v1",
        manifestDigest,
      },
    },
  }];
  f.record.base!.manifestDigest = await requestSpaceDigest(
    f.record.base!.manifest,
  );
  f.record.baseDigest = await requestSpaceDigest(f.record.base);
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const first = await f.admissions.ensure(f.record, actor);
  const retried = await f.admissions.ensure(f.record, actor);
  equal(first.id, await retainedToolAdmissionId(f.record.scope, f.record.id));
  equal(first.permissions.resourceIds.length, 1);
  deepStrictEqual(retried, first);
});

Deno.test("session expiry blocks new control calls while the independent space admission remains active", async () => {
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const admission = await f.admissions.ensure(f.record, actor);
  f.tick(SESSION_MAX_MS + 1);
  await rejects(
    () => f.controls.authenticateSession(session.secret),
    /unavailable/,
  );
  await rejects(() => f.admissions.ensure(f.record, actor), /unavailable/);
  await f.admissions.assertDispatch(f.record, admission);
  const nextSession = await f.controls.exchange(capability.secret);
  const nextActor = await f.controls.authenticateSession(nextSession.secret);
  await f.controls.revokeCapability(nextActor);
  await rejects(
    () => f.admissions.assertDispatch(f.record, admission),
    /unavailable/,
  );
});
Deno.test("revoked space admissions and implicit owner authority cannot be revived by exact retries", async () => {
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const admitted = await f.admissions.ensure(f.record, actor);
  await f.admissions.revoke(admitted.id, actor);
  await rejects(() => f.admissions.ensure(f.record, actor), /unavailable/);
  f.setLegacy();
  await rejects(() => f.controls.issueCapability("owner"), /unavailable/);
});

Deno.test("main can advance without changing control policy or rebinding an admitted Case", async () => {
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const admitted = await f.admissions.ensure(f.record, actor);
  const initialBase = clone(f.record.base),
    initialCredentials = clone([...f.rows.values()]);
  f.changeCurrent((authority) => {
    authority.sourceVersion = `commit:${"d".repeat(40)}`;
    authority.modelDigest = "d".repeat(64);
    authority.owner.sourceIds = ["current-source-evidence"];
    authority.acts.reverse();
  });
  await f.controls.revalidate(actor);
  const nextActor = await f.controls.authenticateSession(session.secret);
  deepStrictEqual(
    nextActor.authority,
    actor.authority,
    "Credential evidence must never be rewritten to the new source",
  );
  deepStrictEqual(await f.admissions.ensure(f.record, nextActor), admitted);
  await f.admissions.assertDispatch(f.record, admitted);
  deepStrictEqual([...f.rows.values()], initialCredentials);
  deepStrictEqual(f.record.base, initialBase);
  const nextSession = await f.controls.exchange(capability.secret);
  await f.controls.authenticateSession(nextSession.secret);
  f.changePolicy();
  await rejects(
    () => f.controls.authenticateSession(nextSession.secret),
    /unavailable/,
  );
  await rejects(
    () => f.admissions.assertDispatch(f.record, admitted),
    /unavailable/,
  );
});
Deno.test("effective policy content without revision bump and foreign control scope refuse old sessions and admitted work", async () => {
  for (
    const change of [
      (authority: SpaceControlAuthority) => {
        authority.acts = ["open-request", "execute-conversation"];
      },
      (authority: SpaceControlAuthority) => {
        authority.operatorIds.push("new-grantee");
      },
      (authority: SpaceControlAuthority) => {
        authority.scope.projectId = "foreign-project";
      },
      (authority: SpaceControlAuthority) => {
        authority.scope.systemId = "foreign-host";
      },
      (authority: SpaceControlAuthority) => {
        authority.owner.systemId = "foreign-native";
      },
      (authority: SpaceControlAuthority) => {
        authority.sourceSystemNativeId = "foreign-native";
        authority.owner.systemId = "foreign-native";
      },
      (authority: SpaceControlAuthority) => {
        authority.owner.rootGrantNativeId = "other-grant";
      },
      (authority: SpaceControlAuthority) => {
        authority.owner.mandateRevision++;
      },
    ]
  ) {
    const f = await fixture();
    const capability = await f.controls.issueCapability("owner");
    const session = await f.controls.exchange(capability.secret);
    const actor = await f.controls.authenticateSession(session.secret);
    const admitted = await f.admissions.ensure(f.record, actor);
    f.changeCurrent(change);
    await rejects(() => f.controls.exchange(capability.secret), /unavailable/);
    await rejects(
      () => f.controls.authenticateSession(session.secret),
      /unavailable/,
    );
    await rejects(() => f.admissions.ensure(f.record, actor), /unavailable/);
    await rejects(
      () => f.admissions.assertDispatch(f.record, admitted),
      /unavailable/,
    );
  }
});
Deno.test("admission expiry independently refuses autonomous dispatch after source-only main advancement", async () => {
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const admitted = await f.admissions.ensure(f.record, actor);
  f.changeCurrent((authority) => {
    authority.sourceVersion = `commit:${"e".repeat(40)}`;
    authority.modelDigest = "e".repeat(64);
  });
  f.tick(ADMISSION_MAX_MS + 1);
  await rejects(
    () => f.admissions.assertDispatch(f.record, admitted),
    /unavailable/,
  );
});

Deno.test("local capability issuance forwards its single atomic capture witness without recapture", async () => {
  const captured = {
    authority: spaceControlAuthority(),
    adoptedState: requestControlAdoptedState(7),
  };
  const inserted: Array<
    { row: SpaceControlCredential; witness?: typeof captured.adoptedState }
  > = [];
  let captures = 0;
  const controls = new SpaceControls(
    {
      insert(
        row: SpaceControlCredential,
        witness?: typeof captured.adoptedState,
      ) {
        inserted.push({ row, witness });
        return Promise.resolve();
      },
      findHash: () => Promise.resolve(null),
      get: () => Promise.resolve(null),
      revokeCapability() {
        throw new Error("No revocation in issuance");
      },
    },
    {
      current() {
        throw new Error("Issuance must not separately read authority");
      },
      capture() {
        captures++;
        return Promise.resolve(clone(captured));
      },
    },
    { randomSecret: () => "1".repeat(64) },
    () => Date.parse("2026-10-29T00:00:00Z"),
    () => "capability",
  );
  const result = await controls.issueCapability("owner");
  equal(captures, 1);
  equal(result.credentialId, "capability");
  deepStrictEqual(inserted[0].witness, captured.adoptedState);
  deepStrictEqual(inserted[0].row.authority, captured.authority);
  equal("adoptedState" in inserted[0].row.authority, false);
});

Deno.test("continued conversation preflight reads the existing admission and never creates or renews one", async () => {
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  await rejects(() => f.admissions.assertConversation(f.record, actor));
  const admission = await f.admissions.ensure(f.record, actor);
  f.record.phase = "admitted";
  f.record.admissionId = admission.id;
  const before = structuredClone(admission);
  await f.admissions.assertConversation(f.record, actor);
  await f.admissions.assertDispatch(f.record, before);
  await f.admissions.revoke(admission.id, actor);
  await rejects(
    () => f.admissions.assertConversation(f.record, actor),
    /unavailable/,
  );
  await rejects(() => f.admissions.ensure(f.record, actor), /unavailable/);
});

Deno.test("4.8e E4: an opening's team is read from its birth models; no binding exists yet", async () => {
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const received: unknown[] = [];
  f.admissions.bindTeamModels((_record, binding) => {
    received.push(binding ?? null);
    return Promise.resolve([]);
  });
  const admission = await f.admissions.ensure(f.record, actor);
  // Before the first dispatch the caller has no execution binding to pass:
  // the reader is told so explicitly and must not look one up itself.
  equal(received.length > 0, true);
  deepStrictEqual(received.filter((binding) => binding !== null), []);
  deepStrictEqual(admission.permissions.operatorIds, ["operator"]);
});

Deno.test("4.8e: a dispatch check reads the pinned team once per pin and creation receipts, not once per BO state revision", async () => {
  let revision = 0;
  const binding = () => ({
    pin: { modelDigest: "a".repeat(64), source: { version: "commit:pin" } },
    admission: { revision: 0, permissions: { resourceIds: [] } },
    state: {
      revision: ++revision,
      executionModel: {
        identity: { builderId: "operator", systemId: "worker-system" },
        version: { digest: "a".repeat(64) },
      },
      configuration: { changes: [] },
    },
  });
  const f = await fixture({
    executionBindings: { read: () => Promise.resolve(binding() as never) },
  });
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const admission = await f.admissions.ensure(f.record, actor);
  f.record.admissionId = admission.id;
  f.record.phase = "admitted";
  const reads: unknown[] = [];
  f.admissions.bindTeamModels((_record, read) => {
    reads.push(read?.state.revision);
    return Promise.resolve([]);
  });
  // Every turn saves the BO's state; the pin and its creation receipts are
  // unchanged, so the pinned team (a compile of the pin) is read once.
  for (let i = 0; i < 3; i++) {
    await f.admissions.assertDispatch(f.record, admission).catch(() => {});
  }
  equal(reads.length, 1);
});

Deno.test("admission carries the verified branch team after the BO, without widening the person's policy", async () => {
  const { legacyOwnerAuthority } = await import(
    "../../../domain/governance/authority.ts"
  );
  const { creationAuthorityExercise } = await import(
    "../../../domain/governance/policies/operator-creation-policy.ts"
  );
  type Model =
    import("../../../domain/model/execution/executable-model.ts").ExecutableModel;
  const f = await fixture();
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const actor = await f.controls.authenticateSession(session.secret);
  const root = {
    ...legacyOwnerAuthority("worker-system"),
    ownerSource: "modeled" as const,
  };
  const policy = {
    id: "create-team",
    revision: 1,
    elementId: "grant-element",
    sourceIds: ["grant-element"],
    holderNativeId: "operator",
    mandateNativeId: "worker-mandate",
    systemId: "worker-system",
    enabled: true,
    rootAuthority: root,
    networkHosts: [],
    maxChildren: 2,
    maxDelegationDepth: 1,
    children: [],
  };
  const spec = {
    kind: "request-team-member" as const,
    instruction: "Contribute to this Case.",
    creationGrant: { networkHosts: [], maxChildren: 2, maxDelegationDepth: 0 },
    provision: {
      budget: { maxAgentDecisions: 2, maxToolProposals: 1, maxFlowSteps: 10 },
      networkHosts: [],
      mayPropose: [],
      mayInvokeActiveCatalog: false,
    },
  };
  const parent = {
    identity: { builderId: "operator", systemId: "worker-system" },
    version: { digest: "base" },
    ownerAuthority: root,
    operatorCreationPolicies: [policy],
    policy: { maxAgentDecisions: 5, maxToolProposals: 2, maxFlowSteps: 50 },
    mandate: { mayPropose: [], mayInvoke: false },
    configuration: { network: { allowedHosts: [] }, changes: [] },
  } as unknown as Model;
  const change = {
    id: "create-member",
    kind: "operator-creation",
    role: "operator",
    name: "Helper",
    status: "approved",
    requestedBy: "operator",
    caseId: "case",
    teamOrigin: { operatorId: "operator", requestId: "case" },
    baseRevision: 0,
    requestedAt: "now",
    reason: "Help",
    operator: spec,
    authority: "builder",
    decidedAt: "now",
  } as never;
  (change as { authorityExercise?: unknown }).authorityExercise =
    creationAuthorityExercise(parent, change, {
      actorId: "operator",
      policyId: policy.id,
      policyRevision: 1,
    }, {
      space: {
        projectId: "space-project",
        systemId: "worker-system",
        executionSpaceId: "space",
      },
      branchTeamSize: 0,
    });
  (parent as { configuration: unknown }).configuration = {
    network: { allowedHosts: [] },
    changes: [change],
  };
  parent.operatorCreationPolicies = [{
    ...policy,
    children: ["member-system"],
  }] as never;
  const member = {
    identity: { builderId: "member", systemId: "member-system" },
    version: { digest: "member-digest" },
    operatorTeam: {
      parentOperatorId: "operator",
      requestOwnerId: "operator",
      requestId: "case",
      creationPolicyId: policy.id,
    },
    operator: { instruction: spec.instruction },
    configuration: { network: { allowedHosts: [] } },
    policy: { ...spec.provision.budget, mayAddNetworkHosts: false },
    mandate: { mayPropose: [], mayInvoke: false },
  } as unknown as Model;
  const forged = structuredClone(member) as Model;
  (forged as { identity: { builderId: string; systemId: string } }).identity = {
    builderId: "forged",
    systemId: "forged-system",
  };
  f.admissions.bindTeamModels(() =>
    Promise.resolve([structuredClone(parent), structuredClone(member), forged])
  );
  const admission = await f.admissions.ensure(f.record, actor);
  // The person's policy admits "operator" alone; the verified member follows
  // it, the forged model (no matching receipt) is excluded.
  deepStrictEqual(admission.permissions.operatorIds, ["operator", "member"]);
  deepStrictEqual(admission.permissions.modelDigests, [
    "a".repeat(64),
    "member-digest",
  ]);

  // A member's own persisted receipt admits its child; stale/forged state
  // cannot be replaced by the pinned model's configuration.
  const memberRoot = {
    ...legacyOwnerAuthority("member-system"),
    ownerSource: "modeled" as const,
  };
  const memberPolicy = {
    ...policy,
    id: "member-grant",
    elementId: "member-grant-element",
    holderNativeId: "member",
    systemId: "member-system",
    rootAuthority: memberRoot,
    maxChildren: 2,
    maxDelegationDepth: 0,
    children: [],
  };
  member.ownerAuthority = memberRoot;
  member.operatorCreationPolicies = [memberPolicy] as never;
  const { creationGrant: _grant, ...ungrantedSpec } = spec;
  const childSpec = { ...ungrantedSpec, instruction: "Child contribution." };
  const childChange = {
    ...(change as import("../../../domain/governance/records/pending-change.ts").PendingChange),
    id: "create-grandchild",
    name: "Grandchild",
    requestedBy: "member",
    operator: childSpec,
    authorityExercise: undefined,
  } as never;
  (childChange as { authorityExercise?: unknown }).authorityExercise =
    creationAuthorityExercise(member, childChange, {
      actorId: "member",
      policyId: memberPolicy.id,
      policyRevision: 1,
    }, {
      space: {
        projectId: "space-project",
        systemId: "member-system",
        executionSpaceId: "space",
      },
      branchTeamSize: 1,
    });
  member.operatorCreationPolicies = [{
    ...memberPolicy,
    children: ["grandchild-system"],
  }] as never;
  const child = {
    ...structuredClone(member),
    identity: { builderId: "grandchild", systemId: "grandchild-system" },
    version: { digest: "grandchild-digest" },
    operatorTeam: {
      parentOperatorId: "member",
      requestOwnerId: "operator",
      requestId: "case",
      creationPolicyId: memberPolicy.id,
    },
    operator: { instruction: childSpec.instruction },
    operatorCreationPolicies: [],
  } as unknown as Model;
  const memberState = { configuration: { changes: [childChange] } };
  let states: ReadonlyMap<string, unknown> = new Map([["member", memberState]]);
  f.admissions.bindTeamModels(() => Promise.resolve([parent, member, child]));
  f.admissions.bindTeamStates((_record, ids) => {
    deepStrictEqual(ids, ["member"]);
    return Promise.resolve(states as never);
  });
  const binding = {
    pin: { source: { version: "commit:pin" } },
    admission: { permissions: { operatorIds: ["operator", "member"] } },
    state: { executionModel: parent, configuration: { changes: [change] } },
  };
  const team = (f.admissions as unknown as {
    team(
      record: OpeningRecord,
      binding: unknown,
    ): Promise<Array<{ operatorId: string }>>;
  }).team.bind(f.admissions);
  deepStrictEqual(
    (await team(f.record, binding)).map((item) => item.operatorId),
    ["grandchild", "member"],
  );
  // Revocation after creation changes no historical receipt.
  (member as unknown as {
    operatorCreationPolicies: Array<{ enabled: boolean }>;
  }).operatorCreationPolicies[0].enabled = false;
  f.admissions.bindTeamModels(() => Promise.resolve([parent, member, child]));
  deepStrictEqual(
    (await team(f.record, binding)).map((item) => item.operatorId),
    ["grandchild", "member"],
  );
  // With no anchored creation policy the child is excluded.
  const revokedPolicies = member.operatorCreationPolicies;
  member.operatorCreationPolicies = [];
  f.admissions.bindTeamModels(() => Promise.resolve([parent, member, child]));
  deepStrictEqual(
    (await team(f.record, binding)).map((item) => item.operatorId),
    ["member"],
  );
  member.operatorCreationPolicies = revokedPolicies;
  f.admissions.bindTeamModels(() => Promise.resolve([parent, member, child]));
  // Missing member state or a forged receipt never admits its child, even
  // when the parent model's configuration contains a matching-looking change.
  member.configuration.changes = [childChange];
  states = new Map();
  deepStrictEqual(
    (await team(f.record, binding)).map((item) => item.operatorId),
    ["member"],
  );
  states = new Map([["member", {
    configuration: {
      changes: [{
        ...(childChange as import("../../../domain/governance/records/pending-change.ts").PendingChange),
        authorityExercise: undefined,
      }],
    },
  }]]);
  deepStrictEqual(
    (await team(f.record, binding)).map((item) => item.operatorId),
    ["member"],
  );
});

const mainOperator = {
  projectId: "project",
  systemId: "system",
  executionSpaceId: "main",
  operatorId: "operator",
};

Deno.test("4.8d D3: a host controller holds a capability, never a session, and admits only an allowed operator", async () => {
  const f = await fixture();
  const controller = await f.controls.hostController("owner", mainOperator);
  equal(controller.kind, "host");
  equal(controller.ownerId, "owner");
  deepStrictEqual(controller.opener, mainOperator);
  equal("sessionId" in controller, false);
  deepStrictEqual([...f.rows.values()].map((row) => row.kind), ["capability"]);
  await f.controls.revalidate(controller);
  await rejects(
    () =>
      f.controls.hostController("owner", {
        ...mainOperator,
        operatorId: "not-allowed",
      }),
    /unavailable/,
  );
  // The policy's allowed operator changes: the controller stops at once.
  f.changeCurrent((authority) => authority.operatorIds = ["someone-else"]);
  await rejects(() => f.controls.revalidate(controller), /unavailable/);
});

Deno.test("4.8d D3: the person's session reads an admission opened by the host controller", async () => {
  const f = await fixture();
  const host = await f.controls.hostController("owner", mainOperator);
  const admission = await f.admissions.ensure(f.record, host);
  equal(admission.capabilityId, host.capabilityId);
  f.record.phase = "admitted";
  f.record.admissionId = admission.id;
  const capability = await f.controls.issueCapability("owner");
  const session = await f.controls.exchange(capability.secret);
  const person = await f.controls.authenticateSession(session.secret);
  await f.admissions.assertConversation(f.record, person);
  // Revoking the host capability revokes what it admitted.
  f.rows.get(host.capabilityId)!.status = "revoked";
  await rejects(() => f.controls.revalidate(host), /unavailable/);
  await rejects(
    () => f.admissions.assertConversation(f.record, person),
    /unavailable/,
  );
});
