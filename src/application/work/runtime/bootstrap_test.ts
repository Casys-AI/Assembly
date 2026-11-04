import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { SystemRuntimeState } from "./state.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import type {
  AgentPort,
  ModelPort,
  StorePort,
  ToolRunnerPort,
} from "./ports.ts";

function fixture() {
  const model = executableFixture({
    projectId: "git:5c13bac2-ed31-57e0-bf4a-fcf782467804",
    editingContextId: "context",
    rootId: "root",
    systemId: "worker-system",
    catalogId: "worker-catalog",
    builderId: "worker",
  });
  model.version.repositoryVersion = "branch:admitted";
  let state: SystemRuntimeState | null = null;
  let initializations = 0, decisions = 0, unavailable = false;
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(state)),
    save(value, expectedRevision) {
      equal(state?.revision ?? null, expectedRevision);
      state = structuredClone(value);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const source: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize() {
      initializations++;
      if (unavailable) throw new Error("HEAD no longer contains this unit");
      return Promise.resolve(structuredClone(model.identity));
    },
    readExecutableModel() {
      if (unavailable) throw new Error("HEAD no longer contains this unit");
      return Promise.resolve(structuredClone(model));
    },
    applyApprovedChange() {
      throw new Error("No source change allowed during startup");
    },
    activateCandidate() {
      throw new Error("No activation allowed during startup");
    },
    graph: () => Promise.resolve({}),
  };
  const agents: AgentPort = {
    label: "fixture",
    decide() {
      decisions++;
      return Promise.resolve({ kind: "reply", text: "Terminé" });
    },
    review() {
      throw new Error("No review allowed during startup");
    },
  };
  const runner: ToolRunnerPort = {
    test() {
      throw new Error("No test allowed during startup");
    },
    run() {
      throw new Error("No effect allowed during startup");
    },
  };
  return {
    model,
    source,
    store,
    open: () => new SystemRuntime({ model: source, store, agents, runner }),
    removeFromHead: () => unavailable = true,
    get initializations() {
      return initializations;
    },
    get decisions() {
      return decisions;
    },
  };
}

Deno.test("restart preserves admitted history when HEAD removed a unit without adoption", async () => {
  const f = fixture();
  const original = f.open();
  await original.initialize();
  await original.submit("Bonjour");
  await original.idle();
  const before = original.snapshot;
  equal(f.initializations, 1);
  equal(f.decisions, 1);
  f.removeFromHead();
  const restarted = f.open();
  await restarted.initialize();
  equal(f.initializations, 1);
  deepStrictEqual(restarted.snapshot.messages, before.messages);
  deepStrictEqual(restarted.snapshot.executionModel, before.executionModel);
  match(restarted.snapshot.phase, /exécution suspendue/);
  await restarted.submit("Travaille quand même");
  await rejects(() => restarted.idle(), {
    name: "Error",
    message: "HEAD no longer contains this unit",
  });
  equal(f.decisions, 1);
  equal(f.initializations, 1);
  match(restarted.snapshot.error!, /HEAD no longer contains/);
  deepStrictEqual(restarted.snapshot.executionModel, before.executionModel);
  deepStrictEqual(
    restarted.snapshot.messages.slice(0, before.messages.length),
    before.messages,
  );
  deepStrictEqual(
    restarted.snapshot.messages.slice(before.messages.length).map((
      message,
    ) => ({
      role: message.role,
      text: message.text,
    })),
    [{ role: "user", text: "Travaille quand même" }],
  );
  deepStrictEqual(
    restarted.snapshot.events.filter((event) => event.effectiveModelUpdate),
    before.events.filter((event) => event.effectiveModelUpdate),
  );
});

Deno.test("opening a source-pinned unit does not provision or mutate a later HEAD", async () => {
  const f = fixture();
  f.removeFromHead();
  const runtime = f.open();
  await runtime.initialize(f.model);
  equal(f.initializations, 0);
  equal(
    runtime.snapshot.executionModel!.version.digest,
    f.model.version.digest,
  );
  equal(f.decisions, 0);
  match(runtime.snapshot.phase, /exécution suspendue/);
});

Deno.test("an unavailable source still fails startup when no admitted contract exists", async () => {
  const f = fixture();
  f.removeFromHead();
  await rejects(() => f.open().initialize(), /HEAD no longer contains/);
  equal(f.initializations, 1);
  equal(f.decisions, 0);
});

for (const pending of [false, true]) {
  Deno.test(`startup preserves unavailable-source diagnostics with pending=${pending}`, async () => {
    const f = fixture();
    await f.open().initialize();
    let lookups = 0;
    f.source.findApprovedChange = () => {
      lookups++;
      return Promise.resolve(null);
    };
    if (pending) {
      const saved = (await f.store.load())!;
      saved.configuration!.changes = [{
        id: "pending",
        kind: "mandate-change",
        status: "pending",
        baseRevision: 0,
        reason: "Host",
        requestedAt: "now",
        requestedRights: { addNetworkHosts: ["example.org"] },
      }];
      await f.store.save(
        { ...saved, revision: saved.revision + 1 },
        saved.revision,
      );
    }
    f.removeFromHead();
    const restarted = f.open();
    await restarted.initialize();
    equal(lookups, pending ? 1 : 0);
    match(restarted.snapshot.error!, /HEAD no longer contains/);
    match(restarted.snapshot.phase, /exécution suspendue/);
  });
}
