import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import type { NativeExecutionSession } from "../../src/adapters/out/native-execution/conversation.ts";
import type {
  ImmutableConsultationGroupManifest,
  ImmutableConsultationMemberOutcome,
} from "../../src/application/work/native-execution/contract.ts";
import {
  nativeExecutionIdentity,
  runtimeRevisionReference,
} from "../../src/application/work/native-execution/contract.ts";
import { immutableConsultationFixture } from "../support/immutable-consultation-fixture.ts";
import {
  openPostgresDurableRecoveryHost,
  openPostgresExecutionFixtureHost,
} from "../support/postgres-runtime-fixture.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import { closeCaseById } from "../../src/application/work/cases/runtime.ts";
import type { Case } from "../../src/domain/work/entities/cases.ts";
import {
  type ExecutionSql,
  withPostgresExecutionTransaction,
} from "../../src/adapters/out/postgres/execution-transaction.ts";
import { eventually } from "../support/eventually.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

function isRetiredClaim(error: unknown): boolean {
  return error instanceof Error &&
    (error.name === "AbortError" ||
      error.message.includes("STALE_EXECUTION_CLAIM"));
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error("Durable group recovery exceeded its bounded wait"),
            ),
          15_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Real claimed pg-boss session, real canonical history and production ledger.
 * Reading ports are deferred doubles; this does not qualify an external provider. */
async function productionFixture(f = immutableConsultationFixture()) {
  const host = await openPostgresExecutionFixtureHost({
    scope: {
      projectId: f.model.identity.projectId,
      systemId: "immutable-ledger-host",
    },
  });
  const storage = await host.storage.operator(f.model.identity.builderId);
  await storage.state.save(f.state, null);
  const delivery = {
    id: f.request.contribution.id,
    kind: "contribution" as const,
    identity: f.request.identity,
    modelPin: {
      modelDigest: f.model.version.digest,
      repositoryVersion: f.model.version.repositoryVersion,
    },
  };
  return {
    ...f,
    host,
    storage,
    delivery,
    async run(
      scenario: (
        session: NativeExecutionSession,
        manifest: ImmutableConsultationGroupManifest,
      ) => Promise<void>,
      parentFence?: (query: ExecutionSql) => Promise<void>,
      diagnosticPhase?: () => string,
    ) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      const done = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      await host.start(async () => {
        try {
          const session = parentFence
            ? await withPostgresExecutionTransaction({
              client: host.storage.client,
              fence: parentFence,
            }, () => host.native.ledger.open(f.request))
            : await host.native.ledger.open(f.request);
          await scenario(session, await f.manifest(session.runId));
          resolve();
        } catch (error) {
          reject(error);
          throw error;
        }
      });
      await host.native.dispatch.enqueue(delivery);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          done,
          new Promise<never>((_, fail) => {
            timer = setTimeout(() =>
              fail(
                new Error(
                  `Claimed immutable consultation scenario timed out (${
                    diagnosticPhase?.() ?? "handler"
                  })`,
                ),
              ), 15_000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function requestProductionFixture(delegated: boolean) {
  const seed = immutableConsultationFixture();
  const ownerId = delegated
    ? "immutable-case-owner"
    : seed.model.identity.builderId;
  const record: Case = {
    id: "immutable-request",
    number: 1,
    type: "request",
    objective: "Read exact sources",
    owner: ownerId,
    openedBy: ownerId,
    openedFrom: { conversationId: "designer-one" },
    modelPin: {
      digest: seed.model.version.digest,
      repositoryVersion: seed.model.version.repositoryVersion,
    },
    status: "open",
    createdAt: "2026-10-29T00:00:00.000Z",
  };
  seed.state.cases = delegated ? [] : [structuredClone(record)];
  seed.state.caseInvocation = delegated
    ? {
      kind: "delegated",
      work: {
        caseId: record.id,
        caseContext: {
          caseId: record.id,
          number: record.number,
          modelPin: structuredClone(record.modelPin),
          record: structuredClone(record),
        },
        callerId: ownerId,
        correlationId: "delegated-read",
        invocationId: "delegated-read",
        behaviorId: "consultation",
        targetNativeId: seed.model.identity.builderId,
        modelVersion: {
          digest: seed.model.version.digest,
          repositoryVersion: seed.model.version.repositoryVersion!,
        },
        fingerprint: "recorded-delegated-read",
        priorCandidateIds: [],
      },
    }
    : { kind: "local", caseId: record.id };
  seed.request.identity = nativeExecutionIdentity(
    seed.state,
    "conversation",
    "input-one",
  );
  seed.request.businessRevision = runtimeRevisionReference(seed.state);
  delete seed.state.messages[0].designerScopeId;
  seed.state.messages[0].caseId = record.id;
  const batch = seed.state.conversationBatches![0];
  delete batch.designerScopeId;
  batch.caseId = record.id;
  batch.invocationKey = seed.request.identity.invocationKey;
  const f = await productionFixture(seed);
  const ownerStorage = await f.host.storage.operator(ownerId);
  // Both connections in the runtime pool are deliberately occupied by the
  // racing transactions. Observe their locks through an independently owned
  // fixture client rather than queueing the observer behind the waiter.
  const observer = f.host.database.createClient();
  if (delegated) {
    const owner = structuredClone(seed.state);
    owner.id = "immutable-owner-state";
    owner.cases = [structuredClone(record)];
    owner.caseInvocation = { kind: "local", caseId: record.id };
    owner.executionModel!.identity.builderId = ownerId;
    owner.model!.builderId = ownerId;
    delete owner.conversationBatches;
    await ownerStorage.state.save(owner, null);
  }
  return {
    ...f,
    record,
    ownerStorage,
    async closure(outcome: "done" | "abandoned") {
      const next = (await ownerStorage.state.load())!;
      closeCaseById(next, record.id, outcome, {
        now: () => "2026-10-29T00:01:00.000Z",
      });
      const expected = next.revision;
      next.revision++;
      return { next, expected };
    },
    async waitForOwnerWaiter(blocker: number) {
      // Assert actual database blocking before releasing either transaction;
      // no sleep-based assumption about which operation acquired the row first.
      await eventually(async () => {
        const rows = await observer.$queryRawUnsafe<
          { pid: number }[]
        >(
          `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid)) AND query LIKE $2`,
          blocker,
          `%${f.host.database.schema}%OperatorRuntime%`,
        );
        return rows.length ? true : undefined;
      }, { timeoutMs: 15_000 });
    },
  };
}

for (const delegated of [false, true]) {
  Deno.test({
    name: `PostgreSQL ${
      delegated ? "delegated" : "local"
    } group registration commits before done closure and keeps the Case open until publication`,
    ignore: !postgresTestEnabled,
    async fn() {
      const f = await requestProductionFixture(delegated);
      const entered = barrier(), resume = barrier();
      let parked = false, blocker = 0;
      let phase = "waiting for the claimed handler";
      try {
        await f.run(async (session, manifest) => {
          const group = session.immutableConsultations;
          phase = "waiting for registration before commit";
          const registering = group.register(manifest);
          let closing: Promise<void> | undefined;
          let refusalResult: Promise<{ error?: unknown }> | undefined;
          // Observe rejection immediately so a failed assertion cannot leave an
          // unhandled rejection while the held transaction is being released.
          const registrationResult = registering.then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          try {
            await within(Promise.race([
              entered.promise,
              registering.then(() => {
                throw new Error(
                  "Registration committed without reaching its transaction boundary",
                );
              }),
            ]));
            const draft = await f.closure("done");
            // A separate HTTP closure has no ownership of this worker's claim.
            // Without this boundary the inherited withClaim ALS fence waits
            // on the registration's pg-boss job row before reaching the Case.
            closing = withPostgresExecutionTransaction({
              client: f.host.storage.client,
            }, () => f.ownerStorage.state.save(draft.next, draft.expected));
            const refused = rejects(closing, /awaits publication/);
            refusalResult = refused.then(() => ({}), (error) => ({ error }));
            phase =
              "observing the independent closure waiting on OperatorRuntime";
            await f.waitForOwnerWaiter(blocker);
            resume.release();
            phase = "committing registration and refusing closure";
            deepStrictEqual(await registering, manifest);
            await refused;
            equal(
              (await f.ownerStorage.state.load())!.cases![0].status,
              "open",
            );
            deepStrictEqual(
              (await group.pending()).map((item) => item.groupId),
              [manifest.groupId],
            );
            const outcomes: ImmutableConsultationMemberOutcome[] = [];
            phase = "settling registered member receipts";
            for (const member of manifest.members) {
              outcomes.push(
                await group.memberEffect(
                  manifest.groupId,
                  member,
                  f.node,
                  () => {
                    const result = f.outcome(manifest, member);
                    for (const message of result.messages) {
                      delete message.designerScopeId;
                      message.caseId = f.record.id;
                    }
                    return Promise.resolve(result);
                  },
                  () => Promise.resolve(),
                ),
              );
            }
            const publication = await f.publication(manifest, outcomes);
            phase = "saving canonical publication";
            await group.withPublicationFence(
              manifest.groupId,
              () => f.storage.state.save(publication.state, 0),
            );
            phase = "acknowledging publication";
            await group.publish(publication.receipt);
            phase = "closing the published Case";
            const done = await f.closure("done");
            await f.ownerStorage.state.save(done.next, done.expected);
            equal(
              (await f.ownerStorage.state.load())!.cases![0].status,
              "closed-done",
            );
          } finally {
            resume.release();
            await registrationResult;
            await closing?.catch(() => {});
            await refusalResult;
          }
        }, async (query) => {
          if (parked) return;
          const rows = await query(
            `SELECT "groupId" FROM "${f.host.database.schema}"."ImmutableConsultationGroup" WHERE "publicationJson" IS NULL`,
          );
          if (rows.rows.length) {
            parked = true;
            blocker = Number(
              (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
            );
            entered.release();
            await resume.promise;
          }
        }, () => phase);
      } finally {
        resume.release();
        await f.host.close();
      }
    },
  });

  Deno.test({
    name: `PostgreSQL done closure commits before ${
      delegated ? "delegated" : "local"
    } group registration and refuses the stale captured Case`,
    ignore: !postgresTestEnabled,
    async fn() {
      const f = await requestProductionFixture(delegated);
      const entered = barrier(), resume = barrier();
      try {
        await f.run(async (session, manifest) => {
          let fences = 0, blocker = 0;
          const draft = await f.closure("done");
          const closing = withPostgresExecutionTransaction({
            client: f.host.storage.client,
            fence: async (query) => {
              if (++fences === 2) {
                blocker = Number(
                  (await query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
                );
                entered.release();
                await resume.promise;
              }
            },
          }, () => f.ownerStorage.state.save(draft.next, draft.expected));
          const closeResult = closing.then(() => ({}), (error) => ({ error }));
          let refused: Promise<void> | undefined;
          let refusalResult: Promise<{ error?: unknown }> | undefined;
          try {
            await within(Promise.race([
              entered.promise,
              closing.then(() => {
                throw new Error(
                  "Closure committed without reaching its transaction boundary",
                );
              }),
            ]));
            const registering = session.immutableConsultations.register(
              manifest,
            );
            refused = rejects(
              registering,
              /IMMUTABLE_CONSULTATION_CASE_CLOSED/,
            );
            refusalResult = refused.then(() => ({}), (error) => ({ error }));
            await f.waitForOwnerWaiter(blocker);
            resume.release();
            await closing;
            await refused;
            equal((await session.immutableConsultations.pending()).length, 0);
            const durable = (await f.ownerStorage.state.load())!;
            equal(durable.cases![0].status, "closed-done");
            if (!delegated) {
              equal(
                durable.conversationBatches![0].calls.every((call) =>
                  call.status === "cancelled"
                ),
                true,
                "historical batches without a registered group retain ordinary closure",
              );
            }
          } finally {
            resume.release();
            await closeResult;
            await refusalResult;
          }
        });
      } finally {
        resume.release();
        await f.host.close();
      }
    },
  });
}

Deno.test({
  name:
    "PostgreSQL abandonment preserves an open delegated group and its unknown member receipt",
  ignore: !postgresTestEnabled,
  async fn() {
    const f = await requestProductionFixture(true);
    try {
      await f.run(async (session, manifest) => {
        await session.immutableConsultations.register(manifest);
        await rejects(
          () =>
            session.immutableConsultations.memberEffect(
              manifest.groupId,
              manifest.members[0],
              f.node,
              () => Promise.reject(new Error("Unknown read at closure")),
              () => Promise.resolve(),
            ),
          /Unknown read at closure/,
        );
        const done = await f.closure("done");
        await rejects(
          () => f.ownerStorage.state.save(done.next, done.expected),
          /awaits publication/,
        );
        const abandoned = await f.closure("abandoned");
        await f.ownerStorage.state.save(abandoned.next, abandoned.expected);
        equal(
          (await f.ownerStorage.state.load())!.cases![0].status,
          "closed-abandoned",
        );
        const [snapshot] = await f.host.native.ledger.inspect(
          f.model.identity.builderId,
        );
        deepStrictEqual(snapshot.openImmutableConsultationGroups, [
          manifest.groupId,
        ]);
        deepStrictEqual(snapshot.unsettledEffects, [
          manifest.members[0].effectKey,
        ]);
        const rows = await f.host.database.client.$queryRawUnsafe<
          { status: string; resultJson: string | null }[]
        >(
          `SELECT "status","resultJson" FROM "${f.host.database.schema}"."ExecutionEffect" WHERE "effectKey"=$1`,
          manifest.members[0].effectKey,
        );
        equal(rows[0].status, "unknown");
        equal(rows[0].resultJson, null);
      });
    } finally {
      await f.host.close();
    }
  },
});

Deno.test({
  name:
    "PostgreSQL immutable groups admit only registered siblings, preserve member refusal and reconcile canonical publication",
  ignore: !postgresTestEnabled,
  async fn() {
    const f = await productionFixture();
    let oldSession: NativeExecutionSession | undefined;
    try {
      await f.run(async (session, manifest) => {
        oldSession = session;
        const group = session.immutableConsultations;
        // An enclosing scalar receipt is an actual blocker, never an opaque
        // completed parent used to conceal the members' independent effects.
        await session.effect("scalar-parent", f.node, async () => {
          await rejects(
            () => group.register(manifest),
            /Unsettled native effects/,
          );
          return {};
        }, () => Promise.resolve());
        deepStrictEqual(await group.register(manifest), manifest);
        deepStrictEqual(
          await group.register(structuredClone(manifest)),
          manifest,
        );
        const [first, second] = manifest.members;
        let release!: () => void, entered!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const reading = group.memberEffect(
          manifest.groupId,
          first,
          f.node,
          async () => {
            entered();
            await gate;
            return f.outcome(manifest, first);
          },
          () => Promise.resolve(),
        );
        await Promise.race([
          started,
          reading.then(() => {}, (error) => Promise.reject(error)),
        ]);
        let scalarCalls = 0;
        try {
          await rejects(
            () =>
              session.effect("forbidden-mutation", f.node, () => {
                scalarCalls++;
                return Promise.resolve({});
              }, () =>
                Promise.reject(
                  new Error("Do not relabel an open group as scalar refusal"),
                )),
            /Unpublished immutable/,
          );
          equal(scalarCalls, 0);
          const changed = structuredClone(second!);
          changed.request.query = "forged";
          changed.argumentsDigest = await executionDigest(changed.request);
          await rejects(
            () =>
              group.memberEffect(
                manifest.groupId,
                changed,
                f.node,
                () => Promise.resolve(f.outcome(manifest, changed)),
                () => Promise.resolve(),
              ),
            /MEMBER_MISMATCH/,
          );
          const foreign = structuredClone(manifest);
          foreign.groupId += ":foreign";
          const { manifestDigest: _digest, ...body } = foreign;
          foreign.manifestDigest = await executionDigest(body);
          await rejects(() => group.register(foreign), /Unpublished immutable/);
          const refused = await group.memberEffect(
            manifest.groupId,
            second!,
            f.node,
            () => {
              throw new Error("A refused member must not execute");
            },
            () =>
              Promise.reject(
                new Error("Current authority refused this member"),
              ),
          );
          equal(refused.result.status, "refused");
          const [snapshot] = await f.host.native.ledger.inspect(
            f.model.identity.builderId,
          );
          equal(snapshot.status, "running");
          deepStrictEqual(snapshot.openImmutableConsultationGroups, [
            manifest.groupId,
          ]);
          release();
          const successful = await reading;
          const publication = await f.publication(manifest, [
            successful,
            refused,
          ]);
          await rejects(
            () => group.publish(publication.receipt),
            /Canonical business revision is unavailable/,
          );
          const beforePublication = await f.host.native.ledger.inspect(
            f.model.identity.builderId,
          );
          equal(beforePublication[0].unsettledEffects.length, 0);
          deepStrictEqual(
            beforePublication[0].openImmutableConsultationGroups,
            [manifest.groupId],
          );
          await group.withPublicationFence(manifest.groupId, async () => {
            await f.storage.state.save(publication.state, 0);
          });
          deepStrictEqual(
            await group.publish(publication.receipt),
            publication.receipt,
          );
          deepStrictEqual(
            await group.publish(structuredClone(publication.receipt)),
            publication.receipt,
          );
          equal((await group.pending()).length, 0);
          deepStrictEqual(
            await group.memberEffect(manifest.groupId, first, f.node, () => {
              throw new Error("Completed read must never repeat");
            }, () => {
              throw new Error("Completed receipt admission must never repeat");
            }),
            successful,
          );
          await session.effect(
            "after-joined-group",
            f.node,
            () => Promise.resolve({}),
            () => Promise.resolve(),
          );
          const durable = await f.storage.state.load();
          equal(
            durable!.messages.filter((message) =>
              message.id === successful.messages[0].id
            ).length,
            1,
          );
          await rejects(() =>
            f.host.database.client.$executeRawUnsafe(
              `UPDATE "${f.host.database.schema}"."ImmutableConsultationGroup" SET "manifestJson"='{}' WHERE "groupId"=$1`,
              manifest.groupId,
            ), /immutable consultation membership/i);
          const { members: _members, ...missingMembers } = manifest;
          missingMembers.groupId += ":missing-members";
          await rejects(() =>
            f.host.database.client.$executeRawUnsafe(
              `INSERT INTO "${f.host.database.schema}"."ImmutableConsultationGroup" ("projectId","systemId","executionSpaceId","operatorId","threadId","groupId","runId","contributionId","manifestDigest","manifestJson","registeredAt") SELECT "projectId","systemId","executionSpaceId","operatorId","threadId",$1,"runId","contributionId","manifestDigest",$2,clock_timestamp() FROM "${f.host.database.schema}"."ImmutableConsultationGroup" WHERE "groupId"=$3`,
              missingMembers.groupId,
              JSON.stringify(missingMembers),
              manifest.groupId,
            ), /ImmutableConsultationGroup_manifest_check/);
        } finally {
          release();
          await reading;
        }
      });
      await eventually(async () => {
        const receipt = await f.host.native.dispatch.inspect(
          f.delivery.identity,
          f.delivery.id,
        );
        return receipt?.status === "completed" ? receipt : undefined;
      }, { timeoutMs: 15_000 });
      await rejects(
        () => oldSession!.immutableConsultations.pending(),
        isRetiredClaim,
      );
    } finally {
      await f.host.close();
    }
  },
});

for (const interrupted of [false, true]) {
  Deno.test({
    name: interrupted
      ? "PostgreSQL refuses contribution completion with an unknown read"
      : "PostgreSQL retries a returned pending-publication group without repeating settled reads",
    ignore: !postgresTestEnabled,
    async fn() {
      const f = await productionFixture();
      let groupId = "";
      let attempts = 0, reads = 0;
      try {
        await f.run(async (session, manifest) => {
          attempts++;
          groupId = manifest.groupId;
          await session.immutableConsultations.register(manifest);
          if (interrupted) {
            await rejects(
              () =>
                session.immutableConsultations.memberEffect(
                  manifest.groupId,
                  manifest.members[0],
                  f.node,
                  () =>
                    Promise.reject(
                      new Error("Interrupted immutable technical reader"),
                    ),
                  () => Promise.resolve(),
                ),
              /Interrupted immutable/,
            );
            await rejects(
              () =>
                session.immutableConsultations.memberEffect(
                  manifest.groupId,
                  manifest.members[1]!,
                  f.node,
                  () =>
                    Promise.resolve(f.outcome(manifest, manifest.members[1]!)),
                  () => Promise.resolve(),
                ),
              /Unsettled native effects/,
            );
          } else {
            const outcomes: ImmutableConsultationMemberOutcome[] = [];
            for (const member of manifest.members) {
              outcomes.push(
                await session.immutableConsultations.memberEffect(
                  manifest.groupId,
                  member,
                  f.node,
                  () => {
                    reads++;
                    return Promise.resolve(f.outcome(manifest, member));
                  },
                  () => Promise.resolve(),
                ),
              );
            }
            if (attempts > 1) {
              const publication = await f.publication(manifest, outcomes);
              await session.immutableConsultations.withPublicationFence(
                manifest.groupId,
                async () => {
                  await f.storage.state.save(publication.state, 0);
                },
              );
              await session.immutableConsultations.publish(publication.receipt);
            }
          }
          // First return deliberately omits publication. Only the exact
          // recoverable retry may finish it using the existing member receipts.
        });
        await eventually(async () => {
          const receipt = await f.host.native.dispatch.inspect(
            f.delivery.identity,
            f.delivery.id,
          );
          return receipt?.status === (interrupted ? "uncertain" : "completed")
            ? receipt
            : undefined;
        }, { timeoutMs: 15_000 });
        const [snapshot] = await f.host.native.ledger.inspect(
          f.model.identity.builderId,
        );
        deepStrictEqual(
          snapshot.openImmutableConsultationGroups ?? [],
          interrupted ? [groupId] : [],
        );
        equal(snapshot.unsettledEffects.length, interrupted ? 1 : 0);
        const rows = await f.host.database.client.$queryRawUnsafe<
          { status: string; resultJson: string | null }[]
        >(
          `SELECT "status","resultJson" FROM "${f.host.database.schema}"."ExecutionEffect" ORDER BY "effectKey"`,
        );
        equal(rows.length, interrupted ? 1 : 2);
        if (interrupted) {
          equal(rows[0].status, "unknown");
          await rejects(() =>
            f.host.database.client.$executeRawUnsafe(
              `UPDATE "${f.host.database.schema}"."ExecutionEffect" SET "status"='completed',"resultJson"='{}' WHERE "status"='unknown'`,
            ), /settled or unknown effect/i);
        } else {
          equal(rows.every((row) => row.status === "completed"), true);
          equal(attempts, 2);
          equal(
            reads,
            2,
            "the retry reconstructs both known receipts without reading again",
          );
        }
        const state = await f.storage.state.load();
        equal(state!.messages.length, interrupted ? 1 : 3);
      } finally {
        await f.host.close();
      }
    },
  });
}

for (const afterCanonicalSave of [false, true]) {
  Deno.test({
    name: `PostgreSQL reopens a killed immutable group ${
      afterCanonicalSave
        ? "after canonical save before publication acknowledgement"
        : "after member receipts before publication"
    } without replaying reads`,
    ignore: !postgresTestEnabled,
    async fn() {
      const f = immutableConsultationFixture();
      const recovery = await openPostgresDurableRecoveryHost({
        scope: {
          projectId: f.model.identity.projectId,
          systemId: "immutable-group-recovery-host",
        },
      });
      let release!: () => void,
        ready!: () => void,
        notReady!: (error: unknown) => void,
        orphanSettled!: () => void;
      const parked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reachedBoundary = new Promise<void>((resolve, reject) => {
        ready = resolve;
        notReady = reject;
      });
      const orphanDone = new Promise<void>((resolve) => {
        orphanSettled = resolve;
      });
      let parkedAttempt = false, orphanFailure: unknown;
      let groupId = "", runId = "", reads = 0;
      try {
        const first = await recovery.openSession();
        const initialStorage = await first.storage.operator(
          f.model.identity.builderId,
        );
        await initialStorage.state.save(f.state, null);
        await first.start(async () => {
          try {
            const session = await first.native.ledger.open(f.request);
            const manifest = await f.manifest(session.runId);
            groupId = manifest.groupId;
            runId = manifest.runId;
            await session.immutableConsultations.register(manifest);
            const outcomes: ImmutableConsultationMemberOutcome[] = [];
            for (const member of manifest.members) {
              outcomes.push(
                await session.immutableConsultations.memberEffect(
                  manifest.groupId,
                  member,
                  f.node,
                  () => {
                    reads++;
                    return Promise.resolve(f.outcome(manifest, member));
                  },
                  () => Promise.resolve(),
                ),
              );
            }
            const publication = await f.publication(manifest, outcomes);
            if (afterCanonicalSave) {
              await session.immutableConsultations.withPublicationFence(
                manifest.groupId,
                async () => {
                  await initialStorage.state.save(publication.state, 0);
                },
              );
            }
            parkedAttempt = true;
            ready();
            await parked;
            // The orphan must be fenced even if its proposed receipt is now
            // identical to the successor's accepted publication.
            await session.immutableConsultations.publish(publication.receipt);
          } catch (error) {
            orphanFailure = error;
            if (!parkedAttempt) notReady(error);
            throw error;
          } finally {
            orphanSettled();
          }
        });
        const delivery = {
          id: f.request.contribution.id,
          kind: "contribution" as const,
          identity: f.request.identity,
          modelPin: {
            modelDigest: f.model.version.digest,
            repositoryVersion: f.model.version.repositoryVersion,
          },
        };
        await first.native.dispatch.enqueue(delivery);
        await within(reachedBoundary);
        equal(reads, 2);
        const [before] = await first.native.ledger.inspect(
          f.model.identity.builderId,
        );
        equal(before.unsettledEffects.length, 0);
        deepStrictEqual(before.openImmutableConsultationGroups, [groupId]);
        await first.kill();
        const successor = await recovery.openSession();
        const storage = await successor.storage.operator(
          f.model.identity.builderId,
        );
        let resumed!: () => void, resumeFailed!: (error: unknown) => void;
        const resumedPublication = new Promise<void>((resolve, reject) => {
          resumed = resolve;
          resumeFailed = reject;
        });
        await successor.start(async () => {
          try {
            const session = await successor.native.ledger.open(f.request);
            equal(
              session.runId,
              runId,
              "the queue retry retains the logical run",
            );
            const manifest = await f.manifest(session.runId);
            equal(manifest.groupId, groupId);
            deepStrictEqual(
              await session.immutableConsultations.register(manifest),
              manifest,
            );
            const outcomes: ImmutableConsultationMemberOutcome[] = [];
            for (const member of manifest.members) {
              outcomes.push(
                await session.immutableConsultations.memberEffect(
                  manifest.groupId,
                  member,
                  f.node,
                  () => {
                    reads++;
                    throw new Error(
                      "A durable completed immutable read was replayed",
                    );
                  },
                  () => Promise.resolve(),
                ),
              );
            }
            const publication = await f.publication(manifest, outcomes);
            await session.immutableConsultations.withPublicationFence(
              manifest.groupId,
              async () => {
                const current = await storage.state.load();
                if (afterCanonicalSave) {
                  equal(current!.revision, 1);
                  equal(
                    current!.conversationBatches![0].immutableGroup!
                      .publication!.publicationDigest,
                    publication.receipt.publicationDigest,
                  );
                } else {
                  equal(current!.revision, 0);
                  await storage.state.save(publication.state, 0);
                }
              },
            );
            deepStrictEqual(
              await session.immutableConsultations.publish(publication.receipt),
              publication.receipt,
            );
            equal((await session.immutableConsultations.pending()).length, 0);
            resumed();
          } catch (error) {
            resumeFailed(error);
            throw error;
          }
        });
        await within(resumedPublication);
        await eventually(async () => {
          const receipt = await successor.native.dispatch.inspect(
            delivery.identity,
            delivery.id,
          );
          return receipt?.status === "completed" ? receipt : undefined;
        }, { timeoutMs: 15_000 });
        release();
        await within(orphanDone);
        equal(
          isRetiredClaim(orphanFailure),
          true,
          "the killed worker cannot acknowledge a publication",
        );
        equal(reads, 2);
        const durable = await storage.state.load();
        equal(
          durable!.revision,
          1,
          "recovery does not repeat an already saved canonical publication",
        );
        equal(durable!.messages.length, 3);
        equal(new Set(durable!.messages.map((message) => message.id)).size, 3);
        const groups = await recovery.database.client.$queryRawUnsafe<
          { count: bigint }[]
        >(
          `SELECT count(*) FROM "${recovery.database.schema}"."ImmutableConsultationGroup" WHERE "publicationJson" IS NOT NULL`,
        );
        equal(groups[0].count, 1n);
        const effects = await recovery.database.client.$queryRawUnsafe<
          { status: string }[]
        >(
          `SELECT "status" FROM "${recovery.database.schema}"."ExecutionEffect"`,
        );
        equal(effects.length, 2);
        equal(effects.every((effect) => effect.status === "completed"), true);
      } finally {
        release();
        if (parkedAttempt) await within(orphanDone).catch(() => {});
        await recovery.close();
      }
    },
  });
}
