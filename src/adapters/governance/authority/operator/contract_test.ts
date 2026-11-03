import assert from "node:assert/strict";
import { validateDecision } from "../../../out/llm-providers/output-validation.ts";
import {
  changeDecisionMetadata,
  modelEditingAuthorityRoots,
  OperatorAuthorityError,
  validateGrantModelEditing,
  validateRequestOperatorSpec,
} from "../../../../domain/governance/operator-authority.ts";
import { assertApprovable } from "../../../../domain/governance/policies/change-approvability.ts";
import { mainCreationScope } from "../../../../domain/governance/policies/operator-creation-policy.ts";
import { SystemGovernance } from "../../../../domain/governance/policies/governance.ts";
import type { ChatDecision } from "../../../../domain/work/dialogue.ts";

const operator = {
  instruction: "Answer bounded requests.",
  networkHosts: [],
  requestType: { name: "Research request", maxInvocations: 4 },
  firstRequest: { objective: "Ask for permission to read example.org." },
};
const creation: ChatDecision = {
  kind: "propose_agent_creation",
  role: "operator",
  name: "Research",
  reason: "Process a Request",
  text: "Proposal",
  operator,
};
const grant = {
  file: "configuration.sysml",
  root: "ASELiveBuilder::liveBuilder::catalog",
  operations: ["insert-member" as const],
};

Deno.test("typed operator and editing grant pass the provider boundary without a free mandate", () => {
  assert(validateDecision(creation));
  assert(
    validateDecision({
      kind: "propose_mandate_change",
      text: "Proposal",
      reason: "Compose the system",
      requestedRights: { grantModelEditing: grant },
    }),
  );
  assert.deepEqual(validateRequestOperatorSpec(operator), operator);
  assert.deepEqual(validateGrantModelEditing(grant), grant);
  assert(
    !validateDecision({ ...creation, mandate: { mayCreateAgents: true } }),
  );
  assert(
    !validateDecision({
      ...creation,
      operator: { ...operator, sources: { "model.sysml": "part injected;" } },
    }),
  );
});

Deno.test("authority inputs refuse unsupported grants and incomplete Request bounds with coded recovery", () => {
  for (
    const value of [
      { ...grant, operations: ["replace-source"] },
      { ...grant, operations: [] },
      { ...grant, file: "../configuration.sysml" },
      { ...grant, root: "ASELiveBuilder::*" },
    ]
  ) {
    assert.throws(
      () => validateGrantModelEditing(value),
      (error) =>
        error instanceof OperatorAuthorityError &&
        error.code === "INVALID_MODEL_EDIT_GRANT" && !!error.context &&
        !!error.recovery,
    );
  }
  for (
    const value of [
      { ...operator, requestType: { name: "Research request" } },
      {
        ...operator,
        requestType: { name: "Research request", maxInvocations: 0 },
      },
      { ...operator, firstRequest: { objective: "" } },
      { ...operator, networkHosts: ["*.example.org"] },
    ]
  ) {
    assert.throws(
      () => validateRequestOperatorSpec(value),
      (error) =>
        error instanceof OperatorAuthorityError &&
        error.code === "INVALID_OPERATOR_REQUEST" && !!error.context &&
        !!error.recovery,
    );
  }
});

Deno.test("operator creation and grants remain proposals gated by the admitted authoring policy", () => {
  const model = {
    configuration: SystemGovernance.fresh().snapshot,
    policy: {
      maxAgentDecisions: 7,
      maxToolProposals: 2,
      maxFlowSteps: 128,
      urlSelectionMode: "user-provided" as const,
      mayAddNetworkHosts: true,
      mayDelegateOwnAdmission: false,
      mayCreateReviewer: false,
      mayChangeUrlSelection: false,
      mayProposeSysmlRevision: false,
    },
  };
  const scope = mainCreationScope({
    projectId: "unit",
    systemId: model.configuration.id,
  });
  assert.throws(
    () => assertApprovable(model, creation, scope),
    /does not authorize/,
  );
  assert.throws(
    () =>
      assertApprovable(model, {
        kind: "propose_mandate_change",
        reason: "Edit",
        text: "Proposal",
        requestedRights: { grantModelEditing: grant },
      }, scope),
    /cannot request/,
  );
  model.policy.mayCreateReviewer = true;
  assert.doesNotThrow(() => assertApprovable(model, creation, scope));
  assert.equal(model.configuration.changes.length, 0);
});

Deno.test("governance refuses editing outside the requester and roots overlapping authority", () => {
  const model = {
    configuration: SystemGovernance.fresh().snapshot,
    identity: {
      projectId: "unit",
      editingContextId: "unit",
      rootId: "root",
      systemId: "system",
      catalogId: "catalog",
      builderId: "builder",
      systemQualifiedName: "Team::requester",
    },
    policy: {
      maxAgentDecisions: 7,
      maxToolProposals: 2,
      maxFlowSteps: 128,
      urlSelectionMode: "user-provided" as const,
      mayAddNetworkHosts: false,
      mayDelegateOwnAdmission: false,
      mayCreateReviewer: false,
      mayChangeUrlSelection: false,
      mayProposeSysmlRevision: true,
    },
    modelEditingAuthorityRoots: [
      "Team::requester::governance::renamedMandate",
      "Team::requester::owner::ownerMandate::rootAuthority",
    ],
  };
  for (
    const root of [
      "Team::other",
      "Team::requesterPeer",
      "Team::requester",
      "Team::requester::owner",
      "Team::requester::governance",
      "Team::requester::governance::renamedMandate::id",
    ]
  ) {
    assert.throws(
      () =>
        SystemGovernance.fromExecutable(
          {
            ...model,
          } as import("../../../../domain/model/execution/executable-model.ts").ExecutableModel,
        ).propose(
          {
            kind: "propose_mandate_change",
            text: "Proposal",
            reason: "Editing",
            requestedRights: { grantModelEditing: { ...grant, root } },
          },
          "change",
          "now",
          { requestedBy: "builder", designerScopeId: "scope" },
        ),
      (error) =>
        error instanceof OperatorAuthorityError &&
        error.code === "INVALID_MODEL_EDIT_GRANT" &&
        error.context.root === root && !!error.recovery,
    );
  }
  assert.doesNotThrow(() =>
    assertApprovable(model, {
      kind: "propose_mandate_change",
      text: "Proposal",
      reason: "Editing",
      requestedRights: {
        grantModelEditing: { ...grant, root: "'Team'::'requester'::'catalog'" },
      },
    }, mainCreationScope(model.identity))
  );
  const primary = {
    ...model,
    identity: { ...model.identity, systemQualifiedName: undefined },
    modelEditingAuthorityRoots: [
      "ASELiveBuilder::liveBuilder::owner::ownerMandate",
      "ASELiveBuilder::liveBuilder::builderMandate",
    ],
  };
  assert.doesNotThrow(() =>
    assertApprovable(primary, {
      kind: "propose_mandate_change",
      text: "Proposal",
      reason: "Editing",
      requestedRights: { grantModelEditing: grant },
    }, mainCreationScope(primary.identity))
  );
});

Deno.test("authority boundaries include derived types and renamed occurrences", () => {
  const element = (
    id: string,
    qualifiedName: string,
    typeIds: string[] = [],
    generalIds: string[] = [],
  ) => ({
    id,
    qualifiedName,
    typeIds,
    generalIds,
    name: id,
    ownerId: "",
    metaclass: "ItemUsage",
    direction: "",
    isReference: false,
    redefinedIds: [],
    multiplicity: "",
    doc: "",
  });
  assert.deepEqual(
    modelEditingAuthorityRoots([
      element("occurrence", "Team::requester::business::renamed", ["derived"]),
      element("derived", "Team::CustomMandate", [], ["mandate"]),
      element("mandate", "ASECore::ConfiguredMandate"),
      element("ordinary", "Team::requester::catalog"),
    ]),
    [
      "ASECore::ConfiguredMandate",
      "Team::CustomMandate",
      "Team::requester::business::renamed",
    ],
  );
});

Deno.test("agent change metadata excludes patch and operator payload while retaining file totals", () => {
  const change:
    import("../../../../domain/governance/records/pending-change.ts").PendingChange =
      {
        id: "creation",
        kind: "operator-creation",
        status: "approved",
        requestedBy: "builder",
        designerScopeId: "scope",
        baseRevision: 0,
        reason: "Reason",
        requestedAt: "now",
        operator,
        diff: {
          title: "Title",
          author: "builder",
          base: {
            repositoryVersion: "base",
            modelDigest: "model",
            sourceDigest: "before",
          },
          sourceDigest: "after",
          patch: "SECRET PATCH".repeat(1000),
          files: [{
            path: "configuration.sysml",
            kind: "changed",
            additions: 4,
            deletions: 1,
          }],
          additions: 4,
          deletions: 1,
        },
      };
  const metadata = changeDecisionMetadata(change);
  assert.equal(metadata.id, change.id);
  assert.equal(metadata.requestedBy, "builder");
  assert.deepEqual(metadata.diff, {
    files: change.diff!.files,
    additions: 4,
    deletions: 1,
  });
  assert(!JSON.stringify(metadata).includes("SECRET PATCH"));
  assert(!("operator" in metadata));
  metadata.diff!.files[0]!.path = "changed";
  assert.equal(change.diff!.files[0]!.path, "configuration.sysml");
  assert(change.diff!.patch.includes("SECRET PATCH"));
});
