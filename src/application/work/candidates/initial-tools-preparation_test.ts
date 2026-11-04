import assert from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import type { NativeInitialToolSeed } from "../../../domain/work/initial-tool-catalog.ts";
import type {
  InitialToolsPreparationIntent,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { closeCaseById, openInitializationCase } from "../cases/runtime.ts";
import { initialAdmissionTargetCaseDigest } from "../runtime/initial-admission-transfer.ts";
import { draftDigest } from "../runtime/values.ts";
import {
  initialToolsPreparationIdentity,
  InitialToolsPreparationRefused,
  initialToolsSelectionPlan,
  verifyInitialToolsPreparation,
} from "./initial-tools-preparation.ts";

const clock = { now: () => "2026-10-29T10:00:00.000Z" };
const seed: NativeInitialToolSeed = {
  id: "reader-1",
  nativeId: "native-reader-1",
  sourceIds: ["selection-1"],
  draft: {
    name: "reader-one",
    description: "First exact reader",
    kind: "read_web_page",
    code: "export default ({html}) => ({title:'one',text:html})",
  },
};
const second: NativeInitialToolSeed = {
  ...structuredClone(seed),
  id: "reader-2",
  nativeId: "native-reader-2",
  draft: {
    ...seed.draft,
    name: "reader-two",
    code: "export default ({html}) => ({title:'two',text:html})",
  },
};

function stateFixture(): SystemRuntimeState {
  const identity = {
    projectId: "git:preparation",
    editingContextId: "context",
    rootId: "root",
    systemId: "system",
    catalogId: "catalog",
    builderId: "owner",
  };
  const model = executableFixture(identity);
  model.version.repositoryVersion = "source-v1";
  model.initialTools = [structuredClone(seed), structuredClone(second)];
  return {
    id: "runtime-1",
    revision: 7,
    catalogRevision: 0,
    model: identity,
    executionModel: model,
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "idle",
    provider: "fixture",
    cases: [],
  };
}

async function candidateFor(
  selection: NativeInitialToolSeed,
  stage: Candidate["stage"],
  caseId = "other-case",
): Promise<Candidate> {
  const digest = await draftDigest(selection.draft);
  return {
    ...structuredClone(selection.draft),
    id: `candidate:${selection.id}`,
    caseId,
    digest,
    stage,
    createdAt: clock.now(),
    baseCatalogRevision: 0,
    initialToolSeed: {
      id: selection.id,
      nativeId: selection.nativeId,
      selectionDigest: digest,
      modelVersion: { digest: "source-0", repositoryVersion: "source-v1" },
    },
  };
}

async function fixture() {
  const state = stateFixture();
  const plan = await initialToolsSelectionPlan(state, state.executionModel!);
  assert(plan);
  const caseId = openInitializationCase(state, clock, 1);
  const record = state.cases!.find((item) => item.id === caseId)!;
  const model = state.executionModel!;
  const intent: InitialToolsPreparationIntent = {
    key: plan.key,
    revision: state.revision,
    runtimeId: state.id,
    projectId: model.identity.projectId,
    systemId: model.identity.systemId,
    operatorId: model.identity.builderId,
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion!,
    },
    flowRootId: model.flows.promotion.rootNativeId,
    flowOccurrenceId: model.flows.promotion.rootOccurrenceId,
    flowDigest: plan.flowDigest,
    selections: plan.selections,
    seedId: plan.seed.id,
    caseId,
    caseBirthDigest: await initialAdmissionTargetCaseDigest(record),
    phase: "pending",
  };
  state.initialToolsPreparations = { [intent.key]: intent };
  return {
    state,
    intent,
    reference: { key: intent.key, revision: intent.revision },
    caseId,
  };
}

const refused = (error: unknown) =>
  error instanceof InitialToolsPreparationRefused &&
  error.code === "INITIAL_TOOLS_PREPARATION_REFUSED";

Deno.test("preparation verifies its exact open or waiting initialization Case and delivery", async () => {
  const { state, intent, reference } = await fixture();
  const identity = initialToolsPreparationIdentity(intent);
  assert.equal(identity.scope.kind, "request");
  assert.equal(identity.scope.scopeId, intent.caseId);
  assert.equal(
    identity.invocationKey,
    JSON.stringify(["local", intent.caseId]),
  );
  assert.equal(identity.subjectId, intent.key);
  assert.deepEqual(
    await verifyInitialToolsPreparation(state, reference, identity),
    intent,
  );
  state.cases![0].status = "waiting";
  assert.deepEqual(
    await verifyInitialToolsPreparation(state, reference, identity),
    intent,
  );
});

Deno.test("terminal preparation retains the exact closed Case and candidate receipt", async () => {
  for (const outcome of ["done", "abandoned"] as const) {
    const { state, intent, reference, caseId } = await fixture();
    const candidate = await candidateFor(seed, "awaiting-admission", caseId);
    state.candidates.push(candidate);
    closeCaseById(state, caseId, outcome, clock);
    intent.phase = "terminal";
    intent.terminal = {
      outcome,
      closedAt: state.cases![0].closedAt!,
      candidateIds: [candidate.id],
    };
    assert.deepEqual(
      await verifyInitialToolsPreparation(
        state,
        reference,
        initialToolsPreparationIdentity(intent),
      ),
      intent,
    );
  }
});

Deno.test("preparation refuses missing or changed intention and foreign delivery identity", async () => {
  const { state, intent, reference } = await fixture();
  await assert.rejects(
    () =>
      verifyInitialToolsPreparation(state, { ...reference, key: "unknown" }),
    refused,
  );
  await assert.rejects(
    () =>
      verifyInitialToolsPreparation(state, {
        ...reference,
        revision: reference.revision + 1,
      }),
    refused,
  );
  const missing = structuredClone(state);
  delete missing.initialToolsPreparations;
  await assert.rejects(
    () => verifyInitialToolsPreparation(missing, reference),
    refused,
  );
  const wrongRuntime = structuredClone(state);
  wrongRuntime.id = "another-runtime";
  await assert.rejects(
    () => verifyInitialToolsPreparation(wrongRuntime, reference),
    refused,
  );
  const wrongOperator = structuredClone(state);
  wrongOperator.executionModel!.identity.builderId = "other-owner";
  await assert.rejects(
    () => verifyInitialToolsPreparation(wrongOperator, reference),
    refused,
  );
  const designer = {
    ...initialToolsPreparationIdentity(intent),
    invocationKey: "designer:other",
    scope: {
      kind: "designer" as const,
      scopeId: "designer",
      ownerId: intent.operatorId,
    },
  };
  await assert.rejects(
    () => verifyInitialToolsPreparation(state, reference, designer),
    refused,
  );
  const foreign = initialToolsPreparationIdentity(intent);
  if (foreign.scope.kind === "request") foreign.scope.scopeId = "foreign-case";
  await assert.rejects(
    () => verifyInitialToolsPreparation(state, reference, foreign),
    refused,
  );
});

Deno.test("pending preparation refuses ordinary, foreign, replaced and closed Cases", async () => {
  const { state, reference } = await fixture();
  const ordinary = structuredClone(state);
  delete ordinary.cases![0].openedFrom.origin;
  const foreign = structuredClone(state);
  foreign.cases![0].owner = "another-owner";
  const replaced = structuredClone(state);
  replaced.cases![0].objective = "Replaced objective";
  const missing = structuredClone(state);
  missing.cases = [];
  const closed = structuredClone(state);
  closeCaseById(closed, closed.cases![0].id, "done", clock);
  for (const changed of [ordinary, foreign, replaced, missing, closed]) {
    await assert.rejects(
      () => verifyInitialToolsPreparation(changed, reference),
      refused,
    );
  }
});

Deno.test("pending preparation refuses changed source selection, pin and admitted flow", async () => {
  const { state, reference } = await fixture();
  const edits: Array<(copy: SystemRuntimeState) => void> = [
    (copy) => {
      copy.executionModel!.initialTools![0].draft.code += " ";
    },
    (copy) => {
      copy.executionModel!.initialTools![0].nativeId = "different-native";
    },
    (copy) => {
      copy.executionModel!.initialTools!.reverse();
    },
    (copy) => {
      copy.executionModel!.version.digest = "different-model";
    },
    (copy) => {
      copy.executionModel!.version.repositoryVersion = "different-version";
    },
    (copy) => {
      copy.executionModel!.flows.promotion.rootNativeId = "foreign-flow";
    },
    (copy) => {
      copy.executionModel!.flows.promotion.rootOccurrenceId =
        "foreign-occurrence";
    },
    (copy) => {
      copy.executionModel!.flows.promotion.nodes[0].nativeId = "changed-node";
    },
    (copy) => {
      copy.executionModel!.identity.systemId = "foreign-system";
    },
  ];
  for (const edit of edits) {
    const copy = structuredClone(state);
    edit(copy);
    await assert.rejects(
      () => verifyInitialToolsPreparation(copy, reference),
      refused,
    );
  }
});

Deno.test("terminal preparation refuses an open Case or an inconsistent outcome and candidate", async () => {
  const { state, intent, reference, caseId } = await fixture();
  const candidate = await candidateFor(seed, "awaiting-admission", caseId);
  state.candidates.push(candidate);
  closeCaseById(state, caseId, "done", clock);
  intent.phase = "terminal";
  intent.terminal = {
    outcome: "done",
    closedAt: state.cases![0].closedAt!,
    candidateIds: [candidate.id],
  };
  const edits: Array<(copy: SystemRuntimeState) => void> = [
    (copy) => {
      copy.cases![0].status = "open";
      delete copy.cases![0].closedAt;
    },
    (copy) => {
      copy.initialToolsPreparations![intent.key].terminal!.outcome =
        "abandoned";
    },
    (copy) => {
      copy.initialToolsPreparations![intent.key].terminal!.closedAt =
        "wrong-time";
    },
    (copy) => {
      copy.initialToolsPreparations![intent.key].terminal!.candidateIds = [
        "unknown",
      ];
    },
    (copy) => {
      copy.candidates[0].caseId = "foreign-case";
    },
    (copy) => {
      copy.candidates[0].initialToolSeed!.id = "foreign-seed";
    },
    (copy) => {
      delete copy.initialToolsPreparations![intent.key].terminal;
    },
  ];
  for (const edit of edits) {
    const copy = structuredClone(state);
    edit(copy);
    await assert.rejects(
      () => verifyInitialToolsPreparation(copy, reference),
      refused,
    );
  }
});

Deno.test("selection plans only the first unprepared seed and detects conflicts before allocation", async () => {
  const state = stateFixture(), model = state.executionModel!;
  const before = structuredClone(state);
  const first = await initialToolsSelectionPlan(state, model);
  assert(first);
  assert.equal(first.seed.id, seed.id);
  assert.deepEqual(state, before);
  state.candidates.push(await candidateFor(seed, "active"));
  const next = await initialToolsSelectionPlan(state, model);
  assert(next);
  assert.equal(next.seed.id, second.id);
  assert.notEqual(next.key, first.key);
  state.candidates.push(await candidateFor(second, "active"));
  assert.equal(await initialToolsSelectionPlan(state, model), undefined);
  const empty = stateFixture();
  empty.executionModel!.initialTools = [];
  assert.equal(
    await initialToolsSelectionPlan(empty, empty.executionModel!),
    undefined,
  );
  const waiting = stateFixture();
  waiting.candidates.push(await candidateFor(seed, "awaiting-admission"));
  assert.equal(
    await initialToolsSelectionPlan(waiting, waiting.executionModel!),
    undefined,
  );
  const changed = stateFixture();
  changed.candidates.push(await candidateFor(seed, "active"));
  changed.executionModel!.initialTools![0].draft.code += " changed";
  await assert.rejects(
    () => initialToolsSelectionPlan(changed, changed.executionModel!),
    /sélection initiale a changé/,
  );
  const duplicated = stateFixture();
  duplicated.candidates.push(
    await candidateFor(seed, "active"),
    await candidateFor(seed, "refused"),
  );
  await assert.rejects(
    () => initialToolsSelectionPlan(duplicated, duplicated.executionModel!),
    /sélection initiale a changé/,
  );
});

Deno.test("admission birth digest excludes closure author and judgment", async () => {
  const record = {
    id: "case",
    number: 1,
    type: "request" as const,
    objective: "Request",
    owner: "operator",
    openedBy: "operator",
    openedFrom: { conversationId: "conversation" },
    modelPin: { digest: "pin" },
    status: "open" as const,
    createdAt: "2026-11-03T00:00:00Z",
  };
  assert.equal(
    await initialAdmissionTargetCaseDigest(record),
    await initialAdmissionTargetCaseDigest({
      ...record,
      status: "closed-done",
      closedAt: record.createdAt,
      closedBy: "person",
      verdict: "rejected",
    }),
  );
});
