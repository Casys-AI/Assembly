import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import {
  InMemoryStore,
  type LangGraphRunnableConfig,
  MemorySaver,
} from "@langchain/langgraph";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { CompiledFlow } from "../../../domain/model/execution/flow.ts";
import type {
  ImmutableConsultationGroupSession,
  NativeExecutionHandlers,
  NativeExecutionRequest,
  NativeExecutionSnapshot,
  RequestNetworkContinuation,
} from "../../../application/work/runtime/execution.ts";
import {
  type NativeExecutionLedger,
  type NativeExecutionSession,
  NativeGraphExecution,
} from "./conversation.ts";
import {
  compileNativeOperatorGraph,
  nativeFrameworkNodeName,
} from "./native-graph.ts";

import {
  checkpointConsumptions,
  LEGACY_WAIT_PROTOCOL,
  type NativeWaitConsumptionEvidence,
  TYPED_WAIT_PROTOCOL,
} from "./checkpoint-wait-evidence.ts";

// Official provider/checkpointer mechanics only. This test ledger asserts no SQL,
// durable adoption, current human authority, queue fence or crash-recovery claim.
async function fixture(
  options: { historicalSource?: boolean; sourceProtocol?: string } = {},
) {
  const source = { file: "network-provider.sysml", line: 1, native: true };
  const flow: CompiledFlow = {
    rootNativeId: "flow",
    rootOccurrenceId: "flow-occurrence",
    name: "conversation",
    source,
    startNodeId: "start",
    maxSteps: 32,
    nodes: [
      {
        id: "start",
        nativeId: "start",
        name: "start",
        kind: "start",
        inputs: [],
        outputs: [],
        assertions: [],
        source,
      },
      {
        id: "proposal",
        nativeId: "proposal",
        name: "proposal",
        kind: "action",
        mechanism: "submit_proposal",
        inputs: [],
        outputs: ["submission", "outcome"],
        assertions: [],
        source,
      },
      {
        id: "wait",
        nativeId: "wait",
        name: "wait",
        kind: "action",
        mechanism: "await_input",
        inputs: [],
        outputs: [],
        assertions: [],
        source,
      },
      {
        id: "useful",
        nativeId: "useful",
        name: "useful",
        kind: "action",
        mechanism: "fixture_effect",
        inputs: [],
        outputs: [],
        assertions: [],
        source,
      },
      {
        id: "done",
        nativeId: "done",
        name: "done",
        kind: "done",
        inputs: [],
        outputs: [],
        assertions: [],
        source,
      },
    ],
    edges: [["start", "proposal"], ["proposal", "wait"], ["wait", "useful"], [
      "useful",
      "done",
    ]].map(([from, to]) => ({
      id: `${from}-${to}`,
      nativeId: `${from}-${to}`,
      source: from,
      target: to,
      guardIds: [],
      sourceEvidence: source,
    })),
    bindings: [],
  };
  const model = executableFixture({
    projectId: "project",
    editingContextId: "project/main",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.flows.conversation = flow;
  model.version.digest = "a".repeat(64);
  model.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  const request: NativeExecutionRequest = {
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: "state",
        operatorId: "operator",
        revision: 0,
        modelDigest: model.version.digest,
      },
    },
    identity: {
      operatorId: "operator",
      invocationKey: "local:case",
      scope: { kind: "request", scopeId: "case", rootRequestId: "case" },
      purpose: "conversation",
      subjectId: "original-input",
    },
    contribution: {
      id: "original-input",
      kind: "input",
      inputMessageId: "original-input",
    },
    model,
    flow,
    maxSteps: 32,
  };
  const consumptions = new Map<string, {
    checkpointId: string;
    proof: NativeWaitConsumptionEvidence;
  }>();
  let targetCheckpointId: string | undefined;
  let resumeWrites = 0;
  // This mechanical ledger records its receipt when the official saver commits,
  // never reconstructing a missing modern receipt from a later checkpoint read.
  class FixtureSaver extends MemorySaver {
    override async put(...args: Parameters<MemorySaver["put"]>) {
      const config = await super.put(...args);
      if (config.configurable?.thread_id === "successor") {
        const checkpointId = config.configurable.checkpoint_id;
        ok(typeof checkpointId === "string");
        targetCheckpointId = checkpointId;
        for (
          const proof of checkpointConsumptions(
            args[1],
            args[1].channel_versions,
          )
        ) {
          if (
            proof.kind !== "wait-v1" ||
            !proof.contributionId.startsWith("network-adoption:")
          ) continue;
          const previous = consumptions.get(proof.contributionId);
          if (previous) deepStrictEqual(previous.proof, proof);
          else {consumptions.set(proof.contributionId, {
              checkpointId,
              proof: structuredClone(proof),
            });}
        }
      }
      return config;
    }
    override async putWrites(...args: Parameters<MemorySaver["putWrites"]>) {
      await super.putWrites(...args);
      if (args[0].configurable?.thread_id === "successor") {
        resumeWrites += args[1].filter(([channel]) =>
          channel === "__resume__"
        ).length;
      }
    }
  }
  const store = new InMemoryStore(), saver = new FixtureSaver();
  const calls: string[] = [],
    effects: string[] = [],
    completions: NativeExecutionSnapshot[] = [];
  let openCalls = 0,
    networkCalls = 0,
    forks = 0,
    selected = false,
    forceResume = true,
    unknown = false;
  let beforeFork: Record<string, unknown> | undefined,
    afterFork: Record<string, unknown> | undefined;
  let selectedForkId: string | undefined;
  let networkCompletion: NativeExecutionSnapshot | undefined;
  let mutateNetworkSession:
    | ((selected: NativeExecutionSession) => void)
    | undefined;
  const unused = (): Promise<never> =>
    Promise.reject(new Error("Unused group/evolution operation"));
  const groups: ImmutableConsultationGroupSession = {
    register: unused,
    withPublicationFence: unused,
    memberEffect: unused,
    publish: unused,
    pending: () => Promise.resolve([]),
  };
  function session(
    threadId: string,
    checkpointId?: string,
    contributionId?: string,
  ): NativeExecutionSession {
    return {
      threadId,
      checkpointNamespace: "",
      checkpointId,
      runId: `run-${threadId}`,
      checkpointer: saver,
      immutableConsultations: groups,
      nativeObservations: {
        append: (emission) =>
          Promise.resolve({
            ...structuredClone(emission),
            firstRecordedAt: "2026-10-31T00:00:00.000Z",
          }),
        read: () => Promise.resolve([]),
      },
      assertCurrent: () => Promise.resolve(),
      contributionConsumed: () =>
        Promise.resolve(!!contributionId && consumptions.has(contributionId)),
      withSelectionFence: (operation) => operation(),
      effect: async (key, _node, operation, admit) => {
        await admit?.();
        effects.push(key);
        return await operation();
      },
      unsettledEffects: () => Promise.resolve([]),
      complete: (snapshot) => {
        completions.push(structuredClone(snapshot));
        if (threadId === "successor") {
          networkCompletion = structuredClone(snapshot);
        }
        return Promise.resolve();
      },
      fail: (error) => Promise.reject(error),
      advance: unused,
    };
  }
  const handlers: NativeExecutionHandlers = {
    assertBoundary: () => Promise.resolve(),
    onEvent: () => Promise.resolve(),
    handle: (node) => {
      calls.push(node.mechanism ?? node.id);
      if (node.mechanism === "submit_proposal") {
        return Promise.resolve({
          outputs: {
            submission: { awaitingInput: true },
            outcome: { succeeded: true, code: "PROPOSAL_RECORDED" },
          },
          localState: {
            changeApprovalProposal: {
              changeId: "change",
              proposalIntentDigest: "c".repeat(64),
            },
          },
        });
      }
      return Promise.resolve({});
    },
  };
  const ledger: NativeExecutionLedger = {
    open: () => {
      openCalls++;
      return Promise.resolve(session("predecessor"));
    },
    inspect: () => Promise.resolve(completions),
    readNativeObservations: () => Promise.resolve([]),
    closeScope: unused,
    retireAndAdvance: unused,
    resumeRequestNetworkAdoption: async (target, fork) => {
      networkCalls++;
      if (unknown) {
        throw new Error("Unknown predecessor effect remains blocked");
      }
      const intent = target.networkAdoptionContinuation!;
      if (networkCompletion) {
        ok(consumptions.has(target.contribution.id));
        equal(networkCompletion.threadId, intent.successorThreadId);
        equal(networkCompletion.contributionId, target.contribution.id);
        equal(networkCompletion.modelDigest, target.model.version.digest);
        return {
          ...session(intent.successorThreadId),
          alreadyCompleted: structuredClone(networkCompletion),
        };
      }
      const consumed = consumptions.get(target.contribution.id);
      if (consumed) {
        ok(selectedForkId && targetCheckpointId);
        equal(consumed.proof.kind, "wait-v1");
        equal(consumed.proof.sourceCheckpointId, selectedForkId);
        const resumed = {
          ...session(
            intent.successorThreadId,
            targetCheckpointId,
            target.contribution.id,
          ),
          forceResumeWait: false,
          selectedNetworkContinuation: {
            mode: "consumed-successor" as const,
            threadId: intent.successorThreadId,
            runId: `run-${intent.successorThreadId}`,
            checkpointNamespace: "",
            checkpointId: targetCheckpointId,
            contributionId: target.contribution.id,
          },
        };
        mutateNetworkSession?.(resumed);
        return resumed;
      }
      if (selectedForkId) {
        throw new Error(
          "Selected network successor has no committed consumption receipt",
        );
      }
      const sourceTuple = await saver.getTuple({
        configurable: {
          thread_id: "predecessor",
          checkpoint_ns: "",
          checkpoint_id: initial.checkpointId,
        },
      });
      ok(sourceTuple?.metadata);
      // Equivalent read view to historicalFork: same immutable source tuple, now
      // addressable in the target's unselected namespace. Source stays unchanged.
      const copiedCheckpoint = structuredClone(sourceTuple.checkpoint);
      if (options.historicalSource) {
        delete copiedCheckpoint.channel_values.waitConsumptions;
        delete copiedCheckpoint.channel_versions.waitConsumptions;
        for (const versions of Object.values(copiedCheckpoint.versions_seen)) {
          delete versions.waitConsumptions;
        }
      }
      await saver.put(
        {
          configurable: {
            thread_id: intent.successorThreadId,
            checkpoint_ns: "",
          },
        },
        copiedCheckpoint,
        structuredClone(sourceTuple.metadata),
      );
      const historicalConfig = {
        configurable: {
          thread_id: intent.successorThreadId,
          checkpoint_ns: "",
          checkpoint_id: sourceTuple.checkpoint.id,
        },
      };
      const writes = new Map<string, [string, unknown][]>();
      for (const [taskId, channel, value] of sourceTuple.pendingWrites ?? []) {
        const group = writes.get(taskId) ?? [];
        group.push([channel, value]);
        writes.set(taskId, group);
      }
      for (const [taskId, pending] of writes) {
        await saver.putWrites(historicalConfig, pending, taskId);
      }
      const config: LangGraphRunnableConfig = {
        configurable: {
          thread_id: intent.successorThreadId,
          checkpoint_ns: "",
          checkpoint_id: intent.checkpointId,
        },
      };
      const graph = compileNativeOperatorGraph(target.model, () => {
        throw new Error("Inspection cannot execute a primitive");
      }, {
        scope: target.identity.scope,
        operatorId: target.identity.operatorId,
        flow: target.flow,
        maxSteps: target.maxSteps,
        checkpointer: saver,
        store,
        assertBoundary: () => {
          throw new Error("Inspection cannot execute a node");
        },
      });
      beforeFork = structuredClone((await graph.graph.getState(config)).values);
      const prefixCalls = calls.length, prefixEffects = effects.length;
      forks++;
      const forked = await fork(saver, config, options.sourceProtocol);
      equal(calls.length, prefixCalls);
      equal(effects.length, prefixEffects);
      const view = await graph.graph.getState(forked);
      afterFork = structuredClone(view.values);
      deepStrictEqual(view.next, [nativeFrameworkNodeName("wait")]);
      selected = forceResume;
      const selectedId = forked.configurable?.checkpoint_id;
      ok(typeof selectedId === "string");
      selectedForkId = selectedId;
      const resumed: NativeExecutionSession = {
        ...session(
          intent.successorThreadId,
          selectedId,
          target.contribution.id,
        ),
        forceResumeWait: forceResume,
        ...(forceResume
          ? {
            selectedNetworkContinuation: {
              mode: "awaiting-consumption" as const,
              threadId: intent.successorThreadId,
              runId: `run-${intent.successorThreadId}`,
              checkpointNamespace: "",
              checkpointId: selectedId,
              contributionId: target.contribution.id,
            },
          }
          : {}),
      };
      mutateNetworkSession?.(resumed);
      return resumed;
    },
  };
  const execution = new NativeGraphExecution(store, ledger);
  const initial = await execution.run(request, handlers);
  equal(initial.status, "waiting");
  ok(initial.checkpointId);
  ok(initial.localState?.changeApprovalWait);
  const continuation: RequestNetworkContinuation = {
    commandId: "adoption",
    receiptDigest: "d".repeat(64),
    changeId: "change",
    proposalIntentDigest: "c".repeat(64),
    predecessorThreadId: "predecessor",
    checkpointId: initial.checkpointId,
    successorThreadId: "successor",
    originalInputMessageId: "original-input",
  };
  const adopted = structuredClone(model);
  adopted.version.digest = "b".repeat(64);
  adopted.version.repositoryVersion = `commit:${"b".repeat(40)}`;
  const target: NativeExecutionRequest = {
    ...request,
    model: adopted,
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: "state",
        operatorId: "operator",
        revision: 2,
        modelDigest: adopted.version.digest,
      },
    },
    contribution: {
      id: `network-adoption:${continuation.receiptDigest}`,
      kind: "resume",
      inputMessageId: "original-input",
      networkAdoptionContinuation: continuation,
    },
    networkAdoptionContinuation: continuation,
  };
  return {
    execution,
    handlers,
    saver,
    initial,
    target,
    request,
    calls,
    effects,
    ledger,
    controls: {
      setForce(value: boolean) {
        forceResume = value;
      },
      setUnknown() {
        unknown = true;
      },
      mutateNetworkSession(
        mutation: (selected: NativeExecutionSession) => void,
      ) {
        mutateNetworkSession = mutation;
      },
      forgetConsumptionReceipt() {
        consumptions.delete(target.contribution.id);
      },
    },
    stats: () => ({ openCalls, networkCalls, forks, selected }),
    channels: () => ({ before: beforeFork, after: afterFork }),
    resumeWrites: () => resumeWrites,
  };
}

Deno.test("network continuation forks only the pin/reference and resumes await_input without replaying the proposal", async () => {
  const f = await fixture(),
    beforeSource = await f.saver.getTuple({
      configurable: {
        thread_id: "predecessor",
        checkpoint_id: f.initial.checkpointId,
      },
    });
  deepStrictEqual(f.calls, ["submit_proposal"]);
  const result = await f.execution.run(f.target, f.handlers);
  equal(result.status, "completed");
  deepStrictEqual(f.calls, [
    "submit_proposal",
    "await_input",
    "fixture_effect",
  ]);
  deepStrictEqual(f.stats(), {
    openCalls: 1,
    networkCalls: 1,
    forks: 1,
    selected: true,
  });
  const channels = f.channels();
  ok(channels.before);
  ok(channels.after);
  const retained = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).filter(([key]) =>
        key !== "modelPin" && key !== "continuationRef"
      ),
    );
  deepStrictEqual(retained(channels.before), retained(channels.after));
  equal(
    channels.after.continuationRef,
    `request-network-adoption:${
      f.target.networkAdoptionContinuation!.receiptDigest
    }`,
  );
  const sourcePin = channels.before.modelPin;
  ok(sourcePin && typeof sourcePin === "object" && !Array.isArray(sourcePin));
  deepStrictEqual(channels.after.modelPin, {
    ...sourcePin,
    identity: f.target.model.identity,
    version: f.target.model.version,
  });
  deepStrictEqual(
    await f.saver.getTuple({
      configurable: {
        thread_id: "predecessor",
        checkpoint_id: f.initial.checkpointId,
      },
    }),
    beforeSource,
  );
  equal(result.localState?.changeApprovalWait, undefined);
});
Deno.test("network continuation refuses a missing source checkpoint or foreign approval before native effects", async () => {
  for (const invalid of ["checkpoint", "change"]) {
    const f = await fixture(), target = structuredClone(f.target);
    target.networkAdoptionContinuation = {
      ...target.networkAdoptionContinuation!,
      ...(invalid === "checkpoint"
        ? { checkpointId: "missing-checkpoint" }
        : { changeId: "foreign-change" }),
    };
    target.contribution.networkAdoptionContinuation =
      target.networkAdoptionContinuation;
    await rejects(
      () => f.execution.run(target, f.handlers),
      /approval checkpoint/,
    );
    deepStrictEqual(f.calls, ["submit_proposal"]);
    equal(f.stats().selected, false);
  }
});
Deno.test("network continuation refuses an unselected fork and unknown effects, never a fresh graph", async () => {
  const f = await fixture();
  f.controls.setForce(false);
  await rejects(
    () => f.execution.run(f.target, f.handlers),
    /not been selected/,
  );
  deepStrictEqual(f.calls, ["submit_proposal"]);
  equal(f.stats().openCalls, 1);
  const unknown = await fixture();
  unknown.controls.setUnknown();
  await rejects(
    () => unknown.execution.run(unknown.target, unknown.handlers),
    /Unknown predecessor effect/,
  );
  deepStrictEqual(unknown.calls, ["submit_proposal"]);
  equal(unknown.stats().forks, 0);
});
Deno.test("network continuation rejects a new human contribution, unknown DTO fields, or an absent fork port before ordinary open", async () => {
  const f = await fixture();
  const human = {
    ...f.target,
    contribution: {
      id: "new-human-input",
      kind: "input" as const,
      inputMessageId: "new-human-input",
    },
  };
  await rejects(() => f.execution.run(human, f.handlers), /ledger-bound/);
  const extra = {
    ...f.target.networkAdoptionContinuation!,
    authority: "invented",
  };
  await rejects(
    () =>
      f.execution.run(
        { ...f.target, networkAdoptionContinuation: extra },
        f.handlers,
      ),
    /ledger-bound/,
  );
  delete f.ledger.resumeRequestNetworkAdoption;
  await rejects(
    () => f.execution.run(f.target, f.handlers),
    /durable fork ledger/,
  );
  deepStrictEqual(f.stats(), {
    openCalls: 1,
    networkCalls: 0,
    forks: 0,
    selected: false,
  });
});

Deno.test("network fork accepts only the explicitly legacy source's neutral new channel default", async () => {
  const f = await fixture({
    historicalSource: true,
    sourceProtocol: LEGACY_WAIT_PROTOCOL,
  });
  const before = await f.saver.getTuple({
    configurable: {
      thread_id: "predecessor",
      checkpoint_id: f.initial.checkpointId,
    },
  });
  const result = await f.execution.run(f.target, f.handlers);
  equal(result.status, "completed");
  equal(f.stats().forks, 1);
  deepStrictEqual(f.calls, [
    "submit_proposal",
    "await_input",
    "fixture_effect",
  ]);
  deepStrictEqual(
    await f.saver.getTuple({
      configurable: {
        thread_id: "predecessor",
        checkpoint_id: f.initial.checkpointId,
      },
    }),
    before,
  );
  for (const sourceProtocol of [TYPED_WAIT_PROTOCOL, undefined]) {
    const strict = await fixture({ historicalSource: true, sourceProtocol });
    await rejects(
      () => strict.execution.run(strict.target, strict.handlers),
      /NATIVE_FORK_CHANNEL_CHANGED:waitConsumptions/,
    );
    deepStrictEqual(strict.calls, ["submit_proposal"]);
    equal(strict.stats().selected, false);
  }
});

Deno.test(
  "network continuation continues its selected committed successor without another resume, fork or acceptance",
  async () => {
    const f = await fixture();
    const failure = new Error("controlled failure after committed consumption");
    let armed = true;
    f.handlers.assertBoundary = (node) => {
      if (armed && node.mechanism === "fixture_effect") {
        armed = false;
        return Promise.reject(failure);
      }
      return Promise.resolve();
    };
    await rejects(
      () => f.execution.run(f.target, f.handlers),
      (error) => error === failure,
    );
    deepStrictEqual(f.calls, ["submit_proposal", "await_input"]);
    const committed = await f.saver.getTuple({
      configurable: { thread_id: "successor", checkpoint_ns: "" },
    });
    ok(committed);
    const proofs = checkpointConsumptions(
      committed.checkpoint,
      committed.checkpoint.channel_versions,
    );
    equal(proofs.length, 1);
    equal(proofs[0].kind, "wait-v1");
    equal(proofs[0].contributionId, f.target.contribution.id);
    const resumeWrites = f.resumeWrites();
    ok(resumeWrites > 0, "the initial consumption used a real Command resume");
    const effectCount = f.effects.length;
    const result = await f.execution.run(f.target, f.handlers);
    equal(result.status, "completed");
    equal(
      f.resumeWrites(),
      resumeWrites,
      "committed retry sends no new resume",
    );
    equal(f.effects.length, effectCount + 1, "only the useful effect remains");
    deepStrictEqual(f.calls, [
      "submit_proposal",
      "await_input",
      "fixture_effect",
    ]);
    deepStrictEqual(f.stats(), {
      openCalls: 1,
      networkCalls: 2,
      forks: 1,
      selected: true,
    });
    const acceptanceCount = f.calls.filter((kind) => kind === "await_input");
    equal(acceptanceCount.length, 1);
  },
);

Deno.test(
  "network continuation refuses absent or incoherent selection and foreign or absent session cursors",
  async () => {
    const mutations: Array<(selected: NativeExecutionSession) => void> = [
      (selected) => {
        delete selected.selectedNetworkContinuation;
      },
      (selected) => {
        selected.forceResumeWait = false;
      },
      (selected) => {
        selected.selectedNetworkContinuation = {
          ...selected.selectedNetworkContinuation!,
          mode: "consumed-successor",
        };
      },
      (selected) => {
        delete selected.checkpointId;
      },
      ...[
        "threadId",
        "runId",
        "checkpointNamespace",
        "checkpointId",
        "contributionId",
      ].map((key) => (selected: NativeExecutionSession) => {
        selected.selectedNetworkContinuation = {
          ...selected.selectedNetworkContinuation!,
          [key]: "foreign-selection",
        };
      }),
    ];
    for (const mutation of mutations) {
      const f = await fixture();
      f.controls.mutateNetworkSession(mutation);
      await rejects(
        () => f.execution.run(f.target, f.handlers),
        /not been selected/,
      );
      deepStrictEqual(f.calls, ["submit_proposal"]);
      equal(f.effects.length, 1);
      equal(f.resumeWrites(), 0);
    }
  },
);

Deno.test(
  "network continuation refuses a selected mode without its matching consumption proof",
  async () => {
    for (const consumed of [false, true]) {
      const f = await fixture();
      f.controls.mutateNetworkSession((selected) => {
        selected.forceResumeWait = consumed;
        selected.selectedNetworkContinuation = {
          ...selected.selectedNetworkContinuation!,
          mode: consumed ? "awaiting-consumption" : "consumed-successor",
        };
        selected.contributionConsumed = () => Promise.resolve(consumed);
      });
      await rejects(
        () => f.execution.run(f.target, f.handlers),
        /selection consumption proof differs/,
      );
      deepStrictEqual(f.calls, ["submit_proposal"]);
      equal(f.resumeWrites(), 0);
    }
  },
);

Deno.test(
  "network continuation keeps the completed receipt fast return without a pending selection mode",
  async () => {
    const f = await fixture();
    const completed = await f.execution.run(f.target, f.handlers);
    const calls = [...f.calls], effects = [...f.effects];
    const resumeWrites = f.resumeWrites();
    deepStrictEqual(await f.execution.run(f.target, f.handlers), completed);
    deepStrictEqual(f.calls, calls);
    deepStrictEqual(f.effects, effects);
    equal(f.resumeWrites(), resumeWrites);
    equal(f.stats().forks, 1);
  },
);

Deno.test(
  "network continuation cannot rebuild a missing committed receipt from the technical checkpoint",
  async () => {
    const f = await fixture();
    const failure = new Error("controlled failure after committed consumption");
    f.handlers.assertBoundary = (node) =>
      node.mechanism === "fixture_effect"
        ? Promise.reject(failure)
        : Promise.resolve();
    await rejects(
      () => f.execution.run(f.target, f.handlers),
      (error) => error === failure,
    );
    const checkpoint = await f.saver.getTuple({
      configurable: { thread_id: "successor", checkpoint_ns: "" },
    });
    ok(checkpoint);
    equal(
      checkpointConsumptions(
        checkpoint.checkpoint,
        checkpoint.checkpoint.channel_versions,
      )[0].contributionId,
      f.target.contribution.id,
    );
    f.controls.forgetConsumptionReceipt();
    await rejects(
      () => f.execution.run(f.target, f.handlers),
      /no committed consumption receipt/,
    );
    deepStrictEqual(f.calls, ["submit_proposal", "await_input"]);
    equal(f.stats().forks, 1);
  },
);

Deno.test("a Request change continuation calls its durable fork ledger as a method", async () => {
  const f = await fixture();
  // The production ledger is a class with private state: a detached call
  // loses it. The resumed continuation must keep the ledger as receiver.
  const original = f.ledger.resumeRequestNetworkAdoption!;
  const receivers: unknown[] = [];
  f.ledger.resumeRequestNetworkAdoption = function (
    this: unknown,
    ...args: Parameters<typeof original>
  ) {
    receivers.push(this);
    return original(...args);
  };
  const result = await f.execution.run(f.target, f.handlers);
  equal(result.status, "completed");
  equal(receivers.length, 1);
  equal(receivers[0], f.ledger);
});

Deno.test("4.8e E4: a team adoption fork names its own continuation reference", async () => {
  const f = await fixture();
  const continuation = f.target.networkAdoptionContinuation!;
  const team: NativeExecutionRequest = {
    ...f.target,
    contribution: {
      id: `team-adoption:${continuation.receiptDigest}`,
      kind: "resume",
      inputMessageId: "original-input",
      teamAdoptionContinuation: continuation,
    },
    teamAdoptionContinuation: continuation,
  };
  delete team.networkAdoptionContinuation;
  // The same durable fork ledger, reached through its team entry.
  f.ledger.resumeRequestTeamAdoption = (target, fork) =>
    f.ledger.resumeRequestNetworkAdoption!({
      ...target,
      networkAdoptionContinuation: target.teamAdoptionContinuation,
    }, fork);
  const result = await f.execution.run(team, f.handlers);
  equal(result.status, "completed");
  equal(
    f.channels().after?.continuationRef,
    `request-team-adoption:${continuation.receiptDigest}`,
  );
});
