/** Scripted agents; real source admission, Git, Toolkit, workspace and PostgreSQL. */
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { postgresTestEnabled } from "../support/postgres.ts";
import { primaryInformationPort } from "../../src/composition/primary-information.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import {
  loadInitialSources,
} from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import type { PostgresSystemStateStore } from "../../src/adapters/out/postgres/system-state-store.ts";
import type { PostgresWorkBudgetStore } from "../../src/adapters/out/postgres/budget-store.ts";
import type { PostgresCaseNumberAllocator } from "../../src/adapters/out/postgres/case-number-allocator.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { createConversationsHandler } from "../../src/adapters/in/http/work/conversations.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type {
  ChatContext,
  ChatDecision,
  ChatDecisionBatch,
} from "../../src/domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import { budgetState } from "../../src/domain/work/policies/budget.ts";
import { caseExecutionContext } from "../../src/application/work/cases/runtime.ts";

Deno.test({
  name:
    "Main approves one Request owner; native grants compose two team generations in the same Request and budget",
  ignore: !toolkitIntegrationEnabled || !postgresTestEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-request-team-workspace-",
    });
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    let store: PostgresSystemStateStore | undefined;
    let budgetStore: PostgresWorkBudgetStore | undefined;
    let caseNumbers: PostgresCaseNumberAllocator | undefined;
    let postgres:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
      | undefined;
    try {
      postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        sources: await loadInitialSources(undefined, { information: false }),
      });
      let repository = postgres.repository;
      let tooling = postgres.backend.tooling;
      let model = postgres.backend.model;
      const contexts: ChatContext[] = [];
      const steps = new Map<string, number>();
      const mainDecisions: ChatDecision[] = [];
      const teamInput =
        "Contribute to the originating Request through your admitted inbox.";
      const leafInput =
        "Provide the exact leaf contribution to this same Request.";
      let mainId = "";
      let secondRequest = false;
      const teamBatches = new Map<string, {
        digest: string;
        response: ChatDecisionBatch;
        observed: boolean;
      }>();
      let responseNumber = 0;
      const scriptedDecision = (
        context: ChatContext,
      ): Promise<ChatDecision> => {
        contexts.push(structuredClone(context));
        const actor = context.operator!.nativeId;
        if (actor === mainId) {
          assert.equal(
            context.case,
            undefined,
            "Main stays in its designer conversation",
          );
          const next = mainDecisions.shift();
          assert(next, "Unexpected Main invocation");
          return Promise.resolve(next);
        }
        assert(
          context.case,
          "Every contribution carries the originating Request",
        );
        assert.equal(
          context.workBudget!.scopeId,
          context.case.budget!.scopeId,
        );
        assert.equal(context.workBudget!.limit, 30);
        const step = steps.get(actor) ?? 0;
        steps.set(actor, step + 1);
        const name = context.operator!.name;
        if (secondRequest) {
          assert.equal(name, "Request owner");
          assert.equal(
            context.modeledBehaviors?.length ?? 0,
            0,
            "Old team exposure is hidden from another Request on the same owner",
          );
          return Promise.resolve({
            kind: "reply",
            text: "Independent second Request received.",
          });
        }
        if (
          name === "Request owner" && step === 0 ||
          name === "Team researcher" && step === 0
        ) {
          const child = name === "Request owner";
          const policy = context.operatorCreation!.policies.find((item) =>
            item.holderNativeId === actor
          )!;
          assert(policy, "Creation is supplied by an admitted native grant");
          assert.equal(policy.maxChildren, child ? 2 : 1);
          assert.equal(policy.maxDelegationDepth, child ? 1 : 0);
          return Promise.resolve({
            kind: "propose_agent_creation",
            text: child ? "Compose a researcher." : "Compose a citation leaf.",
            reason:
              "Contribute within the explicit bounded native creation grant.",
            role: "operator",
            name: child ? "Team researcher" : "Citation leaf",
            operator: {
              kind: "request-team-member",
              instruction: "Contribute to the same originating Request.",
              // The researcher chains creation, invocation and answer in
              // one turn: provision the creator's admitted budget the old
              // silent copy supplied (7 decisions, 128 flow steps).
              provision: {
                budget: {
                  maxAgentDecisions: 7,
                  maxToolProposals: 2,
                  maxFlowSteps: 128,
                },
                networkHosts: [],
                mayPropose: [],
                mayInvokeActiveCatalog: false,
              },
              ...(child
                ? {
                  creationGrant: {
                    networkHosts: [],
                    maxChildren: 1,
                    maxDelegationDepth: 0,
                  },
                }
                : {}),
            },
          });
        }
        if (
          (name === "Request owner" || name === "Team researcher") &&
          step === 1
        ) {
          const behaviors = context.modeledBehaviors ?? [];
          assert.equal(
            behaviors.length,
            1,
            `The actual newly admitted child inbox is callable: ${
              JSON.stringify({
                actor: name,
                version: context.modelVersion,
                caseId: context.case?.id,
                registered: workspace?.runtimeFor(actor)?.runtime.snapshot
                  .executionModel?.behaviors,
                invocation: workspace?.runtimeFor(actor)?.runtime.snapshot
                  .caseInvocation,
                recentMessages: context.messages.slice(-4),
              })
            }`,
          );
          const behavior = behaviors[0]!;
          assert.equal(behavior.callerNativeId, actor);
          assert(behavior.sourceIds.length > 0);
          return Promise.resolve({
            kind: "invoke_behavior",
            text: "Invoke the source-admitted team inbox.",
            behaviorId: behavior.id,
            inputJson: JSON.stringify({
              text: name === "Request owner" ? teamInput : leafInput,
            }),
          });
        }
        if (name !== "Citation leaf" && step === 2) {
          // The teammate's inbox accepted the work; its result arrives later.
          return Promise.resolve({
            kind: "reply",
            text: `${name}: waiting for the teammate.`,
          });
        }
        assert(
          name === "Citation leaf" && step === 0 || step === 3,
          `Unexpected ${name} step ${step}`,
        );
        if (step === 3) {
          // The teammate's single completion wakes its creator once.
          assert(
            context.messages.some((message) =>
              message.text.startsWith("Correlated contribution completion") &&
              message.text.includes("completed contribution")
            ),
            `${name} decides after its teammate's completed contribution`,
          );
        }
        return Promise.resolve({
          kind: "reply",
          text: `${name}: completed contribution.`,
        });
      };
      const agents: AgentPort = {
        label: "scripted-native-request-team-workspace-batches",
        decide() {
          throw new Error("The normal correlated decideBatch path is required");
        },
        async decideBatch(context) {
          const actor = context.operator!.nativeId;
          const prior = teamBatches.get(actor);
          if (prior && !prior.observed) {
            const history = context.toolCallHistory!;
            assert.equal(history.length, 1);
            assert.deepEqual(
              history[0]!.assistantBlocks,
              prior.response.assistantBlocks,
            );
            assert.deepEqual(
              history[0]!.results.map((result) => result.id),
              prior.response.calls.map((call) => call.id),
            );
            assert.deepEqual(
              history[0]!.results.map((entry) => {
                const result = JSON.parse(entry.result);
                return {
                  status: result.status,
                  code: result.code,
                  isError: entry.isError === true,
                };
              }),
              [
                {
                  status: "succeeded",
                  code: "PROPOSAL_RECORDED",
                  isError: false,
                },
                {
                  status: "cancelled",
                  code: "BATCH_REPLAN_REQUIRED",
                  isError: true,
                },
                {
                  status: "cancelled",
                  code: "BATCH_REPLAN_REQUIRED",
                  isError: true,
                },
              ],
            );
            assert.notEqual(
              context.modelVersion!.digest,
              prior.digest,
              "Replanning receives the newly admitted native digest",
            );
            assert.equal(
              context.admittedModelVersion!.digest,
              context.modelVersion!.digest,
            );
            const recorded = workspace!.runtimeFor(actor)!.runtime.snapshot
              .conversationBatches!.find((batch) =>
                batch.calls[0]!.id === prior.response.calls[0]!.id
              )!;
            assert.equal(
              recorded.modelDigest,
              prior.digest,
              "The original batch is never rebased onto new rights",
            );
            assert.deepEqual(recorded.calls.map((call) => call.status), [
              "completed",
              "cancelled",
              "cancelled",
            ]);
            assert.equal(
              context.configuration!.changes.filter((change) =>
                change.kind === "operator-creation"
              ).length,
              1,
              "Only the first creation was proposed",
            );
            assert(
              context.messages.every((message) =>
                !message.text.includes("STALE_FINAL_REPLY")
              ),
            );
            prior.observed = true;
          }
          const decision = await scriptedDecision(context);
          const decisions: ChatDecision[] = [decision];
          if (
            decision.kind === "propose_agent_creation" &&
            decision.role === "operator" && "kind" in decision.operator &&
            decision.operator.kind === "request-team-member"
          ) {
            decisions.push({
              ...structuredClone(decision),
              name: "Stale unexpected teammate",
              text: "STALE_SOURCE_EFFECT must never be attempted.",
            }, {
              kind: "reply",
              text: "STALE_FINAL_REPLY must never be delivered.",
            });
          }
          const sequence = ++responseNumber;
          const calls = decisions.map((item, index) => ({
            id: `provider-${sequence}-call-${index + 1}`,
            decision: item,
          }));
          const response: ChatDecisionBatch = {
            calls,
            assistantBlocks: calls.map((call) => ({
              type: "tool_use",
              id: call.id,
              name: call.decision.kind,
              input: structuredClone(call.decision),
            })),
          };
          if (decisions.length === 3) {
            teamBatches.set(actor, {
              digest: context.modelVersion!.digest,
              response: structuredClone(response),
              observed: false,
            });
          }
          return response;
        },
        review() {
          throw new Error("No tool candidate in the Request team flow");
        },
      };
      store = postgres.primary.state;
      const executors: BehaviorInvocationPort[] = [];
      caseNumbers = postgres.workspacePorts.caseNumbers;
      budgetStore = postgres.primary.budget;
      let workBudget = new WorkBudgetService(budgetStore);
      let primary = new SystemRuntime({
        ...postgres.runtimePorts,
        model,
        store,
        agents,
        caseNumbers,
        workBudget,
        runner: new DenoToolRunner(),
        behaviors: new BehaviorInvocationRegistry(executors),
        // Main is created before its workspace, as in the composition root.
        information: primaryInformationPort(() => workspace?.information),
      });
      await primary.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      mainId = primary.snapshot.executionModel!.identity.builderId;
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
      let conversations = workspace.conversations;
      let handler = createConversationsHandler(
        conversations,
        "http://localhost:4321",
      );
      const approve = async (change: PendingChange) => {
        const response = await handler(
          new Request(
            `http://localhost:4321/api/conversations/${
              encodeURIComponent(mainId)
            }/changes/${change.id}/decision`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                host: "localhost:4321",
                origin: "http://localhost:4321",
              },
              body: JSON.stringify({
                expectedRevision: primary.snapshot.revision,
                configurationRevision: change.baseRevision,
                verdict: "approve",
              }),
            },
          ),
        );
        assert(response);
        assert.equal(response.status, 202, await response.text());
        await conversations.idle();
        await postgres!.idle();
      };
      const speak = async (text: string) => {
        await conversations.submitHuman({
          agentId: mainId,
          expectedRevision: primary.snapshot.revision,
          text,
        });
        await postgres!.idle(primary);
        assert.equal(primary.snapshot.error, undefined);
      };
      mainDecisions.push({
        kind: "propose_mandate_change",
        text: "Request bounded editing.",
        reason: "Compose the approved Request owner.",
        requestedRights: {
          grantModelEditing: {
            file: "configuration.sysml",
            root: "AssemblyLiveBuilder::liveBuilder::catalog",
            operations: ["insert-member"],
          },
        },
      }, { kind: "reply", text: "Editing granted." });
      await speak(
        "Request bounded source editing for the initial composition.",
      );
      await approve(primary.snapshot.configuration!.changes.at(-1)!);
      mainDecisions.push({
        kind: "propose_agent_creation",
        text: "Propose one Request owner.",
        reason: "Open one Request whose owner composes a bounded team.",
        role: "operator",
        name: "Request owner",
        operator: {
          instruction:
            "Compose a bounded team, collect its contributions and answer the originating Request.",
          networkHosts: [],
          requestType: { name: "Team research request", maxInvocations: 30 },
          firstRequest: {
            objective:
              "Collect the two-generation team contribution within this one Request.",
          },
          creationGrant: {
            networkHosts: [],
            maxChildren: 2,
            maxDelegationDepth: 1,
          },
        },
      }, { kind: "reply", text: "The approved Request is open." });
      await speak("Propose the Request owner and its explicit creation grant.");
      const proposal = primary.snapshot.configuration!.changes.at(-1)!;
      assert.equal(proposal.kind, "operator-creation");
      assert(proposal.designerScopeId);
      assert.equal(proposal.caseId, undefined);
      assert(proposal.diff!.patch.includes("creationPolicy"));
      assert.equal(
        conversations.snapshot.conversations.length,
        1,
        "No operator activates before exact approval",
      );
      await approve(proposal);
      assert.equal(primary.snapshot.error, undefined);
      const byName = (name: string) => {
        const view = conversations.snapshot.conversations.find((entry) =>
          entry.name === name
        );
        assert(view, `Missing ${name}`);
        return workspace!.runtimeFor(view.agentId)!.runtime;
      };
      let owner = byName("Request owner"),
        child = byName("Team researcher"),
        leaf = byName("Citation leaf");
      for (const runtime of [owner, child, leaf]) {
        assert.equal(runtime.snapshot.error, undefined);
      }
      const root = owner.cases.cases[0]!;
      assert(root);
      assert.equal(root.firstRequestDispatched, true);
      assert.equal(owner.cases.cases.length, 1);
      assert.equal(primary.cases.cases.length, 0);
      assert.equal(child.cases.cases.length, 0);
      assert.equal(leaf.cases.cases.length, 0);
      const ownerId = owner.snapshot.executionModel!.identity.builderId;
      const childId = child.snapshot.executionModel!.identity.builderId;
      const leafId = leaf.snapshot.executionModel!.identity.builderId;
      assert.equal(
        leaf.snapshot.executionModel!.operatorCreationPolicies?.filter((
          policy,
        ) => policy.holderNativeId === leafId).length ?? 0,
        0,
      );
      for (
        const [runtime, parentId] of [[child, ownerId], [
          leaf,
          childId,
        ]] as const
      ) {
        assert.deepEqual(runtime.snapshot.executionModel!.operatorTeam, {
          parentOperatorId: parentId,
          requestOwnerId: ownerId,
          requestId: root.id,
          creationPolicyId:
            (runtime === child ? owner : child).snapshot.executionModel!
              .operatorCreationPolicies!.find((policy) =>
                policy.holderNativeId === parentId
              )!.id,
        });
        assert(
          runtime.snapshot.executionModel!.operatorEntries!.some((entry) =>
            entry.kind === "inbox"
          ),
        );
        const incoming = runtime.snapshot.messages.filter((message) =>
          message.work
        );
        assert.equal(incoming.length, 1);
        assert.equal(incoming[0]!.work!.callerId, parentId);
        assert.equal(incoming[0]!.caseId, root.id);
        assert(
          runtime.snapshot.messages.some((message) =>
            message.text.includes("completed contribution")
          ),
        );
      }
      const receipts = [];
      for (const runtime of [owner, child]) {
        const change = runtime.snapshot.configuration!.changes.find((item) =>
          item.kind === "operator-creation"
        )!;
        assert.equal(change.status, "approved");
        const actorId = runtime.snapshot.executionModel!.identity.builderId;
        assert.equal(change.requestedBy, actorId);
        assert.equal(
          change.authorityExercise!.creationDelegation!.actorId,
          actorId,
        );
        assert.deepEqual(change.teamOrigin, {
          operatorId: ownerId,
          requestId: root.id,
        });
        const publication = await workspace.runtimeFor(actorId)!.model
          .findApprovedChange!(
            runtime.snapshot.model!,
            change.id,
          );
        assert(publication?.receipt);
        assert.equal(
          publication.receipt.authorityExercise.creationDelegation!.actorId,
          actorId,
        );
        receipts.push(change.id);
      }
      assert.equal(new Set(receipts).size, 2);
      const delegated = contexts.filter((context) =>
        [ownerId, childId, leafId].includes(context.operator!.nativeId)
      );
      assert.equal(teamBatches.size, 2);
      assert([...teamBatches.values()].every((batch) => batch.observed));
      // Creators: create, invoke, wait, answer after the completion; leaf: answer.
      assert.equal(delegated.length, 9);
      assert.equal(
        new Set(delegated.map((context) => context.case!.id)).size,
        1,
      );
      assert.equal(
        new Set(delegated.map((context) => context.workBudget!.scopeId)).size,
        1,
      );
      assert(delegated.every((context) => context.case!.owner === ownerId));
      const budget = (await budgetStore.load(root.budget!.scopeId))!;
      assert.equal(budget.ownerId, ownerId);
      assert.equal(budgetState(budget).view.consumed, 9);
      assert.equal(budgetState(budget).view.limit, 30);
      assert.equal(budgetState(budget).view.reserved, 0);
      const originalContext = caseExecutionContext(owner.snapshot)!;
      const incoming = child.snapshot.messages.find((message) => message.work)!;
      const exposure = owner.snapshot.executionModel!.behaviors!.find((entry) =>
        entry.id === incoming.work!.behaviorId
      )!;
      const proof = {
        callerId: ownerId,
        behavior: exposure,
        modelVersion: incoming.work!.modelVersion,
        invocationId: incoming.work!.invocationId,
        caseId: root.id,
        caseContext: originalContext,
      };
      // Reopen the normal workspace from Main's older pin and durable local pins.
      // The two descendants must be recovered without adopting repository HEAD.
      const primaryPin = structuredClone(
        primary.snapshot.executionModel!.version,
      );
      const ownerPin = structuredClone(owner.snapshot.executionModel!.version);
      const childPin = structuredClone(child.snapshot.executionModel!.version);
      const leafPin = structuredClone(leaf.snapshot.executionModel!.version);
      const callsBeforeRestart = contexts.length;
      const database = postgres.database;
      await postgres.close({ retainDatabase: true });
      workspace = undefined;
      postgres = await openPostgresRuntimeFixture({
        dataDir: directory,
        database,
      });
      model = postgres.backend.model;
      repository = postgres.repository;
      tooling = postgres.backend.tooling;
      store = postgres.primary.state;
      budgetStore = postgres.primary.budget;
      caseNumbers = postgres.workspacePorts.caseNumbers;
      workBudget = new WorkBudgetService(budgetStore);
      executors.length = 0;
      primary = new SystemRuntime({
        ...postgres.runtimePorts,
        model,
        store,
        agents,
        caseNumbers,
        workBudget,
        runner: new DenoToolRunner(),
        behaviors: new BehaviorInvocationRegistry(executors),
        // Main is created before its workspace, as in the composition root.
        information: primaryInformationPort(() => workspace?.information),
      });
      await primary.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
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
      conversations = workspace.conversations;
      handler = createConversationsHandler(
        conversations,
        "http://localhost:4321",
      );
      await conversations.idle();
      await postgres!.idle();
      owner = byName("Request owner");
      child = byName("Team researcher");
      leaf = byName("Citation leaf");
      assert.equal(
        contexts.length,
        callsBeforeRestart,
        "Restart preserves completed effects",
      );
      assert.deepEqual(primary.snapshot.executionModel!.version, primaryPin);
      assert.deepEqual(owner.snapshot.executionModel!.version, ownerPin);
      assert.deepEqual(child.snapshot.executionModel!.version, childPin);
      assert.deepEqual(leaf.snapshot.executionModel!.version, leafPin);
      for (const [actor, prior] of teamBatches) {
        const runtime: SystemRuntime = workspace.runtimeFor(actor)!.runtime;
        const recorded = runtime.snapshot.conversationBatches!.find((batch) =>
          batch.calls[0]!.id === prior.response.calls[0]!.id
        )!;
        assert.equal(recorded.modelDigest, prior.digest);
        assert.deepEqual(
          recorded.assistantBlocks,
          prior.response.assistantBlocks,
        );
        assert.deepEqual(
          recorded.calls.map((call) => ({
            id: call.id,
            status: call.status,
            code: call.result!.code,
          })),
          [
            {
              id: prior.response.calls[0]!.id,
              status: "completed",
              code: "PROPOSAL_RECORDED",
            },
            {
              id: prior.response.calls[1]!.id,
              status: "cancelled",
              code: "BATCH_REPLAN_REQUIRED",
            },
            {
              id: prior.response.calls[2]!.id,
              status: "cancelled",
              code: "BATCH_REPLAN_REQUIRED",
            },
          ],
        );
        assert(
          runtime.snapshot.messages.every((message) =>
            !message.text.includes("STALE_FINAL_REPLY") &&
            !message.text.includes("STALE_SOURCE_EFFECT")
          ),
        );
      }
      assert.equal(
        budgetState((await budgetStore.load(root.budget!.scopeId))!).view
          .consumed,
        9,
      );
      const head = (await repository.current()).version;
      const beforeReplayCalls = contexts.length;
      await approve(
        primary.snapshot.configuration!.changes.find((change) =>
          change.id === proposal.id
        )!,
      );
      await conversations.submitWork(
        childId,
        teamInput,
        incoming.work!.correlationId,
        proof,
      );
      assert.equal(
        contexts.length,
        beforeReplayCalls,
        "Replaying approval and acquired work has no repeated agent effect",
      );
      assert.equal((await repository.current()).version, head);
      assert.equal(owner.cases.cases.length, 1);
      assert.equal(conversations.snapshot.conversations.length, 4);
      secondRequest = true;
      // Main no longer opens a Request in main (4.8d D3): the second Request
      // is an explicit host fixture on the existing owner.
      await owner.openOperatorRequest({
        changeId: "second-request",
        caseTypeId: root.caseTypeId!,
        objective: "Independent second Request.",
        openedBy: mainId,
        openedFrom: {
          conversationId: primary.snapshot.id,
          designerScopeId: proposal.designerScopeId!,
        },
      });
      await conversations.idle();
      await postgres!.idle();
      assert.equal(owner.snapshot.error, undefined);
      assert.equal(owner.cases.cases.length, 2);
      const second = caseExecutionContext(owner.snapshot)!;
      assert.notEqual(second.caseId, root.id);
      await assert.rejects(
        () =>
          conversations.submitWork(
            childId,
            "Do not reuse the old team on a new Request.",
            "cross-request-attempt",
            {
              ...proof,
              invocationId: "cross-request-invocation",
              caseId: second.caseId,
              caseContext: second,
            },
          ),
        (error: unknown) =>
          error instanceof Error && "code" in error &&
          error.code === "WORK_CASE_MISMATCH",
      );
      assert.equal(child.cases.cases.length, 0);
      assert.equal(leaf.cases.cases.length, 0);
      assert.equal((await repository.current()).version, head);
    } finally {
      await postgres?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});
