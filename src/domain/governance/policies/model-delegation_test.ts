import assert from "node:assert/strict";
import { legacyOwnerAuthority } from "../authority.ts";
import { executionDigest } from "../../primitives/execution-digest.ts";
import {
  assertModelDelegationWithinAuthority,
  type ModelAdministrationAuthority,
  type ModelDelegationIdentity,
  type ModelDelegationRecord,
  type ModelRootAuthority,
  resolveModelDelegations,
  validateModelAdministrationEnvelope,
  validateModelDelegationRecord,
} from "./model-delegation.ts";

const identities: ModelDelegationIdentity[] = ["A", "B", "C", "D"].map((
  name,
) => ({
  systemQualifiedName: `Systems::${name}`,
  holderNativeId: `holder-${name}`,
  mandateId: `mandate-${name}`,
  mandateRevision: 1,
  mayProposeSysmlRevision: true,
}));

function root(
  name = "A",
  overrides: Partial<ModelRootAuthority> = {},
): ModelRootAuthority {
  const identity = identities.find((entry) =>
    entry.systemQualifiedName === `Systems::${name}`
  )!;
  return {
    id: `root-${name}`,
    revision: 1,
    systemQualifiedName: identity.systemQualifiedName,
    holderNativeId: identity.holderNativeId,
    mandateId: identity.mandateId,
    mandateRevision: 1,
    operations: ["set-value", "rename"],
    grants: [
      { file: "a.sysml", qualifiedRoots: ["Model::A"] },
      { file: "b.sysml", qualifiedRoots: ["Model::B"] },
    ],
    recipients: identities.map((entry) => entry.systemQualifiedName),
    maxRedelegationDepth: 2,
    ...overrides,
  };
}

function grant(
  authority: ModelAdministrationAuthority,
  target: string,
  overrides: Partial<ModelDelegationRecord> = {},
): ModelDelegationRecord {
  return {
    id: `grant-${target}`,
    revision: 1,
    issuerSystem: authority.systemQualifiedName,
    targetSystem: `Systems::${target}`,
    targetHolderNativeId: `holder-${target}`,
    targetMandateId: `mandate-${target}`,
    targetMandateRevision: 1,
    parent: {
      kind: authority.kind,
      id: authority.id,
      revision: authority.revision,
      digest: authority.digest,
    },
    operations: ["rename"],
    grants: [{ file: "a.sysml", qualifiedRoots: ["Model::A::child"] }],
    mayEdit: true,
    recipients: [],
    maxRedelegationDepth: null,
    revoked: false,
    ...overrides,
  };
}

async function rootAuthority(
  value = root(),
): Promise<ModelAdministrationAuthority> {
  return (await resolveModelDelegations([value], [], identities))
    .bySystem[value.systemQualifiedName]!.administration!;
}

async function chain(): Promise<
  { roots: ModelRootAuthority[]; records: ModelDelegationRecord[] }
> {
  const roots = [root()];
  const b = grant(await rootAuthority(roots[0]), "B", {
    mayEdit: false,
    recipients: ["Systems::C", "Systems::D"],
    maxRedelegationDepth: 1,
  });
  const first = await resolveModelDelegations(roots, [b], identities);
  const c = grant(first.bySystem["Systems::B"]!.administration!, "C", {
    mayEdit: false,
    recipients: ["Systems::D"],
    maxRedelegationDepth: 0,
  });
  const second = await resolveModelDelegations(roots, [b, c], identities);
  const d = grant(second.bySystem["Systems::C"]!.administration!, "D");
  return { roots, records: [b, c, d] };
}

Deno.test("model delegation grants administration independently of exercise through zero depth", async () => {
  const { roots, records } = await chain();
  const result = await resolveModelDelegations(roots, records, identities);
  assert(result.statuses.every((status) => status.active));
  assert.equal(result.bySystem["Systems::A"]!.editing, null);
  assert.equal(result.bySystem["Systems::B"]!.editing, null);
  assert.equal(
    result.bySystem["Systems::B"]!.administration!.maxRedelegationDepth,
    1,
  );
  assert.equal(result.bySystem["Systems::C"]!.editing, null);
  assert.equal(
    result.bySystem["Systems::C"]!.administration!.maxRedelegationDepth,
    0,
  );
  assert.equal(result.bySystem["Systems::D"]!.administration, null);
  assert.deepEqual(result.bySystem["Systems::D"]!.editing!.operations, [
    "rename",
  ]);
});

Deno.test("model delegation root depth zero grants exercise only", async () => {
  const value = root("A", { maxRedelegationDepth: 0 });
  const authority = await rootAuthority(value);
  const leaf = grant(authority, "B");
  assertModelDelegationWithinAuthority(authority, leaf);
  assert.throws(() =>
    assertModelDelegationWithinAuthority(authority, {
      ...leaf,
      mayEdit: false,
      recipients: ["Systems::C"],
      maxRedelegationDepth: 0,
    }), /depth/);
  const result = await resolveModelDelegations([value], [leaf], identities);
  assert(result.statuses[0]!.active);
});

Deno.test("model delegation retains historical root digest and pins modeled root provenance", async () => {
  const legacy = root();
  const previous = await rootAuthority(legacy);
  assert.equal(
    previous.digest,
    await executionDigest({ kind: "model-administration-root", ...legacy }),
  );
  assert.equal("rootAuthority" in previous, false);
  const modeled = root("A", {
    rootAuthority: {
      ...legacyOwnerAuthority("system-A"),
      ownerSource: "modeled",
    },
  });
  const authority = await rootAuthority(modeled);
  assert.notEqual(authority.digest, previous.digest);
  const record = grant(authority, "B");
  const resolved = await resolveModelDelegations(
    [modeled],
    [record],
    identities,
  );
  assert.deepEqual(
    resolved.bySystem["Systems::B"]!.editing!.rootAuthority,
    modeled.rootAuthority,
  );
  const changed = structuredClone(modeled);
  changed.rootAuthority!.mandateRevision++;
  const stale = await resolveModelDelegations([changed], [record], identities);
  assert.equal(stale.statuses[0]!.reason, "stale-parent");
  assert.equal(stale.bySystem["Systems::B"]!.editing, null);
});

Deno.test("model delegation rejects escalation of operations, file-root pairs, recipients and depth", async () => {
  const authority = await rootAuthority();
  const base = grant(authority, "B", {
    recipients: ["Systems::C"],
    maxRedelegationDepth: 1,
  });
  for (
    const override of [
      { operations: ["remove"] },
      { grants: [{ file: "a.sysml", qualifiedRoots: ["Model::B"] }] },
      { grants: [{ file: "a.sysml", qualifiedRoots: ["Model"] }] },
      { grants: [{ file: "A.sysml", qualifiedRoots: ["Model::A"] }] },
      { recipients: ["Systems::C::child"] },
      { maxRedelegationDepth: 2 },
      { issuerSystem: "Systems::C" },
      { targetSystem: "Systems::B::child" },
      { parent: { ...base.parent, digest: "0".repeat(64) } },
    ] as Partial<ModelDelegationRecord>[]
  ) {
    assert.throws(() =>
      assertModelDelegationWithinAuthority(authority, { ...base, ...override })
    );
  }
  assertModelDelegationWithinAuthority(authority, base);
});

Deno.test("model delegation request parsing fails closed on malformed identity, flags and bounds", async () => {
  const authority = await rootAuthority();
  const base = grant(authority, "B");
  const invalid = [
    { id: "$(touch tmp)" },
    { id: "a/b" },
    { revision: 0 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { targetMandateId: "bad\n" },
    { maxRedelegationDepth: undefined },
    { maxRedelegationDepth: -1 },
    { maxRedelegationDepth: 9 },
    { maxRedelegationDepth: NaN },
    { mayEdit: "true" },
    { revoked: 0 },
    { mayEdit: false },
    { recipients: ["Systems::C"] },
    { operations: ["rename", "rename"] },
    { grants: [{ file: "../a.sysml", qualifiedRoots: ["Model::A"] }] },
    { grants: [{ file: "a.sysml", qualifiedRoots: ["Model::*"] }] },
    { parent: { ...base.parent, id: base.id } },
    { parent: { ...base.parent, kind: "unknown" } },
    { parent: { ...base.parent, digest: "bad" } },
    { extra: true },
  ];
  for (const override of invalid) {
    assert.throws(() =>
      validateModelDelegationRecord({ ...base, ...override })
    );
  }
  assert.throws(() =>
    validateModelAdministrationEnvelope({
      ...root(),
      recipients: ["Systems::B", "::'Systems'::'B'"],
    })
  );
  assert.throws(() =>
    validateModelAdministrationEnvelope({ ...root(), recipients: [] })
  );
});

Deno.test("model delegation names use parsed exact identity and preserve embedded separators", async () => {
  const authority = await rootAuthority();
  const base = grant(authority, "B", {
    issuerSystem: "::'Systems'::'A'",
    targetSystem: "'Systems'::'B'",
  });
  assertModelDelegationWithinAuthority(authority, base);
  const result = await resolveModelDelegations([root()], [base], identities);
  assert(result.bySystem["Systems::B"]!.editing);
  assert.throws(
    () =>
      validateModelDelegationRecord({ ...base, targetSystem: "::Systems::A" }),
    /self/,
  );
  assert.throws(() =>
    assertModelDelegationWithinAuthority(authority, {
      ...base,
      targetSystem: "'Systems::B'",
    })
  );
  const quoted = {
    ...authority,
    grants: [{ file: "a.sysml", qualifiedRoots: ["'Model::A'"] }],
  };
  assert.throws(
    () => assertModelDelegationWithinAuthority(quoted, base),
    /scope/,
  );
});

Deno.test("model delegation revocation of an intermediary cascades while unrelated root remains usable", async () => {
  const { roots, records } = await chain();
  records[0]!.revoked = true;
  const result = await resolveModelDelegations(roots, records, identities);
  assert.equal(result.statuses[0]!.reason, "revoked");
  assert(result.statuses.every((status) => !status.active));
  assert(result.bySystem["Systems::A"]!.administration);
  assert.equal(result.bySystem["Systems::D"]!.editing, null);
});

Deno.test("model delegation root removal and root content change invalidate pinned descendants", async () => {
  const { roots, records } = await chain();
  const missing = await resolveModelDelegations([], records, identities);
  assert(missing.statuses.every((status) => !status.active));
  for (
    const override of [
      { revision: 2 },
      { operations: ["rename"] },
      { recipients: ["Systems::B", "Systems::C", "Systems::D"] },
    ] as Partial<ModelRootAuthority>[]
  ) {
    const result = await resolveModelDelegations(
      [{ ...roots[0]!, ...override }],
      records,
      identities,
    );
    assert.equal(result.statuses[0]!.reason, "stale-parent");
    assert(result.statuses.every((status) => !status.active));
  }
});

Deno.test("model delegation every current native capability and mandate gates the complete chain", async () => {
  const { roots, records } = await chain();
  for (const index of [0, 1, 2]) {
    for (
      const override of [
        { mayProposeSysmlRevision: false },
        { mandateRevision: 2 },
        { mandateId: "new-mandate" },
      ]
    ) {
      const changed = identities.map((identity, offset) =>
        offset === index ? { ...identity, ...override } : identity
      );
      const result = await resolveModelDelegations(roots, records, changed);
      assert.equal(result.bySystem["Systems::D"]!.editing, null);
      assert(
        result.statuses.slice(Math.max(0, index - 1)).every((status) =>
          !status.active
        ),
      );
    }
  }
});

Deno.test("model delegation holder replacement invalidates rights until explicitly reissued", async () => {
  const { roots, records } = await chain();
  const before = await resolveModelDelegations(roots, records, identities);
  const changed = identities.map((identity) =>
    identity.systemQualifiedName === "Systems::B"
      ? { ...identity, holderNativeId: "replacement-B" }
      : identity
  );
  const after = await resolveModelDelegations(roots, records, changed);
  assert.equal(after.statuses[0]!.reason, "stale-holder");
  assert.equal(after.bySystem["Systems::B"]!.administration, null);
  assert.equal(after.bySystem["Systems::D"]!.editing, null);
  records[0]!.targetHolderNativeId = "replacement-B";
  records[0]!.revision = 2;
  const reissued = await resolveModelDelegations(roots, records, changed);
  assert(reissued.statuses[0]!.active);
  assert.notEqual(
    reissued.bySystem["Systems::B"]!.administration!.digest,
    before.bySystem["Systems::B"]!.administration!.digest,
  );
  assert.equal(reissued.statuses[1]!.reason, "stale-parent");
  assert.equal(reissued.bySystem["Systems::D"]!.editing, null);
});

Deno.test("model delegation effective leaf digest changes on reissue for pending proposal revalidation", async () => {
  const leaf = grant(await rootAuthority(), "B");
  const before = await resolveModelDelegations([root()], [leaf], identities);
  const after = await resolveModelDelegations([root()], [{
    ...leaf,
    revision: 2,
  }], identities);
  assert.notEqual(
    after.bySystem["Systems::B"]!.editing!.digest,
    before.bySystem["Systems::B"]!.editing!.digest,
  );
});

Deno.test("model delegation accepts opaque native URI identifiers and configured policy names", async () => {
  const configured = identities.map((identity) => ({
    ...identity,
    holderNativeId: `file:///models/operators.sysml#${identity.holderNativeId}`,
    mandateId: `Mandate ${identity.mandateId}`,
  }));
  const configuredRoot = root("A", {
    id: "Administration policy 1",
    holderNativeId: configured[0]!.holderNativeId,
    mandateId: configured[0]!.mandateId,
  });
  const authority =
    (await resolveModelDelegations([configuredRoot], [], configured))
      .bySystem["Systems::A"]!.administration;
  assert(authority);
  const record = grant(authority, "B", {
    targetHolderNativeId: configured[1]!.holderNativeId,
    targetMandateId: configured[1]!.mandateId,
  });
  const result = await resolveModelDelegations(
    [configuredRoot],
    [record],
    configured,
  );
  assert(result.statuses[0]!.active);
});

Deno.test("model delegation malformed long branch cannot poison a valid ancestor by record order", async () => {
  const a = await rootAuthority();
  const valid = grant(a, "B", { id: "valid" });
  const invalid = Array.from({ length: 10 }, (_, index) =>
    grant(a, "C", {
      id: `bad-${index}`,
      maxRedelegationDepth: 0,
      recipients: ["Systems::B"],
      parent: {
        kind: "delegation",
        id: index === 0 ? "valid" : `bad-${index - 1}`,
        revision: 1,
        digest: "0".repeat(64),
      },
    }));
  for (
    const records of [[...invalid].reverse().concat(valid), [valid, ...invalid]]
  ) {
    const result = await resolveModelDelegations([root()], records, identities);
    assert(result.statuses.find((status) => status.id === "valid")!.active);
    assert(result.bySystem["Systems::B"]!.editing);
    assert.equal(result.bySystem["Systems::C"]!.editing, null);
  }
});

Deno.test("model delegation cycles, missing parents and exercise-only parents remain inactive", async () => {
  const authority = await rootAuthority();
  const b = grant(authority, "B", {
    mayEdit: false,
    recipients: ["Systems::C"],
    maxRedelegationDepth: 1,
  });
  const c = grant(authority, "C", {
    issuerSystem: "Systems::B",
    parent: {
      kind: "delegation",
      id: b.id,
      revision: 1,
      digest: "0".repeat(64),
    },
  });
  b.parent = {
    kind: "delegation",
    id: c.id,
    revision: 1,
    digest: "0".repeat(64),
  };
  b.issuerSystem = "Systems::C";
  const cyclic = await resolveModelDelegations([root()], [b, c], identities);
  assert(cyclic.statuses.every((status) => !status.active));
  const missing = await resolveModelDelegations([root()], [c], identities);
  assert(!missing.statuses[0]!.active);
  const leaf = grant(authority, "B");
  const noAdministration = await resolveModelDelegations(
    [root()],
    [leaf, c],
    identities,
  );
  assert(noAdministration.statuses[0]!.active);
  assert.equal(noAdministration.statuses[1]!.reason, "inactive-parent");
});

Deno.test("model delegation rejects target loops back to root despite allowed recipient", async () => {
  const authority = await rootAuthority();
  const b = grant(authority, "B", {
    recipients: ["Systems::A"],
    maxRedelegationDepth: 1,
  });
  const first = await resolveModelDelegations([root()], [b], identities);
  const back = grant(first.bySystem["Systems::B"]!.administration!, "A");
  const result = await resolveModelDelegations([root()], [b, back], identities);
  assert.equal(result.statuses[1]!.reason, "ancestor-target-loop");
  assert.equal(result.bySystem["Systems::A"]!.editing, null);
});

Deno.test("model delegation competing active incoming chains and their descendants fail closed", async () => {
  const roots = [root(), root("D")];
  const a = await rootAuthority(roots[0]);
  const d = await rootAuthority(roots[1]);
  const b = grant(a, "B", {
    recipients: ["Systems::C"],
    maxRedelegationDepth: 1,
  });
  const first = await resolveModelDelegations(roots, [b], identities);
  const c = grant(first.bySystem["Systems::B"]!.administration!, "C");
  const competing = grant(d, "B", { id: "competing-B" });
  const result = await resolveModelDelegations(
    roots,
    [c, competing, b],
    identities,
  );
  assert(result.statuses.every((status) => !status.active));
  assert.equal(result.bySystem["Systems::B"]!.editing, null);
  assert.equal(result.bySystem["Systems::C"]!.editing, null);
  competing.revoked = true;
  const restored = await resolveModelDelegations(
    roots,
    [c, competing, b],
    identities,
  );
  assert(restored.bySystem["Systems::C"]!.editing);
});

Deno.test("model delegation crossed competing chains terminate conservatively without resurrection", async () => {
  const a = await rootAuthority();
  const b = grant(a, "B", {
    recipients: ["Systems::C"],
    maxRedelegationDepth: 1,
  });
  const c = grant(a, "C", {
    recipients: ["Systems::B"],
    maxRedelegationDepth: 1,
  });
  const first = await resolveModelDelegations([root()], [b, c], identities);
  const cb = grant(first.bySystem["Systems::C"]!.administration!, "B", {
    id: "cross-B",
  });
  const bc = grant(first.bySystem["Systems::B"]!.administration!, "C", {
    id: "cross-C",
  });
  const result = await resolveModelDelegations(
    [root()],
    [b, c, cb, bc],
    identities,
  );
  assert(result.statuses.every((status) => !status.active));
});

Deno.test("model delegation incoming administration conflicts with native root and cascades", async () => {
  const roots = [root(), root("B")];
  const b = grant(await rootAuthority(), "B", {
    recipients: ["Systems::C"],
    maxRedelegationDepth: 1,
  });
  const before = await resolveModelDelegations([root()], [b], identities);
  const c = grant(before.bySystem["Systems::B"]!.administration!, "C");
  const result = await resolveModelDelegations(roots, [b, c], identities);
  assert.equal(result.statuses[0]!.reason, "root-administration-conflict");
  assert.equal(result.statuses[1]!.reason, "inactive-parent");
  assert.equal(result.bySystem["Systems::B"]!.administration!.kind, "root");
});

Deno.test("model delegation duplicate IDs and semantic native identities never choose a winner", async () => {
  const b = grant(await rootAuthority(), "B");
  const duplicateRecords = await resolveModelDelegations([root()], [b, {
    ...b,
  }], identities);
  assert(
    duplicateRecords.statuses.every((status) =>
      status.reason === "duplicate-id"
    ),
  );
  const duplicateRoots = await resolveModelDelegations(
    [root(), root()],
    [b],
    identities,
  );
  assert(!duplicateRoots.statuses[0]!.active);
  assert.equal(duplicateRoots.bySystem["Systems::A"]!.administration, null);
  const duplicateNative = await resolveModelDelegations([root()], [b], [
    ...identities,
    { ...identities[1]!, systemQualifiedName: "::'Systems'::'B'" },
  ]);
  assert(!duplicateNative.statuses[0]!.active);
  assert.equal(duplicateNative.bySystem["Systems::B"]!.editing, null);
});

Deno.test("model delegation malformed independent branch does not disable a valid grant", async () => {
  const authority = await rootAuthority();
  const b = grant(authority, "B");
  const bad = grant(authority, "C", { maxRedelegationDepth: 9 });
  const result = await resolveModelDelegations([root()], [bad, b], identities);
  assert.equal(result.statuses[0]!.reason, "invalid-record");
  assert(result.statuses[1]!.active);
});

Deno.test("model delegation malformed long chains have bounded traversal", async () => {
  const a = await rootAuthority();
  const records = Array.from({ length: 1000 }, (_, index) =>
    grant(a, "B", {
      id: `long-${index}`,
      maxRedelegationDepth: 0,
      recipients: ["Systems::C"],
      parent: {
        kind: "delegation",
        id: `long-${index + 1}`,
        revision: 1,
        digest: "0".repeat(64),
      },
    }));
  const result = await resolveModelDelegations([root()], records, identities);
  assert(result.statuses.every((status) => !status.active));
});
