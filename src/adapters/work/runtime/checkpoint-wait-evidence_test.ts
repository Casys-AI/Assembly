import assert from "node:assert/strict";
import type {
  NativeChangeApprovalWait,
  NativeExecutionRequest,
} from "../../../application/work/runtime/execution.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import { nativeFrameworkNodeName } from "./native-graph.ts";
import { ExecutionWaitEvidenceLedger } from "./wait-evidence-ledger.ts";

import {
  budgetSourceFromWait,
  checkpointConsumptions,
  checkpointInterruptEvidence,
  decodeLegacyCheckpointWait,
  effectResultDigest,
  LEGACY_WAIT_PROTOCOL,
  legacyContributionConsumed,
  type NativeWaitEvidence,
  type OfficialCheckpoint,
  type OfficialCheckpointTuple,
  parseNativeWaitEvidence,
  TYPED_WAIT_PROTOCOL,
  verifyOfficialFork,
  verifyOfficialWaitCheckpoint,
} from "./checkpoint-wait-evidence.ts";

function fixture() {
  const model = artifactModel("typed-wait-evidence");
  const request: NativeExecutionRequest = {
    model,
    flow: model.flows.conversation,
    maxSteps: 32,
    identity: {
      operatorId: "operator-wait",
      invocationKey: "request:wait",
      purpose: "conversation",
      scope: {
        kind: "request",
        scopeId: "request-wait",
        rootRequestId: "request-wait",
      },
    },
    contribution: { id: "contribution-input", kind: "input" },
    businessRevision: {
      __assemblyRuntimeRevision: {
        systemId: model.identity.systemId,
        operatorId: "operator-wait",
        revision: 1,
        modelDigest: model.version.digest,
      },
    },
  };
  const node = request.flow.nodes.find((node) =>
    node.mechanism === "await_input"
  )!;
  assert.ok(node, "the compiled fixture retains an input acceptance node");
  const wait: NativeWaitEvidence = {
    version: 1,
    kind: "input",
    nodeId: node.id,
    actionId: node.nativeId,
    preparedNodeId: nativeFrameworkNodeName(node.id, "await-preparation"),
    effectKey: "effect-before-wait",
    resultDigest: "a".repeat(64),
    modelPin: {
      identity: structuredClone(model.identity),
      version: structuredClone(model.version),
      rootNativeId: request.flow.rootNativeId,
      rootOccurrenceId: request.flow.rootOccurrenceId,
    },
    executionScope: structuredClone(request.identity.scope),
    operatorId: request.identity.operatorId,
    rootRequestId: "request-wait",
    inputs: { message: { text: "Retain exact input bytes: é / e\u0301" } },
  };
  return { request, node, wait };
}

function checkpoint(
  values: Record<string, unknown>,
  id = "checkpoint-selected",
): OfficialCheckpoint {
  return {
    v: 4,
    id,
    ts: "2026-10-31T00:00:00.000Z",
    channel_values: structuredClone(values),
    channel_versions: {},
    versions_seen: {},
  } as OfficialCheckpoint;
}

function tuple(values: Record<string, unknown>): OfficialCheckpointTuple {
  return {
    config: {
      configurable: {
        thread_id: "thread-wait",
        checkpoint_ns: "run-namespace",
        checkpoint_id: "checkpoint-selected",
      },
    },
    checkpoint: checkpoint(values),
    metadata: { source: "loop", step: 7, parents: {} },
    pendingWrites: [],
  } as OfficialCheckpointTuple;
}

function waitConsumption(wait: NativeWaitEvidence) {
  return {
    version: 1,
    kind: "wait-v1",
    contributionId: "contribution-resume",
    sourceCheckpointId: "checkpoint-selected",
    wait,
  };
}

function approvalFixture() {
  const { request, wait } = fixture();
  const proposal = request.flow.nodes.find((node) =>
    node.mechanism === "submit_proposal"
  )!;
  assert.ok(proposal);
  const approval: NativeChangeApprovalWait = {
    version: 1,
    identity: { ...request.identity, subjectId: request.contribution.id },
    contributionId: request.contribution.id,
    inputMessageId: request.contribution.id,
    modelDigest: request.model.version.digest,
    repositoryVersion: request.model.version.repositoryVersion!,
    flowRootId: request.flow.rootNativeId,
    flowOccurrenceId: request.flow.rootOccurrenceId,
    nodeId: proposal.id,
    actionId: proposal.nativeId,
    effectKey: `native-effect:${"c".repeat(64)}`,
    changeId: "request-network-change",
    proposalIntentDigest: "d".repeat(64),
  };
  const typed: NativeWaitEvidence = {
    ...wait,
    changeApprovalWait: approval,
  };
  const values = {
    prepared: {
      nodeId: wait.nodeId,
      effectKey: wait.effectKey,
      inputs: wait.inputs,
      result: { suspend: true },
      step: 7,
      segmentStep: 2,
    },
    modelPin: wait.modelPin,
    executionScope: wait.executionScope,
    operatorId: wait.operatorId,
    rootRequestId: wait.rootRequestId,
    operatorData: { changeApprovalWait: approval },
    acceptedContributionIds: [request.contribution.id],
    waitConsumptions: [{
      version: 1,
      kind: "input-v1",
      contributionId: request.contribution.id,
    }],
  };
  return { request, approval, typed, values };
}

Deno.test("typed approval wait retains its bounded proposal receipt independently of the unconsumed input effect", () => {
  const { typed, approval } = approvalFixture();
  const parsed = parseNativeWaitEvidence(typed);
  assert.deepEqual(parsed.changeApprovalWait, approval);
  assert.notEqual(parsed.changeApprovalWait, approval);
  assert.notEqual(parsed.effectKey, parsed.changeApprovalWait!.effectKey);
  const interrupted = checkpointInterruptEvidence([["__interrupt__", {
    value: { waitEvidence: typed },
  }]]);
  assert.deepEqual(interrupted[0].changeApprovalWait, approval);
  for (
    const invalid of [
      null,
      [],
      { ...approval, version: 2 },
      { ...approval, identity: null },
      { ...approval, effectKey: "" },
      { ...approval, proposalIntentDigest: "" },
    ]
  ) {
    assert.throws(
      () => parseNativeWaitEvidence({ ...typed, changeApprovalWait: invalid }),
      /NATIVE_WAIT_EVIDENCE_INVALID/,
    );
  }
});

Deno.test("official input wait matches typed approval proof even after the original input was consumed", async () => {
  const { request, typed, values } = approvalFixture();
  typed.resultDigest = await executionDigest({ suspend: true });
  const saved = tuple(values);
  saved.pendingWrites = [["approval-task", "__interrupt__", {
    value: { waitEvidence: typed },
  }]];
  const before = canonical(saved), proofBefore = canonical(typed);
  await verifyOfficialWaitCheckpoint(saved, typed);
  assert.equal(canonical(saved), before);
  assert.equal(canonical(typed), proofBefore);
  const input = checkpointConsumptions(saved.checkpoint, {
    waitConsumptions: 1,
  });
  assert.deepEqual(input, [{
    version: 1,
    kind: "input-v1",
    contributionId: request.contribution.id,
  }]);
  assert.equal(
    input[0].wait,
    undefined,
    "original-input consumption does not name or consume the retained wait",
  );
  const resume = waitConsumption(typed);
  const successor = checkpoint(
    { ...values, waitConsumptions: [resume] },
    "resumed-successor",
  );
  assert.deepEqual(checkpointConsumptions(successor, { waitConsumptions: 2 }), [
    resume,
  ]);
  assert.notEqual(resume.contributionId, request.contribution.id);
  assert.equal(resume.sourceCheckpointId, saved.checkpoint.id);
});

Deno.test("official wait verification refuses technical evidence that disagrees with the persisted typed receipt", async () => {
  const { typed, values } = approvalFixture();
  typed.resultDigest = await executionDigest({ suspend: true });
  const saved = tuple(values);
  for (
    const mutation of [
      { prepared: undefined },
      { prepared: { ...values.prepared, nodeId: "another-occurrence" } },
      {
        prepared: { ...values.prepared, effectKey: "another-prepared-effect" },
      },
      { prepared: { ...values.prepared, inputs: { different: true } } },
      { prepared: { ...values.prepared, result: { suspend: false } } },
      {
        prepared: {
          ...values.prepared,
          result: { suspend: true, suspensionKind: "budget" },
        },
      },
      {
        prepared: {
          ...values.prepared,
          result: { suspend: true, modelAdvance: {} },
        },
      },
      {
        modelPin: {
          ...typed.modelPin,
          version: { ...typed.modelPin.version, digest: "another-pin" },
        },
      },
      {
        executionScope: {
          kind: "request",
          scopeId: "foreign",
          rootRequestId: "foreign",
        },
      },
      { operatorId: "another-operator" },
      { rootRequestId: "another-request" },
      { operatorData: {} },
      {
        operatorData: {
          changeApprovalWait: {
            ...typed.changeApprovalWait,
            changeId: "another-change",
          },
        },
      },
    ]
  ) {
    await assert.rejects(
      () =>
        verifyOfficialWaitCheckpoint(tuple({ ...values, ...mutation }), typed),
      /NATIVE_WAIT_OFFICIAL_CHECKPOINT_MISMATCH/,
    );
  }
  await assert.rejects(
    () => verifyOfficialWaitCheckpoint(undefined, typed),
    /NATIVE_WAIT_OFFICIAL_CHECKPOINT_MISMATCH/,
  );
  const wrongVersion = structuredClone(saved);
  Object.assign(wrongVersion.checkpoint, { v: 3 });
  await assert.rejects(
    () => verifyOfficialWaitCheckpoint(wrongVersion, typed),
    /NATIVE_WAIT_OFFICIAL_CHECKPOINT_MISMATCH/,
  );
  const pendingResume = structuredClone(saved);
  pendingResume.pendingWrites = [["resume-task", "__resume__", {
    contributionId: "enqueued-only",
  }]];
  await assert.rejects(
    () => verifyOfficialWaitCheckpoint(pendingResume, typed),
    /NATIVE_WAIT_OFFICIAL_CHECKPOINT_MISMATCH/,
  );
  await assert.rejects(
    () => verifyOfficialWaitCheckpoint(saved, { ...typed, kind: "budget" }),
    /NATIVE_WAIT_OFFICIAL_CHECKPOINT_MISMATCH/,
  );
  await assert.rejects(
    () =>
      verifyOfficialWaitCheckpoint(saved, {
        ...typed,
        resultDigest: "e".repeat(64),
      }),
    /NATIVE_WAIT_OFFICIAL_CHECKPOINT_MISMATCH/,
  );
});

Deno.test("explicit legacy import preserves the exact proposal wait metadata and retained technical bytes", async () => {
  const { request, typed, values } = approvalFixture();
  const saved = tuple(values);
  delete saved.checkpoint.channel_values.waitConsumptions;
  const before = canonical(saved);
  const imported = await decodeLegacyCheckpointWait(
    LEGACY_WAIT_PROTOCOL,
    saved,
    request,
  );
  assert.ok(imported);
  assert.deepEqual(imported.changeApprovalWait, typed.changeApprovalWait);
  assert.notEqual(imported.changeApprovalWait, typed.changeApprovalWait);
  await verifyOfficialWaitCheckpoint(saved, imported);
  assert.equal(canonical(saved), before);
  assert.equal(
    Object.hasOwn(saved.checkpoint.channel_values, "waitConsumptions"),
    false,
  );
});

Deno.test("typed wait interrupt parsing preserves every supported kind and proof bytes", () => {
  const { wait, request } = fixture();
  const advance = {
    kind: "verified-mandate-advance" as const,
    businessRevision: request.businessRevision,
    from: { identity: request.model.identity, version: request.model.version },
    to: {
      identity: request.model.identity,
      version: { ...request.model.version, digest: "next-model-digest" },
    },
    changeId: "change-wait",
    decidedAt: "2026-10-31T00:00:00.000Z",
    flowContractDigest: "b".repeat(64),
  };
  for (
    const kind of [
      "input",
      "decision",
      "budget",
      "contribution",
      "technical-advance",
    ] as const
  ) {
    const evidence: NativeWaitEvidence = {
      ...wait,
      kind,
      ...(kind === "technical-advance" ? { evidence: advance } : {}),
    };
    const writes: Parameters<typeof checkpointInterruptEvidence>[0] = [
      ["values", { unrelated: true }],
      ["__interrupt__", {
        id: "interrupt-id",
        value: { waitEvidence: evidence },
      }],
    ];
    const before = canonical(writes);
    const parsed = checkpointInterruptEvidence(writes);
    assert.deepEqual(parsed, [evidence]);
    assert.notEqual(parsed[0], evidence);
    assert.notEqual(parsed[0].inputs, evidence.inputs);
    assert.equal(canonical(writes), before);
  }
});

Deno.test("a modern interrupt without typed evidence refuses instead of choosing legacy", () => {
  for (
    const interrupt of [
      null,
      [],
      { id: "interrupt-id" },
      { value: null },
      { value: { kind: "native-await-input", nodeId: "historical-node" } },
      { value: { waitEvidence: null } },
    ]
  ) {
    assert.throws(
      () => checkpointInterruptEvidence([["__interrupt__", interrupt]]),
      /NATIVE_WAIT_(?:INTERRUPT|EVIDENCE)_INVALID/,
    );
  }
});

Deno.test("typed wait parser refuses malformed identities, digest and prepared node proof", () => {
  const { wait } = fixture();
  const invalid: unknown[] = [
    null,
    [],
    { ...wait, version: 2 },
    { ...wait, kind: "legacy" },
    { ...wait, nodeId: "" },
    { ...wait, actionId: "" },
    { ...wait, effectKey: "" },
    { ...wait, operatorId: "" },
    { ...wait, preparedNodeId: "native_wait_another-occurrence" },
    { ...wait, resultDigest: "not-a-result-digest" },
    { ...wait, inputs: [] },
    { ...wait, modelPin: null },
    { ...wait, executionScope: null },
    { ...wait, kind: "technical-advance" },
    { ...wait, evidence: {} },
  ];
  for (const value of invalid) {
    assert.throws(
      () => parseNativeWaitEvidence(value),
      /NATIVE_WAIT_EVIDENCE_INVALID/,
    );
  }
});

Deno.test("consumption proof is read only for an explicitly advanced proof channel", () => {
  const { wait } = fixture();
  const proof = waitConsumption(wait);
  const saved = checkpoint({
    waitConsumptions: [proof],
    acceptedContributionIds: [proof.contributionId],
  });
  const before = canonical(saved);
  assert.deepEqual(checkpointConsumptions(saved, {}), []);
  assert.deepEqual(
    checkpointConsumptions(saved, { values: "next-version" }),
    [],
  );
  assert.deepEqual(
    checkpointConsumptions(saved, { waitConsumptions: "next-version" }),
    [proof],
  );
  assert.equal(canonical(saved), before);
  const initial = {
    version: 1,
    kind: "input-v1",
    contributionId: "initial-input",
  };
  assert.deepEqual(
    checkpointConsumptions(checkpoint({ waitConsumptions: [initial] }), {
      waitConsumptions: 1,
    }),
    [initial],
  );
});

Deno.test("framework resume and accepted delivery channels grant no consumption proof", () => {
  const delivered = {
    contributionId: "accepted-but-not-consumed",
  };
  const saved = checkpoint({
    __resume__: delivered,
    acceptedContributionIds: [delivered.contributionId],
    waitConsumptions: [],
  });
  assert.deepEqual(
    checkpointConsumptions(saved, {
      __resume__: 1,
      acceptedContributionIds: 1,
    }),
    [],
  );
  assert.deepEqual(
    checkpointInterruptEvidence([["__resume__", delivered]]),
    [],
  );
});

Deno.test("advanced consumption channel refuses malformed proof instead of accepting a delivery", () => {
  const { wait } = fixture();
  const proof = waitConsumption(wait);
  const { wait: _wait, ...withoutWait } = proof;
  const { sourceCheckpointId: _source, ...withoutSource } = proof;
  for (
    const invalid of [
      null,
      {},
      "accepted-but-not-consumed",
      [null],
      [proof, proof],
      [{ ...proof, version: 2 }],
      [{ ...proof, kind: "resume" }],
      [{ ...proof, contributionId: "" }],
      [withoutWait],
      [withoutSource],
      [{ ...proof, sourceCheckpointId: "" }],
      [{ ...proof, wait: { ...wait, effectKey: "" } }],
      [{ ...proof, kind: "input-v1" }],
    ]
  ) {
    assert.throws(
      () =>
        checkpointConsumptions(checkpoint({ waitConsumptions: invalid }), {
          waitConsumptions: 1,
        }),
      /NATIVE_WAIT_(?:CONSUMPTION|EVIDENCE)_INVALID/,
    );
  }
});

Deno.test("historical checkpoint access requires the explicit immutable legacy protocol", async () => {
  const { request } = fixture();
  const saved = tuple({ acceptedContributionIds: ["historical-input"] });
  for (
    const protocol of [TYPED_WAIT_PROTOCOL, "", "missing", "typed-wait-v2"]
  ) {
    await assert.rejects(
      () => decodeLegacyCheckpointWait(protocol, saved, request),
      /NATIVE_WAIT_LEGACY_PROTOCOL_REQUIRED/,
    );
    assert.throws(
      () => legacyContributionConsumed(protocol, saved, "historical-input"),
      /NATIVE_WAIT_LEGACY_PROTOCOL_REQUIRED/,
    );
  }
  assert.equal(
    legacyContributionConsumed(LEGACY_WAIT_PROTOCOL, saved, "historical-input"),
    true,
  );
  assert.equal(
    legacyContributionConsumed(LEGACY_WAIT_PROTOCOL, saved, "another-input"),
    false,
  );
});

Deno.test("legacy wait decode appends a projection without mutating retained checkpoint bytes", async () => {
  const { request, wait } = fixture();
  const result = {
    suspend: true,
    localState: { notPreparedEvidence: "retained handler state" },
    operatorData: { unrelated: "historical extension" },
    messages: [{ content: "retained message bytes" }],
  };
  const saved = tuple({
    prepared: {
      nodeId: wait.nodeId,
      effectKey: wait.effectKey,
      inputs: wait.inputs,
      result,
      step: 7,
      segmentStep: 2,
    },
    modelPin: wait.modelPin,
    executionScope: wait.executionScope,
    operatorId: wait.operatorId,
    rootRequestId: wait.rootRequestId,
    acceptedContributionIds: [request.contribution.id],
    operatorData: {
      promotionId: "promotion-history",
      extension: ["retain", 1],
    },
    trace: [{ at: "2026-10-30T23:59:59.000Z", bytes: "é / e\u0301" }],
    unrelatedExtension: { nested: [null, false, "  retain spacing  "] },
  });
  const before = canonical(saved);
  const decoded = await decodeLegacyCheckpointWait(
    LEGACY_WAIT_PROTOCOL,
    saved,
    request,
  );
  assert.deepEqual(decoded, {
    ...wait,
    resultDigest: await executionDigest({ suspend: true }),
    promotionId: "promotion-history",
  });
  assert.equal(canonical(saved), before);
  assert.notEqual(
    decoded!.inputs,
    (saved.checkpoint.channel_values.prepared as { inputs: unknown }).inputs,
  );
  decoded!.inputs.message = "changed projected copy";
  assert.equal(canonical(saved), before);
});

Deno.test("legacy decoder refuses invalid retained waits and preserves a genuine absence", async () => {
  const { request, wait } = fixture();
  assert.equal(
    await decodeLegacyCheckpointWait(LEGACY_WAIT_PROTOCOL, tuple({}), request),
    undefined,
  );
  const state = {
    prepared: {
      nodeId: wait.nodeId,
      effectKey: wait.effectKey,
      inputs: wait.inputs,
      result: { suspend: true },
      step: 7,
      segmentStep: 2,
    },
    modelPin: wait.modelPin,
    executionScope: wait.executionScope,
    operatorId: wait.operatorId,
  };
  for (
    const invalid of [
      {
        ...state,
        prepared: { ...state.prepared, nodeId: "not-in-admitted-flow" },
      },
      { ...state, prepared: { ...state.prepared, effectKey: "" } },
      { ...state, modelPin: undefined },
      { ...state, executionScope: undefined },
      { ...state, operatorId: "" },
      { ...state, immutableGroup: { groupId: "unfinished-native-group" } },
    ]
  ) {
    await assert.rejects(
      () =>
        decodeLegacyCheckpointWait(
          LEGACY_WAIT_PROTOCOL,
          tuple(invalid),
          request,
        ),
      /NATIVE_WAIT_LEGACY_PROOF_INVALID/,
    );
  }
});

Deno.test("effect-result wait digest excludes handler transport fields while retaining result semantics", async () => {
  const prepared = {
    suspend: true,
    suspensionKind: "decision",
    outputs: { approved: false },
  };
  const extended = {
    ...prepared,
    localState: { promotionId: "handler-owned" },
    messages: [{ content: "a message" }],
    journal: [{ event: "a journal entry" }],
    operatorData: { state: "handler-owned" },
    asyncTasks: { task: { state: "pending" } },
  };
  assert.equal(
    await effectResultDigest(extended),
    await executionDigest(prepared),
  );
  assert.notEqual(
    await effectResultDigest({ ...extended, suspensionKind: "budget" }),
    await effectResultDigest(extended),
  );
  for (const invalid of [null, [], "an untyped result"]) {
    await assert.rejects(
      () => effectResultDigest(invalid),
      /NATIVE_WAIT_EFFECT_INVALID/,
    );
  }
});

Deno.test("budget continuation projection distinguishes unconsumed input and settled budget waits", () => {
  const { wait } = fixture();
  const source = {
    occurrenceId: wait.nodeId,
    preparedNodeId: wait.preparedNodeId,
    settledEffectKey: wait.effectKey,
  };
  assert.deepEqual(budgetSourceFromWait(wait), {
    ...source,
    sourceKind: "unconsumed-input-wait",
  });
  assert.deepEqual(budgetSourceFromWait({ ...wait, kind: "budget" }), {
    ...source,
    sourceKind: "settled-budget-wait",
  });
  for (
    const kind of ["decision", "contribution", "technical-advance"] as const
  ) {
    assert.equal(budgetSourceFromWait({ ...wait, kind }), undefined);
  }
});

Deno.test("official fork verification permits only the named exact target changes", () => {
  const { wait } = fixture();
  const source = tuple({
    modelPin: wait.modelPin,
    executionScope: wait.executionScope,
    rootRequestId: wait.rootRequestId,
    continuationRef: undefined,
    prepared: { effectKey: wait.effectKey, result: { suspend: true } },
    acceptedContributionIds: ["original-input"],
    trace: [{ text: "historical journal bytes" }],
    unrelated: { extension: [null, "é / e\u0301"] },
  });
  const changes = {
    modelPin: {
      ...wait.modelPin,
      version: { ...wait.modelPin.version, digest: "next-pin" },
    },
    executionScope: {
      kind: "request",
      scopeId: "target-request",
      rootRequestId: "target-request",
    },
    rootRequestId: "target-request",
    continuationRef: "selected-continuation",
  };
  const target = tuple({ ...source.checkpoint.channel_values, ...changes });
  const before = canonical(source);
  verifyOfficialFork(source, target, changes);
  assert.equal(canonical(source), before);
  for (
    const mutation of [
      { prepared: { effectKey: "another-effect", result: { suspend: true } } },
      { acceptedContributionIds: ["newly-enqueued-resume"] },
      { trace: [] },
      { unrelated: { extension: [null, "changed"] } },
      { unexpectedChannel: "new channel" },
    ]
  ) {
    const corrupt = tuple({ ...target.checkpoint.channel_values, ...mutation });
    assert.throws(
      () => verifyOfficialFork(source, corrupt, changes),
      /NATIVE_FORK_CHANNEL_CHANGED:/,
    );
  }
  const removed = structuredClone(target);
  delete removed.checkpoint.channel_values.unrelated;
  assert.throws(
    () => verifyOfficialFork(source, removed, changes),
    /NATIVE_FORK_CHANNEL_CHANGED:unrelated/,
  );
  const wrongTarget = tuple({
    ...target.checkpoint.channel_values,
    continuationRef: "another-receipt",
  });
  assert.throws(
    () => verifyOfficialFork(source, wrongTarget, changes),
    /NATIVE_FORK_TARGET_CHANGED:continuationRef/,
  );
});

Deno.test("legacy official fork permits only the newly initialized empty consumption channel", () => {
  const source = tuple({
    prepared: { nodeId: "old-wait", effectKey: "old-effect" },
    trace: [{ text: "retained exact history" }],
    foreign: { unrelated: ["é", null, false] },
  });
  const before = canonical(source);
  const changes = { continuationRef: "explicit-fork" };
  const target = tuple({
    ...source.checkpoint.channel_values,
    ...changes,
    waitConsumptions: [],
  });
  verifyOfficialFork(source, target, changes, LEGACY_WAIT_PROTOCOL);
  assert.equal(canonical(source), before);
  assert.equal(
    Object.hasOwn(source.checkpoint.channel_values, "waitConsumptions"),
    false,
  );
  for (const protocol of [TYPED_WAIT_PROTOCOL, undefined]) {
    assert.throws(
      () => verifyOfficialFork(source, target, changes, protocol),
      /NATIVE_FORK_CHANNEL_CHANGED:waitConsumptions/,
    );
  }
  assert.throws(
    () => verifyOfficialFork(source, target, changes, "unknown-protocol"),
    /NATIVE_FORK_SOURCE_PROTOCOL_INVALID/,
  );
  for (
    const value of [
      null,
      {},
      [{}],
      [{ version: 1, kind: "input-v1", contributionId: "enqueued" }],
      false,
      "",
    ]
  ) {
    assert.throws(
      () =>
        verifyOfficialFork(
          source,
          tuple({
            ...target.checkpoint.channel_values,
            waitConsumptions: value,
          }),
          changes,
          LEGACY_WAIT_PROTOCOL,
        ),
      /NATIVE_FORK_CHANNEL_CHANGED:waitConsumptions/,
    );
  }
  const existing = tuple({
    ...source.checkpoint.channel_values,
    waitConsumptions: [{ retained: "proof" }],
  });
  assert.throws(
    () => verifyOfficialFork(existing, target, changes, LEGACY_WAIT_PROTOCOL),
    /NATIVE_FORK_CHANNEL_CHANGED:waitConsumptions/,
  );
  const explicitUndefined = tuple({
    ...source.checkpoint.channel_values,
    waitConsumptions: undefined,
  });
  assert.throws(
    () =>
      verifyOfficialFork(
        explicitUndefined,
        target,
        changes,
        LEGACY_WAIT_PROTOCOL,
      ),
    /NATIVE_FORK_CHANNEL_CHANGED:waitConsumptions/,
  );
  for (
    const mutation of [{ foreign: { unrelated: ["changed"] } }, { trace: [] }, {
      unexpected: [],
    }]
  ) {
    assert.throws(
      () =>
        verifyOfficialFork(
          source,
          tuple({ ...target.checkpoint.channel_values, ...mutation }),
          changes,
          LEGACY_WAIT_PROTOCOL,
        ),
      /NATIVE_FORK_CHANNEL_CHANGED:/,
    );
  }
  const removed = structuredClone(target);
  delete removed.checkpoint.channel_values.foreign;
  assert.throws(
    () => verifyOfficialFork(source, removed, changes, LEGACY_WAIT_PROTOCOL),
    /NATIVE_FORK_CHANNEL_CHANGED:foreign/,
  );
});

Deno.test(
  "modern effect verification preserves the native default budget wait without rewriting result evidence",
  async () => {
    const { request, wait } = fixture();
    const node = request.flow.nodes.find((entry) =>
      entry.kind === "action" && entry.mechanism !== "await_input"
    );
    assert.ok(node);
    const result = {
      suspend: true,
      outputs: { reason: "budget: é / e\u0301" },
    };
    const resultJson = JSON.stringify(result);
    const digest = await executionDigest(result);
    const typed: NativeWaitEvidence = {
      ...wait,
      kind: "budget",
      nodeId: node.id,
      actionId: node.nativeId,
      preparedNodeId: nativeFrameworkNodeName(node.id, "await-preparation"),
      resultDigest: digest,
    };
    let row: Record<string, unknown> = {
      nodeId: node.nativeId,
      status: "completed",
      resultJson,
    };
    const ledger = new ExecutionWaitEvidenceLedger(
      (name) => name,
      () =>
        Promise.reject(new Error("modern verification cannot decode history")),
    );
    const query = () => Promise.resolve({ rows: [row] });
    const scope = {
      projectId: "default-budget-project",
      systemId: "default-budget-system",
      executionSpaceId: "main",
      operatorId: request.identity.operatorId,
    };
    await ledger.verifyEffect(query, scope, "default-budget-thread", typed);
    assert.equal(row.resultJson, resultJson);
    assert.equal(typed.resultDigest, digest);
    assert.notEqual(
      digest,
      await executionDigest({ ...result, suspensionKind: "budget" }),
      "defaulting the kind must not normalize or rewrite the result digest",
    );
    await assert.rejects(
      () =>
        ledger.verifyEffect(query, scope, "default-budget-thread", {
          ...typed,
          kind: "decision",
        }),
      /NATIVE_WAIT_SETTLED_EFFECT_MISMATCH/,
    );
    for (
      const invalid of [
        { ...result, suspend: false },
        { ...result, suspensionKind: "decision" },
        { ...result, suspensionKind: null },
        { ...result, suspensionKind: "" },
        { ...result, suspensionKind: "unsupported" },
        { ...result, modelAdvance: {} },
      ]
    ) {
      row = { ...row, resultJson: JSON.stringify(invalid) };
      const altered = {
        ...typed,
        resultDigest: await executionDigest(invalid),
      };
      await assert.rejects(
        () =>
          ledger.verifyEffect(query, scope, "default-budget-thread", altered),
        /NATIVE_WAIT_SETTLED_EFFECT_MISMATCH/,
      );
    }
    row = { nodeId: node.nativeId, status: "started", resultJson };
    await assert.rejects(
      () => ledger.verifyEffect(query, scope, "default-budget-thread", typed),
      /NATIVE_WAIT_SETTLED_EFFECT_MISMATCH/,
    );
  },
);

Deno.test(
  "legacy decode preserves the native default budget wait and original checkpoint bytes",
  async () => {
    const { request, wait } = fixture();
    const node = request.flow.nodes.find((entry) =>
      entry.kind === "action" && entry.mechanism !== "await_input"
    );
    assert.ok(node);
    const result = {
      suspend: true,
      outputs: { reason: "budget: é / e\u0301" },
    };
    const saved = tuple({
      prepared: {
        nodeId: node.id,
        effectKey: wait.effectKey,
        inputs: wait.inputs,
        result,
        step: 7,
        segmentStep: 2,
      },
      modelPin: wait.modelPin,
      executionScope: wait.executionScope,
      operatorId: wait.operatorId,
      rootRequestId: wait.rootRequestId,
      operatorData: {},
    });
    const before = canonical(saved);
    const decoded = await decodeLegacyCheckpointWait(
      LEGACY_WAIT_PROTOCOL,
      saved,
      request,
    );
    assert.ok(decoded);
    assert.equal(decoded.kind, "budget");
    assert.equal(decoded.nodeId, node.id);
    assert.equal(decoded.resultDigest, await executionDigest(result));
    assert.notEqual(
      decoded.resultDigest,
      await executionDigest({ ...result, suspensionKind: "budget" }),
    );
    assert.equal(canonical(saved), before);
    for (const invalid of [null, "", "unsupported"]) {
      const corrupt = structuredClone(saved);
      (corrupt.checkpoint.channel_values.prepared as {
        result: Record<string, unknown>;
      }).result.suspensionKind = invalid;
      await assert.rejects(
        () =>
          decodeLegacyCheckpointWait(LEGACY_WAIT_PROTOCOL, corrupt, request),
        /NATIVE_WAIT_LEGACY_KIND_INVALID/,
      );
    }
    await assert.rejects(
      () => decodeLegacyCheckpointWait(TYPED_WAIT_PROTOCOL, saved, request),
      /NATIVE_WAIT_LEGACY_PROTOCOL_REQUIRED/,
    );
  },
);
