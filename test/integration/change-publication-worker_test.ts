import { equal, ok, rejects } from "node:assert/strict";
import { publicationFailure } from "../../src/domain/model/publication/change.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  runSysmlToolkitWorker,
  SysmlToolkitWorkerError,
} from "../../src/adapters/out/sysml-toolkit/worker-client.ts";

for (const event of ["exit", "error"] as const) {
  Deno.test(`Toolkit worker ${event} stays retryable through publication preparation`, async () => {
    const action = event === "exit"
      ? "process.exit(1)"
      : '(() => { throw new Error("Worker crash"); })()';
    const worker = new URL(
      `data:text/javascript,import { parentPort } from "node:worker_threads"; parentPort.on("message", () => ${action});`,
    );
    await rejects(
      () => runSysmlToolkitWorker("unused", { operation: "pin" }, 5000, worker),
      (error: unknown) => {
        ok(error instanceof SysmlToolkitWorkerError);
        equal(
          error.message,
          event === "exit"
            ? "Toolkit worker exited unexpectedly"
            : "Worker crash",
        );
        equal(error.code, "TOOLKIT_WORKER_UNAVAILABLE");
        for (const phase of ["refuse", "retry"] as const) {
          const failure = publicationFailure(error, {
            changeId: "pending",
            systemId: "system",
          }, phase);
          equal(failure.code, "PUBLICATION_FAILED");
          equal(failure.recovery, "retry");
        }
        return true;
      },
    );
  });
}

Deno.test({
  name:
    "real invalid Toolkit compilation is refusable even without diagnostics or a code",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiler = new ToolkitCompiler({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    });
    await rejects(
      () =>
        compiler.compile({
          "broken.sysml": "package Broken { part x : Missing; }",
        }),
      (error: unknown) => {
        ok(error instanceof SysmlToolkitWorkerError);
        equal(error.code, undefined);
        equal(error.diagnostics.length, 0);
        for (const phase of ["refuse", "retry"] as const) {
          const failure = publicationFailure(error, {
            changeId: "pending",
            systemId: "system",
          }, phase);
          equal(failure.code, "PUBLICATION_NOT_APPLICABLE");
          equal(failure.recovery, "refuse");
        }
        return true;
      },
    );
  },
});
