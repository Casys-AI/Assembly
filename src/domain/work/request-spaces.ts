import { matchesExactRevision } from "../shared-kernel/revision-id.ts";
import { persistedOrder } from "../primitives/persisted-order.ts";
import type { SpaceControlAct } from "../governance/policies/space-execution-policy.ts";

import {
  canonicalDigest,
  isSha256Hex,
} from "../primitives/execution-digest.ts";
import type { SavedSystemManifest } from "./saved-systems.ts";
import {
  MAX_BRANCH_TEAM,
  MAX_OPERATOR_UNITS,
} from "./records/conversations.ts";
import type {
  OwnerAuthority,
  ScopedOperatorRef,
} from "../governance/authority.ts";
import {
  sourceIdentity,
  validateSourceBindingReference,
} from "./artifacts/source-reference.ts";

export interface RequestSpaceScope {
  projectId: string;
  systemId: string;
}
export type OpeningSourceChoice =
  | { kind: "current-main"; expectedVersion?: string }
  | { kind: "release"; releaseId: string; digest: string };
/** Public DTO: actor, execution scope, IDs, refs and permissions are host-owned. */
export interface OpeningCommand {
  openingKey: string;
  text: string;
  source: OpeningSourceChoice;
}
/** Host-captured provenance of an opening by the Main Operator (4.8d D3):
 * the registered Main and the turn that opened. Never a public DTO field. */
export interface MainOpener {
  operator: ScopedOperatorRef;
  origin: {
    conversationId: string;
    designerScopeId: string;
    messageId?: string;
    /** The Main Operator's stable identity for this opening. */
    openingId: string;
  };
}
/** The recorded command: the public DTO, plus the host-captured opener of a
 * Main Operator opening. It is part of the command digest. */
export interface RecordedOpeningCommand extends OpeningCommand {
  opener?: MainOpener;
}
/** A Main Operator opening's key is derived from its opener, never typed. */
export async function mainOpeningKey(opener: MainOpener): Promise<string> {
  return `main-${await canonicalDigest({
    operator: opener.operator,
    conversationId: opener.origin.conversationId,
    designerScopeId: opener.origin.designerScopeId,
    openingId: opener.origin.openingId,
  })}`;
}
export interface OpeningBase {
  sourceKind: "current-main" | "release";
  release?: { id: string; digest: string };
  manifest: SavedSystemManifest;
  manifestDigest: string;
  requestOwner: { operatorId: string; caseTypeId: string };
}
export type OpeningPhase =
  | "allocated"
  | "source-selected"
  | "branch-ready"
  | "runtime-ready"
  | "admitted"
  | "dispatched";
export const OPENING_PHASES: readonly OpeningPhase[] = [
  "allocated",
  "source-selected",
  "branch-ready",
  "runtime-ready",
  "admitted",
  "dispatched",
];
export interface OpeningIdentity {
  id: string;
  caseId: string;
  caseNumber: number;
  executionSpaceId: string;
  branchId: string;
  initialContributionId: string;
}
export interface OpeningRecord extends OpeningIdentity {
  scope: RequestSpaceScope;
  ownerId: string;
  command: RecordedOpeningCommand;
  commandDigest: string;
  base: OpeningBase | null;
  baseDigest: string | null;
  phase: OpeningPhase;
  admissionId: string | null;
  revision: number;
  issues: string[];
  createdAt: string;
}
export interface OpeningView extends OpeningIdentity {
  phase: OpeningPhase;
  revision: number;
  sourceVersion: string | null;
  release: { id: string; digest: string } | null;
  admissionId: string | null;
  issues: string[];
}
/** Host-owned binding to the native system in its currently admitted source.
 * The operational system instance ID and SysML native system ID are distinct. */
export interface SpaceControlSourceBinding {
  scope: RequestSpaceScope;
  sourceSystemNativeId: string;
}
/** Transient issuance precondition, not effective authority and never a browser DTO. */
export interface SpaceControlAdoptedState extends RequestSpaceScope {
  executionSpaceId: "main";
  operatorId: string;
  stateId: string;
  revision: number;
}
/** Verified from the current control source, never reconstructed from a Release. */
export interface SpaceControlAuthority extends SpaceControlSourceBinding {
  /** Exact admission-source evidence, independent of the effective policy identity. */
  sourceVersion: string;
  modelDigest: string;
  owner: OwnerAuthority;
  /** Stable source policy identity, never a display label. */
  policyId: string;
  policyRevision: number;
  operatorIds: string[];
  acts: SpaceControlAct[];
}
/** Returned only by server-side credential verification. It is never a command DTO. */
export interface SpaceController {
  kind?: "session";
  ownerId: string;
  capabilityId: string;
  capabilityRevision: number;
  sessionId: string;
  authority: SpaceControlAuthority;
}
/** Host-internal controller of a Main Operator opening (4.8d D3, 4.8c A1): a
 * capability issued by local composition, its secret discarded, no session.
 * Person-facing ports accept only `SpaceController`. */
export interface HostSpaceController {
  kind: "host";
  ownerId: string;
  capabilityId: string;
  capabilityRevision: number;
  authority: SpaceControlAuthority;
  opener: ScopedOperatorRef;
}
/** What the opening phases and their admission accept. */
export type SpaceControlPrincipal = SpaceController | HostSpaceController;
export interface SpacePermissions {
  operatorIds: string[];
  acts: ["conversation"];
  sourceVersion: string;
  modelDigests: string[];
  resourceIds: string[];
}
export interface SpaceExecutionAdmission {
  id: string;
  scope: RequestSpaceScope;
  executionSpaceId: string;
  openingId: string;
  ownerId: string;
  capabilityId: string;
  capabilityRevision: number;
  baseDigest: string;
  authority: SpaceControlAuthority;
  permissions: SpacePermissions;
  revision: number;
  status: "active" | "revoked";
  expiresAt: string;
  createdAt: string;
}
export class RequestSpaceError extends Error {
  constructor(
    readonly code:
      | "INVALID_COMMAND"
      | "OPENING_CONFLICT"
      | "UNAVAILABLE"
      | "FORBIDDEN"
      | "ADMISSION_REFUSED"
      | "PROVISIONING_UNAVAILABLE",
    message: string,
    /** What was refused and how to recover, for an agent reading the code. */
    details: { context?: Record<string, unknown>; recovery?: string } = {},
  ) {
    super(message);
    this.name = "RequestSpaceError";
    this.context = details.context;
    this.recovery = details.recovery;
  }
  readonly context?: Record<string, unknown>;
  readonly recovery?: string;
}
export const requestSpaceDigest = (value: unknown): Promise<string> =>
  canonicalDigest(value);
export function exactSourceVersion(value: unknown): value is string {
  return typeof value === "string" && matchesExactRevision(value);
}
export function requestSpaceIdentity(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}
export function openingCommand(value: unknown): OpeningCommand {
  if (
    !exact(value, ["openingKey", "text", "source"]) ||
    Object.keys(value).length !== 3 ||
    !requestSpaceIdentity(value.openingKey) || typeof value.text !== "string" ||
    !value.text.trim() || value.text.length > 100_000 ||
    value.text.includes("\0")
  ) {
    throw new RequestSpaceError(
      "INVALID_COMMAND",
      "An opening key, bounded request and source choice are required.",
    );
  }
  const source = value.source;
  if (
    !exact(source, ["kind", "expectedVersion", "releaseId", "digest"]) || !(
      source.kind === "current-main" && Object.keys(source).every((key) =>
          ["kind", "expectedVersion"].includes(key)
        ) &&
        (source.expectedVersion === undefined ||
          exactSourceVersion(source.expectedVersion)) ||
      source.kind === "release" && Object.keys(source).length === 3 &&
        requestSpaceIdentity(source.releaseId) &&
        isSha256Hex(source.digest)
    )
  ) {
    throw new RequestSpaceError(
      "INVALID_COMMAND",
      "Select current main or an exact Release.",
    );
  }
  return structuredClone({
    openingKey: value.openingKey,
    text: value.text.trim(),
    source,
  }) as OpeningCommand;
}
/** A recorded command, as stored: the public DTO and, for a Main Operator
 * opening, the exact host-captured opener (4.8d D3). */
export function recordedOpeningCommand(value: unknown): RecordedOpeningCommand {
  const invalid = () =>
    new RequestSpaceError(
      "INVALID_COMMAND",
      "The recorded opening command or its opener is invalid.",
    );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const { opener, ...command } = value as Record<string, unknown>;
  const parsed = openingCommand(command);
  if (opener === undefined) return parsed;
  const operator = (opener as Record<string, unknown>)?.operator;
  const origin = (opener as Record<string, unknown>)?.origin;
  if (
    !exact(opener, ["operator", "origin"]) ||
    Object.keys(opener).length !== 2 ||
    !exact(operator, [
      "projectId",
      "systemId",
      "executionSpaceId",
      "operatorId",
    ]) ||
    Object.keys(operator).length !== 4 ||
    !Object.values(operator).every((entry) =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 512
    ) ||
    !exact(origin, [
      "conversationId",
      "designerScopeId",
      "messageId",
      "openingId",
    ]) ||
    !Object.values(origin).every((entry) =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 512
    ) ||
    typeof origin.conversationId !== "string" ||
    typeof origin.designerScopeId !== "string" ||
    typeof origin.openingId !== "string"
  ) throw invalid();
  return {
    ...parsed,
    opener: structuredClone(opener) as unknown as MainOpener,
  };
}
export function assertOpeningBase(base: OpeningBase): void {
  const source = base.manifest?.source;
  if (
    !source || !exactSourceVersion(source.sourceVersion) ||
    !base.manifestDigest ||
    !base.manifest.operators.length ||
    base.manifest.operators.length > MAX_OPERATOR_UNITS ||
    !base.manifest.operators.some((operator) =>
      operator.operatorId === base.requestOwner?.operatorId
    ) ||
    !base.requestOwner.caseTypeId ||
    base.manifest.operators.some((operator) =>
      operator.repositoryVersion !== source.sourceVersion ||
      operator.tools.some((tool) => {
        try {
          if (!tool.sourceBinding) return true;
          validateSourceBindingReference(tool.sourceBinding);
          return tool.sourceBinding.ownerId !== operator.operatorId ||
            tool.sourceBinding.localArtifactId !== tool.candidateId ||
            tool.sourceBinding.reference.kind !== "tool-draft" ||
            tool.sourceBinding.reference.contentDigest !== tool.digest;
        } catch {
          return true;
        }
      })
    ) ||
    base.manifest.prerequisites.some((entry) =>
      entry.kind !== "host-runtime" && !(
        exact(entry, ["kind", "code", "operatorId"]) &&
        Object.keys(entry).length === 3 && entry.kind === "skill" &&
        entry.code === "SKILL_DEPENDENCY" && sourceIdentity(entry.operatorId) &&
        base.manifest.operators.filter((operator) =>
            operator.operatorId === entry.operatorId
          ).length === 1
      )
    ) ||
    (base.sourceKind === "release" &&
      (!base.release || base.release.digest !== base.manifestDigest))
  ) {
    throw new RequestSpaceError(
      "UNAVAILABLE",
      "This exact source or its supported retained dependencies are unavailable.",
    );
  }
}
export function assertBaseForChoice(
  base: OpeningBase,
  choice: OpeningSourceChoice,
): void {
  assertOpeningBase(base);
  if (
    base.sourceKind !== choice.kind ||
    choice.kind === "current-main" && choice.expectedVersion !== undefined &&
      choice.expectedVersion !== base.manifest.source!.sourceVersion ||
    choice.kind === "release" &&
      (base.release?.id !== choice.releaseId ||
        base.release?.digest !== choice.digest)
  ) {
    throw new RequestSpaceError(
      "OPENING_CONFLICT",
      "The resolved base differs from the exact opening source choice.",
    );
  }
}
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
export function openingView(record: OpeningRecord): OpeningView {
  return {
    id: record.id,
    caseId: record.caseId,
    caseNumber: record.caseNumber,
    executionSpaceId: record.executionSpaceId,
    branchId: record.branchId,
    initialContributionId: record.initialContributionId,
    phase: record.phase,
    revision: record.revision,
    sourceVersion: record.base?.manifest.source?.sourceVersion ?? null,
    release: record.base?.release ?? null,
    admissionId: record.admissionId,
    issues: [...record.issues],
  };
}
