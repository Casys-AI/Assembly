/** Prepare Deno and both verified native runtimes without starting services. */
import { fileURLToPath } from "node:url";
import { installToolkit } from "./setup-sysml-toolkit.ts";
import { installSemanticIndex } from "./setup-semantic-index.ts";

export interface SetupOptions {
  /** `precompiled` par défaut ; `source` est le seul chemin de compilation. */
  mode?: "precompiled" | "source";
  catalogPath?: string;
  toolkitBundlePath?: string;
  semanticBundlePath?: string;
  toolchainsDirectory?: string;
}

export async function installRuntime(): Promise<string> {
  if (Deno.version.deno !== "2.9.7") {
    throw new Error(
      "Setup requires Deno 2.9.7; install that version and retry.",
    );
  }
  const directory = fileURLToPath(
    new URL("../.data/toolchains/deno-v2.9.7/", import.meta.url),
  );
  const target = `${directory}${
    Deno.build.os === "windows" ? "deno.exe" : "deno"
  }`;
  const executable = await Deno.realPath(Deno.execPath());
  try {
    if (await Deno.realPath(target) === executable) return target;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  try {
    const info = await Deno.lstat(directory);
    if (!info.isDirectory || info.isSymlink) {
      throw new Error(
        `Preserve or move the existing Deno runtime directory before setup: ${directory}`,
      );
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(directory, { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.next`;
  try {
    await Deno.copyFile(executable, temporary);
    if (Deno.build.os !== "windows") await Deno.chmod(temporary, 0o755);
    await Deno.rename(temporary, target);
  } finally {
    try {
      await Deno.remove(temporary);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.error(
          `Could not remove setup temporary file ${temporary}:`,
          error,
        );
      }
    }
  }
  return target;
}

/** Compose les deux runtimes natifs dans le mode demandé. */
export async function installNativeRuntimes(
  options: SetupOptions = {},
): Promise<{ toolkit: string; semanticIndex: string }> {
  const shared = {
    ...(options.mode ? { mode: options.mode } : {}),
    ...(options.catalogPath ? { catalogPath: options.catalogPath } : {}),
    ...(options.toolchainsDirectory
      ? { toolchainsDirectory: options.toolchainsDirectory }
      : {}),
  };
  const toolkit = await installToolkit({
    ...shared,
    ...(options.toolkitBundlePath
      ? { bundlePath: options.toolkitBundlePath }
      : {}),
  });
  const semanticIndex = await installSemanticIndex({
    ...shared,
    ...(options.semanticBundlePath
      ? { bundlePath: options.semanticBundlePath }
      : {}),
  });
  return { toolkit, semanticIndex };
}

export function parseSetupArgs(args: string[]): SetupOptions {
  const options: SetupOptions = {};
  for (const arg of args) {
    if (arg === "--source") options.mode = "source";
    else if (arg.startsWith("--catalog=")) {
      options.catalogPath = arg.slice("--catalog=".length);
    } else if (arg.startsWith("--toolkit-bundle=")) {
      options.toolkitBundlePath = arg.slice("--toolkit-bundle=".length);
    } else if (arg.startsWith("--semantic-bundle=")) {
      options.semanticBundlePath = arg.slice("--semantic-bundle=".length);
    } else if (arg.startsWith("--toolchains-dir=")) {
      options.toolchainsDirectory = arg.slice("--toolchains-dir=".length);
    } else throw new Error(`Unknown setup argument: ${arg}`);
  }
  return options;
}

if (import.meta.main) {
  const options = parseSetupArgs(Deno.args);
  console.log(`Deno 2.9.7 ready: ${await installRuntime()}`);
  const installed = await installNativeRuntimes(options);
  console.log(`SysML Toolkit ready: ${installed.toolkit}`);
  console.log(`Semantic index ready: ${installed.semanticIndex}`);
}
