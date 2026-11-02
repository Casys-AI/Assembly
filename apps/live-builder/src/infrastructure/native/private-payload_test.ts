import { deepEqual, equal, rejects } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  MAX_PRIVATE_PAYLOAD_BYTES,
  type PrivatePayloadDescriptor,
  PrivatePayloadError,
  type PrivatePayloadFileSystem,
  readPrivatePayload,
  removePrivatePayload,
  stagePrivatePayload,
} from "./private-payload.ts";

const DIRECTORY = "/private/epoch";
const FILE_NAME = "payload-11111111-2222-4333-8444-555555555555.bin";
const CHUNK_BYTES = 1024 * 1024;
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

interface Entry {
  data: Uint8Array;
  isFile: boolean;
  isSymlink: boolean;
}

class FakeFileSystem implements PrivatePayloadFileSystem {
  readonly files = new Map<string, Entry>();
  readonly removed: string[] = [];
  readonly writeViews: Uint8Array[] = [];
  readonly readViews: Uint8Array[] = [];
  readonly modes: number[] = [];
  opens = 0;
  readerOpens = 0;
  writerCloses = 0;
  readerCloses = 0;
  syncs = 0;
  stats = 0;
  maxWrite = 333_333;
  maxRead = 333_333;
  reportLstatSize?: number;
  reportFstatSize?: (call: number, actual: number) => number;
  onOpen?: () => void;
  onWrite?: () => void;
  onSync?: () => void;
  onChmod?: () => void;
  onWriterClose?: () => void;
  onReadOpen?: (entry: Entry) => void;
  onRead?: (position: number, entry: Entry) => void;
  removeError?: Error;

  put(data: Uint8Array): PrivatePayloadDescriptor {
    this.files.set(`${DIRECTORY}/${FILE_NAME}`, {
      data: data.slice(),
      isFile: true,
      isSymlink: false,
    });
    return { fileName: FILE_NAME, bytes: data.length, digest: digest(data) };
  }

  openNew(path: string) {
    this.opens++;
    if (this.files.has(path)) return Promise.reject(new Error("EEXIST"));
    const entry: Entry = {
      data: new Uint8Array(),
      isFile: true,
      isSymlink: false,
    };
    this.files.set(path, entry);
    this.onOpen?.();
    return Promise.resolve({
      write: (bytes: Uint8Array) => {
        this.writeViews.push(bytes);
        const count = Math.min(bytes.length, this.maxWrite);
        const grown = new Uint8Array(entry.data.length + count);
        grown.set(entry.data);
        grown.set(bytes.subarray(0, count), entry.data.length);
        entry.data = grown;
        this.onWrite?.();
        return Promise.resolve(count);
      },
      sync: () => {
        this.syncs++;
        this.onSync?.();
        return Promise.resolve();
      },
      close: () => {
        this.writerCloses++;
        this.onWriterClose?.();
        return Promise.resolve();
      },
    });
  }

  openReadNoFollow(path: string) {
    const entry = this.files.get(path)!;
    this.onReadOpen?.(entry);
    if (entry.isSymlink) return Promise.reject(new Error("ELOOP"));
    this.readerOpens++;
    return Promise.resolve({
      stat: () => {
        this.stats++;
        return Promise.resolve({
          isFile: entry.isFile,
          size: this.reportFstatSize?.(this.stats, entry.data.length) ??
            entry.data.length,
        });
      },
      read: (target: Uint8Array, position: number) => {
        this.readViews.push(target);
        const count = Math.max(
          0,
          Math.min(target.length, entry.data.length - position, this.maxRead),
        );
        target.set(entry.data.subarray(position, position + count));
        this.onRead?.(position, entry);
        return Promise.resolve(count);
      },
      close: () => {
        this.readerCloses++;
        return Promise.resolve();
      },
    });
  }

  lstat(path: string) {
    const entry = this.files.get(path)!;
    return Promise.resolve({
      isFile: entry.isFile,
      isSymlink: entry.isSymlink,
      size: this.reportLstatSize ?? entry.data.length,
    });
  }
  chmod(_path: string, mode: number) {
    this.modes.push(mode);
    this.onChmod?.();
    return Promise.resolve();
  }
  remove(path: string) {
    if (this.removeError) return Promise.reject(this.removeError);
    this.removed.push(path);
    this.files.delete(path);
    return Promise.resolve();
  }
}

const isCode = (code: PrivatePayloadError["code"]) => (error: unknown) =>
  error instanceof PrivatePayloadError && error.code === code;

Deno.test("private payload staging owns bounded chunks, completes partial writes and seals after fsync", async () => {
  const fs = new FakeFileSystem();
  const source = new Uint8Array(CHUNK_BYTES * 2 + 5).fill(7);
  const expected = digest(source);
  fs.onWrite = () => source.fill(9, 0, CHUNK_BYTES);
  const descriptor = await stagePrivatePayload(DIRECTORY, source, expected, {
    fs,
  });
  equal(descriptor.bytes, CHUNK_BYTES * 2 + 5);
  equal(descriptor.digest, expected);
  equal(/^payload-[0-9a-f-]{36}\.bin$/.test(descriptor.fileName), true);
  equal(fs.writeViews.every((view) => view.buffer !== source.buffer), true);
  equal(
    fs.writeViews.every((view) => view.buffer.byteLength <= CHUNK_BYTES),
    true,
  );
  equal(fs.writeViews.length > 3, true);
  equal(fs.syncs, 1);
  equal(fs.writerCloses, 1);
  deepEqual(fs.modes, [0o400]);
  const staged = fs.files.get(`${DIRECTORY}/${descriptor.fileName}`)!;
  equal(digest(staged.data), expected);
  deepEqual(fs.removed, []);
});

Deno.test("staging refuses mutated unread bytes, digest mismatch and changed byte accounting without deleting partial files", async () => {
  const mutated = new FakeFileSystem();
  const source = new Uint8Array(CHUNK_BYTES + 1).fill(3);
  const expected = digest(source);
  mutated.onWrite = () => source[CHUNK_BYTES] = 4;
  await rejects(
    stagePrivatePayload(DIRECTORY, source, expected, { fs: mutated }),
    isCode("INTEGRITY"),
  );
  equal(mutated.writerCloses, 1);
  equal(mutated.files.size, 1);
  deepEqual(mutated.removed, []);

  const wrong = new FakeFileSystem();
  await rejects(
    stagePrivatePayload(DIRECTORY, new Uint8Array([1]), "0".repeat(64), {
      fs: wrong,
    }),
    isCode("INTEGRITY"),
  );
  equal(wrong.writerCloses, 1);

  const resized = new FakeFileSystem();
  const buffer = new ArrayBuffer(8, { maxByteLength: 16 });
  const changing = new Uint8Array(buffer).fill(1);
  const originalDigest = digest(changing);
  resized.onWrite = () => buffer.resize(4);
  await rejects(
    stagePrivatePayload(DIRECTORY, changing, originalDigest, { fs: resized }),
    isCode("INTEGRITY"),
  );
  equal(resized.writerCloses, 1);
  equal(resized.files.size, 1);
  deepEqual(resized.removed, []);
});

Deno.test("staging copies Buffer inputs before partial writes can observe caller mutation", async () => {
  const fs = new FakeFileSystem();
  fs.maxWrite = 2;
  const source = Buffer.from([1, 2, 3, 4, 5]);
  const expected = digest(source);
  fs.onWrite = () => source.fill(9);
  const descriptor = await stagePrivatePayload(DIRECTORY, source, expected, {
    fs,
  });
  equal(fs.writeViews.every((view) => view.buffer !== source.buffer), true);
  deepEqual(
    fs.files.get(`${DIRECTORY}/${descriptor.fileName}`)!.data,
    new Uint8Array([1, 2, 3, 4, 5]),
  );
  equal(descriptor.digest, expected);
  equal(fs.writerCloses, 1);
});

Deno.test("staging cancellation closes an opened writer at every asynchronous checkpoint", async () => {
  for (
    const checkpoint of [
      "onOpen",
      "onWrite",
      "onSync",
      "onChmod",
      "onWriterClose",
    ] as const
  ) {
    const fs = new FakeFileSystem();
    let cancelled = false;
    fs[checkpoint] = () => cancelled = true;
    const bytes = new Uint8Array([1, 2, 3]);
    await rejects(
      stagePrivatePayload(DIRECTORY, bytes, digest(bytes), {
        fs,
        isCancelled: () => cancelled,
      }),
      isCode("PAYLOAD_ABORTED"),
    );
    equal(fs.writerCloses, 1);
    equal(fs.files.size, 1);
    deepEqual(fs.removed, []);
  }
  const untouched = new FakeFileSystem();
  const empty = new Uint8Array();
  await rejects(
    stagePrivatePayload(DIRECTORY, empty, digest(empty), {
      fs: untouched,
      isCancelled: () => true,
    }),
    isCode("PAYLOAD_ABORTED"),
  );
  equal(untouched.opens, 0);
});

Deno.test("staging refuses invalid SHA, oversized buffers and writes that make no progress", async () => {
  const fs = new FakeFileSystem();
  for (const invalid of ["A".repeat(64), `${"a".repeat(64)}\n`, "short"]) {
    await rejects(
      stagePrivatePayload(DIRECTORY, new Uint8Array(), invalid, { fs }),
      isCode("INVALID_INPUT"),
    );
  }
  class OversizedBytes extends Uint8Array {
    override get byteLength() {
      return MAX_PRIVATE_PAYLOAD_BYTES + 1;
    }
  }
  await rejects(
    stagePrivatePayload(DIRECTORY, new OversizedBytes(), "a".repeat(64), {
      fs,
    }),
    isCode("QUERY_LIMIT"),
  );
  equal(fs.opens, 0);
  fs.maxWrite = 0;
  const bytes = new Uint8Array([1]);
  await rejects(
    stagePrivatePayload(DIRECTORY, bytes, digest(bytes), { fs }),
    isCode("INTEGRITY"),
  );
  equal(fs.writerCloses, 1);
});

Deno.test("private payload reading fills one result allocation through bounded partial reads", async () => {
  const fs = new FakeFileSystem();
  const bytes = new Uint8Array(CHUNK_BYTES + 5).fill(6);
  const descriptor = fs.put(bytes);
  const result = await readPrivatePayload(DIRECTORY, descriptor, { fs });
  deepEqual(result, bytes);
  equal(fs.readerCloses, 1);
  equal(fs.stats, 2);
  equal(fs.readViews.every((view) => view.length <= CHUNK_BYTES), true);
  equal(
    fs.readViews.slice(0, -1).every((view) => view.buffer === result.buffer),
    true,
  );
  equal(fs.readViews.at(-1)!.length, 1);
});

Deno.test("read descriptors refuse traversal, malformed sizes and noncanonical SHA before file access", async () => {
  const fs = new FakeFileSystem();
  const descriptor = fs.put(new Uint8Array([1]));
  for (
    const fileName of [
      "../secret",
      `/tmp/${FILE_NAME}`,
      `${FILE_NAME}\n`,
      FILE_NAME.toUpperCase(),
      `${FILE_NAME}/../secret`,
    ]
  ) {
    await rejects(
      readPrivatePayload(DIRECTORY, { ...descriptor, fileName }, { fs }),
      isCode("INVALID_INPUT"),
    );
  }
  for (const bytes of [-1, 1.5, NaN, Infinity]) {
    await rejects(
      readPrivatePayload(DIRECTORY, { ...descriptor, bytes }, { fs }),
      isCode("INVALID_INPUT"),
    );
  }
  await rejects(
    readPrivatePayload(DIRECTORY, {
      ...descriptor,
      bytes: MAX_PRIVATE_PAYLOAD_BYTES + 1,
    }, { fs }),
    isCode("QUERY_LIMIT"),
  );
  await rejects(
    readPrivatePayload(DIRECTORY, {
      ...descriptor,
      digest: `${descriptor.digest}\n`,
    }, { fs }),
    isCode("INVALID_INPUT"),
  );
  equal(fs.readerOpens, 0);
});

Deno.test("private payload reading rejects symlinks before open and during a no-follow open", async () => {
  const fs = new FakeFileSystem();
  const descriptor = fs.put(new Uint8Array([1]));
  fs.files.get(`${DIRECTORY}/${FILE_NAME}`)!.isSymlink = true;
  await rejects(
    readPrivatePayload(DIRECTORY, descriptor, { fs }),
    isCode("INTEGRITY"),
  );
  equal(fs.readerOpens, 0);

  fs.files.get(`${DIRECTORY}/${FILE_NAME}`)!.isSymlink = false;
  fs.onReadOpen = (entry) => entry.isSymlink = true;
  await rejects(
    readPrivatePayload(DIRECTORY, descriptor, { fs }),
    isCode("INTEGRITY"),
  );
  equal(fs.readerOpens, 0);
  equal(fs.readerCloses, 0);
});

Deno.test("private payload reading refuses lstat/fstat sizes, early EOF, trailing bytes and final size drift", async () => {
  for (const mode of ["lstat", "fstat", "eof", "trailing", "final"] as const) {
    const fs = new FakeFileSystem();
    const descriptor = fs.put(new Uint8Array([1, 2, 3]));
    if (mode === "lstat") fs.reportLstatSize = 4;
    if (mode === "fstat") fs.reportFstatSize = () => 4;
    if (mode === "eof") fs.maxRead = 0;
    if (mode === "trailing") {
      fs.onRead = (_position, entry) =>
        entry.data = new Uint8Array([1, 2, 3, 4]);
    }
    if (mode === "final") {
      fs.reportFstatSize = (call, actual) => call === 2 ? 4 : actual;
    }
    await rejects(
      readPrivatePayload(DIRECTORY, descriptor, { fs }),
      isCode("INTEGRITY"),
    );
    equal(fs.readerCloses, mode === "lstat" ? 0 : 1);
  }
});

Deno.test("private payload reading rejects changed content or SHA and closes its reader", async () => {
  const fs = new FakeFileSystem();
  const descriptor = fs.put(new Uint8Array([1, 2, 3, 4]));
  fs.maxRead = 2;
  fs.onRead = (position, entry) => {
    if (position === 0) entry.data[2] = 9;
  };
  await rejects(
    readPrivatePayload(DIRECTORY, descriptor, { fs }),
    isCode("INTEGRITY"),
  );
  equal(fs.readerCloses, 1);
  const wrong = new FakeFileSystem();
  wrong.put(new Uint8Array([1, 2, 3, 4]));
  await rejects(
    readPrivatePayload(DIRECTORY, { ...descriptor, digest: "0".repeat(64) }, {
      fs: wrong,
    }),
    isCode("INTEGRITY"),
  );
  equal(wrong.readerCloses, 1);
});

Deno.test("empty payloads transfer and removal is exact, traversal-safe and idempotent only for absent files", async () => {
  const fs = new FakeFileSystem();
  const empty = new Uint8Array();
  const descriptor = await stagePrivatePayload(
    DIRECTORY,
    empty,
    digest(empty),
    { fs },
  );
  deepEqual(await readPrivatePayload(DIRECTORY, descriptor, { fs }), empty);
  await removePrivatePayload(DIRECTORY, descriptor, { fs });
  deepEqual(fs.removed, [`${DIRECTORY}/${descriptor.fileName}`]);
  await rejects(
    removePrivatePayload(DIRECTORY, { ...descriptor, fileName: "../secret" }, {
      fs,
    }),
    isCode("INVALID_INPUT"),
  );
  equal(fs.removed.length, 1);
  fs.removeError = Object.assign(new Error("already removed"), {
    code: "ENOENT",
  });
  await removePrivatePayload(DIRECTORY, descriptor, { fs });
  fs.removeError = Object.assign(new Error("already removed"), {
    name: "NotFound",
  });
  await removePrivatePayload(DIRECTORY, descriptor, { fs });
  fs.removeError = Object.assign(new Error("forbidden"), { code: "EPERM" });
  await rejects(
    removePrivatePayload(DIRECTORY, descriptor, { fs }),
    isCode("INTEGRITY"),
  );
});
