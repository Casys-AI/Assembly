/** Real Git/Toolkit/Case qualification through the production SourceModel. */
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import type { SystemRuntime as Runtime } from "../../src/application/work/runtime/system.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { type SourceRevision } from "../../src/domain/model/records/source-revision.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";
import type { ModelIdentity } from "../../src/domain/shared-kernel/model-identity.ts";
import type {
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";
import type { OperatorAuthorityPolicyRequest } from "../../src/domain/governance/policies/operator-authority-policy.ts";
import { compileOperatorAuthorityPolicies } from "../../src/adapters/out/sysml-toolkit/compilation-policies/governance/authority/operator/policy.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../src/domain/model/projections/source-facts.ts";
import { OperatorAuthorityError } from "../../src/domain/governance/operator-authority.ts";
import { AuthorityInvariantError } from "../../src/domain/governance/authority.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import {
  changePublication,
  ChangePublicationError,
} from "../../src/domain/model/publication/change.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";

/** Corrupt only native facts already produced by the real Toolkit. */
function assertCorruptedPolicyRejected(
  revision: SourceRevision,
  identity: ModelIdentity,
  duplicateRevision = false,
) {
  const snapshot = sourceSnapshot(revision.elements, identity.rootId);
  const literals = sourceLiterals(revision.elements);
  const policies = compileOperatorAuthorityPolicies(
    snapshot,
    literals,
    identity,
  );
  const policy = policies.find((p) => p.id === "research-network")!;
  assert(policy);
  const definition = snapshot.elements.find((e) =>
    e.qualifiedName === "AssemblyAuthority::OperatorAuthorityPolicy"
  )!;
  const rejected = (run: () => unknown) =>
    assert.throws(
      run,
      (error) =>
        error instanceof OperatorAuthorityError ||
        error instanceof AuthorityInvariantError,
    );
  for (const field of ["holder", "issuer"]) {
    const feature = snapshot.elements.find((e) =>
      e.ownerId === definition.id && e.name === field
    )!;
    const corrupted = structuredClone(snapshot);
    const before = corrupted.connectors.length;
    corrupted.connectors = corrupted.connectors.filter((c) =>
      !c.ends.some((end) =>
        end.chain.length === 2 && end.chain[0]!.id === policy.elementId &&
        end.chain[1]!.id === feature.id
      )
    );
    assert.equal(corrupted.connectors.length, before - 1);
    rejected(() =>
      compileOperatorAuthorityPolicies(corrupted, literals, identity)
    );
  }
  const wildcard = structuredClone(literals);
  wildcard.find((l) =>
    l.owner === policy.elementId && l.name === "networkHosts"
  )!.value = '["*.example.org"]';
  rejected(() =>
    compileOperatorAuthorityPolicies(snapshot, wildcard, identity)
  );
  if (duplicateRevision) {
    const duplicated = structuredClone(literals);
    duplicated.find((l) =>
      l.owner === policy.elementId && l.name === "revision"
    )!.value = "1";
    rejected(() =>
      compileOperatorAuthorityPolicies(snapshot, duplicated, identity)
    );
  }
}

Deno.test({
  name:
    "Case operator policy: human grant, delegated exact hosts, bounded refusal and revocation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-operator-policy-",
    });
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    let postgres:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
      | undefined;
    try {
      postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        sources: await loadInitialSources(undefined, { information: false }),
      });
      const projectId = postgres.backend.projectId;
      const repository = postgres.repository;
      const tooling = postgres.backend.tooling;
      const model = postgres.backend.model;
      const contexts: ChatContext[] = [];
      const queues = new Map<string, ChatDecision[]>();
      const agents: AgentPort = {
        label: "scripted-operator-policy",
        decide(context) {
          contexts.push(structuredClone(context));
          const actor = context.case!.owner;
          return Promise.resolve(
            queues.get(actor)?.shift() ??
              { kind: "reply", text: "Waiting for the next exact request." },
          );
        },
        review() {
          throw new Error("No review invocation");
        },
      };
      const store = postgres.primary.state;
      const executors: BehaviorInvocationPort[] = [];
      const caseNumbers = postgres.workspacePorts.caseNumbers;
      const workBudget = new WorkBudgetService(postgres.primary.budget);
      const primary = new SystemRuntime({
        ...postgres.runtimePorts,
        model,
        store,
        agents,
        caseNumbers,
        workBudget,
        runner: {
          test() {
            throw new Error("No tool test");
          },
          run() {
            throw new Error("No network invocation");
          },
        },
        behaviors: new BehaviorInvocationRegistry(executors),
      });
      await primary.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      const primaryId = primary.snapshot.executionModel!.identity.builderId;
      workspace = await openOperatorWorkspace({
        ...postgres.workspacePorts,
        createSourceModel: postgres.backend.createSourceModel,
        primaryHistory: store,
        primary,
        primaryModel: model,
        repository,
        tooling,
        agents,
        directory,
        executors,
        caseNumbers,
        workBudget,
      });
      await postgres.start(workspace);
      const conversations = workspace.conversations;
      const submitPrimary = async (decision: ChatDecision, caseId?: string) => {
        queues.set(primaryId, [decision]);
        const id = await conversations.submitHuman({
          agentId: primaryId,
          expectedRevision: primary.snapshot.revision,
          text: decision.text,
          ...(caseId ? { caseId } : { newConversation: true }),
        });
        await postgres!.idle(primary);
        assert.equal(primary.snapshot.error, undefined);
        return id!;
      };
      const approve = async (
        runtime: Runtime,
        change: PendingChange,
      ) => {
        await runtime.decideChange({
          changeId: change.id,
          expectedRevision: change.baseRevision,
          verdict: "approve",
        });
        await postgres!.idle(runtime);
        assert.equal(runtime.snapshot.error, undefined);
      };
      const parentId = await submitPrimary({
        kind: "propose_agent_creation",
        text: "Create Research",
        reason: "Process bounded requests",
        role: "operator",
        name: "Research",
        operator: {
          instruction: "Request exact network hosts.",
          networkHosts: [],
          requestType: { name: "Research request", maxInvocations: 20 },
          firstRequest: { objective: "Wait for a bounded network request." },
        },
      });
      await approve(primary, primary.snapshot.configuration!.changes.at(-1)!);
      const peerView = conversations.snapshot.conversations.find((entry) =>
        entry.agentId !== primaryId
      )!;
      assert(peerView);
      const peerEntry = workspace.runtimeFor(peerView.agentId)!;
      const peer = peerEntry.runtime;
      const childId = peer.cases.cases[0]!.id;
      const policy: OperatorAuthorityPolicyRequest = {
        policyId: "research-network",
        expectedPolicyRevision: 0,
        enabled: true,
        recipients: [peerView.nativeId],
        acts: ["addNetworkHosts"],
        networkHosts: ["example.org", "example.net"],
        toolIds: [],
        maxDelegationDepth: 0,
      };
      await submitPrimary({
        kind: "propose_mandate_change",
        text: "Grant bounded authority",
        reason: "Only Research and two exact hosts",
        requestedRights: { operatorAuthority: policy },
      }, parentId);
      const proposedPolicy = primary.snapshot.configuration!.changes.at(-1)!;
      assert.equal(proposedPolicy.caseId, parentId);
      const policyDiff = proposedPolicy.diff;
      assert(policyDiff);
      assert(policyDiff.patch.includes("OperatorAuthorityPolicy"));
      const beforePolicy = primary.snapshot.executionModel!;
      assert.equal(
        policyDiff.base.repositoryVersion,
        (await repository.current()).version,
      );
      const approval = SystemGovernance.fromExecutable(
        beforePolicy,
        [proposedPolicy],
      ).decideChange(
        proposedPolicy.id,
        proposedPolicy.baseRevision,
        true,
        "2026-10-25T00:00:00.000Z",
      );
      const missingDiff = { ...approval };
      delete missingDiff.diff;
      const missingReceipt = { ...approval };
      delete missingReceipt.authorityExercise;
      const invalidApprovals: Array<[PendingChange, string]> = [
        [
          missingDiff,
          "Operator policy approval requires the displayed source diff",
        ],
        [
          missingReceipt,
          "Mandate approval must exercise the owner authority of the prior model",
        ],
        [
          {
            ...approval,
            authorityExercise: {
              ...approval.authorityExercise!,
              operatorNativeId: "foreign-owner",
            },
          },
          "Mandate approval must exercise the owner authority of the prior model",
        ],
        [
          { ...approval, authority: "builder" },
          "The delegated receipt does not match the exact change",
        ],
      ];
      const beforeInvalidApprovals = (await repository.current()).version;
      for (const [invalid, expectedMessage] of invalidApprovals) {
        await assert.rejects(
          () =>
            model.applyApprovedChange(
              beforePolicy.identity,
              invalid,
              beforePolicy.version.digest,
              changePublication(
                invalid.authorityExercise ? invalid : approval,
                beforePolicy.version,
              ),
            ),
          (error) =>
            error instanceof ChangePublicationError &&
            error.code === "PUBLICATION_NOT_APPLICABLE" &&
            error.message === expectedMessage,
        );
        assert.equal(
          (await repository.current()).version,
          beforeInvalidApprovals,
        );
      }
      await approve(primary, proposedPolicy);
      const publishedPolicy = await repository.findPublication(
        proposedPolicy.id,
      );
      assert(publishedPolicy?.receipt);
      assert.notEqual(publishedPolicy.receipt.type, "candidate-activation");
      const receipt = publishedPolicy.receipt;
      assert(receipt.type !== "candidate-activation");
      assert.equal(receipt.authorityExercise.action, "mandate-change");
      assert.equal(
        receipt.authorityExercise.baseModelDigest,
        beforePolicy.version.digest,
      );
      assert.equal(receipt.authorityExercise.delegation, undefined);
      assert.equal(receipt.proposal?.caseId, parentId);
      assert.deepEqual(receipt.proposal?.requestedRights, {
        operatorAuthority: policy,
      });
      assert.equal(
        receipt.proposal?.sourceDigest,
        policyDiff.sourceDigest,
      );
      assert.equal(
        primary.snapshot.configuration!.revision,
        beforePolicy.configuration.revision + 1,
      );
      assert.equal(
        primary.snapshot.configuration!.builder.mandateRevision,
        beforePolicy.configuration.builder.mandateRevision + 1,
      );
      assert.deepEqual(
        primary.snapshot.executionModel!.configuration.network,
        beforePolicy.configuration.network,
      );
      const approvedPolicy = primary.snapshot.configuration!.changes.find((c) =>
        c.id === proposedPolicy.id
      )!;
      assert.equal(
        approvedPolicy.publishedCommit,
        publishedPolicy.revision.version,
      );
      const replay = await model.applyApprovedChange(
        beforePolicy.identity,
        approvedPolicy,
        beforePolicy.version.digest,
        changePublication(approvedPolicy, beforePolicy.version),
      );
      assert.equal(
        replay.version.repositoryVersion,
        publishedPolicy.revision.version,
      );
      assert.equal(
        (await repository.current()).version,
        publishedPolicy.revision.version,
      );
      const staleApproval = { ...approval, id: crypto.randomUUID() };
      await assert.rejects(
        () =>
          model.applyApprovedChange(
            beforePolicy.identity,
            staleApproval,
            beforePolicy.version.digest,
            changePublication(staleApproval, beforePolicy.version),
          ),
        (error) =>
          error instanceof ChangePublicationError &&
          error.code === "PUBLICATION_NOT_APPLICABLE" &&
          error.message ===
            "Journal operation 0 no longer applies on the current base (INCARNATION_CHANGED).",
      );
      const staleWrite = await postgres.backend.queue.get(
        postgres.backend.writer.repositoryId,
        staleApproval.id,
      );
      assert.equal(staleWrite?.state, "needs-decision");
      assert.equal(staleWrite?.lastError?.code, "REPLAY_BLOCKED");
      assert.equal(
        (await repository.current()).version,
        publishedPolicy.revision.version,
      );
      assertCorruptedPolicyRejected(
        await repository.current(),
        primary.snapshot.model!,
      );
      const syncModels = async () => {
        const head = await repository.current();
        for (const runtime of [primary, peer]) {
          const prospective = await validateSourceExecutable(
            head,
            projectId,
            runtime.snapshot.executionModel!.identity.systemQualifiedName,
          );
          const command = {
            agentId: prospective.identity.builderId,
            expectedDigest: prospective.version.digest,
            expectedVersion: head.version,
          };
          await workspace!.adopt(
            command,
            () => runtime.adoptModelVersion(command),
          );
        }
      };
      await syncModels();
      assert.equal(
        peer.snapshot.executionModel!.operatorAuthorityPolicies?.[0]?.revision,
        1,
      );
      const requestHost = async (host: string) => {
        queues.set(peerView.agentId, [{
          kind: "propose_mandate_change",
          text: `Read ${host}`,
          reason: "Exact Request scope",
          requestedRights: { addNetworkHosts: [host] },
        }]);
        await conversations.submitHuman({
          agentId: peerView.agentId,
          expectedRevision: peer.snapshot.revision,
          caseId: childId,
          text: `Request permission for ${host}`,
        });
        await postgres!.idle(peer);
        assert.equal(peer.snapshot.error, undefined);
        return peer.snapshot.configuration!.changes.at(-1)!;
      };
      const decidePeer = async (change: PendingChange, policyRevision = 1) => {
        queues.set(primaryId, [{
          kind: "decide_operator_change",
          text: "Decide the exact registered request",
          operatorId: peerView.agentId,
          changeId: change.id,
          expectedRevision: change.baseRevision,
          policyId: policy.policyId,
          policyRevision,
          verdict: "approve",
        }]);
        await conversations.submitHuman({
          agentId: primaryId,
          expectedRevision: primary.snapshot.revision,
          caseId: parentId,
          text: "Decide Research request",
        });
        await postgres!.idle(primary);
      };
      const allowed = await requestHost("example.org");
      await decidePeer(allowed);
      assert.equal(primary.snapshot.error, undefined);
      const completed = peer.snapshot.configuration!.changes.find((c) =>
        c.id === allowed.id
      )!;
      assert.equal(completed.status, "approved");
      assert.equal(completed.authority, "builder");
      assert.equal(
        completed.authorityExercise!.delegation!.policyId,
        policy.policyId,
      );
      assert.deepEqual(
        peer.snapshot.executionModel!.configuration.network!.allowedHosts,
        ["example.org"],
      );
      assert.equal(
        contexts.findLast((context) => context.case?.owner === primaryId)!.case!
          .id,
        parentId,
      );
      const outside = await requestHost("example.org.attacker.com");
      const beforeDenied = (await repository.current()).version;
      const beforeDeniedSnapshot = peer.snapshot;
      await decidePeer(outside);
      assert.equal(primary.snapshot.error, undefined);
      assert.deepEqual(peer.snapshot, beforeDeniedSnapshot);
      assert.equal(
        peer.snapshot.configuration!.changes.find((c) => c.id === outside.id)!
          .status,
        "pending",
      );
      assert.equal((await repository.current()).version, beforeDenied);
      const escalation = primary.snapshot.messages.find((message) =>
        message.operatorNotice?.kind === "authority-escalation" &&
        message.operatorNotice.changeId === outside.id
      )?.operatorNotice;
      assert(escalation?.kind === "authority-escalation");
      assert.equal(escalation.decisionAuthority, "human");
      // Refuse the out-of-bounds request through explicit human control to free its Case.
      await peer.decideChange({
        changeId: outside.id,
        expectedRevision: outside.baseRevision,
        verdict: "refuse",
      });
      await postgres!.idle(peer);
      await syncModels();
      await submitPrimary({
        kind: "propose_mandate_change",
        text: "Revoke authority",
        reason: "Return all future decisions to the person",
        requestedRights: {
          operatorAuthority: {
            ...policy,
            expectedPolicyRevision: 1,
            enabled: false,
          },
        },
      }, parentId);
      await approve(primary, primary.snapshot.configuration!.changes.at(-1)!);
      assertCorruptedPolicyRejected(
        await repository.current(),
        primary.snapshot.model!,
        true,
      );
      await syncModels();
      const afterRevocation = await requestHost("example.net");
      const beforeRevokedDecision = (await repository.current()).version;
      await decidePeer(afterRevocation, 2);
      assert.equal(primary.snapshot.error, undefined);
      const revokedEscalation = primary.snapshot.messages.findLast((message) =>
        message.operatorNotice?.kind === "authority-escalation" &&
        message.operatorNotice.changeId === afterRevocation.id
      )?.operatorNotice;
      assert(revokedEscalation?.kind === "authority-escalation");
      assert.equal(revokedEscalation.decisionAuthority, "human");
      assert.equal(
        peer.snapshot.configuration!.changes.find((c) =>
          c.id === afterRevocation.id
        )!.status,
        "pending",
      );
      assert.equal((await repository.current()).version, beforeRevokedDecision);
      assert.deepEqual(
        peer.snapshot.executionModel!.configuration.network!.allowedHosts,
        ["example.org"],
      );
    } finally {
      await postgres?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
