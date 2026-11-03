import assert from "node:assert/strict";
import {
  BuildStoreError,
  type ModelBuildStore,
} from "../../../application/model/builds/ports/out/build-store.port.ts";
import {
  type CachedModelProjectionsOptions,
  createCachedModelProjections,
} from "./cache.ts";
import { matrixFixture } from "../../../../test/support/authority-matrix-fixtures.ts";
import type { ModelBoard } from "../../../domain/model/records/board.ts";
import type { BuildDescriptor } from "../../../domain/model/value-objects/build.ts";
import type {
  ModelViewList,
  ModelViewSummary,
} from "../../../domain/model/records/diagram-views.ts";

const V1 = `commit:${"1".repeat(40)}`;
const V2 = `commit:${"2".repeat(40)}`;
const A = "a".repeat(64);
const S = "b".repeat(64);
function store(): ModelBuildStore {
  const bytes = new Map<string, Uint8Array>();
  return {
    getProjection(kind: string, version: string, key: string) {
      const value = bytes.get(`${kind}/${version}/${key}`);
      return value ? Promise.resolve(value.slice()) : Promise.reject(
        new BuildStoreError("BUILD_BLOB_MISSING", {}, "missing"),
      );
    },
    putProjection(
      kind: string,
      version: string,
      key: string,
      value: Uint8Array,
    ) {
      bytes.set(`${kind}/${version}/${key}`, value.slice());
      return Promise.resolve({
        stored: true,
        bytes: value.length,
        digest: key,
      });
    },
  } as ModelBuildStore;
}
function fixture(buildStore = store()) {
  const calls = {
    at: 0,
    board: 0,
    matrix: 0,
    list: 0,
    diagram: 0,
    plantuml: 0,
    descriptor: 0,
  };
  const summary: ModelViewSummary = {
    id: "view:one",
    title: "One",
    kind: "tree",
    group: "definitions",
    element: "One",
    nodes: 0,
    edges: 0,
  };
  const board: ModelBoard = {
    schema: "ase.board/1",
    meta: {
      model: "test",
      mode: "ase",
      sourceDigest: S,
      diagnostics: [],
      digest: A,
    },
    columns: [],
    links: [],
    index: {},
  };
  const options: CachedModelProjectionsOptions = {
    repositoryId: "repo",
    projectId: "project",
    buildStore,
    repository: {
      header(version) {
        return Promise.resolve({ version, sources: {}, sourceDigest: S });
      },
      descriptorAt(_version) {
        calls.descriptor++;
        return Promise.resolve(
          {
            repositoryId: "repo",
            sourceDigest: S,
            artifactDigest: A,
          } as BuildDescriptor,
        );
      },
      at(version) {
        calls.at++;
        return Promise.resolve({
          version,
          sources: { "m.sysml": "package Test;" },
          elements: [],
          documents: [],
          sourceDigest: S,
          sourceHashes: {},
          semanticDigest: A,
          provenanceDigest: A,
          engineVersion: "test",
        });
      },
    },
    tooling: {
      board() {
        calls.board++;
        return Promise.resolve(structuredClone(board));
      },
      views() {
        calls.list++;
        return Promise.resolve(
          {
            toolkit: "test",
            views: [summary],
            diagnostics: [],
            digest: A,
          } as ModelViewList,
        );
      },
      diagram() {
        calls.diagram++;
        return Promise.resolve({
          ...summary,
          diagram: { nodes: [], edges: [] },
        });
      },
      plantuml() {
        calls.plantuml++;
        return Promise.resolve("@startuml\n@enduml");
      },
    },
    authorityMatrixProject(revision) {
      calls.matrix++;
      const matrix = matrixFixture(revision.version);
      matrix.model.sourceDigest = S;
      return Promise.resolve(matrix);
    },
  };
  return { options, calls };
}
Deno.test("cached projection coalesces reads, persists bytes, isolates consumers and bounds pins", async () => {
  const f = fixture();
  const p = createCachedModelProjections({ ...f.options, maxPins: 2 });
  const values = await Promise.all(
    Array.from({ length: 20 }, () => p.board.read(V1)),
  );
  assert.equal(f.calls.board, 1);
  assert.equal(f.calls.descriptor, 1);
  assert.equal(f.calls.at, 1, "descriptor pin never materializes a revision");
  values[0].meta.model = "mutated";
  assert.equal(values[1].meta.model, "test");
  assert.equal((await p.board.read(V1)).meta.model, "test");
  const restarted = createCachedModelProjections(f.options);
  await restarted.board.read(V1);
  assert.equal(f.calls.board, 1, "new registry reuses persistent projection");
  await p.board.read(V2);
  assert.equal(f.calls.board, 1, "same A/S is shared across commits");
  await p.board.read(`commit:${"3".repeat(40)}`);
  assert.equal(p.stats().pins, 2);
  assert.equal(p.stats().heldRevisions, 0);
  assert.equal(p.stats().triggers, 0);
  assert.ok(p.registry.stats().bytes < 10000);
});
Deno.test("projector version, project and sources invalidate pure projection keys", async () => {
  const f = fixture();
  await createCachedModelProjections(f.options).board.read(V1);
  await createCachedModelProjections({
    ...f.options,
    projectorVersions: { board: "2" },
  }).board.read(V1);
  await createCachedModelProjections({ ...f.options, projectId: "other" }).board
    .read(V1);
  assert.equal(f.calls.board, 3);
});
Deno.test("matrix pure content reattaches requested commit and recalculates its digest", async () => {
  const f = fixture();
  const p = createCachedModelProjections(f.options);
  const [a, b] = await Promise.all([
    p.authorityMatrix.read(V1),
    p.authorityMatrix.read(V2),
  ]);
  assert.equal(a.version, V1);
  assert.equal(b.version, V2);
  assert.notEqual(a.digest, b.digest);
  assert.equal(f.calls.matrix, 1);
  const restarted = createCachedModelProjections(f.options);
  const restored = await restarted.authorityMatrix.read(V2);
  assert.equal(restored.version, V2);
  assert.equal(restored.digest, b.digest);
  assert.equal(f.calls.matrix, 1);
});
Deno.test("wrong matrix version fails before cache persistence", async () => {
  const f = fixture();
  const p = createCachedModelProjections({
    ...f.options,
    authorityMatrixProject: () => Promise.resolve(matrixFixture(V2)),
  });
  await assert.rejects(
    () => p.authorityMatrix.read(V1),
    (error: unknown) =>
      (error as { code: string }).code === "MODEL_VERSION_MISMATCH",
  );
  assert.equal(p.registry.stats().entries, 0);
});
Deno.test("current prewarms only System projections; history and selected views never move it", async () => {
  const f = fixture();
  const p = createCachedModelProjections(f.options);
  const events: string[] = [];
  const unsubscribe = p.subscribe((event) => {
    events.push(event.state);
  });
  await p.requestCurrent(V2);
  await Promise.all([
    p.board.read(V2),
    p.authorityMatrix.read(V2),
    p.views.list(V2),
  ]);
  assert.equal(f.calls.diagram, 0);
  assert.equal(f.calls.plantuml, 0);
  assert.equal(p.current("board").requestedVersion, V2);
  assert.equal(p.current("board").availableVersion, V2);
  assert.equal(p.current("board").state, "ready");
  await p.board.read(V1);
  assert.equal(p.currentVersion(), V2);
  assert.equal(p.current("board").requestedVersion, V2);
  await Promise.all([
    p.views.diagram(V1, "view:one"),
    p.views.plantuml(V1, "view:one"),
  ]);
  assert.equal(f.calls.diagram, 1);
  assert.equal(f.calls.plantuml, 1);
  assert.ok(events.includes("pending") && events.includes("ready"));
  unsubscribe();
});
Deno.test("legacy descriptors bypass A cache without inventing a recipe", async () => {
  const f = fixture();
  f.options.repository.descriptorAt = () => Promise.resolve(null);
  const p = createCachedModelProjections(f.options);
  const pin = await p.pinFor(V1);
  assert.equal(pin.origin, "legacy");
  assert.equal(pin.artifactDigest, undefined);
  assert.equal(f.calls.at, 0);
  await p.board.read(V1);
  await p.board.read(V1);
  assert.equal(f.calls.board, 2);
  assert.equal(p.registry.stats().entries, 0);
});
Deno.test("invalid immutable versions fail at the reader boundary", async () => {
  const f = fixture();
  const p = createCachedModelProjections(f.options);
  await assert.rejects(
    () => p.board.read("HEAD"),
    (error: unknown) => (error as { code: string }).code === "INVALID_REQUEST",
  );
  assert.equal(f.calls.at, 0);
});

Deno.test("cached System completion still emits ready for a newly designated commit", async () => {
  const f = fixture();
  const p = createCachedModelProjections(f.options);
  await p.board.read(V1);
  const ready: string[] = [];
  p.subscribe((event) => {
    if (event.kind === "board" && event.state === "ready") {
      ready.push(...event.versions);
    }
  });
  await p.requestCurrent(V2);
  await p.board.read(V2);
  // requestCurrent completion is a separate promise reaction from the reader.
  await Promise.resolve();
  assert.ok(ready.includes(V2));
  assert.equal(p.current("board").availableVersion, V2);
  await Promise.all([p.authorityMatrix.read(V2), p.views.list(V2)]);
});
Deno.test("distinct source S invalidates cache even when artifact A is unchanged", async () => {
  const shared = store();
  const first = fixture(shared);
  await createCachedModelProjections(first.options).views.list(V1);
  const second = fixture(shared);
  const nextS = "c".repeat(64);
  second.options.repository.header = (version) =>
    Promise.resolve({ version, sources: {}, sourceDigest: nextS });
  second.options.repository.descriptorAt = () =>
    Promise.resolve(
      {
        repositoryId: "repo",
        sourceDigest: nextS,
        artifactDigest: A,
      } as BuildDescriptor,
    );
  await createCachedModelProjections(second.options).views.list(V1);
  assert.equal(first.calls.list, 1);
  assert.equal(second.calls.list, 1);
});
