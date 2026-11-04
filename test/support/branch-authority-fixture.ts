/** Spec 4.8c: one Request branch (BO) and the registered Main (MO), sharing a
 * native operator ID, as the bridge's host adapter resolves them. */
import {
  requestControlState,
  requestOpeningBase,
  requestSpaceScope,
  spaceControlAuthority,
} from "./request-space-fixture.ts";
import { type OpeningRecord } from "../../src/domain/work/request-spaces/opening.ts";
import { requestSpaceDigest } from "../../src/domain/work/request-spaces/scope.ts";
import { type SpaceExecutionAdmission } from "../../src/domain/work/request-spaces/space-control.ts";
import type { PendingChange } from "../../src/domain/governance/records/pending-change.ts";
import type { Case } from "../../src/domain/work/entities/cases.ts";
import type { RequestSpaceAuthorityBridgeSnapshot } from "../../src/application/governance/request-space-authority-bridge.ts";
import { parseRequestModelWriteDestination } from "../../src/domain/model/editing/request-write-destination.ts";

export async function branchAuthorityFixture() {
  const base = await requestOpeningBase("c");
  const request = requestControlState(), main = requestControlState();
  request.id = "branch-runtime";
  request.configuration = structuredClone(
    request.executionModel!.configuration,
  );
  request.cases = [
    {
      id: "case",
      owner: "operator",
      openedBy: "human",
      status: "open",
      openedFrom: { conversationId: request.id, openingId: "opening" },
    } as Case,
  ];
  const change = {
    id: "change",
    kind: "mandate-change",
    status: "pending",
    caseId: "case",
    requestedBy: "operator",
    requestedRights: { addNetworkHosts: ["example.org"] },
    baseRevision: request.configuration.revision,
    baseModelDigest: request.executionModel!.version.digest,
    reason: "A host is needed",
  } as PendingChange;
  request.configuration.changes = [change];
  main.designer = { scopeId: "main:designer" };
  main.executionModel!.operatorAuthorityPolicies = [];
  const opening = {
    id: "opening",
    scope: requestSpaceScope,
    ownerId: "human",
    executionSpaceId: "branch",
    caseId: "case",
    caseNumber: 1,
    command: {
      openingKey: "person-opening",
      text: "Read the page",
      source: { kind: "current-main" },
    },
    createdAt: "2026-10-27T00:00:00Z",
    admissionId: "admission",
    base,
    baseDigest: await requestSpaceDigest(base),
  } as OpeningRecord;
  const admission: SpaceExecutionAdmission = {
    id: "admission",
    scope: requestSpaceScope,
    openingId: opening.id,
    ownerId: opening.ownerId,
    executionSpaceId: opening.executionSpaceId,
    capabilityId: "capability",
    capabilityRevision: 0,
    baseDigest: opening.baseDigest!,
    status: "active",
    revision: 0,
    expiresAt: "2099-01-01T00:00:00Z",
    createdAt: "2026-10-27T00:00:00Z",
    authority: spaceControlAuthority(),
    permissions: {
      operatorIds: ["operator"],
      modelDigests: [request.executionModel!.version.digest],
      sourceVersion: request.executionModel!.version.repositoryVersion!,
      acts: ["conversation"],
      resourceIds: [],
    },
  };
  const snapshot: RequestSpaceAuthorityBridgeSnapshot = {
    opening,
    admission,
    request,
    main,
    space: {
      ...requestSpaceScope,
      executionSpaceId: "branch",
      parentExecutionSpaceId: "main",
      caseId: "case",
    },
  };
  const mandate = (recipientExecutionSpaceId: string) => {
    const model = main.executionModel!;
    model.operatorAuthorityPolicies = [{
      id: "bo-network",
      revision: 1,
      elementId: "bo-network-native",
      sourceIds: ["bo-network-native"],
      rootAuthority: structuredClone(model.ownerAuthority!),
      holderNativeId: model.identity.builderId,
      mandateNativeId: "operator-mandate",
      systemId: model.identity.systemId,
      enabled: true,
      // The BO carries the MO native ID; only the space names it.
      recipients: [model.identity.builderId],
      recipientExecutionSpaceId,
      acts: ["addNetworkHosts"],
      networkHosts: ["example.org"],
      toolIds: [],
      maxDelegationDepth: 0,
    }];
  };
  const branchId = "22222222-2222-4222-8222-222222222222";
  opening.branchId = branchId;
  const destination = parseRequestModelWriteDestination({
    v: 1,
    kind: "request",
    repositoryId: base.manifest.source!.repositoryId,
    host: { ...requestSpaceScope },
    openingId: opening.id,
    executionSpaceId: opening.executionSpaceId,
    caseId: opening.caseId,
    branchId,
    ref: `refs/heads/requests/${branchId}`,
    expectedAdmittedSource: {
      revision: 1,
      source: {
        repositoryId: base.manifest.source!.repositoryId,
        version: request.executionModel!.version.repositoryVersion!,
      },
      sourceDigest: "d".repeat(64),
    },
  });
  const identity = request.executionModel!.identity;
  /** Spec 4.8e: the BO holds a branch-read creation grant and has proposed
   * one provisioned teammate for its own Request (pending). */
  const teamProposal = (mode?: "autonomous" | "per-creation") => {
    const model = request.executionModel!;
    model.policy = {
      ...model.policy,
      maxAgentDecisions: 10,
      maxToolProposals: 4,
      maxFlowSteps: 100,
    };
    model.mandate = {
      ...model.mandate,
      mayPropose: ["read_web_page"],
      mayInvoke: "active-catalog-only",
    } as typeof model.mandate;
    model.configuration.network = { allowedHosts: ["example.org"] };
    model.operatorCreationPolicies = [{
      id: "bo-create",
      revision: 1,
      elementId: "bo-create-native",
      sourceIds: ["bo-create-native"],
      rootAuthority: structuredClone(model.ownerAuthority!),
      holderNativeId: model.identity.builderId,
      mandateNativeId: "operator-mandate",
      systemId: model.identity.systemId,
      enabled: true,
      networkHosts: ["example.org"],
      maxChildren: 5,
      maxDelegationDepth: 0,
      ...(mode ? { mode } : {}),
      children: [],
    }];
    const team = {
      id: "team-change",
      kind: "operator-creation",
      status: "pending",
      caseId: "case",
      requestedBy: "operator",
      name: "Helper",
      role: "operator",
      operator: {
        kind: "request-team-member",
        instruction: "Extract one referenced passage.",
        provision: {
          budget: {
            maxAgentDecisions: 3,
            maxToolProposals: 1,
            maxFlowSteps: 20,
          },
          networkHosts: ["example.org"],
          mayPropose: ["read_web_page"],
          mayInvokeActiveCatalog: true,
        },
      },
      teamOrigin: { operatorId: "operator", requestId: "case" },
      baseRevision: request.configuration!.revision,
      baseModelDigest: model.version.digest,
      reason: "A helper is needed",
      requestedAt: "2026-11-01T00:00:00.000Z",
    } as unknown as PendingChange;
    request.configuration!.changes = [team];
    return team;
  };
  return {
    snapshot,
    mandate,
    teamProposal,
    destination,
    /** The BO's segment, anchored on its admitted model identity. */
    space: {
      projectId: identity.projectId,
      systemId: identity.systemId,
      executionSpaceId: opening.executionSpaceId,
    },
  };
}
