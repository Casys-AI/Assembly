import { ExplicitTooling } from "../../../../test/support/explicit-tooling.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  ModelContextOverview,
  ModelContextQuery,
  ModelContextQueryResult,
  ModelGraphQueryResult,
} from "../../../domain/model/consultation/context.ts";
import {
  modelConsultationRefusalEvidence,
  ModelContextAccessError,
  modelContextTools,
} from "../../../domain/model/consultation/context.ts";
import type {
  ModelSourceRevision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import {
  ModelContextInformation,
  type ModelContextInformationOptions,
} from "./context-information.ts";
import {
  DEFAULT_NETWORK_IMPACT_LIMITS,
  NETWORK_IMPACT_RULE_VERSION,
  type NetworkImpactReport,
} from "../../../domain/model/consultation/network-impact.ts";
import {
  NetworkImpactConsultation,
  type NetworkImpactConsultationSummary,
} from "../impact/consultation.ts";

const fileContent = "package Exact {\n" +
  "    // preserved source\n".repeat(160) + "}\n";

function setup(
  options: {
    maximum?: number;
    publications?: boolean;
    requestSource?: ModelSourceRevision["requestSource"];
    maxCallers?: number;
    toolingQuery?: (version: string, expression: string) => Promise<unknown>;
    toolingReferenceSites?:
      ModelContextInformationOptions["toolingReferenceSites"];
    networkImpact?: ModelContextInformationOptions["networkImpact"];
    queryGraph?:
      import("../../work/context/information-ports.ts").ModelConsultationReader[
        "queryGraph"
      ];
  } = {},
) {
  const models = new Map<string, ExecutableModel>();
  const snapshots = new Map<string, SystemRuntimeState>();
  const calls: ModelContextQuery[] = [];
  const overviews: Array<string | undefined> = [];
  const sourceReads: string[] = [];
  let head = "commit:source-one";
  const files = {
    "system.sysml": fileContent,
    "second.sysml": "package Second {}",
  };
  const metadata = Object.entries(files).map(([path, content]) => ({
    path,
    sha256: "hash:" + path,
    characters: content.length,
    byteLength: new TextEncoder().encode(content).length,
  }));
  function addCaller(owner: string) {
    const model = artifactModel(owner);
    model.policy.mayProposeSysmlRevision = true;
    delete model.behaviors;
    delete model.operatorEntries;
    models.set(owner, model);
    const snapshot: SystemRuntimeState = {
      id: "session:" + owner,
      revision: 1,
      catalogRevision: 0,
      model: model.identity,
      executionModel: model,
      messages: [{
        id: "request:" + owner,
        role: "user",
        at: "2026-10-22T00:00:00Z",
        text: "Revise the model.",
      }],
      candidates: [],
      events: [],
      busy: true,
      phase: "active",
      provider: "test",
    };
    snapshots.set(owner, snapshot);
    return model;
  }
  const model = addCaller("owner");
  const reader = {
    ...(options.queryGraph ? { queryGraph: options.queryGraph } : {}),
    overview(version?: string): Promise<ModelContextOverview> {
      overviews.push(version);
      return Promise.resolve({
        version: version ?? head,
        sourceDigest: "source-digest",
        files: structuredClone(metadata),
        roots: {
          items: [{ id: "root", metaclass: "Package", name: "Exact" }],
          total: 1,
          truncated: false,
        },
        limits: {
          maxPageSize: 40,
          maxSourceBytes: 120000,
          maxInspectSourceBytes: 24000,
        },
        coverage: "bounded-discovery-not-exhaustive-impact",
      });
    },
    query(query: ModelContextQuery): Promise<ModelContextQueryResult> {
      calls.push(structuredClone(query));
      if (query.operation === "read_source") {
        const file = metadata.find((file) => file.path === query.path)!;
        return Promise.resolve({
          operation: "read_source",
          version: query.version,
          sourceDigest: "source-digest",
          ...file,
          content: files[query.path as keyof typeof files],
        });
      }
      return Promise.resolve({
        operation: "search",
        version: query.version,
        sourceDigest: "source-digest",
        offset: 0,
        limit: 40,
        total: 1,
        truncated: false,
        items: [{ id: "root", metaclass: "Package", name: "Exact" }],
      });
    },
  };
  const publications: ModelSourceRevision["publishedRevisions"] = {
    limit: 32,
    proposalLimit: 64,
    truncated: false,
    commits: [{
      version: head,
      sourceDigest: "source-digest",
      author: "agent:peer",
      createdAt: "2026-10-22T00:00:00Z",
    }],
  };
  const provider = new ModelContextInformation({
    projectId: "shared-model",
    reader,
    resolveCallerModel(callerId, version) {
      const model = models.get(callerId);
      return Promise.resolve(
        model?.version.digest === version.digest &&
          model.version.repositoryVersion === version.repositoryVersion
          ? structuredClone(model)
          : null,
      );
    },
    snapshotForCaller: (callerId) => snapshots.get(callerId),
    ...(options.publications
      ? {
        readSourceRevision(callerId: string) {
          sourceReads.push(callerId);
          return Promise.resolve({
            version: head,
            sources: files,
            publishedRevisions: publications,
            ...(options.requestSource
              ? { requestSource: options.requestSource }
              : {}),
          });
        },
      }
      : {}),
    maxLoadedCharacters: options.maximum,
    maxCallers: options.maxCallers,
    toolingQuery: options.toolingQuery ?? (() => new ExplicitTooling().query()),
    toolingReferenceSites: options.toolingReferenceSites,
    networkImpact: options.networkImpact,
  });
  function request(input: Record<string, unknown>): Record<string, unknown> {
    return { version: "commit:source-one", ...input };
  }
  const consult = (input: Record<string, unknown>, caller = model) =>
    provider.consultModel(caller, input);
  return {
    model,
    provider,
    request,
    consult,
    reader,
    models,
    snapshots,
    calls,
    overviews,
    sourceReads,
    publications,
    addCaller,
    setHead: (value: string) => {
      head = value;
    },
  };
}

Deno.test("model consultation loads exact files once in the decision working set, not its journal receipt", async () => {
  const f = setup({ publications: true });
  const initial = await f.provider.read(f.model);
  deepStrictEqual(initial.modelSources!.sources, {});
  equal(JSON.stringify(initial).includes(fileContent), false);
  deepStrictEqual(initial.modelSources!.publishedRevisions, f.publications);
  const receipt = await f.consult(
    f.request({ operation: "read_source", path: "system.sysml" }),
  );
  equal(JSON.stringify(receipt).includes("preserved source"), false);
  equal((receipt.result as { loaded: boolean }).loaded, true);
  const next = await f.provider.read(f.model);
  equal(next.modelSources!.sources["system.sysml"], fileContent);
  equal(next.modelContext!.loadedSources![0]!.characters, fileContent.length);
  deepStrictEqual(f.sourceReads, ["owner"]);
  deepStrictEqual(f.overviews, ["commit:source-one"]);
  equal(receipt.modelVersion.repositoryVersion, "commit:shared-source");
  equal(next.modelSources!.version, "commit:source-one");
  next.modelSources!.sources["system.sysml"] = "changed externally";
  equal(
    (await f.provider.read(f.model)).modelSources!.sources["system.sysml"],
    fileContent,
  );
});

Deno.test("network impact is absent without dedicated host capability and refuses source permission alone", async () => {
  const f = setup();
  await f.provider.read(f.model);
  equal(
    f.provider.modelTools(f.model).some((tool) =>
      tool.operation === "network_impact"
    ),
    false,
  );
  await rejects(
    () =>
      f.consult(f.request({
        operation: "network_impact",
        action: "compare",
        operatorId: "owner",
        host: "example.org",
        fromVersion: `commit:${"a".repeat(40)}`,
        toVersion: `commit:${"b".repeat(40)}`,
      })),
    (error: unknown) =>
      error instanceof ModelContextAccessError &&
      error.code === "MODEL_CONTEXT_INPUT",
  );
  equal(f.calls.length, 0);
});

Deno.test("network impact host catalog, strict schema and own-history checks precede analysis", async () => {
  let calls = 0;
  let scopeReads = 0;
  const capability = {
    scope: "own-history" as const,
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    maxPageSize: 3,
    maxResponseCharacters: 12_000,
  };
  const f = setup({
    networkImpact: {
      service: {
        capability,
        consult(binding, query) {
          calls++;
          equal(binding.callerId, "owner");
          equal(binding.evidenceScopeId, "own:owner");
          equal(binding.consultationVersion, "commit:source-one");
          equal(query.version, "commit:source-one");
          return Promise.resolve({ operation: "network_impact" } as never);
        },
      },
      resolveEvidenceScope(callerId) {
        scopeReads++;
        return Promise.resolve({ ownerId: callerId, id: `own:${callerId}` });
      },
    },
  });
  const info = await f.provider.read(f.model);
  deepStrictEqual(info.modelTools, f.provider.modelTools(f.model));
  equal(info.modelTools?.at(-1)?.id, "model.network_impact");
  const query = f.request({
    operation: "network_impact",
    action: "compare",
    operatorId: "owner",
    host: "example.org",
    fromVersion: `commit:${"a".repeat(40)}`,
    toVersion: `commit:${"b".repeat(40)}`,
  });
  for (
    const invalid of [
      { ...query, operatorId: "peer" },
      { ...query, path: "/secret.duckdb" },
      { ...query, limits: { maxVersions: 999 } },
      { ...query, version: "commit:another-pin" },
      { ...query, fromVersion: "branch:main" },
    ]
  ) await rejects(() => f.consult(invalid));
  equal(calls, 0);
  equal(scopeReads, 0);
  await f.consult(query);
  equal(calls, 1);
  equal(scopeReads, 1);
  await rejects(() =>
    f.consult(
      f.request({
        operation: "network_impact",
        action: "details",
        analysisRef: "opaque",
        view: "evidence",
        limit: 4,
      }),
    )
  );
  equal(calls, 1);
});

Deno.test("cached network pages recheck request and admitted contract before dispatch", async () => {
  let calls = 0;
  const f = setup({
    networkImpact: {
      service: {
        capability: {
          scope: "own-history",
          limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
          maxPageSize: 3,
          maxResponseCharacters: 12_000,
        },
        consult() {
          calls++;
          return Promise.resolve({} as never);
        },
      },
      resolveEvidenceScope(callerId) {
        return Promise.resolve({ id: `own:${callerId}`, ownerId: callerId });
      },
    },
  });
  await f.provider.read(f.model);
  const originalMessages = structuredClone(f.snapshots.get("owner")!.messages);
  const page = f.request({
    operation: "network_impact",
    action: "details",
    analysisRef: "opaque",
    view: "evidence",
  });
  f.snapshots.get("owner")!.messages.push({
    id: "new-request",
    role: "user",
    at: "2026-10-26T00:00:00Z",
    text: "New request",
  });
  await rejects(
    () => f.consult(page),
    (error: unknown) =>
      error instanceof ModelContextAccessError &&
      error.code === "MODEL_CONTEXT_STALE_REQUEST",
  );
  equal(calls, 0);
  await rejects(
    () => f.provider.consultModel(f.model, page, originalMessages),
    (error: unknown) =>
      error instanceof ModelContextAccessError &&
      error.code === "MODEL_CONTEXT_STALE_REQUEST",
  );
  equal(calls, 0);
  f.models.get("owner")!.policy.mayProposeSysmlRevision = false;
  await rejects(
    () => f.consult(page),
    (error: unknown) =>
      error instanceof ModelContextAccessError &&
      error.code === "MODEL_CONTEXT_AUTHORITY",
  );
  equal(calls, 0);
});

Deno.test("real network consultation forwards the caller budget including the complete modelVersion receipt", async () => {
  const request = {
    operatorId: "owner",
    host: "example.org",
    fromVersion: `commit:${"a".repeat(40)}`,
    toVersion: `commit:${"b".repeat(40)}`,
  };
  const report: NetworkImpactReport = {
    ruleVersion: NETWORK_IMPACT_RULE_VERSION,
    request,
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    lineage: {
      fromVersion: request.fromVersion,
      toVersion: request.toVersion,
      versions: [],
      complete: true,
    },
    frames: [],
    transitions: [],
    evidence: Array.from({ length: 3 }, (_, index) => ({
      id: `record-${index}`,
      source: "message",
      kind: "context-only",
      operatorId: "owner",
      code: "metadata ".repeat(100),
      startOrder: "unknown",
      issues: [],
      match: "unresolved",
      relatedVersions: [],
      policyAtRecordedVersion: "unknown",
    })),
    evidenceRead: {
      complete: true,
      snapshotsRead: 1,
      recordsRead: 3,
      bytesRead: 4000,
      issues: [],
      sources: [],
    },
    coverage: {
      calculationComplete: true,
      versionsComplete: true,
      modelReadComplete: true,
      recordsReadComplete: true,
      networkObservationComplete: false,
      indirectAccess: "not-covered",
    },
    issues: [],
  };
  const service = new NetworkImpactConsultation({
    analyze: () => Promise.resolve(report),
    limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
    maxResponseCharacters: 16_000,
  });
  const f = setup({
    networkImpact: {
      service,
      resolveEvidenceScope: (ownerId) =>
        Promise.resolve({ id: "own:owner", ownerId }),
    },
  });
  await f.provider.read(f.model);
  const summary = (await f.consult(
    f.request({ operation: "network_impact", action: "compare", ...request }),
  )).result as NetworkImpactConsultationSummary;
  const page = f.request({
    operation: "network_impact",
    action: "details",
    analysisRef: summary.analysisRef,
    view: "evidence",
    limit: 1,
  });
  const single = await f.consult(page);
  const maximum = JSON.stringify(single).length + 300;
  const bounded = await f.provider.consultModel(
    f.model,
    { ...page, limit: 3 },
    undefined,
    { maxResponseCharacters: maximum },
  );
  ok(JSON.stringify(bounded).length <= maximum);
  equal((bounded.result as { items: unknown[] }).items.length, 1);
  deepStrictEqual(
    (bounded.result as { items: unknown[] }).items,
    report.evidence.slice(0, 1),
  );
  await rejects(
    () =>
      f.provider.consultModel(f.model, page, undefined, {
        maxResponseCharacters: maximum - 500,
      }),
    { code: "NETWORK_IMPACT_RESPONSE_LIMIT" },
  );
});

Deno.test("network consultation rechecks authority, request and same-digest live pin after dispatch", async () => {
  for (const changed of ["authority", "request", "pin"] as const) {
    let started!: () => void;
    let finish!: (value: never) => void;
    const dispatched = new Promise<void>((resolve) => started = resolve);
    const pendingResult = new Promise<never>((resolve) => finish = resolve);
    const f = setup({
      networkImpact: {
        service: {
          capability: {
            scope: "own-history",
            limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
            maxPageSize: 3,
            maxResponseCharacters: 12_000,
          },
          consult() {
            started();
            return pendingResult;
          },
        },
        resolveEvidenceScope: (ownerId) =>
          Promise.resolve({ id: "own:owner", ownerId }),
      },
    });
    f.model.policy.mayConsultModel = true;
    await f.provider.read(f.model);
    const pending = f.consult(
      f.request({
        operation: "network_impact",
        action: "compare",
        operatorId: "owner",
        host: "example.org",
        fromVersion: `commit:${"a".repeat(40)}`,
        toVersion: `commit:${"b".repeat(40)}`,
      }),
    );
    await dispatched;
    if (changed === "authority") {
      f.models.get("owner")!.policy.mayConsultModel = false;
      f.models.get("owner")!.policy.mayProposeSysmlRevision = false;
    }
    if (changed === "request") {
      f.snapshots.get("owner")!.messages.push({
        id: "new-request",
        role: "user",
        at: "2026-10-26T00:00:00Z",
        text: "New request",
      });
    }
    if (changed === "pin") {
      const live = structuredClone(f.model);
      live.version.repositoryVersion = "commit:new-pin-same-digest";
      f.snapshots.get("owner")!.executionModel = live;
    }
    finish({} as never);
    await rejects(() => pending, {
      code: changed === "request"
        ? "MODEL_CONTEXT_STALE_REQUEST"
        : "MODEL_CONTEXT_AUTHORITY",
    });
  }
});

Deno.test("network consultation rejects an old binding before dispatch after a same-digest live admission pin change", async () => {
  let dispatches = 0;
  const f = setup({
    networkImpact: {
      service: {
        capability: {
          scope: "own-history",
          limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
          maxPageSize: 3,
          maxResponseCharacters: 12_000,
        },
        consult() {
          dispatches++;
          return Promise.resolve({} as never);
        },
      },
      resolveEvidenceScope: (ownerId) =>
        Promise.resolve({ id: "own:owner", ownerId }),
    },
  });
  await f.provider.read(f.model);
  const live = structuredClone(f.model);
  live.version.repositoryVersion = "commit:new-pin-same-digest";
  f.snapshots.get("owner")!.executionModel = live;
  await rejects(
    () =>
      f.consult(
        f.request({
          operation: "network_impact",
          action: "details",
          analysisRef: "opaque",
          view: "evidence",
        }),
      ),
    { code: "MODEL_CONTEXT_AUTHORITY" },
  );
  equal(dispatches, 0);
});

Deno.test("combined graph and network consultation retain the source pin across newer design views and bind history to the live admission", async () => {
  const bindings: Array<{ admittedVersion: string; requestKey: string }> = [];
  const graphCalls: Array<[string, string, string]> = [];
  const f = setup({
    queryGraph(version, sourceDigest, expression) {
      graphCalls.push([version, sourceDigest, expression]);
      return Promise.resolve<ModelGraphQueryResult>({
        operation: "query",
        mode: "sparql",
        version,
        sourceDigest,
        build: {
          repositoryId: "shared-model",
          sourceDigest,
          recipeDigest: "recipe",
          buildKey: "build",
          artifactDigest: "artifact",
        },
        projection: {
          kind: "rdf",
          projectorVersion: "test",
          artifactDigest: "artifact",
          projectionDigest: "projection",
        },
        limits: { maxResults: 50, maxBytes: 65_536, timeoutMs: 5000 },
        result: { form: "boolean", value: true },
      });
    },
    networkImpact: {
      service: {
        capability: {
          scope: "own-history",
          limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
          maxPageSize: 3,
          maxResponseCharacters: 12_000,
        },
        consult(binding) {
          bindings.push(structuredClone(binding));
          return Promise.resolve({} as never);
        },
      },
      resolveEvidenceScope: (ownerId) =>
        Promise.resolve({ id: "own:owner", ownerId }),
    },
  });
  const initial = await f.provider.read(f.model);
  deepStrictEqual(initial.modelTools, f.provider.modelTools(f.model));
  deepStrictEqual(initial.modelTools?.map((tool) => tool.operation), [
    "search",
    "inspect",
    "references",
    "read_source",
    "unload_sources",
    "query",
    "network_impact",
  ]);
  const graphQuery = f.request({
    operation: "query",
    mode: "sparql",
    expression: "ASK {}",
  });
  const initialGraph = await f.consult(graphQuery);
  const query = f.request({
    operation: "network_impact",
    action: "details",
    analysisRef: "opaque",
    view: "evidence",
  });
  await f.consult(query);
  const newerView = structuredClone(f.model);
  newerView.version.repositoryVersion = "commit:newer-source-view";
  f.models.set("owner", newerView);
  f.setHead("commit:source-two");
  const next = await f.provider.read(newerView);
  equal(next.modelContext!.version, initial.modelContext!.version);
  deepStrictEqual(f.overviews, [undefined]);
  const newerGraph = await f.provider.consultModel(newerView, graphQuery);
  deepStrictEqual(newerGraph.result, initialGraph.result);
  equal(
    newerGraph.modelVersion.repositoryVersion,
    newerView.version.repositoryVersion,
  );
  deepStrictEqual(
    graphCalls,
    Array.from({ length: 2 }, () => [
      "commit:source-one",
      "source-digest",
      "ASK {}",
    ]),
  );
  await rejects(
    () =>
      f.provider.consultModel(newerView, {
        ...graphQuery,
        version: newerView.version.repositoryVersion,
      }),
    { code: "MODEL_CONTEXT_VERSION" },
  );
  equal(graphCalls.length, 2);
  const source = await f.provider.consultModel(newerView, {
    operation: "read_source",
    version: initial.modelContext!.version,
    path: "system.sysml",
  });
  equal(
    source.modelVersion.repositoryVersion,
    newerView.version.repositoryVersion,
  );
  deepStrictEqual(f.calls.at(-1), {
    operation: "read_source",
    version: initial.modelContext!.version,
    path: "system.sysml",
  });
  equal(
    (source.result as { version: string; loaded: boolean }).version,
    initial.modelContext!.version,
  );
  equal((source.result as { loaded: boolean }).loaded, true);
  equal(
    (await f.provider.read(newerView)).modelSources!.sources["system.sysml"],
    fileContent,
  );
  const receipt = await f.provider.consultModel(newerView, query);
  equal(
    receipt.modelVersion.repositoryVersion,
    newerView.version.repositoryVersion,
  );
  equal(bindings[1]!.admittedVersion, f.model.version.repositoryVersion);
  equal(bindings[1]!.requestKey, bindings[0]!.requestKey);
  f.snapshots.get("owner")!.executionModel = structuredClone(newerView);
  await rejects(() => f.provider.consultModel(newerView, query), {
    code: "MODEL_CONTEXT_AUTHORITY",
  });
  equal(bindings.length, 2);
  const repinned = await f.provider.read(newerView);
  equal(repinned.modelContext!.version, "commit:source-two");
});

Deno.test("model tools always include the six native consultation contracts", () => {
  deepStrictEqual(modelContextTools().map((tool) => tool.id), [
    "model.search",
    "model.inspect",
    "model.references",
    "model.read_source",
    "model.unload_sources",
    "model.query",
  ]);
  const enabled = modelContextTools();
  equal(enabled.length, 6);
  const query = enabled.find((tool) => tool.id === "model.query")!;
  deepStrictEqual(query.inputSchema.required, [
    "operation",
    "version",
    "expression",
  ]);
  equal(query.inputSchema.additionalProperties, false);
  equal(modelContextTools().length, 6);
});

Deno.test("model expressions use the exact consultation pin without loading or changing source files", async () => {
  const calls: Array<[string, string]> = [];
  const answer = { elements: [{ id: "exact-element", name: "Exact" }] };
  const f = setup({
    toolingQuery: (version, expression) => {
      calls.push([version, expression]);
      return Promise.resolve(answer);
    },
  });
  await f.provider.read(f.model);
  f.setHead("commit:source-two");
  const receipt = await f.consult(f.request({
    operation: "query",
    expression: "Exact.member",
  }));
  deepStrictEqual(calls, [["commit:source-one", "Exact.member"]]);
  const result = receipt.result as {
    operation: string;
    version: string;
    sourceDigest: string;
    result: typeof answer;
  };
  equal(result.operation, "query");
  equal(result.version, "commit:source-one");
  equal(result.sourceDigest, "source-digest");
  deepStrictEqual(result.result, answer);
  result.result.elements[0]!.name = "caller mutation";
  equal(answer.elements[0]!.name, "Exact");
  deepStrictEqual((await f.provider.read(f.model)).modelSources!.sources, {});
  equal(f.calls.length, 0);
});

Deno.test("model expression consultation refuses unprepared fixtures, stale authority and malformed operations before querying", async () => {
  const unprepared = setup();
  await unprepared.provider.read(unprepared.model);
  await rejects(() =>
    unprepared.consult(unprepared.request({
      operation: "query",
      expression: "Exact.member",
    })), { code: "TEST_TOOLING_READ" });
  let calls = 0;
  const f = setup({
    toolingQuery: () => {
      calls++;
      return Promise.resolve([]);
    },
  });
  await f.provider.read(f.model);
  for (
    const invalid of [
      { operation: "query" },
      { operation: "query", expression: " " },
      { operation: "query", expression: "x".repeat(4097) },
      { operation: "query", expression: "Exact", callerId: "peer" },
      { operation: "query", expression: "Exact", limit: 1 },
      { operation: "execute_query", expression: "Exact" },
    ]
  ) {
    await rejects(() => f.consult(f.request(invalid)), {
      code: "MODEL_CONTEXT_INPUT",
    });
  }
  await rejects(() =>
    f.consult({
      operation: "query",
      version: "commit:source-two",
      expression: "Exact.member",
    }), { code: "MODEL_CONTEXT_VERSION" });
  const stale = structuredClone(f.model);
  stale.version.digest = "stale-authority";
  await rejects(() =>
    f.consult(
      f.request({
        operation: "query",
        expression: "Exact.member",
      }),
      stale,
    ), { code: "MODEL_CONTEXT_AUTHORITY" });
  f.snapshots.get("owner")!.messages.push({
    id: "new-request",
    role: "user",
    text: "Another model request",
    at: "2026-10-22T00:01:00Z",
  });
  await rejects(() =>
    f.consult(f.request({
      operation: "query",
      expression: "Exact.member",
    })), { code: "MODEL_CONTEXT_STALE_REQUEST" });
  equal(calls, 0);
});

Deno.test("model consultation pins a request across head advances and resets on new request or execution digest", async () => {
  const f = setup();
  await f.provider.read(f.model);
  await f.consult(
    f.request({ operation: "read_source", path: "system.sysml" }),
  );
  f.setHead("commit:source-two");
  equal(
    (await f.provider.read(f.model)).modelSources!.version,
    "commit:source-one",
  );
  await rejects(
    () =>
      f.consult(
        f.request({
          operation: "search",
          query: "Exact",
          version: "commit:source-two",
        }),
      ),
    { code: "MODEL_CONTEXT_VERSION" },
  );
  f.snapshots.get("owner")!.messages.push({
    id: "request-two",
    role: "user",
    at: "2026-10-22T00:01:00Z",
    text: "Another change.",
  });
  await rejects(
    () => f.consult(f.request({ operation: "search", query: "Exact" })),
    { code: "MODEL_CONTEXT_STALE_REQUEST" },
  );
  const next = await f.provider.read(f.model);
  equal(next.modelSources!.version, "commit:source-two");
  deepStrictEqual(next.modelSources!.sources, {});
  f.model.version.digest = "new-executable-digest";
  f.setHead("commit:source-three");
  equal(
    (await f.provider.read(f.model)).modelSources!.version,
    "commit:source-three",
  );
  equal(f.overviews.length, 3);
});

Deno.test("model consultation isolates loaded sources between callers and refuses foreign authority before reading", async () => {
  const f = setup();
  const peer = f.addCaller("peer");
  await f.provider.read(f.model);
  await f.provider.read(peer);
  await f.consult(
    f.request({ operation: "read_source", path: "system.sysml" }),
  );
  deepStrictEqual((await f.provider.read(peer)).modelSources!.sources, {});
  const forged = structuredClone(f.model);
  forged.identity.builderId = "peer";
  await rejects(
    () => f.consult(f.request({ operation: "search", query: "Exact" }), forged),
    ModelContextAccessError,
  );
  f.model.identity.projectId = "foreign-model";
  await rejects(() => f.provider.read(f.model), {
    code: "MODEL_CONTEXT_AUTHORITY",
  });
  equal(f.calls.length, 1);
});

Deno.test("standard consultation works on legacy admitted models without a behavior or entry, while revision permission remains required", async () => {
  const f = setup();
  equal(f.model.behaviors, undefined);
  equal(f.model.operatorEntries, undefined);
  const request = f.request({ operation: "search" });
  await rejects(() => f.consult(request), { code: "MODEL_CONTEXT_NOT_PINNED" });
  const digest = f.model.version.digest;
  const identity = structuredClone(f.model.identity);
  await f.provider.read(f.model);
  const result = await f.consult(request);
  equal((result.result as { operation: string }).operation, "search");
  equal(f.model.version.digest, digest);
  deepStrictEqual(f.model.identity, identity);
  f.model.policy.mayProposeSysmlRevision = false;
  equal((await f.provider.read(f.model)).modelContext, undefined);
  await rejects(() => f.consult(request), { code: "MODEL_CONTEXT_AUTHORITY" });
  const forgedPermission = structuredClone(f.model);
  forgedPermission.policy.mayProposeSysmlRevision = true;
  await rejects(() => f.consult(request, forgedPermission), {
    code: "MODEL_CONTEXT_AUTHORITY",
  });
  delete f.model.policy.mayProposeSysmlRevision;
  await rejects(() => f.consult(request), { code: "MODEL_CONTEXT_AUTHORITY" });
  equal(f.calls.length, 1);
});

Deno.test("exact-source working set refuses overflow without eviction and unload is explicit", async () => {
  const f = setup({ maximum: fileContent.length });
  await f.provider.read(f.model);
  await f.consult(
    f.request({ operation: "read_source", path: "system.sysml" }),
  );
  await rejects(
    () =>
      f.consult(
        f.request({ operation: "read_source", path: "second.sysml" }),
      ),
    { code: "MODEL_CONTEXT_WORKING_SET_LIMIT" },
  );
  deepStrictEqual(
    Object.keys((await f.provider.read(f.model)).modelSources!.sources),
    ["system.sysml"],
  );
  await f.consult(
    f.request({ operation: "unload_sources", path: "system.sysml" }),
  );
  await f.consult(
    f.request({ operation: "read_source", path: "second.sysml" }),
  );
  deepStrictEqual(
    Object.keys((await f.provider.read(f.model)).modelSources!.sources),
    ["second.sysml"],
  );
  await f.consult(f.request({ operation: "unload_sources" }));
  deepStrictEqual((await f.provider.read(f.model)).modelSources!.sources, {});
});

Deno.test("model consultation rejects arbitrary operations, unrelated fields and stale authority", async () => {
  const f = setup();
  await f.provider.read(f.model);
  for (
    const input of [
      { operation: "woql", query: "anything" },
      { operation: "search", query: "Exact", path: "system.sysml" },
      { operation: "read_source", path: "system.sysml", limit: 1 },
      { operation: "inspect" },
      { operation: "search", query: "Exact", offset: -1 },
      { operation: "search", query: "Exact", limit: 51 },
      { operation: "search", query: "x".repeat(201) },
      { operation: "inspect", elementId: " " },
      { operation: "unload_sources", path: "" },
      { operation: "unload_sources", query: "anything" },
    ]
  ) {
    await rejects(() => f.consult(f.request(input)), {
      code: "MODEL_CONTEXT_INPUT",
    });
  }
  const forged = f.request({
    operation: "search",
    query: "Exact",
    callerId: "peer",
  });
  await rejects(() => f.consult(forged), { code: "MODEL_CONTEXT_INPUT" });
  const stale = structuredClone(f.model);
  stale.version.digest = "unadmitted";
  await rejects(() => f.consult(f.request({ operation: "search" }), stale), {
    code: "MODEL_CONTEXT_AUTHORITY",
  });
  stale.version.digest = f.model.version.digest;
  stale.version.repositoryVersion = "commit:unadmitted";
  await rejects(() => f.consult(f.request({ operation: "search" }), stale), {
    code: "MODEL_CONTEXT_AUTHORITY",
  });
  equal(f.calls.length, 0);
});

Deno.test("concurrent source loads cannot overrun the per-caller working set", async () => {
  const f = setup({ maximum: fileContent.length });
  await Promise.all([f.provider.read(f.model), f.provider.read(f.model)]);
  equal(f.overviews.length, 1);
  const results = await Promise.allSettled([
    f.consult(f.request({ operation: "read_source", path: "system.sysml" })),
    f.consult(f.request({ operation: "read_source", path: "second.sysml" })),
  ]);
  equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const context = await f.provider.read(f.model);
  equal(Object.keys(context.modelSources!.sources).length, 1);
  equal(
    Object.values(context.modelSources!.sources).reduce(
      (sum, source) => sum + source.length,
      0,
    ) <= fileContent.length,
    true,
  );
});

Deno.test("source working set capacity does not silently evict an existing caller pin", async () => {
  const f = setup({ maxCallers: 1 });
  await f.provider.read(f.model);
  const peer = f.addCaller("peer");
  await rejects(() => f.provider.read(peer), {
    code: "MODEL_CONTEXT_CAPACITY",
  });
  equal(
    (await f.provider.read(f.model)).modelSources!.version,
    "commit:source-one",
  );
  equal(f.overviews.length, 1);
});

Deno.test("SPARQL mode retains the authorized pin, never falls back to Toolkit, and old query results stay unchanged", async () => {
  const calls: unknown[] = [];
  const f = setup({
    toolingQuery: (version, expression) => {
      calls.push(["toolkit", version, expression]);
      return Promise.resolve({ old: true });
    },
    queryGraph: (version, sourceDigest, expression) => {
      calls.push(["sparql", version, sourceDigest, expression]);
      return Promise.reject(
        Object.assign(new Error("deadline"), { code: "INDEX_TIMEOUT" }),
      );
    },
  });
  await f.provider.read(f.model);
  await rejects(
    () =>
      f.consult(
        f.request({ operation: "query", mode: "sparql", expression: "ASK {}" }),
      ),
    { code: "INDEX_TIMEOUT" },
  );
  deepStrictEqual(calls, [[
    "sparql",
    "commit:source-one",
    "source-digest",
    "ASK {}",
  ]]);
  const legacy = await f.consult(
    f.request({ operation: "query", expression: "P" }),
  );
  const explicit = await f.consult(
    f.request({ operation: "query", mode: "toolkit", expression: "P" }),
  );
  deepStrictEqual(legacy, explicit);
  for (
    const malformed of [
      { operation: "query", mode: "sql", expression: "ASK {}" },
      { operation: "inspect", elementId: "x", graph: { direction: "both" } },
      { operation: "inspect", elementId: "x", graph: { limit: 51 } },
      { operation: "references", elementId: "x", graph: { limit: 0 } },
      { operation: "references", elementId: "x", graph: { property: "" } },
      { operation: "references", elementId: "x", graph: { offset: 1 } },
      { operation: "search", graph: {} },
    ]
  ) {
    await rejects(() => f.consult(f.request(malformed)), {
      code: "MODEL_CONTEXT_INPUT",
    });
  }
  const count = calls.length;
  const denied = structuredClone(f.model);
  denied.policy.mayProposeSysmlRevision = false;
  await rejects(
    () =>
      f.consult(
        f.request({ operation: "query", mode: "sparql", expression: "ASK {}" }),
        denied,
      ),
    { code: "MODEL_CONTEXT_AUTHORITY" },
  );
  equal(calls.length, count);
});

Deno.test("a source-only reader cannot report successful graph navigation, but source reads stay available", async () => {
  const f = setup();
  const originalQuery = f.reader.query;
  f.reader.query = (query) =>
    query.operation === "inspect"
      ? Promise.resolve({
        operation: "inspect",
        version: query.version,
        sourceDigest: "source-digest",
        offset: 0,
        limit: 20,
        total: 1,
        truncated: false,
        selected: { id: "root", metaclass: "Package" },
        items: [],
        coverage: "selected-owner-owned-and-direct-relations",
      })
      : originalQuery(query);
  await f.provider.read(f.model);
  await rejects(
    () => f.consult(f.request({ operation: "inspect", elementId: "root" })),
    { code: "INDEX_UNAVAILABLE" },
  );
  await rejects(
    () =>
      f.consult(
        f.request({ operation: "query", mode: "sparql", expression: "ASK {}" }),
      ),
    { code: "INDEX_UNAVAILABLE" },
  );
  const loaded = await f.consult(
    f.request({ operation: "read_source", path: "system.sysml" }),
  );
  equal((loaded.result as { loaded: boolean }).loaded, true);
});

function pendingValue<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => resolve = done);
  return { promise, resolve };
}

function pinnedReadResult(query: ModelContextQuery): ModelContextQueryResult {
  const base = {
    version: query.version,
    sourceDigest: "source-digest",
    offset: 0,
    limit: 20,
    total: 1,
    truncated: false,
  };
  const element = { id: query.elementId ?? "root", metaclass: "Package" };
  if (query.operation === "search") {
    return { ...base, operation: "search", items: [element] };
  }
  const semantic = {
    state: "ready" as const,
    advisory: true as const,
    version: query.version,
    build: {
      repositoryId: "shared-model",
      sourceDigest: "source-digest",
      recipeDigest: "recipe",
      buildKey: "build",
      artifactDigest: "artifact",
    },
    projection: {
      kind: "rdf" as const,
      projectorVersion: "test",
      artifactDigest: "artifact",
      projectionDigest: "projection",
    },
    iri: `urn:test:${element.id}`,
    scope: "user" as const,
    metaclass: "Package",
    readerVersion: "test",
    neighbors: [],
    neighborPage: { limit: 20, complete: true },
    coverage: "bounded-direct-neighbors" as const,
  };
  return query.operation === "inspect"
    ? {
      ...base,
      operation: "inspect",
      selected: element,
      items: [],
      coverage: "selected-owner-owned-and-direct-relations",
      semantic,
    }
    : {
      ...base,
      operation: "references",
      selected: element,
      items: [],
      coverage: "stored-normalized-relations",
      semantic,
    };
}

Deno.test("immutable pinned searches and navigation overlap in the real information adapter and finish independently", async () => {
  const f = setup();
  await f.provider.read(f.model);
  const started: ModelContextQuery[] = [];
  const gates = Array.from(
    { length: 3 },
    () => pendingValue<ModelContextQueryResult>(),
  );
  f.reader.query = (query) => {
    const index = started.length;
    started.push(query);
    return gates[index]!.promise;
  };
  const queries = [
    f.request({ operation: "search", query: "First" }),
    f.request({ operation: "inspect", elementId: "second" }),
    f.request({ operation: "references", elementId: "third" }),
  ];
  const completed: number[] = [];
  const pending = queries.map((query, index) =>
    f.consult(query).then((result) => {
      completed.push(index);
      return result;
    })
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    deepStrictEqual(started.map((query) => query.operation), [
      "search",
      "inspect",
      "references",
    ]);
    gates[2]!.resolve(pinnedReadResult(started[2]!));
    equal(
      ((await pending[2])!.result as { operation: string }).operation,
      "references",
    );
    deepStrictEqual(completed, [2]);
    gates[0]!.resolve(pinnedReadResult(started[0]!));
    gates[1]!.resolve(pinnedReadResult(started[1]!));
    const results = await Promise.all(pending);
    deepStrictEqual(
      results.map((result) =>
        (result.result as { operation: string }).operation
      ),
      ["search", "inspect", "references"],
    );
    deepStrictEqual((await f.provider.read(f.model)).modelSources!.sources, {});
  } finally {
    gates.forEach((gate, index) =>
      gate.resolve(
        pinnedReadResult(queries[index] as unknown as ModelContextQuery),
      )
    );
    await Promise.allSettled(pending);
  }
});

Deno.test("source loading and unloading retain their per-caller order while a reader is pending", async () => {
  const f = setup();
  await f.provider.read(f.model);
  const original = f.reader.query;
  const first = pendingValue<void>();
  const started: string[] = [];
  f.reader.query = async (query) => {
    started.push(query.path!);
    if (query.path === "system.sysml") await first.promise;
    return await original(query);
  };
  const loading = f.consult(
    f.request({ operation: "read_source", path: "system.sysml" }),
  );
  const unloading = f.consult(
    f.request({ operation: "unload_sources", path: "system.sysml" }),
  );
  const next = f.consult(
    f.request({ operation: "read_source", path: "second.sysml" }),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    deepStrictEqual(started, ["system.sysml"]);
    first.resolve();
    await loading;
    deepStrictEqual((await unloading).result, {
      operation: "unload_sources",
      version: "commit:source-one",
      unloadedPaths: ["system.sysml"],
    });
    await next;
    deepStrictEqual(started, ["system.sysml", "second.sysml"]);
    deepStrictEqual((await f.provider.read(f.model)).modelSources!.sources, {
      "second.sysml": "package Second {}",
    });
  } finally {
    first.resolve();
    await Promise.allSettled([loading, unloading, next]);
  }
});

Deno.test("pinned Toolkit and SPARQL queries overlap and finish independently", async () => {
  const first = pendingValue<unknown>();
  const second = pendingValue<ModelGraphQueryResult>();
  const started: string[] = [];
  const f = setup({
    toolingQuery: () => {
      started.push("toolkit");
      return first.promise;
    },
    queryGraph: () => {
      started.push("sparql");
      return second.promise;
    },
  });
  await f.provider.read(f.model);
  const completed: string[] = [];
  const toolkit = f.consult(
    f.request({ operation: "query", expression: "Exact" }),
  ).then((result) => {
    completed.push("toolkit");
    return result;
  });
  const sparql = f.consult(
    f.request({ operation: "query", mode: "sparql", expression: "ASK {}" }),
  ).then((result) => {
    completed.push("sparql");
    return result;
  });
  const graphResult: ModelGraphQueryResult = {
    operation: "query",
    mode: "sparql",
    version: "commit:source-one",
    sourceDigest: "source-digest",
    build: {
      repositoryId: "shared-model",
      sourceDigest: "source-digest",
      recipeDigest: "recipe",
      buildKey: "build",
      artifactDigest: "artifact",
    },
    projection: {
      kind: "rdf",
      projectorVersion: "test",
      artifactDigest: "artifact",
      projectionDigest: "projection",
    },
    limits: { maxResults: 50, maxBytes: 65_536, timeoutMs: 5000 },
    result: { form: "boolean", value: true },
  };
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    deepStrictEqual(started, ["toolkit", "sparql"]);
    second.resolve(graphResult);
    deepStrictEqual((await sparql).result, graphResult);
    deepStrictEqual(completed, ["sparql"]);
    first.resolve({ found: true });
    equal(
      ((await toolkit).result as { result: { found: boolean } }).result.found,
      true,
    );
  } finally {
    first.resolve({ found: true });
    second.resolve(graphResult);
    await Promise.allSettled([toolkit, sparql]);
  }
});

Deno.test("network analysis stays serialized before source loads and unloads", async () => {
  const analysis = pendingValue<never>();
  const started: string[] = [];
  const f = setup({
    networkImpact: {
      service: {
        capability: {
          scope: "own-history",
          limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
          maxPageSize: 3,
          maxResponseCharacters: 12_000,
        },
        consult() {
          started.push("network");
          return analysis.promise;
        },
      },
      resolveEvidenceScope: (ownerId) =>
        Promise.resolve({ id: "own:owner", ownerId }),
    },
  });
  await f.provider.read(f.model);
  const original = f.reader.query;
  f.reader.query = (query) => {
    started.push(query.operation);
    return original(query);
  };
  const network = f.consult(
    f.request({
      operation: "network_impact",
      action: "details",
      analysisRef: "analysis",
      view: "evidence",
    }),
  );
  const source = f.consult(
    f.request({ operation: "read_source", path: "system.sysml" }),
  );
  const unload = f.consult(
    f.request({ operation: "unload_sources", path: "system.sysml" }),
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    deepStrictEqual(started, ["network"]);
    analysis.resolve({} as never);
    await Promise.all([network, source, unload]);
    deepStrictEqual(started, ["network", "read_source"]);
    deepStrictEqual((await f.provider.read(f.model)).modelSources!.sources, {});
  } finally {
    analysis.resolve({} as never);
    await Promise.allSettled([network, source, unload]);
  }
});

Deno.test("immutable read results recheck live authority, request, admission pin and working-set identity", async () => {
  for (
    const changed of ["authority", "request", "pin", "working-set"] as const
  ) {
    const f = setup();
    f.model.policy.mayConsultModel = true;
    await f.provider.read(f.model);
    const started = pendingValue<void>();
    const finish = pendingValue<ModelContextQueryResult>();
    const originalMessages = structuredClone(
      f.snapshots.get("owner")!.messages,
    );
    const query = f.request({ operation: "search", query: "Exact" });
    f.reader.query = () => {
      started.resolve();
      return finish.promise;
    };
    const pending = f.provider.consultModel(f.model, query, originalMessages);
    await started.promise;
    if (changed === "authority") {
      f.models.get("owner")!.policy.mayConsultModel = false;
      f.models.get("owner")!.policy.mayProposeSysmlRevision = false;
    }
    if (changed === "request" || changed === "working-set") {
      f.snapshots.get("owner")!.messages.push({
        id: "new-request",
        role: "user",
        at: "now",
        text: "New request",
      });
    }
    if (changed === "pin") {
      const live = structuredClone(f.model);
      live.version.repositoryVersion = "commit:new-live-pin";
      f.snapshots.get("owner")!.executionModel = live;
    }
    if (changed === "working-set") {
      await f.provider.read(f.model);
      f.snapshots.get("owner")!.messages = originalMessages;
      await f.provider.read(f.model);
    }
    finish.resolve(pinnedReadResult(query as unknown as ModelContextQuery));
    await rejects(() => pending, {
      code: changed === "request" || changed === "working-set"
        ? "MODEL_CONTEXT_STALE_REQUEST"
        : "MODEL_CONTEXT_AUTHORITY",
    });
  }
});

Deno.test("reference-site inspection refuses an absent capability and a different source digest", async () => {
  const missing = setup();
  missing.reader.query = (query) => Promise.resolve(pinnedReadResult(query));
  await missing.provider.read(missing.model);
  const query = missing.request({
    operation: "inspect",
    elementId: "root",
    includeReferenceSites: true,
  });
  await rejects(() => missing.consult(query), {
    code: "REFERENCE_SITES_UNAVAILABLE",
  });
  let requested: unknown;
  const drift = setup({
    toolingReferenceSites(version, elementId) {
      requested = { version, elementId };
      return Promise.resolve({ sourceDigest: "different-source", sites: [] });
    },
  });
  drift.reader.query = (input) => Promise.resolve(pinnedReadResult(input));
  await drift.provider.read(drift.model);
  await rejects(
    () =>
      drift.consult(
        drift.request({
          operation: "inspect",
          elementId: "root",
          includeReferenceSites: true,
        }),
      ),
    { code: "MODEL_CONTEXT_SOURCE" },
  );
  deepStrictEqual(requested, {
    version: "commit:source-one",
    elementId: "root",
  });
  const site = {
    unit: "system.sysml",
    line: 1,
    col: 1,
    endLine: 1,
    endCol: 2,
    kind: "reference",
    ownerId: "owner",
    chainRootId: null,
    preimage: "p",
  };
  const available = setup({
    toolingReferenceSites: () =>
      Promise.resolve({ sourceDigest: "source-digest", sites: [site] }),
  });
  available.reader.query = (input) => Promise.resolve(pinnedReadResult(input));
  await available.provider.read(available.model);
  const result = await available.consult(
    available.request({
      operation: "inspect",
      elementId: "root",
      includeReferenceSites: true,
    }),
  );
  deepStrictEqual(
    (result.result as { referenceSites: unknown }).referenceSites,
    [site],
  );
});

Deno.test("recorded immutable working set restores without a source HEAD read and rejects changed pins or requests", async () => {
  const f = setup();
  const info = await f.provider.read(f.model);
  const messages = structuredClone(f.snapshots.get("owner")!.messages);
  const pin = {
    version: info.modelContext!.version,
    sourceDigest: info.modelContext!.sourceDigest,
    modelContext: info.modelContext!,
    modelSources: info.modelSources!,
  };
  const initialOverviews = f.overviews.length;
  const restored = new ModelContextInformation(f.provider.options);
  await restored.assertModelContextPin(f.model, messages, pin);
  deepStrictEqual(f.overviews.length, initialOverviews);
  const query = f.request({ operation: "search", query: "Exact" });
  await restored.consultModel(f.model, query, messages, { expectedPin: pin });
  await rejects(
    () =>
      restored.assertModelContextPin(f.model, messages, {
        ...pin,
        sourceDigest: "different",
      }),
    { code: "MODEL_CONTEXT_STALE_PIN" },
  );
  const changed = structuredClone(pin);
  changed.modelSources.sources["different.sysml"] = "different source";
  await rejects(
    () => restored.assertModelContextPin(f.model, messages, changed),
    { code: "MODEL_CONTEXT_STALE_PIN" },
  );
  f.snapshots.get("owner")!.messages.push({
    id: "other-request",
    role: "user",
    text: "other",
    at: "now",
  });
  await rejects(() => restored.assertModelContextPin(f.model, messages, pin), {
    code: "MODEL_CONTEXT_STALE_REQUEST",
  });
});

Deno.test("Request design source S remains the edit working set while declared consultation reads exact execution R", async () => {
  const requestSource: NonNullable<ModelSourceRevision["requestSource"]> = {
    kind: "admitted-request-source",
    openingId: "opening",
    executionSpaceId: "space",
    admittedSourceVersion: "commit:source-one",
    sourceAdmissionRevision: 2,
    sourceAdmissionManifestDigest: "f".repeat(64),
    executedSourceVersion: "commit:executed",
  };
  const f = setup({ publications: true, requestSource });
  requestSource.executedSourceVersion = f.model.version.repositoryVersion!;
  const initial = await f.provider.read(f.model);
  equal(initial.modelContext!.version, requestSource.admittedSourceVersion);
  deepStrictEqual(initial.modelSources!.requestSource, requestSource);
  const result = await f.provider.consultAdmittedModelSource(f.model, {
    operation: "read_source",
    version: f.model.version.repositoryVersion!,
    path: "system.sysml",
  });
  equal(
    result.modelVersion.repositoryVersion,
    f.model.version.repositoryVersion,
  );
  equal(
    (result.result as { version: string }).version,
    f.model.version.repositoryVersion,
  );
  const after = await f.provider.read(f.model);
  equal(after.modelContext!.version, requestSource.admittedSourceVersion);
  deepStrictEqual(after.modelSources!.sources, {});
  deepStrictEqual(after.modelSources!.requestSource, requestSource);
});

Deno.test("a declared admitted-source read needs neither on-demand read nor revision rights", async () => {
  const f = setup();
  // A created operator: its flow declares the read, its mandate cannot
  // propose revisions. The snapshot holds the same admitted model.
  f.model.policy.mayProposeSysmlRevision = false;
  f.model.policy.mayConsultModel = false;
  const declared = {
    operation: "read_source",
    version: f.model.version.repositoryVersion!,
    path: "system.sysml",
  };
  const result = await f.provider.consultAdmittedModelSource(
    f.model,
    declared,
  );
  deepStrictEqual(result.modelVersion, {
    digest: f.model.version.digest,
    repositoryVersion: f.model.version.repositoryVersion,
  });
  equal((result.result as { content: string }).content, fileContent);
  // The declared read opens nothing else.
  equal((await f.provider.read(f.model)).modelContext, undefined);
  await rejects(() => f.consult(f.request({ operation: "search" })), {
    code: "MODEL_CONTEXT_AUTHORITY",
  });
  await rejects(
    () =>
      f.provider.consultAdmittedModelSource(f.model, {
        operation: "search",
        version: declared.version,
      }),
    { code: "MODEL_CONTEXT_INPUT" },
  );
  const other = structuredClone(f.model);
  other.version.digest = "other-digest";
  await rejects(
    () => f.provider.consultAdmittedModelSource(other, declared),
    { code: "MODEL_CONTEXT_AUTHORITY" },
  );
  const foreign = structuredClone(f.model);
  foreign.identity.projectId = "foreign-model";
  await rejects(
    () => f.provider.consultAdmittedModelSource(foreign, declared),
    { code: "MODEL_CONTEXT_AUTHORITY" },
  );
});

for (
  const [read, revision, allowed] of [
    [true, true, true],
    [true, false, true],
    [false, false, false],
    [undefined, true, true],
    [undefined, false, false],
  ] as const
) {
  Deno.test(`model consultation read=${read}, revision=${revision} has independent authority`, async () => {
    const f = setup();
    f.model.policy.mayProposeSysmlRevision = revision;
    if (read !== undefined) f.model.policy.mayConsultModel = read;
    else delete f.model.policy.mayConsultModel;
    const digest = f.model.version.digest;
    equal(f.provider.modelTools(f.model).length > 0, allowed);
    const information = await f.provider.read(f.model);
    equal(information.modelContext !== undefined, allowed);
    const request = f.request({ operation: "search", query: "Exact" });
    if (allowed) {
      const result = await f.consult(request);
      equal((result.result as { operation: string }).operation, "search");
      equal(f.calls.length, 1);
    } else {
      await rejects(() => f.consult(request), (error: unknown) => {
        ok(error instanceof ModelContextAccessError);
        equal(error.code, "MODEL_CONTEXT_AUTHORITY");
        deepStrictEqual(error.context, { authority: "model-read" });
        ok(error.recovery?.length);
        return true;
      });
      equal(f.calls.length, 0);
      equal(f.overviews.length, 0);
    }
    equal(f.model.version.digest, digest);
    equal(f.model.policy.mayProposeSysmlRevision, revision);
  });
}

Deno.test("model read access refusal evidence preserves its coded context and recovery", () => {
  const error = new ModelContextAccessError(
    "MODEL_CONTEXT_AUTHORITY",
    "Read authority unavailable",
  );
  deepStrictEqual(modelConsultationRefusalEvidence(error), {
    code: error.code,
    context: { authority: "model-read" },
    recovery: error.recovery,
  });
});

Deno.test("every model context access refusal has context and recovery", () => {
  const refusal = new ModelContextAccessError(
    "MODEL_CONTEXT_INPUT",
    "Malformed query",
  );
  deepStrictEqual(refusal.context, { authority: "model-read" });
  equal(typeof refusal.recovery, "string");
  ok(refusal.recovery.length > 0);
});
