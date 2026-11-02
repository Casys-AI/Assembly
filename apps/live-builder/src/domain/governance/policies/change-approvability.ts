import { assertToolAdmissionPolicyRequest } from "./tool-admission-policy.ts";
import {
  assertDelegatedAuthorityReceipt,
  assertOperatorPolicyRequest,
} from "./operator-authority-policy.ts";
import {
  assertGrantModelEditingScope,
  isTeamOperatorSpec,
  MAIN_EXECUTION_SPACE_ID,
  mainExecutionSpace,
  OperatorAuthorityError,
  validateGrantModelEditing,
  validateOperatorCreationSpec,
} from "../operator-authority.ts";
import {
  assertCreationAuthorityReceipt,
  assertCreationWithinPolicy,
  type CreationScope,
} from "./operator-creation-policy.ts";
import { characterCount } from "../../primitives/character-count.ts";
import {
  type ExecutableModel,
} from "../../model/execution/executable-model.ts";
import type { ChatDecision } from "../../work/dialogue.ts";
import type { PendingChange } from "../records/pending-change.ts";
import {
  type AuthorityExercise,
  AuthorityInvariantError,
  ownerAuthorityFor,
} from "../authority.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import {
  MAX_NETWORK_HOST_ADDITIONS,
  validateNetworkScope,
} from "./network-policy.ts";

type ChangeProposal = Extract<ChatDecision, {
  kind: "propose_mandate_change" | "propose_agent_creation";
}>;

type ApprovalModel =
  & Pick<ExecutableModel, "policy">
  & { configuration: Omit<ExecutableModel["configuration"], "changes"> }
  & Partial<
    Pick<
      ExecutableModel,
      | "operatorAuthorityPolicies"
      | "toolAdmissionPolicies"
      | "operatorCreationPolicies"
      | "ownerAuthority"
      | "identity"
      | "mandate"
      | "modelEditPolicy"
      | "modelEditingAuthorityRoots"
    >
  >
  & { version?: { digest: string } };

/** A deterministic refusal leaves an undecided proposal available for refusal. */
export class ChangeApprovabilityError extends AuthorityInvariantError {
  readonly recovery = { action: "refuse-and-repropose" } as const;
  constructor(
    reason: string,
    message: string,
    readonly context: {
      systemId: string;
      changeId?: string;
      baseRevision?: number;
      modelDigest?: string;
    },
  ) {
    super(3, reason, message);
    this.name = "ChangeApprovabilityError";
  }
}

/** Shared, effect-free publication preconditions, including current admission authority. */
export function assertApprovable(
  model: ApprovalModel,
  change: PendingChange | ChangeProposal,
  scope: CreationScope,
): void {
  const fail = (reason: string, message: string): never => {
    throw new ChangeApprovabilityError(reason, message, {
      systemId: model.identity?.systemId ?? model.configuration.id,
      ...("id" in change
        ? { changeId: change.id, baseRevision: change.baseRevision }
        : {}),
      modelDigest: model.version?.digest,
    });
  };
  if (
    "baseRevision" in change && (
      change.baseRevision !== model.configuration.revision ||
      change.baseModelDigest !== undefined &&
        change.baseModelDigest !== model.version?.digest ||
      model.ownerAuthority?.ownerSource === "modeled" && !change.baseModelDigest
    )
  ) {
    fail(
      "STALE_PROPOSAL",
      "Le contrat de base a changé ; une nouvelle proposition est requise.",
    );
  }
  if (
    change.kind === "mandate-change" || change.kind === "propose_mandate_change"
  ) {
    const rights = change.requestedRights;
    if (
      !rights || typeof rights !== "object" || Array.isArray(rights) ||
      Object.keys(rights).length !== 1
    ) {
      return fail(
        "PROPOSAL_NOT_AUTHORIZED",
        "Droits demandés hors du périmètre pris en charge.",
      );
    }
    if ("toolAdmission" in rights) {
      if (!model.identity) {
        return fail(
          "PROPOSAL_NOT_AUTHORIZED",
          "A native Main Operator identity is required",
        );
      }
      assertToolAdmissionPolicyRequest(
        { ...model, identity: model.identity },
        rights.toolAdmission,
      );
    } else if ("operatorAuthority" in rights) {
      if (!model.identity) {
        return fail(
          "PROPOSAL_NOT_AUTHORIZED",
          "A native Main Operator identity is required",
        );
      }
      assertOperatorPolicyRequest(
        { ...model, identity: model.identity },
        rights.operatorAuthority,
      );
    } else if ("grantModelEditing" in rights) {
      try {
        validateGrantModelEditing(rights.grantModelEditing);
      } catch (error) {
        fail(
          "PROPOSAL_NOT_AUTHORIZED",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (
        !model.policy.mayProposeSysmlRevision || model.modelEditPolicy
      ) {
        fail(
          "PROPOSAL_NOT_AUTHORIZED",
          "This operator cannot request a new model editing policy",
        );
      }
      if (model.identity) {
        assertGrantModelEditingScope(
          rights.grantModelEditing,
          // sourceModelIdentity omits the historical primary's default scope.
          model.identity.systemQualifiedName ?? "ASELiveBuilder::liveBuilder",
          model.modelEditingAuthorityRoots,
        );
      }
    } else if ("mayAdmitOwnCandidates" in rights) {
      if (
        rights.mayAdmitOwnCandidates !== true ||
        !model.policy.mayDelegateOwnAdmission ||
        model.configuration.builder.admissionAuthority !== "human"
      ) {
        fail(
          "PROPOSAL_NOT_AUTHORIZED",
          "Le modèle ne permet pas cette délégation d’admission : l’autorité doit encore être humaine.",
        );
      }
    } else if ("addNetworkHosts" in rights) {
      if (!model.policy.mayAddNetworkHosts) {
        fail(
          "PROPOSAL_NOT_AUTHORIZED",
          "Le modèle ne permet pas cette évolution réseau.",
        );
      }
      try {
        const additions =
          validateNetworkScope({ allowedHosts: rights.addNetworkHosts })
            .allowedHosts;
        const current = model.configuration.network?.allowedHosts ?? [];
        if (
          !additions.length || additions.length > MAX_NETWORK_HOST_ADDITIONS
        ) {
          throw new Error(
            "Une révision réseau doit ajouter entre 1 et 8 hôtes.",
          );
        }
        if (additions.some((host) => current.includes(host))) {
          throw new Error("Un hôte demandé appartient déjà au mandat actuel.");
        }
        validateNetworkScope({ allowedHosts: [...current, ...additions] });
      } catch (error) {
        fail(
          "PROPOSAL_NOT_AUTHORIZED",
          error instanceof Error ? error.message : "Portée réseau invalide.",
        );
      }
    } else if (
      !("setUrlSelectionMode" in rights) ||
      !model.policy.mayChangeUrlSelection ||
      !["user-provided", "authorized-host"].includes(rights.setUrlSelectionMode)
    ) {
      fail(
        "PROPOSAL_NOT_AUTHORIZED",
        "Le modèle ne permet pas cette évolution de sélection d’URL.",
      );
    }
  } else if (change.role === "operator") {
    if (
      !change.name?.trim() ||
      characterCount(change.name) > 80
    ) {
      fail(
        "PROPOSAL_NOT_AUTHORIZED",
        "The admitted creation policy does not authorize this operator request",
      );
    }
    try {
      const spec = validateOperatorCreationSpec(change.operator);
      if (isTeamOperatorSpec(spec) || !model.policy.mayCreateReviewer) {
        if (!model.identity || !model.mandate) {
          throw new Error(
            "The admitted creation policy does not authorize this operator request: a native creator identity and mandate are required",
          );
        }
        assertCreationWithinPolicy(
          { ...model, identity: model.identity, mandate: model.mandate },
          spec,
          undefined,
          scope,
        );
      }
    } catch (error) {
      fail(
        "PROPOSAL_NOT_AUTHORIZED",
        error instanceof Error ? error.message : String(error),
      );
    }
  } else if (
    !model.policy.mayCreateReviewer || model.configuration.reviewer ||
    change.role !== "reviewer" || !change.name?.trim() ||
    change.name.length > 80 ||
    !change.mandate || Object.keys(change.mandate).length !== 2 ||
    change.mandate.mayReviewExactCandidate !== true ||
    change.mandate.mayAdmitReviewedCandidates !== true
  ) {
    fail(
      "PROPOSAL_NOT_AUTHORIZED",
      "Le mandat actuel ne permet pas cette création d’agent.",
    );
  }
}

/** Compare the persisted receipt; recovery never issues or replaces a receipt.
 * A Main Operator's decision for a Branch Operator was checked against Main's
 * policy when it was recorded (4.8c A2); its branch publication carries that
 * record as `recorded` and is compared to it, never to Main's current policy. */
export function assertChangeAuthorityReceipt(
  model: ExecutableModel,
  change: PendingChange,
  scope: CreationScope,
  recorded?: { exercise: AuthorityExercise },
): void {
  if (change.authorityExercise?.creationDelegation) {
    assertCreationAuthorityReceipt(model, change, scope);
    return;
  }
  const delegation = change.authorityExercise?.delegation;
  if (
    delegation?.actor && delegation.requester &&
    delegation.actor.executionSpaceId !== delegation.requester.executionSpaceId
  ) {
    // A trust boundary: every field that names who decided what, for whom,
    // on which base, is bound here; the record only adds equality.
    const exercise = change.authorityExercise!;
    const { actor, requester } = delegation;
    if (
      !recorded || change.status !== "approved" ||
      change.authority !== "builder" || !change.decidedAt ||
      exercise.action !== "mandate-change" ||
      exercise.baseModelDigest !== model.version.digest ||
      change.baseModelDigest !== model.version.digest ||
      actor.executionSpaceId !== MAIN_EXECUTION_SPACE_ID ||
      actor.projectId !== model.identity.projectId ||
      // Main's policy belongs to its issuer's system; a branch member has
      // its own native system, bound separately by requester below.
      actor.systemId !== delegation.policyIssuer.systemId ||
      actor.operatorId !== delegation.actorId ||
      requester.projectId !== model.identity.projectId ||
      requester.systemId !== model.identity.systemId ||
      requester.operatorId !== model.identity.builderId ||
      change.requestedBy !== model.identity.builderId ||
      delegation.requestedBy !== change.requestedBy ||
      delegation.changeId !== change.id ||
      delegation.caseId !== change.caseId ||
      canonical(delegation.requestedRights) !==
        canonical(change.requestedRights) ||
      canonical(change.authorityExercise) !== canonical(recorded.exercise)
    ) {
      throw new OperatorAuthorityError(
        "AUTHORITY_RECEIPT_MISMATCH",
        "The delegated receipt does not match its recorded decision",
        { changeId: change.id },
      );
    }
    return;
  }
  if (change.authority === "builder" || delegation) {
    const space = mainExecutionSpace(model.identity);
    assertDelegatedAuthorityReceipt({
      target: model,
      targetSpace: space,
      policyModel: model,
      space,
      change,
    });
    return;
  }
  const receipt = change.authorityExercise;
  if (
    change.status !== "approved" || change.authority !== "human" ||
    !change.decidedAt ||
    model.ownerAuthority?.ownerSource === "modeled" &&
      (!receipt || !change.baseModelDigest) ||
    receipt && canonical(receipt) !== canonical({
          ...ownerAuthorityFor(model),
          authoritySchema: 2,
          action: "mandate-change",
          baseModelDigest: model.version.digest,
          outOfMandate: false,
        })
  ) {
    throw new ChangeApprovabilityError(
      "ADMISSION_NOT_AUTHORIZED",
      "Mandate approval must exercise the owner authority of the prior model",
      {
        systemId: model.identity.systemId,
        changeId: change.id,
        baseRevision: change.baseRevision,
        modelDigest: model.version.digest,
      },
    );
  }
}
