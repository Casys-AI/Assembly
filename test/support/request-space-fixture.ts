import { executableFixture } from "./execution-fixture.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";
import { savedManifest } from "../../src/domain/work/records/saved-systems.ts";
import { type OpeningBase } from "../../src/domain/work/request-spaces/opening.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces/scope.ts";
import {
  type SpaceControlAdoptedState,
  type SpaceControlAuthority,
  type SpaceControlSourceBinding,
} from "../../src/domain/work/request-spaces/space-control.ts";
export const requestSpaceScope = {
  projectId: "space-project",
  systemId: "space-system",
};
export const requestControlBinding: SpaceControlSourceBinding = {
  scope: { ...requestSpaceScope },
  sourceSystemNativeId: "native-conversation-system",
};
export const requestOwnerAuthority = {
  ownerSource: "modeled" as const,
  systemId: requestControlBinding.sourceSystemNativeId,
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
export const spaceControlAuthority = (): SpaceControlAuthority => ({
  scope: { ...requestSpaceScope },
  sourceSystemNativeId: requestControlBinding.sourceSystemNativeId,
  sourceVersion: `commit:${"c".repeat(40)}`,
  modelDigest: "c".repeat(64),
  owner: { ...requestOwnerAuthority },
  policyId: "space-policy",
  policyRevision: 1,
  operatorIds: ["operator"],
  acts: ["open-request", "execute-conversation", "revoke-execution"],
});
export const spaceUuid = (number: number) =>
  `11111111-1111-4111-8111-${String(number).padStart(12, "0")}`;
export async function requestOpeningBase(
  letter = "a",
  release = false,
): Promise<OpeningBase> {
  const version = `commit:${letter.repeat(40)}`;
  const manifest = savedManifest({
    origin: { ...requestSpaceScope, executionSpaceId: "main" },
    source: {
      branch: { kind: "main" },
      sourceVersion: version,
      repositoryId: spaceUuid(999),
      branchRef: "refs/heads/admitted",
      admittedHeadVersion: version,
      sourceDigest: letter.repeat(64),
    },
    registeredOperatorIds: ["operator"],
    operators: [{
      operatorId: "operator",
      repositoryVersion: version,
      modelDigest: letter.repeat(64),
      settingsDigest: "settings",
      systemQualifiedName: "Fixture::system",
      sourceDigest: letter.repeat(64),
      build: null,
      tools: [],
    }],
    prerequisites: [],
  });
  const digest = await requestSpaceDigest(manifest);
  return {
    sourceKind: release ? "release" : "current-main",
    ...(release ? { release: { id: "release-b", digest } } : {}),
    manifest,
    manifestDigest: digest,
    requestOwner: { operatorId: "operator", caseTypeId: "request-type" },
  };
}

/** Admitted compiled source facts used by SQL control tests; native and host
 * identities are deliberately different. No runtime membership grants policy. */
export function requestControlModel(authority = spaceControlAuthority()) {
  const model = executableFixture({
    projectId: requestSpaceScope.projectId,
    editingContextId: "main-control",
    rootId: "root",
    systemId: authority.sourceSystemNativeId,
    builderId: "operator",
    catalogId: "catalog",
  });
  model.version.digest = authority.modelDigest;
  model.version.repositoryVersion = authority.sourceVersion;
  model.ownerAuthority = structuredClone(authority.owner);
  model.spaceControlPolicy = {
    id: authority.policyId,
    revision: authority.policyRevision,
    enabled: true,
    elementId: "space-policy-native",
    sourceIds: ["space-policy-native"],
    systemId: authority.sourceSystemNativeId,
    holderNativeId: authority.owner.operatorNativeId,
    mandateNativeId: authority.owner.mandateNativeId,
    issuerRootNativeId: authority.owner.rootAuthorityNativeId,
    rootAuthority: structuredClone(authority.owner),
    operatorIds: [authority.operatorIds[0]],
    acts: [...authority.acts],
  };
  return model;
}
export function requestControlState(
  authority = spaceControlAuthority(),
  revision = 0,
): SystemRuntimeState {
  const model = requestControlModel(authority);
  return {
    id: "primary-runtime",
    revision,
    catalogRevision: 0,
    busy: false,
    phase: "ready",
    provider: "fixture",
    messages: [],
    cases: [],
    candidates: [],
    events: [],
    model: model.identity,
    executionModel: model,
  };
}

export const requestControlAdoptedState = (
  revision = 0,
): SpaceControlAdoptedState => ({
  ...requestSpaceScope,
  executionSpaceId: "main",
  operatorId: "operator",
  stateId: "primary-runtime",
  revision,
});
