import { ModelRepositoryError } from "../../model/repository.ts";
import type { ModelProposalAuthorization } from "../../../domain/governance/records/model-edit-authorization.ts";
import type { ModelEditOperation } from "../../../domain/governance/policies/model-edit-policy.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SourceRevision } from "../../../domain/model/records/source-revision.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { modelToolingTarget } from "../../../domain/model/editing/source-index.ts";

type OperatorAuthorization = Extract<
  ModelProposalAuthorization,
  { kind: "operator" }
>;

export function requireEdit(value: unknown, message: string): asserts value {
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
