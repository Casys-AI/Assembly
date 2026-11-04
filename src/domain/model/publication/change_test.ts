import assert from "node:assert/strict";
import {
  anyPublicationAuthor,
  assertAnyPublicationSize,
  assertPublicationMatches,
  assertPublicationSize,
  type ChangePublication,
  changePublication,
  MAX_APPROVAL_RECEIPT_BYTES,
  parseAnyPublication,
  preparePublication,
  publicationSourceVersion,
} from "./change.ts";
import { exerciseOwnerAuthority } from "../../governance/authority.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import type { PendingChange } from "../../governance/records/pending-change.ts";

Deno.test("proposal identity retains the same shape through durable receipt serialization", () => {
  const pin = {
    digest: "base",
    repositoryVersion: "snapshot-1",
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  };
  const change: PendingChange = {
    id: "network-extension",
    kind: "mandate-change",
    status: "approved",
    baseRevision: 0,
    baseModelDigest: pin.digest,
    requestedAt: "now",
    decidedAt: "later",
    reason: "Exact network extension",
    requestedBy: "operator",
    designerScopeId: "designer-scope",
    requestedRights: { addNetworkHosts: ["recovery.example"] },
    authorityExercise: exerciseOwnerAuthority({
      identity: { systemId: "system" },
      version: pin,
    }, "mandate-change"),
  };
  const receipt = changePublication(change, pin);
  const durable = JSON.parse(JSON.stringify(receipt));
  assert.deepStrictEqual(receipt, durable);
  assert.doesNotThrow(() => assertPublicationMatches(change, durable));
  durable.proposal.requestedBy = "another-operator";
  assert.throws(() => assertPublicationMatches(change, durable), {
    code: "PUBLICATION_RECEIPT_MISMATCH",
  });
});

Deno.test("approval trailer limit counts UTF-8 prefix and newline at its exact boundary", () => {
  const receipt: ChangePublication = {
    changeId: "size",
    authorityExercise: exerciseOwnerAuthority({
      identity: { systemId: "system" },
      version: { digest: "base" },
    }, "mandate-change"),
    baseModelDigest: "base",
    baseRevision: 0,
    adoptedPin: { digest: "base" },
    decidedAt: "",
    edits: [],
  };
  const overhead =
    new TextEncoder().encode(`ASE-Approval: ${canonical(receipt)}\n`).length;
  const remaining = MAX_APPROVAL_RECEIPT_BYTES - overhead;
  receipt.decidedAt = "台".repeat(Math.floor(remaining / 3)) +
    "x".repeat(remaining % 3);
  const trailer = `ASE-Approval: ${canonical(receipt)}\n`;
  assert.equal(
    new TextEncoder().encode(trailer).length,
    MAX_APPROVAL_RECEIPT_BYTES,
  );
  assert(trailer.length < MAX_APPROVAL_RECEIPT_BYTES / 2);
  assert.doesNotThrow(() => assertPublicationSize(receipt));
  receipt.decidedAt += "台";
  assert.throws(() => assertPublicationSize(receipt), {
    code: "PUBLICATION_RECEIPT_TOO_LARGE",
    recovery: "refuse",
  });
});

const hex = (char: string) => char.repeat(64);

function approvedFixture() {
  const pin = {
    digest: "base",
    repositoryVersion: "commit:" + "1".repeat(40),
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: ["source"],
  };
  const change: PendingChange = {
    id: "11111111-1111-4111-8111-111111111111",
    kind: "mandate-change",
    status: "approved",
    baseRevision: 0,
    baseModelDigest: pin.digest,
    requestedAt: "now",
    decidedAt: "later",
    reason: "Exact extension",
    authorityExercise: exerciseOwnerAuthority(
      { identity: { systemId: "system" }, version: pin },
      "mandate-change",
    ),
  };
  return { change, approval: changePublication(change, pin) };
}

Deno.test("a new approval freezes the displayed source base while retaining the real execution pin", () => {
  const { change, approval: old } = approvedFixture();
  change.diff = {
    title: "Exact extension",
    author: "owner",
    base: {
      repositoryVersion: "commit:" + "2".repeat(40),
      modelDigest: old.baseModelDigest,
      sourceDigest: hex("a"),
    },
    sourceDigest: hex("b"),
    files: [],
    patch: "",
    additions: 0,
    deletions: 0,
  };
  const pin = {
    ...old.adoptedPin,
    rootId: "root",
    configurationId: "configuration",
    configurationRevision: 0,
    sourceIds: [],
  };
  const receipt = changePublication(change, pin);
  assert.deepStrictEqual(receipt.adoptedPin, old.adoptedPin);
  assert.deepStrictEqual(receipt.approvedSourceBase, change.diff.base);
  assert.equal(
    publicationSourceVersion(receipt),
    change.diff.base.repositoryVersion,
  );
  const durable = JSON.parse(JSON.stringify(receipt));
  assert.doesNotThrow(() => assertPublicationMatches(change, durable));
  change.diff.base.repositoryVersion = "different-preview";
  assert.notEqual(
    receipt.approvedSourceBase!.repositoryVersion,
    change.diff.base.repositoryVersion,
  );
  assert.throws(() => assertPublicationMatches(change, durable), {
    code: "PUBLICATION_RECEIPT_MISMATCH",
  });
  assert.throws(
    () =>
      parseAnyPublication({
        ...receipt,
        approvedSourceBase: { ...receipt.approvedSourceBase, ignored: true },
      }),
    { code: "PUBLICATION_RECEIPT_MISMATCH" },
  );
  const legacy = { ...receipt };
  delete legacy.approvedSourceBase;
  assert.equal(
    publicationSourceVersion(legacy),
    old.adoptedPin.repositoryVersion,
  );
  assert.equal(parseAnyPublication(legacy), legacy);
  assert.equal(legacy.approvedSourceBase, undefined);
});

Deno.test("v2 keeps the original approval byte-identical while the base moves", () => {
  const { change, approval } = approvedFixture();
  const before = canonical(approval);
  const prepared = preparePublication(approval, {
    executionBase: {
      repositoryVersion: "commit:" + "2".repeat(40),
      sourceDigest: hex("d"),
    },
    replayedEdits: [],
    journalDigest: hex("e"),
    revalidation: {
      checkedAt: "2026-10-25T12:00:00.000Z",
      executionBaseVersion: "commit:" + "2".repeat(40),
      scopeDigest: hex("f"),
      authorityStillValid: true,
      preconditionsChecked: 1,
      baseUnchanged: false,
    },
    result: { sourceDigest: hex("a"), recipeDigest: hex("b") },
    command: { commandId: change.id, commandDigest: hex("9") },
  });
  // The approval, including its original baseModelDigest, is untouched.
  assert.equal(canonical(prepared.approval), before);
  assert.equal(prepared.approval.baseModelDigest, "base");
  assert.doesNotThrow(() => assertAnyPublicationSize(prepared));
  assert.equal(
    anyPublicationAuthor(prepared),
    `ase:approved-change:${change.id}`,
  );

  const durable = JSON.parse(JSON.stringify(prepared));
  assert.deepStrictEqual(parseAnyPublication(durable), prepared);
  // Historical v1 trailers still read back identically.
  assert.deepStrictEqual(parseAnyPublication(JSON.parse(before)), approval);
});

Deno.test("v2 refuses a filled receipt as approval and a false unchanged claim", () => {
  const { approval } = approvedFixture();
  const filled = structuredClone(approval);
  filled.edits = [{
    op: "setFeatureValue",
    target: {
      id: "el",
      qualifiedName: "Sys::a",
      metaclass: "PartUsage",
      preimage: hex("a"),
    },
    value: "x",
  }];
  const attempt = {
    executionBase: {
      repositoryVersion: "commit:" + "2".repeat(40),
      sourceDigest: hex("d"),
    },
    replayedEdits: [],
    revalidation: {
      checkedAt: "2026-10-25T12:00:00.000Z",
      executionBaseVersion: "commit:" + "2".repeat(40),
      scopeDigest: hex("f"),
      authorityStillValid: true as const,
      preconditionsChecked: 0,
      baseUnchanged: true,
    },
    result: { sourceDigest: hex("a") },
  };
  assert.throws(() => preparePublication(filled, attempt), {
    code: "PUBLICATION_NOT_APPLICABLE",
  });
  // baseUnchanged cannot name a different execution version than the pin.
  assert.throws(() => preparePublication(approval, attempt), {
    code: "PUBLICATION_RECEIPT_MISMATCH",
  });
  assert.throws(() => parseAnyPublication({ v: 3, changeId: "x" }), {
    code: "PUBLICATION_RECEIPT_MISMATCH",
  });
});
