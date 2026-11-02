import { toolkitSubprocessPermissions } from "./toolkit-subprocess-permissions.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import type { AuthorityMatrixArtifactPin } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import type { AuthorityMatrix } from "../../src/domain/governance/records/authority-matrix.ts";
import type { ModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import type { validateSourceExecutables } from "../../src/adapters/model/sources/source-model.ts";

export type MatrixCorrectionVariant = "locale" | "unsupported-targets";
export interface MatrixCorrectionArtifact {
  /** Captured from selected source bytes before the setup compilation. */
  pin: AuthorityMatrixArtifactPin;
  revision: ModelRevision;
  units: Awaited<ReturnType<typeof validateSourceExecutables>>;
}
export interface MatrixLocaleObservation {
  matrix: AuthorityMatrix;
  locale: string;
  canary: string[];
}

/** Compile a real fixture only in an exited setup process. Locale probes then
 * send the same artifact and independent pin through the production process;
 * prepared units supply only the project identity, never the projection input. */
export async function writeMatrixCorrectionArtifact(
  variant: MatrixCorrectionVariant,
  output: string,
  options: { packageDir: string; projectId: string; version: ModelRevisionId },
): Promise<void> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      "--allow-read",
      "--allow-env",
      ...toolkitSubprocessPermissions({
        outputPath: output,
        packageDir: options.packageDir,
        executable: Deno.execPath(),
      }),
      import.meta.filename!,
      "prepare",
      variant,
      output,
      options.packageDir,
      options.projectId,
      options.version,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `Matrix correction setup failed (${result.code}): ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
}

/** "process" is the production path (a child that pins its own locale);
 * "direct" projects the prepared units in the caller's locale, so every sort
 * inside the projector is exercised under that locale. */
export async function observeMatrixLocale(
  artifact: string,
  locale: string,
  mode: "process" | "direct" = "process",
): Promise<MatrixLocaleObservation> {
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-prompt",
      `--allow-read=${artifact}`,
      `--allow-run=${Deno.execPath()}`,
      "--allow-env",
      import.meta.filename!,
      mode === "direct" ? "project-direct" : "project",
      artifact,
    ],
    env: { LC_ALL: locale, LANG: locale },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `Matrix locale probe failed under ${locale}: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return JSON.parse(new TextDecoder().decode(result.stdout));
}

if (import.meta.main) {
  const [mode, ...args] = Deno.args;
  if (mode === "prepare") {
    const [variant, output, packageDir, projectId, version] = args;
    if (
      (variant !== "locale" && variant !== "unsupported-targets") ||
      !output || !packageDir || !projectId || !version
    ) throw new Error("Incomplete matrix correction setup arguments");
    const { ToolkitCompiler } = await import(
      "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts"
    );
    const { loadSysmlToolkit } = await import(
      "../../src/adapters/out/sysml-toolkit/runtime/loader.ts"
    );
    const { validateSourceExecutables } = await import(
      "../../src/adapters/model/sources/source-model.ts"
    );
    const { loadInitialSources } = await import(
      "../../src/adapters/out/filesystem/initial-model-sources.ts"
    );
    const sources: Record<string, string> = variant === "locale"
      ? JSON.parse(
        await Deno.readTextFile(
          new URL(
            "../fixtures/commercial-watch/sources.json",
            import.meta.url,
          ),
        ),
      )
      : await loadInitialSources();
    if (variant === "locale") {
      for (const path of Object.keys(sources)) {
        sources[path] = sources[path]!.replaceAll("ASECollect", "ASEChannel")
          .replaceAll("ASEAnalysis", "aseHub");
      }
    } else {
      const marker = "part liveBuilder : ConversationSystem {";
      const configuration = sources["configuration.sysml"]!;
      if (configuration.split(marker).length !== 2) {
        throw new Error(
          "Expected one liveBuilder declaration in correction fixture",
        );
      }
      const exposures = [true, false].map((enabled) => {
        const access = enabled ? "unsupportedEnabled" : "unsupportedDisabled";
        return `
part ${access} : AssemblyInvocations::BehaviorAccess {
    attribute :>> name = "${access}";
    attribute :>> description = "Exposure to a non-entry action.";
    attribute :>> enabled = ${enabled};
    ref item :>> input : APEContext::ContextEvidenceRequest;
}
bind ${access}.caller = builder;
bind ${access}.target = reply;
`;
      }).join("\n");
      sources["configuration.sysml"] = configuration.replace(
        marker,
        marker + "\n" + exposures,
      );
    }
    const { modelSourceDigest } = await import(
      "../../src/domain/model/value-objects/sources.ts"
    );
    const pin = { version, sourceDigest: await modelSourceDigest(sources) };
    const compiler = new ToolkitCompiler({
      packageDir,
      loadRuntime: () => loadSysmlToolkit(packageDir),
    });
    const revision = { ...await compiler.compile(sources), version };
    const units = await validateSourceExecutables(revision, projectId);
    await Deno.writeTextFile(output, JSON.stringify({ pin, revision, units }));
  } else if (mode === "project") {
    const [path] = args;
    if (!path) throw new Error("Missing matrix correction artifact");
    const fixture: MatrixCorrectionArtifact = JSON.parse(
      await Deno.readTextFile(path),
    );
    const { projectAuthorityMatrixWorker } = await import(
      "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts"
    );
    const projectId = fixture.units[0]?.model.identity.projectId;
    if (!projectId) throw new Error("Missing prepared matrix project identity");
    // The caller's locale varies; production pins its disposable process locale
    // before legacy executable validation, then projects the stored artifact.
    const matrix = await projectAuthorityMatrixWorker({
      revision: fixture.revision,
      pin: fixture.pin,
      projectId,
      name: "locale-proof",
    });
    console.log(JSON.stringify({
      matrix,
      locale: new Intl.Collator().resolvedOptions().locale,
      // Intentionally locale-sensitive: proves these child processes use
      // different collations while the matrix ordering remains canonical.
      canary: ["A_b", "a_b", "ASEChannel", "aseHub", "Z", "Æ", "Å"]
        .toSorted((left, right) => left.localeCompare(right)),
    }));
  } else if (mode === "project-direct") {
    const [path] = args;
    if (!path) throw new Error("Missing matrix correction artifact");
    const fixture: MatrixCorrectionArtifact = JSON.parse(
      await Deno.readTextFile(path),
    );
    const { projectAuthorityMatrix } = await import(
      "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/projection.ts"
    );
    const matrix = await projectAuthorityMatrix({
      revision: fixture.revision,
      units: fixture.units,
      name: "locale-proof",
    });
    console.log(JSON.stringify({
      matrix,
      locale: new Intl.Collator().resolvedOptions().locale,
      canary: ["A_b", "a_b", "ASEChannel", "aseHub", "Z", "Æ", "Å"]
        .toSorted((left, right) => left.localeCompare(right)),
    }));
  } else throw new Error("Unknown matrix correction probe mode");
}
