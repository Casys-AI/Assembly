import { persistedOrder } from "../../../domain/primitives/persisted-order.ts";
/** Local source project metadata, independent from instance execution state. */
import { join, resolve } from "node:path";
import {
  type ModelSources as Sources,
  validateModelSources as validateSources,
} from "../../../domain/model/value-objects/sources.ts";

/** Stable project identity and manifest, independent of local storage. */
export interface ModelProject {
  schemaVersion: 1;
  id: string;
  name: string;
  sourcesDirectory: "sources";
}

export function modelProjectName(name: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 63) {
    throw new Error(
      "Project name must contain 1–63 lowercase letters, digits or hyphens",
    );
  }
  return name;
}

/** A model project located in a checked local source directory. */
export interface LocalModelProject extends ModelProject {
  projectDir: string;
  sourcesPath: string;
}

/** @internal Shared safety check for filesystem projects and their Git metadata. */
export async function assertModelProjectDirectory(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`Unsafe project directory: ${path}`);
  }
}

export async function readModelProject(
  projectDir: string,
): Promise<LocalModelProject> {
  projectDir = resolve(projectDir);
  await assertModelProjectDirectory(projectDir);
  const path = join(projectDir, "model-project.json");
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > 16384) {
    throw new Error("Invalid project manifest file");
  }
  const value = JSON.parse(await Deno.readTextFile(path));
  if (
    value?.schemaVersion !== 1 || typeof value.name !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) ||
    value.sourcesDirectory !== "sources"
  ) throw new Error("Invalid project manifest");
  modelProjectName(value.name);
  await assertModelProjectDirectory(join(projectDir, value.sourcesDirectory));
  return {
    ...value,
    projectDir,
    sourcesPath: join(projectDir, value.sourcesDirectory),
  };
}

/** Reject symlinks, including in nested source directories, before reading. */
export async function readProjectSources(sourceDir: string): Promise<Sources> {
  const sources: Sources = {};
  async function walk(path: string, prefix: string) {
    await assertModelProjectDirectory(path);
    for await (const entry of Deno.readDir(path)) {
      const relative = prefix + entry.name;
      if (entry.isSymlink) {
        throw new Error(`Symlink in project sources: ${relative}`);
      }
      if (entry.isDirectory) await walk(join(path, entry.name), relative + "/");
      else if (entry.isFile && entry.name.endsWith(".sysml")) {
        const file = join(path, entry.name);
        const info = await Deno.lstat(file);
        if (info.isSymlink || !info.isFile || info.size > 1_048_576) {
          throw new Error(`Invalid source: ${relative}`);
        }
        sources[relative] = await Deno.readTextFile(file);
        validateSources(sources);
      }
    }
  }
  await walk(sourceDir, "");
  return validateSources(sources);
}

export async function createModelProject(options: {
  root: string;
  name: string;
  sources: Sources;
}): Promise<{ directory: string; project: ModelProject }> {
  const name = modelProjectName(options.name);
  const sources = validateSources(options.sources);
  const root = resolve(options.root);
  await Deno.mkdir(root, { recursive: true });
  await assertModelProjectDirectory(root);
  const projectDir = join(root, name);
  // Exclusive creation: never replace an existing directory or source tree.
  await Deno.mkdir(projectDir);
  try {
    await Deno.mkdir(join(projectDir, "sources"));
    for (const [path, text] of Object.entries(sources)) {
      const filename = join(projectDir, "sources", path);
      await Deno.mkdir(resolve(filename, ".."), { recursive: true });
      await Deno.writeTextFile(filename, text, { createNew: true });
    }
    const project: ModelProject = {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name,
      sourcesDirectory: "sources",
    };
    await Deno.writeTextFile(
      join(projectDir, "model-project.json"),
      JSON.stringify(project, null, 2) + "\n",
      { createNew: true },
    );
    return { directory: projectDir, project };
  } catch (error) {
    await Deno.remove(projectDir, { recursive: true });
    throw error;
  }
}

export async function listModelProjects(
  root: string,
): Promise<Array<{ directory: string; project: ModelProject }>> {
  const projects: Array<{ directory: string; project: ModelProject }> = [];
  try {
    await assertModelProjectDirectory(root);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  for await (const entry of Deno.readDir(root)) {
    if (!entry.isDirectory || entry.isSymlink) continue;
    const projectDir = join(root, entry.name);
    try {
      await Deno.lstat(join(projectDir, "model-project.json"));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      throw error;
    }
    projects.push({
      directory: resolve(projectDir),
      project: await readModelProject(projectDir),
    });
  }
  return projects.sort((a, b) =>
    persistedOrder(a.project.name, b.project.name)
  );
}
