/** Qualification réelle des candidats natifs d'une plateforme.
 *
 * Réinstalle chaque bundle via installNativeDistribution (catalogue candidat
 * comme autorité, archive locale vérifiée), puis charge réellement les deux
 * runtimes : session Toolkit résolvant un élément utilisateur typé
 * ScalarValues::Integer à valeur littérale, et index Oxigraph chargé/requêté/
 * libéré dans son processus. Aucun contrat --capture ni octet factice ici.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ToolkitNativePlatform,
  toolkitNativePlatform,
} from "../src/adapters/sysml-toolkit-pin.ts";
import { loadSysmlToolkit } from "../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { openNativeSemanticIndex } from "../src/adapters/out/oxigraph/runtime.ts";
import type {
  BuildRef,
  ProjectionRef,
} from "../src/domain/model/value-objects/element-ref.ts";
import {
  installNativeDistribution,
  loadNativeCatalog,
  type NativeBundle,
} from "./native-distribution.ts";
import {
  semanticIndexSourceFingerprint,
  verifySemanticIndexPackage,
} from "./setup-semantic-index.ts";
import {
  addonSourceFingerprint,
  sha256,
  verifyToolkitPackage,
} from "./setup-sysml-toolkit.ts";

function arg(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  return index >= 0 ? Deno.args[index + 1] : undefined;
}
function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Argument requis : ${name} <valeur>`);
  return value;
}

export async function qualifyToolkit(
  packageDir: string,
): Promise<Record<string, unknown>> {
  const runtime = await loadSysmlToolkit(packageDir);
  try {
    const source = JSON.stringify([{
      name: "qualification.sysml",
      text:
        "package Qualif { private import ScalarValues::*; part def Widget { attribute count : ScalarValues::Integer = 42; } }",
    }]);
    const session = runtime.createSession(source);
    try {
      const errors = (JSON.parse(session.check()) as { severity?: string }[])
        .filter((item) => item.severity === "error");
      if (errors.length) {
        throw new Error(`Toolkit check en erreur : ${JSON.stringify(errors)}`);
      }
      const user = session.resolve("Qualif::Widget");
      if (!user) {
        throw new Error("Élément utilisateur Qualif::Widget non résolu");
      }
      try {
        if (session.qualifiedName?.(user) !== "Qualif::Widget") {
          throw new Error("Nom qualifié utilisateur divergent");
        }
      } finally {
        user.free();
      }
      const count = session.resolve("Qualif::Widget::count");
      if (!count) throw new Error("Attribut Qualif::Widget::count non résolu");
      try {
        const typings = session.typings(count).map((typing) => {
          const name = session.qualifiedName?.(typing);
          typing.free();
          return name;
        });
        if (!typings.includes("ScalarValues::Integer")) {
          throw new Error(
            `Typage ScalarValues::Integer absent : ${typings.join(",")}`,
          );
        }
        const value = session.valueSource?.(count)?.trim();
        if (value !== "42") {
          throw new Error(`Valeur littérale 42 non lue : ${String(value)}`);
        }
        return {
          resolved: "Qualif::Widget::count",
          typings,
          value: String(value),
        };
      } finally {
        count.free();
      }
    } finally {
      session.free();
    }
  } finally {
    await runtime.close?.();
  }
}

export async function qualifySemantic(
  packageDir?: string,
): Promise<Record<string, unknown>> {
  const runtime = await openNativeSemanticIndex({
    packageDirectory: packageDir,
  });
  try {
    const digest = (char: string) => char.repeat(64);
    const build: BuildRef = {
      repositoryId: "native-qualification",
      sourceDigest: digest("1"),
      recipeDigest: digest("2"),
      buildKey: digest("3"),
      artifactDigest: digest("4"),
    };
    const quads = new TextEncoder().encode(
      "<urn:ase:qualif:widget> <urn:ase:qualif:count> " +
        `"42"^^<http://www.w3.org/2001/XMLSchema#integer> <urn:ase:build:${build.artifactDigest}> .\n`,
    );
    const projection: ProjectionRef = {
      kind: "nquads",
      projectorVersion: "qualify-native-runtimes-1",
      artifactDigest: build.artifactDigest,
      projectionDigest: await sha256(quads),
    };
    const loaded = await runtime.native.load({ build, projection, quads });
    if (loaded.quadCount !== 1) {
      throw new Error(`Oxigraph quadCount divergent : ${loaded.quadCount}`);
    }
    const result = await runtime.native.query({
      build,
      sparql:
        "SELECT ?o WHERE { <urn:ase:qualif:widget> <urn:ase:qualif:count> ?o }",
      limits: { maxResults: 10, maxBytes: 65536, timeoutMs: 5000 },
    });
    if (
      result.form !== "solutions" || result.rows.length !== 1 ||
      result.truncated ||
      result.rows[0].o?.kind !== "literal" || result.rows[0].o.value !== "42" ||
      result.rows[0].o.datatype !== "http://www.w3.org/2001/XMLSchema#integer"
    ) {
      throw new Error(
        `Résultat Oxigraph inattendu : ${JSON.stringify(result)}`,
      );
    }
    await runtime.native.release(build);
    if (await runtime.native.isLoaded(build)) {
      throw new Error("Index Oxigraph encore chargé après release");
    }
    return {
      quadCount: loaded.quadCount,
      rows: result.rows.length,
      released: true,
    };
  } finally {
    await runtime.close();
  }
}

async function main(): Promise<void> {
  const catalogPath = resolve(requiredArg("--catalog"));
  const bundleDir = resolve(requiredArg("--bundle-dir"));
  const toolchainsDir = resolve(requiredArg("--toolchains-dir"));
  const output = resolve(requiredArg("--output"));
  const platform = (arg("--platform") ??
    toolkitNativePlatform(Deno.build.os, Deno.build.arch)) as
      | ToolkitNativePlatform
      | undefined;
  if (!platform) {
    throw new Error(
      `Plateforme hôte non déclarée : ${Deno.build.os}-${Deno.build.arch}`,
    );
  }
  if (platform !== toolkitNativePlatform(Deno.build.os, Deno.build.arch)) {
    throw new Error("La qualification exige la plateforme native du runner");
  }
  const sourceSha256 = {
    toolkit: await addonSourceFingerprint(
      fileURLToPath(new URL("../native/toolkit/", import.meta.url)),
    ),
    "semantic-index": await semanticIndexSourceFingerprint(
      fileURLToPath(new URL("../native/semantic-index/", import.meta.url)),
    ),
  };
  const catalog = await loadNativeCatalog(catalogPath);
  const bundles = catalog.bundles.filter((bundle) =>
    bundle.platform === platform
  );
  if (bundles.length !== 2) {
    throw new Error(
      `Qualification exige exactement les 2 bundles ${platform}, trouvés : ${bundles.length}`,
    );
  }
  await Deno.mkdir(toolchainsDir, { recursive: true });
  const results: Record<string, unknown>[] = [];
  for (
    const runtime of ["toolkit", "semantic-index"] as const
  ) {
    const bundle: NativeBundle = bundles.find((b) => b.runtime === runtime)!;
    if (bundle.sourceSha256 !== sourceSha256[runtime]) {
      throw new Error(`Empreinte source divergente du checkout : ${runtime}`);
    }
    const targetDirectory =
      `${toolchainsDir}/${runtime}-qualified-${platform}-${
        bundle.sourceSha256.slice(0, 12)
      }`;
    const packageDir = await installNativeDistribution({
      runtime,
      platform,
      sourceSha256: bundle.sourceSha256,
      toolchainsDirectory: toolchainsDir,
      targetDirectory,
      catalogPath,
      bundlePath: `${bundleDir}/${bundle.archive.file}`,
      verifyPackage: runtime === "toolkit"
        ? (dir) => verifyToolkitPackage(dir, platform, bundle.sourceSha256)
        : (dir) =>
          verifySemanticIndexPackage(dir, platform, bundle.sourceSha256),
    });
    const read = runtime === "toolkit"
      ? await qualifyToolkit(packageDir)
      : await qualifySemantic(packageDir);
    results.push({
      runtime,
      platform,
      sourceSha256: bundle.sourceSha256,
      archive: bundle.archive,
      packageDir,
      read,
    });
  }
  const report = {
    schema: 1,
    platform,
    os: Deno.build.os,
    arch: Deno.build.arch,
    bundles: results,
    qualified: true,
  };
  await Deno.writeTextFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}

if (import.meta.main) await main();
