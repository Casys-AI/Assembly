/** Inspect the admitted Git revision of a checked local model project. */
import { join } from "node:path";
import { resolveRepositoryLayout } from "../filesystem/layout.ts";
import {
  assertModelProjectDirectory,
  readModelProject,
} from "../filesystem/model-project.ts";

/** Read-only view: editable draft and immutable admitted snapshot are distinct. */
export async function inspectModelProject(projectDir: string) {
  const project = await readModelProject(projectDir);
  let admitted: { version: string; snapshotPathCandidate: string } | null =
    null;
  const gitDirectory = join(project.projectDir, ".git");
  try {
    await assertModelProjectDirectory(gitDirectory);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return { project, draft: { sourcesPath: project.sourcesPath }, admitted };
    }
    throw error;
  }
  {
    const result = await new Deno.Command("git", {
      args: [
        "--git-dir",
        gitDirectory,
        "rev-parse",
        "--verify",
        "--quiet",
        "refs/heads/admitted^{commit}",
      ],
      stdout: "piped",
      stderr: "piped",
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "",
      },
    }).output();
    if (result.success) {
      const version = new TextDecoder().decode(result.stdout).trim();
      if (!/^[a-f0-9]{40}$/.test(version)) {
        throw new Error("Invalid admitted Git revision");
      }
      admitted = {
        version: `commit:${version}`,
        snapshotPathCandidate: join(
          (await resolveRepositoryLayout(project.projectDir)).snapshotsDir,
          version,
          "sources",
        ),
      };
    } else if (result.code !== 1) {
      throw new Error("Cannot inspect admitted Git revision");
    }
  }
  return { project, draft: { sourcesPath: project.sourcesPath }, admitted };
}
