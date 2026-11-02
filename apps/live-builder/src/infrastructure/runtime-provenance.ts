import type { RuntimeProvenancePort } from "../application/work/runtime/provenance.ts";
import {
  type RuntimeProvenance,
  type RuntimeProvenanceIncompleteReason,
  type RuntimeProvenanceRecord,
  runtimeProvenanceRecord,
} from "../domain/work/value-objects/runtime-provenance.ts";
import type { ToolkitBundleProvenance } from "../adapters/out/sysml-toolkit/runtime/loader.ts";
import { runSysmlToolkitWorker } from "../adapters/out/sysml-toolkit/worker-client.ts";

export interface RuntimeProvenanceOptions {
  /** ASE checkout, independently of the configured model project repository. */
  applicationDirectory: string;
  toolkitPackageDirectory: string;
  /** Only the public settings actually passed to the agent adapter. */
  agents: RuntimeProvenance["agents"];
}

export interface RuntimeProvenanceDependencies {
  runGit(args: readonly string[], directory: string): Promise<string>;
  denoVersion(): string;
  loadToolkitProvenance(directory: string): Promise<ToolkitBundleProvenance>;
}

async function runGit(
  args: readonly string[],
  directory: string,
): Promise<string> {
  // Like the model repository adapter, suppress inherited Git configuration and
  // environment. Status is read-only, including optional index refresh locks.
  const output = await new Deno.Command("git", {
    args: [
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.allow=never",
      "-C",
      directory,
      ...args,
    ],
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error("Application Git provenance unavailable");
  }
  return new TextDecoder().decode(output.stdout);
}

const defaults: RuntimeProvenanceDependencies = {
  runGit,
  denoVersion: () => Deno.version.deno,
  loadToolkitProvenance: (directory) =>
    runSysmlToolkitWorker<ToolkitBundleProvenance>(directory, {
      operation: "provenance",
    }),
};

/** One immutable startup snapshot shared by all operator runtimes. */
export class DenoRuntimeProvenanceCollector implements RuntimeProvenancePort {
  readonly #options: RuntimeProvenanceOptions;
  readonly #dependencies: RuntimeProvenanceDependencies;
  #record?: Promise<RuntimeProvenanceRecord>;

  constructor(
    options: RuntimeProvenanceOptions,
    dependencies: Partial<RuntimeProvenanceDependencies> = {},
  ) {
    const agents = options.agents;
    this.#options = {
      applicationDirectory: options.applicationDirectory,
      toolkitPackageDirectory: options.toolkitPackageDirectory,
      agents: {
        provider: agents.provider,
        model: agents.model || "unknown",
        ...(agents.effort === undefined ? {} : { effort: agents.effort }),
        ...(agents.decisionMaxTokens === undefined
          ? {}
          : { decisionMaxTokens: agents.decisionMaxTokens }),
      },
    };
    this.#dependencies = { ...defaults, ...dependencies };
  }

  collect(): Promise<RuntimeProvenanceRecord> {
    return this.#record ??= this.#collect();
  }

  async #collect(): Promise<RuntimeProvenanceRecord> {
    const { runGit, denoVersion, loadToolkitProvenance } = this.#dependencies;
    const directory = this.#options.applicationDirectory;
    const deno = denoVersion();
    const [head, status, toolkit] = await Promise.all([
      runGit(["rev-parse", "--verify", "HEAD"], directory).catch(() => null),
      runGit(
        ["status", "--porcelain=v1", "--untracked-files=normal"],
        directory,
      )
        .catch(() => null),
      loadToolkitProvenance(this.#options.toolkitPackageDirectory),
    ]);
    const headValue = head?.trim();
    const commit =
      headValue && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(headValue)
        ? headValue
        : "unknown";
    const dirty = status === null ? "unknown" : status.trim().length > 0;
    const incompleteReasons: RuntimeProvenanceIncompleteReason[] = [];
    if (this.#options.agents.model === "unknown") {
      // Muse without --model delegates to a CLI default that its offline
      // commands do not expose. Keep startup available without claiming an
      // exact model identity; this status is part of the canonical digest.
      incompleteReasons.push("agent-model-unresolved");
    }
    if (commit === "unknown") incompleteReasons.push("ase-commit-unresolved");
    if (dirty === "unknown") incompleteReasons.push("ase-dirty-unresolved");
    return await runtimeProvenanceRecord({
      schemaVersion: 1,
      complete: incompleteReasons.length === 0,
      incompleteReasons,
      ase: { commit, dirty },
      deno,
      toolkit: { version: toolkit.version, digest: toolkit.digest },
      agents: this.#options.agents,
    });
  }
}
