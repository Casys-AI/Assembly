import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import assert from "node:assert/strict";
import { createCasesHandler } from "../../src/adapters/in/http/work/cases.ts";
import { broadcastSse } from "../../src/infrastructure/http/sse.ts";
import { OperatorCases } from "../../src/application/work/cases/operators.ts";
import { OperatorConversations } from "../../src/application/work/operators/conversations.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import type { CasesSnapshot } from "../../src/domain/work/entities/cases.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import {
  openPostgresExecutionFixtureHost,
  openPostgresRuntimeFixture,
} from "../support/postgres-runtime-fixture.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

const forbidden = () => {
  throw new Error("Unexpected side effect");
};
const agents = {
  label: "cases-aggregation",
  decide: () =>
    Promise.resolve({ kind: "reply" as const, text: "Précision ?" }),
  review: forbidden,
};

async function verifyCases(workspace: {
  conversations: OperatorConversations;
  cases: OperatorCases;
  idle(): Promise<void>;
  runtimeFor(id: string): { runtime: SystemRuntime } | undefined;
}) {
  const visible = workspace.conversations.snapshot.conversations;
  const primary = visible.find((entry) => entry.primary && entry.canSend)!;
  const secondary = visible.find((entry) => !entry.primary && entry.canSend)!;
  assert(primary && secondary);
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      clients.add(controller);
    },
  });
  let emitted = 0;
  const unsubscribe = workspace.cases.onChange((snapshot) => {
    emitted++;
    broadcastSse(clients, "cases", snapshot);
  });
  const reader = stream.getReader();
  const handle = createCasesHandler(workspace.cases, "http://127.0.0.1:4311");
  try {
    for (const entry of [primary, secondary]) {
      await workspace.conversations.submitHuman({
        agentId: entry.agentId,
        expectedRevision: entry.revision,
        text: `Objectif de ${entry.agentId}`,
        newConversation: true,
      });
      await workspace.idle();
    }
    const primaryCase = workspace.runtimeFor(primary.agentId)!.runtime.cases
      .cases[0];
    const secondaryCase = workspace.runtimeFor(secondary.agentId)!.runtime.cases
      .cases[0];
    assert.notEqual(primaryCase.id, secondaryCase.id);
    assert.notEqual(primaryCase.number, secondaryCase.number);
    const collection = await handle(
      new Request("http://127.0.0.1:4311/api/cases"),
    );
    assert.equal(collection?.status, 200);
    const snapshot = await collection!.json() as CasesSnapshot;
    assert.equal(snapshot.cases.length, 2);
    assert.deepEqual(
      new Set(snapshot.cases.map((entry) => entry.id)),
      new Set([primaryCase.id, secondaryCase.id]),
    );
    assert.equal(
      snapshot.systemId,
      workspace.runtimeFor(primary.agentId)!.runtime.snapshot.id,
    );
    const path = `http://127.0.0.1:4311/api/cases/${
      encodeURIComponent(secondaryCase.id)
    }`;
    const detail = await handle(new Request(path));
    assert.equal(detail?.status, 200);
    assert.deepEqual((await detail!.json()).case, secondaryCase);
    const closed = await handle(
      new Request(`${path}/close`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:4311",
          origin: "http://127.0.0.1:4311",
          "content-type": "application/json",
        },
        body: JSON.stringify({ outcome: "done" }),
      }),
    );
    assert.equal(closed?.status, 200);
    assert.equal((await closed!.json()).case.status, "closed-done");
    assert.equal(
      workspace.runtimeFor(primary.agentId)!.runtime.cases.cases[0].status,
      "waiting",
    );
    const events: CasesSnapshot[] = [];
    for (let i = 0; i < emitted; i++) {
      const frame = new TextDecoder().decode((await reader.read()).value);
      assert.match(frame, /^event: cases\ndata: /);
      events.push(JSON.parse(frame.split("\ndata: ")[1].trim()));
    }
    assert(
      events.some((event) =>
        event.cases.some((entry) =>
          entry.id === secondaryCase.id && entry.status === "waiting"
        )
      ),
    );
    assert.equal(
      events.at(-1)!.cases.find((entry) => entry.id === secondaryCase.id)!
        .status,
      "closed-done",
    );
    const missing = await handle(
      new Request("http://127.0.0.1:4311/api/cases/missing"),
    );
    assert.equal(missing?.status, 404);
    assert.equal((await missing!.json()).error.code, "NOT_FOUND");
  } finally {
    unsubscribe();
    await reader.cancel();
    reader.releaseLock();
  }
}

Deno.test({
  name:
    "Cases API and SSE include human-opened Cases from every real operator runtime",
  ignore: !postgresTestEnabled,
  async fn() {
    const postgres = await openPostgresExecutionFixtureHost({
      scope: { projectId: "project", systemId: "cases-aggregation" },
    });
    const runtimes = new Map<string, SystemRuntime>();
    const units = [];
    for (const id of ["central", "specialist"]) {
      const model = executableFixture({
        projectId: "project",
        rootId: "root",
        editingContextId: "context",
        systemId: `system-${id}`,
        catalogId: `catalog-${id}`,
        builderId: id,
      });
      model.version.repositoryVersion = "source";
      model.operator = {
        name: id,
        instruction: id,
        humanInput: true,
        primary: id === "central",
      };
      model.workBudgetPolicy = {
        id: `budget-${id}`,
        revision: 1,
        unit: "agent-invocation",
        limit: 2,
        onExhausted: "wait",
        exhaustionRecipient: "local-control",
        elementId: `budget-${id}`,
        sourceIds: [],
      };
      const storage = await postgres.storage.operator(id);
      const runtime = new SystemRuntime({
        ...await postgres.runtimePortsFor(id),
        agents,
        workBudget: new WorkBudgetService(storage.budget),
        model: {
          ...unexpectedModelAuthoring,
          initialize: () => Promise.resolve(model.identity),
          readExecutableModel: () => Promise.resolve(structuredClone(model)),
          applyApprovedChange: forbidden,
          activateCandidate: forbidden,
          graph: () => Promise.resolve({}),
        },
        runner: { test: forbidden, run: forbidden },
      });
      runtimes.set(id, runtime);
      units.push({ systemQualifiedName: `System::${id}`, model });
    }
    for (const runtime of runtimes.values()) await runtime.initialize();
    const primary = runtimes.get("central")!;
    const conversations = new OperatorConversations({
      primary,
      factory: {
        open: (unit) =>
          Promise.resolve(runtimes.get(unit.model.identity.builderId)!),
      },
    });
    for (const runtime of runtimes.values()) {
      runtime.bindOperatorRegistry(conversations);
    }
    await conversations.initialize({ repositoryVersion: "source", units });
    await postgres.start(async (delivery) => {
      const runtime = runtimes.get(delivery.identity.operatorId);
      assert(runtime, "Delivery must resolve its admitted operator");
      await runtime.processAcceptedContribution(delivery);
    });
    try {
      await verifyCases({
        conversations,
        idle: () => postgres.idle(),
        cases: new OperatorCases({
          systemId: () => primary.snapshot.id,
          runtimes: () => [...runtimes.values()],
          onChange: (listener) => conversations.onChange(listener),
        }),
        runtimeFor: (id) => ({ runtime: runtimes.get(id)! }),
      });
      const records = await Promise.all(
        [...runtimes.entries()].map(async ([id, runtime]) => {
          const scopeId = runtime.cases.cases[0].budget?.scopeId;
          assert(scopeId, "The admitted Case must bind its durable budget");
          return await (await postgres.storage.operator(id)).budget.load(
            scopeId,
          );
        }),
      );
      assert.equal(
        records.filter((record) =>
          record?.events.some((event) => event.kind === "reserve")
        ).length,
        2,
      );
    } finally {
      try {
        await postgres.idle();
        await conversations.dispose();
      } finally {
        await postgres.close();
      }
    }
  },
});

Deno.test({
  name:
    "real Toolkit operator workspace exposes secondary Cases through API and SSE",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({ prefix: "ase-operator-cases-" });
    let postgres:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
      | undefined;
    try {
      const sources: Record<string, string> = JSON.parse(
        await Deno.readTextFile(
          new URL(
            "../fixtures/commercial-watch/sources.json",
            import.meta.url,
          ),
        ),
      );
      assert(
        sources["collect.sysml"].includes(
          "humanInputEnabled : Boolean = false",
        ),
      );
      sources["collect.sysml"] = sources["collect.sysml"].replace(
        "humanInputEnabled : Boolean = false",
        "humanInputEnabled : Boolean = true",
      );
      postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        sources,
      });
      const model = postgres.backend.model;
      const budget = new WorkBudgetService(postgres.primary.budget);
      const primary = new SystemRuntime({
        ...postgres.runtimePorts,
        model,
        agents,
        workBudget: budget,
        runner: new DenoToolRunner(),
      });
      await primary.initialize();
      const workspace = await openOperatorWorkspace({
        postgres,
        createSourceModel: postgres.backend.createSourceModel,
        primaryHistory: postgres.primary.state,
        tooling: postgres.backend.tooling,
        primary,
        primaryModel: model,
        repository: postgres.repository,
        agents,
        workBudget: budget,
        directory,
        executors: [],
      });
      await verifyCases({ ...workspace, idle: () => postgres!.idle(primary) });
    } finally {
      await postgres?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
