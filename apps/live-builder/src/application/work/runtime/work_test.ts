import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  ChatContext,
  ChatDecision,
  ModelSourceProposalStatus,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { ToolDraft } from "../../../domain/work/candidates.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import type {
  AgentPort,
  ModelPort,
  StorePort,
  ToolRunnerPort,
} from "./ports.ts";
import type { OperatorWorkContribution } from "../operators/conversations.ts";
import { recordedOperatorWork } from "../operators/journal.ts";
import { eventually } from "../../../../test/support/eventually.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type { WorkPlanRecord } from "../../../domain/work/entities/plans.ts";
import type { WorkPlanExecution } from "../plans/commands/inputs.ts";
import { WorkPlanExecutor, workTaskInvocationId } from "../plans/executor.ts";

function admitted() {
  const model = executableFixture({
    projectId: "git:f0ec3282-6343-587f-aa0d-25f8a858c7e2",
    editingContextId: "context",
    rootId: "root",
    systemId: "worker-system",
    catalogId: "worker-catalog",
    builderId: "worker",
  });
  model.version.repositoryVersion = "branch:admitted";
  return model;
}

class MemoryStore implements StorePort {
  constructor(public value: SystemRuntimeState | null = null) {}
  load() {
    return Promise.resolve(structuredClone(this.value));
  }
  save(state: SystemRuntimeState, expected: number | null) {
    equal(this.value?.revision ?? null, expected);
    this.value = structuredClone(state);
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}

const nativeExecutions = new WeakMap<
  MemoryStore,
  ReturnType<typeof createTestNativeExecution>
>();

function ports(
  model: ExecutableModel,
  store = new MemoryStore(),
  steps?: Array<ChatDecision | Error>,
  historicalModels: ExecutableModel[] = [],
  /** Holds each provider answer until released: a turn still running. */
  gate?: Promise<void>,
) {
  let decisions = 0;
  let tests = 0;
  const contexts: ChatContext[] = [];
  const versions = new Map(
    [...historicalModels, model].map((retained) =>
      [
        retained.version.repositoryVersion,
        structuredClone(retained),
      ] as const
    ),
  );
  const agents: AgentPort = {
    label: "fixture",
    async decide(context) {
      decisions++;
      contexts.push(structuredClone(context));
      await gate;
      const inbound = context.messages.at(-1)!;
      if (steps) {
        const step = steps.shift();
        if (!step) throw new Error("Unexpected additional decision");
        if (step instanceof Error) throw step;
        return Promise.resolve(structuredClone(step));
      }
      equal(inbound.role, "tool");
      return Promise.resolve({ kind: "reply", text: "Travail terminé" });
    },
    review() {
      throw new Error("No review requested");
    },
  };
  const source: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize() {
      return Promise.resolve(structuredClone(model.identity));
    },
    readExecutableModel(_identity, repositoryVersion) {
      versions.set(model.version.repositoryVersion, structuredClone(model));
      const selected = repositoryVersion === undefined
        ? model
        : versions.get(repositoryVersion);
      if (!selected) throw new Error("The exact fixture source is unavailable");
      return Promise.resolve(structuredClone(selected));
    },
    applyApprovedChange() {
      throw new Error("No model mutation requested");
    },
    activateCandidate(_identity, candidate) {
      if (steps) {
        const binding = {
          elementId: `native-${candidate.id}`,
          graphPath: "fixture",
        };
        model.catalog.push({
          nativeId: binding.elementId,
          candidateId: candidate.id,
          contractId: `contract-${candidate.kind}`,
          name: candidate.name,
          kind: candidate.kind,
          digest: candidate.digest,
          status: "active",
        });
        return Promise.resolve(binding);
      }
      throw new Error("No candidate requested");
    },
    graph() {
      return Promise.resolve({});
    },
  };
  const runner: ToolRunnerPort = {
    test() {
      if (steps) {
        tests++;
        return Promise.resolve({ passed: true, checks: [] });
      }
      throw new Error("No tool test requested");
    },
    run() {
      throw new Error("No tool invocation requested");
    },
  };
  // Reopening a store retains the real memory ledger, saver and state history.
  let native = nativeExecutions.get(store);
  if (!native) {
    native = createTestNativeExecution(store);
    nativeExecutions.set(store, native);
  }
  const retainedNative = native;
  const service = new SystemRuntime({
    agents,
    model: source,
    runner,
    store: retainedNative.store,
    execution: retainedNative.execution,
    dispatch: retainedNative.dispatch,
    stateHistory: retainedNative.stateHistory,
    artifactSources: retainedNative.artifactSources,
  });
  const initialize = service.initialize.bind(service);
  const localIdle = service.idle.bind(service);
  service.initialize = async (...args) => {
    await initialize(...args);
    retainedNative.bind(service);
    service.idle = async () => {
      await localIdle();
      await retainedNative.idle();
      await localIdle();
    };
  };
  return {
    service,
    store,
    source,
    contexts,
    async injectBusinessState(state: SystemRuntimeState) {
      await retainedNative.store.save({
        ...structuredClone(state),
        revision: state.revision + 1,
      }, state.revision);
    },
    get decisions() {
      return decisions;
    },
    get tests() {
      return tests;
    },
  };
}

const draft: ToolDraft = {
  name: "Lecteur",
  kind: "read_web_page",
  description: "Extrait une page",
  code: "export default ({html}) => ({title:'Page',text:html})",
};
const propose: ChatDecision = {
  kind: "propose_tool",
  text: "Je propose le lecteur demandé.",
  tool: draft,
};
const reply: ChatDecision = { kind: "reply", text: "Contribution terminée" };

function request(): OperatorWorkContribution {
  return {
    text: "Effectue le travail transmis par le coordinateur.",
    correlationId: "plan:task:one",
    proof: {
      caseId: "central:case:1",
      caseContext: {
        caseId: "central:case:1",
        number: 1,
        modelPin: {
          digest: "caller-admitted",
          repositoryVersion: "branch:caller",
        },
      },
      callerId: "coordinator",
      invocationId: "invocation-one",
      modelVersion: {
        digest: "caller-admitted",
        repositoryVersion: "branch:caller",
      },
      behavior: {
        id: "access-worker",
        name: "Dispatch",
        description: "Admitted inbox",
        targetNativeId: "inbox-worker",
        targetTypeId: "inbox-type",
        inputTypeId: "work-input",
        callerNativeId: "coordinator",
        sourceIds: ["access-native"],
        inputSchema: { type: "object" },
      },
    },
  };
}

Deno.test("native work uses the ordinary conversation loop and persists a correlated result", async () => {
  const f = ports(admitted());
  await f.service.initialize();
  await f.service.submitWork(request());
  await f.service.idle();
  equal(f.decisions, 1);
  const state = f.service.snapshot;
  equal(state.busy, false);
  const result = recordedOperatorWork(
    state,
    "worker",
    "coordinator",
    "plan:task:one",
  )!;
  equal(result.result.status, "completed");
  equal(result.result.messages[0]!.role, "tool");
  equal(result.result.messages[0]!.text, request().text);
  equal(result.result.messages.at(-1)!.text, "Travail terminé");
  deepStrictEqual(result.result.candidateIds, []);
  equal(result.result.revision, state.revision);
  equal(state.events.at(-1)!.kind, "operator-work-completed");
});

for (const caseClosure of ["done", "abandoned"] as const) {
  Deno.test(`delegated reply with ${caseClosure} closure completes without closing the owner's Request`, async () => {
    const first = ports(admitted(), undefined, [{
      kind: "reply",
      text: "Contribution terminée",
      caseClosure,
    }]);
    await first.service.initialize();
    await first.service.submitWork(request());
    await first.service.idle();
    const state = first.service.snapshot;
    equal(state.error, undefined);
    equal(state.busy, false);
    equal(state.cases?.length ?? 0, 0);
    equal(state.events.some((event) => event.kind === "case-closed"), false);
    const result = recordedOperatorWork(
      state,
      "worker",
      "coordinator",
      "plan:task:one",
    )!.result;
    equal(result.status, "completed");
    equal(result.error, undefined);
    equal(result.messages.at(-1)!.text, "Contribution terminée");
    equal(result.messages.at(-1)!.caseId, request().proof.caseId);

    const restarted = ports(admitted(), first.store, []);
    await restarted.service.initialize();
    await restarted.service.submitWork(request());
    await restarted.service.idle();
    equal(restarted.decisions, 0);
    deepStrictEqual(
      recordedOperatorWork(
        restarted.service.snapshot,
        "worker",
        "coordinator",
        "plan:task:one",
      )!.result,
      result,
    );
  });
}

// A closed plan resumed by a sibling's completion asks whether this work's
// accepted delivery still runs: true during its turn, false once settled.
Deno.test("a journalled work's delivery is live while its turn runs, not once it settled", async () => {
  const gate = Promise.withResolvers<void>();
  const f = ports(admitted(), undefined, undefined, [], gate.promise);
  await f.service.initialize();
  await f.service.submitWork(request());
  const running = await eventually(() =>
    f.decisions > 0
      ? recordedOperatorWork(
        f.service.snapshot,
        "worker",
        "coordinator",
        "plan:task:one",
      )
      : undefined, { label: "the work's turn reaches its provider" });
  equal(running.settled, false, "no terminal receipt during the turn");
  equal(await f.service.workDeliveryLive("coordinator", "plan:task:one"), true);
  gate.resolve();
  await f.service.idle();
  equal(
    recordedOperatorWork(
      f.service.snapshot,
      "worker",
      "coordinator",
      "plan:task:one",
    )!.settled,
    true,
  );
  equal(
    await f.service.workDeliveryLive("coordinator", "plan:task:one"),
    false,
  );
  equal(await f.service.workDeliveryLive("coordinator", "unknown"), false);
});

Deno.test("completed work is observed after restart without another provider call", async () => {
  const first = ports(admitted());
  await first.service.initialize();
  await first.service.submitWork(request());
  await first.service.idle();
  const original = recordedOperatorWork(
    first.service.snapshot,
    "worker",
    "coordinator",
    "plan:task:one",
  )!.result;
  const restarted = ports(admitted(), first.store);
  await restarted.service.initialize();
  const messages = restarted.service.snapshot.messages;
  await restarted.service.submitWork(request());
  await restarted.service.idle();
  equal(restarted.decisions, 0);
  deepStrictEqual(restarted.service.snapshot.messages, messages);
  deepStrictEqual(
    recordedOperatorWork(
      restarted.service.snapshot,
      "worker",
      "coordinator",
      "plan:task:one",
    )!.result,
    original,
  );
});

Deno.test("an interrupted recorded work request is not replayed or reported complete", async () => {
  const first = ports(admitted());
  await first.service.initialize();
  await first.service.submitWork(request());
  await first.service.idle();
  const interrupted = first.service.snapshot;
  interrupted.events = interrupted.events.filter((event) =>
    !event.kind.startsWith("operator-work-completed")
  );
  interrupted.messages.pop();
  interrupted.busy = true;
  const restarted = ports(admitted(), new MemoryStore(interrupted));
  await restarted.service.initialize();
  await restarted.service.submitWork(request());
  equal(restarted.decisions, 0);
  const result = recordedOperatorWork(
    restarted.service.snapshot,
    "worker",
    "coordinator",
    "plan:task:one",
  )!.result;
  equal(result.status, "failed");
  equal(result.messages.length, 0);
  equal(result.error?.includes("aucune répétition automatique"), true);
});

Deno.test("a correlation cannot be reused to run a changed request", async () => {
  const f = ports(admitted());
  await f.service.initialize();
  await f.service.submitWork(request());
  await f.service.idle();
  await rejects(
    () => f.service.submitWork({ ...request(), text: "Autre effet" }),
    /autre contenu/,
  );
  equal(f.decisions, 1);
});

Deno.test("a new session starts from its pinned admitted contract rather than a later HEAD", async () => {
  const pinned = admitted();
  const head = structuredClone(pinned);
  head.version.digest = "unadopted-head";
  head.version.repositoryVersion = "branch:head";
  const f = ports(head, undefined, undefined, [pinned]);
  await f.service.initialize(pinned);
  equal(
    f.service.snapshot.executionModel!.version.digest,
    pinned.version.digest,
  );
  equal(
    f.service.snapshot.availableExecutionModel!.version.digest,
    "unadopted-head",
  );
  await f.service.submitWork(request());
  await rejects(
    () => f.service.idle(),
    /une admission explicite de sa version est requise/,
  );
  equal(f.decisions, 0);
  deepStrictEqual(f.service.snapshot.executionModel!.version, pinned.version);
  deepStrictEqual(
    f.service.snapshot.availableExecutionModel!.version,
    head.version,
  );
  equal(
    f.service.snapshot.events.some((event) =>
      event.kind === "operator-work-failed"
    ),
    true,
  );
});

Deno.test("an initial pinned contract cannot change scope and cannot replace a saved admission", async () => {
  const pinned = admitted();
  const wrong = structuredClone(pinned);
  wrong.identity.builderId = "another-worker";
  const f = ports(pinned);
  await rejects(() => f.service.initialize(wrong), /autre portée/);
  equal(f.store.value, null);
  await f.service.initialize();
  const newer = structuredClone(pinned);
  newer.version.digest = "later-admission";
  const restarted = ports(pinned, f.store);
  await restarted.service.initialize(newer);
  equal(
    restarted.service.snapshot.executionModel!.version.digest,
    pinned.version.digest,
  );
});

Deno.test("human admission settles the correlated waiting contribution without replaying its work", async () => {
  const model = admitted();
  const contribution = request();
  contribution.proof.caseId = "central:case:1";
  contribution.proof.caseContext = {
    caseId: contribution.proof.caseId,
    number: 1,
    modelPin: contribution.proof.modelVersion,
  };
  const first = ports(model, new MemoryStore(), [propose]);
  await first.service.initialize();
  await first.service.submitWork(contribution);
  await first.service.idle();
  const read = (state: SystemRuntimeState) =>
    recordedOperatorWork(
      state,
      "worker",
      "coordinator",
      contribution.correlationId,
    )!
      .result;
  const waiting = read(first.service.snapshot);
  equal(waiting.status, "waiting");
  equal(first.decisions, 1);
  equal(first.tests, 1);
  const candidate = first.service.snapshot.candidates[0]!;

  // Other technical observations are not part of the correlated contribution.
  const persisted = first.service.snapshot;
  persisted.messages.push({
    id: "unrelated-observation",
    role: "tool",
    at: new Date().toISOString(),
    text: "Observation extérieure au travail",
  });
  await first.injectBusinessState(persisted);
  const resumed = ports(model, first.store, [reply]);
  await resumed.service.initialize();
  // As at the end of any accepted delegated turn, the completed work wakes
  // its caller (a closed plan) once its receipt is journalled.
  const notified: Array<{ correlationId: string; recorded: boolean }> = [];
  resumed.service.bindOperatorRegistry({
    snapshot: { conversations: [] } as never,
    withCandidatePublication: (_candidate, publish) => publish(),
    notifyWorkCompletion: (work, completion) => {
      notified.push({
        correlationId: work.correlationId,
        recorded: resumed.service.snapshot.events.some((event) =>
          event.id === completion.id
        ),
      });
      return Promise.resolve();
    },
  });
  const idleOutcomes: string[] = [];
  resumed.service.onState((state) => {
    if (
      !state.busy &&
      state.events.some((event) =>
        event.kind === "operator-work-continuation-started"
      )
    ) idleOutcomes.push(read(state).status);
  });
  await resumed.service.decideCandidate({
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Code et essais examinés",
  });
  await resumed.service.idle();
  equal(resumed.service.snapshot.candidates[0]!.stage, "active");
  const completed = read(resumed.service.snapshot);
  equal(completed.status, "completed");
  equal(completed.caseId, contribution.proof.caseId);
  equal(
    (resumed.service.snapshot.events.find((event) =>
      event.kind === "operator-work-continuation-started"
    ) as import("../operators/journal.ts").OperatorWorkContinuationStart)
      .work.caseId,
    contribution.proof.caseId,
  );
  deepStrictEqual([...new Set(idleOutcomes)], ["completed"]);
  equal(
    resumed.service.snapshot.events.filter((event) =>
      event.kind === "operator-work-completed"
    ).length,
    1,
  );
  deepStrictEqual(notified, [{
    correlationId: contribution.correlationId,
    recorded: true,
  }]);
  equal(completed.messages.at(-1)!.text, reply.text);
  equal(
    completed.messages.some((message) =>
      message.id === "unrelated-observation"
    ),
    false,
  );
  deepStrictEqual(completed.candidateIds, [candidate.id]);
  equal(resumed.decisions, 1);
  equal(resumed.tests, 0);
  await resumed.service.submitWork(contribution);
  await resumed.service.idle();
  equal(resumed.decisions, 1);
  deepStrictEqual(read(resumed.service.snapshot), completed);
  const restarted = ports(model, resumed.store, []);
  await restarted.service.initialize();
  await restarted.service.submitWork(contribution);
  equal(restarted.decisions, 0);
  deepStrictEqual(read(restarted.service.snapshot), completed);
});

Deno.test("successive decisions retain the work boundary until the native continuation returns", async () => {
  const f = ports(admitted(), new MemoryStore(), [
    propose,
    { ...propose, tool: { ...draft, name: "Second lecteur" } },
    reply,
  ]);
  await f.service.initialize();
  await f.service.submitWork(request());
  await f.service.idle();
  const read = () =>
    recordedOperatorWork(
      f.service.snapshot,
      "worker",
      "coordinator",
      request().correlationId,
    )!.result;
  for (let index = 0; index < 2; index++) {
    equal(read().status, "waiting");
    const candidate = f.service.snapshot.candidates[index]!;
    await f.service.decideCandidate({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Essais examinés",
    });
    await f.service.idle();
  }
  equal(read().status, "completed");
  equal(read().candidateIds.length, 2);
  equal(read().messages.at(-1)!.text, reply.text);
  equal(
    new Set(read().messages.map((message) => message.id)).size,
    read().messages.length,
  );
  equal(f.decisions, 3);
  equal(f.tests, 2);
});

Deno.test("an active candidate cannot prove a failed or interrupted continuation completed", async () => {
  const model = admitted();
  const f = ports(model, new MemoryStore(), [
    propose,
    new Error("Suivi interrompu"),
  ]);
  await f.service.initialize();
  await f.service.submitWork(request());
  await f.service.idle();
  const candidate = f.service.snapshot.candidates[0]!;
  await rejects(async () => {
    await f.service.decideCandidate({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Essais examinés",
    });
    await f.service.idle();
  }, /Suivi interrompu/);
  equal(f.service.snapshot.candidates[0]!.stage, "active");
  const read = (state: SystemRuntimeState) =>
    recordedOperatorWork(
      state,
      "worker",
      "coordinator",
      request().correlationId,
    )!
      .result;
  equal(read(f.service.snapshot).status, "failed");
  equal(read(f.service.snapshot).error, "Suivi interrompu");
  // Persisted start without its terminal receipt represents a process interruption.
  const interrupted = f.service.snapshot;
  interrupted.events = interrupted.events.filter((event) =>
    event.kind !== "operator-work-failed"
  );
  const restarted = ports(model, new MemoryStore(interrupted), []);
  await restarted.service.initialize();
  await restarted.service.submitWork(request());
  equal(restarted.decisions, 0);
  equal(read(restarted.service.snapshot).status, "failed");
  equal(
    read(restarted.service.snapshot).error?.includes("reçu de terminaison"),
    true,
  );
});

Deno.test("a designer contribution parks earlier Request work which resumes without claiming designer messages", async () => {
  const f = ports(admitted(), new MemoryStore(), [propose, reply, reply]);
  await f.service.initialize();
  await f.service.submitWork(request());
  await f.service.idle();
  const candidate = f.service.snapshot.candidates[0]!;
  await f.service.submit("Autre dossier confidentiel");
  await f.service.idle();
  equal(
    recordedOperatorWork(
      f.service.snapshot,
      "worker",
      "coordinator",
      request().correlationId,
    )!.result.status,
    "waiting",
  );
  await f.service.decideCandidate({
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Essais examinés",
  });
  await f.service.idle();
  const result = recordedOperatorWork(
    f.service.snapshot,
    "worker",
    "coordinator",
    request().correlationId,
  )!.result;
  equal(result.status, "completed");
  equal(result.error, undefined);
  equal(
    f.contexts.at(-1)!.messages.some((message) =>
      message.text === "Autre dossier confidentiel"
    ),
    false,
  );
  equal(
    result.messages.some((message) =>
      message.text === "Autre dossier confidentiel"
    ),
    false,
  );
  equal(
    f.service.snapshot.events.some((event) =>
      event.kind === "operator-work-continuation-started"
    ),
    true,
  );
  await f.service.submitWork(request());
  equal(f.decisions, 3);
});

Deno.test("an explicit plan resume observes human admission without executing the operator contribution twice", async () => {
  const f = ports(admitted(), new MemoryStore(), [propose, reply]);
  await f.service.initialize();
  const plans = new Map<string, WorkPlanRecord>();
  let observations = 0;
  const executor = new WorkPlanExecutor({
    store: {
      load(id) {
        return Promise.resolve(structuredClone(plans.get(id) ?? null));
      },
      save(record, expected) {
        equal(plans.get(record.id)?.revision ?? null, expected);
        plans.set(record.id, structuredClone(record));
        return Promise.resolve();
      },
    },
    async invokeTarget(invocation) {
      observations++;
      await f.service.submitWork({
        text: invocation.input.text as string,
        correlationId: invocation.invocationId,
        proof: invocation,
      });
      await f.service.idle();
      return {
        behaviorId: invocation.behavior.id,
        targetNativeId: invocation.behavior.targetNativeId,
        invocationId: invocation.invocationId,
        modelVersion: invocation.modelVersion,
        result: recordedOperatorWork(
          f.service.snapshot,
          "worker",
          invocation.callerId,
          invocation.invocationId,
        )!.result,
      };
    },
    completion: (receipt) =>
      (receipt.result as { status: "completed" | "waiting" | "failed" }).status,
  });
  const inbound = request();
  if (!("behavior" in inbound.proof) || !inbound.proof.behavior) {
    throw new Error("Expected the modeled-behavior work fixture");
  }
  const input = { text: inbound.text };
  const plan: WorkPlanExecution = {
    id: "human-admitted-plan",
    caseId: inbound.proof.caseId,
    callerId: inbound.proof.callerId,
    modelVersion: inbound.proof.modelVersion,
    tasks: [{
      id: "build-reader",
      caseId: inbound.proof.caseId,
      dependsOn: [],
      resourceId: "worker",
      inputDigest: await executionDigest(input),
      invocation: {
        ...inbound.proof,
        invocationId: workTaskInvocationId(
          "human-admitted-plan",
          "build-reader",
        ),
        input,
      },
    }],
  };
  equal((await executor.execute(plan)).status, "waiting");
  equal(f.decisions, 1);
  equal((await executor.execute(plan)).status, "waiting");
  equal(observations, 1);
  const candidate = f.service.snapshot.candidates[0]!;
  await f.service.decideCandidate({
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Code et essais examinés",
  });
  await f.service.idle();
  equal(f.decisions, 2);
  equal((await executor.execute(plan)).status, "waiting");
  equal(observations, 1);
  const resumed = await executor.execute(plan, { resume: true });
  equal(resumed.status, "completed");
  deepStrictEqual(resumed.tasks[0]!.attempts!.map((attempt) => attempt.state), [
    "waiting",
    "completed",
  ]);
  equal(observations, 2);
  equal(f.decisions, 2);
  equal(f.tests, 1);
  equal(
    f.service.snapshot.messages.filter((message) =>
      message.text === inbound.text
    ).length,
    1,
  );
});

Deno.test("native source status and the operator's admitted pin override historical pending messages", async () => {
  const model = admitted();
  model.policy.mayProposeSysmlRevision = true;
  const f = ports(model, new MemoryStore(), [
    { kind: "reply", text: "Ma proposition source p1 est pending." },
    reply,
  ]);
  let proposals: ModelSourceProposalStatus[] = [{
    id: "p1",
    baseVersion: "branch:initial",
    status: "proposed",
  }];
  const readers: string[] = [];
  f.source.readSourceProposals = (identity) => {
    readers.push(identity.builderId);
    return Promise.resolve(proposals);
  };
  f.source.readSourceRevision = () =>
    Promise.resolve({
      version: model.version.repositoryVersion!,
      sources: { "own.sysml": "package Own {}" },
      publishedRevisions: {
        limit: 32,
        proposalLimit: 64,
        truncated: false,
        commits: [{
          version: model.version.repositoryVersion!,
          sourceDigest: "shared-accepted-source",
          author: "human:operator",
          createdAt: "2026-10-21T08:00:00Z",
          proposals: [
            { id: "peer-proposal", author: "agent:another-worker" },
            { id: "peer-same-content", author: "agent:second-worker" },
          ],
        }],
      },
    });
  await f.service.initialize();
  await f.service.submit("Propose une évolution");
  await f.service.idle();
  model.version.repositoryVersion = "branch:later-head-same-digest";
  proposals = [{
    id: "p1",
    baseVersion: "branch:initial",
    status: "accepted",
    acceptedVersion: "branch:accepted",
  }];
  await f.service.submitWork(request());
  await f.service.idle();
  const context = f.contexts.at(-1)!;
  equal(context.admittedModelVersion!.repositoryVersion, "branch:admitted");
  // Execution stays pinned; publication observations follow current source.
  deepStrictEqual(context.modelVersion, context.admittedModelVersion);
  equal(context.modelSources!.version, "branch:later-head-same-digest");
  equal(
    context.modelSources!.publishedRevisions!.commits[0]!.proposals![0]!.id,
    "peer-proposal",
  );
  equal(
    context.modelSources!.publishedRevisions!.commits[0]!.proposals![0]!.author,
    "agent:another-worker",
  );
  equal(
    context.modelSources!.publishedRevisions!.commits[0]!.version,
    context.modelSources!.version,
  );
  equal(context.modelSources!.publishedRevisions!.limit, 32);
  equal(context.modelSources!.publishedRevisions!.proposalLimit, 64);
  equal(
    context.modelSources!.publishedRevisions!.commits[0]!.proposals!.length,
    2,
  );
  equal(context.sourceProposals![0]!.status, "accepted");
  equal(context.sourceProposals![0]!.acceptedVersion, "branch:accepted");
  equal(
    context.messages.some((message) => message.text.includes("p1 est pending")),
    false,
  );
  equal(
    f.service.snapshot.messages.some((message) =>
      message.text.includes("p1 est pending")
    ),
    true,
  );
  deepStrictEqual(readers, ["worker", "worker"]);
  equal(
    context.sourceProposals!.some((proposal) =>
      proposal.id === "peer-proposal"
    ),
    false,
  );
  proposals[0]!.status = "rejected";
  equal(context.sourceProposals![0]!.status, "accepted");
});

Deno.test("agent messages omit technical source witnesses while the durable journal retains exact provenance", async () => {
  const f = ports(admitted(), new MemoryStore(), [reply, reply]);
  await f.service.initialize();
  await f.service.submitWork(request());
  await f.service.idle();
  const stored = f.service.snapshot.messages.find((message) =>
    message.text === reply.text
  )!;
  equal(stored.execution!.sourceIds!.length > 0, true);
  const next = request();
  next.correlationId = "another-contribution";
  next.proof.invocationId = "another-invocation";
  await f.service.submitWork(next);
  await f.service.idle();
  const messages = f.contexts.at(-1)!.messages;
  const presented = messages.find((message) => message.id === stored.id)!;
  equal(presented.execution!.sourceIds, undefined);
  equal(presented.execution!.digest, stored.execution!.digest);
  equal(presented.execution!.actionId, stored.execution!.actionId);
  equal(
    presented.execution!.repositoryVersion,
    stored.execution!.repositoryVersion,
  );
  equal(messages.every((message) => !message.execution?.sourceIds), true);
  deepStrictEqual(
    f.service.snapshot.messages.find((message) => message.id === stored.id),
    stored,
  );
  const latestInput = messages.findLast((message) =>
    message.text === next.text
  )!;
  equal(
    (latestInput as { work?: { correlationId: string } }).work!.correlationId,
    "another-contribution",
  );
});

Deno.test("local and peer work evidence records tests and admission without exposing code or granting local usage", async () => {
  const model = admitted();
  const f = ports(model, new MemoryStore(), [propose, reply, reply, reply]);
  await f.service.initialize();
  await f.service.submitWork(request());
  await f.service.idle();
  const candidate = f.service.snapshot.candidates[0]!;
  await f.service.decideCandidate({
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Essais natifs examinés",
  });
  await f.service.idle();
  const context = f.contexts.at(-1)!;
  const evidence = context.artifacts![0]!;
  equal(evidence.localStage, "active");
  equal(evidence.nativeStatus, "active");
  equal(evidence.activationConfirmed, true);
  equal(evidence.contentDigestMatches, true);
  equal(evidence.tests!.passed, true);
  equal(evidence.admissionDecision!.candidateDigest, candidate.digest);
  equal(evidence.admission!.candidateDigest, candidate.digest);
  equal(evidence.nativeModelVersion!.repositoryVersion, "branch:admitted");
  equal("code" in evidence, false);
  equal("promotionContext" in evidence, false);
  const work = recordedOperatorWork(
    f.service.snapshot,
    "worker",
    "coordinator",
    request().correlationId,
  )!.result;
  deepStrictEqual(
    work.artifacts!.map((record) => record.id),
    work.candidateIds,
  );
  deepStrictEqual(work.artifacts![0], evidence);
  work.artifacts![0]!.tests!.passed = false;
  equal(
    recordedOperatorWork(
      f.service.snapshot,
      "worker",
      "coordinator",
      request().correlationId,
    )!
      .result.artifacts![0]!.tests!.passed,
    true,
  );

  model.catalog[0]!.status = "refused";
  await f.service.submit("Quel est le statut actuel ?");
  await f.service.idle();
  const revoked = f.contexts.at(-1)!;
  equal(revoked.activeTools.length, 0);
  equal(revoked.artifacts![0]!.localStage, "active");
  equal(revoked.artifacts![0]!.nativeStatus, "refused");
  equal(revoked.artifacts![0]!.activationConfirmed, false);
  await f.service.submitWork({
    ...request(),
    correlationId: "second-contribution",
    text: "Un autre travail sans nouvelle construction",
  });
  await f.service.idle();
  const otherWork = recordedOperatorWork(
    f.service.snapshot,
    "worker",
    "coordinator",
    "second-contribution",
  )!.result;
  deepStrictEqual(otherWork.candidateIds, []);
  deepStrictEqual(otherWork.artifacts, []);

  model.catalog[0]!.status = "active";
  const corrupted = f.service.snapshot;
  corrupted.candidates[0]!.code += "\n// changed without admission";
  corrupted.candidates[0]!.reusedFrom = {
    agentId: "publishing-operator",
    candidateId: "published-reader",
    digest: candidate.digest,
    correlationId: "import:reader",
    behaviorId: "local-reuse-access",
    sourceModelDigest: "published-source-digest",
    sourceRepositoryVersion: "branch:published-source",
  };
  const restarted = ports(model, new MemoryStore(corrupted), [reply]);
  await restarted.service.initialize();
  await restarted.service.submit("Vérifie cet artefact");
  await restarted.service.idle();
  const invalid = restarted.contexts[0]!;
  equal(invalid.activeTools.length, 0);
  equal(invalid.artifacts![0]!.nativeStatus, "active");
  equal(invalid.artifacts![0]!.contentDigestMatches, false);
  equal(invalid.artifacts![0]!.activationConfirmed, false);
  deepStrictEqual(
    invalid.artifacts![0]!.reusedFrom,
    corrupted.candidates[0]!.reusedFrom,
  );
});

Deno.test("new native work requires its explicit central Case and never opens a local fallback", async () => {
  const f = ports(admitted());
  await f.service.initialize();
  const contribution = request();
  delete contribution.proof.caseId;
  delete contribution.proof.caseContext;
  const before = f.service.snapshot;
  await rejects(() => f.service.submitWork(contribution));
  equal(f.decisions, 0);
  deepStrictEqual(f.service.snapshot, before);
  equal(f.service.cases.cases.length, 0);
});
