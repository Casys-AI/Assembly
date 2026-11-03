import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { MemorySourceRepository } from "../support/memory-source-repository.ts";
import { applyApprovedSourceChange } from "../support/approved-source-change.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import {
  deepStrictEqual,
  equal,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { SystemRuntime } from "../support/system-runtime.ts";
import type {
  AgentPort,
  StorePort,
  ToolRunnerPort,
} from "../../src/application/work/runtime/ports.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { SourceModel } from "../../src/adapters/model/sources/source-model.ts";
import type {
  AdmissionContext,
  Candidate,
  ReviewContext,
  ReviewDecision,
  TestReport,
  ToolDraft,
} from "../../src/domain/work/candidates.ts";
import type {
  ChatContext,
  ChatDecision,
  SystemRuntimeState,
} from "../../src/domain/work/dialogue.ts";
import type {
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const report: TestReport = {
  passed: true,
  checks: [{ name: "extract", passed: true, detail: "Exact tool passed" }],
};
const draft: ToolDraft = {
  name: "Native reviewed reader",
  description: "Extract page content",
  kind: "read_web_page",
  code: "export default ({html}) => ({title:'Page',text:html})",
};

/** The admitted conversation consults its declared source before each move;
 * without this port it takes the refusal edge to await_input and never calls
 * the builder. Serve that exact read from the admitted pin of the memory
 * repository, whose versions the Git-pinned production reader refuses. */
function admittedSourceReads(
  repository: MemorySourceRepository,
): DecisionInformationPort {
  return {
    read: () => Promise.resolve({ memoryGuidance: [] }),
    async consultAdmittedModelSource(model, input) {
      const version = model.version.repositoryVersion!;
      equal(input.operation, "read_source");
      equal(input.version, version);
      const content = (await repository.at(version)).sources[
        input.path as string
      ];
      ok(content, `Declared source ${input.path} is absent at ${version}`);
      return {
        modelVersion: {
          digest: model.version.digest,
          repositoryVersion: version,
        },
        result: {
          operation: "read_source",
          version,
          path: input.path,
          content,
        },
      };
    },
  };
}

/** The real compiler publishes immutable revisions without any live database. */

class MemoryStore implements StorePort {
  value: SystemRuntimeState | null = null;
  load() {
    return Promise.resolve(structuredClone(this.value));
  }
  save(state: SystemRuntimeState, expected: number | null) {
    equal(this.value?.revision ?? null, expected);
    this.value = structuredClone(state);
    return Promise.resolve();
  }
  close() {
    return Promise.resolve();
  }
}
class RecordingAgent implements AgentPort {
  label = "Isolated native review integration";
  contexts: ChatContext[] = [];
  reviews: Array<
    { candidate: Candidate; tests: TestReport; context?: ReviewContext }
  > = [];
  admissions: AdmissionContext[] = [];
  constructor(
    readonly verdict: ReviewDecision["verdict"],
    readonly reason: string,
  ) {}
  decide(context: ChatContext): Promise<ChatDecision> {
    this.contexts.push(structuredClone(context));
    equal(
      this.contexts.length <= 2,
      true,
      "Promotion must return to the same builder turn",
    );
    return Promise.resolve(
      this.contexts.length === 1
        ? { kind: "propose_tool", text: "Build the reader", tool: draft }
        : { kind: "reply", text: "Promotion outcome received" },
    );
  }
  review(candidate: Candidate, tests: TestReport, context?: ReviewContext) {
    this.reviews.push(structuredClone({ candidate, tests, context }));
    return Promise.resolve({
      candidateDigest: candidate.digest,
      verdict: this.verdict,
      reason: this.reason,
    });
  }
  admit(
    _candidate: Candidate,
    _tests: TestReport,
    context: AdmissionContext,
  ): Promise<ReviewDecision> {
    this.admissions.push(context);
    return Promise.reject(
      new Error("Reviewer admission must consume the native review output"),
    );
  }
}

for (const verdict of ["approve", "refuse"] as const) {
  Deno.test({
    name:
      `real source reviewer ${verdict}: native review feeds admission and builder feedback in one session`,
    ignore: !toolkitIntegrationEnabled,
    fn: async () => {
      const repository = new MemorySourceRepository(
        new ToolkitCompiler({ packageDir: packageDir! }),
      );
      const model = new SourceModel({
        tooling: new SysmlToolkitAdapter({ packageDir: packageDir! }),
        repository,
        projectId: "git:00000000-0000-4000-8000-000000000001",
        initialSources: await loadInitialSources(undefined, {
          information: false,
        }),
      });
      const agent = new RecordingAgent(
        verdict,
        `Independent exact candidate ${verdict}`,
      );
      const tests: ToolDraft[] = [];
      const runner: ToolRunnerPort = {
        test(tool) {
          tests.push(structuredClone(tool));
          return Promise.resolve(structuredClone(report));
        },
        run() {
          throw new Error("This integration never requests invocation");
        },
      };
      const store = new MemoryStore();
      const service = new SystemRuntime({
        model,
        agents: agent,
        runner,
        store,
        information: admittedSourceReads(repository),
      });
      await service.initialize();
      const sessionId = service.snapshot.id;
      const initial = await model.readExecutableModel(service.snapshot.model!);
      const change: PendingChange = {
        id: `create-reviewer-${verdict}`,
        kind: "reviewer-creation",
        status: "approved",
        baseRevision: initial.configuration.revision,
        baseModelDigest: initial.version.digest,
        authorityExercise: exerciseOwnerAuthority(initial, "mandate-change"),
        reason: "Exact independent reviewer approval",
        requestedAt: "2026-10-21T00:00:00Z",
        decidedAt: "2026-10-21T00:01:00Z",
        authority: "human",
        role: "reviewer",
        name: "Native reviewer",
        mandate: {
          mayReviewExactCandidate: true,
          mayAdmitReviewedCandidates: true,
        },
      };
      const reviewed = await applyApprovedSourceChange(
        model,
        initial.identity,
        change,
        initial.version.digest,
      );
      await service.adoptModelVersion({
        expectedDigest: reviewed.version.digest,
      });
      equal(
        service.snapshot.configuration!.builder.admissionAuthority,
        "reviewer",
      );
      const flow = service.snapshot.executionModel!.flows.promotion;
      const reviewNode = flow.nodes.find((node) =>
        node.mechanism === "review_candidate"
      );
      const admitNode = flow.nodes.find((node) =>
        node.mechanism === "decide_admission"
      );
      const activateNode = flow.nodes.find((node) =>
        node.mechanism === "activate_candidate"
      );
      ok(reviewNode);
      ok(admitNode);
      ok(activateNode);
      notEqual(reviewNode.nativeId, admitNode.nativeId);
      equal(reviewNode.performerId, reviewed.identity.reviewerId);

      await service.submit("Construis un lecteur pour https://example.org/");
      await service.idle();
      const state = service.snapshot;
      equal(state.id, sessionId);
      equal(state.busy, false);
      equal(state.error, undefined);
      equal(agent.contexts.length, 2);
      equal(agent.reviews.length, 1, JSON.stringify(state.candidates));
      equal(agent.admissions.length, 0);
      equal(tests.length, 1);
      const candidate = state.candidates[0]!;
      equal(candidate.digest, agent.reviews[0]!.candidate.digest);
      deepStrictEqual(agent.reviews[0]!.tests, report);
      equal(
        agent.reviews[0]!.context!.reviewerId,
        reviewed.configuration.reviewer!.id,
      );
      equal(
        agent.reviews[0]!.context!.modelVersion!.digest,
        reviewed.version.digest,
      );
      const native = await model.readExecutableModel(state.model!);
      // Only an admitted activation reaches the native catalog: a refusal
      // leaves no entry and no binding, only its runtime state.
      const entry = verdict === "approve"
        ? native.catalog.find((entry) =>
          entry.nativeId === candidate.binding!.elementId
        )!
        : undefined;
      const exactContract = verdict === "approve"
        ? native.contracts.find((contract) =>
          contract.nativeId === entry!.contractId
        )!
        : native.contracts.find((contract) =>
          contract.kind === candidate.kind
        )!;
      ok(exactContract);
      deepStrictEqual(agent.reviews[0]!.context!.contract, exactContract);
      deepStrictEqual(candidate.review, {
        candidateDigest: candidate.digest,
        verdict,
        reason: agent.reason,
      });
      equal(candidate.reviewExecution!.actionId, reviewNode.nativeId);
      const reviewEvent = state.events.filter((event) =>
        event.kind === "review-decided"
      );
      equal(reviewEvent.length, 1);
      equal(reviewEvent[0]!.execution!.actionId, reviewNode.nativeId);
      equal(reviewEvent[0]!.execution!.digest, reviewed.version.digest);
      const actions = state.events.filter((event) =>
        event.kind === "flow-action"
      ).map((event) => event.execution!.actionId);
      const admissionEvents = state.events.filter((event) =>
        event.kind === "admission-decided"
      );
      const feedback = agent.contexts[1]!;
      equal(
        feedback.candidates[0]!.stage,
        verdict === "approve" ? "active" : "refused",
      );
      ok(
        feedback.messages.some((message) =>
          message.role === "tool" && message.text.includes(agent.reason)
        ),
      );
      if (verdict === "approve") {
        equal(candidate.stage, "active");
        equal(entry!.status, "active");
        equal(state.catalogRevision, 1);
        equal(candidate.admission!.authority, "reviewer");
        equal(
          candidate.admission!.actorId,
          reviewed.configuration.reviewer!.id,
        );
        equal(candidate.admission!.candidateDigest, candidate.digest);
        equal(admissionEvents.length, 1);
        equal(admissionEvents[0]!.execution!.actionId, admitNode.nativeId);
        equal(admissionEvents[0]!.execution!.digest, reviewed.version.digest);
        ok(
          actions.indexOf(reviewNode.nativeId) <
            actions.indexOf(admitNode.nativeId),
        );
        ok(
          actions.indexOf(admitNode.nativeId) <
            actions.indexOf(activateNode.nativeId),
        );
        equal(feedback.activeTools[0]!.id, candidate.id);
      } else {
        equal(candidate.stage, "refused");
        equal(entry, undefined);
        equal(native.catalog.length, 0);
        equal(candidate.binding, undefined);
        equal(candidate.admission, undefined);
        equal(state.catalogRevision, 0);
        equal(admissionEvents.length, 0);
        equal(actions.includes(admitNode.nativeId), false);
        equal(actions.includes(activateNode.nativeId), false);
        equal(feedback.activeTools.length, 0);
      }
      deepStrictEqual(await store.load(), state);
    },
  });
}

Deno.test({
  name:
    "real source reviewer creation leaves repository untouched while human promotion is suspended",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const repository = new MemorySourceRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const model = new SourceModel({
      tooling: new SysmlToolkitAdapter({
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      }),
      repository,
      projectId: "git:78c10bd6-af31-5b2f-b614-02e4dd928aff",
      initialSources: await loadInitialSources(undefined, {
        information: false,
      }),
    });
    const steps: ChatDecision[] = [
      { kind: "propose_tool", text: "Build a reader", tool: draft },
      {
        kind: "propose_agent_creation",
        text: "Propose an independent reviewer",
        name: "Reviewer after human admission",
        role: "reviewer",
        reason: "Independent future admissions",
        mandate: {
          mayReviewExactCandidate: true,
          mayAdmitReviewedCandidates: true,
        },
      },
      { kind: "reply", text: "Human admission outcome received" },
    ];
    const contexts: ChatContext[] = [];
    const agents: AgentPort = {
      label: "Suspended native promotion test",
      decide(context) {
        contexts.push(structuredClone(context));
        const next = steps.shift();
        ok(next, "Unexpected additional builder decision");
        return Promise.resolve(next);
      },
      review() {
        throw new Error("Human promotion cannot request a review");
      },
      admit() {
        throw new Error("Human admission cannot delegate to the builder");
      },
    };
    const service = new SystemRuntime({
      model,
      agents,
      store: new MemoryStore(),
      information: admittedSourceReads(repository),
      runner: {
        test() {
          return Promise.resolve(structuredClone(report));
        },
        run() {
          throw new Error("No invocation requested");
        },
      },
    });
    await service.initialize();
    await service.submit("Construis un lecteur pour https://example.org/");
    await service.idle();
    const candidate = service.snapshot.candidates[0]!;
    equal(candidate.stage, "awaiting-admission");
    // The suspended promotion is a native continuation, not a node cursor.
    ok(candidate.promotionExecution);
    await service.submit("Propose la création d’un reviewer");
    await service.idle();
    const before = service.snapshot;
    const pending = before.configuration!.changes.find((change) =>
      change.status === "pending"
    )!;
    ok(pending);
    equal(pending.kind, "reviewer-creation");
    const nativeBefore = structuredClone(await repository.current());
    const revisionCountBefore = repository.versions.size;
    // The decision is accepted as a durable command; its worker refuses it
    // before publication while the native promotion waits for the human.
    await service.decideChange({
      changeId: pending.id,
      expectedRevision: before.configuration!.revision,
      verdict: "approve",
    });
    await rejects(() => service.idle(), {
      message:
        "Une promotion native suspendue doit être terminée avant cette publication ; la proposition reste en attente.",
    });
    equal(repository.versions.size, revisionCountBefore);
    deepStrictEqual(await repository.current(), nativeBefore);
    equal(
      service.snapshot.executionModel!.version.digest,
      before.executionModel!.version.digest,
    );
    equal(
      service.snapshot.configuration!.revision,
      before.configuration!.revision,
    );
    equal(
      service.snapshot.configuration!.changes.find((change) =>
        change.id === pending.id
      )!.status,
      "pending",
    );
    equal(service.snapshot.configuration!.reviewer, undefined);
    deepStrictEqual(service.snapshot.candidates[0], candidate);
    deepStrictEqual(service.snapshot.messages, before.messages);

    await service.decideCandidate({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Human admission remains possible under the original native flow",
    });
    await service.idle();
    const state = service.snapshot;
    equal(state.error, undefined);
    equal(state.candidates[0]!.stage, "active");
    equal(state.candidates[0]!.admission!.authority, "human");
    equal(state.candidates[0]!.admission!.candidateDigest, candidate.digest);
    const exercised = state.candidates[0]!.admission!.authorityExercise!;
    equal(exercised.ownerSource, "modeled");
    equal(exercised.operatorId, "owner");
    equal(
      exercised.rootGrantNativeId,
      before.executionModel!.ownerAuthority!.rootGrantNativeId,
    );
    equal(exercised.baseModelDigest, before.executionModel!.version.digest);
    equal(exercised.outOfMandate, false);
    deepStrictEqual(
      state.events.find((event) => event.kind === "human-admission-decided")!
        .authorityExercise,
      exercised,
    );
    equal(
      state.configuration!.changes.find((change) => change.id === pending.id)!
        .status,
      "pending",
    );
    equal(contexts.length, 3);
    equal(contexts[2]!.activeTools[0]!.id, candidate.id);
    // The pre-decision snapshot has no binding: it is read from the runtime state.
    equal(candidate.binding, undefined);
    const executable = await model.readExecutableModel(state.model!);
    equal(
      executable.catalog.find((entry) =>
        entry.nativeId === state.candidates[0]!.binding!.elementId
      )!.status,
      "active",
    );
    equal(executable.identity.reviewerId, undefined);
  },
});

Deno.test({
  name:
    "a reviewer admission is never published under a contract edited after the review",
  ignore: !toolkitIntegrationEnabled,
  fn: async () => {
    const repository = new MemorySourceRepository(
      new ToolkitCompiler({ packageDir: packageDir! }),
    );
    const real = new SourceModel({
      tooling: new SysmlToolkitAdapter({ packageDir: packageDir! }),
      repository,
      projectId: "git:00000000-0000-4000-8000-000000000001",
      initialSources: await loadInitialSources(undefined, {
        information: false,
      }),
    });
    // A foreign contract edit lands after the runtime's last read, right before
    // the adapter reads HEAD for the activation. A reviewer admission carries no
    // authority exercise, so only the pinned digest can refuse it.
    let editBeforeActivation = false;
    const model = new Proxy(real, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "activateCandidate") {
          return async (
            ...args: Parameters<SourceModel["activateCandidate"]>
          ) => {
            if (editBeforeActivation) {
              editBeforeActivation = false;
              await repository.updateSystemSources((revision) => ({
                ...revision.sources,
                "configuration.sysml": revision.sources["configuration.sysml"]!
                  .replace(
                    'urlSelectionMode = "user-provided"',
                    'urlSelectionMode = "authorized-host"',
                  ),
              }), "operator:edit");
            }
            return await target.activateCandidate(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SourceModel;
    const agent = new RecordingAgent("approve", "Independent exact approve");
    const store = new MemoryStore();
    const service = new SystemRuntime({
      model,
      agents: agent,
      store,
      information: admittedSourceReads(repository),
      runner: {
        test: () => Promise.resolve(structuredClone(report)),
        run() {
          throw new Error("This integration never requests invocation");
        },
      },
    });
    await service.initialize();
    const initial = await real.readExecutableModel(service.snapshot.model!);
    const reviewed = await applyApprovedSourceChange(
      real,
      initial.identity,
      {
        id: "create-reviewer-toctou",
        kind: "reviewer-creation",
        status: "approved",
        baseRevision: initial.configuration.revision,
        baseModelDigest: initial.version.digest,
        authorityExercise: exerciseOwnerAuthority(initial, "mandate-change"),
        reason: "Exact independent reviewer approval",
        requestedAt: "2026-10-21T00:00:00Z",
        decidedAt: "2026-10-21T00:01:00Z",
        authority: "human",
        role: "reviewer",
        name: "Native reviewer",
        mandate: {
          mayReviewExactCandidate: true,
          mayAdmitReviewedCandidates: true,
        },
      } satisfies PendingChange,
      initial.version.digest,
    );
    await service.adoptModelVersion({
      expectedDigest: reviewed.version.digest,
    });
    editBeforeActivation = true;
    await service.submit("Construis un lecteur pour https://example.org/");
    // The foreign edit moved HEAD off the admitted pin: after the refused
    // activation, the next native effect of the same turn is refused too.
    await rejects(() => service.idle(), { code: "NATIVE_ADMISSION_REFUSED" });

    const state = service.snapshot;
    const candidate = state.candidates[0]!;
    equal(state.error, "The current native admission refused this action");
    equal(agent.reviews.length, 1);
    equal(candidate.admission?.authority, "reviewer");
    equal(candidate.admission?.authorityExercise, undefined);
    equal(candidate.stage, "failed");
    equal(candidate.errorCode, "ADMITTED_MODEL_CHANGED");
    equal(candidate.activationModelDigest, undefined);
    equal(state.catalogRevision, 0);
    const head = await real.readExecutableModel(state.model!);
    notEqual(head.version.digest, reviewed.version.digest, "the edit landed");
    equal(head.catalog.length, 0, "nothing was published natively");
    equal(
      [...repository.publications.values()].filter((entry) =>
        entry.receipt.type === "candidate-activation"
      ).length,
      0,
      "no activation receipt claims the admitted contract",
    );
    deepStrictEqual(await store.load(), state);
  },
});
