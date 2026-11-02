import assert from "node:assert/strict";
import {
  ModelViewDiagramService,
  ModelViewListService,
  ModelViewPlantumlService,
} from "./views.ts";
import type { ModelViewsReader } from "./ports/out/model-views-reader.port.ts";
import type {
  ModelView,
  ModelViewDiagramDocument,
  ModelViewList,
  ModelViewSummary,
} from "../../../domain/model/records/diagram-views.ts";

const VERSION = `commit:${"a".repeat(40)}`;
const OTHER = `commit:${"b".repeat(40)}`;

function summary(id: string): ModelViewSummary {
  const [group, element] = id.split(":");
  return {
    id,
    title: element,
    kind: "interconnection",
    group: group as ModelViewSummary["group"],
    element,
    nodes: 2,
    edges: 0,
  };
}

function list(
  views: ModelViewSummary[] = [summary("structure:Demo::system")],
): ModelViewList {
  return { toolkit: "0.10.10", views, diagnostics: [], digest: "a".repeat(64) };
}

function document(view: ModelViewSummary): ModelViewDiagramDocument {
  const full: ModelView = {
    ...view,
    diagram: {
      nodes: [
        { id: "n1", kind: "part", name: "system", rows: [] },
        { id: "n2", kind: "part", name: "engine", rows: [] },
      ],
      edges: [],
    },
  };
  return { toolkit: "0.10.10", view: full, digest: "b".repeat(64) };
}

function reader(
  views: ModelViewSummary[] = [summary("structure:Demo::system")],
) {
  const calls = { list: 0, diagram: 0 };
  const inner: Pick<ModelViewsReader, "list" | "diagram"> = {
    list(_version: string) {
      calls.list++;
      return Promise.resolve(list(views));
    },
    diagram(version: string, viewId: string) {
      calls.diagram++;
      const found = views.find((view) => view.id === viewId);
      if (!found) {
        return Promise.reject({
          code: "VIEW_NOT_FOUND",
          context: { version, view: viewId },
          recovery: "Re-read the view list and choose an existing view id.",
        });
      }
      return Promise.resolve(document(found));
    },
  };
  return { calls, inner };
}

Deno.test("view list reads share one computation across concurrent readers", async () => {
  let computations = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = new ModelViewListService({
    async list(_version: string) {
      computations++;
      await gate;
      return {
        toolkit: "t",
        views: [],
        diagnostics: [],
        digest: "a".repeat(64),
      };
    },
  });
  const reads = Array.from({ length: 8 }, () => service.read(VERSION));
  await Promise.resolve();
  assert.equal(computations, 1);
  release();
  const results = await Promise.all(reads);
  assert.equal(computations, 1);
  for (const result of results) assert.equal(result.toolkit, "t");
  assert.equal((await service.read(VERSION)).toolkit, "t");
  assert.equal(computations, 1);
});

Deno.test("repeated list and diagram reads keep call counts constant", async () => {
  const { calls, inner } = reader();
  const lists = new ModelViewListService(inner);
  const diagrams = new ModelViewDiagramService(inner);
  for (let i = 0; i < 10; i++) await lists.read(VERSION);
  assert.equal(calls.list, 1);
  const view = (await lists.read(VERSION)).views[0].id;
  for (let i = 0; i < 10; i++) await diagrams.read(VERSION, view);
  assert.equal(calls.diagram, 1);
  assert.equal(calls.list, 1);
});

Deno.test("diagram views compute distinctly per view id", async () => {
  const views = [summary("structure:Demo::a"), summary("structure:Demo::b")];
  const { calls, inner } = reader(views);
  const diagrams = new ModelViewDiagramService(inner);
  await diagrams.read(VERSION, views[0].id);
  await diagrams.read(VERSION, views[1].id);
  assert.equal(calls.diagram, 2);
  await diagrams.read(VERSION, views[0].id);
  assert.equal(calls.diagram, 2);
});

Deno.test("a failed view read evicts so the next read retries", async () => {
  let computations = 0;
  const service = new ModelViewListService({
    list(_version) {
      computations++;
      return computations === 1
        ? Promise.reject(new Error("projector"))
        : Promise.resolve(list());
    },
  });
  const first = service.read(VERSION);
  const second = service.read(VERSION);
  await assert.rejects(() => first, /projector/);
  await assert.rejects(() => second, /projector/);
  assert.equal(computations, 1);
  assert.equal((await service.read(VERSION)).views.length, 1);
  assert.equal(computations, 2);
});

Deno.test("the view list cache holds 16 commits and evicts the oldest", async () => {
  let computations = 0;
  const service = new ModelViewListService({
    list(_version) {
      computations++;
      return Promise.resolve(list());
    },
  });
  const versions = Array.from(
    { length: 17 },
    (_, index) => `commit:${index.toString(16).padStart(40, "0")}`,
  );
  for (const version of versions) await service.read(version);
  assert.equal(computations, 17);
  await service.read(versions[16]);
  assert.equal(computations, 17);
  await service.read(versions[0]);
  assert.equal(computations, 18);
});

Deno.test("view services refuse invalid versions before invoking their reader", async () => {
  const lists = new ModelViewListService({
    list() {
      throw new Error("reader must not run");
    },
  });
  await assert.rejects(() => lists.read("branch:main"), {
    code: "INVALID_REQUEST",
  });
  await assert.rejects(() => lists.read("commit:abc"), {
    code: "INVALID_REQUEST",
  });
  const diagrams = new ModelViewDiagramService({
    diagram() {
      throw new Error("reader must not run");
    },
  });
  await assert.rejects(() => diagrams.read("branch:main", "structure:x"), {
    code: "INVALID_REQUEST",
  });
  await assert.rejects(() => diagrams.read(VERSION, ""), {
    code: "INVALID_REQUEST",
  });
});

Deno.test("diagram reads report an unknown view id with a coded error", async () => {
  const { inner } = reader();
  const diagrams = new ModelViewDiagramService(inner);
  await assert.rejects(
    () => diagrams.read(VERSION, "structure:Demo::nope"),
    (error: unknown) => {
      const failure = error as {
        code: string;
        context: unknown;
        recovery: string;
      };
      assert.equal(failure.code, "VIEW_NOT_FOUND");
      assert.deepEqual(failure.context, {
        version: VERSION,
        view: "structure:Demo::nope",
      });
      assert.ok(failure.recovery.length > 0);
      return true;
    },
  );
});

Deno.test("list and diagram caches are independent per commit", async () => {
  const { calls, inner } = reader();
  const lists = new ModelViewListService(inner);
  await lists.read(VERSION);
  await lists.read(OTHER);
  assert.equal(calls.list, 2);
});

Deno.test("PlantUML caches concurrent reads per commit and view, and retries failures", async () => {
  const calls: string[] = [];
  let fail = true;
  const exports = new ModelViewPlantumlService({
    plantuml(version, viewId) {
      calls.push(`${version}/${viewId}`);
      return fail
        ? Promise.reject(new Error("export failed"))
        : Promise.resolve({
          text: "@startuml\n@enduml",
          digest: "a".repeat(64),
        });
    },
  });
  await assert.rejects(() => exports.read("main", "v"), {
    code: "INVALID_REQUEST",
  });
  await assert.rejects(() => exports.read(VERSION, ""), {
    code: "INVALID_REQUEST",
  });
  assert.equal(calls.length, 0);
  const failed = Array.from({ length: 3 }, () => exports.read(VERSION, "v"));
  for (const result of failed) {
    await assert.rejects(() => result, /export failed/);
  }
  assert.equal(calls.length, 1);
  fail = false;
  await Promise.all(
    Array.from({ length: 5 }, () => exports.read(VERSION, "v")),
  );
  await exports.read(VERSION, "v");
  assert.equal(calls.length, 2);
  await exports.read(OTHER, "v");
  await exports.read(VERSION, "other");
  assert.equal(calls.length, 4);
});
