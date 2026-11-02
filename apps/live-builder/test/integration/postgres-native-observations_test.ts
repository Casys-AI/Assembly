/** Real PostgreSQL R4b witnesses: SQL append/replay/conflict semantics and a
 * durable-prefix recovery across a non-draining worker kill into a fresh
 * session. Models and replies are controlled fixtures; this does not qualify
 * Toolkit/source pins and claims no OS-process crash coverage. */
import assert from "node:assert/strict";
import { fromPrisma } from "pg-boss";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type {
  NativeExecutionHandlers,
  NativeExecutionSnapshot,
} from "../../src/application/work/runtime/execution.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import type { NativeTrace } from "../../src/adapters/work/runtime/native-graph.ts";
import {
  nativeObservationBatchDigest,
  type NativeObservationEmission,
  parseNativeObservationPayload,
} from "../../src/adapters/work/runtime/native-observation.ts";
import {
  ExecutionNativeObservationLedger,
  type NativeObservationOwner,
} from "../../src/adapters/work/runtime/native-observation-ledger.ts";
import { immutableConsultationFixture } from "../support/immutable-consultation-fixture.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import {
  seedPostgresRuntime,
  withPostgresDatabase,
} from "../support/postgres.ts";

const enabled = Boolean(Deno.env.get("ASSEMBLY_POSTGRES_TEST_URL"));

function traceEvent(overrides: Partial<NativeTrace> = {}): NativeTrace {
  return {
    kind: "action",
    actionId: "action-1",
    nodeId: "node-1",
    mechanism: "fixture_effect",
    source: { file: "r4b.sysml", line: 12, quote: "exact", native: true },
    step: 3,
    operatorId: "op-1",
    modelDigest: "digest-1",
    modelSourceIds: ["source-1"],
    ...overrides,
  };
}
async function emissionFor(
  events: NativeTrace[],
  ordinal: number,
  overrides: Partial<NativeObservationEmission> = {},
): Promise<NativeObservationEmission> {
  const base: NativeObservationEmission = {
    producerPhase: "preparation",
    occurrenceId: "node-1",
    emissionStep: 3,
    eventOrdinal: ordinal,
    batchCount: events.length,
    batchDigest: "",
    event: events[ordinal],
    ...overrides,
  };
  base.batchDigest = await nativeObservationBatchDigest({
    producerPhase: base.producerPhase,
    occurrenceId: base.occurrenceId,
    emissionStep: base.emissionStep,
    events,
  });
  return base;
}

Deno.test({
  name:
    "R4b PostgreSQL observation ledger appends once, replays exactly, refuses conflicts and stays immutable",
  ignore: !enabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const scope = {
        projectId: "r4b-project",
        systemId: "r4b-system",
        executionSpaceId: "main",
        operatorId: "op-1",
      };
      const { client } = database;
      await seedPostgresRuntime(client, scope);
      const now = new Date();
      await client.operatorExecution.create({
        data: {
          ...scope,
          threadId: "thread-1",
          identityJson: canonical({ operatorId: "op-1" }),
          scopeKind: "designer",
          scopeId: "designer-one",
          ownerId: "designer-one",
          purpose: "conversation",
          status: "running",
          checkpointNamespace: "",
          createdAt: now,
          updatedAt: now,
        },
      });
      for (
        const [runId, contributionId, generation] of [
          ["run-1", "input-1", 1n],
          ["run-2", "input-2", 2n],
        ] as const
      ) {
        await client.executionContribution.create({
          data: {
            ...scope,
            threadId: "thread-1",
            contributionId,
            digest: "d".repeat(64),
            kind: "input",
            originJson: "{}",
            payloadJson: "{}",
            status: "running",
            acceptedAt: now,
          },
        });
        await client.executionRun.create({
          data: {
            ...scope,
            threadId: "thread-1",
            runId,
            generation,
            contributionId,
            pinJson: canonical({ pin: 1 }),
            status: "running",
            checkpointNamespace: "",
            epoch: generation,
            jobId: "job-1",
            retryCount: 0,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      const ledger = new ExecutionNativeObservationLedger(
        (name) => `"${database.schema}"."${name}"`,
      );
      const owner = (
        runId: string,
        contributionId: string,
      ): NativeObservationOwner => ({
        threadId: "thread-1",
        runId,
        checkpointNamespace: "",
        contributionId,
        identityJson: canonical({ operatorId: "op-1" }),
        pinJson: canonical({ pin: 1 }),
        epoch: 1n,
        jobId: "job-1",
        retryCount: 0,
      });
      const append = (
        runOwner: NativeObservationOwner,
        emission: NativeObservationEmission,
      ) =>
        client.$transaction((tx) =>
          ledger.append(fromPrisma(tx).executeSql, scope, runOwner, emission)
        );
      const read = (runId: string) =>
        client.$transaction((tx) =>
          ledger.read(fromPrisma(tx).executeSql, scope, "thread-1", runId)
        );
      const batch = [
        traceEvent(),
        traceEvent({ kind: "suspended" }),
      ];
      const first = await emissionFor(batch, 0);
      const second = await emissionFor(batch, 1);
      const commit = await emissionFor(
        [traceEvent({
          kind: "edge",
          actionId: undefined,
          edgeId: "edge-1",
          mechanism: undefined,
        })],
        0,
        { producerPhase: "node-commit" },
      );
      // Inserted out of producer order; the reader restores it.
      await append(owner("run-1", "input-1"), commit);
      const recorded = await append(owner("run-1", "input-1"), first);
      await append(owner("run-1", "input-1"), second);
      const rows = await read("run-1");
      assert.deepEqual(
        rows.map((row) => [row.producerPhase, row.event.kind]),
        [
          ["preparation", "action"],
          ["preparation", "suspended"],
          ["node-commit", "edge"],
        ],
      );
      assert.deepEqual(rows[0].event, batch[0]);
      assert.equal(rows[0].firstRecordedAt, recorded.firstRecordedAt);
      // Exact replay under a fresh epoch/job returns the original record.
      const replayed = await append(
        {
          ...owner("run-1", "input-1"),
          epoch: 9n,
          jobId: "job-2",
          retryCount: 3,
        },
        first,
      );
      assert.deepEqual(replayed, recorded);
      assert.equal((await read("run-1")).length, 3);
      const stored = await client.executionNativeObservation.findMany({
        where: { runId: "run-1" },
      });
      assert.equal(stored.length, 3);
      assert.equal(
        parseNativeObservationPayload(
          stored.find((row) =>
            row.producerPhase === "preparation" && row.eventOrdinal === 0
          )!.payloadJson,
        ).actionId,
        "action-1",
      );
      // Conflicting payload, pin or batch descriptor refuses; row unchanged.
      const changedPayload = await emissionFor([
        traceEvent({ source: { file: "r4b.sysml", line: 99 } }),
        batch[1],
      ], 0);
      await assert.rejects(
        () => append(owner("run-1", "input-1"), changedPayload),
        /NATIVE_OBSERVATION_CONFLICT/,
      );
      await assert.rejects(
        () =>
          append(
            { ...owner("run-1", "input-1"), pinJson: canonical({ pin: 2 }) },
            first,
          ),
        /NATIVE_OBSERVATION_CONFLICT/,
      );
      await assert.rejects(
        () =>
          append(owner("run-1", "input-1"), {
            ...first,
            batchDigest: "0".repeat(64),
          }),
        /NATIVE_OBSERVATION_CONFLICT/,
      );
      assert.deepEqual(await read("run-1"), rows);
      // Forged event ownership refuses against the authenticated scope.
      const forged = await emissionFor(
        [
          traceEvent({ operatorId: "someone-else" }),
        ],
        0,
        { emissionStep: 9 },
      );
      await assert.rejects(
        () => append(owner("run-1", "input-1"), forged),
        /NATIVE_OBSERVATION_OWNER_MISMATCH/,
      );
      // A rolled-back append leaves no row; the retry inserts once.
      const rolled = await emissionFor([traceEvent({ step: 9 })], 0, {
        emissionStep: 9,
      });
      await assert.rejects(
        () =>
          client.$transaction(async (tx) => {
            await ledger.append(
              fromPrisma(tx).executeSql,
              scope,
              owner("run-1", "input-1"),
              rolled,
            );
            throw new Error("roll back the observation transaction");
          }),
        /roll back/,
      );
      assert.equal((await read("run-1")).length, 3);
      await append(owner("run-1", "input-1"), rolled);
      assert.equal((await read("run-1")).length, 4);
      // SQL append-only: even a privileged UPDATE/DELETE is refused.
      await assert.rejects(
        () =>
          client.$executeRawUnsafe(
            `UPDATE "${database.schema}"."ExecutionNativeObservation" SET "batchCount"=2 WHERE "runId"='run-1'`,
          ),
        /immutable/,
      );
      await assert.rejects(
        () =>
          client.$executeRawUnsafe(
            `DELETE FROM "${database.schema}"."ExecutionNativeObservation" WHERE "runId"='run-1'`,
          ),
        /immutable/,
      );
      // The same producer coordinates under another run stay separate, and a
      // missing run is refused by the full-scope foreign key.
      await append(owner("run-2", "input-2"), first);
      assert.equal((await read("run-2")).length, 1);
      assert.equal((await read("run-1")).length, 4);
      await assert.rejects(() => append(owner("missing", "input-1"), first));
    });
  },
});

async function eventually<T>(
  read: () => Promise<T | undefined>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The observation recovery worker did not settle in time");
}

Deno.test({
  name:
    "R4b PostgreSQL durable prefix survives a non-draining kill and a fresh session finishes without duplicate effects or trace growth",
  ignore: !enabled,
  async fn() {
    const fixture = immutableConsultationFixture();
    const { model, state } = fixture;
    const original = model.flows.conversation;
    const start = structuredClone(
      original.nodes.find((node) => node.kind === "start"),
    );
    const waiting = structuredClone(
      original.nodes.find((node) => node.mechanism === "await_input"),
    );
    assert.ok(start && waiting);
    const done = {
      id: "observation-terminal",
      nativeId: "observation-terminal",
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
    const host = await openPostgresDurableRecoveryHost({
      scope: {
        projectId: model.identity.projectId,
        systemId: "native-observation-host",
      },
    });
    const boundaryReached = Promise.withResolvers<void>();
    const releaseHook = Promise.withResolvers<void>();
    const abandonedCallback = Promise.withResolvers<unknown>();
    let seeded = false, operations = 0, armed = true;
    const snapshots: NativeExecutionSnapshot[] = [];
    const delivered: string[] = [];
    const handlers: NativeExecutionHandlers = {
      assertBoundary: () => Promise.resolve(),
      onEvent: async (event) => {
        delivered.push(`${event.kind}:${event.actionId ?? event.edgeId}`);
        if (armed && event.kind === "suspended") {
          // The suspended observation COMMIT already happened; this parks
          // inside its awaited business callback, before any node return.
          boundaryReached.resolve();
          await releaseHook.promise;
        }
      },
      handle: (node) => {
        assert.equal(node.mechanism, "await_input");
        operations++;
        return Promise.resolve({ outputs: {} });
      },
    };
    const delivery = (resume = false): OperatorExecutionDelivery => ({
      id: resume ? "observation-resume" : request.contribution.id,
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
        const storage = await session.storage.operator(
          model.identity.builderId,
        );
        await storage.state.save(state, null);
        seeded = true;
      }
      const run = async (accepted: OperatorExecutionDelivery) => {
        snapshots.push(
          await session.native.execution.run({
            ...request,
            contribution: {
              id: accepted.id,
              kind: accepted.id === request.contribution.id
                ? "input"
                : "resume",
              inputMessageId: request.contribution.inputMessageId,
            },
          }, handlers),
        );
      };
      return { session, run };
    };
    const table = `"${host.database.schema}"."ExecutionNativeObservation"`;
    const readRows = () =>
      host.database.client.$queryRawUnsafe<
        Array<{
          threadId: string;
          runId: string;
          producerPhase: string;
          occurrenceId: string;
          emissionStep: bigint;
          eventOrdinal: number;
          payloadJson: string;
          firstRecordedAt: Date;
        }>
      >(
        `SELECT "threadId","runId","producerPhase","occurrenceId","emissionStep","eventOrdinal","payloadJson","firstRecordedAt" FROM ${table} ORDER BY "emissionStep", CASE "producerPhase" WHEN 'preparation' THEN 0 WHEN 'immutable-group-join' THEN 1 ELSE 2 END, "eventOrdinal"`,
      );
    let active: Awaited<ReturnType<typeof open>> | undefined;
    let recovered: Awaited<ReturnType<typeof open>> | undefined;
    try {
      active = await open();
      const ledger = active.session.native.ledger;
      let abandonedClaim: ReturnType<typeof ledger.currentClaim>;
      const worker = async (accepted: OperatorExecutionDelivery) => {
        try {
          await active!.run(accepted);
        } catch (error) {
          abandonedClaim = ledger.currentClaim();
          abandonedCallback.resolve(error);
          throw error;
        }
      };
      await active.session.start(worker);
      const initial = delivery();
      await active.session.native.dispatch.enqueue(initial);
      await boundaryReached.promise;
      const prefix = await readRows();
      assert.equal(prefix.length, 3);
      assert.deepEqual(
        prefix.map((row) => [row.producerPhase, row.eventOrdinal]),
        [["node-commit", 0], ["preparation", 0], ["preparation", 1]],
      );
      assert.equal(
        parseNativeObservationPayload(prefix[2].payloadJson).kind,
        "suspended",
      );
      assert.equal(snapshots.length, 0, "no checkpoint advance was claimed");
      const { threadId, runId } = prefix[0];
      const killing = active.session.kill();
      await killing;
      recovered = await open();
      const recoveredLedger = recovered.session.native.ledger;
      assert.notEqual(recoveredLedger, ledger);
      // Fresh resources read the same prefix before any retry runs.
      assert.deepEqual(await readRows(), prefix);
      await recovered.session.start(recovered.run);
      releaseHook.resolve();
      const refused = await abandonedCallback.promise;
      assert.match(String(refused), /abort|STALE_EXECUTION_/i);
      assert.equal(abandonedClaim?.job.signal?.aborted, true);
      await eventually(async () =>
        (await recovered!.session.native.dispatch.inspect(
            initial.identity,
            initial.id,
          ))?.status === "completed"
          ? true
          : undefined
      );
      assert.equal(operations, 0);
      const waitingSnapshot = snapshots.at(-1);
      assert.equal(waitingSnapshot?.status, "waiting");
      assert.equal(waitingSnapshot?.threadId, threadId);
      // Retry replayed the preparation: same rows, same first recordings.
      assert.deepEqual(await readRows(), prefix);
      const runRow = await host.database.client.executionRun
        .findFirstOrThrow({ where: { runId } });
      const saver = new PostgresSaver(
        recoveredLedger.options.checkpointPool,
        undefined,
        { schema: host.schemas.checkpointSchema },
      );
      const tuple = await saver.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: runRow.checkpointNamespace,
          checkpoint_id: runRow.checkpointId!,
        },
      });
      assert.ok(tuple);
      assert.deepEqual(tuple.checkpoint.channel_values.trace, []);
      const journal = await recoveredLedger.readNativeObservations(
        request.identity.operatorId,
        threadId,
        runId,
      );
      assert.deepEqual(
        journal.map((record) => record.event),
        prefix.map((row) => parseNativeObservationPayload(row.payloadJson)),
      );
      assert.deepEqual(
        journal.map((record) => record.firstRecordedAt),
        prefix.map((row) => new Date(row.firstRecordedAt).toISOString()),
      );
      // Resume in the fresh session: the acceptance effect runs exactly once.
      armed = false;
      const resume = delivery(true);
      await recovered.session.native.dispatch.enqueue(resume);
      await eventually(async () =>
        (await recovered!.session.native.dispatch.inspect(
            resume.identity,
            resume.id,
          ))?.status === "completed"
          ? true
          : undefined
      );
      assert.equal(operations, 1);
      assert.equal(snapshots.at(-1)?.status, "completed");
      const complete = await readRows();
      assert.equal(complete.length, 6);
      assert.deepEqual(complete.slice(0, 3), prefix);
      assert.deepEqual(
        complete.map((row) =>
          parseNativeObservationPayload(row.payloadJson).kind
        ),
        ["edge", "action", "suspended", "action", "edge", "completed"],
      );
      const finalRun = await host.database.client.executionRun
        .findFirstOrThrow({ where: { runId } });
      const finalTuple = await saver.getTuple({
        configurable: {
          thread_id: threadId,
          checkpoint_ns: finalRun.checkpointNamespace,
          checkpoint_id: finalRun.checkpointId!,
        },
      });
      assert.ok(finalTuple);
      assert.deepEqual(finalTuple.checkpoint.channel_values.trace, []);
      // The parked suspended callback and its replay were both awaited.
      assert.equal(
        delivered.filter((item) => item.startsWith("suspended:")).length,
        2,
      );
    } finally {
      releaseHook.resolve();
      armed = false;
      try {
        await recovered?.session.close({ retainDatabase: true });
      } finally {
        try {
          await active?.session.close({ retainDatabase: true });
        } finally {
          await host.close();
        }
      }
    }
  },
});
