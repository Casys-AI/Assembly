import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  enqueueContribution,
  type OperatorWorkHost,
  processAcceptedContribution,
  workCompletion,
} from "./coordination.ts";
import { invocationKey } from "./journal.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { Case } from "../../../domain/work/entities/cases.ts";
import type {
  CaseInvocation,
  OperatorWorkReceipt,
} from "../../../domain/work/execution/case-context.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { branchAuthorityFixture } from "../../../../test/support/branch-authority-fixture.ts";
import type { OperatorExecutionDelivery } from "./execution.ts";
import { recordRequestNetworkOutcome } from "./request-network-outcome.ts";
import { requestChangeProposalDigest } from "../../../domain/governance/records/request-change.ts";
import { nativeExecutionIdentity } from "../native-execution/contract.ts";

/** A teammate working on delegated work, which itself delegated to a leaf. */
function teammate(outgoing?: { status: "pending" | "completed"; of?: string }) {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "researcher-system",
    catalogId: "catalog",
    builderId: "researcher",
  });
  model.version.repositoryVersion = "commit:researcher";
  const root: Case = {
    id: "request",
    number: 1,
    type: "request",
    objective: "Research",
    owner: "owner",
    openedBy: "main",
    openedFrom: { conversationId: "main-session" },
    modelPin: { digest: model.version.digest },
    status: "open",
    createdAt: "2026-11-01T00:00:00Z",
  };
  const work: OperatorWorkReceipt = {
    callerId: "owner",
    correlationId: "owner-call",
    invocationId: "owner-call",
    behaviorId: "researcher-inbox",
    targetNativeId: "researcher-inbox-native",
    modelVersion: { digest: "owner-pin", repositoryVersion: "commit:owner" },
    fingerprint: "owner-call-fingerprint",
    priorCandidateIds: [],
    caseId: root.id,
    caseContext: { caseId: root.id, record: root, modelPin: root.modelPin },
  };
  const invocation: CaseInvocation = {
    kind: "delegated",
    work: { ...work, caseContext: work.caseContext! },
  };
  const state: SystemRuntimeState = {
    id: "researcher-session",
    revision: 4,
    catalogRevision: 0,
    busy: false,
    phase: "ready",
    provider: "fixture",
    events: [],
    candidates: [],
    model: model.identity,
    executionModel: model,
    caseInvocation: invocation,
    activeInputMessageId: "work-input",
    messages: [{
      id: "work-input",
      role: "tool",
      text: "Contribute",
      at: root.createdAt,
      caseId: root.id,
      work,
    }],
    ...(outgoing
      ? {
        pendingContributions: {
          "leaf-call": {
            invocationKey: outgoing.of ?? invocationKey(invocation),
            inputMessageId: "work-input",
            targetOperatorId: "leaf",
            invocationId: "leaf-call",
            behaviorId: "leaf-inbox",
            status: outgoing.status,
          },
        },
      }
      : {}),
  };
  const host = {
    state,
    ports: {
      clock: { now: () => "2026-11-03T00:00:00.000Z" },
      model: { readExecutableModel: () => Promise.resolve(model) },
    },
    continuationFingerprint: () => Promise.resolve("continuation"),
    artifactEvidence: () => Promise.resolve({}),
  } as unknown as OperatorWorkHost;
  return { host, work };
}

const bounds = { messageRanges: [{ start: 0, end: 1 }], candidateIds: [] };

Deno.test("delegated work still waiting on its own outgoing contribution is not completed", async () => {
  const pending = teammate({ status: "pending" });
  const waiting = await workCompletion.call(pending.host, pending.work, bounds);
  equal(waiting.work.status, "waiting");
  equal(waiting.kind, "operator-work-waiting");
  for (
    const settled of [
      undefined,
      teammate({ status: "completed" }),
      // Another invocation's outgoing call does not hold this work.
      teammate({ status: "pending", of: "another-invocation" }),
    ]
  ) {
    const f = settled ?? teammate();
    const completion = await workCompletion.call(f.host, f.work, bounds);
    equal(completion.work.status, "completed");
  }
});

Deno.test("an adopted team creation resumes its exact continuation before accepting the next input", async () => {
  const f = await branchAuthorityFixture();
  const state = f.snapshot.request;
  state.cases![0].type = "request";
  const first = f.teamProposal();
  const beforePublication = structuredClone(state.executionModel!);
  state.executionModel!.version.digest = "c".repeat(64);
  state.executionModel!.version.repositoryVersion = `commit:${"2".repeat(40)}`;
  state.executionModel!.configuration.revision++;
  state.configuration!.revision = state.executionModel!.configuration.revision;
  first.status = "approved";
  first.authority = "builder";
  first.decidedAt = "2026-11-02T00:00:00.000Z";
  first.diff = {
    title: "First team creation",
    author: first.requestedBy!,
    base: {
      repositoryVersion: beforePublication.version.repositoryVersion!,
      modelDigest: beforePublication.version.digest,
      sourceDigest: "d".repeat(64),
    },
    sourceDigest: "e".repeat(64),
    files: [],
    patch: "",
    additions: 1,
    deletions: 0,
  };
  first.publishedCommit = state.executionModel!.version.repositoryVersion;
  const firstDigest = await requestChangeProposalDigest(first);
  state.changeDecisionContinuations = { [first.id]: "pending" };
  state.requestNetworkDecisions = {
    [first.id]: {
      openingId: "opening",
      executionSpaceId: "branch",
      caseId: "case",
      commandId: first.id,
      expectedRevision: state.revision,
      configurationRevision: first.baseRevision,
      proposalIntentDigest: firstDigest,
      verdict: "approve",
      authority: {
        kind: "creation-grant",
        digest: "b".repeat(64),
        envelope: {},
      },
    },
  };
  const accepted: OperatorExecutionDelivery[] = [];
  const host = {
    state,
    pending: null,
    ports: {
      clock: { now: () => "2026-11-02T00:00:00.000Z" },
      dispatch: {
        enqueue: (delivery: OperatorExecutionDelivery) => {
          accepted.push(structuredClone(delivery));
          return Promise.resolve({} as never);
        },
      },
    },
  } as unknown as OperatorWorkHost;
  const before = structuredClone(state);
  await rejects(
    () =>
      enqueueContribution.call(
        host,
        "Create the second teammate",
        undefined,
        "human",
        "case",
      ),
    { code: "AGENT_BUSY" },
  );
  deepStrictEqual(accepted, []);
  deepStrictEqual(
    state,
    before,
    "A refused input cannot displace the first creation's continuation",
  );
  state.changeDecisionContinuations[first.id] = "feedback-sent";
  await rejects(
    () =>
      enqueueContribution.call(
        host,
        "Create the second teammate",
        undefined,
        "human",
        "case",
      ),
    { code: "AGENT_BUSY" },
  );
  state.changeDecisionContinuations[first.id] = "pending";
  for (
    const control of [
      "pending team proposal",
      "resumed team",
      "approved network",
    ] as const
  ) {
    const controlState = structuredClone(state);
    const change = controlState.configuration!.changes[0];
    if (control === "pending team proposal") {
      change.status = "pending";
      delete change.publishedCommit;
    } else if (control === "resumed team") {
      controlState.changeDecisionContinuations![first.id] = "resumed";
    } else {
      change.kind = "mandate-change";
      change.requestedRights = { addNetworkHosts: ["example.org"] };
    }
    const controlBefore = structuredClone(controlState);
    await enqueueContribution.call(
      { ...host, state: controlState },
      "Continue the Request",
      undefined,
      "human",
      "case",
    );
    deepStrictEqual(controlState, controlBefore, control);
  }
  equal(
    accepted.length,
    3,
    "The admission barrier is limited to decided team continuations",
  );
  accepted.length = 0;
  const receiptDigest = "c".repeat(64);
  recordRequestNetworkOutcome(
    state,
    {
      id: `team-adoption:${receiptDigest}`,
      kind: "continuation",
      identity: {} as OperatorExecutionDelivery["identity"],
      modelPin: { modelDigest: state.executionModel!.version.digest },
      payload: {
        teamAdoption: {
          commandId: "first-adoption",
          receiptDigest,
          changeId: first.id,
          proposalIntentDigest: firstDigest,
          predecessorThreadId: "first-before",
          checkpointId: "first-checkpoint",
          successorThreadId: "first-after",
          originalInputMessageId: "first-input",
        },
      },
    },
    "case",
    "2026-11-02T00:00:00.000Z",
  );
  equal(state.changeDecisionContinuations[first.id], "resumed");
  await enqueueContribution.call(
    host,
    "Create the second teammate",
    undefined,
    "human",
    "case",
  );
  equal(accepted.length, 1);
});

for (
  const outcome of [
    "team-adoption",
    "network-adoption",
    "network-refusal",
  ] as const
) {
  Deno.test(`a member's delegated ${outcome} resumes its own outcome without manufacturing a local Case`, async () => {
    const team = outcome === "team-adoption";
    const approved = outcome !== "network-refusal";
    const member = teammate();
    const state = member.host.state;
    const model = state.executionModel!;
    model.version.digest = "d".repeat(64);
    model.version.repositoryVersion = `commit:${"1".repeat(40)}`;
    model.operatorTeam = {
      parentOperatorId: "owner",
      requestOwnerId: "owner",
      requestId: "request",
    };
    state.cases = [];
    const source = await branchAuthorityFixture();
    const creation = team
      ? source.teamProposal()
      : source.snapshot.request.configuration!.changes[0]!;
    creation.id = "member-child";
    creation.requestedBy = model.identity.builderId;
    creation.caseId = "request";
    if (team) {
      creation.teamOrigin = { operatorId: "owner", requestId: "request" };
    }
    creation.baseModelDigest = model.version.digest;
    creation.baseRevision = model.configuration.revision;
    creation.status = approved ? "approved" : "refused";
    creation.authority = team ? "builder" : "human";
    creation.requestedAt = "2026-11-01T00:00:00.000Z";
    creation.decidedAt = "2026-11-02T00:00:00.000Z";
    creation.publishedCommit = model.version.repositoryVersion;
    creation.diff = {
      title: "Member child creation",
      author: model.identity.builderId,
      base: {
        repositoryVersion: model.version.repositoryVersion!,
        modelDigest: model.version.digest,
        sourceDigest: "e".repeat(64),
      },
      sourceDigest: "f".repeat(64),
      files: [],
      patch: "",
      additions: 1,
      deletions: 0,
    };
    state.configuration = { ...model.configuration, changes: [creation] };
    state.changeDecisionContinuations = {
      [creation.id]: "pending",
      unrelated: "pending",
    };
    const proposalIntentDigest = await requestChangeProposalDigest(creation);
    state.requestNetworkDecisions = {
      [creation.id]: {
        openingId: "opening",
        executionSpaceId: "branch",
        caseId: "request",
        commandId: creation.id,
        expectedRevision: state.revision,
        configurationRevision: creation.baseRevision,
        proposalIntentDigest,
        verdict: approved ? "approve" : "refuse",
        ...(team
          ? {
            authority: {
              kind: "creation-grant" as const,
              digest: "a".repeat(64),
              envelope: {},
            },
          }
          : {}),
      },
    };
    const accepted: OperatorExecutionDelivery[] = [];
    let continued: string | undefined;
    const host: OperatorWorkHost = {
      ...member.host,
      pending: null,
      ports: {
        ...member.host.ports,
        clock: { now: () => "2026-11-02T00:00:00.000Z" },
        dispatch: {
          enqueue: (delivery: OperatorExecutionDelivery) => {
            accepted.push(structuredClone(delivery));
            return Promise.resolve({} as never);
          },
          inspect: () => Promise.resolve(null),
        },
      },
      update: (change) => {
        change(state);
        return Promise.resolve();
      },
      resumeActivations: () => Promise.resolve(),
      runTurn: (_onReply, contribution) => {
        continued = contribution?.teamAdoptionContinuation?.changeId ??
          contribution?.networkAdoptionContinuation?.changeId ??
          contribution?.networkRefusalContinuation?.changeId;
        const observation = state.messages.at(-1)!;
        equal(observation.caseId, "request");
        equal(
          (observation.observation?.value as { kind: string } | undefined)
            ?.kind,
          team
            ? "request-team-change-outcome"
            : "request-network-change-outcome",
        );
        return Promise.resolve();
      },
      workCompletion: (work, ranges) => workCompletion.call(host, work, ranges),
    };
    const nextWork = {
      ...structuredClone(member.work),
      correlationId: "next-owner-call",
      invocationId: "next-owner-call",
      fingerprint: "next-owner-call-fingerprint",
    };
    if (team) {
      await rejects(
        () =>
          enqueueContribution.call(
            host,
            "Continue after creating the child",
            nextWork,
            "delegation",
          ),
        { code: "AGENT_BUSY" },
      );
    }
    const receiptDigest = "b".repeat(64);
    const identity = nativeExecutionIdentity(
      state,
      "conversation",
      "work-input",
    );
    await processAcceptedContribution.call(host, {
      id: `${outcome}:${receiptDigest}`,
      kind: "continuation",
      identity,
      modelPin: {
        modelDigest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion,
      },
      payload: {
        inputMessageId: "work-input",
        invocation: structuredClone(state.caseInvocation),
        [
          team
            ? "teamAdoption"
            : approved
            ? "networkAdoption"
            : "networkRefusal"
        ]: approved
          ? {
            commandId: "member-child-adoption",
            receiptDigest,
            changeId: creation.id,
            proposalIntentDigest,
            predecessorThreadId: "member-before",
            checkpointId: "member-checkpoint",
            successorThreadId: "member-after",
            originalInputMessageId: "work-input",
          }
          : {
            changeId: creation.id,
            proposalIntentDigest,
            decisionDigest: receiptDigest,
            threadId: "member-before",
            checkpointId: "member-checkpoint",
            originalInputMessageId: "work-input",
          },
      },
    });
    equal(continued, creation.id);
    equal(
      state.changeDecisionContinuations[creation.id],
      team ? "resumed" : "pending",
    );
    equal(state.changeDecisionContinuations.unrelated, "pending");
    equal(state.busy, false);
    deepStrictEqual(state.cases, []);
    equal(state.caseInvocation?.kind, "delegated");
    await enqueueContribution.call(
      host,
      "Continue after creating the child",
      nextWork,
      "delegation",
    );
    equal(accepted.length, 1);
    deepStrictEqual(state.cases, []);
  });
}
