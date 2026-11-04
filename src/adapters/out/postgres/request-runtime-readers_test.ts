import assert from "node:assert/strict";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";
import type { PrismaClient } from "./client.ts";
import { createRequestRuntimeReaders } from "./request-runtime-readers.ts";

Deno.test("Request admitted reader completes one RepeatableRead before returning continuation evidence", async () => {
  const adoptions = [{
    manifest: {
      commandId: "adoption",
      intent: { target: { openingId: "opening" } },
      nativeRetirement: {
        predecessorThreadIds: ["before"],
        successorThreadIds: ["after"],
        digest: "retirement",
      },
      format: "request-runtime-adoption/v2",
    },
    receipt: { receiptDigest: "receipt" },
  }];
  const events: string[] = [];
  const client = {
    // The transaction double returns the verified fold; admission-store tests
    // exercise the journal validation inside the supplied transaction callback.
    async $transaction(_read: unknown, options: unknown) {
      assert.deepEqual(options, { isolationLevel: "RepeatableRead" });
      events.push("transaction");
      await Promise.resolve();
      events.push("committed");
      return { execution: { adoptions } };
    },
  } as unknown as PrismaClient;
  const chain = await createRequestRuntimeReaders(client).admittedSource.read(
    { id: "opening" } as OpeningRecord,
  );
  events.push("read");
  assert.deepEqual(events, ["transaction", "committed", "read"]);
  assert.deepEqual(chain, {
    execution: {
      adoptions: [{
        manifest: {
          commandId: "adoption",
          intent: adoptions[0].manifest.intent,
          nativeRetirement: {
            predecessorThreadIds: ["before"],
            successorThreadIds: ["after"],
          },
        },
        receipt: adoptions[0].receipt,
      }],
    },
  });
});

Deno.test("Request runtime readers retain exact scopes, waiting predicates and null snapshots", async () => {
  const scope = {
    projectId: "project",
    systemId: "system",
    executionSpaceId: "space",
    operatorId: "operator",
  };
  const rows = [{ snapshotJson: null }, { snapshotJson: "unparsed" }];
  const queries: unknown[] = [];
  const active = {
    ...scope,
    caseId: "case",
    parentExecutionSpaceId: "main",
    lifecycle: "active",
    createdAt: new Date("2026-11-04T00:00:00.000Z"),
    closedAt: null as Date | null,
  };
  let space: typeof active | null = null;
  const client = {
    executionRun: {
      findMany(query: unknown) {
        queries.push(query);
        return Promise.resolve(rows);
      },
    },
    executionSpace: {
      findUnique(query: unknown) {
        queries.push(query);
        return Promise.resolve(space);
      },
    },
  } as unknown as PrismaClient;
  const readers = createRequestRuntimeReaders(client);
  for (
    const target of [
      undefined,
      { threadId: "thread" },
      { threadId: "thread", checkpointId: "checkpoint" },
    ]
  ) {
    assert.deepEqual(await readers.waitingRuns.read(scope, target), rows);
    assert.deepEqual(queries.pop(), {
      where: { ...scope, ...target, status: "waiting" },
    });
  }
  const opening = {
    scope: { projectId: scope.projectId, systemId: scope.systemId },
    executionSpaceId: scope.executionSpaceId,
  } as OpeningRecord;
  for (
    const row of [
      null,
      active,
      {
        ...active,
        lifecycle: "closed",
        closedAt: new Date("2026-11-04T01:00:00.000Z"),
      },
    ]
  ) {
    space = row;
    assert.deepEqual(
      await readers.lifecycle.read(opening),
      row === null ? null : {
        caseId: "case",
        parentExecutionSpaceId: "main",
        lifecycle: row.lifecycle,
        closedAt: row.closedAt,
      },
    );
    assert.deepEqual(queries.pop(), {
      where: {
        projectId_systemId_executionSpaceId: {
          ...opening.scope,
          executionSpaceId: opening.executionSpaceId,
        },
      },
    });
  }
});
