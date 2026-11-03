/** Controlled worker fixture: synchronous JS blocking proves scheduler preemption. */
import { parentPort } from "node:worker_threads";
import type {
  ToolkitWorkerRequest,
  ToolkitWorkerResponse,
} from "../../src/adapters/out/sysml-toolkit/worker-client.ts";

const port = parentPort;
if (!port) throw new Error("Worker fixture requires a parent port");
const workerId = crypto.randomUUID();
let calls = 0;
let active = 0;
let maximumActive = 0;
const operations: string[] = [];
port.on("message", async ({ id, request }: ToolkitWorkerRequest) => {
  const respond = (response: ToolkitWorkerResponse) =>
    port.postMessage(response);
  calls++;
  operations.push(request.operation);
  maximumActive = Math.max(maximumActive, ++active);
  if (
    (request.operation === "query" && request.expression === "spin-blocked") ||
    (request.operation === "board" &&
      request.options?.model === "spin-blocked") ||
    ((request.operation === "views" || request.operation === "diagram") &&
      Object.values(request.sources).some((text) =>
        text.includes("spin-blocked")
      ))
  ) {
    respond({ id, kind: "started" });
    // Deliberately blocks this fixture thread until the scheduler terminates it.
    while (true) { /* synchronous blocked fixture */ }
  }
  respond({ id, kind: "started" });
  if (request.operation === "query" && request.expression === "exit") {
    Deno.exit(0);
    return;
  }
  if (request.operation === "query" && request.expression === "trap") {
    respond({
      id,
      kind: "result",
      ok: false,
      reusable: false,
      error: { message: "injected fixture panic", diagnostics: [] },
    });
    active--;
    return;
  }

  if (
    request.operation === "query" &&
    ["throw", "refuse"].includes(request.expression)
  ) {
    respond({
      id,
      kind: "result",
      ok: false,
      reusable: request.expression === "refuse",
      error: { message: "worker fixture exploded", diagnostics: [] },
    });
    active--;
    return;
  }
  if (request.operation === "board") {
    if (request.options?.model?.startsWith("delay:")) {
      const delay = Number(request.options.model.slice("delay:".length));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    respond({
      id,
      kind: "result",
      ok: true,
      result: {
        workerId,
        calls,
        maximumActive,
        sources: request.sources,
        options: request.options,
        operations,
      },
    });
  } else if (
    request.operation === "views" || request.operation === "diagram"
  ) {
    respond({
      id,
      kind: "result",
      ok: true,
      result: {
        workerId,
        calls,
        maximumActive,
        sources: request.sources,
        operations,
      },
    });
  } else if (
    request.operation === "query" && request.expression.startsWith("state")
  ) {
    const delay = Number(request.expression.split(":")[1] ?? 0);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    respond({
      id,
      kind: "result",
      ok: true,
      result: {
        workerId,
        calls,
        maximumActive,
        sources: request.sources,
        operations,
      },
    });
  } else {
    respond({ id, kind: "result", ok: true, result: request.operation });
  }
  active--;
});
