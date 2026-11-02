import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

/** Storage framing only; domain JSON, digests and provider bytes are unchanged. */
export const RUNTIME_SNAPSHOT_PREFIX = "assembly-runtime-snapshot:";
export const RUNTIME_SNAPSHOT_HEADER_CHARS = RUNTIME_SNAPSHOT_PREFIX.length +
  "1:gzip:0000000000:".length + 64 + 1;
export const MAX_RUNTIME_SNAPSHOT_CODEC_BYTES = 64 * 1024 * 1024;
const MIN_COMPRESSION_BYTES = 16 * 1024;
const headerPattern =
  /^assembly-runtime-snapshot:1:gzip:([0-9]{10}):([0-9a-f]{64}):$/;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function invalid(): never {
  throw new Error("Unsupported or corrupt runtime snapshot encoding");
}

/** Inspect a bounded SQL prefix and stored byte count before fetching a payload.
 * The declared size is untrusted until decode verifies length and SHA-256. */
export function runtimeSnapshotPayloadInfo(
  prefix: string,
  storedBytes: number,
): { encoded: boolean; decodedBytes: number } {
  if (!Number.isSafeInteger(storedBytes) || storedBytes < 0) invalid();
  if (!prefix.startsWith(RUNTIME_SNAPSHOT_PREFIX)) {
    return { encoded: false, decodedBytes: storedBytes };
  }
  const match = headerPattern.exec(
    prefix.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS),
  );
  if (!match || storedBytes > MAX_RUNTIME_SNAPSHOT_CODEC_BYTES) invalid();
  const decodedBytes = Number(match[1]);
  const base64Bytes = storedBytes - RUNTIME_SNAPSHOT_HEADER_CHARS;
  if (
    decodedBytes < 1 || decodedBytes > MAX_RUNTIME_SNAPSHOT_CODEC_BYTES ||
    storedBytes >= decodedBytes ||
    base64Bytes < 4 || base64Bytes % 4 !== 0
  ) invalid();
  return { encoded: true, decodedBytes };
}

/** Framing header of an encoded payload, or null for legacy plain JSON. It
 * carries the decoded size and SHA-256: once decode has verified a payload,
 * an equal header names the same content. Never a substitute for decode. */
export function runtimeSnapshotHeader(payload: string): string | null {
  return payload.startsWith(RUNTIME_SNAPSHOT_PREFIX)
    ? payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS)
    : null;
}

/** Synchronous so save() still freezes caller-owned state before yielding.
 * Oversized or nonbeneficial JSON remains legacy plain text without a new cap. */
export function encodeRuntimeSnapshotPayload(json: string): string {
  const length = Buffer.byteLength(json, "utf8");
  if (
    length < MIN_COMPRESSION_BYTES ||
    length > MAX_RUNTIME_SNAPSHOT_CODEC_BYTES
  ) return json;
  const bytes = Buffer.from(json, "utf8");
  const compressed = gzipSync(bytes, { level: 6 });
  const header = `${RUNTIME_SNAPSHOT_PREFIX}1:gzip:${
    bytes.length.toString().padStart(10, "0")
  }:${createHash("sha256").update(bytes).digest("hex")}:`;
  const payload = header + compressed.toString("base64");
  return payload.length < bytes.length &&
      payload.length <= MAX_RUNTIME_SNAPSHOT_CODEC_BYTES
    ? payload
    : json;
}

/** Plain JSON is returned byte-for-byte. Encoded output is bounded before zlib
 * allocates it, then checked for exact size, checksum and valid UTF-8. */
export function decodeRuntimeSnapshotPayload(
  payload: string,
  maxDecodedBytes = Number.MAX_SAFE_INTEGER,
): string {
  if (!Number.isSafeInteger(maxDecodedBytes) || maxDecodedBytes < 0) invalid();
  const info = runtimeSnapshotPayloadInfo(
    payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS),
    Buffer.byteLength(payload, "utf8"),
  );
  if (info.decodedBytes > maxDecodedBytes) {
    throw new Error("Runtime snapshot exceeds decoded payload budget");
  }
  if (!info.encoded) return payload;
  const data = payload.slice(RUNTIME_SNAPSHOT_HEADER_CHARS);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    invalid();
  }
  const compressed = Buffer.from(data, "base64");
  if (compressed.toString("base64") !== data) invalid();
  let bytes: Uint8Array;
  try {
    bytes = gunzipSync(compressed, { maxOutputLength: info.decodedBytes });
  } catch {
    invalid();
  }
  const checksum = payload.slice(
    RUNTIME_SNAPSHOT_HEADER_CHARS - 65,
    RUNTIME_SNAPSHOT_HEADER_CHARS - 1,
  );
  if (
    bytes.length !== info.decodedBytes ||
    createHash("sha256").update(bytes).digest("hex") !== checksum
  ) invalid();
  try {
    return utf8.decode(bytes);
  } catch {
    invalid();
  }
}

/** Same content for two payloads that decode has already verified: equal
 * headers (size and SHA-256) when both are framed, else equal decoded text. */
export function sameVerifiedRuntimeSnapshot(a: string, b: string): boolean {
  const left = runtimeSnapshotHeader(a), right = runtimeSnapshotHeader(b);
  return left !== null && right !== null
    ? left === right
    : decodeRuntimeSnapshotPayload(a) === decodeRuntimeSnapshotPayload(b);
}
