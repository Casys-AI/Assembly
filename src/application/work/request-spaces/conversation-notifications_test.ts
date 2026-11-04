import { equal } from "node:assert/strict";
import { deepStrictEqual } from "node:assert/strict";
import {
  createRequestConversationOwnerReader,
  isRequestConversationsInvalidation,
  RequestConversationEvents,
} from "./conversation-notifications.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import {
  requestOpeningBase,
  requestSpaceScope,
} from "../../../../test/support/request-space-fixture.ts";

Deno.test("owner resolution accepts only a readable opening in the host scope", async () => {
  const record = {
    caseId: "case-1",
    ownerId: "owner",
    scope: requestSpaceScope,
    base: await requestOpeningBase(),
    phase: "runtime-ready",
  } as OpeningRecord;
  let persisted: OpeningRecord | null = record;
  const read = createRequestConversationOwnerReader({
    scope: requestSpaceScope,
    store: { forCase: () => Promise.resolve(persisted) },
  });
  for (const phase of ["runtime-ready", "admitted", "dispatched"] as const) {
    persisted = { ...record, phase };
    equal(await read("case-1"), "owner");
  }
  for (
    const mismatch of [
      null,
      { ...record, caseId: "case-2" },
      { ...record, base: null },
      { ...record, phase: "branch-ready" as const },
      { ...record, scope: { ...record.scope, projectId: "foreign" } },
      { ...record, scope: { ...record.scope, systemId: "foreign" } },
    ]
  ) {
    persisted = mismatch;
    equal(await read("case-1"), null);
  }
});

Deno.test("Request conversation invalidations carry only a valid Case identity and schema", () => {
  equal(
    isRequestConversationsInvalidation({ schemaVersion: 1, caseId: "case-1" }),
    true,
  );
  for (
    const value of [
      null,
      [],
      {},
      { schemaVersion: 2, caseId: "case-1" },
      { schemaVersion: 1, caseId: "" },
      { schemaVersion: 1, caseId: "../case" },
      { schemaVersion: 1, caseId: "a".repeat(129) },
      { schemaVersion: 1, caseId: "case-1", ownerId: "owner" },
      { schemaVersion: 1, caseId: "case-1", text: "private" },
    ]
  ) {
    equal(
      isRequestConversationsInvalidation(value),
      false,
      JSON.stringify(value),
    );
  }
});

Deno.test("invalidations resolve the owner, coalesce pending work and contain failures", async () => {
  const gate = Promise.withResolvers<void>();
  const sent: unknown[] = [];
  const errors: string[] = [];
  const reads: string[] = [];
  const events = new RequestConversationEvents({
    async owner(caseId) {
      reads.push(caseId);
      if (caseId === "slow") await gate.promise;
      if (caseId === "broken") throw new Error("unavailable");
      return caseId === "missing" ? null : "owner";
    },
    deliver(ownerId, event) {
      if (event.caseId === "delivery-fails") throw new Error("closed stream");
      sent.push({ ownerId, event });
    },
    onError: (_error, caseId) => errors.push(caseId),
  });
  const first = events.observe("slow");
  const waiting = events.observe("case-1");
  const joined = events.observe("case-1");
  equal(waiting, joined);
  gate.resolve();
  await Promise.all([
    first,
    waiting,
    events.observe("missing"),
    events.observe("broken"),
    events.observe("delivery-fails"),
  ]);
  deepStrictEqual(reads, [
    "slow",
    "case-1",
    "missing",
    "broken",
    "delivery-fails",
    "broken",
    "delivery-fails",
  ]);
  deepStrictEqual(
    sent.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ["case-1", "slow"].map((caseId) => ({
      ownerId: "owner",
      event: { schemaVersion: 1, caseId },
    })),
  );
  deepStrictEqual(errors, [
    "broken",
    "delivery-fails",
    "broken",
    "delivery-fails",
  ]);
  await events.close();
  await events.observe("case-1");
  equal(sent.length, 2);
});

Deno.test("a transient notification failure is retried once", async () => {
  let reads = 0, sent = 0, errors = 0;
  const events = new RequestConversationEvents({
    owner: () =>
      ++reads === 1
        ? Promise.reject(new Error("transient"))
        : Promise.resolve("owner"),
    deliver: () => {
      sent++;
    },
    onError: () => {
      errors++;
    },
  });
  await events.observe("case-1");
  equal(reads, 2);
  equal(sent, 1);
  equal(errors, 1);
  await events.close();
});

Deno.test("a blocked Request invalidation does not delay another Request", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const sent: string[] = [];
  const events = new RequestConversationEvents({
    async owner(caseId) {
      if (caseId === "case-A") {
        entered.resolve();
        await gate.promise;
      }
      return "owner";
    },
    deliver: (_owner, event) => {
      sent.push(event.caseId);
    },
  });
  const first = events.observe("case-A");
  await entered.promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      events.observe("case-B"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Other Request stalled")),
          1000,
        );
      }),
    ]);
    deepStrictEqual(sent, ["case-B"]);
  } finally {
    clearTimeout(timer);
    gate.resolve();
    await first;
    await events.close();
  }
  deepStrictEqual(sent, ["case-B", "case-A"]);
});

Deno.test("a change during owner resolution is announced in a later pass; closing suppresses pending delivery", async () => {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const sent: string[] = [];
  let reads = 0;
  const events = new RequestConversationEvents({
    async owner() {
      if (++reads === 1) {
        started.resolve();
        await gate.promise;
      }
      return "owner";
    },
    deliver: (_owner, event) => {
      sent.push(event.caseId);
    },
  });
  const first = events.observe("case-1");
  await started.promise;
  const later = events.observe("case-1");
  gate.resolve();
  await Promise.all([first, later]);
  deepStrictEqual(sent, ["case-1", "case-1"]);

  const pending = events.observe("case-1");
  await events.close();
  await pending;
  equal(sent.length, 2);
});

Deno.test("a change during delivery receives another pass, but closing discards queued work", async () => {
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let deliveries = 0;
  const events = new RequestConversationEvents({
    owner: () => Promise.resolve("owner"),
    async deliver() {
      deliveries++;
      if (deliveries === 1) {
        entered.resolve();
        await gate.promise;
      }
    },
  });
  const first = events.observe("case-1");
  await entered.promise;
  const later = events.observe("case-1");
  gate.resolve();
  await Promise.all([first, later]);
  equal(deliveries, 2);
  const queued = events.observe("case-1");
  const closing = events.close();
  await Promise.all([queued, closing]);
  equal(deliveries, 2);
});
