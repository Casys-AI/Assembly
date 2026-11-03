import {
  deepStrictEqual,
  equal,
  notEqual,
  rejects,
  throws,
} from "node:assert/strict";
import type { NativeTrace } from "./native-graph.ts";
import {
  assertNativeObservationBinding,
  assertNativeObservationEmission,
  compareNativeObservations,
  encodeNativeObservation,
  nativeObservationBatchDigest,
  type NativeObservationEmission,
  type NativeObservationRecord,
  parseNativeObservationPayload,
  parseNativeTrace,
  verifyNativeObservationBatches,
} from "./native-observation.ts";

const full: NativeTrace = {
  kind: "action",
  actionId: "actïon-✓",
  nodeId: "node-1",
  mechanism: "choose_move",
  guardIds: ["guard-b", "guard-a"],
  source: { file: "modèle.sysml", line: "42", quote: "«exact»", native: true },
  step: 7,
  immutableGroupId: "group-1",
  immutableCallId: "call-2",
  operatorId: "opérator",
  rootRequestId: "request-1",
  performerId: "performer-1",
  allocationId: "allocation-1",
  acceptActionId: "accept-1",
  modelDigest: "digest-1",
  modelSourceIds: ["source-z", "source-a"],
  repositoryVersion: "version-1",
};
const minimal: NativeTrace = {
  kind: "edge",
  edgeId: "edge-1",
  nodeId: "node-1",
  source: { file: "f.sysml", line: 3 },
  step: 7,
  operatorId: "opérator",
  modelDigest: "digest-1",
  modelSourceIds: [],
};

Deno.test("native observation encoding round-trips every field, absence, type and order", () => {
  for (const event of [full, minimal]) {
    const parsed = parseNativeObservationPayload(
      encodeNativeObservation(event),
    );
    deepStrictEqual(parsed, event);
    deepStrictEqual(Object.keys(parsed).sort(), Object.keys(event).sort());
  }
  const parsed = parseNativeObservationPayload(
    encodeNativeObservation(minimal),
  );
  equal(typeof parsed.source.line, "number");
  equal("quote" in parsed.source, false);
  equal("native" in parsed.source, false);
  equal("rootRequestId" in parsed, false);
  equal("repositoryVersion" in parsed, false);
  deepStrictEqual(
    parseNativeObservationPayload(encodeNativeObservation(full)).guardIds,
    ["guard-b", "guard-a"],
  );
  deepStrictEqual(
    parseNativeObservationPayload(encodeNativeObservation(full))
      .modelSourceIds,
    ["source-z", "source-a"],
  );
});

Deno.test("native observation parsing refuses unknown keys, nulls and corrupt envelopes", () => {
  throws(() => parseNativeTrace({ ...minimal, extra: 1 }), /INVALID/);
  throws(() => parseNativeTrace({ ...minimal, edgeId: null }), /INVALID/);
  throws(() => parseNativeTrace({ ...minimal, step: 1.5 }), /INVALID/);
  throws(
    () => parseNativeTrace({ ...minimal, source: { file: "f" } }),
    /INVALID/,
  );
  throws(
    () =>
      parseNativeObservationPayload(
        encodeNativeObservation(minimal).replace('"version":1', '"version":2'),
      ),
    /CORRUPT/,
  );
  throws(() => parseNativeObservationPayload("{"), /CORRUPT/);
  // Non-canonical byte order is not the exact encoding.
  throws(
    () =>
      parseNativeObservationPayload(
        JSON.stringify({ event: minimal, version: 1 }),
      ),
    /CORRUPT/,
  );
});

async function emission(
  overrides: Partial<NativeObservationEmission> = {},
): Promise<NativeObservationEmission> {
  const base: NativeObservationEmission = {
    producerPhase: "preparation",
    occurrenceId: "node-1",
    emissionStep: 7,
    eventOrdinal: 0,
    batchCount: 1,
    batchDigest: "",
    event: structuredClone(minimal),
    ...overrides,
  };
  base.batchDigest = await nativeObservationBatchDigest({
    producerPhase: base.producerPhase,
    occurrenceId: base.occurrenceId,
    emissionStep: base.emissionStep,
    events: [base.event],
  });
  return base;
}

Deno.test("native observation batch digest binds order, tail and producer coordinates", async () => {
  const events = [structuredClone(minimal), structuredClone(full)];
  const digest = (list: NativeTrace[], step = 7) =>
    nativeObservationBatchDigest({
      producerPhase: "preparation",
      occurrenceId: "node-1",
      emissionStep: step,
      events: list,
    });
  notEqual(await digest(events), await digest([...events].reverse()));
  notEqual(await digest(events), await digest(events.slice(0, 1)));
  notEqual(await digest(events), await digest(events, 8));
  equal(await digest(events), await digest(structuredClone(events)));
});

Deno.test("native observation emission validation refuses bad coordinates and occurrence mismatch", async () => {
  const good = await emission();
  deepStrictEqual(assertNativeObservationEmission(good).event, minimal);
  throws(
    () => assertNativeObservationEmission({ ...good, emissionStep: 0 }),
    /INVALID/,
  );
  throws(
    () => assertNativeObservationEmission({ ...good, eventOrdinal: 1 }),
    /INVALID/,
  );
  throws(
    () => assertNativeObservationEmission({ ...good, batchDigest: "x" }),
    /INVALID/,
  );
  throws(
    () => assertNativeObservationEmission({ ...good, occurrenceId: "other" }),
    /INVALID/,
  );
});

Deno.test("native observation binding refuses forged owner and pin fields", async () => {
  const good = await emission();
  const binding = {
    operatorId: "opérator",
    modelDigest: "digest-1",
    occurrenceIds: new Set(["node-1"]),
  };
  assertNativeObservationBinding(good, binding);
  throws(
    () =>
      assertNativeObservationBinding(good, {
        ...binding,
        operatorId: "other",
      }),
    /OWNER_MISMATCH/,
  );
  throws(
    () =>
      assertNativeObservationBinding(good, {
        ...binding,
        rootRequestId: "request-1",
      }),
    /OWNER_MISMATCH/,
  );
  throws(
    () =>
      assertNativeObservationBinding(good, {
        ...binding,
        occurrenceIds: new Set(["elsewhere"]),
      }),
    /OWNER_MISMATCH/,
  );
  throws(
    () =>
      assertNativeObservationBinding(good, {
        ...binding,
        modelDigest: "other",
      }),
    /PIN_MISMATCH/,
  );
  throws(
    () =>
      assertNativeObservationBinding(good, {
        ...binding,
        repositoryVersion: "version-1",
      }),
    /PIN_MISMATCH/,
  );
});

Deno.test("native observation ordering is producer step, phase, ordinal; partial batches stay readable", async () => {
  const record = async (
    overrides: Partial<NativeObservationEmission>,
  ): Promise<NativeObservationRecord> => ({
    ...(await emission(overrides)),
    firstRecordedAt: "2026-10-31T00:00:00.000Z",
  });
  const commit = await record({ producerPhase: "node-commit" });
  const prep = await record({});
  const prepNext = await record({ emissionStep: 8 });
  deepStrictEqual(
    [prepNext, commit, prep].sort(compareNativeObservations).map((item) =>
      `${item.emissionStep}:${item.producerPhase}`
    ),
    ["7:preparation", "7:node-commit", "8:preparation"],
  );
  // A durable prefix (batchCount 2, one row) verifies; a complete batch
  // with a forged digest does not.
  const prefix = await record({ batchCount: 2 });
  await verifyNativeObservationBatches([prefix]);
  await rejects(
    () =>
      verifyNativeObservationBatches([{
        ...prep,
        batchDigest: "0".repeat(64),
      }]),
    /CORRUPT/,
  );
});
