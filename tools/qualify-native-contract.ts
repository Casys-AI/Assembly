/** Harnais de qualification du contrat Toolkit (pas un framework).
 * Capture un oracle sémantique du backend courant derrière les ports
 * SysmlToolkitAdapter/ToolkitCompiler, puis compare une autre réalisation
 * derrière les mêmes ports sans changer les faits.
 * Usage:
 *   deno run ... tools/qualify-native-contract.ts --capture --packageDir <dir> [--corpus <dir>] [--out <dir>]
 *   deno run ... tools/qualify-native-contract.ts --compare --packageDir <dir> [--corpus <dir>] --golden <dir|file> [--out <dir>]
 * Golden: <out>/golden.json = { meta, semantic }. `meta` (version, recette,
 * provenance du bundle) est rapporté séparément et ne fait jamais échouer la
 * comparaison sémantique: une identité A/R différente n'est pas un fait modèle.
 * Toute différence sémantique réelle est un échec explicite (exit 1).
 */
import { SysmlToolkitAdapter } from "../src/adapters/out/sysml-toolkit/adapter.ts";
import { ToolkitCompiler } from "../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SYSML_TOOLKIT_VERSION } from "../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { canonical } from "../src/domain/primitives/canonical-json.ts";
import type { ModelSources as Sources } from "../src/domain/model/value-objects/sources.ts";
import type { ModelToolingDescription } from "../src/application/model/tooling.ts";
import type {
  ModelToolingTarget,
  ResolvedModelEdit,
} from "../src/domain/model/editing/tooling.ts";

type Json = unknown;
interface Outcome {
  ok?: Json;
  error?: { name: string; code?: string; message: string };
}
interface CorpusCase {
  id: string;
  kind: string;
  files: string[];
}

const VOLATILE_KEYS = new Set(["timingMs"]);

function stripVolatile(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, Json>)
        .filter(([k]) => !VOLATILE_KEYS.has(k))
        .map(([k, v]) => [k, stripVolatile(v)]),
    );
  }
  return value;
}
/** Retire l'identité d'implémentation embarquée dans une projection. */
function stripEmbeddedIdentity(value: Json): Json {
  const copy = stripVolatile(value) as Record<string, Json>;
  if (
    copy && typeof copy === "object" && copy.meta &&
    typeof copy.meta === "object"
  ) {
    const meta = { ...(copy.meta as Record<string, Json>) };
    delete meta.toolkit;
    copy.meta = meta;
  }
  return copy;
}
async function attempt(fn: () => Promise<Json>): Promise<Outcome> {
  try {
    return { ok: stripVolatile(await fn()) };
  } catch (error) {
    const e = error as { name?: string; code?: string; message?: string };
    return {
      error: {
        name: String(e.name ?? "Error"),
        ...(typeof e.code === "string" ? { code: e.code } : {}),
        message: String(e.message ?? error),
      },
    };
  }
}
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--capture" || a === "--compare") out.mode = a.slice(2);
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else throw new Error(`Unexpected argument: ${a}`);
  }
  return out;
}
async function loadSources(corpusDir: string, c: CorpusCase): Promise<Sources> {
  const sources: Sources = {};
  for (const file of c.files) {
    sources[file] = await Deno.readTextFile(`${corpusDir}/${file}`);
  }
  return sources;
}

async function runCase(
  adapter: SysmlToolkitAdapter,
  compiler: ToolkitCompiler,
  corpusDir: string,
  c: CorpusCase,
): Promise<Record<string, Outcome>> {
  const sources = await loadSources(corpusDir, c);
  const ops: Record<string, Outcome> = {};
  ops.check = await attempt(async () => await adapter.check(sources));
  ops.compile = await attempt(async () => {
    const compiled = await compiler.compile(sources);
    // Sémantique uniquement: provenanceDigest/engineVersion/provider vont en meta.
    return {
      elements: compiled.elements,
      documents: compiled.documents,
      sourceDigest: compiled.sourceDigest,
      semanticDigest: compiled.semanticDigest,
      sourceHashes: compiled.sourceHashes,
    };
  });
  ops.snapshot = await attempt(async () => {
    const snap = await adapter.snapshot(sources);
    return {
      elements: snap.elements,
      documents: snap.documents,
      sourceDigest: snap.sourceDigest,
      semanticDigest: snap.semanticDigest,
    };
  });
  if (c.kind === "board" || c.kind === "real-model") {
    ops.boardAse = await attempt(async () =>
      stripEmbeddedIdentity(await adapter.board(sources, { mode: "ase" }))
    );
    ops.boardGeneric = await attempt(async () =>
      stripEmbeddedIdentity(await adapter.board(sources, { mode: "generic" }))
    );
  }
  if (c.kind === "board" || c.kind === "views" || c.kind === "real-model") {
    ops.views = await attempt(async () => {
      const list = await adapter.views(sources);
      return {
        views: list.views,
        diagnostics: list.diagnostics,
        digest: list.digest,
      };
    });
    const listOutcome = ops.views.ok as
      | { views?: Array<{ id: string }> }
      | undefined;
    for (const view of listOutcome?.views ?? []) {
      ops[`diagram:${view.id}`] = await attempt(async () =>
        (await adapter.diagram(sources, view as never)).diagram
      );
      ops[`plantuml:${view.id}`] = await attempt(async () =>
        await adapter.plantuml(sources, view as never)
      );
    }
  }
  if (c.kind === "tokens") {
    for (const file of c.files) {
      ops[`tokens:${file}`] = await attempt(async () =>
        await adapter.tokens(file, sources[file])
      );
    }
  }
  if (c.kind === "edits") {
    const path = c.files[0];
    const counter: ModelToolingTarget = {
      qualifiedName: "QualEdits::counter",
      metaclass: "AttributeUsage",
      source: { path, text: "attribute counter : Integer = 1;" },
    };
    ops.queryBefore = await attempt(async () =>
      await adapter.query(sources, "QualEdits::counter")
    );
    ops.describe = await attempt(async () =>
      await adapter.describe(sources, counter)
    );
    ops.describeStalePreimage = await attempt(async () =>
      await adapter.describe(sources, {
        ...counter,
        source: { path, text: "attribute counter : Integer = 999;" },
      })
    );
    let current: Sources = sources;
    let description: ModelToolingDescription | undefined;
    const apply = async (name: string, edit: ResolvedModelEdit) => {
      const outcome = await attempt(async () => {
        const result = await adapter.edit(current, [edit]);
        current = result.sources;
        return {
          sources: result.sources,
          splices: result.splices,
          idMap: result.idMap,
          diagnostics: result.diagnostics,
          targets: result.targets,
        };
      });
      ops[name] = outcome;
      return outcome;
    };
    await apply("editSetValue", {
      kind: "set-value",
      target: counter,
      expression: "11",
    });
    ops.queryAfterSetValue = await attempt(async () =>
      await adapter.query(current, "QualEdits::counter")
    );
    const renamed: ModelToolingTarget = {
      ...counter,
      source: { path, text: "attribute counter : Integer = 11;" },
    };
    await apply("editRename", {
      kind: "rename",
      target: renamed,
      name: "counterRenamed",
    });
    ops.queryAfterRename = await attempt(async () =>
      await adapter.query(current, "QualEdits::counterRenamed")
    );
    ops.describeOldNameAfterRename = await attempt(async () =>
      await adapter.describe(current, renamed)
    );
    ops.describeRenamed = await attempt(async () => {
      description = await adapter.describe(current, {
        qualifiedName: "QualEdits::counterRenamed",
        metaclass: "AttributeUsage",
        source: { path, text: "attribute counterRenamed : Integer = 11;" },
      });
      return description;
    });
    const pkg: ModelToolingTarget = {
      qualifiedName: "QualEdits",
      metaclass: "Package",
      source: { path, text: current[path].trimEnd() },
    };
    await apply("editInsertMember", {
      kind: "insert-member",
      target: pkg,
      text: "attribute temporaryEvidence : Integer = 9;",
    });
    ops.queryInserted = await attempt(async () =>
      await adapter.query(current, "QualEdits::temporaryEvidence")
    );
    await apply("editRemoveInserted", {
      kind: "remove",
      target: {
        qualifiedName: "QualEdits::temporaryEvidence",
        metaclass: "AttributeUsage",
        source: { path, text: "attribute temporaryEvidence : Integer = 9;" },
      },
    });
    ops.editUnbalancedInsert = await attempt(async () =>
      await adapter.edit(current, [{
        kind: "insert-member",
        target: pkg,
        text: "part broken { attribute x : Integer;",
      }])
    );
    ops.editMissingTarget = await attempt(async () =>
      await adapter.edit(current, [{
        kind: "remove",
        target: {
          qualifiedName: "QualEdits::absent",
          metaclass: "AttributeUsage",
          source: { path, text: "attribute absent : Integer = 0;" },
        },
      }])
    );
    ops.checkAfterEdits = await attempt(async () =>
      await adapter.check(current)
    );
  }
  return ops;
}

function diffPaths(
  expected: Json,
  actual: Json,
  path: string,
  out: string[],
): void {
  const e = canonical(expected as never), a = canonical(actual as never);
  if (e === a) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      out.push(`${path}: longueur ${expected.length} != ${actual.length}`);
    }
    for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
      diffPaths(expected[i], actual[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (
    expected && actual && typeof expected === "object" &&
    typeof actual === "object"
  ) {
    const keys = new Set([
      ...Object.keys(expected as object),
      ...Object.keys(actual as object),
    ]);
    for (const k of keys) {
      diffPaths(
        (expected as Record<string, Json>)[k],
        (actual as Record<string, Json>)[k],
        `${path}.${k}`,
        out,
      );
    }
    return;
  }
  out.push(`${path}: attendu=${e} obtenu=${a}`);
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args);
  const mode = args.mode;
  if (mode !== "capture" && mode !== "compare") {
    throw new Error("--capture ou --compare requis");
  }
  const packageDir = String(args.packageDir ?? "");
  if (!packageDir) throw new Error("--packageDir requis");
  const corpusDir = String(args.corpus ?? "test/fixtures/native-contract");
  const outDir = String(args.out ?? ".data/qualification");
  const corpus = JSON.parse(
    await Deno.readTextFile(`${corpusDir}/corpus.json`),
  ) as { cases: CorpusCase[] };
  const adapter = new SysmlToolkitAdapter({ packageDir });
  const compiler = new ToolkitCompiler({ packageDir });
  const meta: Record<string, Json> = {
    toolkitVersion: SYSML_TOOLKIT_VERSION,
    packageDirBasename: packageDir.split("/").pop(),
  };
  meta.recipe = await attempt(async () =>
    await compiler.recipe() as unknown as Json
  ).then((o) => o.ok ?? o.error ?? null);
  const semantic: Record<string, Record<string, Outcome>> = {};
  for (const c of corpus.cases) {
    semantic[c.id] = await runCase(adapter, compiler, corpusDir, c);
  }
  await Deno.mkdir(outDir, { recursive: true });
  if (mode === "capture") {
    await Deno.writeTextFile(
      `${outDir}/golden.json`,
      JSON.stringify({ meta, semantic }, null, 2) + "\n",
    );
    console.log(
      JSON.stringify({
        mode,
        cases: Object.keys(semantic),
        out: `${outDir}/golden.json`,
        meta,
      }),
    );
    return 0;
  }
  const goldenPath = String(args.golden ?? `${outDir}/golden.json`);
  const goldenFile = goldenPath.endsWith(".json")
    ? goldenPath
    : `${goldenPath}/golden.json`;
  const golden = JSON.parse(await Deno.readTextFile(goldenFile)) as {
    meta: Record<string, Json>;
    semantic: typeof semantic;
  };
  const failures: string[] = [];
  for (
    const caseId of new Set([
      ...Object.keys(golden.semantic),
      ...Object.keys(semantic),
    ])
  ) {
    for (
      const op of new Set([
        ...Object.keys(golden.semantic[caseId] ?? {}),
        ...Object.keys(semantic[caseId] ?? {}),
      ])
    ) {
      diffPaths(
        golden.semantic[caseId]?.[op],
        semantic[caseId]?.[op],
        `${caseId}.${op}`,
        failures,
      );
    }
  }
  const metaDiffs: string[] = [];
  diffPaths(golden.meta, meta, "meta", metaDiffs);
  const report = {
    mode,
    semanticFailures: failures,
    metaDifferences: metaDiffs,
    metaGolden: golden.meta,
    metaActual: meta,
  };
  await Deno.writeTextFile(
    `${outDir}/compare-report.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  return failures.length ? 1 : 0;
}
if (import.meta.main) Deno.exit(await main());
