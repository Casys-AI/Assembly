/** Installation de bundles natifs précompilés autorisés par un catalogue suivi.
 *
 * Le catalogue est l'unique source d'autorisation : il est validé avant toute
 * lecture d'archive locale, tout transport et toute extraction. Aucun repli
 * Rust, npm, JS ou WASM n'existe ici. Une installation existante valide est
 * réutilisée hors ligne après vérification du catalogue local ; une
 * installation divergente n'est jamais remplacée.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  TOOLKIT_NATIVE_PLATFORMS,
  toolkitAddonPath,
  type ToolkitNativePlatform,
} from "../src/adapters/sysml-toolkit-pin.ts";
import { readToolkitTar, sha256 } from "./setup-sysml-toolkit.ts";

export type NativeRuntime = "toolkit" | "semantic-index";

export interface NativeBundle {
  runtime: NativeRuntime;
  platform: ToolkitNativePlatform;
  sourceSha256: string;
  archive: { file: string; bytes: number; sha256: string };
  files: Record<string, string>;
  release: { repository: string; tag: string; asset: string };
}

export interface NativeCatalog {
  schema: 1;
  bundles: NativeBundle[];
}

export interface InstallNativeDistributionOptions {
  runtime: NativeRuntime;
  platform: ToolkitNativePlatform;
  sourceSha256: string;
  toolchainsDirectory: string;
  /** Chemin complet du répertoire d'installation ; son enfant `package/` est final. */
  targetDirectory: string;
  catalogPath?: string;
  bundlePath?: string;
  fetcher?: typeof fetch;
  /** Délai total par réponse, corps compris ; au plus 30 secondes. */
  fetchTimeoutMs?: number;
  env?: (key: string) => string | undefined;
  verifyPackage: (packageDir: string) => Promise<unknown>;
}

const MAX_CATALOG_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_TAR_ENTRIES = 8192;
const MAX_CATALOG_BUNDLES = 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const SEMANTIC_ADDON_PATH = "native/ase-semantic-index-napi.node";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Seules ces erreurs locales peuvent traverser la frontière du transport. */
class BoundedInputError extends Error {}

const RUNTIMES: readonly NativeRuntime[] = ["toolkit", "semantic-index"];
const PLATFORMS = Object.keys(
  TOOLKIT_NATIVE_PLATFORMS,
) as ToolkitNativePlatform[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  subject: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `Catalogue natif invalide : champs inattendus ou manquants pour ${subject} (${
        actual.join(", ")
      })`,
    );
  }
}

function sha256Field(value: unknown, subject: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(
      `Catalogue natif invalide : ${subject} doit être un SHA-256 hexadécimal minuscule`,
    );
  }
  return value;
}

/** Chemin relatif sûr d'un fichier de package : aucun préfixe `package/`, aucune traversée. */
function packageRelativePath(value: unknown, subject: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.length > 512 ||
    value.startsWith("/") || value.includes("\\") || value.includes("\0") ||
    !/^[A-Za-z0-9._/+@-]+$/.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    value === "package" || value.startsWith("package/")
  ) {
    throw new Error(
      `Catalogue natif invalide : chemin de fichier unsafe pour ${subject}`,
    );
  }
  // Aucun repli exécutable script ou WASM ne peut être autorisé.
  if (/\.(?:js|cjs|mjs|wasm)$/i.test(value)) {
    throw new Error(
      `Catalogue natif invalide : fallback JS/WASM interdit (${value})`,
    );
  }
  // Le reçu d'installation est créé par l'installateur, jamais fourni par un bundle.
  if (value === "release.json") {
    throw new Error(
      "Catalogue natif invalide : un bundle ne fournit pas release.json",
    );
  }
  return value;
}

function addonPathFor(
  runtime: NativeRuntime,
  platform: ToolkitNativePlatform,
): string {
  return runtime === "toolkit"
    ? toolkitAddonPath(platform)
    : SEMANTIC_ADDON_PATH;
}

function validateBundle(value: unknown, index: number): NativeBundle {
  const subject = `bundles[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`Catalogue natif invalide : ${subject} doit être un objet`);
  }
  exactKeys(
    value,
    ["runtime", "platform", "sourceSha256", "archive", "files", "release"],
    subject,
  );
  if (!RUNTIMES.includes(value.runtime as NativeRuntime)) {
    throw new Error(
      `Catalogue natif invalide : runtime inconnu pour ${subject}`,
    );
  }
  const runtime = value.runtime as NativeRuntime;
  if (!PLATFORMS.includes(value.platform as ToolkitNativePlatform)) {
    throw new Error(
      `Catalogue natif invalide : plateforme inconnue pour ${subject}`,
    );
  }
  const platform = value.platform as ToolkitNativePlatform;
  const sourceSha256 = sha256Field(
    value.sourceSha256,
    `${subject}.sourceSha256`,
  );

  if (!isRecord(value.archive)) {
    throw new Error(
      `Catalogue natif invalide : ${subject}.archive doit être un objet`,
    );
  }
  exactKeys(value.archive, ["file", "bytes", "sha256"], `${subject}.archive`);
  const archiveFile = value.archive.file;
  if (
    typeof archiveFile !== "string" || archiveFile.length === 0 ||
    archiveFile.includes("/") || archiveFile.includes("\\") ||
    archiveFile.includes("\0") || !archiveFile.endsWith(".tar.gz") ||
    !/^[A-Za-z0-9._+@-]+$/.test(archiveFile)
  ) {
    throw new Error(
      `Catalogue natif invalide : ${subject}.archive.file doit être un nom de base .tar.gz`,
    );
  }
  const archiveBytes = value.archive.bytes;
  if (
    typeof archiveBytes !== "number" || !Number.isSafeInteger(archiveBytes) ||
    archiveBytes <= 0 || archiveBytes > MAX_ARCHIVE_BYTES
  ) {
    throw new Error(
      `Catalogue natif invalide : ${subject}.archive.bytes doit être positif et borné`,
    );
  }
  const archiveSha256 = sha256Field(
    value.archive.sha256,
    `${subject}.archive.sha256`,
  );

  if (
    !isRecord(value.files) || Object.keys(value.files).length === 0 ||
    Object.keys(value.files).length > MAX_TAR_ENTRIES
  ) {
    throw new Error(
      `Catalogue natif invalide : ${subject}.files doit être non vide et borné`,
    );
  }
  const files: Record<string, string> = Object.create(null);
  for (const [path, hash] of Object.entries(value.files)) {
    files[packageRelativePath(path, `${subject}.files`)] = sha256Field(
      hash,
      `${subject}.files[${path}]`,
    );
  }
  for (
    const mandatory of [
      "package.json",
      "buildinfo.json",
      addonPathFor(runtime, platform),
    ]
  ) {
    if (!Object.hasOwn(files, mandatory)) {
      throw new Error(
        `Catalogue natif invalide : ${subject}.files doit contenir ${mandatory}`,
      );
    }
  }
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/");
      if (Object.hasOwn(files, parent)) {
        throw new Error(
          `Catalogue natif invalide : un fichier est aussi un répertoire (${parent})`,
        );
      }
    }
  }

  if (!isRecord(value.release)) {
    throw new Error(
      `Catalogue natif invalide : ${subject}.release doit être un objet`,
    );
  }
  exactKeys(
    value.release,
    ["repository", "tag", "asset"],
    `${subject}.release`,
  );
  const repository = value.release.repository;
  if (
    typeof repository !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/.test(
      repository,
    ) ||
    repository.split("/")[1] === "." || repository.split("/")[1] === ".."
  ) {
    throw new Error(
      `Catalogue natif invalide : ${subject}.release.repository doit suivre owner/name`,
    );
  }
  const tag = value.release.tag;
  if (
    typeof tag !== "string" || tag.length === 0 || tag.length > 256 ||
    /[\s\0]/.test(tag)
  ) {
    throw new Error(
      `Catalogue natif invalide : ${subject}.release.tag invalide`,
    );
  }
  if (value.release.asset !== archiveFile) {
    throw new Error(
      `Catalogue natif invalide : ${subject}.release.asset doit égaler archive.file`,
    );
  }

  return {
    runtime,
    platform,
    sourceSha256,
    archive: { file: archiveFile, bytes: archiveBytes, sha256: archiveSha256 },
    files,
    release: { repository, tag, asset: archiveFile },
  };
}

/** Validation stricte du catalogue suivi : aucun champ ni doublon toléré. */
export function parseNativeCatalog(value: unknown): NativeCatalog {
  if (!isRecord(value)) {
    throw new Error("Catalogue natif invalide : objet attendu");
  }
  exactKeys(value, ["schema", "bundles"], "catalogue");
  if (value.schema !== 1) {
    throw new Error("Catalogue natif invalide : schema doit valoir 1");
  }
  if (
    !Array.isArray(value.bundles) || value.bundles.length > MAX_CATALOG_BUNDLES
  ) {
    throw new Error(
      "Catalogue natif invalide : bundles doit être un tableau borné",
    );
  }
  const bundles = value.bundles.map((bundle, index) =>
    validateBundle(bundle, index)
  );
  const seen = new Set<string>();
  for (const bundle of bundles) {
    const key = `${bundle.runtime}/${bundle.platform}/${bundle.sourceSha256}`;
    if (seen.has(key)) {
      throw new Error(`Catalogue natif invalide : bundle dupliqué pour ${key}`);
    }
    seen.add(key);
  }
  return { schema: 1, bundles };
}

async function regularFile(
  path: string,
  maxBytes: number,
  subject: string,
): Promise<Uint8Array> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink) {
    throw new Error(`${subject} refusé : fichier régulier requis (${path})`);
  }
  if (info.size > maxBytes) {
    throw new Error(
      `${subject} refusé : taille supérieure à la borne (${path})`,
    );
  }
  return await Deno.readFile(path);
}

async function regularDirectory(path: string, subject: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new Error(`${subject} refusé : répertoire régulier requis (${path})`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

export async function loadNativeCatalog(path?: string): Promise<NativeCatalog> {
  const catalogPath = path ? resolve(path) : fileURLToPath(
    new URL("../vendor/native-runtimes/catalog.json", import.meta.url),
  );
  let bytes: Uint8Array;
  try {
    bytes = await regularFile(
      catalogPath,
      MAX_CATALOG_BYTES,
      "Catalogue natif",
    );
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Catalogue natif introuvable : ${catalogPath}. Aucun bundle précompilé ne peut être autorisé sans catalogue suivi.`,
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(
      `Catalogue natif illisible (JSON invalide) : ${catalogPath}`,
    );
  }
  return parseNativeCatalog(parsed);
}

interface Receipt {
  schema: 1;
  runtime: NativeRuntime;
  platform: ToolkitNativePlatform;
  sourceSha256: string;
  bundle: NativeBundle;
}

function installerReceipt(bundle: NativeBundle): Receipt {
  return {
    schema: 1,
    runtime: bundle.runtime,
    platform: bundle.platform,
    sourceSha256: bundle.sourceSha256,
    bundle,
  };
}

function parseReceipt(bytes: Uint8Array, target: string): Receipt {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new Error(`Reçu d'installation illisible : ${target}/release.json`);
  }
  if (!isRecord(value)) {
    throw new Error(`Reçu d'installation invalide : ${target}/release.json`);
  }
  exactKeys(
    value,
    ["schema", "runtime", "platform", "sourceSha256", "bundle"],
    "release.json",
  );
  if (value.schema !== 1) {
    throw new Error(
      `Reçu d'installation invalide (schema) : ${target}/release.json`,
    );
  }
  const bundle = validateBundle(value.bundle, 0);
  if (
    value.runtime !== bundle.runtime || value.platform !== bundle.platform ||
    value.sourceSha256 !== bundle.sourceSha256
  ) {
    throw new Error(`Reçu d'installation incohérent : ${target}/release.json`);
  }
  return installerReceipt(bundle);
}

/** Inventaire exact d'un package : fichiers réguliers uniquement, aucun lien. */
async function listPackageFiles(
  packageDir: string,
): Promise<{ files: string[]; directories: string[] }> {
  await regularDirectory(packageDir, "Package natif installé");
  const files: string[] = [];
  const directories: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for await (const entry of Deno.readDir(directory)) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymlink) {
        throw new Error(
          `Lien symbolique refusé dans le package installé : ${relative}`,
        );
      }
      if (entry.isDirectory) {
        directories.push(relative);
        await visit(`${directory}/${entry.name}`, relative);
      } else if (entry.isFile) {
        files.push(relative);
      } else {
        throw new Error(
          `Entrée spéciale refusée dans le package installé : ${relative}`,
        );
      }
    }
  };
  await visit(packageDir, "");
  return { files: files.sort(), directories: directories.sort() };
}

async function verifyInstalledPackage(
  packageDir: string,
  bundle: NativeBundle,
): Promise<void> {
  const { files, directories } = await listPackageFiles(packageDir);
  const expected = Object.keys(bundle.files).sort();
  if (
    files.length !== expected.length ||
    files.some((file, index) => file !== expected[index])
  ) {
    throw new Error(
      `Package natif divergent : fichiers attendus [${
        expected.join(", ")
      }], trouvés [${files.join(", ")}]`,
    );
  }
  const legitimate = new Set<string>();
  for (const file of expected) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index++) {
      legitimate.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directory of directories) {
    if (!legitimate.has(directory)) {
      throw new Error(
        `Répertoire non autorisé dans le package installé : ${directory}`,
      );
    }
  }
  for (const [file, expectedHash] of Object.entries(bundle.files)) {
    const bytes = await regularFile(
      `${packageDir}/${file}`,
      MAX_ARCHIVE_BYTES,
      "Fichier de package",
    );
    if (await sha256(bytes) !== expectedHash) {
      throw new Error(
        `Empreinte divergente pour le fichier installé : ${file}`,
      );
    }
  }
}

function bundleIdentity(bundle: NativeBundle): string {
  return JSON.stringify({
    ...bundle,
    files: Object.fromEntries(
      Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
}

/** Réutilisation hors ligne : le catalogue reste l'autorité sur les octets. */
async function verifyExistingInstallation(
  options: InstallNativeDistributionOptions,
  target: string,
  bundle: NativeBundle,
): Promise<string> {
  await regularDirectory(target, "Installation native existante");
  const packageDir = `${target}/package`;
  const receipt = parseReceipt(
    await regularFile(
      `${target}/release.json`,
      MAX_CATALOG_BYTES,
      "Reçu d'installation",
    ),
    target,
  );
  if (
    receipt.runtime !== options.runtime ||
    receipt.platform !== options.platform ||
    receipt.sourceSha256 !== options.sourceSha256 ||
    bundleIdentity(receipt.bundle) !== bundleIdentity(bundle)
  ) {
    throw new Error(
      `Installation native divergente pour ${options.runtime}/${options.platform}/${options.sourceSha256}`,
    );
  }
  await verifyInstalledPackage(packageDir, bundle);
  await options.verifyPackage(packageDir);
  return packageDir;
}

function preserveError(target: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Installation native existante préservée et non remplacée : ${target}. ${detail} Préservez ou déplacez cette installation, puis relancez l'installation.`,
  );
}

/** Le nettoyage ne doit pas prolonger une erreur si le transport ignore cancel. */
function cancelWithoutWaiting(
  stream: { cancel(): Promise<void> } | null | undefined,
): void {
  try {
    void stream?.cancel().catch(() => undefined);
  } catch {
    /* Nettoyage best effort, sans masquer le résultat du transport. */
  }
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  subject: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () =>
      reject(new BoundedInputError(`${subject} : délai de transport dépassé`));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const { done, value } = signal
        ? await Promise.race([reader.read(), aborted])
        : await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        throw new BoundedInputError(
          `${subject} dépasse la borne de ${limit} octets`,
        );
      }
      chunks.push(value);
    }
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    cancelWithoutWaiting(reader);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function readBoundedResponse(
  response: Response,
  limit: number,
  subject: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    throw new BoundedInputError(
      `${subject} dépasse la borne de ${limit} octets`,
    );
  }
  if (response.body) {
    try {
      return await readBoundedStream(response.body, limit, subject, signal);
    } catch (error) {
      if (error instanceof BoundedInputError) throw error;
      throw new Error(
        `${subject} : lecture du corps interrompue. Vérifiez l'accès GitHub puis réessayez.`,
      );
    }
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) {
    throw new BoundedInputError(
      `${subject} dépasse la borne de ${limit} octets`,
    );
  }
  return bytes;
}

async function fetchWithTimeout<T>(
  fetcher: typeof fetch,
  url: string,
  init: { headers: Record<string, string> },
  consume: (response: Response, signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response | undefined;
  try {
    try {
      response = await fetcher(url, {
        headers: init.headers,
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      // Aucun corps, en-tête ni jeton ne doit fuiter dans l'erreur.
      throw new Error(
        `Transport GitHub indisponible pour ${
          new URL(url).host
        } (délai ou réseau). Vérifiez l'accès au dépôt privé puis réessayez.`,
      );
    }
    return await consume(response, controller.signal);
  } finally {
    clearTimeout(timer);
    controller.abort();
    cancelWithoutWaiting(response?.body);
  }
}

function readEnv(
  options: InstallNativeDistributionOptions,
  key: string,
): string | undefined {
  try {
    return (options.env ?? ((name) => Deno.env.get(name)))(key);
  } catch {
    return undefined;
  }
}

function unavailable(status: number, subject: string): Error {
  const hint = status === 401 || status === 403
    ? "Vérifiez GH_TOKEN ou GITHUB_TOKEN et ses droits de lecture sur le dépôt privé."
    : status === 404
    ? "Vérifiez le tag, l'asset publié et l'accès au dépôt privé."
    : "Réessayez après vérification de l'accès GitHub.";
  return new Error(
    `Release GitHub indisponible (${subject}, HTTP ${status}). ${hint}`,
  );
}

/** Téléchargement authentifié d'un asset de Release privée, redirections bornées. */
async function downloadFromRelease(
  options: InstallNativeDistributionOptions,
  bundle: NativeBundle,
): Promise<Uint8Array> {
  const token = readEnv(options, "GH_TOKEN")?.trim() ||
    readEnv(options, "GITHUB_TOKEN")?.trim();
  if (!token) {
    throw new Error(
      "Transport GitHub non authentifié : définissez GH_TOKEN ou GITHUB_TOKEN (lecture du dépôt privé) pour installer le bundle précompilé, ou utilisez le mode source explicite.",
    );
  }
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
  const [owner, name] = bundle.release.repository.split("/");
  const metadataUrl =
    `https://api.github.com/repos/${owner}/${name}/releases/tags/${
      encodeURIComponent(bundle.release.tag)
    }`;
  const metadataBytes = await fetchWithTimeout(fetcher, metadataUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }, async (response, signal) => {
    if (!response.ok) throw unavailable(response.status, "métadonnées");
    return await readBoundedResponse(
      response,
      MAX_METADATA_BYTES,
      "Réponse GitHub",
      signal,
    );
  }, timeoutMs);
  let metadata: unknown;
  try {
    metadata = JSON.parse(decoder.decode(metadataBytes));
  } catch {
    throw new Error("Réponse GitHub illisible (métadonnées de Release).");
  }
  if (!isRecord(metadata) || !Array.isArray(metadata.assets)) {
    throw new Error("Réponse GitHub invalide : assets de Release absents.");
  }
  const asset = metadata.assets.find((entry) =>
    isRecord(entry) && entry.name === bundle.release.asset
  );
  if (!isRecord(asset)) {
    throw new Error(
      `Asset ${bundle.release.asset} absent de la Release ${bundle.release.tag}. Publiez l'asset qualifié ou utilisez le mode source explicite.`,
    );
  }
  if (asset.size !== bundle.archive.bytes) {
    throw new Error(
      `Taille d'asset divergente pour ${bundle.release.asset} : le catalogue autorise ${bundle.archive.bytes} octets.`,
    );
  }
  const assetUrl = asset.url;
  const expectedPrefix =
    `https://api.github.com/repos/${owner}/${name}/releases/assets/`;
  if (
    typeof assetUrl !== "string" || !assetUrl.startsWith(expectedPrefix) ||
    !/^\d+$/.test(assetUrl.slice(expectedPrefix.length))
  ) {
    throw new Error("URL d'asset GitHub non autorisée par le catalogue.");
  }

  let currentUrl = assetUrl;
  let sendAuth = true;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const result = await fetchWithTimeout(
      fetcher,
      currentUrl,
      {
        headers: {
          ...(sendAuth ? { Authorization: `Bearer ${token}` } : {}),
          Accept: "application/octet-stream",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
      async (
        response,
        signal,
      ): Promise<{ location: string | null } | { bytes: Uint8Array }> => {
        if (response.status >= 300 && response.status < 400) {
          return { location: response.headers.get("location") };
        }
        if (!response.ok) throw unavailable(response.status, "asset");
        return {
          bytes: await readBoundedResponse(
            response,
            bundle.archive.bytes,
            "Archive native téléchargée",
            signal,
          ),
        };
      },
      timeoutMs,
    );
    if ("location" in result) {
      const location = result.location;
      if (!location || hop === MAX_REDIRECTS) {
        throw new Error("Redirection GitHub refusée ou trop nombreuse.");
      }
      const next = new URL(location, currentUrl);
      // Seul l'hôte signé GitHub est permis, et jamais avec le jeton.
      if (
        next.protocol !== "https:" ||
        next.hostname !== "release-assets.githubusercontent.com" ||
        (next.port !== "" && next.port !== "443") || next.username !== "" ||
        next.password !== ""
      ) {
        throw new Error(
          "Redirection GitHub vers un hôte non autorisé refusée.",
        );
      }
      currentUrl = next.toString();
      sendAuth = false;
      continue;
    }
    return result.bytes;
  }
  throw new Error("Redirection GitHub trop nombreuse.");
}

async function obtainArchive(
  options: InstallNativeDistributionOptions,
  bundle: NativeBundle,
): Promise<Uint8Array> {
  const bytes = options.bundlePath
    ? await regularFile(
      resolve(options.bundlePath),
      MAX_ARCHIVE_BYTES,
      "Archive native locale",
    )
    : await downloadFromRelease(options, bundle);
  // L'empreinte des octets compressés précède toute décompression/extraction.
  if (
    bytes.length !== bundle.archive.bytes ||
    await sha256(bytes) !== bundle.archive.sha256
  ) {
    throw new Error(
      `Archive native divergente pour ${bundle.archive.file} : taille ou SHA-256 différent du catalogue autorisé. Aucune extraction effectuée.`,
    );
  }
  return bytes;
}

/** Valide intégralement l'archive avant le moindre écrit de fichier de package. */
function validateArchiveEntries(
  tarBytes: Uint8Array,
  bundle: NativeBundle,
): Map<string, Uint8Array> {
  const entries = readToolkitTar(tarBytes, {
    maxBytes: MAX_DECOMPRESSED_BYTES,
    maxEntries: MAX_TAR_ENTRIES,
  });
  const files = new Map<string, Uint8Array>();
  const legitimateDirs = new Set<string>(["package"]);
  for (const file of Object.keys(bundle.files)) {
    const parts = `package/${file}`.split("/");
    for (let index = 1; index < parts.length; index++) {
      legitimateDirs.add(parts.slice(0, index).join("/"));
    }
  }
  for (const entry of entries) {
    if (entry.directory) {
      if (!legitimateDirs.has(entry.path)) {
        throw new Error(`Répertoire d'archive non autorisé : ${entry.path}`);
      }
      continue;
    }
    if (!entry.path.startsWith("package/")) {
      throw new Error(`Entrée d'archive hors package/ refusée : ${entry.path}`);
    }
    const relative = entry.path.slice("package/".length);
    if (!Object.hasOwn(bundle.files, relative)) {
      throw new Error(
        `Fichier d'archive non listé par le catalogue : ${relative}`,
      );
    }
    files.set(relative, entry.bytes);
  }
  for (const file of Object.keys(bundle.files)) {
    if (!files.has(file)) {
      throw new Error(`Fichier autorisé absent de l'archive : ${file}`);
    }
  }
  return files;
}

export async function installNativeDistribution(
  options: InstallNativeDistributionOptions,
): Promise<string> {
  if (!RUNTIMES.includes(options.runtime)) {
    throw new Error(`Runtime natif inconnu : ${String(options.runtime)}`);
  }
  if (!PLATFORMS.includes(options.platform)) {
    throw new Error(`Plateforme native inconnue : ${String(options.platform)}`);
  }
  if (!SHA256_PATTERN.test(options.sourceSha256)) {
    throw new Error("sourceSha256 doit être un SHA-256 hexadécimal minuscule");
  }
  if (typeof options.verifyPackage !== "function") {
    throw new Error("verifyPackage est requis pour installer un bundle natif");
  }
  if (
    options.fetchTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.fetchTimeoutMs) ||
      options.fetchTimeoutMs < 1 || options.fetchTimeoutMs > FETCH_TIMEOUT_MS)
  ) throw new Error("fetchTimeoutMs doit être compris entre 1 et 30000 ms");
  const toolchainsDirectory = resolve(options.toolchainsDirectory);
  const target = resolve(options.targetDirectory);
  if (dirname(target) !== toolchainsDirectory) {
    throw new Error(
      "La cible native doit être un enfant direct du répertoire des toolchains",
    );
  }
  await Deno.mkdir(toolchainsDirectory, { recursive: true });
  await regularDirectory(toolchainsDirectory, "Répertoire des toolchains");

  // Verrou propre à ce module ; l'appelant détient déjà `<target>.install.lock`.
  const lockPath = `${target}.distribution.lock`;
  let lock: Deno.FsFile;
  try {
    lock = await Deno.open(lockPath, { createNew: true, write: true });
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(
        `Installation native verrouillée ; inspectez ${lockPath} avant de réessayer`,
      );
    }
    throw error;
  }
  let staging: string | undefined;
  try {
    await lock.write(encoder.encode(JSON.stringify({ pid: Deno.pid })));

    // Le reçu mutable ne peut pas remplacer le catalogue suivi, même hors ligne.
    const catalog = options.catalogPath
      ? await loadNativeCatalog(options.catalogPath)
      : await loadNativeCatalog();
    const bundle = catalog.bundles.find((entry) =>
      entry.runtime === options.runtime &&
      entry.platform === options.platform &&
      entry.sourceSha256 === options.sourceSha256
    );
    if (!bundle) {
      const error = new Error(
        `Aucun bundle natif précompilé autorisé pour ${options.runtime}/${options.platform}/${options.sourceSha256} dans le catalogue suivi. Publiez et qualifiez ce bundle, ou relancez le setup en mode source explicite ; aucun build implicite ne sera tenté.`,
      );
      if (await exists(target)) throw preserveError(target, error);
      throw error;
    }
    if (await exists(target)) {
      try {
        return await verifyExistingInstallation(options, target, bundle);
      } catch (error) {
        throw preserveError(target, error);
      }
    }

    const compressed = await obtainArchive(options, bundle);
    const tarBytes = await readBoundedStream(
      new Blob([Uint8Array.from(compressed)]).stream().pipeThrough(
        new DecompressionStream("gzip"),
      ),
      MAX_DECOMPRESSED_BYTES,
      "Archive native décompressée",
    );
    const files = validateArchiveEntries(tarBytes, bundle);
    for (const [file, bytes] of files) {
      if (await sha256(bytes) !== bundle.files[file]) {
        throw new Error(`Empreinte divergente dans l'archive pour : ${file}`);
      }
    }

    const parent = target.slice(0, target.lastIndexOf("/"));
    staging = await Deno.makeTempDir({
      dir: parent,
      prefix: ".native-distribution-",
    });
    const stagedTarget = staging;
    const packageDir = `${stagedTarget}/package`;
    await Deno.mkdir(packageDir, { recursive: true });
    for (const file of Object.keys(bundle.files).sort()) {
      const destination = `${packageDir}/${file}`;
      await Deno.mkdir(destination.slice(0, destination.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeFile(destination, files.get(file)!, { createNew: true });
    }
    await Deno.writeTextFile(
      `${stagedTarget}/release.json`,
      `${JSON.stringify(installerReceipt(bundle), null, 2)}\n`,
      { createNew: true },
    );
    await verifyInstalledPackage(packageDir, bundle);
    try {
      await options.verifyPackage(packageDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Vérification du package natif refusée avant publication : ${detail}`,
      );
    }
    try {
      if (await exists(target)) {
        throw preserveError(
          target,
          new Error("cible apparue pendant l'installation"),
        );
      }
      await Deno.rename(stagedTarget, target);
    } catch {
      // Une course ne remplace jamais une installation apparue entre-temps.
      if (await exists(target)) {
        throw preserveError(
          target,
          new Error("cible apparue pendant l'installation"),
        );
      }
      throw new Error(`Publication atomique impossible vers ${target}`);
    }
    staging = undefined;
    return packageDir.replace(stagedTarget, target);
  } finally {
    if (staging) {
      await Deno.remove(staging, { recursive: true }).catch(() => undefined);
    }
    lock.close();
    await Deno.remove(lockPath).catch(() => undefined);
  }
}
