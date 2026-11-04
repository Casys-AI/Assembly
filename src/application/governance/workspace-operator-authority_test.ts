import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { invocationKey } from "../work/operators/journal.ts";
import { createWorkspaceOperatorAuthority } from "./workspace-operator-authority.ts";
import { requestControlState } from "../../../test/support/request-space-fixture.ts";
import type { SystemRuntime } from "../work/runtime/system.ts";
import type { WorkspaceRuntime } from "../work/operators/workspace-registry.ts";
import type { OperatorCommandOrigin } from "../work/operators/command-delivery.ts";
import type { QueuedArtifactSourcePublication } from "../../domain/work/artifacts/source-publication.ts";
import type { ChatDecision } from "../../domain/work/dialogue.ts";

type BranchAuthority = NonNullable<
  Parameters<typeof createWorkspaceOperatorAuthority>[0]["branchAuthority"]
>;

function fixture(
  kind: "candidate" | "change",
  branchAuthority?: BranchAuthority,
) {
  const events: string[] = [];
  const historical = requestControlState(undefined, 5);
  historical.caseInvocation = { kind: "designer", scopeId: "design" };
  historical.designer = { scopeId: "design" };
  historical.messages = [{
    id: "input",
    role: "user",
    text: "Decide",
    at: "2026-11-04T00:00:00Z",
    designerScopeId: "design",
  }];
  const common = {
    operatorId: "recipient",
    policyId: "grant",
    policyRevision: 2,
    expectedRevision: 7,
    verdict: "approve" as const,
    text: "Decide",
  };
  const decision: Extract<
    ChatDecision,
    { kind: "decide_operator_candidate" | "decide_operator_change" }
  > = kind === "candidate"
    ? {
      ...common,
      kind: "decide_operator_candidate",
      candidateId: "candidate",
      candidateDigest: "digest",
      caseId: "request",
      reason: "Verified",
    }
    : { ...common, kind: "decide_operator_change", changeId: "change" };
  if (decision.kind === "decide_operator_candidate") {
    historical.messages.push({
      id: "inspection",
      role: "tool",
      text: "Inspection",
      at: "2026-11-04T00:00:00Z",
      designerScopeId: "design",
      execution: {
        digest: historical.executionModel!.version.digest,
        repositoryVersion: historical.executionModel!.version.repositoryVersion,
        actionId: "inspect",
      },
      observation: {
        kind: "candidate-inspection",
        value: {
          candidate: { id: "candidate" },
          decisionReference: {
            operatorId: decision.operatorId,
            candidateId: decision.candidateId,
            candidateDigest: decision.candidateDigest,
            expectedRevision: decision.expectedRevision,
            caseId: decision.caseId,
            policyId: decision.policyId,
            policyRevision: decision.policyRevision,
          },
        },
      },
    });
  }
  historical.activeBatchCall = { batchId: "batch", callId: "call" };
  historical.conversationBatches = [{
    id: "batch",
    modelDigest: historical.executionModel!.version.digest,
    inputMessageId: "input",
    invocationKey: invocationKey(historical.caseInvocation),
    createdAt: "2026-11-04T00:00:00Z",
    sourceDecision: {},
    calls: [{ id: "call", status: "started", effectStarted: true, decision }],
  }];
  const current = structuredClone(historical);
  current.executionModel!.version.digest = "revoked-contract";
  const origin: OperatorCommandOrigin = {
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: historical.id,
        operatorId: "operator",
        revision: 5,
        modelDigest: historical.executionModel!.version.digest,
        invocationKey: invocationKey(historical.caseInvocation),
      },
    },
    effectKey: "effect",
    inputMessageId: "input",
  };
  let lifecycle!: Parameters<
    SystemRuntime["bindOperatorAuthorityLifecycle"]
  >[0];
  const actor = {
    snapshot: current,
    bindOperatorCommandAuthority() {},
    bindArtifactSourceAuthority() {},
    bindOperatorAuthorityLifecycle(value: typeof lifecycle) {
      lifecycle = value;
    },
  } as unknown as SystemRuntime;
  let accepted = true;
  const target = {
    snapshot: {
      ...requestControlState(),
      executionModel: {
        ...requestControlState().executionModel,
        identity: { builderId: "recipient" },
      },
    },
    assertArtifactSourcePublication: () => {
      events.push("verify-publication");
      return Promise.resolve();
    },
    resumeOperatorCommand: () => {
      events.push("resume");
      return Promise.resolve(accepted);
    },
  } as unknown as SystemRuntime;
  const unused = () => {
    throw new Error("Unexpected port");
  };
  const runtimes = new Map<string, WorkspaceRuntime>([
    [
      "operator",
      {
        runtime: actor,
        model: { readExecutableModel: unused },
        scope: "actor",
      } as unknown as WorkspaceRuntime,
    ],
    ["recipient", { runtime: target, scope: "target" } as WorkspaceRuntime],
  ]);
  const service = createWorkspaceOperatorAuthority({
    primary: actor,
    primaryModel: historical.executionModel!,
    branchAuthority,
    runtimes,
    storage: {
      operator: () =>
        Promise.resolve({
          state: {
            loadRevision: () => {
              events.push("historical");
              return Promise.resolve(structuredClone(historical));
            },
            load: () => {
              events.push("current");
              return Promise.resolve(structuredClone(current));
            },
          },
        }),
    },
    assertCommandOrigin: () => {
      events.push("native-origin");
      return Promise.resolve();
    },
    assertArtifactSourceOrigin: unused,
    assertSkillAuthority: unused,
    conversations: {
      inspectCandidate: unused,
      decideCandidate: unused,
      decideChange: unused,
    },
    reconcile: unused,
    recoveryError: unused,
    clock: { now: () => "2026-11-04T00:00:00Z" },
  });
  service.bindAuthority(actor);
  const decide = () =>
    decision.kind === "decide_operator_candidate"
      ? lifecycle.decideCandidate!(decision, origin)
      : lifecycle.decide!(decision, origin);
  return {
    service,
    decide,
    events,
    historical,
    current,
    lifecycle,
    origin,
    decision,
    fresh: () => {
      accepted = false;
    },
  };
}

for (const kind of ["candidate", "change"] as const) {
  Deno.test(`workspace accepted ${kind} replay proves historical authority before bypassing today's revoked contract`, async () => {
    const f = fixture(kind);
    await f.decide();
    deepStrictEqual(f.events, [
      "native-origin",
      "historical",
      "current",
      "resume",
    ]);
    f.historical.conversationBatches![0].calls[0].effectStarted = false;
    f.events.length = 0;
    await rejects(f.decide(), { code: "AUTHORITY_REQUEST_STALE" });
    equal(f.events.includes("resume"), false);
  });
  Deno.test(`workspace new ${kind} command revalidates the currently adopted contract`, async () => {
    const f = fixture(kind);
    f.fresh();
    await rejects(f.decide(), { code: "AUTHORITY_REQUEST_STALE" });
    deepStrictEqual(f.events, [
      "native-origin",
      "historical",
      "current",
      "resume",
      "native-origin",
      "historical",
      "current",
    ]);
  });
}

Deno.test("workspace artifact publication selects only its exact admitted owner", async () => {
  const f = fixture("change");
  const publication = {
    target: { operatorId: "recipient", ownerId: "recipient" },
  } as QueuedArtifactSourcePublication;
  await f.service.verifyArtifactSourcePublication(publication);
  deepStrictEqual(f.events, ["verify-publication"]);
  f.events.length = 0;
  await rejects(
    f.service.verifyArtifactSourcePublication({
      ...publication,
      target: { ...publication.target, ownerId: "operator" },
    }),
  );
  await rejects(
    f.service.verifyArtifactSourcePublication({
      ...publication,
      target: {
        ...publication.target,
        operatorId: "missing",
        ownerId: "missing",
      },
    }),
  );
  deepStrictEqual(f.events, []);
});

Deno.test("workspace Main decisions route a fresh branch request while display contexts retain their revision cache", async () => {
  let reads = 0;
  let view: Awaited<ReturnType<BranchAuthority["mainView"]>> = {
    requests: [],
    awaitingPerson: [],
    openRequests: [],
    recorded: [],
  };
  const decisions: Array<Parameters<BranchAuthority["decide"]>[0]> = [];
  const f = fixture("change", {
    mainView: () => {
      reads++;
      return Promise.resolve(view);
    },
    decide: (input) => {
      decisions.push(input);
      return Promise.resolve();
    },
    recipientSpace: () => {
      throw new Error("Unexpected recipient-space read");
    },
  });
  const revision = f.current.revision;
  const displayed = await f.lifecycle.decisionContext!();
  deepStrictEqual(displayed!.requests, []);
  equal(reads, 1);

  const identity = f.historical.executionModel!.identity;
  view = {
    ...view,
    requests: [{
      id: "change",
      caseId: "fresh-case",
      requestedBy: "recipient",
      baseRevision: 7,
      executionSpaceId: "request:fresh-case",
      requester: {
        projectId: identity.projectId,
        systemId: identity.systemId,
        executionSpaceId: "request:fresh-case",
        operatorId: "recipient",
      },
      changeKind: "mandate-change",
    }],
  };
  await f.decide();
  deepStrictEqual(decisions, [{
    caseId: "fresh-case",
    command: f.decision,
    origin: f.origin,
  }]);
  equal(reads, 2);
  equal(f.current.revision, revision);
  deepStrictEqual(displayed!.requests, []);
  deepStrictEqual((await f.lifecycle.decisionContext!())!.requests, []);
  equal(reads, 2);
});
