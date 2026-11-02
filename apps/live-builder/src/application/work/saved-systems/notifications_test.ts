import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  afterCommittedReleaseMutation,
  isReleaseCatalogueInvalidation,
  RELEASE_CATALOGUE_INVALIDATION,
} from "./notifications.ts";

Deno.test("Release invalidation contains only a validated schema version", () => {
  deepStrictEqual(RELEASE_CATALOGUE_INVALIDATION, { schemaVersion: 1 });
  equal(isReleaseCatalogueInvalidation(RELEASE_CATALOGUE_INVALIDATION), true);
  for (
    const value of [
      null,
      [],
      {},
      { schemaVersion: 2 },
      {
        schemaVersion: 1,
        caseId: "private",
      },
      { schemaVersion: 1, records: [] },
      { schemaVersion: 1, ownerId: "owner" },
    ]
  ) {
    equal(isReleaseCatalogueInvalidation(value), false);
  }
});

Deno.test("Release notification waits for committed mutation and ignores no-op and rollback", async () => {
  const commit = Promise.withResolvers<{ value: string; changed: boolean }>();
  let notifications = 0;
  const result = afterCommittedReleaseMutation(commit.promise, () => {
    notifications++;
  });
  equal(notifications, 0);
  commit.resolve({ value: "retained", changed: true });
  equal(await result, "retained");
  equal(notifications, 1);
  await afterCommittedReleaseMutation(
    Promise.resolve({ value: "same", changed: false }),
    () => {
      notifications++;
    },
  );
  await rejects(
    afterCommittedReleaseMutation(Promise.reject(new Error("rollback")), () => {
      notifications++;
    }),
    /rollback/,
  );
  equal(notifications, 1);
  equal(
    await afterCommittedReleaseMutation(
      Promise.resolve({ value: "committed", changed: true }),
      () => {
        throw new Error("stream closed");
      },
    ),
    "committed",
  );
});
