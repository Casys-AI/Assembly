import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  installNativeDistribution,
  loadNativeCatalog,
  type NativeBundle,
  type NativeRuntime,
  parseNativeCatalog,
} from "./native-distribution.ts";
import { sha256 } from "./setup-sysml-toolkit.ts";
import { toolkitAddonPath } from "../src/adapters/sysml-toolkit-pin.ts";

const encoder = new TextEncoder();
const PLATFORM = "darwin-arm64" as const;
const SOURCE = "a".repeat(64);
const OTHER_SOURCE = "b".repeat(64);
const REPO = "acme/ase";

/** Construit une archive USTAR minimale, comme les fixtures du Toolkit. */
function tar(
  entries: Array<{ path: string; bytes?: Uint8Array; type?: string }>,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const body = entry.bytes ?? new Uint8Array();
    const field = (offset: number, value: string) =>
      header.set(encoder.encode(value), offset);
    field(0, entry.path);
    field(124, body.length.toString(8).padStart(11, "0") + "\0");
    header.fill(32, 148, 156);
    field(156, entry.type ?? "0");
    field(257, "ustar\0");
    field(
      148,
      header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0") +
        "\0 ",
    );
    chunks.push(header);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    chunks.push(padded);
  }
  chunks.push(new Uint8Array(1024));
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function payloads(runtime: NativeRuntime): Record<string, Uint8Array> {
  const addon = runtime === "toolkit"
    ? toolkitAddonPath(PLATFORM)
    : "native/ase-semantic-index-napi.node";
  return {
    "package.json": encoder.encode(JSON.stringify({ name: `fake-${runtime}` })),
    "buildinfo.json": encoder.encode(JSON.stringify({ runtime })),
    [addon]: encoder.encode(`addon-${runtime}`),
    "LICENSE": encoder.encode("Apache-2.0"),
  };
}

interface Fixture {
  bundle: NativeBundle;
  compressed: Uint8Array;
  files: Record<string, Uint8Array>;
}

async function fixture(
  runtime: NativeRuntime,
  mutate?: (
    payload: Record<string, Uint8Array>,
  ) => Array<{ path: string; bytes?: Uint8Array; type?: string }>,
  sourceSha256 = SOURCE,
): Promise<Fixture> {
  const files = payloads(runtime);
  const entries = mutate ? mutate(files) : [
    { path: "package/", type: "5" },
    { path: "package/native/", type: "5" },
    ...Object.entries(files).map(([path, bytes]) => ({
      path: `package/${path}`,
      bytes,
    })),
  ];
  const compressed = await gzip(tar(entries));
  const hashes: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(files)) {
    hashes[path] = await sha256(bytes);
  }
  const file = `${runtime}-${PLATFORM}.tar.gz`;
  return {
    files,
    compressed,
    bundle: {
      runtime,
      platform: PLATFORM,
      sourceSha256,
      archive: {
        file,
        bytes: compressed.length,
        sha256: await sha256(compressed),
      },
      files: hashes,
      release: { repository: REPO, tag: "native-v1", asset: file },
    },
  };
}

async function writeCatalog(
  directory: string,
  bundles: NativeBundle[],
): Promise<string> {
  const path = `${directory}/catalog.json`;
  await Deno.writeTextFile(path, JSON.stringify({ schema: 1, bundles }));
  return path;
}

async function tempRoot(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "ase-native-dist-" });
}

function verifyOk(calls: string[] = []): (dir: string) => Promise<void> {
  return async (dir: string) => {
    calls.push(dir);
    const manifest = JSON.parse(await Deno.readTextFile(`${dir}/package.json`));
    assert.equal(typeof manifest.name, "string");
  };
}

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

function githubFetcher(
  fx: Fixture,
  calls: FetchCall[],
  opts: {
    metadataStatus?: number;
    redirect?: boolean;
    oversized?: boolean;
    badRedirect?: boolean;
  } = {},
): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    if (url.includes("/releases/tags/")) {
      if (opts.metadataStatus) {
        return new Response("secret-body", { status: opts.metadataStatus });
      }
      return Response.json({
        assets: [{
          name: fx.bundle.release.asset,
          size: fx.bundle.archive.bytes,
          url: `https://api.github.com/repos/${REPO}/releases/assets/12345`,
        }],
      });
    }
    if (url.includes("/releases/assets/")) {
      if (opts.badRedirect) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://example.com/x" },
        });
      }
      if (opts.redirect) {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              "https://release-assets.githubusercontent.com/signed?sig=1",
          },
        });
      }
      return new Response(Uint8Array.from(fx.compressed));
    }
    if (url.startsWith("https://release-assets.githubusercontent.com/")) {
      if (opts.oversized) {
        return new Response(new Uint8Array(fx.bundle.archive.bytes + 10));
      }
      return new Response(Uint8Array.from(fx.compressed));
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

const envWithToken = (
  key: string,
) => (key === "GH_TOKEN" ? "token-secret" : undefined);
const envEmpty = () => undefined;

Deno.test("le catalogue suivi respecte le schéma strict, y compris avant publication", async () => {
  const catalog = await loadNativeCatalog(
    fileURLToPath(
      new URL("../vendor/native-runtimes/catalog.json", import.meta.url),
    ),
  );
  assert.equal(catalog.schema, 1);
  assert.deepEqual(parseNativeCatalog({ schema: 1, bundles: [] }), {
    schema: 1,
    bundles: [],
  });
  assert.throws(() => parseNativeCatalog({ schema: 2, bundles: [] }), /schema/);
  assert.throws(
    () => parseNativeCatalog({ schema: 1, bundles: [], extra: 1 }),
    /inattendus/,
  );
});

Deno.test("parseNativeCatalog refuse schémas, empreintes, fallbacks et doublons invalides", async () => {
  const fx = await fixture("toolkit");
  const base = { schema: 1, bundles: [fx.bundle] };
  assert.equal(parseNativeCatalog(base).bundles.length, 1);
  const bad: Array<[unknown, RegExp]> = [
    [{ schema: 1, bundles: [{ ...fx.bundle, runtime: "wasm" }] }, /runtime/],
    [
      { schema: 1, bundles: [{ ...fx.bundle, platform: "plan9" }] },
      /plateforme/,
    ],
    [
      { schema: 1, bundles: [{ ...fx.bundle, sourceSha256: "A".repeat(64) }] },
      /SHA-256/,
    ],
    [{
      schema: 1,
      bundles: [{
        ...fx.bundle,
        archive: { ...fx.bundle.archive, file: "a/b.tar.gz" },
      }],
    }, /nom de base/],
    [{
      schema: 1,
      bundles: [{ ...fx.bundle, archive: { ...fx.bundle.archive, bytes: 0 } }],
    }, /positif/],
    [{
      schema: 1,
      bundles: [{
        ...fx.bundle,
        files: { ...fx.bundle.files, "index.js": "c".repeat(64) },
      }],
    }, /fallback/],
    [{
      schema: 1,
      bundles: [{
        ...fx.bundle,
        files: { ...fx.bundle.files, "../x": "c".repeat(64) },
      }],
    }, /unsafe/],
    [{
      schema: 1,
      bundles: [{
        ...fx.bundle,
        files: {
          ...fx.bundle.files,
          native: "c".repeat(64),
          "native-extra": "c".repeat(64),
        },
      }],
    }, /aussi un répertoire/],
    [{
      schema: 1,
      bundles: [{
        ...fx.bundle,
        files: { "package.json": fx.bundle.files["package.json"] },
      }],
    }, /doit contenir/],
    [{ schema: 1, bundles: [fx.bundle, fx.bundle] }, /dupliqué/],
    [{
      schema: 1,
      bundles: [{
        ...fx.bundle,
        release: { ...fx.bundle.release, repository: "bad repo" },
      }],
    }, /owner\/name/],
    [{
      schema: 1,
      bundles: [{
        ...fx.bundle,
        release: { ...fx.bundle.release, asset: "other.tar.gz" },
      }],
    }, /asset/],
  ];
  for (const [value, pattern] of bad) {
    assert.throws(() => parseNativeCatalog(value), pattern);
  }
});

Deno.test("bundles toolkit et semantic autorisés s'installent depuis bundlePath sans fetch", async () => {
  for (const runtime of ["toolkit", "semantic-index"] as const) {
    const root = await tempRoot();
    try {
      const fx = await fixture(runtime);
      const catalogPath = await writeCatalog(root, [fx.bundle]);
      const bundlePath = `${root}/${fx.bundle.archive.file}`;
      await Deno.writeFile(bundlePath, fx.compressed);
      let fetchCalls = 0;
      const verifyCalls: string[] = [];
      const target = `${root}/${runtime}-${SOURCE.slice(0, 8)}`;
      const installed = await installNativeDistribution({
        runtime,
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: target,
        catalogPath,
        bundlePath,
        fetcher: (() => {
          fetchCalls++;
          throw new Error("réseau interdit");
        }) as typeof fetch,
        env: envEmpty,
        verifyPackage: verifyOk(verifyCalls),
      });
      assert.equal(installed, `${target}/package`);
      assert.equal(fetchCalls, 0);
      assert.equal(verifyCalls.length, 1);
      const addon = runtime === "toolkit"
        ? toolkitAddonPath(PLATFORM)
        : "native/ase-semantic-index-napi.node";
      assert.equal(
        await Deno.readTextFile(`${installed}/${addon}`),
        `addon-${runtime}`,
      );
      const receipt = JSON.parse(
        await Deno.readTextFile(`${target}/release.json`),
      );
      assert.equal(receipt.schema, 1);
      assert.equal(receipt.bundle.sourceSha256, SOURCE);
      assert.equal(await existsLock(target), false);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

async function existsLock(target: string): Promise<boolean> {
  try {
    await Deno.lstat(`${target}.distribution.lock`);
    return true;
  } catch {
    return false;
  }
}

Deno.test("réinstallation valide réutilise hors ligne sans fetch ni archive avec le catalogue suivi", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const bundlePath = `${root}/bundle.tar.gz`;
    await Deno.writeFile(bundlePath, fx.compressed);
    const target = `${root}/install`;
    const base = {
      runtime: "toolkit" as const,
      platform: PLATFORM,
      sourceSha256: SOURCE,
      toolchainsDirectory: root,
      targetDirectory: target,
      verifyPackage: verifyOk(),
    };
    await installNativeDistribution({
      ...base,
      catalogPath,
      bundlePath,
      env: envEmpty,
    });
    // L'archive est supprimée : seul le catalogue local reste nécessaire.
    await Deno.remove(bundlePath);
    const verifyCalls: string[] = [];
    const again = await installNativeDistribution({
      ...base,
      catalogPath,
      bundlePath: `${root}/absent.tar.gz`,
      fetcher: (() => {
        throw new Error("réseau interdit");
      }) as typeof fetch,
      env: envEmpty,
      verifyPackage: verifyOk(verifyCalls),
    });
    assert.equal(again, `${target}/package`);
    assert.equal(verifyCalls.length, 1);
    await Deno.remove(catalogPath);
    await assert.rejects(
      installNativeDistribution({
        ...base,
        catalogPath,
      }),
      /Catalogue natif introuvable/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("un reçu et un binaire modifiés ensemble ne s'autorisent pas sans le catalogue", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const bundlePath = `${root}/bundle.tar.gz`;
    await Deno.writeFile(bundlePath, fx.compressed);
    const target = `${root}/install`;
    const base = {
      runtime: "toolkit" as const,
      platform: PLATFORM,
      sourceSha256: SOURCE,
      toolchainsDirectory: root,
      targetDirectory: target,
      catalogPath,
      bundlePath,
      verifyPackage: verifyOk(),
    };
    await installNativeDistribution(base);
    const changed = encoder.encode("modified-addon");
    const addon = toolkitAddonPath(PLATFORM);
    await Deno.writeFile(`${target}/package/${addon}`, changed);
    const receiptPath = `${target}/release.json`;
    const receipt = JSON.parse(await Deno.readTextFile(receiptPath));
    receipt.bundle.files[addon] = await sha256(changed);
    await Deno.writeTextFile(receiptPath, JSON.stringify(receipt));
    await assert.rejects(
      installNativeDistribution(base),
      /préservée et non remplacée.*divergente/,
    );
    assert.deepEqual(
      await Deno.readFile(`${target}/package/${addon}`),
      changed,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("catalogue absent ou source divergente donne une erreur actionnable sans transport", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const emptyCatalog = await writeCatalog(root, []);
    let fetchCalls = 0;
    const fetcher = (() => {
      fetchCalls++;
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: `${root}/a`,
        catalogPath: emptyCatalog,
        fetcher,
        env: envWithToken,
        verifyPackage: verifyOk(),
      }),
      /Aucun bundle.*mode source explicite/,
    );
    const catalogPath = `${root}/catalog2.json`;
    await Deno.writeTextFile(
      catalogPath,
      JSON.stringify({ schema: 1, bundles: [fx.bundle] }),
    );
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: OTHER_SOURCE,
        toolchainsDirectory: root,
        targetDirectory: `${root}/b`,
        catalogPath,
        fetcher,
        env: envWithToken,
        verifyPackage: verifyOk(),
      }),
      /Aucun bundle.*mode source explicite/,
    );
    assert.equal(fetchCalls, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("transport privé : API authentifiée, redirection sans jeton, hôte arbitraire refusé", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("semantic-index");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const calls: FetchCall[] = [];
    const installed = await installNativeDistribution({
      runtime: "semantic-index",
      platform: PLATFORM,
      sourceSha256: SOURCE,
      toolchainsDirectory: root,
      targetDirectory: `${root}/dl`,
      catalogPath,
      fetcher: githubFetcher(fx, calls, { redirect: true }),
      env: envWithToken,
      verifyPackage: verifyOk(),
    });
    assert.equal(
      await Deno.readTextFile(
        `${installed}/native/ase-semantic-index-napi.node`,
      ),
      "addon-semantic-index",
    );
    assert.equal(calls.length, 3);
    assert.equal(
      calls[0].url,
      `https://api.github.com/repos/${REPO}/releases/tags/native-v1`,
    );
    assert.equal(calls[0].headers.Authorization, "Bearer token-secret");
    assert.equal(calls[0].headers.Accept, "application/vnd.github+json");
    assert.equal(calls[0].headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(calls[1].headers.Accept, "application/octet-stream");
    assert.equal(calls[1].headers.Authorization, "Bearer token-secret");
    assert.equal(
      calls[2].url.startsWith("https://release-assets.githubusercontent.com/"),
      true,
    );
    assert.equal("Authorization" in calls[2].headers, false);

    const badCalls: FetchCall[] = [];
    await assert.rejects(
      installNativeDistribution({
        runtime: "semantic-index",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: `${root}/dl2`,
        catalogPath,
        fetcher: githubFetcher(fx, badCalls, { badRedirect: true }),
        env: envWithToken,
        verifyPackage: verifyOk(),
      }),
      /hôte non autorisé/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("transport sans jeton ou en échec d'authentification est actionnable et ne fuit rien", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const calls: FetchCall[] = [];
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: `${root}/x`,
        catalogPath,
        fetcher: githubFetcher(fx, calls),
        env: envEmpty,
        verifyPackage: verifyOk(),
      }),
      /GH_TOKEN ou GITHUB_TOKEN/,
    );
    assert.equal(calls.length, 0);
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: `${root}/y`,
        catalogPath,
        fetcher: githubFetcher(fx, [], { metadataStatus: 401 }),
        env: envWithToken,
        verifyPackage: verifyOk(),
      }),
      (error: unknown) => {
        assert.match(String(error), /HTTP 401/);
        assert.doesNotMatch(String(error), /token-secret|secret-body/);
        return true;
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("réponses surdimensionnées sont rejetées avant analyse", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: `${root}/big`,
        catalogPath,
        fetcher: githubFetcher(fx, [], { redirect: true, oversized: true }),
        env: envWithToken,
        verifyPackage: verifyOk(),
      }),
      /dépasse la borne/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("archive corrompue rejetée avant publication ; installation divergente préservée", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const bundlePath = `${root}/bundle.tar.gz`;
    await Deno.writeFile(bundlePath, fx.compressed);
    const target = `${root}/install`;
    const base = {
      runtime: "toolkit" as const,
      platform: PLATFORM,
      sourceSha256: SOURCE,
      toolchainsDirectory: root,
      targetDirectory: target,
      catalogPath,
      bundlePath,
      env: envEmpty,
      verifyPackage: verifyOk(),
    };
    await installNativeDistribution(base);
    const before = await Deno.readFile(`${target}/package/package.json`);

    // Source divergente sur la même cible : refus, octets intacts.
    await assert.rejects(
      installNativeDistribution({ ...base, sourceSha256: OTHER_SOURCE }),
      /préservée et non remplacée.*Préservez ou déplacez/,
    );
    assert.deepEqual(
      await Deno.readFile(`${target}/package/package.json`),
      before,
    );

    // Archive altérée sur une cible neuve : aucun répertoire publié.
    const corrupt = Uint8Array.from(fx.compressed);
    corrupt[corrupt.length - 5] ^= 0xff;
    await Deno.writeFile(bundlePath, corrupt);
    await assert.rejects(
      installNativeDistribution({ ...base, targetDirectory: `${root}/fresh` }),
      /Archive native divergente/,
    );
    await assert.rejects(Deno.lstat(`${root}/fresh`), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("archives unsafe, non listées ou incomplètes sont refusées sans publication", async () => {
  const root = await tempRoot();
  try {
    const cases: Array<{
      name: string;
      fx: Fixture;
      pattern: RegExp;
    }> = [];
    cases.push({
      name: "unlisted",
      fx: await fixture("toolkit", (files) => [
        ...Object.entries(files).map(([path, bytes]) => ({
          path: `package/${path}`,
          bytes,
        })),
        { path: "package/extra.txt", bytes: encoder.encode("x") },
      ]),
      pattern: /non listé/,
    });
    cases.push({
      name: "traversal",
      fx: await fixture("toolkit", (files) => [
        ...Object.entries(files).map(([path, bytes]) => ({
          path: `package/${path}`,
          bytes,
        })),
        { path: "package/../escape", bytes: encoder.encode("x") },
      ]),
      pattern: /path|Unsafe/,
    });
    cases.push({
      name: "missing",
      fx: await fixture("toolkit", (files) => [
        ...Object.entries(files).filter(([path]) => path !== "LICENSE")
          .map(([path, bytes]) => ({ path: `package/${path}`, bytes })),
      ]),
      pattern: /absent de l'archive/,
    });
    cases.push({
      name: "symlink-entry",
      fx: await fixture("toolkit", (files) => [
        ...Object.entries(files).map(([path, bytes]) => ({
          path: `package/${path}`,
          bytes,
        })),
        { path: "package/link", type: "2" },
      ]),
      pattern: /links and special|non listé/,
    });
    for (const { name, fx, pattern } of cases) {
      const catalogPath = await writeCatalog(root, [fx.bundle]);
      const bundlePath = `${root}/${name}.tar.gz`;
      await Deno.writeFile(bundlePath, fx.compressed);
      const target = `${root}/${name}-target`;
      await assert.rejects(
        installNativeDistribution({
          runtime: "toolkit",
          platform: PLATFORM,
          sourceSha256: SOURCE,
          toolchainsDirectory: root,
          targetDirectory: target,
          catalogPath,
          bundlePath,
          env: envEmpty,
          verifyPackage: verifyOk(),
        }),
        pattern,
        name,
      );
      await assert.rejects(Deno.lstat(target), Deno.errors.NotFound, name);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("vérificateur en échec : rien n'est publié", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const bundlePath = `${root}/bundle.tar.gz`;
    await Deno.writeFile(bundlePath, fx.compressed);
    const target = `${root}/target`;
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: target,
        catalogPath,
        bundlePath,
        env: envEmpty,
        verifyPackage: () => Promise.reject(new Error("contrat natif refusé")),
      }),
      /Vérification du package natif refusée.*contrat natif refusé/,
    );
    await assert.rejects(Deno.lstat(target), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cible existante en lien symbolique est refusée et préservée", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const real = `${root}/real`;
    await Deno.mkdir(`${real}/package`, { recursive: true });
    await Deno.writeTextFile(`${real}/package/sentinel.txt`, "préservé");
    const target = `${root}/link-target`;
    await Deno.symlink(real, target);
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: target,
        catalogPath,
        bundlePath: `${root}/absent.tar.gz`,
        env: envEmpty,
        verifyPackage: verifyOk(),
      }),
      /préservée et non remplacée/,
    );
    assert.equal((await Deno.lstat(target)).isSymlink, true);
    assert.equal(
      await Deno.readTextFile(`${real}/package/sentinel.txt`),
      "préservé",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("le délai de transport couvre aussi un corps qui ne termine pas", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    let cancelled = false;
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('{"assets":['));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      );
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: `${root}/deadline`,
        catalogPath,
        fetcher,
        fetchTimeoutMs: 10,
        env: envWithToken,
        verifyPackage: verifyOk(),
      }),
      /délai de transport dépassé/,
    );
    assert.equal(cancelled, true);
    await assert.rejects(Deno.lstat(`${root}/deadline`), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function rejectionWithinCleanupBound(
  operation: Promise<unknown>,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      operation.then(
        () => ({ resolved: true as const }),
        (error: unknown) => ({ error }),
      ),
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), 500);
      }),
    ]);
    assert.notEqual(outcome, "pending", "cancel ne doit pas bloquer le refus");
    if (outcome === "pending" || !("error" in outcome)) {
      throw new Error("Le transport devait être refusé sans attendre cancel");
    }
    return outcome.error;
  } finally {
    clearTimeout(timer);
  }
}

Deno.test("un cancel qui ne termine pas ne bloque pas le délai des métadonnées ou de l'asset", async () => {
  for (const stalledAt of ["metadata", "asset"] as const) {
    const root = await tempRoot();
    try {
      const fx = await fixture("toolkit");
      const catalogPath = await writeCatalog(root, [fx.bundle]);
      let fetches = 0;
      let cancellations = 0;
      const fetcher: typeof fetch = () => {
        fetches++;
        if (stalledAt === "asset" && fetches === 1) {
          return Promise.resolve(Response.json({
            assets: [{
              name: fx.bundle.release.asset,
              size: fx.bundle.archive.bytes,
              url:
                `https://api.github.com/repos/${fx.bundle.release.repository}/releases/assets/1`,
            }],
          }));
        }
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull() {
                return new Promise(() => {});
              },
              cancel() {
                cancellations++;
                return new Promise(() => {});
              },
            }),
          ),
        );
      };
      const target = `${root}/stalled-cancel`;
      const error = await rejectionWithinCleanupBound(
        installNativeDistribution({
          runtime: "toolkit",
          platform: PLATFORM,
          sourceSha256: SOURCE,
          toolchainsDirectory: root,
          targetDirectory: target,
          catalogPath,
          fetcher,
          fetchTimeoutMs: 10,
          env: envWithToken,
          verifyPackage: verifyOk(),
        }),
      );
      assert.match(String(error), /délai de transport dépassé/);
      assert.equal(fetches, stalledAt === "metadata" ? 1 : 2);
      assert.equal(cancellations, 1);
      await assert.rejects(Deno.lstat(target), Deno.errors.NotFound);
      await assert.rejects(
        Deno.lstat(`${target}.distribution.lock`),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("un cancel bloqué ne masque pas un refus HTTP avant lecture du corps", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    let cancellations = 0;
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancellations++;
              return new Promise(() => {});
            },
          }),
          { status: 503 },
        ),
      );
    const target = `${root}/http-stalled-cancel`;
    const error = await rejectionWithinCleanupBound(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: target,
        catalogPath,
        fetcher,
        env: envWithToken,
        verifyPackage: verifyOk(),
      }),
    );
    assert.match(String(error), /HTTP 503/);
    assert.equal(cancellations, 1);
    await assert.rejects(Deno.lstat(target), Deno.errors.NotFound);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("une erreur du corps distant ne divulgue pas ses détails", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const fetcher: typeof fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("token-secret remote body details"));
            },
          }),
        ),
      );
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: `${root}/body-error`,
        catalogPath,
        fetcher,
        env: envWithToken,
        verifyPackage: verifyOk(),
      }),
      (error: unknown) => {
        assert.match(String(error), /lecture du corps interrompue/);
        assert.doesNotMatch(String(error), /token-secret|remote body details/);
        return true;
      },
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("une cible apparue pendant la vérification reste préservée même vide", async () => {
  const root = await tempRoot();
  try {
    const fx = await fixture("toolkit");
    const catalogPath = await writeCatalog(root, [fx.bundle]);
    const bundlePath = `${root}/bundle.tar.gz`;
    await Deno.writeFile(bundlePath, fx.compressed);
    const target = `${root}/appeared`;
    await assert.rejects(
      installNativeDistribution({
        runtime: "toolkit",
        platform: PLATFORM,
        sourceSha256: SOURCE,
        toolchainsDirectory: root,
        targetDirectory: target,
        catalogPath,
        bundlePath,
        verifyPackage: async () => await Deno.mkdir(target),
      }),
      /cible apparue/,
    );
    assert.equal((await Deno.lstat(target)).isDirectory, true);
    assert.deepEqual([...Deno.readDirSync(target)], []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("la cible reste confinée au répertoire des toolchains sans traverser un lien parent", async () => {
  const root = await tempRoot();
  try {
    const outside = `${root}/outside`;
    const toolchains = `${root}/toolchains`;
    await Deno.mkdir(outside);
    await Deno.mkdir(toolchains);
    await Deno.symlink(outside, `${toolchains}/linked`);
    for (const target of [`${outside}/target`, `${toolchains}/linked/target`]) {
      await assert.rejects(
        installNativeDistribution({
          runtime: "toolkit",
          platform: PLATFORM,
          sourceSha256: SOURCE,
          toolchainsDirectory: toolchains,
          targetDirectory: target,
          verifyPackage: verifyOk(),
        }),
        /enfant direct/,
      );
    }
    assert.deepEqual([...Deno.readDirSync(outside)], []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
