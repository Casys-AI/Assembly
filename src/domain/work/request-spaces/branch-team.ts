import { persistedOrder } from "../../primitives/persisted-order.ts";
import { MAX_BRANCH_TEAM } from "../records/conversations.ts";
import { assertOpeningBase, type OpeningBase } from "./opening.ts";
import { RequestSpaceError } from "./scope.ts";
import type { SpacePermissions } from "./space-control.ts";

/** Structural pinned model for branch team membership; no authority by itself. */
export interface BranchTeamPinnedModel {
  identity: { builderId: string; systemId: string };
  version: { digest: string; repositoryVersion?: string };
  operatorTeam?: {
    parentOperatorId: string;
    requestOwnerId: string;
    requestId: string;
    creationPolicyId?: string;
  };
}
/** Membership already verified by branchTeam at the Request opening boundary. */
export interface VerifiedRequestTeam {
  readonly caseId: string;
  readonly memberIds: readonly string[];
}

/** The shared operational membership predicate; the host supplies verified evidence. */
export function isRequestTeamMember(
  operatorId: string,
  team: VerifiedRequestTeam,
): boolean {
  return team.memberIds.includes(operatorId);
}

/** Main has no Request opening roster: only the exact native Case lineage applies. */
export function canContributeFromMain(
  model: BranchTeamPinnedModel,
  callerId: string,
  context: {
    caseId: string;
    record?: { owner: string };
    budget?: { ownerId: string };
  } | undefined,
): boolean {
  const team = model.operatorTeam;
  return !team || !!context && callerId === team.parentOperatorId &&
      context.caseId === team.requestId &&
      (context.record?.owner ?? context.budget?.ownerId) ===
        team.requestOwnerId;
}

/** Capture the roster verified at the opening boundary as immutable evidence. */
export function verifiedRequestTeam(
  caseId: string,
  team: readonly BranchTeamMember[],
): VerifiedRequestTeam {
  return Object.freeze({
    caseId,
    memberIds: Object.freeze(team.map((member) => member.operatorId)),
  });
}

/** Project current Case identity only for a member of the verified opening team. */
export function operatorTeamInRequest(
  model: BranchTeamPinnedModel,
  team: VerifiedRequestTeam,
) {
  return model.operatorTeam &&
      isRequestTeamMember(model.identity.builderId, team)
    ? { ...model.operatorTeam, requestId: team.caseId }
    : undefined;
}

/** An unambiguous registered baseline; membership still needs its own proof. */
export function retainedMember(base: OpeningBase, operatorId: string) {
  if (!base.manifest.source || operatorId === base.requestOwner.operatorId) {
    return undefined;
  }
  const entries = base.manifest.operators.filter((entry) =>
    entry.operatorId === operatorId
  );
  return entries.length === 1 &&
      base.manifest.registeredOperatorIds.filter((id) => id === operatorId)
          .length === 1
    ? entries[0]
    : undefined;
}

export interface BranchTeamMember {
  operatorId: string;
  modelDigest: string;
  parentOperatorId: string;
}

/**
 * The one branch-team source of truth (spec 4.8e E3): pinned operators of
 * this Case whose creation receipt verifies, or retained exact Release team,
 * admitted transitively from the
 * Request owner (a member's own sub-operator joins only through it), at most
 * MAX_BRANCH_TEAM. An exact Release retains its source Request team; other
 * inherited members remain inert. Retained models keep their original lineage.
 * Receipt verification is the governance predicate injected by the caller
 * (`creationReceiptVerifies`); this module owns membership, not receipts.
 */
export function branchTeam(
  base: OpeningBase,
  pinnedModels: readonly BranchTeamPinnedModel[],
  caseId: string,
  receiptVerifies: (child: BranchTeamPinnedModel) => boolean,
  admittedMembers: readonly string[] = [],
): BranchTeamMember[] {
  const owner = base.requestOwner.operatorId;
  const byOperator = new Map<string, BranchTeamPinnedModel>();
  const ambiguous = new Set<string>();
  for (const model of pinnedModels) {
    const id = model.identity.builderId;
    // An ambiguous pin admits nobody under that identity.
    if (byOperator.has(id)) ambiguous.add(id);
    else if (!ambiguous.has(id)) byOperator.set(id, model);
  }
  for (const id of ambiguous) byOperator.delete(id);
  const admitted = new Set(admittedMembers);
  const retainedSource = base.sourceKind === "release"
    ? base.manifest.source
    : undefined;
  // Initial membership is fixed by the exact retained executable. Later pins
  // may advance only members already covered by this space's admission;
  // their binding reader separately verifies the new execution digest.
  const retained = (model: BranchTeamPinnedModel): boolean => {
    const id = model.identity.builderId;
    const entry = retainedMember(base, id);
    return !!retainedSource && !!entry &&
      entry.nativeSystemId === model.identity.systemId &&
      (admitted.has(id) || entry.modelDigest === model.version.digest &&
          entry.repositoryVersion === retainedSource.sourceVersion &&
          model.version.repositoryVersion === retainedSource.sourceVersion);
  };
  const members = new Map<string, BranchTeamMember>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const model of byOperator.values()) {
      const team = model.operatorTeam;
      const id = model.identity.builderId;
      if (
        !team || id === owner || members.has(id) ||
        team.requestOwnerId !== owner ||
        team.parentOperatorId !== owner &&
          !members.has(team.parentOperatorId) ||
        !(retained(model) ||
          team.requestId === caseId && receiptVerifies(model))
      ) continue;
      members.set(id, {
        operatorId: id,
        modelDigest: model.version.digest,
        parentOperatorId: team.parentOperatorId,
      });
      grew = true;
    }
  }
  if (
    admittedMembers.length > MAX_BRANCH_TEAM ||
    new Set(admittedMembers).size !== admittedMembers.length ||
    admittedMembers.some((id) => {
      const member = members.get(id);
      return !member || member.parentOperatorId !== owner &&
          !admitted.has(member.parentOperatorId);
    })
  ) {
    throw new RequestSpaceError(
      "OPENING_CONFLICT",
      "An admitted branch member is missing from the verified team",
      {
        context: { caseId, admittedMembers: [...admittedMembers] },
        recovery:
          "Restore the admitted members and their creation receipts before admitting another member.",
      },
    );
  }
  // Truncation keeps parents before children: shallower members first
  // (alphabetical within a depth), so a kept sub-member's parent is kept.
  const depth = new Map<string, number>([[owner, 0]]);
  for (const member of members.values()) {
    let level = 0;
    let parent = member.parentOperatorId;
    while (parent !== owner && members.has(parent)) {
      level++;
      parent = members.get(parent)!.parentOperatorId;
    }
    depth.set(member.operatorId, level + 1);
  }
  return [...members.values()]
    .sort((a, b) =>
      Number(admitted.has(b.operatorId)) - Number(admitted.has(a.operatorId)) ||
      depth.get(a.operatorId)! - depth.get(b.operatorId)! ||
      persistedOrder(a.operatorId, b.operatorId)
    )
    .slice(0, MAX_BRANCH_TEAM)
    .sort((a, b) => persistedOrder(a.operatorId, b.operatorId));
}

export function conversationPermissions(
  base: OpeningBase,
  team: readonly BranchTeamMember[] = [],
): SpacePermissions {
  assertOpeningBase(base);
  return {
    operatorIds: [
      base.requestOwner.operatorId,
      ...team.map((member) => member.operatorId),
    ],
    acts: ["conversation"],
    sourceVersion: base.manifest.source!.sourceVersion,
    modelDigests: [
      ...base.manifest.operators.filter((operator) =>
        operator.operatorId === base.requestOwner.operatorId
      ).map((operator) => operator.modelDigest),
      ...team.map((member) => member.modelDigest),
    ],
    resourceIds: [],
  };
}
