import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  requestControlModel,
  requestOpeningBase,
  requestSpaceScope,
} from "../../../../test/support/request-space-fixture.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import { type OpeningRecord } from "../../../domain/work/request-spaces/opening.ts";
import { requestSpaceDigest } from "../../../domain/work/request-spaces/scope.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import { RequestNetworkChangeSources } from "./request-network-change-sources.ts";
import { creationPreviewExercise } from "../../../domain/governance/policies/operator-creation-policy.ts";

Deno.test("Case network preparation reads admitted A=R only, preserves exact intent, and rejects drift before publication", async () => {
  const base = await requestOpeningBase(), model = requestControlModel();
  model.version.repositoryVersion = base.manifest.source!.sourceVersion;
  model.version.digest = base.manifest.operators[0].modelDigest;
  const opening: OpeningRecord = {
    id: "opening",
    caseId: "case-a",
    caseNumber: 1,
    executionSpaceId: "case-space",
    branchId: "branch",
    initialContributionId: "initial",
    scope: requestSpaceScope,
    ownerId: "human",
    command: {
      openingKey: "key",
      text: "Request",
      source: { kind: "current-main" },
    },
    commandDigest: "d".repeat(64),
    base,
    baseDigest: await requestSpaceDigest(base),
    phase: "dispatched",
    admissionId: "admission",
    revision: 1,
    issues: [],
    createdAt: "2026-10-30T00:00:00.000Z",
  };
  const sources = { "model.sysml": "old source" },
    next = { "model.sysml": "prepared source" };
  const revision: ModelRevision = {
    version: model.version.repositoryVersion,
    sources,
    elements: [],
    documents: [],
    sourceDigest: await modelSourceDigest(sources),
    semanticDigest: "b".repeat(64),
    provenanceDigest: "c".repeat(64),
    sourceHashes: {},
    engineVersion: "fixture",
  };
  const diff = {
    title: "Network",
    author: model.identity.builderId,
    base: {
      repositoryVersion: revision.version,
      modelDigest: model.version.digest,
      sourceDigest: revision.sourceDigest,
    },
    sourceDigest: await modelSourceDigest(next),
    files: [{
      path: "model.sysml",
      kind: "changed" as const,
      additions: 1,
      deletions: 1,
    }],
    patch: "exact compiled diff",
    additions: 1,
    deletions: 1,
  };
  const change: PendingChange = {
    id: "change",
    kind: "mandate-change",
    status: "pending",
    requestedBy: model.identity.builderId,
    caseId: opening.caseId,
    baseRevision: model.configuration.revision,
    baseModelDigest: model.version.digest,
    requestedAt: opening.createdAt,
    reason: "Network",
    requestedRights: { addNetworkHosts: ["docs.example.org"] },
  };
  let head = revision.version, reads = 0, prepares = 0;
  let preparedScope: unknown;
  const port = new RequestNetworkChangeSources({
    assertExecuting: (_opening, executing) => {
      deepStrictEqual(executing, model);
      return Promise.resolve();
    },
    admittedInspection: () => Promise.resolve(head),
    reader: () =>
      Promise.resolve({
        repositoryId: base.manifest.source!.repositoryId,
        at(version) {
          reads++;
          equal(version, revision.version);
          return Promise.resolve(structuredClone(revision));
        },
      }),
    prepareApprovedChangeAt: (identity, actual, proposal, digest, scope) => {
      prepares++;
      preparedScope = scope;
      deepStrictEqual(identity, model.identity);
      deepStrictEqual(actual, revision);
      equal(proposal.id, change.id);
      equal(digest, model.version.digest);
      return Promise.resolve({
        diff: structuredClone(diff),
        sources: structuredClone(next),
      });
    },
  });
  const original = structuredClone({ opening, model, change });
  const result = await port.prepare(opening, model, change);
  deepStrictEqual(result.changes, [{
    path: "model.sysml",
    text: "prepared source",
  }]);
  equal(result.expectedVersion, revision.version);
  equal(result.proposalIntentDigest.length, 64);
  deepStrictEqual({ opening, model, change }, original);
  await port.prepare(opening, model, { ...change, diff });
  await port.prepare(opening, model, {
    ...change,
    requestedRights: {
      operatorCreation: {
        networkHosts: [],
        maxChildren: 3,
        mode: "autonomous",
      },
    },
  }, 0);
  deepStrictEqual(preparedScope, {
    space: {
      projectId: model.identity.projectId,
      systemId: model.identity.systemId,
      executionSpaceId: opening.executionSpaceId,
    },
    branchTeamSize: 0,
    currentCaseId: opening.caseId,
  });
  await rejects(
    () =>
      port.prepare(opening, model, {
        ...change,
        diff: { ...diff, patch: "changed after display" },
      }),
    /displayed/,
  );
  head = `commit:${"e".repeat(40)}`;
  const before = { reads, prepares };
  await rejects(
    () => port.prepare(opening, model, change),
    /current admitted source/,
  );
  deepStrictEqual({ reads, prepares }, before);
  await rejects(() =>
    port.prepare(opening, model, { ...change, caseId: "foreign" })
  );
});

Deno.test("Case member preparation keeps its execution pin and prepares the unchanged target at the current admitted source", async () => {
  const base = await requestOpeningBase("a", true),
    model = requestControlModel();
  model.identity.builderId = "member";
  model.identity.systemId = "member-system";
  model.version.digest = "c".repeat(64);
  model.version.repositoryVersion = base.manifest.source!.sourceVersion;
  const opening = {
    id: "opening",
    caseId: "case-a",
    executionSpaceId: "case-space",
    base,
    baseDigest: await requestSpaceDigest(base),
    phase: "dispatched",
    admissionId: "admission",
  } as OpeningRecord;
  const sources = { "model.sysml": "source" };
  const next = { "model.sysml": "member network source" };
  const revision: ModelRevision = {
    version: `commit:${"b".repeat(40)}`,
    sources,
    sourceDigest: await modelSourceDigest(sources),
    elements: [],
    documents: [],
    semanticDigest: "b".repeat(64),
    provenanceDigest: "c".repeat(64),
    sourceHashes: {},
    engineVersion: "fixture",
  };
  const diff = {
    title: "Member network",
    author: "member",
    base: {
      repositoryVersion: revision.version,
      modelDigest: model.version.digest,
      sourceDigest: revision.sourceDigest!,
    },
    sourceDigest: await modelSourceDigest(next),
    files: [{
      path: "model.sysml",
      kind: "changed" as const,
      additions: 1,
      deletions: 1,
    }],
    patch: "member diff",
    additions: 1,
    deletions: 1,
  };
  const change: PendingChange = {
    id: "member-change",
    kind: "mandate-change",
    status: "pending",
    requestedBy: "member",
    caseId: opening.caseId,
    baseRevision: model.configuration.revision,
    baseModelDigest: model.version.digest,
    requestedAt: "2026-11-01T00:00:00.000Z",
    reason: "Read Case sources",
    requestedRights: { addNetworkHosts: ["docs.example.org"] },
  };
  let admitted = true, assertions = 0, reads = 0, targetChanged = false;
  let expectedProposal = change;
  const port = new RequestNetworkChangeSources({
    assertExecuting: (actualOpening, executing) => {
      assertions++;
      deepStrictEqual(actualOpening, opening);
      deepStrictEqual(executing, model);
      return admitted
        ? Promise.resolve()
        : Promise.reject(new Error("member admission withdrawn"));
    },
    admittedInspection: () => Promise.resolve(revision.version),
    reader: () =>
      Promise.resolve({
        repositoryId: base.manifest.source!.repositoryId,
        at: (version) => {
          equal(version, revision.version);
          reads++;
          return Promise.resolve(revision);
        },
      }),
    prepareApprovedChangeAt: (identity, _revision, proposal, digest, scope) => {
      if (targetChanged) throw new Error("compiled target digest changed");
      deepStrictEqual(identity, model.identity);
      deepStrictEqual(proposal, expectedProposal);
      if (proposal.kind === "operator-creation") {
        const exercise = creationPreviewExercise(model, proposal, scope!);
        equal(exercise.creationDelegation?.caseId, opening.caseId);
        equal(exercise.creationDelegation?.actorId, "member");
      }
      equal(digest, model.version.digest);
      return Promise.resolve({ diff, sources: next });
    },
  });
  const prepared = await port.prepare(opening, model, change, 2);
  equal(prepared.diff.author, "member");
  equal(prepared.expectedVersion, revision.version);
  equal(prepared.diff.base.repositoryVersion, revision.version);
  equal(model.version.repositoryVersion, base.manifest.source!.sourceVersion);
  equal(assertions, 1);
  equal(reads, 1);
  targetChanged = true;
  await rejects(
    () => port.prepare(opening, model, change, 2),
    /compiled target digest changed/,
  );
  targetChanged = false;
  admitted = false;
  await rejects(
    () => port.prepare(opening, model, change, 2),
    /admission withdrawn/,
  );
  equal(assertions, 3);
  equal(reads, 2);
  await rejects(
    () =>
      port.prepare(opening, model, { ...change, requestedBy: "operator" }, 2),
    /executing source/,
  );
  equal(assertions, 3);

  // The retained executable keeps its old lineage, but autonomous creation
  // must use the current Case supplied by the real preparation adapter.
  admitted = true;
  model.operatorTeam = {
    parentOperatorId: "operator",
    requestOwnerId: "operator",
    requestId: "old-origin",
  };
  model.ownerAuthority = {
    ...model.ownerAuthority!,
    systemId: model.identity.systemId,
  };
  model.operatorCreationPolicies = [{
    id: "member-creation",
    revision: 1,
    elementId: "member-creation-native",
    sourceIds: ["member-creation-native"],
    rootAuthority: model.ownerAuthority,
    holderNativeId: "member",
    mandateNativeId: "member-mandate",
    systemId: model.identity.systemId,
    enabled: true,
    mode: "autonomous",
    networkHosts: [],
    maxChildren: 3,
    maxDelegationDepth: 0,
    children: [],
  }];
  const { requestedRights: _networkRights, ...creationBase } = change;
  const creation: PendingChange = {
    ...creationBase,
    id: "member-creates-child",
    kind: "operator-creation",
    role: "operator",
    name: "Reader",
    teamOrigin: { operatorId: "operator", requestId: opening.caseId },
    operator: {
      kind: "request-team-member",
      instruction: "Read one passage.",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 1, maxFlowSteps: 8 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
  };
  expectedProposal = creation;
  const created = await port.prepare(opening, model, creation, 2);
  equal(created.expectedVersion, revision.version);
  equal(created.diff.base.modelDigest, model.version.digest);
  equal(model.operatorTeam.requestId, "old-origin");
  const beforeMissingReads = reads;
  await rejects(
    () => port.prepare(opening, model, creation),
    /team size is unavailable/,
  );
  equal(reads, beforeMissingReads + 1);
  const beforeForeign = { assertions, reads };
  await rejects(
    () =>
      port.prepare(opening, model, {
        ...creation,
        caseId: "old-origin",
        teamOrigin: { ...creation.teamOrigin!, requestId: "old-origin" },
      }, 2),
    /executing source/,
  );
  deepStrictEqual({ assertions, reads }, beforeForeign);
});
