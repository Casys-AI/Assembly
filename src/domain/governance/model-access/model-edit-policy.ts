/** APE 4.1 Operator Identity & Mandate: explicit delegated source-editing bounds. */
import type { ModelEdit } from "../../model/editing/tooling.ts";
import { validateModelSources } from "../../model/value-objects/sources.ts";
import { parseSysmlQualifiedName } from "../../model/value-objects/sysml-qualified-name.ts";

export type ModelEditOperation = ModelEdit["kind"] | "replace-source";
export interface ModelEditGrant {
  file: string;
  qualifiedRoots: string[];
}
const operations: ModelEditOperation[] = [
  "set-value",
  "set-type",
  "retarget-reference",
  "rename",
  "insert-member",
  "remove",
  "replace-source",
];
export function validateModelEditPolicyIdentity(
  id: string,
  revision: number,
): void {
  if (
    typeof id !== "string" || !id || id.trim() !== id || id.length > 128 ||
    [...id].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) || !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error("Invalid model edit policy identity");
  }
}
export function parseModelEditOperations(value: string): ModelEditOperation[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) || parsed.length < 1 ||
    parsed.length > operations.length ||
    parsed.some((entry) => !operations.includes(entry)) ||
    new Set(parsed).size !== parsed.length ||
    JSON.stringify(parsed) !== value
  ) throw new Error("Invalid canonical model edit operations");
  return parsed;
}
export function parseModelEditGrants(value: string): ModelEditGrant[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) || !parsed.length || parsed.length > 64 ||
    JSON.stringify(parsed) !== value
  ) {
    throw new Error("Invalid canonical model edit grants");
  }
  const files = new Set<string>();
  for (const entry of parsed) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "file,qualifiedRoots" ||
      typeof entry.file !== "string" || !Array.isArray(entry.qualifiedRoots) ||
      !entry.qualifiedRoots.length || entry.qualifiedRoots.length > 128
    ) throw new Error("Invalid model edit grant pair");
    validateModelSources({ [entry.file]: "" });
    if (files.has(entry.file.toLowerCase())) {
      throw new Error("Duplicate model edit grant file");
    }
    files.add(entry.file.toLowerCase());
    const roots = new Set<string>();
    for (const root of entry.qualifiedRoots) {
      const segments = typeof root === "string"
        ? parseSysmlQualifiedName(root)
        : undefined;
      if (!segments || segments.some((segment) => segment.includes("*"))) {
        throw new Error("Invalid model edit grant root");
      }
      const key = JSON.stringify(segments);
      if (roots.has(key)) throw new Error("Duplicate model edit grant root");
      roots.add(key);
    }
  }
  return parsed as ModelEditGrant[];
}
export function modelEditRootContains(
  root: string,
  qualifiedName: string,
): boolean {
  const a = parseSysmlQualifiedName(root),
    b = parseSysmlQualifiedName(qualifiedName);
  return !!a && !!b && a.length <= b.length &&
    a.every((segment, index) => segment === b[index]);
}
