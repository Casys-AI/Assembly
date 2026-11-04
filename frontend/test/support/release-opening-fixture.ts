import type { SavedSystemView } from "../../../src/application/work/saved-systems/release-view.ts";

export const RELEASE_HOST = {
  projectId: "git:45a0a316-1773-4c47-80a5-b1688a28ab6c",
  systemId: "54014246-1c70-4039-88d6-6b6bf1e3d8ee",
};
export const RELEASE_VERSION = `commit:${"a".repeat(40)}`;
/** Transport fixture only; actual hash/assets/host support are server witnesses. */
export function localSkillRelease(
  id = "releaseA",
  caseId?: string,
): SavedSystemView {
  const origin = {
    ...RELEASE_HOST,
    executionSpaceId: caseId ? `space-${caseId}` : "main",
  };
  const source = {
    branch: caseId
      ? { kind: "case" as const, caseId }
      : { kind: "main" as const },
    sourceVersion: RELEASE_VERSION,
    repositoryId: RELEASE_HOST.projectId,
    branchRef: caseId ? `refs/assembly/requests/${caseId}` : "refs/heads/main",
    admittedHeadVersion: RELEASE_VERSION,
    sourceDigest: "b".repeat(64),
  };
  const operator = {
    operatorId: "Assembly::Primary",
    modelDigest: "c".repeat(64),
    repositoryVersion: RELEASE_VERSION,
    settingsDigest: "d".repeat(64),
    systemQualifiedName: "Assembly::Primary",
    tools: [],
  };
  const prerequisites = [{
    kind: "skill" as const,
    code: "SKILL_DEPENDENCY",
    operatorId: operator.operatorId,
  }];
  return {
    id,
    saveKey: `key-${id}`,
    metadata: { name: id, purpose: "Exact local skill source" },
    createdAt: "2026-10-30T00:00:00.000Z",
    status: "incomplete",
    digest: "e".repeat(64),
    revision: 1,
    issues: ["PREREQUISITES_REQUIRED"],
    assetAvailability: "unchecked",
    origin,
    source,
    prerequisites,
    selectedOperators: [operator],
    manifest: {
      format: "assembly-saved-system-v1",
      origin,
      source,
      registeredOperatorIds: [operator.operatorId],
      operators: [{
        ...operator,
        sourceDigest: source.sourceDigest,
        build: null,
      }],
      prerequisites,
    },
  };
}
