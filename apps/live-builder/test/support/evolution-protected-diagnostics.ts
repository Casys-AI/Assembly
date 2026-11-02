/** Bounded diagnostics for public native fixtures; never a production allowance. */
import { join } from "node:path";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import {
  projectEvolutionSemanticsPair,
  type ScopedExecutableModel,
} from "../../src/domain/model/evolution/semantic-effects.ts";

interface Difference {
  path: string;
  beforeType: string;
  afterType: string;
  beforeDigest: string;
  afterDigest: string;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function kind(value: unknown): string {
  return value === null
    ? "null"
    : Array.isArray(value)
    ? `array(${value.length})`
    : typeof value;
}
/** The public summary carries hashes and paths, never arbitrary model values. */
export async function protectedDifferences(
  before: unknown,
  after: unknown,
  limit = 20,
): Promise<Difference[]> {
  const pending: { path: string; before: unknown; after: unknown }[] = [];
  const visit = (a: unknown, b: unknown, path: string) => {
    if (pending.length >= limit || canonical(a) === canonical(b)) return;
    if (object(a) && object(b)) {
      for (
        const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
      ) {
        visit(a[key], b[key], `${path}[${JSON.stringify(key)}]`);
        if (pending.length >= limit) return;
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) visit(a.length, b.length, `${path}.length`);
      for (let index = 0; index < Math.max(a.length, b.length); index++) {
        visit(a[index], b[index], `${path}[${index}]`);
        if (pending.length >= limit) return;
      }
      return;
    }
    pending.push({ path, before: a, after: b });
  };
  visit(before, after, "$protected");
  return await Promise.all(pending.map(async (entry) => ({
    path: entry.path,
    beforeType: kind(entry.before),
    afterType: kind(entry.after),
    beforeDigest: await executionDigest({
      type: kind(entry.before),
      value: entry.before ?? null,
    }),
    afterDigest: await executionDigest({
      type: kind(entry.after),
      value: entry.after ?? null,
    }),
  })));
}
export async function writeEvolutionProtectedDiagnostics(input: {
  directory: string;
  before: ScopedExecutableModel[];
  after: ScopedExecutableModel[];
}): Promise<string> {
  const directory = join(input.directory, "evolution-protected-diagnostics");
  await Deno.mkdir(directory, { recursive: true });
  const summary = [];
  let remaining = 20;
  for (const [index, old] of input.before.entries()) {
    const next = input.after.find((scope) =>
      scope.model.identity.builderId === old.model.identity.builderId
    );
    if (!next) continue;
    const [beforeProjection, afterProjection] = projectEvolutionSemanticsPair(
      old,
      next,
    );
    const before = beforeProjection.protected,
      after = afterProjection.protected;
    if (canonical(before) === canonical(after)) continue;
    const differences = await protectedDifferences(before, after, remaining);
    remaining -= differences.length;
    const factSummary = (scope: ScopedExecutableModel) =>
      Object.fromEntries(
        Object.entries(scope.evidence.sourceFacts).map((
          [id, value],
        ) => [
          id,
          object(value)
            ? {
              nativeId: id,
              metaclass: value["@type"],
              owner: value.owner,
              qualifiedName: value.qualifiedName,
              keys: Object.keys(value).sort(),
              category: scope.evidence.sourceCategories[id],
            }
            : { nativeId: id, type: kind(value) },
        ]),
      );
    const evidenceFile = join(directory, `scope-${index}.json`);
    // Fixtures contain declared test data only. Preserve exact failed preimages
    // locally for inspection, while the emitted summary stays value-free.
    await Deno.writeTextFile(
      evidenceFile,
      JSON.stringify(
        {
          systemQualifiedName: old.systemQualifiedName,
          before: {
            protected: before,
            evidence: old.evidence,
            nativeFacts: factSummary(old),
          },
          after: {
            protected: after,
            evidence: next.evidence,
            nativeFacts: factSummary(next),
          },
        },
        null,
        2,
      ),
    );
    summary.push({
      systemQualifiedName: old.systemQualifiedName,
      beforeModelDigest: old.model.version.digest,
      afterModelDigest: next.model.version.digest,
      beforeProtectedDigest: await executionDigest(before),
      afterProtectedDigest: await executionDigest(after),
      differences,
      evidenceFile,
    });
  }
  const path = join(directory, "summary.json");
  await Deno.writeTextFile(path, JSON.stringify(summary, null, 2));
  console.error(`Native evolution protected diagnostics: ${path}`);
  console.error(JSON.stringify(summary));
  return path;
}
