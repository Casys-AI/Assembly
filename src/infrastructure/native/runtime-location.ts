/** Résolution du package natif actif sous `.data/toolchains`.
 *
 * Les installateurs publient des cibles distinctes par plateforme et
 * empreinte des sources, puis mettent à jour un pointeur par runtime. Le
 * pointeur ne contient qu'un nom de base sûr : aucune traversée, aucun lien
 * symbolique, aucune donnée de provenance (les reçus et `buildinfo.json`
 * restent l'autorité dans chaque package). Sans pointeur, l'emplacement
 * historique (« legacy ») est utilisé tel quel.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOLKIT_DEFAULT_PACKAGE,
  TOOLKIT_DIRECTORY,
  TOOLKIT_NATIVE_PLATFORMS,
  type ToolkitNativePlatform,
  toolkitNativePlatform,
} from "../../adapters/sysml-toolkit-pin.ts";

export type NativeRuntimeKind = "toolkit" | "semantic-index";

export const NATIVE_RUNTIME_POINTER_SCHEMA = 1 as const;
const MAX_POINTER_BYTES = 4096;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_BASENAME = /^[A-Za-z0-9._+@-]+$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/** Base historique de l'installation semantic-index (version épinglée 0.1.0). */
export const SEMANTIC_INDEX_NATIVE_BASE = "semantic-index-native-v0.1.0";

const POINTER_FILES: Record<NativeRuntimeKind, string> = {
  toolkit: "sysml-toolkit-active.json",
  "semantic-index": "semantic-index-active.json",
};

export function nativeRuntimePointerFileName(
  runtime: NativeRuntimeKind,
): string {
  return POINTER_FILES[runtime];
}

export function nativeRuntimePointerPath(
  toolchainsDirectory: string,
  runtime: NativeRuntimeKind,
): string {
  return `${resolve(toolchainsDirectory)}/${POINTER_FILES[runtime]}`;
}

function assertPlatform(
  platform: string,
): asserts platform is ToolkitNativePlatform {
  if (!(platform in TOOLKIT_NATIVE_PLATFORMS)) {
    throw new Error(
      `Plateforme native inconnue dans le pointeur : ${platform}`,
    );
  }
}

/** Nom de cible neuve : base, plateforme et 16 premiers hex de l'empreinte source. */
export function fingerprintedNativeDirectory(
  base: string,
  platform: ToolkitNativePlatform,
  sourceSha256: string,
): string {
  assertPlatform(platform);
  if (!SAFE_BASENAME.test(base) || base === "." || base === "..") {
    throw new Error(`Base d'installation native invalide : ${base}`);
  }
  if (!SHA256_PATTERN.test(sourceSha256)) {
    throw new Error(
      "Empreinte source invalide : SHA-256 hexadécimal minuscule requis",
    );
  }
  return `${base}-${platform}-${sourceSha256.slice(0, 16)}`;
}

export function toolkitNativeDirectory(
  platform: ToolkitNativePlatform,
  sourceSha256: string,
): string {
  return fingerprintedNativeDirectory(
    TOOLKIT_DIRECTORY,
    platform,
    sourceSha256,
  );
}

export function semanticNativeDirectory(
  platform: ToolkitNativePlatform,
  sourceSha256: string,
): string {
  return fingerprintedNativeDirectory(
    SEMANTIC_INDEX_NATIVE_BASE,
    platform,
    sourceSha256,
  );
}

/** Ancien répertoire toolkit, conservé intégralement (sans plateforme ni empreinte). */
export function toolkitLegacyDirectory(): string {
  return TOOLKIT_DIRECTORY;
}

/** Ancien répertoire semantic-index : plateforme, mais pas d'empreinte source. */
export function semanticLegacyDirectory(
  platform: ToolkitNativePlatform,
): string {
  assertPlatform(platform);
  return `${SEMANTIC_INDEX_NATIVE_BASE}-${platform}`;
}

export interface NativeRuntimePointer {
  schema: typeof NATIVE_RUNTIME_POINTER_SCHEMA;
  runtime: NativeRuntimeKind;
  platform: ToolkitNativePlatform;
  directory: string;
}

/** Basename sûr uniquement : ni séparateur, ni traversée, ni nom spécial. */
export function isSafeNativeBasename(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 255 && SAFE_BASENAME.test(value) && value !== "." &&
    value !== ".." && !value.startsWith(".");
}

export function serializeNativeRuntimePointer(
  pointer: NativeRuntimePointer,
): string {
  parseNativeRuntimePointer(JSON.stringify(pointer), pointer.runtime);
  return `${
    JSON.stringify({
      schema: pointer.schema,
      runtime: pointer.runtime,
      platform: pointer.platform,
      directory: pointer.directory,
    })
  }\n`;
}

/** Validation stricte : clés exactes, basename sûr, runtime/plateforme déclarés. */
export function parseNativeRuntimePointer(
  text: string,
  expectedRuntime?: NativeRuntimeKind,
): NativeRuntimePointer {
  if (encoder.encode(text).length > MAX_POINTER_BYTES) {
    throw new Error("Pointeur d'installation native trop grand");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Pointeur d'installation native illisible (JSON invalide)");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pointeur d'installation native invalide : objet attendu");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(",") !== "directory,platform,runtime,schema"
  ) {
    throw new Error(
      "Pointeur d'installation native invalide : champs inattendus ou manquants",
    );
  }
  if (record.schema !== NATIVE_RUNTIME_POINTER_SCHEMA) {
    throw new Error("Pointeur d'installation native invalide : schema");
  }
  if (record.runtime !== "toolkit" && record.runtime !== "semantic-index") {
    throw new Error("Pointeur d'installation native invalide : runtime");
  }
  if (expectedRuntime && record.runtime !== expectedRuntime) {
    throw new Error(
      `Pointeur d'installation native pour ${record.runtime}, ${expectedRuntime} attendu`,
    );
  }
  if (typeof record.platform !== "string") {
    throw new Error("Pointeur d'installation native invalide : platform");
  }
  assertPlatform(record.platform);
  if (!isSafeNativeBasename(record.directory)) {
    throw new Error(
      "Pointeur d'installation native invalide : directory doit être un nom de base sûr",
    );
  }
  return {
    schema: NATIVE_RUNTIME_POINTER_SCHEMA,
    runtime: record.runtime,
    platform: record.platform,
    directory: record.directory,
  };
}

export interface ResolveActiveNativePackageOptions {
  toolchainsDirectory: string;
  runtime: NativeRuntimeKind;
  platform?: ToolkitNativePlatform;
  /** Package historique utilisé quand aucun pointeur n'existe. */
  legacyPackageDir: string;
}

function regularDirectorySync(path: string, subject: string): void {
  const info = Deno.lstatSync(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`${subject} refusé : répertoire régulier requis (${path})`);
  }
}

/**
 * Résolution synchrone pour les consommateurs qui ne peuvent pas attendre :
 * pointeur valide -> son package ; pas de pointeur -> legacy. Un pointeur
 * présent mais invalide, divergent ou symbolique échoue fermé.
 */
export function resolveActiveNativePackageDirSync(
  options: ResolveActiveNativePackageOptions,
): string {
  const legacy = resolve(options.legacyPackageDir);
  if (!options.platform) return legacy;
  const pointerPath = nativeRuntimePointerPath(
    options.toolchainsDirectory,
    options.runtime,
  );
  let bytes: Uint8Array;
  try {
    const info = Deno.lstatSync(pointerPath);
    if (!info.isFile || info.isSymlink || info.size > MAX_POINTER_BYTES) {
      throw new Error(
        `Pointeur d'installation native refusé : fichier régulier borné requis (${pointerPath})`,
      );
    }
    bytes = Deno.readFileSync(pointerPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return legacy;
    throw error;
  }
  const pointer = parseNativeRuntimePointer(
    decoder.decode(bytes),
    options.runtime,
  );
  if (pointer.platform !== options.platform) {
    throw new Error(
      `Pointeur d'installation native divergent : plateforme ${pointer.platform}, ${options.platform} attendue`,
    );
  }
  const root = resolve(options.toolchainsDirectory);
  const target = `${root}/${pointer.directory}`;
  regularDirectorySync(target, "Installation native pointée");
  const packageDir = `${target}/package`;
  regularDirectorySync(packageDir, "Package natif pointé");
  return packageDir;
}

/** Même sélection locale pour l'application et les outils de vérification. */
export function defaultToolkitPackageDir(): string {
  return resolveActiveNativePackageDirSync({
    toolchainsDirectory: fileURLToPath(
      new URL("../../../.data/toolchains/", import.meta.url),
    ),
    runtime: "toolkit",
    platform: toolkitNativePlatform(Deno.build.os, Deno.build.arch),
    legacyPackageDir: fileURLToPath(TOOLKIT_DEFAULT_PACKAGE),
  });
}

/**
 * Publication atomique du pointeur, côté installateurs uniquement. Un
 * pointeur déjà identique n'est pas réécrit (octets et date préservés).
 */
export async function writeActiveNativePointer(
  toolchainsDirectory: string,
  runtime: NativeRuntimeKind,
  platform: ToolkitNativePlatform,
  directory: string,
): Promise<void> {
  const content = serializeNativeRuntimePointer({
    schema: NATIVE_RUNTIME_POINTER_SCHEMA,
    runtime,
    platform,
    directory,
  });
  const root = resolve(toolchainsDirectory);
  await Deno.mkdir(root, { recursive: true });
  const pointerPath = nativeRuntimePointerPath(root, runtime);
  try {
    const info = await Deno.lstat(pointerPath);
    if (!info.isFile || info.isSymlink || info.size > MAX_POINTER_BYTES) {
      throw new Error(
        `Pointeur d'installation native refusé : fichier régulier borné requis (${pointerPath})`,
      );
    }
    if (decoder.decode(await Deno.readFile(pointerPath)) === content) return;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const temporary = `${pointerPath}.${crypto.randomUUID()}.next`;
  try {
    await Deno.writeTextFile(temporary, content, { createNew: true });
    await Deno.rename(temporary, pointerPath);
  } finally {
    await Deno.remove(temporary).catch(() => undefined);
  }
}
