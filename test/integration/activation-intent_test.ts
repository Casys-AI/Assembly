import { ACCEPTED_CASE_CLOSURE } from "../support/case-closure.ts";
import { unexpectedModelAuthoring } from "../support/model-authoring.ts";
import { isOpenCase } from "../../src/domain/work/entities/cases.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import type { ModelPort } from "../../src/application/work/runtime/ports.ts";
import {
  CandidateActivationError,
  MAX_ACTIVATION_ATTEMPTS,
} from "../../src/domain/work/policies/candidate-activation.ts";
import { ChangePublicationError } from "../../src/domain/model/publication/change.ts";
import { HostEditError } from "../../src/domain/model/editing/host-edit.ts";
import { ToolNameError } from "../../src/domain/work/value-objects/tool-name.ts";
import type {
  Candidate,
  ModelBinding,
} from "../../src/domain/work/records/candidates.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";
import { compileNativeFixtureFlows } from "../support/execution-fixture.ts";
import { SystemRuntime } from "../support/system-runtime.ts";
import { createTestNativeExecution } from "../support/native-execution.ts";
import { artifactModel } from "../support/tool-artifact-fixture.ts";

const publicationContext = { changeId: "change", systemId: "system" };
const transient = () =>
  new ChangePublicationError(
    "PUBLICATION_FAILED",
    publicationContext,
    "Toolkit worker unavailable",
  );

/** A reviewer-admitted candidate whose native publication is scripted. */
function fixture(proposedName = "reader") {
  const model = artifactModel("builder");
  model.identity.reviewerId = "reviewer-native";
  model.configuration.reviewer = {
    id: "reviewer",
    name: "Reviewer",
    mandateRevision: 1,
  };
  model.configuration.builder.admissionAuthority = "reviewer";
  model.flows = compileNativeFixtureFlows(128, "reviewer-native");
  let saved: SystemRuntimeState | null = null;
  let proposals = 0;
  let reviewCalls = 0;
  let behavior: (candidate: Candidate) => void = () => {};
  let unreadable = false;
  let hold: { entered: () => void; released: Promise<void> } | undefined;
  const calls: Array<{ id: string; digest: string }> = [];
  const tests: unknown[] = [];
  const forbidden = () => {
    throw new Error("Unexpected effect");
  };
  /** Idempotent native insertion, like the real writer. */
  const publish = (candidate: Candidate): ModelBinding => {
    const binding = {
      elementId: `native-${candidate.id}`,
      graphPath: "fixture",
    };
    if (!model.catalog.some((entry) => entry.nativeId === binding.elementId)) {
      model.catalog.push({
        nativeId: binding.elementId,
        candidateId: candidate.id,
        contractId: model.contracts[0]!.nativeId,
        name: candidate.name,
        kind: candidate.kind,
        digest: candidate.digest,
        status: "active",
      });
    }
    return binding;
  };
  const native: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: () =>
      unreadable
        ? Promise.reject(new Error("Toolkit down"))
        : Promise.resolve(structuredClone(model)),
    applyApprovedChange: forbidden,
    activateCandidate: async (_identity, candidate, admittedModelDigest) => {
      calls.push({ id: candidate.id, digest: admittedModelDigest });
      behavior(candidate);
      const held = hold;
      hold = undefined;
      if (held) {
        held.entered();
        await held.released;
      }
      return publish(candidate);
    },
    graph: () => Promise.resolve({}),
  };
  // Reopening retains the real worker queue, native ledger and checkpoints.
  const retained = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(saved)),
    save: (next, expected) => {
      equal(saved?.revision ?? null, expected);
      saved = structuredClone(next);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  const create = () => {
    const runtime = new SystemRuntime({
      model: native,
      store: retained.store,
      execution: retained.execution,
      dispatch: retained.dispatch,
      stateHistory: retained.stateHistory,
      artifactSources: retained.artifactSources,
      agents: {
        label: "test",
        decide: () =>
          Promise.resolve<ChatDecision>(
            ++proposals === 1
              ? {
                kind: "propose_tool",
                text: "Prepare",
                tool: {
                  name: proposedName,
                  description: "Reader",
                  kind: "read_web_page",
                  code: "export default ({html}) => ({title:'Page',text:html})",
                },
              }
              : { kind: "reply", text: "ok" },
          ),
        review: (candidate) => {
          reviewCalls++;
          return Promise.resolve({
            candidateDigest: candidate.digest,
            verdict: "approve",
            reason: "reviewed",
          });
        },
      },
      runner: {
        run: forbidden,
        test: (draft) => {
          tests.push(draft);
          return Promise.resolve({ passed: true, checks: [] });
        },
      },
    });
    const initialize = runtime.initialize.bind(runtime);
    const controlIdle = runtime.idle.bind(runtime);
    runtime.initialize = async (...args) => {
      await initialize(...args);
      retained.bind(runtime);
      runtime.idle = async () => {
        await controlIdle();
        await retained.idle();
        await controlIdle();
      };
    };
    return runtime;
  };
  return {
    create,
    model,
    calls,
    tests,
    retained,
    get reviewCalls() {
      return reviewCalls;
    },
    publish,
    script: (next: (candidate: Candidate) => void) => {
      behavior = next;
    },
    setUnreadable: (value: boolean) => {
      unreadable = value;
    },
    /** The next publication stops inside the port until `release` is called. */
    holdNextPublication: () => {
      let release!: () => void;
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => entered = resolve);
      hold = {
        entered,
        released: new Promise<void>((resolve) => release = resolve),
      };
      return { inside, release };
    },
    saved: () => saved!,
  };
}

async function proposeReader(
  f: ReturnType<typeof fixture>,
  workerFailure?: RegExp,
): Promise<{ runtime: SystemRuntime; caseId: string }> {
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submit("Prepare a reader", undefined, undefined, true);
  if (workerFailure) await rejects(() => runtime.idle(), workerFailure);
  else await runtime.idle();
  return { runtime, caseId: runtime.cases.cases[0]!.id };
}

Deno.test("an unknown activation keeps its exact intent and never republishes on the next contribution", async () => {
  const f = fixture();
  f.script(() => {
    throw transient();
  });
  const { runtime, caseId } = await proposeReader(
    f,
    /Toolkit worker unavailable/,
  );
  const interrupted = runtime.snapshot.candidates[0]!;
  equal(interrupted.stage, "activating");
  equal(interrupted.activationAttempts, 1);
  equal(interrupted.activationModelDigest, f.model.version.digest);
  equal(interrupted.admission?.candidateId, interrupted.id);
  equal(interrupted.admission?.candidateDigest, interrupted.digest);
  equal(interrupted.admission?.authority, "reviewer");
  equal(interrupted.caseId, caseId);
  equal(interrupted.tests?.passed, true);
  const unknown = (await f.retained.execution.inspect("builder"))
    .find((snapshot) =>
      snapshot.identity.purpose === "promotion" &&
      snapshot.identity.subjectId === interrupted.promotionExecution?.subjectId
    )!;
  equal(unknown.status, "uncertain");
  ok(unknown.unsettledEffects.length);
  const frames = await f.retained.checkpoints();
  await runtime.submit("continue", undefined, caseId);
  await runtime.idle();
  ok(
    runtime.snapshot.messages.some((message) =>
      message.role === "assistant" && message.text === "ok"
    ),
  );
  deepStrictEqual(
    (await f.retained.execution.inspect("builder")).find((snapshot) =>
      snapshot.threadId === unknown.threadId
    ),
    unknown,
  );
  const kept = runtime.snapshot.candidates[0]!;
  equal(kept.stage, "activating");
  equal(kept.activationAttempts, 1);
  deepStrictEqual(kept.admission, interrupted.admission);
  equal(kept.activationModelDigest, interrupted.activationModelDigest);
  equal(f.calls.length, 1);
  equal(f.model.catalog.length, 0);
  equal(runtime.snapshot.catalogRevision, 0);
  equal(f.tests.length, 1);
  deepStrictEqual(
    (await f.retained.checkpoints()).find((frame) =>
      frame.threadId === unknown.threadId
    ),
    frames.find((frame) => frame.threadId === unknown.threadId),
  );
  deepStrictEqual(f.saved(), runtime.snapshot);
});

Deno.test("closing done and restarting preserves an unknown publication without another charge", async () => {
  const f = fixture();
  f.script(() => {
    throw transient();
  });
  const { runtime, caseId } = await proposeReader(
    f,
    /Toolkit worker unavailable/,
  );
  const admitted = runtime.snapshot.candidates[0]!;
  await runtime.closeCase(caseId, "done", ACCEPTED_CASE_CLOSURE);
  equal(runtime.cases.cases[0]!.status, "closed-done");
  f.script(() => {});
  const restarted = f.create();
  await restarted.initialize();
  equal(restarted.snapshot.candidates[0]!.stage, "activating");
  equal(restarted.snapshot.candidates[0]!.activationAttempts, 1);
  deepStrictEqual(
    restarted.snapshot.candidates[0]!.admission,
    admitted.admission,
  );
  equal(f.calls.length, 1);
  equal(f.model.catalog.length, 0);
  equal(restarted.snapshot.catalogRevision, 0);
});

Deno.test("abandon cannot infer that an unknown publication had no effect", async () => {
  const f = fixture();
  f.script(() => {
    throw transient();
  });
  const { runtime, caseId } = await proposeReader(
    f,
    /Toolkit worker unavailable/,
  );
  const beforeAbandon = runtime.cases.cases[0]!;
  ok(isOpenCase(beforeAbandon));
  await rejects(() => runtime.closeCase(caseId, "abandoned"), /unresolved/);
  equal(runtime.cases.cases[0]!.status, beforeAbandon.status);
  ok(isOpenCase(runtime.cases.cases[0]!));
  equal(runtime.cases.cases[0]!.closedAt, undefined);
  equal(runtime.snapshot.candidates[0]!.stage, "activating");
  equal(runtime.snapshot.candidates[0]!.activationAttempts, 1);
  equal(f.calls.length, 1);
  equal(f.model.catalog.length, 0);
});

Deno.test("abandon adopts an exact native publication through reads alone and preserves its unknown receipt", async () => {
  const f = fixture();
  f.script((candidate) => {
    f.publish(candidate);
    throw transient();
  });
  const { runtime, caseId } = await proposeReader(
    f,
    /Toolkit worker unavailable/,
  );
  const candidate = runtime.snapshot.candidates[0]!;
  const frames = await f.retained.checkpoints();
  await runtime.closeCase(caseId, "abandoned");
  const adopted = runtime.snapshot.candidates[0]!;
  equal(adopted.stage, "active");
  equal(adopted.activationModelDigest, undefined);
  deepStrictEqual(adopted.admission, candidate.admission);
  equal(adopted.binding?.elementId, `native-${candidate.id}`);
  equal(runtime.snapshot.catalogRevision, 1);
  equal(
    f.calls.length,
    1,
    "read-only reconciliation never invokes the publisher",
  );
  equal(f.model.catalog.length, 1);
  deepStrictEqual(await f.retained.checkpoints(), frames);
  const restarted = f.create();
  await restarted.initialize();
  equal(restarted.snapshot.candidates[0]!.stage, "active");
  equal(f.calls.length, 1);
  equal(f.tests.length, 1);
});

Deno.test("an unreadable native catalog preserves unknown intent and the publication budget", async () => {
  const f = fixture();
  f.script(() => {
    throw transient();
  });
  const { runtime, caseId } = await proposeReader(
    f,
    /Toolkit worker unavailable/,
  );
  const beforeAbandon = runtime.cases.cases[0]!;
  ok(isOpenCase(beforeAbandon));
  f.setUnreadable(true);
  await rejects(() => runtime.closeCase(caseId, "abandoned"), /Toolkit down/);
  equal(runtime.cases.cases[0]!.status, beforeAbandon.status);
  equal(runtime.cases.cases[0]!.closedAt, undefined);
  for (let restart = 0; restart <= MAX_ACTIVATION_ATTEMPTS; restart++) {
    const reopened = f.create();
    await reopened.initialize();
    equal(reopened.snapshot.candidates[0]!.stage, "activating");
    equal(reopened.snapshot.candidates[0]!.activationAttempts, 1);
  }
  f.setUnreadable(false);
  const healthy = f.create();
  await healthy.initialize();
  equal(healthy.snapshot.candidates[0]!.stage, "activating");
  equal(healthy.snapshot.candidates[0]!.activationAttempts, 1);
  equal(f.calls.length, 1);
  equal(f.model.catalog.length, 0);
});

Deno.test("unknown publication never exhausts its attempt budget merely by restarting", async () => {
  const f = fixture();
  f.script(() => {
    throw transient();
  });
  const { runtime } = await proposeReader(f, /Toolkit worker unavailable/);
  const admitted = runtime.snapshot.candidates[0]!;
  const executions = await f.retained.execution.inspect("builder");
  for (let restart = 0; restart <= MAX_ACTIVATION_ATTEMPTS; restart++) {
    const reopened = f.create();
    await reopened.initialize();
    const kept = reopened.snapshot.candidates[0]!;
    equal(kept.stage, "activating");
    equal(kept.errorCode, undefined);
    equal(kept.activationAttempts, 1);
    deepStrictEqual(kept.admission, admitted.admission);
  }
  equal(f.calls.length, 1);
  equal(f.tests.length, 1);
  deepStrictEqual(await f.retained.execution.inspect("builder"), executions);
});

Deno.test("a model adoption cannot replace the contract of an unknown native publication", async () => {
  const f = fixture();
  f.script(() => {
    throw transient();
  });
  const { runtime } = await proposeReader(f, /Toolkit worker unavailable/);
  const admitted = runtime.snapshot.candidates[0]!;
  f.model.version.digest = "digest-v2";
  await rejects(
    () => runtime.adoptModelVersion({ expectedDigest: "digest-v2" }),
    { code: "EVOLUTION_BOUNDARY_UNSAFE" },
  );
  equal(runtime.snapshot.candidates[0]!.stage, "activating");
  equal(
    runtime.snapshot.candidates[0]!.activationModelDigest,
    admitted.activationModelDigest,
  );
  deepStrictEqual(
    runtime.snapshot.candidates[0]!.admission,
    admitted.admission,
  );
  equal(f.calls.length, 1);
  equal(f.model.catalog.length, 0);
});

Deno.test("the first admitted native publication remains allowed while its own effect is running", async () => {
  const f = fixture();
  const held = f.holdNextPublication();
  const runtime = f.create();
  await runtime.initialize();
  await runtime.submit("Prepare a reader", undefined, undefined, true);
  await held.inside;
  const candidate = runtime.snapshot.candidates[0]!;
  equal(candidate.stage, "activating");
  equal(candidate.activationAttempts, 1);
  equal(f.calls.length, 1);
  equal(f.model.catalog.length, 0);
  try {
    await rejects(() => runtime.closeCase(candidate.caseId!, "abandoned"), {
      code: "CASE_BUSY",
    });
  } finally {
    held.release();
  }
  await runtime.idle();
  const active = runtime.snapshot.candidates[0]!;
  equal(active.stage, "active");
  equal(active.binding?.elementId, `native-${active.id}`);
  equal(active.admission?.authority, "reviewer");
  equal(runtime.snapshot.catalogRevision, 1);
  equal(f.model.catalog.length, 1);
  equal(f.calls.length, 1);
  equal(f.tests.length, 1);
});

Deno.test("terminal refusals after the intent fail the candidate with their code", async () => {
  const refusals: Array<[string, () => Error]> = [
    ["PUBLICATION_NOT_APPLICABLE", () =>
      new ChangePublicationError(
        "PUBLICATION_NOT_APPLICABLE",
        publicationContext,
        "Toolkit edit preview refused",
      )],
    ["PUBLICATION_RECEIPT_TOO_LARGE", () =>
      new ChangePublicationError(
        "PUBLICATION_RECEIPT_TOO_LARGE",
        publicationContext,
        "Approval receipt exceeds the trailer size limit",
      )],
    ["TOOLKIT_REFUSED", () =>
      new HostEditError("TOOLKIT_REFUSED", {
        opIndex: 0,
        op: "insertMember",
        target: { qualifiedName: "System::catalog" },
      }, "The member was refused")],
    ["CANDIDATE_AMBIGUOUS", () =>
      new CandidateActivationError(
        "CANDIDATE_AMBIGUOUS",
        { candidateId: "c" },
        "Ambiguous candidate identity",
      )],
    ["ADMITTED_MODEL_CHANGED", () =>
      new CandidateActivationError(
        "ADMITTED_MODEL_CHANGED",
        { candidateId: "c" },
        "The model changed after the candidate was admitted",
      )],
  ];
  for (const [code, error] of refusals) {
    const f = fixture();
    f.script(() => {
      throw error();
    });
    const { runtime, caseId } = await proposeReader(f);
    const failed = runtime.snapshot.candidates[0]!;
    equal(failed.stage, "failed", code);
    equal(failed.errorCode, code);
    equal(failed.activationModelDigest, undefined);
    equal(failed.activationAttempts, undefined);
    equal(failed.promotionCursor, undefined);
    ok(failed.error);
    equal(f.calls.length, 1, "a terminal refusal is never retried");
    equal(f.model.catalog.length, 0);
    equal(runtime.snapshot.catalogRevision, 0);
    equal(
      runtime.snapshot.events.filter((event) =>
        event.kind === "tool-failed" && event.code === code
      ).length,
      1,
      "the terminal failure is announced once",
    );
    // The Case closes normally and the next start is not blocked.
    await runtime.closeCase(caseId, "done", ACCEPTED_CASE_CLOSURE);
    const restarted = f.create();
    await restarted.initialize();
    equal(restarted.snapshot.candidates[0]!.stage, "failed");
    equal(f.calls.length, 1);
  }
});

Deno.test("a terminal refusal after the effect was published is reconciled", async () => {
  const f = fixture();
  f.script((candidate) => {
    f.publish(candidate);
    throw new ChangePublicationError(
      "PUBLICATION_NOT_APPLICABLE",
      publicationContext,
      "Readback refused after the commit",
    );
  });
  const { runtime } = await proposeReader(f);
  const active = runtime.snapshot.candidates[0]!;
  equal(active.stage, "active");
  equal(active.errorCode, undefined);
  equal(active.binding?.elementId, `native-${active.id}`);
  equal(runtime.snapshot.catalogRevision, 1);
  equal(f.calls.length, 1);
});

Deno.test("a tool name the literal writer cannot spell is refused before tests and review", async () => {
  for (
    const [name, problem] of [
      ["lone\ud800surrogate", "LONE_SURROGATE"],
      ["separator ", "LINE_SEPARATOR"],
      ["nul\u0000", "CONTROL_CHARACTER"],
    ] as const
  ) {
    const f = fixture(name);
    const runtime = f.create();
    await runtime.initialize();
    await runtime.submit("Prepare a reader", undefined, undefined, true);
    await rejects(() => runtime.idle(), (error) => {
      ok(error instanceof ToolNameError);
      equal(error.code, "TOOL_NAME_INVALID");
      equal(error.recovery, "refuse");
      equal(error.context.problem, problem);
      return true;
    });
    const state = runtime.snapshot;
    equal(state.candidates.length, 0, JSON.stringify(name));
    equal(f.tests.length, 0, "no test is spent on an unpublishable name");
    equal(f.reviewCalls, 0);
    equal(f.calls.length, 0);
    ok(state.error?.includes("TOOL_NAME_INVALID"), state.error);
    ok(
      state.events.some((event) =>
        event.kind === "turn-failed" && event.label.includes("TOOL_NAME")
      ),
    );
  }
});

/** Two initial tools selected by the model, activated by the reviewer. */
function withInitialTools(f: ReturnType<typeof fixture>) {
  f.model.version.repositoryVersion = "branch:initial-selection";
  f.model.initialTools = ["first", "second"].map((name) => ({
    id: `${name}-v1`,
    nativeId: `native-${name}-selection`,
    sourceIds: ["a", "b"],
    draft: {
      name: `selected-${name}`,
      description: "seed",
      kind: "read_web_page",
      code: "export default ({html}) => ({title:'Page',text:html})",
    },
  }));
}

Deno.test("an unknown initial publication retains the same preparation Case, command and native effect", async () => {
  const f = fixture();
  withInitialTools(f);
  f.script(() => {
    throw transient();
  });
  const runtime = f.create();
  await runtime.initialize();
  await runtime.prepareInitialTools();
  await rejects(() => runtime.idle(), /Toolkit worker unavailable/);
  const admitted = runtime.snapshot.candidates[0]!;
  const intent = Object.values(runtime.snapshot.initialToolsPreparations!)[0];
  equal(admitted.stage, "activating");
  equal(admitted.activationAttempts, 1);
  equal(admitted.caseId, intent.caseId);
  equal(admitted.admission?.candidateId, admitted.id);
  equal(admitted.tests?.passed, true);
  equal(intent.phase, "pending");
  const initial = runtime.cases.cases[0]!;
  ok(isOpenCase(initial));
  equal(initial.closedAt, undefined);
  const accepted = await f.retained.dispatch.inspectAccepted!(
    "builder",
    intent.key,
  );
  ok(accepted);
  equal(accepted.receipt.status, "failed");
  const frames = await f.retained.checkpoints();
  const executions = await f.retained.execution.inspect("builder");
  ok(
    executions.some((execution) =>
      execution.status === "uncertain" && execution.unsettledEffects.length
    ),
  );
  f.script(() => {});
  const reopened = f.create();
  await reopened.initialize();
  await reopened.prepareInitialTools();
  await reopened.idle();
  deepStrictEqual(
    reopened.snapshot.initialToolsPreparations![intent.key],
    intent,
  );
  equal(reopened.cases.cases.length, 1);
  equal(reopened.cases.cases[0]!.status, initial.status);
  ok(isOpenCase(reopened.cases.cases[0]!));
  equal(reopened.cases.cases[0]!.closedAt, undefined);
  equal(
    reopened.snapshot.candidates.length,
    1,
    "the following selection cannot bypass the unresolved seed",
  );
  deepStrictEqual(
    reopened.snapshot.candidates[0]!.admission,
    admitted.admission,
  );
  equal(reopened.snapshot.candidates[0]!.activationAttempts, 1);
  equal(f.calls.length, 1);
  equal(f.tests.length, 1);
  equal(f.model.catalog.length, 0);
  equal(reopened.snapshot.catalogRevision, 0);
  deepStrictEqual(
    await f.retained.dispatch.inspectAccepted!("builder", intent.key),
    accepted,
  );
  deepStrictEqual(await f.retained.checkpoints(), frames);
  deepStrictEqual(await f.retained.execution.inspect("builder"), executions);
});

Deno.test("a refused publication of an initial tool is recorded on the seed, not thrown", async () => {
  const f = fixture();
  withInitialTools(f);
  f.script(() => {
    throw new ChangePublicationError(
      "PUBLICATION_NOT_APPLICABLE",
      publicationContext,
      "Toolkit edit preview refused",
    );
  });
  const runtime = f.create();
  await runtime.initialize();
  await runtime.prepareInitialTools();
  await runtime.idle();
  // A refusal is terminal and recorded on each seed; nothing is left to retry.
  for (const seed of runtime.snapshot.candidates) {
    equal(seed.stage, "failed", seed.name);
    equal(seed.errorCode, "PUBLICATION_NOT_APPLICABLE", seed.name);
    equal(seed.activationModelDigest, undefined, seed.name);
  }
  equal(runtime.snapshot.candidates.length, 2);
  equal(f.calls.length, 2);
});
