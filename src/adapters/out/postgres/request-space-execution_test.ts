import { createRequestInputAdmissionGuard } from "./request-input-admission.ts";
import type { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import { requestOriginChain } from "../../../../test/support/request-origin-chain.ts";
import { requestReleaseFixture } from "../../../../test/support/request-release-fixture.ts";
import { admissionFixture } from "../../../../test/support/request-source-admission-fixture.ts";
import { requestSourceAdmissionDigest } from "../../../application/model/source-admission/request-source-admission.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import type { AdmittedSourceChain } from "./request-source-admission-store.ts";
import assert from "node:assert/strict";
import type { Prisma, PrismaClient } from "./client.ts";
import type { PostgresHostStorage } from "./host-storage.ts";
import type { PostgresSpaceEffectStartGuard } from "../../work/runtime/postgres-ledger.ts";
import type { SpaceEffectStartProof } from "./request-space-control-store.ts";
import {
  retainedToolAdmissionId,
  retainedToolDescriptors,
  retainedToolResourceId,
} from "../../../domain/work/retained-tool-dependencies.ts";
import { decodeRequestSpaceOpening } from "./request-space-store.ts";
import {
  requestControlModel,
  requestOpeningBase,
  requestSpaceScope,
  spaceUuid,
} from "../../../../test/support/request-space-fixture.ts";
import {
  type OpeningBase,
  requestSpaceDigest,
  RequestSpaceError,
} from "../../../domain/work/request-spaces.ts";
import {
  createRequestSpaceEffectStartGuard,
  createRequestSpaceResolver,
} from "./request-space-execution.ts";

const host = requestSpaceScope;
const space = () => ({
  ...host,
  executionSpaceId: "space",
  caseId: "case",
  parentExecutionSpaceId: "main",
  lifecycle: "active",
  closedAt: null,
  case: { ...host, caseId: "case", number: 1n },
});
Deno.test("Request composition resolver reads the host binding and rejects foreign/closed/contradictory spaces", async () => {
  let row: unknown = space();
  let query: unknown;
  const client = {
    executionSpace: {
      findUnique(input: unknown) {
        query = input;
        return Promise.resolve(row);
      },
    },
  } as unknown as PrismaClient;
  const resolve = createRequestSpaceResolver(
    { client, scope: host } as PostgresHostStorage,
  );
  assert.deepEqual(await resolve("space"), {
    ...host,
    executionSpaceId: "space",
    caseId: "case",
  });
  assert.deepEqual(query, {
    where: {
      projectId_systemId_executionSpaceId: {
        ...host,
        executionSpaceId: "space",
      },
    },
    include: { case: true },
  });
  for (
    const unavailable of [
      null,
      { ...space(), projectId: "foreign" },
      { ...space(), systemId: "foreign" },
      { ...space(), executionSpaceId: "other" },
      { ...space(), lifecycle: "closed" },
      { ...space(), closedAt: new Date() },
      { ...space(), parentExecutionSpaceId: "sibling" },
      { ...space(), caseId: "" },
      { ...space(), case: null },
      { ...space(), case: { ...space().case, caseId: "sibling" } },
      { ...space(), case: { ...space().case, systemId: "foreign" } },
    ]
  ) {
    row = unavailable;
    assert.equal(await resolve("space"), null);
  }
  assert.equal(await resolve("main"), null);
  assert.equal(await resolve(""), null);
  const technical = new Error("database unavailable");
  client.executionSpace.findUnique = () => {
    throw technical;
  };
  await assert.rejects(resolve("space"), (error) => error === technical);
});

async function guardFixture() {
  const base = await requestOpeningBase();
  const command = {
    openingKey: "key",
    text: "Request",
    source: { kind: "current-main" },
  };
  const opening = {
    ...host,
    id: "opening",
    executionSpaceId: "space",
    caseId: "case",
    ownerId: "owner",
    baseJson: JSON.stringify(base),
    baseDigest: await requestSpaceDigest(base),
    commandJson: JSON.stringify(command),
    commandDigest: await requestSpaceDigest({
      scope: host,
      ownerId: "owner",
      command,
    }),
    phase: "admitted",
    admissionId: "admission",
  };
  const admission = {
    ...host,
    id: "admission",
    executionSpaceId: "space",
    openingId: "opening",
    ownerId: "owner",
    baseDigest: opening.baseDigest,
    revision: 7,
    permissionsJson: JSON.stringify({ resourceIds: [] }),
  };
  let openingRow: unknown = opening;
  let admissionRow: unknown = admission;
  let spaceRow: unknown = space();
  let originRow: unknown = null,
    originSpaceRow: unknown = null,
    repositoryRow: unknown = null;
  const reads: string[] = [];
  const originLookups: string[] = [];
  let origins = new Map<string, unknown>(),
    originSpaces = new Map<string, unknown>();
  const tx = {
    executionSpace: {
      findUnique(
        input: {
          where: {
            projectId_systemId_executionSpaceId: { executionSpaceId: string };
          };
        },
      ) {
        const target =
          input.where.projectId_systemId_executionSpaceId.executionSpaceId ===
            "space";
        reads.push(target ? "space" : "origin-space");
        return Promise.resolve(
          target ? spaceRow : originSpaces.get(
            input.where.projectId_systemId_executionSpaceId.executionSpaceId,
          ) ?? originSpaceRow,
        );
      },
    },
    spaceOpening: {
      findUnique(
        input: {
          where: {
            projectId_systemId_executionSpaceId: { executionSpaceId: string };
          };
        },
      ) {
        const target =
          input.where.projectId_systemId_executionSpaceId.executionSpaceId ===
            "space";
        reads.push(target ? "opening" : "origin-opening");
        const executionSpaceId =
          input.where.projectId_systemId_executionSpaceId.executionSpaceId;
        if (!target) originLookups.push(executionSpaceId);
        return Promise.resolve(
          target ? openingRow : origins.get(executionSpaceId) ?? originRow,
        );
      },
    },
    sourceRepository: {
      findUnique() {
        reads.push("source-repository");
        return Promise.resolve(repositoryRow);
      },
    },
    spaceExecutionAdmission: {
      findFirst() {
        reads.push("admission");
        return Promise.resolve(admissionRow);
      },
    },
  } as unknown as Prisma.TransactionClient;
  const model = requestControlModel();
  model.version.digest = base.manifest.operators[0].modelDigest;
  model.version.repositoryVersion = base.manifest.source!.sourceVersion;
  const input = {
    scope: { ...host, executionSpaceId: "space", operatorId: "operator" },
    request: {
      identity: {
        operatorId: "operator",
        scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
        purpose: "conversation",
      },
      model,
    },
  } as Parameters<PostgresSpaceEffectStartGuard>[1];
  const proof = {
    marker: "unchanged proof",
  } as unknown as SpaceEffectStartProof;
  let checks = 0;
  const guard = createRequestSpaceEffectStartGuard(host, {
    assertEffectStart(foundTx, check) {
      checks++;
      assert.equal(foundTx, tx);
      assert.deepEqual(check, {
        admissionId: "admission",
        expectedRevision: 7,
        openingId: "opening",
        executionSpaceId: "space",
        operatorId: "operator",
        modelDigest: base.manifest.operators[0].modelDigest,
        sourceVersion: base.manifest.source!.sourceVersion,
        baseDigest: opening.baseDigest,
        act: "conversation",
        expectedResourceIds: [],
      });
      return Promise.resolve(proof);
    },
  });
  return {
    guard,
    tx,
    input,
    proof,
    opening,
    admission,
    reads,
    checks: () => checks,
    originLookups,
    setOriginRows: (rows: Array<{ executionSpaceId: string }>) => {
      origins = new Map(rows.map((row) => [row.executionSpaceId, row]));
    },
    setOriginSpaceRows: (rows: Array<{ executionSpaceId: string }>) => {
      originSpaces = new Map(rows.map((row) => [row.executionSpaceId, row]));
    },
    setOrigin: (row: unknown) => {
      originRow = row;
    },
    setOriginSpace: (row: unknown) => {
      originSpaceRow = row;
    },
    setRepository: (row: unknown) => {
      repositoryRow = row;
    },
    setOpening: (row: unknown) => {
      openingRow = row;
    },
    setAdmission: (row: unknown) => {
      admissionRow = row;
    },
    setSpace: (row: unknown) => {
      spaceRow = row;
    },
  };
}

Deno.test("Request effect guard binds the actual chosen retained tool and refuses missing or foreign evidence", async () => {
  const f = await guardFixture();
  const base = await requestOpeningBase();
  const manifestDigest = "b".repeat(64), toolDigest = "d".repeat(64);
  base.manifest.operators[0].tools = [{
    candidateId: "tool-1",
    digest: toolDigest,
    sourceBinding: {
      version: 1,
      bindingId: "binding",
      versionId: "version",
      revision: 1,
      ownerId: "operator",
      localArtifactId: "tool-1",
      invocationId: "invoke",
      reference: {
        version: 2,
        scopeId: "scope",
        repositoryId: "repo",
        artifactId: "tool-1",
        kind: "tool-draft",
        commitOid: "c".repeat(40),
        entryPath: `artifacts/${manifestDigest}/source.json`,
        manifestPath: `artifacts/${manifestDigest}/manifest.json`,
        contentEncoding: "tool-draft-json-v1",
        contentDigest: toolDigest,
        manifestFormat: "assembly-artifact-package-v2",
        manifestDigestVersion: "sha256-canonical-json-v1",
        manifestDigest,
      },
    },
  }];
  base.manifestDigest = await requestSpaceDigest(base.manifest);
  const baseDigest = await requestSpaceDigest(base);
  const admissionId = await retainedToolAdmissionId(host, f.opening.id);
  const opening = {
    ...f.opening,
    baseJson: JSON.stringify(base),
    baseDigest,
    admissionId,
    caseNumber: 1n,
    branchId: spaceUuid(1),
    initialContributionId: "input",
    revision: 3,
    issuesJson: "[]",
    createdAt: new Date("2026-10-30T00:00:00Z"),
  };
  const descriptor =
    retainedToolDescriptors(decodeRequestSpaceOpening(opening), admissionId)[0];
  const resourceId = await retainedToolResourceId(descriptor);
  f.setOpening(opening);
  f.setAdmission({
    ...f.admission,
    id: admissionId,
    baseDigest,
    permissionsJson: JSON.stringify({ resourceIds: [resourceId] }),
  });
  let starts = 0;
  const guard = createRequestSpaceEffectStartGuard(host, {
    assertEffectStart(_tx, check) {
      starts++;
      assert.deepEqual(check.expectedResourceIds, [resourceId]);
      assert.equal(check.retainedTool?.resourceId, resourceId);
      return Promise.resolve(f.proof);
    },
  });
  const target = {
    kind: "invocation" as const,
    admitted: true,
    toolId: "tool-1",
    behaviorId: null,
    retainedTool: {
      resourceId,
      descriptorDigest: resourceId.slice("retained-tool:v1:".length),
      toolId: "tool-1",
      toolDigest,
    },
  };
  const input = {
    ...f.input,
    node: { mechanism: "invoke_tool" } as typeof f.input.node,
    target,
  };
  assert.equal(await guard(f.tx, input), f.proof);
  for (
    const changed of [
      { ...target, retainedTool: undefined },
      { ...target, toolId: "other" },
      {
        ...target,
        retainedTool: { ...target.retainedTool, toolDigest: "e".repeat(64) },
      },
      {
        ...target,
        retainedTool: {
          ...target.retainedTool,
          resourceId: `retained-tool:v1:${"f".repeat(64)}`,
        },
      },
    ]
  ) {
    await assert.rejects(
      () => guard(f.tx, { ...input, target: changed }),
      /unavailable/,
    );
  }
  assert.equal(starts, 1);
});

Deno.test("Request effect guard discovers exact durable opening/admission in the ledger transaction and returns CAP-3 proof unchanged", async () => {
  const f = await guardFixture();
  assert.equal(await f.guard(f.tx, f.input), f.proof);
  assert.deepEqual(f.reads, ["space", "opening", "admission"]);
  assert.equal(f.checks(), 1);
  f.setOpening({ ...f.opening, phase: "dispatched" });
  assert.equal(await f.guard(f.tx, f.input), f.proof);
});

Deno.test("Request effect guard refuses absent openings, wrong Case/owner/pin/admission before CAP-3", async () => {
  const f = await guardFixture();
  for (
    const row of [
      null,
      { ...f.opening, phase: "runtime-ready" },
      { ...f.opening, caseId: "sibling" },
      { ...f.opening, systemId: "foreign" },
      { ...f.opening, admissionId: null },
      { ...f.opening, baseDigest: "0".repeat(64) },
    ]
  ) {
    f.setOpening(row);
    await assert.rejects(f.guard(f.tx, f.input), RequestSpaceError);
  }
  f.setOpening(f.opening);
  for (
    const row of [
      null,
      { ...f.admission, id: "other" },
      { ...f.admission, openingId: "sibling" },
      { ...f.admission, executionSpaceId: "sibling" },
      { ...f.admission, ownerId: "other-owner" },
      { ...f.admission, revision: -1 },
    ]
  ) {
    f.setAdmission(row);
    await assert.rejects(f.guard(f.tx, f.input), RequestSpaceError);
  }
  f.setAdmission(f.admission);
  for (
    const update of [
      (input: typeof f.input) => {
        input.scope = { ...input.scope, projectId: "foreign" };
      },
      (input: typeof f.input) => {
        input.scope = { ...input.scope, operatorId: "other-owner" };
      },
      (input: typeof f.input) => {
        input.request.identity.operatorId = "other-owner";
      },
      (input: typeof f.input) => {
        input.request.identity.scope.scopeId = "sibling";
      },
      (input: typeof f.input) => {
        if (input.request.identity.scope.kind === "request") {
          input.request.identity.scope.rootRequestId = "sibling";
        }
      },
      (input: typeof f.input) => {
        input.request.identity.purpose = "promotion";
      },
      (input: typeof f.input) => {
        input.request.model.version.digest = "0".repeat(64);
      },
      (input: typeof f.input) => {
        input.request.model.version.repositoryVersion = `commit:${
          "b".repeat(40)
        }`;
      },
    ]
  ) {
    const input = structuredClone(f.input);
    update(input);
    await assert.rejects(f.guard(f.tx, input), RequestSpaceError);
  }
  f.setSpace({ ...space(), lifecycle: "closed" });
  await assert.rejects(f.guard(f.tx, f.input), RequestSpaceError);
  assert.equal(f.checks(), 0);
});

Deno.test("Request effect guard preserves technical failures and CAP-3 authority refusals", async () => {
  const f = await guardFixture();
  const technical = new Error("database timeout");
  const denied = new RequestSpaceError(
    "ADMISSION_REFUSED",
    "revoked during discovery",
  );
  for (const failure of [technical, denied]) {
    const guard = createRequestSpaceEffectStartGuard(host, {
      assertEffectStart() {
        return Promise.reject(failure);
      },
    });
    await assert.rejects(guard(f.tx, f.input), (error) => error === failure);
  }
  f.setOpening({ ...f.opening, baseJson: "{" });
  await assert.rejects(f.guard(f.tx, f.input), SyntaxError);
  f.setOpening({ ...f.opening, commandJson: "{" });
  await assert.rejects(f.guard(f.tx, f.input), SyntaxError);
  f.setOpening({ ...f.opening, baseJson: "null" });
  await assert.rejects(f.guard(f.tx, f.input), TypeError);
  f.setOpening(f.opening);
  f.tx.spaceOpening.findUnique = () => {
    throw technical;
  };
  await assert.rejects(f.guard(f.tx, f.input), (error) => error === technical);
});

Deno.test("Request effect guard turns semantic command/source-choice contradictions into authority refusals", async () => {
  const f = await guardFixture();
  const command = JSON.parse(f.opening.commandJson);
  for (
    const value of [
      { ...command, text: "" },
      {
        ...command,
        source: {
          kind: "current-main",
          expectedVersion: `commit:${"b".repeat(40)}`,
        },
      },
    ]
  ) {
    f.setOpening({ ...f.opening, commandJson: JSON.stringify(value) });
    await assert.rejects(
      f.guard(f.tx, f.input),
      (error) =>
        error instanceof RequestSpaceError &&
        error.code === "ADMISSION_REFUSED",
    );
  }
  assert.equal(f.checks(), 0);
});

Deno.test("Request effect guard refuses structured bases with unavailable source or owner as admission failures", async () => {
  const f = await guardFixture();
  for (
    const invalidate of [
      (base: OpeningBase) => {
        delete base.manifest.source;
      },
      (base: OpeningBase) => {
        base.requestOwner.operatorId = "unrecorded-owner";
      },
    ]
  ) {
    const base = JSON.parse(f.opening.baseJson) as OpeningBase;
    invalidate(base);
    // Preserve coherent stored digests so this exercises domain admissibility,
    // rather than the guard's independent stale-digest refusal.
    base.manifestDigest = await requestSpaceDigest(base.manifest);
    f.setOpening({
      ...f.opening,
      baseJson: JSON.stringify(base),
      baseDigest: await requestSpaceDigest(base),
    });
    await assert.rejects(
      f.guard(f.tx, f.input),
      (error) =>
        error instanceof RequestSpaceError &&
        error.code === "ADMISSION_REFUSED",
    );
  }
  assert.equal(f.checks(), 0);
});

async function requestOriginGuardFixture() {
  const f = await guardFixture(), r = await requestReleaseFixture();
  const origin = {
    ...r.record.scope,
    ...r.record,
    baseJson: JSON.stringify(r.record.base),
    commandJson: JSON.stringify(r.record.command),
  };
  const originSpace = {
    ...host,
    executionSpaceId: r.record.executionSpaceId,
    caseId: r.record.caseId,
    parentExecutionSpaceId: "main",
    lifecycle: "closed",
    closedAt: new Date(),
  };
  const repository = {
    ...host,
    repositoryId: r.source.repositoryId,
    sourceScopeId: host.systemId,
  };
  const digest = await requestSpaceDigest(r.manifest);
  const base = {
    ...r.record.base!,
    sourceKind: "release" as const,
    release: { id: "release", digest },
    manifest: r.manifest,
    manifestDigest: digest,
  };
  const command = {
    openingKey: "from-request",
    text: "Exact retained Request source",
    source: { kind: "release" as const, releaseId: "release", digest },
  };
  const opening = {
    ...f.opening,
    baseJson: JSON.stringify(base),
    baseDigest: await requestSpaceDigest(base),
    commandJson: JSON.stringify(command),
    commandDigest: await requestSpaceDigest({
      scope: host,
      ownerId: f.opening.ownerId,
      command,
    }),
  };
  f.setOpening(opening);
  f.setAdmission({ ...f.admission, baseDigest: opening.baseDigest });
  f.setOrigin(origin);
  f.setOriginSpace(originSpace);
  f.setRepository(repository);
  // Keep the existing CAP-3 assertion's exact expected base digest current.
  f.opening.baseDigest = opening.baseDigest;
  return { ...f, origin, originSpace, repository, base, opening, command };
}

Deno.test("Request effect guard accepts exact same-owner retained Request origin including closed historical scope before unchanged CAP-3", async () => {
  const f = await requestOriginGuardFixture();
  assert.equal(await f.guard(f.tx, f.input), f.proof);
  assert.equal(f.checks(), 1);
  assert.deepEqual(f.reads, [
    "space",
    "opening",
    "origin-opening",
    "origin-space",
    "source-repository",
    "admission",
  ]);
  f.setOriginSpace({ ...f.originSpace, lifecycle: "active", closedAt: null });
  assert.equal(await f.guard(f.tx, f.input), f.proof);
});

Deno.test("Request effect guard rejects missing foreign changed or cyclic retained origin without reaching CAP-3", async () => {
  const f = await requestOriginGuardFixture();
  for (
    const origin of [
      null,
      { ...f.origin, ownerId: "foreign" },
      { ...f.origin, caseId: "foreign" },
      { ...f.origin, systemId: "foreign" },
      { ...f.origin, phase: "allocated" },
      { ...f.origin, baseDigest: "0".repeat(64) },
      { ...f.origin, commandDigest: "0".repeat(64) },
      { ...f.origin, branchId: "not-a-host-uuid" },
      { ...f.origin, branchId: "10000000-0000-0000-0000-000000000001" },
    ]
  ) {
    f.setOrigin(origin);
    await assert.rejects(f.guard(f.tx, f.input), RequestSpaceError);
  }
  f.setOrigin(f.origin);
  for (
    const originSpace of [null, { ...f.originSpace, systemId: "foreign" }, {
      ...f.originSpace,
      caseId: "foreign",
    }]
  ) {
    f.setOriginSpace(originSpace);
    await assert.rejects(f.guard(f.tx, f.input), RequestSpaceError);
  }
  f.setOriginSpace(f.originSpace);
  for (
    const repository of [
      null,
      { ...f.repository, systemId: "foreign" },
      { ...f.repository, repositoryId: "foreign" },
      { ...f.repository, sourceScopeId: undefined },
      { ...f.repository, sourceScopeId: "foreign" },
    ]
  ) {
    f.setRepository(repository);
    await assert.rejects(f.guard(f.tx, f.input), RequestSpaceError);
  }
  f.setRepository(f.repository);
  for (const change of ["source", "operators", "cycle"] as const) {
    const base = structuredClone(f.base);
    if (change === "source") {
      base.manifest.source!.sourceDigest = "f".repeat(64);
    }
    if (change === "operators") {
      base.manifest.operators[0].settingsDigest = "changed-retained-settings";
    }
    if (change === "cycle") {
      base.manifest.source!.branch = { kind: "case", caseId: "case" };
    }
    base.manifestDigest = await requestSpaceDigest(base.manifest);
    const command = {
      ...f.command,
      source: { ...f.command.source, digest: base.manifestDigest },
    };
    base.release!.digest = base.manifestDigest;
    const opening = {
      ...f.opening,
      baseJson: JSON.stringify(base),
      baseDigest: await requestSpaceDigest(base),
      commandJson: JSON.stringify(command),
      commandDigest: await requestSpaceDigest({
        scope: host,
        ownerId: f.opening.ownerId,
        command,
      }),
    };
    f.setOpening(opening);
    await assert.rejects(f.guard(f.tx, f.input), RequestSpaceError);
  }
  assert.equal(f.checks(), 0);
});

async function effectOriginChain(depth: number, cycle = false) {
  const f = await guardFixture(),
    chain = await requestOriginChain(depth, cycle);
  const command = {
    openingKey: "boundary-request",
    text: "Exact origin boundary",
    source: {
      kind: "release" as const,
      releaseId: chain.base.release!.id,
      digest: chain.base.manifestDigest,
    },
  };
  const opening = {
    ...f.opening,
    baseJson: JSON.stringify(chain.base),
    baseDigest: await requestSpaceDigest(chain.base),
    commandJson: JSON.stringify(command),
    commandDigest: await requestSpaceDigest({
      scope: host,
      ownerId: f.opening.ownerId,
      command,
    }),
  };
  f.setOpening(opening);
  f.setAdmission({ ...f.admission, baseDigest: opening.baseDigest });
  f.opening.baseDigest = opening.baseDigest;
  f.setOriginRows(
    chain.records.map((record) => ({
      ...record.scope,
      ...record,
      baseJson: JSON.stringify(record.base),
      commandJson: JSON.stringify(record.command),
    })),
  );
  f.setOriginSpaceRows(
    chain.records.map((record) => ({
      ...host,
      executionSpaceId: record.executionSpaceId,
      caseId: record.caseId,
      parentExecutionSpaceId: "main",
      lifecycle: "closed",
      closedAt: new Date(),
    })),
  );
  f.setRepository({
    ...host,
    repositoryId: chain.source.repositoryId,
    sourceScopeId: host.systemId,
  });
  return { ...f, chain };
}

Deno.test("Request effect guard accepts exactly 32 origins and refuses the 33rd before origin lookup or CAP-3", async () => {
  for (const depth of [32, 33]) {
    const f = await effectOriginChain(depth);
    if (depth === 32) {
      assert.equal(await f.guard(f.tx, f.input), f.proof);
      assert.equal(f.checks(), 1);
    } else {
      await assert.rejects(
        f.guard(f.tx, f.input),
        (error) =>
          error instanceof RequestSpaceError &&
          error.code === "ADMISSION_REFUSED",
      );
      assert.equal(f.checks(), 0);
    }
    assert.deepEqual(
      f.originLookups,
      f.chain.records.slice().reverse().slice(0, 32).map((record) =>
        record.executionSpaceId
      ),
    );
  }
});

Deno.test("Request effect guard rejects coherent three-origin cycle before repeated lookup and CAP-3", async () => {
  const f = await effectOriginChain(3, true);
  await assert.rejects(
    f.guard(f.tx, f.input),
    (error) =>
      error instanceof RequestSpaceError && error.code === "ADMISSION_REFUSED",
  );
  assert.deepEqual(
    f.originLookups,
    f.chain.records.slice().reverse().map((record) => record.executionSpaceId),
  );
  assert.equal(f.checks(), 0);
});

Deno.test("Request effect guard verifies exact historical evolved-source receipt after source advance and closure before independent CAP-3", async () => {
  const f = await requestOriginGuardFixture(),
    r = await requestReleaseFixture();
  const baseline = {
    revision: 1,
    manifestDigest: r.record.base!.manifestDigest,
    source: parseModelRevisionRef({
      repositoryId: r.source.repositoryId,
      version: r.source.sourceVersion,
    }),
    sourceDigest: r.source.sourceDigest,
  };
  const first = await admissionFixture(
    r.record,
    baseline,
    spaceUuid(851),
    "d",
    r.manifest.operators[0].modelDigest,
  );
  const firstDigest = await requestSourceAdmissionDigest(first);
  const firstHead = {
    revision: 2,
    manifestDigest: firstDigest,
    source: first.result.source,
    sourceDigest: first.result.sourceDigest,
  };
  const second = await admissionFixture(
    r.record,
    firstHead,
    spaceUuid(852),
    "f",
    first.result.model.digest,
  );
  const secondDigest = await requestSourceAdmissionDigest(second);
  const chain: AdmittedSourceChain = {
    baseline,
    head: {
      revision: 3,
      manifestDigest: secondDigest,
      source: second.result.source,
      sourceDigest: second.result.sourceDigest,
    },
    cursor: { revision: 3, digest: secondDigest },
    receipts: [
      {
        revision: 2,
        manifestDigest: firstDigest,
        payload: first,
        recordedAt: r.record.createdAt,
      },
      {
        revision: 3,
        manifestDigest: secondDigest,
        payload: second,
        recordedAt: r.record.createdAt,
      },
    ],
    softwareReceipts: [],
    execution: {
      pin: {
        source: baseline.source,
        modelDigest: r.manifest.operators[0].modelDigest,
        sourceAdmission: {
          revision: 1,
          manifestDigest: baseline.manifestDigest,
        },
        adoption: null,
      },
      adoptions: [],
      softwareAdoptions: [],
    },
  };
  const manifest = structuredClone(r.manifest);
  manifest.source = {
    ...r.source,
    sourceVersion: first.result.source.version,
    admittedHeadVersion: first.result.source.version,
    sourceDigest: first.result.sourceDigest,
    requestAdmission: {
      format: "request-release-admission/v1",
      openingId: r.record.id,
      openingBaseDigest: r.record.baseDigest!,
      revision: 2,
      manifestDigest: firstDigest,
    },
  };
  manifest.operators[0] = {
    ...manifest.operators[0],
    nativeSystemId: first.result.model.identity.systemId,
    systemQualifiedName: first.result.model.identity.systemQualifiedName,
    repositoryVersion: first.result.source.version,
    modelDigest: first.result.model.digest,
    sourceDigest: first.result.sourceDigest,
    build: first.result.build,
  };
  const select = async (value: typeof manifest) => {
    const digest = await requestSpaceDigest(value);
    const base = {
      ...f.base,
      manifest: value,
      manifestDigest: digest,
      release: { id: "release", digest },
    };
    const command = {
      ...f.command,
      source: { kind: "release", releaseId: "release", digest },
    };
    const baseDigest = await requestSpaceDigest(base);
    f.setOpening({
      ...f.opening,
      baseJson: JSON.stringify(base),
      baseDigest,
      commandJson: JSON.stringify(command),
      commandDigest: await requestSpaceDigest({
        scope: host,
        ownerId: f.opening.ownerId,
        command,
      }),
    });
    f.setAdmission({ ...f.admission, baseDigest });
  };
  await select(manifest);
  f.setOrigin({
    ...f.origin,
    caseNumber: BigInt(r.record.caseNumber),
    createdAt: new Date(r.record.createdAt),
    issuesJson: "[]",
  });
  const input = structuredClone(f.input);
  input.request.model.version.digest = first.result.model.digest;
  input.request.model.version.repositoryVersion = first.result.source.version;
  input.request.model.identity = structuredClone(first.result.model.identity);
  let effects = 0, folds = 0;
  const sql = {
    assertEffectStart(
      _tx: unknown,
      check: { modelDigest: string; sourceVersion: string },
    ) {
      effects++;
      assert.equal(check.modelDigest, first.result.model.digest);
      assert.equal(check.sourceVersion, first.result.source.version);
      return Promise.resolve(f.proof);
    },
  };
  const guard = createRequestSpaceEffectStartGuard(host, sql, undefined, {
    readAdmittedSource(tx, opening) {
      folds++;
      assert.equal(tx, f.tx);
      assert.equal(opening.id, r.record.id);
      return Promise.resolve(structuredClone(chain));
    },
  });
  assert.equal(await guard(f.tx, input), f.proof);
  assert.equal(folds, 1);
  assert.equal(effects, 1);
  assert.equal(chain.head.source.version, second.result.source.version);
  assert.equal(chain.execution.pin.source.version, baseline.source.version);
  const missing = createRequestSpaceEffectStartGuard(host, sql);
  await assert.rejects(() => missing(f.tx, input), /unavailable/);
  assert.equal(effects, 1);
  for (
    const patch of [
      { revision: 3 },
      { manifestDigest: "0".repeat(64) },
      { openingId: "foreign-opening" },
      { openingBaseDigest: "0".repeat(64) },
    ]
  ) {
    const forged = structuredClone(manifest);
    Object.assign(forged.source!.requestAdmission!, patch);
    await select(forged);
    await assert.rejects(() => guard(f.tx, input), /unavailable/);
  }
  assert.equal(effects, 1);
});

Deno.test("Request effect guard refuses a BO retained tool presented by a team member", async () => {
  const f = await guardFixture();
  const base = await requestOpeningBase();
  const manifestDigest = "b".repeat(64), toolDigest = "d".repeat(64);
  base.manifest.operators[0].tools = [{
    candidateId: "tool-1",
    digest: toolDigest,
    sourceBinding: {
      version: 1,
      bindingId: "binding",
      versionId: "version",
      revision: 1,
      ownerId: "operator",
      localArtifactId: "tool-1",
      invocationId: "invoke",
      reference: {
        version: 2,
        scopeId: "scope",
        repositoryId: "repo",
        artifactId: "tool-1",
        kind: "tool-draft",
        commitOid: "c".repeat(40),
        entryPath: `artifacts/${manifestDigest}/source.json`,
        manifestPath: `artifacts/${manifestDigest}/manifest.json`,
        contentEncoding: "tool-draft-json-v1",
        contentDigest: toolDigest,
        manifestFormat: "assembly-artifact-package-v2",
        manifestDigestVersion: "sha256-canonical-json-v1",
        manifestDigest,
      },
    },
  }];
  base.manifestDigest = await requestSpaceDigest(base.manifest);
  const baseDigest = await requestSpaceDigest(base);
  const admissionId = await retainedToolAdmissionId(host, f.opening.id);
  const opening = {
    ...f.opening,
    baseJson: JSON.stringify(base),
    baseDigest,
    admissionId,
    caseNumber: 1n,
    branchId: spaceUuid(1),
    initialContributionId: "input",
    revision: 3,
    issuesJson: "[]",
    createdAt: new Date("2026-10-30T00:00:00Z"),
  };
  const descriptor =
    retainedToolDescriptors(decodeRequestSpaceOpening(opening), admissionId)[0];
  const resourceId = await retainedToolResourceId(descriptor);
  const memberDigest = "e".repeat(64);
  const sourceVersion = base.manifest.source!.sourceVersion;
  f.setOpening(opening);
  f.setAdmission({
    ...f.admission,
    id: admissionId,
    baseDigest,
    permissionsJson: JSON.stringify({
      resourceIds: [resourceId],
      operatorIds: ["operator", "member"],
      modelDigests: [base.manifest.operators[0].modelDigest, memberDigest],
      sourceVersion,
    }),
  });
  let starts = 0;
  const guard = createRequestSpaceEffectStartGuard(host, {
    assertEffectStart() {
      starts++;
      return Promise.resolve(f.proof);
    },
  }, {
    readInTransaction: () =>
      Promise.resolve({
        pin: {
          modelDigest: base.manifest.operators[0].modelDigest,
          source: { version: sourceVersion },
        },
        admission: { id: admissionId, revision: 7 },
      } as never),
  });
  const memberModel = requestControlModel();
  memberModel.identity = { ...memberModel.identity, builderId: "member" };
  memberModel.version.digest = memberDigest;
  memberModel.version.repositoryVersion = sourceVersion;
  const input = {
    scope: { ...host, executionSpaceId: "space", operatorId: "member" },
    request: {
      identity: {
        operatorId: "member",
        scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
        purpose: "conversation",
      },
      model: memberModel,
    },
    node: { mechanism: "invoke_tool" },
    target: {
      kind: "invocation",
      admitted: true,
      toolId: "tool-1",
      behaviorId: null,
      retainedTool: {
        resourceId,
        descriptorDigest: resourceId.slice("retained-tool:v1:".length),
        toolId: "tool-1",
        toolDigest,
      },
    },
  } as Parameters<PostgresSpaceEffectStartGuard>[1];
  await assert.rejects(() => guard(f.tx, input), /unavailable/);
  assert.equal(starts, 0);
});

Deno.test("member effect start selects its own scoped binding and exact pin, not the BO source version", async () => {
  const f = await guardFixture();
  const base = await requestOpeningBase();
  const memberDigest = "e".repeat(64);
  const memberVersion = `commit:${"f".repeat(40)}`;
  f.setOpening({
    ...f.opening,
    caseNumber: 1n,
    branchId: spaceUuid(1),
    initialContributionId: "input",
    revision: 3,
    issuesJson: "[]",
    createdAt: new Date("2026-10-30T00:00:00Z"),
  });
  f.setAdmission({
    ...f.admission,
    permissionsJson: JSON.stringify({
      resourceIds: [],
      operatorIds: ["operator", "member"],
      modelDigests: [base.manifest.operators[0].modelDigest, memberDigest],
      sourceVersion: base.manifest.source!.sourceVersion,
    }),
  });
  const model = structuredClone(f.input.request.model);
  model.identity = { ...model.identity, builderId: "member" };
  model.version.digest = memberDigest;
  model.version.repositoryVersion = memberVersion;
  const input = {
    ...f.input,
    scope: { ...f.input.scope, operatorId: "member" },
    request: {
      ...f.input.request,
      identity: { ...f.input.request.identity, operatorId: "member" },
      model,
    },
  };
  let selected: unknown;
  let starts = 0;
  const guard = createRequestSpaceEffectStartGuard(host, {
    assertEffectStart(_tx, check) {
      starts++;
      assert.equal(check.operatorId, "member");
      assert.equal(check.modelDigest, memberDigest);
      assert.equal(check.sourceVersion, memberVersion);
      return Promise.resolve(f.proof);
    },
  }, {
    readInTransaction(_tx, _opening, requester) {
      selected = requester;
      return Promise.resolve(
        {
          pin: {
            modelDigest: memberDigest,
            source: { version: memberVersion },
          },
          admission: { id: "admission", revision: 7 },
        } as never,
      );
    },
  });
  assert.equal(await guard(f.tx, input), f.proof);
  assert.deepEqual(selected, {
    projectId: model.identity.projectId,
    systemId: model.identity.systemId,
    executionSpaceId: "space",
    operatorId: "member",
  });
  assert.equal(starts, 1);
  const stale = structuredClone(input);
  stale.request.model.version.repositoryVersion = `commit:${"0".repeat(40)}`;
  await assert.rejects(() => guard(f.tx, stale), /unavailable/);
  assert.equal(starts, 1);
  const wrongDigest = structuredClone(input);
  wrongDigest.request.model.version.digest = "a".repeat(64);
  await assert.rejects(() => guard(f.tx, wrongDigest), /unavailable/);
  assert.equal(starts, 1);
});

Deno.test("member input admission selects and rechecks its own persisted pin across both phases", async () => {
  const f = await guardFixture();
  const base = await requestOpeningBase();
  const memberDigest = "e".repeat(64);
  const memberVersion = `commit:${"f".repeat(40)}`;
  const opening = {
    ...f.opening,
    phase: "dispatched",
    caseNumber: 1n,
    branchId: spaceUuid(1),
    initialContributionId: "input",
    revision: 3,
    issuesJson: "[]",
    createdAt: new Date("2026-10-30T00:00:00Z"),
  };
  const tx = {
    spaceOpening: { findFirst: () => Promise.resolve(opening) },
    evolutionTargetBarrier: { findUnique: () => Promise.resolve(null) },
  } as unknown as Prisma.TransactionClient;
  const admission = {
    id: "admission",
    revision: 7,
    capabilityId: "cap",
    capabilityRevision: 1,
    permissions: {
      operatorIds: ["operator", "member"],
      modelDigests: [base.manifest.operators[0].modelDigest, memberDigest],
    },
  };
  let memberReads = 0, ownerReads = 0, checks = 0;
  let selectedVersion = memberVersion;
  const binding = {
    readInTransaction: () => {
      ownerReads++;
      throw new Error("BO pin selected for member");
    },
    readOperatorInTransaction(
      _tx: unknown,
      _opening: unknown,
      operatorId: string,
    ) {
      assert.equal(operatorId, "member");
      memberReads++;
      return Promise.resolve({
        pin: {
          modelDigest: memberDigest,
          source: { version: selectedVersion },
        },
        admission,
      });
    },
  } as unknown as PostgresRequestExecutionBindingReader;
  const guard = createRequestInputAdmissionGuard(host, binding, {
    assertEffectStart(_tx, check) {
      checks++;
      assert.equal(check.operatorId, "member");
      assert.equal(check.modelDigest, memberDigest);
      assert.equal(check.sourceVersion, memberVersion);
      return Promise.resolve(f.proof);
    },
  });
  const input = {
    scope: { ...host, executionSpaceId: "space", operatorId: "member" },
    identity: { ...f.input.request.identity, operatorId: "member" },
    modelPin: { modelDigest: memberDigest, repositoryVersion: memberVersion },
    phase: "before-share",
  } as Parameters<typeof guard>[1];
  await guard(tx, input);
  await guard(tx, { ...input, phase: "after-share" });
  assert.equal(memberReads, 2);
  assert.equal(ownerReads, 0);
  assert.equal(checks, 2);
  selectedVersion = `commit:${"0".repeat(40)}`;
  await assert.rejects(() => guard(tx, input), /admission/i);
  assert.equal(checks, 2);
});
