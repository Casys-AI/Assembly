import type {
  ImmutableConsultationGroupManifest,
  ImmutableConsultationGroupMember,
  ImmutableConsultationGroupPublication,
  ImmutableConsultationMemberOutcome,
  NativeExecutionRequest,
} from "../../src/application/work/native-execution/contract.ts";
import {
  nativeExecutionIdentity,
  runtimeRevisionReference,
} from "../../src/application/work/native-execution/contract.ts";
import type { SystemRuntimeState } from "../../src/domain/work/dialogue.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import { nativeCaseFixtureModel } from "./native-execution.ts";

/** An exact recorded response used with either ledger; no provider or native build. */
export function immutableConsultationFixture() {
  const model = nativeCaseFixtureModel("immutable-ledger", {
    repositoryVersion: "b".repeat(40),
  });
  model.identity.projectId = "git:immutable-ledger-fixture";
  model.version.digest = "a".repeat(64);
  model.policy.mayProposeSysmlRevision = true;
  const flow = model.flows.conversation;
  flow.executionProfile = "operator-command-immutable-group-v1";
  const node = {
    ...structuredClone(flow.nodes.find((item) => item.kind === "action")!),
    id: "immutable-command",
    nativeId: "immutable-command-native",
    name: "executeOperatorCommand",
    mechanism: "execute_operator_command",
    inputs: [],
    outputs: [],
    assertions: [],
  };
  flow.nodes.push(node);
  const state: SystemRuntimeState = {
    id: "immutable-business-state",
    revision: 0,
    catalogRevision: 0,
    messages: [{
      id: "input-one",
      role: "user",
      text: "Read two exact sources",
      at: "2026-10-29T00:00:00.000Z",
      designerScopeId: "designer-one",
    }],
    candidates: [],
    events: [],
    busy: true,
    phase: "Ledger fixture",
    provider: "scripted ledger fixture",
    model: structuredClone(model.identity),
    executionModel: structuredClone(model),
    cases: [],
    designer: { scopeId: "designer-one" },
    caseInvocation: { kind: "designer", scopeId: "designer-one" },
    activeInputMessageId: "input-one",
  };
  const request: NativeExecutionRequest = {
    businessRevision: runtimeRevisionReference(state),
    identity: nativeExecutionIdentity(state, "conversation", "input-one"),
    contribution: {
      id: "input-one",
      kind: "input",
      inputMessageId: "input-one",
    },
    model,
    flow,
    maxSteps: flow.maxSteps,
  };
  const choices = ["first", "second"].map((query) => ({
    kind: "consult_model" as const,
    text: `Read ${query}`,
    inputJson: JSON.stringify({
      operation: "search",
      version: "commit:source",
      query,
    }),
  }));
  state.conversationBatches = [{
    id: "batch-one",
    inputMessageId: "input-one",
    invocationKey: request.identity.invocationKey,
    designerScopeId: "designer-one",
    modelDigest: model.version.digest,
    createdAt: "2026-10-29T00:00:00.000Z",
    sourceDecision: {
      modelContext: {
        version: "commit:source",
        sourceDigest: "c".repeat(64),
        files: [],
        roots: { items: [], total: 0, truncated: false },
        limits: {
          maxPageSize: 50,
          maxSourceBytes: 120000,
          maxInspectSourceBytes: 4096,
        },
        coverage: "bounded-discovery-not-exhaustive-impact",
      },
    },
    calls: choices.map((decision, index) => ({
      id: `provider-${index}`,
      decision,
      status: "queued",
    })),
  }];
  const manifest = async (
    runId: string,
  ): Promise<ImmutableConsultationGroupManifest> => {
    const members = await Promise.all(
      choices.map(
        async (choice, ordinal): Promise<ImmutableConsultationGroupMember> => {
          const query: ImmutableConsultationGroupMember["request"] = {
            operation: "search",
            version: "commit:source",
            query: ordinal ? "second" : "first",
          };
          return {
            ordinal,
            callId: `provider-${ordinal}`,
            effectKey: `immutable-member:${runId}:${ordinal}`,
            argumentsDigest: await executionDigest(query),
            choice: structuredClone(choice),
            request: query,
            responseCharacters: 4096,
            flowStepOrdinal: ordinal + 1,
          };
        },
      ),
    );
    const body: Omit<ImmutableConsultationGroupManifest, "manifestDigest"> = {
      groupId: `immutable-group:${runId}`,
      runId,
      occurrenceId: node.id,
      batchId: "batch-one",
      firstOrdinal: 0,
      identity: structuredClone(request.identity),
      contribution: structuredClone(request.contribution),
      businessRevision: structuredClone(request.businessRevision),
      executionPin: {
        modelDigest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion,
      },
      sourcePin: { version: "commit:source", digest: "c".repeat(64) },
      members: [members[0]!, members[1]!],
      limits: { responseCharacters: 8192, flowSteps: 3 },
    };
    return { ...body, manifestDigest: await executionDigest(body) };
  };
  const outcome = (
    group: ImmutableConsultationGroupManifest,
    member: ImmutableConsultationGroupMember,
  ): ImmutableConsultationMemberOutcome => ({
    groupId: group.groupId,
    callId: member.callId,
    effectKey: member.effectKey,
    argumentsDigest: member.argumentsDigest,
    result: {
      status: "succeeded",
      code: "MODEL_CONSULTATION_COMPLETED",
      details: member.callId,
      value: { query: member.request.query },
    },
    messages: [{
      id: `immutable-message:${group.groupId}:${member.callId}`,
      role: "tool",
      text: member.callId,
      at: "2026-10-29T00:00:00.000Z",
      designerScopeId: "designer-one",
    }],
    events: [],
  });
  const publication = async (
    group: ImmutableConsultationGroupManifest,
    outcomes: ImmutableConsultationMemberOutcome[],
  ) => {
    const next = structuredClone(state);
    next.revision++;
    const body: Omit<
      ImmutableConsultationGroupPublication,
      "publicationDigest"
    > = {
      groupId: group.groupId,
      manifestDigest: group.manifestDigest,
      members: await Promise.all(
        outcomes.map(async (receipt) => ({
          callId: receipt.callId,
          effectKey: receipt.effectKey,
          receiptDigest: await executionDigest(receipt),
        })),
      ),
      businessRevision: runtimeRevisionReference(next),
    };
    const receipt = { ...body, publicationDigest: await executionDigest(body) };
    next.conversationBatches![0].immutableGroup = {
      groupId: group.groupId,
      manifestDigest: group.manifestDigest,
      publication: {
        publicationDigest: receipt.publicationDigest,
        revision: next.revision,
      },
    };
    for (const result of outcomes) {
      const call = next.conversationBatches![0].calls.find((item) =>
        item.id === result.callId
      )!;
      call.status = result.result.status === "cancelled"
        ? "cancelled"
        : "completed";
      call.result = structuredClone(result.result);
      next.messages.push(...structuredClone(result.messages));
      next.events.push(...structuredClone(result.events));
    }
    return { state: next, receipt };
  };
  return { model, state, request, node, manifest, outcome, publication };
}
