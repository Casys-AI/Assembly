import {
  type DelegatedActor,
  delegatedAuthorityExercise,
  validateOperatorAuthorityPolicyRequest,
} from "./operator-authority-policy.ts";
import { OperatorAuthorityError } from "../operator-authority-error.ts";
import {
  isTeamOperatorSpec,
  validateGrantModelEditing,
  validateOperatorCreationSpec,
} from "../operator-authority.ts";
import { type ExecutionSpaceRef, mainExecutionSpace } from "../authority.ts";
import {
  creationAuthorityExercise,
  type CreationScope,
  mainCreationScope,
  validateOperatorCreationPolicyRequest,
} from "./operator-creation-policy.ts";
/**
 * Admission rules used by APE 2.1 Proposal–Admission–Execution Separation
 * and 2.2 Fail-Closed Admission. These rules do not themselves execute effects.
 */
import type {
  AdmissionRecord,
  Candidate,
} from "../../work/records/candidates.ts";
import type {
  ChangeProposal,
  ChangeRequestOrigin,
  MandateRequestedRights,
  PendingChange,
} from "../records/pending-change.ts";
import type {
  ExecutionMandate,
  SystemConfiguration,
} from "../records/system-configuration.ts";
import {
  assertApprovable,
  ChangeApprovabilityError,
} from "./change-approvability.ts";
import type { ExecutableModel } from "../../model/execution/executable-model.ts";
import {
  AuthorityInvariantError,
  exerciseOwnerAuthority,
} from "../authority.ts";
import { TOOL_KINDS } from "../../shared-kernel/tool-kind.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import {
  delegatedCandidateAuthorityExercise,
  validateToolAdmissionPolicyRequest,
} from "./tool-admission-policy.ts";
import {
  MAX_NETWORK_HOST_ADDITIONS,
  networkScopeFor,
  validateNetworkScope,
} from "./network-policy.ts";

function validateRequestedRights(value: unknown): MandateRequestedRights {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 1
  ) throw new Error("Droits demandés hors du périmètre pris en charge.");
  if ("operatorCreation" in value) {
    return {
      operatorCreation: validateOperatorCreationPolicyRequest(
        value.operatorCreation,
      ),
    };
  }
  if ("toolAdmission" in value) {
    return {
      toolAdmission: validateToolAdmissionPolicyRequest(value.toolAdmission),
    };
  }
  if ("operatorAuthority" in value) {
    return {
      operatorAuthority: validateOperatorAuthorityPolicyRequest(
        value.operatorAuthority,
      ),
    };
  }
  if ("grantModelEditing" in value) {
    return {
      grantModelEditing: validateGrantModelEditing(value.grantModelEditing),
    };
  }
  if (
    Object.hasOwn(value, "mayAdmitOwnCandidates") &&
    "mayAdmitOwnCandidates" in value && value.mayAdmitOwnCandidates === true
  ) return { mayAdmitOwnCandidates: true };
  if (Object.hasOwn(value, "addNetworkHosts") && "addNetworkHosts" in value) {
    const scope = validateNetworkScope({ allowedHosts: value.addNetworkHosts });
    if (
      scope.allowedHosts.length < 1 ||
      scope.allowedHosts.length > MAX_NETWORK_HOST_ADDITIONS
    ) throw new Error("Une révision réseau doit ajouter entre 1 et 8 hôtes.");
    return { addNetworkHosts: scope.allowedHosts };
  }
  if (
    "setUrlSelectionMode" in value &&
    (value.setUrlSelectionMode === "authorized-host" ||
      value.setUrlSelectionMode === "user-provided")
  ) {
    return { setUrlSelectionMode: value.setUrlSelectionMode };
  }
  throw new Error("Droits demandés hors du périmètre pris en charge.");
}

export class ChangeScopeMissingError extends Error {
  readonly code = "CHANGE_SCOPE_MISSING";
  readonly recovery = { action: "restore-recorded-scope" } as const;
  constructor(readonly context: { changeId: string }) {
    super("Une évolution exige une origine exclusive et son requérant.");
    this.name = "ChangeScopeMissingError";
  }
}

export class ChangePendingError extends Error {
  readonly code = "CHANGE_PENDING";
  readonly recovery = { action: "await-decision" } as const;
  constructor(
    readonly context: {
      requestedBy?: string;
      changeId: string;
      caseId?: string;
      designerScopeId?: string;
    },
  ) {
    super("Une évolution attend déjà une décision explicite.");
    this.name = "ChangePendingError";
  }
}

export class DuplicateOperatorCreationError extends Error {
  readonly code = "OPERATOR_CREATION_DUPLICATE";
  readonly recovery = { action: "use-existing-or-await-creation" } as const;
  constructor(
    readonly context: { caseId: string; changeId: string; status: string },
  ) {
    super(
      "A teammate with this instruction and provision already exists or is pending in this Case.",
    );
    this.name = "DuplicateOperatorCreationError";
  }
}

/** Compiled SysML supplies authority; runtime changes are admission audit records. */
export class SystemGovernance {
  private constructor(
    private readonly value: SystemConfiguration,
    private readonly model?: ExecutableModel,
    private readonly creationScope?: CreationScope,
  ) {}

  /** Creation reads use the scope the host states for its runtime; a
   * governance restored without one is main-only (its model states it). */
  #scope(): CreationScope {
    return this.creationScope ?? mainCreationScope(this.model!.identity);
  }

  static fromExecutable(
    model: ExecutableModel,
    changes: PendingChange[] = [],
    creationScope?: CreationScope,
  ): SystemGovernance {
    return SystemGovernance.restoreConfiguration(
      {
        ...structuredClone(model.configuration),
        changes: structuredClone(changes),
      },
      structuredClone(model),
      creationScope,
    );
  }

  static fresh(id: string = crypto.randomUUID()): SystemGovernance {
    return new SystemGovernance({
      id,
      envelope: {
        kind: "conversational-case-management",
        pattern: "1.3",
        revision: 1,
      },
      revision: 0,
      network: { allowedHosts: [] },
      builder: {
        id: "builder",
        mandateRevision: 1,
        admissionAuthority: "human",
      },
      changes: [],
    });
  }

  /** Compatibility with the former fixed reviewer host policy, never a fresh-system default. */
  static importLegacy(id: string, reviewerId: string): SystemGovernance {
    const configuration = SystemGovernance.fresh(id).snapshot;
    configuration.network = networkScopeFor();
    if (reviewerId) {
      configuration.builder.admissionAuthority = "reviewer";
      configuration.reviewer = {
        id: reviewerId,
        name: "Reviewer existant",
        mandateRevision: 1,
      };
    }
    return new SystemGovernance(configuration);
  }

  static restore(value: SystemConfiguration): SystemGovernance {
    return SystemGovernance.restoreConfiguration(value);
  }

  private static restoreConfiguration(
    value: SystemConfiguration,
    model?: ExecutableModel,
    creationScope?: CreationScope,
  ): SystemGovernance {
    const network = model
      ? validateNetworkScope(value.network)
      : networkScopeFor(value);
    if (
      value.envelope?.kind !== "conversational-case-management" ||
      value.envelope.pattern !== "1.3" || value.envelope.revision !== 1 ||
      !value.id || !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Number.isSafeInteger(value.builder.mandateRevision) ||
      value.builder.mandateRevision < 1 ||
      !["human", "builder", "reviewer"].includes(
        value.builder.admissionAuthority,
      ) ||
      (value.builder.admissionAuthority === "reviewer") !== !!value.reviewer
    ) throw new Error("Configuration d’autorité incohérente.");
    if (
      !model && value.builder.admissionAuthority === "builder" &&
      !value.changes.some((c) =>
        c.kind === "mandate-change" && c.status === "approved" &&
        c.authority === "human" && c.requestedRights &&
        "mayAdmitOwnCandidates" in c.requestedRights &&
        c.requestedRights.mayAdmitOwnCandidates === true
      )
    ) {
      throw new Error(
        "L’auto-admission exige une révision de mandat approuvée.",
      );
    }
    for (const change of value.changes) {
      if (change.kind === "mandate-change") {
        validateRequestedRights(change.requestedRights);
      }
    }
    return new SystemGovernance(
      { ...structuredClone(value), network },
      model,
      creationScope,
    );
  }

  get snapshot(): SystemConfiguration {
    return structuredClone(this.value);
  }

  get builderMandate(): ExecutionMandate {
    if (this.model) return structuredClone(this.model.mandate);
    const builder = this.value.builder;
    return {
      id: `builder-v${builder.mandateRevision}`,
      mayPropose: [...TOOL_KINDS],
      mayInvoke: "active-catalog-only",
      mayReview: false,
      mayAdmitOwnCandidates: builder.admissionAuthority === "builder",
      mayActivate: false,
      mayChangeOwnMandate: false,
      network: networkScopeFor(this.value),
      supportedChanges: [
        {
          kind: "propose_mandate_change",
          requestedRights: "addNetworkHosts",
          description:
            "Propose adding 1–8 exact canonical public DNS hosts to allowedHosts. The human must approve this exact scope before invocation resumes; wildcards, IPs and private hosts are forbidden.",
        },
        ...(builder.admissionAuthority === "human"
          ? [{
            kind: "propose_mandate_change" as const,
            requestedRights: "mayAdmitOwnCandidates" as const,
            description:
              "Propose admission of the builder’s own tested exact candidates, subject to a separate human mandate decision.",
          }]
          : []),
      ],
    };
  }

  propose(
    decision: ChangeProposal,
    id: string,
    at: string,
    origin?: ChangeRequestOrigin,
  ): PendingChange {
    if (
      !origin?.requestedBy || (!!origin.caseId === !!origin.designerScopeId)
    ) {
      throw new ChangeScopeMissingError({ changeId: id });
    }
    if (
      origin.caseId && decision.kind === "propose_agent_creation" &&
      decision.role === "operator" && isTeamOperatorSpec(decision.operator)
    ) {
      const spec = validateOperatorCreationSpec(
        decision.operator,
      ) as typeof decision.operator;
      const duplicate = this.value.changes.find((change) =>
        change.kind === "operator-creation" &&
        (change.status === "pending" || change.status === "approved") &&
        change.caseId === origin.caseId && change.operator &&
        isTeamOperatorSpec(change.operator) &&
        change.operator.instruction === spec.instruction &&
        canonical(change.operator.provision) ===
          canonical(spec.provision)
      );
      if (duplicate) {
        throw new DuplicateOperatorCreationError({
          caseId: origin.caseId,
          changeId: duplicate.id,
          status: duplicate.status,
        });
      }
    }
    // A published change is decided and merely completing its receipt; only
    // an undecided pending proposal blocks the next one.
    const pending = this.value.changes.find((c) =>
      c.status === "pending" && !c.publishedCommit
    );
    if (pending) {
      throw new ChangePendingError({
        ...(pending.requestedBy ? { requestedBy: pending.requestedBy } : {}),
        changeId: pending.id,
        ...(pending.caseId ? { caseId: pending.caseId } : {}),
        ...(pending.designerScopeId
          ? { designerScopeId: pending.designerScopeId }
          : {}),
      });
    }
    if (!decision.reason.trim() || decision.reason.length > 2000) {
      throw new Error("L’évolution doit présenter une justification courte.");
    }
    if (this.model) assertApprovable(this.model, decision, this.#scope());
    const kind = decision.kind === "propose_mandate_change"
      ? "mandate-change"
      : decision.role === "operator"
      ? "operator-creation"
      : "reviewer-creation";
    if (kind === "mandate-change") {
      const rights = validateRequestedRights(
        (decision as Extract<
          ChangeProposal,
          { kind: "propose_mandate_change" }
        >)
          .requestedRights,
      );
      if (!this.model) this.validateAvailableRights(rights);
    } else if (
      decision.kind === "propose_agent_creation" && decision.role === "operator"
    ) {
      if (!this.model) {
        throw new ChangeApprovabilityError(
          "PROPOSAL_NOT_AUTHORIZED",
          "Operator creation requires an executable model",
          { systemId: this.value.id, changeId: id },
        );
      }
      validateOperatorCreationSpec(decision.operator);
    } else {
      const request = decision as Extract<
        ChangeProposal,
        { kind: "propose_agent_creation"; role: "reviewer" }
      >;
      if (
        (!this.model && this.value.reviewer) ||
        (this.model && !this.model.policy.mayCreateReviewer)
      ) {
        throw new AuthorityInvariantError(
          3,
          "PROPOSAL_NOT_AUTHORIZED",
          "Le mandat actuel ne permet pas cette création d’agent.",
        );
      }
      if (
        request.role !== "reviewer" || !request.name.trim() ||
        request.name.length > 80 || !request.mandate ||
        Object.keys(request.mandate).length !== 2 ||
        request.mandate.mayReviewExactCandidate !== true ||
        request.mandate.mayAdmitReviewedCandidates !== true
      ) {
        throw new Error(
          "Le reviewer demandé dépasse le mandat pris en charge.",
        );
      }
    }
    const change: PendingChange = {
      ...structuredClone(origin),
      id,
      kind,
      status: "pending",
      baseRevision: this.value.revision,
      ...(this.model ? { baseModelDigest: this.model.version.digest } : {}),
      requestedAt: at,
      reason: decision.reason.trim(),
      ...(decision.kind === "propose_agent_creation"
        ? {
          name: decision.name.trim(),
          role: decision.role,
          ...(decision.role === "operator"
            ? { operator: validateOperatorCreationSpec(decision.operator) }
            : { mandate: structuredClone(decision.mandate) }),
        }
        : { requestedRights: structuredClone(decision.requestedRights) }),
    };
    if (this.model) assertApprovable(this.model, change, this.#scope());
    this.value.changes.push(change);
    return structuredClone(change);
  }

  /** Records the explicit decision. Compiled-model authority changes only after native
   * source application and recompilation. Legacy host mutation is deprecated.
   */
  /** `crossing`: a delegated decision taken across an opening (4.8c) reads the
   * decider's policy model in its own space; the change stays in this model. */
  decideChange(
    id: string,
    expectedRevision: number,
    approve: boolean,
    at: string,
    delegated?: DelegatedActor,
    crossing?: {
      policyModel: ExecutableModel;
      space: ExecutionSpaceRef;
      targetSpace: ExecutionSpaceRef;
    },
  ): PendingChange {
    if (delegated && !this.model) {
      throw new OperatorAuthorityError(
        "AUTHORITY_POLICY_FORBIDDEN",
        "Delegated decisions require a current native model",
      );
    }
    const change = this.value.changes.find((c) => c.id === id);
    if (!change || change.status !== "pending") {
      if (change?.status === "superseded") {
        throw new ChangeApprovabilityError(
          "SUPERSEDED_PROPOSAL",
          "Cette proposition a été supplantée par une adoption plus récente ; dépose une nouvelle proposition.",
          {
            systemId: this.model?.identity.systemId ?? this.value.id,
            changeId: change.id,
            baseRevision: change.baseRevision,
            modelDigest: this.model?.version.digest,
          },
        );
      }
      throw new Error("Cette évolution n’attend pas de décision.");
    }
    if (
      (approve || delegated) &&
      (!change.requestedBy || (!!change.caseId === !!change.designerScopeId))
    ) {
      throw new ChangeScopeMissingError({ changeId: change.id });
    }
    if (
      (approve || delegated) && (expectedRevision !== this.value.revision ||
        change.baseRevision !== expectedRevision)
    ) {
      throw new ChangeApprovabilityError(
        "STALE_PROPOSAL",
        "La configuration a changé ; recharge la proposition.",
        {
          systemId: this.model?.identity.systemId ?? this.value.id,
          changeId: change.id,
          baseRevision: change.baseRevision,
          modelDigest: this.model?.version.digest,
        },
      );
    }
    const rights = change.kind === "mandate-change"
      ? validateRequestedRights(change.requestedRights)
      : undefined;
    if (approve || delegated) {
      if (this.model) assertApprovable(this.model, change, this.#scope());
      else if (rights) this.validateAvailableRights(rights);
    }
    if (this.model) {
      // A host-bound delegated decision is in-space (main's own policies)
      // unless it crosses a verified opening.
      const space = mainExecutionSpace(this.model.identity);
      change.authorityExercise = delegated
        ? change.kind === "operator-creation" && !crossing
          ? creationAuthorityExercise(
            this.model,
            change,
            delegated,
            this.#scope(),
          )
          : delegatedAuthorityExercise({
            target: this.model,
            targetSpace: crossing?.targetSpace ?? space,
            policyModel: crossing?.policyModel ?? this.model,
            space: crossing?.space ?? space,
            change,
            command: delegated,
          })
        : exerciseOwnerAuthority(
          this.model,
          "mandate-change",
        );
    }
    change.status = approve ? "approved" : "refused";
    change.authority = delegated ? "builder" : "human";
    change.decidedAt = at;
    if (this.model) return structuredClone(change);
    if (approve) {
      this.value.builder.mandateRevision++;
      if (change.kind === "mandate-change") {
        if (rights && "addNetworkHosts" in rights) {
          this.value.network = validateNetworkScope({
            allowedHosts: [
              ...networkScopeFor(this.value).allowedHosts,
              ...rights.addNetworkHosts,
            ],
          });
        } else {
          this.value.builder.admissionAuthority = "builder";
        }
      } else {
        this.value.reviewer = {
          id: change.id,
          name: change.name!,
          mandateRevision: 1,
        };
        this.value.builder.admissionAuthority = "reviewer";
      }
    }
    this.value.revision++;
    return structuredClone(change);
  }

  private validateAvailableRights(rights: MandateRequestedRights): void {
    if (
      "operatorCreation" in rights || "operatorAuthority" in rights ||
      "toolAdmission" in rights
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_POLICY_FORBIDDEN",
        "Operator authority requires an executable model",
      );
    }
    if ("grantModelEditing" in rights) {
      if (!this.model) {
        throw new ChangeApprovabilityError(
          "PROPOSAL_NOT_AUTHORIZED",
          "Model editing grants require an executable model",
          { systemId: this.value.id },
        );
      }
      return;
    }
    if ("setUrlSelectionMode" in rights) {
      if (!this.model) {
        throw new Error("Cette évolution exige un modèle exécutable.");
      }
      return;
    }
    if ("mayAdmitOwnCandidates" in rights) {
      if (!this.model && this.value.builder.admissionAuthority !== "human") {
        throw new Error("Le mandat d’auto-admission a déjà été révisé.");
      }
      return;
    }
    const current = networkScopeFor(this.value).allowedHosts;
    if (rights.addNetworkHosts.some((host) => current.includes(host))) {
      throw new Error("Un hôte demandé appartient déjà au mandat actuel.");
    }
    validateNetworkScope({
      allowedHosts: [...current, ...rights.addNetworkHosts],
    });
  }

  admission(
    candidate: Candidate,
    authority: AdmissionRecord["authority"],
    reason: string,
    at: string,
  ): AdmissionRecord {
    const delegated = candidate.admissionDecision?.authorityExercise
      ?.candidateDelegation;
    if (delegated && authority !== "delegate") {
      throw new Error(
        "A delegated candidate decision cannot become a human or builder admission.",
      );
    }
    let delegatedExercise:
      | import("../authority.ts").AuthorityExercise
      | undefined;
    if (authority === "delegate") {
      if (!this.model || !delegated) {
        throw new Error(
          "Delegated admission requires a host-bound exact decision.",
        );
      }
      delegatedExercise = delegatedCandidateAuthorityExercise(
        this.model,
        candidate,
        delegated,
        mainExecutionSpace(this.model.identity),
      );
      if (
        candidate.admissionDecision?.verdict !== "approve" ||
        canonical(candidate.admissionDecision.authorityExercise) !==
          canonical(delegatedExercise)
      ) {
        throw new Error(
          "The delegated decision no longer matches this candidate.",
        );
      }
    }
    if (
      authority !== "delegate" && authority !==
        (candidate.requiredAuthority ?? this.value.builder.admissionAuthority)
    ) {
      throw new Error(
        "L’opérateur ne détient pas le mandat d’admission actuel.",
      );
    }
    if (
      !this.model && (
        !candidate.tests?.passed || !candidate.tests.checks.length ||
        candidate.tests.checks.some((c) => !c.passed)
      )
    ) throw new Error("Tous les essais doivent réussir avant admission.");
    if (
      !this.model && authority === "human" &&
      candidate.stage !== "awaiting-admission"
    ) {
      throw new Error("Ce candidat n’attend pas d’admission humaine.");
    }
    if (
      authority === "reviewer" && (
        (!this.model && candidate.review?.verdict !== "approve") ||
        candidate.review?.candidateDigest !== candidate.digest
      )
    ) throw new Error("L’admission exige la revue du candidat exact.");
    if (
      authority !== "human" &&
      candidate.proposedConfigurationRevision !== undefined &&
      candidate.proposedConfigurationRevision !== this.value.revision
    ) {
      throw new Error("Le mandat a changé depuis la proposition du candidat.");
    }
    if (
      authority === "builder" && (
        !this.builderMandate.mayAdmitOwnCandidates ||
        (!this.model && candidate.admissionDecision?.verdict !== "approve") ||
        candidate.admissionDecision?.candidateDigest !== candidate.digest
      )
    ) {
      throw new Error(
        "L’admission exige la décision du constructeur sur le candidat exact.",
      );
    }
    if (!reason.trim()) throw new Error("La décision doit être justifiée.");
    return {
      ...(delegatedExercise
        ? { authorityExercise: delegatedExercise }
        : authority === "human" && this.model
        ? {
          authorityExercise: exerciseOwnerAuthority(
            this.model,
            "candidate-admission",
          ),
        }
        : {}),
      candidateId: candidate.id,
      mandateRevision: authority === "reviewer"
        ? this.value.reviewer!.mandateRevision
        : this.value.builder.mandateRevision,
      authority,
      actorId: delegatedExercise
        ? delegatedExercise.candidateDelegation!.actorId
        : authority === "reviewer"
        ? this.value.reviewer!.id
        : authority,
      candidateDigest: candidate.digest,
      configurationRevision: this.value.revision,
      reason: reason.trim(),
      at,
    };
  }
}
