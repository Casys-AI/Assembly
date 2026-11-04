import { BundledSkillReadError } from "../../../application/skills/ports.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { join } from "node:path";

/** Bootstrap templates pin each generation's exact asset. Keep the legacy
 * marker and bundle distinct: substituting the new asset would invalidate an
 * admitted ASE skill's content digest. Existing sources are never passed here. */
export async function pinBundledSkillDigests(
  fragment: string,
  root: string | URL = new URL("../../../../skills/", import.meta.url),
): Promise<string> {
  const read = bundledSkillReader(root);
  for (
    const [marker, source] of [
      ["__ASSEMBLY_SKILL_DIGEST__", "bundle:assembly-modeling"],
      ["__ASE_SKILL_DIGEST__", "bundle:ase-modeling"],
    ] as const
  ) {
    if (!fragment.includes(JSON.stringify(marker))) continue;
    const content = await read(source, 65_536);
    const digest = await sha256(content);
    fragment = fragment.replaceAll(
      JSON.stringify(marker),
      JSON.stringify(digest),
    );
  }
  return fragment;
}

/** Source-selected instruction assets. The identifier never names an arbitrary
 * host path; bytes remain outside modelSources until a skill is loaded. */
export function bundledSkillReader(
  root: string | URL = new URL("../../../../skills/", import.meta.url),
) {
  return async (source: string, maximumBytes: number): Promise<string> => {
    try {
      return await readBundledSkill(root, source, maximumBytes);
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.NotADirectory
      ) throw new BundledSkillReadError("unavailable");
      throw error;
    }
  };
}

async function readBundledSkill(
  root: string | URL,
  source: string,
  maximumBytes: number,
): Promise<string> {
  const match = /^bundle:([a-z0-9]+(?:[-_.][a-z0-9]+)*)$/.exec(source);
  if (
    !match || match[1]!.length > 120 ||
    !Number.isSafeInteger(maximumBytes) || maximumBytes < 1 ||
    maximumBytes > 1_048_576
  ) throw new BundledSkillReadError("unavailable");
  const directory = await Deno.realPath(root);
  let folder = join(directory, match[1]!);
  if (match[1] === "ase-modeling") {
    const legacy = join(directory, "legacy");
    let legacyInfo: Deno.FileInfo | undefined;
    try {
      legacyInfo = await Deno.lstat(legacy);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (legacyInfo) {
      if (legacyInfo.isSymlink || !legacyInfo.isDirectory) {
        throw new BundledSkillReadError("unavailable");
      }
      const archived = join(legacy, "ase-modeling");
      try {
        await Deno.lstat(archived);
        folder = archived;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
  const folderInfo = await Deno.lstat(folder);
  if (folderInfo.isSymlink || !folderInfo.isDirectory) {
    throw new BundledSkillReadError("unavailable");
  }
  const filename = join(folder, "SKILL.md");
  const info = await Deno.lstat(filename);
  if (
    info.isSymlink || !info.isFile ||
    await Deno.realPath(filename) !== filename
  ) throw new BundledSkillReadError("unavailable");
  if (info.size === 0) throw new BundledSkillReadError("invalid-content");
  if (info.size > maximumBytes) throw new BundledSkillReadError("limit");
  const file = await Deno.open(filename, { read: true });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const buffer = new Uint8Array(Math.min(16_384, maximumBytes + 1));
      const count = await file.read(buffer);
      if (count === null) break;
      length += count;
      if (length > maximumBytes) {
        throw new BundledSkillReadError("limit");
      }
      chunks.push(buffer.slice(0, count));
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch (error) {
      if (error instanceof TypeError) {
        throw new BundledSkillReadError("invalid-content");
      }
      throw error;
    }
  } finally {
    file.close();
  }
}
