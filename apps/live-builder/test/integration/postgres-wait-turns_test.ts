/** Actual queue claims and official PostgreSQL graph checkpoints across resumed
 * turns. Recorded model reads are fixture outcomes, not provider qualification. */
import assert from "node:assert/strict";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { checkpointConsumptions } from "../../src/adapters/work/runtime/checkpoint-wait-evidence.ts";
import type {
  NativeExecutionHandlers,
  NativeExecutionSnapshot,
} from "../../src/application/work/runtime/execution.ts";
import { runtimeRevisionReference } from "../../src/application/work/runtime/execution.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import type { CompiledFlow } from "../../src/domain/model/execution/flow.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import { immutableConsultationFixture } from "../support/immutable-consultation-fixture.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

Deno.test({
  name:
    "R4a PostgreSQL two resumed input turns publish immutable groups and retain bounded checkpoint proof with durable consumption history",
  ignore: !postgresTestEnabled,
  async fn() {
    const fixture = immutableConsultationFixture();
    const { model, state, request } = fixture;
    assert.equal(request.identity.scope.kind, "designer");
    const original = model.flows.conversation;
    const start = structuredClone(
      original.nodes.find((node) => node.kind === "start")!,
    );
    const waiting = structuredClone(
      original.nodes.find((node) => node.mechanism === "await_input")!,
    );
    assert.ok(start);
    assert.ok(waiting);
    waiting.inputs = [];
    waiting.outputs = [];
    waiting.assertions = [];
    const command = structuredClone(fixture.node);
    const edge = (id: string, source: string, target: string) => ({
      id,
      nativeId: id,
      source,
      target,
      guardIds: [],
      sourceEvidence: start.source,
    });
    const flow: CompiledFlow = {
      ...original,
      executionProfile: "operator-command-immutable-group-v1",
      startNodeId: start.id,
      nodes: [start, waiting, command],
      edges: [
        edge("turn-start-to-wait", start.id, waiting.id),
        edge("turn-wait-to-group", waiting.id, command.id),
        edge("turn-group-to-wait", command.id, waiting.id),
      ],
      bindings: [],
    };
    model.flows.conversation = flow;
    request.flow = flow;
    state.executionModel = structuredClone(model);
    const queuedBatch = structuredClone(state.conversationBatches![0]);
    const scope = {
      projectId: model.identity.projectId,
      systemId: "typed-wait-turns-host",
    };
    const host = await openPostgresDurableRecoveryHost({
      scope,
    });
    const table = (name: string) => `"${host.database.schema}"."${name}"`;
    const acceptedEffects = new Map<string, number>();
    const memberEffects = new Map<string, number>();
    const snapshots = new Map<string, NativeExecutionSnapshot>();
    const contributions = [
      request.contribution.id,
      "wait-turn-resume-one",
      "wait-turn-resume-two",
    ];
    let threadId: string | undefined, namespace: string | undefined;
    try {
      for (const [turn, contributionId] of contributions.entries()) {
        const session = await host.openSession();
        const owner = await session.storage.operator(model.identity.builderId);
        if (turn === 0) {
          await owner.state.save(state, null);
        } else {
          const current = await owner.state.load();
          assert.ok(current);
          if (turn === 2) {
            // A distinct recorded provider response supplies the next group.
            // The prior batch/publication stays in canonical history and state.
            const expected = current.revision;
            const nextBatch = structuredClone(queuedBatch);
            nextBatch.id = "batch-two";
            current.conversationBatches = [
              nextBatch,
              ...current.conversationBatches!,
            ];
            current.revision++;
            await owner.state.save(current, expected);
          }
          Object.assign(state, structuredClone(current));
        }
        const handlers: NativeExecutionHandlers = {
          assertBoundary: () => Promise.resolve(),
          onEvent: () => Promise.resolve(),
          handle: (node, _inputs, _values, action) => {
            assert.equal(node.mechanism, "await_input");
            assert.equal(action.resumed, true);
            acceptedEffects.set(
              action.effectKey,
              (acceptedEffects.get(action.effectKey) ?? 0) + 1,
            );
            return Promise.resolve({ outputs: {} });
          },
          immutableConsultations: {
            async plan(node, _inputs, _values, context) {
              assert.equal(node.id, command.id);
              const { manifestDigest: _baseDigest, ...base } = await fixture
                .manifest(context.runId);
              const members = base.members.map((member, index) => ({
                ...member,
                flowStepOrdinal: context.step + index + 1,
              }));
              const body = {
                ...base,
                batchId: state.conversationBatches![0].id,
                contribution: structuredClone(context.request.contribution),
                businessRevision: structuredClone(
                  context.request.businessRevision,
                ),
                members: [members[0]!, members[1]!] as const,
              };
              return { ...body, manifestDigest: await executionDigest(body) };
            },
            execute(manifest, member) {
              memberEffects.set(
                member.effectKey,
                (memberEffects.get(member.effectKey) ?? 0) + 1,
              );
              return Promise.resolve(fixture.outcome(manifest, member));
            },
            async publish(manifest, outcomes) {
              const publication = await fixture.publication(manifest, outcomes);
              await owner.state.save(publication.state, state.revision);
              Object.assign(state, structuredClone(publication.state));
              return {
                publication: publication.receipt,
                action: { outputs: {} },
              };
            },
          },
        };
        const delivery: OperatorExecutionDelivery = {
          id: contributionId,
          identity: structuredClone(request.identity),
          kind: turn === 0 ? "contribution" : "continuation",
          modelPin: {
            modelDigest: model.version.digest,
            repositoryVersion: model.version.repositoryVersion,
          },
        };
        await session.start(async (accepted) => {
          const snapshot = await session.native.execution.run({
            ...request,
            businessRevision: runtimeRevisionReference(state),
            contribution: {
              id: accepted.id,
              kind: turn === 0 ? "input" : "resume",
              inputMessageId: request.contribution.inputMessageId,
            },
          }, handlers);
          snapshots.set(accepted.id, snapshot);
        });
        await session.native.dispatch.enqueue(delivery);
        await session.idle(undefined, 30_000);
        const snapshot = snapshots.get(contributionId);
        assert.ok(snapshot);
        assert.equal(snapshot.status, "waiting");
        assert.deepEqual(snapshot.waits, [{
          nodeId: waiting.id,
          mechanism: "await_input",
          kind: "input",
        }]);
        assert.deepEqual(snapshot.unsettledEffects, []);
        assert.deepEqual(snapshot.openImmutableConsultationGroups, []);
        assert.equal(snapshot.contributionId, contributionId);
        assert.deepEqual(snapshot.identity, request.identity);
        threadId ??= snapshot.threadId;
        namespace ??= snapshot.checkpointNamespace;
        assert.equal(snapshot.threadId, threadId);
        assert.equal(snapshot.checkpointNamespace, namespace);
        assert.ok(snapshot.checkpointId);
        const saver = new PostgresSaver(
          session.native.ledger.options.checkpointPool,
          undefined,
          {
            schema: host.schemas.checkpointSchema,
          },
        );
        const selected = await saver.getTuple({
          configurable: {
            thread_id: threadId,
            checkpoint_ns: namespace,
            checkpoint_id: snapshot.checkpointId,
          },
        });
        assert.ok(selected);
        const candidates = checkpointConsumptions(
          selected.checkpoint,
          selected.checkpoint.channel_versions,
        );
        assert.equal(
          candidates.length,
          1,
          "the checkpoint keeps only the current turn's candidate",
        );
        assert.equal(candidates[0].contributionId, contributionId);
        assert.equal(candidates[0].kind, turn === 0 ? "input-v1" : "wait-v1");
        const consumptions = await host.database.client.$queryRawUnsafe<
          Array<{
            contributionId: string;
            kind: string;
            sourceRunId: string | null;
            sourceCheckpointNamespace: string | null;
            sourceCheckpointId: string | null;
            successorCheckpointNamespace: string;
            successorCheckpointId: string;
            consumptionJson: string;
          }>
        >(
          `SELECT * FROM ${
            table("ExecutionWaitConsumption")
          } WHERE "threadId"=$1`,
          threadId,
        );
        assert.equal(
          consumptions.length,
          turn + 1,
          "durable receipts retain every admitted turn",
        );
        assert.deepEqual(
          consumptions.map((item) => item.contributionId).sort(),
          contributions.slice(0, turn + 1).toSorted(),
        );
        const receipt = consumptions.find((item) =>
          item.contributionId === contributionId
        )!;
        assert.equal(receipt.kind, candidates[0].kind);
        assert.deepEqual(JSON.parse(receipt.consumptionJson), candidates[0]);
        if (turn > 0) {
          const source = snapshots.get(contributions[turn - 1])!;
          assert.equal(receipt.sourceRunId, source.runId);
          assert.equal(
            receipt.sourceCheckpointNamespace,
            source.checkpointNamespace,
          );
          assert.equal(receipt.sourceCheckpointId, source.checkpointId);
        }
        const consumedAt = await saver.getTuple({
          configurable: {
            thread_id: threadId,
            checkpoint_ns: receipt.successorCheckpointNamespace,
            checkpoint_id: receipt.successorCheckpointId,
          },
        });
        assert.ok(
          consumedAt,
          "consumption names the exact official successor checkpoint",
        );
        assert.deepEqual(
          checkpointConsumptions(
            consumedAt.checkpoint,
            consumedAt.checkpoint.channel_versions,
          ),
          candidates,
        );
        assert.equal(acceptedEffects.size, turn);
        assert.equal(memberEffects.size, turn * 2);
        assert.ok(
          [...acceptedEffects.values(), ...memberEffects.values()].every((
            count,
          ) => count === 1),
        );
        if (turn === 2) {
          let checkpoints = 0;
          for await (
            const historical of saver.list({
              configurable: { thread_id: threadId, checkpoint_ns: namespace },
            })
          ) {
            checkpoints++;
            assert.ok(
              checkpointConsumptions(
                historical.checkpoint,
                historical.checkpoint.channel_versions,
              ).length <= 1,
            );
          }
          assert.ok(checkpoints > 3);
        }
        await session.stop();
      }
      const effects = await host.database.client.$queryRawUnsafe<
        Array<{ effectKey: string; status: string }>
      >(
        `SELECT "effectKey","status" FROM ${
          table("ExecutionEffect")
        } WHERE "threadId"=$1`,
        threadId,
      );
      assert.equal(
        effects.length,
        6,
        "two input acceptances and four immutable reads settle exactly once",
      );
      assert.equal(new Set(effects.map((effect) => effect.effectKey)).size, 6);
      assert.ok(effects.every((effect) => effect.status === "completed"));
      const groups = await host.database.client.$queryRawUnsafe<
        Array<{ publicationJson: string | null }>
      >(
        `SELECT "publicationJson" FROM ${
          table("ImmutableConsultationGroup")
        } WHERE "threadId"=$1`,
        threadId,
      );
      assert.equal(groups.length, 2);
      assert.ok(groups.every((group) => group.publicationJson !== null));
      assert.equal(state.messages.length, 5);
      assert.equal(
        new Set(state.messages.map((message) => message.id)).size,
        5,
      );
    } finally {
      await host.close();
    }
  },
});
