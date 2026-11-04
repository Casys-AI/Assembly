import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import { RequestSpaceModel } from "./request-space-model.ts";
import type { ModelPort } from "../runtime/ports.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { OpeningBase } from "../../../domain/work/request-spaces.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import { requestOpeningBase } from "../../../../test/support/request-space-fixture.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";

async function fixture(release = false) {
  const base = await requestOpeningBase("a", release);
  const model = executableFixture({
    backend: "native",
    projectId: "source-project",
    editingContextId: "source-project/main",
    rootId: "source-root",
    systemId: "native-system",
    builderId: "operator",
    catalogId: "native-catalog",
    systemQualifiedName: "Fixture::system",
  });
  model.version.repositoryVersion = base.manifest.source!.sourceVersion;
  model.version.digest = base.manifest.operators[0].modelDigest;
  base.manifest.operators[0].nativeSystemId = model.identity.systemId;
  return { base, model };
}

const errorCode = (code: RequestSpaceError["code"]) => (error: unknown) =>
  error instanceof RequestSpaceError && error.code === code;

Deno.test("Request exact model initializes and reads the recorded main or Release without identity rewriting", async () => {
  for (const release of [false, true]) {
    const { base, model } = await fixture(release);
    const port: ModelPort = new RequestSpaceModel({ base, model });
    deepStrictEqual(await port.initialize(), model.identity);
    deepStrictEqual(
      await port.initialize(model.identity, model.configuration),
      model.identity,
    );
    deepStrictEqual(await port.readExecutableModel(model.identity), model);
    deepStrictEqual(
      await port.readExecutableModel(
        model.identity,
        base.manifest.source!.sourceVersion,
      ),
      model,
    );
    equal(port.readSourceRevision, undefined);
    equal(port.readSourceProposals, undefined);
    equal(port.proposeRevision, undefined);
    equal(port.proposeDelegation, undefined);
    equal(port.syncConfiguration, undefined);
    equal(port.findCandidate, undefined);
  }
});

Deno.test("Request exact model supports another registered operator independently of the selected Request owner", async () => {
  const { base, model } = await fixture();
  const second = structuredClone(model);
  second.identity.builderId = "second-operator";
  second.identity.systemId = "second-system";
  second.identity.catalogId = "second-catalog";
  second.identity.systemQualifiedName = "Fixture::second";
  second.version.digest = "b".repeat(64);
  base.manifest.registeredOperatorIds.push(second.identity.builderId);
  base.manifest.operators.push({
    ...structuredClone(base.manifest.operators[0]),
    operatorId: second.identity.builderId,
    nativeSystemId: second.identity.systemId,
    systemQualifiedName: second.identity.systemQualifiedName,
    modelDigest: second.version.digest,
  });
  const firstPort = new RequestSpaceModel({ base, model });
  const secondPort = new RequestSpaceModel({ base, model: second });
  deepStrictEqual(await secondPort.initialize(), second.identity);
  deepStrictEqual(
    await secondPort.readExecutableModel(second.identity),
    second,
  );
  await rejects(
    () => firstPort.readExecutableModel(second.identity),
    errorCode("FORBIDDEN"),
  );
  await rejects(
    () => secondPort.readExecutableModel(model.identity),
    errorCode("FORBIDDEN"),
  );
});

Deno.test("Request exact model refuses missing, unregistered, duplicate and foreign operator entries", async () => {
  const changes: Array<(base: OpeningBase, model: ExecutableModel) => void> = [
    (base) => base.manifest.operators.splice(0),
    (base) => base.manifest.registeredOperatorIds.splice(0),
    (base) => base.manifest.registeredOperatorIds.push("operator"),
    (base) =>
      base.manifest.operators.push(
        structuredClone(base.manifest.operators[0]),
      ),
    (_base, model) => model.identity.builderId = "foreign",
    (base) => base.manifest.operators[0].nativeSystemId = "foreign-system",
    (base) =>
      base.manifest.operators[0].systemQualifiedName = "Foreign::system",
  ];
  for (const change of changes) {
    const { base, model } = await fixture();
    change(base, model);
    throws(() => new RequestSpaceModel({ base, model }), RequestSpaceError);
  }
});

Deno.test("Request exact model refuses incompatible digests and missing or divergent exact repository versions", async () => {
  const changes: Array<(base: OpeningBase, model: ExecutableModel) => void> = [
    (_base, model) => model.version.digest = "b".repeat(64),
    (base) => base.manifest.operators[0].modelDigest = "",
    (_base, model) => delete model.version.repositoryVersion,
    (_base, model) =>
      model.version.repositoryVersion = `commit:${"b".repeat(40)}`,
    (base) =>
      base.manifest.operators[0].repositoryVersion = `commit:${"b".repeat(40)}`,
    (base) => delete base.manifest.source,
    (base) => base.manifest.source!.sourceVersion = "main",
  ];
  for (const change of changes) {
    const { base, model } = await fixture();
    change(base, model);
    throws(
      () => new RequestSpaceModel({ base, model }),
      errorCode("UNAVAILABLE"),
    );
  }
});

Deno.test("Request exact model refuses alternate revisions, native identities and configuration changes without altering its model", async () => {
  const { base, model } = await fixture();
  const port = new RequestSpaceModel({ base, model });
  for (const repositoryVersion of [`commit:${"b".repeat(40)}`, "main", ""]) {
    await rejects(
      () => port.readExecutableModel(model.identity, repositoryVersion),
      errorCode("UNAVAILABLE"),
    );
  }
  for (const key of Object.keys(model.identity)) {
    const foreign = { ...model.identity, [key]: "foreign" };
    await rejects(() => port.initialize(foreign), errorCode("FORBIDDEN"));
    await rejects(
      () => port.readExecutableModel(foreign),
      errorCode("FORBIDDEN"),
    );
  }
  const configuration = structuredClone(model.configuration);
  configuration.network = { allowedHosts: ["foreign.example"] };
  await rejects(
    () => port.initialize(model.identity, configuration),
    errorCode("FORBIDDEN"),
  );
  deepStrictEqual(await port.readExecutableModel(model.identity), model);
});

Deno.test("Request exact model preserves optional encoding and provenance through defensive copies", async () => {
  const { base, model } = await fixture();
  model.version.authoritySchema = 2;
  model.operatorTeam = {
    parentOperatorId: "parent",
    requestOwnerId: "operator",
    requestId: "source-request",
  };
  // Presence and absence are retained, including explicitly undefined fields.
  model.initialSkills = undefined;
  const expected = structuredClone(model);
  const port = new RequestSpaceModel({ base, model });
  base.manifest.source!.sourceVersion = `commit:${"b".repeat(40)}`;
  base.manifest.operators[0].modelDigest = "b".repeat(64);
  model.identity.builderId = "mutated";
  model.version.sourceIds.push("mutated");
  model.flows.conversation.nodes.splice(0);
  model.operatorTeam.requestId = "mutated";
  model.configuration.network = { allowedHosts: ["mutated.example"] };
  const identity = await port.initialize();
  identity.catalogId = "mutated";
  const first = await port.readExecutableModel(expected.identity);
  deepStrictEqual(first, expected);
  first.version.sourceIds.push("returned-mutation");
  first.operatorTeam!.requestId = "returned-mutation";
  first.flows.conversation.nodes.splice(0);
  first.configuration.builder.mandateRevision++;
  deepStrictEqual(
    await port.readExecutableModel(
      expected.identity,
      expected.version.repositoryVersion,
    ),
    expected,
  );
  deepStrictEqual(await port.initialize(), expected.identity);
});

Deno.test("Request exact model refuses every required authoring, publication, activation and unsupported graph operation", async () => {
  const { base, model } = await fixture();
  const port = new RequestSpaceModel({ base, model });
  const change: Parameters<ModelPort["previewApprovedChange"]>[1] = {
    id: "change",
    kind: "mandate-change",
    status: "approved",
    baseRevision: model.configuration.revision,
    reason: "Test refusal",
    requestedAt: "2026-10-29T00:00:00Z",
  };
  const publication: Parameters<ModelPort["applyApprovedChange"]>[3] = {
    changeId: change.id,
    authorityExercise: exerciseOwnerAuthority(model, "mandate-change"),
    baseModelDigest: model.version.digest,
    baseRevision: model.configuration.revision,
    adoptedPin: structuredClone(model.version),
    decidedAt: change.requestedAt,
    edits: [],
  };
  const candidate: Parameters<ModelPort["activateCandidate"]>[1] = {
    id: "candidate",
    name: "Candidate",
    description: "Read-only refusal witness",
    kind: "read_web_page",
    code: "export default () => ({title: '', text: ''});",
    digest: "candidate-digest",
    stage: "activating",
    createdAt: change.requestedAt,
    baseCatalogRevision: 0,
  };
  const calls = [
    () =>
      port.previewApprovedChange(model.identity, change, model.version.digest),
    () =>
      port.applyApprovedChange(
        model.identity,
        change,
        model.version.digest,
        publication,
      ),
    () =>
      port.proposeEdit(model.identity, {
        baseVersion: model.version.repositoryVersion!,
        sourceDigest: base.manifest.source!.sourceDigest,
        reason: "Test refusal",
        edits: [{ kind: "remove", elementId: "native-element" }],
      }, model.version.digest),
    () =>
      port.activateCandidate(model.identity, candidate, model.version.digest),
  ];
  for (const call of calls) await rejects(call, errorCode("FORBIDDEN"));
  await rejects(() => port.graph(model.identity), errorCode("UNAVAILABLE"));
  deepStrictEqual(await port.readExecutableModel(model.identity), model);
});

Deno.test("Case model previews only the exact owner's network proposal and never enables generic publication", async () => {
  const { base, model } = await fixture();
  let calls = 0;
  const diff = {
    title: "Network",
    author: model.identity.builderId,
    base: {
      repositoryVersion: model.version.repositoryVersion!,
      modelDigest: model.version.digest,
      sourceDigest: "b".repeat(64),
    },
    sourceDigest: "c".repeat(64),
    files: [],
    patch: "compiled preview",
    additions: 1,
    deletions: 1,
  };
  const change = {
    id: "network-change",
    kind: "mandate-change" as const,
    status: "pending" as const,
    caseId: "case-a",
    requestedBy: model.identity.builderId,
    baseRevision: model.configuration.revision,
    baseModelDigest: model.version.digest,
    requestedAt: "2026-10-30T00:00:00.000Z",
    reason: "Network",
    requestedRights: { addNetworkHosts: ["docs.example.org"] },
  };
  const port = new RequestSpaceModel({
    base,
    model,
    executionSpaceId: "space-a",
    requestTeam: { caseId: "case-a", memberIds: [] },
    networkChangePreview: (identity, proposal, digest) => {
      calls++;
      deepStrictEqual(identity, model.identity);
      deepStrictEqual(proposal, change);
      equal(digest, model.version.digest);
      return Promise.resolve(diff);
    },
  });
  deepStrictEqual(port.requestChangeScope, {
    caseId: "case-a",
    operatorId: model.identity.builderId,
    executionSpaceId: "space-a",
    branchTeamSize: 0,
    memberIds: [],
  });
  deepStrictEqual(
    await port.previewApprovedChange(
      model.identity,
      change,
      model.version.digest,
    ),
    diff,
  );
  for (
    const other of [
      { ...change, caseId: "other" },
      { ...change, requestedBy: "other" },
      { ...change, baseRevision: change.baseRevision + 1 },
      {
        ...change,
        requestedRights: { setUrlSelectionMode: "authorized-host" as const },
      },
    ]
  ) {
    await rejects(() =>
      port.previewApprovedChange(model.identity, other, model.version.digest)
    );
  }
  equal(calls, 1);
  await rejects(() =>
    port.applyApprovedChange(model.identity, change, model.version.digest, {
      changeId: change.id,
      authorityExercise: exerciseOwnerAuthority(model, "mandate-change"),
      baseModelDigest: model.version.digest,
      baseRevision: model.configuration.revision,
      adoptedPin: model.version,
      decidedAt: "2026-10-30T00:01:00.000Z",
      edits: [],
    })
  );
  deepStrictEqual(await port.readExecutableModel(model.identity), model);
});

Deno.test("4.8e E4: a branch member created after birth is fixed by its admitted digest at the pin's source", async () => {
  const { base, model } = await fixture();
  // Not in the birth manifest; compiled at the adopted pin's source.
  const member = structuredClone(model);
  member.identity = {
    ...member.identity,
    builderId: "member",
    systemId: "member-system",
  };
  member.version = {
    ...member.version,
    digest: "e".repeat(64),
    repositoryVersion: `commit:${"9".repeat(40)}`,
  };
  const pin = {
    modelDigest: member.version.digest,
    repositoryVersion: member.version.repositoryVersion!,
  };
  const port = new RequestSpaceModel({ base, model: member, teamPin: pin });
  deepStrictEqual(await port.readExecutableModel(member.identity), member);
  // Another digest or source is not this member.
  for (
    const teamPin of [
      { ...pin, modelDigest: "f".repeat(64) },
      { ...pin, repositoryVersion: base.manifest.source!.sourceVersion },
    ]
  ) {
    throws(
      () => new RequestSpaceModel({ base, model: member, teamPin }),
      errorCode("UNAVAILABLE"),
    );
  }
});

Deno.test("Request previews refuse unsupported effects with a coded domain error before preparing sources", async () => {
  const { base, model } = await fixture();
  let previews = 0;
  const port = new RequestSpaceModel({
    base,
    model,
    executionSpaceId: "space-a",
    requestTeam: { caseId: "case-a", memberIds: [] },
    networkChangePreview: () => {
      previews++;
      throw new Error("Unsupported changes must not prepare sources");
    },
  });
  await rejects(
    () =>
      port.previewApprovedChange(model.identity, {
        id: "unsupported",
        kind: "mandate-change",
        status: "pending",
        caseId: "case-a",
        requestedBy: model.identity.builderId,
        baseRevision: model.configuration.revision,
        baseModelDigest: model.version.digest,
        reason: "Unsupported",
        requestedAt: "2026-11-02T00:00:00.000Z",
        requestedRights: { mayAdmitOwnCandidates: true },
      }, model.version.digest),
    (error) =>
      error instanceof OperatorAuthorityError &&
      error.code === "INVALID_OPERATOR_REQUEST",
  );
  equal(previews, 0);
});
