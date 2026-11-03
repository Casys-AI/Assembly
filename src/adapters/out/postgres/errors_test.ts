import assert from "node:assert/strict";
import { EvolutionError } from "../../../application/model/evolution/ports.ts";
import { publicPostgresFailure, safeStoragePort } from "./errors.ts";

Deno.test("storage boundary preserves synchronous observers and their unsubscribe", () => {
  class Observer {
    #listeners = new Set<() => void>();
    onChange(listener: () => void): () => void {
      this.#listeners.add(listener);
      return () => {
        this.#listeners.delete(listener);
      };
    }
    notify(): void {
      for (const listener of this.#listeners) listener();
    }
  }
  const port = safeStoragePort(new Observer());
  let calls = 0;
  const unsubscribe = port.onChange(() => calls++);
  assert.equal(typeof unsubscribe, "function");
  assert.equal(port.notify(), undefined);
  assert.equal(calls, 1);
  unsubscribe();
  port.notify();
  assert.equal(calls, 1);
});

Deno.test("storage boundary preserves synchronous and asynchronous evolution refusals", async () => {
  const refusal = new EvolutionError(
    "EVOLUTION_STORE_CORRUPT",
    "Stored dossier is invalid",
  );
  const port = safeStoragePort({
    sync(): never {
      throw refusal;
    },
    asynchronous(): Promise<never> {
      return Promise.reject(refusal);
    },
  });
  assert.throws(() => port.sync(), (error) => error === refusal);
  await assert.rejects(port.asynchronous(), (error) => error === refusal);
  assert.equal(publicPostgresFailure(refusal), undefined);
  assert.equal(
    publicPostgresFailure(
      new EvolutionError("ECONNREFUSED", "Modeled refusal"),
    ),
    undefined,
  );
});

Deno.test("storage boundary removes driver connection and query details from errors", async () => {
  const secret = "private-connection-canary";
  const connection = Object.assign(new Error(secret), { code: "ECONNREFUSED" });
  const query = Object.assign(new Error(secret), {
    name: "PrismaClientValidationError",
  });
  const port = safeStoragePort({
    sync(): never {
      throw connection;
    },
    asynchronous(): Promise<never> {
      return Promise.reject(query);
    },
  });
  const safe = (error: unknown) =>
    error instanceof Error && !error.message.includes(secret) &&
    error.message ===
      "Operational storage is unavailable; retry or contact the host operator";
  assert.throws(() => port.sync(), safe);
  await assert.rejects(port.asynchronous(), safe);
  assert.ok(
    safe(publicPostgresFailure(new AggregateError([connection], secret))),
  );
  assert.equal(
    publicPostgresFailure(
      Object.assign(new Error("business refusal"), {
        code: "EVOLUTION_INVALID",
      }),
    ),
    undefined,
  );
});
