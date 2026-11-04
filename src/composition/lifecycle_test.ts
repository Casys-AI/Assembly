import assert from "node:assert/strict";
import { LangChainAgents } from "../adapters/out/llm-providers/langchain-agents.ts";
import { MuseAgents } from "../adapters/out/llm-providers/agents.ts";
import type {
  CompletionFlushResult,
  CompletionSink,
} from "../adapters/out/llm-providers/completion-observer.ts";
import type { DecisionInformationPort } from "../application/work/context/information-ports.ts";
import { createClaudeToolsFake } from "../../test/support/claude-tools-fake.ts";
import { createOrderedStop, startPrimaryDeliveries } from "./lifecycle.ts";
import {
  type ProviderObservation,
  providerObservation,
} from "./provider-configuration.ts";

const unexpected = (): never => {
  throw new Error("Unexpected lifecycle fixture operation");
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}

async function bounded<T>(operation: Promise<T>, milliseconds = 2500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Lifecycle witness did not settle")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

type Delivery = { identity: { operatorId: string } };

function startupFixture(withMain: boolean) {
  const events: string[] = [];
  const information = {} as DecisionInformationPort;
  const informationReader: { current?: DecisionInformationPort } = {};
  const registeredMain: {
    current?: {
      processAcceptedContribution(delivery: Delivery): Promise<void>;
    };
  } = {};
  const main = {
    processAcceptedContribution() {
      events.push("main-delivery");
      return Promise.resolve();
    },
  };
  let bound: unknown;
  const decision = { kind: "network-decision" };
  const options = {
    primaryOperatorId: "main",
    informationReader,
    registeredMain,
    workspace: {
      information,
      runtimeFor(operatorId: string) {
        assert.equal(operatorId, "main");
        events.push("resolve-main");
        return withMain ? { runtime: main } : undefined;
      },
      activateRuntimeDeliveries() {
        events.push("activate-deliveries");
        return Promise.resolve();
      },
    },
    prepareNetworkDecision() {
      assert.equal(registeredMain.current, main);
      events.push("prepare-network");
      return decision;
    },
    requestSpaces: {
      bindNetworkDecision(value: typeof decision) {
        bound = value;
        events.push("bind-network");
      },
      recoverSoftwareEvolution() {
        assert.equal(bound, decision);
        events.push("recover-software");
        return Promise.resolve();
      },
      replayAuthority() {
        events.push("replay-authority");
        return Promise.resolve();
      },
      async dispatchAccepted(
        delivery: Delivery,
        scope: string | undefined,
        mainDispatch: (delivery: Delivery) => Promise<void>,
      ) {
        assert.equal(scope, "main-scope");
        await mainDispatch(delivery);
      },
    },
    nativeRuntime: {
      async start(
        handler: (delivery: Delivery, scope?: string) => Promise<void>,
      ) {
        assert.equal(informationReader.current, information);
        events.push("native-start");
        await handler({ identity: { operatorId: "main" } }, "main-scope");
      },
    },
  };
  return { events, options, registeredMain, main };
}

Deno.test("startup binds the network decision after resolving Main and before native delivery", async () => {
  const fixture = startupFixture(true);
  await startPrimaryDeliveries(fixture.options);
  assert.equal(fixture.registeredMain.current, fixture.main);
  assert.deepEqual(fixture.events, [
    "resolve-main",
    "prepare-network",
    "bind-network",
    "recover-software",
    "native-start",
    "resolve-main",
    "main-delivery",
    "activate-deliveries",
    "replay-authority",
  ]);
});

Deno.test("startup refuses an absent Main before any network decision or native delivery", async () => {
  const fixture = startupFixture(false);
  await assert.rejects(startPrimaryDeliveries(fixture.options), {
    message: "The registered Main runtime is unavailable",
  });
  assert.equal(fixture.registeredMain.current, undefined);
  assert.deepEqual(fixture.events, ["resolve-main"]);
});

function stopFixture(
  observation: ProviderObservation,
  options: {
    business?: ReturnType<typeof gate>;
    deliveries?: ReturnType<typeof gate>;
    serverFailure?: Error;
  } = {},
) {
  const events: string[] = [];
  const warnings: Array<{ message: string; properties: unknown }> = [];
  const idleEntered = gate(), deliveriesEntered = gate();
  const mark = (name: string) => () => {
    events.push(name);
    return Promise.resolve();
  };
  const assembly = {
    providerObservation: observation,
    clients: new Set([{ close: mark("client.close") }]),
    liveGraph: {
      stopPolling: mark("polling.stop"),
      graphClients: new Set([{ close: mark("graph-client.close") }]),
      pendingRead: mark("graph.read"),
    },
    operatorWorkspace: {
      stopAcceptingRuntimeDeliveries: mark("deliveries.stop-accepting"),
      async drainRuntimeDeliveries() {
        events.push("deliveries.enter");
        deliveriesEntered.resolve();
        await options.deliveries?.promise;
        events.push("deliveries.drained");
      },
      close: mark("workspace.close"),
    },
    nativeRuntime: {
      stopAccepting: mark("native.stop-accepting"),
      stop: mark("native.stop"),
    },
    requestEvents: { close: mark("request-events.close") },
    requestSpaces: {
      runtime: {
        closeConversationObservers() {
          events.push("conversation-observers.close");
        },
      },
    },
    service: {
      async idle() {
        events.push("business.enter");
        idleEntered.resolve();
        await options.business?.promise;
        events.push("business.drained");
      },
    },
    stopSourceWriter: mark("source-writer.stop"),
    evolutionStore: { close: mark("evolution.close") },
    revisionNotifications: { close: mark("revisions.close") },
    projectionPreparer: { close: mark("preparer.close") },
    semanticModel: { close: mark("semantic.close") },
    nativeSemantic: { close: mark("native-semantic.close") },
    closeModelBackend: mark("model-backend.close"),
    caseNumbers: { close: mark("case-numbers.close") },
    storage: { close: mark("storage.close") },
  };
  const casePoll = setInterval(unexpected, 60_000);
  const stop = createOrderedStop({
    assembly,
    casePoll,
    server: {
      shutdown() {
        events.push("server.shutdown");
        return options.serverFailure
          ? Promise.reject(options.serverFailure)
          : Promise.resolve();
      },
    },
    log: {
      warn(message, properties) {
        events.push("observation.warning");
        warnings.push({ message, properties });
      },
    },
    closeToolkitWorkers: mark("toolkit.close"),
  });
  return {
    assembly,
    casePoll,
    events,
    warnings,
    idleEntered,
    deliveriesEntered,
    stop,
  };
}

function provider(sink: CompletionSink) {
  const fake = createClaudeToolsFake(() => ({
    decision: { kind: "reply", text: "Observed once" },
    id: "lifecycle-message",
    model: "controlled-sonnet",
    usage: { input_tokens: 3, output_tokens: 2 },
  }));
  const agents = new LangChainAgents({
    apiKey: "fixture-key",
    model: "controlled-sonnet",
    fetch: fake.fetch,
    onCompletion: sink,
    completionStallMs: 10,
  });
  return { agents, fake };
}

function watchClose(agents: LangChainAgents, events: string[]) {
  const deadlines: Array<number | undefined> = [];
  const results: CompletionFlushResult[] = [];
  const entered = gate();
  const close = agents.completionObservation.close.bind(
    agents.completionObservation,
  );
  agents.completionObservation.close = async (deadline) => {
    events.push("observation.close");
    deadlines.push(deadline);
    entered.resolve();
    const result = await close(deadline);
    results.push(result);
    events.push("observation.closed");
    return result;
  };
  return { deadlines, results, entered };
}

const context = { messages: [], activeTools: [], candidates: [] };
const noDrops = {
  invalid: 0,
  oversize: 0,
  saturated: 0,
  sinkFailure: 0,
  closed: 0,
  disabled: 0,
};

Deno.test("stop drains work before closing provider collection and awaits one delayed append", async () => {
  const append = gate(), sinkEntered = gate();
  const business = gate(), deliveries = gate();
  const appended: string[] = [];
  const p = provider(async (metadata) => {
    sinkEntered.resolve();
    await append.promise;
    appended.push(String(metadata.id));
  });
  const fixture = stopFixture(providerObservation(p.agents), {
    business,
    deliveries,
  });
  const observed = watchClose(p.agents, fixture.events);
  try {
    assert.deepEqual(await p.agents.decide(context), {
      kind: "reply",
      text: "Observed once",
    });
    await bounded(sinkEntered.promise);
    const stopping = fixture.stop();
    assert.equal(fixture.stop(), stopping);
    await bounded(fixture.idleEntered.promise);
    assert.equal(observed.deadlines.length, 0);
    business.resolve();
    await bounded(fixture.deliveriesEntered.promise);
    assert.equal(observed.deadlines.length, 0);
    deliveries.resolve();
    await bounded(observed.entered.promise);
    assert.equal(fixture.events.includes("source-writer.stop"), false);
    append.resolve();
    await bounded(stopping);
    assert.deepEqual(observed.deadlines, [1000]);
    assert.equal(observed.results[0].timedOut, false);
    assert.equal(observed.results[0].unconfirmedPending, 0);
    assert.equal(observed.results[0].status.closed, true);
    assert.equal(observed.results[0].status.written, 1);
    assert.deepEqual(appended, ["lifecycle-message"]);
    assert.equal(p.fake.views.length, 1);
    const at = (name: string) => fixture.events.indexOf(name);
    assert.ok(at("request-events.close") < at("server.shutdown"));
    assert.ok(at("native.stop") < at("conversation-observers.close"));
    assert.ok(at("conversation-observers.close") < at("storage.close"));
    assert.ok(at("business.drained") < at("observation.close"));
    assert.ok(at("deliveries.drained") < at("observation.close"));
    assert.ok(at("observation.closed") < at("source-writer.stop"));
    assert.equal(fixture.events.at(-1), "storage.close");
    assert.equal(fixture.assembly.clients.size, 0);
    assert.equal(fixture.assembly.liveGraph.graphClients.size, 0);
    assert.deepEqual(fixture.warnings, []);
  } finally {
    business.resolve();
    deliveries.resolve();
    append.resolve();
    clearInterval(fixture.casePoll);
    await p.agents.completionObservation.close(20);
  }
});

Deno.test("stop bounds a stalled append and reports unconfirmed work before storage closes", async () => {
  const append = gate(), sinkEntered = gate();
  let writes = 0;
  const p = provider(() => {
    writes++;
    sinkEntered.resolve();
    return append.promise;
  });
  const fixture = stopFixture(providerObservation(p.agents));
  const observed = watchClose(p.agents, fixture.events);
  try {
    await p.agents.decide(context);
    await bounded(sinkEntered.promise);
    await bounded(fixture.stop());
    assert.deepEqual(observed.deadlines, [1000]);
    assert.equal(observed.results[0].timedOut, true);
    assert.equal(observed.results[0].unconfirmedPending, 1);
    assert.equal(observed.results[0].status.closed, true);
    assert.equal(observed.results[0].status.inFlight, true);
    assert.equal(writes, 1);
    assert.equal(p.fake.views.length, 1);
    assert.deepEqual(fixture.warnings, [{
      message: "Provider observation shutdown collection health",
      properties: { pending: 1, timedOut: true, dropped: noDrops },
    }]);
    assert.ok(
      fixture.events.indexOf("observation.warning") <
        fixture.events.indexOf("storage.close"),
    );
    assert.equal(fixture.events.at(-1), "storage.close");
  } finally {
    append.resolve();
    clearInterval(fixture.casePoll);
    await p.agents.completionObservation.close(20);
  }
});

Deno.test("stop reports a failed collection and continues past a server shutdown failure", async () => {
  const privateError = "private-sink-error-must-not-be-logged";
  const p = provider(() => Promise.reject(new Error(privateError)));
  const serverFailure = new Error("Controlled server shutdown failure");
  const fixture = stopFixture(providerObservation(p.agents), {
    serverFailure,
  });
  const observed = watchClose(p.agents, fixture.events);
  try {
    await p.agents.decide(context);
    await p.agents.completionObservation.flush(20);
    assert.equal(p.agents.completionObservation.status().pending, 0);
    await assert.rejects(bounded(fixture.stop()), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [serverFailure]);
      return true;
    });
    assert.deepEqual(observed.deadlines, [1000]);
    assert.equal(observed.results[0].unconfirmedPending, 0);
    assert.equal(fixture.events.at(-1), "storage.close");
    assert.equal(p.fake.views.length, 1);
    assert.deepEqual(fixture.warnings.map((entry) => entry.properties), [{
      pending: 0,
      timedOut: false,
      dropped: { ...noDrops, sinkFailure: 1 },
    }]);
    assert.equal(
      JSON.stringify(fixture.warnings).includes(privateError),
      false,
    );
    assert.ok(fixture.events.includes("native.stop"));
    assert.ok(fixture.events.includes("toolkit.close"));
    assert.ok(
      fixture.events.indexOf("observation.closed") <
        fixture.events.indexOf("workspace.close"),
    );
  } finally {
    clearInterval(fixture.casePoll);
    await p.agents.completionObservation.close(20);
  }
});

Deno.test("Muse reports unsupported collection coverage and stops without a provider call", async () => {
  const observation = providerObservation(
    new MuseAgents({ runner: unexpected }),
  );
  assert.deepEqual(observation, { supported: false, coverage: "unsupported" });
  const fixture = stopFixture(observation);
  try {
    await bounded(fixture.stop());
    assert.equal(fixture.events.at(-1), "storage.close");
    assert.equal(fixture.events.includes("observation.close"), false);
    assert.deepEqual(fixture.warnings, []);
  } finally {
    clearInterval(fixture.casePoll);
  }
});
