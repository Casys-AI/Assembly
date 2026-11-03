/** Named local systems: prepare, list and serve; no model provider call at creation. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  availablePort,
  createNamedSystem,
  listSystemWorkspaces,
  preparedSources,
  readSystemWorkspace,
  systemEnvironment,
  workspacePaths,
} from "./system-workspace.ts";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const systemsRoot = resolve(appRoot, ".data/systems");

export async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (const arg of rest) {
    if (!arg.startsWith("--")) positional.push(arg);
    else {
      const at = arg.indexOf("=");
      if (at === -1 || at === arg.length - 1) {
        throw new Error("Option attendue : --nom=valeur");
      }
      const name = arg.slice(0, at), value = arg.slice(at + 1);
      options.set(name, [...(options.get(name) ?? []), value]);
    }
  }
  const allowed = command === "create"
    ? ["--port", "--from-sources", "--add-source", "--initial-tools"]
    : command === "serve" || command === "control"
    ? ["--env-file"]
    : [];
  for (const [name, values] of options) {
    if (
      !allowed.includes(name) || name !== "--add-source" && values.length !== 1
    ) {
      throw new Error(`Option invalide : ${name}`);
    }
  }
  if (command === "list" && !positional.length) {
    const systems = await listSystemWorkspaces(
      systemsRoot,
      incompleteSystem,
      retiredSystem,
    );
    if (!systems.length) {
      console.log(
        "Aucun système nommé. Créez-en un avec deno task system create <nom>.",
      );
    }
    for (const system of systems) {
      console.log(
        `${system.name}\thttp://127.0.0.1:${system.port}/\t${
          workspacePaths(systemsRoot, system.name).project
        }`,
      );
    }
    return;
  }
  if (command === "control") {
    const [name, action, path] = positional;
    if (positional.length !== 3 || !["issue", "revoke"].includes(action)) {
      throw new Error(
        "Usage : deno task system control <nom> issue <nouveau-fichier-privé> | revoke <fichier-privé> [--env-file=.env]",
      );
    }
    const system = await readSystemWorkspace(systemsRoot, name);
    const absoluteEnv = resolve(options.get("--env-file")?.[0] ?? ".env");
    if (!(await Deno.stat(absoluteEnv)).isFile) {
      throw new Error("Fichier d’environnement invalide.");
    }
    // Same explicit env-file/named-profile launch as serve, without its runtime,
    // providers, native libraries, server or source/backend initialization.
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        `--env-file=${absoluteEnv}`,
        "--no-prompt",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        "--allow-sys=uid",
        resolve(appRoot, "tools/system-control.ts"),
        action,
        resolve(path),
      ],
      cwd: appRoot,
      env: systemEnvironment(systemsRoot, system),
      stdin: "null",
      stdout: "inherit",
      stderr: "inherit",
    }).spawn();
    const status = await child.status;
    if (!status.success) Deno.exitCode = status.code || 1;
    return;
  }
  if (!["create", "serve"].includes(command) || positional.length !== 1) {
    throw new Error(
      "Usage : deno task system create <nom> [--port=4313] [--from-sources=export.json] [--add-source=exemple.sysml] [--initial-tools=catalogue.json] | serve <nom> [--env-file=.env] | control <nom> issue <nouveau-fichier-privé> | control <nom> revoke <fichier-privé> [--env-file=.env] | list",
    );
  }
  const name = positional[0];
  if (command === "create") {
    const sources = await preparedSources({
      fromSources: options.get("--from-sources")?.[0],
      addSources: options.get("--add-source"),
      initialTools: options.get("--initial-tools")?.[0],
    });
    const preferred = options.get("--port")?.[0];
    const system = await createNamedSystem({
      root: systemsRoot,
      name,
      port: preferred === undefined ? undefined : Number(preferred),
      sources,
      onIncomplete: incompleteSystem,
      onRetired: retiredSystem,
    });
    console.log(
      `Système ${system.name} préparé : ${
        workspacePaths(systemsRoot, name).directory
      }`,
    );
    console.log(`Démarrer : deno task system serve ${name}`);
    if (options.has("--initial-tools")) {
      console.log(
        "Outils initiaux sélectionnés dans le SysML : tests et admission habituels requis avant activation.",
      );
    }
    return;
  }
  const system = await readSystemWorkspace(systemsRoot, name);
  await availablePort(system.port);
  const envFile = options.get("--env-file")?.[0] ?? ".env";
  const absoluteEnv = resolve(envFile);
  if (!(await Deno.stat(absoluteEnv)).isFile) {
    throw new Error("Fichier d’environnement invalide.");
  }
  console.log(`Système ${system.name} : http://127.0.0.1:${system.port}/`);
  const ffiRoot = await Deno.realPath(resolve(appRoot, "node_modules"));
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      `--env-file=${absoluteEnv}`,
      "--no-prompt",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      "--allow-run",
      "--allow-net",
      "--allow-sys=hostname,systemMemoryInfo,cpus",
      `--allow-ffi=${ffiRoot}`,
      resolve(appRoot, "src/main.ts"),
    ],
    cwd: appRoot,
    env: systemEnvironment(systemsRoot, system),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch { /* Already stopped. */ }
  };
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  try {
    const status = await child.status;
    if (!status.success && !status.signal) Deno.exitCode = status.code;
  } finally {
    Deno.removeSignalListener("SIGINT", stop);
    Deno.removeSignalListener("SIGTERM", stop);
  }
}

function retiredSystem(name: string, format: unknown) {
  console.warn(
    `${name}\tformat retiré ${String(format)} : ignoré, données conservées.`,
  );
}

function incompleteSystem(name: string) {
  console.warn(
    `${name}\tcréation incomplète : manifeste absent, données conservées.`,
  );
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
