import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { legacyOwnerAuthority } from "../../../domain/governance/authority.ts";
import { OperatorAuthorityError } from "../../../domain/governance/operator-authority-error.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  Candidate,
  ToolDraft,
} from "../../../domain/work/records/candidates.ts";
import type { Case } from "../../../domain/work/entities/cases.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type { CandidateDelegatedActor } from "../../../domain/governance/policies/tool-admission-policy.ts";
import {
  type CandidateDecisionsHost,
  decideCandidate,
  inspectCandidate,
  resumeCandidateDecisions,
} from "./decisions.ts";
import { draftDigest } from "../runtime/values.ts";

const AT = "2026-10-28T00:00:00.000Z";
const ACTOR: CandidateDelegatedActor = {
  actorId: "main",
  policyId: "tested-tools",
  policyRevision: 1,
};

function draft(name = "reader"): ToolDraft {
  return {
    name,
    description: "Exact reader",
    kind: "read_web_page",
    code: "export default ({html}) => ({title:'Page',text:html})",
  };
}

function modelFixture(): ExecutableModel {
  const model = executableFixture({
    projectId: "project",
    editingContextId: "context",
    rootId: "root",
    systemId: "worker-system",
    catalogId: "catalog",
    builderId: "worker",
  });
  model.version.repositoryVersion = "commit:char";
  model.ownerAuthority = {
    ...legacyOwnerAuthority(model.identity.systemId),
    ownerSource: "modeled",
  };
  model.toolAdmissionPolicies = [{
    id: ACTOR.policyId,
    revision: ACTOR.policyRevision,
    enabled: true,
    recipients: [model.identity.builderId],
    toolKinds: ["read_web_page"],
    maxDelegationDepth: 0,
    elementId: "native-tool-admission-policy",
    holderNativeId: ACTOR.actorId,
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    rootAuthority: {
      ...legacyOwnerAuthority("main-system"),
      ownerSource: "modeled",
    },
    sourceIds: ["native-tool-admission-policy"],
  }];
  return model;
}

function openLocalCase(id: string): Case {
  return { id, status: "open" } as unknown as Case;
}

async function awaitingCandidate(
  model: ExecutableModel,
  overrides: Partial<Candidate> = {},
): Promise<Candidate> {
  const d = draft(overrides.name ?? "reader");
  const digest = await draftDigest(d);
  const tests = {
    passed: true,
    checks: [{ name: "c", passed: true, detail: "ok" }],
  };
  const contract = model.contracts.find((c) => c.kind === d.kind)!;
  return {
    ...d,
    id: "c1",
    caseId: "case-1",
    digest,
    stage: "awaiting-admission",
    createdAt: AT,
    baseCatalogRevision: 0,
    tests: structuredClone(tests),
    requiredAuthority: "human",
    proposedConfigurationRevision: model.configuration.revision,
    promotionModelDigest: model.version.digest,
    toolAdmissionPolicyPins: [{
      policyId: ACTOR.policyId,
      policyRevision: ACTOR.policyRevision,
      holderNativeId: ACTOR.actorId,
      policyElementId: "native-tool-admission-policy",
    }],
    toolAdmissionContract: structuredClone(contract),
    ...overrides,
  };
}

function decisionsHost(
  model: ExecutableModel,
  state: SystemRuntimeState,
  overrides: Partial<CandidateDecisionsHost> = {},
): CandidateDecisionsHost & {
  calls: {
    builds: Array<{ draft?: unknown; resumeId?: string }>;
    feedbacks: string[];
    runTurns: number;
    preparedSelected: number;
  };
} {
  const calls = {
    builds: [] as Array<{ draft?: unknown; resumeId?: string }>,
    feedbacks: [] as string[],
    runTurns: 0,
    preparedSelected: 0,
  };
  const host: CandidateDecisionsHost = {
    get state() {
      return state;
    },
    ports: {
      clock: { now: () => AT },
      caseNumbers: { allocate: () => Promise.resolve(1) },
    },
    control: (action) => action(),
    currentModel: () => Promise.resolve(structuredClone(model)),
    candidate: (id: string) => {
      const found = state.candidates.find((c) => c.id === id);
      if (!found) throw new Error("Candidat introuvable");
      return found;
    },
    continuationFingerprint: () => Promise.resolve(undefined),
    update: (change) => {
      change(state);
      return Promise.resolve();
    },
    action: (_node, effect) => effect(structuredClone(model)),
    build: (d, resumeId) => {
      calls.builds.push({ draft: d, resumeId });
      return Promise.resolve();
    },
    prepareSelectedTools: () => {
      calls.preparedSelected++;
      return Promise.resolve();
    },
    feedback: (text: string) => {
      calls.feedbacks.push(text);
      return Promise.resolve();
    },
    runTurn: () => {
      calls.runTurns++;
      return Promise.resolve();
    },
    workCompletion: () =>
      Promise.reject(new Error("workCompletion must not be called")),
    ...overrides,
  };
  return Object.assign(host, { calls });
}

function stateFixture(
  model: ExecutableModel,
  candidates: Candidate[],
): SystemRuntimeState {
  return {
    id: "system",
    revision: 0,
    model: model.identity,
    executionModel: structuredClone(model),
    configuration: structuredClone(model.configuration),
    catalogRevision: 0,
    candidates,
    cases: [openLocalCase("case-1")],
    caseInvocation: { kind: "local", caseId: "case-1" },
    events: [],
    messages: [],
  } as unknown as SystemRuntimeState;
}

// --- inspectCandidate ---

Deno.test("decisions/inspectCandidate projects the exact tested candidate", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model);
  const state = stateFixture(model, [c]);
  const host = decisionsHost(model, state);
  const result = await inspectCandidate.call(host, {
    candidateId: "c1",
    candidateDigest: c.digest,
    caseId: "case-1",
  }, ACTOR);
  equal(result.operatorId, "worker");
  equal(result.candidate.id, "c1");
  equal(result.candidate.digest, c.digest);
  equal(result.candidate.stage, "awaiting-admission");
  equal(result.contract.kind, "read_web_page");
  ok(result.authorityExercise.candidateDelegation);
  equal(result.authorityExercise.candidateDelegation!.actorId, "main");
  equal(result.authorityExercise.candidateDelegation!.candidateId, "c1");
});

Deno.test("decisions/inspectCandidate refuses a recorded decision as stale", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model, {
    admissionDecision: {
      candidateDigest: "x",
      verdict: "approve",
      reason: "done",
    },
  });
  // Fix digest after override.
  c.admissionDecision!.candidateDigest = c.digest;
  const state = stateFixture(model, [c]);
  const host = decisionsHost(model, state);
  let error: unknown;
  try {
    await inspectCandidate.call(host, {
      candidateId: "c1",
      candidateDigest: c.digest,
      caseId: "case-1",
    }, ACTOR);
  } catch (e) {
    error = e;
  }
  ok(error instanceof OperatorAuthorityError);
  equal(error.code, "AUTHORITY_REQUEST_STALE");
});

Deno.test("decisions/inspectCandidate requires the exact open tested candidate", async () => {
  const mutations: Array<
    (
      c: Candidate,
      input: { candidateId: string; candidateDigest: string; caseId: string },
      state: SystemRuntimeState,
    ) => void
  > = [
    (_c, input) => {
      input.caseId = "other-case";
    },
    (_c, _input, state) => {
      state.cases = [];
    },
    (c) => {
      c.stage = "testing";
    },
    (c) => {
      c.requiredAuthority = "builder";
    },
    (_c, input) => {
      input.candidateDigest = "0".repeat(64);
    },
    (c) => {
      c.code += "\n// changed";
    },
    (c) => {
      c.baseCatalogRevision = 99;
    },
  ];
  for (const mutate of mutations) {
    const model = modelFixture();
    const c = await awaitingCandidate(model);
    const state = stateFixture(model, [c]);
    const input = {
      candidateId: "c1",
      candidateDigest: c.digest,
      caseId: "case-1",
    };
    mutate(c, input, state);
    const host = decisionsHost(model, state);
    let error: unknown;
    try {
      await inspectCandidate.call(host, input, ACTOR);
    } catch (e) {
      error = e;
    }
    ok(
      error instanceof Error,
      "inspect must reject the mutated fixture",
    );
    ok(
      error.message.includes("exact tested candidate") ||
        error.message.includes("person's decision") ||
        error instanceof OperatorAuthorityError,
      `unexpected message: ${error.message}`,
    );
  }
});

// --- decideCandidate validation ---

Deno.test("decisions/decideCandidate validates verdict and reason", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model);
  const state = stateFixture(model, [c]);
  const host = decisionsHost(model, state);
  for (
    const input of [
      {
        candidateId: "c1",
        candidateDigest: c.digest,
        verdict: "maybe",
        reason: "ok",
      },
      {
        candidateId: "c1",
        candidateDigest: c.digest,
        verdict: "approve",
        reason: "",
      },
      {
        candidateId: "c1",
        candidateDigest: c.digest,
        verdict: "approve",
        reason: "   ",
      },
      {
        candidateId: "c1",
        candidateDigest: c.digest,
        verdict: "approve",
        reason: "x".repeat(2001),
      },
    ]
  ) {
    let error: unknown;
    try {
      await decideCandidate.call(
        host,
        input as unknown as Parameters<typeof decideCandidate>[0],
      );
    } catch (e) {
      error = e;
    }
    ok(error instanceof Error);
    ok(error.message.includes("justification courte"));
  }
});

Deno.test("decisions/decideCandidate refuses a closed case", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model);
  const state = stateFixture(model, [c]);
  state.cases = []; // no open case, no initialization seed
  const host = decisionsHost(model, state);
  let error: unknown;
  try {
    await decideCandidate.call(host, {
      candidateId: "c1",
      candidateDigest: c.digest,
      verdict: "approve",
      reason: "Admit",
    });
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  equal((error as { code?: string }).code ?? "", "CASE_CLOSED");
});

Deno.test("decisions/decideCandidate with delegation revalidates the exact inspection", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model);
  const state = stateFixture(model, [c]);
  const host = decisionsHost(model, state);
  let error: unknown;
  try {
    await decideCandidate.call(host, {
      candidateId: "c1",
      candidateDigest: "0".repeat(64),
      caseId: "case-1",
      verdict: "approve",
      reason: "Admit",
    }, ACTOR);
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
});

Deno.test("decisions/decideCandidate inside control requires awaiting human admission", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model, { stage: "testing" });
  const state = stateFixture(model, [c]);
  const host = decisionsHost(model, state);
  let error: unknown;
  try {
    await decideCandidate.call(host, {
      candidateId: "c1",
      candidateDigest: c.digest,
      verdict: "approve",
      reason: "Admit",
    });
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  ok(error.message.includes("n’attend pas de décision humaine"));
});

Deno.test("decisions/decideCandidate inside control requires the exact digest", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model);
  const state = stateFixture(model, [c]);
  const host = decisionsHost(model, state);
  let error: unknown;
  try {
    await decideCandidate.call(host, {
      candidateId: "c1",
      candidateDigest: "0".repeat(64),
      verdict: "approve",
      reason: "Admit",
    });
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  ok(error.message.includes("ne correspond pas au candidat exact"));
});

Deno.test("decisions/decideCandidate requires the admitted promotion pin", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model, { promotionModelDigest: "other" });
  const state = stateFixture(model, [c]);
  const host = decisionsHost(model, state);
  let error: unknown;
  try {
    await decideCandidate.call(host, {
      candidateId: "c1",
      candidateDigest: c.digest,
      verdict: "approve",
      reason: "Admit",
    });
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  ok(error.message.includes("ne correspond plus"));
});

Deno.test("decisions/decideCandidate requires a native admission continuation", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model, {
    promotionExecution: {
      subjectId: "subject-1",
      modelDigest: model.version.digest,
    },
  });
  const state = stateFixture(model, [c]);
  const host = decisionsHost(model, state, {
    ports: {
      clock: { now: () => AT },
      caseNumbers: { allocate: () => Promise.resolve(1) },
      execution: {
        inspect: () => Promise.resolve([]),
      } as unknown as NonNullable<
        CandidateDecisionsHost["ports"]["execution"]
      >,
    },
  });
  let error: unknown;
  try {
    await decideCandidate.call(host, {
      candidateId: "c1",
      candidateDigest: c.digest,
      verdict: "approve",
      reason: "Admit",
    });
  } catch (e) {
    error = e;
  }
  ok(error instanceof Error);
  ok(error.message.includes("continuation d’admission native"));
});

Deno.test("decisions/decideCandidate records the decision and resumes promotion", async () => {
  const model = modelFixture();
  const admissionNode = model.flows.promotion.nodes.find((n) =>
    n.mechanism === "decide_admission"
  )!;
  const c = await awaitingCandidate(model, {
    promotionExecution: {
      subjectId: "subject-1",
      modelDigest: model.version.digest,
    },
  });
  const state = stateFixture(model, [c]);
  const execution = {
    inspect: () =>
      Promise.resolve([
        {
          identity: {
            operatorId: "worker",
            purpose: "promotion",
            subjectId: "subject-1",
          },
          status: "waiting",
          unsettledEffects: [],
          modelDigest: model.version.digest,
          waits: [{ nodeId: admissionNode.id, kind: "decision" }],
        },
      ]),
  } as unknown as NonNullable<CandidateDecisionsHost["ports"]["execution"]>;
  const host = decisionsHost(model, state, {
    ports: {
      clock: { now: () => AT },
      caseNumbers: { allocate: () => Promise.resolve(1) },
      execution,
    },
  });
  await decideCandidate.call(host, {
    candidateId: "c1",
    candidateDigest: c.digest,
    verdict: "approve",
    reason: "  Admit the exact candidate  ",
  });
  const stored = state.candidates[0]!;
  deepStrictEqual(stored.admissionDecision, {
    candidateDigest: c.digest,
    verdict: "approve",
    reason: "Admit the exact candidate",
    authorityExercise: stored.admissionDecision!.authorityExercise,
  });
  ok(stored.admissionDecision!.authorityExercise);
  deepStrictEqual(host.calls.builds, [{ draft: undefined, resumeId: "c1" }]);
  ok(state.events.some((e) => e.kind === "human-admission-decided"));
});

// --- resumeCandidateDecisions ---

Deno.test("decisions/resumeCandidateDecisions is a no-op without continuations", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model);
  const state = stateFixture(model, [c]);
  let updates = 0;
  const host = decisionsHost(model, state, {
    update: (change) => {
      updates++;
      change(state);
      return Promise.resolve();
    },
  });
  await resumeCandidateDecisions.call(host);
  equal(updates, 0);
});

Deno.test("decisions/resumeCandidateDecisions discards a superseded contribution", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model, { stage: "proposed" });
  c.admissionContinuation = {
    modelDigest: model.version.digest,
    fingerprint: "fp",
    inputMessageId: "msg-1",
    messageStart: 0,
    priorCandidateIds: ["c1"],
  };
  const state = stateFixture(model, [c]);
  // Selected invocation differs from the candidate's own; no parked continuation.
  state.caseInvocation = {
    kind: "local",
    caseId: "other-case",
  } as unknown as SystemRuntimeState["caseInvocation"];
  state.messages = [];
  const host = decisionsHost(model, state);
  await resumeCandidateDecisions.call(host);
  equal(state.candidates[0].admissionContinuation, undefined);
});

Deno.test("decisions/resumeCandidateDecisions keeps a parked invocation for its host refresh", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model, { stage: "proposed" });
  const continuation = {
    modelDigest: model.version.digest,
    fingerprint: "fp",
    inputMessageId: "msg-1",
    messageStart: 0,
    priorCandidateIds: ["c1"],
  };
  c.admissionContinuation = structuredClone(continuation);
  const state = stateFixture(model, [c]);
  state.caseInvocation = {
    kind: "local",
    caseId: "other-case",
  } as unknown as SystemRuntimeState["caseInvocation"];
  state.messages = [];
  const { invocationKey } = await import("../operators/journal.ts");
  const key = invocationKey({ kind: "local", caseId: "case-1" });
  state.invocationContinuations = {
    [key]: { invocation: { kind: "local", caseId: "case-1" } },
  } as unknown as SystemRuntimeState["invocationContinuations"];
  const host = decisionsHost(model, state);
  await resumeCandidateDecisions.call(host);
  deepStrictEqual(state.candidates[0].admissionContinuation, continuation);
});

Deno.test("decisions/resumeCandidateDecisions skips a blocked budget without discarding", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model);
  const continuation = {
    modelDigest: model.version.digest,
    fingerprint: "fp",
    inputMessageId: "msg-1",
    messageStart: 0,
    priorCandidateIds: ["c1"],
  };
  c.admissionContinuation = structuredClone(continuation);
  const state = stateFixture(model, [c]);
  state.messages = [{
    id: "msg-1",
    role: "user",
    text: "Build the reader",
    at: AT,
    caseId: "case-1",
  }] as unknown as SystemRuntimeState["messages"];
  state.budgetSuspension = {
    reason: "waiting",
  } as unknown as SystemRuntimeState["budgetSuspension"];
  const host = decisionsHost(model, state);
  await resumeCandidateDecisions.call(host);
  deepStrictEqual(state.candidates[0].admissionContinuation, continuation);
});

Deno.test("decisions/resumeCandidateDecisions drops a continuation with no promotable outcome", async () => {
  const model = modelFixture();
  const c = await awaitingCandidate(model, { stage: "proposed" });
  // Keep the digest exact so the contribution owns its input.
  c.admissionContinuation = {
    modelDigest: model.version.digest,
    fingerprint: "fp",
    inputMessageId: "msg-1",
    messageStart: 0,
    priorCandidateIds: ["c1"],
  };
  const state = stateFixture(model, [c]);
  state.messages = [{
    id: "msg-1",
    role: "user",
    text: "Build the reader",
    at: AT,
    caseId: "case-1",
  }] as unknown as SystemRuntimeState["messages"];
  const host = decisionsHost(model, state, {
    continuationFingerprint: () => Promise.resolve("other-fingerprint"),
  });
  await resumeCandidateDecisions.call(host);
  equal(state.candidates[0].admissionContinuation, undefined);
});
