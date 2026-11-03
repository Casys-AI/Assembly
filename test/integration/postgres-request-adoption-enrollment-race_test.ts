import { PostgresProviderCallStore } from "../../src/adapters/out/postgres/provider-call-store.ts";
import { UNKNOWN_PROVIDER_CALL_CORRELATION } from "../../src/application/telemetry/provider-call.ts";
import { qualifyRequestAdoptionControlRaces } from "../support/request-adoption-control-races.ts";
import { ProviderResourceAccessError } from "../../src/application/telemetry/current-provider-resources.ts";
import { startPausedCurrentRead } from "../support/request-provider-adoption-qualification.ts";
import {
  captureRequestAdoptionMemory,
  qualifyRetainedRequestAdoptionMemory,
} from "../support/request-adoption-memory-qualification.ts";
/** Owned normal PG + Toolkit Request. This file exercises the real dispatch,
 * input guard and adoption arming transaction; controlled provider only. */
import assert from "node:assert/strict";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import { withPostgresExecutionTransaction } from "../../src/adapters/out/postgres/execution-transaction.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  postgresTestEnabled,
  withPostgresDatabase,
} from "../support/postgres.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  openInitialNormalRequest,
  openNormalAdmissionWitnessHost,
} from "../support/request-source-admission-normal-host.ts";
import { normalInstructionChange } from "../support/request-source-admission-qualification.ts";
import {
  actualRequestWorkPending,
  completeActualAdoption,
  observeAdoptionNativeBoundary,
  observeAdoptionTransactions,
} from "../support/request-adoption-diagnostics.ts";
import { eventually } from "../support/eventually.ts";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error("Enrollment race exceeded bounded fixture wait")),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorCategory(error: unknown) {
  if (!error || typeof error !== "object") return "unclassified";
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) {
    return code;
  }
  return error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : "unclassified";
}

function transactionCategories(error: string) {
  // Diagnostics retain original errors privately. Emit only fixed categories;
  // never print SQL, model source, request text, credentials or error messages.
  const known = [
    "P2002",
    "P2010",
    "P2034",
    "55P03",
    "40P01",
    "40001",
    "23514",
    "23505",
    "WRITE_QUEUE_CONFLICT",
    "WRITE_FENCE_LOST",
    "WRITE_QUEUE_UNAVAILABLE",
    "SOURCE_CONFLICT",
  ].filter((code) => error.includes(code));
  if (/lock timeout/i.test(error)) known.push("lock-timeout");
  if (/deadlock/i.test(error)) known.push("deadlock");
  return known.length ? known : ["unclassified"];
}

Deno.test({
  name:
    "PG Request enrollment versus arming: SHARE exclusion, new identity rollback, exact replay and delayed R0 refusal",
  ignore: !postgresTestEnabled ||
    !toolkitIntegrationEnabled,
  async fn() {
    await withPostgresDatabase(async (database) => {
      const host = await openNormalAdmissionWitnessHost(database, {
        enableRuntimeAdoption: true,
      });
      const initial = await openInitialNormalRequest(host);
      const sibling = await openInitialNormalRequest(host);
      const retainedMemory = await captureRequestAdoptionMemory(host, initial);
      const isolation = () =>
        host.storage.client.runtimeState.findMany({
          where: {
            ...host.storage.scope,
            executionSpaceId: { in: ["main", sibling.record.executionSpaceId] },
          },
          orderBy: [{ executionSpaceId: "asc" }, { operatorId: "asc" }],
        });
      const untouched = await isolation();
      assert(untouched.some((row) => row.executionSpaceId === "main"));
      assert(
        untouched.some((row) =>
          row.executionSpaceId === sibling.record.executionSpaceId
        ),
      );
      const diagnostics = observeAdoptionTransactions(host.storage.client);
      database.registerCleanup(() => diagnostics.restore());
      database.registerCleanup(
        observeAdoptionNativeBoundary(initial.view.ledger, diagnostics),
      );
      const { record, view, session } = initial;
      const adoption = host.stage.adoption;
      assert(adoption);
      const scope = {
        ...record.scope,
        executionSpaceId: record.executionSpaceId,
        operatorId: host.primaryOperatorId,
      };
      const parentTable = postgresQualifiedTable(
        host.storage.client,
        "OperatorRuntime",
      );
      const originalDelivery = initial.initialReceipt!.delivery;
      const newDelivery = (
        label: string,
        kind: OperatorExecutionDelivery["kind"] = "contribution",
      ): OperatorExecutionDelivery => {
        const id = `enrollment-${label}-${crypto.randomUUID()}`;
        return {
          ...structuredClone(originalDelivery),
          id,
          kind,
          identity: {
            ...structuredClone(originalDelivery.identity),
            subjectId: id,
          },
          payload: {
            ...structuredClone(originalDelivery.payload),
            text: `Owned race ${label}`,
            receivedAt: new Date().toISOString(),
          },
        };
      };
      const competingClient = database.createClient();
      const assertParentExcludesUpdate = async () => {
        await assert.rejects(() =>
          competingClient.$transaction(async (tx) => {
            await tx.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '100ms'`);
            await tx.$executeRaw(
              Prisma.sql`UPDATE ${parentTable} SET "operatorId"="operatorId"
            WHERE "projectId"=${scope.projectId} AND "systemId"=${scope.systemId}
            AND "executionSpaceId"=${scope.executionSpaceId} AND "operatorId"=${scope.operatorId}`,
            );
          }), /lock timeout|55P03/);
      };
      const proposal = await host.revisions.propose(session.secret, {
        caseId: record.caseId,
        expectedVersion: originalDelivery.modelPin.repositoryVersion!,
        changes: [normalInstructionChange(host.source.sources)],
        reason: "Owned enrollment/adoption exclusion qualification",
      });
      const queued = await host.revisions.accept(session.secret, {
        caseId: record.caseId,
        proposalId: proposal.id,
      });
      const sourceCheckpoint = diagnostics.checkpoint();
      let lastQueueState: unknown = null, lastAdmittedHead: unknown = null;
      // SQL source admission precedes the writer's retained Git/native proof
      // recovery and final queue acknowledgement. Give only this source setup
      // 90s (below the writer's 300s lease), polling its 1s pump at 250ms. Native
      // race waits retain their original deadlines; do not repeatedly parse D2
      // while the actual writer is still publishing.
      const source = await eventually(async () => {
        const queue = await host.backend.queue.get(
          host.backend.project.id,
          queued.commandId,
        );
        lastQueueState = queue
          ? {
            state: queue.state,
            attempts: queue.attempts,
            fence: queue.fence,
            updatedAt: queue.updatedAt,
            leaseExpiresAt: queue.leaseExpiresAt ?? null,
            publishedVersion: queue.publishedVersion ?? null,
            errorCategory: queue.lastError?.code
              ? errorCategory({ code: queue.lastError.code })
              : null,
          }
          : null;
        if (queue?.state === "refused" || queue?.state === "needs-decision") {
          throw new Error(`Source setup refused: ${queue.state}`);
        }
        if (queue?.state !== "published") return undefined;
        const chain = await host.sourceAdmission.admittedSource(record);
        lastAdmittedHead = {
          revision: chain.head.revision,
          manifestDigest: chain.head.manifestDigest,
          sourceVersion: chain.head.source.version,
        };
        return queue?.state === "published" &&
            chain.head.source.version !==
              originalDelivery.modelPin.repositoryVersion
          ? chain
          : undefined;
      }, { timeoutMs: 90_000, pollMs: 250 }).catch(async (error: unknown) => {
        // One bounded failure-only D2 observation retains actionable admission
        // progress evidence without competing with publication on every poll.
        let admittedHeadReadError: string | null = null;
        try {
          const chain = await bounded(
            host.sourceAdmission.admittedSource(record),
          );
          lastAdmittedHead = {
            revision: chain.head.revision,
            manifestDigest: chain.head.manifestDigest,
            sourceVersion: chain.head.source.version,
          };
        } catch (headError) {
          admittedHeadReadError = errorCategory(headError);
        }
        const failures = diagnostics.since(sourceCheckpoint);
        throw new Error(
          `Owned source-publication gate failed: ${
            JSON.stringify({
              commandId: queued.commandId,
              failureCategory: errorCategory(error),
              queue: lastQueueState,
              admittedHead: lastAdmittedHead,
              admittedHeadReadError,
              nativeWorkerErrors: {
                count: host.workerErrors.length,
                categories: host.workerErrors.slice(-8).map(errorCategory),
              },
              transactionFailures: {
                count: failures.length,
                recent: failures.slice(-8).map((failure) => ({
                  sequence: failure.sequence,
                  categories: transactionCategories(failure.error),
                })),
              },
            })
          }`,
        );
      });

      // Acceptance first: pause AFTER the real guard under actual parent SHARE.
      // Enqueue uses its real caller transaction; defer only this owned job's
      // eligibility so accepted R0 remains queued while the adoption checks it.
      const entered = gate(), releaseAcceptance = gate();
      const guard = view.ledger.options.acceptDeliveryInTransaction;
      assert(guard);
      const acceptedInput = newDelivery("accepted-first");
      let freshGuardCalls = 0;
      view.ledger.options.acceptDeliveryInTransaction = async (tx, input) => {
        if (input.identity.subjectId === acceptedInput.id) freshGuardCalls++;
        await guard(tx, input);
        if (
          input.phase === "after-share" &&
          input.identity.subjectId === acceptedInput.id
        ) {
          entered.release();
          await bounded(releaseAcceptance.promise);
        }
      };
      const queueSchema = view.ledger.options.queueSchema;
      assert.match(queueSchema, /^[a-z_][a-z0-9_]{0,62}$/);
      const queueJobs = Prisma.raw(`"${queueSchema}".job`);
      let heldJob: string | undefined;
      database.registerCleanup(async () => {
        releaseAcceptance.release();
        if (heldJob) {
          await host.storage.client.$executeRaw(
            Prisma.sql`UPDATE ${queueJobs} SET start_after=clock_timestamp()
          WHERE name=${view.ledger.options.queueName} AND id=${heldJob}::uuid`,
          );
        }
      });
      const accepting = host.storage.client.$transaction(
        (tx) =>
          withPostgresExecutionTransaction({
            client: host.storage.client,
            transaction: tx,
          }, async () => {
            const receipt = await view.dispatch.enqueue(acceptedInput);
            heldJob = receipt.jobId;
            await tx.$executeRaw(
              Prisma
                .sql`UPDATE ${queueJobs} SET start_after=clock_timestamp()+interval '1 day'
          WHERE name=${view.ledger.options.queueName} AND id=${receipt.jobId}::uuid`,
            );
            return receipt;
          }),
        { timeout: 20_000 },
      );
      void accepting.catch(() => {});
      const retryResolving = gate();
      const resolveThread = view.ledger.resolveThread.bind(view.ledger);
      let exactRetry: ReturnType<typeof view.dispatch.enqueue> | undefined;
      try {
        await bounded(entered.promise);
        view.ledger.resolveThread = async (...args) => {
          if (args[1].subjectId === acceptedInput.id) retryResolving.release();
          return await resolveThread(...args);
        };
        exactRetry = view.dispatch.enqueue(acceptedInput);
        void exactRetry.catch(() => {});
        // Reaching resolveThread proves this retry saw no prior committed row;
        // it must return through the raced receipt after the first commit.
        await bounded(retryResolving.promise);
        await assertParentExcludesUpdate(); // FOR KEY SHARE would allow this UPDATE.
      } finally {
        releaseAcceptance.release();
        view.ledger.resolveThread = resolveThread;
      }
      const acceptedReceipt = await bounded(accepting);
      assert(exactRetry);
      const racedReplay = await bounded(exactRetry);
      assert.equal(racedReplay.jobId, acceptedReceipt.jobId);
      assert.equal(
        freshGuardCalls,
        2,
        "Raced exact receipt returns before either fresh guard phase",
      );
      view.ledger.options.acceptDeliveryInTransaction = guard;
      const adoptionKey = `race-${crypto.randomUUID()}`;
      const pending = await adoption.prepare(session.secret, {
        caseId: record.caseId,
        adoptionKey,
        expectedAdmittedVersion: source.head.source.version,
        expectedExecutingDigest: originalDelivery.modelPin.modelDigest,
      });
      assert.equal(pending.status, "prepared");
      assert(pending.blockers.length > 0);
      assert.equal(
        await host.storage.client.evolutionTargetBarrier.count({
          where: {
            ...record.scope,
            targetScopeKey: `request:${record.executionSpaceId}`,
            operatorId: scope.operatorId,
          },
        }),
        0,
      );
      assert.equal(
        (await host.stage.executionBindings.read(record)).pin.modelDigest,
        originalDelivery.modelPin.modelDigest,
      );
      assert.equal(
        (await view.dispatch.inspect(acceptedInput.identity, acceptedInput.id))
          ?.status,
        "queued",
      );
      await host.storage.client.$executeRaw(
        Prisma.sql`UPDATE ${queueJobs} SET start_after=clock_timestamp()
        WHERE name=${view.ledger.options.queueName} AND id=${acceptedReceipt.jobId}::uuid`,
      );
      heldJob = undefined;
      await eventually(async () =>
        (await view.dispatch.inspect(acceptedInput.identity, acceptedInput.id))
            ?.status === "completed"
          ? true
          : undefined
      );

      // Exact phantom enrollment: session/intent preflights finish first, then
      // a new subject remains invisible while preparation/native locks are taken.
      // Its acceptance holds control/admission+SHARE. Pause arm before attempting
      // those locks (NOWAIT would otherwise refuse immediately), commit input
      // without changing RuntimeState; arm must recheck native members
      // under the parent and roll back before publishing any durable barrier.
      const beforePreparation = gate(), releasePreparation = gate();
      const invisibleEntered = gate(), releaseInvisible = gate();
      const nativeLocked = gate(), releaseNative = gate();
      const prepareBatch = view.ledger.prepareRetirementBatch.bind(view.ledger);
      const lockRetirement = view.ledger.lockRetirementInTransaction.bind(
        view.ledger,
      );
      view.ledger.prepareRetirementBatch = async (...args) => {
        beforePreparation.release();
        await bounded(releasePreparation.promise);
        return await prepareBatch(...args);
      };
      view.ledger.lockRetirementInTransaction = async (tx, packet) => {
        const token = await lockRetirement(tx, packet);
        nativeLocked.release();
        await bounded(releaseNative.promise);
        return token;
      };
      const phantomInput = newDelivery("invisible-before-parent");
      view.ledger.options.acceptDeliveryInTransaction = async (tx, input) => {
        await guard(tx, input);
        if (
          input.phase === "after-share" &&
          input.identity.subjectId === phantomInput.id
        ) {
          invisibleEntered.release();
          await bounded(releaseInvisible.promise);
        }
      };
      const assertRetirement = view.ledger.assertRetirementPreparedLocked.bind(
        view.ledger,
      );
      let membershipRefused = false;
      view.ledger.assertRetirementPreparedLocked = async (...args) => {
        try {
          await assertRetirement(...args);
        } catch (error) {
          if (
            error instanceof Error &&
            /Native retirement dependency changed after locking/.test(
              error.message,
            )
          ) membershipRefused = true;
          throw error;
        }
      };
      const beforePhantom = await host.stage.executionBindings.read(record);
      const phantomArm = adoption.resume(session.secret, {
        caseId: record.caseId,
        adoptionKey,
      });
      void phantomArm.catch(() => {});
      let phantomAcceptance:
        | ReturnType<typeof view.dispatch.enqueue>
        | undefined;
      try {
        await bounded(beforePreparation.promise);
        phantomAcceptance = host.storage.client.$transaction(
          (tx) =>
            withPostgresExecutionTransaction({
              client: host.storage.client,
              transaction: tx,
            }, async () => {
              const receipt = await view.dispatch.enqueue(phantomInput);
              heldJob = receipt.jobId;
              await tx.$executeRaw(
                Prisma
                  .sql`UPDATE ${queueJobs} SET start_after=clock_timestamp()+interval '1 day'
            WHERE name=${view.ledger.options.queueName} AND id=${receipt.jobId}::uuid`,
              );
              return receipt;
            }),
          { timeout: 20_000 },
        );
        void phantomAcceptance.catch(() => {});
        await bounded(invisibleEntered.promise);
        releasePreparation.release();
        await bounded(nativeLocked.promise);
        releaseInvisible.release();
        const phantomReceipt = await bounded(phantomAcceptance);
        releaseNative.release();
        const blocked = await bounded(phantomArm);
        assert.equal(blocked.status, "prepared");
        assert.equal(
          membershipRefused,
          true,
          "the real nonlocking membership helper must refuse the newly committed native row under the parent",
        );
        assert.equal(
          (await adoption.status(session.secret, {
            caseId: record.caseId,
            adoptionKey,
          }))?.status,
          "prepared",
        );
        assert.equal(
          await host.storage.client.evolutionTargetBarrier.count({
            where: {
              ...record.scope,
              targetScopeKey: `request:${record.executionSpaceId}`,
              operatorId: scope.operatorId,
            },
          }),
          0,
        );
        const unchanged = await host.stage.executionBindings.read(record);
        assert.deepEqual(unchanged.pin, beforePhantom.pin);
        assert.equal(unchanged.state.revision, beforePhantom.state.revision);
        assert.equal(
          (await view.dispatch.inspect(phantomInput.identity, phantomInput.id))
            ?.status,
          "queued",
        );
        await host.storage.client.$executeRaw(
          Prisma.sql`UPDATE ${queueJobs} SET start_after=clock_timestamp()
          WHERE name=${view.ledger.options.queueName} AND id=${phantomReceipt.jobId}::uuid`,
        );
        heldJob = undefined;
        await eventually(async () =>
          (await view.dispatch.inspect(phantomInput.identity, phantomInput.id))
              ?.status === "completed"
            ? true
            : undefined
        );
      } finally {
        releasePreparation.release();
        releaseInvisible.release();
        releaseNative.release();
        view.ledger.assertRetirementPreparedLocked = assertRetirement;
        view.ledger.prepareRetirementBatch = prepareBatch;
        view.ledger.lockRetirementInTransaction = lockRetirement;
        view.ledger.options.acceptDeliveryInTransaction = guard;
      }

      // Arming first: pause the real first parent lock while its native/control
      // locks are held. A brand-new subject must not survive as enrollment.
      const armedParent = gate(), releaseArming = gate();
      let restoreStateLock: (() => void) | undefined;
      await host.stage.runtime.withInstructionAdoptionReservation(
        record,
        `hook-${adoptionKey}`,
        ({ stores }) => {
          const original = stores.state.lockMutationInTransaction.bind(
            stores.state,
          );
          let paused = false;
          stores.state.lockMutationInTransaction = async (tx) => {
            const token = await original(tx);
            if (!paused) {
              paused = true;
              armedParent.release();
              await bounded(releaseArming.promise);
            }
            return token;
          };
          restoreStateLock = () => {
            stores.state.lockMutationInTransaction = original;
          };
          return Promise.resolve();
        },
      );
      const observations = new PostgresProviderCallStore(host.storage.client);
      async function syntheticObservation(native: boolean) {
        // Explicit synthetic measurement, never an asserted physical call.
        // Only native=true binds an already real run; R1 may have no run yet.
        const binding = await host.stage.executionBindings.read(record);
        const run = native
          ? await host.storage.client.executionRun.findFirstOrThrow({
            where: {
              ...scope,
              threadId: initial.initialReceipt!.receipt.threadId,
            },
            orderBy: { generation: "desc" },
          })
          : null;
        if (run) {
          const pin = JSON.parse(run.pinJson).version;
          assert.equal(pin.digest, binding.pin.modelDigest);
          assert.equal(pin.repositoryVersion, binding.pin.source.version);
        }
        const [clock] = await host.storage.client.$queryRaw<
          Array<{ at: Date }>
        >(Prisma.sql`SELECT clock_timestamp() AS at`);
        assert(clock);
        const observationId = crypto.randomUUID();
        assert.equal(
          await observations.append(record.scope, {
            schemaVersion: 1,
            observationId,
            provider: "anthropic",
            configuredModel:
              "SYNTHETIC-qualification-not-a-physical-provider-call",
            startedAt: clock.at.toISOString(),
            endedAt: clock.at.toISOString(),
            elapsedMs: 0,
            outcome: "returned",
            usage: { input_tokens: 1, output_tokens: 1 },
            correlation: {
              ...UNKNOWN_PROVIDER_CALL_CORRELATION,
              executionScope: {
                ...record.scope,
                executionSpaceId: record.executionSpaceId,
              },
              scopeKind: "request",
              scopeId: record.caseId,
              caseId: record.caseId,
              operatorId: scope.operatorId,
              threadId: run?.threadId ?? null,
              runId: run?.runId ?? null,
              modelDigest: binding.pin.modelDigest,
              repositoryVersion: binding.pin.source.version,
            },
          }),
          "inserted",
        );
        return await host.storage.client.providerCallObservation
          .findUniqueOrThrow({
            where: {
              projectId_systemId_observationId: {
                ...record.scope,
                observationId,
              },
            },
          });
      }
      const r0Observation = await syntheticObservation(true);
      const [r0Cutoff] = await host.storage.client.$queryRaw<
        Array<{ at: Date }>
      >(Prisma.sql`SELECT clock_timestamp() AS at`);
      assert(r0Cutoff);
      const pausedR0 = startPausedCurrentRead({
        client: host.storage.client,
        scope: record.scope,
        cases: host.stage.conversations,
        control: host.stage.controls,
        secret: session.secret,
        caseId: record.caseId,
        expectedVersion: originalDelivery.modelPin.repositoryVersion!,
        clock: { now: () => r0Cutoff.at.toISOString() },
      });
      try {
        // This is a real completed SQL aggregate held before service delivery,
        // not a synthetic pin port. No physical-provider claim is made.
        await bounded(pausedR0.aggregated);
        assert.equal(
          pausedR0.stats.observedCalls,
          1,
          "actual R0 aggregate includes the explicitly synthetic observation",
        );
        const arming = adoption.resume(session.secret, {
          caseId: record.caseId,
          adoptionKey,
        });
        void arming.catch(() => {});
        const refusedInput = newDelivery("arming-first");
        let competing:
          | Promise<Awaited<ReturnType<typeof view.dispatch.enqueue>>>
          | undefined;
        try {
          await bounded(armedParent.promise);
          await assertParentExcludesUpdate();
          competing = view.dispatch.enqueue(refusedInput);
          // Attach rejection handling before releasing either contender.
          const competingResult = competing.then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          );
          releaseArming.release();
          const [adoptionResult, inputResult] = await bounded(
            Promise.allSettled([arming, competingResult]),
          );
          assert.equal(inputResult.status, "fulfilled");
          if (inputResult.status === "fulfilled") {
            assert.equal(inputResult.value.ok, false);
          }
          if (adoptionResult.status === "rejected") {
            // A bounded lock refusal is allowed. Only explicit same-intent resume
            // may finish; inspect committed receipt before asking for another effect.
            const known = await adoption.status(session.secret, {
              caseId: record.caseId,
              adoptionKey,
            });
            if (known?.status !== "adopted") {
              await completeActualAdoption({
                start: () =>
                  adoption.resume(session.secret, {
                    caseId: record.caseId,
                    adoptionKey,
                  }),
                resume: () =>
                  adoption.resume(session.secret, {
                    caseId: record.caseId,
                    adoptionKey,
                  }),
                diagnostics,
                transientBoundary: async () =>
                  await actualRequestWorkPending(
                    host.storage.client,
                    scope,
                    view.ledger.options,
                    (await host.stage.executionBindings.read(record)).state
                      .busy,
                  ),
                label: "Same-key completion after armed-first race",
              });
            }
          }
        } finally {
          releaseArming.release();
          restoreStateLock?.();
        }
        const adopted = await adoption.status(session.secret, {
          caseId: record.caseId,
          adoptionKey,
        });
        assert.equal(adopted?.status, "adopted");
        assert(adopted?.receipt);
        assert.equal(
          await view.dispatch.inspect(refusedInput.identity, refusedInput.id),
          null,
        );
        assert.equal(
          await host.storage.client.executionThreadBinding.count({
            where: { ...scope, identityJson: canonical(refusedInput.identity) },
          }),
          0,
        );
        assert.equal(
          await host.storage.client.operatorExecution.count({
            where: { ...scope, identityJson: canonical(refusedInput.identity) },
          }),
          0,
        );
        assert.equal(
          await host.storage.client.evolutionTargetBarrier.count({
            where: {
              ...record.scope,
              targetScopeKey: `request:${record.executionSpaceId}`,
              operatorId: scope.operatorId,
            },
          }),
          0,
        );
        const current = await host.stage.executionBindings.read(record);
        assert.equal(current.pin.source.version, source.head.source.version);
        assert.notEqual(
          current.pin.modelDigest,
          originalDelivery.modelPin.modelDigest,
        );

        pausedR0.release();
        await assert.rejects(
          pausedR0.result,
          (error) =>
            error instanceof ProviderResourceAccessError &&
            error.code === "PROVIDER_RESOURCE_VERSION_MISMATCH",
        );
        assert.equal(pausedR0.stats.readerCalls, 1);
        assert.equal(pausedR0.stats.executionCalls, 2);
      } finally {
        releaseArming.release();
        restoreStateLock?.();
        await pausedR0.settle();
      }

      await qualifyRetainedRequestAdoptionMemory(host, initial, retainedMemory);

      // Released barrier does not admit previously unaccepted R0. Every delivery
      // category uses the actual same enqueue fence, including a new binding.
      for (
        const kind of [
          "contribution",
          "command",
          "schedule",
          "notification",
        ] as const
      ) {
        const stale = newDelivery(`delayed-${kind}`, kind);
        await assert.rejects(() => view.dispatch.enqueue(stale));
        assert.equal(
          await view.dispatch.inspect(stale.identity, stale.id),
          null,
        );
        assert.equal(
          await host.storage.client.executionThreadBinding.count({
            where: { ...scope, identityJson: canonical(stale.identity) },
          }),
          0,
        );
      }
      let freshChecks = 0;
      view.ledger.options.acceptDeliveryInTransaction = () => {
        freshChecks++;
        return Promise.reject(
          new Error("Exact old replay must precede fresh admission"),
        );
      };
      try {
        const replay = await view.dispatch.enqueue(acceptedInput);
        assert.equal(replay.jobId, acceptedReceipt.jobId);
        assert.equal(replay.status, "completed");
        assert.equal(freshChecks, 0);
      } finally {
        view.ledger.options.acceptDeliveryInTransaction = guard;
      }
      assert.deepEqual(
        await host.storage.client.providerCallObservation.findUniqueOrThrow({
          where: {
            projectId_systemId_observationId: {
              ...record.scope,
              observationId: r0Observation.observationId,
            },
          },
        }),
        r0Observation,
      );
      const r1Observation = await syntheticObservation(false);
      const [r1Cutoff] = await host.storage.client.$queryRaw<
        Array<{ at: Date }>
      >(Prisma.sql`SELECT clock_timestamp() AS at`);
      assert(r1Cutoff);
      // A separate authenticated human session observes the same actual R1.
      // Revoke only that session in a different SQL client after aggregation;
      // the original execution capability/admission and main session survive.
      const primarySessionBefore = await host.storage.client
        .spaceControlCredential.findUniqueOrThrow({
          where: { id: initial.controller.sessionId },
        });
      const capabilityBefore = await host.storage.client.spaceControlCredential
        .findUniqueOrThrow({ where: { id: initial.controller.capabilityId } });
      const admissionBefore = await host.storage.client.spaceExecutionAdmission
        .findUniqueOrThrow({ where: { id: record.admissionId! } });
      const auxiliary = await host.stage.controls.exchange(
        initial.capability.secret,
      );
      const auxiliaryController = await host.stage.controls.authenticateSession(
        auxiliary.secret,
      );
      assert.equal(
        auxiliaryController.capabilityId,
        initial.controller.capabilityId,
      );
      assert.notEqual(
        auxiliaryController.sessionId,
        initial.controller.sessionId,
      );
      const auxiliaryBefore = await host.storage.client.spaceControlCredential
        .findUniqueOrThrow({ where: { id: auxiliaryController.sessionId } });
      const r1 = await host.stage.executionBindings.read(record);
      const pausedR1 = startPausedCurrentRead({
        client: host.storage.client,
        scope: record.scope,
        cases: host.stage.conversations,
        control: host.stage.controls,
        secret: auxiliary.secret,
        caseId: record.caseId,
        expectedVersion: r1.pin.source.version,
        clock: { now: () => r1Cutoff.at.toISOString() },
      });
      try {
        await bounded(pausedR1.aggregated);
        assert.equal(
          pausedR1.stats.observedCalls,
          1,
          "actual R1 aggregate excludes R0 and includes its explicitly synthetic observation",
        );
        const revoked = await competingClient.$transaction(async (tx) =>
          await tx.spaceControlCredential.updateMany({
            where: {
              ...record.scope,
              id: auxiliaryController.sessionId,
              kind: "session",
              status: "active",
              revision: auxiliaryBefore.revision,
              parentCapabilityId: initial.controller.capabilityId,
            },
            data: { status: "revoked", revision: auxiliaryBefore.revision + 1 },
          })
        );
        assert.equal(revoked.count, 1);
        pausedR1.release();
        await assert.rejects(
          pausedR1.result,
          (error) =>
            error instanceof ProviderResourceAccessError &&
            error.code === "PROVIDER_RESOURCE_FORBIDDEN",
        );
        assert.equal(pausedR1.stats.readerCalls, 1);
        assert.equal(pausedR1.stats.executionCalls, 2);
      } finally {
        await pausedR1.settle();
      }
      assert.deepEqual(
        await host.storage.client.spaceControlCredential.findUniqueOrThrow({
          where: { id: initial.controller.sessionId },
        }),
        primarySessionBefore,
      );
      assert.deepEqual(
        await host.storage.client.spaceControlCredential.findUniqueOrThrow({
          where: { id: initial.controller.capabilityId },
        }),
        capabilityBefore,
      );
      assert.deepEqual(
        await host.storage.client.spaceExecutionAdmission.findUniqueOrThrow({
          where: { id: record.admissionId! },
        }),
        admissionBefore,
      );
      assert.deepEqual(
        await host.storage.client.spaceControlCredential.findUniqueOrThrow({
          where: { id: auxiliaryController.sessionId },
        }),
        {
          ...auxiliaryBefore,
          status: "revoked",
          revision: auxiliaryBefore.revision + 1,
        },
      );
      assert.deepEqual(
        await host.storage.client.providerCallObservation.findUniqueOrThrow({
          where: {
            projectId_systemId_observationId: {
              ...record.scope,
              observationId: r0Observation.observationId,
            },
          },
        }),
        r0Observation,
      );
      assert.deepEqual(
        await host.storage.client.providerCallObservation.findUniqueOrThrow({
          where: {
            projectId_systemId_observationId: {
              ...record.scope,
              observationId: r1Observation.observationId,
            },
          },
        }),
        r1Observation,
      );
      assert.deepEqual(await isolation(), untouched);
      await qualifyRequestAdoptionControlRaces(database, host, diagnostics);
      assert.deepEqual(await isolation(), untouched);
      assert.deepEqual(
        await host.storage.client.spaceControlCredential.findUniqueOrThrow({
          where: { id: initial.controller.sessionId },
        }),
        primarySessionBefore,
      );
      assert.deepEqual(
        await host.storage.client.spaceControlCredential.findUniqueOrThrow({
          where: { id: initial.controller.capabilityId },
        }),
        capabilityBefore,
      );
      assert.deepEqual(
        await host.storage.client.spaceExecutionAdmission.findUniqueOrThrow({
          where: { id: record.admissionId! },
        }),
        admissionBefore,
      );
      assert.deepEqual(host.workerErrors, []);
    });
  },
});
