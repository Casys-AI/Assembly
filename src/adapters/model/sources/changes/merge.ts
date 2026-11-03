/** Shared source comparison and textual merge; semantic validation follows in each repository. */
import type { ModelSources as Sources } from "../../../../domain/model/value-objects/sources.ts";
import { ModelRepositoryError } from "../../../../application/model/repository.ts";
import { type SourceChange } from "../../../../domain/model/records/revision.ts";
function ensure(
  value: unknown,
  code: ModelRepositoryError["code"],
  message: string,
): asserts value {
  if (!value) throw new ModelRepositoryError(code, message);
}

export function diffSources(before: Sources, after: Sources): SourceChange[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
    .flatMap((path) =>
      before[path] === after[path] ? [] : [{
        path,
        kind: !(path in before)
          ? "added" as const
          : !(path in after)
          ? "deleted" as const
          : "changed" as const,
        ...(path in before ? { before: before[path] } : {}),
        ...(path in after ? { after: after[path] } : {}),
      }]
    );
}

/** Real textual three-way merge. Semantic validation is still mandatory after it. */
export async function mergeSources(
  base: Sources,
  current: Sources,
  proposed: Sources,
): Promise<Sources> {
  const merged: Sources = {};
  const directory = await Deno.makeTempDir({
    prefix: "assembly-source-merge-",
  });
  try {
    for (
      const path of [
        ...new Set([
          ...Object.keys(base),
          ...Object.keys(current),
          ...Object.keys(proposed),
        ]),
      ].sort()
    ) {
      const [ancestor, ours, theirs] = [
        base[path],
        current[path],
        proposed[path],
      ];
      let result: string | undefined;
      if (ours === theirs || ancestor === theirs) result = ours;
      else if (ancestor === ours) result = theirs;
      else {
        ensure(
          ancestor !== undefined && ours !== undefined && theirs !== undefined,
          "SOURCE_CONFLICT",
          `Concurrent add/delete conflict in ${path}`,
        );
        const paths = ["main", "base", "proposal"].map((name) =>
          `${directory}/${name}.sysml`
        );
        await Promise.all(
          paths.map((file, index) =>
            Deno.writeTextFile(file, [ours, ancestor, theirs][index]!)
          ),
        );
        const output = await new Deno.Command("git", {
          args: ["merge-file", "-p", ...paths],
          stdout: "piped",
          stderr: "piped",
        }).output();
        ensure(
          output.success,
          "SOURCE_CONFLICT",
          `Concurrent source changes conflict in ${path}`,
        );
        result = new TextDecoder().decode(output.stdout);
      }
      if (result !== undefined) merged[path] = result;
    }
    return merged;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}
