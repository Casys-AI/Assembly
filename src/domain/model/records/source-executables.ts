import { assert } from "../../primitives/assert.ts";
import { sameProductName } from "../sysml-product-names.ts";
import {
  type ConversationUnitIdentity,
  DEFAULT_SYSTEM,
} from "./source-identity.ts";
import type { ExecutableModel } from "../execution/executable-model.ts";

export type ValidatedSourceExecutables = Array<
  { unit: ConversationUnitIdentity; model: ExecutableModel }
>;

/** Primary endpoint, then the default system, then the only available unit. */
export function primarySourceExecutable(
  compiled: ValidatedSourceExecutables,
): ValidatedSourceExecutables[number] | undefined {
  return compiled.find(({ model }) => model.operator?.primary) ??
    compiled.find(({ unit }) =>
      sameProductName(unit.systemQualifiedName, DEFAULT_SYSTEM)
    ) ??
    (compiled.length === 1 ? compiled[0] : undefined);
}

/** Select from a complete validated collection with the same default rules. */
export function selectValidatedSourceExecutable(
  compiled: ValidatedSourceExecutables,
  systemQualifiedName?: string,
): ExecutableModel {
  const requested = systemQualifiedName ??
    primarySourceExecutable(compiled)?.unit.systemQualifiedName;
  const selected = compiled.filter(({ unit }) =>
    sameProductName(unit.systemQualifiedName, requested ?? "")
  );
  assert(selected.length === 1, "Select an exact native conversation system");
  return selected[0]!.model;
}
