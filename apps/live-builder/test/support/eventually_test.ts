import assert from "node:assert/strict";
import { eventually } from "./eventually.ts";

Deno.test("eventually returns the first defined value, including falsy ones", async () => {
  let reads = 0;
  assert.equal(
    await eventually(() => ++reads < 3 ? undefined : 0, { pollMs: 0 }),
    0,
  );
  assert.equal(reads, 3);
  assert.equal(await eventually(() => Promise.resolve(false)), false);
});

Deno.test("eventually fails at its deadline with the label and diagnosis", async () => {
  let reads = 0;
  await assert.rejects(
    eventually(() => {
      reads++;
      return undefined;
    }, {
      timeoutMs: 0,
      label: "Fixture worker",
      diagnose: () => ({ reads }),
    }),
    { message: 'Fixture worker did not settle within 0 ms: {"reads":1}' },
  );
  await assert.rejects(
    eventually(() => undefined, {
      timeoutMs: 0,
      label: "Fixture worker",
      diagnose: () => {
        throw new AggregateError([
          new Error("scenario failed"),
          Object.assign(
            new Error(
              "queue unavailable at postgresql://message-secret@localhost/db",
            ),
            {
              code: "WRITE_QUEUE_UNAVAILABLE",
              context: {
                reason:
                  "Transaction expired at postgresql://secret@localhost/db",
                payload: "private-payload",
              },
              recovery: "retry https://recovery-secret@localhost/retry",
              meta: { message: "postgresql://meta-secret@localhost/db" },
            },
          ),
          "postgresql://primitive-secret@localhost/db",
        ], "diagnostic unavailable");
      },
    }),
    (error: Error) => {
      assert.match(
        error.message,
        /Fixture worker did not settle within 0 ms: .*diagnostic unavailable/,
      );
      assert.match(error.message, /scenario failed/);
      assert.match(error.message, /WRITE_QUEUE_UNAVAILABLE/);
      assert.match(error.message, /Transaction expired at \[redacted URL\]/);
      assert.match(error.message, /queue unavailable at \[redacted URL\]/);
      assert.match(error.message, /"recovery":"retry \[redacted URL\]"/);
      assert.doesNotMatch(
        error.message,
        /private-payload|secret@localhost|postgresql:\/\//,
      );
      return true;
    },
  );
});

Deno.test("eventually propagates a failed read without retrying it", async () => {
  let reads = 0;
  await assert.rejects(
    eventually(() => {
      reads++;
      return Promise.reject(new Error("read failed"));
    }),
    { message: "read failed" },
  );
  assert.equal(reads, 1);
});
