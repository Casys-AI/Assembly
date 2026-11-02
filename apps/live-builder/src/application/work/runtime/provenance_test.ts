import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import {
  type RuntimeProvenanceRecord,
  runtimeProvenanceRecord,
} from "../../../domain/work/value-objects/runtime-provenance.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ModelPort, StorePort } from "./ports.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";

const provenance = (commit = "a".repeat(40)) =>
  runtimeProvenanceRecord({
    schemaVersion: 1,
    ase: { commit, dirty: false },
    deno: "2.9.7",
    toolkit: { version: "0.10.10", digest: "b".repeat(64) },
    agents: { provider: "anthropic", model: "configured-exact-model" },
  });

function fixture() {
  const model = executableFixture({
    projectId: "provenance-project",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "builder",
  });
  model.version.repositoryVersion = "commit:admitted-model";
  let saved: SystemRuntimeState | null = null;
  let failStartup = false;
  let collections = 0, decisions = 0, tests = 0;
  const atDispatch: SystemRuntimeState[] = [];
  const explicitWorkers = new WeakMap<SystemRuntime, {
    native: ReturnType<typeof createTestNativeExecution>;
    acceptedIds: string[];
  }>();
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(saved)),
    save(next, expected) {
      equal(saved?.revision ?? null, expected);
      if (
        failStartup &&
        next.events.filter((event) => event.kind === "runtime-started").length >
          (saved?.events.filter((event) => event.kind === "runtime-started")
            .length ?? 0)
      ) {
        failStartup = false;
        throw new Error("Runtime provenance persistence unavailable");
      }
      saved = structuredClone(next);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const forbidden = () => {
    throw new Error("Unexpected external effect");
  };
  const source: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: () => Promise.resolve(structuredClone(model)),
    applyApprovedChange: forbidden,
    activateCandidate(_identity, candidate) {
      const binding = {
        elementId: `native-${candidate.id}`,
        graphPath: `catalog/${candidate.id}`,
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
    },
    graph: () => Promise.resolve({}),
  };
  return {
    model,
    atDispatch,
    open(
      record: RuntimeProvenanceRecord,
      options: { explicitWorker?: true } = {},
    ) {
      const native = options.explicitWorker
        ? createTestNativeExecution(store)
        : undefined;
      const acceptedIds: string[] = [];
      if (native) {
        const enqueue = native.dispatch.enqueue.bind(native.dispatch);
        native.dispatch.enqueue = async (delivery) => {
          const receipt = await enqueue(delivery);
          acceptedIds.push(delivery.id);
          return receipt;
        };
      }
      const service = new SystemRuntime({
        model: source,
        store: native?.store ?? store,
        ...(native
          ? {
            execution: native.execution,
            dispatch: native.dispatch,
            stateHistory: native.stateHistory,
            artifactSources: native.artifactSources,
          }
          : {}),
        runtimeProvenance: {
          collect() {
            collections++;
            return Promise.resolve(structuredClone(record));
          },
        },
        agents: {
          label: "provenance-fixture",
          decide() {
            decisions++;
            ok(saved);
            atDispatch.push(structuredClone(saved));
            return Promise.resolve({ kind: "reply", text: "Réponse exécutée" });
          },
          review: forbidden,
        },
        runner: {
          run: forbidden,
          test() {
            tests++;
            ok(saved);
            atDispatch.push(structuredClone(saved));
            return Promise.resolve({
              passed: true,
              checks: [{ name: "fixture", passed: true, detail: "Valid" }],
            });
          },
        },
      });
      if (native) explicitWorkers.set(service, { native, acceptedIds });
      return service;
    },
    bindWorker(service: SystemRuntime) {
      const worker = explicitWorkers.get(service);
      ok(worker, "This negative scenario must own its explicit native worker");
      worker.native.bind(service);
    },
    async acceptedDeliveries(service: SystemRuntime) {
      const worker = explicitWorkers.get(service);
      ok(worker);
      return await Promise.all(worker.acceptedIds.map(async (id) => {
        const accepted = await worker.native.dispatch.inspectAccepted!(
          model.identity.builderId,
          id,
        );
        ok(
          accepted,
          "Only the actual accepted delivery may serve as failure correlation",
        );
        return accepted;
      }));
    },
    checkpoints(service: SystemRuntime) {
      const worker = explicitWorkers.get(service);
      ok(worker);
      return worker.native.checkpoints();
    },
    seed(state: SystemRuntimeState) {
      saved = structuredClone(state);
    },
    failNextStartup: () => failStartup = true,
    get saved() {
      return structuredClone(saved);
    },
    get collections() {
      return collections;
    },
    get decisions() {
      return decisions;
    },
    get tests() {
      return tests;
    },
  };
}

Deno.test("executed action and conversation flow resolve provenance already persisted before dispatch", async () => {
  const f = fixture();
  const record = await provenance();
  const service = f.open(record);
  const version = structuredClone(f.model.version);
  await service.initialize();
  await service.initialize();
  await service.submit("Bonjour");
  await service.idle();

  equal(f.collections, 1);
  equal(f.decisions, 1);
  equal(service.snapshot.error, undefined);
  deepStrictEqual(service.snapshot.runtime, { digest: record.digest });
  deepStrictEqual(service.snapshot.executionModel!.version, version);
  const persisted = await service.readPersistedState();
  ok(persisted);
  const startup = persisted.events.filter((event) =>
    event.kind === "runtime-started"
  );
  equal(startup.length, 1);
  deepStrictEqual(startup[0].runtimeProvenance, record);
  deepStrictEqual(
    f.atDispatch[0].events.find((event) => event.kind === "runtime-started")
      ?.runtimeProvenance,
    record,
  );
  const response = persisted.messages.find((message) =>
    message.text === "Réponse exécutée"
  );
  ok(response?.execution?.actionId);
  equal(response.execution.digest, version.digest);
  equal(response.execution.repositoryVersion, version.repositoryVersion);
  equal(
    response.execution.runtime?.digest,
    startup[0].runtimeProvenance!.digest,
  );
  const flow = persisted.events.filter((event) =>
    event.label.startsWith("Conversation :")
  );
  ok(flow.some((event) => event.execution?.actionId));
  ok(flow.some((event) => event.execution?.edgeId));
  for (const event of flow) {
    equal(event.execution?.runtime?.digest, record.digest);
  }
});

Deno.test("Muse completeness is visible in API state and runtime-started while unresolved models still execute", async () => {
  for (const model of ["configured-muse-model", "unknown"]) {
    const f = fixture();
    const complete = model !== "unknown";
    const incompleteReasons = complete
      ? []
      : ["agent-model-unresolved" as const];
    const record = await runtimeProvenanceRecord({
      ...(await provenance()).provenance,
      agents: { provider: "muse", model },
      complete,
      incompleteReasons,
    });
    const service = f.open(record);
    await service.initialize();
    await service.submit("Exécuter malgré le modèle CLI non résolu");
    await service.idle();
    equal(f.decisions, 1);
    equal(service.snapshot.error, undefined);

    // /api/state directly serializes service.snapshot.
    const apiState: SystemRuntimeState = JSON.parse(
      JSON.stringify(service.snapshot),
    );
    deepStrictEqual(apiState.runtime, {
      digest: record.digest,
      complete,
      incompleteReasons,
    });
    const startup = apiState.events.find((event) =>
      event.kind === "runtime-started"
    );
    deepStrictEqual(startup?.runtimeProvenance, record);
    equal(apiState.messages.at(-1)?.execution?.runtime?.digest, record.digest);
  }
});

Deno.test("promotion actions and flow references carry the durable runtime provenance", async () => {
  const f = fixture();
  const record = await provenance();
  f.model.initialTools = [{
    id: "reader-v1",
    nativeId: "native-reader-selection",
    sourceIds: ["selection-definition", "selection-code"],
    draft: {
      name: "selected-reader",
      description: "Selected code exercises the real promotion flow",
      kind: "read_web_page",
      code: "export default ({html}) => ({title:'Page',text:html})",
    },
  }];
  const service = f.open(record);
  await service.initialize();
  // Initial preparation acknowledges its exact durable command; only the
  // claimed native worker performs the promotion and records its provenance.
  await service.prepareInitialTools();
  await service.idle();

  equal(f.tests, 1);
  equal(
    f.decisions,
    0,
    "The admitted seed must not ask a provider to recreate its code",
  );
  equal(service.snapshot.error, undefined);
  equal(service.snapshot.candidates[0].stage, "awaiting-admission");
  deepStrictEqual(
    f.atDispatch[0].events.find((event) => event.kind === "runtime-started")
      ?.runtimeProvenance,
    record,
  );
  const events = service.snapshot.events;
  const proposed = events.find((event) => event.kind === "tool-proposed");
  ok(proposed?.execution?.actionId);
  equal(proposed.execution.runtime?.digest, record.digest);
  const flow = events.filter((event) => event.label.startsWith("Promotion :"));
  ok(flow.some((event) => event.execution?.actionId));
  ok(flow.some((event) => event.execution?.edgeId));
  for (const event of flow) {
    equal(event.execution?.runtime?.digest, record.digest);
  }
});

Deno.test("restart records the new runtime without rewriting old execution references or model identity", async () => {
  const f = fixture();
  const first = await provenance();
  const second = await provenance("c".repeat(40));
  const original = f.open(first);
  await original.initialize();
  await original.submit("Premier démarrage");
  await original.idle();
  const before = original.snapshot;
  const restarted = f.open(second);
  await restarted.initialize();
  await restarted.submit("Second démarrage");
  await restarted.idle();

  const after = f.saved!;
  deepStrictEqual(after.events.slice(0, before.events.length), before.events);
  deepStrictEqual(
    after.messages.slice(0, before.messages.length),
    before.messages,
  );
  deepStrictEqual(after.executionModel, before.executionModel);
  deepStrictEqual(after.runtime, { digest: second.digest });
  deepStrictEqual(
    after.events.filter((event) => event.kind === "runtime-started")
      .map((event) => event.runtimeProvenance),
    [first, second],
  );
  equal(after.messages.at(-1)?.execution?.runtime?.digest, second.digest);
  equal(f.collections, 2);
  equal(f.decisions, 2);
});

Deno.test("legacy events and messages without runtime provenance remain unchanged when reopened", async () => {
  const f = fixture();
  const legacy: SystemRuntimeState = {
    id: "legacy-case",
    revision: 4,
    catalogRevision: 0,
    model: structuredClone(f.model.identity),
    executionModel: structuredClone(f.model),
    messages: [{
      id: "legacy-message",
      at: "2026-01-01T00:00:00Z",
      role: "assistant",
      text: "Historique",
      execution: { digest: f.model.version.digest, actionId: "legacy-action" },
    }],
    events: [{
      id: "legacy-event",
      at: "2026-01-01T00:00:00Z",
      kind: "flow-action",
      label: "Action historique",
      execution: { digest: f.model.version.digest, actionId: "legacy-action" },
    }],
    candidates: [],
    busy: false,
    phase: "Prêt",
    provider: "legacy-provider",
  };
  f.seed(legacy);
  const record = await provenance();
  const service = f.open(record);
  await service.initialize();
  await service.submit("Reprendre");
  await service.idle();

  deepStrictEqual(f.saved!.events[0], legacy.events[0]);
  deepStrictEqual(f.saved!.messages[0], legacy.messages[0]);
  equal(f.saved!.events[0].execution?.runtime, undefined);
  equal(f.saved!.messages[0].execution?.runtime, undefined);
  equal(f.saved!.ownerAuthority?.ownerSource, "implicit-legacy");
  equal(f.saved!.ownerAuthority?.operatorId, "owner");
  const startup = f.saved!.events.find((event) =>
    event.kind === "runtime-started"
  )!;
  deepStrictEqual(startup.ownerAuthority, f.saved!.ownerAuthority);
  deepStrictEqual(
    f.saved!.executionModel!.version,
    legacy.executionModel!.version,
  );
  equal(f.saved!.messages.at(-1)?.execution?.runtime?.digest, record.digest);
  equal(f.decisions, 1);
});

Deno.test("failed startup provenance persistence prevents execution until initialization succeeds", async () => {
  const f = fixture();
  const original = f.open(await provenance());
  await original.initialize();
  const before = f.saved;
  const record = await provenance("d".repeat(40));
  const restarted = f.open(record, { explicitWorker: true });
  f.failNextStartup();
  await rejects(
    restarted.initialize(),
    /Runtime provenance persistence unavailable/,
  );
  deepStrictEqual(f.saved, before);
  // Bind the real application handler despite the failed startup, so the
  // negative result proves its provenance fence rather than an absent worker.
  f.bindWorker(restarted);
  const blockedText = "Ne pas exécuter avant journalisation";
  await restarted.submit(blockedText);
  await rejects(restarted.idle(), /provenance du runtime.*journalisée/);
  const blocked = await f.acceptedDeliveries(restarted);
  equal(blocked.length, 1);
  equal(blocked[0].delivery.kind, "contribution");
  equal(blocked[0].delivery.payload?.text, blockedText);
  equal(blocked[0].delivery.identity.operatorId, f.model.identity.builderId);
  equal(blocked[0].receipt.id, blocked[0].delivery.id);
  equal(blocked[0].receipt.status, "failed");
  deepStrictEqual(await f.checkpoints(restarted), []);
  equal(f.decisions, 0);
  equal(f.tests, 0);
  equal(f.atDispatch.length, 0);
  deepStrictEqual(f.saved, before);

  await restarted.initialize();
  await restarted.submit("Reprendre après journalisation");
  await restarted.idle();
  equal(f.decisions, 1);
  equal(f.collections, 2);
  const completed = await f.acceptedDeliveries(restarted);
  equal(completed.length, 2);
  deepStrictEqual(completed[0], blocked[0]);
  equal(completed[1].receipt.status, "completed");
  equal(completed[1].receipt.id, completed[1].delivery.id);
  equal(completed[1].delivery.payload?.text, "Reprendre après journalisation");
  equal(
    f.saved!.messages.some((message) => message.text === blockedText),
    false,
  );
  deepStrictEqual(
    f.atDispatch[0].events.filter((event) => event.kind === "runtime-started")
      .at(-1)?.runtimeProvenance,
    record,
  );
});
