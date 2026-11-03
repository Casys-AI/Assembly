import assert from "node:assert/strict";
import {
  initializeRequestSpace,
  type RequestSpaceSeed,
  type RuntimeInitializationHost,
} from "./initialization.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import {
  runtimeProvenanceRecord,
  unknownRuntimeProvenance,
} from "../../../domain/work/value-objects/runtime-provenance.ts";

const seed: RequestSpaceSeed = {
  runtimeId: "request-runtime",
  openingId: "opening",
  caseId: "case",
  caseNumber: 42,
  caseTypeId: "request-type",
  initialContributionId: "input",
  createdAt: "2026-10-29T00:00:00Z",
  openedBy: "owner",
  text: "Full request",
};
function fixture() {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "native-system",
    catalogId: "catalog",
    builderId: "operator",
  });
  model.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  model.caseTypes = [{
    id: seed.caseTypeId,
    name: "Request",
    type: "request",
    envelope: "conversational",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId: model.identity.builderId,
    sourceIds: ["request-type"],
  }, {
    id: "scheduled",
    name: "Scheduled",
    type: "job",
    envelope: "deterministic",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId: model.identity.builderId,
    sourceIds: ["scheduled"],
    schedule: { kind: "every", count: 1, unit: "hour" },
  }];
  let saved: SystemRuntimeState | null = null;
  let saves = 0;
  const forbidden = () => {
    throw new Error("Inert birth called an active port");
  };
  const host: Pick<
    RuntimeInitializationHost,
    "state" | "ports" | "runtimeProvenance" | "runtimeRecorded"
  > = {
    state: undefined!,
    runtimeRecorded: false,
    ports: {
      agents: { label: "controlled" },
      clock: { now: forbidden },
      caseNumbers: { allocate: forbidden },
      model: {
        initialize: forbidden,
        readExecutableModel: forbidden,
        activateCandidate: forbidden,
      },
      store: {
        load: () => Promise.resolve(structuredClone(saved)),
        save: (next, expected) => {
          saves++;
          if ((saved?.revision ?? null) !== expected) {
            return Promise.reject(new Error("State revision changed"));
          }
          saved = structuredClone(next);
          return Promise.resolve();
        },
      },
    },
  };
  return {
    host,
    model,
    read: () => saved!,
    saves: () => saves,
    write: (s: SystemRuntimeState) => {
      saved = structuredClone(s);
    },
  };
}

Deno.test("Request birth is one inert CAS even when the exact model declares schedules", async () => {
  const f = fixture();
  await initializeRequestSpace.call(
    f.host,
    { ...seed, text: "x".repeat(4000) },
    f.model,
  );
  const state = f.read();
  assert.equal(f.saves(), 1);
  assert.equal(state.cases!.length, 1);
  assert.equal(state.cases![0].id, seed.caseId);
  assert.equal(state.cases![0].number, 42);
  assert.equal(state.cases![0].createdAt, seed.createdAt);
  assert.equal(state.cases![0].objective.length, 2000);
  assert.deepEqual(state.messages, []);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].kind, "runtime-started");
  assert.deepEqual(state.candidates, []);
  assert.deepEqual(state.executionModel, f.model);
  assert.equal(state.scheduledExecution, undefined);
});

Deno.test("Request restoration preserves busy, closed status, messages, budget and pending work without saving", async () => {
  const f = fixture();
  await initializeRequestSpace.call(f.host, seed, f.model);
  const existing = structuredClone(f.read());
  existing.busy = true;
  existing.phase = "in flight";
  existing.messages.push({
    id: "input",
    role: "user",
    text: seed.text,
    at: seed.createdAt,
  });
  existing.cases![0].status = "closed-done";
  existing.cases![0].closedAt = "2026-10-29T01:00:00Z";
  existing.activeInputMessageId = "input";
  f.write(existing);
  await initializeRequestSpace.call(f.host, seed, f.model);
  assert.deepEqual(f.host.state, existing);
  assert.deepEqual(f.read(), existing);
  assert.equal(f.saves(), 1);
  for (
    const changed of [
      { ...seed, caseNumber: 43 },
      { ...seed, openedBy: "foreign" },
      { ...seed, openingId: "foreign" },
      { ...seed, initialContributionId: "foreign" },
      { ...seed, createdAt: "2026-10-30T00:00:00Z" },
    ]
  ) {
    await assert.rejects(
      () => initializeRequestSpace.call(f.host, changed, f.model),
      /birth differs/,
    );
  }
  const divergent = structuredClone(f.model);
  divergent.version.digest = "foreign";
  await assert.rejects(
    () => initializeRequestSpace.call(f.host, seed, divergent),
    /birth differs/,
  );
  assert.deepEqual(f.read(), existing);
});

Deno.test("concurrent Request births reload the winning CAS and never reset it", async () => {
  const f = fixture();
  const second = { ...f.host, state: undefined! };
  await Promise.all([
    initializeRequestSpace.call(f.host, seed, f.model),
    initializeRequestSpace.call(second, seed, f.model),
  ]);
  assert.deepEqual(f.host.state, second.state);
  assert.equal(f.read().cases!.length, 1);
});

Deno.test("Request restoration journals new software provenance without rewriting history or busy work", async () => {
  const f = fixture();
  await initializeRequestSpace.call(f.host, seed, f.model);
  const existing = structuredClone(f.read());
  existing.busy = true;
  existing.phase = "in flight";
  existing.messages.push({
    id: "prior",
    role: "assistant",
    text: "retained",
    at: seed.createdAt,
  });
  existing.activeInputMessageId = "prior";
  f.write(existing);
  const provenance = unknownRuntimeProvenance();
  provenance.ase.commit = "new-runtime";
  const record = await runtimeProvenanceRecord(provenance);
  f.host.ports.runtimeProvenance = { collect: () => Promise.resolve(record) };
  f.host.ports.clock = { now: () => "2026-10-30T00:00:00Z" };
  await initializeRequestSpace.call(f.host, seed, f.model);
  const changed = f.read();
  assert.equal(changed.runtime!.digest, record.digest);
  assert.equal(changed.revision, existing.revision + 1);
  assert.deepEqual(changed.events.slice(0, -1), existing.events);
  assert.equal(changed.events.at(-1)!.at, "2026-10-30T00:00:00Z");
  assert.deepEqual({
    ...changed,
    revision: existing.revision,
    runtime: existing.runtime,
    events: existing.events,
  }, existing);
  const saves = f.saves();
  await initializeRequestSpace.call(f.host, seed, f.model);
  assert.equal(f.saves(), saves);
});
