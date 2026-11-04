import type { ElementRecord, ModelSnapshot } from "../records/snapshot.ts";
import { sameProductName } from "../sysml-product-names.ts";
import { findPolicyBinding } from "./typed-policy-facts.ts";

type AccountabilityLibrary = {
  definition: ElementRecord;
  field: ElementRecord;
  human: ElementRecord;
};

const singleton = (multiplicity: string) =>
  ["", "1", "1..1"].includes(multiplicity);

/** Validate the diagnostic library once for a model snapshot. */
export function accountabilityLibrary(
  snapshot: ModelSnapshot,
): AccountabilityLibrary | undefined {
  const definitions = snapshot.elements.filter((element) =>
    element.qualifiedName === "APEAccountability::AccountabilityAssignment" &&
    element.metaclass === "PartDefinition"
  );
  const humans = snapshot.elements.filter((element) =>
    element.metaclass === "PartDefinition" &&
    sameProductName(element.qualifiedName, "AssemblyCore::HumanOperator")
  );
  const operators = snapshot.elements.filter((element) =>
    element.metaclass === "PartDefinition" &&
    sameProductName(element.qualifiedName, "AssemblyCore::Operator")
  );
  if (
    definitions.length !== 1 || humans.length !== 1 || operators.length !== 1 ||
    !humans[0]!.generalIds.includes(operators[0]!.id)
  ) return undefined;
  const fields = snapshot.elements.filter((element) =>
    element.ownerId === definitions[0]!.id
  );
  const field = fields[0];
  if (
    fields.length !== 1 || !field || field.name !== "accountable" ||
    field.metaclass !== "PartUsage" || !field.isReference ||
    !singleton(field.multiplicity) || field.typeIds.length !== 1 ||
    field.typeIds[0] !== humans[0]!.id
  ) return undefined;
  return { definition: definitions[0]!, field, human: humans[0]! };
}

/** Diagnostic declaration only: neither authority nor accepted accountability. */
export function declaresAccountableHuman(
  snapshot: ModelSnapshot,
  library: AccountabilityLibrary | undefined,
  unitId: string,
  systemId = unitId,
): boolean {
  if (!library) return false;
  const { definition, field, human } = library;
  const declarations = snapshot.elements.filter((element) =>
    element.ownerId === unitId &&
    element.typeIds.includes(definition.id)
  );
  const declaration = declarations[0];
  if (
    declarations.length !== 1 || !declaration ||
    declaration.metaclass !== "PartUsage" || declaration.isReference ||
    declaration.typeIds.length !== 1 || !singleton(declaration.multiplicity)
  ) return false;
  const binding = findPolicyBinding(snapshot, declaration.id, field.id);
  if (!binding || binding.ownerId !== unitId || binding.ends.length !== 2) {
    return false;
  }
  const targetId = binding.ends.find((end) => end.chain.length === 1)?.chain[0]
    ?.id;
  const target = snapshot.elements.find((element) => element.id === targetId);
  return !!target && target.ownerId === systemId &&
    target.metaclass === "PartUsage" && !target.isReference &&
    singleton(target.multiplicity) && target.typeIds.length === 1 &&
    target.typeIds[0] === human.id;
}
