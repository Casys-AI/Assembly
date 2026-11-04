/** Local provisioning metadata. SysML remains the source of behavior and rights. */
import {
  createModelProject,
  readModelProject,
} from "../src/adapters/out/filesystem/model-project.ts";
import { basename, join, resolve } from "node:path";
import {
  type ModelSources as Sources,
  validateModelSources as validateSources,
} from "../src/domain/model/value-objects/sources.ts";
import { loadInitialSources } from "../src/adapters/out/filesystem/initial-model-sources.ts";
import { withInitialTools } from "../src/adapters/out/sysml-toolkit/compilation-policies/work/initial-catalog.ts";
import { MAX_INITIAL_TOOLS_JSON_CHARACTERS } from "../src/domain/work/records/initial-tool-catalog.ts";

export interface NamedSystem {
  format: 2;
  name: string;
  id: string;
  port: number;
  createdAt: string;
}

export class SystemPortReserved extends Error {
  constructor(readonly port: number) {
    super(`Le port ${port} est déjà réservé par un système nommé.`);
    this.name = "SystemPortReserved";
  }
}

export function systemName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) || value.length > 63) {
    throw new Error(
      "Nom attendu : 1 à 63 lettres minuscules, chiffres ou tirets.",
    );
  }
  return value;
}

export function systemPort(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Port attendu : un entier entre 1024 et 65535.");
  }
  return value;
}

export function workspacePaths(root: string, name: string) {
  const directory = resolve(root, systemName(name));
  return {
    directory,
    manifest: join(directory, "system.json"),
    project: join(directory, "model-project"),
    sources: join(directory, "model-project", "sources"),
    instance: join(directory, "instance"),
  };
}

export function availablePort(
  preferred?: number,
  reserved: Iterable<number> = [],
): number {
  const assigned = new Set(reserved);
  if (preferred !== undefined && assigned.has(preferred)) {
    throw new Error(
      `Le port ${preferred} est déjà réservé par un système nommé.`,
    );
  }
  const ports = preferred === undefined
    ? Array.from({ length: 87 }, (_, index) => 4313 + index)
    : [systemPort(preferred)];
  for (const port of ports) {
    if (assigned.has(port)) continue;
    try {
      const listener = Deno.listen({ hostname: "127.0.0.1", port });
      listener.close();
      return port;
    } catch (error) {
      if (!(error instanceof Deno.errors.AddrInUse)) throw error;
    }
  }
  throw new Error(
    preferred === undefined
      ? "Aucun port libre entre 4313 et 4399. Utilisez --port=<port>."
      : `Le port ${preferred} est déjà utilisé.`,
  );
}

export async function preparedSources(options: {
  fromSources?: string;
  addSources?: string[];
  initialTools?: string;
}): Promise<Sources> {
  let sources: Sources;
  if (options.fromSources) {
    const input = JSON.parse(await Deno.readTextFile(options.fromSources));
    sources = validateSources(input?.sources ?? input);
  } else sources = validateSources(await loadInitialSources());
  for (const path of options.addSources ?? []) {
    const name = basename(path);
    if (name in sources) {
      throw new Error(`La source ajoutée existe déjà : ${name}`);
    }
    sources = validateSources({
      ...sources,
      [name]: await Deno.readTextFile(path),
    });
  }
  if (options.initialTools) {
    const file = await Deno.stat(options.initialTools);
    if (!file.isFile || file.size > MAX_INITIAL_TOOLS_JSON_CHARACTERS * 4) {
      throw new Error(
        "Fichier de catalogue initial invalide ou trop volumineux.",
      );
    }
    const text = await Deno.readTextFile(options.initialTools);
    if (text.length > MAX_INITIAL_TOOLS_JSON_CHARACTERS) {
      throw new Error("Le manifeste du catalogue initial est trop volumineux.");
    }
    sources = validateSources(withInitialTools(
      sources,
      JSON.parse(text),
      await Deno.readTextFile(
        new URL("../models/initial-tools.sysml", import.meta.url),
      ),
    ));
  }
  return sources;
}

export async function createSystemWorkspace(options: {
  root: string;
  name: string;
  port: number;
  sources: Sources;
}): Promise<NamedSystem> {
  const name = systemName(options.name);
  const port = systemPort(options.port);
  const sources = validateSources(options.sources);
  const paths = workspacePaths(options.root, name);
  await Deno.mkdir(resolve(options.root), { recursive: true });
  try {
    await Deno.mkdir(paths.directory);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(
        `Le système ${name} existe déjà. Utilisez system serve ${name}.`,
      );
    }
    throw error;
  }
  const id = crypto.randomUUID();
  const manifest: NamedSystem = {
    format: 2,
    name,
    id,
    port,
    createdAt: new Date().toISOString(),
  };
  const claim = join(resolve(options.root), `.port-${port}`);
  let ownsClaim = false;
  try {
    try {
      await Deno.writeTextFile(claim, JSON.stringify({ id, name }), {
        createNew: true,
        mode: 0o600,
      });
      ownsClaim = true;
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        throw new SystemPortReserved(port);
      }
      throw error;
    }
    await createModelProject({
      root: paths.directory,
      name: "model-project",
      sources,
    });
    await Deno.mkdir(paths.instance);
    await Deno.writeTextFile(
      paths.manifest,
      JSON.stringify(manifest, null, 2) + "\n",
      {
        createNew: true,
        mode: 0o600,
      },
    );
  } catch (error) {
    // This invocation exclusively created this directory; never remove a
    // pre-existing system when source preparation or metadata publication fails.
    await Deno.remove(paths.directory, { recursive: true });
    if (ownsClaim) await Deno.remove(claim);
    throw error;
  }
  return manifest;
}

/** A system created by a retired workshop version; kept on disk, never resumed. */
export class RetiredSystemFormatError extends Error {
  constructor(readonly systemName: string, readonly format: unknown) {
    super(
      `Manifeste de système invalide : ${systemName} utilise le format retiré ${
        String(format)
      } ; données conservées, système non exécutable par cet atelier.`,
    );
  }
}

export async function readSystemWorkspace(
  root: string,
  name: string,
): Promise<NamedSystem> {
  const paths = workspacePaths(root, name);
  const stat = await Deno.lstat(paths.directory);
  if (!stat.isDirectory || stat.isSymlink) {
    throw new Error("Répertoire de système invalide.");
  }
  const value = JSON.parse(await Deno.readTextFile(paths.manifest));
  if (value?.format === 1) {
    throw new RetiredSystemFormatError(systemName(name), value.format);
  }
  if (
    value?.format !== 2 || value.name !== systemName(name) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) ||
    Object.keys(value).sort().join(",") !== "createdAt,format,id,name,port" ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) throw new Error("Manifeste de système invalide.");
  await readModelProject(paths.project);
  systemPort(value.port);
  return value as NamedSystem;
}

export async function listSystemWorkspaces(
  root: string,
  onIncomplete: (name: string) => void = () => {},
  onRetired: (name: string, format: unknown) => void = () => {},
): Promise<NamedSystem[]> {
  const systems: NamedSystem[] = [];
  try {
    for await (const entry of Deno.readDir(root)) {
      if (!entry.isDirectory || entry.isSymlink) continue;
      try {
        systems.push(await readSystemWorkspace(root, entry.name));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          onIncomplete(entry.name);
          continue;
        }
        // A retired system must not block listing or creating current ones.
        if (error instanceof RetiredSystemFormatError) {
          onRetired(error.systemName, error.format);
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound && !await exists(root)) return [];
    throw error;
  }
  return systems.sort((a, b) => a.name.localeCompare(b.name));
}

/** Reserve the chosen port atomically even when several names are created together. */
export async function createNamedSystem(options: {
  root: string;
  name: string;
  sources: Sources;
  port?: number;
  onIncomplete?: (name: string) => void;
  onRetired?: (name: string, format: unknown) => void;
}): Promise<NamedSystem> {
  const registered = await listSystemWorkspaces(
    options.root,
    options.onIncomplete,
    options.onRetired,
  );
  const assigned = registered.map((system) => system.port);
  while (true) {
    const port = availablePort(options.port, assigned);
    try {
      return await createSystemWorkspace({ ...options, port });
    } catch (error) {
      if (
        !(error instanceof SystemPortReserved) || options.port !== undefined
      ) throw error;
      assigned.push(port);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export function systemEnvironment(
  root: string,
  system: NamedSystem,
): Record<string, string> {
  const paths = workspacePaths(root, system.name);
  return {
    PORT: String(system.port),
    ASSEMBLY_SYSTEM_ID: system.id,
    ASSEMBLY_MODEL_PROJECT_DIR: paths.project,
    ASSEMBLY_DEMO_DATA_DIR: paths.instance,
  };
}
