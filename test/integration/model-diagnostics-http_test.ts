import { sourceExecutablesCompilation } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import assert from "node:assert/strict";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { materialize } from "../../src/domain/model/value-objects/artifact.ts";
import { JsonModelDiagnosticMaskStore } from "../../src/adapters/out/filesystem/diagnostic-masks.ts";
import { createModelDiagnosticsHandler } from "../../src/adapters/in/http/diagnostics/diagnostics.ts";
import { SourceModelDiagnosticsReader } from "../../src/application/model/diagnostics/source-diagnostics-reader.ts";
import { ModelDiagnosticsService } from "../../src/application/model/diagnostics/service.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import type { ModelDiagnosticFacts } from "../../src/domain/model/policies/diagnostics.ts";

const input: ModelDiagnosticFacts = {
  units: [{
    location: {
      elementId: "operator-a",
      qualifiedName: "Workshop::operator",
      source: { file: "workshop.sysml", line: 12, column: 3 },
    },
    kind: "conversation",
    hasInvocationBudget: false,
    admissionMode: "builder",
    accountableHumanDeclared: true,
  }],
  effects: [],
  networkCapabilities: [],
};

Deno.test("diagnostics HTTP distinguishes missing Git versions from damaged repositories", async () => {
  const directory = await Deno.makeTempDir({
    dir: ".data",
    prefix: "diagnostics-http-git-",
  });
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    const repository = await GitModelRepository.open({
      projectDir: directory,
      compiler: {
        compile: (sources) => materialize([], sources, "fixture-engine"),
        recipe: () => {
          throw new Error("Fixture compiler reports no build recipe");
        },
      },
    });
    const initial = await repository.initialize({
      "model.sysml": "package Diagnostics;\n",
    });
    const handler = createModelDiagnosticsHandler(
      new ModelDiagnosticsService(
        new SourceModelDiagnosticsReader(
          repository,
          repository.projectId,
          sourceExecutablesCompilation,
        ),
        await JsonModelDiagnosticMaskStore.open(
          `${directory}/model-diagnostic-masks.json`,
        ),
      ),
    );
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) =>
        await handler(request) ?? new Response(null, { status: 404 }),
    );
    const base = `http://127.0.0.1:${server.addr.port}`;
    const get = async (version: string) => {
      const response = await fetch(
        `${base}/api/model/diagnostics?version=${version}`,
      );
      return { status: response.status, body: await response.json() };
    };
    const missingVersion = `commit:${"0".repeat(40)}`;
    const missing = await get(missingVersion);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "NOT_FOUND");
    assert.equal(
      (await repository.at(initial.version)).version,
      initial.version,
    );

    const oid = initial.version.slice(7);
    const objectPath = `${repository.gitDir}/objects/${oid.slice(0, 2)}/${
      oid.slice(2)
    }`;
    await Deno.chmod(objectPath, 0o644);
    await Deno.writeTextFile(objectPath, "corrupt Git object");
    const corrupt = await get(initial.version);
    assert.equal(corrupt.status, 500);
    assert.equal(corrupt.body.code, "INVALID_REPOSITORY");

    await Deno.remove(`${repository.gitDir}/HEAD`);
    const invalid = await get(missingVersion);
    assert.equal(invalid.status, 500);
    assert.equal(invalid.body.code, "INVALID_REPOSITORY");
  } finally {
    await server?.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("diagnostics HTTP retains masked findings and instance preferences after reopening storage", async () => {
  const directory = await Deno.makeTempDir({
    dir: ".data",
    prefix: "diagnostics-http-",
  });
  const path = `${directory}/first/model-diagnostic-masks.json`;
  const reader = {
    read(version = "commit:current") {
      if (
        !["commit:current", "commit:historical", "branch:proposal"].includes(
          version,
        )
      ) {
        return Promise.reject(
          new ModelRepositoryError("NOT_FOUND", "Model version not found."),
        );
      }
      return Promise.resolve({
        version,
        digest: version,
        input: version === "branch:proposal"
          ? {
            ...input,
            units: input.units.map((unit) => ({
              ...unit,
              hasInvocationBudget: true,
            })),
          }
          : input,
      });
    },
  };
  let server: Deno.HttpServer<Deno.NetAddr> | undefined;
  try {
    const masks = await JsonModelDiagnosticMaskStore.open(path);
    let service = new ModelDiagnosticsService(reader, masks);
    let handler = createModelDiagnosticsHandler(service);
    server = Deno.serve(
      { hostname: "127.0.0.1", port: 0, onListen() {} },
      async (request) =>
        await handler(request) ?? new Response(null, { status: 404 }),
    );
    const base = `http://127.0.0.1:${server.addr.port}`;
    const get = async (query = "") => {
      const response = await fetch(`${base}/api/model/diagnostics${query}`);
      return { status: response.status, body: await response.json() };
    };
    const post = async (
      masked: boolean,
      target: { code: string; elementId?: string | null } = {
        code: "LOOP_WITHOUT_BUDGET",
        elementId: "operator-a",
      },
    ) => {
      const response = await fetch(`${base}/api/model/diagnostics/masks`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({
          ...target,
          masked,
        }),
      });
      return { status: response.status, body: await response.json() };
    };
    assert.equal((await get()).body.diagnostics[0].masked, false);
    assert.equal((await post(true)).status, 200);
    const masked = await get();
    assert.equal(masked.status, 200);
    assert.equal(masked.body.version, "commit:current");
    assert.equal(masked.body.sourceDigest, "commit:current");
    assert.equal(Object.hasOwn(masked.body, "digest"), false);
    assert.equal(masked.body.diagnostics.length, 2);
    assert.equal(masked.body.diagnostics[0].masked, true);
    assert.equal(masked.body.diagnostics[0].source.line, 12);
    assert.deepEqual(await service.forAgent(), []);
    const reopened = await JsonModelDiagnosticMaskStore.open(path);
    service = new ModelDiagnosticsService(reader, reopened);
    handler = createModelDiagnosticsHandler(service);
    assert.equal((await get()).body.diagnostics[0].masked, true);
    assert.equal(
      (await get("?version=commit:historical")).body.diagnostics[0].masked,
      true,
    );
    const other = new ModelDiagnosticsService(
      reader,
      await JsonModelDiagnosticMaskStore.open(
        `${directory}/second/model-diagnostic-masks.json`,
      ),
    );
    assert.equal((await other.list()).diagnostics[0].masked, false);
    assert.equal((await post(false)).status, 200);
    assert.equal((await get()).body.diagnostics[0].masked, false);
    const proposed = await get("?version=branch:proposal");
    assert.equal(proposed.body.version, "branch:proposal");
    assert.equal(proposed.body.sourceDigest, "branch:proposal");
    assert.deepEqual(
      proposed.body.diagnostics.map((d: { code: string }) => d.code),
      ["SELF_ADMINISTERED"],
    );
    for (
      const target of [{ code: "LOOP_WITHOUT_BUDGET" }, {
        code: "SELF_ADMINISTERED",
        elementId: null,
      }]
    ) {
      assert.equal((await post(true, target)).status, 200);
    }
    assert(
      (await get()).body.diagnostics.every((d: { masked: boolean }) =>
        d.masked
      ),
    );
    handler = createModelDiagnosticsHandler(
      new ModelDiagnosticsService(
        reader,
        await JsonModelDiagnosticMaskStore.open(path),
      ),
    );
    assert(
      (await get("?version=commit:historical")).body.diagnostics.every((
        d: { masked: boolean },
      ) => d.masked),
    );
    assert.equal(
      (await post(false, { code: "SELF_ADMINISTERED" })).status,
      200,
    );
    assert.equal(
      (await get("?version=branch:proposal")).body.diagnostics[0].masked,
      false,
    );
    const missing = await get("?version=commit:missing");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "NOT_FOUND");
  } finally {
    await server?.shutdown();
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("diagnostic mask JSON serializes concurrent writes and refuses damaged preferences", async () => {
  const directory = await Deno.makeTempDir({
    dir: ".data",
    prefix: "diagnostics-store-",
  });
  const path = `${directory}/model-diagnostic-masks.json`;
  try {
    const first = await JsonModelDiagnosticMaskStore.open(path);
    const second = await JsonModelDiagnosticMaskStore.open(path);
    await Promise.all([
      first.set({ code: "LOOP_WITHOUT_BUDGET", elementId: "a", masked: true }),
      second.set({ code: "LOOP_WITHOUT_BUDGET", elementId: "b", masked: true }),
    ]);
    assert.deepEqual((await first.list()).map((mask) => mask.elementId), [
      "a",
      "b",
    ]);
    await first.set({
      code: "LOOP_WITHOUT_BUDGET",
      elementId: "a",
      masked: false,
    });
    assert.deepEqual((await second.list()).map((mask) => mask.elementId), [
      "b",
    ]);
    await first.set({
      code: "SELF_ADMINISTERED",
      elementId: null,
      masked: true,
    });
    assert(
      (await second.list()).some((mask) =>
        mask.code === "SELF_ADMINISTERED" && mask.elementId === undefined
      ),
    );
    await second.set({ code: "SELF_ADMINISTERED", masked: false });
    assert(
      !(await first.list()).some((mask) => mask.code === "SELF_ADMINISTERED"),
    );
    await Deno.writeTextFile(
      path,
      '{"schemaVersion":"model-diagnostic-masks/v1","masks":[{"code":"W","masked":true}]}',
    );
    const damaged = await JsonModelDiagnosticMaskStore.open(path);
    await assert.rejects(() => damaged.list(), /Invalid/);
    assert.match(await Deno.readTextFile(path), /masked/);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
