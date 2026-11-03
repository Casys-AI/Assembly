/** Manage local source projects without contacting any remote service. */
import { resolve } from "node:path";
import { GitModelRepository } from "../src/adapters/out/git/repository.ts";
import { inspectModelProject } from "../src/adapters/out/git/project-inspection.ts";
import {
  createModelProject,
  listModelProjects,
  readProjectSources,
} from "../src/adapters/out/filesystem/model-project.ts";

export async function main(args: string[]) {
  const [command, ...rest] = args;
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const at = arg.indexOf("=");
    const key = at < 0 ? arg : arg.slice(0, at);
    const value = at < 0 ? rest[++index] : arg.slice(at + 1);
    if (
      !["--root", "--from-sources", "--version"].includes(key) ||
      options.has(key) ||
      !value || value.startsWith("--")
    ) throw new Error(`Invalid option: ${arg}`);
    options.set(key, value);
  }
  const root = resolve(options.get("--root") ?? ".data/projects");
  if (
    command === "create" && positional.length === 1 &&
    options.has("--from-sources") && !options.has("--version")
  ) {
    const sources = await readProjectSources(
      resolve(options.get("--from-sources")!),
    );
    console.log(
      JSON.stringify(
        await createModelProject({ root, name: positional[0], sources }),
        null,
        2,
      ),
    );
  } else if (
    command === "list" && !positional.length &&
    [...options.keys()].every((key) => key === "--root")
  ) {
    console.log(JSON.stringify(await listModelProjects(root), null, 2));
  } else if (
    command === "inspect" && positional.length === 1 && !options.size
  ) {
    const directory = resolve(positional[0]);
    console.log(
      JSON.stringify(await inspectModelProject(directory), null, 2),
    );
  } else if (
    command === "export" && positional.length === 1 &&
    [...options.keys()].every((key) => key === "--version")
  ) {
    const inspected = await inspectModelProject(resolve(positional[0]));
    if (!inspected.admitted) {
      throw new Error(
        "Project has no admitted Git revision; start its backend first",
      );
    }
    const version = options.get("--version") ?? inspected.admitted.version;
    if (!/^commit:[a-f0-9]{40}$/.test(version)) {
      throw new Error("Expected --version commit:<40 lowercase hex digits>");
    }
    const repository = await GitModelRepository.open({
      projectDir: inspected.project.projectDir,
      repositoryId: inspected.project.id,
      compiler: {
        compile: () => {
          throw new Error("Export must never compile sources");
        },
        recipe: () => {
          throw new Error("Export reports no build recipe");
        },
      },
    });
    console.log(
      JSON.stringify(
        { version, sourcesPath: await repository.exportSources(version) },
        null,
        2,
      ),
    );
  } else {throw new Error(
      "Usage: model-project create <name> --from-sources <directory> [--root <directory>] | list [--root <directory>] | inspect <project-directory> | export <project-directory> [--version commit:<sha>]",
    );}
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exitCode = 1;
  }
}
