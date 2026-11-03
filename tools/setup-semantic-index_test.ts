import assert from "node:assert/strict";
import {
  installSemanticIndex,
  SEMANTIC_INDEX_ADDON_FILE,
  semanticIndexSourceFingerprint,
  verifySemanticIndexPackage,
} from "./setup-semantic-index.ts";
import {
  type CommandRequest,
  type CommandRunner,
  sha256,
} from "./setup-sysml-toolkit.ts";
import {
  createUstarArchive,
  gzipDeterministic,
} from "./package-native-runtimes.ts";

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: "ase-semantic-setup-test-" });
  const crateDir = `${root}/crate`;
  await Deno.mkdir(`${crateDir}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${crateDir}/Cargo.toml`,
    'oxigraph = { version = "=0.4.11", default-features = false }\nspargebra = { version = "=0.3.5" }\n',
  );
  await Deno.writeTextFile(`${crateDir}/Cargo.lock`, "version = 4\n");
  await Deno.writeTextFile(`${crateDir}/build.rs`, "fn main() {}\n");
  await Deno.writeTextFile(
    `${crateDir}/src/lib.rs`,
    "// fake source, never compiled\n",
  );
  await Deno.writeTextFile(
    `${crateDir}/package.json`,
    JSON.stringify({
      name: "ase-semantic-index-napi",
      version: "0.1.0",
      devDependencies: { "@napi-rs/cli": "3.10.9" },
    }),
  );
  const calls: CommandRequest[] = [];
  const runner: CommandRunner = async (request) => {
    calls.push(request);
    let stdout = "";
    if (request.program.endsWith("rustc")) stdout = "rustc 1.98.1 (fixture)\n";
    else if (
      request.program.endsWith("cargo") && request.args[0] === "--version"
    ) stdout = "cargo 1.98.1 (fixture)\n";
    else if (request.program === "node") stdout = "v24.0.0\n";
    else if (request.program === "npm" && request.args.at(-1) === "--version") {
      stdout = "3.10.9\n";
    } else if (request.program === "npm" && request.args.includes("build")) {
      const out = request.args[request.args.indexOf("--output-dir") + 1]!;
      await Deno.writeFile(
        `${out}/ase-semantic-index-napi.darwin-arm64.node`,
        new Uint8Array([1, 2, 3]),
      );
      await Deno.writeTextFile(
        `${out}/index.js`,
        "// generated WASI fallback MUST NOT be installed",
      );
    }
    return { code: 0, stdout, stderr: "" };
  };
  const options = {
    toolchainsDirectory: `${root}/toolchains`,
    addonCrateDir: crateDir,
    rustBinDir: "/pinned/bin",
    platform: "darwin-arm64" as const,
    env: () => "/usr/bin",
    runner,
    mode: "source" as const,
    prepareVendor: () =>
      Promise.resolve({
        directory: `${root}/rust-vendor`,
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        cargoConfig: `${root}/cargo-config.toml`,
      }),
  };
  return { root, crateDir, calls, runner, options };
}

async function targetName(
  crateDir: string,
  mode: "source" | "precompiled" = "source",
): Promise<string> {
  const fingerprint = await semanticIndexSourceFingerprint(crateDir);
  return `semantic-index-native-v0.1.0-darwin-arm64-${
    fingerprint.slice(0, 16)
  }${mode === "source" ? "-source" : ""}`;
}

Deno.test("semantic setup accepts canonical and legacy Rust environment with defined-value precedence", async () => {
  for (
    const [canonical, legacy, expected] of [
      ["/assembly/bin", "/legacy/bin", "/assembly/bin/rustc"],
      [undefined, "/legacy/bin", "/legacy/bin/rustc"],
      ["", "/legacy/bin", "rustc"],
    ] as const
  ) {
    const { root, calls, options } = await fixture();
    try {
      await installSemanticIndex({
        ...options,
        rustBinDir: undefined,
        env: (key) =>
          key === "ASSEMBLY_RUST_BIN_DIR"
            ? canonical
            : key === "ASE_RUST_BIN_DIR"
            ? legacy
            : undefined,
      });
      assert.equal(calls[0].program, expected);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

async function copyDir(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (entry.isDirectory) {
      await copyDir(`${from}/${entry.name}`, `${to}/${entry.name}`);
    } else await Deno.copyFile(`${from}/${entry.name}`, `${to}/${entry.name}`);
  }
}

Deno.test("semantic installer uses exact pins, fresh output and binary-only distribution", async () => {
  const f = await fixture();
  try {
    const installed = await installSemanticIndex(f.options);
    const name = await targetName(f.crateDir);
    assert.equal(installed, `${f.root}/toolchains/${name}/package`);
    const pointer = JSON.parse(
      await Deno.readTextFile(
        `${f.root}/toolchains/semantic-index-active.json`,
      ),
    );
    assert.deepEqual(pointer, {
      schema: 1,
      runtime: "semantic-index",
      platform: "darwin-arm64",
      directory: name,
    });
    const info = await verifySemanticIndexPackage(
      installed,
      "darwin-arm64",
      await semanticIndexSourceFingerprint(f.crateDir),
    );
    assert.equal(info.addonBytes, 3);
    assert.equal(info.addonFile, SEMANTIC_INDEX_ADDON_FILE);
    assert.deepEqual(
      [...await Deno.readFile(`${installed}/${info.addonFile}`)],
      [1, 2, 3],
    );
    await assert.rejects(
      Deno.stat(`${installed}/index.js`),
      Deno.errors.NotFound,
    );
    const build = f.calls.find((request) => request.args.includes("build"))!;
    assert.equal(build.program, "npm");
    assert.ok(build.args.includes("--package=@napi-rs/cli@3.10.9"));
    assert.ok(build.args.includes("aarch64-apple-darwin"));
    // Le build Cargo est figé, hors réseau, et lit le vendor via --config.
    assert.deepEqual(build.args.slice(build.args.lastIndexOf("--") + 1), [
      "--frozen",
      "--config",
      `${f.root}/cargo-config.toml`,
    ]);
    assert.equal(build.env?.CARGO_NET_OFFLINE, "true");
    assert.equal(
      f.calls.some((request) => request.args.includes("fetch")),
      false,
    );
    assert.equal(info.rustVendorSha256, "a".repeat(64));
    assert.equal(info.rustVendorManifestSha256, "b".repeat(64));
    assert.equal(build.env?.RUSTC, "/pinned/bin/rustc");
    assert.equal(build.env?.CARGO, "/pinned/bin/cargo");
    assert.ok(
      build.env?.CARGO_TARGET_DIR.endsWith(
        "/.semantic-index-native-cache/target",
      ),
    );
    const count = f.calls.length;
    assert.equal(await installSemanticIndex(f.options), installed);
    assert.equal(f.calls.length, count); // verified cache, no tools or build
    await Deno.writeFile(`${installed}/${info.addonFile}`, new Uint8Array([9]));
    await assert.rejects(installSemanticIndex(f.options), /integrity mismatch/);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("changed sources install a distinct target and preserve the previous one", async () => {
  const f = await fixture();
  try {
    const first = await installSemanticIndex(f.options);
    const firstFingerprint = await semanticIndexSourceFingerprint(f.crateDir);
    await Deno.writeTextFile(`${f.crateDir}/src/lib.rs`, "// changed\n");
    const second = await installSemanticIndex(f.options);
    assert.notEqual(second, first);
    assert.equal(
      second,
      `${f.root}/toolchains/${await targetName(f.crateDir)}/package`,
    );
    // L'ancienne installation reste vérifiable avec sa propre provenance.
    const info = await verifySemanticIndexPackage(
      first,
      "darwin-arm64",
      firstFingerprint,
    );
    assert.equal(info.sourceSha256, firstFingerprint);
    const pointer = JSON.parse(
      await Deno.readTextFile(
        `${f.root}/toolchains/semantic-index-active.json`,
      ),
    );
    assert.equal(pointer.directory, await targetName(f.crateDir));
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("precompiled default delegates to the distribution installer without any build", async () => {
  const f = await fixture();
  try {
    const seen: unknown[] = [];
    const installed = await installSemanticIndex({
      toolchainsDirectory: f.options.toolchainsDirectory,
      addonCrateDir: f.crateDir,
      platform: "darwin-arm64",
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
    const name = await targetName(f.crateDir, "precompiled");
    assert.equal(installed, `${f.root}/toolchains/${name}/package`);
    assert.equal(seen.length, 1);
    const request = seen[0] as { runtime: string; sourceSha256: string };
    assert.equal(request.runtime, "semantic-index");
    assert.equal(
      request.sourceSha256,
      await semanticIndexSourceFingerprint(f.crateDir),
    );
    const pointer = JSON.parse(
      await Deno.readTextFile(
        `${f.root}/toolchains/semantic-index-active.json`,
      ),
    );
    assert.equal(pointer.directory, name);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("verified legacy installation is reused by default and pointed at, never replaced", async () => {
  const f = await fixture();
  try {
    const installed = await installSemanticIndex(f.options);
    const name = await targetName(f.crateDir);
    const legacy =
      `${f.root}/toolchains/semantic-index-native-v0.1.0-darwin-arm64`;
    await copyDir(`${f.root}/toolchains/${name}`, legacy);
    await Deno.remove(`${f.root}/toolchains/${name}`, { recursive: true });
    const pointerPath = `${f.root}/toolchains/semantic-index-active.json`;
    await Deno.remove(pointerPath);
    const callsBefore = f.calls.length;
    const reused = await installSemanticIndex({
      ...f.options,
      mode: "precompiled",
      distributionRunner: () =>
        Promise.reject(
          new Error("legacy reuse must not consult the distribution"),
        ),
    });
    assert.equal(reused, `${legacy}/package`);
    assert.equal(f.calls.length, callsBefore);
    const pointerBytes = await Deno.readFile(pointerPath);
    const pointer = JSON.parse(new TextDecoder().decode(pointerBytes));
    assert.equal(
      pointer.directory,
      "semantic-index-native-v0.1.0-darwin-arm64",
    );
    // Réexécution : le pointeur identique n'est pas réécrit.
    const mtime = (await Deno.stat(pointerPath)).mtime;
    await installSemanticIndex({
      ...f.options,
      mode: "precompiled",
      distributionRunner: () =>
        Promise.reject(
          new Error("legacy reuse must not consult the distribution"),
        ),
    });
    assert.deepEqual(await Deno.readFile(pointerPath), pointerBytes);
    assert.deepEqual((await Deno.stat(pointerPath)).mtime, mtime);
    assert.equal(installed.endsWith("/package"), true);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("new targets require a non-null receipt while legacy without receipt remains reusable", async () => {
  const f = await fixture();
  try {
    const installed = await installSemanticIndex(f.options);
    const target = `${f.root}/toolchains/${await targetName(f.crateDir)}`;
    const receiptPath = `${target}/release.json`;
    const addonPath = `${installed}/${SEMANTIC_INDEX_ADDON_FILE}`;
    const buildPath = `${installed}/buildinfo.json`;
    const originalAddon = await Deno.readFile(addonPath);
    const originalBuild = await Deno.readTextFile(buildPath);
    const pointerPath = `${f.root}/toolchains/semantic-index-active.json`;
    const originalPointer = await Deno.readFile(pointerPath);
    const callCount = f.calls.length;
    let distributions = 0;
    const reuseOptions = {
      ...f.options,
      mode: "precompiled" as const,
      distributionRunner: () => {
        distributions++;
        return Promise.reject(new Error("unexpected distribution fallback"));
      },
    };
    // Cohérentes entre elles, ces modifications ne doivent pas remplacer le reçu.
    const changed = new Uint8Array([9, 8, 7]);
    await Deno.writeFile(addonPath, changed);
    const build = JSON.parse(originalBuild);
    build.addonSha256 = await sha256(changed);
    build.addonBytes = changed.length;
    await Deno.writeTextFile(buildPath, JSON.stringify(build));
    await Deno.remove(receiptPath);
    for (const receipt of [undefined, "null", "{}", "[]", '{"bundle":{}}']) {
      if (receipt !== undefined) await Deno.writeTextFile(receiptPath, receipt);
      for (const mode of ["source", "precompiled"] as const) {
        await assert.rejects(
          installSemanticIndex({ ...reuseOptions, mode }),
          /receipt|provenance or binary integrity mismatch/,
        );
      }
      assert.deepEqual(await Deno.readFile(pointerPath), originalPointer);
      assert.deepEqual(await Deno.readFile(addonPath), changed);
      assert.equal(f.calls.length, callCount);
      assert.equal(distributions, 0);
    }
    await Deno.writeFile(addonPath, originalAddon);
    await Deno.writeTextFile(buildPath, originalBuild);
    await Deno.remove(receiptPath);
    const legacy =
      `${f.root}/toolchains/semantic-index-native-v0.1.0-darwin-arm64`;
    await Deno.rename(target, legacy);
    assert.equal(await installSemanticIndex(reuseOptions), `${legacy}/package`);
    assert.equal(f.calls.length, callCount);
    assert.equal(distributions, 0);
    // Un reçu legacy null ne peut pas bénéficier de l'exception « sans reçu ».
    await Deno.writeTextFile(`${legacy}/release.json`, "null");
    assert.equal(
      await installSemanticIndex({ ...reuseOptions, mode: "source" }),
      `${target}/package`,
    );
    assert.equal(await Deno.readTextFile(`${legacy}/release.json`), "null");
    assert.deepEqual(
      await Deno.readFile(`${legacy}/package/${SEMANTIC_INDEX_ADDON_FILE}`),
      originalAddon,
    );
    assert.equal(distributions, 0);
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("older fingerprinted source installations remain reusable in both modes", async () => {
  const f = await fixture();
  try {
    const installed = await installSemanticIndex(f.options);
    const sourceTarget = `${f.options.toolchainsDirectory}/${await targetName(
      f.crateDir,
    )}`;
    const olderName = await targetName(f.crateDir, "precompiled");
    const olderTarget = `${f.options.toolchainsDirectory}/${olderName}`;
    await Deno.rename(sourceTarget, olderTarget);
    const callCount = f.calls.length;
    for (const mode of ["source", "precompiled"] as const) {
      assert.equal(
        await installSemanticIndex({
          ...f.options,
          mode,
          distributionRunner: () =>
            Promise.reject(
              new Error("older source must not consult the distribution"),
            ),
        }),
        `${olderTarget}/package`,
      );
      assert.equal(f.calls.length, callCount);
    }
    assert.ok(installed.endsWith("-source/package"));
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("source recovery ignores installed bundles after catalog removal and preserves their bytes", async () => {
  for (const location of ["fingerprinted", "legacy"] as const) {
    const f = await fixture();
    try {
      const seed = await installSemanticIndex(f.options);
      const sourceName = await targetName(f.crateDir);
      const distributedName = await targetName(f.crateDir, "precompiled");
      const sourceSha256 = await semanticIndexSourceFingerprint(f.crateDir);
      const packageFiles = [
        "package.json",
        "buildinfo.json",
        SEMANTIC_INDEX_ADDON_FILE,
      ];
      const payloads = await Promise.all(packageFiles.map(async (path) => ({
        path: `package/${path}`,
        bytes: await Deno.readFile(`${seed}/${path}`),
      })));
      const compressed = await gzipDeterministic(createUstarArchive(payloads));
      const archiveFile = "semantic-test.tar.gz";
      const bundlePath = `${f.root}/${archiveFile}`;
      const catalogPath = `${f.root}/catalog.json`;
      const files: Record<string, string> = {};
      for (const payload of payloads) {
        files[payload.path.slice("package/".length)] = await sha256(
          payload.bytes,
        );
      }
      await Deno.writeFile(bundlePath, compressed);
      await Deno.writeTextFile(
        catalogPath,
        JSON.stringify({
          schema: 1,
          bundles: [{
            runtime: "semantic-index",
            platform: "darwin-arm64",
            sourceSha256,
            archive: {
              file: archiveFile,
              bytes: compressed.length,
              sha256: await sha256(compressed),
            },
            files,
            release: {
              repository: "acme/ase",
              tag: "native-test",
              asset: archiveFile,
            },
          }],
        }),
      );
      await Deno.remove(`${f.options.toolchainsDirectory}/${sourceName}`, {
        recursive: true,
      });
      await Deno.remove(
        `${f.options.toolchainsDirectory}/semantic-index-active.json`,
      );
      // Parcours réel d'installation du bundle autorisé, sans transport réseau.
      const distributedPackage = await installSemanticIndex({
        ...f.options,
        mode: "precompiled",
        catalogPath,
        bundlePath,
        runner: () =>
          Promise.reject(new Error("bundle install must not compile")),
        prepareVendor: () =>
          Promise.reject(new Error("bundle install must not prepare sources")),
      });
      assert.equal(
        distributedPackage,
        `${f.options.toolchainsDirectory}/${distributedName}/package`,
      );
      const distributedTarget =
        `${f.options.toolchainsDirectory}/${distributedName}`;
      const bundleTarget = location === "legacy"
        ? `${f.options.toolchainsDirectory}/semantic-index-native-v0.1.0-darwin-arm64`
        : distributedTarget;
      if (location === "legacy") {
        await Deno.rename(distributedTarget, bundleTarget);
      }
      const before: Record<string, Uint8Array> = {};
      for (
        const path of [
          "release.json",
          ...packageFiles.map((path) => `package/${path}`),
        ]
      ) {
        before[path] = await Deno.readFile(`${bundleTarget}/${path}`);
      }
      await Deno.remove(catalogPath);
      let distributions = 0;
      let networkCalls = 0;
      const recovery = {
        ...f.options,
        catalogPath,
        distributionRunner: () => {
          distributions++;
          return Promise.reject(
            new Error("source recovery must not consult distribution"),
          );
        },
        fetcher: (() => {
          networkCalls++;
          return Promise.reject(
            new Error("source recovery must not use network"),
          );
        }) as typeof fetch,
      };
      const buildsBefore = f.calls.filter((request) =>
        request.args.includes("build")
      ).length;
      const recovered = await installSemanticIndex(recovery);
      assert.equal(
        recovered,
        `${f.options.toolchainsDirectory}/${sourceName}/package`,
      );
      assert.equal(
        f.calls.filter((request) => request.args.includes("build")).length,
        buildsBefore + 1,
      );
      const callsAfterRecovery = f.calls.length;
      assert.equal(await installSemanticIndex(recovery), recovered);
      assert.equal(
        await installSemanticIndex({ ...recovery, mode: "precompiled" }),
        recovered,
      );
      assert.equal(f.calls.length, callsAfterRecovery);
      assert.equal(distributions, 0);
      assert.equal(networkCalls, 0);
      for (const [path, bytes] of Object.entries(before)) {
        assert.deepEqual(await Deno.readFile(`${bundleTarget}/${path}`), bytes);
      }
      assert.deepEqual(await Deno.readFile(bundlePath), compressed);
      const pointer = JSON.parse(
        await Deno.readTextFile(
          `${f.options.toolchainsDirectory}/semantic-index-active.json`,
        ),
      );
      assert.equal(pointer.directory, sourceName);
    } finally {
      await Deno.remove(f.root, { recursive: true });
    }
  }
});

Deno.test("source fingerprint requires lockfile and refuses symlink build inputs", async () => {
  const f = await fixture();
  try {
    await Deno.remove(`${f.crateDir}/Cargo.lock`);
    await assert.rejects(
      semanticIndexSourceFingerprint(f.crateDir),
      Deno.errors.NotFound,
    );
    await Deno.writeTextFile(`${f.crateDir}/Cargo.lock`, "version=4");
    await Deno.symlink("lib.rs", `${f.crateDir}/src/linked.rs`);
    await assert.rejects(
      semanticIndexSourceFingerprint(f.crateDir),
      /Symlink source refused/,
    );
  } finally {
    await Deno.remove(f.root, { recursive: true });
  }
});

Deno.test("installer refuses wrong Rust and CLI pins and leaves no installed target", async () => {
  for (const mode of ["rust", "cli", "empty"] as const) {
    const f = await fixture();
    try {
      const runner: CommandRunner = async (request) => {
        if (mode === "rust" && request.program.endsWith("rustc")) {
          return { code: 0, stdout: "rustc 1.97.0", stderr: "" };
        }
        if (
          mode === "cli" && request.program === "npm" &&
          request.args.at(-1) === "--version"
        ) return { code: 0, stdout: "3.10.90", stderr: "" };
        if (mode === "empty" && request.args.includes("build")) {
          return { code: 0, stdout: "", stderr: "" };
        }
        return await f.runner(request);
      };
      await assert.rejects(
        installSemanticIndex({ ...f.options, runner }),
        mode === "rust"
          ? /Pinned rustc/
          : mode === "cli"
          ? /Pinned napi CLI/
          : /exactly one fresh/,
      );
      const name = await targetName(f.crateDir);
      await assert.rejects(
        Deno.stat(`${f.options.toolchainsDirectory}/${name}`),
        Deno.errors.NotFound,
      );
      await assert.rejects(
        Deno.stat(`${f.options.toolchainsDirectory}/${name}.install.lock`),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(f.root, { recursive: true });
    }
  }
});
