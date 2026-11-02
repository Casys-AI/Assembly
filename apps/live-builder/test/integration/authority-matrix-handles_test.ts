import assert from "node:assert/strict";
import { projectAuthorityMatrix } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/projection.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import { prepareMatrixArtifact } from "../support/authority-matrix-artifact-fixtures.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { MATRIX_PROCESS_HEAP_MIB } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import { writeProjectionJson } from "../../src/infrastructure/projection-json-stream.ts";
import type { AuthorityMatrix } from "../../src/domain/governance/records/authority-matrix.ts";

Deno.test("matrix runtime dependency graph has no Toolkit compiler, loader, adapter or worker", async () => {
  const root = new URL(
    "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/projection.ts",
    import.meta.url,
  ).href;
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", root],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.ok(result.success, new TextDecoder().decode(result.stderr));
  const graph: {
    modules: {
      specifier: string;
      dependencies?: { code?: { specifier: string } }[];
    }[];
  } = JSON.parse(new TextDecoder().decode(result.stdout));
  const bySpecifier = new Map(
    graph.modules.map((module) => [module.specifier, module]),
  );
  const visited = new Set<string>();
  const visit = (specifier: string) => {
    if (visited.has(specifier)) return;
    visited.add(specifier);
    assert.equal(
      /(?:toolkit-compiler|sysml-toolkit-[^/]+)\.ts$/.test(specifier),
      false,
      `Toolkit runtime dependency reached: ${specifier}`,
    );
    // Type-only dependencies in Deno's graph are intentionally not runtime edges.
    for (const dependency of bySpecifier.get(specifier)?.dependencies ?? []) {
      if (dependency.code) visit(dependency.code.specifier);
    }
  };
  visit(root);
  assert.ok(visited.size > 5, "transitive runtime dependencies were checked");
});

// Preparation is deliberately outside the restricted projection test. Its child
// exits before we enter the permission-free path; the parent loads no Toolkit.
const prepared = toolkitIntegrationEnabled
  ? await prepareMatrixArtifact("initial", {
    packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    projectId: "git:22222222-2222-4222-8222-222222222222",
    version: parseModelRevisionId(`commit:${"a".repeat(40)}`),
  })
  : undefined;

Deno.test({
  name:
    "artifact projection works without I/O permissions and allocates no Toolkit session or wrapper",
  ignore: !prepared,
  permissions: {
    read: false,
    write: false,
    env: false,
    net: false,
    run: false,
    ffi: false,
    sys: false,
  },
  async fn() {
    assert.ok(prepared);
    const matrix = await projectAuthorityMatrix({
      revision: prepared.revision,
      units: prepared.units,
      name: "initial",
    });
    assert.equal(matrix.summary.coordinates.mismatches, 0);
    assert.ok(matrix.summary.coordinates.checked > 0);
    assert.match(matrix.digest, /^[0-9a-f]{64}$/);
    console.log(JSON.stringify({
      qualification:
        "runtime import graph excludes all Toolkit entry points; real artifact projection succeeds with filesystem, network, subprocess, FFI and env access denied",
      toolkitSessions: 0,
      toolkitElementWrappers: 0,
    }));
  },
});

Deno.test("matrix reader and worker entry points contain no source compiler or Toolkit execution calls", async () => {
  for (
    const filename of [
      "reader.ts",
      "process.ts",
      "worker-client.ts",
    ]
  ) {
    const source = await Deno.readTextFile(
      new URL(
        `../../src/adapters/out/sysml-toolkit/projections/authority-matrix/${filename}`,
        import.meta.url,
      ),
    );
    assert.doesNotMatch(
      source,
      /\b(?:ToolkitCompiler|SysmlToolkitAdapter|loadSysmlToolkit|createSession|runSysmlToolkitWorker)\b|\.\s*compile\s*\(/,
      filename,
    );
  }
});

Deno.test({
  name:
    "production matrix process validates and projects an artifact while Toolkit compilation is poisoned",
  ignore: !prepared,
  async fn() {
    assert.ok(prepared);
    const {
      version,
      sourceDigest,
      engineVersion,
      provenanceDigest,
      provider,
      sources,
      elements,
    } = prepared.revision;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        "--quiet",
        `--v8-flags=--max-old-space-size=${MATRIX_PROCESS_HEAP_MIB}`,
        "--allow-read",
        "--allow-env",
        new URL(
          "../fixtures/authority-matrix-no-compile-worker.ts",
          import.meta.url,
        ).pathname,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const output = child.output();
    void output.catch(() => undefined);
    try {
      await writeProjectionJson(child.stdin, {
        revision: {
          version,
          sourceDigest,
          engineVersion,
          provenanceDigest,
          provider,
          sources,
          elements,
        },
        pin: prepared.pin,
        projectId: "git:22222222-2222-4222-8222-222222222222",
        name: "initial",
        // No units: the real process entry must invoke its validator.
      });
      await child.stdin.close();
      const status = await output;
      assert.equal(status.code, 0, new TextDecoder().decode(status.stderr));
      assert.equal(status.signal, null);
      const result: { ok: boolean; matrix: AuthorityMatrix; error?: unknown } =
        JSON.parse(new TextDecoder().decode(status.stdout));
      assert.equal(result.ok, true, JSON.stringify(result.error));
      const matrix = result.matrix;
      const expected = await projectAuthorityMatrix({
        revision: prepared.revision,
        units: prepared.units,
        name: "initial",
      });
      assert.equal(matrix.version, version);
      assert.equal(matrix.model.sourceDigest, sourceDigest);
      assert.equal(matrix.summary.coordinates.mismatches, 0);
      assert.deepEqual(
        matrix.summary.coordinates,
        expected.summary.coordinates,
      );
      assert.deepEqual([
        matrix.rows.length,
        matrix.columns.length,
        matrix.cells.length,
      ], [
        expected.rows.length,
        expected.columns.length,
        expected.cells.length,
      ]);
      assert.equal(matrix.digest, expected.digest);
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* Own child already exited. */ }
      await output;
    }
  },
});
