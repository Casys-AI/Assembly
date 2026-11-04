import { DEFAULT_SYSTEM } from "./source-identity.ts";
import { sameProductName } from "../sysml-product-names.ts";
import type { ExecutableModel } from "../execution/executable-model.ts";
import type { NativeLiteral } from "./native-literal.ts";

/** The modeled primary contact; the default designer when no system declares one. */
export function isPrimaryDesigner(
  native: Pick<ExecutableModel, "operator">,
  systemQualifiedName: string | undefined,
  literals: readonly NativeLiteral[],
): boolean {
  return native.operator?.primary ??
    (sameProductName(
      systemQualifiedName ?? DEFAULT_SYSTEM,
      "AssemblyLiveBuilder::liveBuilder",
    ) &&
      !literals.some((l) =>
        l.name === "primaryContact" && l.kind === "LiteralBoolean" &&
        l.value === "true"
      ));
}
