import assert from "node:assert/strict";
import {
  RequestAdoptionError,
  type RequestAdoptionSession,
} from "../../application/model/evolution/request-adoption-ports.ts";
import type { OpeningRecord } from "../../domain/work/request-spaces.ts";
import { PostgresPrimarySpaceControlSource } from "../out/postgres/primary-space-control-source.ts";
import { type Prisma, type PrismaClient } from "../out/postgres/client.ts";
import { RequestAdoptionContexts } from "./request-adoption-context.ts";
import {
  requestControlBinding,
  requestSpaceScope,
  spaceControlAuthority,
} from "../../../test/support/request-space-fixture.ts";

/** Controlled ports stop at the source boundary; these cases qualify the cheap
 * expiry preflight, not native compilation, current authority or PostgreSQL. */
function expiryFixture(live: boolean | undefined, expiresAt: string) {
  type Options = ConstructorParameters<typeof RequestAdoptionContexts>[0];
  const counts = { clocks: 0, journals: 0, readers: 0 };
  const sourceBoundary = new Error("controlled source boundary reached");
  const opening = {
    phase: "dispatched",
    scope: requestSpaceScope,
    executionSpaceId: "spaceA",
    caseId: "caseA",
  } as OpeningRecord;
  const client = {
    $queryRaw(query: Prisma.Sql) {
      counts.clocks++;
      assert.match(query.sql, /::timestamptz > clock_timestamp\(\) AS live/);
      assert.deepEqual(query.values, [new Date(expiresAt)]);
      return Promise.resolve(live === undefined ? [] : [{ live }]);
    },
    $transaction<T>(operation: (tx: unknown) => Promise<T>) {
      return operation({ $executeRaw: () => Promise.resolve(0) });
    },
    executionSpace: {
      findUnique: () =>
        Promise.resolve({ lifecycle: "active", closedAt: null }),
    },
  } as unknown as PrismaClient;
  const primarySpaceControl = new PostgresPrimarySpaceControlSource(client, {
    ...requestControlBinding,
    primaryOperatorId: "operator",
  });
  const context = new RequestAdoptionContexts({
    storage: {
      client,
      scope: requestSpaceScope,
      primarySpaceControl,
      readCaseRuntimeState: () => Promise.resolve(null),
    },
    controls: {
      authenticateSession: () =>
        Promise.reject(new Error("unused authentication")),
    },
    openings: { forCase: () => Promise.resolve(null) },
    binding: {
      read: () =>
        Promise.resolve({
          state: {
            executionModel: {},
            cases: [{ id: opening.caseId, status: "open" }],
          },
          admission: { status: "active", expiresAt },
        }),
    } as unknown as Options["binding"],
    journal: {
      readAdmittedSource: () => {
        counts.journals++;
        return Promise.reject(sourceBoundary);
      },
    } as unknown as Options["journal"],
    repositoryId: "repository",
    reader: () => {
      counts.readers++;
      return Promise.reject(new Error("unused source reader"));
    },
  });
  const session: RequestAdoptionSession = {
    controller: {
      ownerId: "owner",
      sessionId: "session",
      capabilityId: "capability",
      capabilityRevision: 0,
      authority: spaceControlAuthority(),
    },
    sessionRevision: 0,
  };
  return { context, opening, session, counts, sourceBoundary };
}

Deno.test("adoption context refuses active admission expired by database time before source work", async () => {
  // The application date alone would see this as live; the database says it
  // has expired. No client/app clock can override that authoritative result.
  const f = expiryFixture(false, "2099-01-01T00:00:00.000Z");
  await assert.rejects(
    () => f.context.resolve(f.session, f.opening),
    (error) =>
      error instanceof RequestAdoptionError &&
      error.code === "FORBIDDEN" &&
      error.message.includes("admission has expired"),
  );
  assert.deepEqual(f.counts, { clocks: 1, journals: 0, readers: 0 });
});

Deno.test("adoption context uses database liveness rather than the application wall clock", async () => {
  const f = expiryFixture(true, "2000-01-01T00:00:00.000Z");
  await assert.rejects(
    () => f.context.resolve(f.session, f.opening),
    (error) => error === f.sourceBoundary,
  );
  assert.deepEqual(f.counts, { clocks: 1, journals: 1, readers: 0 });
});

Deno.test("adoption context cannot offer eligibility without a database expiry result", async () => {
  const f = expiryFixture(undefined, "2099-01-01T00:00:00.000Z");
  await assert.rejects(
    () => f.context.resolve(f.session, f.opening),
    (error) =>
      error instanceof RequestAdoptionError && error.code === "UNAVAILABLE",
  );
  assert.deepEqual(f.counts, { clocks: 1, journals: 0, readers: 0 });
});
