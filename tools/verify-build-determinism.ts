import { GitModelRepository } from "../src/adapters/out/git/repository.ts";
import { ToolkitCompiler } from "../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import {
  artifactDigest,
  artifactPayload,
  buildKey,
  recipeDigest,
} from "../src/domain/model/value-objects/build.ts";
import { executionDigest } from "../src/domain/primitives/execution-digest.ts";
import { modelSourceDigest } from "../src/domain/model/value-objects/sources.ts";
import { defaultToolkitPackageDir } from "../src/infrastructure/native/runtime-location.ts";

/** Recompile every commit of example model repositories and compare the
 * stored artifact byte-for-byte, across processes, workers and locales.
 *
 * Reads only copies under /tmp: never point it at a live project directory.
 * Needs the pinned Toolkit: SYSML_TOOLKIT_DIR or .data/toolchains.
 *
 * Usage:
 *   deno run --allow-read --allow-write --allow-env --allow-run
 *     --allow-net=127.0.0.1,localhost --allow-ffi=./node_modules
 *     tools/verify-build-determinism.ts --project <dir> [--project <dir>...]
 *     [--commits <n>] [--locales da_DK.UTF-8,tr_TR.UTF-8] [--keep-tmp]
 */
const localesDefault = ["da_DK.UTF-8", "tr_TR.UTF-8"];
const probeValue = {
  zeta: 1,
  æble: 2,
  Åse: [3, { ø: 4, aa: 5 }],
  I: 6,
  i: 7,
  ı: 8,
  İ: 9,
};

function usage(message?: string): never {
  if (message) console.error(`verify-build-determinism: ${message}`);
  console.error(
    "Usage: verify-build-determinism.ts --project <dir> [--project <dir>...] [--commits <n>] [--locales <csv>] [--keep-tmp] | --probe-compile <dir> <version> | --probe-digests <dir> <version>",
  );
  Deno.exit(2);
}

function toolkitPackageDir(): string {
  return Deno.env.get("SYSML_TOOLKIT_DIR") ??
    defaultToolkitPackageDir();
}

async function copyTree(source: string, target: string): Promise<void> {
  const child = new Deno.Command("cp", {
    args: ["-a", source, target],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = await child.output();
  if (!output.success) {
    throw new Error(
      `Copy failed: ${new TextDecoder().decode(output.stderr).slice(0, 300)}`,
    );
  }
}

async function openCopy(
  projectDir: string,
  keepTmp: boolean,
): Promise<{ copy: string; release: () => Promise<void> }> {
  const stat = await Deno.stat(projectDir).catch(() => null);
  if (!stat?.isDirectory) usage(`Not a directory: ${projectDir}`);
  const copy = await Deno.makeTempDir({ prefix: "verify-build-" });
  await copyTree(`${projectDir}/.`, copy);
  return {
    copy,
    release: keepTmp
      ? () => Promise.resolve()
      : () => Deno.remove(copy, { recursive: true }),
  };
}

async function compileRevision(copy: string, version: string) {
  const repository = await GitModelRepository.open({
    projectDir: copy,
    compiler: new ToolkitCompiler({ packageDir: toolkitPackageDir() }),
  });
  const revision = await repository.at(version);
  const fresh = await new ToolkitCompiler({ packageDir: toolkitPackageDir() })
    .compile(structuredClone(revision.sources));
  return { revision, fresh };
}

async function probeCompile(copy: string, version: string): Promise<void> {
  const { revision, fresh } = await compileRevision(copy, version);
  const payload = artifactPayload({
    provider: fresh.provider,
    engineVersion: fresh.engineVersion,
    elements: fresh.elements,
  });
  console.log(JSON.stringify({
    sourceDigest: revision.sourceDigest,
    artifactDigest: await artifactDigest({
      provider: fresh.provider,
      engineVersion: fresh.engineVersion,
      elements: fresh.elements,
    }),
    executionDigest: await executionDigest(probeValue),
    bytes: new TextEncoder().encode(payload).length,
  }));
}

async function probeDigests(copy: string, version: string): Promise<void> {
  const repository = await GitModelRepository.open({
    projectDir: copy,
    compiler: {
      compile: () => {
        throw new Error("Digest probe must never compile sources");
      },
      recipe: () => {
        throw new Error("Digest probe reports no build recipe");
      },
    },
  });
  const revision = await repository.at(version);
  console.log(JSON.stringify({
    sourceDigest: await modelSourceDigest(revision.sources),
    artifactDigest: await artifactDigest({
      provider: revision.provider,
      engineVersion: revision.engineVersion,
      elements: revision.elements,
    }),
    executionDigest: await executionDigest(probeValue),
  }));
}

async function runProbe(
  args: string[],
  locale?: string,
): Promise<Record<string, string | number>> {
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-net=127.0.0.1,localhost",
      "--allow-ffi=./node_modules",
      new URL(import.meta.url).pathname,
      ...args,
    ],
    env: locale ? { LC_ALL: locale } : {},
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const output = await child.output();
  if (!output.success) {
    throw new Error(
      `Probe ${args[0]} failed: ${
        new TextDecoder().decode(output.stderr).slice(0, 300)
      }`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

const args = Deno.args.slice();
if (args[0] === "--probe-compile" && args.length === 3) {
  await probeCompile(args[1]!, args[2]!);
  Deno.exit(0);
}
if (args[0] === "--probe-digests" && args.length === 3) {
  await probeDigests(args[1]!, args[2]!);
  Deno.exit(0);
}

const projects: string[] = [];
let commitLimit: number | undefined;
let locales = localesDefault;
let keepTmp = false;
for (let index = 0; index < args.length; index++) {
  const flag = args[index]!;
  if (flag === "--project") {
    const dir = args[++index];
    if (!dir) usage("Missing --project directory");
    projects.push(dir!);
  } else if (flag === "--commits") {
    commitLimit = Number(args[++index]);
    if (!Number.isSafeInteger(commitLimit) || commitLimit! < 1) {
      usage("Expected --commits <positive integer>");
    }
  } else if (flag === "--locales") {
    const csv = args[++index];
    if (!csv) usage("Missing --locales list");
    locales = csv!.split(",").map((locale) => locale.trim()).filter(Boolean);
  } else if (flag === "--keep-tmp") {
    keepTmp = true;
  } else usage(`Unknown flag: ${flag}`);
}
if (!projects.length) usage("At least one --project is required");

let failures = 0;
for (const project of projects) {
  const { copy, release } = await openCopy(project, keepTmp);
  try {
    const reader = await GitModelRepository.open({
      projectDir: copy,
      compiler: {
        compile: () => {
          throw new Error("History reads must never compile sources");
        },
        recipe: () => {
          throw new Error("History reads report no build recipe");
        },
      },
    });
    const history = await reader.history(
      commitLimit ? { limit: commitLimit } : {},
    );
    const versions = history.commits.map((commit) => commit.version);
    console.log(`project ${project}: ${versions.length} commits`);
    const compiler = new ToolkitCompiler({ packageDir: toolkitPackageDir() });
    const recipe = await compiler.recipe();
    const recipeId = await recipeDigest(recipe);
    for (const version of versions) {
      const revision = await reader.at(version);
      const storedPayload = artifactPayload({
        provider: revision.provider,
        engineVersion: revision.engineVersion,
        elements: revision.elements,
      });
      const fresh = await compiler.compile(
        structuredClone(revision.sources),
      );
      const freshPayload = artifactPayload({
        provider: fresh.provider,
        engineVersion: fresh.engineVersion,
        elements: fresh.elements,
      });
      const sourceOk = revision.sourceDigest ===
        await modelSourceDigest(revision.sources);
      const bytesOk = storedPayload === freshPayload;
      // A second in-process compile exercises the warm worker path.
      const warm = await compiler.compile(
        structuredClone(revision.sources),
      );
      const warmOk = artifactPayload({
        provider: warm.provider,
        engineVersion: warm.engineVersion,
        elements: warm.elements,
      }) === freshPayload;
      const key = await buildKey(revision.sourceDigest, recipeId);
      const status = sourceOk && bytesOk && warmOk ? "MATCH" : "MISMATCH";
      if (status === "MISMATCH") failures++;
      console.log(
        `${status} ${version} S=${revision.sourceDigest.slice(0, 12)} A=${
          (await artifactDigest({
            provider: fresh.provider,
            engineVersion: fresh.engineVersion,
            elements: fresh.elements,
          })).slice(0, 12)
        } K=${key.slice(0, 12)}`,
      );
    }
    const head = versions[0];
    if (head) {
      const cold = await runProbe(["--probe-compile", copy, head]);
      const compileLocale = locales.find((locale) =>
        locale !== Deno.env.get("LC_ALL")
      ) ?? (Deno.env.get("LC_ALL") === "da_DK.UTF-8"
        ? "tr_TR.UTF-8"
        : "da_DK.UTF-8");
      const local = await runProbe(
        ["--probe-compile", copy, head],
        compileLocale,
      );
      const coldOk = JSON.stringify(cold) === JSON.stringify(local);
      if (!coldOk) failures++;
      console.log(
        `${
          coldOk ? "MATCH" : "MISMATCH"
        } cold-worker subprocess locale ${compileLocale} ${head}`,
      );
      const reference = await runProbe(["--probe-digests", copy, head]);
      for (const locale of locales) {
        const observed = await runProbe(
          ["--probe-digests", copy, head],
          locale,
        );
        const ok = JSON.stringify(observed) === JSON.stringify(reference);
        if (!ok) failures++;
        console.log(`${ok ? "MATCH" : "MISMATCH"} locale ${locale} ${head}`);
      }
    }
  } finally {
    await release();
  }
}
console.log(failures === 0 ? "DETERMINISTIC" : `MISMATCHES: ${failures}`);
Deno.exit(failures === 0 ? 0 : 1);
