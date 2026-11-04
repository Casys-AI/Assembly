import { sameProductName } from "../../../domain/model/sysml-product-names.ts";
import type { ElementRecord } from "../../../domain/model/records/snapshot.ts";

/** Include derived mandate types and their occurrences, regardless of local names. */
export function modelEditingAuthorityRoots(
  elements: readonly ElementRecord[],
): string[] {
  const protectedIds = new Set(
    elements.filter((element) =>
      [
        "AssemblyAuthority::OperatorAuthorityPolicy",
        "AssemblyAuthority::OperatorCreationPolicy",
        "AssemblyAuthority::ToolAdmissionPolicy",
        "AssemblyAuthority::Mandate",
        "AssemblyAuthority::RootAuthority",
        "AssemblyAuthority::RootGrant",
        "AssemblyCore::ConfiguredMandate",
      ].some((name) => sameProductName(element.qualifiedName, name))
    ).map((element) => element.id),
  );
  let size: number;
  do {
    size = protectedIds.size;
    for (const element of elements) {
      if (
        [...element.typeIds, ...element.generalIds].some((id) =>
          protectedIds.has(id)
        )
      ) {
        protectedIds.add(element.id);
      }
    }
  } while (size !== protectedIds.size);
  return elements.filter((element) => protectedIds.has(element.id))
    .map((element) => element.qualifiedName).filter(Boolean).sort();
}
