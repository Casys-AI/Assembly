/** Git tree build-format discrimination (W2d): legacy inline artifact vs
 * descriptor reference. Readers retain both ASE formats permanently:
 * `.ase-build.json` and `.ase-build-ref.json`. New descriptors use
 * `.assembly-build-ref.json`. Encoding a
 * descriptor only ever produces the new entry for a new commit; nothing
 * here rewrites or deletes legacy history.
 */
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { CompiledModel } from "../../../domain/model/records/compiled-model.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  type BuildDescriptor,
  ModelBuildError,
  parseBuildDescriptorStrict,
} from "../../../domain/model/value-objects/build.ts";

export const LEGACY_BUILD_PATH = ".ase-build.json";
export const LEGACY_DESCRIPTOR_BUILD_PATH = ".ase-build-ref.json";
export const DESCRIPTOR_BUILD_PATH = ".assembly-build-ref.json";
const BUILD_PATHS = [
  LEGACY_BUILD_PATH,
  LEGACY_DESCRIPTOR_BUILD_PATH,
  DESCRIPTOR_BUILD_PATH,
] as const;

/** Historical inline snapshot stored in `.ase-build.json`. */
export interface LegacyBuildSnapshot {
  readonly repositoryId: string;
  readonly compiled: CompiledModel;
  readonly digest: string;
}

export type GitRevisionBuild =
  | {
    readonly kind: "legacy";
    readonly legacy: LegacyBuildSnapshot;
    readonly text: string;
  }
  | {
    readonly kind: "descriptor";
    readonly descriptor: BuildDescriptor;
    readonly text: string;
  };

export type GitRevisionFormatErrorCode =
  | "BUILD_FORMAT_AMBIGUOUS"
  | "BUILD_FORMAT_MISSING"
  | "BUILD_FORMAT_INVALID";

const FORMAT_RECOVERY: Record<GitRevisionFormatErrorCode, string> = {
  BUILD_FORMAT_AMBIGUOUS:
    "Keep exactly one build entry per commit: .assembly-build-ref.json, .ase-build-ref.json or .ase-build.json.",
  BUILD_FORMAT_MISSING:
    "This commit carries no model build entry; treat the repository tree as invalid.",
  BUILD_FORMAT_INVALID:
    "Re-derive the build entry from the commit sources and exact recipe, then retry.",
};

export class GitRevisionFormatError extends Error {
  readonly recovery: string;
  constructor(
    readonly code: GitRevisionFormatErrorCode,
    readonly context: Readonly<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "GitRevisionFormatError";
    this.recovery = FORMAT_RECOVERY[code];
  }
}

function invalid(reason: string, extra: Record<string, unknown> = {}): never {
  throw new GitRevisionFormatError(
    "BUILD_FORMAT_INVALID",
    { reason, ...extra },
    `Invalid Git model build entry: ${reason}`,
  );
}

/** Which build format these tree paths declare. Double presence is
 * ambiguity, absence is missing — both refuse before any blob is read. */
export function classifyGitRevisionBuildPaths(
  paths: readonly string[],
): "legacy" | "descriptor" {
  const set = new Set(paths);
  const present = BUILD_PATHS.filter((path) => set.has(path));
  if (present.length > 1) {
    throw new GitRevisionFormatError(
      "BUILD_FORMAT_AMBIGUOUS",
      { paths: present },
      "Commit carries competing model build entries",
    );
  }
  if (present[0] === LEGACY_BUILD_PATH) return "legacy";
  if (present.length) return "descriptor";
  throw new GitRevisionFormatError(
    "BUILD_FORMAT_MISSING",
    { paths: BUILD_PATHS },
    "Commit carries no model build entry",
  );
}

/** Strict descriptor text parse for either descriptor path. */
export function parseBuildRefText(text: string): BuildDescriptor {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    invalid("descriptor is not valid JSON", { cause: String(cause) });
  }
  try {
    return parseBuildDescriptorStrict(value);
  } catch (error) {
    if (error instanceof ModelBuildError) {
      invalid(error.context.reason, { path: error.context.path });
    }
    throw error;
  }
}

/** Legacy snapshot parse: required historical fields only, extra compiled
 * data is preserved so historical artifacts keep their exact digest. */
export function parseLegacyBuildText(text: string): LegacyBuildSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    invalid("legacy snapshot is not valid JSON", { cause: String(cause) });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("legacy snapshot is not an object");
  }
  const record = value as Record<string, unknown>;
  const compiled = record.compiled;
  if (
    typeof record.repositoryId !== "string" || !record.repositoryId ||
    record.repositoryId.length > 512 ||
    !isSha256Hex(record.digest) ||
    !compiled || typeof compiled !== "object" || Array.isArray(compiled)
  ) {
    invalid("legacy snapshot lacks repositoryId, compiled or digest");
  }
  const compiledRecord = compiled as Record<string, unknown>;
  if (
    !compiledRecord.sources ||
    typeof compiledRecord.sources !== "object" ||
    Array.isArray(compiledRecord.sources) ||
    !Array.isArray(compiledRecord.elements) ||
    typeof compiledRecord.sourceDigest !== "string" ||
    typeof compiledRecord.engineVersion !== "string"
  ) {
    invalid("legacy compiled model lacks sources, elements or digests");
  }
  return {
    repositoryId: record.repositoryId as string,
    compiled: compiled as CompiledModel,
    digest: record.digest as string,
  };
}

/** Decode whichever build entry a commit carries. Presence is decided
 * before parsing: two texts are ambiguity even if one would parse. */
export function decodeGitRevisionBuild(input: {
  legacyText?: string | null;
  descriptorText?: string | null;
  legacyDescriptorText?: string | null;
}): GitRevisionBuild {
  const legacyText = input.legacyText ?? null;
  const legacyDescriptorText = input.legacyDescriptorText ?? null;
  const descriptorText = input.descriptorText ?? null;
  const present = [
    [LEGACY_BUILD_PATH, legacyText],
    [LEGACY_DESCRIPTOR_BUILD_PATH, legacyDescriptorText],
    [DESCRIPTOR_BUILD_PATH, descriptorText],
  ].filter(([, text]) => text !== null);
  if (present.length > 1) {
    throw new GitRevisionFormatError(
      "BUILD_FORMAT_AMBIGUOUS",
      { paths: present.map(([path]) => path) },
      "Commit carries competing model build entries",
    );
  }
  const storedDescriptor = descriptorText ?? legacyDescriptorText;
  if (storedDescriptor !== null) {
    return {
      kind: "descriptor",
      descriptor: parseBuildRefText(storedDescriptor),
      text: storedDescriptor,
    };
  }
  if (legacyText !== null) {
    return {
      kind: "legacy",
      legacy: parseLegacyBuildText(legacyText),
      text: legacyText,
    };
  }
  throw new GitRevisionFormatError(
    "BUILD_FORMAT_MISSING",
    { paths: BUILD_PATHS },
    "Commit carries no model build entry",
  );
}

/** New-commit entry for a descriptor build. Validation is strict so a
 * writer can never commit an unreadable reference. Legacy trees in history
 * are untouched: this only emits the entry of the commit being created. */
export function encodeBuildRef(
  descriptor: BuildDescriptor,
): { path: typeof DESCRIPTOR_BUILD_PATH; text: string } {
  const strict = parseBuildDescriptorStrict(descriptor);
  return { path: DESCRIPTOR_BUILD_PATH, text: canonical(strict) };
}

/** Historical digest agreement (unchanged algorithm): the legacy digest
 * covers the canonical compiled snapshot, exactly as writers computed it. */
export async function verifyLegacyBuildSnapshot(
  snapshot: LegacyBuildSnapshot,
): Promise<boolean> {
  return snapshot.digest === await canonicalDigest(snapshot.compiled);
}

/** Static facade over the functions above, for repository wiring. */
export class GitRevisionFormat {
  static readonly LEGACY_PATH = LEGACY_BUILD_PATH;
  static readonly DESCRIPTOR_PATH = DESCRIPTOR_BUILD_PATH;
  static readonly LEGACY_DESCRIPTOR_PATH = LEGACY_DESCRIPTOR_BUILD_PATH;
  static classifyPaths(paths: readonly string[]): "legacy" | "descriptor" {
    return classifyGitRevisionBuildPaths(paths);
  }
  static decode(input: {
    legacyText?: string | null;
    descriptorText?: string | null;
    legacyDescriptorText?: string | null;
  }): GitRevisionBuild {
    return decodeGitRevisionBuild(input);
  }
  static parseDescriptor(text: string): BuildDescriptor {
    return parseBuildRefText(text);
  }
  static parseLegacy(text: string): LegacyBuildSnapshot {
    return parseLegacyBuildText(text);
  }
  static encodeDescriptor(
    descriptor: BuildDescriptor,
  ): { path: typeof DESCRIPTOR_BUILD_PATH; text: string } {
    return encodeBuildRef(descriptor);
  }
  static verifyLegacy(snapshot: LegacyBuildSnapshot): Promise<boolean> {
    return verifyLegacyBuildSnapshot(snapshot);
  }
}
