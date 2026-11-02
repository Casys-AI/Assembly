import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import { BuildStoreError } from "../../../application/model/builds/ports/out/build-store.port.ts";
import {
  buildDescriptor,
  type BuildRecipeInputs,
} from "../../../domain/model/value-objects/build.ts";
import {
  buildRefFromDescriptor,
  type ProjectionRef,
} from "../../../domain/model/value-objects/element-ref.ts";
import type { SemanticProjectionPreparationInput } from "./preparation.ts";
import {
  encodeSemanticPreparationControl,
  parseSemanticPreparationRequest,
  parseSemanticPreparationResponse,
  readSemanticPreparationControl,
  SEMANTIC_PREPARATION_MAX_CONTROL_BYTES,
  semanticPreparationFailure,
} from "./protocol.ts";

const recipe: BuildRecipeInputs = {
  toolkit: { version: "protocol-fixture", bundleDigest: "9".repeat(64) },
  format: "ase-toolkit-normalized-json-v1",
  normalizerVersion: 2,
  irVersion: "0.1",
  artifactSchema: 1,
  engineVersion: "protocol-fixture",
};
const descriptor = buildDescriptor({
  repositoryId: "protocol-fixture",
  sourceDigest: "1".repeat(64),
  recipe,
  recipeDigest: "2".repeat(64),
  buildKey: "3".repeat(64),
  artifactDigest: "4".repeat(64),
  bytes: 512,
});
const input: SemanticProjectionPreparationInput = {
  build: buildRefFromDescriptor(descriptor),
  descriptor,
};
const projection: ProjectionRef = {
  kind: "rdf-quads",
  projectorVersion: `ase-rdf-quads-v2:${"5".repeat(64)}`,
  artifactDigest: descriptor.artifactDigest,
  projectionDigest: "6".repeat(64),
};
function chunks(...parts: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

Deno.test("semantic preparation protocol carries only a small descriptor and immutable references", () => {
  const request = { v: 1, id: 11, input };
  const bytes = encodeSemanticPreparationControl(request);
  ok(bytes.byteLength < 4096);
  deepStrictEqual(
    parseSemanticPreparationRequest(
      JSON.parse(new TextDecoder().decode(bytes)),
    ),
    request,
  );
  const response = { v: 1, id: 11, ok: true, projection };
  const responseBytes = encodeSemanticPreparationControl(response);
  ok(responseBytes.byteLength < 512);
  const parsed = parseSemanticPreparationResponse(
    JSON.parse(new TextDecoder().decode(responseBytes)),
    11,
  );
  deepStrictEqual(parsed, response);
  deepStrictEqual(Object.keys(parsed), ["v", "id", "ok", "projection"]);
  ok(Object.isFrozen(parsed.ok ? parsed.projection : undefined));
});

Deno.test("semantic preparation protocol snapshots nested descriptor inputs before queue admission", () => {
  const caller = JSON.parse(
    JSON.stringify(input),
  ) as SemanticProjectionPreparationInput;
  const parsed = parseSemanticPreparationRequest({
    v: 1,
    id: 1,
    input: caller,
  });
  Object.assign(caller.build, { artifactDigest: "7".repeat(64) });
  Object.assign(caller.descriptor.recipe.toolkit, {
    version: "caller-mutated",
  });
  equal(parsed.input.build.artifactDigest, input.build.artifactDigest);
  equal(parsed.input.descriptor.recipe.toolkit.version, recipe.toolkit.version);
});

Deno.test("semantic preparation request protocol refuses transport bytes and storage paths at every boundary", () => {
  for (
    const field of ["quads", "artifactBytes", "cachePath", "vaultDirectory"]
  ) {
    throws(() =>
      parseSemanticPreparationRequest({
        v: 1,
        id: 1,
        input,
        [field]: "untrusted",
      })
    );
    throws(() =>
      parseSemanticPreparationRequest({
        v: 1,
        id: 1,
        input: { ...input, [field]: "untrusted" },
      })
    );
    throws(() =>
      parseSemanticPreparationRequest({
        v: 1,
        id: 1,
        input: {
          ...input,
          descriptor: { ...descriptor, [field]: "untrusted" },
        },
      })
    );
  }
});

Deno.test("semantic preparation request protocol refuses malformed envelope versions and identifiers", () => {
  for (const version of [undefined, 0, 2, "1"]) {
    throws(() => parseSemanticPreparationRequest({ v: version, id: 1, input }));
  }
  for (
    const id of [
      undefined,
      0,
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
    ]
  ) {
    throws(() => parseSemanticPreparationRequest({ v: 1, id, input }));
  }
  for (const malformed of [null, [], "request", {}, { v: 1, id: 1 }]) {
    throws(() => parseSemanticPreparationRequest(malformed));
  }
});

Deno.test("semantic preparation response protocol rejects late IDs, unknown fields and mixed success/error payloads", () => {
  const success = { v: 1, id: 5, ok: true, projection };
  const error = semanticPreparationFailure(new Error("failed"));
  for (
    const malformed of [
      { ...success, id: 4 },
      { ...success, v: 2 },
      { ...success, quads: "large bytes must never return" },
      { ...success, error },
      { v: 1, id: 5, ok: false, error, projection },
      { ...success, ok: "true" },
      { ...success, projection: { ...projection, path: "/tmp/untrusted" } },
      {
        ...success,
        projection: { ...projection, projectionDigest: "invalid" },
      },
      { v: 1, id: 5, ok: true },
    ]
  ) {
    throws(() => parseSemanticPreparationResponse(malformed, 5));
  }
});

Deno.test("semantic preparation error protocol retains known failure codes, context and recovery", () => {
  const original = new BuildStoreError("BUILD_BLOB_CORRUPT", {
    artifactDigest: descriptor.artifactDigest,
    stage: "decompress",
  }, "Stored projection failed checksum");
  const error = semanticPreparationFailure(original);
  deepStrictEqual(error, {
    code: original.code,
    context: original.context,
    message: original.message,
    recovery: original.recovery,
  });
  deepStrictEqual(
    parseSemanticPreparationResponse({ v: 1, id: 1, ok: false, error }, 1),
    { v: 1, id: 1, ok: false, error },
  );
  equal(
    semanticPreparationFailure(
      Object.assign(new Error("unexpected"), { code: "UNTRUSTED_CODE" }),
    ).code,
    "INDEX_UNAVAILABLE",
  );
  equal(
    semanticPreparationFailure(new Error("unexpected")).code,
    "INDEX_UNAVAILABLE",
  );
});

Deno.test("semantic preparation error protocol rejects unknown codes, unbounded strings and invalid context", () => {
  const error = semanticPreparationFailure(new Error("failed"));
  for (
    const altered of [
      { code: "UNTRUSTED_CODE" },
      { message: "x".repeat(8193) },
      { recovery: "x".repeat(8193) },
      { context: [] },
      { context: null },
      { code: 17 },
      { path: "/tmp/untrusted" },
    ]
  ) {
    throws(() =>
      parseSemanticPreparationResponse({
        v: 1,
        id: 1,
        ok: false,
        error: { ...error, ...altered },
      }, 1)
    );
  }
  equal(
    semanticPreparationFailure(new Error("x".repeat(9000))).message.length,
    8192,
  );
});

Deno.test("semantic preparation control encoding enforces its byte budget, including UTF-8", () => {
  equal(
    encodeSemanticPreparationControl(
      "x".repeat(SEMANTIC_PREPARATION_MAX_CONTROL_BYTES - 2),
    ).byteLength,
    SEMANTIC_PREPARATION_MAX_CONTROL_BYTES,
  );
  throws(() =>
    encodeSemanticPreparationControl(
      "x".repeat(SEMANTIC_PREPARATION_MAX_CONTROL_BYTES - 1),
    )
  );
  throws(() =>
    encodeSemanticPreparationControl(
      "é".repeat(SEMANTIC_PREPARATION_MAX_CONTROL_BYTES / 2),
    )
  );
});

Deno.test("semantic preparation control reader accepts split UTF-8 and releases its stream lock", async () => {
  const expected = '{"message":"préparé 🧭"}';
  const bytes = new TextEncoder().encode(expected);
  const stream = chunks(...Array.from(bytes, (byte) => Uint8Array.of(byte)));
  equal(await readSemanticPreparationControl(stream), expected);
  equal(stream.locked, false);
});

Deno.test("semantic preparation control reader refuses oversized or invalid UTF-8 streams", async () => {
  const oversized = chunks(
    new Uint8Array(SEMANTIC_PREPARATION_MAX_CONTROL_BYTES),
    Uint8Array.of(32),
  );
  await rejects(() => readSemanticPreparationControl(oversized), {
    code: "INDEX_UNAVAILABLE",
  });
  equal(oversized.locked, false);
  const invalidUtf8 = chunks(Uint8Array.of(0xc3), Uint8Array.of(0x28));
  await rejects(() => readSemanticPreparationControl(invalidUtf8), TypeError);
  equal(invalidUtf8.locked, false);
});
