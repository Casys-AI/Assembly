import { deepStrictEqual, rejects } from "node:assert/strict";
import { createCaseBranchReader } from "./case-branch-reader.ts";
import { requestSpaceDigest } from "../../domain/work/request-spaces/scope.ts";
import type { OpeningRecord } from "../../domain/work/request-spaces/opening.ts";
import type { SpaceController } from "../../domain/work/request-spaces/space-control.ts";

const baseVersion = `commit:${"a".repeat(40)}`;
const historical = `commit:${"b".repeat(40)}`;
const record = {
  caseId: "case1",
  branchId: "branch1",
  executionSpaceId: "space1",
  ownerId: "owner",
  phase: "branch-ready",
  scope: { projectId: "p", systemId: "s" },
  base: {
    sourceKind: "current-main",
    manifestDigest: "digest",
    requestOwner: { operatorId: "operator", caseTypeId: "type" },
    manifest: {
      source: { sourceVersion: baseVersion },
      operators: [{
        operatorId: "operator",
        repositoryVersion: baseVersion,
        tools: [],
      }],
      prerequisites: [],
    },
  },
} as unknown as OpeningRecord;
const controller = { ownerId: "owner" } as unknown as SpaceController;
Deno.test("Case branch reads resolve the host mapping and verify each version", async () => {
  record.baseDigest = await requestSpaceDigest(record.base);
  const seen: string[] = [];
  const reader = createCaseBranchReader({
    scope: record.scope,
    store: { forCase: () => Promise.resolve(record) },
    source: {
      readModelsForInspection: () => {
        seen.push("source");
        return Promise.resolve([]);
      },
    },
    branches: {
      sourceVersion: () => Promise.resolve(baseVersion),
      assertVersion: (_record, version) => {
        seen.push(version);
        return Promise.resolve();
      },
    },
  });
  const result = await reader.resolve("case1", controller, historical);
  deepStrictEqual(result.version, historical);
  deepStrictEqual(result.executionVersion, baseVersion);
  deepStrictEqual(seen, ["source", historical]);
  await rejects(() =>
    reader.resolve("case1", { ownerId: "other" } as unknown as SpaceController)
  );
  await rejects(() => reader.resolve("case1", controller, "branch:main"));
});

Deno.test("Case model inspection does not require an executable host or invoke its readiness path", async () => {
  record.baseDigest = await requestSpaceDigest(record.base);
  let inspections = 0, executionReads = 0;
  const unavailable = () => {
    executionReads++;
    throw new Error("Host execution is unavailable");
  };
  const source = {
    verify: unavailable,
    readModels: unavailable,
    readModelsForInspection: () => {
      inspections++;
      return Promise.resolve([]);
    },
  };
  const reader = createCaseBranchReader({
    scope: record.scope,
    store: { forCase: () => Promise.resolve(structuredClone(record)) },
    source,
    branches: {
      sourceVersion: () => Promise.resolve(baseVersion),
      assertVersion: () => Promise.resolve(),
    },
  });
  const result = await reader.resolve("case1", controller, historical);
  deepStrictEqual(result.version, historical);
  deepStrictEqual(inspections, 1);
  deepStrictEqual(executionReads, 0);
  await rejects(() => reader.resolve("missing", controller));
  deepStrictEqual(
    inspections,
    1,
    "a missing scoped Case never falls through to another source",
  );
});

Deno.test("Default Request inspection remains R0 while explicit inspection selects admitted A1", async () => {
  const current = structuredClone(record);
  current.baseDigest = await requestSpaceDigest(current.base);
  const seen: string[] = [];
  const reader = createCaseBranchReader({
    scope: current.scope,
    store: { forCase: () => Promise.resolve(current) },
    source: { readModelsForInspection: () => Promise.resolve([]) },
    branches: {
      sourceVersion: () => Promise.resolve(historical),
      assertVersion: (_record, version) => {
        seen.push(version);
        return Promise.resolve();
      },
    },
  });
  const normal = await reader.resolve("case1", controller);
  deepStrictEqual({
    branch: normal.branchVersion,
    execution: normal.executionVersion,
    version: normal.version,
  }, { branch: historical, execution: baseVersion, version: baseVersion });
  const explicit = await reader.resolve("case1", controller, historical);
  deepStrictEqual({
    branch: explicit.branchVersion,
    execution: explicit.executionVersion,
    version: explicit.version,
  }, { branch: historical, execution: baseVersion, version: historical });
  deepStrictEqual(seen, [baseVersion, historical]);
});

Deno.test("Case inspection uses verified admitted A1 while physical A2 is pending", async () => {
  const current = structuredClone(record);
  current.baseDigest = await requestSpaceDigest(current.base);
  current.phase = "dispatched";
  const pending = `commit:${"c".repeat(40)}`;
  const selected: string[] = [];
  const reader = createCaseBranchReader({
    scope: current.scope,
    store: { forCase: () => Promise.resolve(current) },
    source: { readModelsForInspection: () => Promise.resolve([]) },
    branches: {
      sourceVersion() {
        throw new Error("Physical branch must not select the admitted source");
      },
      assertVersion() {
        throw new Error("Physical branch must not select history");
      },
    },
    admittedInspection: (_opening, version) => {
      selected.push(version);
      if (![baseVersion, historical].includes(version)) {
        return Promise.reject(new Error("not admitted"));
      }
      return Promise.resolve(historical);
    },
  });
  const defaultView = await reader.resolve("case1", controller);
  deepStrictEqual([defaultView.branchVersion, defaultView.version], [
    historical,
    baseVersion,
  ]);
  const admitted = await reader.resolve("case1", controller, historical);
  deepStrictEqual([admitted.branchVersion, admitted.version], [
    historical,
    historical,
  ]);
  await rejects(() => reader.resolve("case1", controller, pending));
  await rejects(() =>
    reader.resolve("case1", { ...controller, ownerId: "other" }, historical)
  );
  deepStrictEqual(selected, [baseVersion, historical, pending]);
});

Deno.test("Case versions for notifications tell the unasked scope's versions and owner without inspecting models", async () => {
  const current = structuredClone(record);
  current.baseDigest = await requestSpaceDigest(current.base);
  current.phase = "dispatched";
  let inspections = 0;
  const selected: string[] = [];
  const reader = createCaseBranchReader({
    scope: current.scope,
    store: {
      forCase: (caseId) => Promise.resolve(caseId === "case1" ? current : null),
    },
    source: {
      readModelsForInspection: () => {
        inspections++;
        return Promise.resolve([]);
      },
    },
    branches: {
      sourceVersion() {
        throw new Error("Physical branch must not select the admitted source");
      },
      assertVersion() {
        throw new Error("Notifications assert no version");
      },
    },
    executionBindings: {
      read: () =>
        Promise.resolve({
          pin: { source: { version: historical } },
        } as unknown as Awaited<
          ReturnType<
            NonNullable<
              Parameters<typeof createCaseBranchReader>[0]["executionBindings"]
            >["read"]
          >
        >),
    } as unknown as Parameters<
      typeof createCaseBranchReader
    >[0]["executionBindings"],
    admittedInspection: (_opening, version) => {
      selected.push(version);
      return Promise.resolve(historical);
    },
  });
  deepStrictEqual(await reader.versions("case1"), {
    ownerId: "owner",
    branchVersion: historical,
    executionVersion: historical,
  });
  deepStrictEqual(selected, [historical]);
  deepStrictEqual(inspections, 0);
  deepStrictEqual(await reader.versions("missing"), null);
  deepStrictEqual(await reader.versions("../case1"), null);
  const elsewhere = createCaseBranchReader({
    scope: { projectId: "p", systemId: "other" },
    store: { forCase: () => Promise.resolve(current) },
    source: { readModelsForInspection: () => Promise.resolve([]) },
    branches: {
      sourceVersion: () => Promise.resolve(baseVersion),
      assertVersion: () => Promise.resolve(),
    },
  });
  deepStrictEqual(await elsewhere.versions("case1"), null);
});
