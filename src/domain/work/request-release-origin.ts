import { canonical } from "../primitives/canonical-json.ts";
import type { OpeningRecord } from "./request-spaces.ts";
import type {
  SavedOperatorManifest,
  SavedSystemManifest,
} from "./saved-systems.ts";
import {
  assertRequestReleaseAdmissionReference,
  type RequestReleaseAdmissionReference,
} from "./saved-systems.ts";
import type { ModelIdentity } from "./dialogue.ts";

/** Projection from an independently verified admission journal, not authority. */
export interface VerifiedRequestReleaseSource {
  requestAdmission: RequestReleaseAdmissionReference;
  source: { repositoryId: string; version: string };
  sourceDigest: string;
  /** Same retained build evidence as the Work Release manifest, required here. */
  build: NonNullable<SavedOperatorManifest["build"]>;
  model: { identity: ModelIdentity; digest: string };
}

/** Pure immutable source relationship shared by retained-source preflight and
 * the SQL effect guard. Caller separately verifies records, visibility, assets
 * and current execution authority; this predicate grants none of them. */
export function requestReleaseOriginMatches(
  manifest: SavedSystemManifest,
  origin:
    & Pick<OpeningRecord, "scope" | "caseId" | "executionSpaceId" | "base">
    & Partial<Pick<OpeningRecord, "id" | "baseDigest">>,
  expectedBranchRef: string,
  admitted?: VerifiedRequestReleaseSource,
): boolean {
  const source = manifest.source, base = origin.base?.manifest;
  if (source?.requestAdmission !== undefined) {
    try {
      assertRequestReleaseAdmissionReference(source.requestAdmission);
    } catch {
      return false;
    }
    const ownerId = origin.base?.requestOwner.operatorId;
    const owner = manifest.operators.filter((item) =>
      item.operatorId === ownerId
    );
    const identity = admitted?.model.identity;
    return Boolean(
      base?.source && admitted && identity && owner.length === 1 &&
        source.branch.kind === "case" &&
        source.branch.caseId === origin.caseId &&
        manifest.origin.projectId === origin.scope.projectId &&
        manifest.origin.systemId === origin.scope.systemId &&
        manifest.origin.executionSpaceId === origin.executionSpaceId &&
        source.repositoryId === base.source.repositoryId &&
        source.branchRef === expectedBranchRef &&
        source.admittedHeadVersion === source.sourceVersion &&
        source.requestAdmission.openingId === origin.id &&
        source.requestAdmission.openingBaseDigest === origin.baseDigest &&
        canonical(source.requestAdmission) ===
          canonical(admitted.requestAdmission) &&
        admitted.source.repositoryId === source.repositoryId &&
        admitted.source.version === source.sourceVersion &&
        admitted.sourceDigest === source.sourceDigest &&
        identity.projectId === `git:${source.repositoryId}` &&
        identity.builderId === ownerId &&
        (owner[0].nativeSystemId === undefined ||
          owner[0].nativeSystemId === identity.systemId) &&
        (identity.systemQualifiedName === undefined ||
          owner[0].systemQualifiedName === identity.systemQualifiedName) &&
        owner[0].modelDigest === admitted.model.digest &&
        owner[0].sourceDigest === source.sourceDigest &&
        canonical(owner[0].build) === canonical(admitted.build),
    );
  }
  return Boolean(
    source && base?.source &&
      source.branch.kind === "case" && source.branch.caseId === origin.caseId &&
      manifest.origin.projectId === origin.scope.projectId &&
      manifest.origin.systemId === origin.scope.systemId &&
      manifest.origin.executionSpaceId === origin.executionSpaceId &&
      source.repositoryId === base.source.repositoryId &&
      source.branchRef === expectedBranchRef &&
      source.sourceVersion === base.source.sourceVersion &&
      source.admittedHeadVersion === source.sourceVersion &&
      source.sourceDigest === base.source.sourceDigest &&
      canonical(manifest.registeredOperatorIds) ===
        canonical(base.registeredOperatorIds) &&
      canonical(manifest.operators) === canonical(base.operators) &&
      canonical(manifest.prerequisites) === canonical(base.prerequisites),
  );
}
