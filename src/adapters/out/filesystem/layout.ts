/** Select one reserved local state tree without moving existing user data.
 * Legacy ASE repositories keep their journal, vault and export locations.
 */
import { join } from "node:path";
import { ModelRepositoryError } from "../../../application/model/repository.ts";

export interface RepositoryLayout {
  readonly metadataDir: string;
  readonly stateDir: string;
  readonly snapshotsDir: string;
}

export async function resolveRepositoryLayout(
  projectDir: string,
): Promise<RepositoryLayout> {
  const roots = [join(projectDir, ".assembly"), join(projectDir, ".ase")];
  const present: string[] = [];
  for (const root of roots) {
    try {
      const info = await Deno.lstat(root);
      if (!info.isDirectory || info.isSymlink) {
        throw new ModelRepositoryError(
          "INVALID_REPOSITORY",
          `Unsafe repository directory: ${root}`,
        );
      }
      present.push(root);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (present.length > 1) {
    throw new ModelRepositoryError(
      "INVALID_REPOSITORY",
      "Ambiguous repository state: both .assembly and .ase directories exist; preserve and reconcile them before opening the repository",
    );
  }
  const metadataDir = present[0] ?? roots[0];
  return {
    metadataDir,
    stateDir: join(metadataDir, "runtime"),
    snapshotsDir: join(metadataDir, "snapshots"),
  };
}
