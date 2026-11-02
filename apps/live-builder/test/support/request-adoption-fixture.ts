import { executableFixture } from "./execution-fixture.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { sha256 } from "../../src/domain/primitives/execution-digest.ts";
import {
  buildKey,
  recipeDigest,
} from "../../src/domain/model/value-objects/build.ts";
import { parseModelRevisionRef } from "../../src/domain/model/value-objects/element-ref.ts";
import type {
  RequestAdoptionIntent,
  RequestHumanAdoptionDecision,
  RequestOwnerAdoptionDossier,
} from "../../src/application/model/evolution/request-adoption-ports.ts";
import { requestInstructionCompatibility } from "../../src/application/model/evolution/request-adoption-invariants.ts";

export async function requestAdoptionFixture() {
  const at = "2026-10-30T00:00:00.000Z", repositoryId = "repository";
  const target = {
    v: 1 as const,
    kind: "request" as const,
    repositoryId,
    host: { projectId: "host-project", systemId: "host-system" },
    openingId: "opening_A",
    executionSpaceId: "space_A",
    caseId: "case_A",
    branchId: "12345678-1234-1234-1234-123456789abc",
    ref: "refs/heads/requests/12345678-1234-1234-1234-123456789abc",
    operatorId: "builder",
  };
  const previous = executableFixture({
    projectId: `git:${repositoryId}`,
    editingContextId: "editing",
    rootId: "root",
    systemId: "native-system",
    catalogId: "catalog",
    builderId: "builder",
  });
  previous.version = {
    ...previous.version,
    digest: "a".repeat(64),
    repositoryVersion: `commit:${"1".repeat(40)}`,
    authoritySchema: 2,
  };
  previous.ownerAuthority = {
    ownerSource: "modeled",
    systemId: "native-system",
    operatorId: "human-owner",
    operatorNativeId: "human-native",
    mandateId: "owner-mandate",
    mandateNativeId: "mandate-native",
    mandateRevision: 1,
    rootAuthorityId: "root-authority",
    rootAuthorityNativeId: "root-native",
    rootGrantId: "root-grant",
    rootGrantNativeId: "grant-native",
    sourceIds: ["owner-native"],
  };
  previous.operator = {
    name: "Builder",
    instruction: "Use the original instruction.",
    primary: false,
    humanInput: true,
  };
  const model = structuredClone(previous);
  model.version.digest = "c".repeat(64);
  model.version.repositoryVersion = `commit:${"2".repeat(40)}`;
  model.operator!.instruction = "Use the newly admitted instruction.";
  const authority = {
    scope: target.host,
    sourceSystemNativeId: previous.identity.systemId,
    sourceVersion: previous.version.repositoryVersion!,
    modelDigest: previous.version.digest,
    owner: previous.ownerAuthority,
    policyId: "space-policy",
    policyRevision: 1,
    operatorIds: [target.operatorId],
    acts: ["open-request" as const, "execute-conversation" as const],
  };
  const decision: RequestHumanAdoptionDecision = {
    kind: "request-human-adoption-decision",
    controller: {
      ownerId: "account-owner",
      capabilityId: "capability",
      capabilityRevision: 1,
      sessionId: "session",
      authority,
    },
    sessionRevision: 1,
    exercise: exerciseOwnerAuthority(previous, "model-adoption"),
    capturedAt: at,
  };
  const source = parseModelRevisionRef({
    repositoryId,
    version: model.version.repositoryVersion,
  });
  const sourceDigest = "d".repeat(64),
    recipeInputs = {
      toolkit: { version: "1", bundleDigest: "e".repeat(64) },
      format: "sysml",
      normalizerVersion: 1,
      irVersion: "1",
      artifactSchema: 1,
      engineVersion: "1",
    };
  const recipe = { ...recipeInputs, digest: await recipeDigest(recipeInputs) };
  const candidate = {
    source,
    sourceDigest,
    sourceAdmission: { revision: 2, manifestDigest: "f".repeat(64) },
    build: {
      v: 1 as const,
      kind: "ase-model-build" as const,
      repositoryId,
      sourceDigest,
      recipe,
      buildKey: await buildKey(sourceDigest, recipe.digest),
      artifactDigest: "9".repeat(64),
      bytes: 10,
    },
    model,
    compatibilityDigest: await requestInstructionCompatibility(previous, model),
  };
  const admission = {
    id: "admission",
    scope: target.host,
    executionSpaceId: target.executionSpaceId,
    openingId: target.openingId,
    ownerId: decision.controller.ownerId,
    capabilityId: decision.controller.capabilityId,
    capabilityRevision: 1,
    baseDigest: "b".repeat(64),
    authority,
    permissions: {
      operatorIds: [target.operatorId],
      acts: ["conversation"] as ["conversation"],
      sourceVersion: previous.version.repositoryVersion!,
      modelDigests: [previous.version.digest],
      resourceIds: [] as [],
    },
    revision: 0,
    status: "active" as const,
    expiresAt: "2026-10-31T00:00:00.000Z",
    createdAt: at,
  };
  const immutable = {
    target,
    openingBaseDigest: admission.baseDigest,
    adoptionKey: "adoption-key",
    previous: {
      pin: {
        source: parseModelRevisionRef({
          repositoryId,
          version: previous.version.repositoryVersion,
        }),
        modelDigest: previous.version.digest,
        sourceAdmission: { revision: 1, manifestDigest: "8".repeat(64) },
        adoption: null,
      },
      identity: previous.identity,
      admission,
    },
    candidate,
    decision,
  };
  const id = `request-adoption:${await sha256(
    canonical({
      host: target.host,
      ownerId: decision.controller.ownerId,
      openingId: target.openingId,
      adoptionKey: immutable.adoptionKey,
    }),
  )}`;
  const intent: RequestAdoptionIntent = {
    ...immutable,
    commandDigest: await sha256(canonical(immutable)),
    accountingDigest: await sha256(
      canonical({ id: `evolution:${repositoryId}:${id}`, agentInvocations: 0 }),
    ),
  };
  const dossier: RequestOwnerAdoptionDossier = {
    v: 2,
    kind: "request-owner-adoption",
    id,
    repositoryId,
    revision: 0,
    status: "prepared",
    createdAt: at,
    updatedAt: at,
    intent,
    blockers: [],
  };
  return { previous, model, target, decision, intent, dossier };
}
