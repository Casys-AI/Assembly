import { characterCount } from "../../primitives/character-count.ts";
import type { ModelDiagnostic } from "../policies/diagnostics.ts";

/** The finding a revision intends to address, not evidence that it is resolved. */
export interface ModelDiagnosticAddress {
  code: string;
  elementId: string;
}

export function modelDiagnosticAddresses(
  input: unknown,
): ModelDiagnosticAddress[] {
  if (
    !Array.isArray(input) || input.length > 128 ||
    input.some((entry) =>
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 ||
      typeof entry.code !== "string" || !entry.code.trim() ||
      characterCount(entry.code) > 128 ||
      typeof entry.elementId !== "string" ||
      !entry.elementId.trim() || characterCount(entry.elementId) > 512
    )
  ) throw new Error("Invalid diagnostic addresses");
  const addresses = input.map(({ code, elementId }) => ({ code, elementId }));
  if (
    new Set(addresses.map((address) => JSON.stringify(address))).size !==
      addresses.length
  ) throw new Error("Duplicate diagnostic addresses");
  return addresses;
}

export function requireExistingDiagnosticAddresses(
  input: unknown,
  diagnostics: readonly ModelDiagnostic[],
): ModelDiagnosticAddress[] {
  const addresses = modelDiagnosticAddresses(input);
  for (const address of addresses) {
    if (
      !diagnostics.some((diagnostic) =>
        diagnostic.code === address.code &&
        diagnostic.elementId === address.elementId
      )
    ) {
      throw new Error(
        "Every addressed diagnostic must exist in the proposal's base version",
      );
    }
  }
  return addresses;
}
