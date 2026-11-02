/** Run explicitly with --allow-read --allow-write --allow-env; uses the
 * committed vendor archives with a fake command runner (no real Rust build).
 * The real native build is qualified by `deno task model:toolkit:setup:source`. */
import assert from "node:assert/strict";
import {
  addonSourceFingerprint,
  type CommandRequest,
  installToolkit,
  sha256,
} from "./setup-sysml-toolkit.ts";
import {
  NAPI_CLI_VERSION,
  RUST_TOOLCHAIN_VERSION,
  TOOLKIT_COMMIT,
  TOOLKIT_DIRECTORY,
  TOOLKIT_NATIVE_PLATFORMS,
  TOOLKIT_RELEASE,
  TOOLKIT_SOURCE_ARCHIVE_SHA256,
  TOOLKIT_SOURCE_DIRECTORY,
  TOOLKIT_SOURCE_SPOT_FILES,
  TOOLKIT_STDLIB_ARCHIVE_SHA256,
} from "../src/adapters/sysml-toolkit-pin.ts";
import {
  createUstarArchive,
  gzipDeterministic,
} from "./package-native-runtimes.ts";

const PLATFORM = "darwin-arm64" as const;
const ADDON_FILE = TOOLKIT_NATIVE_PLATFORMS[PLATFORM].addonFile;
const FAKE_ADDON = new TextEncoder().encode("fake native addon bytes");

function fakeRunner(
  recording: CommandRequest[],
  rustcVersion = RUST_TOOLCHAIN_VERSION,
) {
  return async (request: CommandRequest) => {
    recording.push(request);
    const joined = request.args.join(" ");
    if (request.program.endsWith("rustc") || request.program === "rustc") {
      return { code: 0, stdout: `rustc ${rustcVersion} (fake)\n`, stderr: "" };
    }
    if (request.program.endsWith("cargo") || request.program === "cargo") {
      return { code: 0, stdout: "cargo 1.98.1 (fake)\n", stderr: "" };
    }
    if (request.program === "node") {
      return { code: 0, stdout: "v26.5.0\n", stderr: "" };
    }
    if (request.program === "npm" && joined.includes("build")) {
      // Mirror the real napi outputs, including the JS loader that must
      // never be copied into the installed package.
      const outputFlag = request.args.indexOf("--output-dir");
      assert.notEqual(
        outputFlag,
        -1,
        "NAPI doit écrire dans un répertoire frais",
      );
      const outputDir = request.args[outputFlag + 1];
      assert.ok(outputDir && outputDir !== request.cwd);
      await Deno.writeFile(`${outputDir}/${ADDON_FILE}`, FAKE_ADDON);
      await Deno.writeTextFile(
        `${outputDir}/index.js`,
        "// generated loader\n",
      );
      await Deno.writeTextFile(
        `${outputDir}/index.d.ts`,
        "// generated types\n",
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    if (request.program === "npm") {
      return { code: 0, stdout: `${NAPI_CLI_VERSION}\n`, stderr: "" };
    }
    throw new Error(`Unexpected command: ${request.program} ${joined}`);
  };
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(root)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      found.push(...await listFiles(`${root}/${entry.name}`, path));
    } else found.push(path);
  }
  return found.sort();
}

const VENDOR_CONFIG = "/fake-vendor/cargo-config.toml";
function fakeVendor() {
  return () =>
    Promise.resolve({
      directory: "/fake-vendor/tree",
      archiveSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      cargoConfig: VENDOR_CONFIG,
    });
}

async function installedName(
  crateDir: string,
  mode: "source" | "precompiled" = "source",
): Promise<string> {
  const fingerprint = await addonSourceFingerprint(crateDir);
  return `${TOOLKIT_DIRECTORY}-${PLATFORM}-${fingerprint.slice(0, 16)}${
    mode === "source" ? "-source" : ""
  }`;
}

async function copyDir(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    const path = entry.name;
    if (entry.isDirectory) await copyDir(`${from}/${path}`, `${to}/${path}`);
    else await Deno.copyFile(`${from}/${path}`, `${to}/${path}`);
  }
}

async function fakeCrate(crateDir: string): Promise<void> {
  await Deno.mkdir(`${crateDir}/src`, { recursive: true });
  for (
    const [name, text] of Object.entries({
      "Cargo.toml": "[package]\nname='x'\n",
      "Cargo.lock": "version = 4\n",
      "build.rs": "fn main() {}\n",
      "package.json": '{"devDependencies":{"@napi-rs/cli":"3.10.9"}}\n',
      "src/lib.rs": "pub fn bridge() {}\n",
    })
  ) await Deno.writeTextFile(`${crateDir}/${name}`, text);
}

Deno.test("native toolkit installs offline with a fake build, verifies reuse and preserves other installations", async () => {
  const app = await Deno.makeTempDir({ prefix: "ase-native-install-" });
  try {
    const toolchains = `${app}/.data/toolchains`;
    const crateDir = `${app}/native/toolkit`;
    await fakeCrate(crateDir);
    const official = `${toolchains}/sysml-toolkit-v0.10.10/package`;
    await Deno.mkdir(official, { recursive: true });
    await Deno.writeTextFile(`${official}/untouched`, "official installation");
    assert.notEqual(TOOLKIT_DIRECTORY, "sysml-toolkit-v0.10.10");

    const calls: CommandRequest[] = [];
    const options = {
      toolchainsDirectory: toolchains,
      addonCrateDir: crateDir,
      platform: PLATFORM,
      runner: fakeRunner(calls),
      env: () => undefined,
      mode: "source" as const,
      prepareVendor: fakeVendor(),
    };
    const name = await installedName(crateDir);
    const installed = await installToolkit(options);
    assert.equal(installed, `${toolchains}/${name}/package`);
    const pointer = JSON.parse(
      await Deno.readTextFile(`${toolchains}/sysml-toolkit-active.json`),
    );
    assert.deepEqual(pointer, {
      schema: 1,
      runtime: "toolkit",
      platform: PLATFORM,
      directory: name,
    });

    const files = await listFiles(installed);
    assert.ok(files.includes(`native/${ADDON_FILE}`));
    assert.ok(files.includes("stdlib/sysml-library.prepared.gz"));
    assert.ok(files.includes("LICENSE"));
    assert.equal(files.some((file) => file.endsWith(".wasm")), false);
    assert.equal(files.some((file) => file.includes("sysmlv2")), false);
    assert.equal(files.includes("index.js"), false);

    const build = JSON.parse(
      await Deno.readTextFile(`${installed}/buildinfo.json`),
    );
    assert.equal(build.addonSha256, await sha256(FAKE_ADDON));
    assert.equal(
      build.bridgeSourceSha256,
      await addonSourceFingerprint(crateDir),
    );
    assert.equal(JSON.stringify(build).includes(app), false);
    assert.equal(build.target, "aarch64-apple-darwin");
    assert.equal(build.rustVendorSha256, "a".repeat(64));
    assert.equal(build.rustVendorManifestSha256, "b".repeat(64));
    assert.equal(build.sourceArchiveSha256, TOOLKIT_SOURCE_ARCHIVE_SHA256);
    assert.equal(build.stdlibArchiveSha256, TOOLKIT_STDLIB_ARCHIVE_SHA256);
    const manifest = JSON.parse(
      await Deno.readTextFile(`${installed}/package.json`),
    );
    assert.equal(manifest.name, "ase-sysml-toolkit-native");
    assert.equal(manifest.version, TOOLKIT_RELEASE);
    assert.equal(manifest.toolkitCommit, TOOLKIT_COMMIT);

    const receipt = JSON.parse(
      await Deno.readTextFile(`${toolchains}/${name}/release.json`),
    );
    assert.deepEqual(receipt.rustVendor, {
      archiveSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
    });
    assert.equal(receipt.release, TOOLKIT_RELEASE);
    assert.equal(receipt.commit, TOOLKIT_COMMIT);
    assert.equal(receipt.platform, PLATFORM);
    assert.equal(receipt.bridgeSourceSha256, build.bridgeSourceSha256);
    assert.equal(
      receipt.files[`native/${ADDON_FILE}`],
      await sha256(FAKE_ADDON),
    );

    const sourceRoot = `${toolchains}/${TOOLKIT_SOURCE_DIRECTORY}`;
    for (const [path, expected] of Object.entries(TOOLKIT_SOURCE_SPOT_FILES)) {
      assert.equal(
        await sha256(await Deno.readFile(`${sourceRoot}/${path}`)),
        expected,
      );
    }

    const buildCalls = calls.filter((call) => call.args.includes("build"));
    assert.equal(buildCalls.length, 1);
    assert.ok(buildCalls[0].args.includes("aarch64-apple-darwin"));
    // Aucun fetch registre : build figé, hors réseau, vendor via --config.
    assert.equal(calls.some((call) => call.args.includes("fetch")), false);
    assert.deepEqual(
      buildCalls[0].args.slice(buildCalls[0].args.lastIndexOf("--") + 1),
      ["--frozen", "--config", VENDOR_CONFIG],
    );
    assert.equal(buildCalls[0].env?.CARGO_NET_OFFLINE, "true");
    assert.ok(buildCalls[0].env?.CARGO_HOME?.startsWith(toolchains));
    assert.ok(buildCalls[0].env?.CARGO_TARGET_DIR?.startsWith(toolchains));
    assert.equal(
      calls.some((call) => JSON.stringify(call).includes("Scratch")),
      false,
    );

    // Verified reuse: no further build commands at all.
    const before = calls.length;
    assert.equal(await installToolkit(options), installed);
    assert.equal(calls.length, before);
    assert.equal(
      await Deno.readTextFile(`${official}/untouched`),
      "official installation",
    );

    // Generated outputs are excluded from the fingerprint.
    await Deno.writeTextFile(
      `${crateDir}/index.js`,
      "changed generated loader",
    );
    assert.equal(await installToolkit(options), installed);
    assert.equal(calls.length, before);
    // Changed bridge sources install a distinct target; the old one is kept.
    const bridge = await Deno.readTextFile(`${crateDir}/src/lib.rs`);
    await Deno.writeTextFile(
      `${crateDir}/src/lib.rs`,
      `${bridge}// edited bridge\n`,
    );
    const second = await installToolkit(options);
    assert.notEqual(second, installed);
    // L'ancienne cible conserve sa propre empreinte, intacte.
    assert.notEqual(
      JSON.parse(await Deno.readTextFile(`${installed}/buildinfo.json`))
        .bridgeSourceSha256,
      await addonSourceFingerprint(crateDir),
    );
    await Deno.writeTextFile(`${crateDir}/src/lib.rs`, bridge);
    assert.equal(await installToolkit(options), installed);

    // Le réemploi vérifié n'extrait ni ne relit les sources du toolkit :
    // leur altération locale ne bloque pas un package déjà vérifié.
    const rustSource = (await listFiles(sourceRoot)).find((file) =>
      file.endsWith(".rs")
    )!;
    const original = await Deno.readFile(`${sourceRoot}/${rustSource}`);
    await Deno.writeTextFile(
      `${sourceRoot}/${rustSource}`,
      "// tampered crate source",
    );
    assert.equal(await installToolkit(options), installed);
    await Deno.writeFile(`${sourceRoot}/${rustSource}`, original);
    await Deno.writeTextFile(`${sourceRoot}/injected.rs`, "fn injected() {}");
    assert.equal(await installToolkit(options), installed);
    await Deno.remove(`${sourceRoot}/injected.rs`);

    // Tampered addon bytes are a closed refusal on reuse.
    await Deno.writeTextFile(`${installed}/native/${ADDON_FILE}`, "changed");
    await assert.rejects(
      () => installToolkit(options),
      /build identity|checksum/,
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("native toolkit setup refuses wrong toolchains and corrupt archives explicitly", async () => {
  const app = await Deno.makeTempDir({ prefix: "ase-native-refusals-" });
  try {
    const crateDir = `${app}/native/toolkit`;
    await fakeCrate(crateDir);
    const base = {
      addonCrateDir: crateDir,
      platform: PLATFORM,
      env: () => undefined,
      mode: "source" as const,
      prepareVendor: fakeVendor(),
    };
    const name = await installedName(crateDir);
    await assert.rejects(
      () =>
        installToolkit({
          ...base,
          toolchainsDirectory: `${app}/wrong-rust`,
          runner: fakeRunner([], "1.96.1"),
        }),
      new RegExp(
        `Pinned Rust ${RUST_TOOLCHAIN_VERSION} is required; found 1\\.96\\.1`,
      ),
    );
    await assert.rejects(
      () => Deno.stat(`${app}/wrong-rust/${name}`),
      Deno.errors.NotFound,
    );

    for (const suffix of ["nightly", "dev"]) {
      const calls: CommandRequest[] = [];
      await assert.rejects(() =>
        installToolkit({
          ...base,
          toolchainsDirectory: `${app}/rust-${suffix}`,
          runner: fakeRunner(calls, `${RUST_TOOLCHAIN_VERSION}-${suffix}`),
        }), /Pinned Rust .* is required/);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, ["--version"]);
    }

    for (const kind of ["cargo", "napi"] as const) {
      const calls: CommandRequest[] = [];
      const validRunner = fakeRunner(calls);
      await assert.rejects(
        () =>
          installToolkit({
            ...base,
            toolchainsDirectory: `${app}/wrong-${kind}`,
            runner: async (request) => {
              if (
                kind === "cargo" && request.program.endsWith("cargo") &&
                request.args[0] === "--version"
              ) {
                calls.push(request);
                return {
                  code: 0,
                  stdout: "cargo 1.98.10 (fake)\n",
                  stderr: "",
                };
              }
              if (
                kind === "napi" && request.program === "npm" &&
                request.args.at(-1) === "--version"
              ) {
                calls.push(request);
                return { code: 0, stdout: "3.10.90\n", stderr: "" };
              }
              return await validRunner(request);
            },
          }),
        kind === "cargo"
          ? /Pinned cargo .* is required/
          : /Pinned @napi-rs\/cli .* is required/,
      );
      assert.equal(
        calls.some((request) => request.args.includes("build")),
        false,
      );
      await assert.rejects(
        Deno.lstat(`${app}/wrong-${kind}/${name}`),
        Deno.errors.NotFound,
      );
    }

    const invalidArchive = `${app}/invalid.tgz`;
    await Deno.writeTextFile(invalidArchive, "invalid");
    await assert.rejects(
      () =>
        installToolkit({
          ...base,
          toolchainsDirectory: `${app}/bad-archive`,
          stdlibArchive: invalidArchive,
          runner: fakeRunner([]),
        }),
      /archive checksum or size mismatch/,
    );
    await assert.rejects(
      () => Deno.stat(`${app}/bad-archive/${name}`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("native toolkit refuses missing lockfile and build-time source mutation before installation", async () => {
  const app = await Deno.makeTempDir({ prefix: "ase-native-inputs-" });
  try {
    const crateDir = `${app}/native/toolkit`;
    await fakeCrate(crateDir);
    const calls: CommandRequest[] = [];
    const options = {
      toolchainsDirectory: `${app}/.data/toolchains`,
      addonCrateDir: crateDir,
      platform: PLATFORM,
      env: () => undefined,
      mode: "source" as const,
      prepareVendor: fakeVendor(),
    };
    await Deno.remove(`${crateDir}/Cargo.lock`);
    await assert.rejects(
      () => installToolkit({ ...options, runner: fakeRunner(calls) }),
      Deno.errors.NotFound,
    );
    assert.equal(calls.length, 0);
    await Deno.writeTextFile(`${crateDir}/Cargo.lock`, "version = 4\n");
    const runner = fakeRunner(calls);
    await assert.rejects(
      () =>
        installToolkit({
          ...options,
          runner: async (request: CommandRequest) => {
            const result = await runner(request);
            if (request.args.includes("build")) {
              await Deno.writeTextFile(
                `${crateDir}/src/lib.rs`,
                "// concurrent edit\n",
              );
            }
            return result;
          },
        }),
      /build inputs changed during the build/,
    );
    const nameAfterBuild = await installedName(crateDir);
    await assert.rejects(
      () => Deno.stat(`${options.toolchainsDirectory}/${nameAfterBuild}`),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("precompiled default delegates to the distribution installer without Rust, npm or vendor", async () => {
  const app = await Deno.makeTempDir({ prefix: "ase-native-precompiled-" });
  try {
    const toolchains = `${app}/.data/toolchains`;
    const crateDir = `${app}/native/toolkit`;
    await fakeCrate(crateDir);
    const seen: unknown[] = [];
    const installed = await installToolkit({
      toolchainsDirectory: toolchains,
      addonCrateDir: crateDir,
      platform: PLATFORM,
      env: () => undefined,
      runner: () =>
        Promise.reject(new Error("no command may run in precompiled mode")),
      prepareVendor: () =>
        Promise.reject(new Error("no vendor in precompiled mode")),
      distributionRunner: async (request) => {
        seen.push(request);
        const packageDir = `${request.targetDirectory}/package`;
        await Deno.mkdir(packageDir, { recursive: true });
        return packageDir;
      },
    });
    const name = await installedName(crateDir, "precompiled");
    assert.equal(installed, `${toolchains}/${name}/package`);
    assert.equal(seen.length, 1);
    const request = seen[0] as {
      runtime: string;
      sourceSha256: string;
      targetDirectory: string;
    };
    assert.equal(request.runtime, "toolkit");
    assert.equal(request.sourceSha256, await addonSourceFingerprint(crateDir));
    assert.equal(request.targetDirectory, `${toolchains}/${name}`);
    const pointer = JSON.parse(
      await Deno.readTextFile(`${toolchains}/sysml-toolkit-active.json`),
    );
    assert.equal(pointer.directory, name);
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("verified legacy toolkit is reused by default without extracting sources", async () => {
  const app = await Deno.makeTempDir({ prefix: "ase-native-legacy-" });
  try {
    const toolchains = `${app}/.data/toolchains`;
    const crateDir = `${app}/native/toolkit`;
    await fakeCrate(crateDir);
    const calls: CommandRequest[] = [];
    const options = {
      toolchainsDirectory: toolchains,
      addonCrateDir: crateDir,
      platform: PLATFORM,
      runner: fakeRunner(calls),
      env: () => undefined,
      mode: "source" as const,
      prepareVendor: fakeVendor(),
    };
    const installed = await installToolkit(options);
    const name = await installedName(crateDir);
    const legacy = `${toolchains}/${TOOLKIT_DIRECTORY}`;
    await copyDir(`${toolchains}/${name}`, legacy);
    await Deno.remove(`${toolchains}/${name}`, { recursive: true });
    const pointerPath = `${toolchains}/sysml-toolkit-active.json`;
    await Deno.remove(pointerPath);
    const before = calls.length;
    const reused = await installToolkit({
      ...options,
      mode: "precompiled",
      distributionRunner: () =>
        Promise.reject(
          new Error("legacy reuse must not consult the distribution"),
        ),
    });
    assert.equal(reused, `${legacy}/package`);
    assert.equal(calls.length, before);
    const pointerBytes = await Deno.readFile(pointerPath);
    assert.equal(
      JSON.parse(new TextDecoder().decode(pointerBytes)).directory,
      TOOLKIT_DIRECTORY,
    );
    const mtime = (await Deno.stat(pointerPath)).mtime;
    await installToolkit({
      ...options,
      mode: "precompiled",
      distributionRunner: () =>
        Promise.reject(
          new Error("legacy reuse must not consult the distribution"),
        ),
    });
    assert.deepEqual(await Deno.readFile(pointerPath), pointerBytes);
    assert.deepEqual((await Deno.stat(pointerPath)).mtime, mtime);
    assert.equal(installed, `${toolchains}/${name}/package`);
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("source recovery survives a removed bundle entry and preserves the distributed package", async () => {
  const app = await Deno.makeTempDir({
    prefix: "ase-toolkit-source-recovery-",
  });
  try {
    const crateDir = `${app}/native/toolkit`;
    await fakeCrate(crateDir);
    const calls: CommandRequest[] = [];
    const shared = {
      addonCrateDir: crateDir,
      platform: PLATFORM,
      env: () => undefined,
    };
    const prepared = await installToolkit({
      ...shared,
      mode: "source",
      toolchainsDirectory: `${app}/prepared`,
      runner: fakeRunner(calls),
      prepareVendor: fakeVendor(),
    });
    const files: Record<string, string> = {};
    const entries: { path: string; bytes: Uint8Array }[] = [];
    for (const file of await listFiles(prepared)) {
      const bytes = await Deno.readFile(`${prepared}/${file}`);
      files[file] = await sha256(bytes);
      entries.push({ path: `package/${file}`, bytes });
    }
    const archive = await gzipDeterministic(createUstarArchive(entries));
    const catalogPath = `${app}/catalog.json`;
    const bundlePath = `${app}/toolkit.tar.gz`;
    await Deno.writeFile(bundlePath, archive);
    await Deno.writeTextFile(
      catalogPath,
      JSON.stringify({
        schema: 1,
        bundles: [{
          runtime: "toolkit",
          platform: PLATFORM,
          sourceSha256: await addonSourceFingerprint(crateDir),
          archive: {
            file: "toolkit.tar.gz",
            bytes: archive.length,
            sha256: await sha256(archive),
          },
          files,
          release: {
            repository: "acme/assembly",
            tag: "native-v1",
            asset: "toolkit.tar.gz",
          },
        }],
      }),
    );
    const forbidden = () =>
      Promise.reject(
        new Error("distribution, network and compiler are forbidden"),
      );
    const toolchains = `${app}/.data/toolchains`;
    const local = {
      ...shared,
      toolchainsDirectory: toolchains,
      catalogPath,
      bundlePath,
      runner: forbidden,
      prepareVendor: forbidden,
      fetcher: forbidden,
    };
    const distributed = await installToolkit(local);
    const distributedTarget = `${toolchains}/${await installedName(
      crateDir,
      "precompiled",
    )}`;
    const snapshot = async () =>
      await Promise.all(
        (await listFiles(distributedTarget)).map(async (
          file,
        ) => [
          file,
          await sha256(await Deno.readFile(`${distributedTarget}/${file}`)),
        ]),
      );
    const original = await snapshot();
    await Deno.writeTextFile(
      catalogPath,
      JSON.stringify({ schema: 1, bundles: [] }),
    );
    await Deno.remove(bundlePath);
    const beforeBuilds = calls.filter((request) =>
      request.args.includes("build")
    ).length;
    const recovered = await installToolkit({
      ...local,
      mode: "source",
      runner: fakeRunner(calls),
      prepareVendor: fakeVendor(),
      distributionRunner: forbidden,
    });
    assert.notEqual(recovered, distributed);
    assert.equal(
      recovered,
      `${toolchains}/${await installedName(crateDir)}/package`,
    );
    assert.equal(
      calls.filter((request) => request.args.includes("build")).length,
      beforeBuilds + 1,
    );
    const cacheOnly = { ...local, distributionRunner: forbidden };
    assert.equal(
      await installToolkit({ ...cacheOnly, mode: "source" }),
      recovered,
    );
    assert.equal(await installToolkit(cacheOnly), recovered);
    assert.deepEqual(await snapshot(), original);
    assert.equal(
      JSON.parse(
        await Deno.readTextFile(`${toolchains}/sysml-toolkit-active.json`),
      ).directory,
      await installedName(crateDir),
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("source build refuses a stale crate addon when NAPI succeeds without fresh output", async () => {
  const app = await Deno.makeTempDir({ prefix: "ase-native-stale-output-" });
  try {
    const toolchains = `${app}/.data/toolchains`;
    const crateDir = `${app}/native/toolkit`;
    await fakeCrate(crateDir);
    const calls: CommandRequest[] = [];
    const options = {
      mode: "source" as const,
      toolchainsDirectory: toolchains,
      addonCrateDir: crateDir,
      platform: PLATFORM,
      prepareVendor: fakeVendor(),
      env: () => undefined,
    };
    const installed = await installToolkit({
      ...options,
      runner: fakeRunner(calls),
    });
    const pointerPath = `${toolchains}/sysml-toolkit-active.json`;
    const pointerBefore = await Deno.readFile(pointerPath);
    await Deno.writeTextFile(
      `${crateDir}/src/lib.rs`,
      "// next bridge version\n",
    );
    const nextName = await installedName(crateDir);
    const stale = new TextEncoder().encode("stale addon for an earlier source");
    await Deno.writeFile(`${crateDir}/${ADDON_FILE}`, stale);
    const probes = fakeRunner(calls);
    let attemptedBuild = false;
    await assert.rejects(
      () =>
        installToolkit({
          ...options,
          runner: async (request) => {
            if (request.args.includes("build")) {
              calls.push(request);
              attemptedBuild = true;
              return { code: 0, stdout: "", stderr: "" };
            }
            return await probes(request);
          },
        }),
      /exactly one fresh \.node addon|fresh native addon/,
    );
    assert.equal(attemptedBuild, true);
    await assert.rejects(
      Deno.lstat(`${toolchains}/${nextName}`),
      Deno.errors.NotFound,
    );
    assert.deepEqual(await Deno.readFile(pointerPath), pointerBefore);
    assert.deepEqual(
      await Deno.readFile(`${installed}/native/${ADDON_FILE}`),
      FAKE_ADDON,
    );
    assert.deepEqual(await Deno.readFile(`${crateDir}/${ADDON_FILE}`), stale);
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});

Deno.test("precompiled source drift refuses activation and preserves the previous pointer", async () => {
  const app = await Deno.makeTempDir({
    prefix: "ase-native-precompiled-drift-",
  });
  try {
    const toolchains = `${app}/.data/toolchains`;
    const crateDir = `${app}/native/toolkit`;
    await fakeCrate(crateDir);
    const installed = await installToolkit({
      mode: "source",
      toolchainsDirectory: toolchains,
      addonCrateDir: crateDir,
      platform: PLATFORM,
      prepareVendor: fakeVendor(),
      env: () => undefined,
      runner: fakeRunner([]),
    });
    const pointerPath = `${toolchains}/sysml-toolkit-active.json`;
    const pointerBefore = await Deno.readFile(pointerPath);
    await Deno.writeTextFile(
      `${crateDir}/src/lib.rs`,
      "// candidate bridge version\n",
    );
    const candidateSource = await addonSourceFingerprint(crateDir);
    let verifiedBundle = false;
    await assert.rejects(
      () =>
        installToolkit({
          toolchainsDirectory: toolchains,
          addonCrateDir: crateDir,
          platform: PLATFORM,
          env: () => undefined,
          runner: () =>
            Promise.reject(
              new Error("precompiled mode must not invoke build commands"),
            ),
          distributionRunner: async (request) => {
            assert.equal(request.sourceSha256, candidateSource);
            const packageDir = `${request.targetDirectory}/package`;
            await copyDir(installed, packageDir);
            const build = JSON.parse(
              await Deno.readTextFile(`${packageDir}/buildinfo.json`),
            );
            build.bridgeSourceSha256 = candidateSource;
            await Deno.writeTextFile(
              `${packageDir}/buildinfo.json`,
              JSON.stringify(build),
            );
            await Deno.writeTextFile(
              `${crateDir}/src/lib.rs`,
              "// source changed during bundle transport\n",
            );
            await request.verifyPackage(packageDir);
            verifiedBundle = true;
            return packageDir;
          },
        }),
      /build inputs changed|sources?.*changed|source.*modifi/i,
    );
    assert.equal(verifiedBundle, true);
    assert.notEqual(await addonSourceFingerprint(crateDir), candidateSource);
    assert.deepEqual(await Deno.readFile(pointerPath), pointerBefore);
    assert.deepEqual(
      await Deno.readFile(`${installed}/native/${ADDON_FILE}`),
      FAKE_ADDON,
    );
  } finally {
    await Deno.remove(app, { recursive: true });
  }
});
