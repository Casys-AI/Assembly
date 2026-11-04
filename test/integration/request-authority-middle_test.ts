/** Native source and workspace proof for an explicitly admitted nonprimary holder. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { postgresTestEnabled } from "../support/postgres.ts";
import { primaryInformationPort } from "../../src/composition/primary-information.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import {
  openRequestValueFixture,
  requestValueHost,
} from "../fixtures/request-value-profile.ts";
import { nativeId } from "../fixtures/model-edit-mandate.ts";

import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type { ChatContext } from "../../src/application/work/conversation/chat-context.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { caseTypesForModel } from "../../src/domain/work/records/case-types.ts";
import { designerScopeId } from "../../src/application/work/cases/runtime.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../src/domain/model/projections/source-facts.ts";
import { compileOperatorAuthorityPolicies } from "../../src/adapters/out/sysml-toolkit/compilation-policies/governance/authority/operator/policy.ts";
import { compileToolAdmissionPolicies } from "../../src/adapters/out/sysml-toolkit/compilation-policies/governance/authority/tool-admission-policy.ts";
import { OperatorAuthorityError } from "../../src/domain/governance/operator-authority-error.ts";
import { AuthorityInvariantError } from "../../src/domain/governance/authority.ts";

function networkPolicy(id: string, recipient: string, host: string) {
  return `
    part '${id}' : AssemblyAuthority::OperatorAuthorityPolicy {
      attribute :>> id = "${id}";
      attribute :>> revision = 1;
      attribute :>> enabled = true;
      attribute :>> recipients = ${JSON.stringify(JSON.stringify([recipient]))};
      attribute :>> acts = ${
    JSON.stringify(JSON.stringify(["addNetworkHosts"]))
  };
      attribute :>> networkHosts = ${JSON.stringify(JSON.stringify([host]))};
      attribute :>> toolIds = "[]";
      attribute :>> maxDelegationDepth = 0;
    }
    bind '${id}'.holder = builder;
    bind '${id}'.mandate = builderMandate;
    bind '${id}'.issuer = owner.ownerMandate.rootAuthority;
  `;
}
function admissionPolicy(id: string, recipient: string) {
  return `
    part '${id}' : AssemblyAuthority::ToolAdmissionPolicy {
      attribute :>> id = "${id}";
      attribute :>> revision = 1;
      attribute :>> enabled = true;
      attribute :>> recipients = ${JSON.stringify(JSON.stringify([recipient]))};
      attribute :>> toolKinds = ${
    JSON.stringify(JSON.stringify(["read_web_page"]))
  };
      attribute :>> maxDelegationDepth = 0;
    }
    bind '${id}'.holder = builder;
    bind '${id}'.mandate = builderMandate;
    bind '${id}'.issuer = owner.ownerMandate.rootAuthority;
  `;
}

Deno.test({
  name:
    "nonprimary native holder decides its leaf Request; uncovered scopes reach Main then human",
  ignore: !toolkitIntegrationEnabled || !postgresTestEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "assembly-authority-middle-",
    });
    const sourceEpoch = Deno.env.get("ASSEMBLY_QUALIFICATION_SOURCE_EPOCH");
    const epochManifest = Deno.env.get(
      "ASSEMBLY_QUALIFICATION_SOURCE_EPOCH_FILE",
    );
    console.info(
      "MIDDLE_AUTHORITY_QUALIFICATION " +
        JSON.stringify({ directory, pid: Deno.pid, sourceEpoch }),
    );
    if (epochManifest) {
      await Deno.copyFile(
        epochManifest,
        join(directory, "qualification-source-epoch.json"),
      );
    }
    const f = await openRequestValueFixture(
      Deno.env.get("SYSML_TOOLKIT_DIR")!,
      directory,
    );
    const { postgres } = f;
    const store = postgres.primary.state;
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    try {
      // Explicit owner-authorized fixture source admission, before any runtime work.
      // It confers no policy-authoring right on the nonprimary holder.
      await f.primary.initialize();
      const base = await f.repository.current();
      const leafId = nativeId(
        base,
        "AssemblyLiveBuilder::permissionsOperator::builder",
      );
      const sources = structuredClone(base.sources);
      const middleMarker = "part researchOwner : ConversationSystem {";
      const mainMarker = "part liveBuilder : ConversationSystem {";
      assert.equal(
        sources["configuration.sysml"].split(middleMarker).length,
        2,
      );
      sources["configuration.sysml"] = sources["configuration.sysml"].replace(
        middleMarker,
        middleMarker +
          networkPolicy("middle-network", leafId, "covered.example") +
          admissionPolicy("middle-tools", leafId),
      );
      sources["configuration.sysml"] = sources["configuration.sysml"].replace(
        mainMarker,
        mainMarker + networkPolicy("main-network", leafId, requestValueHost),
      );
      const admitted = await f.repository.publishSystemSources(
        sources,
        base.version,
        "local-owner-intermediate-qualification",
      );
      const middleModel = await validateSourceExecutable(
        admitted,
        f.projectId,
        "AssemblyLiveBuilder::researchOwner",
      );
      const middleId = middleModel.identity.builderId;
      await Deno.writeTextFile(
        join(directory, "native-source-admission.json"),
        JSON.stringify(
          {
            sourceEpoch,
            projectId: f.projectId,
            baseVersion: base.version,
            admittedVersion: admitted.version,
            sourceDigest: admitted.sourceDigest,
            middleId,
            leafId,
          },
          null,
          2,
        ),
      );
      assert.equal(middleModel.operator?.primary, false);
      assert.equal(middleModel.ownerAuthority?.ownerSource, "modeled");
      assert.equal(middleModel.policy.mayProposeSysmlRevision, false);
      const network = middleModel.operatorAuthorityPolicies!.find((p) =>
        p.id === "middle-network"
      )!;
      const admission = middleModel.toolAdmissionPolicies!.find((p) =>
        p.id === "middle-tools"
      )!;
      for (const policy of [network, admission]) {
        assert.equal(policy.holderNativeId, middleId);
        assert.equal(policy.systemId, middleModel.identity.systemId);
        assert.equal(
          policy.mandateNativeId,
          nativeId(
            admitted,
            "AssemblyLiveBuilder::researchOwner::builderMandate",
          ),
        );
        assert.equal(policy.rootAuthority!.ownerSource, "modeled");
        assert.equal(
          policy.rootAuthority!.systemId,
          middleModel.identity.systemId,
        );
        assert.equal(
          policy.rootAuthority!.operatorNativeId,
          nativeId(admitted, "AssemblyLiveBuilder::researchOwner::owner"),
        );
        assert(policy.sourceIds.includes(policy.elementId));
        assert.deepEqual(policy.recipients, [leafId]);
      }
      // Corrupt already obtained native snapshots: no further Toolkit compilations.
      const snapshot = sourceSnapshot(
        admitted.elements,
        middleModel.identity.rootId,
      );
      const literals = sourceLiterals(admitted.elements);
      for (
        const [policy, definitionName, compile] of [
          [
            network,
            "AssemblyAuthority::OperatorAuthorityPolicy",
            compileOperatorAuthorityPolicies,
          ],
          [
            admission,
            "AssemblyAuthority::ToolAdmissionPolicy",
            compileToolAdmissionPolicies,
          ],
        ] as const
      ) {
        const definition = snapshot.elements.find((element) =>
          element.qualifiedName === definitionName
        )!;
        const issuer = snapshot.elements.find((element) =>
          element.ownerId === definition.id && element.name === "issuer"
        )!;
        assert(definition && issuer);
        const corrupted = structuredClone(snapshot);
        const before = corrupted.connectors.length;
        corrupted.connectors = corrupted.connectors.filter((connector) =>
          !connector.ends.some((end) =>
            end.chain.length === 2 && end.chain[0].id === policy.elementId &&
            end.chain[1].id === issuer.id
          )
        );
        assert.equal(corrupted.connectors.length, before - 1);
        assert.throws(
          () => compile(corrupted, literals, middleModel.identity),
          (error) =>
            error instanceof OperatorAuthorityError ||
            error instanceof AuthorityInvariantError,
        );
      }
      const hosts = [
        "covered.example",
        requestValueHost,
        "outside.example",
      ] as const;
      let phase = 0, mainDispatched = false, rootId = "";
      const middleDispatched = new Set<number>(),
        leafProposed = new Set<number>();
      const decisions: Array<{ actorId: string; changeId: string }> = [];
      const contexts: ChatContext[] = [];
      const decided = new Set<string>();
      const agents: AgentPort = {
        label: "scripted-native-intermediate-holder",
        decide(context): Promise<ChatDecision> {
          contexts.push(structuredClone(context));
          const actorId = context.operator!.nativeId;
          if (context.operator!.name === "Main Operator") {
            if (!mainDispatched) {
              mainDispatched = true;
              return Promise.resolve({
                kind: "resume_request",
                text: "Continue the same Request",
                operatorId: middleId,
                caseId: rootId,
                resumeId: `middle-resume-${phase}`,
                instruction: `Run permission phase ${phase}`,
              });
            }
          } else if (actorId === middleId) {
            rootId = context.case!.id;
            assert.equal(
              context.requestOpening,
              undefined,
              "The holder does not acquire Main opening/resume capability",
            );
            if (!middleDispatched.has(phase)) {
              middleDispatched.add(phase);
              const inbox = context.modeledBehaviors!.find((behavior) =>
                behavior.name === "permissions contribution"
              )!;
              assert(inbox);
              return Promise.resolve({
                kind: "invoke_behavior",
                text: "Send one permission contribution",
                behaviorId: inbox.id,
                inputJson: JSON.stringify({
                  text: `Request only ${
                    hosts[phase]
                  } and acknowledge its actual decision; do not prepare or invoke a tool.`,
                }),
              });
            }
          } else if (actorId === leafId) {
            if (!leafProposed.has(phase)) {
              leafProposed.add(phase);
              return Promise.resolve({
                kind: "propose_mandate_change",
                text: "Request the exact host",
                reason: `Native hierarchy phase ${phase}`,
                requestedRights: { addNetworkHosts: [hosts[phase]] },
              });
            }
            assert(
              context.mandate!.network.allowedHosts.includes(hosts[phase]),
              "Only effective host permission may be acknowledged",
            );
            return Promise.resolve({
              kind: "reply",
              text: `Observed effective permission for ${hosts[phase]}`,
            });
          } else throw new Error(`Unexpected operator invocation ${actorId}`);
          const pending = context.operatorAuthority?.requests.find((request) =>
            !decided.has(request.id)
          );
          if (pending) {
            assert.equal(actorId, phase === 0 ? middleId : mainId);
            assert.notEqual(
              phase,
              2,
              "No delegated actor covers the third host",
            );
            decided.add(pending.id);
            decisions.push({ actorId, changeId: pending.id });
            return Promise.resolve({
              kind: "decide_operator_change",
              text: "Explicitly approve this exact native scope",
              operatorId: leafId,
              changeId: pending.id,
              expectedRevision: pending.baseRevision,
              policyId: phase === 0 ? "middle-network" : "main-network",
              policyRevision: 1,
              verdict: "approve",
            });
          }
          return Promise.resolve({
            kind: "reply",
            text: phase === 2
              ? "Waiting for explicit local control"
              : "Contribution observed",
          });
        },
        review() {
          throw new Error(
            "No candidate is prepared or reviewed in this network proof",
          );
        },
      };
      const executors: BehaviorInvocationPort[] = [];
      const workBudget = new WorkBudgetService(postgres.primary.budget);
      const caseNumbers = postgres.workspacePorts.caseNumbers;
      const primary = new SystemRuntime({
        ...postgres.runtimePorts,
        model: f.primary,
        store,
        agents,
        caseNumbers,
        workBudget,
        behaviors: new BehaviorInvocationRegistry(executors),
        // Main is created before its workspace, as in the composition root.
        information: primaryInformationPort(() => workspace?.information),
        runner: {
          run() {
            throw new Error("No network effect expected");
          },
          test() {
            throw new Error("No tool test expected");
          },
        },
      });
      await primary.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      const mainId = primary.snapshot.executionModel!.identity.builderId;
      workspace = await openOperatorWorkspace({
        ...postgres.workspacePorts,
        primary,
        primaryModel: f.primary,
        repository: f.repository,
        tooling: f.tooling,
        directory: f.dataDir,
        createSourceModel: f.createSourceModel,
        agents,
        executors,
        caseNumbers,
        workBudget,
      });
      await postgres.start(workspace);
      const leaf = workspace.runtimeFor(leafId)!.runtime;
      const middle = workspace.runtimeFor(middleId)!.runtime;
      assert.equal(
        middle.snapshot.executionModel!.version.repositoryVersion,
        admitted.version,
      );
      assert.equal(
        leaf.snapshot.executionModel!.version.repositoryVersion,
        admitted.version,
      );
      assert.equal(
        leaf.snapshot.executionModel!.operatorAuthorityPolicies!.find((
          policy,
        ) => policy.id === "middle-network")!.holderNativeId,
        middleId,
      );
      const mainNotices = () =>
        primary.snapshot.messages.filter((message) =>
          message.operatorNotice?.kind === "authority-escalation"
        );
      // Main no longer opens a Request in main (4.8d D3): the holder's root
      // Request is an explicit host fixture opened from Main's conversation.
      const middleRuntimeModel = middle.snapshot.executionModel!;
      rootId = await middle.openOperatorRequest({
        changeId: "middle-root",
        caseTypeId: caseTypesForModel(middleRuntimeModel).find((type) =>
          type.type === "request" &&
          type.ownerId === middleRuntimeModel.identity.builderId
        )!.id,
        objective: "Delegate the bounded permission task",
        openedBy: mainId,
        openedFrom: {
          conversationId: primary.snapshot.id,
          designerScopeId: designerScopeId(primary.snapshot),
        },
      });
      await workspace.conversations.idle();
      await postgres.idle();
      for (phase = 0; phase < hosts.length; phase++) {
        mainDispatched = false;
        const sourceBefore = (await f.repository.current()).version;
        await workspace.conversations.submitHuman({
          agentId: mainId,
          expectedRevision: primary.snapshot.revision,
          text: `Run the already authorized hierarchy phase ${phase}`,
        });
        await workspace.conversations.idle();
        await postgres.idle();
        for (const runtime of [primary, middle, leaf]) {
          assert.equal(runtime.snapshot.error, undefined);
        }
        const change = leaf.snapshot.configuration!.changes.at(-1)!;
        assert.equal(change.requestedBy, leafId);
        assert.equal(change.caseId, rootId);
        const middleNotice = middle.snapshot.messages.findLast((message) =>
          message.operatorNotice?.kind === "authority-escalation" &&
          message.operatorNotice.changeId === change.id
        )!;
        assert.equal(middleNotice.caseId, rootId);
        assert(middleNotice.operatorNotice?.kind === "authority-escalation");
        if (phase === 0) {
          assert.equal(change.status, "approved");
          assert.equal(change.authority, "builder");
          assert.equal(change.authorityExercise!.delegation!.actorId, middleId);
          assert.equal(
            change.authorityExercise!.delegation!.policyId,
            "middle-network",
          );
          assert.equal(change.authorityExercise!.delegation!.policyRevision, 1);
          assert.equal(
            middleNotice.operatorNotice.route!.designatedDecider!.operatorId,
            middleId,
          );
          assert.equal(
            mainNotices().length,
            0,
            "Main receives no authority/human solicitation for a covered middle",
          );
          assert.deepEqual(decisions, [{
            actorId: middleId,
            changeId: change.id,
          }]);
        } else if (phase === 1) {
          assert.equal(change.status, "approved");
          assert.equal(change.authorityExercise!.delegation!.actorId, mainId);
          assert.equal(
            change.authorityExercise!.delegation!.policyId,
            "main-network",
          );
          assert.deepEqual(
            middleNotice.operatorNotice.route!.trace.map((
              hop,
            ) => [hop.operatorId, hop.eligibility]),
            [[middleId, "not-covered"], [mainId, "eligible"]],
          );
          const notice = mainNotices().find((message) =>
            message.operatorNotice?.kind === "authority-escalation" &&
            message.operatorNotice.changeId === change.id
          )!;
          assert(notice.operatorNotice?.kind === "authority-escalation");
          assert.equal(notice.operatorNotice.decisionAuthority, "operator");
        } else {
          assert.equal(change.status, "pending");
          assert.equal(change.authorityExercise, undefined);
          assert.equal((await f.repository.current()).version, sourceBefore);
          const notice = mainNotices().find((message) =>
            message.operatorNotice?.kind === "authority-escalation" &&
            message.operatorNotice.changeId === change.id
          )!;
          assert(notice.operatorNotice?.kind === "authority-escalation");
          assert.equal(notice.operatorNotice.decisionAuthority, "human");
          assert.equal(notice.operatorNotice.route!.status, "human-decision");
          assert.deepEqual(
            notice.operatorNotice.route!.trace.map((
              hop,
            ) => [hop.operatorId, hop.eligibility]),
            [[middleId, "not-covered"], [mainId, "not-covered"]],
          );
          assert.equal(
            leaf.snapshot.executionModel!.configuration.network!.allowedHosts
              .includes(hosts[phase]),
            false,
          );
        }
        if (phase < 2) {
          const published = await workspace.runtimeFor(leafId)!.model
            .findApprovedChange!(leaf.snapshot.model!, change.id);
          assert(published?.receipt);
          assert.equal(
            published.receipt.authorityExercise.delegation!.actorId,
            phase === 0 ? middleId : mainId,
          );
          assert(
            leaf.snapshot.executionModel!.configuration.network!.allowedHosts
              .includes(hosts[phase]),
          );
        }
      }
      assert.equal(
        decisions.length,
        2,
        "Only middle then Main explicitly decide; no human action is executed",
      );
      assert.equal(
        contexts.filter((context) =>
          context.operator?.nativeId === middleId &&
          context.requestOpening !== undefined
        ).length,
        0,
      );
    } catch (error) {
      await Deno.writeTextFile(
        join(directory, "failure.json"),
        JSON.stringify(
          {
            sourceEpoch,
            error: error instanceof Error
              ? { name: error.name, message: error.message, stack: error.stack }
              : String(error),
            conversations: workspace?.conversations.snapshot,
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      if (workspace) {
        await Deno.writeTextFile(
          join(directory, "final-conversations.json"),
          JSON.stringify(workspace.conversations.snapshot, null, 2),
        );
      }

      await f.closeBackend();
    }
  },
});
