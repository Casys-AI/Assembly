import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  parseRequestDelegatedAuthority,
  requestWriteAuthorityDigest,
} from "./request-delegated-authority.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { requestNetworkSourceAdmissionFixture } from "../../../../test/support/request-network-source-admission-fixture.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import { changePublication } from "../../../domain/model/publication/change.ts";
import {
  buildModelWriteDossierV2,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
  modelWriteIntentDigestV2,
} from "../publication/write-command-v2.ts";
import {
  parseRequestSourceAdmission,
  requestNetworkAdmissionEvidence,
} from "./request-source-admission.ts";

Deno.test("network source receipts preserve v1 framing but require the exact real approved-change dossier", async () => {
  const { dossier, receipt, change, model } =
    await requestNetworkSourceAdmissionFixture();
  const before = structuredClone({ dossier, receipt });
  const evidence = await requestNetworkAdmissionEvidence(
    receipt.payload,
    dossier,
  );
  equal(evidence.dossier.command.kind, "approved-change");
  equal(evidence.dossier.decision.change.id, change.id);
  equal(evidence.proposalIntentDigest.length, 64);
  equal(evidence.approvedChangeDigest.length, 64);
  deepStrictEqual({ dossier, receipt }, before);
  const mutable = structuredClone(dossier);
  const pending = requestNetworkAdmissionEvidence(receipt.payload, mutable);
  if (mutable.decision.kind !== "approved-change") {
    throw new Error("Fixture kind differs");
  }
  mutable.decision.change.diff!.patch =
    "changed after the reader owned its snapshot";
  deepStrictEqual((await pending).dossier, dossier);
  await rejects(() =>
    requestNetworkAdmissionEvidence(receipt.payload, {
      ...dossier,
      command: { ...dossier.command, kind: "accept-proposal" },
    })
  );
  await rejects(() =>
    requestNetworkAdmissionEvidence({
      ...receipt.payload,
      dossierDigest: "0".repeat(64),
    }, dossier)
  );
  for (
    const kind of ["activate-candidate", "retain-artifact-source", "unknown"]
  ) {
    await rejects(() =>
      parseRequestSourceAdmission({
        ...receipt.payload,
        command: { ...receipt.payload.command, kind },
      })
    );
  }
  // Rebuild ordinary command, approval and envelope digests. Coherent broader
  // rights/foreign origins must still fail the independent network route gate.
  for (
    const otherChange of [
      {
        ...change,
        requestedRights: { setUrlSelectionMode: "authorized-host" as const },
      },
      { ...change, requestedBy: "foreign-operator" },
      { ...change, caseId: "foreign-case" },
    ] satisfies PendingChange[]
  ) {
    const broader = await buildModelWriteDossierV2({
      repositoryId: dossier.command.repositoryId,
      commandId: dossier.command.commandId,
      kind: "approved-change",
      destination: dossier.command.destination,
      authority: dossier.authority,
      operations: dossier.operations,
      decision: {
        kind: "approved-change",
        change: otherChange,
        approval: changePublication(otherChange, model.version),
      },
      recipeDigest: dossier.command.recipeDigest,
    });
    const changedReceipt = await parseRequestSourceAdmission({
      ...receipt.payload,
      command: broader.command,
      commandDigest: await modelWriteCommandDigestV2(broader.command),
      dossierDigest: await modelWriteDossierDigestV2(broader),
      decisionDigest: broader.command.decisionRef.digest,
    });
    await rejects(() =>
      requestNetworkAdmissionEvidence(changedReceipt, broader)
    );
  }
});

Deno.test("sessionless source receipt preserves the requester's executed R while its exact publication base is admitted A", async () => {
  const f = await requestNetworkSourceAdmissionFixture();
  const human = f.receipt.payload.authority;
  if (human.kind !== "request-source-owner-authority") {
    throw new Error("Human fixture required");
  }
  const prior = {
    ...structuredClone(human.acceptance.priorModel),
    identity: {
      ...human.acceptance.priorModel.identity,
      builderId: "member",
      systemId: "member-system",
    },
    operatorTeam: {
      parentOperatorId: human.acceptance.priorModel.identity.builderId,
      requestOwnerId: human.acceptance.priorModel.identity.builderId,
      requestId: f.dossier.command.destination.caseId,
    },
    version: {
      ...human.acceptance.priorModel.version,
      repositoryVersion: parseModelRevisionRef({
        repositoryId: f.dossier.command.repositoryId,
        version: `commit:${"9".repeat(40)}`,
      }).version,
    },
  };
  const destination = f.dossier.command.destination;
  const decider = {
    projectId: prior.identity.projectId,
    systemId: prior.identity.systemId,
    executionSpaceId: "main",
    operatorId: "decider",
  };
  const requester = {
    ...decider,
    executionSpaceId: destination.executionSpaceId,
    operatorId: prior.identity.builderId,
  };
  const policy = {
    id: "member-network",
    revision: 1,
    elementId: "member-network-native",
    space: {
      projectId: decider.projectId,
      systemId: decider.systemId,
      executionSpaceId: "main",
    },
  };
  const change = structuredClone(f.change);
  change.requestedBy = "member";
  change.authority = "builder";
  change.authorityExercise = {
    ...human.acceptance.principal.priorOwner,
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
      policyIssuer: human.acceptance.principal.priorOwner,
      requestedBy: requester.operatorId,
      changeId: change.id,
      caseId: destination.caseId,
      requestedRights: { addNetworkHosts: ["docs.example.org"] },
    },
  };
  const authority = parseRequestDelegatedAuthority({
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
      requestedBy: requester.operatorId,
      requester,
      openingId: destination.openingId,
      targetOperatorId: requester.operatorId,
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
    origin: { effectKey: "member-decision", inputMessageId: "notice" },
    exercise: change.authorityExercise,
    capturedAt: "2026-11-02T00:00:00.000Z",
  });
  const dossier = await buildModelWriteDossierV2({
    repositoryId: f.dossier.command.repositoryId,
    commandId: change.id,
    kind: "approved-change",
    destination,
    authority,
    operations: f.dossier.operations,
    decision: {
      kind: "approved-change",
      change,
      approval: changePublication(change, {
        ...f.model.version,
        ...prior.version,
      }),
    },
    recipeDigest: f.dossier.command.recipeDigest,
  });
  const receipt = await parseRequestSourceAdmission({
    ...f.receipt.payload,
    result: {
      ...f.receipt.payload.result,
      model: { ...f.receipt.payload.result.model, identity: prior.identity },
    },
    command: dossier.command,
    commandDigest: await modelWriteCommandDigestV2(dossier.command),
    dossierDigest: await modelWriteDossierDigestV2(dossier),
    decisionDigest: dossier.command.decisionRef.digest,
    authority,
    authorityDigest: await requestWriteAuthorityDigest(authority),
  });
  equal(
    receipt.predecessor.source.version,
    destination.expectedAdmittedSource.source.version,
  );
  equal(receipt.authority.kind, "request-delegated-authority");
  const noMemberProof = structuredClone(authority);
  delete (noMemberProof.priorModel as { operatorTeam?: unknown }).operatorTeam;
  const authorityDigest = await requestWriteAuthorityDigest(noMemberProof);
  const { v: _version, intentDigest: _intentDigest, ...body } = dossier.command;
  const commandBody = {
    ...body,
    authorityRef: { ...body.authorityRef, digest: authorityDigest },
  };
  const command = {
    v: 2 as const,
    ...commandBody,
    intentDigest: await modelWriteIntentDigestV2(commandBody),
  };
  const commandDigest = await modelWriteCommandDigestV2(command);
  await rejects(() =>
    parseRequestSourceAdmission({
      ...receipt,
      command,
      commandDigest,
      authority: noMemberProof,
      authorityDigest,
    }), { code: "UNAVAILABLE" });
  deepStrictEqual(
    (await requestNetworkAdmissionEvidence(receipt, dossier)).dossier,
    dossier,
  );
  await rejects(() =>
    requestNetworkAdmissionEvidence({
      ...receipt,
      predecessor: {
        ...receipt.predecessor,
        source: {
          ...receipt.predecessor.source,
          version: prior.version.repositoryVersion,
        },
      },
    }, dossier)
  );
});
