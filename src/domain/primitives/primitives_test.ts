import { equal, throws } from "node:assert/strict";
import { assert } from "./assert.ts";
import { assertClosedRecord, hasOnlyKeys } from "./closed-record.ts";
import { errorMessage } from "./error-message.ts";
import { isPlainRecord } from "./is-plain-record.ts";

Deno.test("assert preserves truthiness and the supplied error message", () => {
  assert("present", "unused");
  throws(() => assert(0, "missing"), { name: "Error", message: "missing" });
});

Deno.test("record guard accepts non-array objects regardless of prototype", () => {
  class Instance {}
  const accepted = [
    {},
    new Instance(),
    new Date(),
    Object.create(null),
    new Proxy({}, {}),
  ];
  const rejected = [
    null,
    undefined,
    [],
    () => {},
    0,
    1,
    "",
    "text",
    true,
    Symbol("s"),
    1n,
  ];
  for (const value of accepted) equal(isPlainRecord(value), true);
  for (const value of rejected) equal(isPlainRecord(value), false);
});

Deno.test("error message preserves conversion and propagates conversion errors", () => {
  equal(errorMessage(new Error("failure")), "failure");
  equal(errorMessage(42), "42");
  const failure = new Error("conversion failed");
  throws(() =>
    errorMessage({
      [Symbol.toPrimitive]: () => {
        throw failure;
      },
    }), (error) => error === failure);
});

Deno.test("closed keys require own keys and allow only declared enumerable keys", () => {
  const value = Object.defineProperty({ optional: 1 }, "required", {
    value: 2,
  });
  equal(hasOnlyKeys(value, ["required"], ["optional"]), true);
  equal(hasOnlyKeys(value, ["missing"], ["optional"]), false);
  equal(hasOnlyKeys(value, ["required"]), false);
  equal(hasOnlyKeys(Object.create({ inherited: 1 }), ["inherited"]), false);
});

Deno.test("closed record rejects the first unexpected enumerable own key", () => {
  const value = Object.create({ inherited: true });
  Object.defineProperty(value, "hidden", { value: true });
  value.allowed = true;
  assertClosedRecord(value, ["allowed"], () => {
    throw new Error("unexpected");
  });
  value.first = true;
  value.second = true;
  const failure = new Error("sentinel");
  let rejectedKey: string | undefined;
  throws(() =>
    assertClosedRecord(value, ["allowed"], (key) => {
      rejectedKey = key;
      throw failure;
    }), (error) => error === failure);
  equal(rejectedKey, "first");
});
