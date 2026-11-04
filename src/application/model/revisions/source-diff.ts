/** Read-only Git-format source comparison. The diff is complete or fails;
 * resource limits never turn an omitted change into an apparently clean diff. */
import { formatPatch, structuredPatch } from "diff";
import { validateModelSources as validateSources } from "../../../domain/model/value-objects/sources.ts";

export interface SourceFileDiff {
  path: string;
  kind: "added" | "changed" | "deleted";
  additions: number;
  deletions: number;
}
export interface ModelSourceDiff {
  patch: string;
  files: SourceFileDiff[];
  additions: number;
  deletions: number;
}
interface SourceDiffLimits {
  /** Optional stricter limits, primarily for callers with a smaller viewport. */
  timeoutMs?: number;
  maxEditLength?: number;
  maxPatchBytes?: number;
}
const MAXIMUM = {
  timeoutMs: 1000,
  maxEditLength: 20_000,
  maxPatchBytes: 2_097_152,
};
export class ModelSourceDiffLimitError extends Error {
  constructor() {
    super(
      "La comparaison dépasse la limite de calcul ou de taille. Aucun diff partiel n’est affiché ; consultez les sources de ces versions.",
    );
    this.name = "ModelSourceDiffLimitError";
  }
}
function tree(input: Record<string, string>): Record<string, string> {
  // The root commit and a deletion can be compared to an empty source tree.
  if (
    input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).length === 0
  ) return {};
  return validateSources(input);
}

export function compareModelSources(
  beforeInput: Record<string, string>,
  afterInput: Record<string, string>,
  stricter: SourceDiffLimits = {},
): ModelSourceDiff {
  const limits = { ...MAXIMUM, ...stricter };
  for (const key of Object.keys(MAXIMUM) as (keyof SourceDiffLimits)[]) {
    if (
      !Number.isSafeInteger(limits[key]) || limits[key]! < 1 ||
      limits[key]! > MAXIMUM[key]
    ) throw new Error(`Invalid source diff limit: ${key}`);
  }
  const before = tree(beforeInput), after = tree(afterInput);
  const files: SourceFileDiff[] = [];
  const patches: string[] = [];
  let additions = 0, deletions = 0, patchBytes = 0;
  const deadline = performance.now() + limits.timeoutMs;
  for (
    const path of [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .sort()
  ) {
    const oldExists = Object.hasOwn(before, path);
    const newExists = Object.hasOwn(after, path);
    if (oldExists === newExists && before[path] === after[path]) continue;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new ModelSourceDiffLimitError();
    const native = structuredPatch(
      oldExists ? `a/${path}` : "/dev/null",
      newExists ? `b/${path}` : "/dev/null",
      before[path] ?? "",
      after[path] ?? "",
      undefined,
      undefined,
      {
        context: 3,
        timeout: Math.max(1, remaining),
        maxEditLength: limits.maxEditLength,
      },
    );
    if (!native || performance.now() > deadline) {
      throw new ModelSourceDiffLimitError();
    }
    native.isGit = true;
    native.isCreate = !oldExists;
    native.isDelete = !newExists;
    let added = 0, removed = 0;
    for (const hunk of native.hunks) {
      for (const line of hunk.lines) {
        if (line.startsWith("+")) added++;
        if (line.startsWith("-")) removed++;
      }
    }
    const patch = formatPatch(native);
    patchBytes += new TextEncoder().encode(patch).length;
    if (patchBytes > limits.maxPatchBytes) {
      throw new ModelSourceDiffLimitError();
    }
    patches.push(patch);
    files.push({
      path,
      kind: !oldExists ? "added" : !newExists ? "deleted" : "changed",
      additions: added,
      deletions: removed,
    });
    additions += added;
    deletions += removed;
  }
  return { patch: patches.join(""), files, additions, deletions };
}
