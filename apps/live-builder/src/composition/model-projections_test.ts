import assert from "node:assert/strict";
import { type LogRecord, reset } from "@logtape/logtape";
import {
  createHttpApp,
  type HttpAppDependencies,
} from "../adapters/in/http/app.ts";
import { SysmlToolkitTimeoutError } from "../adapters/out/sysml-toolkit/worker-client.ts";
import type { ModelBoard } from "../domain/model/records/board.ts";
import type { ModelViewList } from "../domain/model/records/diagram-views.ts";
import type { AuthorityMatrix } from "../domain/governance/records/authority-matrix.ts";
import { configureTechnicalLogging } from "../infrastructure/logging.ts";
import { matrixFixture } from "../../test/support/authority-matrix-fixtures.ts";
import { eventually } from "../../test/support/eventually.ts";
import {
  composeModelProjections,
  type ModelProjectionDependencies,
  startModelProjectionPrewarms,
} from "./model-projections.ts";

const VERSION = `commit:${"a".repeat(40)}`;
const SOURCE_DIGEST = "s".repeat(64);

const board: ModelBoard = {
  schema: "ase.board/1",
  meta: {
    model: "test",
    mode: "ase",
    sourceDigest: SOURCE_DIGEST,
    diagnostics: [],
    digest: "b".repeat(64),
  },
  columns: [],
  links: [],
  index: {},
};
const views: ModelViewList = {
  toolkit: "test",
  views: [],
  diagnostics: [],
  digest: "0".repeat(64),
};
const matrix: AuthorityMatrix = matrixFixture(VERSION);

type Kind = "board" | "views" | "authority-matrix";
const KINDS: Array<{ kind: Kind; warning: string; name: string }> = [
  { kind: "board", warning: "Initial model board read failed", name: "board" },
  {
    kind: "views",
    warning: "Initial model views read failed",
    name: "model views",
  },
  {
    kind: "authority-matrix",
    warning: "Initial authority matrix read failed",
    name: "authority matrix",
  },
];

/** The composed projections behind the real HTTP app; only ports are stubbed. */
function composed(options: {
  head?: () => Promise<{ version: string }>;
  /** The error a projector call rejects with, or undefined to serve its value. */
  failure?: (kind: Kind) => unknown;
}) {
  const project = (kind: Kind, value: unknown) => () => {
    const error = options.failure?.(kind);
    return error === undefined
      ? Promise.resolve(structuredClone(value))
      : Promise.reject(error);
  };
  const projections = composeModelProjections({
    repository: {
      current: options.head ?? (() => Promise.resolve({ version: VERSION })),
      at: (version: string) => Promise.resolve({ version, sources: {} }),
      header: (version: string) =>
        Promise.resolve({ version, sources: {}, sourceDigest: SOURCE_DIGEST }),
      descriptorAt: () => Promise.resolve(null),
    } as unknown as ModelProjectionDependencies["repository"],
    project: { id: "projection-composition" },
    projectId: "projection-composition",
    tooling: {
      board: project("board", board),
      views: project("views", views),
      diagram: () => Promise.reject(new Error("unused")),
      plantuml: () => Promise.reject(new Error("unused")),
    } as unknown as ModelProjectionDependencies["tooling"],
    buildStore: undefined,
    toolkitDigest: "fixture-toolkit",
    modelDiagnostics: {
      list: () => Promise.resolve({ diagnostics: [] }),
    } as unknown as ModelProjectionDependencies["modelDiagnostics"],
    authorityMatrixProject: project("authority-matrix", matrix) as never,
  });
  const app = createHttpApp(httpDependencies(projections));
  return { projections, app };
}

function httpDependencies(
  projections: HttpAppDependencies["projections"],
): HttpAppDependencies {
  const none = () => Promise.resolve(null);
  return {
    handleFrontend: none,
    handleModelDiagnostics: none,
    service: { snapshot: { revision: 1, busy: false } as never },
    store: {
      listRevisions: () => Promise.resolve([]),
      loadRevision: none,
      loadProjection: none,
    },
    operatorWorkspace: {
      conversations: { conversations: () => Promise.resolve([]) },
      cases: { cases: [] },
    },
    modelVersionEvents: {
      initial: () => Promise.resolve({}),
      publish: () => Promise.resolve(undefined),
    },
    clients: new Set(),
    handleModelRevisions: none,
    handleControl: none,
    handleConversations: none,
    handleArtifactSources: none,
    handleSpaceSession: none,
    handleRequestSpaceOpenings: none,
    handleCases: none,
    project: null,
    agents: { label: "fixture" },
    projections,
    liveGraph: {
      handleModelGraph: none,
      graphClients: new Set(),
      status: () => ({ version: VERSION, activityDigest: "d", error: null }),
    },
  };
}

const route = (kind: Kind) => `/api/model/${kind}?version=${VERSION}`;

async function withWarnings(run: (warnings: LogRecord[]) => Promise<void>) {
  const warnings: LogRecord[] = [];
  await configureTechnicalLogging({
    level: "warning",
    sink: (record) => {
      warnings.push(record);
    },
  });
  try {
    await run(warnings);
  } finally {
    await reset();
  }
}

const messageOf = (record: LogRecord) => record.message.join("");

function codedFailure(phase: string) {
  return Object.assign(new Error(`${phase} failed`), {
    code: "PREWARM_FAILED",
    context: { phase, version: VERSION },
    recovery: "Retry the exact read after source recovery.",
  });
}

Deno.test("a failed head read is logged by each advisory prewarm and versioned routes still serve", () =>
  withWarnings(async (warnings) => {
    const failure = codedFailure("head");
    const { projections, app } = composed({
      head: () => Promise.reject(failure),
    });
    startModelProjectionPrewarms(projections);
    const expected = [
      "Initial model board read failed",
      "Initial model attention read failed",
      "Initial model views read failed",
      "Initial authority matrix read failed",
    ];
    await eventually(() => warnings.length >= 4 || undefined);
    assert.deepEqual(warnings.map(messageOf).sort(), expected.toSorted());
    for (const warning of warnings) {
      assert.deepEqual(warning.category, ["composition"]);
      assert.deepEqual(warning.properties, {
        code: failure.code,
        context: failure.context,
        recovery: failure.recovery,
        error: failure.message,
        stack: failure.stack,
      });
    }
    for (const { kind } of KINDS) {
      const response = await app.request(route(kind));
      assert.equal(response.status, 200, kind);
      await response.body?.cancel();
    }
    assert.equal((await app.request("/other")).status, 404);
    assert.equal(warnings.length, 4);
  }));

Deno.test("a failed first projection is logged once and not cached: the route read retries", async () => {
  for (const { kind, warning } of KINDS) {
    await withWarnings(async (warnings) => {
      const failure = codedFailure(kind);
      let attempts = 0;
      const { projections, app } = composed({
        failure: (requested) =>
          requested === kind && ++attempts === 1 ? failure : undefined,
      });
      startModelProjectionPrewarms(projections);
      await eventually(() =>
        warnings.some((record) => messageOf(record) === warning) || undefined
      );
      const response = await app.request(route(kind));
      assert.equal(response.status, 200, kind);
      const body = await response.json();
      if (kind === "board") assert.deepEqual(body, board);
      if (kind === "views") assert.deepEqual(body.views, []);
      if (kind === "authority-matrix") {
        assert.equal(body.schema, "ase.authority-matrix/1");
      }
      assert.equal(
        warnings.filter((record) => messageOf(record) === warning).length,
        1,
        kind,
      );
    });
  }
});

Deno.test("a Toolkit timeout becomes a coded 502 with backoff on every projection route", async () => {
  for (const { kind, name } of KINDS) {
    const { app } = composed({
      failure: () => new SysmlToolkitTimeoutError(3000, true),
    });
    const response = await app.request(route(kind));
    assert.equal(response.status, 502, kind);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      code: "TOOLKIT_TIMEOUT",
      context: {
        version: VERSION,
        timeoutMs: 3000,
        started: true,
        retryAfterMs: 30_000,
      },
      recovery:
        `The ${name} exceeded the Toolkit budget. Wait for context.retryAfterMs before retrying; do not retry in a loop.`,
    });
  }
});
