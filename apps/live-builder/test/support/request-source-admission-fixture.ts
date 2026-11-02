/** Synthetic integrity fixture: no credential, Git anchor or publication is real. */
import type { ModelIdentity } from "../../src/domain/work/dialogue.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { sha256 } from "../../src/domain/primitives/execution-digest.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import {
  parseRequestSourceOwnerAuthority,
  requestSourceOwnerAuthorityDigest,
} from "../../src/application/model/source-admission/request-source-owner.ts";
import {
  modelWriteCommandDigestV2,
  type ModelWriteCommandV2,
  modelWriteIntentDigestV2,
} from "../../src/application/model/publication/write-command-v2.ts";
import {
  requestSourceAdmissionRef,
  requestSourceCommandRef,
} from "../../src/domain/model/editing/request-source-publication.ts";
import {
  buildDescriptor,
  buildKey,
  recipeDigest,
} from "../../src/domain/model/value-objects/build.ts";
import { parseModelRevisionRef } from "../../src/domain/model/value-objects/element-ref.ts";
import { parseRequestSourceAdmission } from "../../src/application/model/source-admission/request-source-admission.ts";
import type { OpeningRecord } from "../../src/domain/work/request-spaces.ts";
import type { AdmittedSourceHead } from "../../src/adapters/out/postgres/request-source-admission-store.ts";
import {
  requestControlModel,
  spaceControlAuthority,
} from "./request-space-fixture.ts";

export async function admissionFixture(
  opening: OpeningRecord,
  predecessor: AdmittedSourceHead,
  id: string,
  next: string,
  priorModelDigest = predecessor.sourceDigest,
  identityPatch: Partial<
    Pick<ModelIdentity, "systemId" | "systemQualifiedName">
  > = {},
) {
  const model = requestControlModel();
  const baselineOwner = opening.base!.manifest.operators.find((operator) =>
    operator.operatorId === opening.base!.requestOwner.operatorId
  );
  if (baselineOwner?.systemQualifiedName !== undefined) {
    model.identity.systemQualifiedName = baselineOwner.systemQualifiedName;
  }
  // Optional contradictory identity is used only by coherent integrity negatives:
  // all principal/exercise/model and command hashes still describe that claim.
  Object.assign(model.identity, identityPatch);
  model.ownerAuthority = {
    ...model.ownerAuthority!,
    systemId: model.identity.systemId,
  };
  model.identity.projectId = `git:${predecessor.source.repositoryId}`;
  model.version.digest = priorModelDigest;
  model.version.repositoryVersion =
    parseModelRevisionRef(predecessor.source).version;
  const destination = {
    v: 1 as const,
    kind: "request" as const,
    repositoryId: predecessor.source.repositoryId,
    host: structuredClone(opening.scope),
    openingId: opening.id,
    executionSpaceId: opening.executionSpaceId,
    caseId: opening.caseId,
    branchId: opening.branchId,
    ref: `refs/heads/requests/${opening.branchId}`,
    expectedAdmittedSource: {
      revision: predecessor.revision,
      source: parseModelRevisionRef(predecessor.source),
      sourceDigest: predecessor.sourceDigest,
    },
  };
  const control = spaceControlAuthority();
  const controller = {
    ownerId: opening.ownerId,
    capabilityId: "capability",
    capabilityRevision: 0,
    sessionId: "session",
    authority: {
      ...control,
      sourceSystemNativeId: model.identity.systemId,
      owner: { ...control.owner, systemId: model.identity.systemId },
    },
  };
  const principal = {
    v: 1 as const,
    kind: "request-source-owner" as const,
    controller,
    sessionRevision: 0,
    priorOwner: model.ownerAuthority!,
  };
  const phase = <P extends "proposal" | "acceptance">(name: P) => ({
    v: 1 as const,
    phase: name,
    destination,
    priorModel: {
      identity: model.identity,
      version: {
        digest: model.version.digest,
        repositoryVersion: parseModelRevisionRef(predecessor.source).version,
      },
    },
    principal,
    exercise: exerciseOwnerAuthority(model, "model-revision"),
    capturedAt: "2026-10-30T00:00:00.000Z",
  });
  const authority = parseRequestSourceOwnerAuthority({
    v: 1,
    kind: "request-source-owner-authority",
    proposal: phase("proposal"),
    acceptance: phase("acceptance"),
  });
  const authorityDigest = await requestSourceOwnerAuthorityDigest(authority);
  const recipe = {
    toolkit: { version: "fixture", bundleDigest: "4".repeat(64) },
    format: "fixture",
    normalizerVersion: 1,
    irVersion: "1",
    artifactSchema: 1,
    engineVersion: "fixture",
  };
  const recipeId = await recipeDigest(recipe);
  const intent = {
    repositoryId: predecessor.source.repositoryId,
    commandId: id,
    kind: "accept-proposal" as const,
    approvedBase: parseModelRevisionRef(predecessor.source),
    operationsRef: { digest: "1".repeat(64) },
    decisionRef: { id, digest: "2".repeat(64) },
    recipeDigest: recipeId,
    destination,
    authorityRef: {
      kind: "request-source-owner-authority" as const,
      digest: authorityDigest,
    },
  };
  const command: ModelWriteCommandV2 = {
    v: 2,
    ...intent,
    intentDigest: await modelWriteIntentDigestV2(intent),
  };
  const source = parseModelRevisionRef({
    repositoryId: predecessor.source.repositoryId,
    version: `commit:${next.repeat(40)}`,
  });
  const build = buildDescriptor({
    repositoryId: source.repositoryId,
    sourceDigest: next.repeat(64),
    recipe,
    recipeDigest: recipeId,
    buildKey: await buildKey(next.repeat(64), recipeId),
    artifactDigest: "7".repeat(64),
    bytes: 1,
  });
  return await parseRequestSourceAdmission({
    format: "request-source-admission/v1",
    destination,
    openingBaseDigest: opening.baseDigest,
    predecessor,
    result: {
      source,
      sourceDigest: next.repeat(64),
      build,
      buildDigest: await sha256(canonical(build)),
      model: {
        identity: model.identity,
        digest: (next === "f" ? "9" : "8").repeat(64),
      },
    },
    command,
    commandDigest: await modelWriteCommandDigestV2(command),
    dossierDigest: "9".repeat(64),
    decisionDigest: command.decisionRef.digest,
    authority,
    authorityDigest,
    publication: {
      repositoryId: command.repositoryId,
      commandId: id,
      commandRef: requestSourceCommandRef(id),
      publicationRef: requestSourceAdmissionRef(id, source.version),
      commit: source.version,
      receiptDigest: "a".repeat(64),
    },
  });
}
