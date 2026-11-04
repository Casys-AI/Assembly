import { toolkitSubprocessPermissions } from "./toolkit-subprocess-permissions.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import type { validateSourceExecutables } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import type { ModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";

export type MatrixArtifactFixtureName =
  | "initial"
  | "fixture-reviewer-policies"
  | "fixture-delegation";
export interface MatrixArtifactFixture {
  /** Hash of fixture source bytes, computed independently before compilation. */
  pin: { version: ModelRevisionId; sourceDigest: string };
  revision: ModelRevision;
  units: Awaited<ReturnType<typeof validateSourceExecutables>>;
  setup: {
    sourcePreparationMs: number;
    artifactCompilationMs: number;
    executableValidationMs: number;
    isolatedProcessMs: number;
  };
}

/** Repository fixture exposes the independent source pin separately from the
 * compiled artifact, including when a test deliberately tampers with revision. */
export function matrixArtifactRepository(fixture: MatrixArtifactFixture) {
  const pin = Object.freeze({ ...fixture.pin });
  const expectedVersion = pin.version;
  const requireVersion = (version: string) => {
    if (version !== expectedVersion) {
      throw new Error(`Unknown matrix fixture version: ${version}`);
    }
  };
  return {
    at(version: string): Promise<ModelRevision> {
      requireVersion(version);
      return Promise.resolve(fixture.revision);
    },
    header(
      version: string,
    ): Promise<MatrixArtifactFixture["pin"] & Pick<ModelRevision, "sources">> {
      requireVersion(version);
      return Promise.resolve({ ...pin, sources: fixture.revision.sources });
    },
  };
}

/** Compile only in an isolated setup process, then load its trusted artifact.
 * The child exits before the caller starts matrix timings/RSS measurements:
 * no Toolkit runtime, worker or native memory is retained in the measured process.
 * The synthetic delegation source helper has its own preparation compile; its
 * time is reported separately, outside the final artifact compilation. */
export async function prepareMatrixArtifact(
  name: MatrixArtifactFixtureName,
  options: {
    packageDir: string;
    projectId: string;
    version: ModelRevisionId;
  },
): Promise<MatrixArtifactFixture> {
  const directory = await Deno.makeTempDir({ prefix: "ase-matrix-artifact-" });
  const output = `${directory}/artifact.json`;
  const started = performance.now();
  try {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        "--allow-read",
        "--allow-env",
        ...toolkitSubprocessPermissions({
          outputPath: directory,
          packageDir: options.packageDir,
          executable: Deno.execPath(),
        }),
        new URL(import.meta.url).pathname,
        name,
        output,
        options.packageDir,
        options.projectId,
        options.version,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `Matrix artifact setup failed (${result.code}): ${
          new TextDecoder().decode(result.stderr)
        }`,
      );
    }
    const fixture: MatrixArtifactFixture = JSON.parse(
      await Deno.readTextFile(output),
    );
    fixture.setup.isolatedProcessMs = performance.now() - started;
    return fixture;
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

if (import.meta.main) {
  const [name, output, packageDir, projectId, version] = Deno.args;
  if (!name || !output || !packageDir || !projectId || !version) {
    throw new Error("Incomplete matrix artifact setup arguments");
  }
  const { validateSourceExecutables } = await import(
    "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts"
  );
  const { loadInitialSources } = await import(
    "../../src/adapters/out/filesystem/initial-model-sources.ts"
  );
  const { ToolkitCompiler } = await import(
    "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts"
  );
  const { modelSourceDigest } = await import(
    "../../src/domain/model/value-objects/sources.ts"
  );
  const preparationStart = performance.now();
  const sources = name === "initial"
    ? await loadInitialSources()
    : await (await import("./authority-matrix-source-fixtures.ts"))
      .matrixSourceFixtures
      [name as "fixture-reviewer-policies" | "fixture-delegation"]({
        packageDir,
        projectId,
      });
  // This pin is derived from the selected fixture bytes before compilation,
  // not copied from revision.sourceDigest or its output metadata.
  const pin = { version, sourceDigest: await modelSourceDigest(sources) };
  const sourcePreparationMs = performance.now() - preparationStart;
  const compilationStart = performance.now();
  const revision = {
    ...await new ToolkitCompiler({ packageDir }).compile(sources),
    version,
  };
  const artifactCompilationMs = performance.now() - compilationStart;
  const validationStart = performance.now();
  const units = await validateSourceExecutables(revision, projectId);
  const executableValidationMs = performance.now() - validationStart;
  await Deno.writeTextFile(
    output,
    JSON.stringify({
      pin,
      revision,
      units,
      setup: {
        sourcePreparationMs,
        artifactCompilationMs,
        executableValidationMs,
        isolatedProcessMs: 0,
      },
    }),
  );
}
