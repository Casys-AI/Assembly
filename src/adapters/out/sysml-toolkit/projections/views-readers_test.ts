import assert from "node:assert/strict";
import type { ModelRepositoryPort } from "../../../../application/model/repository.ts";
import type {
  ModelView,
  ModelViewDiagramDocument,
  ModelViewList,
  ModelViewSummary,
} from "../../../../domain/model/records/diagram-views.ts";
import {
  ToolkitModelViewDiagramReader,
  ToolkitModelViewListReader,
  ToolkitModelViewPlantumlReader,
} from "./views-readers.ts";
import { SysmlToolkitError } from "../adapter.ts";
import { SysmlToolkitTimeoutError } from "../worker-client.ts";

const VERSION = `commit:${"b".repeat(40)}`;
const SOURCES = { "version.sysml": "package Pinned;" };
const SUMMARY: ModelViewSummary = {
  id: "definitions:Pinned",
  title: "Pinned",
  kind: "tree",
  group: "definitions",
  element: "Pinned",
  nodes: 2,
  edges: 0,
};
const LIST: ModelViewList = {
  toolkit: "0.10.10",
  views: [SUMMARY],
  diagnostics: [],
  digest: "0".repeat(64),
};
const VIEW: ModelView = {
  ...SUMMARY,
  diagram: {
    nodes: [
      { id: "n1", kind: "package", name: "Pinned", rows: [] },
      { id: "n2", kind: "part", name: "system", typeName: "System", rows: [] },
    ],
    edges: [],
  },
};

function repository(sources: Record<string, string> = SOURCES) {
  const versions: string[] = [];
  return {
    versions,
    at(version: string) {
      versions.push(version);
      return Promise.resolve({
        version,
        sources,
        elements: [],
        documents: [],
        sourceDigest: "repository digest",
        semanticDigest: "semantic digest",
        provenanceDigest: "provenance digest",
        sourceHashes: {},
        engineVersion: "test",
      });
    },
  };
}

function listsReader(value: ModelViewList = LIST) {
  return { read: (_version: string) => Promise.resolve(value) };
}

Deno.test("views list reader projects only the requested immutable snapshot", async () => {
  const repo = repository();
  const inputs: unknown[] = [];
  const reader = new ToolkitModelViewListReader(repo, {
    views(input) {
      inputs.push(structuredClone(input));
      return Promise.resolve(LIST);
    },
  });
  const value = await reader.list(VERSION);
  assert.equal(value.toolkit, LIST.toolkit);
  assert.deepEqual(value.views, LIST.views);
  assert.deepEqual(value.diagnostics, LIST.diagnostics);
  assert.match(value.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(repo.versions, [VERSION]);
  assert.deepEqual(inputs, [SOURCES]);
});

Deno.test("views list reader maps Toolkit deadlines to bounded versioned errors", async () => {
  for (const started of [false, true]) {
    const reader = new ToolkitModelViewListReader(repository(), {
      views: () => Promise.reject(new SysmlToolkitTimeoutError(1234, started)),
    }, () => 0);
    await assert.rejects(() => reader.list(VERSION), (error: unknown) => {
      const failure = error as {
        code: string;
        context: unknown;
        recovery: string;
      };
      assert.equal(failure.code, "TOOLKIT_TIMEOUT");
      assert.deepEqual(failure.context, {
        version: VERSION,
        timeoutMs: 1234,
        started,
        retryAfterMs: 30000,
      });
      assert.ok(failure.recovery.length > 0);
      return true;
    });
  }
});

Deno.test("diagram reader resolves an unknown view id before opening any session", async () => {
  let projections = 0;
  const reader = new ToolkitModelViewDiagramReader(
    repository(),
    {
      diagram(_sources, _view) {
        projections++;
        return Promise.resolve(VIEW);
      },
    },
    listsReader(),
  );
  await assert.rejects(
    () => reader.diagram(VERSION, "structure:Pinned::nope"),
    (error: unknown) => {
      const failure = error as {
        code: string;
        context: unknown;
        recovery: string;
      };
      assert.equal(failure.code, "VIEW_NOT_FOUND");
      assert.deepEqual(failure.context, {
        version: VERSION,
        view: "structure:Pinned::nope",
      });
      assert.ok(failure.recovery.length > 0);
      return true;
    },
  );
  assert.equal(projections, 0);
});

Deno.test("diagram reader reprojects one view from its cached summary", async () => {
  const repo = repository();
  const inputs: Array<{ sources: unknown; view: ModelViewSummary }> = [];
  const reader = new ToolkitModelViewDiagramReader(
    repo,
    {
      diagram(sources, view) {
        inputs.push({ sources: structuredClone(sources), view });
        return Promise.resolve(VIEW);
      },
    },
    listsReader(),
  );
  const document: ModelViewDiagramDocument = await reader.diagram(
    VERSION,
    SUMMARY.id,
  );
  assert.equal(document.toolkit, LIST.toolkit);
  assert.equal(document.view.id, SUMMARY.id);
  assert.equal(document.view.diagram.nodes[1].name, "system");
  assert.equal(document.view.diagram.nodes[1].typeName, "System");
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].sources, SOURCES);
  assert.deepEqual(inputs[0].view, SUMMARY);
});

Deno.test("diagram reader keeps concurrent views on their own summaries", async () => {
  const other: ModelViewSummary = {
    ...SUMMARY,
    id: "structure:Pinned::system",
    group: "structure",
    kind: "interconnection",
    element: "Pinned::system",
  };
  const seen: string[] = [];
  const reader = new ToolkitModelViewDiagramReader(
    repository(),
    {
      async diagram(_sources, view) {
        seen.push(view.id);
        await Promise.resolve();
        return { ...VIEW, id: view.id, title: view.title };
      },
    },
    listsReader({
      toolkit: "t",
      views: [SUMMARY, other],
      diagnostics: [],
      digest: "0".repeat(64),
    }),
  );
  const [first, second] = await Promise.all([
    reader.diagram(VERSION, SUMMARY.id),
    reader.diagram(VERSION, other.id),
  ]);
  assert.equal(first.view.id, SUMMARY.id);
  assert.equal(second.view.id, other.id);
  assert.deepEqual([...seen].sort(), [SUMMARY.id, other.id].sort());
});

Deno.test("diagram reader translates Toolkit timeouts with the bare version, not the composite key", async () => {
  const reader = new ToolkitModelViewDiagramReader(
    repository(),
    {
      diagram: () => Promise.reject(new SysmlToolkitTimeoutError(1234, true)),
    },
    listsReader(),
    () => 0,
  );
  await assert.rejects(
    () => reader.diagram(VERSION, SUMMARY.id),
    (error: unknown) => {
      const failure = error as {
        code: string;
        context: Record<string, unknown>;
        recovery: string;
      };
      assert.equal(failure.code, "TOOLKIT_TIMEOUT");
      assert.equal(failure.context.version, VERSION);
      assert.equal(failure.context.timeoutMs, 1234);
      assert.equal(failure.context.started, true);
      assert.equal(failure.context.retryAfterMs, 30000);
      assert.ok(failure.recovery.length > 0);
      return true;
    },
  );
  const toolkitFailure = new ToolkitModelViewDiagramReader(
    repository(),
    {
      diagram: () =>
        Promise.reject(new SysmlToolkitError("diagram exploded", [])),
    },
    listsReader(),
    () => 0,
  );
  await assert.rejects(
    () => toolkitFailure.diagram(VERSION, SUMMARY.id),
    (error: unknown) => {
      const failure = error as {
        code: string;
        context: Record<string, unknown>;
      };
      assert.equal(failure.context.version, VERSION);
      assert.ok(String(failure.code).length > 0);
      return true;
    },
  );
});

Deno.test("diagram reader preserves repository and projector failures without fallback", async () => {
  const repositoryFailure = new Error("immutable snapshot missing");
  const projectorFailure = new Error("projection failed");
  let calls = 0;
  const failing: Pick<ModelRepositoryPort, "at"> = {
    at: () => Promise.reject(repositoryFailure),
  };
  const tooling = {
    diagram() {
      calls++;
      return Promise.reject(projectorFailure);
    },
  };
  await assert.rejects(
    () =>
      new ToolkitModelViewDiagramReader(failing, tooling, listsReader())
        .diagram(VERSION, SUMMARY.id),
    (error) => error === repositoryFailure,
  );
  assert.equal(calls, 0);
  await assert.rejects(
    () =>
      new ToolkitModelViewDiagramReader(repository(), tooling, listsReader())
        .diagram(VERSION, SUMMARY.id),
    (error) => error === projectorFailure,
  );
  assert.equal(calls, 1);
});

Deno.test("PlantUML reader rejects unknown views before loading sources and uses the exact commit", async () => {
  const repo = repository();
  const selections: string[] = [];
  const inputs: unknown[] = [];
  const reader = new ToolkitModelViewPlantumlReader(repo, {
    plantuml(sources, view) {
      inputs.push({ sources, view });
      return Promise.resolve("@startuml\nclass Pinned\n@enduml\n");
    },
  }, {
    read(version) {
      selections.push(version);
      return Promise.resolve(LIST);
    },
  });
  await assert.rejects(() => reader.plantuml(VERSION, "unknown"), {
    code: "VIEW_NOT_FOUND",
  });
  assert.deepEqual(repo.versions, []);
  assert.equal(inputs.length, 0);
  const exported = await reader.plantuml(VERSION, SUMMARY.id);
  assert.deepEqual(repo.versions, [VERSION]);
  assert.deepEqual(selections, [VERSION, VERSION]);
  assert.deepEqual(inputs, [{ sources: SOURCES, view: SUMMARY }]);
  assert.match(exported.text, /^@startuml/);
  const bytes = new TextEncoder().encode(exported.text);
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(exported.digest, digest);
});

Deno.test("PlantUML timeout cooldown keeps bare version and retries after expiry", async () => {
  let now = 0;
  let calls = 0;
  const reader = new ToolkitModelViewPlantumlReader(
    repository(),
    {
      plantuml() {
        calls++;
        return Promise.reject(new SysmlToolkitTimeoutError(1234, true));
      },
    },
    listsReader(),
    () => now,
  );
  const failure = (error: unknown) => {
    const value = error as { code: string; context: { version: string } };
    assert.equal(value.code, "TOOLKIT_TIMEOUT");
    assert.equal(value.context.version, VERSION);
    return true;
  };
  await assert.rejects(() => reader.plantuml(VERSION, SUMMARY.id), failure);
  now = 100;
  await assert.rejects(() => reader.plantuml(VERSION, SUMMARY.id), failure);
  assert.equal(calls, 1);
  now = 30001;
  await assert.rejects(() => reader.plantuml(VERSION, SUMMARY.id), failure);
  assert.equal(calls, 2);
});
