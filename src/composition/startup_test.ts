import { equal, rejects } from "node:assert/strict";
import { PostgresMigrationsPendingError } from "../adapters/out/postgres/migration-readiness.ts";
import { StartupRefusalError } from "../infrastructure/startup-refusal.ts";
import { ToolkitRequiredError } from "./model-backend.ts";
import { startAssembly } from "./startup.ts";

Deno.test("startup preserves prerequisite refusals and unexpected failures", async () => {
  const options = {
    dataDir: "unused",
    servedOrigin: "http://127.0.0.1:4311",
    provider: "unused",
    agentModel: undefined,
    agentEffort: "low",
    decisionMaxTokens: undefined,
  };
  const toolkit = new ToolkitRequiredError({ packageDir: "missing" });
  let assembled = false;
  await rejects(() =>
    startAssembly(options, {
      requireToolkit: () => Promise.reject(toolkit),
      assemble: () => {
        assembled = true;
        throw new Error("must not assemble");
      },
    }), (error) => error === toolkit && error instanceof StartupRefusalError);
  equal(assembled, false);
  for (
    const failure of [
      new PostgresMigrationsPendingError({
        pending: ["pending"],
        unresolved: [],
      }),
      new Error("Unexpected assembly failure"),
    ]
  ) {
    await rejects(() =>
      startAssembly(options, {
        requireToolkit: () => Promise.resolve(),
        assemble: () => Promise.reject(failure),
      }), (error) => error === failure);
    equal(
      failure instanceof StartupRefusalError,
      failure instanceof PostgresMigrationsPendingError,
    );
  }
});
