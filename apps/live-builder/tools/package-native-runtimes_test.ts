import {
  TOOLKIT_NATIVE_PLATFORMS,
  toolkitAddonPath,
  type ToolkitNativePlatform,
} from "../src/adapters/sysml-toolkit-pin.ts";
import type { NativeBundle } from "./native-distribution.ts";
import { readToolkitTar } from "./setup-sysml-toolkit.ts";
import {
  collectLicenseFiles,
  createUstarArchive,
  gzipDeterministic,
  isLicenseFileName,
  spdxLicenseExpression,
  verifyNativeQualifications,
} from "./package-native-runtimes.ts";

function assert(value: unknown, message = "assertion") {
  if (!value) throw new Error(message);
}
function equal<T>(actual: T, expected: T, message = "égalité") {
  if (actual !== expected) {
    throw new Error(
      `${message}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
    );
  }
}

Deno.test("USTAR déterministe, trié et relu par le lecteur strict", () => {
  const entries = [
    { path: "package/b.txt", bytes: new TextEncoder().encode("b") },
    { path: "package/a/c.txt", bytes: new TextEncoder().encode("c") },
  ];
  const first = createUstarArchive(entries);
  const second = createUstarArchive([...entries].reverse());
  assert(first.length % 512 === 0);
  assert(first.every((byte, i) => byte === second[i]), "octets déterministes");
  const read = readToolkitTar(first);
  const files = read.filter((entry) => !entry.directory).map((e) => e.path);
  equal(files.join(","), "package/a/c.txt,package/b.txt");
  assert(
    read.every((entry) =>
      entry.path === "package" || entry.path.startsWith("package/")
    ),
  );
});

Deno.test("gzip déterministe sans mtime", async () => {
  const input = new TextEncoder().encode("ase".repeat(100));
  const first = await gzipDeterministic(input);
  const second = await gzipDeterministic(input);
  assert(first.every((byte, i) => byte === second[i]));
  equal([...first.subarray(4, 8)].join(","), "0,0,0,0");
});

Deno.test("licences : noms reconnus, SPDX lu, aucun texte inventé", () => {
  for (
    const name of [
      "LICENSE",
      "LICENSE-MIT",
      "LICENCE.txt",
      "COPYING",
      "COPYRIGHT.md",
      "NOTICE",
      "UNLICENSE",
      "crates/x/LICENSE-APACHE",
    ]
  ) assert(isLicenseFileName(name), name);
  for (const name of ["README.md", "src/lib.rs", "LICENSES"]) {
    assert(!isLicenseFileName(name), name);
  }
  equal(
    collectLicenseFiles([
      "src/lib.rs",
      "LICENSE-MIT",
      "Cargo.toml",
      "README.md",
    ])
      .join(","),
    "Cargo.toml,LICENSE-MIT",
  );
  equal(
    spdxLicenseExpression('license = "MIT OR Apache-2.0"'),
    "MIT OR Apache-2.0",
  );
  equal(spdxLicenseExpression('license-file = "LICENSE.txt"'), null);
});

Deno.test("USTAR accepte un préfixe valide au-delà des cent premiers octets", () => {
  const path = `package/${"directory/".repeat(10)}file.txt`;
  const bytes = new TextEncoder().encode("contenu");
  const entries = readToolkitTar(createUstarArchive([{ path, bytes }]));
  equal(entries.find((entry) => !entry.directory)?.path, path);
});

function qualificationFixture() {
  const bundles: NativeBundle[] = [];
  const reports: Record<string, unknown>[] = [];
  for (
    const platform of Object.keys(
      TOOLKIT_NATIVE_PLATFORMS,
    ) as ToolkitNativePlatform[]
  ) {
    const results: Record<string, unknown>[] = [];
    for (const runtime of ["toolkit", "semantic-index"] as const) {
      const file = `${runtime}-${platform}.tar.gz`;
      const archive = { file, bytes: 123, sha256: "a".repeat(64) };
      bundles.push({
        runtime,
        platform,
        sourceSha256: "b".repeat(64),
        archive,
        files: {
          "package.json": "c".repeat(64),
          "buildinfo.json": "d".repeat(64),
          [
            runtime === "toolkit"
              ? toolkitAddonPath(platform)
              : "native/ase-semantic-index-napi.node"
          ]: "e".repeat(64),
        },
        release: { repository: "owner/private", tag: "native-v1", asset: file },
      });
      results.push({
        runtime,
        platform,
        sourceSha256: "b".repeat(64),
        archive,
        read: runtime === "toolkit"
          ? {
            resolved: "Qualif::Widget::count",
            typings: ["ScalarValues::Integer"],
            value: "42",
          }
          : { quadCount: 1, rows: 1, released: true },
      });
    }
    reports.push({
      schema: 1,
      qualified: true,
      platform,
      os: platform.startsWith("darwin") ? "darwin" : "linux",
      arch: platform.includes("arm64") ? "aarch64" : "x86_64",
      bundles: results,
    });
  }
  return { catalog: { schema: 1 as const, bundles }, reports };
}

Deno.test("la préparation exige quatre contrats liés aux huit archives exactes", () => {
  const { catalog, reports } = qualificationFixture();
  equal(
    verifyNativeQualifications(catalog, reports, "owner/private", "native-v1")
      .bundles.length,
    8,
  );
  for (
    const mode of [
      "digest",
      "source",
      "platform",
      "failed",
      "read",
      "destination",
      "missing",
    ] as const
  ) {
    const fixture = qualificationFixture();
    const result = (fixture.reports[0].bundles as Record<string, unknown>[])[0];
    if (mode === "digest") {
      result.archive = {
        ...(result.archive as object),
        sha256: "f".repeat(64),
      };
    }
    if (mode === "source") result.sourceSha256 = "f".repeat(64);
    if (mode === "platform") fixture.reports[0].arch = "x86_64";
    if (mode === "failed") fixture.reports[0].qualified = false;
    if (mode === "read") result.read = { resolved: "wrong" };
    if (mode === "destination") {
      fixture.catalog.bundles[0].release.tag = "another-release";
    }
    if (mode === "missing") fixture.reports.pop();
    let refused = false;
    try {
      verifyNativeQualifications(
        fixture.catalog,
        fixture.reports,
        "owner/private",
        "native-v1",
      );
    } catch {
      refused = true;
    }
    assert(refused, `qualification divergente acceptée : ${mode}`);
  }
});
