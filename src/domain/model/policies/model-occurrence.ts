import type { ElementRecord } from "../records/snapshot.ts";

/** A package-owned part is referential by SysML default. Exact source evidence
 * distinguishes that declaration from an explicit `ref part` alias. This does
 * not grant runtime authority: callers still check type, identity and scope. */
export function isNamespacePartOccurrence(
  element: ElementRecord,
  owner: ElementRecord | undefined,
): boolean {
  return element.metaclass === "PartUsage" &&
    element.declaredReference === false &&
    /^(Library)?Package$/.test(owner?.metaclass ?? "");
}
