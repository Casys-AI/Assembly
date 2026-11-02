import assert from "node:assert/strict";
import { openNativeSemanticIndex } from "../../src/adapters/out/oxigraph/runtime.ts";
import {
  NAPI_CLI_VERSION,
  RUST_TOOLCHAIN_VERSION,
  TOOLKIT_NATIVE_PLATFORMS,
  toolkitNativePlatform,
} from "../../src/adapters/sysml-toolkit-pin.ts";

async function hash(bytes: Uint8Array): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function fixture(root: string) {
  const platform = toolkitNativePlatform(Deno.build.os, Deno.build.arch)!;
  const bytes = new TextEncoder().encode(
    "fake binary, must never be loaded by parent",
  );
  const build = {
    schema: 1,
    name: "ase-semantic-index-napi",
    version: "0.1.0",
    platform,
    target: TOOLKIT_NATIVE_PLATFORMS[platform].target,
    abi: "napi8",
    rustc: `rustc ${RUST_TOOLCHAIN_VERSION}`,
    napiCli: NAPI_CLI_VERSION,
    oxigraph: "0.4.11",
    spargebra: "0.3.5",
    sourceSha256: "a".repeat(64),
    addonFile: "native/ase-semantic-index-napi.node",
    addonSha256: await hash(bytes),
    addonBytes: bytes.length,
  };
  await Deno.mkdir(`${root}/native`);
  await Deno.writeFile(`${root}/${build.addonFile}`, bytes);
  await Deno.writeTextFile(
    `${root}/package.json`,
    JSON.stringify({ name: build.name, version: build.version }),
  );
  await Deno.writeTextFile(`${root}/buildinfo.json`, JSON.stringify(build));
  return build;
}

Deno.test("semantic runtime verifies installed package without starting a native child", async () => {
  const root = await Deno.makeTempDir();
  try {
    const build = await fixture(root);
    // Test runs without --allow-run or --allow-ffi: opening and closing are lazy.
    const runtime = await openNativeSemanticIndex({ packageDirectory: root });
    assert.equal(runtime.packageDirectory, root);
    assert.equal(runtime.provenance.version, "0.1.0");
    assert.equal(runtime.provenance.oxigraph, "0.4.11");
    assert.equal(runtime.provenance.sourceDigest, build.sourceSha256);
    assert.match(runtime.provenance.digest, /^[0-9a-f]{64}$/);
    const again = await openNativeSemanticIndex({ packageDirectory: root });
    assert.equal(again.provenance.digest, runtime.provenance.digest);
    await runtime.close();
    await again.close();
    await Deno.writeTextFile(
      `${root}/package.json`,
      JSON.stringify({
        name: build.name,
        version: build.version,
        description: "changed manifest",
      }),
    );
    const changed = await openNativeSemanticIndex({ packageDirectory: root });
    assert.notEqual(changed.provenance.digest, runtime.provenance.digest);
    await changed.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("semantic runtime rejects incompatible metadata and changed binary bytes", async () => {
  const root = await Deno.makeTempDir();
  try {
    const build = await fixture(root);
    for (
      const patch of [
        { platform: "unknown" },
        { target: "wrong" },
        { version: "0.2.0" },
        { oxigraph: "0.5.0" },
        { spargebra: "0.4.0" },
        { abi: "napi9" },
        { sourceSha256: "invalid" },
        { addonFile: "index.js" },
        { addonSha256: "b".repeat(64) },
      ]
    ) {
      await Deno.writeTextFile(
        `${root}/buildinfo.json`,
        JSON.stringify({ ...build, ...patch }),
      );
      await assert.rejects(
        () => openNativeSemanticIndex({ packageDirectory: root }),
        /provenance or binary integrity mismatch/,
      );
    }
    await Deno.writeTextFile(`${root}/buildinfo.json`, JSON.stringify(build));
    await Deno.writeTextFile(`${root}/${build.addonFile}`, "changed");
    await assert.rejects(
      () => openNativeSemanticIndex({ packageDirectory: root }),
      /binary integrity mismatch/,
    );
    await Deno.remove(`${root}/buildinfo.json`);
    await assert.rejects(
      () => openNativeSemanticIndex({ packageDirectory: root }),
      /Run deno run -A tools\/setup-semantic-index.ts/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("semantic runtime rejects symlinked binary and package directory", async () => {
  const root = await Deno.makeTempDir();
  try {
    const packageDir = `${root}/package`;
    await Deno.mkdir(packageDir);
    const build = await fixture(packageDir);
    await Deno.rename(`${packageDir}/${build.addonFile}`, `${root}/real.node`);
    await Deno.symlink(`${root}/real.node`, `${packageDir}/${build.addonFile}`);
    await assert.rejects(
      () => openNativeSemanticIndex({ packageDirectory: packageDir }),
      /regular file/,
    );
    await Deno.symlink(packageDir, `${root}/alias`);
    await assert.rejects(
      () => openNativeSemanticIndex({ packageDirectory: `${root}/alias` }),
      /regular directory/,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
