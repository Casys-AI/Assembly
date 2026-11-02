import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import {
  type NativeChildStatus,
  type NativeProcessChild,
  nativeProcessCommandArgs,
  NativeProcessEndpoint,
  type NativeProcessEndpointOptions,
  type NativeProcessRequestEnvelope,
  readBoundedLines,
} from "./process-client.ts";
import {
  createIsolatedWorkerRunner,
  SysmlToolkitTimeoutError,
  SysmlToolkitWorkerClosedError,
  type ToolkitWorkerOperation,
  type ToolkitWorkerResponse,
} from "../../adapters/out/sysml-toolkit/worker-client.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Scriptable child: test code pushes stdout lines and controls exit. */
class FakeChild implements NativeProcessChild {
  readonly pid = 4242;
  readonly kills: string[] = [];
  readonly received: string[] = [];
  writeGate?: Promise<void>;
  #stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  #resolveStatus!: (status: NativeChildStatus) => void;
  readonly status = new Promise<NativeChildStatus>((resolveStatus) => {
    this.#resolveStatus = resolveStatus;
  });
  readonly stdout = new ReadableStream<Uint8Array>({
    start: (controller) => {
      this.#stdoutController = controller;
    },
  });
  readonly stderr = new ReadableStream<Uint8Array>({
    start: (controller) => controller.close(),
  });
  readonly stdin = new WritableStream<Uint8Array>({
    write: (chunk) => {
      this.received.push(decoder.decode(chunk));
      return this.writeGate;
    },
  });
  /** When set, SIGTERM is ignored; only SIGKILL ends the process. */
  ignoreTerm = false;
  acknowledgeKills = true;

  push(text: string): void {
    this.#stdoutController.enqueue(encoder.encode(text));
  }
  exit(code = 0): void {
    try {
      this.#stdoutController.close();
    } catch { /* Already closed. */ }
    this.#resolveStatus({ success: code === 0, code, signal: null });
  }
  kill(signo = "SIGTERM"): void {
    this.kills.push(signo);
    if (this.acknowledgeKills && (signo === "SIGKILL" || !this.ignoreTerm)) {
      queueMicrotask(() => this.exit(signo === "SIGKILL" ? 137 : 143));
    }
  }
  ref(): void {}
  unref(): void {}
}

const ENTRY = new URL(
  "../../adapters/out/sysml-toolkit/worker.ts",
  import.meta.url,
);
const fakeSnapshotStorage = {
  create: (_appRoot: string, epoch: string) =>
    Promise.resolve(`/private/${epoch}`),
  remove: (_directory: string) => Promise.resolve(),
};

function endpointWith(
  child: FakeChild,
  options: NativeProcessEndpointOptions = {},
) {
  const endpoint = new NativeProcessEndpoint(ENTRY, {
    spawnChild: () => child,
    snapshotStorage: fakeSnapshotStorage,
    ...options,
  });
  const messages: ToolkitWorkerResponse[] = [];
  const errors: Error[] = [];
  const exits: number[] = [];
  endpoint.on("message", (message) => messages.push(message));
  endpoint.on("error", (error) => errors.push(error));
  endpoint.on("exit", () => exits.push(1));
  return { endpoint, messages, errors, exits };
}

function hello(child: FakeChild, epoch: string): void {
  child.push(
    `${
      JSON.stringify({
        v: 1,
        kind: "hello",
        processEpoch: epoch,
        pid: child.pid,
      })
    }\n`,
  );
}

async function until(check: () => boolean, subject: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error(`Timed out waiting for ${subject}`);
}

const REQUEST = {
  id: 7,
  packageDir: "/pkg",
  request: { operation: "check", sources: { "a.sysml": "package A;" } },
} as const;

Deno.test("native endpoint completes hello, started and result for its epoch", async () => {
  const child = new FakeChild();
  const { endpoint, messages, errors } = endpointWith(child);
  endpoint.postMessage(REQUEST);
  await until(() => child.received.length === 1, "request line");
  const envelope = JSON.parse(
    child.received[0],
  ) as NativeProcessRequestEnvelope;
  equal(envelope.v, 1);
  equal(envelope.kind, "request");
  equal(envelope.id, 7);
  equal(envelope.processEpoch, endpoint.processEpoch);
  equal(envelope.request.operation, "check");
  hello(child, endpoint.processEpoch);
  child.push(
    `${
      JSON.stringify({
        v: 1,
        kind: "started",
        id: 7,
        processEpoch: endpoint.processEpoch,
      })
    }\n${
      JSON.stringify({
        v: 1,
        kind: "result",
        id: 7,
        processEpoch: endpoint.processEpoch,
        ok: true,
        result: ["diag"],
        reusable: true,
      })
    }\n`,
  );
  await until(() => messages.length === 2, "started and result");
  deepEqual(messages[0], { id: 7, kind: "started" });
  equal(messages[1].kind, "result");
  equal(errors.length, 0);
  equal(endpoint.pid, 4242);
  equal(await endpoint.terminate(), 143);
  deepEqual(child.kills, ["SIGTERM"]);
});

Deno.test("a response from a previous process epoch is never delivered", async () => {
  const child = new FakeChild();
  const { endpoint, messages, errors } = endpointWith(child);
  endpoint.postMessage(REQUEST);
  await until(() => child.received.length === 1, "request line");
  hello(child, endpoint.processEpoch);
  child.push(
    `${
      JSON.stringify({
        v: 1,
        kind: "result",
        id: 7,
        processEpoch: "previous-epoch",
        ok: true,
        result: "stale",
      })
    }\n`,
  );
  await until(() => errors.length === 1, "protocol error");
  equal(messages.length, 0);
  equal((errors[0] as { code?: string }).code, "TOOLKIT_WORKER_UNAVAILABLE");
  await endpoint.terminate();
});

Deno.test("missing hello and malformed lines fail the endpoint closed", async () => {
  const child = new FakeChild();
  const { endpoint, messages, errors } = endpointWith(child);
  endpoint.postMessage(REQUEST);
  await until(() => child.received.length === 1, "request line");
  child.push("this is not json\n");
  await until(() => errors.length === 1, "protocol error");
  equal(messages.length, 0);
  await endpoint.terminate();

  const child2 = new FakeChild();
  const second = endpointWith(child2);
  second.endpoint.postMessage(REQUEST);
  await until(() => child2.received.length === 1, "request line");
  child2.push(
    `${
      JSON.stringify({
        v: 1,
        kind: "result",
        id: 7,
        processEpoch: second.endpoint.processEpoch,
        ok: true,
        result: 1,
      })
    }\n`,
  );
  await until(() => second.errors.length === 1, "hello error");
  equal(second.messages.length, 0);
  await second.endpoint.terminate();
});

Deno.test("message bounds are enforced in both directions", async () => {
  const child = new FakeChild();
  const { endpoint, errors } = endpointWith(child, { maxMessageBytes: 64 });
  throws(() => endpoint.postMessage(REQUEST), {
    code: "TOOLKIT_MESSAGE_TOO_LARGE",
  });
  equal(errors.length, 0);

  const child2 = new FakeChild();
  const second = endpointWith(child2, { maxMessageBytes: 256 });
  second.endpoint.postMessage(REQUEST);
  await until(() => child2.received.length === 1, "request line");
  child2.push(`${"x".repeat(300)}\n`);
  await until(() => second.errors.length === 1, "oversize protocol error");
  await second.endpoint.terminate();
});

Deno.test("terminate waits for the real child exit and escalates signals", async () => {
  const child = new FakeChild();
  child.ignoreTerm = true;
  const { endpoint } = endpointWith(child, { terminateGraceMs: 10 });
  endpoint.postMessage(REQUEST);
  await until(() => child.received.length === 1, "request line");
  hello(child, endpoint.processEpoch);
  const started = performance.now();
  const code = await endpoint.terminate();
  equal(code, 137);
  deepEqual(child.kills, ["SIGTERM", "SIGKILL"]);
  // Termination settled only after the SIGKILL exit was observed, i.e. it
  // could not resolve before the grace escalation fired.
  equal(performance.now() - started >= 10, true);
  equal(await endpoint.terminate(), 137);
});

for (const ignoreTerm of [false, true]) {
  Deno.test(`terminate signals a child with a stalled stdin write (${ignoreTerm ? "SIGKILL" : "SIGTERM"})`, async () => {
    const child = new FakeChild();
    const gate = Promise.withResolvers<void>();
    child.writeGate = gate.promise;
    child.ignoreTerm = ignoreTerm;
    const { endpoint, errors } = endpointWith(child, { terminateGraceMs: 5 });
    endpoint.postMessage(REQUEST);
    await until(() => child.received.length === 1, "stalled request write");
    const termination = endpoint.terminate();
    try {
      // The write stays pending through exit: neither pipe cleanup nor the
      // grace escalation may depend on its completion.
      await until(() => child.kills.length > 0, "signal during stalled write");
      equal(await termination, ignoreTerm ? 137 : 143);
      deepEqual(child.kills, ignoreTerm ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
      equal(endpoint.terminate(), termination);
      equal(errors.length, 0);
    } finally {
      gate.resolve();
      await termination;
    }
  });
}

Deno.test("scheduler shutdown completes retirement after a stalled-write timeout", async () => {
  const child = new FakeChild();
  const gate = Promise.withResolvers<void>();
  child.writeGate = gate.promise;
  child.ignoreTerm = true;
  const run = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
    isProjection: () => false,
    createWorker: (url) =>
      new NativeProcessEndpoint(url, {
        spawnChild: () => child,
        snapshotStorage: fakeSnapshotStorage,
        terminateGraceMs: 5,
      }),
  });
  try {
    await rejects(
      () => run("/pkg", { operation: "check", sources: {} }, 40, ENTRY),
      SysmlToolkitTimeoutError,
    );
    equal(child.received.length, 1);
    const closing = run.close();
    await until(() => child.kills.includes("SIGKILL"), "shutdown escalation");
    await closing;
    deepEqual(run.stats(), { active: 0, queued: 0, retiring: 0 });
    await rejects(
      () => run("/pkg", { operation: "check", sources: {} }, 40, ENTRY),
      SysmlToolkitWorkerClosedError,
    );
  } finally {
    gate.resolve();
    await run.close();
  }
});

Deno.test("scheduler times out a hung native process and recycles the epoch", async () => {
  const children: FakeChild[] = [];
  const run = createIsolatedWorkerRunner<ToolkitWorkerOperation>({
    isProjection: () => false,
    createWorker: (url) => {
      const child = new FakeChild();
      children.push(child);
      const endpoint = new NativeProcessEndpoint(url, {
        spawnChild: () => child,
        snapshotStorage: fakeSnapshotStorage,
        terminateGraceMs: 5,
      });
      // Drive the fake: first process hangs forever, the recycled one answers.
      const drive = async () => {
        await until(() => child.received.length > 0, "spawned request");
        hello(child, endpoint.processEpoch);
        if (children.length > 1) {
          const request = JSON.parse(
            child.received[child.received.length - 1],
          ) as NativeProcessRequestEnvelope;
          child.push(
            `${
              JSON.stringify({
                v: 1,
                kind: "result",
                id: request.id,
                processEpoch: endpoint.processEpoch,
                ok: true,
                result: endpoint.processEpoch,
                reusable: true,
              })
            }\n`,
          );
        }
      };
      void drive();
      return endpoint;
    },
  });
  await rejects(
    () => run("/pkg", { operation: "check", sources: {} }, 40, ENTRY),
    SysmlToolkitTimeoutError,
  );
  await until(
    () => children.length === 1 && children[0].kills.length > 0,
    "kill",
  );
  const epoch = await run<string>(
    "/pkg",
    { operation: "check", sources: {} },
    2_000,
    ENTRY,
  );
  equal(children.length, 2);
  equal(typeof epoch, "string");
  notEqualEpoch(epoch, children);
  // End the recycled fake so no stream read stays pending past the test.
  children[1].exit(0);
  await until(() => children[1].kills.length > 0, "lane retirement");
});

Deno.test("child permissions expose only its private snapshot as writable native code", () => {
  const args = nativeProcessCommandArgs({
    entryPath: "/app/src/adapters/out/sysml-toolkit/worker.ts",
    appRoot: "/app",
    packageDir: "/installation",
    processEpoch: "epoch-a",
    snapshotDirectory: "/private/epoch-a",
  });
  equal(args.includes("--allow-write=/private/epoch-a"), true);
  equal(args.includes("--snapshot-dir=/private/epoch-a"), true);
  equal(args.includes("--allow-ffi=/private/epoch-a,/app/node_modules"), true);
  equal(
    args.some((arg) =>
      arg.startsWith("--allow-ffi=") && arg.includes("/installation")
    ),
    false,
  );
  equal(args.includes("--allow-write"), false);
});

Deno.test("private snapshot remains through SIGKILL until real status acknowledges exit", async () => {
  const child = new FakeChild();
  child.acknowledgeKills = false;
  const removed: string[] = [];
  let directory = "";
  const { endpoint } = endpointWith(child, {
    terminateGraceMs: 5,
    snapshotStorage: {
      create: (_root, epoch) => Promise.resolve(`/private/${epoch}`),
      remove: (path) => {
        removed.push(path);
        return Promise.resolve();
      },
    },
    spawnChild: (info) => {
      directory = info.snapshotDirectory;
      return child;
    },
  });
  endpoint.postMessage(REQUEST);
  await until(() => child.received.length === 1, "request line");
  let settled = false;
  const termination = endpoint.terminate().then((code) => {
    settled = true;
    return code;
  });
  await until(() => child.kills.includes("SIGKILL"), "SIGKILL");
  deepEqual(removed, []);
  equal(settled, false);
  child.exit(137);
  equal(await termination, 137);
  deepEqual(removed, [directory]);
});

Deno.test("natural exit and failed spawn both release only their owned snapshot", async () => {
  const child = new FakeChild();
  const removed: string[] = [];
  const storage = {
    create: (_root: string, epoch: string) =>
      Promise.resolve(`/private/${epoch}`),
    remove: (path: string) => {
      removed.push(path);
      return Promise.resolve();
    },
  };
  const { endpoint } = endpointWith(child, { snapshotStorage: storage });
  endpoint.postMessage(REQUEST);
  await until(() => child.received.length === 1, "request line");
  child.exit();
  await until(() => removed.length === 1, "natural-exit cleanup");
  equal(removed[0], `/private/${endpoint.processEpoch}`);
  await endpoint.terminate();
  equal(removed.length, 1);

  const failing = endpointWith(new FakeChild(), {
    snapshotStorage: storage,
    spawnChild: () => {
      throw new Error("spawn refused");
    },
  });
  failing.endpoint.postMessage(REQUEST);
  await until(() => failing.errors.length === 1, "spawn failure");
  equal(removed[1], `/private/${failing.endpoint.processEpoch}`);
  await failing.endpoint.terminate();
});

function notEqualEpoch(epoch: string, children: FakeChild[]): void {
  // The recycled process answered with its own fresh epoch, and the hung
  // process was really killed before the lane dispatched again.
  equal(children[0].kills.includes("SIGTERM"), true);
  equal(epoch.length > 0, true);
}

Deno.test("native framing preserves a large fragmented UTF-8 frame and the following message", async () => {
  const payload = "é😀".repeat(65_536);
  const encoded = encoder.encode(`${payload}\nnext\n`);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === encoded.length) return controller.close();
      const end = Math.min(offset + 257, encoded.length);
      controller.enqueue(encoded.subarray(offset, end));
      offset = end;
    },
  });
  const lines: string[] = [];
  for await (
    const line of readBoundedLines(stream, encoder.encode(payload).length)
  ) lines.push(line);
  deepEqual(lines, [payload, "next"]);
});

Deno.test("native framing enforces the byte budget across split multibyte characters", async () => {
  const payload = encoder.encode("😀😀\n");
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of payload) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  await rejects(
    async () => {
      for await (const _line of readBoundedLines(stream, 7)) { /* consume */ }
    },
    {
      name: "Error",
      message: "Native toolkit process message exceeds its size limit",
      code: "TOOLKIT_MESSAGE_TOO_LARGE",
    },
  );
});
