import { equal, notEqual, throws } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  decodeRuntimeSnapshotPayload,
  encodeRuntimeSnapshotPayload,
  MAX_RUNTIME_SNAPSHOT_CODEC_BYTES,
  RUNTIME_SNAPSHOT_HEADER_CHARS,
  RUNTIME_SNAPSHOT_PREFIX,
  runtimeSnapshotHeader,
  runtimeSnapshotPayloadInfo,
  sameVerifiedRuntimeSnapshot,
} from "./runtime-snapshot-codec.ts";

const json = JSON.stringify({ text: "État 漢字 🙂 e\u0301\n".repeat(2000) });

function framed(bytes: Uint8Array, declaredLength = bytes.length): string {
  return `${RUNTIME_SNAPSHOT_PREFIX}1:gzip:${
    declaredLength.toString().padStart(10, "0")
  }:${createHash("sha256").update(bytes).digest("hex")}:${
    gzipSync(bytes).toString("base64")
  }`;
}

Deno.test("runtime snapshot codec preserves exact UTF-8 JSON bytes and plain legacy text", () => {
  const payload = encodeRuntimeSnapshotPayload(json);
  equal(payload.startsWith(RUNTIME_SNAPSHOT_PREFIX), true);
  equal(Buffer.byteLength(payload) < Buffer.byteLength(json), true);
  equal(decodeRuntimeSnapshotPayload(payload), json);
  equal(
    runtimeSnapshotPayloadInfo(
      payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS),
      payload.length,
    ).decodedBytes,
    Buffer.byteLength(json),
  );
  const legacy = ' \n{ "text" : "assembly-runtime-snapshot:1:gzip:é" }\n';
  equal(encodeRuntimeSnapshotPayload(legacy), legacy);
  equal(decodeRuntimeSnapshotPayload(legacy), legacy);
});

Deno.test("runtime snapshot codec leaves nonbeneficial JSON plain", () => {
  let seed = 0x12345678;
  const bytes = new Uint8Array(20 * 1024);
  for (let i = 0; i < bytes.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  const plain = JSON.stringify({ text: Buffer.from(bytes).toString("base64") });
  equal(encodeRuntimeSnapshotPayload(plain), plain);
});

Deno.test("runtime snapshot codec refuses unknown, truncated and corrupt envelopes", () => {
  const payload = encodeRuntimeSnapshotPayload(json);
  notEqual(payload, json);
  for (
    const malformed of [
      payload.replace(":1:gzip:", ":2:gzip:"),
      payload.replace(":1:gzip:", ":1:zstd:"),
      payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS - 1),
      payload.slice(0, -4),
      payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS) + "!!!!",
      payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS) + "A===",
      payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS - 65) +
      "0".repeat(64) + payload.slice(RUNTIME_SNAPSHOT_HEADER_CHARS - 1),
      framed(new Uint8Array(20 * 1024).fill(0xff)),
    ]
  ) {
    throws(
      () => decodeRuntimeSnapshotPayload(malformed),
      /corrupt runtime snapshot/,
    );
  }
});

Deno.test("runtime snapshot codec enforces declared and caller bounds before inflation", () => {
  const payload = encodeRuntimeSnapshotPayload(json);
  const declared = Buffer.byteLength(json);
  throws(
    () => decodeRuntimeSnapshotPayload(payload, declared - 1),
    /decoded payload budget/,
  );
  throws(
    () => decodeRuntimeSnapshotPayload(" { } ", 4),
    /decoded payload budget/,
  );
  // A valid gzip stream that expands past its declaration must hit zlib's cap.
  throws(
    () => decodeRuntimeSnapshotPayload(framed(Buffer.from(json), 1000)),
    /corrupt runtime snapshot/,
  );
  throws(
    () => decodeRuntimeSnapshotPayload(framed(Buffer.from(json), declared + 1)),
    /corrupt runtime snapshot/,
  );
  const oversized = framed(
    new Uint8Array([1]),
    MAX_RUNTIME_SNAPSHOT_CODEC_BYTES + 1,
  );
  throws(() =>
    runtimeSnapshotPayloadInfo(
      oversized.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS),
      oversized.length,
    ), /corrupt runtime snapshot/);
  throws(() =>
    runtimeSnapshotPayloadInfo(
      payload.slice(0, RUNTIME_SNAPSHOT_HEADER_CHARS),
      MAX_RUNTIME_SNAPSHOT_CODEC_BYTES + 1,
    ), /corrupt runtime snapshot/);
  equal(
    runtimeSnapshotPayloadInfo("{", MAX_RUNTIME_SNAPSHOT_CODEC_BYTES + 1)
      .decodedBytes,
    MAX_RUNTIME_SNAPSHOT_CODEC_BYTES + 1,
  );
});

Deno.test("Deno node:zlib enforces maxOutputLength during gzip inflation", () => {
  const bytes = Buffer.from("bounded inflation".repeat(4096));
  const gzip = gzipSync(bytes);
  equal(
    gunzipSync(gzip, { maxOutputLength: bytes.length }).length,
    bytes.length,
  );
  throws(() => gunzipSync(gzip, { maxOutputLength: 1000 }), {
    code: "ERR_BUFFER_TOO_LARGE",
  });
});

Deno.test("verified runtime snapshots compare framed headers and fall back to decoded text", () => {
  const payload = encodeRuntimeSnapshotPayload(json);
  const header = runtimeSnapshotHeader(payload)!;
  equal(header.length, RUNTIME_SNAPSHOT_HEADER_CHARS);
  equal(runtimeSnapshotHeader(json), null);
  // Framed pairs are decided by their size and SHA-256 header alone: callers
  // pass payloads that decode has already verified.
  equal(sameVerifiedRuntimeSnapshot(payload, `${header}AAAA`), true);
  const other = encodeRuntimeSnapshotPayload(json.replace("État", "Etat"));
  equal(sameVerifiedRuntimeSnapshot(payload, other), false);
  equal(sameVerifiedRuntimeSnapshot(payload, json), true);
  equal(sameVerifiedRuntimeSnapshot(json, json), true);
  equal(sameVerifiedRuntimeSnapshot(json, `${json} `), false);
});
