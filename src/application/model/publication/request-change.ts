import { OWNER_AUTHORITY_IDENTITY_FIELDS } from "../../../domain/governance/authority.ts";
import { ModelWriteCommandError } from "../../../domain/model/editing/write-command.ts";
import { assertRequestNetworkChange } from "../../../domain/governance/records/request-network-change.ts";
import {
  assertRequestChange,
  assertRequestTeamChange,
  requestChangeEffect,
} from "../../../domain/governance/records/request-change.ts";
import { assertPublicationMatches } from "../../../domain/model/publication/change.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { ModelWriteDossierV2 } from "./write-command-v2.ts";
import {
  isCreationGrantRequestAuthority,
  isDelegatedRequestAuthority,
  requestWriteAuthorityHasMemberPin,
  requestWriteAuthorityPrior,
} from "../source-admission/request-delegated-authority.ts";

export type RequestChangeDossier = ModelWriteDossierV2 & {
  command: ModelWriteDossierV2["command"] & { kind: "approved-change" };
  decision: Extract<
    ModelWriteDossierV2["decision"],
    { kind: "approved-change" }
  >;
  operations: Extract<
    ModelWriteDossierV2["operations"],
    { kind: "host-edits" }
  >;
};
/** An extra closed route gate AFTER the ordinary v2 parser, never a grant. */
export function assertRequestChangeDossier(
  dossier: ModelWriteDossierV2,
): asserts dossier is RequestChangeDossier {
  const fail = (): never => {
    throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
      reason: "Case network approval required",
    }, "An exact human-approved Case network publication is required");
  };
  if (
    dossier.command.kind !== "approved-change" ||
    dossier.decision.kind !== "approved-change" ||
    dossier.operations.kind !== "host-edits"
  ) return fail();
  // Effect first, authority second (4.8e E4): a team creation never enters
  // the network branches below, and a creation grant never publishes one.
  if (requestChangeEffect(dossier.decision.change) === "team-member") {
    return assertTeamChangeDossier(dossier, fail);
  }
  if (isCreationGrantRequestAuthority(dossier.authority)) return fail();
  if (isDelegatedRequestAuthority(dossier.authority)) {
    return assertDelegatedNetworkChangeDossier(dossier, fail);
  }
  const { change, approval } = dossier.decision,
    source = dossier.authority,
    prior = source.acceptance.priorModel,
    target = dossier.command.destination;
  try {
    assertRequestChange(change);
  } catch {
    return fail();
  }
  if (
    change.status !== "approved" || change.authority !== "human" ||
    !change.decidedAt || !change.authorityExercise ||
    change.authorityExercise.delegation ||
    change.authorityExercise.creationDelegation ||
    change.authorityExercise.candidateDelegation ||
    change.authorityExercise.action !== "mandate-change" ||
    change.authorityExercise.outOfMandate !== false ||
    change.id !== dossier.command.commandId ||
    change.caseId !== target.caseId ||
    change.requestedBy !== prior.identity.builderId ||
    change.baseModelDigest !== prior.version.digest ||
    change.diff?.base.repositoryVersion !== prior.version.repositoryVersion ||
    change.diff?.base.repositoryVersion !==
      dossier.command.approvedBase.version ||
    change.diff.base.sourceDigest !==
      target.expectedAdmittedSource.sourceDigest ||
    canonical(source.proposal.priorModel) !== canonical(prior) ||
    canonical(source.proposal.destination) !== canonical(target) ||
    canonical(source.acceptance.destination) !== canonical(target)
  ) return fail();
  const exerciseFields = new Set<string>([
    ...OWNER_AUTHORITY_IDENTITY_FIELDS,
    "sourceIds",
    "authoritySchema",
    "action",
    "baseModelDigest",
    "outOfMandate",
  ]);
  if (
    Object.keys(change.authorityExercise).some((key) =>
      !exerciseFields.has(key)
    ) || Object.keys(approval).some((key) =>
      ![
        "changeId",
        "authorityExercise",
        "baseModelDigest",
        "baseRevision",
        "adoptedPin",
        "approvedSourceBase",
        "decidedAt",
        "proposal",
        "edits",
      ].includes(key)
    )
  ) return fail();
  const owner = source.acceptance.principal.priorOwner,
    exercise: Record<string, unknown> = { ...change.authorityExercise };
  if (
    Object.entries(owner).some(([key, value]) =>
      canonical(exercise[key]) !== canonical(value)
    )
  ) return fail();
  assertPublicationMatches(change, approval);
  if (
    approval.edits.length !== 0 ||
    approval.approvedSourceBase?.modelDigest !== prior.version.digest ||
    canonical(approval.approvedSourceBase) !== canonical(change.diff.base) ||
    approval.adoptedPin.repositoryVersion !==
      dossier.command.approvedBase.version ||
    dossier.operations.journal.base.version !==
      dossier.command.approvedBase.version ||
    dossier.operations.journal.baseSourceDigest !==
      target.expectedAdmittedSource.sourceDigest
  ) return fail();
}

const APPROVAL_FIELDS = [
  "changeId",
  "authorityExercise",
  "baseModelDigest",
  "baseRevision",
  "adoptedPin",
  "approvedSourceBase",
  "decidedAt",
  "proposal",
  "edits",
];
/** The MO's decision under main's policy (4.8c C9): an operator-approved
 * change whose delegated exercise is exactly the envelope's, published only in
 * the requester's branch. Same source and approval evidence as the person's. */
function assertDelegatedNetworkChangeDossier(
  dossier: ModelWriteDossierV2,
  fail: () => never,
): asserts dossier is RequestChangeDossier {
  const authority = dossier.authority;
  if (
    !isDelegatedRequestAuthority(authority) ||
    dossier.command.kind !== "approved-change" ||
    dossier.decision.kind !== "approved-change"
  ) return fail();
  const { change, approval } = dossier.decision,
    prior = authority.priorModel,
    target = dossier.command.destination,
    exercise = change.authorityExercise;
  try {
    assertRequestNetworkChange(change);
  } catch {
    return fail();
  }
  if (
    dossier.operations.kind !== "host-edits" ||
    change.status !== "approved" || change.authority !== "builder" ||
    !change.decidedAt || !exercise?.delegation ||
    exercise.creationDelegation || exercise.candidateDelegation ||
    exercise.action !== "mandate-change" || exercise.outOfMandate !== false ||
    canonical(exercise) !== canonical(authority.exercise) ||
    canonical(exercise.delegation.requestedRights) !==
      canonical(change.requestedRights) ||
    change.id !== dossier.command.commandId ||
    change.id !== authority.route.changeId ||
    change.caseId !== target.caseId ||
    change.requestedBy !== prior.identity.builderId ||
    change.baseModelDigest !== prior.version.digest ||
    !requestWriteAuthorityHasMemberPin(authority) &&
      change.diff?.base.repositoryVersion !== prior.version.repositoryVersion ||
    change.diff?.base.repositoryVersion !==
      target.expectedAdmittedSource.source.version ||
    change.diff?.base.repositoryVersion !==
      dossier.command.approvedBase.version ||
    change.diff.base.sourceDigest !==
      target.expectedAdmittedSource.sourceDigest ||
    canonical(authority.destination) !== canonical(target) ||
    Object.keys(approval).some((key) => !APPROVAL_FIELDS.includes(key))
  ) return fail();
  assertPublicationMatches(change, approval);
  if (
    approval.edits.length !== 0 ||
    approval.approvedSourceBase?.modelDigest !== prior.version.digest ||
    canonical(approval.approvedSourceBase) !== canonical(change.diff.base) ||
    approval.adoptedPin.repositoryVersion !== prior.version.repositoryVersion ||
    dossier.operations.journal.base.version !==
      dossier.command.approvedBase.version ||
    dossier.operations.journal.baseSourceDigest !==
      target.expectedAdmittedSource.sourceDigest
  ) return fail();
}

/** The approval/source tail every team branch shares with the network ones. */
function assertTeamApprovalTail(
  dossier: ModelWriteDossierV2,
  prior: { version: { digest: string } },
  fail: () => never,
): void {
  if (
    dossier.decision.kind !== "approved-change" ||
    dossier.operations.kind !== "host-edits"
  ) return fail();
  const { change, approval } = dossier.decision,
    target = dossier.command.destination;
  assertPublicationMatches(change, approval);
  if (
    approval.edits.length !== 0 ||
    approval.approvedSourceBase?.modelDigest !== prior.version.digest ||
    canonical(approval.approvedSourceBase) !== canonical(change.diff!.base) ||
    approval.adoptedPin.repositoryVersion !==
      (requestWriteAuthorityHasMemberPin(dossier.authority)
        ? requestWriteAuthorityPrior(dossier.authority).version
          .repositoryVersion
        : dossier.command.approvedBase.version) ||
    dossier.operations.journal.base.version !==
      dossier.command.approvedBase.version ||
    dossier.operations.journal.baseSourceDigest !==
      target.expectedAdmittedSource.sourceDigest
  ) return fail();
}

/** A team creation in its requester's branch (4.8e E4): decided by the
 * person, or by the creator under its branch-read `autonomous` grant whose
 * receipt is exactly the envelope's. A delegated envelope never creates. */
function assertTeamChangeDossier(
  dossier: ModelWriteDossierV2,
  fail: () => never,
): asserts dossier is RequestChangeDossier {
  if (
    dossier.command.kind !== "approved-change" ||
    dossier.decision.kind !== "approved-change" ||
    dossier.operations.kind !== "host-edits" ||
    isDelegatedRequestAuthority(dossier.authority)
  ) return fail();
  const { change, approval } = dossier.decision,
    target = dossier.command.destination,
    exercise = change.authorityExercise;
  try {
    assertRequestTeamChange(change);
  } catch {
    return fail();
  }
  if (
    change.status !== "approved" || !change.decidedAt || !exercise ||
    exercise.action !== "mandate-change" || exercise.outOfMandate !== false ||
    exercise.candidateDelegation ||
    change.id !== dossier.command.commandId ||
    change.caseId !== target.caseId ||
    change.diff?.base.repositoryVersion !==
      dossier.command.approvedBase.version ||
    change.diff.base.sourceDigest !==
      target.expectedAdmittedSource.sourceDigest ||
    Object.keys(approval).some((key) => !APPROVAL_FIELDS.includes(key))
  ) return fail();
  if (isCreationGrantRequestAuthority(dossier.authority)) {
    const authority = dossier.authority,
      prior = authority.priorModel,
      receipt = exercise.creationDelegation;
    if (
      change.authority !== "builder" || !receipt || exercise.delegation ||
      canonical(exercise) !== canonical(authority.exercise) ||
      receipt.changeId !== change.id ||
      change.requestedBy !== prior.identity.builderId ||
      change.baseModelDigest !== prior.version.digest ||
      change.diff?.base.repositoryVersion !==
        target.expectedAdmittedSource.source.version ||
      canonical(authority.destination) !== canonical(target)
    ) return fail();
    return assertTeamApprovalTail(dossier, prior, fail);
  }
  const source = dossier.authority,
    prior = source.acceptance.priorModel;
  if (
    change.authority !== "human" || exercise.delegation ||
    exercise.creationDelegation ||
    change.requestedBy !== prior.identity.builderId ||
    change.baseModelDigest !== prior.version.digest ||
    change.diff?.base.repositoryVersion !== prior.version.repositoryVersion ||
    canonical(source.proposal.priorModel) !== canonical(prior) ||
    canonical(source.proposal.destination) !== canonical(target) ||
    canonical(source.acceptance.destination) !== canonical(target)
  ) return fail();
  const exerciseFields = new Set<string>([
    ...OWNER_AUTHORITY_IDENTITY_FIELDS,
    "sourceIds",
    "authoritySchema",
    "action",
    "baseModelDigest",
    "outOfMandate",
  ]);
  if (
    Object.keys(exercise).some((key) => !exerciseFields.has(key))
  ) return fail();
  const owner = source.acceptance.principal.priorOwner,
    exerciseRecord: Record<string, unknown> = { ...exercise };
  if (
    Object.entries(owner).some(([key, value]) =>
      canonical(exerciseRecord[key]) !== canonical(value)
    )
  ) return fail();
  return assertTeamApprovalTail(dossier, prior, fail);
}
