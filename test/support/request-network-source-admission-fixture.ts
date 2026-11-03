/** Synthetic source/decision integrity fixture; no Git publication or human
 * authentication is claimed. Uses the real command/approval builders. */
import type { RequestSourceOwnerAuthorityEnvelope } from "../../src/application/model/source-admission/request-source-owner.ts";
import { requestReleaseFixture } from "./request-release-fixture.ts";
import { admissionFixture } from "./request-source-admission-fixture.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { buildOperationJournal } from "../../src/domain/model/editing/write-command.ts";
import { buildApprovedChangeCommand } from "../../src/application/model/publication/write-queue.ts";
import {
  buildModelWriteDossierV2,
  modelWriteCommandDigestV2,
  modelWriteDossierDigestV2,
} from "../../src/application/model/publication/write-command-v2.ts";
import {
  parseRequestSourceAdmission,
  requestSourceAdmissionDigest,
} from "../../src/application/model/source-admission/request-source-admission.ts";

export async function requestNetworkSourceAdmissionFixture() {
  const fixture = await requestReleaseFixture();
  const opening = fixture.record;
  const predecessor = {
    revision: 1,
    manifestDigest: opening.base!.manifestDigest,
    source: {
      repositoryId: fixture.source.repositoryId,
      version: fixture.source.sourceVersion,
    },
    sourceDigest: fixture.source.sourceDigest,
  };
  const skeleton = await admissionFixture(
    opening,
    predecessor,
    "11111111-1111-4111-8111-111111111999",
    "d",
    fixture.model.version.digest,
  );
  const model = structuredClone(fixture.model);
  const human = skeleton.authority as RequestSourceOwnerAuthorityEnvelope;
  model.identity = structuredClone(
    human.acceptance.priorModel.identity,
  );
  model.version = {
    ...model.version,
    ...human.acceptance.priorModel.version,
    authoritySchema: 2,
  };
  model.ownerAuthority = structuredClone(
    human.acceptance.principal.priorOwner,
  );
  const change: PendingChange = {
    id: skeleton.command.commandId,
    kind: "mandate-change",
    status: "approved",
    requestedBy: model.identity.builderId,
    caseId: opening.caseId,
    baseRevision: model.configuration.revision,
    baseModelDigest: model.version.digest,
    reason: "Read the requested exact host",
    requestedAt: "2026-10-30T00:00:00.000Z",
    decidedAt: "2026-10-30T00:01:00.000Z",
    authority: "human",
    authorityExercise: exerciseOwnerAuthority(model, "mandate-change"),
    requestedRights: { addNetworkHosts: ["docs.example.org"] },
    diff: {
      title: "Read the requested exact host",
      author: model.identity.builderId,
      base: {
        repositoryVersion: predecessor.source.version,
        modelDigest: model.version.digest,
        sourceDigest: predecessor.sourceDigest,
      },
      sourceDigest: skeleton.result.sourceDigest,
      files: [{
        path: "models/configuration.sysml",
        kind: "changed",
        additions: 1,
        deletions: 1,
      }],
      patch: "synthetic exact network diff",
      additions: 1,
      deletions: 1,
    },
  };
  const legacy = await buildApprovedChangeCommand({
    repositoryId: skeleton.command.repositoryId,
    change,
    pin: model.version,
    journal: buildOperationJournal({
      base: skeleton.command.approvedBase,
      baseSourceDigest: predecessor.sourceDigest,
      edits: [{
        op: "setFeatureValue",
        target: {
          id: "network",
          qualifiedName: "Fixture::networkHosts",
          metaclass: "AttributeUsage",
          preimage: "b".repeat(64),
        },
        value: '["docs.example.org"]',
        format: 1,
      }],
    }),
    recipeDigest: skeleton.command.recipeDigest,
  });
  if (
    legacy.operations.kind !== "host-edits" ||
    legacy.decision.kind !== "approved-change"
  ) {
    throw new Error(
      "The network fixture requires the actual approved-change host-edit command",
    );
  }
  const dossier = await buildModelWriteDossierV2({
    repositoryId: skeleton.command.repositoryId,
    commandId: change.id,
    kind: "approved-change",
    destination: skeleton.destination,
    authority: skeleton.authority,
    operations: legacy.operations,
    decision: legacy.decision,
    recipeDigest: skeleton.command.recipeDigest,
  });
  const payload = await parseRequestSourceAdmission({
    ...skeleton,
    command: dossier.command,
    commandDigest: await modelWriteCommandDigestV2(dossier.command),
    dossierDigest: await modelWriteDossierDigestV2(dossier),
    decisionDigest: dossier.command.decisionRef.digest,
  });
  return {
    ...fixture,
    model,
    dossier,
    change,
    receipt: {
      revision: 2,
      manifestDigest: await requestSourceAdmissionDigest(payload),
      payload,
    },
  };
}
