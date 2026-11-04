import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { scopedOperator } from "../../../domain/governance/policies/delegation-scope.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority.ts";
import { exerciseOwnerAuthority } from "../../../domain/governance/authority.ts";
import { CandidateActivationError } from "../../../domain/work/policies/candidate-activation.ts";
import type { CandidateDelegatedActor } from "../../../domain/governance/policies/tool-admission-policy.ts";
import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import {
  draftDigest,
  SystemRuntime,
} from "../../../../test/support/system-runtime.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  Message,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type {
  SkillCatalogRecord,
} from "../../../domain/skills/records/catalog.ts";
import type { SkillStorePort } from "../../skills/ports.ts";
import { modelContextTools } from "../../../domain/model/consultation/context.ts";
import {
  type ConversationRuntime,
  conversationUnit,
  type OperatorCandidateDecision,
  type OperatorChangeDecision,
  OperatorConversationError,
  OperatorConversations,
  type OperatorConversationUnit,
  type OperatorWorkAdmission,
  type OperatorWorkContribution,
  reviewerConversation,
} from "./conversations.ts";
import {
  candidateCaseInvocation,
  invocationKey,
  type OperatorWorkCompletion,
  operatorWorkFingerprint,
  type OperatorWorkMessage,
  recordedOperatorWork,
} from "./journal.ts";
import { type OperatorWorkReceipt } from "../../../domain/work/execution/case-context.ts";

import { MAX_USER_MESSAGE_CHARS } from "../../../domain/work/records/conversations.ts";
import type { CaseExecutionContext } from "../../../domain/work/execution/modeled-behavior.ts";
import { caseExecutionContext } from "../cases/runtime.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type { OperatorControlCommand } from "./command-delivery.ts";
import {
  designerExecutionContext,
  selectCaseInvocation,
  selectDesignerInvocation,
  selectHumanRequestCase,
} from "../cases/runtime.ts";

type CandidateRecoveryCommand = Extract<
  OperatorControlCommand,
  { kind: "resume-candidate-continuation" }
>;

function delegated(state: SystemRuntimeState, context: CaseExecutionContext) {
  const work: OperatorWorkReceipt & { caseContext: CaseExecutionContext } = {
    caseId: context.caseId,
    caseContext: structuredClone(context),
    correlationId: "delegated-task",
    callerId: "primary",
    invocationId: "delegated-invocation",
    behaviorId: "delegated-behavior",
    targetNativeId: "flow-worker",
    modelVersion: {
      digest: "digest-primary",
      repositoryVersion: "branch:admitted",
    },
    fingerprint: "delegated-receipt",
    priorCandidateIds: [],
  };
  state.caseInvocation = {
    kind: "delegated",
    work,
  };
}

function model(
  id: string,
  humanInput = false,
  primary = false,
): ExecutableModel {
  const result = executableFixture({
    projectId: "git:fbca7d6e-a561-5230-8ca8-91e294e3d711",
    rootId: "root",
    editingContextId: "context",
    systemId: `system-${id}`,
    catalogId: `catalog-${id}`,
    builderId: id,
  });
  result.version.digest = `digest-${id}`;
  result.version.repositoryVersion = "branch:admitted";
  result.flows.conversation.rootNativeId = `flow-${id}`;
  result.operator = {
    name: id,
    instruction: `Mission ${id}`,
    humanInput,
    primary,
  };
  return result;
}

class Runtime implements ConversationRuntime {
  state: SystemRuntimeState;
  calls: string[] = [];
  humanTargets: Array<
    { caseId?: string; work?: OperatorWorkReceipt; newConversation?: true }
  > = [];
  decisions: Array<
    Omit<OperatorCandidateDecision, "agentId" | "expectedRevision">
  > = [];
  candidateActors: Array<CandidateDelegatedActor | undefined> = [];
  inspections: Array<
    {
      candidateId: string;
      candidateDigest: string;
      caseId: string;
      delegated: CandidateDelegatedActor;
    }
  > = [];
  resumeOptions: Array<{ candidatesOnly?: boolean } | undefined> = [];
  candidateContinuations: CandidateRecoveryCommand[] = [];
  enqueueStep?: (command: CandidateRecoveryCommand) => Promise<void>;
  settledActivations: Array<
    { caseId: string; abandon?: boolean; closed?: boolean }
  > = [];
  settleStep?: (
    input: { caseId: string; abandon?: boolean; closed?: boolean },
  ) => Promise<void>;
  decisionStep?: () => Promise<void>;
  changeDecisions: Array<
    Pick<OperatorChangeDecision, "changeId" | "expectedRevision" | "verdict">
  > = [];
  changeDecisionStep?: () => Promise<void>;
  notices: Array<
    {
      notice:
        import("../../../domain/governance/operator-authority.ts").OperatorNotice;
      origin:
        import("../../../domain/work/entities/cases.ts").Case["openedFrom"];
      delivery?: { wake: boolean };
    }
  > = [];
  receiveOperatorNotice(
    notice:
      import("../../../domain/governance/operator-authority.ts").OperatorNotice,
    origin: import("../../../domain/work/entities/cases.ts").Case["openedFrom"],
    delivery?: { wake: boolean },
  ) {
    if (
      notice.kind !== "subordinate-order" ||
      !this.notices.some((entry) =>
        entry.notice.kind === "subordinate-order" &&
        entry.notice.invocationId === notice.invocationId
      )
    ) {
      this.notices.push(structuredClone({ notice, origin, delivery }));
    }
    return Promise.resolve();
  }
  /** Whether a work's accepted delivery still runs (in file or in progress). */
  liveDelivery = false;
  listeners = new Set<(state: SystemRuntimeState) => void>();
  #idle = Promise.resolve();
  #finish?: () => void;
  constructor(executionModel: ExecutableModel) {
    this.state = {
      id: `session-${executionModel.identity.builderId}`,
      revision: 0,
      catalogRevision: 0,
      messages: [],
      candidates: [],
      events: [],
      busy: false,
      phase: "Ready",
      provider: "fixture",
      model: executionModel.identity,
      executionModel,
      configuration: structuredClone(executionModel.configuration),
    };
  }
  get snapshot() {
    return structuredClone(this.state);
  }
  onState(listener: (state: SystemRuntimeState) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  #emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
  refreshCaseContext(context: CaseExecutionContext, candidateId?: string) {
    if (candidateId) {
      const candidate = this.state.candidates.find((value) =>
        value.id === candidateId
      );
      const invocation = candidate &&
        candidateCaseInvocation(this.state, candidate);
      ok(invocation);
      selectCaseInvocation(this.state, invocation);
    }
    if (this.state.caseInvocation?.kind === "delegated") {
      this.state.caseInvocation.work.caseContext = structuredClone(context);
    }
    return Promise.resolve();
  }
  restoreCaseInvocation(
    invocation: NonNullable<SystemRuntimeState["caseInvocation"]>,
  ) {
    selectCaseInvocation(this.state, invocation);
    return Promise.resolve();
  }
  submit(
    text: string,
    work?: OperatorWorkReceipt,
    caseId?: string,
    newConversation?: true,
  ) {
    this.calls.push(text);
    this.humanTargets.push({
      caseId,
      work,
      ...(newConversation ? { newConversation } : {}),
    });
    this.state.messages.push({
      id: `message-${this.state.messages.length}`,
      at: "2026-10-21T00:00:00Z",
      role: "user",
      text,
    });
    this.state.busy = true;
    this.state.revision++;
    this.#idle = new Promise((resolve) => this.#finish = resolve);
    this.#emit();
    return Promise.resolve();
  }
  async submitWork(input: OperatorWorkContribution) {
    const accepted = this.submit(input.text);
    const last = this.state.messages.at(-1)! as OperatorWorkMessage;
    last.role = "tool";
    last.work = {
      ...(input.proof.mainOrder
        ? { mainOrder: structuredClone(input.proof.mainOrder) }
        : {}),
      ...(input.proof.parentInvocation
        ? { parentInvocation: structuredClone(input.proof.parentInvocation) }
        : {}),
      ...(input.proof.designerContext
        ? { designerContext: input.proof.designerContext }
        : {}),
      ...(input.proof.caseId ? { caseId: input.proof.caseId } : {}),
      ...(input.proof.caseContext
        ? { caseContext: input.proof.caseContext }
        : {}),
      callerId: input.proof.callerId,
      correlationId: input.correlationId,
      invocationId: input.proof.invocationId,
      ...(input.proof.kind === "mainOrder"
        ? {}
        : { behaviorId: input.proof.behavior.id }),
      targetNativeId: input.proof.kind === "mainOrder"
        ? input.proof.targetNativeId
        : input.proof.behavior.targetNativeId,
      modelVersion: input.proof.modelVersion,
      fingerprint: operatorWorkFingerprint(
        this.state.executionModel!.identity.builderId,
        input.text,
        input.correlationId,
        input.proof,
      ),
      priorCandidateIds: [],
    };
    // This controlled double journals a nonterminal waiting stage before its
    // acceptance promise returns. Retries below are after that journal barrier;
    // only finish() supplies terminal evidence. No queue/worker race is modeled.
    const waiting: OperatorWorkCompletion = {
      id: `waiting:${input.correlationId}`,
      at: "2026-10-21T00:00:00Z",
      kind: "operator-work-waiting",
      label: "Accepted contribution is waiting",
      work: {
        ...last.work,
        status: "waiting",
        messageCount: this.state.messages.length,
        messageRanges: [{
          start: this.state.messages.length - 1,
          end: this.state.messages.length,
        }],
        candidateIds: [],
        revision: this.state.revision,
        modelVersion: {
          digest: this.state.executionModel!.version.digest,
          repositoryVersion: this.state.executionModel!.version
            .repositoryVersion!,
        },
      },
    };
    this.state.events.push(waiting);
    this.#emit();
    await accepted;
  }
  finish(text = "Résultat") {
    this.state.messages.push({
      id: `message-${this.state.messages.length}`,
      at: "2026-10-21T00:01:00Z",
      role: "assistant",
      text,
    });
    this.state.busy = false;
    this.state.revision++;
    const receipt =
      (this.state.messages.at(-2) as Partial<OperatorWorkMessage>).work;
    if (receipt) {
      const event: OperatorWorkCompletion = {
        id: "completion",
        at: "2026-10-21T00:01:00Z",
        kind: "operator-work-completed",
        label: "Result",
        work: {
          ...receipt,
          status: "completed",
          messageCount: this.state.messages.length,
          candidateIds: [],
          revision: this.state.revision,
          modelVersion: {
            digest: this.state.executionModel!.version.digest,
            repositoryVersion: "branch:admitted",
          },
        },
      };
      this.state.events.push(event);
    }
    this.#emit();
    this.#finish?.();
  }
  idle() {
    return this.#idle;
  }
  workDeliveryLive(_callerId: string, _correlationId: string) {
    return Promise.resolve(this.liveDelivery);
  }
  async decideCandidate(
    input: Omit<OperatorCandidateDecision, "agentId" | "expectedRevision">,
    actor?: CandidateDelegatedActor,
  ) {
    this.decisions.push(structuredClone(input));
    this.candidateActors.push(structuredClone(actor));
    await this.decisionStep?.();
  }
  inspectCandidate(
    input: { candidateId: string; candidateDigest: string; caseId: string },
    actor: CandidateDelegatedActor,
  ) {
    this.inspections.push({ ...input, delegated: structuredClone(actor) });
    return Promise.resolve({
      operatorId: this.state.executionModel!.identity.builderId,
      candidate: structuredClone(
        this.state.candidates.find((candidate) =>
          candidate.id === input.candidateId
        )!,
      ),
      contract: structuredClone(this.state.executionModel!.contracts[0]),
      authorityExercise: exerciseOwnerAuthority(
        this.state.executionModel!,
        "candidate-admission",
      ),
    });
  }
  resumeDecidedChanges(options?: { candidatesOnly?: boolean }) {
    this.resumeOptions.push(structuredClone(options));
    return Promise.reject(
      new Error(
        "Registry recovery must enqueue an exact candidate, never invoke the legacy direct resume",
      ),
    );
  }
  async enqueueCandidateContinuation(candidateId: string) {
    // Registry boundary double only. Production SystemRuntime/PG tests own
    // accepted DTOs, native preflight, claim fencing and worker execution.
    const candidate = this.state.candidates.find((value) =>
      value.id === candidateId
    );
    ok(candidate?.admissionContinuation);
    const invocation = candidateCaseInvocation(this.state, candidate);
    ok(invocation);
    const command: CandidateRecoveryCommand = {
      kind: "resume-candidate-continuation",
      candidateId,
      invocationKey: invocationKey(invocation),
      inputMessageId: candidate.admissionContinuation.inputMessageId,
      continuationDigest: await executionDigest(
        candidate.admissionContinuation,
      ),
    };
    this.candidateContinuations.push(structuredClone(command));
    await this.enqueueStep?.(command);
  }
  async settleDelegatedCandidateActivations(
    input: { caseId: string; abandon?: boolean; closed?: boolean },
  ) {
    this.settledActivations.push(structuredClone(input));
    await this.settleStep?.(input);
  }
  async decideChange(
    input: Pick<
      OperatorChangeDecision,
      "changeId" | "expectedRevision" | "verdict"
    >,
  ) {
    this.changeDecisions.push(structuredClone(input));
    await this.changeDecisionStep?.();
  }
}

async function fixture(skillStore?: Pick<SkillStorePort, "load">) {
  const primary = new Runtime(model("primary", true, true));
  const worker = new Runtime(model("worker", false));
  const second = new Runtime(model("second", true));
  primary.state.cases = [{
    id: "primary-request",
    number: 1,
    type: "request",
    owner: "primary",
    objective: "Coordinate the requested work",
    openedBy: "primary",
    openedFrom: { conversationId: primary.state.id },
    modelPin: {
      digest: "digest-primary",
      repositoryVersion: "branch:admitted",
    },
    status: "waiting",
    createdAt: "2026-10-21T00:00:00Z",
  }];
  primary.state.caseInvocation = { kind: "local", caseId: "primary-request" };
  primary.state.executionModel!.behaviors = [worker, second].map((runtime) => ({
    id: `expose-${runtime.state.executionModel!.identity.builderId}`,
    name: "Submit work",
    description: "Native inbox",
    targetNativeId:
      runtime.state.executionModel!.flows.conversation.rootNativeId,
    targetTypeId: "inbox-type",
    inputTypeId: "input-type",
    callerNativeId: "primary",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    sourceIds: ["native-exposure"],
  }));
  const units = [primary, worker, second].map((
    runtime,
  ): OperatorConversationUnit => ({
    systemQualifiedName: `Example::${
      runtime.state.executionModel!.identity.systemId
    }`,
    model: runtime.snapshot.executionModel!,
  }));
  const opened: string[] = [], closed: ConversationRuntime[] = [];
  const manager = new OperatorConversations({
    primary,
    skillStore,
    factory: {
      open(unit) {
        const id = unit.model.identity.builderId;
        opened.push(id);
        return Promise.resolve(id === "worker" ? worker : second);
      },
      close(runtime) {
        closed.push(runtime);
        return Promise.resolve();
      },
    },
  });
  await manager.initialize({ repositoryVersion: "branch:admitted", units });
  const proof = (
    target = "worker",
  ): Extract<OperatorWorkAdmission, { behavior: unknown }> => ({
    caseId: caseExecutionContext(primary.state)?.caseId,
    caseContext: caseExecutionContext(primary.state),
    behavior: structuredClone(
      primary.state.executionModel!.behaviors!.find((entry) =>
        entry.id === `expose-${target}`
      )!,
    ),
    modelVersion: {
      digest: "digest-primary",
      repositoryVersion: "branch:admitted",
    },
    callerId: "primary",
    invocationId: `invoke-${target}`,
  });
  return { primary, worker, second, manager, units, opened, closed, proof };
}

Deno.test("conversation reads keep native operators and isolated histories without starting work", async () => {
  const f = await fixture();
  const value = f.manager.snapshot;
  equal(value.systemId, "session-primary");
  equal(value.defaultAgentId, "primary");
  deepStrictEqual(value.conversations.map((entry) => entry.agentId), [
    "primary",
    "worker",
    "second",
  ]);
  equal(value.conversations[1]!.canSend, false);
  equal(value.conversations[1]!.runtimeOwned, true);
  deepStrictEqual(f.primary.calls, []);
  deepStrictEqual(f.worker.calls, []);
  value.conversations[0]!.messages.push({} as Message);
  equal(f.manager.snapshot.conversations[0]!.messages.length, 0);
  await f.manager.dispose();
});

Deno.test("conversation skills project only display metadata in loaded and name order without catalog writes", async () => {
  const catalog: SkillCatalogRecord = {
    ownerId: "worker",
    revision: 1,
    operations: [],
    skills: [
      { id: "unloaded-z", name: "Zulu", loaded: false },
      { id: "loaded-z", name: "Zulu", loaded: true },
      { id: "unloaded-a", name: "Alpha", loaded: false },
      { id: "loaded-a", name: "Alpha", loaded: true },
    ].map((skill) => ({
      ...skill,
      description: `Description ${skill.id}`,
      content: "Private instructions",
      digest: "a".repeat(64),
      byteLength: 20,
      installedAt: "2026-10-22T10:00:00.000Z",
      source: {
        kind: "bundled",
        location: "private-source",
        acquiredAt: "2026-10-22T10:00:00.000Z",
        modelVersion: {
          digest: "digest-worker",
          repositoryVersion: "branch:admitted",
        },
      },
    })),
  };
  const before = structuredClone(catalog);
  const owners: string[] = [];
  const store: SkillStorePort = {
    load(ownerId) {
      owners.push(ownerId);
      return Promise.resolve(ownerId === "worker" ? catalog : null);
    },
    save() {
      throw new Error("Conversation reads must not save catalogs");
    },
  };
  const f = await fixture(store);
  const snapshot = await f.manager.conversations();
  deepStrictEqual(owners, ["primary", "worker", "second"]);
  deepStrictEqual(
    snapshot.conversations.find((entry) => entry.agentId === "worker")!.skills,
    ["loaded-a", "loaded-z", "unloaded-a", "unloaded-z"].map((id) => ({
      id,
      name: id.endsWith("a") ? "Alpha" : "Zulu",
      description: `Description ${id}`,
      loaded: id.startsWith("loaded"),
    })),
  );
  deepStrictEqual(catalog, before);
  equal(JSON.stringify(snapshot).includes("Private instructions"), false);
  await f.manager.dispose();
});

Deno.test("conversation skills distinguish absent catalogs, empty catalogs and an unwired store", async () => {
  const f = await fixture({
    load: (ownerId) =>
      Promise.resolve(
        ownerId === "worker"
          ? { ownerId, revision: 1, skills: [], operations: [] }
          : null,
      ),
  });
  const snapshot = await f.manager.conversations();
  equal(Object.hasOwn(snapshot.conversations[0]!, "skills"), false);
  deepStrictEqual(snapshot.conversations[1]!.skills, []);
  equal(Object.hasOwn(snapshot.conversations[2]!, "skills"), false);
  await f.manager.dispose();

  const unwired = await fixture();
  equal(
    (await unwired.manager.conversations()).conversations.some((entry) =>
      Object.hasOwn(entry, "skills")
    ),
    false,
  );
  await unwired.manager.dispose();
});

Deno.test("a 50 000-character human message is accepted and one past the bound is refused with its code", async () => {
  const f = await fixture();
  await rejects(
    () =>
      f.manager.submitHuman({
        agentId: "primary",
        text: "x".repeat(MAX_USER_MESSAGE_CHARS + 1),
        expectedRevision: f.primary.state.revision,
      }),
    (error: unknown) =>
      error instanceof OperatorConversationError &&
      error.code === "INVALID_MESSAGE",
  );
  const long = "y".repeat(50_000);
  await f.manager.submitHuman({
    agentId: "primary",
    text: long,
    expectedRevision: f.primary.state.revision,
  });
  equal(f.primary.calls.at(-1), long);
});

Deno.test("human input cannot grant itself a peer-only entry or bypass the session revision", async () => {
  const f = await fixture();
  await rejects(
    () =>
      f.manager.submitHuman({
        agentId: "worker",
        text: "Instruction",
        expectedRevision: 0,
      }),
    (error: unknown) =>
      error instanceof OperatorConversationError && error.status === 403,
  );
  await rejects(
    () =>
      f.manager.submitHuman({
        agentId: "primary",
        text: "Instruction",
        expectedRevision: 4,
      }),
    (error: unknown) =>
      error instanceof OperatorConversationError && error.status === 409,
  );
  deepStrictEqual(f.worker.calls, []);
  deepStrictEqual(f.primary.calls, []);
  await f.manager.dispose();
});

Deno.test("human commands forward the named Request and reject foreign or closed conversations", async () => {
  const f = await fixture();
  const clock = { now: () => "2026-10-24T00:00:00.000Z" };
  const open = (runtime: Runtime, number: number) =>
    selectHumanRequestCase(
      runtime.state,
      { objective: `Request ${number}`, messageId: `m${number}` },
      clock,
      number,
    );
  const a = open(f.primary, 2);
  const b = open(f.primary, 3);
  const foreign = open(f.second, 4);
  try {
    for (const caseId of [a, b]) {
      await f.manager.submitHuman({
        agentId: "primary",
        expectedRevision: f.primary.snapshot.revision,
        text: "Suite",
        caseId,
      });
      deepStrictEqual(f.primary.humanTargets.at(-1), {
        caseId,
        work: undefined,
      });
      f.primary.finish();
    }
    await rejects(
      () =>
        f.manager.submitHuman({
          agentId: "primary",
          expectedRevision: f.primary.snapshot.revision,
          text: "Foreign",
          caseId: foreign,
        }),
      {
        code: "CASE_NOT_OWNED",
        context: { caseId: foreign, agentId: "primary" },
      },
    );
    const closed = f.primary.state.cases!.find((record) => record.id === a)!;
    closed.status = "closed-done";
    closed.closedAt = clock.now();
    await rejects(
      () =>
        f.manager.submitHuman({
          agentId: "primary",
          expectedRevision: f.primary.snapshot.revision,
          text: "Closed",
          caseId: a,
        }),
      { code: "CASE_CLOSED" },
    );
    equal(f.primary.calls.length, 2);
    delegated(f.primary.state, caseExecutionContext(f.second.state)!);
    await f.manager.submitHuman({
      agentId: "primary",
      expectedRevision: f.primary.snapshot.revision,
      text: "New",
      newConversation: true,
    });
    deepStrictEqual(f.primary.humanTargets.at(-1), {
      caseId: undefined,
      work: undefined,
      newConversation: true,
    });
    f.primary.finish();
    await f.manager.submitHuman({
      agentId: "primary",
      expectedRevision: f.primary.snapshot.revision,
      text: "Designer",
    });
    deepStrictEqual(f.primary.humanTargets.at(-1), {
      caseId: undefined,
      work: undefined,
    });
    f.primary.finish();
  } finally {
    f.primary.finish();
    await f.manager.dispose();
  }
});

Deno.test("registry updates retain independently admitted operator pins without adopting peer semantics", async () => {
  const f = await fixture();
  const next = structuredClone(f.units);
  f.primary.state.executionModel!.version.repositoryVersion =
    "branch:new-registry";
  next[0]!.model = f.primary.snapshot.executionModel!;
  await f.manager.reconcileUnits({
    repositoryVersion: "branch:new-registry",
    units: next,
  });
  equal(
    f.manager.snapshot.conversations.find((entry) =>
      entry.agentId === "worker"
    )!.repositoryVersion,
    "branch:admitted",
  );
  equal(f.worker.snapshot.executionModel!.version.digest, "digest-worker");
  const unadopted = structuredClone(next);
  unadopted[1]!.model.version.digest = "new-worker-contract";
  await rejects(
    () =>
      f.manager.reconcileUnits({
        repositoryVersion: "branch:new-registry",
        units: unadopted,
      }),
    /admise/,
  );
  equal(
    f.manager.snapshot.conversations.find((entry) =>
      entry.agentId === "worker"
    )!.modelDigest,
    "digest-worker",
  );
  await f.manager.dispose();
});

Deno.test("model admission reserves human and native work commands and releases after refusal", async () => {
  const f = await fixture();
  await rejects(() =>
    f.manager.withAdmission(async () => {
      await rejects(() =>
        f.manager.submitHuman({
          agentId: "primary",
          text: "Run",
          expectedRevision: 0,
        }), /admission/);
      await rejects(
        () => f.manager.submitWork("worker", "Run", "reserved-work", f.proof()),
        /admission/,
      );
      await rejects(() => f.manager.withAdmission(async () => {}), /repos/);
      throw new Error("preflight refused");
    }), /preflight refused/);
  equal(f.primary.calls.length, 0);
  equal(f.worker.calls.length, 0);
  await f.manager.submitHuman({
    agentId: "primary",
    text: "Run after refusal",
    expectedRevision: 0,
  });
  equal(f.primary.calls.length, 1);
  f.primary.finish();
  await f.manager.dispose();
});

Deno.test("one busy conversation does not reserve another agent or copy its messages", async () => {
  const f = await fixture();
  await f.manager.submitHuman({
    agentId: "primary",
    text: "Mission principale",
    expectedRevision: 0,
  });
  await f.manager.submitHuman({
    agentId: "second",
    text: "Autre mission",
    expectedRevision: 0,
  });
  equal(f.primary.snapshot.busy, true);
  equal(f.second.snapshot.busy, true);
  deepStrictEqual(f.primary.calls, ["Mission principale"]);
  deepStrictEqual(f.second.calls, ["Autre mission"]);
  await rejects(
    () =>
      f.manager.submitHuman({
        agentId: "primary",
        text: "Encore",
        expectedRevision: 1,
      }),
    (error: unknown) =>
      error instanceof OperatorConversationError && error.code === "AGENT_BUSY",
  );
  f.primary.finish();
  f.second.finish();
  await f.manager.dispose();
});

Deno.test("a native work request needs the exact admitted caller, exposure and inbox", async () => {
  const f = await fixture();
  for (
    const proof of [
      { ...f.proof(), callerId: "second" },
      {
        ...f.proof(),
        modelVersion: {
          digest: "different",
          repositoryVersion: "branch:admitted",
        },
      },
      {
        ...f.proof(),
        behavior: { ...f.proof().behavior, targetNativeId: "other-inbox" },
      },
    ]
  ) {
    await rejects(
      () => f.manager.submitWork("worker", "Collecter", "work", proof),
      (error: unknown) =>
        error instanceof OperatorConversationError && error.status === 403,
    );
  }
  deepStrictEqual(f.worker.calls, []);
  await f.manager.dispose();
});

Deno.test("native work preserves exact admitted text until the runtime journals it", async () => {
  const f = await fixture();
  const text = "  Keep the original material input.\n";
  const pending = f.manager.submitWork(
    "worker",
    text,
    "exact-input",
    f.proof(),
  );
  await Promise.resolve();
  equal(f.worker.calls[0], text);
  f.worker.finish();
  await pending;
  await f.manager.dispose();
});

Deno.test("designer delegation requires the caller's exact explicit durable scope", async () => {
  const f = await fixture();
  selectDesignerInvocation(f.primary.state);
  const proof = f.proof();
  delete proof.caseId;
  delete proof.caseContext;
  proof.designerContext = designerExecutionContext(f.primary.state);
  try {
    const pending = f.manager.submitWork(
      "worker",
      "Concevoir",
      "designer-task",
      proof,
    );
    await Promise.resolve();
    equal(f.worker.calls.at(-1), "Concevoir");
    deepStrictEqual(
      f.worker.state.messages.at(-1)?.work?.designerContext,
      proof.designerContext,
    );
    const accepted = await pending;
    equal(accepted.status, "waiting");
    deepStrictEqual(accepted.messages, []);
    equal(accepted.agentId, "worker");
    equal(accepted.correlationId, "designer-task");
    equal(accepted.invocationId, proof.invocationId);
    f.worker.finish();
    const calls = f.worker.calls.length;
    const completed = await f.manager.submitWork(
      "worker",
      "Concevoir",
      "designer-task",
      proof,
    );
    equal(completed.status, "completed");
    deepStrictEqual(completed.messages.map((message) => message.text), [
      "Concevoir",
      "Résultat",
    ]);
    equal(f.worker.calls.length, calls);
    await rejects(() =>
      f.manager.submitWork("worker", "Forged", "forged", {
        ...proof,
        designerContext: {
          ...proof.designerContext!,
          scopeId: "foreign-designer",
        },
      }), { code: "WORK_CASE_MISMATCH" });
    await rejects(
      () =>
        f.manager.submitWork("worker", "Ambiguous", "ambiguous", {
          ...proof,
          caseId: "primary-request",
          caseContext: caseExecutionContext({
            ...f.primary.state,
            caseInvocation: { kind: "local", caseId: "primary-request" },
          }),
        }),
      { code: "WORK_CASE_MISMATCH" },
    );
    equal(f.worker.calls.length, calls);
  } finally {
    if (f.worker.state.busy) f.worker.finish();
    await f.manager.dispose();
  }
});

Deno.test("delegation verifies host case accounting independently of the unchanged historical fingerprint", async () => {
  const f = await fixture();
  const legacy = f.proof();
  delete legacy.caseId;
  delete legacy.caseContext;
  const context = {
    caseId: "central:case:1",
    modelPin: legacy.modelVersion,
    budget: {
      scopeId: "central-case",
      ownerId: "primary",
      policy: {
        id: "central-budget",
        revision: 1,
        unit: "agent-invocation" as const,
        limit: 5,
        onExhausted: "wait" as const,
        exhaustionRecipient: "local-control" as const,
        elementId: "central-budget",
        sourceIds: [],
      },
    },
  };
  f.primary.state.cases = [{
    id: context.caseId,
    number: 1,
    type: "request",
    objective: "Collecter",
    owner: "primary",
    openedBy: "primary",
    openedFrom: { conversationId: f.primary.state.id },
    status: "open",
    createdAt: "2026-10-21T00:00:00Z",
    modelPin: context.modelPin,
    budget: {
      scopeId: context.budget.scopeId,
      budgetId: context.budget.policy.id,
    },
  }];
  f.primary.state.caseInvocation = { kind: "local", caseId: context.caseId };
  f.primary.state.executionModel!.workBudgetPolicy = {
    ...context.budget.policy,
    elementId: "central-budget",
    sourceIds: [],
  };
  const numberedContext = caseExecutionContext(f.primary.state)!;
  const proof = {
    ...legacy,
    caseId: context.caseId,
    caseContext: numberedContext,
  };
  equal(
    operatorWorkFingerprint("worker", "Collecter", "task", legacy),
    operatorWorkFingerprint("worker", "Collecter", "task", proof),
  );
  for (const change of ["missing", "case", "budget"] as const) {
    const forged = structuredClone(proof) as OperatorWorkAdmission;
    if (change === "missing") delete forged.caseContext;
    if (change === "case") forged.caseId = "other-case";
    if (change === "budget") forged.caseContext!.budget!.policy.limit = 500;
    await rejects(
      () => f.manager.submitWork("worker", "Collecter", "task", forged),
      (error: unknown) =>
        error instanceof OperatorConversationError &&
        error.code === "WORK_CASE_MISMATCH",
    );
  }
  equal(f.worker.calls.length, 0);
  const pending = f.manager.submitWork("worker", "Collecter", "task", proof);
  await Promise.resolve();
  const forgedRetry = structuredClone(proof);
  forgedRetry.caseContext.budget!.policy.limit = 500;
  await rejects(
    () => f.manager.submitWork("worker", "Collecter", "task", forgedRetry),
    (error: unknown) =>
      error instanceof OperatorConversationError &&
      error.code === "WORK_CASE_MISMATCH",
  );
  f.worker.finish();
  const result = await pending;
  equal(result.caseId, context.caseId);
  deepStrictEqual(
    (f.worker.snapshot.messages[0] as OperatorWorkMessage).work.caseContext,
    numberedContext,
  );
  const next = structuredClone(proof);
  next.caseId = "central:case:2";
  next.caseContext.caseId = next.caseId;
  delegated(f.primary.state, next.caseContext);
  await rejects(
    () => f.manager.submitWork("worker", "Collecter", "task", next),
    (error: unknown) =>
      error instanceof OperatorConversationError &&
      error.code === "WORK_CONFLICT",
  );
  equal(f.worker.calls.length, 1);
  await f.manager.dispose();
});

Deno.test("parallel native work returns waiting acceptance and replays exact journaled contributions without redispatch", async () => {
  const f = await fixture();
  const work = f.manager.submitWork(
    "worker",
    "Collecter",
    "task:collect",
    f.proof(),
  );
  const accepted = await work;
  equal(accepted.status, "waiting");
  deepStrictEqual(accepted.messages, []);
  equal(accepted.agentId, "worker");
  equal(accepted.correlationId, "task:collect");
  equal(accepted.invocationId, f.proof().invocationId);
  const duplicate = await f.manager.submitWork(
    "worker",
    "Collecter",
    "task:collect",
    f.proof(),
  );
  equal(duplicate.status, "waiting");
  equal(duplicate.correlationId, accepted.correlationId);
  equal(duplicate.invocationId, accepted.invocationId);
  deepStrictEqual(duplicate.messages.map((message) => message.text), [
    "Collecter",
  ]);
  equal(f.worker.calls.length, 1);
  const other = f.manager.submitWork(
    "second",
    "Analyser",
    "task:analyse",
    f.proof("second"),
  );
  const acceptedOther = await other;
  equal(acceptedOther.status, "waiting");
  deepStrictEqual(acceptedOther.messages, []);
  equal(acceptedOther.agentId, "second");
  equal(acceptedOther.correlationId, "task:analyse");
  equal(acceptedOther.invocationId, f.proof("second").invocationId);
  equal(f.worker.state.busy, true);
  equal(f.second.state.busy, true);
  equal(f.second.calls.length, 1);
  f.worker.finish("Collecte effectuée");
  f.second.finish("Analyse effectuée");
  const [first, repeated, second] = await Promise.all([
    f.manager.submitWork("worker", "Collecter", "task:collect", f.proof()),
    f.manager.submitWork("worker", "Collecter", "task:collect", f.proof()),
    f.manager.submitWork(
      "second",
      "Analyser",
      "task:analyse",
      f.proof("second"),
    ),
  ]);
  deepStrictEqual(first, repeated);
  equal(first.status, "completed");
  equal(second.status, "completed");
  equal(f.worker.calls.length, 1);
  equal(f.second.calls.length, 1);
  deepStrictEqual(first.messages.map((entry) => entry.text), [
    "Collecter",
    "Collecte effectuée",
  ]);
  deepStrictEqual(second.messages.map((entry) => entry.text), [
    "Analyser",
    "Analyse effectuée",
  ]);
  equal(f.primary.snapshot.messages.length, 0);
  f.worker.state.messages.push({
    id: "later-private-message",
    role: "user",
    text:
      "Une contribution ultérieure ne fait pas partie du résultat précédent.",
    at: "later",
  });
  const replay = await f.manager.submitWork(
    "worker",
    "Collecter",
    "task:collect",
    f.proof(),
  );
  deepStrictEqual(replay, first);
  equal(f.worker.calls.length, 1);
  await rejects(
    () =>
      f.manager.submitWork(
        "worker",
        "Autre contenu",
        "task:collect",
        f.proof(),
      ),
    (error: unknown) =>
      error instanceof OperatorConversationError &&
      error.code === "WORK_CONFLICT",
  );
  await f.manager.dispose();
});

// A closed plan resumed by one sibling's completion re-invokes the other:
// while that sibling's accepted delivery still runs, its journalled input has
// no terminal receipt yet, and it is still waiting, not failed. Without a live
// delivery the same journal is an interrupted work (crash recovery).
Deno.test("a sibling whose accepted delivery still runs replays as waiting, an interrupted one as failed", async () => {
  const f = await fixture();
  await f.manager.submitWork("worker", "Collecter", "task:collect", f.proof());
  await f.manager.submitWork(
    "second",
    "Analyser",
    "task:analyse",
    f.proof("second"),
  );
  // The real target journals its input when its worker starts, then writes
  // no receipt until the turn ends.
  f.second.state.events = f.second.state.events.filter((event) =>
    event.kind !== "operator-work-waiting"
  );
  f.worker.finish("Collecte effectuée");
  const finished = await f.manager.submitWork(
    "worker",
    "Collecter",
    "task:collect",
    f.proof(),
  );
  equal(finished.status, "completed");
  f.second.liveDelivery = true;
  const running = await f.manager.submitWork(
    "second",
    "Analyser",
    "task:analyse",
    f.proof("second"),
  );
  equal(running.status, "waiting");
  equal(running.error, undefined);
  deepStrictEqual(running.messages, []);
  equal(running.correlationId, "task:analyse");
  equal(running.invocationId, f.proof("second").invocationId);
  f.second.liveDelivery = false;
  const interrupted = await f.manager.submitWork(
    "second",
    "Analyser",
    "task:analyse",
    f.proof("second"),
  );
  equal(interrupted.status, "failed");
  equal(f.second.calls.length, 1, "neither replay redispatches the work");
  f.second.finish("Analyse effectuée");
  await f.manager.dispose();
});

Deno.test("only an explicitly migrated dossier can reuse a historical receipt without changing its fingerprint", async () => {
  const f = await fixture();
  const admitted = structuredClone(f.primary.state.executionModel!);
  const openRuntime = async (
    saved: SystemRuntimeState | null,
    previousNumber = 0,
  ) => {
    let persisted = structuredClone(saved);
    let number = previousNumber;
    const forbidden = () => {
      throw new Error("Unexpected candidate or tool effect");
    };
    const runtime = new SystemRuntime({
      caseNumbers: { allocate: () => Promise.resolve(++number) },
      store: {
        load: () => Promise.resolve(structuredClone(persisted)),
        save(next, expected) {
          equal(persisted?.revision ?? null, expected);
          persisted = structuredClone(next);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      },
      agents: {
        label: "legacy-receipt-migration",
        decide: () =>
          Promise.resolve({ kind: "reply" as const, text: "Ready" }),
        review: forbidden,
      },
      model: {
        ...unexpectedModelAuthoring,
        initialize: () => Promise.resolve(admitted.identity),
        readExecutableModel: () => Promise.resolve(structuredClone(admitted)),
        activateCandidate: forbidden,
        applyApprovedChange: forbidden,
        graph: () => Promise.resolve({}),
      },
      runner: { test: forbidden, run: forbidden },
    });
    await runtime.initialize();
    return runtime;
  };
  const legacyProof = f.proof();
  delete legacyProof.caseId;
  delete legacyProof.caseContext;
  // Seed a pre-Cases journal without asking the new registry to execute it.
  await f.worker.submitWork({
    text: "Collecter",
    correlationId: "legacy",
    proof: legacyProof,
  });
  f.worker.finish();
  const legacy = await f.manager.submitWork(
    "worker",
    "Collecter",
    "legacy",
    legacyProof,
  );
  // Even Case #1 is unrelated when it was opened after Cases were introduced.
  const fresh = await openRuntime(null);
  await fresh.submit("Collecter", undefined, undefined, true);
  await fresh.idle();
  f.primary.state = fresh.snapshot;
  equal(f.primary.state.cases![0].number, 1);
  equal(f.primary.state.cases![0].migratedFrom, undefined);
  await rejects(
    () => f.manager.submitWork("worker", "Collecter", "legacy", f.proof()),
    (error: unknown) =>
      error instanceof OperatorConversationError &&
      error.code === "WORK_CONFLICT",
  );

  // initialize() reconstructs the historical caller's dossier and writes its
  // provenance, independently of the system-wide number already allocated.
  const historical: SystemRuntimeState = {
    id: "session-primary",
    revision: 0,
    catalogRevision: 0,
    model: admitted.identity,
    executionModel: admitted,
    messages: [{
      id: "historical-request",
      role: "user",
      text: "Collecter",
      at: "2026-10-21T00:00:00Z",
    }],
    candidates: [],
    events: [],
    busy: false,
    phase: "Continuation pending",
    provider: "legacy",
    conversationCursor: {
      nodeId:
        admitted.flows.conversation.nodes.find((node) =>
          node.mechanism === "choose_move"
        )!.id,
    },
  };
  const migrated = await openRuntime(historical, 6);
  f.primary.state = migrated.snapshot;
  equal(f.primary.state.cases![0].number, 7);
  equal(f.primary.state.cases![0].migratedFrom, "legacy-dossier");
  deepStrictEqual(
    await f.manager.submitWork("worker", "Collecter", "legacy", f.proof()),
    legacy,
  );
  await migrated.closeCase(f.primary.state.cases![0].id, "done", {
    closedBy: "host-owner",
    verdict: "accepted",
  });
  await migrated.submit("A new request", undefined, undefined, true);
  await migrated.idle();
  f.primary.state = migrated.snapshot;
  equal(f.primary.state.cases![1].number, 8);
  equal(f.primary.state.cases![1].migratedFrom, undefined);
  await rejects(
    () => f.manager.submitWork("worker", "Collecter", "legacy", f.proof()),
    (error: unknown) =>
      error instanceof OperatorConversationError &&
      error.code === "WORK_CONFLICT",
  );
  equal(f.worker.calls.length, 1);
  await f.manager.dispose();
});

Deno.test("an observer cannot re-enter an operator reconciliation before its reservation", async () => {
  const primary = new Runtime(model("primary", true, true));
  const manifest = {
    repositoryVersion: "branch:admitted",
    units: [{
      systemQualifiedName: "Example::primary",
      model: primary.snapshot.executionModel!,
    }],
  };
  const manager = new OperatorConversations({ primary });
  const failures: string[] = [];
  manager.onChange(() => {
    void manager.reconcileUnits(manifest).catch(
      (error: OperatorConversationError) => {
        failures.push(error.code);
      },
    );
  });
  await manager.initialize(manifest);
  await Promise.resolve();
  deepStrictEqual(failures, ["RECONCILIATION_BUSY"]);
  await manager.dispose();
});

Deno.test("an agent becoming busy while another session opens cannot be retired", async () => {
  const primary = new Runtime(model("primary", true, true));
  const old = new Runtime(model("old", true));
  const added = new Runtime(model("added", true));
  let release!: (runtime: Runtime) => void;
  const opening = new Promise<Runtime>((resolve) => release = resolve);
  const closed: ConversationRuntime[] = [];
  const manager = new OperatorConversations({
    primary,
    factory: {
      open(unit) {
        return unit.model.identity.builderId === "old"
          ? Promise.resolve(old)
          : opening;
      },
      close(runtime) {
        closed.push(runtime);
        return Promise.resolve();
      },
    },
  });
  const unit = (runtime: Runtime): OperatorConversationUnit => ({
    systemQualifiedName: `Example::${
      runtime.snapshot.executionModel!.identity.builderId
    }`,
    model: runtime.snapshot.executionModel!,
  });
  await manager.initialize({
    repositoryVersion: "branch:admitted",
    units: [unit(primary), unit(old)],
  });
  const reconciliation = manager.reconcileUnits({
    repositoryVersion: "branch:admitted",
    units: [unit(primary), unit(added)],
  });
  await Promise.resolve();
  await manager.submitHuman({
    agentId: "old",
    text: "Travail commencé",
    expectedRevision: 0,
  });
  release(added);
  await rejects(() => reconciliation, /commencé un travail/);
  deepStrictEqual(
    manager.snapshot.conversations.map((entry) => entry.agentId),
    ["primary", "old"],
  );
  deepStrictEqual(closed, [added]);
  old.finish();
  await manager.dispose();
});

Deno.test("an operator manifest cannot use HEAD or replace an unadopted session contract", async () => {
  const f = await fixture();
  await rejects(
    () =>
      f.manager.reconcileUnits({
        repositoryVersion: "branch:head",
        units: f.units,
      }),
    /version source admise/,
  );
  const changed = structuredClone(f.units);
  changed[1]!.model.version.digest = "unadopted";
  await rejects(
    () =>
      f.manager.reconcileUnits({
        repositoryVersion: "branch:admitted",
        units: changed,
      }),
    /admise par la session/,
  );
  equal(f.manager.snapshot.conversations[1]!.modelDigest, "digest-worker");
  await f.manager.dispose();
});

Deno.test("disposing during a pending factory cannot publish or leak the opened runtime", async () => {
  const primary = new Runtime(model("primary", true, true));
  const worker = new Runtime(model("worker"));
  let release!: (runtime: Runtime) => void;
  const opening = new Promise<Runtime>((resolve) => release = resolve);
  const closed: ConversationRuntime[] = [];
  const manager = new OperatorConversations({
    primary,
    factory: {
      open() {
        return opening;
      },
      close(runtime) {
        closed.push(runtime);
        return Promise.resolve();
      },
    },
  });
  const unit = (runtime: Runtime): OperatorConversationUnit => ({
    systemQualifiedName: `Example::${
      runtime.snapshot.executionModel!.identity.builderId
    }`,
    model: runtime.snapshot.executionModel!,
  });
  await manager.initialize({
    repositoryVersion: "branch:admitted",
    units: [unit(primary)],
  });
  const reconciliation = manager.reconcileUnits({
    repositoryVersion: "branch:admitted",
    units: [unit(primary), unit(worker)],
  });
  await Promise.resolve();
  const disposed = manager.dispose();
  release(worker);
  await rejects(() => reconciliation, /Atelier fermé/);
  await disposed;
  equal(manager.snapshot.conversations.length, 0);
  deepStrictEqual(closed, [worker]);
});

Deno.test("removing a running unit is refused; retiring an idle unit closes its runtime", async () => {
  const f = await fixture();
  await f.manager.submitHuman({
    agentId: "second",
    text: "Mission",
    expectedRevision: 0,
  });
  const units = f.units.filter((unit) =>
    unit.model.identity.builderId !== "second"
  );
  await rejects(
    () =>
      f.manager.reconcileUnits({ repositoryVersion: "branch:admitted", units }),
    /en activité/,
  );
  f.second.finish();
  await f.manager.reconcileUnits({
    repositoryVersion: "branch:admitted",
    units,
  });
  equal(f.closed.length, 1);
  deepStrictEqual(
    f.manager.snapshot.conversations.map((entry) => entry.agentId),
    ["primary", "worker"],
  );
  await f.manager.dispose();
});

Deno.test("review audit exposes recorded decisions without manufacturing a transcript or contact right", () => {
  const runtime = new Runtime(model("primary", true, true));
  const state = runtime.state;
  state.executionModel!.identity.reviewerId = "native-reviewer";
  state.executionModel!.configuration.reviewer = {
    id: "reviewer-config",
    name: "Relecteur",
    mandateRevision: 1,
  };
  const candidate = {
    id: "candidate",
    caseId: "candidate-case",
    name: "Lecteur",
    digest: "exact",
    stage: "active" as const,
    description: "read",
    kind: "read_web_page" as const,
    code: "module",
    createdAt: "earlier",
    baseCatalogRevision: 0,
    review: {
      candidateDigest: "exact",
      verdict: "approve" as const,
      reason: "Trois essais revus.",
    },
    reviewExecution: {
      modelDigest: "old-admitted",
      actionId: "review-action",
      reviewerId: "reviewer-config",
      testsDigest: "tests",
      contractDigest: "contract",
    },
  };
  state.candidates.push(candidate);
  equal(reviewerConversation(state)!.messages.length, 0);
  state.events.push({
    id: "review-event",
    caseId: "review-event-case",
    at: "recorded-at",
    kind: "review-decided",
    label: "reviewed",
    candidateId: "candidate",
    execution: { digest: "old-admitted", actionId: "review-action" },
  });
  const audit = reviewerConversation(state)!;
  equal(audit.nativeId, "native-reviewer");
  equal(audit.canSend, false);
  equal(audit.runtimeOwned, false);
  equal(audit.messages.length, 1);
  equal(audit.messages[0]!.at, "recorded-at");
  equal(audit.messages[0]!.caseId, "review-event-case");
  equal(audit.messages[0]!.execution!.digest, "old-admitted");
  equal(audit.messages[0]!.text, "Lecteur · approve\nTrois essais revus.");
  delete state.events[0]!.caseId;
  equal("caseId" in reviewerConversation(state)!.messages[0]!, false);
  state.candidates[0]!.review!.candidateDigest = "not-the-candidate";
  equal(reviewerConversation(state)!.messages.length, 0);
});

function tool(id: string, digest: string, caseId: string) {
  return {
    id,
    digest,
    caseId,
    name: "Même nom d’outil",
    description: "Un artefact exact",
    kind: "read_web_page" as const,
    code: "export default () => ({title:'Title',text:'Text'})",
    stage: "awaiting-admission" as const,
    createdAt: "recorded",
    baseCatalogRevision: 0,
    requiredAuthority: "human" as const,
  };
}

Deno.test("operator catalog retains owner occurrences and does not merge equal names or digests", async () => {
  const f = await fixture();
  f.primary.state.candidates.push(
    tool("same-id", "same-digest", "primary-request"),
  );
  f.worker.state.candidates.push(
    tool("same-id", "same-digest", "primary-request"),
  );
  f.primary.state.executionModel!.identity.reviewerId = "reviewer-native";
  f.primary.state.executionModel!.configuration.reviewer = {
    id: "reviewer",
    name: "Relecteur",
    mandateRevision: 1,
  };
  const snapshot = f.manager.catalogSnapshot;
  equal(snapshot.systemId, "session-primary");
  equal(snapshot.tools.length, 2);
  deepStrictEqual(snapshot.tools.map((entry) => entry.agentId), [
    "primary",
    "worker",
  ]);
  deepStrictEqual(snapshot.tools.map((entry) => entry.agentName), [
    "primary",
    "worker",
  ]);
  snapshot.tools[0]!.candidate.name = "Mutated read";
  equal(f.primary.snapshot.candidates[0]!.name, "Même nom d’outil");
  equal(f.primary.decisions.length + f.worker.decisions.length, 0);
  await f.manager.dispose();
});

Deno.test("operator catalog reports actual model consultations per runtime and changes identity when availability changes", async () => {
  const f = await fixture();
  f.primary.state.modelTools = modelContextTools();
  f.worker.state.modelTools = modelContextTools();
  const before = f.manager.catalogSnapshot;
  equal(before.tools.length, 0);
  equal(before.modelTools!.length, 12);
  deepStrictEqual([
    ...new Set(before.modelTools!.map((entry) => entry.agentId)),
  ], ["primary", "worker"]);
  before.modelTools![0].tool.name = "Mutated presentation";
  equal(f.primary.snapshot.modelTools![0].name, modelContextTools()[0].name);
  f.worker.state.modelTools = [];
  const after = f.manager.catalogSnapshot;
  equal(after.modelTools!.length, 6);
  equal(after.modelTools!.every((entry) => entry.agentId === "primary"), true);
  equal(after.version === before.version, false);
  equal(f.primary.decisions.length + f.worker.decisions.length, 0);
  await f.manager.dispose();
});

Deno.test("human admission targets a peer-only operator without granting a conversation entry", async () => {
  const f = await fixture();
  f.primary.state.candidates.push(
    tool("same-id", "primary-artifact", "primary-request"),
  );
  delegated(f.worker.state, caseExecutionContext(f.primary.state)!);
  f.worker.state.candidates.push(
    tool("same-id", "worker-artifact", "primary-request"),
  );
  equal(
    f.manager.snapshot.conversations.find((entry) =>
      entry.agentId === "worker"
    )!.canSend,
    false,
  );
  await f.manager.decideCandidate({
    agentId: "worker",
    candidateId: "same-id",
    candidateDigest: "worker-artifact",
    expectedRevision: 0,
    verdict: "approve",
    reason: "  Admission explicite.  ",
  });
  equal(f.primary.decisions.length, 0);
  deepStrictEqual(f.worker.decisions, [{
    candidateId: "same-id",
    candidateDigest: "worker-artifact",
    verdict: "approve",
    reason: "Admission explicite.",
  }]);
  equal(
    f.manager.snapshot.conversations.find((entry) =>
      entry.agentId === "worker"
    )!.canSend,
    false,
  );
  await f.manager.dispose();
});

Deno.test("bounded candidate inspection and admission route the host actor to the exact operator and Request", async () => {
  const f = await fixture();
  delegated(f.worker.state, caseExecutionContext(f.primary.state)!);
  f.worker.state.candidates.push(
    tool("same-id", "worker-artifact", "primary-request"),
  );
  f.primary.state.candidates.push(
    tool("same-id", "primary-artifact", "primary-request"),
  );
  const reference = {
    agentId: "worker",
    candidateId: "same-id",
    candidateDigest: "worker-artifact",
    expectedRevision: 0,
    caseId: "primary-request",
  };
  const actor = {
    actorId: "primary",
    policyId: "tool-admission",
    policyRevision: 1,
  };
  const inspection = await f.manager.inspectCandidate(reference, actor);
  equal(inspection.operatorId, "worker");
  equal(inspection.candidate.digest, "worker-artifact");
  equal(f.primary.inspections.length, 0);
  deepStrictEqual(f.worker.inspections, [{
    candidateId: "same-id",
    candidateDigest: "worker-artifact",
    caseId: "primary-request",
    delegated: actor,
  }]);
  await f.manager.decideCandidate({
    ...reference,
    verdict: "approve",
    reason: "Exact inspection",
  }, actor);
  deepStrictEqual(f.worker.candidateActors, [actor]);
  equal(f.primary.decisions.length, 0);
  for (
    const patch of [{ caseId: "other-request" }, {
      candidateDigest: "primary-artifact",
    }, { expectedRevision: 1 }]
  ) {
    await rejects(
      () => f.manager.inspectCandidate({ ...reference, ...patch }, actor),
      OperatorConversationError,
    );
  }
  await rejects(
    () =>
      f.manager.decideCandidate({
        ...reference,
        caseId: "other-request",
        verdict: "approve",
        reason: "Wrong Request",
      }, actor),
    OperatorConversationError,
  );
  equal(f.worker.inspections.length, 1);
  equal(f.worker.decisions.length, 1);
  await f.manager.dispose();
});

Deno.test("a specialist cannot resume candidate admission after its central Case closes", async () => {
  for (const status of ["closed-done", "closed-abandoned"] as const) {
    const f = await fixture();
    const central = {
      id: "session-primary:case:1",
      number: 1,
      type: "request" as const,
      objective: "Travail délégué",
      owner: "primary",
      openedBy: "primary",
      openedFrom: { conversationId: "session-primary" },
      modelPin: f.proof().modelVersion,
      status: "waiting" as const,
      createdAt: "2026-10-21T00:00:00Z",
    };
    f.primary.state.cases = [central];
    f.primary.state.caseInvocation = { kind: "local", caseId: central.id };
    delegated(f.worker.state, caseExecutionContext(f.primary.state)!);
    f.worker.state.candidates.push(
      tool("waiting-worker", "worker-digest", central.id),
    );
    const command: OperatorCandidateDecision = {
      agentId: "worker",
      candidateId: "waiting-worker",
      candidateDigest: "worker-digest",
      expectedRevision: 0,
      verdict: "approve",
      reason: "Reprendre le travail autorisé",
    };
    await f.manager.decideCandidate(command);
    equal(f.worker.decisions.length, 1);
    f.primary.state.cases = [{
      ...central,
      status,
      closedAt: "2026-10-21T00:01:00Z",
    }];
    delete f.primary.state.caseInvocation;
    await rejects(
      () => f.manager.decideCandidate(command),
      (error: unknown) =>
        error instanceof OperatorConversationError &&
        error.code === "WORK_CASE_INACTIVE",
    );
    equal(f.worker.decisions.length, 1);
    await f.manager.dispose();
  }
});

async function delegatedCaseFixture() {
  const f = await fixture();
  const central = {
    id: "session-primary:case:1",
    number: 1,
    type: "request" as const,
    objective: "Travail délégué",
    owner: "primary",
    openedBy: "primary",
    openedFrom: { conversationId: "session-primary" },
    modelPin: f.proof().modelVersion,
    status: "waiting" as const,
    createdAt: "2026-10-21T00:00:00Z",
  };
  f.primary.state.cases = [central];
  f.primary.state.caseInvocation = { kind: "local", caseId: central.id };
  delegated(f.worker.state, caseExecutionContext(f.primary.state)!);
  f.worker.state.candidates.push(
    tool("waiting-worker", "worker-digest", central.id),
  );
  f.worker.state.configuration!.changes = [{
    id: "waiting-change",
    requestedBy: "worker",
    caseId: central.id,
    requestedRights: { addNetworkHosts: ["example.org"] },
    kind: "mandate-change",
    status: "pending",
    baseRevision: 0,
    reason: "Travail délégué",
    requestedAt: "2026-10-21T00:00:00Z",
  }];
  return {
    ...f,
    central,
    resume(kind: "candidate" | "change") {
      return kind === "candidate"
        ? f.manager.decideCandidate({
          agentId: "worker",
          candidateId: "waiting-worker",
          candidateDigest: "worker-digest",
          expectedRevision: 0,
          verdict: "approve",
          reason: "Reprendre le travail autorisé",
        })
        : f.manager.decideChange({
          agentId: "worker",
          changeId: "waiting-change",
          configurationRevision: 0,
          expectedRevision: 0,
          verdict: "approve",
        });
    },
  };
}

function caseBusy(error: unknown): boolean {
  return error instanceof OperatorConversationError &&
    error.code === "CASE_BUSY";
}

function pendingCandidateRecovery(
  f: Awaited<ReturnType<typeof delegatedCaseFixture>>,
) {
  const invocation = f.worker.state.caseInvocation;
  ok(invocation?.kind === "delegated");
  const candidate = f.worker.state.candidates[0];
  const source: OperatorWorkMessage = {
    id: "input",
    role: "tool",
    text: "Exact fixture contribution",
    at: "now",
    caseId: f.central.id,
    work: structuredClone(invocation.work),
  };
  f.worker.state.messages.push(source);
  candidate.admissionContinuation = {
    modelDigest: "digest-worker",
    fingerprint: "exact-contribution",
    inputMessageId: "input",
    messageStart: 0,
    priorCandidateIds: [],
    work: {
      receipt: structuredClone(invocation.work),
      messageRanges: [],
      candidateIds: [candidate.id],
    },
  };
}

/** Expected registry boundary request from the original persisted work receipt;
 * no accepted DTO, queue claim or native checkpoint is manufactured here. */
async function expectedCandidateRecovery(
  f: Awaited<ReturnType<typeof delegatedCaseFixture>>,
): Promise<CandidateRecoveryCommand> {
  const candidate = f.worker.state.candidates.find((value) =>
    value.id === "waiting-worker"
  );
  const continuation = candidate?.admissionContinuation;
  const receipt = continuation?.work?.receipt;
  ok(candidate && continuation && receipt?.caseContext);
  return {
    kind: "resume-candidate-continuation",
    candidateId: "waiting-worker",
    invocationKey: invocationKey({
      kind: "delegated",
      work: { ...receipt, caseContext: receipt.caseContext },
    }),
    inputMessageId: continuation.inputMessageId,
    continuationDigest: await executionDigest(continuation),
  };
}

function pendingDelegateActivation(
  f: Awaited<ReturnType<typeof delegatedCaseFixture>>,
) {
  const candidate = f.worker.state.candidates[0];
  candidate.stage = "activating";
  candidate.activationModelDigest = "digest-worker";
  candidate.admission = {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    authority: "delegate",
    actorId: "primary",
    mandateRevision: 1,
    configurationRevision: 0,
    at: "2026-10-26T00:00:00Z",
    reason: "Exact candidate admitted",
  };
}

function candidatePublicationInput(
  f: Awaited<ReturnType<typeof delegatedCaseFixture>>,
) {
  const candidate = f.worker.state.candidates[0];
  return {
    agentId: "worker",
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    caseId: candidate.caseId!,
  };
}

Deno.test("delegated publication uses a reentrant Case lease inside an already reserved busy target", async () => {
  const f = await delegatedCaseFixture();
  pendingDelegateActivation(f);
  let publications = 0;
  f.worker.decisionStep = async () => {
    f.worker.state.busy = true;
    const result = await f.manager.withCandidatePublication(
      candidatePublicationInput(f),
      async () => {
        publications++;
        await rejects(
          () =>
            f.manager.withCaseClosure(f.central.id, () => Promise.resolve()),
          caseBusy,
        );
        return "published";
      },
    );
    equal(result, "published");
    f.worker.state.busy = false;
  };
  await f.resume("candidate");
  equal(publications, 1);
  await f.manager.withCaseClosure(f.central.id, () => Promise.resolve());
  await f.manager.dispose();
});

Deno.test("finishing an admitted publication preserves another selected Case cursor and budget", async () => {
  const f = await delegatedCaseFixture();
  pendingDelegateActivation(f);
  f.worker.state.busy = true;
  f.worker.state.caseInvocation = { kind: "local", caseId: "other-request" };
  f.worker.state.conversationCursor = { nodeId: "other-request-cursor" };
  f.worker.state.conversationContext = { request: "another contribution" };
  f.worker.state.workBudgetBinding = {
    budgetId: "other-budget",
    scopeId: "other-scope",
  };
  const before = f.worker.snapshot;
  let publications = 0;
  await f.manager.withCandidatePublication(candidatePublicationInput(f), () => {
    publications++;
    return Promise.resolve();
  });
  equal(publications, 1);
  deepStrictEqual(f.worker.snapshot, before);
  f.worker.state.busy = false;
  await f.manager.dispose();
});

Deno.test("a done Request may finish its admitted publication under the closure lease", async () => {
  const f = await delegatedCaseFixture();
  pendingDelegateActivation(f);
  f.primary.state.cases![0].status = "closed-done";
  let publications = 0;
  let release!: () => void;
  const gate = new Promise<string>((resolve) =>
    release = () => resolve("published")
  );
  const pending = f.manager.withCandidatePublication(
    candidatePublicationInput(f),
    () => {
      publications++;
      return gate;
    },
  );
  equal(publications, 1);
  await rejects(
    () => f.manager.withCaseClosure(f.central.id, () => Promise.resolve()),
    caseBusy,
  );
  release();
  equal(await pending, "published");
  await f.manager.withCaseClosure(f.central.id, () => Promise.resolve());
  await f.manager.dispose();
});

Deno.test("abandoned, unavailable, ambiguous or closing Requests cannot publish a delegated candidate", async () => {
  for (
    const refusal of ["abandoned", "missing", "ambiguous", "closing"] as const
  ) {
    const f = await delegatedCaseFixture();
    pendingDelegateActivation(f);
    if (refusal === "abandoned") {
      f.primary.state.cases![0].status = "closed-abandoned";
    }
    if (refusal === "missing") f.primary.state.cases = [];
    if (refusal === "ambiguous") {
      f.primary.state.cases!.push(structuredClone(f.central));
    }
    let release: (() => void) | undefined;
    const closing = refusal === "closing"
      ? f.manager.withCaseClosure(
        f.central.id,
        () => new Promise<void>((resolve) => release = resolve),
      )
      : undefined;
    let publications = 0;
    await rejects(
      () =>
        f.manager.withCandidatePublication(candidatePublicationInput(f), () => {
          publications++;
          return Promise.resolve();
        }),
      (error: unknown) => {
        if (refusal === "abandoned") {
          return error instanceof CandidateActivationError &&
            error.code === "CASE_ABANDONED";
        }
        return error instanceof OperatorConversationError &&
          error.code ===
            (refusal === "closing" ? "CASE_BUSY" : "WORK_CASE_INACTIVE");
      },
    );
    equal(publications, 0);
    release?.();
    await closing;
    await f.manager.dispose();
  }
});

Deno.test("workspace recovery enqueues only exact marked peer candidate continuations", async () => {
  const f = await delegatedCaseFixture();
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(f.worker.candidateContinuations, []);
  pendingCandidateRecovery(f);
  const expected = await expectedCandidateRecovery(f);
  f.primary.state.candidates.push({
    ...structuredClone(f.worker.state.candidates[0]),
    caseId: f.central.id,
  });
  const before = f.worker.snapshot;
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(f.worker.candidateContinuations, [expected]);
  deepStrictEqual(f.primary.candidateContinuations, []);
  deepStrictEqual(f.second.candidateContinuations, []);
  deepStrictEqual(f.worker.state.caseInvocation, before.caseInvocation);
  deepStrictEqual(f.worker.state.messages, before.messages);
  deepStrictEqual(f.worker.resumeOptions, []);
  deepStrictEqual(f.primary.resumeOptions, []);
  deepStrictEqual(f.second.resumeOptions, []);
  await f.manager.dispose();
});

Deno.test("workspace recovers a delegated activation intent even without a conversation marker", async () => {
  const f = await delegatedCaseFixture();
  pendingDelegateActivation(f);
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(f.worker.settledActivations, [{ caseId: f.central.id }]);
  deepStrictEqual(f.worker.candidateContinuations, []);
  deepStrictEqual(f.worker.resumeOptions, []);
  await f.manager.dispose();
});

Deno.test("closed authoritative Requests distinguish done from abandonment before any native resume even with a stale invocation", async () => {
  for (const status of ["closed-done", "closed-abandoned"] as const) {
    const f = await delegatedCaseFixture();
    pendingCandidateRecovery(f);
    pendingDelegateActivation(f);
    f.primary.state.cases![0].status = status;
    f.worker.state.caseInvocation = {
      kind: "local",
      caseId: "new-unrelated-request",
    };
    let builds = 0, providerCalls = 0;
    f.worker.settleStep = (input) => {
      equal(input.abandon, status === "closed-abandoned");
      equal(input.closed, true);
      return Promise.resolve();
    };
    f.worker.enqueueStep = () => {
      builds++;
      providerCalls++;
      return Promise.resolve();
    };
    await f.manager.resumeCandidateContinuations();
    deepStrictEqual(f.worker.settledActivations, [{
      caseId: f.central.id,
      abandon: status === "closed-abandoned",
      closed: true,
    }]);
    deepStrictEqual(f.worker.candidateContinuations, []);
    deepStrictEqual(f.worker.resumeOptions, []);
    equal(builds, 0);
    equal(providerCalls, 0);
    await f.manager.dispose();
  }
});

Deno.test("a delegated activation with no registered authoritative Request remains pending", async () => {
  const f = await delegatedCaseFixture();
  pendingDelegateActivation(f);
  f.primary.state.cases = [];
  const before = f.worker.snapshot;
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(f.worker.snapshot, before);
  deepStrictEqual(f.worker.settledActivations, []);
  deepStrictEqual(f.worker.candidateContinuations, []);
  deepStrictEqual(f.worker.resumeOptions, []);
  await f.manager.dispose();
});

Deno.test("a stale settled marker cannot block the current Request recovery or activate its former Case", async () => {
  const f = await delegatedCaseFixture();
  pendingCandidateRecovery(f);
  const stale = {
    ...structuredClone(f.worker.state.candidates[0]),
    id: "settled-old-candidate",
    caseId: "old-request",
    stage: "active" as const,
  };
  f.worker.state.candidates.unshift(stale);
  f.primary.state.cases!.push({
    ...structuredClone(f.central),
    id: "old-request",
    number: 2,
    status: "closed-done",
  });
  f.primary.state.executionModel!.workBudgetPolicy = {
    id: "case-budget",
    revision: 1,
    elementId: "native-budget",
    sourceIds: ["native-budget"],
    unit: "agent-invocation",
    limit: 8,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  f.primary.state.cases![0].budget = {
    budgetId: "case-budget",
    scopeId: f.central.id,
  };
  delegated(f.worker.state, caseExecutionContext(f.primary.state)!);
  f.primary.state.executionModel!.workBudgetPolicy!.limit = 3;
  const activationCases: string[] = [];
  const queuedCases: string[] = [];
  f.worker.settleStep = (input) => {
    if (input.closed) {
      equal(input.caseId, stale.caseId);
      delete stale.admissionContinuation;
      return Promise.resolve();
    }
    activationCases.push(input.caseId);
    equal(input.caseId, f.central.id);
    equal(caseExecutionContext(f.worker.state)!.budget!.policy.limit, 3);
    return Promise.resolve();
  };
  const expected = await expectedCandidateRecovery(f);
  f.worker.enqueueStep = (command) => {
    deepStrictEqual(command, expected);
    queuedCases.push(caseExecutionContext(f.worker.state)!.caseId);
    return Promise.resolve();
  };
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(activationCases, [f.central.id]);
  deepStrictEqual(queuedCases, [f.central.id]);
  deepStrictEqual(f.worker.candidateContinuations, [expected]);
  deepStrictEqual(f.worker.resumeOptions, []);
  await f.manager.withCandidateContinuation(f.central.id, async (context) => {
    equal(context.budget!.policy.limit, 3);
    await rejects(
      () => f.manager.withCaseClosure(f.central.id, () => Promise.resolve()),
      caseBusy,
    );
  });
  equal(stale.admissionContinuation, undefined);
  await f.manager.dispose();
});

Deno.test("interrupted delegate intentions settle independently per Case before only the current continuation resumes", async () => {
  const f = await delegatedCaseFixture();
  pendingDelegateActivation(f);
  pendingCandidateRecovery(f);
  const historical = structuredClone(f.worker.state.candidates[0]);
  historical.id = "historical-intent";
  historical.caseId = "historical-request";
  historical.admission!.candidateId = historical.id;
  f.worker.state.candidates.push(historical);
  f.primary.state.cases!.push({
    ...structuredClone(f.central),
    id: historical.caseId,
    number: 2,
  });
  f.worker.state.error = "The current Request keeps its diagnostic";
  f.worker.state.conversationCursor = { nodeId: "current-cursor" };
  f.worker.state.conversationContext = { current: "B" };
  f.worker.state.workBudgetBinding = {
    budgetId: "budget-B",
    scopeId: f.central.id,
  };
  const before = f.worker.snapshot;
  const publications: string[] = [];
  f.worker.settleStep = async ({ caseId }) => {
    const candidate = f.worker.state.candidates.find((value) =>
      value.caseId === caseId
    )!;
    await f.manager.withCandidatePublication({
      agentId: "worker",
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      caseId,
    }, async () => {
      await rejects(
        () => f.manager.withCaseClosure(caseId, () => Promise.resolve()),
        caseBusy,
      );
      equal(caseExecutionContext(f.worker.state)!.caseId, f.central.id);
      publications.push(caseId);
      candidate.stage = "active";
      delete candidate.activationModelDigest;
    });
  };
  const queuedCases: string[] = [];
  const expected = await expectedCandidateRecovery(f);
  f.worker.enqueueStep = (command) => {
    equal(
      f.worker.state.candidates.every((candidate) =>
        candidate.stage === "active"
      ),
      true,
    );
    deepStrictEqual(command, expected);
    queuedCases.push(caseExecutionContext(f.worker.state)!.caseId);
    return Promise.resolve();
  };
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(publications, [f.central.id, historical.caseId]);
  deepStrictEqual(queuedCases, [f.central.id]);
  deepStrictEqual(f.worker.candidateContinuations, [expected]);
  deepStrictEqual(f.worker.resumeOptions, []);
  for (
    const field of [
      "caseInvocation",
      "conversationCursor",
      "conversationContext",
      "workBudgetBinding",
      "error",
    ] as const
  ) {
    deepStrictEqual(f.worker.snapshot[field], before[field]);
  }
  await f.manager.dispose();
});

Deno.test("a missing or reserved historical Case cannot block the current Case recovery", async () => {
  for (const unavailable of ["missing", "closing"] as const) {
    const f = await delegatedCaseFixture();
    pendingDelegateActivation(f);
    pendingCandidateRecovery(f);
    const historical = structuredClone(f.worker.state.candidates[0]);
    historical.id = "blocked-intent";
    historical.caseId = "blocked-request";
    historical.admission!.candidateId = historical.id;
    f.worker.state.candidates.unshift(historical);
    if (unavailable === "closing") {
      f.primary.state.cases!.push({
        ...structuredClone(f.central),
        id: historical.caseId,
        number: 2,
      });
    }
    let release: (() => void) | undefined;
    const closing = unavailable === "closing"
      ? f.manager.withCaseClosure(
        historical.caseId,
        () => new Promise<void>((resolve) => release = resolve),
      )
      : undefined;
    const queuedCases: string[] = [];
    const expected = await expectedCandidateRecovery(f);
    f.worker.settleStep = ({ caseId }) => {
      const candidate = f.worker.state.candidates.find((value) =>
        value.caseId === caseId
      )!;
      candidate.stage = "active";
      delete candidate.activationModelDigest;
      return Promise.resolve();
    };
    f.worker.enqueueStep = (command) => {
      deepStrictEqual(command, expected);
      queuedCases.push(caseExecutionContext(f.worker.state)!.caseId);
      return Promise.resolve();
    };
    await f.manager.resumeCandidateContinuations();
    deepStrictEqual(f.worker.settledActivations, [{ caseId: f.central.id }]);
    deepStrictEqual(queuedCases, [f.central.id]);
    deepStrictEqual(f.worker.candidateContinuations, [expected]);
    deepStrictEqual(f.worker.resumeOptions, []);
    equal(historical.stage, "activating");
    release?.();
    await closing;
    await f.manager.dispose();
  }
});

Deno.test("real native activation recovery drives different Cases without selecting old conversation state", async () => {
  const primary = new Runtime(model("primary", true, true));
  const native = model("worker");
  const initial = new Runtime(native).snapshot;
  initial.cases = ["A", "B"].map((id, index) => ({
    id,
    number: index + 1,
    type: "request" as const,
    owner: "worker",
    objective: `Request ${id}`,
    openedBy: "primary",
    openedFrom: { conversationId: primary.state.id },
    modelPin: structuredClone(native.version),
    status: "waiting" as const,
    createdAt: "2026-10-26T00:00:00Z",
  }));
  initial.caseInvocation = { kind: "local", caseId: "B" };
  initial.conversationCursor = { nodeId: "current-B" };
  initial.conversationContext = { current: "B" };
  initial.conversationFlow = structuredClone(native.flows.conversation);
  initial.error = "Current B diagnostic";
  initial.workBudgetBinding = { budgetId: "B-budget", scopeId: "B" };
  initial.candidates = await Promise.all(["A", "B"].map(async (caseId) => {
    const draft = {
      name: `reader-${caseId}`,
      description: "Exact reader",
      kind: "read_web_page" as const,
      code: "export default () => ({title:'Title',text:'Text'})",
    };
    const digest = await draftDigest(draft);
    return {
      ...draft,
      id: `candidate-${caseId}`,
      digest,
      caseId,
      stage: "activating" as const,
      createdAt: "2026-10-26T00:00:00Z",
      requiredAuthority: "human" as const,
      baseCatalogRevision: 0,
      activationModelDigest: native.version.digest,
      tests: {
        passed: true,
        checks: [{ name: "tested", passed: true, detail: "Exact fixture" }],
      },
      admission: {
        candidateId: `candidate-${caseId}`,
        candidateDigest: digest,
        authority: "delegate" as const,
        actorId: "primary",
        mandateRevision: 1,
        configurationRevision: 0,
        reason: "Exact admission",
        at: "2026-10-26T00:00:00Z",
      },
    };
  }));
  let saved = initial;
  const publications: string[] = [];
  const forbidden = () => {
    throw new Error(
      "Recovery must not replay a provider, test or other native effect",
    );
  };
  const worker = new SystemRuntime({
    store: {
      load: () => Promise.resolve(structuredClone(saved)),
      save(state, expected) {
        equal(saved.revision, expected);
        saved = structuredClone(state);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    },
    agents: {
      label: "native-case-recovery",
      decide: forbidden,
      review: forbidden,
    },
    runner: { test: forbidden, run: forbidden },
    model: {
      ...unexpectedModelAuthoring,
      initialize: () => Promise.resolve(native.identity),
      readExecutableModel: () => Promise.resolve(structuredClone(native)),
      activateCandidate(_identity, candidate) {
        publications.push(candidate.caseId!);
        const binding = {
          elementId: `native-${candidate.id}`,
          graphPath: candidate.id,
        };
        native.catalog.push({
          nativeId: binding.elementId,
          candidateId: candidate.id,
          digest: candidate.digest,
          name: candidate.name,
          kind: candidate.kind,
          status: "active",
          contractId: native.contracts[0].nativeId,
        });
        return Promise.resolve(binding);
      },
      findCandidate(_identity, candidate) {
        const entry = native.catalog.find((value) =>
          value.candidateId === candidate.id
        );
        return Promise.resolve(
          entry ? { elementId: entry.nativeId, graphPath: candidate.id } : null,
        );
      },
      graph: () => Promise.resolve({}),
      applyApprovedChange: forbidden,
    },
  });
  await worker.initialize(native, { resumeCandidateContinuations: false });
  const before = worker.snapshot;
  const manager = new OperatorConversations({
    primary,
    factory: { open: () => Promise.resolve(worker) },
  });
  await manager.initialize({
    repositoryVersion: "branch:admitted",
    units: [primary, worker].map((runtime) => ({
      systemQualifiedName: `Example::${
        runtime.snapshot.executionModel!.identity.builderId
      }`,
      model: runtime.snapshot.executionModel!,
    })),
  });
  worker.bindOperatorRegistry(manager);
  await manager.resumeCandidateContinuations();
  equal(worker.snapshot.candidates[0].stage, "active");
  equal(worker.snapshot.candidates[1].stage, "failed");
  equal(worker.snapshot.candidates[1].errorCode, "CATALOG_BASE_CHANGED");
  deepStrictEqual(publications, ["A"]);
  for (
    const field of [
      "caseInvocation",
      "conversationCursor",
      "conversationContext",
      "conversationFlow",
      "workBudgetBinding",
      "error",
    ] as const
  ) {
    deepStrictEqual(worker.snapshot[field], before[field]);
  }
  await manager.dispose();
});

Deno.test("closed, busy or closing central Requests leave candidate recovery pending without invoking the peer", async () => {
  for (
    const refusal of [
      "closed-done",
      "closed-abandoned",
      "peer-busy",
      "closing",
    ] as const
  ) {
    const f = await delegatedCaseFixture();
    pendingCandidateRecovery(f);
    if (refusal === "peer-busy") f.worker.state.busy = true;
    else if (refusal !== "closing") f.primary.state.cases![0].status = refusal;
    let release: (() => void) | undefined;
    const closing = refusal === "closing"
      ? f.manager.withCaseClosure(
        f.central.id,
        () => new Promise<void>((resolve) => release = resolve),
      )
      : undefined;
    const before = f.worker.snapshot;
    await f.manager.resumeCandidateContinuations();
    deepStrictEqual(f.worker.candidateContinuations, []);
    deepStrictEqual(f.worker.resumeOptions, []);
    deepStrictEqual(f.worker.snapshot, before);
    release?.();
    await closing;
    f.worker.state.busy = false;
    await f.manager.dispose();
  }
});

Deno.test("candidate recovery enqueues exact work before its worker leases the current central budget", async () => {
  const f = await delegatedCaseFixture();
  pendingCandidateRecovery(f);
  f.primary.state.executionModel!.workBudgetPolicy = {
    id: "case-budget",
    revision: 1,
    elementId: "native-budget",
    sourceIds: ["native-budget"],
    unit: "agent-invocation",
    limit: 8,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  f.primary.state.cases![0].budget = {
    budgetId: "case-budget",
    scopeId: f.central.id,
  };
  delegated(f.worker.state, caseExecutionContext(f.primary.state)!);
  f.primary.state.executionModel!.workBudgetPolicy!.limit = 3;
  const expected = await expectedCandidateRecovery(f);
  f.worker.settleStep = () => {
    equal(caseExecutionContext(f.worker.state)!.budget!.policy.limit, 3);
    equal(f.worker.candidateContinuations.length, 0);
    return Promise.resolve();
  };
  f.worker.enqueueStep = async (command) => {
    deepStrictEqual(command, expected);
    // Queue acceptance does not hold the Case lease until a future worker runs.
    await f.manager.withCaseClosure(f.central.id, () => Promise.resolve());
  };
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(f.worker.candidateContinuations, [expected]);
  deepStrictEqual(f.worker.resumeOptions, []);
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const workerLease = f.manager.withCandidateContinuation(
    f.central.id,
    async (context) => {
      entered = true;
      equal(context.budget!.policy.limit, 3);
      // The worker owns its local busy flag while holding this real registry lease.
      // No native execution or queue claim is modeled by this boundary double.
      f.worker.state.busy = true;
      try {
        await gate;
      } finally {
        f.worker.state.busy = false;
      }
    },
  );
  ok(entered);
  await rejects(
    () => f.manager.withCaseClosure(f.central.id, () => Promise.resolve()),
    caseBusy,
  );
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(f.worker.candidateContinuations, [expected]);
  release();
  await workerLease;
  await f.manager.withCaseClosure(f.central.id, () => Promise.resolve());
  await f.manager.dispose();
});

Deno.test("a delegated admission or change reserves its Case until the resumed runtime settles", async () => {
  for (const kind of ["candidate", "change"] as const) {
    const f = await delegatedCaseFixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => release = resolve);
    f.worker.decisionStep = f.worker.changeDecisionStep = () => gate;
    const pending = f.resume(kind);
    equal(f.worker.decisions.length + f.worker.changeDecisions.length, 1);
    let closures = 0;
    await rejects(
      () =>
        f.manager.withCaseClosure(f.central.id, () => {
          closures++;
          return Promise.resolve();
        }),
      caseBusy,
    );
    equal(closures, 0);
    release();
    await pending;
    await f.manager.withCaseClosure(f.central.id, () => {
      closures++;
      return Promise.resolve();
    });
    equal(closures, 1);
    await f.manager.dispose();
  }
});

Deno.test("registry refresh selects the persisted exact candidate invocation after switching Requests", async () => {
  const f = await delegatedCaseFixture();
  const original = f.worker.state.caseInvocation;
  ok(original?.kind === "delegated");
  f.worker.state.messages.push({
    id: "work-A",
    role: "tool",
    text: "A",
    at: "now",
    work: original.work,
  });
  const completion: OperatorWorkCompletion = {
    id: "completion-A",
    kind: "operator-work-waiting",
    label: "A",
    at: "now",
    work: {
      caseId: f.central.id,
      callerId: original.work.callerId,
      correlationId: original.work.correlationId,
      fingerprint: original.work.fingerprint,
      status: "waiting",
      continuation: "A",
      candidateIds: ["waiting-worker"],
      messageCount: 1,
      revision: 0,
      modelVersion: original.work.modelVersion,
    },
  };
  f.worker.state.events.push(completion);
  f.worker.state.conversationCursor = { nodeId: "A-suspended" };
  f.worker.state.cases = [];
  selectHumanRequestCase(f.worker.state, { objective: "B", messageId: "B" }, {
    now: () => "2026-10-27T00:00:00.000Z",
  }, 2);
  f.worker.state.conversationCursor = { nodeId: "B-suspended" };
  const refreshed: string[] = [];
  f.worker.refreshCaseContext = (
    context: CaseExecutionContext,
    candidateId?: string,
  ) => {
    equal(candidateId, "waiting-worker");
    const invocation = candidateCaseInvocation(
      f.worker.state,
      f.worker.state.candidates[0],
    );
    ok(invocation?.kind === "delegated");
    selectCaseInvocation(f.worker.state, invocation);
    f.worker.state.caseInvocation = {
      kind: "delegated",
      work: { ...invocation.work, caseContext: structuredClone(context) },
    };
    refreshed.push(context.caseId);
    return Promise.resolve();
  };
  f.worker.decisionStep = async () => {
    deepStrictEqual(f.worker.state.conversationCursor, {
      nodeId: "A-suspended",
    });
    await rejects(
      () => f.manager.withCaseClosure(f.central.id, () => Promise.resolve()),
      caseBusy,
    );
  };
  await f.resume("candidate");
  deepStrictEqual(refreshed, [f.central.id]);
  equal(f.worker.decisions.length, 1);
  await f.manager.dispose();
});

Deno.test("a parked admission intent settles while another contribution to the same Request remains selected", async () => {
  const f = await delegatedCaseFixture();
  pendingDelegateActivation(f);
  const original = f.worker.state.caseInvocation;
  ok(original?.kind === "delegated");
  f.worker.state.messages.push({
    id: "input-A",
    role: "tool",
    text: "A",
    at: "now",
    work: original.work,
  });
  const candidate = f.worker.state.candidates[0];
  candidate.admissionContinuation = {
    modelDigest: "digest-worker",
    fingerprint: "A",
    inputMessageId: "input-A",
    messageStart: 0,
    priorCandidateIds: [],
    work: {
      receipt: original.work,
      messageRanges: [],
      candidateIds: [candidate.id],
    },
  };
  selectCaseInvocation(f.worker.state, {
    kind: "delegated",
    work: {
      ...original.work,
      correlationId: "B",
      fingerprint: "B",
      invocationId: "B",
    },
  });
  f.worker.state.conversationCursor = { nodeId: "B-suspended" };
  const before = f.worker.snapshot;
  await f.manager.resumeCandidateContinuations();
  deepStrictEqual(f.worker.settledActivations, [{ caseId: f.central.id }]);
  equal(f.worker.resumeOptions.length, 0);
  deepStrictEqual(f.worker.candidateContinuations, []);
  deepStrictEqual(f.worker.state.caseInvocation, before.caseInvocation);
  deepStrictEqual(f.worker.state.conversationCursor, before.conversationCursor);
  await f.manager.dispose();
});

Deno.test("host recovery repeatedly discovers the same bounded parked contribution without selecting or executing it", async () => {
  const f = await delegatedCaseFixture();
  const original = f.worker.state.caseInvocation;
  ok(original?.kind === "delegated");
  const candidate = f.worker.state.candidates[0];
  candidate.admissionDecision = {
    candidateDigest: candidate.digest,
    verdict: "refuse",
    reason: "Exact decision",
  };
  candidate.admissionContinuation = {
    modelDigest: "digest-worker",
    fingerprint: "A",
    inputMessageId: "input-A",
    messageStart: 0,
    priorCandidateIds: [],
    work: {
      receipt: original.work,
      messageRanges: [],
      candidateIds: [candidate.id],
    },
  };
  const input: OperatorWorkMessage = {
    id: "input-A",
    role: "tool",
    text: "A",
    at: "now",
    work: original.work,
  };
  f.worker.state.messages.push(input);
  f.worker.state.conversationCursor = { nodeId: "A-decision-persisted" };
  selectCaseInvocation(f.worker.state, {
    kind: "delegated",
    work: {
      ...original.work,
      correlationId: "B",
      fingerprint: "B",
      invocationId: "B",
    },
  });
  f.worker.state.conversationCursor = { nodeId: "B-selected" };
  const before = f.worker.snapshot;
  const expected = await expectedCandidateRecovery(f);
  equal(expected.invocationKey, invocationKey(original));
  equal(expected.inputMessageId, "input-A");
  let acceptances = 0;
  f.worker.enqueueStep = async (command) => {
    deepStrictEqual(command, expected);
    deepStrictEqual(f.worker.state.caseInvocation, before.caseInvocation);
    deepStrictEqual(
      f.worker.state.conversationCursor,
      before.conversationCursor,
    );
    acceptances++;
    // The real worker obtains this separate lease after queue acceptance.
    await f.manager.withCandidateContinuation(f.central.id, async (context) => {
      equal(context.caseId, f.central.id);
      await rejects(
        () => f.manager.withCaseClosure(f.central.id, () => Promise.resolve()),
        caseBusy,
      );
    });
  };
  await f.manager.resumeCandidateContinuations();
  equal(acceptances, 1);
  deepStrictEqual(f.worker.candidateContinuations, [expected]);
  deepStrictEqual(f.worker.state.caseInvocation, before.caseInvocation);
  deepStrictEqual(f.worker.state.conversationCursor, before.conversationCursor);
  await f.manager.resumeCandidateContinuations();
  equal(acceptances, 2);
  deepStrictEqual(f.worker.candidateContinuations, [expected, expected]);
  deepStrictEqual(f.worker.resumeOptions, []);
  deepStrictEqual(f.worker.snapshot, before);
  await f.manager.dispose();
});

Deno.test("a reserved Case closure blocks both delegated resumptions and a second closure before yielding", async () => {
  const f = await delegatedCaseFixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const closing = f.manager.withCaseClosure(f.central.id, () => gate);
  await rejects(() => f.resume("candidate"), caseBusy);
  await rejects(() => f.resume("change"), caseBusy);
  await rejects(
    () => f.manager.withCaseClosure(f.central.id, () => Promise.resolve()),
    caseBusy,
  );
  equal(f.worker.decisions.length + f.worker.changeDecisions.length, 0);
  release();
  await closing;
  await f.resume("candidate");
  await f.resume("change");
  equal(f.worker.decisions.length + f.worker.changeDecisions.length, 2);
  await f.manager.dispose();
});

Deno.test("failed delegated resumptions and failed closures release their Case reservation", async () => {
  const f = await delegatedCaseFixture();
  for (const kind of ["candidate", "change"] as const) {
    let fail!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, reject) => fail = reject);
    f.worker.decisionStep = f.worker.changeDecisionStep = () => gate;
    const failure = rejects(() => f.resume(kind), /resume failure/);
    await rejects(
      () => f.manager.withCaseClosure(f.central.id, () => Promise.resolve()),
      caseBusy,
    );
    fail(new Error("resume failure"));
    await failure;
    await f.manager.withCaseClosure(f.central.id, () => Promise.resolve());
  }
  f.worker.decisionStep = f.worker.changeDecisionStep = undefined;
  let fail!: (error: Error) => void;
  const gate = new Promise<void>((_resolve, reject) => fail = reject);
  const failure = rejects(
    () => f.manager.withCaseClosure(f.central.id, () => gate),
    /closure failure/,
  );
  await rejects(() => f.resume("candidate"), caseBusy);
  fail(new Error("closure failure"));
  await failure;
  await f.resume("candidate");
  await f.resume("change");
  await f.manager.dispose();
});

Deno.test("each conversation exposes its own runtime proposals and concrete before state", async () => {
  const f = await fixture();
  const configuration = f.worker.state.configuration!;
  configuration.revision = 3;
  configuration.network = { allowedHosts: ["example.org"] };
  configuration.changes = [{
    id: "worker-change",
    kind: "mandate-change",
    status: "pending",
    baseRevision: 3,
    reason: "Accès à la source",
    requestedAt: "2026-10-21T00:00:00Z",
    requestedRights: { addNetworkHosts: ["docs.example.org"] },
  }, {
    id: "past-change",
    kind: "mandate-change",
    status: "refused",
    baseRevision: 1,
    reason: "Ancienne proposition",
    requestedAt: "2026-10-20T00:00:00Z",
    decidedAt: "2026-10-20T00:01:00Z",
    authority: "human",
    requestedRights: { mayAdmitOwnCandidates: true },
  }];
  const snapshot = f.manager.snapshot;
  const worker = snapshot.conversations.find((item) =>
    item.agentId === "worker"
  )!;
  deepStrictEqual(worker.proposalContext, {
    configurationRevision: 3,
    before: {
      network: { allowedHosts: ["example.org"] },
      builder: { admissionAuthority: configuration.builder.admissionAuthority },
      urlSelectionMode: f.worker.state.executionModel!.policy.urlSelectionMode,
    },
    changes: configuration.changes,
  });
  equal(
    snapshot.conversations.find((item) => item.agentId === "primary")!
      .proposalContext!.changes.length,
    0,
  );
  worker.proposalContext!.changes[0]!.status = "refused";
  worker.proposalContext!.before.network.allowedHosts.push("other.example.org");
  equal(f.worker.state.configuration!.changes[0]!.status, "pending");
  deepStrictEqual(f.worker.state.configuration!.network!.allowedHosts, [
    "example.org",
  ]);
  await f.manager.dispose();
});

Deno.test("change decision keeps owner, both revisions, pending status and reservation at runtime", async () => {
  const f = await fixture();
  f.worker.state.configuration!.revision = 3;
  f.worker.state.configuration!.changes = [{
    id: "change-1",
    kind: "mandate-change",
    status: "pending",
    baseRevision: 3,
    reason: "R",
    requestedAt: "2026-10-21T00:00:00Z",
  }];
  const command: OperatorChangeDecision = {
    agentId: "worker",
    changeId: "change-1",
    expectedRevision: 0,
    configurationRevision: 3,
    verdict: "refuse",
  };
  for (
    const invalid of [
      { ...command, agentId: "primary" },
      { ...command, expectedRevision: 1 },
      { ...command, configurationRevision: 2 },
      { ...command, changeId: "other" },
    ]
  ) {
    await rejects(
      () => f.manager.decideChange(invalid),
      OperatorConversationError,
    );
  }
  let release!: () => void;
  f.worker.changeDecisionStep = () =>
    new Promise((resolve) => release = resolve);
  const pending = f.manager.decideChange(command);
  await rejects(
    () => f.manager.decideChange(command),
    (error: unknown) =>
      error instanceof OperatorConversationError && error.code === "AGENT_BUSY",
  );
  release();
  await pending;
  deepStrictEqual(f.worker.changeDecisions, [{
    changeId: "change-1",
    expectedRevision: 3,
    verdict: "refuse",
  }]);
  equal(f.primary.changeDecisions.length, 0);
  f.worker.state.configuration!.changes[0]!.status = "refused";
  await rejects(
    () => f.manager.decideChange(command),
    OperatorConversationError,
  );
  equal(f.worker.changeDecisions.length, 1);
  await f.manager.dispose();
});

Deno.test("approved change delegates idempotent approval and typed refusal to its runtime", async () => {
  const f = await fixture();
  f.worker.state.configuration!.revision = 4;
  const change = {
    id: "change-1",
    kind: "mandate-change" as const,
    status: "approved" as const,
    baseRevision: 3,
    reason: "R",
    requestedAt: "2026-10-21T00:00:00Z",
    publication: { baseRepositoryVersion: "branch:before", completed: false },
  };
  f.worker.state.configuration!.changes = [change];
  const command: OperatorChangeDecision = {
    agentId: "worker",
    changeId: change.id,
    expectedRevision: 0,
    configurationRevision: change.baseRevision,
    verdict: "approve",
  };
  for (
    const invalid of [
      { ...command, expectedRevision: 1 },
      { ...command, configurationRevision: 4 },
      { ...command, agentId: "primary" },
    ]
  ) {
    await rejects(
      () => f.manager.decideChange(invalid),
      OperatorConversationError,
    );
  }
  deepStrictEqual(f.worker.changeDecisions, []);
  await f.manager.decideChange(command);
  await f.manager.decideChange({ ...command, verdict: "refuse" });
  deepStrictEqual(f.worker.changeDecisions, [
    {
      changeId: change.id,
      expectedRevision: change.baseRevision,
      verdict: "approve",
    },
    {
      changeId: change.id,
      expectedRevision: change.baseRevision,
      verdict: "refuse",
    },
  ]);
  await f.manager.dispose();
});

Deno.test("candidate admission rejects a foreign owner, stale candidate and stale owner revision", async () => {
  const f = await fixture();
  delegated(f.worker.state, caseExecutionContext(f.primary.state)!);
  f.worker.state.candidates.push(
    tool("worker-only", "worker-digest", "primary-request"),
  );
  const command: OperatorCandidateDecision = {
    agentId: "worker",
    candidateId: "worker-only",
    candidateDigest: "worker-digest",
    expectedRevision: 0,
    verdict: "approve",
    reason: "Decision",
  };
  for (
    const invalid of [
      { ...command, agentId: "primary" },
      { ...command, candidateDigest: "other-digest" },
      { ...command, expectedRevision: 8 },
    ]
  ) {
    await rejects(
      () => f.manager.decideCandidate(invalid),
      OperatorConversationError,
    );
  }
  equal(f.primary.decisions.length + f.worker.decisions.length, 0);
  await f.manager.dispose();
});

Deno.test("candidate controls reserve only their owner while the existing admission gate runs", async () => {
  const f = await fixture();
  delegated(f.worker.state, caseExecutionContext(f.primary.state)!);
  f.worker.state.candidates.push(
    tool("worker-only", "worker-digest", "primary-request"),
  );
  let release!: () => void;
  f.worker.decisionStep = () => new Promise((resolve) => release = resolve);
  const command: OperatorCandidateDecision = {
    agentId: "worker",
    candidateId: "worker-only",
    candidateDigest: "worker-digest",
    expectedRevision: 0,
    verdict: "approve",
    reason: "Decision",
  };
  const pending = f.manager.decideCandidate(command);
  await rejects(
    () => f.manager.decideCandidate(command),
    (error: unknown) =>
      error instanceof OperatorConversationError && error.code === "AGENT_BUSY",
  );
  await f.manager.submitHuman({
    agentId: "second",
    text: "Autre activité",
    expectedRevision: 0,
  });
  equal(f.second.snapshot.busy, true);
  release();
  await pending;
  equal(f.worker.decisions.length, 1);
  f.second.finish();
  await f.manager.dispose();
});

Deno.test("a stale pending change can still be refused through its owning operator", async () => {
  const f = await fixture();
  f.worker.state.configuration!.revision = 4;
  f.worker.state.configuration!.changes = [{
    id: "stale",
    kind: "mandate-change",
    status: "pending",
    baseRevision: 3,
    reason: "Old request",
    requestedAt: "before",
  }];
  const command: OperatorChangeDecision = {
    agentId: "worker",
    changeId: "stale",
    expectedRevision: 0,
    configurationRevision: 3,
    verdict: "approve",
  };
  await f.manager.decideChange(command);
  await f.manager.decideChange({ ...command, verdict: "refuse" });
  equal(f.worker.changeDecisions.length, 2);
  deepStrictEqual(f.worker.changeDecisions.map((entry) => entry.verdict), [
    "approve",
    "refuse",
  ]);
  await f.manager.dispose();
});

Deno.test("a new delegation without a Case is rejected without invoking or creating local work", async () => {
  const f = await fixture();
  try {
    const proof = f.proof();
    delete proof.caseId;
    delete proof.caseContext;
    const before = f.worker.snapshot;
    await rejects(
      () => f.manager.submitWork("worker", "Unscoped work", "new-work", proof),
      {
        code: "WORK_CASE_MISMATCH",
      },
    );
    equal(f.worker.calls.length, 0);
    deepStrictEqual(f.worker.snapshot, before);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("an operator without general human input accepts only its existing owned open Request", async () => {
  const f = await fixture();
  const clock = { now: () => "2026-10-24T00:00:00.000Z" };
  const caseId = selectHumanRequestCase(
    f.worker.state,
    { objective: "Operator request", messageId: "start" },
    clock,
    5,
  );
  try {
    const agentId = f.worker.state.executionModel!.identity.builderId;
    await rejects(
      () =>
        f.manager.submitHuman({
          agentId,
          expectedRevision: f.worker.snapshot.revision,
          text: "General",
        }),
      { code: "READ_ONLY_AGENT" },
    );
    await rejects(
      () =>
        f.manager.submitHuman({
          agentId,
          expectedRevision: f.worker.snapshot.revision,
          text: "New",
          newConversation: true,
        }),
      { code: "READ_ONLY_AGENT" },
    );
    await f.manager.submitHuman({
      agentId,
      expectedRevision: f.worker.snapshot.revision,
      text: "Follow-up",
      caseId,
    });
    equal(f.worker.humanTargets.at(-1)!.caseId, caseId);
    f.worker.finish();
    f.worker.state.cases![0].status = "closed-done";
    await rejects(
      () =>
        f.manager.submitHuman({
          agentId,
          expectedRevision: f.worker.snapshot.revision,
          text: "Closed",
          caseId,
        }),
      { code: "CASE_CLOSED" },
    );
  } finally {
    f.worker.finish();
    await f.manager.dispose();
  }
});

Deno.test("inactive delegated work returns a coded authority refusal without invoking the operator", async () => {
  const f = await delegatedCaseFixture();
  f.primary.state.cases![0].status = "closed-done";
  const before = structuredClone(f.worker.state);
  await rejects(
    () =>
      f.manager.decideChange({
        agentId: "worker",
        changeId: "waiting-change",
        expectedRevision: 0,
        configurationRevision: 0,
        verdict: "approve",
      }, { actorId: "primary", policyId: "network", policyRevision: 1 }),
    (error) => {
      ok(error instanceof OperatorAuthorityError);
      equal(error.code, "AUTHORITY_REQUEST_STALE");
      equal(error.context.reason, "WORK_CASE_INACTIVE");
      deepStrictEqual(error.recovery, { action: "refuse-and-repropose" });
      return true;
    },
  );
  deepStrictEqual(f.worker.state, before);
  equal(f.worker.changeDecisions.length, 0);
  await f.manager.dispose();
});

Deno.test("conversation projection exposes independent exact Request team metadata before any message", async () => {
  const f = await fixture();
  const team = {
    parentOperatorId: "primary",
    requestOwnerId: "primary",
    requestId: "request:team",
    creationPolicyId: "policy:team",
  };
  f.worker.state.executionModel!.operatorTeam = team;
  const read = f.manager.snapshot;
  const worker = read.conversations.find((entry) =>
    entry.agentId === "worker"
  )!;
  deepStrictEqual(worker.operatorTeam, team);
  equal(worker.messages.length, 0);
  equal(
    read.conversations.find((entry) => entry.agentId === "primary")!
      .operatorTeam,
    undefined,
  );
  team.requestId = "changed-after-read";
  equal(worker.operatorTeam!.requestId, "request:team");
});

Deno.test("native dispatch captures the immutable exact parent invocation and rejects a forged anchor", async () => {
  const f = await fixture();
  f.primary.state.messages.push({
    id: "parent-input",
    role: "user",
    caseId: "primary-request",
    text: "Coordinate",
    at: "2026-10-27T00:00:00Z",
  });
  await rejects(
    () =>
      f.manager.submitWork("worker", "Collect", "forged-anchor", {
        ...f.proof(),
        parentInvocation: {
          operatorId: "primary",
          invocationKey: "forged",
          inputMessageId: "parent-input",
        },
      }),
    (error: unknown) =>
      error instanceof OperatorConversationError &&
      error.code === "WORK_CASE_MISMATCH",
  );
  const pending = f.manager.submitWork(
    "worker",
    "Collect",
    "anchored-work",
    f.proof(),
  );
  await Promise.resolve();
  const anchor = structuredClone(
    f.worker.state.messages.at(-1)?.work?.parentInvocation,
  );
  deepStrictEqual(anchor, {
    operatorId: "primary",
    invocationKey: invocationKey({ kind: "local", caseId: "primary-request" }),
    inputMessageId: "parent-input",
  });
  selectDesignerInvocation(f.primary.state);
  deepStrictEqual(
    f.worker.state.messages.at(-1)?.work?.parentInvocation,
    anchor,
  );
  f.worker.finish();
  await pending;
  await f.manager.dispose();
});

async function frozenWorkFixture() {
  const f = await fixture();
  const root = f.primary.state.cases![0];
  root.status = "open";
  root.budget = { budgetId: "plan-budget", scopeId: "plan-root-budget" };
  root.firstRequestDispatch = {
    modelDigest: "digest-primary",
    providerPending: false,
    progressed: true,
  };
  root.taskSourceInputs = [{
    kind: "human-selected-urls",
    rootRequestId: root.id,
    source: {
      operatorId: "main",
      conversationId: "main-session",
      designerScopeId: "main-designer",
      messageId: "source-1",
      messageDigest: "a".repeat(64),
    },
    urls: ["https://original.example/source"],
  }];
  f.primary.state.executionModel!.workBudgetPolicy = {
    id: "plan-budget",
    elementId: "plan-budget-native",
    sourceIds: ["plan-budget-native"],
    revision: 1,
    unit: "agent-invocation",
    limit: 8,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  f.primary.state.messages.push({
    id: "plan-input",
    role: "user",
    caseId: root.id,
    text: "Run the admitted plan",
    at: "2026-10-27T00:00:00Z",
  });
  return { ...f, root, frozen: structuredClone(f.proof()) };
}

Deno.test("frozen native work contexts refresh mutable root progress and resume sources without replaying completed tasks", async () => {
  const f = await frozenWorkFixture();
  try {
    const first = f.manager.submitWork(
      "worker",
      "First admitted task",
      "plan:first",
      f.frozen,
    );
    await Promise.resolve();
    const originalReceipt = structuredClone(
      (f.worker.state.messages.at(-1) as OperatorWorkMessage).work,
    );
    const accepted = await first;
    equal(accepted.status, "waiting");
    deepStrictEqual(accepted.messages, []);
    equal(accepted.correlationId, "plan:first");
    equal(accepted.invocationId, f.frozen.invocationId);
    f.worker.finish("First task completed");
    const completed = await f.manager.submitWork(
      "worker",
      "First admitted task",
      "plan:first",
      { ...f.frozen, parentInvocation: originalReceipt.parentInvocation },
    );
    equal(completed.status, "completed");
    deepStrictEqual(completed.messages.map((message) => message.text), [
      "First admitted task",
      "First task completed",
    ]);
    f.root.status = "waiting";
    delete f.root.firstRequestDispatch;
    f.root.firstRequestDispatched = true;
    f.root.taskSourceInputs![0].source.resumeId = "resume-2";
    f.root.taskSourceInputs![0].source.messageId = "source-2";
    f.root.taskSourceInputs![0].urls = ["https://current.example/source"];
    f.primary.state.messages.push({
      id: "resume-input",
      role: "user",
      caseId: f.root.id,
      text: "Resume the same plan",
      at: "2026-10-27T00:01:00Z",
    });
    const cached = await f.manager.submitWork(
      "worker",
      "First admitted task",
      "plan:first",
      { ...f.frozen, parentInvocation: originalReceipt.parentInvocation },
    );
    deepStrictEqual(cached, completed);
    equal(f.worker.calls.length, 1);
    deepStrictEqual(
      (f.worker.state.messages[0] as OperatorWorkMessage).work,
      originalReceipt,
    );
    const next = f.manager.submitWork(
      "worker",
      "Next admitted task",
      "plan:next",
      { ...f.frozen, invocationId: "next-native-invocation" },
    );
    await Promise.resolve();
    const nextReceipt =
      (f.worker.state.messages.at(-1) as OperatorWorkMessage).work;
    deepStrictEqual(
      nextReceipt.caseContext,
      caseExecutionContext(f.primary.state),
    );
    equal(nextReceipt.parentInvocation?.inputMessageId, "resume-input");
    deepStrictEqual(
      nextReceipt.caseContext!.record!.taskSourceInputs![0].urls,
      ["https://current.example/source"],
    );
    deepStrictEqual(f.frozen.caseContext!.record!.taskSourceInputs![0].urls, [
      "https://original.example/source",
    ]);
    equal(f.worker.calls.length, 2);
    const acceptedNext = await next;
    equal(acceptedNext.status, "waiting");
    deepStrictEqual(acceptedNext.messages, []);
    equal(acceptedNext.correlationId, "plan:next");
    equal(acceptedNext.invocationId, "next-native-invocation");
    f.worker.finish("Next task completed");
    const completedNext = await f.manager.submitWork(
      "worker",
      "Next admitted task",
      "plan:next",
      { ...f.frozen, invocationId: "next-native-invocation" },
    );
    equal(completedNext.status, "completed");
    deepStrictEqual(completedNext.messages.map((message) => message.text), [
      "Next admitted task",
      "Next task completed",
    ]);
    equal(f.worker.calls.length, 2);
  } finally {
    if (f.worker.state.busy) f.worker.finish();
    await f.manager.dispose();
  }
});

Deno.test("refreshing frozen native work rejects forged root identity, owner and budget authority", async () => {
  const f = await frozenWorkFixture();
  try {
    const mutations: Array<
      (proof: Extract<OperatorWorkAdmission, { behavior: unknown }>) => void
    > = [
      (proof) => {
        proof.caseContext!.record!.owner = "foreign-owner";
      },
      (proof) => {
        proof.caseContext!.budget!.ownerId = "foreign-owner";
      },
      (proof) => {
        proof.caseContext!.budget!.scopeId = "foreign-budget";
      },
      (proof) => {
        proof.caseContext!.budget!.policy.limit = 800;
      },
      (proof) => {
        proof.caseContext!.record!.budget!.scopeId = "foreign-binding";
      },
      (proof) => {
        proof.caseContext!.modelPin.digest = "foreign-pin";
      },
      (proof) => {
        proof.modelVersion.digest = "foreign-model";
      },
      (proof) => {
        proof.behavior.targetNativeId = "foreign-inbox";
      },
      (proof) => {
        proof.caseContext!.caseId = "foreign-request";
      },
    ];
    for (const mutate of mutations) {
      const forged = structuredClone(f.frozen);
      mutate(forged);
      await rejects(
        () =>
          f.manager.submitWork(
            "worker",
            "Admitted task",
            "plan:forged",
            forged,
          ),
        (error: unknown) =>
          error instanceof OperatorConversationError &&
          (error.code === "WORK_CASE_MISMATCH" ||
            error.code === "WORK_NOT_AUTHORIZED"),
      );
    }
    equal(f.worker.calls.length, 0);
    // Even a stale delegated caller envelope cannot impersonate the actual Root owner.
    delegated(f.primary.state, f.frozen.caseContext!);
    f.root.owner = "foreign-owner";
    await rejects(
      () =>
        f.manager.submitWork(
          "worker",
          "Admitted task",
          "plan:root-owner",
          f.frozen,
        ),
      { code: "WORK_CASE_INACTIVE" },
    );
    f.root.owner = "primary";
    f.root.status = "closed-done";
    await rejects(
      () =>
        f.manager.submitWork(
          "worker",
          "Admitted task",
          "plan:closed",
          f.frozen,
        ),
      { code: "WORK_CASE_INACTIVE" },
    );
    equal(f.worker.calls.length, 0);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("committed evolution read notifications change aggregate identity without changing command CAS", async () => {
  const primary = new Runtime(model("primary", true, true));
  let version = "evolutions:one";
  const application = new OperatorConversations({
    primary,
    evolutionRead: () =>
      Promise.resolve({ version, items: [], truncated: false }),
  });
  await application.initialize();
  const before = await application.conversations();
  let notices = 0;
  const unsubscribe = application.onChange(() => {
    notices++;
  });
  version = "evolutions:two";
  application.notifyReadChange();
  const after = await application.conversations();
  equal(notices, 1);
  equal(primary.state.revision, 0);
  equal(primary.calls.length, 0);
  equal(before.version === after.version, false);
  equal(after.evolutions!.version, version);
  unsubscribe();
  application.notifyReadChange();
  equal(notices, 1);
  await application.dispose();
  application.notifyReadChange();
  equal(notices, 1);
});

Deno.test("unavailable evolution details cannot hide ordinary conversations or invent current receipts", async () => {
  const primary = new Runtime(model("primary", true, true));
  const application = new OperatorConversations({
    primary,
    evolutionRead: () => Promise.reject(new Error("Unavailable staged source")),
  });
  await application.initialize();
  const read = await application.conversations();
  equal(read.conversations[0].agentId, "primary");
  deepStrictEqual(read.evolutions!.items, []);
  equal(read.evolutions!.truncated, true);
  equal(read.evolutions!.error, "Evolution dossier details are unavailable.");
  equal(primary.state.revision, 0);
  equal(primary.calls.length, 0);
  await application.dispose();
});

Deno.test("a parent contribution through the member's native inbox is authorized", async () => {
  const primary = new Runtime(model("primary", true, true));
  const worker = new Runtime(model("worker", false));
  primary.state.cases = [{
    id: "primary-request",
    number: 1,
    type: "request",
    owner: "primary",
    objective: "Coordinate the requested work",
    openedBy: "primary",
    openedFrom: { conversationId: primary.state.id },
    modelPin: {
      digest: "digest-primary",
      repositoryVersion: "branch:admitted",
    },
    status: "waiting",
    createdAt: "2026-10-21T00:00:00Z",
  }];
  primary.state.caseInvocation = { kind: "local", caseId: "primary-request" };
  worker.state.executionModel!.operatorTeam = {
    parentOperatorId: "primary",
    requestOwnerId: "primary",
    requestId: "primary-request",
  };
  // The writer binds the parent's BehaviorAccess to the member's `.inbox`
  // action, never to its conversation root.
  worker.state.executionModel!.operatorEntries = [{
    id: "worker-inbox-action",
    kind: "inbox",
    typeId: "inbox-type",
    performerId: "worker",
    allocationId: "inbox-allocation",
    sourceIds: ["inbox-source"],
  }];
  primary.state.executionModel!.behaviors = [{
    id: "expose-worker",
    name: "Submit work",
    description: "Native inbox",
    targetNativeId: "worker-inbox-action",
    targetTypeId: "inbox-type",
    inputTypeId: "input-type",
    callerNativeId: "primary",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    sourceIds: ["native-exposure"],
  }];
  const manager = new OperatorConversations({
    primary,
    factory: {
      open: () => Promise.resolve(worker),
      close: () => Promise.resolve(),
    },
  });
  await manager.initialize({
    repositoryVersion: "branch:admitted",
    units: [primary, worker].map((runtime) =>
      conversationUnit(
        `Example::${runtime.state.executionModel!.identity.systemId}`,
        runtime.snapshot.executionModel!,
      )
    ),
  });
  const proof: OperatorWorkAdmission = {
    caseId: caseExecutionContext(primary.state)?.caseId,
    caseContext: caseExecutionContext(primary.state),
    behavior: structuredClone(primary.state.executionModel!.behaviors![0]!),
    modelVersion: {
      digest: "digest-primary",
      repositoryVersion: "branch:admitted",
    },
    callerId: "primary",
    invocationId: "invoke-worker",
  };
  const pending = manager.submitWork("worker", "Collect", "inbox-work", proof);
  await Promise.resolve();
  equal(worker.calls.length, 1);
  worker.finish();
  await pending;
  await manager.dispose();
});

/** A BO (primary), its member (worker) and a sibling member that the source
 * explicitly gives access to the worker's inbox (spec 4.8e E6). */
async function subordinateOrderFixture(
  onNoticeError?: (error: OperatorConversationError) => void,
  retained = false,
  verifiedMemberIds = ["worker", "sibling"],
) {
  const primary = new Runtime(model("primary", true, true));
  const worker = new Runtime(model("worker", false));
  const sibling = new Runtime(model("sibling", false));
  primary.state.cases = [{
    id: "primary-request",
    number: 1,
    type: "request",
    owner: "primary",
    objective: "Coordinate the requested work",
    openedBy: "primary",
    openedFrom: { conversationId: primary.state.id },
    modelPin: {
      digest: "digest-primary",
      repositoryVersion: "branch:admitted",
    },
    status: "waiting",
    createdAt: "2026-10-21T00:00:00Z",
  }];
  primary.state.caseInvocation = { kind: "local", caseId: "primary-request" };
  const team = {
    parentOperatorId: "primary",
    requestOwnerId: "primary",
    requestId: retained ? "original-request" : "primary-request",
  };
  worker.state.executionModel!.operatorTeam = structuredClone(team);
  sibling.state.executionModel!.operatorTeam = structuredClone(team);
  worker.state.executionModel!.operatorEntries = [{
    id: "worker-inbox-action",
    kind: "inbox",
    typeId: "inbox-type",
    performerId: "worker",
    allocationId: "inbox-allocation",
    sourceIds: ["inbox-source"],
  }];
  const access = (caller: string) => ({
    id: `expose-worker-to-${caller}`,
    name: "Submit work",
    description: "Native inbox",
    targetNativeId: "worker-inbox-action",
    targetTypeId: "inbox-type",
    inputTypeId: "input-type",
    callerNativeId: caller,
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    sourceIds: [`native-exposure-${caller}`],
  });
  primary.state.executionModel!.behaviors = [access("primary")];
  sibling.state.executionModel!.behaviors = [access("sibling")];
  const caseContext = caseExecutionContext(primary.state)!;
  // The sibling works on the same Request through its own delegated input.
  sibling.state.caseInvocation = {
    kind: "delegated",
    work: {
      callerId: "primary",
      correlationId: "sibling-work",
      invocationId: "invoke-sibling",
      behaviorId: "expose-sibling",
      targetNativeId: "sibling-inbox",
      modelVersion: {
        digest: "digest-primary",
        repositoryVersion: "branch:admitted",
      },
      fingerprint: "sibling-fingerprint",
      priorCandidateIds: [],
      caseId: "primary-request",
      caseContext: structuredClone(caseContext),
    },
  } as unknown as SystemRuntimeState["caseInvocation"];
  const members = new Map([["worker", worker], ["sibling", sibling]]);
  const manager = new OperatorConversations({
    primary,
    onNoticeError,
    ...(retained
      ? {
        requestTeam: {
          caseId: "primary-request",
          memberIds: verifiedMemberIds,
        },
      }
      : {}),
    factory: {
      open: (unit) =>
        Promise.resolve(members.get(unit.model.identity.builderId)!),
      close: () => Promise.resolve(),
    },
  });
  await manager.initialize({
    repositoryVersion: "branch:admitted",
    units: [primary, worker, sibling].map((runtime) =>
      conversationUnit(
        `Example::${runtime.state.executionModel!.identity.systemId}`,
        runtime.snapshot.executionModel!,
      )
    ),
  });
  const proof = (caller: Runtime, invocationId: string) => ({
    caseId: "primary-request",
    caseContext: caseExecutionContext(caller.state),
    behavior: structuredClone(caller.state.executionModel!.behaviors![0]!),
    modelVersion: {
      digest: caller.state.executionModel!.version.digest,
      repositoryVersion: "branch:admitted",
    },
    callerId: caller.state.executionModel!.identity.builderId,
    invocationId,
  } as Extract<OperatorWorkAdmission, { behavior: unknown }>);
  const mainProof = (invocationId: string) => {
    const { behavior, ...context } = proof(primary, invocationId);
    return {
      ...context,
      kind: "mainOrder" as const,
      targetNativeId: behavior.targetNativeId,
      mainOrder: {
        openingId: "opening",
        caller: scopedOperator({
          projectId: "project",
          systemId: "system",
          executionSpaceId: "main",
        }, "primary"),
      },
    };
  };
  return { primary, worker, sibling, manager, proof, mainProof };
}

Deno.test("a foreign team lineage cannot contribute through another Request's native inbox", async () => {
  const f = await subordinateOrderFixture();
  f.worker.state.executionModel!.operatorTeam!.requestId = "foreign-request";
  try {
    await rejects(
      () =>
        f.manager.submitWork(
          "worker",
          "Collect",
          "foreign-member",
          f.proof(f.primary, "foreign-member"),
        ),
      { code: "WORK_CASE_MISMATCH" },
    );
    equal(f.worker.calls.length, 0);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("a Request contribution refuses a member absent from the verified opening roster", async () => {
  const f = await subordinateOrderFixture(undefined, true, []);
  try {
    await rejects(
      () =>
        f.manager.submitWork(
          "worker",
          "Collect",
          "unadmitted-member",
          f.proof(f.primary, "unadmitted-member"),
        ),
      { code: "WORK_CASE_MISMATCH" },
    );
    equal(f.worker.calls.length, 0);
  } finally {
    await f.manager.dispose();
  }
});

Deno.test("4.8e Q7: a host Main order records its crossing and notifies the parent once; a forged ordinary call is refused", async () => {
  const f = await subordinateOrderFixture();
  const proof = f.mainProof("main-invoke");
  await rejects(
    () => f.manager.submitWork("worker", "Collect", "forged-main", proof),
    { code: "WORK_NOT_AUTHORIZED" },
  );
  equal(f.worker.calls.length, 0);
  for (
    const invalid of [
      { ...proof, mainOrder: undefined },
      {
        ...proof,
        mainOrder: {
          ...proof.mainOrder,
          caller: { ...proof.mainOrder.caller, executionSpaceId: "other" },
        },
      },
      {
        ...proof,
        mainOrder: {
          ...proof.mainOrder,
          caller: { ...proof.mainOrder.caller, operatorId: "other" },
        },
      },
      {
        ...proof,
        designerContext: { scopeId: "designer", ownerId: "primary" },
      },
      { ...proof, caseId: "foreign" },
    ]
  ) {
    await rejects(
      () =>
        f.manager.submitMainWork(
          "worker",
          "Collect",
          "invalid-main",
          invalid as OperatorWorkAdmission,
        ),
      { code: "WORK_NOT_AUTHORIZED" },
    );
  }
  equal(f.worker.calls.length, 0);
  const accepted = f.manager.submitMainWork(
    "worker",
    "Collect",
    "main-order",
    proof,
  );
  await Promise.resolve();
  const legacy =
    (f.worker.state.messages.find((message) =>
      message.work?.correlationId === "main-order"
    ) as OperatorWorkMessage).work;
  legacy.behaviorId = "main-request-order";
  legacy.fingerprint = canonical({
    ...JSON.parse(legacy.fingerprint),
    behaviorId: legacy.behaviorId,
  });
  f.worker.finish();
  await accepted;
  deepStrictEqual(
    (f.worker.state.messages.find((message) =>
      message.work?.correlationId === "main-order"
    ) as OperatorWorkMessage).work.mainOrder,
    proof.mainOrder,
  );
  equal(f.primary.notices.length, 1);
  const notice = f.primary.notices[0].notice;
  equal(notice.kind, "subordinate-order");
  if (notice.kind === "subordinate-order") {
    deepStrictEqual(notice.orderedBy, {
      operatorId: "primary",
      executionSpaceId: "main",
    });
  }
  await f.manager.submitMainWork("worker", "Collect", "main-order", proof);
  equal(f.worker.calls.length, 1);
  equal(f.primary.notices.length, 1);
  await f.manager.dispose();
});

Deno.test("4.8e E6: an order from the parent notifies nobody", async () => {
  const f = await subordinateOrderFixture();
  const pending = f.manager.submitWork(
    "worker",
    "Collect",
    "parent-work",
    f.proof(f.primary, "invoke-parent"),
  );
  await Promise.resolve();
  f.worker.finish();
  await pending;
  deepStrictEqual(f.primary.notices, []);
  await f.manager.dispose();
});

Deno.test("4.8e E6: an authorized non-parent order reaches the member and notifies its parent once", async () => {
  const f = await subordinateOrderFixture();
  const proof = f.proof(f.sibling, "invoke-by-sibling");
  const first = f.manager.submitWork(
    "worker",
    "Collect the second passage",
    "sibling-order",
    proof,
  );
  await Promise.resolve();
  equal(f.worker.calls.length, 1, "the order is accepted, never blocked");
  f.worker.finish();
  await first;
  deepStrictEqual(f.primary.notices, [{
    notice: {
      kind: "subordinate-order",
      invocationId: "invoke-by-sibling",
      caseId: "primary-request",
      subordinate: "worker",
      orderedBy: { operatorId: "sibling" },
      summary: "Collect the second passage",
    },
    origin: { conversationId: f.primary.state.id, caseId: "primary-request" },
    delivery: { wake: false },
  }]);
  // A replay of the same order is the recorded one; its notice is the same
  // deterministic notice, which the parent stores once.
  await f.manager.submitWork(
    "worker",
    "Collect the second passage",
    "sibling-order",
    proof,
  );
  equal(f.worker.calls.length, 1);
  equal(
    new Set(
      f.primary.notices.map((entry) =>
        entry.notice.kind === "subordinate-order" && entry.notice.invocationId
      ),
    ).size,
    1,
  );
  await f.manager.dispose();
});

Deno.test("4.8e E6: an operator without an explicit access never orders a member", async () => {
  const f = await subordinateOrderFixture();
  f.sibling.state.executionModel!.behaviors = [];
  await rejects(
    () =>
      f.manager.submitWork(
        "worker",
        "Collect",
        "unauthorized",
        {
          ...f.proof(f.sibling, "invoke-unauthorized"),
          behavior: structuredClone(
            f.primary.state.executionModel!.behaviors![0]!,
          ),
        },
      ),
    (error: unknown) =>
      error instanceof OperatorConversationError &&
      error.code === "WORK_NOT_AUTHORIZED",
  );
  deepStrictEqual(f.primary.notices, []);
  await f.manager.dispose();
});

const noticeFailures = [
  { failure: "rejected", expectedErrors: 1 },
  { failure: "missing-parent", expectedErrors: 2 },
];
for (const { failure, expectedErrors } of noticeFailures) {
  Deno.test(`4.8e E6: ${failure} logs ${expectedErrors} failed notice attempts while the accepted order replays`, async () => {
    const errors: OperatorConversationError[] = [];
    const f = await subordinateOrderFixture((error) => errors.push(error));
    if (failure === "rejected") {
      f.primary.receiveOperatorNotice = () =>
        Promise.reject(new Error("notice unavailable"));
    } else {
      f.worker.state.executionModel!.operatorTeam!.parentOperatorId =
        "unavailable-parent";
    }
    const proof = f.proof(f.sibling, "invoke-notice-failure");
    const accepted = await f.manager.submitWork(
      "worker",
      "Collect",
      "notice-failure",
      proof,
    );
    equal(accepted.status, "waiting");
    equal(f.worker.calls.length, 1);
    f.worker.finish();
    const recorded = recordedOperatorWork(
      f.worker.snapshot,
      "worker",
      "sibling",
      "notice-failure",
    )!;
    equal(recorded.settled, true);
    const replay = await f.manager.submitWork(
      "worker",
      "Collect",
      "notice-failure",
      proof,
    );
    deepStrictEqual(replay, recorded.result);
    equal(f.worker.calls.length, 1);
    equal(errors.length, expectedErrors);
    equal(errors[0]!.code, "SUBORDINATE_ORDER_NOTICE_FAILED");
    equal(errors[0]!.context?.agentId, "worker");
    equal(errors[0]!.context?.callerId, "sibling");
    equal(errors[0]!.context?.caseId, "primary-request");
    equal(errors[0]!.context?.invocationId, "invoke-notice-failure");
    ok(errors[0]!.recovery);
    await f.manager.dispose();
  });
}

Deno.test("4.8e E6: accepted order replay retries a failed notice", async () => {
  const errors: OperatorConversationError[] = [];
  const f = await subordinateOrderFixture((error) => errors.push(error));
  const receive = f.primary.receiveOperatorNotice.bind(f.primary);
  let attempts = 0;
  f.primary.receiveOperatorNotice = (...args) => {
    attempts++;
    return attempts === 1
      ? Promise.reject(new Error("offline"))
      : receive(...args);
  };
  const proof = f.proof(f.sibling, "retry-notice");
  const accepted = await f.manager.submitWork(
    "worker",
    "Collect",
    "retry",
    proof,
  );
  equal(accepted.status, "waiting");
  f.worker.finish();
  await f.manager.submitWork("worker", "Collect", "retry", proof);
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  equal(attempts, 2);
  equal(f.worker.calls.length, 1);
  equal(f.primary.notices.length, 1);
  equal(errors[0]?.code, "SUBORDINATE_ORDER_NOTICE_FAILED");
  ok(errors[0]?.context?.invocationId);
  ok(errors[0]?.recovery);
  await f.manager.dispose();
});

Deno.test("4.8e E6: a pending notice does not delay order acceptance or settled replay", async () => {
  const f = await subordinateOrderFixture();
  let finishNotice!: () => void;
  let attempts = 0;
  f.primary.receiveOperatorNotice = () => {
    attempts++;
    return new Promise<void>((resolve) => finishNotice = resolve);
  };
  let accepted = false;
  const proof = f.proof(f.sibling, "invoke-pending-notice");
  const pending = f.manager.submitWork(
    "worker",
    "Collect",
    "pending-notice",
    proof,
  ).then((result) => {
    accepted = true;
    return result;
  });
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  equal(attempts, 1);
  const acceptedBeforeNotice = accepted;
  f.worker.finish();
  const recorded = recordedOperatorWork(
    f.worker.snapshot,
    "worker",
    "sibling",
    "pending-notice",
  )!;
  equal(recorded.settled, true);
  let replayed = false;
  const replay = f.manager.submitWork(
    "worker",
    "Collect",
    "pending-notice",
    proof,
  ).then((result) => {
    replayed = true;
    return result;
  });
  for (let turn = 0; turn < 10; turn++) await Promise.resolve();
  const replayedBeforeNotice = replayed;
  equal(attempts, 1);
  finishNotice();
  equal((await pending).status, "waiting");
  deepStrictEqual(await replay, recorded.result);
  equal(f.worker.calls.length, 1);
  await f.manager.dispose();
  equal(acceptedBeforeNotice, true);
  equal(replayedBeforeNotice, true);
});

Deno.test("4.8e Q7: Main-order completion never resumes the same-ID BO as its caller", async () => {
  const f = await subordinateOrderFixture();
  const proof = {
    ...f.mainProof("main-completion"),
    parentInvocation: {
      operatorId: "primary",
      invocationKey: "main-designer-invocation",
      inputMessageId: "main-input",
    },
  };
  const accepted = f.manager.submitMainWork(
    "worker",
    "Collect",
    "main-completion",
    proof,
  );
  await Promise.resolve();
  f.worker.finish();
  await accepted;
  const message = f.worker.state.messages.find((entry) =>
    entry.work?.correlationId === "main-completion"
  ) as OperatorWorkMessage;
  const completion = f.worker.state.events.find((entry) =>
    entry.id === "completion"
  ) as OperatorWorkCompletion;
  ok(message?.work && completion);
  const deliveries: unknown[] = [];
  (f.primary as unknown as {
    enqueueContinuation(input: unknown): Promise<void>;
  }).enqueueContinuation = (input) => {
    deliveries.push(input);
    return Promise.resolve();
  };
  try {
    await f.manager.notifyWorkCompletion(message.work, completion);
  } catch (error) {
    if (!(error instanceof OperatorConversationError)) throw error;
  }
  equal(deliveries.length, 0, "the branch BO is not Main@main");
  await f.manager.dispose();
});

Deno.test("Q7 Main order to a nested member informs its BO once", async () => {
  const f = await subordinateOrderFixture();
  f.worker.state.executionModel!.operatorTeam!.parentOperatorId = "sibling";
  const proof = f.mainProof("main-nested");
  await f.manager.submitMainWork("worker", "Collect", "main-nested", proof);
  await f.manager.submitMainWork("worker", "Collect", "main-nested", proof);
  equal(f.primary.notices.length, 1);
  equal(f.sibling.notices.length, 0);
  f.worker.finish();
  await f.manager.dispose();
});

Deno.test("a retained team registry authorizes and observes work in its new Case without rewriting source lineage", async () => {
  const f = await subordinateOrderFixture(undefined, true);
  const original = structuredClone(f.worker.state.executionModel);
  const pending = f.manager.submitWork(
    "worker",
    "Collect",
    "retained-work",
    f.proof(f.sibling, "retained-invoke"),
  );
  await Promise.resolve();
  equal(f.worker.calls.length, 1);
  f.worker.finish();
  await pending;
  deepStrictEqual(f.worker.state.executionModel, original);
  const notice = f.primary.notices.at(-1);
  equal(notice?.notice.caseId, "primary-request");
  await f.manager.dispose();
});
