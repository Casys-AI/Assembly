/** Actual native/SQL control fences on owned normal Requests. No authority,
 * source/model pin, native run, history, clock or permission port is substituted. */
import assert from "node:assert/strict";
import type { RequestAdoptionStatus } from "../../src/application/model/evolution/request-adoption-ports.ts";
import { PostgresPrimarySpaceControlSource } from "../../src/adapters/out/postgres/primary-space-control-source.ts";
import { PostgresSpaceCredentials } from "../../src/adapters/out/postgres/request-space-control-store.ts";
import {
  postgresQualifiedTable,
  Prisma,
} from "../../src/adapters/out/postgres/client.ts";
import { CryptographicSpaceSecrets } from "../../src/adapters/work/space-control-secrets.ts";
import { createRequestSpaceControls } from "../../src/composition/space-controls.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { sha256 } from "../../src/domain/primitives/execution-digest.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces.ts";
import type { PostgresTestDatabase } from "./postgres.ts";
import {
  actualRequestWorkPending,
  type observeAdoptionTransactions,
} from "./request-adoption-diagnostics.ts";
import {
  openInitialNormalRequest,
  type openNormalAdmissionWitnessHost,
} from "./request-source-admission-normal-host.ts";
import { normalInstructionChange } from "./request-source-admission-qualification.ts";

type Host = Awaited<ReturnType<typeof openNormalAdmissionWitnessHost>>;
type Initial = Awaited<ReturnType<typeof openInitialNormalRequest>>;
type Diagnostics = ReturnType<typeof observeAdoptionTransactions>;
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function bounded<T>(promise: Promise<T>, timeoutMs = 30_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owned control-race gate did not settle")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
async function until(
  read: () => Promise<boolean>,
  timing = { timeoutMs: 30_000, pollMs: 25 },
) {
  const end = Date.now() + timing.timeoutMs;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, timing.pollMs));
  }
  throw new Error("Owned control-race condition did not settle");
}

function errorCategory(error: unknown) {
  if (!error || typeof error !== "object") return "unclassified";
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  return error instanceof Error &&
      /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : "unclassified";
}

export async function qualifyRequestAdoptionControlRaces(
  database: PostgresTestDatabase,
  host: Host,
  diagnostics: Diagnostics,
) {
  const client = host.storage.client, peer = database.createClient();
  const primary = new PostgresPrimarySpaceControlSource(peer, {
    ...host.storage.primarySpaceControl.binding,
    primaryOperatorId: host.storage.primarySpaceControl.runtimeScope.operatorId,
  });
  const competing = createRequestSpaceControls({
    client: peer,
    scope: host.storage.scope,
    primarySpaceControl: primary,
  });
  const adoption = host.stage.adoption!;
  assert(adoption);
  async function setup() {
    const initial = await openInitialNormalRequest(host), { record } = initial;
    const proposed = await host.revisions.propose(initial.session.secret, {
      caseId: record.caseId,
      expectedVersion: host.source.version,
      changes: [normalInstructionChange(host.source.sources)],
      reason: "Owned before-effect control-fence qualification",
    });
    const accepted = await host.revisions.accept(initial.session.secret, {
      caseId: record.caseId,
      proposalId: proposed.id,
    });
    const checkpoint = diagnostics.checkpoint();
    let lastQueue: unknown = null;
    // Source admission can commit before retained Git/native proof recovery and
    // final queue settlement. This setup alone gets 90s below the 300s writer
    // lease; the control/expiry race gates retain their original 30s bounds.
    await until(async () => {
      const command = await host.backend.queue.get(
        host.backend.project.id,
        accepted.commandId,
      );
      lastQueue = command
        ? {
          state: command.state,
          attempts: command.attempts,
          fence: command.fence,
          updatedAt: command.updatedAt,
          leaseExpiresAt: command.leaseExpiresAt ?? null,
          publishedVersion: command.publishedVersion ?? null,
          errorCategory: command.lastError?.code
            ? errorCategory({ code: command.lastError.code })
            : null,
        }
        : null;
      assert(!["refused", "needs-decision"].includes(command?.state ?? ""));
      return command?.state === "published";
    }, { timeoutMs: 90_000, pollMs: 250 }).catch(async (error: unknown) => {
      // Read D2 only once on failure, not during every publication poll.
      let admittedHead: unknown = null,
        admittedHeadReadError: string | null = null;
      try {
        const chain = await bounded(
          host.sourceAdmission.admittedSource(record),
          15_000,
        );
        admittedHead = {
          revision: chain.head.revision,
          manifestDigest: chain.head.manifestDigest,
          sourceVersion: chain.head.source.version,
        };
      } catch (headError) {
        admittedHeadReadError = errorCategory(headError);
      }
      const failures = diagnostics.since(checkpoint);
      throw new Error(
        `Owned control source-publication gate failed: ${
          JSON.stringify({
            commandId: accepted.commandId,
            failureCategory: errorCategory(error),
            queue: lastQueue,
            admittedHead,
            admittedHeadReadError,
            nativeWorkerErrors: {
              count: host.workerErrors.length,
              categories: host.workerErrors.slice(-8).map(errorCategory),
            },
            transactionFailures: {
              count: failures.length,
              recent: failures.slice(-8).map((failure) => ({
                sequence: failure.sequence,
                categories: [
                  "P2002",
                  "P2010",
                  "P2034",
                  "55P03",
                  "40P01",
                  "40001",
                  "23514",
                  "23505",
                ].filter((code) => failure.error.includes(code)),
              })),
            },
          })
        }`,
      );
    });
    const chain = await host.sourceAdmission.admittedSource(record);
    assert.notEqual(
      chain.head.source.version,
      record.base!.manifest.source!.sourceVersion,
    );
    await until(async () =>
      !await actualRequestWorkPending(
        client,
        {
          ...record.scope,
          executionSpaceId: record.executionSpaceId,
          operatorId: host.primaryOperatorId,
        },
        initial.view.ledger.options,
        (await host.stage.executionBindings.read(record)).state.busy,
      )
    );
    return { ...initial, candidate: chain.head.source.version };
  }
  async function facts(initial: Initial) {
    const output: Record<string, { count: number; sha256: string }> = {};
    for (
      const table of [
        "RuntimeState",
        "RuntimeRevision",
        "ExecutionThreadBinding",
        "OperatorExecution",
        "ExecutionRun",
        "ExecutionContribution",
        "ExecutionEffect",
        "ImmutableConsultationGroup",
        "SpaceManifest",
      ]
    ) {
      const rows = await client.$queryRaw<Array<{ content: string }>>(
        Prisma.sql`
        SELECT row_to_json(t)::text AS "content" FROM ${
          postgresQualifiedTable(client, table)
        } t
        WHERE t."projectId"=${initial.record.scope.projectId} AND t."systemId"=${initial.record.scope.systemId}
          AND t."executionSpaceId"=${initial.record.executionSpaceId} ORDER BY "content" LIMIT 257`,
      );
      assert(rows.length <= 256);
      output[table] = {
        count: rows.length,
        sha256: await sha256(canonical(rows)),
      };
    }
    return output;
  }
  async function noEffect(
    initial: Initial,
    before: Awaited<ReturnType<typeof facts>>,
    result: RequestAdoptionStatus,
  ) {
    assert.equal(result.status, "prepared");
    assert.equal(result.receipt, undefined);
    assert(result.blockers.length > 0);
    assert.deepEqual(await facts(initial), before);
    assert.equal(
      await client.evolutionTargetBarrier.count({
        where: {
          ...initial.record.scope,
          targetScopeKey: `request:${initial.record.executionSpaceId}`,
        },
      }),
      0,
    );
  }
  async function controlFacts(initial: Initial) {
    const [capability, session, admission, space, mainParent] = await Promise
      .all([
        client.spaceControlCredential.findUniqueOrThrow({
          where: { id: initial.controller.capabilityId },
        }),
        client.spaceControlCredential.findUniqueOrThrow({
          where: { id: initial.controller.sessionId },
        }),
        client.spaceExecutionAdmission.findUniqueOrThrow({
          where: { id: initial.record.admissionId! },
        }),
        client.executionSpace.findFirstOrThrow({
          where: {
            ...initial.record.scope,
            executionSpaceId: initial.record.executionSpaceId,
          },
        }),
        client.operatorRuntime.findFirstOrThrow({
          where: primary.runtimeScope,
        }),
      ]);
    return { capability, session, admission, space, mainParent };
  }
  function input(initial: Initial & { candidate: string }, label: string) {
    return {
      caseId: initial.record.caseId,
      adoptionKey: `${label}-${crypto.randomUUID()}`,
      expectedAdmittedVersion: initial.candidate,
      expectedExecutingDigest: initial.state.executionModel!.version.digest,
    };
  }
  async function beforeControl(
    initial: Initial & { candidate: string },
    label: string,
    winner: () => Promise<() => Promise<void>>,
    expected: RegExp,
  ) {
    const ledger = initial.view.ledger,
      original = ledger.lockRetirementInTransaction;
    const entered = gate(),
      proceed = gate(),
      checkpoint = diagnostics.checkpoint();
    const before = await facts(initial);
    let reached = false;
    ledger.lockRetirementInTransaction = async (tx, packet) => {
      const token = await Reflect.apply(original, ledger, [tx, packet]);
      if (!reached) {
        reached = true;
        entered.release();
        await bounded(proceed.promise);
      }
      return token;
    };
    const attempt = adoption.prepare(
      initial.session.secret,
      input(initial, label),
    );
    const settled = attempt.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    let finish: (() => Promise<void>) | undefined;
    try {
      await bounded(Promise.race([
        entered.promise,
        settled.then(() => {
          throw new Error(`${label} stopped before actual native locks`);
        }),
      ]));
      finish = await winner();
      // Capture the independently committed winner, including its intentional
      // revocation/closure. The losing adoption may change only its dossier.
      const winningControls = await controlFacts(initial);
      proceed.release();
      const result = await bounded(attempt);
      const failures = diagnostics.since(checkpoint);
      assert(
        failures.some((failure) => expected.test(failure.error)),
        `${label} must observe its actual control/lock refusal: ${
          JSON.stringify(failures)
        }`,
      );
      await noEffect(initial, before, result);
      assert.deepEqual(await controlFacts(initial), winningControls);
    } finally {
      proceed.release();
      try {
        await bounded(settled);
      } finally {
        ledger.lockRetirementInTransaction = original;
        await finish?.();
      }
    }
  }

  const initial = await setup();
  const initialControls = await controlFacts(initial);
  // A PRIMARY writer locks the real parent without changing stored Main bytes.
  // This proves serialization only, not a changed-policy semantic refusal.
  await beforeControl(initial, "primary-lock", async () => {
    const entered = gate(), release = gate();
    const holder = peer.$transaction(async (tx) => {
      const changed = await tx.$executeRaw(
        Prisma.sql`UPDATE ${postgresQualifiedTable(peer, "OperatorRuntime")}
        SET "operatorId"="operatorId" WHERE "projectId"=${host.storage.scope.projectId}
        AND "systemId"=${host.storage.scope.systemId} AND "executionSpaceId"='main'
        AND "operatorId"=${primary.runtimeScope.operatorId}`,
      );
      assert.equal(changed, 1);
      entered.release();
      await bounded(release.promise);
    }, { timeout: 10_000 });
    const settled = holder.then(() => undefined, () => undefined);
    try {
      await bounded(Promise.race([
        entered.promise,
        holder.then(() => {
          throw new Error("PRIMARY holder ended before observation");
        }),
      ]));
    } catch (error) {
      release.release();
      await settled;
      throw error;
    }
    return async () => {
      release.release();
      await holder;
    };
  }, /lock timeout|55P03/);
  assert.deepEqual(await controlFacts(initial), initialControls);

  // Short child issuance uses the production store and real database time.
  // Expiry is never edited, and the long execution capability is not renewed.
  const [issued] = await peer.$queryRaw<Array<{ at: Date; expiresAt: Date }>>(
    Prisma.sql`
    WITH clock AS MATERIALIZED (SELECT date_trunc('milliseconds',clock_timestamp()) AS at)
    SELECT at, at+interval '20 seconds' AS "expiresAt" FROM clock`,
  );
  assert(issued);
  const secrets = new CryptographicSpaceSecrets(),
    shortSecret = secrets.randomSecret();
  const shortId = crypto.randomUUID(),
    credentials = new PostgresSpaceCredentials(
      client,
      host.storage.primarySpaceControl,
    );
  await credentials.insert({
    id: shortId,
    kind: "session",
    parentCapabilityId: initial.controller.capabilityId,
    ownerId: initial.controller.ownerId,
    authority: structuredClone(initial.controller.authority),
    secretHash: await requestSpaceDigest({ secret: shortSecret }),
    revision: 0,
    status: "active",
    expiresAt: issued.expiresAt.toISOString(),
    createdAt: issued.at.toISOString(),
  });
  const shortController = await host.stage.controls.authenticateSession(
    shortSecret,
  );
  assert.equal(shortController.sessionId, shortId);
  assert.equal(shortController.capabilityId, initial.controller.capabilityId);
  const shortBefore = await client.spaceControlCredential.findUniqueOrThrow({
    where: { id: shortId },
  });
  const beforeExpiryControls = await controlFacts(initial);
  const beforeExpiry = await facts(initial),
    beforeAdmission = await client.spaceExecutionAdmission.findUniqueOrThrow({
      where: { id: initial.record.admissionId! },
    });
  const prepared = gate(),
    enterSql = gate(),
    parentHeld = gate(),
    cutoff = gate();
  const ledger = initial.view.ledger, prepare = ledger.prepareRetirementBatch;
  let restoreParent: (() => void) | undefined;
  await host.stage.runtime.withInstructionAdoptionReservation(
    initial.record,
    `cutoff-hook-${crypto.randomUUID()}`,
    ({ stores }) => {
      const lock = stores.state.lockMutationInTransaction;
      let first = true;
      stores.state.lockMutationInTransaction = async (tx) => {
        const token = await Reflect.apply(lock, stores.state, [tx]);
        if (first) {
          first = false;
          parentHeld.release();
          await bounded(cutoff.promise, 3_000);
        }
        return token;
      };
      restoreParent = () => {
        stores.state.lockMutationInTransaction = lock;
      };
      return Promise.resolve();
    },
  );
  ledger.prepareRetirementBatch = async (...args) => {
    const packet = await Reflect.apply(prepare, ledger, args);
    prepared.release();
    await bounded(enterSql.promise);
    return packet;
  };
  const expiryCheckpoint = diagnostics.checkpoint();
  const expiring = adoption.prepare(
    shortSecret,
    input(initial, "database-expiry"),
  );
  const expiredSettled = expiring.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  async function remaining() {
    const [row] = await peer.$queryRaw<Array<{ milliseconds: number }>>(
      Prisma.sql`
      SELECT extract(epoch FROM (${shortBefore.expiresAt}::timestamptz-clock_timestamp()))::double precision*1000 AS milliseconds`,
    );
    assert(row);
    return row.milliseconds;
  }
  try {
    await bounded(Promise.race([
      prepared.promise,
      expiredSettled.then(() => {
        throw new Error("Expiry witness ended before authentic preparation");
      }),
    ]));
    assert(
      await remaining() > 0,
      "short session must still be live after real preparation",
    );
    await until(async () => await remaining() <= 2_000);
    assert(await remaining() > 0, "session must enter SQL while live");
    enterSql.release();
    await bounded(Promise.race([
      parentHeld.promise,
      expiredSettled.then(() => {
        throw new Error("Expiry witness ended before all actual locks");
      }),
    ]));
    assert(
      await remaining() > 0,
      "cutoff pause must follow successful live credential checks",
    );
    await until(async () => await remaining() <= 0);
    cutoff.release();
    const result = await bounded(expiring);
    assert(
      diagnostics.since(expiryCheckpoint).some((failure) =>
        failure.error.includes(
          "Current human control or execution admission expired before adoption.",
        )
      ),
    );
    await noEffect(initial, beforeExpiry, result);
    assert.deepEqual(await controlFacts(initial), beforeExpiryControls);
    assert.deepEqual(
      await client.spaceControlCredential.findUniqueOrThrow({
        where: { id: shortId },
      }),
      shortBefore,
    );
    assert.deepEqual(
      await client.spaceExecutionAdmission.findUniqueOrThrow({
        where: { id: initial.record.admissionId! },
      }),
      beforeAdmission,
    );
    await host.stage.controls.revalidate(initial.controller);
  } finally {
    enterSql.release();
    cutoff.release();
    try {
      await bounded(expiredSettled);
    } finally {
      ledger.prepareRetirementBatch = prepare;
      restoreParent?.();
    }
  }

  // Revocation is terminal; retain its real rows and use a distinct Case below.
  await beforeControl(initial, "capability-revoke", async () => {
    await competing.controls.revokeCapability(initial.controller);
    const capability = await peer.spaceControlCredential.findUniqueOrThrow({
      where: { id: initial.controller.capabilityId },
    });
    const admission = await peer.spaceExecutionAdmission.findUniqueOrThrow({
      where: { id: initial.record.admissionId! },
    });
    assert.deepEqual(capability, {
      ...initialControls.capability,
      status: "revoked",
      revision: initialControls.capability.revision + 1,
    });
    assert.deepEqual(admission, {
      ...beforeAdmission,
      status: "revoked",
      revision: beforeAdmission.revision + 1,
    });
    const controls = await controlFacts(initial);
    assert.deepEqual(controls.session, initialControls.session);
    assert.deepEqual(controls.space, initialControls.space);
    assert.deepEqual(controls.mainParent, initialControls.mainParent);
    return () => Promise.resolve();
  }, /The current space control or execution admission is unavailable/);

  const closing = await setup();
  const beforeClosure = await controlFacts(closing);
  await beforeControl(closing, "space-close", async () => {
    const changed = await peer.$transaction(async (tx) =>
      await tx.$executeRaw(Prisma.sql`
      UPDATE ${
        postgresQualifiedTable(peer, "ExecutionSpace")
      } SET "lifecycle"='closed',
      "lifecycleRevision"="lifecycleRevision"+1,"closedAt"=clock_timestamp()
      WHERE "projectId"=${closing.record.scope.projectId} AND "systemId"=${closing.record.scope.systemId}
        AND "executionSpaceId"=${closing.record.executionSpaceId} AND "caseId"=${closing.record.caseId} AND "lifecycle"='active'`)
    );
    assert.equal(changed, 1);
    const controls = await controlFacts(closing);
    assert(controls.space.closedAt instanceof Date);
    assert.deepEqual(controls, {
      ...beforeClosure,
      space: {
        ...beforeClosure.space,
        lifecycle: "closed",
        lifecycleRevision: beforeClosure.space.lifecycleRevision + 1n,
        closedAt: controls.space.closedAt,
      },
    });
    return () => Promise.resolve();
  }, /The Request is no longer active/);
  console.info(
    "Control-fence witness complete: actual pre-effect capability revoke, target-space closure, database session cutoff and PRIMARY lock exclusion (not changed-policy semantics)",
  );
}
