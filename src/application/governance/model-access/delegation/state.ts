/** APE 4.1 Operator Identity & Mandate: project only effective source-admitted rights. */
import type { ExecutableModel } from "../../../../domain/model/execution/executable-model.ts";
import { executionDigest } from "../../../../domain/primitives/execution-digest.ts";
import { resolveModelDelegations } from "../../../../domain/governance/model-access/model-delegation.ts";
import type {
  ModelDelegationIdentity,
  ModelRootAuthority,
} from "../../../../domain/governance/model-access/model-delegation.ts";
import { readModelDelegations } from "../../../../domain/governance/model-access/model-delegation-ledger.ts";
import type { SourceRevision } from "../../../../domain/model/records/source-revision.ts";
import { sourceSnapshot } from "../../../../domain/model/projections/source-facts.ts";
import { isNamespacePartOccurrence } from "../../../../domain/model/policies/model-occurrence.ts";
import {
  AuthorityInvariantError,
  ownerAuthorityFor,
} from "../../../../domain/governance/authority.ts";

export function delegationIdentity(
  systemQualifiedName: string,
  model: ExecutableModel,
  revision?: SourceRevision,
): ModelDelegationIdentity {
  let concrete = true;
  if (revision) {
    const snapshot = sourceSnapshot(revision.elements, model.identity.rootId);
    const byId = new Map(
      snapshot.elements.map((element) => [element.id, element]),
    );
    const singleton = (id: string): boolean => {
      let element = byId.get(id);
      const seen = new Set<string>();
      while (element && !/^(Library)?Package$/.test(element.metaclass)) {
        if (
          seen.has(element.id) ||
          !["", "1", "1..1"].includes(element.multiplicity) ||
          !["PartUsage", "ItemUsage"].includes(element.metaclass) ||
          (element.isReference &&
            !isNamespacePartOccurrence(element, byId.get(element.ownerId)))
        ) return false;
        seen.add(element.id);
        element = byId.get(element.ownerId);
      }
      return !!element;
    };
    const mandates = snapshot.elements.filter((element) =>
      element.qualifiedName === `${systemQualifiedName}::builderMandate`
    );
    concrete = singleton(model.identity.builderId) &&
      singleton(model.identity.systemId) &&
      mandates.length === 1 && singleton(mandates[0]!.id);
  }
  return {
    systemQualifiedName,
    holderNativeId: model.identity.builderId,
    mandateId: model.mandate.id,
    mandateRevision: model.configuration.builder.mandateRevision,
    mayProposeSysmlRevision: concrete &&
      model.policy.mayProposeSysmlRevision === true,
  };
}

/** Resolve all chains together, without recursive executable-model compilation. */
export async function applyModelDelegations(
  revision: SourceRevision,
  systems: readonly { systemQualifiedName: string; model: ExecutableModel }[],
  captureDigestInput?: (
    systemQualifiedName: string,
    input: Record<string, unknown>,
  ) => void,
): Promise<void> {
  const records = readModelDelegations(revision.sources);
  const roots: ModelRootAuthority[] = [];
  const identities = systems.map(({ systemQualifiedName, model }) => {
    const identity = delegationIdentity(systemQualifiedName, model, revision);
    const policy = model.modelAdministrationPolicy;
    const owner = ownerAuthorityFor(model);
    if (policy && owner.ownerSource === "modeled") {
      const root = policy.rootAuthority;
      if (
        !root || root.ownerSource !== "modeled" ||
        root.rootAuthorityNativeId !== owner.rootAuthorityNativeId ||
        root.rootGrantNativeId !== owner.rootGrantNativeId ||
        root.mandateNativeId !== owner.mandateNativeId ||
        root.mandateRevision !== owner.mandateRevision ||
        root.operatorNativeId !== owner.operatorNativeId
      ) {
        throw new AuthorityInvariantError(1, "administration-root-mismatch");
      }
    }
    if (policy) roots.push({ ...identity, ...policy });
    return identity;
  });
  if (!roots.length && !records.length) return;
  const resolved = await resolveModelDelegations(roots, records, identities);
  for (const { systemQualifiedName, model } of systems) {
    const effective = resolved.bySystem[systemQualifiedName];
    if (effective?.administration) {
      model.modelAdministration = effective.administration;
    }
    if (effective?.editing && !model.modelEditPolicy) {
      const editing = effective.editing;
      model.modelEditPolicy = {
        id: editing.delegationId,
        revision: editing.delegationRevision,
        elementId: model.identity.builderId,
        sourceIds: [model.identity.builderId],
        holderNativeId: editing.holderNativeId,
        mandateNativeId: String(
          revision.elements.find((element) =>
            element.qualifiedName === `${systemQualifiedName}::builderMandate`
          )!["@id"],
        ),
        mandateId: editing.mandateId,
        mandateRevision: editing.mandateRevision,
        operations: editing.operations,
        grants: editing.grants,
        delegationDigest: editing.digest,
        ...(editing.rootAuthority
          ? { rootAuthority: editing.rootAuthority }
          : {}),
      };
    }
    if (model.modelAdministration || effective?.editing) {
      const digestInput = {
        base: model.version.digest,
        administration: model.modelAdministration,
        delegatedEditing: effective?.editing,
      };
      captureDigestInput?.(systemQualifiedName, structuredClone(digestInput));
      model.version.digest = await executionDigest(digestInput);
    }
  }
}
