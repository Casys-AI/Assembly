import { matchesExactRevision } from "../shared-kernel/revision-id.ts";
import type {
  SpaceControlAdoptedState,
  SpaceControlAuthority,
  SpaceController,
} from "./request-spaces.ts";
import {
  assertSavedSourceSelection,
  assertSaveKey,
  savedSystemDigest,
  SavedSystemError,
  type SavedSystemScope,
  type SavedSystemSourceEvidence,
} from "./saved-systems.ts";

/** Host-resolved exact command. Source/owner/scope are never browser authority. */
export interface ReleaseRetentionIntent {
  scope: SavedSystemScope;
  saveKey: string;
  commandDigest: string;
  source: SavedSystemSourceEvidence;
}
/** Server-only preflight carrier; it is neither a credential nor a reusable grant. */
export interface ReleaseRetentionAuthorization {
  intent: ReleaseRetentionIntent;
  controller: SpaceController;
}
/** Persisted beside the accepted intention, never in a public Release manifest. */
export interface ReleaseRetentionProof {
  act: "retain-release";
  intentDigest: string;
  ownerId: string;
  capabilityId: string;
  capabilityRevision: number;
  sessionId: string;
  sessionRevision: number;
  authority: SpaceControlAuthority;
  adoptedState: SpaceControlAdoptedState;
  authorizedAt: string;
}
export function assertReleaseRetentionIntent(
  intent: ReleaseRetentionIntent,
): void {
  assertSaveKey(intent.saveKey);
  assertSavedSourceSelection({
    branch: intent.source?.branch,
    sourceVersion: intent.source?.sourceVersion,
  });
  if (
    !intent.scope ||
    Object.keys(intent.scope).sort().join(",") !==
      "executionSpaceId,projectId,systemId" ||
    Object.values(intent.scope).some((value) =>
      typeof value !== "string" || !value.trim() || value.includes("\0")
    ) ||
    !/^[a-f0-9]{64}$/.test(intent.commandDigest) ||
    !intent.source.repositoryId || !intent.source.branchRef ||
    !matchesExactRevision(intent.source.admittedHeadVersion) ||
    !/^[a-f0-9]{64}$/.test(intent.source.sourceDigest) ||
    (intent.scope.executionSpaceId === "main") !==
      (intent.source.branch.kind === "main")
  ) {
    throw new SavedSystemError(
      "INVALID_COMMAND",
      "An exact host-resolved Release intention is required.",
    );
  }
}
export function releaseRetentionIntentDigest(
  intent: ReleaseRetentionIntent,
): Promise<string> {
  assertReleaseRetentionIntent(intent);
  return savedSystemDigest(intent);
}
