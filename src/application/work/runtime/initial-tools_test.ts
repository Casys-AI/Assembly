import {
  InitialToolsPreparationRefused,
} from "../candidates/initial-tools-preparation.ts";
import {
  InitialAdmissionTransferRefused,
  verifyInitialAdmissionSourceSnapshot,
  verifyInitialAdmissionTransfer,
} from "./initial-admission-transfer.ts";
import {
  type NativeExecutionRequest,
  runtimeRevisionReference,
} from "./execution.ts";
import { selectCaseInvocation } from "../cases/runtime.ts";
import { type Case, isOpenCase } from "../../../domain/work/entities/cases.ts";
import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import { parseAcceptedCommand } from "../operators/command-delivery.ts";
import type {
  OperatorDeliveryReceipt,
  OperatorExecutionDelivery,
  OperatorExecutionDispatchPort,
} from "../operators/execution.ts";
import type { NativeInitialToolSeed } from "../../../domain/work/initial-tool-catalog.ts";
import type {
  ModelBinding,
  Stage,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  draftDigest,
  SystemRuntime,
} from "../../../../test/support/system-runtime.ts";
import type {
  AgentPort,
  ModelPort,
  StorePort,
  ToolRunnerPort,
} from "./ports.ts";

const selected: NativeInitialToolSeed = {
  id: "reader-v1",
  nativeId: "native-reader-selection",
  sourceIds: ["selection-definition", "selection-code"],
  draft: {
    name: "selected-reader",
    description:
      "Exact bytes selected in the model, requiring normal tests and admission",
    kind: "read_web_page",
    code: "export default ({html}) => ({title:'Page',text:html})",
  },
};

async function fixture(seeds: NativeInitialToolSeed[] = [selected]) {
  const native = executableFixture({
    projectId: "git:a07cf71f-fc5a-5819-ab7a-bd2e5d9bcd6b",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  native.version.repositoryVersion = "branch:initial-selection";
  if (seeds.length) native.initialTools = structuredClone(seeds);
  let saved: SystemRuntimeState | null = null;
  let writes = 0, tests = 0, activations = 0, providerCalls = 0;
  let failCreation = false;
  let failBeforePreparationAcceptance = false;
  let losePreparationAllocationAck = false;
  let loseTerminalPreparationAck = false;
  let admissionIntentionFault: "before-commit" | "after-commit" | undefined;
  let admissionIntentionFaults = 0;
  let alterPreparationDelivery:
    | ((delivery: OperatorExecutionDelivery) => void)
    | undefined;
  let sourceUnavailable = false;
  let testsPass = true;
  let pausedTest: { entered: () => void; released: Promise<void> } | undefined;
  const tested: ToolDraft[] = [];
  const stages: Stage[] = [];
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(saved)),
    async save(value, expected) {
      // Real asynchronous optimistic persistence, not shared mutable references.
      await Promise.resolve();
      equal(saved?.revision ?? null, expected);
      if (
        failCreation &&
        value.candidates.length > (saved?.candidates.length ?? 0)
      ) {
        failCreation = false;
        throw new Error("Candidate creation CAS unavailable");
      }
      const newAdmissionIntention = value.candidates.some((candidate) =>
        candidate.initialAdmissionTransfer &&
        !saved?.candidates.find((previous) => previous.id === candidate.id)
          ?.initialAdmissionTransfer
      );
      if (
        newAdmissionIntention && admissionIntentionFault === "before-commit"
      ) {
        admissionIntentionFault = undefined;
        admissionIntentionFaults++;
        throw new Error(
          "Admission intention rejected before business CAS commit",
        );
      }
      const newAllocation = Object.keys(value.initialToolsPreparations ?? {})
        .some((key) => !saved?.initialToolsPreparations?.[key]);
      const newTerminal = Object.entries(value.initialToolsPreparations ?? {})
        .some(([key, intent]) =>
          intent.phase === "terminal" &&
          saved?.initialToolsPreparations?.[key]?.phase === "pending"
        );
      saved = structuredClone(value);
      writes++;
      if (newAdmissionIntention && admissionIntentionFault === "after-commit") {
        admissionIntentionFault = undefined;
        admissionIntentionFaults++;
        throw new Error(
          "Admission intention business CAS committed before ACK",
        );
      }
      if (losePreparationAllocationAck && newAllocation) {
        losePreparationAllocationAck = false;
        throw new Error(
          "Preparation intention committed before allocation ACK",
        );
      }
      if (loseTerminalPreparationAck && newTerminal) {
        loseTerminalPreparationAck = false;
        throw new Error("Terminal preparation committed before worker ACK");
      }
    },
    close: () => Promise.resolve(),
  };
  const execution = createTestNativeExecution(store);
  const inspectAccepted = execution.dispatch.inspectAccepted;
  ok(inspectAccepted);
  const accepted: Array<{
    delivery: OperatorExecutionDelivery;
    receipt: OperatorDeliveryReceipt;
  }> = [];
  let acceptanceBarrier: {
    remaining: number;
    ready: () => void;
    released: Promise<void>;
  } | undefined;
  const dispatch: OperatorExecutionDispatchPort = {
    async enqueue(delivery) {
      if (
        parseAcceptedCommand(delivery)?.command.kind === "prepare-initial-tools"
      ) {
        if (failBeforePreparationAcceptance) {
          failBeforePreparationAcceptance = false;
          throw new Error("Preparation enqueue interrupted before acceptance");
        }
        const alter = alterPreparationDelivery;
        alterPreparationDelivery = undefined;
        alter?.(delivery);
      }
      if (acceptanceBarrier) {
        const barrier = acceptanceBarrier;
        if (--barrier.remaining === 0) {
          acceptanceBarrier = undefined;
          barrier.ready();
        }
        await barrier.released;
      }
      const receipt = await execution.dispatch.enqueue(delivery);
      accepted.push({
        delivery: structuredClone(delivery),
        receipt: structuredClone(receipt),
      });
      return receipt;
    },
    inspect: (identity, id) => execution.dispatch.inspect(identity, id),
    inspectAccepted: (operatorId, id) =>
      inspectAccepted.call(execution.dispatch, operatorId, id),
  };
  const bindings = new Map<string, ModelBinding>();
  const source: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(native.identity)),
    readExecutableModel() {
      return sourceUnavailable
        ? Promise.reject(new Error("HEAD no longer contains this unit"))
        : Promise.resolve(structuredClone(native));
    },
    applyApprovedChange() {
      throw new Error("No mandate change may seed a tool");
    },
    activateCandidate(_identity, candidate) {
      activations++;
      stages.push("active");
      const binding: ModelBinding = {
        elementId: "native-" + candidate.id,
        graphPath: "catalog/" + candidate.id,
      };
      bindings.set(candidate.id, binding);
      native.catalog.push({
        nativeId: binding.elementId,
        candidateId: candidate.id,
        contractId: "contract-" + candidate.kind,
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
      return Promise.resolve(structuredClone(binding));
    },
    findCandidate(_identity, candidate) {
      return Promise.resolve(
        structuredClone(bindings.get(candidate.id) ?? null),
      );
    },
    graph: () => Promise.resolve({}),
  };
  const agents: AgentPort = {
    label: "No-provider initial catalog fixture",
    decide() {
      providerCalls++;
      throw new Error(
        "Initial selection must not ask a provider to recreate bytes",
      );
    },
    review() {
      providerCalls++;
      throw new Error("Human-mode seed must not fabricate a reviewer");
    },
    admit() {
      providerCalls++;
      throw new Error("Human-mode seed must not auto-admit");
    },
  };
  const runner: ToolRunnerPort = {
    async test(draft) {
      tests++;
      tested.push(structuredClone(draft));
      if (pausedTest) {
        const pending = pausedTest;
        pausedTest = undefined;
        pending.entered();
        await pending.released;
      }
      return {
        passed: testsPass,
        checks: [{
          name: "actual selected bytes",
          passed: testsPass,
          detail: "fixture test outcome",
        }],
      };
    },
    run() {
      throw new Error("Initial catalog preparation must not invoke a tool");
    },
  };
  const open = async () => {
    const service = new SystemRuntime({
      model: source,
      store: execution.store,
      execution: execution.execution,
      stateHistory: execution.stateHistory,
      artifactSources: execution.artifactSources,
      dispatch,
      agents,
      runner,
    });
    await service.initialize();
    const localIdle = service.idle.bind(service);
    execution.bind(service);
    service.idle = async () => {
      await localIdle();
      await execution.idle();
      await localIdle();
    };
    return service;
  };
  return {
    native,
    nativeExecution: execution,
    async selectPersistedCaseForRestart(caseId: string) {
      const state = await execution.store.load();
      ok(state);
      const expected = state.revision;
      selectCaseInvocation(state, { kind: "local", caseId });
      state.revision++;
      await execution.store.save(state, expected);
    },
    open,
    service: await open(),
    tested,
    stages,
    accepted,
    commandReceipts: () =>
      Promise.all(
        accepted.map(({ delivery }) =>
          dispatch.inspect(delivery.identity, delivery.id)
        ),
      ),
    holdNextAcceptances(count: number) {
      let ready!: () => void, release!: () => void;
      const entered = new Promise<void>((resolve) => ready = resolve);
      const released = new Promise<void>((resolve) => release = resolve);
      acceptanceBarrier = { remaining: count, ready, released };
      return { ready: entered, release };
    },
    failNextCreation: () => failCreation = true,
    failNextPreparationEnqueue: () => failBeforePreparationAcceptance = true,
    loseNextPreparationAllocationAck: () => losePreparationAllocationAck = true,
    loseNextTerminalPreparationAck: () => loseTerminalPreparationAck = true,
    faultNextAdmissionIntention: (boundary: "before-commit" | "after-commit") =>
      admissionIntentionFault = boundary,
    get admissionIntentionFaults() {
      return admissionIntentionFaults;
    },
    alterNextPreparationDelivery: (
      alter: (delivery: OperatorExecutionDelivery) => void,
    ) => alterPreparationDelivery = alter,
    removeFromHead: () => sourceUnavailable = true,
    failTests: () => testsPass = false,
    passTests: () => testsPass = true,
    pauseNextTest() {
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => entered = resolve);
      const released = new Promise<void>((resolve) => release = resolve);
      pausedTest = { entered, released };
      return { ready, release };
    },
    get writes() {
      return writes;
    },
    get tests() {
      return tests;
    },
    get activations() {
      return activations;
    },
    get providerCalls() {
      return providerCalls;
    },
  };
}

/** A public control call acknowledges durable acceptance; the fixture worker
 * must drain before tests inspect the resulting candidate or admission. */
async function prepare(service: SystemRuntime): Promise<void> {
  await service.prepareInitialTools();
  await service.idle();
}

async function decide(
  service: SystemRuntime,
  input: Parameters<SystemRuntime["decideCandidate"]>[0],
): Promise<void> {
  await service.decideCandidate(input);
  await service.idle();
}

Deno.test("source-selected initial tools traverse normal tests and await exact human admission", async () => {
  const f = await fixture();
  await prepare(f.service);
  const waiting = f.service.snapshot.candidates;
  equal(waiting.length, 1);
  const candidate = waiting[0]!;
  equal(candidate.stage, "awaiting-admission");
  equal(candidate.requiredAuthority, "human");
  equal(candidate.tests?.passed, true);
  equal(candidate.admission, undefined);
  equal(candidate.binding, undefined);
  equal(f.native.catalog.length, 0);
  equal(candidate.digest, await draftDigest(selected.draft));
  deepStrictEqual(
    f.tested.map(({ name, description, kind, code }) => ({
      name,
      description,
      kind,
      code,
    })),
    [selected.draft],
  );
  deepStrictEqual(candidate.initialToolSeed, {
    id: selected.id,
    nativeId: selected.nativeId,
    selectionDigest: await draftDigest(selected.draft),
    modelVersion: {
      digest: f.native.version.digest,
      repositoryVersion: f.native.version.repositoryVersion!,
    },
  });
  equal(f.stages.includes("active"), false);
  equal(f.providerCalls, 0);
  await rejects(() =>
    decide(f.service, {
      candidateId: candidate.id,
      candidateDigest: "0".repeat(64),
      verdict: "approve",
      reason: "Wrong bytes must not be admitted",
    }), /candidat exact/);
  equal(f.service.snapshot.candidates[0]!.stage, "awaiting-admission");
  equal((await f.commandReceipts()).at(-1)!.status, "failed");
  await decide(f.service, {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Exact selected bytes tested and explicitly admitted",
  });
  equal(f.service.snapshot.candidates[0]!.stage, "active");
  equal(f.service.snapshot.candidates[0]!.admission?.authority, "human");
  const admitted = f.service.snapshot.candidates[0]!;
  const receipt = admitted.admissionDecision!.authorityExercise!;
  equal(receipt.ownerSource, "implicit-legacy");
  equal(receipt.operatorId, "owner");
  equal(receipt.baseModelDigest, f.native.version.digest);
  equal(receipt.outOfMandate, false);
  deepStrictEqual(admitted.admission!.authorityExercise, receipt);
  deepStrictEqual(
    f.service.snapshot.events.find((event) =>
      event.kind === "human-admission-decided"
    )!.authorityExercise,
    receipt,
  );
  deepStrictEqual(
    f.service.snapshot.events.find((event) => event.kind === "tool-admitted")!
      .authorityExercise,
    receipt,
  );
  equal(f.native.catalog[0]!.status, "active");
  equal((await f.commandReceipts()).at(-1)!.status, "completed");
  equal(f.tests, 1);
  equal(f.providerCalls, 0);
});

Deno.test("restart preserves the initial selection marker without reproposing or retesting pending tools", async () => {
  const f = await fixture();
  await prepare(f.service);
  const before = f.service.snapshot.candidates[0]!;
  const restarted = await f.open();
  const originalReceipt = f.accepted[0].receipt;
  await prepare(restarted);
  const replay = f.accepted.at(-1)!;
  equal(replay.receipt.id, originalReceipt.id);
  equal(replay.receipt.threadId, originalReceipt.threadId);
  equal(replay.receipt.jobId, originalReceipt.jobId);
  equal((await f.commandReceipts()).at(-1)!.status, "completed");
  equal(restarted.snapshot.candidates.length, 1);
  equal(restarted.snapshot.candidates[0]!.id, before.id);
  deepStrictEqual(
    restarted.snapshot.candidates[0]!.initialToolSeed,
    before.initialToolSeed,
  );
  equal(restarted.snapshot.candidates[0]!.stage, "awaiting-admission");
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

Deno.test("changed selected bytes require an explicit conflict after the earlier exact admission settles", async () => {
  const f = await fixture();
  await prepare(f.service);
  const waiting = f.service.snapshot.candidates[0]!;
  await decide(f.service, {
    candidateId: waiting.id,
    candidateDigest: waiting.digest,
    verdict: "approve",
    reason:
      "Settle the old selected bytes before adopting another source selection",
  });
  const before = f.service.snapshot.candidates[0]!;
  equal(before.stage, "active");
  f.native.initialTools![0]!.draft.code =
    "export default () => ({title:'changed',text:'changed'})";
  f.native.version.digest = "source-selection-revised";
  f.native.version.repositoryVersion = "branch:selection-revised";
  await f.service.adoptModelVersion({
    expectedDigest: f.native.version.digest,
  });
  const acceptedBeforeConflict = f.accepted.length;
  const writesBeforeConflict = f.writes;
  await rejects(() => prepare(f.service), {
    name: "Error",
    message:
      "La sélection initiale a changé ; révisez explicitement son candidat existant.",
  });
  equal(
    f.accepted.length,
    acceptedBeforeConflict,
    "The conflict refuses before another job is accepted",
  );
  equal(
    f.writes,
    writesBeforeConflict,
    "The conflict allocates no new Case or intention",
  );
  equal(f.tests, 1);
  equal(f.activations, 1);
  equal(f.providerCalls, 0);
  equal(f.service.snapshot.candidates.length, 1);
  deepStrictEqual(f.service.snapshot.candidates[0], before);
  equal(f.native.catalog[0]!.status, "active");
});

Deno.test("no initial selection makes preparation inert without provider calls or state writes", async () => {
  const f = await fixture([]);
  const writes = f.writes;
  await prepare(f.service);
  equal(f.writes, writes);
  equal(f.tests, 0);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
  equal(f.service.snapshot.candidates.length, 0);
});

Deno.test("failing initial tool tests never admit or activate the selected bytes and restart does not retry", async () => {
  const f = await fixture();
  f.failTests();
  await prepare(f.service);
  const candidate = f.service.snapshot.candidates[0]!;
  equal(candidate.tests?.passed, false);
  equal(candidate.stage, "refused");
  equal(candidate.admission, undefined);
  ok(candidate.initialToolSeed);
  equal(f.stages.includes("active"), false);
  await prepare(await f.open());
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

Deno.test("identical competing initial preparations share one durable command while its promotion is reserved", async () => {
  const f = await fixture();
  const acceptance = f.holdNextAcceptances(2);
  const paused = f.pauseNextTest();
  const preparing = f.service.prepareInitialTools();
  const competing = f.service.prepareInitialTools();
  await acceptance.ready;
  acceptance.release();
  await Promise.all([preparing, competing]);
  await paused.ready;
  try {
    equal(f.accepted.length, 2, "Both callers received durable acceptance");
    deepStrictEqual(f.accepted[0].delivery, f.accepted[1].delivery);
    equal(
      parseAcceptedCommand(f.accepted[0].delivery)!.command.kind,
      "prepare-initial-tools",
    );
    equal(f.accepted[0].receipt.id, f.accepted[1].receipt.id);
    equal(f.accepted[0].receipt.threadId, f.accepted[1].receipt.threadId);
    equal(f.accepted[0].receipt.jobId, f.accepted[1].receipt.jobId);
    const preparations = Object.values(
      f.service.snapshot.initialToolsPreparations ?? {},
    );
    equal(preparations.length, 1);
    equal(
      f.accepted[0].delivery.identity.scope.scopeId,
      preparations[0].caseId,
    );
    equal(
      f.service.snapshot.cases!.filter((record) =>
        record.id === preparations[0].caseId
      ).length,
      1,
    );
    deepStrictEqual(
      (await f.commandReceipts()).map((receipt) => receipt!.status),
      [
        "running",
        "running",
      ],
    );
    equal(f.tests, 1);
    equal(f.activations, 0);
    equal(f.stages.includes("active"), false);
  } finally {
    paused.release();
    await f.service.idle();
  }
  deepStrictEqual(
    (await f.commandReceipts()).map((receipt) => receipt!.status),
    [
      "completed",
      "completed",
    ],
  );
  equal(f.service.snapshot.candidates.length, 1);
  equal(f.service.snapshot.candidates[0].stage, "awaiting-admission");
  const writes = f.writes;
  await prepare(f.service);
  equal(f.accepted.at(-1)!.receipt.jobId, f.accepted[0].receipt.jobId);
  equal((await f.commandReceipts()).at(-1)!.status, "completed");
  equal(f.writes, writes, "A completed deterministic command adds no work");
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

Deno.test("an initial candidate persistence failure cannot leave a seed marker or native capability", async () => {
  const f = await fixture();
  f.failNextCreation();
  await rejects(() => prepare(f.service), {
    name: "Error",
    message: "Candidate creation CAS unavailable",
  });
  equal((await f.commandReceipts()).at(-1)!.status, "failed");
  equal(f.service.snapshot.candidates.length, 0);
  equal(f.native.catalog.length, 0);
  equal(f.tests, 0);
  equal(f.activations, 0);
  equal(f.stages.includes("active"), false);
  equal(f.providerCalls, 0);
});

Deno.test("several initial selections preserve ordinary catalog CAS across sequential human admissions", async () => {
  const second = structuredClone(selected);
  second.id = "reader-v2";
  second.nativeId = "native-reader-selection-two";
  second.draft.name = "selected-reader-two";
  const f = await fixture([selected, second]);
  await prepare(f.service);
  equal(
    f.service.snapshot.candidates.length,
    1,
    "Do not create a future admission against a catalog base that the first admission will advance",
  );
  await prepare(f.service);
  equal(
    f.service.snapshot.candidates.length,
    1,
    "An unresolved first admission holds the remaining source selections",
  );
  const first = f.service.snapshot.candidates[0]!;
  await decide(f.service, {
    candidateId: first.id,
    candidateDigest: first.digest,
    verdict: "approve",
    reason: "First exact selected tool admitted",
  });
  await prepare(f.service);
  const next = f.service.snapshot.candidates.find((candidate) =>
    candidate.initialToolSeed?.id === second.id
  )!;
  ok(next);
  equal(next.stage, "awaiting-admission");
  equal(next.baseCatalogRevision, f.service.snapshot.catalogRevision);
  equal(next.baseCatalogRevision, 1);
  await decide(f.service, {
    candidateId: next.id,
    candidateDigest: next.digest,
    verdict: "approve",
    reason: "Second exact selected tool admitted against the advanced catalog",
  });
  deepStrictEqual(
    f.service.snapshot.candidates.map((candidate) => candidate.stage),
    ["active", "active"],
  );
  equal(f.tests, 2);
  equal(f.activations, 2);
  equal(f.providerCalls, 0);
});

Deno.test("a different source selection cannot be adopted while an exact initial admission is pending", async () => {
  const f = await fixture();
  await prepare(f.service);
  const before = f.service.snapshot;
  const earlier = structuredClone(selected);
  earlier.id = "earlier-reader";
  earlier.nativeId = "native-earlier-selection";
  earlier.draft.name = "earlier-reader";
  f.native.initialTools = [earlier, structuredClone(selected)];
  f.native.version.digest = "source-selection-expanded";
  f.native.version.repositoryVersion = "branch:selection-expanded";
  await rejects(() =>
    f.service.adoptModelVersion({
      expectedDigest: f.native.version.digest,
    }), (error: unknown) => {
    ok(error instanceof Error && "code" in error);
    equal(error.code, "EVOLUTION_BOUNDARY_UNSAFE");
    ok(
      error.message.includes(
        "A candidate, promotion or activation remains unsettled",
      ),
    );
    return true;
  });
  deepStrictEqual(f.service.snapshot.executionModel, before.executionModel);
  deepStrictEqual(f.service.snapshot.candidates, before.candidates);
  equal(f.service.snapshot.candidates[0].stage, "awaiting-admission");
  equal(
    f.service.snapshot.events.filter((event) =>
      event.kind === "model-version-admission-authorized"
    ).length,
    0,
  );
  equal(f.native.catalog.length, 0);
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

Deno.test("a completed human admission remains successful when a later initial selection conflicts with a refused candidate", async () => {
  const blocked = structuredClone(selected);
  blocked.id = "previous-refused-selection";
  blocked.nativeId = "native-previous-selection";
  blocked.draft.name = "blocked-next-reader";
  const f = await fixture([blocked]);
  f.failTests();
  await prepare(f.service);
  const refused = f.service.snapshot.candidates[0]!;
  equal(refused.stage, "refused");
  equal(refused.admission, undefined);
  f.passTests();
  const next = structuredClone(blocked);
  next.id = "next-selection";
  next.nativeId = "native-next-selection";
  f.native.initialTools = [structuredClone(selected), next];
  // The collision is with retained runtime history, not an invalid source
  // manifest or changed bytes under an unchanged executable pin.
  f.native.contextPolicy = {
    kind: "separated-context",
    pattern: "5.1",
    id: "local-context",
    revision: 1,
    elementId: "local-context",
    sourceIds: ["local-context"],
    recentMessages: 8,
    maxMessageCharacters: 2000,
    maxCollectionItems: 12,
    maxContextCharacters: 250000,
  };
  f.native.version.digest = "source-selection-expanded";
  f.native.version.repositoryVersion = "branch:selection-expanded";
  await f.service.adoptModelVersion({
    expectedDigest: f.native.version.digest,
  });
  await prepare(f.service);
  const waiting = f.service.snapshot.candidates.find((candidate) =>
    candidate.initialToolSeed?.id === selected.id
  )!;
  equal(waiting.stage, "awaiting-admission");
  await decide(f.service, {
    candidateId: waiting.id,
    candidateDigest: waiting.digest,
    verdict: "approve",
    reason: "Admit these exact tested bytes independently of later preparation",
  });
  const state = f.service.snapshot;
  const admitted = state.candidates.find((candidate) =>
    candidate.id === waiting.id
  )!;
  equal(admitted.stage, "active");
  equal(admitted.admission?.authority, "human");
  equal(admitted.digest, waiting.digest);
  deepStrictEqual(
    state.candidates.find((candidate) => candidate.id === refused.id),
    refused,
  );
  equal(f.native.catalog[0]!.status, "active");
  equal(
    state.error,
    undefined,
    "A later preparation failure cannot reject the committed admission",
  );
  equal(
    state.events.some((event) =>
      event.kind === "initial-tools-preparation-failed"
    ),
    true,
  );
  const feedback = state.messages.findLast((message) =>
    message.observation?.kind === "tool-failure"
  );
  ok(feedback);
  deepStrictEqual(feedback.observation!.value, {
    code: "INITIAL_TOOLS_PREPARATION_FAILED",
    details:
      "Un candidat du catalogue porte déjà ce nom ; la sélection initiale ne le remplace pas.",
  });
  equal((await f.commandReceipts()).at(-1)!.status, "completed");
  equal(f.tests, 2);
  equal(f.activations, 1);
  equal(f.providerCalls, 0);
  const writes = f.writes;
  const preparation = f.accepted.findLast(({ delivery }) =>
    parseAcceptedCommand(delivery)?.command.kind === "prepare-initial-tools"
  )!;
  const acceptedBeforeRepeat = f.accepted.length;
  await rejects(
    () => prepare(f.service),
    /Un candidat du catalogue porte déjà ce nom/,
  );
  equal(f.accepted.length, acceptedBeforeRepeat);
  const knownPreparation = await f.nativeExecution.dispatch.inspect(
    preparation.delivery.identity,
    preparation.delivery.id,
  );
  equal(knownPreparation!.jobId, preparation.receipt.jobId);
  equal(knownPreparation!.status, "completed");
  equal((await f.commandReceipts()).at(-1)!.status, "completed");
  equal(f.writes, writes);
  equal(
    f.service.snapshot.candidates.find((candidate) =>
      candidate.id === waiting.id
    )!.stage,
    "active",
  );
  equal(f.tests, 2);
});

Deno.test("a prepared initial selection restarts on its admitted source while a changed HEAD awaits adoption", async () => {
  const f = await fixture();
  await prepare(f.service);
  const before = f.service.snapshot;
  f.native.version.digest = "source-head-unadopted";
  f.native.version.repositoryVersion = "branch:head-unadopted";
  f.native.initialTools![0]!.draft.code =
    "export default () => ({title:'unadopted',text:'unadopted'})";
  const restarted = await f.open();
  const writes = f.writes;
  const originalReceipt = f.accepted[0].receipt;
  await prepare(restarted);
  const replay = f.accepted.at(-1)!;
  equal(replay.receipt.id, originalReceipt.id);
  equal(replay.receipt.threadId, originalReceipt.threadId);
  equal(replay.receipt.jobId, originalReceipt.jobId);
  equal((await f.commandReceipts()).at(-1)!.status, "completed");
  equal(
    f.writes,
    writes,
    "Already prepared source-pinned history needs no startup mutation",
  );
  deepStrictEqual(restarted.snapshot.executionModel, before.executionModel);
  deepStrictEqual(
    restarted.snapshot.candidates[0]!.initialToolSeed,
    before.candidates[0]!.initialToolSeed,
  );
  equal(
    restarted.snapshot.availableExecutionModel?.version.digest,
    f.native.version.digest,
  );
  equal(restarted.snapshot.candidates[0]!.stage, "awaiting-admission");
  equal(restarted.snapshot.error, undefined);
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

Deno.test("a removed unit HEAD cannot make prepared initial history fail to reopen", async () => {
  const f = await fixture();
  await prepare(f.service);
  const before = f.service.snapshot;
  f.removeFromHead();
  const restarted = await f.open();
  const writes = f.writes;
  const originalReceipt = f.accepted[0].receipt;
  await prepare(restarted);
  const replay = f.accepted.at(-1)!;
  equal(replay.receipt.id, originalReceipt.id);
  equal(replay.receipt.threadId, originalReceipt.threadId);
  equal(replay.receipt.jobId, originalReceipt.jobId);
  equal((await f.commandReceipts()).at(-1)!.status, "completed");
  equal(f.writes, writes);
  deepStrictEqual(restarted.snapshot.executionModel, before.executionModel);
  deepStrictEqual(restarted.snapshot.candidates, before.candidates);
  equal(
    restarted.snapshot.phase,
    "Source native indisponible : exécution suspendue",
  );
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

Deno.test("an unprepared initial selection makes no effects on restart until the changed HEAD is explicitly adopted", async () => {
  const f = await fixture();
  const before = f.service.snapshot;
  f.native.version.digest = "source-head-unadopted";
  f.native.version.repositoryVersion = "branch:head-unadopted";
  f.native.initialTools![0]!.draft.code =
    "export default () => ({title:'adopted later',text:'adopted later'})";
  const restarted = await f.open();
  const writes = f.writes;
  const acceptedBeforeUnadopted = f.accepted.length;
  await rejects(() => prepare(restarted), {
    name: "Error",
    message:
      "Le modèle natif a changé ; une admission explicite de sa version est requise avant toute décision ou effet.",
  });
  equal(
    f.accepted.length,
    acceptedBeforeUnadopted,
    "An unadopted pin cannot allocate or enqueue preparation",
  );
  equal(f.writes, writes);
  deepStrictEqual(restarted.snapshot.executionModel, before.executionModel);
  equal(
    restarted.snapshot.availableExecutionModel?.version.digest,
    f.native.version.digest,
  );
  equal(restarted.snapshot.candidates.length, 0);
  equal(f.tests, 0);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
  await restarted.adoptModelVersion({
    expectedDigest: f.native.version.digest,
  });
  await prepare(restarted);
  equal(restarted.snapshot.candidates[0]!.stage, "awaiting-admission");
  equal(
    restarted.snapshot.candidates[0]!.code,
    f.native.initialTools![0]!.draft.code,
  );
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

Deno.test("initial admission transfers its exact saved wait and preserves the closed preparation", async () => {
  const f = await fixture();
  await prepare(f.service);
  const before = f.service.snapshot;
  const candidate = before.candidates[0];
  const oldCase = before.cases!.find((record) =>
    record.id === candidate.caseId
  )!;
  const oldCheckpoints = await f.nativeExecution.checkpoints();
  const old = oldCheckpoints.find((record) =>
    record.request.identity.subjectId ===
      candidate.promotionExecution!.subjectId
  )!;
  const source = (await f.nativeExecution.execution.inspect("builder")).find(
    (record) => record.threadId === candidate.promotionExecution!.threadId,
  )!;
  equal(source.waits[0].mechanism, "decide_admission");
  ok(source.initialAdmissionSource);
  const input = {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve" as const,
    reason: "Exact transfer",
  };
  await decide(f.service, input);
  const after = f.service.snapshot;
  const result = after.candidates[0];
  const intent = result.initialAdmissionTransfer!;
  ok(intent);
  equal(intent.source.threadId, source.threadId);
  equal(intent.source.runId, source.runId);
  equal(intent.source.checkpointId, source.checkpointId);
  equal(
    intent.source.settledEffectKey,
    source.initialAdmissionSource.settledEffectKey,
  );
  equal(intent.target.caseId === oldCase.id, false);
  equal(result.promotionExecution!.threadId === source.threadId, false);
  deepStrictEqual(
    after.cases!.find((record) => record.id === oldCase.id),
    oldCase,
  );
  equal(
    after.cases!.find((record) => record.id === intent.target.caseId)!.status,
    "closed-done",
  );
  const frames = await f.nativeExecution.checkpoints();
  const retained = frames.find((record) =>
    record.request.identity.scope.scopeId === oldCase.id
  )!;
  deepStrictEqual(retained, old);
  const target = frames.find((record) =>
    record.request.identity.scope.scopeId === intent.target.caseId
  )!;
  ok(
    target.effects.some((effect) =>
      effect.node.mechanism === "decide_admission" && effect.settled
    ),
  );
  equal(
    target.effects.some((effect) =>
      effect.node.mechanism === "propose_candidate" ||
      effect.node.mechanism === "test_candidate"
    ),
    false,
  );
  equal(f.tests, 1);
  equal(f.activations, 1);
  equal(f.providerCalls, 0);
  const writes = f.writes, jobs = f.accepted.length;
  await decide(f.service, input);
  equal(f.writes, writes);
  equal(f.accepted.length, jobs);
  await rejects(
    () => decide(f.service, { ...input, verdict: "refuse" }),
    InitialAdmissionTransferRefused,
  );
});

for (
  const phase of [
    "before-fork",
    "after-fork",
    "before-selection",
    "after-selection",
  ] as const
) {
  Deno.test(`initial admission recovers the same memory target after ${phase} (not PostgreSQL evidence)`, async () => {
    const f = await fixture();
    await prepare(f.service);
    const candidate = f.service.snapshot.candidates[0];
    const sourceCase = structuredClone(
      f.service.snapshot.cases!.find((record) =>
        record.id === candidate.caseId
      ),
    );
    let fired = false;
    f.nativeExecution.admissionTransferBoundary((boundary) => {
      if (!fired && boundary === phase) {
        fired = true;
        throw new Error(`fault:${phase}`);
      }
    });
    await rejects(() =>
      decide(f.service, {
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Recover the recorded target",
      }), new RegExp(`fault:${phase}`));
    ok(fired);
    const interrupted = f.service.snapshot;
    const intent = interrupted.candidates[0].initialAdmissionTransfer!;
    ok(intent);
    // A failed worker can put the recoverable Case in its open waiting state.
    ok(isOpenCase(
      interrupted.cases!.find((record) => record.id === intent.target.caseId)!,
    ));
    equal(interrupted.candidates[0].stage, "awaiting-admission");
    f.nativeExecution.admissionTransferBoundary();
    const reopened = await f.open();
    await f.nativeExecution.retryFailed();
    const result = reopened.snapshot;
    equal(result.candidates[0].stage, "active");
    equal(
      result.candidates[0].initialAdmissionTransfer!.target.caseId,
      intent.target.caseId,
    );
    equal(
      result.cases!.filter((record) => record.id === intent.target.caseId)
        .length,
      1,
    );
    deepStrictEqual(
      result.cases!.find((record) => record.id === candidate.caseId),
      sourceCase,
    );
    equal(f.tests, 1);
    equal(f.activations, 1);
    equal(f.providerCalls, 0);
  });
}

Deno.test("explicit initial refusal consumes the real admission edge without activation", async () => {
  const f = await fixture();
  await prepare(f.service);
  const candidate = f.service.snapshot.candidates[0];
  await decide(f.service, {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "refuse",
    reason: "Owner refuses these exact bytes",
  });
  equal(f.service.snapshot.candidates[0].stage, "refused");
  equal(
    f.service.snapshot.events.filter((event) =>
      event.kind === "admission-decided"
    ).length,
    1,
  );
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

Deno.test("initial transfer verifier refuses changed evidence, scope, authority, flow, waits and budgets", async () => {
  const f = await fixture();
  await prepare(f.service);
  const candidate = f.service.snapshot.candidates[0];
  f.nativeExecution.admissionTransferBoundary((phase) => {
    if (phase === "before-fork") throw new Error("capture-intent");
  });
  await rejects(
    () =>
      decide(f.service, {
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Capture exact verifier evidence",
      }),
    /capture-intent/,
  );
  const current = f.service.snapshot;
  const intent = current.candidates[0].initialAdmissionTransfer!;
  selectCaseInvocation(current, {
    kind: "local",
    caseId: intent.target.caseId,
  });
  const historical = await f.nativeExecution.stateHistory.loadRevision(
    intent.sourceRevision,
  );
  ok(historical);
  const request: NativeExecutionRequest = {
    initialAdmissionTransfer: structuredClone(intent),
    identity: structuredClone(intent.target.identity),
    contribution: structuredClone(intent.contribution),
    model: structuredClone(f.native),
    flow: structuredClone(f.native.flows.promotion),
    maxSteps: f.native.policy.maxFlowSteps,
    businessRevision: runtimeRevisionReference(current),
  };
  await verifyInitialAdmissionTransfer(request, historical, current);
  // Both active lifecycle states retain the same immutable target birth proof.
  for (const status of ["open", "waiting"] as const) {
    const active = structuredClone(current);
    active.cases!.find((record) => record.id === intent.target.caseId)!.status =
      status;
    await verifyInitialAdmissionTransfer(request, historical, active);
  }
  const birthChanges: Array<(record: Case) => void> = [
    (record) => {
      record.id = "replaced-target";
    },
    (record) => {
      record.number++;
    },
    (record) => {
      record.type = "job";
    },
    (record) => {
      record.caseTypeId = "foreign-type";
    },
    (record) => {
      record.objective = "different birth objective";
    },
    (record) => {
      record.owner = "foreign-owner";
    },
    (record) => {
      record.openedBy = "foreign-opener";
    },
    (record) => {
      record.openedFrom.conversationId = "foreign-conversation";
    },
    (record) => {
      delete record.openedFrom.origin;
    },
    (record) => {
      record.openedFrom.caseId = "foreign-origin-case";
    },
    (record) => {
      record.modelPin.digest = "foreign-model";
    },
    (record) => {
      record.modelPin.repositoryVersion = "foreign-source";
    },
    (record) => {
      record.createdAt = "2000-01-01T00:00:00.000Z";
    },
    (record) => {
      record.budget = { budgetId: "foreign-budget", scopeId: "foreign-scope" };
    },
    (record) => {
      record.firstRequestDispatched = true;
    },
    (record) => {
      record.closedAt = "2000-01-01T00:00:00.000Z";
    },
  ];
  for (const alter of birthChanges) {
    const changed = structuredClone(current);
    alter(changed.cases!.find((record) => record.id === intent.target.caseId)!);
    await rejects(
      () => verifyInitialAdmissionTransfer(request, historical, changed),
      InitialAdmissionTransferRefused,
    );
  }
  const changes: Array<
    (r: NativeExecutionRequest, s: SystemRuntimeState) => void
  > = [
    (r) => {
      r.initialAdmissionTransfer!.candidateId = "foreign";
    },
    (r) => {
      r.initialAdmissionTransfer!.candidateDigest = "0".repeat(64);
    },
    (r) => {
      r.initialAdmissionTransfer!.seed.id = "foreign";
    },
    (r) => {
      r.initialAdmissionTransfer!.testsDigest = "0".repeat(64);
    },
    (r) => {
      r.initialAdmissionTransfer!.preparationEvidence.contractDigest = "0"
        .repeat(64);
    },
    (r) => {
      r.initialAdmissionTransfer!.sourceBinding.bindingId = "foreign";
    },
    (r) => {
      r.initialAdmissionTransfer!.source.identity.operatorId = "foreign";
    },
    (r) => {
      r.initialAdmissionTransfer!.systemId = "foreign";
    },
    (r) => {
      r.initialAdmissionTransfer!.target.caseId = "foreign";
    },
    (r) => {
      r.initialAdmissionTransfer!.source.checkpointId = "foreign";
    },
    (r) => {
      r.initialAdmissionTransfer!.source.occurrenceId = "foreign";
    },
    (r) => {
      r.contribution.id = "foreign";
    },
    (r) => {
      r.flow.rootOccurrenceId = "foreign";
    },
    (r) => {
      r.model.version.digest = "foreign";
    },
    (_r, s) => {
      s.candidates[0].initialToolSeed = undefined;
    },
    (_r, s) => {
      s.candidates[0].tests!.passed = false;
    },
    (_r, s) => {
      s.cases!.find((record) => record.id === intent.target.caseId)!.status =
        "closed-done";
    },
    (_r, s) => {
      s.executionModel!.ownerAuthority = {
        ...intent.decision.authorityExercise!,
        mandateRevision: 99,
      };
    },
    (_r, s) => {
      s.workBudget = { ...(s.workBudget ?? {}), reserved: 1 } as NonNullable<
        SystemRuntimeState["workBudget"]
      >;
    },
  ];
  for (const change of changes) {
    const r = structuredClone(request), s = structuredClone(current);
    change(r, s);
    await rejects(
      () => verifyInitialAdmissionTransfer(r, historical, s),
      InitialAdmissionTransferRefused,
    );
  }
  const source = (await f.nativeExecution.execution.inspect("builder")).find(
    (record) => record.threadId === intent.source.threadId,
  )!;
  await verifyInitialAdmissionSourceSnapshot(intent, source);
  for (
    const mutation of [
      (s: typeof source) => {
        s.unsettledEffects = ["started-or-unknown"];
      },
      (s: typeof source) => {
        s.openImmutableConsultationGroups = ["unfinished"];
      },
      (s: typeof source) => {
        s.waits = [];
      },
      (s: typeof source) => {
        s.initialAdmissionSource!.settledEffectKey = "foreign";
      },
      (s: typeof source) => {
        s.checkpointId = "foreign";
      },
    ]
  ) {
    const changed = structuredClone(source);
    mutation(changed);
    await rejects(
      () => verifyInitialAdmissionSourceSnapshot(intent, changed),
      InitialAdmissionTransferRefused,
    );
  }
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
});

for (const verdict of ["approve", "refuse"] as const) {
  Deno.test(`initial admission keeps B open after the ${verdict} effect receipt until its exact native run drains`, async () => {
    const f = await fixture();
    await prepare(f.service);
    const candidate = f.service.snapshot.candidates[0];
    const oldCase = structuredClone(
      f.service.snapshot.cases!.find((record) =>
        record.id === candidate.caseId
      ),
    );
    let fired = false;
    f.nativeExecution.effectBoundary((boundary) => {
      const terminal = verdict === "approve"
        ? "activate_candidate"
        : "refuse_candidate";
      if (
        !fired && boundary.phase === "after-receipt" &&
        boundary.request.initialAdmissionTransfer &&
        boundary.node.mechanism === terminal
      ) {
        fired = true;
        throw new Error("after-terminal-effect-receipt");
      }
    });
    await rejects(() =>
      decide(f.service, {
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        verdict,
        reason:
          "Drain the exact completed effect before closing its control Case",
      }), /after-terminal-effect-receipt/);
    ok(fired);
    const interrupted = f.service.snapshot;
    const intent = interrupted.candidates[0].initialAdmissionTransfer!;
    equal(
      interrupted.candidates[0].stage,
      verdict === "approve" ? "active" : "refused",
    );
    ok(isOpenCase(
      interrupted.cases!.find((record) => record.id === intent.target.caseId)!,
    ));
    const selected =
      (await f.nativeExecution.execution.inspect(intent.operatorId))
        .find((snapshot) =>
          snapshot.identity.scope.scopeId === intent.target.caseId
        )!;
    equal(selected.status, "failed");
    equal(selected.unsettledEffects.length, 0);
    const beforeFrames = await f.nativeExecution.checkpoints();
    const beforeTarget = beforeFrames.find((frame) =>
      frame.request.identity.scope.scopeId === intent.target.caseId
    )!;
    ok(beforeTarget.effects.some((effect) =>
      effect.node.mechanism ===
        (verdict === "approve" ? "activate_candidate" : "refuse_candidate") &&
      effect.settled
    ));
    ok(beforeTarget.runId);
    equal(beforeTarget.threadId, selected.threadId);
    equal(beforeTarget.request.contribution.id, intent.contribution.id);
    const effectsBefore = beforeTarget.effects.length;
    equal(
      f.service.snapshot.events.filter((event) =>
        event.kind === "admission-decided"
      ).length,
      1,
    );

    f.nativeExecution.effectBoundary();
    const reopened = await f.open();
    ok(isOpenCase(
      reopened.snapshot.cases!.find((record) =>
        record.id === intent.target.caseId
      )!,
    ));
    await f.nativeExecution.retryFailed();

    const after = reopened.snapshot;
    equal(
      after.candidates[0].stage,
      verdict === "approve" ? "active" : "refused",
    );
    equal(
      after.cases!.find((record) => record.id === intent.target.caseId)!.status,
      "closed-done",
    );
    deepStrictEqual(
      after.cases!.find((record) => record.id === candidate.caseId),
      oldCase,
    );
    const completed =
      (await f.nativeExecution.execution.inspect(intent.operatorId))
        .find((snapshot) =>
          snapshot.identity.scope.scopeId === intent.target.caseId
        )!;
    equal(completed.status, "completed");
    // Failed snapshots have no completed run receipt. Prove run stability
    // against the ledger selection captured before restart, not that projection.
    equal(completed.runId, beforeTarget.runId);
    equal(completed.checkpointNamespace, beforeTarget.checkpointNamespace);
    equal(completed.threadId, beforeTarget.threadId);
    equal(completed.threadId, selected.threadId);
    equal(completed.contributionId, intent.contribution.id);
    const afterTarget = (await f.nativeExecution.checkpoints())
      .find((frame) =>
        frame.request.identity.scope.scopeId === intent.target.caseId
      )!;
    equal(afterTarget.threadId, beforeTarget.threadId);
    equal(afterTarget.runId, beforeTarget.runId);
    equal(afterTarget.checkpointNamespace, beforeTarget.checkpointNamespace);
    equal(afterTarget.effects.length, effectsBefore);
    equal(
      after.events.filter((event) => event.kind === "admission-decided").length,
      1,
    );
    equal(f.tests, 1);
    equal(f.activations, verdict === "approve" ? 1 : 0);
    equal(f.providerCalls, 0);
  });
}

Deno.test("recovery selected on B returns to the designer after the exact target closes", async () => {
  const f = await fixture();
  await prepare(f.service);
  const candidate = f.service.snapshot.candidates[0];
  const sourceCase = structuredClone(
    f.service.snapshot.cases!.find((record) => record.id === candidate.caseId),
  );
  f.nativeExecution.admissionTransferBoundary((phase) => {
    if (phase === "before-fork") throw new Error("restart-selected-on-B");
  });
  await rejects(() =>
    decide(f.service, {
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Recover with the exact control Case still selected",
    }), /restart-selected-on-B/);
  const intent = f.service.snapshot.candidates[0].initialAdmissionTransfer!;
  // Simulate the accepted canonical selection retained when a crash prevented
  // the old worker's finally from restoring its earlier designer invocation.
  await f.selectPersistedCaseForRestart(intent.target.caseId);
  f.nativeExecution.admissionTransferBoundary();
  const reopened = await f.open();
  equal(reopened.snapshot.caseInvocation?.kind, "local");
  equal(
    (reopened.snapshot.caseInvocation as { caseId: string }).caseId,
    intent.target.caseId,
  );
  ok(
    isOpenCase(
      reopened.snapshot.cases!.find((record) =>
        record.id === intent.target.caseId
      )!,
    ),
  );
  await f.nativeExecution.retryFailed();
  const after = reopened.snapshot;
  equal(after.candidates[0].stage, "active");
  equal(
    after.cases!.find((record) => record.id === intent.target.caseId)!.status,
    "closed-done",
  );
  equal(after.caseInvocation?.kind, "designer");
  equal(
    (after.caseInvocation as { scopeId: string }).scopeId,
    after.designer!.scopeId,
  );
  deepStrictEqual(
    after.cases!.find((record) => record.id === candidate.caseId),
    sourceCase,
  );
  equal(f.tests, 1);
  equal(f.activations, 1);
  equal(f.providerCalls, 0);
});

Deno.test("initial preparation persists one A before interrupted enqueue and reuses it after restart", async () => {
  const f = await fixture();
  f.failNextPreparationEnqueue();
  await rejects(
    () => prepare(f.service),
    /enqueue interrupted before acceptance/,
  );
  equal(f.accepted.length, 0);
  const recorded = Object.values(
    f.service.snapshot.initialToolsPreparations ?? {},
  );
  equal(recorded.length, 1);
  const intent = structuredClone(recorded[0]);
  equal(intent.phase, "pending");
  ok(
    isOpenCase(
      f.service.snapshot.cases!.find((record) => record.id === intent.caseId)!,
    ),
  );
  equal(f.tests, 0);
  equal(f.providerCalls, 0);
  const reopened = await f.open();
  await prepare(reopened);
  const after = reopened.snapshot;
  equal(Object.keys(after.initialToolsPreparations!).length, 1);
  equal(after.initialToolsPreparations![intent.key].caseId, intent.caseId);
  equal(after.initialToolsPreparations![intent.key].revision, intent.revision);
  equal(f.accepted[0].delivery.identity.scope.scopeId, intent.caseId);
  equal(after.candidates[0].caseId, intent.caseId);
  equal(
    after.cases!.find((record) => record.id === intent.caseId)!.status,
    "closed-done",
  );
  equal(f.tests, 1);
  equal(f.providerCalls, 0);
});

Deno.test("a committed preparation allocation with a lost ACK reuses its Case and intention", async () => {
  const f = await fixture();
  f.loseNextPreparationAllocationAck();
  await prepare(f.service);
  const intents = Object.values(
    f.service.snapshot.initialToolsPreparations ?? {},
  );
  equal(intents.length, 1);
  equal(
    f.service.snapshot.cases!.filter((record) =>
      record.openedFrom.origin === "initialization"
    ).length,
    1,
  );
  equal(f.service.snapshot.candidates[0].caseId, intents[0].caseId);
  equal(f.accepted.length, 1);
  equal(f.accepted[0].delivery.identity.scope.scopeId, intents[0].caseId);
  equal(f.tests, 1);
  equal(f.providerCalls, 0);
});

Deno.test("terminal preparation saved before queue ACK replays its closed A without native effects", async () => {
  const f = await fixture();
  f.loseNextTerminalPreparationAck();
  await rejects(() => prepare(f.service));
  const persisted = await f.nativeExecution.store.load();
  ok(persisted);
  const intent = Object.values(persisted.initialToolsPreparations!)[0];
  equal(intent.phase, "terminal");
  equal(intent.terminal!.outcome, "done");
  const closed = structuredClone(
    persisted.cases!.find((record) => record.id === intent.caseId),
  );
  equal(closed!.status, "closed-done");
  equal(persisted.candidates[0].stage, "awaiting-admission");
  const frames = await f.nativeExecution.checkpoints();
  const reopened = await f.open();
  await f.nativeExecution.retryFailed();
  deepStrictEqual(
    reopened.snapshot.cases!.find((record) => record.id === intent.caseId),
    closed,
  );
  deepStrictEqual(await f.nativeExecution.checkpoints(), frames);
  equal(f.tests, 1);
  equal(f.activations, 0);
  equal(f.providerCalls, 0);
  equal((await f.commandReceipts())[0]!.status, "completed");
});

for (
  const invalid of [
    "missing-intent",
    "changed-revision",
    "designer-delivery",
  ] as const
) {
  Deno.test(`initial preparation refuses ${invalid} before native proposal or tests`, async () => {
    const f = await fixture();
    f.alterNextPreparationDelivery((delivery) => {
      const envelope = delivery.payload as {
        command: { preparation: { key: string; revision: number } };
      };
      if (invalid === "missing-intent") {
        envelope.command.preparation.key = "unknown-preparation";
      }
      if (invalid === "changed-revision") {
        envelope.command.preparation.revision++;
      }
      if (invalid === "designer-delivery") {
        delivery.identity.scope = {
          kind: "designer",
          scopeId: "foreign-designer",
          ownerId: "owner",
        };
        delivery.identity.invocationKey = JSON.stringify([
          "designer",
          "foreign-designer",
        ]);
      }
    });
    await rejects(() => prepare(f.service), InitialToolsPreparationRefused);
    equal(f.service.snapshot.candidates.length, 0);
    equal((await f.nativeExecution.checkpoints()).length, 0);
    equal(f.tests, 0);
    equal(f.activations, 0);
    equal(f.providerCalls, 0);
  });
}

for (const boundary of ["before-commit", "after-commit"] as const) {
  Deno.test(`admission intention recovers ${boundary} at the controlled business CAS (not a full-process crash)`, async () => {
    const f = await fixture();
    await prepare(f.service);
    const candidate = f.service.snapshot.candidates[0];
    const originalA = structuredClone(
      f.service.snapshot.cases!.find((record) =>
        record.id === candidate.caseId
      ),
    );
    const sourceFrames = await f.nativeExecution.checkpoints();
    f.faultNextAdmissionIntention(boundary);
    await rejects(() =>
      decide(f.service, {
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Recover the exact canonical decision across its business CAS",
      })
    );
    equal(f.admissionIntentionFaults, 1);
    const persisted = await f.nativeExecution.store.load();
    ok(persisted);
    const recorded = persisted.candidates[0];
    const recordedB = recorded.initialAdmissionTransfer?.target.caseId;
    if (boundary === "before-commit") {
      equal(recorded.initialAdmissionTransfer, undefined);
      equal(recorded.admissionDecision, undefined);
      equal(
        persisted.cases!.filter((record) =>
          record.openedFrom.origin === "initialization"
        ).length,
        1,
      );
    } else {
      ok(recorded.initialAdmissionTransfer);
      deepStrictEqual(
        recorded.admissionDecision,
        recorded.initialAdmissionTransfer.decision,
      );
      ok(
        isOpenCase(persisted.cases!.find((record) => record.id === recordedB)!),
      );
      equal(
        persisted.cases!.filter((record) =>
          record.openedFrom.origin === "initialization"
        ).length,
        2,
      );
    }
    // Neither store failure reached native target enrollment or a new effect.
    deepStrictEqual(await f.nativeExecution.checkpoints(), sourceFrames);
    equal(f.activations, 0);
    const reopened = await f.open();
    await f.nativeExecution.retryFailed();
    const after = reopened.snapshot;
    const intent = after.candidates[0].initialAdmissionTransfer!;
    equal(after.candidates[0].stage, "active");
    equal(
      after.cases!.filter((record) =>
        record.openedFrom.origin === "initialization"
      ).length,
      2,
    );
    if (recordedB) equal(intent.target.caseId, recordedB);
    deepStrictEqual(
      after.cases!.find((record) => record.id === candidate.caseId),
      originalA,
    );
    equal(
      after.cases!.find((record) => record.id === intent.target.caseId)!.status,
      "closed-done",
    );
    equal(
      after.events.filter((event) => event.kind === "human-admission-decided")
        .length,
      1,
    );
    equal(
      after.events.filter((event) => event.kind === "admission-decided").length,
      1,
    );
    equal(
      after.events.filter((event) => event.kind === "tool-admitted").length,
      1,
    );
    equal((await f.commandReceipts()).at(-1)!.status, "completed");
    equal(f.tests, 1);
    equal(f.activations, 1);
    equal(f.providerCalls, 0);
  });
}
