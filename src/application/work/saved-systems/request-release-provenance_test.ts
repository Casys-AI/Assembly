import { requestSpaceDigest } from "../../../domain/work/request-spaces.ts";
import { requestOriginChain } from "../../../../test/support/request-origin-chain.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { RequestReleaseProvenance } from "./request-release-provenance.ts";
import { requestReleaseFixture } from "../../../../test/support/request-release-fixture.ts";
import { savedSystemDigest } from "../../../domain/work/saved-systems.ts";

async function fixture() {
  const f = await requestReleaseFixture();
  const reads: string[] = [];
  let visible = true, assetsAvailable = true, hideOnOriginRead = false;
  let head = f.source.sourceVersion;
  const provenance = new RequestReleaseProvenance({
    scope: f.record.scope,
    repositoryId: f.source.repositoryId,
    openings: {
      forCase: (id) => {
        reads.push(`opening:${id}`);
        if (hideOnOriginRead) visible = false;
        return Promise.resolve(
          id === f.record.caseId ? structuredClone(f.record) : null,
        );
      },
    },
    branches: {
      sourceEvidence() {
        reads.push("actual-branch");
        return Promise.resolve({
          version: head,
          branchRef: f.source.branchRef,
        });
      },
      refForInspection: () => f.source.branchRef,
    },
    canReadScope(scope) {
      reads.push(`visibility:${scope.executionSpaceId}`);
      return Promise.resolve(visible);
    },
    inspectModels(manifest) {
      reads.push(`exact-assets:${manifest.origin.executionSpaceId}`);
      if (!assetsAvailable) {
        throw new Error("Exact retained physical assets unavailable");
      }
      return Promise.resolve([structuredClone(f.model)]);
    },
    readState() {
      reads.push("pure-state");
      return Promise.resolve(structuredClone(f.state));
    },
  });
  return {
    ...f,
    reads,
    provenance,
    assetsAvailable(value: boolean) {
      assetsAvailable = value;
    },
    hideOnOriginRead() {
      hideOnOriginRead = true;
    },
    hide() {
      visible = false;
    },
    advanceBranch() {
      head = `commit:${"b".repeat(40)}`;
    },
  };
}

Deno.test("immutable Request capture keeps actual scope/ref/source and reads closed state without opening a runtime", async () => {
  const f = await fixture();
  f.state.cases![0].status = "closed-done";
  const before = structuredClone({ record: f.record, state: f.state });
  const source = await f.provenance.capture({
    branch: { kind: "case", caseId: f.record.caseId },
    sourceVersion: f.source.sourceVersion,
  }, f.scope);
  deepStrictEqual(source, f.source);
  deepStrictEqual({ record: f.record, state: f.state }, before);
  equal(f.reads.filter((read) => read === "actual-branch").length, 1);
  equal(f.reads.filter((read) => read === "pure-state").length, 1);
});

Deno.test("new B0 capture refuses an advanced branch and verifies birth independently of present runtime", async () => {
  const branch = await fixture();
  branch.advanceBranch();
  await rejects(() =>
    branch.provenance.capture({
      branch: { kind: "case", caseId: branch.record.caseId },
      sourceVersion: branch.source.sourceVersion,
    }, branch.scope)
  );
  const runtime = await fixture();
  runtime.state.executionModel!.version.repositoryVersion = `commit:${
    "b".repeat(40)
  }`;
  await runtime.provenance.capture({
    branch: { kind: "case", caseId: runtime.record.caseId },
    sourceVersion: runtime.source.sourceVersion,
  }, runtime.scope);
});

Deno.test("evolved Request source retains its admitted receipt independently of runtime and later head", async () => {
  const f = await requestReleaseFixture();
  const version = `commit:${"b".repeat(40)}`;
  const sourceDigest = "b".repeat(64);
  const model = structuredClone(f.model);
  model.identity.projectId = `git:${f.source.repositoryId}`;
  model.version.repositoryVersion = version;
  model.version.digest = "c".repeat(64);
  const build = {
    v: 1 as const,
    kind: "ase-model-build" as const,
    repositoryId: f.source.repositoryId,
    sourceDigest,
    recipe: {
      toolkit: { version: "1", bundleDigest: "d".repeat(64) },
      format: "fixture",
      normalizerVersion: 1,
      irVersion: "1",
      artifactSchema: 1,
      engineVersion: "1",
      digest: "e".repeat(64),
    },
    buildKey: "f".repeat(64),
    artifactDigest: "a".repeat(64),
    bytes: 1,
  };
  const facts = {
    requestAdmission: {
      format: "request-release-admission/v1" as const,
      openingId: f.record.id,
      openingBaseDigest: f.record.baseDigest!,
      revision: 3,
      manifestDigest: "1".repeat(64),
    },
    source: { repositoryId: f.source.repositoryId, version },
    sourceDigest,
    build,
    model: { identity: model.identity, digest: model.version.digest },
  };
  let current = facts;
  const provenance = new RequestReleaseProvenance({
    scope: f.record.scope,
    repositoryId: f.source.repositoryId,
    openings: { forCase: () => Promise.resolve(structuredClone(f.record)) },
    branches: {
      sourceEvidence() {
        throw new Error("Must not follow physical A2");
      },
      refForInspection: () => f.source.branchRef,
    },
    journal: {
      selected: (_record, selected) => {
        if (selected === facts.source.version) return Promise.resolve(facts);
        if (selected === current.source.version) {
          return Promise.resolve(current);
        }
        return Promise.reject(new Error("not admitted"));
      },
      historical: (_record, ref) => {
        if (
          JSON.stringify(ref) !== JSON.stringify(facts.requestAdmission)
        ) throw new Error("Unknown receipt");
        return Promise.resolve(facts);
      },
    },
    canReadScope: () => Promise.resolve(true),
    inspectModels: () => Promise.resolve([f.model]),
    readState: () => Promise.resolve(f.state),
  });
  const selection = {
    branch: { kind: "case" as const, caseId: f.record.caseId },
    sourceVersion: version,
  };
  const source = await provenance.capture(selection, f.scope);
  deepStrictEqual(source.requestAdmission, facts.requestAdmission);
  const capture = {
    origin: f.scope,
    source,
    registeredOperatorIds: ["operator"],
    operators: [{
      operatorId: "operator",
      nativeSystemId: model.identity.systemId,
      ...(model.identity.systemQualifiedName
        ? { systemQualifiedName: model.identity.systemQualifiedName }
        : {}),
      modelDigest: model.version.digest,
      repositoryVersion: version,
      settingsDigest: "settings",
      tools: [],
    }],
    prerequisites: [],
  };
  await provenance.assertAccepted(capture, f.scope);
  const manifest = {
    ...f.manifest,
    source,
    operators: [{
      ...f.manifest.operators[0],
      ...capture.operators[0],
      sourceDigest,
      build,
    }],
  };
  await provenance.assertOriginRelation(manifest);
  current = {
    ...facts,
    source: { ...facts.source, version: `commit:${"d".repeat(40)}` },
  };
  deepStrictEqual(await provenance.capture(selection, f.scope), source);
  await rejects(() =>
    provenance.capture({
      ...selection,
      sourceVersion: `commit:${"e".repeat(40)}`,
    }, f.scope)
  );
  await provenance.assertAccepted(capture, f.scope);
  await provenance.assertOriginRelation(manifest);
  await rejects(() =>
    provenance.assertOriginRelation({
      ...manifest,
      source: {
        ...source,
        requestAdmission: {
          ...source.requestAdmission!,
          manifestDigest: "2".repeat(64),
        },
      },
    })
  );
});

Deno.test("verified B0 remains selectable while a physical successor is not admitted", async () => {
  const f = await requestReleaseFixture();
  let checked = "";
  const provenance = new RequestReleaseProvenance({
    scope: f.record.scope,
    repositoryId: f.source.repositoryId,
    openings: { forCase: () => Promise.resolve(f.record) },
    branches: {
      sourceEvidence() {
        throw new Error("Do not select physical successor");
      },
      refForInspection: () => f.source.branchRef,
      assertRetainedExecutionVersion: (_record, version) => {
        checked = version;
        return Promise.resolve();
      },
    },
    journal: {
      selected: (_record, version) =>
        version === f.source.sourceVersion
          ? Promise.resolve(null)
          : Promise.reject(new Error("not admitted")),
      historical() {
        throw new Error("No evolved receipt");
      },
    },
    canReadScope: () => Promise.resolve(true),
    inspectModels: () => Promise.resolve([f.model]),
    readState: () => Promise.resolve(f.state),
  });
  const selected = await provenance.capture({
    branch: { kind: "case", caseId: f.record.caseId },
    sourceVersion: f.source.sourceVersion,
  }, f.scope);
  deepStrictEqual(selected, f.source);
  equal(checked, f.source.sourceVersion);
  await rejects(() =>
    provenance.capture({
      branch: { kind: "case", caseId: f.record.caseId },
      sourceVersion: `commit:${"b".repeat(40)}`,
    }, f.scope)
  );
});

Deno.test("a retained Request-origin source remains inspectable after closure/branch advance but withdrawn visibility refuses", async () => {
  const f = await fixture();
  f.state.cases![0].status = "closed-done";
  f.advanceBranch();
  f.state.executionModel!.version.repositoryVersion = `commit:${
    "b".repeat(40)
  }`;
  await f.provenance.assertManifest(f.manifest);
  equal(f.reads.includes("actual-branch"), false);
  equal(f.reads.includes("pure-state"), false);
  f.hide();
  await rejects(() => f.provenance.assertManifest(f.manifest));
});

Deno.test("foreign scope, wrong Case/ref, changed closure and tampered opening each fail without Main substitution", async () => {
  const f = await fixture();
  await rejects(() =>
    f.provenance.capture({
      branch: { kind: "case", caseId: "foreign" },
      sourceVersion: f.source.sourceVersion,
    }, f.scope)
  );
  await rejects(() =>
    f.provenance.capture({
      branch: { kind: "case", caseId: f.record.caseId },
      sourceVersion: f.source.sourceVersion,
    }, { ...f.scope, executionSpaceId: "other" })
  );
  for (
    const patch of [
      { origin: { ...f.scope, systemId: "foreign" } },
      { source: { ...f.source, branchRef: "refs/heads/admitted" } },
      { operators: [{ ...f.manifest.operators[0], modelDigest: "changed" }] },
    ]
  ) {
    await rejects(() =>
      f.provenance.assertManifest({ ...f.manifest, ...patch })
    );
  }
  f.record.command.text = "tampered";
  await rejects(() => f.provenance.assertManifest(f.manifest));
});

Deno.test("accepted-source repair checks historical exact provenance without recapturing a moving branch", async () => {
  const f = await fixture();
  f.advanceBranch();
  const capture = {
    origin: f.scope,
    source: f.source,
    registeredOperatorIds: ["operator"],
    operators: [{
      operatorId: "operator",
      modelDigest: f.model.version.digest,
      repositoryVersion: f.source.sourceVersion,
      settingsDigest: "settings",
      tools: [],
    }],
    prerequisites: [],
    admission: { operatorIds: ["operator"], prerequisites: [] },
  };
  const before = await savedSystemDigest(capture);
  await f.provenance.assertAccepted(capture, f.scope);
  equal(await savedSystemDigest(capture), before);
  equal(f.reads.includes("actual-branch"), false);
  f.hide();
  await rejects(() => f.provenance.assertAccepted(capture, f.scope));
});

Deno.test("retained Request preflight accepts exactly 32 origins and refuses the 33rd before reading it", async () => {
  for (const depth of [32, 33]) {
    const chain = await requestOriginChain(depth);
    const reads: string[] = [];
    const assetScopes: string[] = [];
    const records = new Map(
      chain.records.map((record) => [record.caseId, record]),
    );
    const provenance = new RequestReleaseProvenance({
      scope: chain.record.scope,
      repositoryId: chain.source.repositoryId,
      openings: {
        forCase(id) {
          reads.push(id);
          return Promise.resolve(structuredClone(records.get(id) ?? null));
        },
      },
      branches: {
        sourceEvidence() {
          throw new Error("Historical lineage must not read a live ref");
        },
        refForInspection: (record) => `refs/heads/requests/${record.branchId}`,
      },
      canReadScope: () => Promise.resolve(true),
      inspectModels: (manifest) => {
        assetScopes.push(manifest.origin.executionSpaceId);
        return Promise.resolve([structuredClone(chain.model)]);
      },
      readState() {
        throw new Error("Historical lineage must not read a runtime");
      },
    });
    if (depth === 32) await provenance.assertManifest(chain.manifest);
    else {await rejects(provenance.assertManifest(chain.manifest), (error) =>
        error instanceof Error && "code" in error &&
        error.code === "UNAVAILABLE");}
    deepStrictEqual(
      reads,
      chain.records.slice().reverse().slice(0, 32).map((record) =>
        record.caseId
      ),
    );
    deepStrictEqual(
      assetScopes,
      depth === 32
        ? ["main", ...chain.records.map((record) => record.executionSpaceId)]
        : [],
      "Full manifest inspection still validates every exact physical ancestor, never only the final source",
    );
  }
});

Deno.test("retained Request preflight rejects a coherent three-origin cycle before rereading its first record", async () => {
  const chain = await requestOriginChain(3, true);
  const reads: string[] = [];
  const records = new Map(
    chain.records.map((record) => [record.caseId, record]),
  );
  const provenance = new RequestReleaseProvenance({
    scope: chain.record.scope,
    repositoryId: chain.source.repositoryId,
    openings: {
      forCase(id) {
        reads.push(id);
        return Promise.resolve(structuredClone(records.get(id) ?? null));
      },
    },
    branches: {
      sourceEvidence() {
        throw new Error("Historical lineage must not read a live ref");
      },
      refForInspection: (record) => `refs/heads/requests/${record.branchId}`,
    },
    canReadScope: () => Promise.resolve(true),
    inspectModels: () => Promise.resolve([structuredClone(chain.model)]),
    readState() {
      throw new Error("Historical lineage must not read a runtime");
    },
  });
  await rejects(
    provenance.assertManifest(chain.manifest),
    (error) =>
      error instanceof Error && "code" in error && error.code === "UNAVAILABLE",
  );
  deepStrictEqual(
    reads,
    chain.records.slice().reverse().map((record) => record.caseId),
  );
});

Deno.test("origin relation checks fresh ancestry and visibility without physical inspection; full manifest keeps both exact inspections", async () => {
  const f = await fixture();
  await f.provenance.assertOriginRelation(f.manifest);
  await f.provenance.assertOriginRelation(f.manifest);
  equal(f.reads.filter((read) => read.startsWith("opening:")).length, 2);
  equal(f.reads.filter((read) => read.startsWith("exact-assets:")).length, 0);
  equal(f.reads.includes("actual-branch"), false);
  equal(f.reads.includes("pure-state"), false);
  await f.provenance.assertManifest(f.manifest);
  deepStrictEqual(f.reads.filter((read) => read.startsWith("exact-assets:")), [
    "exact-assets:main",
    `exact-assets:${f.scope.executionSpaceId}`,
  ]);
});

Deno.test("origin relation is not a physical asset verdict and never caches source visibility", async () => {
  const f = await fixture();
  f.assetsAvailable(false);
  await f.provenance.assertOriginRelation(f.manifest);
  equal(f.reads.filter((read) => read.startsWith("exact-assets:")).length, 0);
  await rejects(
    f.provenance.assertManifest(f.manifest),
    /Exact retained physical assets unavailable/,
  );
  f.hide();
  await rejects(f.provenance.assertOriginRelation(f.manifest));
  const racing = await fixture();
  racing.hideOnOriginRead();
  await rejects(racing.provenance.assertOriginRelation(racing.manifest));
  equal(
    racing.reads.filter((read) => read.startsWith("exact-assets:")).length,
    0,
  );
});

Deno.test("origin relation preserves exact immutable source rejection before physical checks", async () => {
  const f = await fixture();
  const changed = structuredClone(f.manifest);
  changed.operators[0].settingsDigest = "altered-retained-settings";
  await rejects(f.provenance.assertOriginRelation(changed));
  equal(f.reads.filter((read) => read.startsWith("exact-assets:")).length, 0);
  // Coherent ancestor hashes cannot hide a different retained asset vector.
  f.record.base!.manifest.operators[0].settingsDigest =
    "changed-ancestor-settings";
  f.record.base!.manifestDigest = await requestSpaceDigest(
    f.record.base!.manifest,
  );
  f.record.baseDigest = await requestSpaceDigest(f.record.base);
  await rejects(f.provenance.assertOriginRelation(f.manifest));
  equal(f.reads.filter((read) => read.startsWith("exact-assets:")).length, 0);
});
