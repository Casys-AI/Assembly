/**
 * Wrapper TypeScript public (écrit à la main) autour de l'addon napi-rs.
 *
 * Les déclarations des classes et DTO (`../index.d.ts`) sont produites
 * par les macros napi-rs via `@napi-rs/cli` au build ; ce fichier ne les
 * réécrit pas. Il apporte seulement : le chargement du `.node` sous
 * Deno, la validation de la forme dynamique du JSON d'interchange, et
 * de petits helpers d'erreurs/fermeture. API native synchrone : chaque
 * appel bloque le thread JS le temps du travail Rust.
 */
import { createRequire } from "node:module";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as Generated from "../index.d.ts";

export type {
  CheckFindingDto,
  EditPreview,
  EditReport,
  EditSplice,
  ElementDescription,
  ElementRefSnapshot,
  IdMapping,
  MetaclassCount,
  NativeLspServer,
  ResourceCounts,
  SessionSummary,
  SourcePosition,
  SourceText,
  ToolkitLibrary,
  ToolkitSession,
} from "../index.d.ts";

/** Module addon chargé, typé par les déclarations générées. */
export type AddonModule = typeof Generated;

const EXPECTED_EXPORTS = [
  "ToolkitLibrary",
  "ToolkitSession",
  "NativeLspServer",
  "toolkitVersion",
  "addonVersion",
  "checkSyntax",
  "checkSyntaxFindings",
  "nativeResourceCounts",
] as const;

function packageDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

/**
 * Résout le fichier `.node` : chemin explicite si fourni (le lanceur
 * passe toujours `--addon`), sinon l'unique `*.node` du paquet.
 */
export function resolveAddonPath(explicit?: string): string {
  if (explicit && explicit.length > 0) {
    return checkedAddonPath(resolve(explicit));
  }
  const dir = packageDir();
  const candidates = readdirSync(dir).filter((name) => name.endsWith(".node"));
  if (candidates.length !== 1) {
    throw new Error(
      `INVALID_INPUT: expected exactly one .node file in ${dir}, found ${candidates.length}: ${
        candidates.join(", ")
      }`,
    );
  }
  return checkedAddonPath(join(dir, candidates[0]!));
}

function checkedAddonPath(path: string): string {
  if (!path.endsWith(".node")) {
    throw new Error(`INVALID_ADDON: expected a .node file: ${path}`);
  }
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`INVALID_ADDON: expected a regular .node file: ${path}`);
  }
  return path;
}

function checkedModule(value: unknown, origin: string): AddonModule {
  if (!value || typeof value !== "object") {
    throw new Error(`INVALID_ADDON: ${origin} did not return an object`);
  }
  const record = value as Record<string, unknown>;
  const missing = EXPECTED_EXPORTS.filter(
    (name) => typeof record[name] !== "function",
  );
  if (missing.length > 0) {
    throw new Error(
      `INVALID_ADDON: ${origin} is missing exports: ${missing.join(", ")}`,
    );
  }
  return value as AddonModule;
}

/** Charge uniquement le `.node` validé. Le chargeur injectable sert aux
 * tests de contrat sans charger de bibliothèque native. Aucun chargeur JS
 * généré ni autre binding n'est consulté après un échec. */
// Preserve the existing Promise API and rejection semantics for contract callers.
// deno-lint-ignore require-await
export async function loadAddon(
  explicitPath?: string,
  requireNative: (path: string) => unknown = createRequire(import.meta.url),
): Promise<AddonModule> {
  const addonPath = resolveAddonPath(explicitPath);
  try {
    return checkedModule(requireNative(addonPath), `require(${addonPath})`);
  } catch (error) {
    throw new Error(
      `INVALID_ADDON: direct .node load failed (${addonPath}): ${
        String(error)
      }`,
      { cause: error },
    );
  }
}

/** Code stable préfixant les erreurs natives (`SESSION_CLOSED`, ...). */
export function nativeErrorCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z][A-Z_]+):/.exec(message);
  return match ? match[1]! : null;
}

export function isNativeError(error: unknown, code: string): boolean {
  return nativeErrorCode(error) === code;
}

/** Ferme dans l'ordre inverse ; `close()` natif est idempotent. */
export function closeAll(
  closables: ReadonlyArray<{ close(): void }>,
): void {
  for (let i = closables.length - 1; i >= 0; i -= 1) {
    closables[i]!.close();
  }
}

// ---- Forme dynamique du JSON d'interchange ----

/**
 * Une ligne d'interchange Toolkit : au minimum `@id` (identité native)
 * et `@type` (métaclasse). Le reste suit le vocabulaire du Toolkit et
 * n'est pas re-décrit ici.
 */
export interface InterchangeElement {
  "@id": string;
  "@type": string;
  [property: string]: unknown;
}

/**
 * Valide une valeur dynamique comme tableau d'interchange : objets
 * avec `@id`/`@type` chaînes non vides et `@id` uniques. Sert aux
 * résultats de `exportFullObject()`/`exportCompactObject()` comme
 * aux textes parsés.
 */
export function validateInterchange(
  value: unknown,
  what = "interchange",
): InterchangeElement[] {
  if (!Array.isArray(value)) {
    throw new Error(`INVALID_INTERCHANGE: ${what} must be an array`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < value.length; i += 1) {
    const row: unknown = value[i];
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`INVALID_INTERCHANGE: ${what}[${i}] must be an object`);
    }
    const record = row as Record<string, unknown>;
    const id = record["@id"];
    const type = record["@type"];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        `INVALID_INTERCHANGE: ${what}[${i}]["@id"] must be a non-empty string`,
      );
    }
    if (typeof type !== "string" || type.length === 0) {
      throw new Error(
        `INVALID_INTERCHANGE: ${what}[${i}]["@type"] must be a non-empty string`,
      );
    }
    if (seen.has(id)) {
      throw new Error(`INVALID_INTERCHANGE: ${what} has duplicate @id ${id}`);
    }
    seen.add(id);
  }
  return value as InterchangeElement[];
}

/** `JSON.parse` + `validateInterchange` pour les exports texte. */
export function parseInterchangeText(
  text: string,
  what = "interchange text",
): InterchangeElement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `INVALID_INTERCHANGE: ${what} is not JSON: ${String(error)}`,
    );
  }
  return validateInterchange(parsed, what);
}
