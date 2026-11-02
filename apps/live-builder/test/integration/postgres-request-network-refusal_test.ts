/** Focused real PostgreSQL/LangGraph refusal witness. Only provider decisions
 * are controlled; proposal, human decision, checkpoint and queue are genuine. */
import assert from "node:assert/strict";
import { fromPrisma } from "pg-boss";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import {
  checkpointConsumptions,
  parseNativeWaitEvidence,
  verifyOfficialWaitCheckpoint,
} from "../../src/adapters/work/runtime/checkpoint-wait-evidence.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  openInitialNormalRequest,
  openNormalAdmissionWitnessHost,
} from "../support/request-source-admission-normal-host.ts";
import { caseNetworkWitnessAgent } from "../support/request-case-network-witness.ts";
import {
  type NativeChangeApprovalWait,
  parseRequestNetworkRefusalContinuation,
} from "../../src/application/work/runtime/execution.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { sha256 } from "../../src/domain/primitives/execution-digest.ts";
import { eventually } from "../support/eventually.ts";

const refusalGuards = [
  "The exact Request refusal continuation claim is unavailable",
  "The refusal continuation thread differs",
  "The refusal wait snapshot is unavailable",
  "The refusal checkpoint is not the exact unconsumed wait",
  "The recorded Request refusal changed",
  "The refusal wait changed before selection",
  "The refusal proposal effect is unavailable",
  "The refusal proposal or wait differs",
  "The Request refusal wait is already closed",
  "The Request refusal delivery differs from its recorded receipt",
  "The continuation no longer owns its exact original input",
  "Accepted contribution invocation does not match its receipt",
  "The accepted contribution selected a different native scope",
  "A Request approval wait requires its exact recorded decision",
  "Approval checkpoint unavailable",
  "Approval checkpoint evidence is incomplete or exceeds its bound",
  "Execution identity is retired or changed",
  "Accepted delivery targets a retired execution binding",
  "Native execution requires a durable claimed operator delivery",
  "EXECUTION_DELIVERY_MODEL_PIN_MISMATCH",
  "CONTRIBUTION_RECEIPT_MISMATCH",
] as const;

const diagnosticFrames = [
  "src/application/work/operators/coordination.ts",
  "src/application/work/conversation/turn.ts",
  "src/application/work/runtime/system.ts",
  "src/application/work/runtime/model-adoption.ts",
  "src/adapters/work/runtime/postgres-ledger.ts",
  "src/adapters/work/runtime/conversation.ts",
  "src/adapters/work/request-space-runtime.ts",
  "test/integration/postgres-request-network-refusal_test.ts",
];

function safeFailure(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  const known = refusalGuards.find((guard) => text.includes(guard));
  const names = [
    "Error",
    "TypeError",
    "AssertionError",
    "RequestSpaceError",
    "EvolutionError",
  ];
  return {
    name: error instanceof Error && names.includes(error.name)
      ? error.name
      : "other",
    guard: known ?? "unclassified",
    frames: error instanceof Error
      ? (error.stack ?? "").split("\n").flatMap((line) => {
        const file = diagnosticFrames.find((file) => line.includes(file));
        const position = file
          ? line.slice(line.indexOf(file) + file.length).match(/^:\d+:\d+/)
          : null;
        return file && position ? [file + position[0]] : [];
      }).slice(0, 6)
      : [],
  };
}

Deno.test({
  name:
    "Real Request human refusal consumes its original R0 native wait without adoption",
  ignore: Deno.build.os !== "darwin" ||
    !postgresTestEnabled || !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const controlled = caseNetworkWitnessAgent();
      const host = await openNormalAdmissionWitnessHost(database, {
        wholeSystemClosure: true,
        tools: [],
        enableRuntimeAdoption: true,
        enableNetworkChangeWitness: true,
        agent: controlled.agent,
        networkHost: "example.net",
      });
      assert.equal(host.toolTests, 0);
      assert.equal(host.retainedTools?.length, 0);
      assert.equal(host.initialModel.initialTools?.length ?? 0, 0);
      let phase = "request-opening";
      let selected:
        | Awaited<ReturnType<typeof openInitialNormalRequest>>
        | undefined;
      let expectedWake: string | undefined;
      const diagnosticPath = new URL(
        `../../.data/request-evolved-release/focused-network-refusal-${crypto.randomUUID()}.json`,
        import.meta.url,
      );
      try {
        selected = await openInitialNormalRequest(host);
        const { record, session, view, stores } = selected;
        const operatorId = host.primaryOperatorId;
        const conversations = host.networkConversationsForWitness();
        const owner =
          (await conversations.conversations(session.secret, record.caseId))
            .conversations.find((entry) => entry.agentId === operatorId)!;
        phase = "proposal";
        controlled.armProposal(record.caseId);
        await conversations.submitHuman(session.secret, {
          caseId: record.caseId,
          agentId: operatorId,
          expectedRevision: owner.revision,
          text: "Request the page host; preserve the mandate if refused.",
        });
        const pending = await eventually(async () => {
          const actor =
            (await conversations.conversations(session.secret, record.caseId))
              .conversations.find((entry) => entry.agentId === operatorId);
          const change = actor?.proposalContext?.changes.find((entry) =>
            entry.status === "pending" && !!entry.diff
          );
          return actor && change ? { actor, change } : undefined;
        }, { label: "pending proposal" });
        const original = await eventually(
          async () =>
            (await view.execution.inspect(operatorId)).find((entry) =>
              entry.status === "waiting" && entry.waits.length === 1 &&
              entry.waits[0].kind === "input" &&
              entry.waits[0].mechanism === "await_input" &&
              (entry.localState?.changeApprovalWait as
                  | NativeChangeApprovalWait
                  | undefined)
                  ?.changeId === pending.change.id
            ),
          { label: "native approval wait" },
        );
        const wait = original.localState!
          .changeApprovalWait as NativeChangeApprovalWait;
        const ready = await eventually(
          async () => {
            const actor =
              (await conversations.conversations(session.secret, record.caseId))
                .conversations.find((entry) => entry.agentId === operatorId);
            const accepted = await view.dispatch.inspectAccepted(
              operatorId,
              wait.contributionId,
            );
            return actor && !actor.busy &&
                accepted?.receipt.status === "completed"
              ? actor
              : undefined;
          },
          { label: "settled proposal delivery" },
        );
        const before = await stores.state.load();
        assert(before?.executionModel);
        assert(original.runId && original.checkpointId);
        assert.equal(typeof original.checkpointNamespace, "string");
        const nativeScope = {
          ...host.storage.scope,
          executionSpaceId: record.executionSpaceId,
          operatorId,
        };
        const sourceRun = await host.storage.client.executionRun
          .findFirstOrThrow({
            where: {
              ...nativeScope,
              threadId: original.threadId,
              runId: original.runId,
            },
          });
        const sourceReceipts = await host.storage.client.executionWaitReceipt
          .findMany({
            where: {
              ...nativeScope,
              threadId: original.threadId,
              runId: original.runId,
              checkpointNamespace: original.checkpointNamespace,
              checkpointId: original.checkpointId,
            },
          });
        assert.equal(sourceReceipts.length, 1);
        assert.equal(sourceReceipts[0].origin, "interrupt-v1");
        assert.equal(sourceReceipts[0].pinJson, sourceRun.pinJson);
        const typedSource = parseNativeWaitEvidence(
          JSON.parse(sourceReceipts[0].waitJson),
        );
        assert.equal(typedSource.kind, "input");
        assert.equal(typedSource.nodeId, original.waits[0].nodeId);
        assert.deepEqual(typedSource.changeApprovalWait, wait);
        assert.notEqual(
          typedSource.effectKey,
          wait.effectKey,
          "input acceptance and the completed proposal are separate effects",
        );
        const saver = new PostgresSaver(
          host.stage.nativeRuntime.ledger.options.checkpointPool,
          undefined,
          { schema: host.stage.nativeRuntime.ledger.options.checkpointSchema },
        );
        await verifyOfficialWaitCheckpoint(
          await saver.getTuple({
            configurable: {
              thread_id: original.threadId,
              checkpoint_ns: original.checkpointNamespace,
              checkpoint_id: original.checkpointId,
            },
          }),
          typedSource,
        );
        const inputAndWait = () =>
          host.storage.client.$transaction(async (tx) => {
            const query = fromPrisma(tx).executeSql;
            return {
              inputConsumed: await view.ledger.waitEvidence.consumed(
                query,
                nativeScope,
                original.threadId,
                sourceRun,
                wait.contributionId,
              ),
              waitConsumed: await view.ledger.waitEvidence.waitConsumed(
                query,
                nativeScope,
                original.threadId,
                sourceRun,
                typedSource,
              ),
            };
          });
        assert.deepEqual(await inputAndWait(), {
          inputConsumed: true,
          waitConsumed: false,
        });
        const admissionBefore = await host.stage.executionBindings.read(record);
        const sourceBefore = await host.sourceAdmission.admittedSource(record);
        const userIds = before.messages.filter((message) =>
          message.role === "user"
        ).map((message) => message.id);
        controlled.armRefusal(record.caseId, {
          changeId: pending.change.id,
          inputMessageId: wait.inputMessageId,
          modelDigest: wait.modelDigest,
        });
        const command = {
          caseId: record.caseId,
          agentId: operatorId,
          changeId: pending.change.id,
          expectedRevision: ready.revision,
          configurationRevision: pending.change.baseRevision,
          verdict: "refuse" as const,
        };
        phase = "human-refusal";
        assert.deepEqual(
          await conversations.decideChange(session.secret, command),
          {
            status: "refused",
            caseId: record.caseId,
            changeId: pending.change.id,
          },
        );
        const committed = await stores.state.load();
        assert(committed?.executionModel);
        const change = committed.configuration!.changes.find((entry) =>
          entry.id === pending.change.id
        )!;
        const decision = committed.requestNetworkDecisions![change.id];
        assert.equal(change.status, "refused");
        assert.equal(decision.verdict, "refuse");
        const digest = await sha256(canonical({ change, decision }));
        expectedWake = `network-refusal:${digest}`;
        phase = "refusal-consumption";
        const settled = await eventually(async () => {
          const accepted = await view.dispatch.inspectAccepted(
            operatorId,
            expectedWake!,
          );
          if (
            accepted &&
            ["failed", "refused", "uncertain", "cancelled"].includes(
              accepted.receipt.status,
            )
          ) {
            throw new Error(
              `Focused refusal continuation reached terminal ${accepted.receipt.status}`,
            );
          }
          if (
            controlled.diagnostics.some((entry) =>
              entry.failed && entry.caseId === record.caseId
            )
          ) {
            throw new Error(
              "Focused refusal provider rejected its real context",
            );
          }
          const state = await stores.state.load();
          return accepted?.receipt.status === "completed" && state &&
              !state.busy &&
              controlled.refusals.some((entry) => entry.changeId === change.id)
            ? { accepted, state }
            : undefined;
        }, { label: "R0 refusal consumption" });
        assert.equal(settled.accepted.delivery.kind, "continuation");
        assert.deepEqual(settled.accepted.delivery.identity, original.identity);
        assert.deepEqual(settled.accepted.delivery.modelPin, {
          modelDigest: wait.modelDigest,
          repositoryVersion: wait.repositoryVersion,
        });
        assert.deepEqual(
          parseRequestNetworkRefusalContinuation(
            settled.accepted.delivery.payload?.networkRefusal,
          ),
          {
            changeId: change.id,
            proposalIntentDigest: wait.proposalIntentDigest,
            decisionDigest: digest,
            threadId: original.threadId,
            checkpointId: original.checkpointId,
            originalInputMessageId: wait.inputMessageId,
          },
        );
        const resumed = (await view.execution.inspect(operatorId)).find((
          entry,
        ) => entry.contributionId === expectedWake);
        assert(resumed);
        assert.equal(resumed.threadId, original.threadId);
        assert.notEqual(resumed.checkpointId, original.checkpointId);
        assert.equal(resumed.status, "waiting");
        assert.equal(resumed.modelDigest, wait.modelDigest);
        assert.equal(resumed.repositoryVersion, wait.repositoryVersion);
        assert.equal(resumed.waits.length, 1);
        assert.equal(resumed.waits[0].mechanism, "await_input");
        assert.deepEqual(resumed.unsettledEffects, []);
        const consumption = await host.storage.client.executionWaitConsumption
          .findMany({
            where: {
              ...nativeScope,
              threadId: original.threadId,
              contributionId: expectedWake,
            },
          });
        assert.equal(consumption.length, 1);
        assert.equal(consumption[0].kind, "wait-v1");
        assert.equal(consumption[0].runId, resumed.runId);
        assert.equal(consumption[0].sourceRunId, original.runId);
        assert.equal(
          consumption[0].sourceCheckpointNamespace,
          original.checkpointNamespace,
        );
        assert.equal(consumption[0].sourceCheckpointId, original.checkpointId);
        assert.notEqual(
          consumption[0].successorCheckpointId,
          original.checkpointId,
        );
        const proof = JSON.parse(consumption[0].consumptionJson);
        assert.deepEqual(proof.wait, typedSource);
        assert.equal(proof.sourceCheckpointId, original.checkpointId);
        assert.equal(proof.contributionId, expectedWake);
        const consumedCheckpoint = await saver.getTuple({
          configurable: {
            thread_id: original.threadId,
            checkpoint_ns: consumption[0].successorCheckpointNamespace,
            checkpoint_id: consumption[0].successorCheckpointId,
          },
        });
        assert(
          consumedCheckpoint,
          "refusal consumption names a real committed official successor checkpoint",
        );
        assert.deepEqual(
          checkpointConsumptions(
            consumedCheckpoint.checkpoint,
            consumedCheckpoint.checkpoint.channel_versions,
          ),
          [proof],
        );
        assert.deepEqual(await inputAndWait(), {
          inputConsumed: true,
          waitConsumed: true,
        });
        assert.deepEqual(
          settled.state.messages.filter((message) => message.role === "user")
            .map((message) => message.id),
          userIds,
        );
        assert.equal(
          settled.state.messages.filter((message) =>
            message.id === `network-refusal-feedback:${digest}`
          ).length,
          1,
        );
        assert.deepEqual(controlled.refusals, [{
          caseId: record.caseId,
          changeId: change.id,
          feedbackId: `network-refusal-feedback:${digest}`,
          inputMessageId: wait.inputMessageId,
          modelDigest: wait.modelDigest,
        }]);
        assert.deepEqual(settled.state.executionModel, before.executionModel);
        const after = await host.stage.executionBindings.read(record);
        assert.deepEqual(after.pin, admissionBefore.pin);
        assert.deepEqual(after.admission, admissionBefore.admission);
        assert.deepEqual(
          await host.sourceAdmission.admittedSource(record),
          sourceBefore,
        );
        const where = {
          ...host.storage.scope,
          executionSpaceId: record.executionSpaceId,
          operatorId,
        };
        assert.equal(
          await host.storage.client.executionEffect.count({
            where: {
              ...where,
              threadId: original.threadId,
              nodeId: wait.actionId,
            },
          }),
          1,
          "Refusal must not replay its completed proposal effect",
        );
        assert.equal(
          await host.storage.client.executionContribution.count({
            where: { ...where, contributionId: expectedWake },
          }),
          1,
        );
        assert.deepEqual(host.workerErrors, []);
        assert.deepEqual(host.deliveryFailures, []);
      } catch (error) {
        try {
          const state = await selected?.stores.state.load();
          const where = selected
            ? {
              ...host.storage.scope,
              executionSpaceId: selected.record.executionSpaceId,
              operatorId: host.primaryOperatorId,
            }
            : undefined;
          const contributions = where
            ? await host.storage.client.executionContribution.findMany({
              where,
              take: 8,
              select: {
                contributionId: true,
                status: true,
                runId: true,
                jobId: true,
              },
            })
            : [];
          const snapshots = selected
            ? await selected.view.execution.inspect(host.primaryOperatorId)
            : [];
          const diagnostic = {
            capturedBeforeCleanup: true,
            phase,
            failure: safeFailure(error),
            expectedWake,
            runtime: state
              ? {
                revision: state.revision,
                busy: state.busy,
                phase: state.phase === "Demande interrompue"
                  ? "interrupted"
                  : "other",
                error: state.error === undefined
                  ? null
                  : safeFailure(state.error),
                activeInputMessageId: state.activeInputMessageId,
              }
              : null,
            deliveryFailures: host.deliveryFailures.slice(0, 8).map((
              entry,
            ) => ({
              deliveryId: entry.deliveryId,
              ...safeFailure(entry.error),
            })),
            workerErrors: host.workerErrors.slice(0, 8).map(safeFailure),
            provider: controlled.diagnostics.slice(-16),
            contributions,
            snapshots: snapshots.slice(0, 8).map((snapshot) => ({
              runId: snapshot.runId,
              threadId: snapshot.threadId,
              contributionId: snapshot.contributionId,
              status: snapshot.status,
              checkpointId: snapshot.checkpointId,
              waits: snapshot.waits,
              unsettledEffects: snapshot.unsettledEffects.length,
            })),
          };
          await Deno.mkdir(new URL("./", diagnosticPath), { recursive: true });
          await Deno.writeTextFile(
            diagnosticPath,
            JSON.stringify(diagnostic, null, 2),
          );
          console.log("Focused Request refusal failure", {
            phase,
            diagnosticPath: diagnosticPath.pathname,
            deliveryFailures: diagnostic.deliveryFailures,
            runtimeError: diagnostic.runtime?.error,
          });
        } catch (diagnosticError) {
          console.log(
            "Focused refusal diagnostic unavailable",
            safeFailure(diagnosticError),
          );
        }
        throw error;
      }
    });
  },
});
