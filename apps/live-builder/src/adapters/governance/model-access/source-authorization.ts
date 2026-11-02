import { persistedOrder } from "../../../domain/primitives/persisted-order.ts";
import { OWNER_AUTHORITY_IDENTITY_FIELDS as ownerIdentityFields } from "../../../domain/governance/authority.ts";
/** APE 4.1 Operator Identity & Mandate: check every source effect before publication. */
import type { ModelSourceAuthorizationPort } from "../../../application/governance/ports/out/model-source-authorization.port.ts";
import type { ModelToolingPort } from "../../../application/model/tooling.ts";
import { ModelRepositoryError } from "../../../application/model/repository.ts";
import type { ModelProposalAuthorization } from "../../../domain/governance/records/model-edit-authorization.ts";
import type { ModelEditOperation } from "../../../domain/governance/policies/model-edit-policy.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  type AuthorityExercise,
  AuthorityInvariantError,
  ownerAuthorityFor,
} from "../../../domain/governance/authority.ts";
import { modelToolingTarget } from "../../model/sources/editing/tooling.ts";
import { assertModelEditScope } from "./editing/scope.ts";
import { MODEL_DELEGATIONS_FILE } from "./delegation/ledger.ts";
import { validateModelAdministration } from "./administration/operations.ts";
import { validateEvolutionSourceAuthorization } from "./evolution/source-authorization.ts";
import {
  discoverConversationUnits,
  type SourceRevision,
  validateSourceExecutable,
} from "../../model/sources/source-model.ts";

type OperatorAuthorization = Extract<
  ModelProposalAuthorization,
  { kind: "operator" }
>;

function requireEdit(value: unknown, message: string): asserts value {
  if (!value) throw new ModelRepositoryError("EDIT_SCOPE_DENIED", message);
}

/** Trusted composition captures the principal; request JSON never supplies these rights. */
export async function createOperatorEditAuthorization(
  model: ExecutableModel,
  revision: SourceRevision,
  operations: readonly ModelEditOperation[],
): Promise<OperatorAuthorization> {
  const policy = model.modelEditPolicy;
  requireEdit(
    model.policy.mayProposeSysmlRevision === true && policy,
    "Le mandat courant ne délègue aucun périmètre d’édition SysML.",
  );
  requireEdit(
    policy.holderNativeId === model.identity.builderId,
    "Le titulaire de la politique d’édition ne correspond pas à l’opérateur.",
  );
  requireEdit(
    operations.length > 0 &&
      operations.every((operation) => policy.operations.includes(operation)),
    "Cette opération d’édition n’est pas autorisée par le mandat courant.",
  );
  const systemQualifiedName =
    modelToolingTarget(revision, model.identity.systemId).qualifiedName;
  const operatorQualifiedName =
    modelToolingTarget(revision, policy.holderNativeId).qualifiedName;
  const policyDigest = await executionDigest({
    systemQualifiedName,
    operatorQualifiedName,
    id: policy.id,
    revision: policy.revision,
    mandateId: policy.mandateId,
    mandateRevision: policy.mandateRevision,
    operations: policy.operations,
    grants: policy.grants,
    ...(policy.rootAuthority ? { rootAuthority: policy.rootAuthority } : {}),
    ...(policy.delegationDigest
      ? { delegationDigest: policy.delegationDigest }
      : {}),
  });
  return {
    kind: "operator",
    systemQualifiedName,
    operatorQualifiedName,
    operatorNativeId: policy.holderNativeId,
    mandateId: policy.mandateId,
    mandateRevision: policy.mandateRevision,
    policyId: policy.id,
    policyRevision: policy.revision,
    policyDigest,
    operations: [...new Set(operations)].sort(),
  };
}

/** The existing execution digest includes resolved mandates, controls and flows.
 * Comparing it is deliberately conservative: delegated edits cannot change executable
 * authority. Operational catalog state is checked separately because its digest is excluded.
 * Native identity churn may require resubmission; it must never relax this check.
 */
async function protectedAuthority(revision: SourceRevision, projectId: string) {
  const units = discoverConversationUnits(revision, projectId);
  const signatures = [];
  for (const unit of units) {
    const model = await validateSourceExecutable(
      revision,
      projectId,
      unit.systemQualifiedName,
    );
    signatures.push({
      system: unit.systemQualifiedName,
      digest: model.version.digest,
      catalog: model.catalog,
    });
  }
  return signatures.sort((a, b) => persistedOrder(a.system, b.system));
}

export class NativeModelSourceAuthorization
  implements ModelSourceAuthorizationPort {
  constructor(
    readonly projectId: string,
    readonly tooling?: ModelToolingPort,
  ) {}
  async validateScopedSoftware(
    input: Parameters<ModelSourceAuthorizationPort["validate"]>[0],
    actor:
      import("../../../domain/model/execution/executable-model.ts").ExecutableModel,
  ): Promise<void> {
    try {
      if (
        input.phase !== "proposal" ||
        input.authorization?.kind !== "operator-evolution"
      ) {
        throw new Error(
          "Scoped software source validation requires the exact preparation act",
        );
      }
      await validateEvolutionSourceAuthorization(
        input,
        this.projectId,
        this.tooling,
        actor,
      );
    } catch (error) {
      throw new ModelRepositoryError(
        "EDIT_SCOPE_DENIED",
        error instanceof Error
          ? error.message
          : "Scoped evolution authority cannot be verified",
      );
    }
  }
  async validate(
    input: Parameters<ModelSourceAuthorizationPort["validate"]>[0],
  ): Promise<void> {
    const principal = input.authorization;
    if (principal?.kind === "operator-evolution") {
      try {
        await validateEvolutionSourceAuthorization(
          input,
          this.projectId,
          this.tooling,
        );
      } catch (error) {
        throw new ModelRepositoryError(
          "EDIT_SCOPE_DENIED",
          error instanceof Error
            ? error.message
            : "Evolution authority cannot be verified",
        );
      }
      return;
    }
    const exercise = principal?.kind === "local-owner"
      ? principal.authorityExercise
      : undefined;
    const recovery = input.phase === "proposal"
      ? exercise
      : input.decisionAuthorityExercise;
    if (principal?.kind === "local-owner" && recovery?.outOfMandate) {
      requireEdit(
        input.author === "local-owner",
        "Invalid local owner source authority",
      );
      if (recovery.authoritySchema !== 2 || !recovery.reason?.trim()) {
        throw new AuthorityInvariantError(3, "local-recovery-reason-required");
      }
      // The admitted model can be unusable: this explicit host-captured receipt
      // is the sole escape hatch, and only for a local owner's own proposal.
      return;
    }
    const units = discoverConversationUnits(input.authority, this.projectId);
    const models = new Map<string, ExecutableModel>();
    const currentModel = async (systemQualifiedName: string) => {
      let model = models.get(systemQualifiedName);
      if (!model) {
        model = await validateSourceExecutable(
          input.authority,
          this.projectId,
          systemQualifiedName,
        );
        models.set(systemQualifiedName, model);
      }
      return model;
    };
    const validateExercise = async (
      receipt: AuthorityExercise,
      strictDigest: boolean,
    ) => {
      const selected = units.find((unit) =>
        unit.identity.systemId === receipt.systemId
      );
      if (!selected) {
        throw new AuthorityInvariantError(1, "local-owner-system-missing");
      }
      const current = await currentModel(selected.systemQualifiedName);
      const owner = ownerAuthorityFor(current);
      if (
        receipt.authoritySchema !== 2 || receipt.action !== "model-revision" ||
        receipt.outOfMandate ||
        ownerIdentityFields.some((field) => receipt[field] !== owner[field]) ||
        (strictDigest && receipt.baseModelDigest !== current.version.digest)
      ) {
        throw new AuthorityInvariantError(3, "local-owner-authority-changed");
      }
      return current;
    };
    if (input.phase !== "proposal") {
      if (input.decisionAuthorityExercise) {
        await validateExercise(input.decisionAuthorityExercise, true);
      } else {
        for (const unit of units) {
          if (
            ownerAuthorityFor(await currentModel(unit.systemQualifiedName))
              .ownerSource === "modeled"
          ) {
            throw new AuthorityInvariantError(
              3,
              "local-owner-decision-exercise-required",
            );
          }
        }
      }
    }
    if (principal?.kind === "local-owner") {
      requireEdit(
        input.author === "local-owner",
        "Invalid local owner source authority",
      );
      if (exercise) {
        await validateExercise(exercise, input.phase === "proposal");
        if (input.before.version !== input.authority.version) {
          const baseUnits = discoverConversationUnits(
            input.before,
            this.projectId,
          );
          const baseUnit = baseUnits.find((unit) =>
            unit.identity.systemId === exercise.systemId
          );
          if (!baseUnit) {
            throw new AuthorityInvariantError(
              3,
              "local-owner-not-authorized-at-base",
            );
          }
          const baseModel = await validateSourceExecutable(
            input.before,
            this.projectId,
            baseUnit.systemQualifiedName,
          );
          const baseOwner = ownerAuthorityFor(baseModel);
          if (
            ownerIdentityFields.some((field) =>
              exercise[field] !== baseOwner[field]
            )
          ) {
            throw new AuthorityInvariantError(
              3,
              "local-owner-not-authorized-at-base",
            );
          }
        }
      } else {
        for (const unit of units) {
          if (
            ownerAuthorityFor(await currentModel(unit.systemQualifiedName))
              .ownerSource === "modeled"
          ) {
            throw new AuthorityInvariantError(
              3,
              "local-owner-exercise-required",
            );
          }
        }
      }
      const after = {
        ...input.after,
        version: "compiled-before-owner-admission",
      };
      const afterUnits = discoverConversationUnits(after, this.projectId);
      const requireRootAuthority = (
        systemId: string,
        reason = "local-owner-root-outside-authority",
      ) => {
        // A valid receipt for one system is not authority over another root.
        // Both the proposer and the admitting owner must cover the effect.
        if (
          exercise?.systemId !== systemId ||
          (input.phase !== "proposal" &&
            input.decisionAuthorityExercise?.systemId !== systemId)
        ) {
          throw new AuthorityInvariantError(3, reason);
        }
      };
      for (const unit of units) {
        const owner = ownerAuthorityFor(
          await currentModel(unit.systemQualifiedName),
        );
        const retained = afterUnits.some((entry) =>
          entry.systemQualifiedName === unit.systemQualifiedName
        );
        if (!retained) {
          if (owner.ownerSource === "modeled") {
            requireRootAuthority(owner.systemId);
          }
          continue;
        }
        const next = await validateSourceExecutable(
          after,
          this.projectId,
          unit.systemQualifiedName,
        );
        const nextOwner = ownerAuthorityFor(next);
        if (
          owner.ownerSource === "modeled" &&
          nextOwner.ownerSource !== "modeled"
        ) {
          throw new AuthorityInvariantError(
            1,
            "modeled-owner-cannot-become-implicit",
          );
        }
        if (canonical(owner) !== canonical(nextOwner)) {
          requireRootAuthority(owner.systemId);
        }
      }
      for (const unit of afterUnits) {
        if (
          units.some((entry) =>
            entry.systemQualifiedName === unit.systemQualifiedName
          )
        ) continue;
        const next = await validateSourceExecutable(
          after,
          this.projectId,
          unit.systemQualifiedName,
        );
        if (ownerAuthorityFor(next).ownerSource === "modeled") {
          // A new root (including a renamed system with a new native ID) has
          // no grant in the prior state. Lot 1 requires explicit recovery.
          // The named teammate of a person's team decision is the exception:
          // authority over its parent covers it (4.8e).
          const parent = unit.systemQualifiedName === input.teamCreationRoot &&
              next.operatorTeam
            ? units.find((entry) =>
              entry.identity.builderId === next.operatorTeam!.parentOperatorId
            )
            : undefined;
          requireRootAuthority(
            parent?.identity.systemId ?? next.identity.systemId,
            "modeled-root-recreation-requires-recovery",
          );
        }
      }
      return;
    }
    if (principal?.kind === "operator-administration") {
      try {
        await validateModelAdministration({
          ...input,
          authorization: principal,
        }, this.projectId);
      } catch (error) {
        if (error instanceof AuthorityInvariantError) throw error;
        throw new ModelRepositoryError(
          "EDIT_SCOPE_DENIED",
          error instanceof Error
            ? error.message
            : "Administration invérifiable.",
        );
      }
      return;
    }
    requireEdit(
      principal?.kind === "operator",
      "Une identité d’édition explicite est requise.",
    );
    requireEdit(
      input.author === `agent:${principal.operatorNativeId}`,
      "L’auteur de la proposition ne correspond pas à son opérateur.",
    );
    try {
      const current = await validateSourceExecutable(
        input.authority,
        this.projectId,
        principal.systemQualifiedName,
      );
      if (!current.modelEditPolicy || !current.policy.mayProposeSysmlRevision) {
        throw new AuthorityInvariantError(
          3,
          "model-edit-not-authorized-at-base",
        );
      }
      const expected = await createOperatorEditAuthorization(
        current,
        input.authority,
        principal.operations,
      );
      if (input.before.version !== input.authority.version) {
        try {
          const prior = await validateSourceExecutable(
            input.before,
            this.projectId,
            principal.systemQualifiedName,
          );
          const priorExpected = await createOperatorEditAuthorization(
            prior,
            input.before,
            principal.operations,
          );
          if (canonical(priorExpected) !== canonical(principal)) {
            throw new AuthorityInvariantError(
              3,
              "model-edit-not-authorized-at-base",
            );
          }
        } catch (error) {
          if (error instanceof AuthorityInvariantError) throw error;
          throw new AuthorityInvariantError(
            3,
            "model-edit-not-authorized-at-base",
          );
        }
      }
      if (canonical(expected) !== canonical(principal)) {
        throw new AuthorityInvariantError(3, "model-edit-authority-changed");
      }
      const after: SourceRevision = {
        ...input.after,
        version: "compiled-before-scope-admission",
      };
      requireEdit(
        input.before.sources[MODEL_DELEGATIONS_FILE] ===
          after.sources[MODEL_DELEGATIONS_FILE],
        "Le registre de délégation exige une opération d’administration dédiée.",
      );
      assertModelEditScope(
        input.before,
        after,
        current.modelEditPolicy!.grants,
      );
      requireEdit(
        canonical(await protectedAuthority(input.before, this.projectId)) ===
          canonical(await protectedAuthority(after, this.projectId)),
        "Une édition déléguée ne peut modifier les mandats, contrôles d’exécution ou capacités admises.",
      );
    } catch (error) {
      if (error instanceof AuthorityInvariantError) throw error;
      if (
        error instanceof ModelRepositoryError &&
        error.code === "EDIT_SCOPE_DENIED"
      ) throw error;
      throw new ModelRepositoryError(
        "EDIT_SCOPE_DENIED",
        error instanceof Error
          ? error.message
          : "Périmètre d’édition invérifiable.",
      );
    }
  }
}
