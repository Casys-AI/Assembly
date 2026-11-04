/** Shared real runtime composition for deterministic and opt-in qualifications. */
import assert from "node:assert/strict";
import {
  openRequestValueFixture,
  requestValueHost,
} from "./request-value-profile.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { SystemClock } from "../../src/infrastructure/clock.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import { primaryInformationPort } from "../../src/composition/primary-information.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type { ChatDecision } from "../../src/domain/work/dialogue.ts";

/** Setup decisions are explicit owner-authorized grants, not delegated input.
 * The supplied provider takes over only after both grants are published/adopted. */
export async function openRequestValueRuntime(
  packageDir: string,
  provider: AgentPort,
  existingFixture?: Awaited<ReturnType<typeof openRequestValueFixture>>,
  runtimeProvenance?:
    import("../../src/application/work/runtime/provenance.ts").RuntimeProvenancePort,
) {
  const fixture = existingFixture ?? await openRequestValueFixture(packageDir);
  const { postgres } = fixture;
  const store = postgres.primary.state;
  const numbers = postgres.workspacePorts.caseNumbers;
  const budgets = postgres.primary.budget;
  const workBudget = new WorkBudgetService(budgets);
  const setupQueue: ChatDecision[] = [];
  let setup = true;
  const agents: AgentPort = {
    label: `request-value/${provider.label}`,
    decide(context) {
      if (!setup) return provider.decide(context);
      const decision = setupQueue.shift();
      assert(decision, "Unexpected model decision during owner setup");
      return Promise.resolve(decision);
    },
    ...(provider.decideBatch
      ? {
        decideBatch(context) {
          if (!setup) return provider.decideBatch!(context);
          const decision = setupQueue.shift();
          assert(decision, "Unexpected batched decision during owner setup");
          return Promise.resolve({
            calls: [{ id: crypto.randomUUID(), decision }],
          });
        },
      }
      : {}),
    review: (candidate, tests, context) =>
      provider.review(candidate, tests, context),
  };
  const executors: BehaviorInvocationPort[] = [];
  const informationReader: { current?: DecisionInformationPort } = {};
  const clock = new SystemClock();
  let workspace: Awaited<ReturnType<typeof openOperatorWorkspace>> | undefined;
  try {
    const primary = new SystemRuntime({
      ...postgres.runtimePorts,
      model: fixture.primary,
      store,
      agents,
      caseNumbers: numbers,
      workBudget,
      runtimeProvenance,
      clock,
      // Main is created before its workspace, as in the composition root.
      information: primaryInformationPort(() => informationReader.current),
      runner: new DenoToolRunner(),
      behaviors: new BehaviorInvocationRegistry(executors),
    });
    await primary.initialize(undefined, {
      resumeContinuations: false,
      resumeCandidateContinuations: false,
    });
    workspace = await openOperatorWorkspace({
      ...postgres.workspacePorts,
      primaryHistory: store,
      primary,
      primaryModel: fixture.primary,
      repository: fixture.repository,
      tooling: fixture.tooling,
      agents,
      directory: fixture.dataDir,
      createSourceModel: fixture.createSourceModel,
      executors,
      caseNumbers: numbers,
      workBudget,
      runtimeProvenance,
      clock,
    });
    informationReader.current = workspace.information;
    await postgres.start(workspace);
    const mainId = primary.snapshot.executionModel!.identity.builderId;
    const view = (name: string) => {
      const entry = workspace!.conversations.snapshot.conversations.find((
        item,
      ) => item.name === name);
      assert(entry, `Missing admitted operator ${name}`);
      return entry;
    };
    const peers = [view("Permissions operator"), view("Constraints operator")];
    const owner = view("Research owner");
    const grant = async (decision: ChatDecision) => {
      setupQueue.push(decision, {
        kind: "reply",
        text: "Initial grant recorded.",
      });
      await workspace!.conversations.submitHuman({
        agentId: mainId,
        expectedRevision: primary.snapshot.revision,
        text: "Publish and approve the displayed initial qualification grant.",
      });
      await postgres.idle(primary);
      assert.equal(primary.snapshot.error, undefined);
      assert.equal(
        primary.cases.cases.length,
        0,
        "Setup must remain in Main's designer scope",
      );
      const change = primary.snapshot.configuration!.changes.at(-1)!;
      assert.equal(change.status, "pending");
      await primary.decideChange({
        changeId: change.id,
        expectedRevision: change.baseRevision,
        verdict: "approve",
      });
      await postgres.idle(primary);
      assert.equal(primary.snapshot.error, undefined);
      assert.equal(
        primary.snapshot.configuration!.changes.find((item) =>
          item.id === change.id
        )?.status,
        "approved",
      );
      return change.id;
    };
    const recipients = peers.map((peer) => peer.nativeId);
    const networkGrant = await grant({
      kind: "propose_mandate_change",
      text: "Propose a bounded network decision grant.",
      reason:
        "Only the two admitted operators and the official documentation host.",
      requestedRights: {
        operatorAuthority: {
          policyId: "request-value-network",
          expectedPolicyRevision: 0,
          enabled: true,
          recipients,
          acts: ["addNetworkHosts"],
          networkHosts: [requestValueHost],
          toolIds: [],
          maxDelegationDepth: 0,
        },
      },
    });
    const admissionGrant = await grant({
      kind: "propose_mandate_change",
      text: "Propose a bounded candidate admission grant.",
      reason:
        "Only the two admitted operators and the HTML extraction contract.",
      requestedRights: {
        toolAdmission: {
          policyId: "request-value-tools",
          expectedPolicyRevision: 0,
          enabled: true,
          recipients,
          toolKinds: ["read_web_page"],
          maxDelegationDepth: 0,
        },
      },
    });
    const head = await fixture.repository.current();
    for (const entry of [view("Main Operator"), owner, ...peers]) {
      const runtime = workspace!.runtimeFor(entry.agentId)!.runtime;
      const available = await validateSourceExecutable(
        head,
        fixture.projectId,
        runtime.snapshot.executionModel!.identity.systemQualifiedName,
      );
      const command = {
        agentId: available.identity.builderId,
        expectedDigest: available.version.digest,
        expectedVersion: head.version,
      };
      await workspace!.adopt(command, () => runtime.adoptModelVersion(command));
    }
    for (const peer of peers) {
      const model = workspace!.runtimeFor(peer.agentId)!.runtime.snapshot
        .executionModel!;
      assert(
        model.operatorAuthorityPolicies?.some((p) =>
          p.id === "request-value-network" && p.enabled
        ),
      );
      assert(
        model.toolAdmissionPolicies?.some((p) =>
          p.id === "request-value-tools" && p.enabled
        ),
      );
    }
    setup = false;
    return {
      ...fixture,
      primary,
      workspace: workspace!,
      store,
      numbers,
      budgets,
      workBudget,
      mainId,
      owner,
      peers,
      networkGrant,
      admissionGrant,
      async close() {
        await fixture.closeBackend();
      },
    };
  } catch (error) {
    await fixture.closeBackend();
    throw error;
  }
}
