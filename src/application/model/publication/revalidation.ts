import type { SourceCompilationPort } from "../source-compilation.ts";
import type { PublicationRevalidationPort } from "./ports/out/publication-revalidation.port.ts";
import { ModelPublicationError } from "./service.ts";
import {
  assertCreationWithinPolicy,
  assertOperatorCreationCapacity,
  exactChildCreationGrant,
  mainCreationScope,
  matchesTeamProvision,
} from "../../../domain/governance/policies/operator-creation-policy.ts";
import { mainExecutionSpace } from "../../../domain/governance/authority.ts";
import {
  isTeamOperatorSpec,
  type TeamOperatorSpec,
  validateOperatorCreationSpec,
} from "../../../domain/governance/operator-authority.ts";
import { requestOperatorSystemName } from "../../governance/operator-authority-values.ts";
import { toolDraftDigest } from "../../work/artifacts/catalog.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  assertApprovable,
  assertChangeAuthorityReceipt,
} from "../../../domain/governance/policies/change-approvability.ts";
import {
  assertPublicationMatches,
  publicationSourceVersion,
  publicationSystemId,
  type RevalidationEvidence,
} from "../../../domain/model/publication/change.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import { assertCandidateDelegationReceipt } from "../../../domain/governance/policies/tool-admission-policy.ts";
import type { Candidate } from "../../../domain/work/records/candidates.ts";
import { compareModelSources } from "../revisions/source-diff.ts";
import { sourceLiterals } from "../../../domain/model/projections/source-facts.ts";
import { discoverConversationUnits } from "../../../domain/model/records/source-identity.ts";

type Input = Parameters<PublicationRevalidationPort["revalidate"]>[0] & {
  activationCandidate?: Candidate;
};
type Validate = (
  revision: ModelRevision,
  projectId: string,
  systemId: string,
) => Promise<ExecutableModel>;
export function createSelectedSystemValidator(
  compilation: SourceCompilationPort,
): Validate {
  return async (
    revision,
    projectId,
    systemId,
  ) => {
    const units = discoverConversationUnits(revision, projectId).filter((
      unit,
    ) => unit.identity.systemId === systemId);
    if (units.length !== 1) {
      throw new Error("Select one exact native system identity");
    }
    return await compilation.compile(
      revision,
      projectId,
      units[0]!.systemQualifiedName,
    );
  };
}

/** Revalidates an immutable approval against its exact admitted source base.
 * A later repository base needs a new decision until a separate continuity
 * proof can establish the original authority and displayed intent there. */
export class NativeModelPublicationRevalidator
  implements PublicationRevalidationPort {
  constructor(
    readonly projectId: string,
    private readonly validate: Validate,
    private readonly compilation: SourceCompilationPort,
  ) {}

  async revalidate(input: Input): Promise<RevalidationEvidence> {
    const {
      approval,
      executionBase,
      candidate,
      edits,
      change,
      activationCandidate,
    } = input;
    const fail = (
      code: "NEEDS_DECISION" | "REFUSED",
      reason: string,
    ): never => {
      throw new ModelPublicationError(code, {
        changeId: approval.changeId,
        reason,
      }, reason);
    };
    const systemId = publicationSystemId(approval);
    if (
      !systemId || !approval.adoptedPin?.repositoryVersion ||
      approval.adoptedPin.digest !== approval.baseModelDigest ||
      approval.edits.length !== 0 || !edits.length
    ) {
      fail("REFUSED", "APPROVAL_INCOMPLETE");
    }
    if (executionBase.version !== publicationSourceVersion(approval)) {
      fail("NEEDS_DECISION", "APPROVED_BASE_CHANGED");
    }
    if (candidate.version !== executionBase.version) {
      fail("REFUSED", "CANDIDATE_BASE_MISMATCH");
    }
    const baseSourceDigest = await modelSourceDigest(executionBase.sources);
    const candidateSourceDigest = await modelSourceDigest(candidate.sources);
    if (
      approval.type !== "candidate-activation" && approval.approvedSourceBase &&
      (approval.approvedSourceBase.sourceDigest !== baseSourceDigest ||
        approval.approvedSourceBase.modelDigest !== approval.baseModelDigest)
    ) {
      fail("NEEDS_DECISION", "APPROVED_SOURCE_BASE_MISMATCH");
    }
    if (
      executionBase.sourceDigest !== baseSourceDigest ||
      candidate.sourceDigest !== candidateSourceDigest ||
      candidateSourceDigest === baseSourceDigest
    ) {
      fail("REFUSED", "SOURCE_DIGEST_MISMATCH");
    }
    if (change?.kind === "operator-creation") {
      try {
        assertOperatorCreationCapacity(
          discoverConversationUnits(executionBase, this.projectId).length,
          discoverConversationUnits(candidate, this.projectId).length,
        );
      } catch (error) {
        return fail(
          "REFUSED",
          error instanceof Error ? error.message : "OPERATOR_CAPACITY_EXCEEDED",
        );
      }
    }
    let base: ExecutableModel;
    let next: ExecutableModel;
    try {
      base = await this.validate(executionBase, this.projectId, systemId);
      next = await this.validate(candidate, this.projectId, systemId);
    } catch (error) {
      // Native compilation failures remain infrastructure failures; the
      // service must not turn an unavailable validator into approval.
      throw error;
    }
    if (
      base.identity.systemId !== systemId ||
      next.identity.systemId !== systemId ||
      base.version.repositoryVersion !== executionBase.version ||
      next.version.repositoryVersion !== candidate.version ||
      base.version.digest !== approval.baseModelDigest ||
      base.configuration.revision !== approval.baseRevision ||
      approval.adoptedPin.digest !== base.version.digest
    ) {
      fail("REFUSED", "APPROVED_MODEL_MISMATCH");
    }

    if (approval.type === "candidate-activation") {
      const admission = approval.admission;
      if (!activationCandidate) {
        return fail("NEEDS_DECISION", "DURABLE_ACTIVATION_CANDIDATE_MISSING");
      }
      if (
        activationCandidate.id !== approval.candidateId ||
        activationCandidate.digest !== approval.candidateDigest ||
        !/^[a-f0-9]{64}$/i.test(activationCandidate.digest) ||
        await toolDraftDigest(activationCandidate) !==
          activationCandidate.digest ||
        canonical(activationCandidate.admission) !== canonical(admission) ||
        activationCandidate.tests?.passed !== true ||
        !Array.isArray(activationCandidate.tests?.checks) ||
        activationCandidate.tests.checks.some((check) =>
          check.passed !== true
        ) ||
        activationCandidate.activationModelDigest !== approval.baseModelDigest
      ) fail("REFUSED", "ACTIVATION_CANDIDATE_PROOF_MISMATCH");
      if (
        approval.builderId !== base.identity.builderId ||
        admission.candidateId !== approval.candidateId ||
        admission.candidateDigest !== approval.candidateDigest ||
        admission.configurationRevision !== approval.baseRevision ||
        admission.at !== approval.decidedAt ||
        !admission.actorId || !admission.reason?.trim() || !admission.at ||
        !["human", "builder", "reviewer", "delegate"].includes(
          admission.authority,
        ) ||
        admission.authorityExercise && (
            admission.authorityExercise.action !== "candidate-admission" ||
            admission.authorityExercise.systemId !== systemId ||
            admission.authorityExercise.baseModelDigest !==
              approval.baseModelDigest
          )
      ) fail("REFUSED", "ACTIVATION_ADMISSION_MISMATCH");
      if (
        admission.authority === "delegate" ||
        admission.authorityExercise?.candidateDelegation !== undefined ||
        activationCandidate.admissionDecision?.authorityExercise
            ?.candidateDelegation !== undefined
      ) {
        try {
          assertCandidateDelegationReceipt(
            base,
            activationCandidate,
            mainExecutionSpace(base.identity),
          );
        } catch {
          fail("REFUSED", "ACTIVATION_ADMISSION_MISMATCH");
        }
      }
      if (
        next.version.digest !== base.version.digest ||
        next.configuration.revision !== base.configuration.revision ||
        canonical(next.configuration.builder) !==
          canonical(base.configuration.builder) ||
        canonical(next.policy) !== canonical(base.policy) ||
        canonical(next.ownerAuthority) !== canonical(base.ownerAuthority)
      ) {
        fail("REFUSED", "ACTIVATION_CHANGED_CONTRACT");
      }
      const matches = next.catalog.filter((entry) =>
        entry.candidateId === approval.candidateId &&
        entry.digest === approval.candidateDigest &&
        entry.name === activationCandidate.name &&
        entry.kind === activationCandidate.kind &&
        entry.status === "active"
      );
      if (
        matches.length !== 1 ||
        next.catalog.filter((entry) =>
            entry.candidateId === approval.candidateId
          ).length !== 1 ||
        base.catalog.some((entry) =>
          entry.candidateId === approval.candidateId &&
          entry.status === "active"
        )
      ) fail("REFUSED", "ACTIVATION_CANDIDATE_MISMATCH");
      const selected = matches[0]!;
      const contract = next.contracts.filter((entry) =>
        entry.nativeId === selected.contractId &&
        entry.kind === activationCandidate.kind
      );
      if (contract.length !== 1) {
        fail("REFUSED", "ACTIVATION_CONTRACT_MISMATCH");
      }
      if (
        activationCandidate.requiredAuthority !== undefined ||
        activationCandidate.proposedConfigurationRevision !== undefined
      ) {
        const literals = sourceLiterals(candidate.elements);
        const matchesLiteral = (name: string, value: string) =>
          literals.filter((literal) =>
            literal.owner === selected.nativeId &&
            literal.name === name && literal.value === value
          ).length === 1;
        if (
          activationCandidate.requiredAuthority !== undefined &&
            !matchesLiteral(
              "requiredAuthority",
              activationCandidate.requiredAuthority,
            ) ||
          activationCandidate.proposedConfigurationRevision !== undefined &&
            !matchesLiteral(
              "configurationRevision",
              String(activationCandidate.proposedConfigurationRevision),
            )
        ) fail("REFUSED", "ACTIVATION_NATIVE_BINDING_MISMATCH");
      }
      const beforeOthers = base.catalog.filter((entry) =>
        entry.candidateId !== approval.candidateId
      );
      const afterOthers = next.catalog.filter((entry) =>
        entry.candidateId !== approval.candidateId
      );
      if (canonical(beforeOthers) !== canonical(afterOthers)) {
        fail("REFUSED", "ACTIVATION_CATALOG_SCOPE");
      }
    } else {
      if (!change || change.status !== "approved" || !change.diff) {
        fail("NEEDS_DECISION", "DURABLE_CHANGE_MISSING");
      }
      // The previous guard establishes both values; keep explicit locals so
      // callbacks below cannot loosen TypeScript's narrowing.
      const durableChange = change!;
      const displayed = durableChange.diff!;
      try {
        assertPublicationMatches(durableChange, approval);
        assertChangeAuthorityReceipt(
          base,
          durableChange,
          mainCreationScope(base.identity),
        );
        assertApprovable(
          base,
          durableChange,
          mainCreationScope(base.identity),
        );
      } catch {
        fail("NEEDS_DECISION", "APPROVAL_AUTHORITY_INVALID");
      }
      if (
        displayed.base.repositoryVersion !== executionBase.version ||
        displayed.base.sourceDigest !== baseSourceDigest ||
        displayed.base.modelDigest !== base.version.digest ||
        displayed.sourceDigest !== candidateSourceDigest
      ) {
        fail("NEEDS_DECISION", "DISPLAYED_CHANGE_MISMATCH");
      }
      const actual = compareModelSources(
        executionBase.sources,
        candidate.sources,
      );
      if (
        canonical(actual.files) !== canonical(displayed.files) ||
        actual.patch !== displayed.patch ||
        actual.additions !== displayed.additions ||
        actual.deletions !== displayed.deletions
      ) {
        fail("NEEDS_DECISION", "DISPLAYED_CHANGE_MISMATCH");
      }
      if (
        next.configuration.revision !== base.configuration.revision + 1 ||
        next.configuration.builder.mandateRevision !==
          base.configuration.builder.mandateRevision + 1 ||
        next.configuration.id !== base.configuration.id ||
        next.identity.systemId !== base.identity.systemId
      ) {
        fail("REFUSED", "CHANGE_EFFECT_MISMATCH");
      }
      if (
        durableChange.kind === "operator-creation" && durableChange.operator &&
        !isTeamOperatorSpec(durableChange.operator)
      ) {
        const spec = durableChange.operator;
        if (
          spec.creationGrant &&
          (durableChange.authority !== "human" ||
            durableChange.authorityExercise?.creationDelegation ||
            durableChange.authorityExercise?.delegation)
        ) {
          fail("REFUSED", "INITIAL_CREATION_GRANT_REQUIRES_HUMAN");
        }
        const childScope = await requestOperatorSystemName(
          base.identity.systemQualifiedName ?? "ASELiveBuilder::liveBuilder",
          durableChange.id,
        );
        const child = await this.compilation.compile(
          candidate,
          this.projectId,
          childScope,
        );
        if (!exactChildCreationGrant(child, spec.creationGrant)) {
          fail("REFUSED", "INITIAL_CREATION_GRANT_MISMATCH");
        }
      }
      if (
        durableChange.kind === "operator-creation" && durableChange.operator &&
        isTeamOperatorSpec(durableChange.operator)
      ) {
        if (
          !durableChange.teamOrigin ||
          durableChange.requestedBy !== base.identity.builderId ||
          durableChange.teamOrigin.requestId !== durableChange.caseId
        ) {
          fail("REFUSED", "TEAM_ORIGIN_MISMATCH");
        }
        // The persisted change is unvalidated here: a pre-E2 team spec has
        // no provision. Refuse it with a code, never read through it.
        const spec: TeamOperatorSpec = (() => {
          try {
            const validated = validateOperatorCreationSpec(
              durableChange.operator,
            );
            if (!isTeamOperatorSpec(validated)) {
              throw new Error("not a team spec");
            }
            return validated;
          } catch {
            return fail("REFUSED", "TEAM_CREATION_SPEC_INVALID");
          }
        })();
        const scope = base.identity.systemQualifiedName ??
          "ASELiveBuilder::liveBuilder";
        const childScope = await requestOperatorSystemName(
          scope,
          durableChange.id,
        );
        const child = await this.compilation.compile(
          candidate,
          this.projectId,
          childScope,
        );
        if (
          !child.operatorTeam ||
          child.operatorTeam.parentOperatorId !== base.identity.builderId ||
          child.operatorTeam.requestOwnerId !==
            durableChange.teamOrigin!.operatorId ||
          child.operatorTeam.requestId !==
            durableChange.teamOrigin!.requestId ||
          child.caseTypes?.length ||
          child.operatorEntries?.filter((entry) => entry.kind === "inbox")
              .length !== 1 ||
          child.operator?.instruction !== spec.instruction ||
          !matchesTeamProvision(child, spec.provision)
        ) {
          fail("REFUSED", "TEAM_CREATION_EFFECT_MISMATCH");
        }
        const inbox = child.operatorEntries!.find((entry) =>
          entry.kind === "inbox"
        )!;
        if (
          next.behaviors?.filter((behavior) =>
            behavior.targetNativeId === inbox.id &&
            behavior.callerNativeId === base.identity.builderId
          ).length !== 1
        ) {
          fail("REFUSED", "TEAM_CREATION_EXPOSURE_MISMATCH");
        }
        const delegation = durableChange.authorityExercise?.creationDelegation;
        if (delegation) {
          const beforePolicy = base.operatorCreationPolicies?.find((policy) =>
            policy.id === delegation.policyId
          );
          const afterPolicy = next.operatorCreationPolicies?.find((policy) =>
            policy.id === delegation.policyId
          );
          if (
            !beforePolicy || !afterPolicy ||
            afterPolicy.children.length !== beforePolicy.children.length + 1 ||
            !afterPolicy.children.includes(child.identity.systemId) ||
            child.operatorTeam!.creationPolicyId !== beforePolicy.id
          ) {
            fail("REFUSED", "TEAM_CREATION_CAPACITY_MISMATCH");
          }
        }
        const parentPolicy = assertCreationWithinPolicy(
          base,
          spec,
          delegation,
          mainCreationScope(base.identity),
        );
        if (
          !exactChildCreationGrant(
            child,
            spec.creationGrant,
            parentPolicy.elementId,
          )
        ) {
          fail("REFUSED", "TEAM_CREATION_GRANT_MISMATCH");
        }
      }
      if (durableChange.kind === "mandate-change") {
        const rights = durableChange.requestedRights;
        if (!rights) return fail("REFUSED", "CHANGE_EFFECT_MISMATCH");
        if (
          "addNetworkHosts" in rights &&
            canonical(next.configuration.network?.allowedHosts) !==
              canonical([
                ...(base.configuration.network?.allowedHosts ?? []),
                ...rights.addNetworkHosts,
              ]) ||
          "setUrlSelectionMode" in rights &&
            next.policy.urlSelectionMode !== rights.setUrlSelectionMode ||
          "mayAdmitOwnCandidates" in rights &&
            next.configuration.builder.admissionAuthority !== "builder"
        ) {
          fail("REFUSED", "CHANGE_EFFECT_MISMATCH");
        }
      } else if (
        durableChange.kind === "reviewer-creation" &&
        (next.configuration.reviewer?.id !== durableChange.id ||
          next.configuration.reviewer?.name !== durableChange.name ||
          next.configuration.builder.admissionAuthority !== "reviewer")
      ) {
        fail("REFUSED", "CHANGE_EFFECT_MISMATCH");
      }
    }
    return {
      checkedAt: new Date().toISOString(),
      executionBaseVersion: executionBase.version,
      scopeDigest: await canonicalDigest({
        approval,
        baseSourceDigest,
        candidateSourceDigest,
        edits,
        authorityDigest: base.version.digest,
        ...(activationCandidate ? { activationCandidate } : {}),
      }),
      authorityStillValid: true,
      preconditionsChecked: approval.type === "candidate-activation" ? 9 : 12,
      baseUnchanged: true,
    };
  }
}
