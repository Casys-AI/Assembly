// deno-lint-ignore-file require-await -- Async port doubles preserve promise failure contracts.
import { ModelRevisionNotifications } from "./notifications.ts";

function deferred() {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((r) => resolve = r),
    resolve: () => resolve(),
  };
}
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

Deno.test("publication announcement finishes while diagnostics remain blocked", async () => {
  const blocked = deferred();
  const started = deferred();
  const calls: string[] = [];
  const notifications = new ModelRevisionNotifications({
    invalidateHead() {
      calls.push("invalidate");
    },
    announce() {
      calls.push("announce");
      return Promise.resolve();
    },
    async refresh(version) {
      calls.push(version);
      started.resolve();
      await blocked.promise;
    },
    onError() {
      throw new Error("unexpected error");
    },
  });
  await notifications.notify("a");
  equal(calls, ["invalidate", "announce"]);
  await started.promise;
  equal(calls, ["invalidate", "announce", "a"]);
  blocked.resolve();
  await notifications.close();
});

Deno.test("a publication burst coalesces pending diagnostics without delaying announcements", async () => {
  const blocked = deferred();
  const started = deferred();
  const refreshed: string[] = [];
  let announced = 0;
  const notifications = new ModelRevisionNotifications({
    invalidateHead() {},
    announce() {
      announced++;
      return Promise.resolve();
    },
    async refresh(version) {
      refreshed.push(version);
      if (version === "a") {
        started.resolve();
        await blocked.promise;
      }
    },
    onError() {
      throw new Error("unexpected error");
    },
  });
  await notifications.notify("a");
  await started.promise;
  await notifications.notify("b");
  await notifications.notify("c");
  equal(announced, 3);
  equal(refreshed, ["a"]);
  blocked.resolve();
  // Let the active loop consume its one pending revision.
  await Promise.resolve();
  await Promise.resolve();
  equal(refreshed, ["a", "c"]);
  await notifications.close();
});

Deno.test("advisory failures do not undo publication and close prevents later work", async () => {
  const errors: string[] = [];
  const refreshed = deferred();
  const notifications = new ModelRevisionNotifications({
    invalidateHead() {},
    async announce() {
      throw new Error("SSE disconnected");
    },
    async refresh() {
      refreshed.resolve();
      throw new Error("diagnostics unavailable");
    },
    onError(stage) {
      errors.push(stage);
    },
  });
  await notifications.notify("a");
  await refreshed.promise;
  await notifications.close();
  await notifications.notify("b");
  equal(errors, ["announce", "refresh"]);
});
