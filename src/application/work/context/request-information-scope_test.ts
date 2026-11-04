import assert from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type {
  ModelSourceRevision,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { postgresScopeValidation } from "../../../adapters/out/postgres/scope.ts";
import { RequestInformationScope } from "./request-information-scope.ts";

function fixture() {
  const model = artifactModel("owner");
  model.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  let snapshot: SystemRuntimeState | undefined = {
    id: "request:space:owner",
    revision: 0,
    catalogRevision: 0,
    model: structuredClone(model.identity),
    executionModel: structuredClone(model),
    messages: [],
    candidates: [],
    events: [],
    busy: false,
    phase: "idle",
    provider: "controlled",
  };
  const scope = new RequestInformationScope({
    validation: postgresScopeValidation,
    hostScope: { projectId: "host", systemId: "system" },
    sourceProjectId: model.identity.projectId,
    scope: {
      projectId: "host",
      systemId: "system",
      executionSpaceId: "space",
      operatorId: "owner",
    },
    model,
    currentSnapshot: () => snapshot,
  });
  return {
    model,
    scope,
    replace: (next: SystemRuntimeState | undefined) => {
      snapshot = next;
    },
    snapshot: () => snapshot,
  };
}

Deno.test("Request source scope revalidates live identity after an asynchronous exact source read", async () => {
  const f = fixture();
  let finish: ((revision: ModelSourceRevision) => void) | undefined;
  const pending = f.scope.readSourceRevision("owner", (model) => {
    assert.deepEqual(model, f.model);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const sibling = structuredClone(f.snapshot()!);
  sibling.id = "request:sibling:owner";
  f.replace(sibling);
  finish!({
    version: f.model.version.repositoryVersion!,
    sources: { "model.sysml": "package Exact {}" },
  });
  await assert.rejects(() => pending, /another Request/);
});

Deno.test("Request source scope preserves exact read failures and refuses unavailable live state before reads", async () => {
  const f = fixture(),
    failure = new Error("Exact retained source is unavailable");
  await assert.rejects(
    () => f.scope.readSourceRevision("owner", () => Promise.reject(failure)),
    (error) => error === failure,
  );
  f.replace(undefined);
  let reads = 0;
  await assert.rejects(() =>
    f.scope.readSourceRevision("owner", () => {
      reads++;
      return Promise.resolve({
        version: f.model.version.repositoryVersion!,
        sources: {},
      });
    }), /live Request source snapshot is unavailable/);
  assert.equal(reads, 0);
});

function historicalFixture() {
  const r0 = artifactModel("owner"), r1 = structuredClone(r0);
  r0.version.digest = "a".repeat(64);
  r0.version.repositoryVersion = `commit:${"b".repeat(40)}`;
  r1.version.digest = "c".repeat(64);
  r1.version.repositoryVersion = `commit:${"d".repeat(40)}`;
  const r0ref = {
    digest: r0.version.digest,
    repositoryVersion: r0.version.repositoryVersion,
    actionId: "action",
    sourceIds: ["action"],
  };
  let snapshot: SystemRuntimeState = {
    id: "request:space:owner",
    revision: 3,
    catalogRevision: 0,
    model: structuredClone(r1.identity),
    executionModel: structuredClone(r1),
    caseInvocation: { kind: "local", caseId: "caseA" },
    cases: [{
      id: "caseA",
      number: 1,
      type: "request",
      objective: "work",
      owner: "owner",
      openedBy: "owner",
      openedFrom: { conversationId: "conversation" },
      modelPin: {
        digest: r0.version.digest,
        repositoryVersion: r0.version.repositoryVersion,
      },
      status: "open",
      createdAt: "2026-10-22T00:00:00.000Z",
    }],
    messages: [
      {
        id: "decision",
        caseId: "caseA",
        role: "assistant",
        text: "decision",
        at: "2026-10-22T00:00:00.000Z",
        execution: structuredClone(r0ref),
      },
      {
        id: "source",
        caseId: "caseA",
        role: "tool",
        text: "result",
        at: "2026-10-22T00:00:00.000Z",
        execution: structuredClone(r0ref),
        observation: { kind: "tool-result", value: "ok" },
      },
    ],
    candidates: [],
    events: [],
    busy: false,
    phase: "idle",
    provider: "controlled",
  };
  const content:
    import("../../../domain/memory/entities/memory-record.ts").MemoryContent = {
      text: "Preserved observation",
      origin: { decisionId: "decision", sourceRefs: ["message:source"] },
      scope: ["construction"],
      validUntil: "2026-10-23T00:00:00.000Z",
      outcome: {
        status: "known",
        summary: "Observed",
        evidenceRefs: ["message:source"],
      },
    };
  let executed: typeof r0 | null = r0;
  const calls: unknown[] = [];
  const scope = new RequestInformationScope({
    validation: postgresScopeValidation,
    hostScope: { projectId: "host", systemId: "system" },
    sourceProjectId: r1.identity.projectId,
    scope: {
      projectId: "host",
      systemId: "system",
      executionSpaceId: "space",
      operatorId: "owner",
    },
    model: r1,
    currentSnapshot: () => snapshot,
    resolveExecutedModel: (pin) => {
      calls.push(structuredClone(pin));
      return Promise.resolve(executed && structuredClone(executed));
    },
  });
  return {
    scope,
    r0,
    r1,
    content,
    calls,
    state: () => snapshot,
    setState: (value: SystemRuntimeState) => snapshot = value,
    setExecuted: (value: typeof r0 | null) => executed = value,
  };
}
Deno.test("R1 caller resolves only current model while historical R0 decision and outcome retain their pins", async () => {
  const f = historicalFixture(), original = structuredClone(f.state());
  assert.equal(await f.scope.verify("owner", f.content), true);
  assert.deepEqual(f.calls, [{
    digest: f.r0.version.digest,
    repositoryVersion: f.r0.version.repositoryVersion,
  }]);
  assert.deepEqual(
    await f.scope.resolveCallerModel("owner", {
      digest: f.r1.version.digest,
      repositoryVersion: f.r1.version.repositoryVersion!,
    }),
    f.r1,
  );
  assert.equal(
    await f.scope.resolveCallerModel("owner", {
      digest: f.r0.version.digest,
      repositoryVersion: f.r0.version.repositoryVersion!,
    }),
    null,
  );
  assert.equal(
    await f.scope.resolveCallerModel("other", {
      digest: f.r1.version.digest,
      repositoryVersion: f.r1.version.repositoryVersion!,
    }),
    null,
  );
  assert.deepEqual(f.state(), original);
});
Deno.test("historical memory refuses foreign, mixed, unexecuted, or unobserved evidence", async () => {
  for (
    const mutation of [
      "unexecuted",
      "foreign-model",
      "foreign-case",
      "mixed-digest",
      "mixed-version",
      "decision-role",
      "decision-action",
      "outcome-role",
      "outcome-action",
      "outcome-observation",
    ] as const
  ) {
    const f = historicalFixture(),
      state = structuredClone(f.state()),
      decision = state.messages[0],
      outcome = state.messages[1];
    if (mutation === "unexecuted") f.setExecuted(null);
    if (mutation === "foreign-model") {
      const foreign = structuredClone(f.r0);
      foreign.identity.builderId = "other";
      f.setExecuted(foreign);
    }
    if (mutation === "foreign-case") outcome.caseId = "caseB";
    if (mutation === "mixed-digest") {
      outcome.execution!.digest = f.r1.version.digest;
    }
    if (mutation === "mixed-version") {
      outcome.execution!.repositoryVersion = f.r1.version.repositoryVersion;
    }
    if (mutation === "decision-role") decision.role = "user";
    if (mutation === "decision-action") delete decision.execution!.actionId;
    if (mutation === "outcome-role") outcome.role = "assistant";
    if (mutation === "outcome-action") delete outcome.execution!.actionId;
    if (mutation === "outcome-observation") delete outcome.observation;
    f.setState(state);
    assert.equal(await f.scope.verify("owner", f.content), false, mutation);
  }
});

Deno.test("R1 governed policy controls capture and review of retained R0 evidence", async () => {
  const f = historicalFixture();
  const { GovernedMemoryPromotionService } = await import(
    "../../memory/governed-memory-promotion.ts"
  );
  type Record =
    import("../../../domain/memory/entities/memory-record.ts").MemoryRecord;
  const records = new Map<string, Record>();
  const service = new GovernedMemoryPromotionService({
    provenance: f.scope,
    now: () => "2026-10-22T00:00:00.000Z",
    store: {
      load: (_owner, id) =>
        Promise.resolve(structuredClone(records.get(id) ?? null)),
      list: () => Promise.resolve(structuredClone([...records.values()])),
      save: (record, expected) => {
        const previous = records.get(record.id);
        if (
          (previous?.revision ?? null) !== (expected?.revision ?? null) ||
          (expected && previous?.digest !== expected.digest)
        ) throw new Error("memory CAS mismatch");
        records.set(record.id, structuredClone(record));
        return Promise.resolve();
      },
    },
  });
  const modelVersion = {
    digest: f.r1.version.digest,
    repositoryVersion: f.r1.version.repositoryVersion!,
  };
  const policy = {
    id: "policy",
    ownerId: "owner",
    modelVersion,
    allowedScopes: ["construction"],
    permissions: { capture: ["owner"], recall: ["owner"], admit: ["owner"] },
    requireSourceRefs: true,
    requireKnownOutcome: true,
    maxValidityMs: 86400000,
    allowSelfAdmission: true,
  };
  const auth = {
    callerId: "owner",
    behaviorId: "memory",
    invocationId: "capture",
    modelVersion,
    policy,
  };
  const captured = await service.capture(auth, {
    id: "retained",
    content: f.content,
  });
  const denied = {
    ...auth,
    invocationId: "deny",
    policy: { ...policy, permissions: { ...policy.permissions, admit: [] } },
  };
  await assert.rejects(() =>
    service.review(denied, {
      id: "retained",
      expected: {
        revision: captured.memory.revision,
        digest: captured.memory.digest,
      },
      decision: "admit",
      reason: "review",
    }), /admit permission/);
  const reviewed = await service.review({ ...auth, invocationId: "review" }, {
    id: "retained",
    expected: {
      revision: captured.memory.revision,
      digest: captured.memory.digest,
    },
    decision: "admit",
    reason: "review",
  });
  assert.equal(reviewed.memory.status, "admitted");
  assert.deepEqual(reviewed.memory.content, f.content);
  assert.equal(
    (await service.recall({ ...auth, invocationId: "recall" }, {
      id: "retained",
    }))[0].status,
    "admitted",
  );
});

Deno.test("Request source scope exposes admitted design S separately from executed R only with exact host provenance", async () => {
  const f = fixture(), snapshot = structuredClone(f.snapshot()!);
  snapshot.cases = [{
    id: "case",
    number: 1,
    owner: "owner",
    openedBy: "human",
    type: "request",
    objective: "Revise",
    modelPin: { digest: f.model.version.digest },
    status: "open",
    createdAt: "2026-10-31T00:00:00Z",
    openedFrom: { conversationId: "main", openingId: "opening" },
  }];
  f.replace(snapshot);
  const revision: ModelSourceRevision = {
    version: `commit:${"b".repeat(40)}`,
    sources: { "model.sysml": "package Design {}" },
    requestSource: {
      kind: "admitted-request-source",
      openingId: "opening",
      executionSpaceId: "space",
      admittedSourceVersion: `commit:${"b".repeat(40)}`,
      sourceAdmissionRevision: 2,
      sourceAdmissionManifestDigest: "f".repeat(64),
      executedSourceVersion: f.model.version.repositoryVersion!,
    },
  };
  const read = await f.scope.readSourceRevision(
    "owner",
    () => Promise.resolve(structuredClone(revision)),
  );
  assert.equal(read.version, revision.version);
  assert.equal(
    read.requestSource!.executedSourceVersion,
    f.model.version.repositoryVersion,
  );
  assert.equal(
    f.scope.snapshotForCaller("owner")!.executionModel!.version
      .repositoryVersion,
    f.model.version.repositoryVersion,
  );
  await assert.rejects(
    f.scope.readSourceRevision(
      "owner",
      () =>
        Promise.resolve({
          version: revision.version,
          sources: revision.sources,
        }),
    ),
    /another Request revision/,
  );
  await assert.rejects(
    f.scope.readSourceRevision(
      "owner",
      () =>
        Promise.resolve({
          ...revision,
          requestSource: {
            ...revision.requestSource!,
            executionSpaceId: "sibling",
          },
        }),
    ),
    /another Request revision/,
  );
});
