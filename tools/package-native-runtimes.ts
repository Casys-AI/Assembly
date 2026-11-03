/** Produit les candidats de distribution native (archives + catalogue candidat).
 *
 * Aucun catalogue suivi n'est écrit : la sortie est un répertoire neuf contenant
 * les deux archives déterministes USTAR+gzip, leur catalogue candidat et
 * SHA256SUMS. La promotion reste une opération séparée du workflow.
 * Les licences des crates Rust du vendor commun sont copiées octet pour octet
 * dans les deux packages, avec leur Cargo.toml et l'expression SPDX
 * déclarée ; aucune notice n'est inventée pour les crates sans texte séparé.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TOOLKIT_NATIVE_PLATFORMS,
  toolkitAddonPath,
  type ToolkitNativePlatform,
  toolkitNativePlatform,
} from "../src/adapters/sysml-toolkit-pin.ts";
import {
  type NativeBundle,
  type NativeCatalog,
  parseNativeCatalog,
} from "./native-distribution.ts";
import {
  ensureRustVendor,
  parseRustVendorManifest,
} from "./setup-rust-vendor.ts";
import {
  semanticIndexSourceFingerprint,
  verifySemanticIndexPackage,
} from "./setup-semantic-index.ts";
import {
  addonSourceFingerprint as toolkitFingerprint,
  hashToolkitPackageFiles,
  readToolkitTar,
  sha256,
  verifyToolkitPackage,
} from "./setup-sysml-toolkit.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const LICENSE_STEM =
  /^(?:LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|UNLICENSE)(?:[-_.].*)?$/i;

/** Fichier de licence/notice séparé d'une crate (nom de base uniquement). */
export function isLicenseFileName(name: string): boolean {
  const base = name.split("/").at(-1) ?? name;
  return LICENSE_STEM.test(base);
}

/** Expression SPDX déclarée par un Cargo.toml (`license = "..."`), sinon null. */
export function spdxLicenseExpression(cargoToml: string): string | null {
  const match = /^license\s*=\s*"([^"]+)"\s*$/m.exec(cargoToml);
  return match ? match[1] : null;
}

/** Fichiers conservés d'une crate : licences/notices + manifeste, triés. */
export function collectLicenseFiles(files: readonly string[]): string[] {
  return files.filter((file) =>
    file === "Cargo.toml" || isLicenseFileName(file)
  ).sort();
}

function ustarHeader(
  name: string,
  prefix: string,
  size: number,
  directory: boolean,
): Uint8Array {
  const header = new Uint8Array(512);
  const write = (offset: number, text: string) =>
    header.set(encoder.encode(text), offset);
  write(0, name);
  write(100, directory ? "0000755\0" : "0000644\0");
  write(108, "0000000\0");
  write(116, "0000000\0");
  write(124, `${size.toString(8).padStart(11, "0")}\0`);
  write(136, "00000000000\0");
  write(148, "        ");
  header[156] = directory ? 53 : 48;
  write(257, "ustar\0");
  write(263, "00");
  if (prefix) write(345, prefix);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  write(148, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** Archive USTAR déterministe : chemins triés, mtime/uid/gid fixes, racine unique. */
export function createUstarArchive(
  entries: readonly { path: string; bytes: Uint8Array }[],
): Uint8Array {
  const sorted = [...entries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  const directories = new Set<string>();
  for (const entry of sorted) {
    const parts = entry.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join("/"));
    }
  }
  const all: { path: string; bytes: Uint8Array; directory: boolean }[] = [
    ...[...directories].sort().map((path) => ({
      path,
      bytes: new Uint8Array(0),
      directory: true,
    })),
    ...sorted.map((entry) => ({ ...entry, directory: false })),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const chunks: Uint8Array[] = [];
  for (const entry of all) {
    let name = entry.path;
    let prefix = "";
    if (name.length > 100) {
      let cut = name.lastIndexOf("/");
      while (cut >= 0 && (cut > 155 || name.length - cut - 1 > 100)) {
        cut = name.lastIndexOf("/", cut - 1);
      }
      if (cut < 0) throw new Error(`Chemin USTAR trop long : ${entry.path}`);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    chunks.push(ustarHeader(name, prefix, entry.bytes.length, entry.directory));
    if (!entry.directory) {
      chunks.push(entry.bytes);
      const pad = (512 - (entry.bytes.length % 512)) % 512;
      if (pad) chunks.push(new Uint8Array(pad));
    }
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** gzip déterministe : en-tête sans nom, mtime forcé à zéro. */
export async function gzipDeterministic(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const stream = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(Uint8Array.from(chunk));
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  if (out.length < 10 || out[0] !== 0x1f || out[1] !== 0x8b) {
    throw new Error("Flux gzip inattendu");
  }
  if (out[3] !== 0) throw new Error("En-tête gzip avec options inattendues");
  out[4] = 0;
  out[5] = 0;
  out[6] = 0;
  out[7] = 0; // mtime = 0
  return out;
}

export function archiveFileName(
  runtime: "toolkit" | "semantic-index",
  platform: ToolkitNativePlatform,
): string {
  return runtime === "toolkit"
    ? `ase-toolkit-${platform}.tar.gz`
    : `ase-semantic-index-${platform}.tar.gz`;
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(prefix ? `${root}/${prefix}` : root)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymlink) {
      throw new Error(`Lien refusé dans un package : ${relative}`);
    }
    if (entry.isDirectory) files.push(...await listFiles(root, relative));
    else if (entry.isFile) files.push(relative);
    else throw new Error(`Entrée spéciale refusée : ${relative}`);
  }
  return files.sort();
}

async function hashFiles(
  root: string,
  files: readonly string[],
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of [...files].sort()) {
    hashes[file] = await sha256(await Deno.readFile(`${root}/${file}`));
  }
  return hashes;
}

function arg(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}
function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Argument requis : ${name} <valeur>`);
  return value;
}

function sameArchive(
  actual: unknown,
  expected: NativeBundle["archive"],
): boolean {
  if (!actual || typeof actual !== "object") return false;
  const value = actual as Record<string, unknown>;
  return value.file === expected.file && value.bytes === expected.bytes &&
    value.sha256 === expected.sha256;
}

function sortedCatalog(catalog: NativeCatalog): NativeCatalog {
  return {
    schema: 1,
    bundles: [...catalog.bundles].sort((a, b) =>
      `${a.runtime}/${a.platform}`.localeCompare(`${b.runtime}/${b.platform}`)
    ).map((bundle) => ({
      ...bundle,
      files: Object.fromEntries(
        Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b)),
      ),
    })),
  };
}

/** Les quatre rapports doivent qualifier exactement les huit archives proposées. */
export function verifyNativeQualifications(
  catalog: NativeCatalog,
  reports: readonly unknown[],
  repository: string,
  tag: string,
): NativeCatalog {
  const checked = sortedCatalog(parseNativeCatalog(catalog));
  const platforms = Object.keys(
    TOOLKIT_NATIVE_PLATFORMS,
  ) as ToolkitNativePlatform[];
  if (checked.bundles.length !== 8 || reports.length !== 4) {
    throw new Error("Quatre plateformes et huit bundles qualifiés sont requis");
  }
  for (const platform of platforms) {
    const platformReports = reports.filter((report) =>
      report !== null && typeof report === "object" &&
      (report as Record<string, unknown>).platform === platform
    ) as Record<string, unknown>[];
    if (platformReports.length !== 1) {
      throw new Error(`Rapport ambigu ou absent : ${platform}`);
    }
    const report = platformReports[0];
    if (
      report.schema !== 1 || report.qualified !== true ||
      !Array.isArray(report.bundles) ||
      report.bundles.length !== 2 ||
      toolkitNativePlatform(String(report.os), String(report.arch)) !== platform
    ) throw new Error(`Rapport de qualification invalide : ${platform}`);
    for (const runtime of ["toolkit", "semantic-index"] as const) {
      const bundles = checked.bundles.filter((bundle) =>
        bundle.runtime === runtime && bundle.platform === platform
      );
      if (bundles.length !== 1) {
        throw new Error(`Bundle ambigu ou absent : ${runtime}/${platform}`);
      }
      const bundle = bundles[0];
      if (
        bundle.release.repository !== repository || bundle.release.tag !== tag
      ) {
        throw new Error(
          `Destination de Release divergente : ${runtime}/${platform}`,
        );
      }
      const results = report.bundles.filter((value: unknown) =>
        value !== null && typeof value === "object" &&
        (value as Record<string, unknown>).runtime === runtime
      ) as Record<string, unknown>[];
      if (
        results.length !== 1 || results[0].platform !== platform ||
        results[0].sourceSha256 !== bundle.sourceSha256 ||
        !sameArchive(results[0].archive, bundle.archive)
      ) {
        throw new Error(
          `Rapport non lié aux octets du bundle : ${runtime}/${platform}`,
        );
      }
      const read = results[0].read as Record<string, unknown> | undefined;
      if (
        !read ||
        (runtime === "toolkit"
          ? read.resolved !== "Qualif::Widget::count" || read.value !== "42" ||
            !Array.isArray(read.typings) ||
            !read.typings.includes("ScalarValues::Integer")
          : read.quadCount !== 1 || read.rows !== 1 || read.released !== true)
      ) {
        throw new Error(
          `Lecture native non qualifiée : ${runtime}/${platform}`,
        );
      }
    }
  }
  return checked;
}

async function releaseFile(
  path: string,
  limit = 256 * 1024 * 1024,
): Promise<Uint8Array> {
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size > limit) {
    throw new Error(`Asset non régulier ou trop volumineux : ${path}`);
  }
  const bytes = await Deno.readFile(path);
  if (bytes.length > limit) throw new Error(`Asset trop volumineux : ${path}`);
  return bytes;
}

async function releaseJson(path: string): Promise<unknown> {
  return JSON.parse(decoder.decode(await releaseFile(path, 2 * 1024 * 1024)));
}

async function checkReleaseSources(catalog: NativeCatalog): Promise<void> {
  const sources = {
    toolkit: await toolkitFingerprint(
      fileURLToPath(new URL("../native/toolkit/", import.meta.url)),
    ),
    "semantic-index": await semanticIndexSourceFingerprint(
      fileURLToPath(new URL("../native/semantic-index/", import.meta.url)),
    ),
  };
  for (const bundle of catalog.bundles) {
    if (bundle.sourceSha256 !== sources[bundle.runtime]) {
      throw new Error(
        `Le checkout diffère des sources qualifiées : ${bundle.runtime}`,
      );
    }
  }
}

function releaseSums(catalog: NativeCatalog): string {
  return catalog.bundles.map((bundle) =>
    `${bundle.archive.sha256}  ${bundle.archive.file}`
  ).sort().join("\n") + "\n";
}

async function assembleRelease(repository: string, tag: string): Promise<void> {
  const input = resolve(requiredArg("--input-dir"));
  const output = resolve(requiredArg("--output-dir"));
  const bundles: NativeBundle[] = [];
  const reports: unknown[] = [];
  for (const platform of Object.keys(TOOLKIT_NATIVE_PLATFORMS)) {
    const candidate = parseNativeCatalog(
      await releaseJson(
        `${input}/candidates/native-candidate-${platform}/catalog.json`,
      ),
    );
    const qualified = parseNativeCatalog(
      await releaseJson(
        `${input}/qualified/native-qualified-${platform}/catalog.json`,
      ),
    );
    if (
      JSON.stringify(sortedCatalog(candidate)) !==
        JSON.stringify(sortedCatalog(qualified))
    ) {
      throw new Error(`Catalogue qualifié divergent : ${platform}`);
    }
    bundles.push(...candidate.bundles);
    reports.push(
      await releaseJson(
        `${input}/qualified/native-qualified-${platform}/qualification-report.json`,
      ),
    );
  }
  const catalog = verifyNativeQualifications(
    { schema: 1, bundles },
    reports,
    repository,
    tag,
  );
  await checkReleaseSources(catalog);
  await Deno.mkdir(output);
  for (const bundle of catalog.bundles) {
    const bytes = await releaseFile(
      `${input}/candidates/native-candidate-${bundle.platform}/${bundle.archive.file}`,
    );
    if (
      bytes.length !== bundle.archive.bytes ||
      await sha256(bytes) !== bundle.archive.sha256
    ) {
      throw new Error(
        `Archive divergente après qualification : ${bundle.archive.file}`,
      );
    }
    await Deno.writeFile(`${output}/${bundle.archive.file}`, bytes, {
      createNew: true,
    });
  }
  for (const report of reports as Record<string, unknown>[]) {
    await Deno.writeTextFile(
      `${output}/qualification-${report.platform}.json`,
      JSON.stringify(report, null, 2) + "\n",
      { createNew: true },
    );
  }
  await Deno.writeTextFile(
    `${output}/catalog.json`,
    JSON.stringify(catalog, null, 2) + "\n",
    { createNew: true },
  );
  await Deno.writeTextFile(`${output}/SHA256SUMS`, releaseSums(catalog), {
    createNew: true,
  });
  console.log(
    JSON.stringify({
      prepared: true,
      directory: output,
      bundles: catalog.bundles.length,
    }),
  );
}

async function verifyRelease(repository: string, tag: string): Promise<void> {
  const root = resolve(requiredArg("--release-dir"));
  const catalog = parseNativeCatalog(await releaseJson(`${root}/catalog.json`));
  const reports = await Promise.all(
    Object.keys(TOOLKIT_NATIVE_PLATFORMS).map((platform) =>
      releaseJson(`${root}/qualification-${platform}.json`)
    ),
  );
  const checked = verifyNativeQualifications(catalog, reports, repository, tag);
  await checkReleaseSources(checked);
  const tracked = parseNativeCatalog(
    await releaseJson(resolve(requiredArg("--tracked-catalog"))),
  );
  const approved = sortedCatalog({
    schema: 1,
    bundles: tracked.bundles.filter((bundle) =>
      bundle.release.repository === repository && bundle.release.tag === tag
    ),
  });
  if (JSON.stringify(approved) !== JSON.stringify(checked)) {
    throw new Error(
      "Le catalogue candidat diffère des entrées suivies pour cette Release ; conserver les autres Releases et faire revoir ces entrées avant promotion",
    );
  }
  const expected = new Set([
    "catalog.json",
    "SHA256SUMS",
    ...Object.keys(TOOLKIT_NATIVE_PLATFORMS).map((platform) =>
      `qualification-${platform}.json`
    ),
    ...checked.bundles.map((bundle) => bundle.archive.file),
  ]);
  for await (const entry of Deno.readDir(root)) {
    if (!expected.delete(entry.name) || !entry.isFile || entry.isSymlink) {
      throw new Error(`Asset supplémentaire ou irrégulier : ${entry.name}`);
    }
  }
  if (expected.size) {
    throw new Error(`Assets manquants : ${[...expected].join(", ")}`);
  }
  for (const bundle of checked.bundles) {
    const bytes = await releaseFile(`${root}/${bundle.archive.file}`);
    if (
      bytes.length !== bundle.archive.bytes ||
      await sha256(bytes) !== bundle.archive.sha256
    ) {
      throw new Error(
        `Asset divergent avant promotion : ${bundle.archive.file}`,
      );
    }
  }
  if (
    decoder.decode(await releaseFile(`${root}/SHA256SUMS`, 1024 * 1024)) !==
      releaseSums(checked)
  ) throw new Error("SHA256SUMS divergent du catalogue");
  console.log(
    JSON.stringify({
      assets: [
        ...checked.bundles.map((bundle) => `${root}/${bundle.archive.file}`),
        `${root}/catalog.json`,
        `${root}/SHA256SUMS`,
      ],
    }),
  );
}

async function main(): Promise<void> {
  const toolkitPackage = resolve(requiredArg("--toolkit-package"));
  const semanticPackage = resolve(requiredArg("--semantic-package"));
  const outputDir = resolve(requiredArg("--output-dir"));
  try {
    await Deno.mkdir(outputDir);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) {
      throw new Error(
        `Le répertoire de sortie existe déjà ; le conserver et choisir un chemin neuf : ${outputDir}`,
      );
    }
    throw error;
  }
  const repository = arg("--repository") ?? Deno.env.get("GITHUB_REPOSITORY") ??
    "superWorldSavior/assembly";
  const tag = arg("--tag") ?? "native-runtimes-v1";
  const appRoot = fileURLToPath(new URL("../", import.meta.url));

  const toolkitBuild = JSON.parse(
    decoder.decode(await Deno.readFile(`${toolkitPackage}/buildinfo.json`)),
  );
  const semanticBuild = JSON.parse(
    decoder.decode(await Deno.readFile(`${semanticPackage}/buildinfo.json`)),
  );
  const platform =
    (arg("--platform") ?? toolkitBuild.platform) as ToolkitNativePlatform;
  if (!(platform in TOOLKIT_NATIVE_PLATFORMS)) {
    throw new Error(`Plateforme inconnue : ${String(platform)}`);
  }
  if (semanticBuild.platform !== platform) {
    throw new Error("Plateformes toolkit/semantic-index divergentes");
  }

  const toolkitSourceSha256 = await toolkitFingerprint(
    resolve(arg("--toolkit-crate-dir") ?? `${appRoot}native/toolkit`),
  );
  const semanticSourceSha256 = await semanticIndexSourceFingerprint(
    resolve(arg("--semantic-crate-dir") ?? `${appRoot}native/semantic-index`),
  );
  if (toolkitBuild.bridgeSourceSha256 !== toolkitSourceSha256) {
    throw new Error("Empreinte source toolkit divergente du buildinfo");
  }
  if (semanticBuild.sourceSha256 !== semanticSourceSha256) {
    throw new Error("Empreinte source semantic-index divergente du buildinfo");
  }
  await verifySemanticIndexPackage(
    semanticPackage,
    platform,
    semanticSourceSha256,
  );

  await verifyToolkitPackage(toolkitPackage, platform, toolkitSourceSha256);
  const toolkitOriginalFiles = await hashToolkitPackageFiles(
    toolkitPackage,
    platform,
  );

  // Licences des crates du vendor commun, octets préservés et vérifiés.
  const vendor = await ensureRustVendor();
  const manifestBytes = await Deno.readFile(
    fileURLToPath(new URL("../vendor/rust/manifest.json", import.meta.url)),
  );
  const manifest = parseRustVendorManifest(manifestBytes);
  const toolkitWork = `${outputDir}/.toolkit-package`;
  await Deno.mkdir(toolkitWork, { recursive: true });
  for (const file of Object.keys(toolkitOriginalFiles)) {
    await Deno.mkdir(dirname(`${toolkitWork}/${file}`), { recursive: true });
    await Deno.copyFile(`${toolkitPackage}/${file}`, `${toolkitWork}/${file}`);
  }
  const semanticWork = `${outputDir}/.semantic-package`;
  await Deno.mkdir(semanticWork, { recursive: true });
  for (const file of await listFiles(semanticPackage)) {
    await Deno.mkdir(dirname(`${semanticWork}/${file}`), { recursive: true });
    await Deno.copyFile(
      `${semanticPackage}/${file}`,
      `${semanticWork}/${file}`,
    );
  }
  const licenseIndex: {
    name: string;
    version: string;
    directory: string;
    license: string | null;
    manifest: string;
    licenseFiles: string[];
  }[] = [];
  let withoutText = 0;
  const addLicense = async (
    crateDir: string,
    record: (typeof licenseIndex)[number],
    read: (rel: string) => Promise<Uint8Array>,
    rels: string[],
  ) => {
    for (const rel of rels) {
      const dest = `${semanticWork}/licenses/crates/${crateDir}/${rel}`;
      await Deno.mkdir(dirname(dest), { recursive: true });
      await Deno.writeFile(dest, await read(rel), { createNew: true });
    }
    licenseIndex.push(record);
  };
  for (const crate of manifest.crates) {
    const rels = collectLicenseFiles(Object.keys(crate.files));
    const licenseFiles = rels.filter((file) => file !== "Cargo.toml");
    if (licenseFiles.length === 0) withoutText++;
    const cargoToml = decoder.decode(
      await Deno.readFile(`${vendor.directory}/${crate.directory}/Cargo.toml`),
    );
    await addLicense(
      crate.directory,
      {
        name: crate.name,
        version: crate.version,
        directory: crate.directory,
        license: spdxLicenseExpression(cargoToml),
        manifest: "Cargo.toml",
        licenseFiles,
      },
      async (rel) => {
        const bytes = await Deno.readFile(
          `${vendor.directory}/${crate.directory}/${rel}`,
        );
        if (await sha256(bytes) !== crate.files[rel]) {
          throw new Error(
            `Licence/manifest divergent : ${crate.directory}/${rel}`,
          );
        }
        return bytes;
      },
      rels,
    );
  }
  licenseIndex.sort((a, b) => a.directory.localeCompare(b.directory));
  await Deno.mkdir(`${semanticWork}/licenses`, { recursive: true });
  await Deno.writeTextFile(
    `${semanticWork}/licenses/index.json`,
    `${JSON.stringify({ schema: 1, crates: licenseIndex }, null, 2)}\n`,
    { createNew: true },
  );
  for (const file of await listFiles(`${semanticWork}/licenses`)) {
    const dest = `${toolkitWork}/licenses/${file}`;
    await Deno.mkdir(dirname(dest), { recursive: true });
    await Deno.copyFile(`${semanticWork}/licenses/${file}`, dest);
  }
  const toolkitFiles = await hashFiles(
    toolkitWork,
    await listFiles(toolkitWork),
  );
  const semanticFiles = await hashFiles(
    semanticWork,
    await listFiles(semanticWork),
  );

  const bundles: NativeBundle[] = [];
  const sums: string[] = [];
  const makeBundle = async (
    runtime: NativeBundle["runtime"],
    sourceSha256: string,
    packageDir: string,
    files: Record<string, string>,
  ): Promise<void> => {
    const entries = await Promise.all(
      Object.keys(files).sort().map(async (file) => ({
        path: `package/${file}`,
        bytes: await Deno.readFile(`${packageDir}/${file}`),
      })),
    );
    // Contrôle aller-retour par le lecteur USTAR strict partagé.
    const tar = createUstarArchive(entries);
    readToolkitTar(tar);
    const archive = await gzipDeterministic(tar);
    const file = archiveFileName(runtime, platform);
    await Deno.writeFile(`${outputDir}/${file}`, archive, { createNew: true });
    const archiveSha256 = await sha256(archive);
    sums.push(`${archiveSha256}  ${file}`);
    bundles.push({
      runtime,
      platform,
      sourceSha256,
      archive: { file, bytes: archive.length, sha256: archiveSha256 },
      files,
      release: { repository, tag, asset: file },
    });
  };
  await makeBundle(
    "toolkit",
    toolkitSourceSha256,
    toolkitWork,
    toolkitFiles,
  );
  await makeBundle(
    "semantic-index",
    semanticSourceSha256,
    semanticWork,
    semanticFiles,
  );
  await Deno.remove(toolkitWork, { recursive: true });
  await Deno.remove(semanticWork, { recursive: true });

  bundles.sort((a, b) => a.runtime.localeCompare(b.runtime));
  const catalog: NativeCatalog = parseNativeCatalog({ schema: 1, bundles });
  await Deno.writeTextFile(
    `${outputDir}/catalog.json`,
    `${JSON.stringify(catalog, null, 2)}\n`,
    { createNew: true },
  );
  sums.sort();
  await Deno.writeTextFile(
    `${outputDir}/SHA256SUMS`,
    `${sums.join("\n")}\n`,
    { createNew: true },
  );
  const report = {
    schema: 1,
    platform,
    target: TOOLKIT_NATIVE_PLATFORMS[platform].target,
    repository,
    tag,
    bundles: catalog.bundles.map((bundle) => ({
      runtime: bundle.runtime,
      sourceSha256: bundle.sourceSha256,
      archive: bundle.archive,
      fileCount: Object.keys(bundle.files).length,
    })),
    rustVendor: {
      archiveSha256: vendor.archiveSha256,
      manifestSha256: vendor.manifestSha256,
      crates: licenseIndex.length,
      cratesWithoutSeparateLicenseText: withoutText,
      toolkitAddon: toolkitAddonPath(platform),
    },
  };
  await Deno.writeTextFile(
    `${outputDir}/packaging-report.json`,
    `${JSON.stringify(report, null, 2)}\n`,
    { createNew: true },
  );
  console.log(JSON.stringify(report));
}

if (import.meta.main) {
  if (
    Deno.args.includes("--assemble-release") ||
    Deno.args.includes("--verify-release")
  ) {
    const repository = requiredArg("--repository");
    const tag = requiredArg("--tag");
    if (Deno.args.includes("--assemble-release")) {
      await assembleRelease(repository, tag);
    } else await verifyRelease(repository, tag);
  } else await main();
}
