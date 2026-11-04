import { nativeFrameworkNodeName } from "../../src/application/work/native-execution/framework-node-name.ts";
/** Real PostgreSQL receipt and official-saver witnesses. Models and provider
 * replies are controlled fixtures; this does not qualify Toolkit/source pins. */
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import { fromPrisma } from "pg-boss";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type {
  NativeExecutionActionResult,
  NativeExecutionHandlers,
  NativeExecutionRequest,
  NativeExecutionSnapshot,
} from "../../src/application/work/native-execution/contract.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import {
  type NativeModelAdvanceEvidence,
  runtimeRevisionReference,
} from "../../src/application/work/native-execution/contract.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import {
  compileNativeOperatorGraph,
} from "../../src/adapters/out/native-execution/native-graph.ts";
import {
  postgresExecutionThreadId,
  PostgresNativeExecutionLedger,
} from "../../src/adapters/out/native-execution/postgres-ledger.ts";
import { nativeCatalogAdvanceEvidence } from "../../src/application/work/native-execution/model-advance.ts";
import { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import {
  LEGACY_WAIT_PROTOCOL,
  type NativeWaitEvidence,
  TYPED_WAIT_PROTOCOL,
} from "../../src/application/work/native-execution/wait-evidence.ts";
import {
  checkpointConsumptions,
  type OfficialCheckpoint,
  verifyOfficialWaitCheckpoint,
} from "../../src/adapters/out/native-execution/checkpoint-wait-evidence.ts";
import { ExecutionWaitEvidenceLedger } from "../../src/adapters/out/native-execution/wait-evidence-ledger.ts";
import type { WaitRun } from "../../src/adapters/out/native-execution/wait-evidence-ledger.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import { immutableConsultationFixture } from "../support/immutable-consultation-fixture.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import {
  type PostgresTestDatabase,
  postgresTestEnabled,
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { eventually } from "../support/eventually.ts";

const previousMigration = "20261030030000_release_tags";

function immutablePin(request: NativeExecutionRequest): string {
  return canonical({
    identity: request.model.identity,
    version: request.model.version,
    flowRootId: request.flow.rootNativeId,
    flowOccurrenceId: request.flow.rootOccurrenceId,
    profile: request.flow.executionProfile ?? null,
    maxSteps: request.maxSteps,
  });
}

function historicalRequest(): NativeExecutionRequest {
  const model = executableFixture({
    projectId: "wait-evidence-project",
    editingContextId: "historical-context",
    rootId: "historical-root",
    systemId: "native-wait-system",
    catalogId: "wait-catalog",
    builderId: "wait-operator",
  });
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = `commit:${"b".repeat(40)}`;
  return {
    identity: {
      operatorId: model.identity.builderId,
      invocationKey: "designer:historical-wait",
      purpose: "conversation",
      scope: {
        kind: "designer",
        scopeId: "designer-historical-wait",
        ownerId: model.identity.builderId,
      },
    },
    contribution: { kind: "input", id: "historical-input" },
    model,
    flow: model.flows.conversation,
    maxSteps: 32,
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: model.identity.systemId,
        operatorId: model.identity.builderId,
        revision: 1,
        modelDigest: model.version.digest,
      },
    },
  };
}

async function retainedFixture(
  database: PostgresTestDatabase,
  options: { inspectionSnapshot?: boolean } = {},
) {
  const request = historicalRequest();
  const scope = {
    projectId: request.model.identity.projectId,
    systemId: "wait-evidence-host",
    executionSpaceId: "main",
    operatorId: request.identity.operatorId,
  };
  await seedPostgresRuntime(database.client, scope);
  const threadId = "historical-wait-thread", runId = "historical-wait-run";
  const namespace = "historical-wait-namespace";
  const checkpointSchema = `${database.schema}_wait_checkpoint`;
  const pool = new Pool({
    connectionString: database.connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  database.registerCleanup(async () => {
    await pool.end();
    const admin = new Client({ connectionString: database.connectionString });
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  const saver = new PostgresSaver(pool, undefined, {
    schema: checkpointSchema,
  });
  await saver.setup();
  const node = request.flow.nodes.find((node) =>
    node.mechanism === "await_input"
  )!;
  assert.ok(node);
  const wait: NativeWaitEvidence = {
    version: 1,
    kind: "input",
    nodeId: node.id,
    actionId: node.nativeId,
    preparedNodeId: nativeFrameworkNodeName(node.id, "await-preparation"),
    effectKey: "historical-absent-input-effect",
    resultDigest: await executionDigest({ suspend: true }),
    modelPin: {
      identity: structuredClone(request.model.identity),
      version: structuredClone(request.model.version),
      rootNativeId: request.flow.rootNativeId,
      rootOccurrenceId: request.flow.rootOccurrenceId,
    },
    executionScope: structuredClone(request.identity.scope),
    operatorId: request.identity.operatorId,
    inputs: { input: { text: "  retain exact bytes: é / e\u0301  " } },
  };
  const checkpointId = "1f000000-0000-6000-8000-000000000001";
  const values = {
    prepared: {
      nodeId: wait.nodeId,
      effectKey: wait.effectKey,
      inputs: wait.inputs,
      result: { suspend: true },
      step: 3,
      segmentStep: 2,
    },
    modelPin: wait.modelPin,
    executionScope: wait.executionScope,
    operatorId: wait.operatorId,
    acceptedContributionIds: [request.contribution.id],
    operatorData: {},
    trace: [{
      at: "2026-10-30T23:59:59.000Z",
      text: "retained historical trace",
    }],
    extension: { original: [null, false, "  keep these bytes  "] },
  };
  const versions = Object.fromEntries(
    Object.keys(values).map((key) => [key, 1]),
  );
  const saved = await saver.put(
    {
      configurable: { thread_id: threadId, checkpoint_ns: namespace },
    },
    {
      v: 4,
      id: checkpointId,
      ts: "2026-10-30T23:59:59.000Z",
      channel_values: values,
      channel_versions: versions,
      versions_seen: {},
    } as OfficialCheckpoint,
    { source: "loop", step: 3, parents: {} },
    versions,
  );
  await saver.putWrites(saved, [["__interrupt__", {
    id: "historical-interrupt",
    value: { kind: "native-await-input", nodeId: node.id },
  }]], "historical-task");
  const timestamp = new Date("2026-10-30T23:59:59.000Z");
  const pinJson = immutablePin(request);
  // Seed the inspection shape at creation: accepted snapshots are immutable.
  const inspectionSnapshot: NativeExecutionSnapshot | undefined =
    options.inspectionSnapshot
      ? {
        runId,
        checkpointNamespace: namespace,
        checkpointId,
        contributionId: request.contribution.id,
        identity: request.identity,
        threadId,
        modelDigest: request.model.version.digest,
        repositoryVersion: request.model.version.repositoryVersion,
        flowRootId: request.flow.rootNativeId,
        status: "waiting",
        waits: [{
          nodeId: wait.nodeId,
          mechanism: "await_input",
          kind: "input",
        }],
        unsettledEffects: [],
        pendingContributions: [],
      }
      : undefined;
  await database.client.$transaction(async (tx) => {
    await tx.operatorExecution.create({
      data: {
        ...scope,
        threadId,
        identityJson: canonical(request.identity),
        scopeKind: "designer",
        scopeId: request.identity.scope.scopeId,
        ownerId: request.identity.operatorId,
        purpose: "conversation",
        revision: 1n,
        epoch: 1n,
        status: "waiting",
        checkpointNamespace: namespace,
        currentCheckpointId: checkpointId,
        ...(inspectionSnapshot ? { currentRunId: runId } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    await tx.executionContribution.create({
      data: {
        ...scope,
        threadId,
        contributionId: request.contribution.id,
        digest: "c".repeat(64),
        kind: "input",
        originJson: '{ "original": "  spaced origin bytes  " }',
        payloadJson: '{ "original": "é / e\\u0301" }',
        status: "completed",
        acceptedAt: timestamp,
        completedAt: timestamp,
      },
    });
    await tx.executionRun.create({
      data: {
        ...scope,
        threadId,
        runId,
        generation: 1n,
        contributionId: request.contribution.id,
        pinJson,
        modelReferenceJson: canonical({
          businessRevision: request.businessRevision,
          contribution: request.contribution,
        }),
        status: "waiting",
        checkpointNamespace: namespace,
        checkpointId,
        snapshotJson: inspectionSnapshot
          ? canonical(inspectionSnapshot)
          : '{ "original": "  historical snapshot bytes  " }',
        epoch: 1n,
        jobId: "historical-job",
        retryCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    await tx.executionEffect.create({
      data: {
        ...scope,
        threadId,
        effectKey: "historical-completed-unrelated-effect",
        runId,
        contributionId: request.contribution.id,
        nodeId: "historical-native-action",
        requestDigest: "d".repeat(64),
        status: "completed",
        resultJson: '{ "outputs": { "reply": "  retained effect bytes  " } }',
        epoch: 1n,
        jobId: "historical-job",
        retryCount: 0,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    });
  });
  const ledger = new ExecutionWaitEvidenceLedger(
    (name) => `"${database.schema}"."${name}"`,
    (selectedThread, selectedNamespace, id) =>
      saver.getTuple({
        configurable: {
          thread_id: selectedThread,
          checkpoint_ns: selectedNamespace,
          checkpoint_id: id,
        },
      }),
  );
  const run: WaitRun = {
    runId,
    checkpointNamespace: namespace,
    checkpointId,
    pinJson,
    contributionId: request.contribution.id,
  };
  const bytes = async () => {
    const result: Record<string, unknown> = {};
    for (
      const table of [
        "ExecutionRun",
        "ExecutionContribution",
        "ExecutionEffect",
      ]
    ) {
      result[table] = await database.client.$queryRawUnsafe(
        `SELECT row_to_json(t)::text AS bytes FROM "${database.schema}"."${table}" t ORDER BY row_to_json(t)::text`,
      );
    }
    for (
      const table of ["checkpoints", "checkpoint_blobs", "checkpoint_writes"]
    ) {
      result[table] = await database.client.$queryRawUnsafe(
        `SELECT row_to_json(t)::text AS bytes FROM "${checkpointSchema}"."${table}" t ORDER BY row_to_json(t)::text`,
      );
    }
    return result;
  };
  return {
    request,
    scope,
    threadId,
    runId,
    namespace,
    checkpointId,
    pinJson,
    wait,
    saver,
    pool,
    checkpointSchema,
    ledger,
    run,
    bytes,
  };
}

async function nativeFixture() {
  const fixture = immutableConsultationFixture();
  const { model, state } = fixture;
  // A reduced admitted fixture isolates acceptance: its only effect occurs
  // after a real interrupt accepts a resume, then the flow completes.
  const original = model.flows.conversation;
  const start = structuredClone(
    original.nodes.find((node) => node.kind === "start"),
  );
  const waiting = structuredClone(
    original.nodes.find((node) => node.mechanism === "await_input"),
  );
  assert.ok(start, "the reduced fixture requires an admitted start node");
  assert.equal(start.kind, "start");
  assert.ok(waiting, "the reduced fixture requires an input action");
  assert.equal(waiting.kind, "action");
  const done = {
    id: "typed-wait-terminal",
    nativeId: "typed-wait-terminal",
    name: "done",
    kind: "done" as const,
    inputs: [],
    outputs: [],
    assertions: [],
    source: structuredClone(start.source),
  };
  waiting.inputs = [];
  waiting.outputs = [];
  waiting.assertions = [];
  const flow = {
    ...original,
    executionProfile: undefined,
    startNodeId: start.id,
    nodes: [start, waiting, done],
    edges: [{
      id: "start-to-wait",
      nativeId: "start-to-wait",
      source: start.id,
      target: waiting.id,
      guardIds: [],
      sourceEvidence: start.source,
    }, {
      id: "wait-to-done",
      nativeId: "wait-to-done",
      source: waiting.id,
      target: done.id,
      guardIds: [],
      sourceEvidence: waiting.source,
    }],
    bindings: [],
  };
  model.flows.conversation = flow;
  state.executionModel = structuredClone(model);
  delete state.conversationBatches;
  const request = { ...fixture.request, model, flow };
  const scope = {
    projectId: model.identity.projectId,
    systemId: "typed-wait-native-host",
  };
  const host = await openPostgresDurableRecoveryHost({
    scope,
  });
  let seeded = false, operations = 0;
  const snapshots: NativeExecutionSnapshot[] = [];
  const handlers: NativeExecutionHandlers = {
    assertBoundary: () => Promise.resolve(),
    onEvent: () => Promise.resolve(),
    handle: (node) => {
      assert.equal(node.mechanism, "await_input");
      operations++;
      return Promise.resolve({ outputs: {} });
    },
  };
  const delivery = (resume = false): OperatorExecutionDelivery => ({
    id: resume ? "typed-wait-resume" : request.contribution.id,
    identity: structuredClone(request.identity),
    kind: resume ? "continuation" : "contribution",
    modelPin: {
      modelDigest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion,
    },
  });
  const open = async () => {
    const session = await host.openSession();
    if (!seeded) {
      const storage = await session.storage.operator(model.identity.builderId);
      await storage.state.save(state, null);
      seeded = true;
    }
    const run = async (accepted: OperatorExecutionDelivery) => {
      snapshots.push(
        await session.native.execution.run({
          ...request,
          contribution: {
            id: accepted.id,
            kind: accepted.id === request.contribution.id ? "input" : "resume",
            inputMessageId: request.contribution.inputMessageId,
          },
        }, handlers),
      );
    };
    return { session, run };
  };
  const table = (name: string) => `"${host.database.schema}"."${name}"`;
  return {
    host,
    scope,
    model,
    request,
    open,
    delivery,
    table,
    snapshots,
    operations: () => operations,
  };
}

/** Historical-writer fixture only. The official saver still serializes every
 * byte; this adapter removes solely the two additive R4a proof fields that an
 * old writer could not have emitted. It never participates after migration. */
class HistoricalWaitSaver extends PostgresSaver {
  override put(...args: Parameters<PostgresSaver["put"]>) {
    const checkpoint = structuredClone(args[1]);
    delete checkpoint.channel_values.waitConsumptions;
    delete checkpoint.channel_versions.waitConsumptions;
    for (const versions of Object.values(checkpoint.versions_seen)) {
      delete versions.waitConsumptions;
    }
    const versions = { ...args[3] };
    delete versions.waitConsumptions;
    return super.put(args[0], checkpoint, args[2], versions);
  }
  override putWrites(...args: Parameters<PostgresSaver["putWrites"]>) {
    const writes: typeof args[1] = args[1].filter(([channel]) =>
      channel !== "waitConsumptions"
    ).map(([channel, value]) => {
      const copy = structuredClone(value);
      if (channel === "__interrupt__") {
        const interrupt = copy as { value?: Record<string, unknown> };
        if (interrupt.value) delete interrupt.value.waitEvidence;
      } else if (channel === "__start__" && copy && typeof copy === "object") {
        delete (copy as Record<string, unknown>).waitConsumptions;
      }
      return [channel, copy] as typeof args[1][number];
    });
    return super.putWrites(args[0], writes, args[2], args[3]);
  }
}

async function historicalNativeFixture(
  database: PostgresTestDatabase,
  kind:
    | "input"
    | "decision"
    | "budget"
    | "budget-implicit"
    | "contribution"
    | "publication",
) {
  const fork = kind === "publication";
  const waitKind = fork
    ? "technical-advance"
    : kind === "budget-implicit"
    ? "budget"
    : kind;
  const base = immutableConsultationFixture();
  const { state } = base;
  let model = base.model;
  const original = model.flows.conversation;
  const start = structuredClone(
    original.nodes.find((node) => node.kind === "start"),
  );
  const action = structuredClone(
    original.nodes.find((node) =>
      node.mechanism ===
        (kind === "input" || fork ? "await_input" : "choose_move")
    ),
  );
  assert.ok(start, "the historical fixture requires an admitted start node");
  assert.equal(start.kind, "start");
  assert.ok(action, "the historical fixture requires its admitted action");
  assert.equal(action.kind, "action");
  const done = {
    id: "historical-wait-terminal",
    nativeId: "historical-wait-terminal",
    name: "done",
    kind: "done" as const,
    inputs: [],
    outputs: [],
    assertions: [],
    source: structuredClone(start.source),
  };
  action.inputs = [];
  action.outputs = [];
  action.assertions = [];
  if (fork) {
    action.id = "historical-publication-occurrence";
    action.nativeId = "historical-publication-action";
    action.name = "historicalPublication";
    action.mechanism = "activate_candidate";
    delete action.acceptActionId;
  }
  const flow = {
    ...original,
    executionProfile: undefined,
    startNodeId: start.id,
    nodes: [start, action, done],
    edges: [
      {
        id: "historical-start-action",
        nativeId: "historical-start-action",
        source: start.id,
        target: action.id,
        guardIds: [],
        sourceEvidence: start.source,
      },
      {
        id: "historical-action-done",
        nativeId: "historical-action-done",
        source: action.id,
        target: done.id,
        guardIds: [],
        sourceEvidence: action.source,
      },
    ],
    bindings: [],
  };
  model.flows.conversation = flow;
  // Seed the archive in the business store's JSON value space. Absent optional
  // fields must not remain own undefined properties in the expected model only.
  // No retained bytes exist before this fixture is seeded.
  model = JSON.parse(canonical(model)) as typeof model;
  state.executionModel = structuredClone(model);
  delete state.conversationBatches;
  state.busy = false;
  state.events.push({
    id: "retained-historical-journal",
    kind: "turn-started",
    label: "Retain exact journal: é / e\u0301",
    at: "2026-10-30T23:59:59.000Z",
  });
  const request: NativeExecutionRequest = {
    ...base.request,
    model,
    flow: model.flows.conversation,
    businessRevision: runtimeRevisionReference(state),
  };
  const scope = {
    projectId: model.identity.projectId,
    systemId: "historical-native-upgrade",
    executionSpaceId: "main",
    operatorId: model.identity.builderId,
  };
  await database.client.project.upsert({
    where: { projectId: scope.projectId },
    create: { projectId: scope.projectId },
    update: {},
  });
  await database.client.assemblySystem.upsert({
    where: {
      projectId_systemId: {
        projectId: scope.projectId,
        systemId: scope.systemId,
      },
    },
    create: { projectId: scope.projectId, systemId: scope.systemId },
    update: {},
  });
  await database.client.executionSpace.create({
    data: {
      projectId: scope.projectId,
      systemId: scope.systemId,
      executionSpaceId: scope.executionSpaceId,
      parentExecutionSpaceId: null,
      caseId: null,
    },
  });
  await seedPostgresRuntime(database.client, scope);
  const stateStore = await PostgresSystemStateStore.open(
    database.client,
    scope,
  );
  database.registerCleanup(() => stateStore.close());
  await stateStore.save(state, null);
  const adopted = structuredClone(model);
  const targetState = structuredClone(state);
  let evidence: NativeModelAdvanceEvidence | undefined;
  if (fork) {
    adopted.version.repositoryVersion = `commit:${"c".repeat(40)}`;
    const candidateId = "historical-admitted-candidate",
      candidateDigest = "d".repeat(64);
    const nativeId = "historical-published-reader";
    const contract = model.contracts.find((entry) =>
      entry.kind === "read_web_page"
    )!;
    assert.ok(contract);
    adopted.catalog.push({
      nativeId,
      candidateId,
      digest: candidateDigest,
      contractId: contract.nativeId,
      kind: "read_web_page",
      name: "historical-reader",
      status: "active",
    });
    targetState.revision++;
    targetState.catalogRevision++;
    targetState.executionModel = adopted;
    targetState.candidates.push({
      id: candidateId,
      name: "historical-reader",
      description: "A controlled canonical admission/publication receipt",
      kind: "read_web_page",
      code: "export default ({html})=>({title:'retained',text:html})",
      digest: candidateDigest,
      stage: "active",
      createdAt: "2026-10-30T23:59:59.000Z",
      designerScopeId: request.identity.scope.scopeId,
      baseCatalogRevision: 0,
      binding: { elementId: nativeId, graphPath: "catalog.historicalReader" },
      admission: {
        candidateId,
        candidateDigest,
        authority: "human",
        actorId: model.identity.builderId,
        mandateRevision: model.configuration.builder.mandateRevision,
        configurationRevision: model.configuration.revision,
        reason: "Exact separately recorded admission",
        at: "2026-10-30T23:59:59.001Z",
      },
    });
    targetState.events.push({
      id: "historical-publication-readback",
      kind: "tool-active",
      candidateId,
      elementId: nativeId,
      label: "Exact admitted publication readback",
      at: "2026-10-30T23:59:59.002Z",
    });
    await stateStore.save(targetState, state.revision);
    evidence = await nativeCatalogAdvanceEvidence(model, targetState);
    assert.ok(
      evidence,
      "the same production verifier used by advance accepts the recorded publication",
    );
  }
  const threadId = await postgresExecutionThreadId({
    projectId: scope.projectId,
    systemId: scope.systemId,
    executionSpaceId: scope.executionSpaceId,
  }, request.identity);
  const runId = `legacy-${kind}-source-run`;
  const checkpointSchema = `${database.schema}_checkpoint`;
  const pool = new Pool({
    connectionString: database.connectionString,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });
  database.registerCleanup(async () => {
    await pool.end();
    const admin = new Client({ connectionString: database.connectionString });
    await admin.connect();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${checkpointSchema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  const saver = new HistoricalWaitSaver(pool, undefined, {
    schema: checkpointSchema,
  });
  await saver.setup();
  let preparedEffect: {
    key: string;
    result: NativeExecutionActionResult;
  } | undefined;
  const graph = compileNativeOperatorGraph(
    model,
    (_node, _inputs, _values, invocation) => {
      assert.notEqual(kind, "input");
      if (fork) assert.ok(evidence);
      const result: NativeExecutionActionResult = fork
        ? { modelAdvance: evidence }
        : kind === "budget-implicit"
        ? { suspend: true }
        : {
          suspend: true,
          suspensionKind: kind as "decision" | "budget" | "contribution",
        };
      preparedEffect = { key: invocation.effectKey, result };
      return result;
    },
    {
      effectNamespace: runId,
      scope: request.identity.scope,
      operatorId: request.identity.operatorId,
      flow,
      maxSteps: request.maxSteps,
      checkpointer: saver,
      assertBoundary: () => Promise.resolve(),
      assertTechnicalBoundary: () => Promise.resolve(),
    },
  );
  let config = { configurable: { thread_id: threadId, checkpoint_ns: "" } };
  const initial = {
    ...graph.initialState(),
    acceptedContributionIds: [request.contribution.id],
  };
  delete (initial as Partial<typeof initial>).waitConsumptions;
  for await (
    const saved of await graph.graph.stream(initial, {
      ...config,
      streamMode: "checkpoints",
      durability: "sync",
    })
  ) config = saved.config as typeof config;
  const official = await graph.graph.getState(config);
  const checkpointId = String(official.config.configurable?.checkpoint_id);
  if (kind !== "input") {
    assert.ok(preparedEffect, "the historical handler settled the source wait");
  }
  const sourceTuple = await saver.getTuple({
    configurable: {
      thread_id: threadId,
      checkpoint_ns: "",
      checkpoint_id: checkpointId,
    },
  });
  assert.ok(sourceTuple);
  assert.equal(
    Object.hasOwn(sourceTuple.checkpoint.channel_values, "waitConsumptions"),
    false,
  );
  assert.equal(
    Object.hasOwn(sourceTuple.checkpoint.channel_versions, "waitConsumptions"),
    false,
  );
  const interrupts = (sourceTuple.pendingWrites ?? []).filter(([, channel]) =>
    channel === "__interrupt__"
  );
  assert.equal(interrupts.length, 1);
  assert.equal(
    Object.hasOwn(
      (interrupts[0][2] as { value: object }).value,
      "waitEvidence",
    ),
    false,
  );
  const wake: OperatorExecutionDelivery = {
    id: fork ? "historical-parent-wake" : `historical-native-resume:${kind}`,
    identity: structuredClone(request.identity),
    kind: fork ? "notification" : "continuation",
    modelPin: {
      modelDigest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion,
    },
  };
  const sourceDelivery: OperatorExecutionDelivery = fork
    ? wake
    : { ...wake, id: request.contribution.id, kind: "contribution" };
  const pinJson = immutablePin(request);
  const timestamp = new Date("2026-10-30T23:59:59.000Z");
  const snapshot: NativeExecutionSnapshot | null = fork ? null : {
    runId,
    checkpointNamespace: "",
    checkpointId,
    contributionId: request.contribution.id,
    identity: request.identity,
    threadId,
    modelDigest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
    flowRootId: flow.rootNativeId,
    status: "waiting",
    waits: [{
      nodeId: action.id,
      mechanism: action.mechanism,
      kind: waitKind as "input" | "decision" | "budget" | "contribution",
    }],
    unsettledEffects: [],
    pendingContributions: [],
  };
  await database.client.$transaction(async (tx) => {
    await tx.operatorExecution.create({
      data: {
        ...scope,
        threadId,
        identityJson: canonical(request.identity),
        scopeKind: "designer",
        scopeId: request.identity.scope.scopeId,
        ownerId: request.identity.operatorId,
        purpose: request.identity.purpose,
        subjectId: request.identity.subjectId,
        revision: 1n,
        epoch: 1n,
        currentRunId: runId,
        status: fork ? "failed" : "waiting",
        checkpointNamespace: "",
        currentCheckpointId: checkpointId,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    await tx.executionContribution.create({
      data: {
        ...scope,
        threadId,
        contributionId: request.contribution.id,
        digest: await executionDigest(sourceDelivery),
        requestDigest: await executionDigest({
          identity: request.identity,
          contribution: request.contribution,
          pin: pinJson,
        }),
        kind: "input",
        originJson: canonical({ delivery: sourceDelivery }),
        payloadJson: canonical(sourceDelivery),
        runId,
        status: fork ? "failed" : "completed",
        acceptedAt: timestamp,
        ...(fork ? {} : { completedAt: timestamp }),
      },
    });
    await tx.executionRun.create({
      data: {
        ...scope,
        threadId,
        runId,
        generation: 1n,
        contributionId: request.contribution.id,
        pinJson,
        modelReferenceJson: canonical({
          businessRevision: request.businessRevision,
          contribution: request.contribution,
        }),
        status: fork ? "failed" : "waiting",
        checkpointNamespace: "",
        checkpointId,
        snapshotJson: snapshot ? canonical(snapshot) : null,
        epoch: 1n,
        jobId: "historical-worker-job",
        retryCount: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    await tx.executionThreadBinding.create({
      data: {
        ...scope,
        identityDigest: await executionDigest(request.identity),
        identityJson: canonical(request.identity),
        activeThreadId: threadId,
        revision: 0n,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    });
    const effect = preparedEffect ??
      {
        key: "historical-unrelated-settled-effect",
        result: { outputs: { historical: "  retained result bytes  " } },
      };
    await tx.executionEffect.create({
      data: {
        ...scope,
        threadId,
        effectKey: effect.key,
        runId,
        contributionId: request.contribution.id,
        nodeId: preparedEffect
          ? action.nativeId
          : "historical-unrelated-action",
        requestDigest: preparedEffect
          ? await executionDigest({
            key: effect.key,
            nodeId: action.id,
            nativeId: action.nativeId,
            contribution: request.contribution,
            pin: pinJson,
          })
          : "e".repeat(64),
        status: "completed",
        resultJson: JSON.stringify(effect.result),
        epoch: 1n,
        jobId: "historical-worker-job",
        retryCount: 0,
        startedAt: timestamp,
        completedAt: timestamp,
      },
    });
  });
  const retainedBytes = async () => ({
    run: await database.client.$queryRawUnsafe(
      `SELECT "pinJson","modelReferenceJson","snapshotJson" FROM "${database.schema}"."ExecutionRun" WHERE "runId"=$1`,
      runId,
    ),
    effects: await database.client.$queryRawUnsafe(
      `SELECT row_to_json(t)::text AS bytes FROM "${database.schema}"."ExecutionEffect" t WHERE "runId"=$1 ORDER BY "effectKey"`,
      runId,
    ),
    business: await database.client.$queryRawUnsafe(
      `SELECT row_to_json(t)::text AS bytes FROM "${database.schema}"."RuntimeRevision" t ORDER BY "revision"`,
    ),
    checkpoints: await database.client.$queryRawUnsafe(
      `SELECT row_to_json(t)::text AS bytes FROM "${checkpointSchema}"."checkpoints" t WHERE "thread_id"=$1 AND "checkpoint_ns"='' ORDER BY "checkpoint_id"`,
      threadId,
    ),
    blobs: await database.client.$queryRawUnsafe(
      `SELECT row_to_json(t)::text AS bytes FROM "${checkpointSchema}"."checkpoint_blobs" t WHERE "thread_id"=$1 AND "checkpoint_ns"='' ORDER BY row_to_json(t)::text`,
      threadId,
    ),
    writes: await database.client.$queryRawUnsafe(
      `SELECT row_to_json(t)::text AS bytes FROM "${checkpointSchema}"."checkpoint_writes" t WHERE "thread_id"=$1 AND "checkpoint_ns"='' AND "checkpoint_id"=$2 ORDER BY row_to_json(t)::text`,
      threadId,
      checkpointId,
    ),
  });
  return {
    scope,
    request,
    adopted,
    targetState,
    threadId,
    runId,
    checkpointId,
    wake,
    sourceTuple,
    saver,
    waitKind,
    retainedBytes,
  };
}

for (
  const kind of [
    "input",
    "decision",
    "budget",
    "budget-implicit",
    "contribution",
    "publication",
  ] as const
) {
  const fork = kind === "publication";
  Deno.test({
    name: fork
      ? "R4a upgrade executes a real legacy publication fork without rewriting retained source evidence"
      : `R4a upgrade resumes a real legacy ${kind} wait without rewriting retained source evidence`,
    ignore: !postgresTestEnabled,
    async fn() {
      await withPostgresDatabase(async (database) => {
        const fixture = await historicalNativeFixture(database, kind);
        const before = await fixture.retainedBytes();
        await database.migrateToLatest();
        assert.deepEqual(await fixture.retainedBytes(), before);
        const markers = await database.client.$queryRawUnsafe<
          Array<{ protocol: string }>
        >(
          `SELECT "protocol" FROM "${database.schema}"."ExecutionWaitProtocol" WHERE "runId"=$1`,
          fixture.runId,
        );
        assert.deepEqual(markers, [{ protocol: LEGACY_WAIT_PROTOCOL }]);
        const host = await openPostgresDurableRecoveryHost({
          database,
          scope: {
            projectId: fixture.scope.projectId,
            systemId: fixture.scope.systemId,
          },
        });
        let operations = 0;
        let result: NativeExecutionSnapshot | undefined;
        let workerError: unknown;
        try {
          const session = await host.openSession();
          const storage = await session.storage.operator(
            fixture.scope.operatorId,
          );
          const handlers: NativeExecutionHandlers = {
            assertBoundary: async (node) => {
              const current = await storage.state.load();
              assert.ok(current?.executionModel);
              assert.deepEqual(
                current.executionModel,
                fork ? fixture.adopted : fixture.request.model,
              );
              assert.equal(
                current.executionModel.identity.builderId,
                fixture.request.identity.operatorId,
              );
              assert.equal(
                current.designer?.scopeId,
                fixture.request.identity.scope.scopeId,
              );
              assert.ok(
                current.executionModel.flows.conversation.nodes.some((
                  admitted,
                ) =>
                  admitted.id === node.id && admitted.nativeId === node.nativeId
                ),
              );
            },
            handle: (node, _inputs, _values, execution) => {
              assert.equal(
                fork,
                false,
                "the archived settled publication effect is never reexecuted",
              );
              assert.equal(
                node.mechanism,
                kind === "input" ? "await_input" : "choose_move",
              );
              assert.equal(execution.resumed, true);
              operations++;
              return Promise.resolve({ outputs: {} });
            },
            onEvent: () => Promise.resolve(),
            readAdoptedModel: async () => {
              const current = await storage.state.load();
              assert.ok(current?.executionModel);
              return current.executionModel;
            },
          };
          await session.start(async (accepted) => {
            try {
              assert.deepEqual(accepted, fixture.wake);
              result = await session.native.execution.run(
                fork ? fixture.request : {
                  ...fixture.request,
                  contribution: {
                    id: accepted.id,
                    kind: "resume",
                    inputMessageId: fixture.request.contribution.id,
                  },
                },
                handlers,
              );
            } catch (error) {
              workerError = error;
              throw error;
            }
          });
          await session.native.dispatch.enqueue(fixture.wake);
          await eventually(() =>
            Promise.resolve(result || workerError ? true : undefined)
          );
          if (workerError) throw workerError;
          await session.idle(undefined, 30_000);
          assert.equal(result?.status, "completed");
          assert.equal(operations, fork ? 0 : 1);
          assert.equal(
            result?.repositoryVersion,
            (fork ? fixture.adopted : fixture.request.model).version
              .repositoryVersion,
          );
          const compatibility = await database.client.$queryRawUnsafe<
            Array<{ origin: string; waitJson: string }>
          >(
            `SELECT "origin","waitJson" FROM "${database.schema}"."ExecutionWaitReceipt" WHERE "runId"=$1 AND "checkpointId"=$2`,
            fixture.runId,
            fixture.checkpointId,
          );
          assert.deepEqual(
            compatibility.map(({ origin }) => ({ origin })),
            [{ origin: "legacy-import-v0" }],
          );
          const importedWait = JSON.parse(
            compatibility[0].waitJson,
          ) as NativeWaitEvidence;
          assert.equal(importedWait.kind, fixture.waitKind);
          const modernSaver = new PostgresSaver(
            session.native.ledger.options.checkpointPool,
            undefined,
            { schema: host.schemas.checkpointSchema },
          );
          if (fork) {
            const continuations = await database.client.$queryRawUnsafe<
              Array<
                {
                  status: string;
                  predecessorRunId: string;
                  successorRunId: string;
                  sourceCheckpointId: string;
                  successorCheckpointId: string;
                  successorCheckpointNamespace: string;
                }
              >
            >(
              `SELECT "status","predecessorRunId","successorRunId","sourceCheckpointId","successorCheckpointId","successorCheckpointNamespace" FROM "${database.schema}"."NativeContinuationReceipt" WHERE "predecessorRunId"=$1`,
              fixture.runId,
            );
            assert.equal(continuations.length, 1);
            assert.equal(continuations[0].status, "selected");
            assert.equal(
              continuations[0].sourceCheckpointId,
              fixture.checkpointId,
            );
            assert.equal(continuations[0].successorRunId, result?.runId);
            const target = await modernSaver.getTuple({
              configurable: {
                thread_id: fixture.threadId,
                checkpoint_ns: continuations[0].successorCheckpointNamespace,
                checkpoint_id: continuations[0].successorCheckpointId,
              },
            });
            assert.ok(target);
            const candidate = target.checkpoint.channel_values.waitConsumptions;
            assert.ok(
              !Object.hasOwn(
                target.checkpoint.channel_values,
                "waitConsumptions",
              ) || Array.isArray(candidate) && candidate.length === 0,
              "the official legacy fork retains no consumption candidate: absent or exactly the neutral empty channel",
            );
            assert.equal(
              Object.hasOwn(
                fixture.sourceTuple.checkpoint.channel_values,
                "waitConsumptions",
              ),
              false,
            );
          } else {
            const consumption = await database.client.$queryRawUnsafe<
              Array<
                {
                  kind: string;
                  sourceRunId: string;
                  sourceCheckpointId: string;
                  successorCheckpointNamespace: string;
                  successorCheckpointId: string;
                  consumptionJson: string;
                }
              >
            >(
              `SELECT "kind","sourceRunId","sourceCheckpointId","successorCheckpointNamespace","successorCheckpointId","consumptionJson" FROM "${database.schema}"."ExecutionWaitConsumption" WHERE "contributionId"=$1`,
              fixture.wake.id,
            );
            assert.deepEqual(
              consumption.map((row) => ({
                kind: row.kind,
                sourceRunId: row.sourceRunId,
                sourceCheckpointId: row.sourceCheckpointId,
              })),
              [{
                kind: "wait-v1",
                sourceRunId: fixture.runId,
                sourceCheckpointId: fixture.checkpointId,
              }],
            );
            const proof = JSON.parse(consumption[0].consumptionJson);
            assert.deepEqual(proof, {
              version: 1,
              kind: "wait-v1",
              contributionId: fixture.wake.id,
              sourceCheckpointId: fixture.checkpointId,
              wait: importedWait,
            });
            const successor = await modernSaver.getTuple({
              configurable: {
                thread_id: fixture.threadId,
                checkpoint_ns: consumption[0].successorCheckpointNamespace,
                checkpoint_id: consumption[0].successorCheckpointId,
              },
            });
            assert.ok(successor);
            assert.deepEqual(
              checkpointConsumptions(
                successor.checkpoint,
                successor.checkpoint.channel_versions,
              ),
              [proof],
            );
          }
          const after = await fixture.retainedBytes();
          assert.deepEqual(
            after.run,
            before.run,
            "source pin, model revision reference and snapshot bytes stay exact",
          );
          assert.deepEqual(
            after.effects,
            before.effects,
            "every old settled effect row stays exact",
          );
          assert.deepEqual(
            after.business,
            before.business,
            "accepted model, snapshot and business journal bytes stay exact",
          );
          for (
            const collection of ["checkpoints", "blobs", "writes"] as const
          ) {
            const actual = new Set(
              (after[collection] as unknown[]).map(canonical),
            );
            for (const row of before[collection] as unknown[]) {
              assert.ok(
                actual.has(canonical(row)),
                `every original official ${collection} row retains its bytes`,
              );
            }
          }
          assert.equal(
            (await session.native.dispatch.enqueue(fixture.wake)).status,
            "completed",
          );
          assert.equal(
            operations,
            fork ? 0 : 1,
            "exact delivery replay executes no duplicate effect",
          );
        } finally {
          await host.close();
        }
      }, { throughMigration: previousMigration });
    },
  });
}

Deno.test({
  name:
    "R4a PostgreSQL interrupt receipt and exact successor consumption survive enqueue-only stop/reopen",
  ignore: !postgresTestEnabled,
  async fn() {
    const fixture = await nativeFixture();
    const { host, scope, model, open, delivery, table, operations } = fixture;
    try {
      const first = await open();
      await first.session.start(first.run);
      await first.session.native.dispatch.enqueue(delivery());
      await first.session.idle(undefined, 30_000);
      assert.equal(
        operations(),
        0,
        "input-wait preparation executes no acceptance effect",
      );
      const source = await host.database.client.executionRun.findFirstOrThrow({
        where: {
          ...scope,
          executionSpaceId: "main",
          operatorId: model.identity.builderId,
          status: "waiting",
        },
      });
      const receipts = await host.database.client.$queryRawUnsafe<
        Array<{ waitJson: string; pinJson: string; origin: string }>
      >(
        `SELECT "waitJson","pinJson","origin" FROM ${
          table("ExecutionWaitReceipt")
        } WHERE "runId"=$1 AND "checkpointNamespace"=$2 AND "checkpointId"=$3`,
        source.runId,
        source.checkpointNamespace,
        source.checkpointId,
      );
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].origin, "interrupt-v1");
      assert.equal(receipts[0].pinJson, source.pinJson);
      const sourceWait = JSON.parse(receipts[0].waitJson) as NativeWaitEvidence;
      assert.equal(sourceWait.kind, "input");
      const protocol = await host.database.client.$queryRawUnsafe<
        Array<{ protocol: string }>
      >(
        `SELECT "protocol" FROM ${
          table("ExecutionWaitProtocol")
        } WHERE "runId"=$1`,
        source.runId,
      );
      assert.deepEqual(protocol, [{ protocol: TYPED_WAIT_PROTOCOL }]);
      await first.session.stop();

      const second = await open();
      const resume = delivery(true);
      await second.session.native.dispatch.enqueue(resume);
      const consumptionRows = () =>
        host.database.client.$queryRawUnsafe<
          Array<{
            runId: string;
            kind: string;
            sourceRunId: string;
            sourceCheckpointNamespace: string;
            sourceCheckpointId: string;
            successorCheckpointNamespace: string;
            successorCheckpointId: string;
            consumptionJson: string;
          }>
        >(
          `SELECT * FROM ${
            table("ExecutionWaitConsumption")
          } WHERE "contributionId"=$1`,
          resume.id,
        );
      assert.deepEqual(
        await consumptionRows(),
        [],
        "enqueue acceptance alone cannot consume the source wait",
      );
      assert.equal(operations(), 0);
      await second.session.start(second.run);
      await second.session.idle(undefined, 30_000);
      assert.equal(operations(), 1);
      const consumed = await consumptionRows();
      assert.equal(consumed.length, 1);
      assert.equal(consumed[0].kind, "wait-v1");
      assert.equal(consumed[0].sourceRunId, source.runId);
      assert.equal(
        consumed[0].sourceCheckpointNamespace,
        source.checkpointNamespace,
      );
      assert.equal(consumed[0].sourceCheckpointId, source.checkpointId);
      const proof = JSON.parse(consumed[0].consumptionJson);
      assert.deepEqual(proof.wait, sourceWait);
      assert.equal(proof.sourceCheckpointId, source.checkpointId);
      assert.equal(proof.contributionId, resume.id);
      const consumer = await host.database.client.executionRun.findFirstOrThrow(
        { where: { runId: consumed[0].runId } },
      );
      assert.equal(consumer.contributionId, resume.id);
      const saver = new PostgresSaver(
        second.session.native.ledger.options.checkpointPool,
        undefined,
        { schema: host.schemas.checkpointSchema },
      );
      const successor = await saver.getTuple({
        configurable: {
          thread_id: source.threadId,
          checkpoint_ns: consumed[0].successorCheckpointNamespace,
          checkpoint_id: consumed[0].successorCheckpointId,
        },
      });
      assert.ok(
        successor,
        "the receipt names an official committed successor checkpoint",
      );
      assert.ok(
        checkpointConsumptions(
          successor.checkpoint,
          successor.checkpoint.channel_versions,
        ).some((value) =>
          value.contributionId === resume.id && value.kind === "wait-v1"
        ),
      );
      assert.equal(fixture.snapshots.at(-1)?.status, "completed");
      assert.equal(
        (await second.session.native.dispatch.enqueue(resume)).status,
        "completed",
      );
      assert.equal((await consumptionRows()).length, 1);
      assert.equal(operations(), 1);
    } finally {
      await host.close();
    }
  },
});

for (
  const phase of [
    "before-interrupt-commit",
    "after-interrupt-commit",
    "before-consumption-commit",
    "after-consumption-commit",
  ] as const
) {
  Deno.test({
    name:
      `R4a PostgreSQL session crash ${phase} reopens atomic evidence and retries without duplicate effects`,
    ignore: !postgresTestEnabled,
    async fn() {
      const fixture = await nativeFixture();
      const { host, open, delivery, table, operations } = fixture;
      const boundaryReached = Promise.withResolvers<void>();
      const releaseHook = Promise.withResolvers<void>();
      const abandonedCallback = Promise.withResolvers<unknown>();
      let armed = true;
      let abandonedClaim: ReturnType<
        PostgresNativeExecutionLedger["currentClaim"]
      >;
      let ownedActive: Awaited<ReturnType<typeof open>>["session"] | undefined;
      let ownedRecovered: typeof ownedActive;
      let coordinate: {
        runId: string;
        namespace: string;
        checkpointId: string;
        threadId: string;
        contributionId?: string;
      } | undefined;
      try {
        const active = await open();
        ownedActive = active.session;
        const ledger = active.session.native.ledger;
        const append = ledger.waitEvidence.appendWait.bind(ledger.waitEvidence);
        ledger.waitEvidence.appendWait = async (...args) => {
          await append(...args);
          if (armed && phase.includes("interrupt")) {
            coordinate = {
              threadId: args[2],
              runId: args[3],
              namespace: args[4],
              checkpointId: args[5],
            };
          }
        };
        const consume = ledger.waitEvidence.commitConsumption.bind(
          ledger.waitEvidence,
        );
        ledger.waitEvidence.commitConsumption = async (...args) => {
          await consume(...args);
          if (
            armed && phase.includes("consumption") && args[6].kind === "wait-v1"
          ) {
            coordinate = {
              threadId: args[2],
              runId: args[3],
              namespace: args[4],
              checkpointId: args[5],
              contributionId: args[6].contributionId,
            };
          }
        };
        const initial = delivery(), resume = delivery(true);
        const selected = phase.includes("consumption") ? resume : initial;
        const worker = async (accepted: OperatorExecutionDelivery) => {
          try {
            await active.run(accepted);
          } catch (error) {
            abandonedCallback.resolve(error);
            throw error;
          }
        };
        await active.session.start(worker);
        if (phase.includes("consumption")) {
          await active.session.native.dispatch.enqueue(initial);
          await active.session.idle(undefined, 30_000);
        }
        ledger.options.waitEvidenceFault = async (observed) => {
          if (armed && observed === phase && coordinate) {
            armed = false;
            abandonedClaim = ledger.currentClaim();
            assert.ok(abandonedClaim);
            // Stay inside the exact saver boundary: run() has not reached fail().
            boundaryReached.resolve();
            await releaseHook.promise;
            throw new Error(`controlled-wait-crash:${phase}`);
          }
        };
        await active.session.native.dispatch.enqueue(selected);
        await boundaryReached.promise;
        assert.ok(coordinate);
        assert.ok(abandonedClaim);
        const expected = phase.startsWith("after-") ? 1 : 0;
        const receiptTable = phase.includes("interrupt")
          ? "ExecutionWaitReceipt"
          : "ExecutionWaitConsumption";
        const selectedCoordinate = coordinate;
        const readOutcome = async (reader: PostgresSaver) => {
          const receipt = await host.database.client.$queryRawUnsafe<
            Array<{ count: bigint }>
          >(
            phase.includes("interrupt")
              ? `SELECT count(*) AS count FROM ${
                table(receiptTable)
              } WHERE "runId"=$1 AND "checkpointNamespace"=$2 AND "checkpointId"=$3`
              : `SELECT count(*) AS count FROM ${
                table(receiptTable)
              } WHERE "runId"=$1 AND "successorCheckpointNamespace"=$2 AND "successorCheckpointId"=$3`,
            selectedCoordinate.runId,
            selectedCoordinate.namespace,
            selectedCoordinate.checkpointId,
          );
          assert.equal(Number(receipt[0].count), expected);
          const checkpoint = await reader.getTuple({
            configurable: {
              thread_id: selectedCoordinate.threadId,
              checkpoint_ns: selectedCoordinate.namespace,
              checkpoint_id: selectedCoordinate.checkpointId,
            },
          });
          if (phase.includes("interrupt")) {
            assert.ok(
              checkpoint,
              "the preceding selected prepared checkpoint remains retained",
            );
            assert.equal(
              (checkpoint.pendingWrites ?? []).filter(([, channel]) =>
                channel === "__interrupt__"
              ).length,
              expected,
              "official interrupt write and typed wait have one commit outcome",
            );
          } else {
            assert.equal(
              Boolean(checkpoint),
              Boolean(expected),
              "official successor checkpoint and its consumption receipt have one commit outcome",
            );
          }
        };
        await readOutcome(
          new PostgresSaver(
            ledger.options.checkpointPool,
            undefined,
            { schema: host.schemas.checkpointSchema },
          ),
        );
        const effectsBeforeRetry = operations();
        assert.equal(effectsBeforeRetry, phase.includes("consumption") ? 1 : 0);
        const readEffects = () =>
          host.database.client.$queryRawUnsafe(
            `SELECT row_to_json(t)::text AS bytes FROM ${
              table("ExecutionEffect")
            } t WHERE "threadId"=$1 ORDER BY "effectKey"`,
            selectedCoordinate.threadId,
          );
        const retainedEffects = await readEffects();
        const readRun = () =>
          host.database.client.executionRun.findFirstOrThrow({
            where: { runId: selectedCoordinate.runId },
          });
        const readContribution = () =>
          host.database.client.executionContribution.findFirstOrThrow({
            where: {
              threadId: selectedCoordinate.threadId,
              contributionId: selected.id,
            },
          });
        const abandonedRun = await readRun();
        assert.equal(abandonedRun.status, "running");
        assert.equal((await readContribution()).status, "running");
        assert.equal(abandonedClaim.job.signal?.aborted, false);
        const killStarted = Date.now();
        const killing = active.session.kill();
        if (phase.startsWith("before-")) {
          // The saver transaction holds the queue-row lock needed by kill().
          // Observe the owned queue's blocked shutdown query before rollback;
          // otherwise ordinary handler cleanup could win this race and make
          // the fresh-session recovery witness depend on that cleanup.
          await eventually(async () => {
            const rows = await host.database.client.$queryRawUnsafe<
              Array<{ waiting: boolean }>
            >(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND position($1 in query)>0) AS waiting`,
              host.schemas.queueSchema,
            );
            return rows[0]?.waiting ? true : undefined;
          });
          releaseHook.resolve();
        }
        await killing;
        assert.ok(
          Date.now() - killStarted < 10_000,
          "session kill aborts its claim without draining the parked hook",
        );
        assert.equal(abandonedClaim.job.signal?.aborted, true);
        await assert.rejects(
          () =>
            ledger.client.$transaction((tx) =>
              ledger.lockClaim(fromPrisma(tx).executeSql, abandonedClaim!.job)
            ),
          /abort|STALE_EXECUTION_/i,
        );
        assert.equal(
          (await readRun()).status,
          "running",
          "the abandoned run was not cleaned up before fresh recovery",
        );
        assert.equal(
          (await readContribution()).status,
          "running",
          "the abandoned delivery was not cleaned up before fresh recovery",
        );
        const recovered = await open();
        ownedRecovered = recovered.session;
        const recoveredLedger = recovered.session.native.ledger;
        assert.notEqual(recoveredLedger, ledger);
        assert.notEqual(
          recoveredLedger.options.checkpointPool,
          ledger.options.checkpointPool,
        );
        const recoveredSaver = new PostgresSaver(
          recoveredLedger.options.checkpointPool,
          undefined,
          { schema: host.schemas.checkpointSchema },
        );
        await readOutcome(recoveredSaver);
        assert.deepEqual(await readEffects(), retainedEffects);
        assert.equal(
          await host.database.client.$transaction((tx) =>
            recoveredLedger.waitEvidence.protocol(
              fromPrisma(tx).executeSql,
              recoveredLedger.scope(selected.identity),
              selectedCoordinate.threadId,
              selectedCoordinate.runId,
            )
          ),
          TYPED_WAIT_PROTOCOL,
        );
        await recovered.session.start(recovered.run);
        // After-COMMIT hooks stay parked through kill and fresh start. Before-
        // COMMIT hooks were released only to roll back their locked transaction.
        releaseHook.resolve();
        const refused = await abandonedCallback.promise;
        // fail() preserves the original hook error when its fenced cleanup is
        // refused. A cancellation may instead win in the graph runner. The
        // separate lockClaim rejection above proves the dead claim cannot write.
        assert.match(
          String(refused),
          new RegExp(
            `controlled-wait-crash:${phase}|abort|STALE_EXECUTION_`,
            "i",
          ),
        );
        await eventually(async () =>
          (await recovered.session.native.dispatch.inspect(
              selected.identity,
              selected.id,
            ))?.status === "completed"
            ? true
            : undefined
        );
        assert.equal(
          operations(),
          effectsBeforeRetry,
          "retry cannot duplicate the acceptance effect",
        );
        const recoveredRun = await host.database.client.executionRun
          .findFirstOrThrow({ where: { runId: selectedCoordinate.runId } });
        assert.equal(recoveredRun.jobId, abandonedRun.jobId);
        assert.ok(recoveredRun.retryCount > abandonedRun.retryCount);
        assert.ok(recoveredRun.epoch > abandonedRun.epoch);
        assert.equal(recoveredRun.pinJson, abandonedRun.pinJson);
        assert.deepEqual(await readEffects(), retainedEffects);
        const inspected = await recoveredLedger.inspect(
          selected.identity.operatorId,
          {
            threadId: selectedCoordinate.threadId,
            contributionId: selected.id,
          },
        );
        assert.equal(inspected.length, 1);
        assert.equal(
          inspected[0].status,
          phase.includes("consumption") ? "completed" : "waiting",
        );
        const proofs = await host.database.client.$queryRawUnsafe<
          Array<{
            checkpointNamespace: string;
            checkpointId: string;
            successorCheckpointNamespace: string;
            successorCheckpointId: string;
            consumptionJson: string;
          }>
        >(
          `SELECT * FROM ${table(receiptTable)} WHERE "runId"=$1`,
          selectedCoordinate.runId,
        );
        assert.equal(proofs.length, 1);
        const finalCheckpoint = await recoveredSaver.getTuple({
          configurable: {
            thread_id: selectedCoordinate.threadId,
            checkpoint_ns: phase.includes("interrupt")
              ? proofs[0].checkpointNamespace
              : proofs[0].successorCheckpointNamespace,
            checkpoint_id: phase.includes("interrupt")
              ? proofs[0].checkpointId
              : proofs[0].successorCheckpointId,
          },
        });
        assert.ok(finalCheckpoint);
        if (phase.includes("consumption")) {
          assert.ok(
            checkpointConsumptions(
              finalCheckpoint.checkpoint,
              finalCheckpoint.checkpoint.channel_versions,
            ).some((proof) => canonical(proof) === proofs[0].consumptionJson),
          );
        } else {
          assert.equal(
            (finalCheckpoint.pendingWrites ?? []).filter(([, channel]) =>
              channel === "__interrupt__"
            ).length,
            1,
          );
        }
        assert.deepEqual(await readEffects(), retainedEffects);
      } finally {
        releaseHook.resolve();
        try {
          await ownedRecovered?.close({ retainDatabase: true });
        } finally {
          try {
            await ownedActive?.close({ retainDatabase: true });
          } finally {
            await host.close();
          }
        }
      }
    },
  });
}

Deno.test({
  name:
    "R4a PostgreSQL inspect refuses a modern wait without original contribution consumption despite accepted checkpoint input",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const fixture = await retainedFixture(database, {
        inspectionSnapshot: true,
      });
      const { scope, threadId, runId, namespace, checkpointId, request, wait } =
        fixture;
      const ledger = new PostgresNativeExecutionLedger({
        client: database.client,
        scope,
        queueName: "wait-evidence-inspection",
        queueSchema: database.schema,
        checkpointPool: fixture.pool,
        checkpointSchema: fixture.checkpointSchema,
      });
      await database.client.$transaction(async (tx) => {
        const query = fromPrisma(tx).executeSql;
        await ledger.waitEvidence.initialize(query, scope, threadId, runId);
        await ledger.waitEvidence.appendWait(
          query,
          scope,
          threadId,
          runId,
          namespace,
          checkpointId,
          fixture.pinJson,
          wait,
          "interrupt-v1",
        );
        assert.equal(
          await ledger.waitEvidence.protocol(query, scope, threadId, runId),
          TYPED_WAIT_PROTOCOL,
        );
        assert.deepEqual(
          await ledger.waitEvidence.read(
            query,
            scope,
            threadId,
            fixture.run,
            request,
          ),
          wait,
        );
      });
      const official = await fixture.saver.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: namespace,
          checkpoint_id: checkpointId,
        },
      });
      assert.ok(official);
      assert.deepEqual(
        official.checkpoint.channel_values.acceptedContributionIds,
        [request.contribution.id],
      );
      await verifyOfficialWaitCheckpoint(official, wait);
      const consumptionCount = () =>
        database.client.executionWaitConsumption.count({
          where: { ...scope, threadId },
        });
      assert.equal(await consumptionCount(), 0);
      const before = await fixture.bytes();
      await assert.rejects(
        () =>
          ledger.inspect(scope.operatorId, {
            threadId,
            contributionId: request.contribution.id,
          }),
        /NATIVE_WAIT_MODERN_CONSUMPTION_PROOF_MISSING/,
      );
      assert.equal(await consumptionCount(), 0);
      assert.deepEqual(
        await fixture.bytes(),
        before,
        "inspection cannot import consumption from modern acceptedContributionIds",
      );
    });
  },
});

Deno.test({
  name:
    "R4a PostgreSQL receipt replay is exact, immutable, and missing modern proof cannot import legacy state",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const fixture = await retainedFixture(database);
      const {
        ledger,
        scope,
        threadId,
        runId,
        namespace,
        checkpointId,
        pinJson,
        wait,
        request,
        run,
      } = fixture;
      const transaction = <T>(
        operation: (
          query: ReturnType<typeof fromPrisma>["executeSql"],
        ) => Promise<T>,
      ) =>
        database.client.$transaction((tx) =>
          operation(fromPrisma(tx).executeSql)
        );
      await transaction((query) =>
        ledger.initialize(query, scope, threadId, runId)
      );
      let legacyReads = 0;
      const modernOnly = new ExecutionWaitEvidenceLedger(
        (name) => `"${database.schema}"."${name}"`,
        () => {
          legacyReads++;
          throw new Error("A modern run cannot select the legacy decoder");
        },
      );
      await assert.rejects(
        () =>
          transaction((query) =>
            modernOnly.read(query, scope, threadId, run, request)
          ),
        /NATIVE_WAIT_MODERN_PROOF_MISSING_OR_MISMATCHED/,
      );
      assert.equal(
        legacyReads,
        0,
        "missing modern proof never opens the historical checkpoint boundary",
      );
      const append = (evidence: NativeWaitEvidence = wait) =>
        transaction((query) =>
          ledger.appendWait(
            query,
            scope,
            threadId,
            runId,
            namespace,
            checkpointId,
            pinJson,
            evidence,
            "interrupt-v1",
          )
        );
      await append();
      const before = await fixture.bytes();
      await append();
      assert.deepEqual(await fixture.bytes(), before);
      await assert.rejects(
        () =>
          transaction((query) =>
            ledger.appendWait(
              query,
              scope,
              threadId,
              runId,
              namespace,
              checkpointId,
              pinJson,
              wait,
              "fork-v1",
            )
          ),
        /NATIVE_WAIT_RECEIPT_CONFLICT/,
      );
      await assert.rejects(
        () => append({ ...wait, effectKey: "conflicting-effect" }),
        /NATIVE_WAIT_RECEIPT_CONFLICT/,
      );
      await assert.rejects(
        () =>
          transaction((query) =>
            ledger.appendWait(
              query,
              scope,
              threadId,
              runId,
              namespace,
              checkpointId,
              canonical({
                ...JSON.parse(pinJson),
                maxSteps: request.maxSteps + 1,
              }),
              wait,
              "interrupt-v1",
            )
          ),
        /NATIVE_WAIT_RECEIPT_CONFLICT/,
      );
      assert.deepEqual(
        await transaction((query) =>
          ledger.read(query, scope, threadId, run, request)
        ),
        wait,
      );
      const proof = {
        version: 1 as const,
        kind: "wait-v1" as const,
        contributionId: request.contribution.id,
        sourceCheckpointId: checkpointId,
        wait,
      };
      const successorId = "1f000000-0000-6000-8000-000000000002";
      const consume = () =>
        transaction((query) =>
          ledger.commitConsumption(
            query,
            scope,
            threadId,
            runId,
            namespace,
            successorId,
            proof,
          )
        );
      await consume();
      await consume();
      await assert.rejects(
        () =>
          transaction((query) =>
            ledger.commitConsumption(
              query,
              scope,
              threadId,
              runId,
              namespace,
              "conflicting-successor",
              proof,
            )
          ),
        /NATIVE_WAIT_CONSUMPTION_CONFLICT/,
      );
      for (
        const table of [
          "ExecutionWaitProtocol",
          "ExecutionWaitReceipt",
          "ExecutionWaitConsumption",
        ]
      ) {
        await assert.rejects(
          () =>
            database.client.$executeRawUnsafe(
              `UPDATE "${database.schema}"."${table}" SET "createdAt"="createdAt" WHERE "runId"=$1`,
              runId,
            ),
          /execution wait evidence is immutable/,
        );
      }
      const rows = await database.client.$queryRawUnsafe<
        Array<{ count: bigint }>
      >(`SELECT count(*) AS count FROM "${database.schema}"."ExecutionWaitConsumption"`);
      assert.equal(rows[0].count, 1n);
      assert.deepEqual(
        await fixture.bytes(),
        before,
        "new companion proof never rewrites retained business or checkpoint bytes",
      );
    });
  },
});

Deno.test({
  name:
    "R4a additive upgrade preserves old execution checkpoint and effect bytes and imports only explicit legacy proof",
  ignore: !postgresTestEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const fixture = await retainedFixture(database);
      const before = await fixture.bytes();
      await database.migrateToLatest();
      assert.deepEqual(await fixture.bytes(), before);
      const protocol = await database.client.$queryRawUnsafe<
        Array<{ protocol: string }>
      >(
        `SELECT "protocol" FROM "${database.schema}"."ExecutionWaitProtocol" WHERE "runId"=$1`,
        fixture.runId,
      );
      assert.deepEqual(protocol, [{ protocol: LEGACY_WAIT_PROTOCOL }]);
      const transaction = <T>(
        operation: (
          query: ReturnType<typeof fromPrisma>["executeSql"],
        ) => Promise<T>,
      ) =>
        database.client.$transaction((tx) =>
          operation(fromPrisma(tx).executeSql)
        );
      const decoded = await transaction((query) =>
        fixture.ledger.read(
          query,
          fixture.scope,
          fixture.threadId,
          fixture.run,
          fixture.request,
        )
      );
      assert.deepEqual(decoded, fixture.wait);
      const receipts = await database.client.$queryRawUnsafe<
        Array<{ origin: string; waitJson: string }>
      >(
        `SELECT "origin","waitJson" FROM "${database.schema}"."ExecutionWaitReceipt" WHERE "runId"=$1`,
        fixture.runId,
      );
      assert.deepEqual(receipts, [{
        origin: "legacy-import-v0",
        waitJson: canonical(fixture.wait),
      }]);
      assert.equal(
        await transaction((query) =>
          fixture.ledger.consumed(
            query,
            fixture.scope,
            fixture.threadId,
            fixture.run,
            fixture.request.contribution.id,
          )
        ),
        true,
      );
      assert.equal(
        await transaction((query) =>
          fixture.ledger.consumed(
            query,
            fixture.scope,
            fixture.threadId,
            fixture.run,
            fixture.request.contribution.id,
          )
        ),
        true,
      );
      assert.deepEqual(
        await fixture.bytes(),
        before,
        "migration and explicit compatibility imports preserve every retained byte",
      );
      assert.equal(
        (await database.client.$queryRawUnsafe<Array<{ count: bigint }>>(
          `SELECT count(*) AS count FROM "${database.schema}"."ExecutionWaitConsumption"`,
        ))[0].count,
        1n,
      );
    }, { throughMigration: previousMigration });
  },
});
