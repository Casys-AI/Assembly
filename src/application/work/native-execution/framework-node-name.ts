/** Injective scheduling names; canonical occurrence IDs remain model evidence. */
export function nativeFrameworkNodeName(
  nativeNodeId: string,
  phase: "node" | "await-preparation" = "node",
): string {
  return `${phase === "node" ? "native_" : "native_wait_"}${
    encodeURIComponent(nativeNodeId)
  }`;
}
