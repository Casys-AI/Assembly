import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  RequestSourceApiError as SharedError,
  responseError,
  retryOnceAfterStale,
  sendErrorMessage,
} from "./api-error.ts";
import { RequestSourceApiError } from "./model/sources/request-revisions.ts";

Deno.test("HTTP errors retain their prose and acquire a code only at the send boundary", () => {
  equal(SharedError, RequestSourceApiError);
  const error = responseError(409, {
    code: "STALE_CONVERSATION",
    error: "Conversation changed",
  }, "Fallback");
  equal(error instanceof RequestSourceApiError, true);
  equal(error.message, "Conversation changed");
  equal(
    sendErrorMessage(error, "Fallback"),
    "STALE_CONVERSATION: Conversation changed",
  );
});

Deno.test("only a stale refusal permits one retry, and failed reload preserves the original refusal", async () => {
  for (const reloadResult of ["missing", "throws", "fresh"] as const) {
    const stale = new RequestSourceApiError(
      "Conversation changed",
      409,
      "STALE_CONVERSATION",
    );
    const calls: Array<string | undefined> = [];
    let reloads = 0;
    const operation = retryOnceAfterStale(
      (target?: string) => {
        calls.push(target);
        return Promise.reject(stale);
      },
      () => {
        reloads++;
        if (reloadResult === "throws") {
          return Promise.reject(new Error("Read failed"));
        }
        return Promise.resolve(reloadResult === "fresh" ? "fresh" : null);
      },
    );
    await rejects(operation, (error: unknown) => error === stale);
    equal(reloads, 1);
    deepStrictEqual(
      calls,
      reloadResult === "fresh" ? [undefined, "fresh"] : [undefined],
    );
  }
  for (
    const error of [
      new RequestSourceApiError("Other conflict", 409, "OTHER"),
      new RequestSourceApiError("Wrong status", 503, "STALE_CONVERSATION"),
    ]
  ) {
    let reloads = 0;
    await rejects(
      retryOnceAfterStale(
        () => Promise.reject(error),
        () => {
          reloads++;
          return Promise.resolve("fresh");
        },
      ),
      (caught: unknown) => caught === error,
    );
    equal(reloads, 0);
  }
});
