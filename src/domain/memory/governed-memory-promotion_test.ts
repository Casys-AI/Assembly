import { deepStrictEqual, equal, throws } from "node:assert/strict";
import type { MemoryContent, MemoryRecord } from "./entities/memory-record.ts";
import {
  type MemoryAuthority,
  memoryContentDigest,
  MemoryError,
  memoryGuidance,
  type MemoryPolicy,
  memoryView,
  requireMemoryPermission,
  requireMemoryPolicy,
  requireMemoryVersion,
  validateMemoryContent,
} from "./governed-memory-promotion.ts";

const at = "2026-10-22T00:00:00.000Z";
const modelVersion = {
  digest: "model-digest",
  repositoryVersion: "commit:one",
};

function content(): MemoryContent {
  return {
    text: "An observation is not yet shared guidance.",
    origin: { decisionId: "decision-one", sourceRefs: ["message:source-one"] },
    scope: ["tool-building"],
    validUntil: "2026-10-22T01:00:00.000Z",
    outcome: { status: "pending" },
  };
}

function policy(): MemoryPolicy {
  return {
    id: "memory-policy",
    ownerId: "operator-one",
    modelVersion,
    allowedScopes: ["tool-building"],
    permissions: { capture: ["operator-one"], recall: ["operator-one"] },
    requireSourceRefs: true,
    requireKnownOutcome: true,
    maxValidityMs: 3_600_000,
    allowSelfAdmission: false,
  };
}

Deno.test("memory requires an explicit decision, source representation, scope and outcome status", () => {
  validateMemoryContent(content());
  for (
    const mutate of [
      (value: MemoryContent) => value.origin.decisionId = "",
      (value: MemoryContent) =>
        value.origin.sourceRefs = ["duplicate", "duplicate"],
      (value: MemoryContent) => value.scope = [],
      (value: MemoryContent) => value.validUntil = "invalid-time",
      (value: MemoryContent) => value.validUntil = "2026-10-22T01:00:00",
      (value: MemoryContent) =>
        value.outcome = { status: "confirmed" } as never,
      (value: MemoryContent) =>
        value.outcome = { status: "known", summary: "", evidenceRefs: [] },
      (value: MemoryContent) =>
        value.outcome = { status: "pending", summary: "confirmed" } as never,
    ]
  ) {
    const value = content();
    mutate(value);
    throws(() => validateMemoryContent(value), MemoryError);
  }
});

Deno.test("memory policy selects scopes, validity and outcome admission independently", () => {
  requireMemoryPolicy(content(), policy(), at);
  throws(
    () => requireMemoryPolicy(content(), policy(), at, true),
    /known outcome/,
  );
  const permissive = { ...policy(), requireKnownOutcome: false };
  const pending = content();
  requireMemoryPolicy(pending, permissive, at, true);
  deepStrictEqual(pending.outcome, { status: "pending" });
  const noSources = content();
  noSources.origin.sourceRefs = [];
  throws(
    () => requireMemoryPolicy(noSources, policy(), at),
    /source references/,
  );
  requireMemoryPolicy(noSources, { ...policy(), requireSourceRefs: false }, at);
  throws(() =>
    requireMemoryPolicy(
      content(),
      { ...policy(), allowedScopes: ["another"] },
      at,
    )
  );
  throws(() =>
    requireMemoryPolicy(content(), { ...policy(), maxValidityMs: 1 }, at)
  );
  throws(() =>
    requireMemoryPolicy(content(), policy(), "2026-10-22T01:00:00.000Z")
  );
});

Deno.test("memory capture authority never grants recall or admission implicitly", () => {
  const authority: MemoryAuthority = {
    callerId: "operator-one",
    behaviorId: "capture-behavior",
    invocationId: "call-one",
    modelVersion,
    policy: policy(),
  };
  requireMemoryPermission(authority, "capture");
  throws(() => requireMemoryPermission(authority, "admit"), /permission/);
  delete authority.policy.permissions.recall;
  throws(() => requireMemoryPermission(authority, "recall"), /permission/);
  const stale = structuredClone(authority);
  stale.modelVersion = { ...stale.modelVersion, digest: "another-model" };
  throws(() => requireMemoryPermission(stale, "capture"), /pinned/);
  const missing = structuredClone(authority);
  missing.policy.maxValidityMs = undefined as never;
  throws(() => requireMemoryPermission(missing, "capture"), /policy/);
});

Deno.test("memory view derives expiry without mutating admitted evidence", async () => {
  const value = content();
  const record: MemoryRecord = {
    id: "note-one",
    ownerId: "operator-one",
    contributorId: "operator-one",
    revision: 2,
    digest: await memoryContentDigest("operator-one", value),
    content: value,
    status: "admitted",
    createdAt: at,
    updatedAt: at,
    history: [],
  };
  const before = structuredClone(record);
  equal(memoryView(record, at).usableAsGuidance, true);
  const expired = memoryView(record, value.validUntil);
  equal(expired.status, "admitted");
  equal(expired.effectiveStatus, "expired");
  equal(expired.usableAsGuidance, false);
  deepStrictEqual(record, before);
});

Deno.test("memory content digest binds provenance, scope, outcome and owner", async () => {
  const first = await memoryContentDigest("operator-one", content());
  equal(first, await memoryContentDigest("operator-one", content()));
  for (
    const mutate of [
      (value: MemoryContent) => value.text += " changed",
      (value: MemoryContent) => value.origin.decisionId = "decision-two",
      (value: MemoryContent) => value.origin.sourceRefs = ["message:other"],
      (value: MemoryContent) => value.scope = ["another"],
      (value: MemoryContent) =>
        value.outcome = {
          status: "known",
          summary: "Observed result",
          evidenceRefs: ["message:result"],
        },
    ]
  ) {
    const value = content();
    mutate(value);
    equal(first === await memoryContentDigest("operator-one", value), false);
  }
  equal(first === await memoryContentDigest("operator-two", content()), false);
});

Deno.test("memory optimistic admission binds both revision and content digest", () => {
  const record = { revision: 2, digest: "exact-digest" } as MemoryRecord;
  requireMemoryVersion(record, { revision: 2, digest: "exact-digest" });
  throws(() =>
    requireMemoryVersion(record, { revision: 1, digest: "exact-digest" })
  );
  throws(() =>
    requireMemoryVersion(record, { revision: 2, digest: "another" })
  );
});

Deno.test("memory guidance projection retains current evidence without transporting the full history", async () => {
  const value = content();
  const view = memoryView({
    id: "note-one",
    ownerId: "operator-one",
    contributorId: "operator-one",
    revision: 1,
    digest: await memoryContentDigest("operator-one", value),
    content: value,
    status: "candidate",
    createdAt: at,
    updatedAt: at,
    history: [{ revision: 1 }] as MemoryRecord["history"],
  }, at);
  const guidance = memoryGuidance(view);
  equal("history" in guidance, false);
  equal(guidance.historyLength, 1);
  equal(guidance.digest, view.digest);
  equal(guidance.usableAsGuidance, false);
  guidance.content.text = "changed projection";
  equal(view.content.text, value.text);
});
