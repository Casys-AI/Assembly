import { deepEqual, equal, throws } from "node:assert/strict";
import {
  handleNativeToolkitRequest,
  processEpochFromArgs,
  runToolkitNativeProcess,
  snapshotDirectoryFromArgs,
} from "./native-process.ts";
import type { ToolkitBundlePin, ToolkitRuntime } from "./runtime/loader.ts";
import type { NativeProcessDeps } from "./native-process.ts";

const PIN: ToolkitBundlePin = {
  directory: "/pkg",
  version: "0.10.10+ase.2",
  digest: "digest-1",
};

function depsReturning(overrides: Partial<ToolkitRuntime>): NativeProcessDeps {
  const runtime: ToolkitRuntime = {
    version: "0.10.10+ase.2",
    bundle: PIN,
    provenance: () =>
      Promise.resolve({ version: PIN.version, digest: PIN.digest }),
    checkSyntax: () => "[]",
    createSession: () => {
      throw new Error("no session in this fake");
    },
    ...overrides,
  };
  return { loadRuntime: () => Promise.resolve(runtime) };
}

Deno.test("native request handler serves pin and provenance without sessions", async () => {
  const deps = depsReturning({});
  const pin = await handleNativeToolkitRequest("/pkg", undefined, {
    operation: "pin",
  }, deps);
  equal(pin.ok, true);
  equal(pin.reusable, true);
  equal((pin.result as ToolkitBundlePin).digest, "digest-1");
  const provenance = await handleNativeToolkitRequest("/pkg", PIN, {
    operation: "provenance",
  }, deps);
  equal(provenance.ok, true);
  equal(
    (provenance.result as { digest: string }).digest,
    "digest-1",
  );
});

Deno.test("unknown operations refuse before loading any runtime", async () => {
  let loads = 0;
  const deps: NativeProcessDeps = {
    loadRuntime: () => {
      loads++;
      return Promise.reject(new Error("must not load"));
    },
  };
  const outcome = await handleNativeToolkitRequest(
    "/pkg",
    undefined,
    { operation: "explode" } as never,
    deps,
  );
  equal(outcome.ok, false);
  equal(outcome.reusable, false);
  equal(loads, 0);
});

Deno.test("ordinary refusals stay reusable but panics recycle the process", async () => {
  const ordinary = depsReturning({
    provenance: () => Promise.reject(new Error("plain refusal")),
  });
  const refused = await handleNativeToolkitRequest("/pkg", undefined, {
    operation: "provenance",
  }, ordinary);
  equal(refused.ok, false);
  equal(refused.reusable, true);
  equal(refused.error?.message, "plain refusal");

  const panicking = depsReturning({
    provenance: () => Promise.reject(new Error("NATIVE_PANIC: boom")),
  });
  const panicked = await handleNativeToolkitRequest("/pkg", undefined, {
    operation: "provenance",
  }, panicking);
  equal(panicked.ok, false);
  equal(panicked.reusable, false);

  const invalidating = depsReturning({
    createLspServer: () => {
      throw new Error("NATIVE_PANIC: lsp");
    },
  });
  // The tokens operation drives the runtime through the adapter seam; the
  // handler wrapper observes invalidate/panic and reports non-reusable.
  const tokens = await handleNativeToolkitRequest("/pkg", undefined, {
    operation: "tokens",
    path: "a.sysml",
    text: "package A;",
  }, invalidating);
  equal(tokens.ok, false);
  equal(tokens.reusable, false);
});

Deno.test("process loop writes hello first and answers envelope requests", async () => {
  const epoch = "test-epoch-1";
  const requests = [
    {
      v: 1,
      kind: "request",
      id: 1,
      processEpoch: epoch,
      packageDir: "/pkg",
      request: { operation: "pin" },
    },
    {
      v: 1,
      kind: "request",
      id: 2,
      processEpoch: epoch,
      packageDir: "/pkg",
      request: { operation: "provenance" },
    },
  ];
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const request of requests) {
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify(request)}\n`),
        );
      }
      controller.close();
    },
  });
  const written: string[] = [];
  const stdout = new WritableStream<Uint8Array>({
    write(chunk) {
      written.push(new TextDecoder().decode(chunk));
    },
  });
  await runToolkitNativeProcess({
    processEpoch: epoch,
    stdin,
    stdout,
    deps: depsReturning({}),
  });
  const lines = written.join("").trim().split("\n").map((line) =>
    JSON.parse(line)
  );
  equal(lines[0].kind, "hello");
  equal(lines[0].processEpoch, epoch);
  equal(typeof lines[0].pid, "number");
  deepEqual(lines.map((line) => line.kind), [
    "hello",
    "started",
    "result",
    "started",
    "result",
  ]);
  equal(lines[2].ok, true);
  equal(lines[2].result.digest, "digest-1");
  equal(lines[4].result.digest, "digest-1");
  // Epoch/session material stays in envelopes only, never in results.
  equal(JSON.stringify(lines[2].result).includes(epoch), false);
});

Deno.test("process loop rejects foreign epochs without answering requests", async () => {
  const failures: string[] = [];
  const stdin = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `${
          JSON.stringify({
            v: 1,
            kind: "request",
            id: 9,
            processEpoch: "other-epoch",
            packageDir: "/pkg",
            request: { operation: "pin" },
          })
        }\n`,
      ));
      controller.close();
    },
  });
  const written: string[] = [];
  await runToolkitNativeProcess({
    processEpoch: "expected-epoch",
    stdin,
    stdout: new WritableStream<Uint8Array>({
      write(chunk) {
        written.push(new TextDecoder().decode(chunk));
      },
    }),
    deps: depsReturning({}),
    onProtocolError: (detail) => failures.push(detail),
  });
  equal(failures.length, 1);
  const lines = written.join("").trim().split("\n").map((line) =>
    JSON.parse(line)
  );
  deepEqual(lines.map((line) => line.kind), ["hello"]);
});

Deno.test("epoch argument parsing requires an explicit value", () => {
  equal(processEpochFromArgs(["--epoch=abc-123"]), "abc-123");
  let threw = false;
  try {
    processEpochFromArgs([]);
  } catch {
    threw = true;
  }
  equal(threw, true);
});

Deno.test("native child requires parent CLI staging and refuses before loading without it", async () => {
  equal(
    snapshotDirectoryFromArgs(["--snapshot-dir=/private/epoch"]),
    "/private/epoch",
  );
  throws(() => snapshotDirectoryFromArgs([]), {
    code: "TOOLKIT_NATIVE_SNAPSHOT_UNAVAILABLE",
    recovery: "PROVISION_PRIVATE_NATIVE_SNAPSHOT_DIRECTORY",
  });
  const input = {
    v: 1,
    kind: "request",
    id: 1,
    processEpoch: "epoch",
    packageDir: "/never-read-installation",
    // A request field cannot provide the process's writable staging path.
    snapshotDirectory: "/request-selected",
    request: { operation: "pin" },
  };
  const written: string[] = [];
  await runToolkitNativeProcess({
    processEpoch: "epoch",
    stdin: new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`${JSON.stringify(input)}\n`),
        );
        controller.close();
      },
    }),
    stdout: new WritableStream({
      write(chunk) {
        written.push(new TextDecoder().decode(chunk));
      },
    }),
  });
  const lines = written.join("").trim().split("\n").map((line) =>
    JSON.parse(line)
  );
  equal(lines[2].ok, false);
  equal(lines[2].error.code, "TOOLKIT_NATIVE_SNAPSHOT_UNAVAILABLE");
});
