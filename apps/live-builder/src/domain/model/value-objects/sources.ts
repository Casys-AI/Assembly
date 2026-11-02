import { persistedOrder } from "../../primitives/persisted-order.ts";
import { compareCodeUnits } from "../../primitives/canonical-json.ts";
import { characterCount } from "../../primitives/character-count.ts";
import { sha256 } from "../../primitives/execution-digest.ts";
/** Complete SysML source files keyed by relative source path, never logical scope. */
export type ModelSources = Record<string, string>;
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_TOTAL_BYTES = 8_388_608;
const MAX_FILES = 64;

/** Source identity S: the single owner; adapters import this, never duplicate it. */
export async function modelSourceDigest(
  sources: ModelSources,
): Promise<string> {
  const entries: string[] = [];
  for (const path of Object.keys(sources).sort(compareCodeUnits)) {
    entries.push(`${path}\0${await sha256(sources[path] as string)}`);
  }
  return await sha256(entries.join("\n"));
}

export function validateModelSources(input: ModelSources): ModelSources {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(
      "SysML sources must be an object of relative file paths and text",
    );
  }
  // Preserve legacy compilation unit order, independently of the host locale.
  const entries = Object.entries(input).sort(([a], [b]) =>
    persistedOrder(a, b)
  );
  if (!entries.length || entries.length > MAX_FILES) {
    throw new Error("Expected 1–64 SysML source files");
  }
  let total = 0;
  const insensitivePaths = new Set<string>();
  const treePaths = new Map<
    string,
    { path: string; kind: "file" | "directory" }
  >();
  for (const [path, content] of entries) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*\.sysml$/.test(path) ||
      characterCount(path) > 240 ||
      path.split("/").some((part) => !part || part === "." || part === "..")
    ) {
      throw new Error(`Unsafe SysML source path: ${path}`);
    }
    const insensitive = path.toLowerCase();
    if (insensitivePaths.has(insensitive)) {
      throw new Error(`Duplicate SysML source path: ${path}`);
    }
    insensitivePaths.add(insensitive);
    const parts = path.split("/");
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join("/");
      const key = prefix.toLowerCase();
      const kind = index === parts.length ? "file" : "directory";
      const prior = treePaths.get(key);
      if (prior && (prior.path !== prefix || prior.kind !== kind)) {
        throw new Error(`Conflicting SysML source path: ${path}`);
      }
      treePaths.set(key, { path: prefix, kind });
    }
    if (typeof content !== "string" || content.includes("\0")) {
      throw new Error(`Invalid SysML source text: ${path}`);
    }
    const length = new TextEncoder().encode(content).length;
    total += length;
    if (length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
      throw new Error("SysML source size limit exceeded");
    }
  }
  return Object.fromEntries(entries);
}
