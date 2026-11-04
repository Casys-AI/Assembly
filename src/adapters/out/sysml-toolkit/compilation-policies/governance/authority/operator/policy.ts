import { persistedOrder } from "../../../../../../../domain/primitives/persisted-order.ts";
import {
  bindPolicyReferences,
  typedPolicyLiterals,
} from "../../../../../../../domain/model/policies/typed-policy-facts.ts";
import { sameProductName } from "../../../../../../../domain/model/sysml-product-names.ts";
/** Semantic compilation of admitted operator authority policies. */
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../../../domain/model/records/snapshot.ts";
import type { ModelIdentity } from "../../../../../../../domain/shared-kernel/model-identity.ts";
import type { NativeLiteral } from "../../../../../../../domain/model/records/native-literal.ts";
import { compileNativeAuthority } from "../../../work/execution-model.ts";
import { compileModelPolicyRoot } from "../model-policy-root.ts";
import { OperatorAuthorityError } from "../../../../../../../domain/governance/operator-authority-error.ts";
import { MAIN_EXECUTION_SPACE_ID } from "../../../../../../../domain/governance/authority.ts";
import {
  type OperatorAuthorityPolicy,
  type OperatorAuthorityPolicyRequest,
  validateOperatorAuthorityPolicyRequest,
} from "../../../../../../../domain/governance/policies/operator-authority-policy.ts";
import { namesHolderInstance } from "../../../../../../../domain/governance/policies/delegation-scope.ts";

const typeName = "AssemblyAuthority::OperatorAuthorityPolicy";
const fields = {
  id: "String",
  revision: "Integer",
  enabled: "Boolean",
  recipients: "String",
  acts: "String",
  networkHosts: "String",
  toolIds: "String",
  maxDelegationDepth: "Integer",
} as const;
/** Absent: recipients relative to the execution space where the policy is read. */
const optionalFields = { recipientSpace: "String" } as const;

/** A branch recipient is verified against its admitted team by the host's
 * recipient-Case boundary. Only local recipients belong to this source snapshot. */
export function assertOperatorAuthorityRecipients(
  elements: ReadonlyMap<string, ElementRecord>,
  holderId: string,
  request: Pick<
    OperatorAuthorityPolicyRequest,
    "recipients" | "recipientExecutionSpaceId"
  >,
): void {
  const localRecipients =
    (request.recipientExecutionSpaceId ?? MAIN_EXECUTION_SPACE_ID) ===
        MAIN_EXECUTION_SPACE_ID
      ? request.recipients
      : [];
  if (
    namesHolderInstance(holderId, request) ||
    localRecipients.some((id) => {
      const element = elements.get(id);
      return !element || element.name !== "builder" ||
        element.metaclass !== "PartUsage" || element.typeIds.length !== 1 ||
        !sameProductName(
          elements.get(element.typeIds[0])?.qualifiedName,
          "AssemblyLiveBuilder::ConversationBuilder",
        );
    })
  ) {
    throw new OperatorAuthorityError(
      "INVALID_AUTHORITY_POLICY",
      "Recipients must be exact other operators",
    );
  }
}

export function compileOperatorAuthorityPolicies(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
): OperatorAuthorityPolicy[] {
  const fail = (condition: unknown, detail: string): void => {
    if (!condition) {
      throw new OperatorAuthorityError("INVALID_AUTHORITY_POLICY", detail);
    }
  };
  const byId = new Map(snapshot.elements.map((e) => [e.id, e]));
  fail(byId.size === snapshot.elements.length, "Duplicate native identity");
  const definitions = snapshot.elements.filter((e) =>
    sameProductName(e.qualifiedName, typeName)
  );
  if (!definitions.length) return [];
  fail(
    definitions.length === 1 && definitions[0]!.metaclass === "PartDefinition",
    "Policy definition must be unique",
  );
  const definition = definitions[0]!;
  const member = (owner: string, name: string): ElementRecord => {
    const found = snapshot.elements.filter((e) =>
      e.ownerId === owner && e.name === name
    );
    fail(found.length === 1, `Expected one policy member ${name}`);
    return found[0]!;
  };
  // Systems created before 4.8c keep a definition without recipientSpace.
  const declared = {
    ...fields,
    ...(snapshot.elements.some((e) =>
        e.ownerId === definition.id && e.name === "recipientSpace"
      )
      ? optionalFields
      : {}),
  };
  fail(
    snapshot.elements.filter((e) => e.ownerId === definition.id).length ===
      Object.keys(declared).length + 3,
    "Unsupported policy definition members",
  );
  for (const name of Object.keys(declared)) {
    const base = member(definition.id, name);
    fail(
      base.metaclass === "AttributeUsage" && base.typeIds.length === 1,
      `Invalid declared scalar ${name}`,
    );
  }
  for (
    const [name, metaclass, target] of [[
      "holder",
      "ReferenceUsage",
      "AssemblyCore::SoftwareOperator",
    ], ["mandate", "ItemUsage", "AssemblyCore::ConfiguredMandate"]]
  ) {
    const ref = member(definition.id, name!);
    fail(
      ref.isReference && ref.metaclass === metaclass &&
        ref.typeIds.length === 1 &&
        sameProductName(byId.get(ref.typeIds[0]!)?.qualifiedName, target!),
      `Invalid reference ${name}`,
    );
  }
  const all: OperatorAuthorityPolicy[] = [];
  for (
    const occurrence of snapshot.elements.filter((e) =>
      e.typeIds.includes(definition.id)
    )
  ) {
    fail(
      occurrence.metaclass === "PartUsage" && !occurrence.isReference &&
        occurrence.typeIds.length === 1 &&
        ["", "1", "1..1"].includes(occurrence.multiplicity),
      "Policy must be a concrete singleton",
    );
    const system = byId.get(occurrence.ownerId);
    const builder = system &&
      snapshot.elements.filter((e) =>
        e.ownerId === system.id && e.name === "builder"
      );
    fail(
      system && builder?.length === 1,
      "Policy must belong to its designer system",
    );
    // Compile the holder's real mandate and owner, not the requesting operator's.
    const selected = {
      ...identity,
      systemId: system!.id,
      systemQualifiedName: system!.qualifiedName,
      builderId: builder![0]!.id,
      catalogId: member(system!.id, "catalog").id,
      reviewerId: snapshot.elements.find((e) =>
        e.ownerId === system!.id && e.name === "reviewer" &&
        e.metaclass === "PartUsage"
      )?.id,
    };
    const native = compileNativeAuthority(snapshot, literals, selected);
    fail(
      native.ownerAuthority.ownerSource === "modeled",
      "Only a modeled operator can hold operator authority",
    );
    const present = {
      ...fields,
      ...(snapshot.elements.some((e) =>
          e.ownerId === occurrence.id && e.name === "recipientSpace"
        )
        ? optionalFields
        : {}),
    };
    fail(
      snapshot.elements.filter((e) => e.ownerId === occurrence.id).length ===
        Object.keys(present).length,
      "Unsupported policy occurrence members",
    );
    const values: Record<string, unknown> = {};
    const sourceIds = [definition.id, occurrence.id];
    for (const [name, kind] of Object.entries(present)) {
      const base = member(definition.id, name),
        attribute = member(occurrence.id, name);
      const matches = literals.filter((l) =>
        l.owner === occurrence.id && l.name === name
      );
      const literal = matches[0];
      fail(
        matches.length === 1 &&
          typedPolicyLiterals(attribute, base, literal, kind, false, literals),
        `Invalid typed policy literal ${name}`,
      );
      values[name] = kind === "Integer"
        ? Number(literal!.value)
        : kind === "Boolean"
        ? literal!.value === "true"
        : literal!.value;
      if (["recipients", "acts", "networkHosts", "toolIds"].includes(name)) {
        try {
          values[name] = JSON.parse(literal!.value);
        } catch {
          fail(false, `Invalid JSON ${name}`);
        }
        fail(
          JSON.stringify(values[name]) === literal!.value,
          "Noncanonical bounds",
        );
      }
      sourceIds.push(base.id, attribute.id, literal!.literalId);
    }
    fail(
      Number.isSafeInteger(values.revision) && Number(values.revision) >= 1,
      "Invalid policy revision",
    );
    const request = validateOperatorAuthorityPolicyRequest({
      policyId: values.id,
      expectedPolicyRevision: Number(values.revision) - 1,
      enabled: values.enabled,
      recipients: values.recipients,
      ...("recipientSpace" in values
        ? { recipientExecutionSpaceId: values.recipientSpace }
        : {}),
      acts: values.acts,
      networkHosts: values.networkHosts,
      toolIds: values.toolIds,
      maxDelegationDepth: values.maxDelegationDepth,
    });
    assertOperatorAuthorityRecipients(byId, selected.builderId, request);
    for (
      const [name, target] of [["holder", selected.builderId], [
        "mandate",
        native.builderMandate.nativeId,
      ]]
    ) {
      const feature = member(definition.id, name!);
      const connector = bindPolicyReferences(
        snapshot,
        occurrence.id,
        feature.id,
        system!.id,
        target!,
        fail,
        {
          ambiguous: `Invalid policy ${name} binding`,
          invalid: `Invalid policy ${name} binding`,
        },
      );
      sourceIds.push(connector.id);
    }
    const rootAuthority = compileModelPolicyRoot(
      snapshot,
      definition,
      occurrence,
      native.ownerAuthority,
    );
    fail(rootAuthority, "Explicit root authority required");
    all.push({
      id: request.policyId,
      revision: Number(values.revision),
      enabled: request.enabled,
      recipients: request.recipients,
      ...(request.recipientExecutionSpaceId
        ? { recipientExecutionSpaceId: request.recipientExecutionSpaceId }
        : {}),
      acts: request.acts,
      networkHosts: request.networkHosts,
      toolIds: request.toolIds,
      maxDelegationDepth: request.maxDelegationDepth,
      elementId: occurrence.id,
      holderNativeId: selected.builderId,
      mandateNativeId: native.builderMandate.nativeId,
      systemId: system!.id,
      rootAuthority,
      sourceIds: [
        ...new Set([
          ...sourceIds,
          ...native.builderMandate.sourceIds,
          ...rootAuthority!.sourceIds,
        ]),
      ].sort(),
    });
  }
  const latest = new Map<string, OperatorAuthorityPolicy>();
  for (const p of all.sort((a, b) => a.revision - b.revision)) {
    const previous = latest.get(p.id);
    fail(
      p.revision === (previous?.revision ?? 0) + 1 &&
        (!previous || previous.holderNativeId === p.holderNativeId),
      "Duplicate, missing or reassigned policy revision",
    );
    latest.set(p.id, p);
  }
  return [...latest.values()].sort((a, b) => persistedOrder(a.id, b.id));
}
