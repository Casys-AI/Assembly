import assert from "node:assert/strict";
import { observeMemberRightTransactions } from "./request-member-transaction-observer.ts";

Deno.test("member transaction observer preserves receiver, arguments, results and raw/public errors only in its read context", async () => {
  const result = {};
  const options = { isolationLevel: "RepeatableRead" };
  const raw = Object.assign(new Error("private fixture text"), {
    name: "PrismaClientKnownRequestError",
    code: "P2028",
  });
  const publicError = new Error("public failure");
  const reports: unknown[] = [];
  const client = {
    $transaction(callback: () => Promise<object>, selected: typeof options) {
      assert.equal(this, client);
      assert.equal(selected, options);
      return callback();
    },
  };
  const descriptor = Object.getOwnPropertyDescriptor(client, "$transaction");
  const observer = observeMemberRightTransactions(
    client,
    (summary) => reports.push(summary),
  );
  try {
    const outside = Promise.reject(raw);
    assert.equal(client.$transaction(() => outside, options), outside);
    await assert.rejects(outside, (error) => error === raw);
    assert.equal(
      await observer.read(() =>
        client.$transaction(() => Promise.resolve(result), options)
      ),
      result,
    );
    assert.deepEqual(reports, []);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    const observed = observer.read(async () => {
      await gate;
      return await client.$transaction(() => Promise.reject(raw), options)
        .catch(
          (error) => {
            assert.equal(error, raw);
            throw publicError;
          },
        );
    });
    // Another transaction can fail while the selected read is still active.
    await assert.rejects(
      client.$transaction(() => Promise.reject(raw), options),
      (error) => error === raw,
    );
    release();
    await assert.rejects(observed, (error) => error === publicError);
    assert.deepEqual(reports, [{
      count: 1,
      failures: [{ class: "PrismaClientKnownRequestError", code: "P2028" }],
    }]);
  } finally {
    observer.restore();
  }
  observer.restore();
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(client, "$transaction"),
    descriptor,
  );
});

Deno.test("member transaction diagnostics are bounded closed enums and never retain private error fields", async () => {
  const secret = "fixture-password SQL payload connection-string";
  const error = Object.assign(new Error(secret), {
    name: secret,
    code: secret,
  });
  for (const key of ["message", "stack", "meta", "cause"]) {
    Object.defineProperty(error, key, {
      get() {
        throw new Error("private field read");
      },
    });
  }
  const publicError = new Error("public failure");
  const client = Object.create({
    $transaction() {
      throw error;
    },
  }) as { $transaction(): Promise<never> };
  let report: unknown;
  const observer = observeMemberRightTransactions(client, (summary) => {
    report = summary;
    throw new Error("reporting failed");
  });
  try {
    await assert.rejects(
      observer.read(() => {
        for (let count = 0; count < 12; count++) {
          assert.throws(
            () => client.$transaction(),
            (caught) => caught === error,
          );
        }
        return Promise.reject(publicError);
      }),
      (caught) => caught === publicError,
    );
    assert.deepEqual(report, {
      count: 8,
      failures: Array.from(
        { length: 8 },
        () => ({ class: "other", code: "other" }),
      ),
    });
    assert.equal(JSON.stringify(report).includes(secret), false);
  } finally {
    observer.restore();
  }
  assert.equal(Object.hasOwn(client, "$transaction"), false);
  assert.throws(() => client.$transaction(), (caught) => caught === error);
});

Deno.test("member transaction observer restores a Prisma-style virtual method descriptor and callable", () => {
  const original = () => Promise.resolve("unchanged");
  const client = new Proxy({ $transaction: original }, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return descriptor && key === "$transaction"
        ? { ...descriptor, value: undefined }
        : descriptor;
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(client, "$transaction");
  const observer = observeMemberRightTransactions(client, () => {});
  observer.restore();
  assert.equal(client.$transaction, original);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(client, "$transaction"),
    descriptor,
  );
});
