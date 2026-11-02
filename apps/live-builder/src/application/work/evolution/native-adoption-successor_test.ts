import assert from "node:assert/strict";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { requestAdoptionReceiptDigest } from "../../model/evolution/request-adoption-invariants.ts";
import type { RequestAdoptionManifest } from "../../model/evolution/request-adoption-ports.ts";
import { requestAdoptionFixture } from "../../../../test/support/request-adoption-fixture.ts";
import {
  type NeverStartedAdoptionSource,
  parseNeverStartedAdoptionSource,
  parseRequestNeverStartedSuccessorContext,
  type RequestNeverStartedSuccessorContext,
} from "./native-adoption-successor.ts";

function marker(): NeverStartedAdoptionSource {
  return {
    v: 1,
    kind: "never-started-adoption-successor",
    threadId: "inert-current",
    predecessorThreadId: "retired-real-wait",
    identityDigest: "a".repeat(64),
    previousCommandId: "previous-adoption",
    previousReceiptDigest: "b".repeat(64),
    previousAuthorizationRuntimeRevision: 11,
    previousCommittedRuntimeRevision: 12,
    authorizedPinDigest: "c".repeat(64),
    advanceAuthorizationDigest: "d".repeat(64),
  };
}
async function context(): Promise<RequestNeverStartedSuccessorContext> {
  const fixture = await requestAdoptionFixture();
  const manifest: RequestAdoptionManifest = {
    format: "request-runtime-adoption/v2",
    commandId: fixture.dossier.id,
    intent: fixture.intent,
    completion: fixture.decision,
    predecessor: { revision: 2, digest: "f".repeat(64) },
    sourceHead: fixture.intent.candidate.sourceAdmission,
    previousRuntimeRevision: 10,
    authorizationRuntimeRevision: 11,
    committedRuntimeRevision: 12,
    admissionRevision: fixture.intent.previous.admission.revision + 1,
    nativeRetirement: {
      digest: "e".repeat(64),
      predecessorThreadIds: ["real-wait"],
      successorThreadIds: ["never-started"],
    },
  };
  const payload = {
    commandId: manifest.commandId,
    committedRuntimeRevision: manifest.committedRuntimeRevision,
    journalRevision: 3,
    journalDigest: await sha256(canonical(manifest)),
    recordedAt: "2026-10-30T00:00:00.000Z",
  };
  const receipt = {
    ...payload,
    receiptDigest: await requestAdoptionReceiptDigest(payload),
  };
  return {
    currentPin: {
      source: manifest.intent.candidate.source,
      modelDigest: manifest.intent.candidate.model.version.digest,
      sourceAdmission: manifest.intent.candidate.sourceAdmission,
      adoption: {
        commandId: manifest.commandId,
        receiptDigest: receipt.receiptDigest,
        committedRuntimeRevision: manifest.committedRuntimeRevision,
      },
    },
    adoptions: [{ manifest, receipt }],
  };
}
Deno.test("never-started adoption source is a closed fact marker without fake snapshot or nested authorization", () => {
  const original = marker(), parsed = parseNeverStartedAdoptionSource(original);
  assert.deepEqual(parsed, original);
  assert.notEqual(parsed, original);
  for (
    const invalid of [
      { ...original, v: 2 },
      { ...original, kind: "waiting" },
      { ...original, snapshot: {} },
      { ...original, advanceAuthorizationJson: "recursive-old-json" },
      { ...original, threadId: original.predecessorThreadId },
      { ...original, previousCommittedRuntimeRevision: 13 },
      { ...original, authorizedPinDigest: "invalid" },
    ]
  ) {
    assert.throws(() => parseNeverStartedAdoptionSource(invalid));
  }
});
Deno.test("never-started context requires exactly latest executed adoption or empty birth context", async () => {
  const proof = await context();
  assert.deepEqual(
    await parseRequestNeverStartedSuccessorContext(proof),
    proof,
  );
  const baseline = {
    currentPin: { ...proof.currentPin, adoption: null },
    adoptions: [],
  };
  assert.deepEqual(
    await parseRequestNeverStartedSuccessorContext(baseline),
    baseline,
  );
  for (
    const invalid of [
      { ...proof, adoptions: [] },
      { ...proof, adoptions: [...proof.adoptions, ...proof.adoptions] },
      { ...proof, currentPin: { ...proof.currentPin, adoption: null } },
      {
        ...proof,
        currentPin: { ...proof.currentPin, modelDigest: "0".repeat(64) },
      },
      {
        ...proof,
        currentPin: {
          ...proof.currentPin,
          sourceAdmission: { ...proof.currentPin.sourceAdmission, revision: 4 },
        },
      },
      {
        ...proof,
        currentPin: {
          ...proof.currentPin,
          adoption: {
            ...proof.currentPin.adoption!,
            receiptDigest: "0".repeat(64),
          },
        },
      },
    ]
  ) {
    await assert.rejects(() =>
      parseRequestNeverStartedSuccessorContext(invalid)
    );
  }
});
Deno.test("never-started proof verifies original receipt hash and exact manifest bytes", async () => {
  const proof = await context(), entry = proof.adoptions[0];
  await assert.rejects(() =>
    parseRequestNeverStartedSuccessorContext({
      ...proof,
      adoptions: [{
        ...entry,
        manifest: {
          ...entry.manifest,
          nativeRetirement: {
            ...entry.manifest.nativeRetirement,
            digest: "0".repeat(64),
          },
        },
      }],
    })
  );
  await assert.rejects(() =>
    parseRequestNeverStartedSuccessorContext({
      ...proof,
      adoptions: [{
        ...entry,
        receipt: { ...entry.receipt, journalRevision: 4 },
      }],
    })
  );
});
Deno.test("never-started context captures current facts before asynchronous validation", async () => {
  const proof = await context(),
    mutable = {
      currentPin: { ...proof.currentPin },
      adoptions: [...proof.adoptions],
    };
  const pending = parseRequestNeverStartedSuccessorContext(mutable);
  mutable.currentPin.modelDigest = "0".repeat(64);
  assert.deepEqual(await pending, proof);
});
