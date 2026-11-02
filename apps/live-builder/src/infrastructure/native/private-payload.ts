import { isSha256Hex } from "../../domain/primitives/execution-digest.ts";
/** Bounded transfer files inside a process owner's private epoch directory.
 * The owner removes failed/partial transfers only after its child has exited. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, open, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const MAX_PRIVATE_PAYLOAD_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;
const FILE_NAME =
  /^payload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/;

export type PrivatePayloadDescriptor = {
  fileName: string;
  bytes: number;
  digest: string;
};

export type PrivatePayloadErrorCode =
  | "INVALID_INPUT"
  | "QUERY_LIMIT"
  | "INTEGRITY"
  | "PAYLOAD_ABORTED";

export class PrivatePayloadError extends Error {
  constructor(
    readonly code: PrivatePayloadErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PrivatePayloadError";
  }
}

interface PrivatePayloadStat {
  isFile: boolean;
  size: number;
}

export interface PrivatePayloadFileSystem {
  openNew(path: string): Promise<{
    write(bytes: Uint8Array): Promise<number>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  openReadNoFollow(path: string): Promise<{
    stat(): Promise<PrivatePayloadStat>;
    read(target: Uint8Array, position: number): Promise<number>;
    close(): Promise<void>;
  }>;
  lstat(path: string): Promise<PrivatePayloadStat & { isSymlink: boolean }>;
  chmod(path: string, mode: number): Promise<void>;
  remove(path: string): Promise<void>;
}

const defaultFileSystem: PrivatePayloadFileSystem = {
  async openNew(path) {
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    return {
      write: async (bytes) => (await file.write(bytes)).bytesWritten,
      sync: () => file.sync(),
      close: () => file.close(),
    };
  },
  async openReadNoFollow(path) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return {
      stat: async () => {
        const stat = await file.stat();
        return { isFile: stat.isFile(), size: stat.size };
      },
      read: async (target, position) =>
        (await file.read(target, 0, target.length, position)).bytesRead,
      close: () => file.close(),
    };
  },
  lstat: async (path) => {
    const stat = await lstat(path);
    return {
      isFile: stat.isFile(),
      isSymlink: stat.isSymbolicLink(),
      size: stat.size,
    };
  },
  chmod,
  remove: unlink,
};

function integrity(error: unknown): PrivatePayloadError {
  return error instanceof PrivatePayloadError
    ? error
    : new PrivatePayloadError("INTEGRITY", "Private payload transfer failed", {
      cause: error,
    });
}

function payloadPath(directory: string, fileName: unknown): string {
  if (
    typeof directory !== "string" || !isAbsolute(directory) ||
    typeof fileName !== "string" || fileName.length !== 48 ||
    !FILE_NAME.test(fileName)
  ) {
    throw new PrivatePayloadError(
      "INVALID_INPUT",
      "Expected a private absolute directory and a safe payload basename",
    );
  }
  return join(directory, fileName);
}

function checkSize(bytes: unknown): asserts bytes is number {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) {
    throw new PrivatePayloadError(
      "INVALID_INPUT",
      "Invalid private payload size",
    );
  }
  if (bytes > MAX_PRIVATE_PAYLOAD_BYTES) {
    throw new PrivatePayloadError(
      "QUERY_LIMIT",
      "Private payload exceeds 256 MiB",
    );
  }
}

function checkDigest(digest: unknown): asserts digest is string {
  if (
    !isSha256Hex(digest)
  ) {
    throw new PrivatePayloadError(
      "INVALID_INPUT",
      "Expected a lowercase SHA-256",
    );
  }
}

function descriptorCopy(
  descriptor: PrivatePayloadDescriptor,
): PrivatePayloadDescriptor {
  if (!descriptor || typeof descriptor !== "object") {
    throw new PrivatePayloadError(
      "INVALID_INPUT",
      "Missing private payload descriptor",
    );
  }
  const { fileName, bytes, digest } = descriptor;
  checkSize(bytes);
  checkDigest(digest);
  return { fileName, bytes, digest };
}

function checkFile(stat: PrivatePayloadStat, expectedBytes: number): void {
  if (!stat.isFile || stat.size !== expectedBytes) {
    throw new PrivatePayloadError(
      "INTEGRITY",
      "Private payload must remain a regular file with its declared size",
    );
  }
}

/** Stage without copying the whole input. Each <=1 MiB chunk is owned while
 * writes await; the digest covers exactly those slices, including short writes.
 * Failed files remain owned by the epoch until its child status is observed. */
export async function stagePrivatePayload(
  directory: string,
  bytes: Uint8Array,
  expectedDigest: string,
  options: { fs?: PrivatePayloadFileSystem; isCancelled?: () => boolean } = {},
): Promise<PrivatePayloadDescriptor> {
  if (!(bytes instanceof Uint8Array)) {
    throw new PrivatePayloadError("INVALID_INPUT", "Expected payload bytes");
  }
  const size = bytes.byteLength;
  checkSize(size);
  checkDigest(expectedDigest);
  const fileName = `payload-${randomUUID()}.bin`;
  const path = payloadPath(directory, fileName);
  const fs = options.fs ?? defaultFileSystem;
  const checkpoint = () => {
    if (options.isCancelled?.()) {
      throw new PrivatePayloadError(
        "PAYLOAD_ABORTED",
        "Private payload transfer cancelled",
      );
    }
    if (bytes.byteLength !== size) {
      throw new PrivatePayloadError(
        "INTEGRITY",
        "Payload buffer size changed during transfer",
      );
    }
  };
  let writer:
    | Awaited<ReturnType<PrivatePayloadFileSystem["openNew"]>>
    | undefined;
  let failure: PrivatePayloadError | undefined;
  try {
    checkpoint();
    writer = await fs.openNew(path);
    checkpoint();
    const hash = createHash("sha256");
    for (let offset = 0; offset < size;) {
      checkpoint();
      // Buffer is also a Uint8Array, but Buffer.slice() keeps shared storage.
      // Copy synchronously into a bounded plain array before any write awaits.
      const chunk = new Uint8Array(Math.min(CHUNK_BYTES, size - offset));
      chunk.set(bytes.subarray(offset, offset + chunk.length));
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        checkpoint();
        const count = await writer.write(chunk.subarray(written));
        checkpoint();
        if (
          !Number.isSafeInteger(count) || count < 1 ||
          count > chunk.length - written
        ) {
          throw new PrivatePayloadError(
            "INTEGRITY",
            "Invalid private payload write count",
          );
        }
        written += count;
      }
      offset += chunk.length;
    }
    checkpoint();
    await writer.sync();
    checkpoint();
    await fs.chmod(path, 0o400);
    checkpoint();
    if (hash.digest("hex") !== expectedDigest) {
      throw new PrivatePayloadError(
        "INTEGRITY",
        "Private payload digest mismatch",
      );
    }
  } catch (error) {
    failure = integrity(error);
  } finally {
    if (writer) {
      try {
        await writer.close();
      } catch (error) {
        failure ??= integrity(error);
      }
    }
  }
  if (failure) throw failure;
  checkpoint();
  return { fileName, bytes: size, digest: expectedDigest };
}

/** Read through an O_NOFOLLOW descriptor and verify the complete bytes before
 * exposing them. The result is the only allocation proportional to file size. */
export async function readPrivatePayload(
  directory: string,
  descriptor: PrivatePayloadDescriptor,
  options: { fs?: PrivatePayloadFileSystem } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const expected = descriptorCopy(descriptor);
  const path = payloadPath(directory, expected.fileName);
  const fs = options.fs ?? defaultFileSystem;
  let reader:
    | Awaited<ReturnType<PrivatePayloadFileSystem["openReadNoFollow"]>>
    | undefined;
  let failure: PrivatePayloadError | undefined;
  let output: Uint8Array<ArrayBuffer> | undefined;
  try {
    const before = await fs.lstat(path);
    checkFile(before, expected.bytes);
    if (before.isSymlink) {
      throw new PrivatePayloadError(
        "INTEGRITY",
        "Private payload cannot be a symlink",
      );
    }
    reader = await fs.openReadNoFollow(path);
    checkFile(await reader.stat(), expected.bytes);
    output = new Uint8Array(expected.bytes);
    const hash = createHash("sha256");
    for (let offset = 0; offset < expected.bytes;) {
      const target = output.subarray(
        offset,
        Math.min(offset + CHUNK_BYTES, expected.bytes),
      );
      const count = await reader.read(target, offset);
      if (
        !Number.isSafeInteger(count) || count < 1 || count > target.length
      ) {
        throw new PrivatePayloadError(
          "INTEGRITY",
          "Private payload ended before its declared size",
        );
      }
      hash.update(target.subarray(0, count));
      offset += count;
    }
    if (await reader.read(new Uint8Array(1), expected.bytes) !== 0) {
      throw new PrivatePayloadError(
        "INTEGRITY",
        "Private payload contains trailing bytes",
      );
    }
    checkFile(await reader.stat(), expected.bytes);
    const after = await fs.lstat(path);
    checkFile(after, expected.bytes);
    if (after.isSymlink || hash.digest("hex") !== expected.digest) {
      throw new PrivatePayloadError(
        "INTEGRITY",
        "Private payload changed or its digest mismatches",
      );
    }
  } catch (error) {
    failure = integrity(error);
  } finally {
    if (reader) {
      try {
        await reader.close();
      } catch (error) {
        failure ??= integrity(error);
      }
    }
  }
  if (failure) throw failure;
  return output!;
}

/** Successful consumers remove one validated basename. A concurrently removed
 * epoch is already clean; all other cleanup failures remain visible. */
export async function removePrivatePayload(
  directory: string,
  descriptor: PrivatePayloadDescriptor,
  options: { fs?: PrivatePayloadFileSystem } = {},
): Promise<void> {
  const path = payloadPath(directory, descriptor?.fileName);
  try {
    await (options.fs ?? defaultFileSystem).remove(path);
  } catch (error) {
    const detail = error as { code?: unknown; name?: unknown } | null;
    if (detail?.code === "ENOENT" || detail?.name === "NotFound") return;
    throw integrity(error);
  }
}
