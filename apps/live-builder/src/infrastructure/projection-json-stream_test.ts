import assert from "node:assert/strict";
import {
  ProjectionJsonInputError,
  writeProjectionJson,
} from "./projection-json-stream.ts";

function capture() {
  const chunks: Uint8Array[] = [];
  let closes = 0;
  const stream = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk.slice());
    },
    close() {
      closes++;
    },
  });
  return {
    stream,
    chunks,
    closes: () => closes,
    text() {
      const joined = new Uint8Array(
        chunks.reduce((sum, chunk) => sum + chunk.length, 0),
      );
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(joined);
    },
  };
}

function invalid(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ProjectionJsonInputError);
    assert.equal(error.code, "INVALID_PROJECTION_INPUT");
    assert.equal(error.context.reason, reason);
    assert.ok(error.recovery.length > 0);
    return true;
  };
}

Deno.test("projection JSON bytes match stringify across escaping, Unicode, arrays and shared objects", async () => {
  const shared = { emoji: "😀", quote: '"\\\n\t\b\r\f\u0000' };
  const sparse = new Array(3);
  sparse[1] = undefined;
  sparse[2] = shared;
  const value = {
    "10": "integer-key order",
    "2": "before ten",
    undefined: undefined,
    nil: null,
    numbers: [0, -0, 42, 1.25, NaN, Infinity, -Infinity],
    booleans: [true, false],
    sparse,
    nested: { shared, again: shared },
    unicode: "a".repeat(2047) + "😀" + "é漢字\u2028\u2029".repeat(10000),
    loneSurrogates: "\ud800X\udc00",
    empty: "",
  };
  const sink = capture();
  const stats = await writeProjectionJson(sink.stream, value);
  const expected = JSON.stringify(value);
  assert.equal(sink.text(), expected);
  assert.equal(stats.bytes, new TextEncoder().encode(expected).length);
  assert.ok(sink.chunks.length > 1);
  assert.ok(sink.chunks.every((chunk) => chunk.length <= 32 * 1024));
  assert.equal(sink.stream.locked, false);
  assert.equal(sink.closes(), 0, "caller owns stream closure");
  // The serializer's writer was released, so the caller can close normally.
  const writer = sink.stream.getWriter();
  await writer.close();
  writer.releaseLock();
  assert.equal(sink.closes(), 1);
});

Deno.test("projection JSON bounds encoded bytes, string code units, depth and unsupported input", async () => {
  for (
    const [value, options, reason] of [
      ["é", { maxBytes: 3 }, "max-bytes"],
      ["😀", { maxStringLength: 1 }, "max-string-length"],
      [{ longKey: 1 }, { maxStringLength: 2 }, "max-string-length"],
      [undefined, {}, "non-json-value"],
      [1n, {}, "non-json-value"],
      [{ callback: () => 1 }, {}, "non-json-value"],
      [new Date(0), {}, "non-plain-object"],
      [null, { maxBytes: -1 }, "invalid-option"],
    ] as const
  ) {
    const sink = capture();
    await assert.rejects(
      writeProjectionJson(sink.stream, value, options),
      invalid(reason),
    );
    assert.equal(sink.stream.locked, false);
    assert.equal(sink.closes(), 0);
  }
  const cyclic: { self?: unknown } = {};
  cyclic.self = cyclic;
  await assert.rejects(
    writeProjectionJson(capture().stream, cyclic),
    invalid("cycle"),
  );
  let deep: unknown = null;
  for (let index = 0; index < 257; index++) deep = [deep];
  await assert.rejects(
    writeProjectionJson(capture().stream, deep),
    invalid("max-depth"),
  );
  const empty = capture();
  await writeProjectionJson(empty.stream, "", { maxStringLength: 0 });
  assert.equal(empty.text(), '""');
});

Deno.test("projection JSON aborts before work and while blocked in a write, without closing", async () => {
  const before = new AbortController();
  const reason = new Error("requested projection cancellation");
  before.abort(reason);
  const untouched = capture();
  await assert.rejects(
    writeProjectionJson(untouched.stream, {}, { signal: before.signal }),
    (error) => error === reason,
  );
  assert.equal(untouched.chunks.length, 0);
  assert.equal(untouched.stream.locked, false);

  const during = new AbortController();
  let writeStarted!: () => void;
  const started = new Promise<void>((resolve) => writeStarted = resolve);
  let releaseWrite!: () => void;
  const writing = new Promise<void>((resolve) => releaseWrite = resolve);
  let closes = 0;
  const stream = new WritableStream<Uint8Array>({
    write() {
      writeStarted();
      return writing;
    },
    close() {
      closes++;
    },
  });
  const operation = writeProjectionJson(stream, "x".repeat(100000), {
    signal: during.signal,
  });
  const rejected = assert.rejects(operation, (error) => error === reason);
  await started;
  during.abort(reason);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      rejected,
      new Promise<never>((_, reject) => {
        guard = setTimeout(
          () => reject(new Error("abort waited on backpressure")),
          500,
        );
      }),
    ]);
    assert.equal(stream.locked, false);
    assert.equal(closes, 0);
  } finally {
    clearTimeout(guard);
    releaseWrite();
    await rejected;
  }
});

Deno.test("projection JSON yields to other tasks between writes of a large graph", async () => {
  const graph = Array.from({ length: 30000 }, (_, index) => ({
    id: index,
    text: "artifact declaration é漢😀 ".repeat(4),
    refs: ["holder", "target", null],
  }));
  const events: Array<"write" | "tick"> = [];
  const heartbeat = setInterval(() => events.push("tick"), 1);
  const stream = new WritableStream<Uint8Array>({
    write() {
      events.push("write");
    },
  });
  try {
    const stats = await writeProjectionJson(stream, graph, { quantumMs: 1 });
    assert.ok(stats.bytes > 1024 * 1024);
    assert.ok(
      stats.yields > 1,
      "explicit task yields happen even with immediate writes",
    );
    // A timer task ran while serialization was still producing chunks.
    const ticksBetweenWrites = events.slice(
      events.indexOf("write"),
      events.lastIndexOf("write"),
    ).filter((event) => event === "tick").length;
    assert.ok(ticksBetweenWrites > 0, "no task ran between serializer writes");
    assert.equal(stream.locked, false);
  } finally {
    clearInterval(heartbeat);
  }
});
