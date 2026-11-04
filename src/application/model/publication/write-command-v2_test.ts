import type { RequestSourceOwnerAuthorityEnvelope } from "../source-admission/request-source-owner.ts";
import { assertRequestChangeDossier } from "./request-change.ts";
import { mutableTestSnapshot } from "../../../../test/support/mutable-test-snapshot.ts";
import {
  captureRequestSourceOwnerPhase,
  requestSourceOwnerAuthorityDigest,
} from "../source-admission/request-source-owner.ts";
import type { SpaceController } from "../../../domain/work/request-spaces/space-control.ts";
import assert from "node:assert/strict";
import * as v2Api from "./write-command-v2.ts";
import type { AuthorityExercise } from "../../../domain/governance/authority.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import type { ExecutableModelVersion } from "../../../domain/model/execution/executable-model.ts";
import {
  type CandidateActivationPublication,
  changePublication,
} from "../../../domain/model/publication/change.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  assertModelWriteDossier,
  modelWriteCommandDigest,
  type ModelWriteDossier,
  modelWriteDossierDigest,
  modelWriteIntentDigest,
  parseModelWriteCommand,
} from "../../../domain/model/editing/write-command.ts";
import { buildOperationJournal } from "../../../domain/model/editing/operation-journal.ts";
import {
  assertModelWriteDestinationMatches,
  assertModelWriteReplayMatches,
  buildModelWriteDossierV2,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
  modelWriteIntentDigestV2,
  parseModelWriteCommandV2,
  parseModelWriteDossierV2,
  parseVersionedModelWriteCommand,
  parseVersionedModelWriteDossier,
  requestModelWriteDestinationDigest,
} from "./write-command-v2.ts";
import {
  parseRequestModelWriteDestination,
  type RequestModelWriteDestination,
} from "../../../domain/model/editing/request-write-destination.ts";

// Frozen v1 fixture and independent canonical SHA-256 vectors. No v2 migration
// or destination field may enter these accepted bytes or Main recovery hashes.
const legacyBase = parseModelRevisionRef({
  repositoryId: "repo",
  version: `commit:${"1".repeat(40)}`,
});
const nextBase = parseModelRevisionRef({
  repositoryId: "repo",
  version: `commit:${"2".repeat(40)}`,
});
const legacy: ModelWriteDossier = {
  "v": 1,
  "command": {
    "v": 1,
    "repositoryId": "repo",
    "commandId": "proposal-1",
    "kind": "accept-proposal",
    "approvedBase": legacyBase,
    "operationsRef": {
      "digest":
        "9a01545469f48173265ab23cf030668abb91a8b78c0c1b6f9a454bc06a19b94e",
    },
    "decisionRef": {
      "id": "proposal-1",
      "digest":
        "c6208f6720b3774997a2dd4823f5d64df8f51252c78ff82cd393deac7c49d44d",
    },
    "recipeDigest":
      "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "intentDigest":
      "d5c253051a4666be0818b0886937557f17a9a9fbb2f4683327b2ee2e8d7a4dde",
  },
  "operations": {
    "kind": "whole-files",
    "files": {
      "v": 1,
      "base": legacyBase,
      "baseSourceDigest":
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "files": [
        {
          "path": "models/configuration.sysml",
          "baseDigest":
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "text": "package Changed;",
        },
      ],
    },
  },
  "decision": {
    "kind": "accept-proposal",
    "proposalId": "proposal-1",
    "expectedVersion": "commit:1111111111111111111111111111111111111111",
    "baseVersion": "commit:1111111111111111111111111111111111111111",
    "proposalSourceDigest":
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "proposalVersion": "proposal:1",
    "author": "owner",
  },
};
const branchId = "abcdef12-abcd-4abc-8def-123456abcdef";
const destination = (): RequestModelWriteDestination => ({
  v: 1,
  kind: "request",
  repositoryId: "repo",
  host: {
    projectId: "git:11111111-1111-4111-8111-111111111111",
    systemId: "Assembly::Primary",
  },
  openingId: "opening-a",
  executionSpaceId: "space-a",
  caseId: "case-a",
  branchId,
  ref: `refs/heads/requests/${branchId}`,
  expectedAdmittedSource: {
    revision: 1,
    source: structuredClone(legacy.command.approvedBase),
    sourceDigest: "a".repeat(64),
  },
});
function sourceAuthority() {
  const target = destination();
  const {
    authoritySchema: _schema,
    action: _action,
    baseModelDigest: _digest,
    outOfMandate: _recovery,
    ...owner
  } = recordedAuthority("model-revision");
  const controller: SpaceController = {
    ownerId: "owner",
    capabilityId: "capability",
    capabilityRevision: 0,
    sessionId: "proposal-session",
    authority: {
      scope: target.host,
      sourceSystemNativeId: owner.systemId,
      sourceVersion: target.expectedAdmittedSource.source.version,
      modelDigest: "e".repeat(64),
      owner,
      policyId: "control",
      policyRevision: 1,
      operatorIds: ["operator"],
      acts: [
        "open-request",
        "execute-conversation",
        "revoke-execution",
        "retain-release",
      ],
    },
  };
  const context = {
    destination: target,
    openingOwnerId: "owner",
    targetOperatorId: "operator",
    priorModel: {
      identity: {
        projectId: "git:repo",
        editingContextId: "editing",
        rootId: "root",
        systemId: owner.systemId,
        catalogId: "catalog",
        builderId: "operator",
      },
      version: {
        digest: "e".repeat(64),
        repositoryVersion: target.expectedAdmittedSource.source.version,
        authoritySchema: 2 as const,
        rootId: "root",
        configurationId: "configuration",
        configurationRevision: 0,
        sourceIds: ["source"],
      },
      ownerAuthority: owner,
    },
  };
  const binding = { scope: target.host, sourceSystemNativeId: owner.systemId };
  const proposal = captureRequestSourceOwnerPhase({
    phase: "proposal",
    context,
    controller,
    sessionRevision: 0,
    binding,
    capturedAt: "2026-10-30T01:00:00.000Z",
  });
  const acceptance = captureRequestSourceOwnerPhase({
    phase: "acceptance",
    context,
    controller: { ...controller, sessionId: "acceptance-session" },
    sessionRevision: 1,
    binding,
    capturedAt: "2026-10-30T01:01:00.000Z",
  });
  return {
    v: 1 as const,
    kind: "request-source-owner-authority" as const,
    proposal,
    acceptance,
  };
}
function input() {
  if (
    legacy.operations.kind !== "whole-files" ||
    legacy.decision.kind !== "accept-proposal"
  ) throw new Error("fixture");
  return {
    repositoryId: "repo",
    commandId: "proposal-1",
    kind: "accept-proposal" as const,
    destination: destination(),
    operations: structuredClone(legacy.operations),
    decision: {
      ...structuredClone(legacy.decision),
      decisionAuthorityExercise: sourceAuthority().acceptance.exercise,
    },
    authority: sourceAuthority(),
    recipeDigest: legacy.command.recipeDigest,
  };
}
async function resign(command: Parameters<typeof modelWriteIntentDigestV2>[0]) {
  return {
    v: 2 as const,
    ...command,
    intentDigest: await modelWriteIntentDigestV2(command),
  };
}

Deno.test("v1 frozen Main command/dossier bytes and digests remain exact; legacy parser refuses v2", async () => {
  const before = canonical(legacy);
  await assertModelWriteDossier(legacy);
  const { intentDigest: _digest, v: _v, ...intent } = legacy.command;
  assert.equal(
    await modelWriteIntentDigest(intent),
    "d5c253051a4666be0818b0886937557f17a9a9fbb2f4683327b2ee2e8d7a4dde",
  );
  assert.equal(
    await modelWriteCommandDigest(legacy.command),
    "48af214f096ab3a8b49f7520f1e540ccff8c910b8f8a10bded08597e47767812",
  );
  assert.equal(
    await modelWriteDossierDigest(legacy),
    "c394db80438c7537c52bfa2f1f64040bb18f01902e816052e03cfed8bbd2af97",
  );
  assert.deepStrictEqual(await parseVersionedModelWriteDossier(legacy), legacy);
  assert.deepStrictEqual(
    parseVersionedModelWriteCommand(legacy.command),
    legacy.command,
  );
  assert.equal(canonical(legacy), before);
  assertModelWriteDestinationMatches(legacy.command, {
    kind: "main",
    repositoryId: "repo",
  });
  assert.throws(
    () => assertModelWriteDestinationMatches(legacy.command, destination()),
    { code: "WRITE_DOSSIER_MISMATCH" },
  );
  const scoped = await buildModelWriteDossierV2(input());
  assert.throws(() => parseModelWriteCommand(scoped.command), {
    code: "WRITE_COMMAND_INVALID",
  });
  await assert.rejects(
    () => assertModelWriteDossier(scoped as unknown as ModelWriteDossier),
    { code: "WRITE_DOSSIER_MISMATCH" },
  );
});

Deno.test("explicit v2 dossier survives JSON recovery with full destination and no Main default", async () => {
  const dossier = await buildModelWriteDossierV2(input());
  const restored = await parseVersionedModelWriteDossier(
    JSON.parse(JSON.stringify(dossier)),
  );
  assert.deepStrictEqual(restored, dossier);
  assert.equal(
    await modelWriteDossierDigestV2(dossier),
    await modelWriteDossierDigestV2(restored as typeof dossier),
  );
  assertModelWriteDestinationMatches(dossier.command, destination());
  assert.throws(
    () =>
      assertModelWriteDestinationMatches(dossier.command, {
        kind: "main",
        repositoryId: "repo",
      }),
    { code: "WRITE_DOSSIER_MISMATCH" },
  );
  const { destination: _target, ...missing } = dossier.command;
  assert.throws(() => parseVersionedModelWriteCommand(missing), {
    code: "WRITE_COMMAND_INVALID",
  });
  await assert.rejects(
    () => parseVersionedModelWriteDossier({ ...dossier, v: 1 }),
    { code: "WRITE_COMMAND_INVALID" },
  );
});

Deno.test("every destination coordinate participates in exact intent and same commandId conflicts", async () => {
  const dossier = await buildModelWriteDossierV2(input());
  const original = destination();
  const otherBranch = "22222222-2222-4222-8222-222222222222";
  const changes: RequestModelWriteDestination[] = [
    { ...original, host: { ...original.host, projectId: "git:other-host" } },
    { ...original, host: { ...original.host, systemId: "Other::Primary" } },
    { ...original, openingId: "opening-b" },
    { ...original, executionSpaceId: "space-b" },
    { ...original, caseId: "case-b" },
    {
      ...original,
      branchId: otherBranch,
      ref: `refs/heads/requests/${otherBranch}`,
    },
    {
      ...original,
      expectedAdmittedSource: {
        ...original.expectedAdmittedSource,
        revision: 2,
      },
    },
    {
      ...original,
      expectedAdmittedSource: {
        ...original.expectedAdmittedSource,
        sourceDigest: "e".repeat(64),
      },
    },
    {
      ...original,
      repositoryId: "other-repo",
      expectedAdmittedSource: {
        ...original.expectedAdmittedSource,
        source: {
          ...original.expectedAdmittedSource.source,
          repositoryId: "other-repo",
        },
      },
    },
    {
      ...original,
      expectedAdmittedSource: {
        ...original.expectedAdmittedSource,
        source: {
          ...original.expectedAdmittedSource.source,
          version: nextBase.version,
        },
      },
    },
  ];
  for (const changed of changes) {
    const command = await resign({
      ...dossier.command,
      repositoryId: changed.repositoryId,
      approvedBase: changed.expectedAdmittedSource.source,
      destination: changed,
    });
    assert.notEqual(
      await requestModelWriteDestinationDigest(changed),
      await requestModelWriteDestinationDigest(original),
    );
    assert.notEqual(command.intentDigest, dossier.command.intentDigest);
    assert.notEqual(
      await modelWriteCommandDigestV2(command),
      await modelWriteCommandDigestV2(dossier.command),
    );
    await assert.rejects(
      () => assertModelWriteReplayMatches(dossier.command, command),
      { code: "WRITE_DOSSIER_MISMATCH" },
    );
    assert.throws(() => assertModelWriteDestinationMatches(command, original), {
      code: "WRITE_DOSSIER_MISMATCH",
    });
  }
  await assertModelWriteReplayMatches(
    dossier.command,
    structuredClone(dossier.command),
  );
  await assert.rejects(
    () => assertModelWriteReplayMatches(legacy.command, dossier.command),
    { code: "WRITE_DOSSIER_MISMATCH" },
  );
});

Deno.test("internal destination grammar rejects raw Main/arbitrary refs, aliases, actors, proofs and malformed admitted heads", () => {
  const original = destination();
  const invalid: unknown[] = [
    { ...original, ref: "refs/heads/admitted" },
    { ...original, ref: "refs/heads/requests/other" },
    { ...original, ref: `refs/heads/requests/${branchId}/../main` },
    { ...original, kind: "main" },
    { ...original, executionSpaceId: "main" },
    { ...original, v: 2 },
    { ...original, branchId: branchId.toUpperCase() },
    { ...original, host: { ...original.host, ownerId: "self" } },
    { ...original, actor: "self" },
    { ...original, authority: {} },
    { ...original, proof: {} },
    { ...original, openingId: " " },
    { ...original, host: { ...original.host, projectId: "host\0foreign" } },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((revision) => ({
      ...original,
      expectedAdmittedSource: { ...original.expectedAdmittedSource, revision },
    })),
    {
      ...original,
      expectedAdmittedSource: {
        ...original.expectedAdmittedSource,
        sourceDigest: "changed",
      },
    },
    {
      ...original,
      expectedAdmittedSource: {
        ...original.expectedAdmittedSource,
        source: {
          repositoryId: "foreign",
          version: legacy.command.approvedBase.version,
        },
      },
    },
    {
      ...original,
      expectedAdmittedSource: {
        ...original.expectedAdmittedSource,
        source: { repositoryId: "repo", version: "HEAD" },
      },
    },
  ];
  for (const value of invalid) {
    assert.throws(() => parseRequestModelWriteDestination(value));
  }
});

Deno.test("a correctly rehashed command cannot mix another admitted source with captured operations or proposal approval", async () => {
  const sourceMismatch = input();
  sourceMismatch.destination = {
    ...sourceMismatch.destination,
    expectedAdmittedSource: {
      ...sourceMismatch.destination.expectedAdmittedSource,
      sourceDigest: "e".repeat(64),
    },
  };
  await assert.rejects(() => buildModelWriteDossierV2(sourceMismatch), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const versionMismatch = input();
  versionMismatch.destination = {
    ...versionMismatch.destination,
    expectedAdmittedSource: {
      ...versionMismatch.destination.expectedAdmittedSource,
      source: { repositoryId: "repo", version: nextBase.version },
    },
  };
  await assert.rejects(() => buildModelWriteDossierV2(versionMismatch), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const expectedMismatch = input();
  expectedMismatch.decision = {
    ...expectedMismatch.decision,
    expectedVersion: `commit:${"2".repeat(40)}`,
  };
  await assert.rejects(() => buildModelWriteDossierV2(expectedMismatch), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const missingExpected = input();
  const { expectedVersion: _expected, ...withoutExpected } =
    missingExpected.decision;
  missingExpected.decision = withoutExpected;
  await assert.rejects(() => buildModelWriteDossierV2(missingExpected), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
});

Deno.test("dossier mutation and unknown version/fields refuse before any future worker may use them", async () => {
  const dossier = await buildModelWriteDossierV2(input());
  await assert.rejects(
    () =>
      parseModelWriteDossierV2({
        ...dossier,
        command: {
          ...dossier.command,
          destination: { ...destination(), caseId: "sibling" },
        },
      }),
    { code: "WRITE_DOSSIER_MISMATCH" },
  );
  await assert.rejects(
    () =>
      parseVersionedModelWriteDossier({
        ...dossier,
        rawRef: "refs/heads/admitted",
      }),
    { code: "WRITE_COMMAND_INVALID" },
  );
  for (const v of [0, 3, "2", null]) {
    assert.throws(() =>
      parseVersionedModelWriteCommand({ ...dossier.command, v })
    );
  }
  assert.throws(
    () => parseModelWriteCommandV2({ ...dossier.command, authority: {} }),
    { code: "WRITE_COMMAND_INVALID" },
  );
  assert.throws(
    () =>
      parseModelWriteCommandV2({
        ...dossier.command,
        kind: "retain-artifact-source",
      }),
    { code: "WRITE_COMMAND_INVALID" },
  );
});

Deno.test("builder and durable decoder snapshot inputs before asynchronous digest validation", async () => {
  const draft = input();
  const building = buildModelWriteDossierV2(draft);
  Object.assign(draft.operations.files.files[0], { text: "package Tampered;" });
  draft.destination = { ...draft.destination, caseId: "sibling" };
  const dossier = await building;
  assert.equal(dossier.command.destination.caseId, "case-a");
  assert.equal(
    dossier.operations.kind === "whole-files" &&
      dossier.operations.files.files[0].text,
    "package Changed;",
  );
  const wire = structuredClone(dossier);
  const decoding = parseVersionedModelWriteDossier(wire);
  Object.assign(wire.command.destination, { caseId: "sibling" });
  assert.deepStrictEqual(await decoding, dossier);
});

// Controlled captured facts, not credential issuance or current source authority.
function recordedAuthority(
  action: AuthorityExercise["action"],
): AuthorityExercise {
  return {
    authoritySchema: 2,
    action,
    baseModelDigest: "e".repeat(64),
    outOfMandate: false,
    ownerSource: "modeled",
    systemId: "Assembly::Primary",
    operatorId: "owner",
    operatorNativeId: "owner-native",
    mandateId: "mandate",
    mandateNativeId: "mandate-native",
    mandateRevision: 1,
    rootAuthorityId: "root",
    rootAuthorityNativeId: "root-native",
    rootGrantId: "grant",
    rootGrantNativeId: "grant-native",
    sourceIds: ["owner-native"],
  };
}
function capturedJournal() {
  return buildOperationJournal({
    base: structuredClone(legacy.command.approvedBase),
    baseSourceDigest: "a".repeat(64),
    edits: [{
      op: "setFeatureValue",
      format: 1,
      target: {
        id: "instruction",
        qualifiedName: "Sys::instruction",
        metaclass: "AttributeUsage",
        preimage: "b".repeat(64),
      },
      value: "Explain source changes",
    }],
  });
}
function approvedChangePin() {
  return {
    digest: "e".repeat(64),
    repositoryVersion: legacy.command.approvedBase.version,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  } satisfies ExecutableModelVersion;
}
function approvedChangeInput() {
  const pin = approvedChangePin();
  const change: PendingChange = {
    id: "change-1",
    kind: "mandate-change",
    status: "approved",
    baseRevision: 0,
    baseModelDigest: pin.digest,
    requestedAt: "2026-10-30T01:00:00.000Z",
    decidedAt: "2026-10-30T01:01:00.000Z",
    reason: "Recorded bounded change",
    authorityExercise: recordedAuthority("mandate-change"),
    diff: {
      title: "Recorded diff",
      author: "owner",
      base: {
        repositoryVersion: pin.repositoryVersion,
        modelDigest: pin.digest,
        sourceDigest: "a".repeat(64),
      },
      sourceDigest: "c".repeat(64),
      files: [{
        path: "models/configuration.sysml",
        kind: "changed",
        additions: 1,
        deletions: 1,
      }],
      patch: "recorded diff",
      additions: 1,
      deletions: 1,
    },
  };
  return {
    repositoryId: "repo",
    commandId: change.id,
    kind: "approved-change" as const,
    destination: destination(),
    authority: sourceAuthority(),
    operations: { kind: "host-edits" as const, journal: capturedJournal() },
    decision: {
      kind: "approved-change" as const,
      change,
      approval: changePublication(change, pin),
    },
    recipeDigest: legacy.command.recipeDigest,
  };
}
function activationInput() {
  const approval: CandidateActivationPublication = {
    type: "candidate-activation",
    changeId: "activation-1",
    systemId: "Assembly::Primary",
    builderId: "operator",
    candidateId: "candidate-1",
    candidateDigest: "f".repeat(64),
    baseModelDigest: "e".repeat(64),
    baseRevision: 0,
    adoptedPin: {
      digest: "e".repeat(64),
      repositoryVersion: legacy.command.approvedBase.version,
    },
    decidedAt: "2026-10-30T01:01:00.000Z",
    edits: [],
    admission: {
      candidateId: "candidate-1",
      candidateDigest: "f".repeat(64),
      mandateRevision: 1,
      authority: "human",
      actorId: "owner",
      configurationRevision: 0,
      reason: "Recorded admission",
      at: "2026-10-30T01:01:00.000Z",
      authorityExercise: recordedAuthority("candidate-admission"),
    },
  };
  return {
    repositoryId: "repo",
    commandId: approval.changeId,
    kind: "activate-candidate" as const,
    destination: destination(),
    authority: sourceAuthority(),
    operations: { kind: "host-edits" as const, journal: capturedJournal() },
    decision: { kind: "activate-candidate" as const, approval },
    recipeDigest: legacy.command.recipeDigest,
  };
}

Deno.test("approved-change v2 rejects coherently rehashed source/base/pin contradictions and missing captured evidence", async () => {
  const valid = await buildModelWriteDossierV2(approvedChangeInput());
  assert.deepStrictEqual(await parseModelWriteDossierV2(valid), valid);
  const otherBase = approvedChangeInput();
  const next = structuredClone(nextBase);
  otherBase.destination = {
    ...otherBase.destination,
    expectedAdmittedSource: {
      ...otherBase.destination.expectedAdmittedSource,
      source: next,
    },
  };
  otherBase.operations = {
    kind: "host-edits",
    journal: { ...otherBase.operations.journal, base: next },
  };
  // Builder computes every new digest; the old recorded approval still names A.
  await assert.rejects(() => buildModelWriteDossierV2(otherBase), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const otherSource = approvedChangeInput();
  otherSource.destination = {
    ...otherSource.destination,
    expectedAdmittedSource: {
      ...otherSource.destination.expectedAdmittedSource,
      sourceDigest: "9".repeat(64),
    },
  };
  otherSource.operations = {
    kind: "host-edits",
    journal: {
      ...otherSource.operations.journal,
      baseSourceDigest: "9".repeat(64),
    },
  };
  await assert.rejects(() => buildModelWriteDossierV2(otherSource), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const otherPin = approvedChangeInput();
  otherPin.decision.change.baseModelDigest = "f".repeat(64);
  await assert.rejects(() => buildModelWriteDossierV2(otherPin), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const noPin = approvedChangeInput();
  delete noPin.decision.approval.adoptedPin.repositoryVersion;
  await assert.rejects(() => buildModelWriteDossierV2(noPin), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const noSource = approvedChangeInput();
  delete noSource.decision.approval.approvedSourceBase;
  await assert.rejects(() => buildModelWriteDossierV2(noSource), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const changedProposal = approvedChangeInput();
  changedProposal.decision.change.reason = "Another proposal with reused IDs";
  await assert.rejects(() => buildModelWriteDossierV2(changedProposal), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const filled = approvedChangeInput();
  filled.decision.approval.edits = [filled.operations.journal.entries[0].edit];
  await assert.rejects(() => buildModelWriteDossierV2(filled), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
});

Deno.test("activate-candidate v2 requires exact captured journal/pin and original empty approval edits after rehash", async () => {
  const valid = await buildModelWriteDossierV2(activationInput());
  assert.deepStrictEqual(await parseModelWriteDossierV2(valid), valid);
  const otherBase = activationInput();
  const next = structuredClone(nextBase);
  otherBase.destination = {
    ...otherBase.destination,
    expectedAdmittedSource: {
      ...otherBase.destination.expectedAdmittedSource,
      source: next,
    },
  };
  otherBase.operations = {
    kind: "host-edits",
    journal: { ...otherBase.operations.journal, base: next },
  };
  await assert.rejects(() => buildModelWriteDossierV2(otherBase), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const noPin = activationInput();
  delete noPin.decision.approval.adoptedPin.repositoryVersion;
  await assert.rejects(() => buildModelWriteDossierV2(noPin), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const differentModel = activationInput();
  differentModel.decision.approval.adoptedPin.digest = "f".repeat(64);
  await assert.rejects(() => buildModelWriteDossierV2(differentModel), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const filled = activationInput();
  filled.decision.approval.edits = [filled.operations.journal.entries[0].edit];
  await assert.rejects(() => buildModelWriteDossierV2(filled), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
});

Deno.test("direct v2 parser returns its own validated snapshot and exposes no async assertion on mutable aliases", async () => {
  assert.equal("assertModelWriteDossierV2" in v2Api, false);
  const accepted = await buildModelWriteDossierV2(approvedChangeInput());
  const alias = structuredClone(accepted);
  const decoding = parseModelWriteDossierV2(alias);
  Object.assign(alias.command.destination, { caseId: "sibling" });
  Object.assign(alias.decision, {
    kind: "accept-proposal",
    proposalId: "foreign",
  });
  const validated = await decoding;
  assert.deepStrictEqual(validated, accepted);
  assert.notStrictEqual(validated, alias);
  assert.notStrictEqual(
    validated.command.destination,
    alias.command.destination,
  );
  const invalid = structuredClone(accepted);
  Object.assign(invalid.command.destination, { caseId: "sibling" });
  const failing = parseModelWriteDossierV2(invalid);
  // Repairing the caller alias during a digest await cannot repair its snapshot.
  Object.assign(invalid.command.destination, accepted.command.destination);
  await assert.rejects(() => failing, { code: "WRITE_DOSSIER_MISMATCH" });
  assert.deepStrictEqual(await parseModelWriteDossierV2(accepted), accepted);
});

Deno.test("v2 command anchor binds both independent source owner decisions while v1 remains unchanged", async () => {
  const dossier = await buildModelWriteDossierV2(input());
  assert.equal(
    dossier.command.authorityRef.digest,
    await requestSourceOwnerAuthorityDigest(
      dossier.authority as RequestSourceOwnerAuthorityEnvelope,
    ),
  );
  const changed = input();
  changed.authority.acceptance.principal.controller.sessionId =
    "later-acceptance-session";
  const other = await buildModelWriteDossierV2(changed);
  assert.notEqual(other.command.intentDigest, dossier.command.intentDigest);
  assert.notEqual(
    await modelWriteCommandDigestV2(other.command),
    await modelWriteCommandDigestV2(dossier.command),
  );
  const omitted = { ...dossier } as Record<string, unknown>;
  delete omitted.authority;
  await assert.rejects(() => parseModelWriteDossierV2(omitted));
  const tampered = mutableTestSnapshot(dossier);
  (tampered.authority as unknown as { proposal: { capturedAt: string } })
    .proposal.capturedAt = "2026-10-30T00:59:00.000Z";
  await assert.rejects(() => parseModelWriteDossierV2(tampered), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const substituted = structuredClone(dossier);
  Object.assign(substituted.authority, {
    acceptance:
      (substituted.authority as RequestSourceOwnerAuthorityEnvelope).proposal,
  });
  await assert.rejects(() => parseModelWriteDossierV2(substituted), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const absent = mutableTestSnapshot(dossier);
  if (absent.decision.kind !== "accept-proposal") throw new Error("fixture");
  delete absent.decision.decisionAuthorityExercise;
  await assert.rejects(() => parseModelWriteDossierV2(absent), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
});

Deno.test("the Request approved-change route additionally requires a closed human Case network decision, not a supported kind alone", async () => {
  const unsupported = await buildModelWriteDossierV2(approvedChangeInput());
  assert.throws(() => assertRequestChangeDossier(unsupported), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  function networkInput() {
    const input = approvedChangeInput(), change = input.decision.change;
    Object.assign(change, {
      caseId: input.destination.caseId,
      requestedBy: input.authority.acceptance.priorModel.identity.builderId,
      authority: "human",
      requestedRights: { addNetworkHosts: ["docs.example.org"] },
    });
    input.decision.approval = changePublication(
      change,
      {
        ...approvedChangePin(),
        ...input.authority.acceptance.priorModel.version,
      },
    );
    return input;
  }
  const input = networkInput(), valid = await buildModelWriteDossierV2(input);
  // This is payload/route evidence only. Git still verifies the actual delta and exact native preimages.
  assertRequestChangeDossier(valid);
  assert.equal(valid.command.commandId, input.decision.change.id);
  assert.deepStrictEqual(await parseModelWriteDossierV2(valid), valid);
  const changed = networkInput();
  changed.decision.change.authority = "builder";
  changed.decision.approval = changePublication(
    changed.decision.change,
    {
      ...approvedChangePin(),
      ...changed.authority.acceptance.priorModel.version,
    },
  );
  const builder = await buildModelWriteDossierV2(changed);
  assert.throws(() => assertRequestChangeDossier(builder), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const foreign = networkInput();
  foreign.decision.change.caseId = "sibling";
  foreign.decision.approval = changePublication(
    foreign.decision.change,
    {
      ...approvedChangePin(),
      ...foreign.authority.acceptance.priorModel.version,
    },
  );
  const otherCase = await buildModelWriteDossierV2(foreign);
  assert.throws(() => assertRequestChangeDossier(otherCase), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
});

Deno.test("4.8c C9: a delegated Case network decision is its own authority kind, never a human one", async () => {
  const input = approvedChangeInput(), change = input.decision.change;
  const human = input.authority as RequestSourceOwnerAuthorityEnvelope;
  const prior = human.acceptance.priorModel, destination = input.destination;
  const decider = {
    projectId: prior.identity.projectId,
    systemId: prior.identity.systemId,
    executionSpaceId: "main",
    operatorId: prior.identity.builderId,
  };
  const requester = {
    ...decider,
    executionSpaceId: destination.executionSpaceId,
  };
  const policy = {
    id: "bo-network",
    revision: 1,
    elementId: "bo-network-native",
    space: { ...decider, operatorId: undefined },
  };
  delete (policy.space as { operatorId?: string }).operatorId;
  const owner = human.acceptance.principal.priorOwner;
  Object.assign(change, {
    caseId: destination.caseId,
    requestedBy: prior.identity.builderId,
    authority: "builder",
    requestedRights: { addNetworkHosts: ["docs.example.org"] },
    authorityExercise: {
      ...owner,
      authoritySchema: 2,
      action: "mandate-change",
      baseModelDigest: prior.version.digest,
      outOfMandate: false,
      delegation: {
        actorId: decider.operatorId,
        actor: decider,
        requester,
        policyId: policy.id,
        policyRevision: policy.revision,
        policyElementId: policy.elementId,
        policyIssuer: owner,
        requestedBy: prior.identity.builderId,
        changeId: change.id,
        caseId: destination.caseId,
        requestedRights: { addNetworkHosts: ["docs.example.org"] },
      },
    },
  });
  input.decision.approval = changePublication(change, {
    ...approvedChangePin(),
    ...prior.version,
  });
  const delegated = {
    v: 1,
    kind: "request-delegated-authority",
    destination,
    priorModel: prior,
    decider,
    requester,
    policy,
    route: {
      version: 2,
      changeId: change.id,
      caseId: destination.caseId,
      requestedBy: prior.identity.builderId,
      requester,
      openingId: destination.openingId,
      targetOperatorId: prior.identity.builderId,
      baseRevision: change.baseRevision,
      modelDigest: prior.version.digest,
      status: "actor-decision",
      designatedDecider: {
        operatorId: decider.operatorId,
        executionSpaceId: "main",
        policyId: policy.id,
        policyRevision: policy.revision,
      },
      trace: [],
    },
    origin: { effectKey: "mo-effect", inputMessageId: "notice" },
    exercise: change.authorityExercise,
    capturedAt: "2026-10-31T00:00:00.000Z",
  };
  const dossier = await buildModelWriteDossierV2({
    ...input,
    authority: delegated as never,
  });
  assert.equal(
    dossier.command.authorityRef.kind,
    "request-delegated-authority",
  );
  assertRequestChangeDossier(dossier);
  assert.deepStrictEqual(await parseModelWriteDossierV2(dossier), dossier);
  // The kind discriminates first: a delegated reference never names a human
  // proof, and a delegated change never rides the human branch.
  const relabelled = mutableTestSnapshot(dossier);
  (relabelled.command.authorityRef as { kind: string }).kind =
    "request-source-owner-authority";
  await assert.rejects(() => parseModelWriteDossierV2(relabelled), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const underHuman = await buildModelWriteDossierV2({
    ...input,
    authority: human,
  });
  assert.throws(() => assertRequestChangeDossier(underHuman), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
  const otherPolicy = structuredClone(delegated);
  otherPolicy.exercise = {
    ...otherPolicy.exercise!,
    delegation: { ...otherPolicy.exercise!.delegation!, policyRevision: 2 },
  };
  await assert.rejects(() =>
    buildModelWriteDossierV2({ ...input, authority: otherPolicy as never })
  );
  // A member can retain R while another operator advances shared source A.
  // The host's own authority still pins R; only the displayed diff/journal
  // and destination move to the independently verified admitted A.
  const advanced = parseModelRevisionRef({
    repositoryId: input.repositoryId,
    version: `commit:${"9".repeat(40)}`,
  });
  const advancedTarget = {
    ...destination,
    expectedAdmittedSource: {
      ...destination.expectedAdmittedSource,
      source: advanced,
    },
  };
  const advancedChange = {
    ...change,
    diff: {
      ...change.diff!,
      base: { ...change.diff!.base, repositoryVersion: advanced.version },
    },
  };
  const independentPins = {
    ...input,
    destination: advancedTarget,
    authority: { ...delegated, destination: advancedTarget } as never,
    operations: {
      kind: "host-edits" as const,
      journal: { ...input.operations.journal, base: advanced },
    },
    decision: {
      kind: "approved-change" as const,
      change: advancedChange,
      approval: changePublication(advancedChange, {
        ...approvedChangePin(),
        ...prior.version,
      }),
    },
  };
  await assert.rejects(() => buildModelWriteDossierV2(independentPins));
  const memberRequester = {
    ...requester,
    operatorId: "member",
    systemId: "member-system",
  };
  const memberPrior = {
    ...prior,
    identity: {
      ...prior.identity,
      builderId: "member",
      systemId: "member-system",
    },
    operatorTeam: {
      parentOperatorId: prior.identity.builderId,
      requestOwnerId: prior.identity.builderId,
      requestId: destination.caseId,
    },
  };
  Object.assign(independentPins.authority as object, {
    priorModel: memberPrior,
    requester: memberRequester,
    route: {
      ...delegated.route,
      requester: memberRequester,
      requestedBy: "member",
      targetOperatorId: "member",
    },
    exercise: {
      ...change.authorityExercise!,
      delegation: {
        ...change.authorityExercise!.delegation!,
        requester: memberRequester,
        requestedBy: "member",
      },
    },
  });
  independentPins.decision.change.requestedBy = "member";
  independentPins.decision.change.authorityExercise =
    (independentPins.authority as typeof delegated).exercise;
  independentPins.decision.approval = changePublication(
    independentPins.decision.change,
    {
      ...approvedChangePin(),
      ...prior.version,
    },
  );
  const independent = await buildModelWriteDossierV2(independentPins);
  assertRequestChangeDossier(independent);
  assert.deepStrictEqual(
    await parseModelWriteDossierV2(independent),
    independent,
  );
  assert.equal(independent.command.approvedBase.version, advanced.version);
  assert.equal(
    independent.decision.kind === "approved-change" &&
      independent.decision.approval.adoptedPin.repositoryVersion,
    prior.version.repositoryVersion,
  );
  const wrongExecution = {
    ...independentPins,
    decision: {
      ...independentPins.decision,
      approval: {
        ...independentPins.decision.approval,
        adoptedPin: {
          ...independentPins.decision.approval.adoptedPin,
          repositoryVersion: advanced.version,
        },
      },
    },
  };
  await assert.rejects(() => buildModelWriteDossierV2(wrongExecution), {
    code: "WRITE_DOSSIER_MISMATCH",
  });
});
