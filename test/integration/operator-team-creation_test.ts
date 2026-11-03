import assert from "node:assert/strict";
import type { HostEdit } from "../../src/domain/model/editing/host-edit.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  SourceModel,
  sourceModelIdentity,
  type SourceRevision,
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import {
  operatorAuthorityRequests,
  requestOperatorSystemName,
} from "../../src/adapters/governance/authority/operator/writer.ts";
import { applyEdits } from "../../src/adapters/model/sources/editing/host-writer.ts";
import { modelToolingTarget } from "../../src/adapters/model/sources/editing/tooling.ts";
import { MemorySourceRepository } from "../support/memory-source-repository.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import { changePublication } from "../../src/domain/model/publication/change.ts";
import { NativeModelPublicationRevalidator } from "../../src/adapters/governance/model-access/publication/policy.ts";
import type {
  OperatorCreationGrant,
  OperatorCreationSpec,
} from "../../src/domain/governance/operator-authority.ts";
import {
  assertCreationWithinPolicy,
  mainCreationScope,
} from "../../src/domain/governance/policies/operator-creation-policy.ts";
import type { TeamOperatorSpec } from "../../src/domain/governance/operator-authority.ts";

Deno.test({
  name:
    "native bounded team creation publishes two generations with one originating Request and callable inboxes",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const options = { packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")! };
    const compiler = new ToolkitCompiler(options),
      tooling = new SysmlToolkitAdapter(options);
    const compile = async (
      sources: Record<string, string>,
    ): Promise<SourceRevision> => {
      const diagnostics = await tooling.check(sources);
      assert.deepEqual(
        diagnostics.filter((item) =>
          item.severity.toLowerCase() === "error" ||
          item.stage === "referential" &&
            (item.unit === undefined || Object.hasOwn(sources, item.unit))
        ),
        [],
      );
      return {
        ...await compiler.compile(sources),
        version: "native-team-base",
      };
    };
    const sources = await loadInitialSources(undefined, { information: false });
    const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
    const mainScope = "AssemblyLiveBuilder::liveBuilder";
    const repository = new MemorySourceRepository(compiler);
    const mainSource = new SourceModel({
      repository,
      projectId,
      tooling,
      initialSources: sources,
      systemQualifiedName: mainScope,
    });
    await mainSource.initialize();
    const publish = async (
      parentScope: string,
      changeId: string,
      spec: OperatorCreationSpec,
      teamOrigin?: { operatorId: string; requestId: string },
    ) => {
      const source = new SourceModel({
        repository,
        projectId,
        tooling,
        systemQualifiedName: parentScope,
      });
      const identity = await source.initialize();
      const current = await source.readExecutableModel(identity);
      const pending = SystemGovernance.fromExecutable(current).propose(
        {
          kind: "propose_agent_creation",
          role: "operator",
          name: changeId,
          text: "Compose one bounded operator",
          reason: "Contribute to the originating Request",
          operator: spec,
        },
        changeId,
        "2026-10-27T00:00:00Z",
        {
          requestedBy: identity.builderId,
          ...(teamOrigin
            ? { caseId: teamOrigin.requestId }
            : { designerScopeId: "main-design" }),
        },
      );
      if (teamOrigin) pending.teamOrigin = teamOrigin;
      pending.diff = await source.previewApprovedChange(
        identity,
        pending,
        current.version.digest,
      );
      const grant = teamOrigin
        ? assertCreationWithinPolicy(
          current,
          spec,
          undefined,
          mainCreationScope(current.identity),
        )
        : undefined;
      const approved = SystemGovernance.fromExecutable(current, [pending])
        .decideChange(
          changeId,
          current.configuration.revision,
          true,
          "2026-10-27T00:01:00Z",
          grant
            ? {
              actorId: identity.builderId,
              policyId: grant.id,
              policyRevision: grant.revision,
            }
            : undefined,
        );
      assert.equal(approved.authority, teamOrigin ? "builder" : "human");
      const approval = changePublication(approved, current.version);
      const originalApproval = structuredClone(approval);
      const executionBase = await repository.current();
      await source.applyApprovedChange(
        identity,
        approved,
        current.version.digest,
        approval,
      );
      const candidate = await repository.current();
      // Exercise the same native prior-authority/effect validator used by the
      // durable queue, using its unchanged-base preparation representation.
      const nativeEdits = approval.edits.filter((edit): edit is HostEdit =>
        "format" in edit && edit.format === 1
      );
      assert.equal(nativeEdits.length, approval.edits.length);
      await new NativeModelPublicationRevalidator(projectId).revalidate({
        approval: originalApproval,
        executionBase,
        candidate: { ...candidate, version: executionBase.version },
        edits: nativeEdits,
        change: approved,
      });
      const again = await source.applyApprovedChange(
        identity,
        approved,
        current.version.digest,
        approval,
      );
      assert.equal(again.version.repositoryVersion, candidate.version);
      assert.equal((await repository.current()).version, candidate.version);
      return {
        candidate,
        scope: await requestOperatorSystemName(parentScope, changeId),
        approved,
      };
    };
    const independent = async (
      changeId: string,
      creationGrant?: OperatorCreationGrant,
    ) =>
      await publish(mainScope, changeId, {
        instruction:
          "Own the originating Request and compose only an authorized team.",
        networkHosts: [],
        requestType: { name: "Research request", maxInvocations: 4 },
        firstRequest: { objective: "Produce a sourced answer." },
        ...(creationGrant ? { creationGrant } : {}),
      });
    const owner = await independent("request-owner", {
      networkHosts: [],
      maxChildren: 2,
      maxDelegationDepth: 1,
    });
    const ordinary = await independent("ordinary-owner");
    const noGrant = await validateSourceExecutable(
      ordinary.candidate,
      projectId,
      ordinary.scope,
    );
    assert.equal(
      noGrant.operatorCreationPolicies?.filter((policy) =>
        policy.holderNativeId === noGrant.identity.builderId
      ).length ?? 0,
      0,
    );
    assert.throws(() =>
      assertCreationWithinPolicy(
        noGrant,
        {
          kind: "request-team-member",
          instruction: "No implicit authority",
          provision: {
            budget: {
              maxAgentDecisions: 1,
              maxToolProposals: 0,
              maxFlowSteps: 1,
            },
            networkHosts: [],
            mayPropose: [],
            mayInvokeActiveCatalog: false,
          },
        },
        undefined,
        mainCreationScope(noGrant.identity),
      )
    );
    const rootScope = owner.scope;
    // An independent Request operator starts with read only. Explicit fixture
    // owner admission of revision authority supplies a creator that can pass on
    // both independently bounded rights to its team member.
    const initialRoot = await validateSourceExecutable(
      ordinary.candidate,
      projectId,
      rootScope,
    );
    assert.equal(initialRoot.policy.mayConsultModel, true);
    assert.equal(initialRoot.policy.mayProposeSysmlRevision, false);
    const revisionField = ordinary.candidate.elements.find((element) =>
      element.qualifiedName ===
        `${rootScope}::conversation::executionPolicy::mayProposeSysmlRevision`
    );
    assert(revisionField);
    const elevated = await tooling.edit(ordinary.candidate.sources, [{
      kind: "set-value",
      target: modelToolingTarget(
        ordinary.candidate,
        String(revisionField["@id"]),
      ),
      expression: "true",
    }]);
    const base = await repository.publishSystemSources(
      elevated.sources,
      ordinary.candidate.version,
      "fixture-owner-read-and-revision-grant",
    );
    const root = await validateSourceExecutable(base, projectId, rootScope);
    assert.equal(root.policy.mayConsultModel, true);
    assert.equal(root.policy.mayProposeSysmlRevision, true);
    assert.equal(root.operatorTeam, undefined);
    assert.equal(root.caseTypes?.length, 1);
    const rootGrant = root.operatorCreationPolicies!.find((policy) =>
      policy.holderNativeId === root.identity.builderId
    )!;
    assert.equal(rootGrant.maxChildren, 2);
    assert.equal(rootGrant.parentPolicyElementId, undefined);
    const rootOrigin = {
      operatorId: root.identity.builderId,
      requestId: "one-originating-request",
    };
    const first: TeamOperatorSpec = {
      kind: "request-team-member",
      instruction: "Contribute research to the originating Request.",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
        mayConsultModel: true,
        mayProposeSysmlRevision: true,
      },
      creationGrant: {
        networkHosts: [],
        maxChildren: 1,
        maxDelegationDepth: 0,
      },
    };
    const create = async (
      revision: SourceRevision,
      parentScope: string,
      changeId: string,
      spec: TeamOperatorSpec,
    ) => {
      const parent = await validateSourceExecutable(
        revision,
        projectId,
        parentScope,
      );
      const grant = assertCreationWithinPolicy(
        parent,
        spec,
        undefined,
        mainCreationScope(parent.identity),
      );
      assert.equal((await repository.current()).version, revision.version);
      const published = await publish(parentScope, changeId, spec, rootOrigin);
      const { candidate } = published;
      const child = await validateSourceExecutable(
        candidate,
        projectId,
        published.scope,
      );
      const updatedParent = await validateSourceExecutable(
        candidate,
        projectId,
        parentScope,
      );
      assert.equal(
        child.flows.conversation.nodes.some((node) =>
          node.mechanism === "consult_declared_source"
        ),
        false,
        "A newly created team member inherits the default flow without a declared read",
      );
      assert.deepEqual(child.operatorTeam, {
        parentOperatorId: parent.identity.builderId,
        requestOwnerId: rootOrigin.operatorId,
        requestId: rootOrigin.requestId,
        creationPolicyId: grant.id,
      });
      assert.equal(child.caseTypes?.length ?? 0, 0);
      const inbox = child.operatorEntries!.find((entry) =>
        entry.kind === "inbox"
      )!;
      assert(inbox);
      assert.equal(
        updatedParent.behaviors?.filter((behavior) =>
          behavior.targetNativeId === inbox.id &&
          behavior.callerNativeId === parent.identity.builderId
        ).length,
        1,
      );
      assert.equal(
        updatedParent.operatorCreationPolicies!.find((policy) =>
          policy.id === grant.id
        )!.children.length,
        grant.children.length + 1,
      );
      return { candidate, child, scope: published.scope };
    };
    const mainBeforeTeam = await validateSourceExecutable(
      base,
      projectId,
      mainScope,
    );
    const child = await create(base, rootScope, "first-child", first);
    assert.equal(child.child.policy.mayConsultModel, true);
    assert.equal(child.child.policy.mayProposeSysmlRevision, true);
    const ownerBeforeLeaf = await validateSourceExecutable(
      child.candidate,
      projectId,
      rootScope,
    );
    const leaf = await create(child.candidate, child.scope, "second-child", {
      kind: "request-team-member",
      instruction: "Contribute an exact citation.",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    });
    assert.equal(leaf.child.policy.mayConsultModel, false);
    assert.equal(leaf.child.policy.mayProposeSysmlRevision, false);
    const ownerAfterLeaf = await validateSourceExecutable(
      leaf.candidate,
      projectId,
      rootScope,
    );
    const mainAfterTeam = await validateSourceExecutable(
      leaf.candidate,
      projectId,
      mainScope,
    );
    assert.equal(ownerAfterLeaf.version.digest, ownerBeforeLeaf.version.digest);
    assert.equal(mainAfterTeam.version.digest, mainBeforeTeam.version.digest);
    assert(
      ownerAfterLeaf.operatorCreationPolicies!.every((policy) =>
        policy.holderNativeId === ownerAfterLeaf.identity.builderId &&
        policy.systemId === ownerAfterLeaf.identity.systemId
      ),
    );
    assert.equal(leaf.child.operatorCreationPolicies, undefined);
    assert.throws(() =>
      assertCreationWithinPolicy(
        leaf.child,
        {
          kind: "request-team-member",
          instruction: "Unauthorized third generation.",
          provision: {
            budget: {
              maxAgentDecisions: 1,
              maxToolProposals: 0,
              maxFlowSteps: 1,
            },
            networkHosts: [],
            mayPropose: [],
            mayInvokeActiveCatalog: false,
          },
        },
        undefined,
        mainCreationScope(leaf.child.identity),
      )
    );
    const exhausted = await validateSourceExecutable(
      leaf.candidate,
      projectId,
      child.scope,
    );
    assert.throws(() =>
      assertCreationWithinPolicy(
        exhausted,
        {
          kind: "request-team-member",
          instruction: "Exhausted child count.",
          provision: {
            budget: {
              maxAgentDecisions: 1,
              maxToolProposals: 0,
              maxFlowSteps: 1,
            },
            networkHosts: [],
            mayPropose: [],
            mayInvokeActiveCatalog: false,
          },
        },
        undefined,
        mainCreationScope(exhausted.identity),
      )
    );
    const revokedSources = {
      ...leaf.candidate.sources,
      "configuration.sysml": leaf.candidate.sources["configuration.sysml"]!
        .replace(
          /(part creationPolicy[\s\S]*?attribute :>> enabled = )true;/,
          "$1false;",
        ),
    };
    assert.notEqual(
      revokedSources["configuration.sysml"],
      leaf.candidate.sources["configuration.sysml"],
    );
    const revoked = await compile(revokedSources);
    const retainedChild = await validateSourceExecutable(
      revoked,
      projectId,
      child.scope,
    );
    assert.equal(
      retainedChild.operatorCreationPolicies!.find((policy) =>
        policy.holderNativeId === retainedChild.identity.builderId
      )!.enabled,
      false,
    );
    assert(
      retainedChild.operatorEntries!.some((entry) => entry.kind === "inbox"),
    );
    assert.throws(() =>
      assertCreationWithinPolicy(
        retainedChild,
        {
          kind: "request-team-member",
          instruction: "Revoked creation.",
          provision: {
            budget: {
              maxAgentDecisions: 1,
              maxToolProposals: 0,
              maxFlowSteps: 1,
            },
            networkHosts: [],
            mayPropose: [],
            mayInvokeActiveCatalog: false,
          },
        },
        undefined,
        mainCreationScope(retainedChild.identity),
      )
    );
  },
});

Deno.test({
  name:
    "native sibling creation preserves an existing child's grant while ancestor revocation changes it",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const options = { packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")! };
    const compiler = new ToolkitCompiler(options),
      tooling = new SysmlToolkitAdapter(options);
    const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
    const compile = async (
      sources: Record<string, string>,
    ): Promise<SourceRevision> => ({
      ...await compiler.compile(sources),
      version: "native-sibling-base",
    });
    let revision = await compile(
      await loadInitialSources(undefined, { information: false }),
    );
    const mainScope = "AssemblyLiveBuilder::liveBuilder";
    const initial = await operatorAuthorityRequests(revision, {
      op: "createRequestOperator",
      systemName: mainScope,
      changeId: "sibling-request-owner",
      name: "Request owner",
      operator: {
        instruction: "Own one Request.",
        networkHosts: [],
        requestType: { name: "Research", maxInvocations: 4 },
        firstRequest: { objective: "Prepare two independent contributions." },
        creationGrant: {
          networkHosts: [],
          maxChildren: 2,
          maxDelegationDepth: 1,
        },
      },
    });
    const initialEdits = await applyEdits(tooling, revision, initial.requests, {
      compile,
    });
    revision = await compile(initialEdits.sources);
    const ownerScope = initial.systemQualifiedName;
    const ownerIdentity = sourceModelIdentity(revision, projectId, ownerScope);
    const origin = {
      operatorId: ownerIdentity.builderId,
      requestId: "same-originating-request",
    };
    const create = async (
      changeId: string,
      spec: TeamOperatorSpec,
      bumpMandate = false,
    ) => {
      const parent = await validateSourceExecutable(
        revision,
        projectId,
        ownerScope,
      );
      const grant = assertCreationWithinPolicy(
        parent,
        spec,
        undefined,
        mainCreationScope(parent.identity),
      );
      const write = await operatorAuthorityRequests(revision, {
        op: "createRequestOperator",
        systemName: ownerScope,
        changeId,
        name: changeId,
        operator: spec,
        creatorMayAddNetworkHosts: parent.policy.mayAddNetworkHosts,
        teamOrigin: origin,
        parentOperatorId: ownerIdentity.builderId,
        creationPolicy: {
          id: grant.id,
          revision: grant.revision,
          elementId: grant.elementId,
        },
      });
      // Match the creation host's normal local mandate counter update too;
      // unchanged ancestor rights must not depend on its scalar spelling.
      const counters:
        import("../../src/domain/model/editing/host-edit.ts").HostEditRequest[] =
          bumpMandate
            ? [{
              op: "setFeatureValue",
              target: {
                qualifiedName: `${ownerScope}::builderMandate::version`,
              },
              value: "2",
            }, {
              op: "setFeatureValue",
              target: { qualifiedName: `${ownerScope}::builderMandate::id` },
              value: "builder-v2",
            }]
            : [];
      const prepared = await applyEdits(tooling, revision, [
        ...counters,
        ...write.requests,
      ], { compile });
      revision = await compile(prepared.sources);
      return await validateSourceExecutable(
        revision,
        projectId,
        write.systemQualifiedName,
      );
    };
    const first = await create("first-sibling", {
      kind: "request-team-member",
      instruction: "Contribute one result.",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
      creationGrant: {
        networkHosts: [],
        maxChildren: 1,
        maxDelegationDepth: 0,
      },
    });
    const firstScope = first.identity.systemQualifiedName!;
    const ownerBefore = await validateSourceExecutable(
      revision,
      projectId,
      ownerScope,
    );
    assert.equal(ownerBefore.operatorCreationPolicies![0]!.children.length, 1);
    await create("second-sibling", {
      kind: "request-team-member",
      instruction: "Contribute another result.",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    }, true);
    const retained = await validateSourceExecutable(
      revision,
      projectId,
      firstScope,
    );
    const ownerAfter = await validateSourceExecutable(
      revision,
      projectId,
      ownerScope,
    );
    assert.equal(ownerAfter.operatorCreationPolicies![0]!.children.length, 2);
    assert.notEqual(ownerAfter.version.digest, ownerBefore.version.digest);
    assert.equal(retained.version.digest, first.version.digest);
    assert.deepEqual(
      retained.operatorCreationPolicies,
      first.operatorCreationPolicies,
    );
    const leaf: TeamOperatorSpec = {
      kind: "request-team-member",
      instruction: "A separately granted leaf.",
      provision: {
        budget: { maxAgentDecisions: 1, maxToolProposals: 0, maxFlowSteps: 1 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    };
    assert.doesNotThrow(() =>
      assertCreationWithinPolicy(
        retained,
        leaf,
        undefined,
        mainCreationScope(retained.identity),
      )
    );
    const policy = ownerAfter.operatorCreationPolicies![0]!;
    const declaration = new RegExp(
      `(attribute :>> id = "${policy.id}";\\s*attribute :>> revision = 1;\\s*attribute :>> enabled = )true;`,
    );
    const revokedSources = {
      ...revision.sources,
      "configuration.sysml": revision.sources["configuration.sysml"]!.replace(
        declaration,
        "$1false;",
      ),
    };
    assert.notEqual(
      revokedSources["configuration.sysml"],
      revision.sources["configuration.sysml"],
    );
    const revoked = await validateSourceExecutable(
      await compile(revokedSources),
      projectId,
      firstScope,
    );
    assert.notEqual(revoked.version.digest, retained.version.digest);
    assert.equal(revoked.operatorCreationPolicies![0]!.enabled, false);
    assert.throws(() =>
      assertCreationWithinPolicy(
        revoked,
        leaf,
        undefined,
        mainCreationScope(revoked.identity),
      )
    );
  },
});
