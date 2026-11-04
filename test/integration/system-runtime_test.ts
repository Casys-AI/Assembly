import {
  emptyChangePreview,
  unexpectedModelAuthoring,
} from "../support/model-authoring.ts";
import {
  type ApprovedChangePublication,
  type ChangePublication,
  ChangePublicationError,
} from "../../src/domain/model/publication/change.ts";
import { compileModelFlow } from "../../src/domain/model/execution/flow.ts";
import { CONVERSATION, PROMOTION } from "../fixtures/native-flows.ts";
import { executableFixture } from "../support/execution-fixture.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import { TOOL_CONTRACTS } from "../../src/domain/work/records/candidates.ts";
import { TOOL_KINDS } from "../../src/domain/shared-kernel/tool-kind.ts";
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { draftDigest, SystemRuntime } from "../support/system-runtime.ts";
import { createTestNativeExecution } from "../support/native-execution.ts";
import { createMemoryArtifactSources } from "../support/memory-artifact-sources.ts";
import { resolveCandidateSource } from "../../src/application/work/artifacts/candidate-source.ts";
import {
  type AcceptedOperatorCommand,
  type OperatorControlCommand,
  parseAcceptedCommand,
  recordedCommandOutcome,
} from "../../src/application/work/operators/command-delivery.ts";
import { ToolInvocationError } from "../../src/application/work/tools/tool-invocation.ts";
import { OperatorAuthorityError } from "../../src/domain/governance/operator-authority-error.ts";
import type { OperatorExecutionDelivery } from "../../src/application/work/operators/execution.ts";
import {
  candidateCaseInvocation,
  invocationInput,
} from "../../src/application/work/operators/journal.ts";
import {
  hydrateRuntimeValues,
  nativeExecutionIdentity,
} from "../../src/application/work/native-execution/contract.ts";
import {
  emptyNativeEvolutionAwait,
  evolutionCheckpoint,
} from "../../src/application/work/runtime/evolution.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import { networkScopeFor } from "../../src/domain/governance/policies/network-policy.ts";
import type {
  AdmissionContext,
  AgentPort,
  ModelPort,
  PageResult,
  ReviewContext,
  StorePort,
  ToolRunnerPort,
} from "../../src/application/work/runtime/ports.ts";
import type {
  Candidate,
  ModelBinding,
  ReviewDecision,
  Stage,
  TestReport,
  ToolDraft,
} from "../../src/domain/work/records/candidates.ts";
import type { ChatContext } from "../../src/application/work/conversation/chat-context.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import type { SystemRuntimeState } from "../../src/application/work/runtime/state.ts";
import type { ModelIdentity } from "../../src/domain/shared-kernel/model-identity.ts";
import type {
  NetworkScope,
  SystemConfiguration,
} from "../../src/domain/governance/records/system-configuration.ts";
import type {
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";

const draft: ToolDraft = {
  name: "Page reader",
  description: "Extract a page title and text",
  kind: "read_web_page",
  code: "export default ({html}) => ({title:'Page',text:html})",
};
const identity: ModelIdentity = {
  projectId: "project",
  editingContextId: "context",
  rootId: "root",
  systemId: "system",
  catalogId: "catalog",
  builderId: "builder",
  reviewerId: "reviewer",
};
const binding: ModelBinding = {
  elementId: "element",
  graphPath: "graph",
};
const passed: TestReport = {
  passed: true,
  checks: [{ name: "extraction", passed: true, detail: "Page extracted" }],
};
const reply: ChatDecision = { kind: "reply", text: "Voici la page demandée." };
const propose: ChatDecision = {
  kind: "propose_tool",
  text: "Je propose un lecteur.",
  tool: draft,
};
const invoke = (
  toolId: string,
  url = "https://example.org/",
): ChatDecision => ({ kind: "invoke_tool", text: "", toolId, input: { url } });
type DecisionStep =
  | ChatDecision
  | ((context: ChatContext) => ChatDecision | Promise<ChatDecision>);

class MemoryStore implements StorePort {
  value: SystemRuntimeState | null;
  saves: Array<{ state: SystemRuntimeState; expected: number | null }> = [];
  constructor(initial: SystemRuntimeState | null = null) {
    this.value = structuredClone(initial);
  }
  load(): Promise<SystemRuntimeState | null> {
    return Promise.resolve(structuredClone(this.value));
  }
  save(state: SystemRuntimeState, expected: number | null): Promise<void> {
    const snapshot = structuredClone(state);
    equal(
      this.value?.revision ?? null,
      expected,
      "every write must compare the persisted revision",
    );
    equal(
      snapshot.revision,
      expected === null ? 0 : expected + 1,
      "revisions advance exactly once",
    );
    if (this.value) equal(snapshot.id, this.value.id);
    this.value = snapshot;
    this.saves.push({ state: structuredClone(snapshot), expected });
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
class FakeAgent implements AgentPort {
  readonly label = "Test-only agent";
  contexts: ChatContext[] = [];
  reviews: Array<
    { candidate: Candidate; tests: TestReport; context?: ReviewContext }
  > = [];
  admissions: Array<{ candidate: Candidate; context: AdmissionContext }> = [];
  admissionStep = (candidate: Candidate): ReviewDecision => ({
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason:
      "Builder explicitly admits the tested candidate under the revised mandate",
  });
  reviewStep = (
    candidate: Candidate,
    _tests: TestReport,
  ): ReviewDecision | Promise<ReviewDecision> => ({
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Reviewed independently",
  });
  constructor(
    public steps: DecisionStep[] = [reply],
    private trace: string[] = [],
  ) {}
  async decide(context: ChatContext): Promise<ChatDecision> {
    this.contexts.push(structuredClone(context));
    const step = this.steps.shift();
    ok(step, "unexpected additional builder decision");
    return typeof step === "function"
      ? await step(context)
      : structuredClone(step);
  }
  async review(
    candidate: Candidate,
    tests: TestReport,
    context?: ReviewContext,
  ): Promise<ReviewDecision> {
    this.trace.push("review");
    this.reviews.push(structuredClone({ candidate, tests, context }));
    return await this.reviewStep(candidate, tests);
  }
  admit(
    candidate: Candidate,
    _tests: TestReport,
    context: AdmissionContext,
  ): Promise<ReviewDecision> {
    this.trace.push("builder-admission");
    this.admissions.push(structuredClone({ candidate, context }));
    return Promise.resolve(this.admissionStep(candidate));
  }
}
class FakeModel implements ModelPort {
  proposeEdit = unexpectedModelAuthoring.proposeEdit;
  private readonly versions = new Map<string, ExecutableModel>();
  private sourceRevision = 0;
  private nextSourceVersion(): string {
    let version: string;
    do {
      version = `fake-source:${++this.sourceRevision}`;
    } while (this.versions.has(version));
    return version;
  }
  /** Direct scenario edits are a controlled working tree. Reading its head
   * commits a new immutable version; reading an old pin never reads that tree. */
  private retainHead(): ExecutableModel {
    let version = this.executable.version.repositoryVersion;
    ok(version);
    const retained = this.versions.get(version);
    if (retained && canonical(retained) !== canonical(this.executable)) {
      version = this.nextSourceVersion();
      this.executable.version.repositoryVersion = version;
    }
    if (!this.versions.has(version)) {
      this.versions.set(version, structuredClone(this.executable));
    }
    return structuredClone(this.versions.get(version)!);
  }
  async previewApprovedChange(
    modelIdentity: ModelIdentity,
    change: PendingChange,
    expectedDigest: string,
  ) {
    const base = this.retainHead();
    equal(expectedDigest, base.version.digest);
    equal(modelIdentity.systemId, base.identity.systemId);
    const sourceDigest = await executionDigest(base);
    const preview = await emptyChangePreview(
      modelIdentity,
      change,
      expectedDigest,
    );
    return {
      ...preview,
      base: {
        repositoryVersion: base.version.repositoryVersion!,
        modelDigest: expectedDigest,
        sourceDigest,
      },
      sourceDigest,
    };
  }
  initializations: Array<ModelIdentity | undefined> = [];
  stages: Stage[] = [];
  added: Candidate[] = [];
  found: Candidate[] = [];
  findResult: ModelBinding | null = null;
  onAdd?: (candidate: Candidate) => void;
  configurations: SystemConfiguration[] = [];
  changeApplications = 0;
  syncError?: Error;
  failActivation = false;
  activationCalls = 0;
  executable: ExecutableModel;
  // Publication history, so an interrupted intent can prove what was published.
  private published = new Map<string, ApprovedChangePublication>();
  constructor(
    private trace: string[] = [],
    initial: SystemRuntimeState | null = saved(),
  ) {
    const configuration = initial?.configuration ??
      (initial
        ? SystemGovernance.importLegacy(
          initial.id,
          initial.model?.reviewerId ?? "",
        ).snapshot
        : SystemGovernance.fresh("test-source").snapshot);
    this.executable = executableFixture(
      { ...identity, reviewerId: configuration.reviewer?.id },
      configuration,
      (initial?.candidates ?? []).map((c) => ({
        nativeId: c.binding?.elementId ?? `native-${c.id}`,
        candidateId: c.id,
        contractId: `contract-${c.kind}`,
        name: c.name,
        kind: c.kind,
        digest: c.digest,
        status: c.stage,
      })),
    );
    this.executable.version.repositoryVersion =
      `fake-${configuration.revision}`;
    this.retainHead();
  }
  findApprovedChange(
    _identity: ModelIdentity,
    changeId: string,
  ): Promise<ApprovedChangePublication | null> {
    return Promise.resolve(
      structuredClone(this.published.get(changeId) ?? null),
    );
  }
  readExecutableModel(
    modelIdentity?: ModelIdentity,
    repositoryVersion?: string,
  ): Promise<ExecutableModel> {
    if (modelIdentity) {
      equal(modelIdentity.systemId, this.executable.identity.systemId);
    }
    if (repositoryVersion !== undefined) {
      const retained = this.versions.get(repositoryVersion);
      ok(
        retained,
        `The exact historical source ${repositoryVersion} must exist; retained=${
          JSON.stringify([...this.versions.keys()])
        }`,
      );
      return Promise.resolve(structuredClone(retained));
    }
    return Promise.resolve(this.retainHead());
  }
  applyApprovedChange(
    _identity: ModelIdentity,
    change: PendingChange,
    expectedDigest: string,
    publication: ChangePublication,
  ): Promise<ExecutableModel> {
    const base = this.retainHead();
    equal(expectedDigest, base.version.digest);
    const approvedVersion = change.diff?.base.repositoryVersion;
    ok(approvedVersion);
    const approvedBase = this.versions.get(approvedVersion);
    ok(
      approvedBase,
      "The source adapter must retain the exact immutable base named by the approved diff",
    );
    equal(approvedBase.version.digest, change.baseModelDigest);
    // Mirror SourceModel's direct prepare(HEAD): an unchanged execution digest
    // cannot authorize applying a diff approved against an older source pin.
    if (base.version.repositoryVersion !== approvedVersion) {
      return Promise.reject(
        new ChangePublicationError(
          "PUBLICATION_NOT_APPLICABLE",
          { changeId: change.id, systemId: _identity.systemId },
          "The source base differs from the exact displayed approval",
        ),
      );
    }
    this.changeApplications++;
    if (this.syncError) return Promise.reject(this.syncError);
    equal(change.status, "approved");
    equal(change.authority, "human");
    const configuration = structuredClone(this.executable.configuration);
    equal(change.baseRevision, configuration.revision);
    configuration.changes.push(structuredClone(change));
    configuration.revision++;
    configuration.builder.mandateRevision++;
    if (change.kind === "reviewer-creation") {
      configuration.reviewer = {
        id: change.id,
        name: change.name!,
        mandateRevision: 1,
      };
      configuration.builder.admissionAuthority = "reviewer";
    } else if (
      change.requestedRights && "addNetworkHosts" in change.requestedRights
    ) {
      configuration.network!.allowedHosts.push(
        ...change.requestedRights.addNetworkHosts,
      );
    } else if (
      change.requestedRights &&
      "mayAdmitOwnCandidates" in change.requestedRights
    ) configuration.builder.admissionAuthority = "builder";
    const previousPolicy = this.executable.policy;
    this.executable = executableFixture(
      { ...this.executable.identity, reviewerId: configuration.reviewer?.id },
      configuration,
      this.executable.catalog,
    );
    this.executable.policy = previousPolicy;
    this.executable.version.repositoryVersion = this.nextSourceVersion();
    if (
      change.requestedRights && "setUrlSelectionMode" in change.requestedRights
    ) {
      this.executable.policy.urlSelectionMode =
        change.requestedRights.setUrlSelectionMode;
    }
    this.configurations.push(structuredClone(configuration));
    const published = this.retainHead();
    this.published.set(change.id, {
      model: published,
      receipt: structuredClone(publication),
    });
    return this.readExecutableModel();
  }
  initialize(
    existing?: ModelIdentity,
    _configuration?: SystemConfiguration,
  ): Promise<ModelIdentity> {
    this.initializations.push(structuredClone(existing));
    return Promise.resolve({
      ...structuredClone(identity),
      reviewerId: this.executable.configuration.reviewer?.id,
    });
  }
  activateCandidate(
    _identity: ModelIdentity,
    candidate: Candidate,
  ): Promise<ModelBinding> {
    this.activationCalls++;
    if (this.failActivation) {
      return Promise.reject(new Error("Native activation readback failed"));
    }
    equal(candidate.admission?.candidateId, candidate.id);
    equal(candidate.admission?.candidateDigest, candidate.digest);
    equal(candidate.tests?.passed, true);
    const candidateBinding = {
      ...binding,
      elementId: `native-${candidate.id}`,
    };
    if (
      this.executable.catalog.some((entry) =>
        entry.nativeId === candidateBinding.elementId &&
        entry.candidateId === candidate.id &&
        entry.digest === candidate.digest &&
        entry.status === "active"
      )
    ) return Promise.resolve(candidateBinding);
    this.trace.push("active");
    this.stages.push("active");
    this.added.push(structuredClone(candidate));
    this.executable.catalog.push({
      nativeId: candidateBinding.elementId,
      candidateId: candidate.id,
      contractId: `contract-${candidate.kind}`,
      name: candidate.name,
      kind: candidate.kind,
      digest: candidate.digest,
      status: "active",
    });
    // The catalog write itself commits before a possible lost readback return.
    this.retainHead();
    this.onAdd?.(candidate);
    return Promise.resolve(candidateBinding);
  }
  findCandidate(
    model: ModelIdentity,
    candidate: Candidate,
  ): Promise<ModelBinding | null> {
    equal(model.systemId, identity.systemId);
    this.found.push(structuredClone(candidate));
    return Promise.resolve(structuredClone(this.findResult));
  }
  graph(): Promise<unknown> {
    return Promise.resolve({});
  }
  syncConfiguration(
    model: ModelIdentity,
    configuration: SystemConfiguration,
  ): Promise<ModelIdentity> {
    if (this.syncError) return Promise.reject(this.syncError);
    this.configurations.push(structuredClone(configuration));
    return Promise.resolve({
      ...model,
      reviewerId: configuration.reviewer?.id,
    });
  }
}
class FakeRunner implements ToolRunnerPort {
  tests: ToolDraft[] = [];
  calls: Array<{ candidate: Candidate; input: { url: string } }> = [];
  scopes: NetworkScope[] = [];
  invokeStep?: (
    candidate: Candidate,
    input: { url: string },
    scope: NetworkScope,
  ) => PageResult | Promise<PageResult>;
  report = structuredClone(passed);
  constructor(private trace: string[] = []) {}
  test(tool: ToolDraft): Promise<TestReport> {
    this.trace.push("test");
    this.tests.push(structuredClone(tool));
    return Promise.resolve(structuredClone(this.report));
  }
  run(
    candidate: Candidate,
    input: { url: string },
    scope = networkScopeFor(),
  ): Promise<PageResult> {
    this.trace.push("invoke");
    this.calls.push(structuredClone({ candidate, input }));
    this.scopes.push(structuredClone(scope));
    if (this.invokeStep) {
      try {
        return Promise.resolve(this.invokeStep(candidate, input, scope));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return Promise.resolve({
      url: input.url,
      title: "Example",
      text: "Actual runner result",
    });
  }
}
async function activeCandidate(
  overrides: Partial<Candidate> = {},
): Promise<Candidate> {
  return {
    ...draft,
    id: "admitted",
    digest: await draftDigest(draft),
    stage: "active",
    createdAt: "now",
    baseCatalogRevision: 0,
    tests: structuredClone(passed),
    binding: structuredClone(binding),
    ...overrides,
  };
}
function saved(candidates: Candidate[] = []): SystemRuntimeState {
  return {
    id: "session",
    revision: 3,
    catalogRevision: candidates.filter((c) => c.stage === "active").length,
    messages: [],
    candidates,
    events: [],
    busy: false,
    phase: "ready",
    provider: "old",
    model: structuredClone(identity),
  };
}
/** This file observes the real memory native queue at its public boundary.
 * Controlled providers/models stay local; no accepted DTO or native receipt is
 * manufactured by the command helpers below. */
type CommandWorker = {
  native: ReturnType<typeof createTestNativeExecution>;
  accepted: AcceptedOperatorCommand[];
  deliveries: OperatorExecutionDelivery[];
  sources: ReturnType<typeof createMemoryArtifactSources>;
};
const commandWorkers = new WeakMap<SystemRuntime, CommandWorker>();
const storedWorkers = new WeakMap<StorePort, CommandWorker>();
function openRuntime(
  ports: ConstructorParameters<typeof SystemRuntime>[0],
): SystemRuntime {
  let worker = storedWorkers.get(ports.store);
  if (!worker) {
    const native = createTestNativeExecution(ports.store);
    const accepted: AcceptedOperatorCommand[] = [];
    const deliveries: OperatorExecutionDelivery[] = [];
    const enqueue = native.dispatch.enqueue.bind(native.dispatch);
    native.dispatch.enqueue = async (delivery) => {
      const receipt = await enqueue(delivery);
      deliveries.push(structuredClone(delivery));
      const command = parseAcceptedCommand(delivery);
      if (command) accepted.push(structuredClone(command));
      return receipt;
    };
    worker = {
      native,
      accepted,
      deliveries,
      sources: ports.artifactSources ?? native.artifactSources,
    };
    storedWorkers.set(ports.store, worker);
  }
  // Reopening the same store retains its actual memory queue, official saver
  // and native admission waits; the source checkpoint is never reconstructed.
  const { native } = worker;
  const service = new SystemRuntime({
    ...ports,
    store: native.store,
    execution: native.execution,
    dispatch: native.dispatch,
    stateHistory: native.stateHistory,
    artifactSources: worker.sources,
  });
  const initialize = service.initialize.bind(service);
  const localIdle = service.idle.bind(service);
  service.initialize = async (...args) => {
    await initialize(...args);
    native.bind(service);
    service.idle = async () => {
      await localIdle();
      await native.idle();
      await localIdle();
    };
  };
  commandWorkers.set(service, worker);
  return service;
}
async function completeControl(
  service: SystemRuntime,
  expected: OperatorControlCommand,
  dispatch: () => Promise<void>,
): Promise<void> {
  const worker = commandWorkers.get(service);
  ok(worker, "The scenario must own its actual native command queue");
  const before = worker.accepted.length;
  try {
    await dispatch();
  } catch (error) {
    equal(
      worker.accepted.length,
      before,
      "A preacceptance refusal must not enqueue a command",
    );
    throw error;
  }
  const commands = worker.accepted.slice(before);
  equal(
    commands.length,
    1,
    "The facade must accept exactly this control command",
  );
  const command = commands[0];
  deepStrictEqual(command.command, expected);
  let failure: unknown;
  let failed = false;
  try {
    await service.idle();
  } catch (error) {
    failed = true;
    failure = error;
  }
  const accepted = await worker.native.dispatch.inspectAccepted!(
    command.identity.operatorId,
    command.id,
  );
  ok(
    accepted,
    "The completed or failed worker must retain its exact acceptance",
  );
  deepStrictEqual(parseAcceptedCommand(accepted.delivery), command);
  equal(accepted.receipt.id, command.id);
  equal(accepted.receipt.status, failed ? "failed" : "completed");
  if (failed) throw failure;
  // This receipt proves processing of the control. Each scenario separately
  // checks its actual admission, publication, authority and conversation result.
  ok(
    await recordedCommandOutcome(service.snapshot, command),
    "Successful control processing needs its canonical correlated result",
  );
}
async function decideCandidate(
  service: SystemRuntime,
  input: Parameters<SystemRuntime["decideCandidate"]>[0],
): Promise<void> {
  await completeControl(
    service,
    { kind: "decide-candidate", input },
    () => service.decideCandidate(input),
  );
}
async function decideChange(
  service: SystemRuntime,
  input: Parameters<SystemRuntime["decideChange"]>[0],
): Promise<void> {
  await completeControl(
    service,
    { kind: "decide-change", input },
    () => service.decideChange(input),
  );
}

const testAgents = new WeakMap<SystemRuntime, FakeAgent>();
async function setup(
  steps: DecisionStep[] = [reply],
  initial: SystemRuntimeState | null = saved(),
  options: {
    retainActiveSources?: true;
    configureModel?: (model: ExecutableModel) => void;
  } = {},
) {
  const trace: string[] = [];
  const agents = new FakeAgent(steps, trace);
  const model = new FakeModel(trace, initial);
  if (options.configureModel) {
    options.configureModel(model.executable);
    // This is the scenario's initial admitted source, before runtime startup;
    // no later read or user approval silently adopts a changed contract.
    await model.readExecutableModel();
  }
  const runner = new FakeRunner(trace);
  const prepared = structuredClone(initial);
  const sources = options.retainActiveSources
    ? createMemoryArtifactSources()
    : undefined;
  if (sources) {
    const version = model.executable.version;
    ok(version.repositoryVersion);
    for (const candidate of prepared?.candidates ?? []) {
      // These invocation scenarios start from an explicitly admitted catalog
      // fixture. Retain its exact declared bytes through the controlled source
      // port; this creates no admission, privilege, native effect or checkpoint.
      const entry = model.executable.catalog.find((value) =>
        value.candidateId === candidate.id &&
        value.digest === candidate.digest && value.status === "active"
      );
      ok(entry && candidate.stage === "active");
      equal(await draftDigest(candidate), candidate.digest);
      const tool = {
        name: candidate.name,
        description: candidate.description,
        kind: candidate.kind,
        code: candidate.code,
      };
      candidate.sourceBinding = await sources.publishTool({
        artifactId: candidate.id,
        ownerId: model.executable.identity.builderId,
        localArtifactId: candidate.id,
        invocationId:
          `fixture-admitted-source:${entry.nativeId}:${candidate.digest}`,
        baseVersion: version.repositoryVersion,
        expectedDigest: candidate.digest,
        draft: tool,
        proof: {
          kind: "admitted-model-seed",
          ownerId: model.executable.identity.builderId,
          sourceElementId: entry.nativeId,
          modelVersion: {
            digest: version.digest,
            repositoryVersion: version.repositoryVersion,
          },
        },
      });
      const resolved = await resolveCandidateSource(
        candidate,
        model.executable.identity.builderId,
        sources,
      );
      deepStrictEqual({
        name: resolved.name,
        description: resolved.description,
        kind: resolved.kind,
        code: resolved.code,
      }, tool);
    }
  }
  const store = new MemoryStore(prepared);
  const service = openRuntime({
    agents,
    model,
    runner,
    store,
    ...(sources ? { artifactSources: sources } : {}),
  });
  await service.initialize();
  testAgents.set(service, agents);
  return { service, agents, model, runner, store, trace };
}
async function turn(
  service: SystemRuntime,
  text = "Lis https://example.org/",
  caseId?: string,
  newConversation?: true,
) {
  const selected = await service.submit(
    text,
    undefined,
    caseId,
    newConversation,
  );
  await service.idle();
  equal(service.snapshot.busy, false);
  return selected;
}

Deno.test("initialization persists model identity, without a greeting, with detached snapshots", async () => {
  const { service, store, model, agents } = await setup([reply], null);
  const state = service.snapshot;
  equal(state.catalogRevision, 0);
  deepStrictEqual(state.model, { ...identity, reviewerId: undefined });
  equal(state.provider, agents.label);
  // A Request starts with the person's own request: no greeting.
  equal(state.messages.length, 0);
  deepStrictEqual(model.initializations, [undefined]);
  state.messages.push({
    id: "snapshot-only",
    role: "user",
    text: "Local snapshot mutation",
    at: "now",
  });
  state.model!.systemId = "changed";
  equal(service.snapshot.messages.length, 0);
  equal(service.snapshot.model!.systemId, identity.systemId);
  deepStrictEqual(await store.load(), service.snapshot);
  const reloaded = (await store.load())!;
  reloaded.messages.push(...state.messages);
  equal((await store.load())!.messages.length, 0);
});

Deno.test("proposal is tested, independently reviewed and activated before invocation and reply", async () => {
  const { service, agents, runner, store, trace } = await setup([
    propose,
    (context) => {
      equal(context.activeTools.length, 1);
      equal(context.candidates[0]!.stage, "active");
      ok(
        context.messages.some((m) =>
          m.role === "tool" && m.text.includes("ACTIF")
        ),
      );
      return invoke(context.activeTools[0]!.id);
    },
    (context) => {
      ok(
        context.messages.some((m) =>
          m.role === "tool" && m.text.includes("Actual runner result")
        ),
      );
      return reply;
    },
  ]);
  agents.reviewStep = (candidate, tests) => {
    equal(service.snapshot.candidates[0]!.stage, "reviewing");
    equal(service.snapshot.catalogRevision, 0);
    equal(runner.calls.length, 0);
    equal(candidate.digest, service.snapshot.candidates[0]!.digest);
    deepStrictEqual(tests, passed);
    return {
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Reviewed independently",
    };
  };
  await turn(service);
  deepStrictEqual(trace, ["test", "review", "active", "invoke"]);
  equal(agents.reviews.length, 1);
  equal(runner.calls.length, 1);
  equal(service.snapshot.catalogRevision, 1);
  equal(service.snapshot.candidates[0]!.stage, "active");
  equal(service.snapshot.messages.at(-1)!.text, reply.text);
  deepStrictEqual(await store.load(), service.snapshot);
  for (const context of agents.contexts) {
    deepStrictEqual(
      context.contracts,
      TOOL_CONTRACTS.map((contract) => ({
        ...contract,
        nativeId: `contract-${contract.kind}`,
      })),
    );
    deepStrictEqual(context.mandate, {
      id: "builder-v1",
      mayPropose: TOOL_KINDS,
      mayInvoke: "active-catalog-only",
      mayReview: false,
      mayActivate: false,
      mayAdmitOwnCandidates: false,
      mayChangeOwnMandate: false,
      network: networkScopeFor(),
      supportedChanges: context.mandate!.supportedChanges,
    });
    ok(
      context.mandate!.supportedChanges.some((c) =>
        c.requestedRights === "addNetworkHosts"
      ),
    );
  }
  const activating = store.saves.find((s) =>
    s.state.candidates[0]?.stage === "activating"
  )!;
  equal(activating.state.catalogRevision, 0);
  equal(activating.state.candidates[0]!.review!.verdict, "approve");
  equal(
    service.snapshot.events.filter((e) => e.kind === "tool-called").length,
    1,
  );
});

Deno.test("review of another digest cannot activate or subsequently invoke the candidate", async () => {
  const { service, agents, model, runner } = await setup([
    propose,
    (context) => invoke(context.candidates[0]!.id),
    reply,
  ]);
  agents.reviewStep = () => ({
    candidateDigest: "another-digest",
    verdict: "approve",
    reason: "Wrong code",
  });
  await turn(service);
  equal(service.snapshot.candidates[0]!.stage, "failed");
  ok(service.snapshot.candidates[0]!.error!.includes("ne correspond pas"));
  equal(service.snapshot.catalogRevision, 0);
  equal(model.stages.includes("active"), false);
  equal(runner.calls.length, 0);
  equal(service.snapshot.error, undefined);
  equal(service.snapshot.lastToolFailure?.code, "TOOL_UNAVAILABLE");
});

Deno.test("failed tests skip the reviewer and leave the catalog unchanged", async () => {
  const { service, agents, model, runner } = await setup([propose, reply]);
  runner.report = {
    passed: false,
    checks: [{ name: "extraction", passed: false, detail: "Missing text" }],
  };
  await turn(service);
  equal(agents.reviews.length, 0);
  equal(service.snapshot.candidates[0]!.stage, "refused");
  deepStrictEqual(service.snapshot.candidates[0]!.tests, runner.report);
  equal(service.snapshot.catalogRevision, 0);
  equal(model.stages.includes("active"), false);
  equal(runner.calls.length, 0);
});

Deno.test("a reviewer refusal remains visible and cannot admit a tool", async () => {
  const { service, agents, model } = await setup([propose, reply]);
  agents.reviewStep = (c) => ({
    candidateDigest: c.digest,
    verdict: "refuse",
    reason: "Extraction is unsuitable",
  });
  await turn(service);
  equal(service.snapshot.candidates[0]!.stage, "refused");
  equal(
    service.snapshot.candidates[0]!.review!.reason,
    "Extraction is unsuitable",
  );
  equal(service.snapshot.catalogRevision, 0);
  equal(model.stages.includes("activating"), false);
  equal(agents.contexts[1]!.activeTools.length, 0);
});

Deno.test("a proposal stays local without binding or native catalog entry until admission", async () => {
  const { service, model, agents } = await setup([propose], null);
  await turn(service);
  const candidate = service.snapshot.candidates[0]!;
  equal(candidate.stage, "awaiting-admission");
  equal(candidate.binding, undefined);
  equal(model.executable.catalog.length, 0);
  equal(model.added.length, 0);
  equal(agents.reviews.length, 0);
  await rejects(() =>
    decideCandidate(service, {
      candidateId: candidate.id,
      candidateDigest: "wrong-digest",
      verdict: "approve",
      reason: "Wrong bytes",
    }), /exact/);
  equal(service.snapshot.catalogRevision, 0);
  equal(model.executable.catalog.length, 0);
});

Deno.test("a stale candidate base or changed code cannot be admitted after approval", async () => {
  for (
    const change of [(c: Candidate) => {
      c.baseCatalogRevision = -1;
    }, (c: Candidate) => {
      c.code += "\n// changed after digest";
    }]
  ) {
    const { service, agents, model } = await setup([propose, reply]);
    // Mutate the live candidate while the reviewer works: the guard that runs
    // at activation, not at proposal, must refuse before any native write.
    agents.reviewStep = (candidate) => {
      change(
        service["state"].candidates.find((c) => c.id === candidate.id)!,
      );
      return {
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Reviewed independently",
      };
    };
    await turn(service);
    equal(agents.reviews.length, 1);
    const refused = service.snapshot.candidates[0]!;
    equal(refused.stage, "failed");
    ok(refused.error!.includes("a changé"));
    equal(refused.activationModelDigest, undefined);
    equal(refused.admission, undefined);
    equal(service.snapshot.catalogRevision, 0);
    equal(model.executable.catalog.length, 0);
    equal(model.added.length, 0);
  }
});

Deno.test("duplicate active tool names cannot replace an admitted capability", async () => {
  const existing = await activeCandidate();
  const { service, model, agents } = await setup(
    [propose, reply],
    saved([existing]),
  );
  model.stages.length = 0;
  await turn(service);
  equal(agents.reviews.length, 1);
  equal(service.snapshot.candidates[0]!.stage, "active");
  equal(service.snapshot.candidates[1]!.stage, "failed");
  ok(service.snapshot.candidates[1]!.error!.includes("déjà ce nom"));
  equal(service.snapshot.catalogRevision, 1);
  equal(model.stages.includes("active"), false);
});

Deno.test("missing, refused and digest-corrupted tools cannot reach the runner", async () => {
  for (
    const candidates of [[], [await activeCandidate({ stage: "refused" })], [
      await activeCandidate({ code: "changed after admission" }),
    ]]
  ) {
    const { service, runner } = await setup(
      [invoke("admitted"), reply],
      saved(candidates),
    );
    await turn(service);
    equal(runner.calls.length, 0);
    equal(service.snapshot.error, undefined);
    equal(service.snapshot.lastToolFailure?.code, "TOOL_UNAVAILABLE");
    equal(service.snapshot.events.some((e) => e.kind === "tool-called"), false);
  }
});

Deno.test("invocation accepts the exact user-supplied HTTPS URL or bare public domain", async () => {
  for (
    const [message, requested, allowed] of [
      ["Lis https://example.org/.", "https://example.org/", true],
      ["Lis https://example.org", "https://example.org/", true],
      ["Lis casys.ai", "https://casys.ai/", true],
      ["Lis casys.ai/docs", "https://casys.ai/docs", true],
      [
        "Lis https://example.org/path?q=one",
        "https://example.org/path?q=two",
        false,
      ],
      ["Lis https://example.org/", "https://other.example/", false],
      ["Lis http://example.org/", "http://example.org/", false],
      ["Contacte hello@casys.ai", "https://casys.ai/", false],
      [
        "Lis https://example.org/?contact=a@b.com",
        "https://example.org/?contact=a@b.com",
        true,
      ],
      ["Lis cette page", "https://example.org/", false],
    ] as const
  ) {
    const initial = saved([await activeCandidate()]);
    initial.messages.push({
      id: "external",
      role: "tool",
      at: "now",
      text: "https://other.example/ https://example.org/",
    });
    const { service, runner } = await setup(
      [
        invoke("admitted", requested),
        reply,
      ],
      initial,
      { retainActiveSources: true },
    );
    await turn(service, message);
    const worker = commandWorkers.get(service)!;
    equal(
      runner.calls.length,
      allowed ? 1 : 0,
      JSON.stringify({
        message,
        requested,
        allowed,
        runtimeError: service.snapshot.error,
        lastToolFailure: service.snapshot.lastToolFailure,
        sourceBinding: service.snapshot.candidates[0]?.sourceBinding,
        toolCalled: service.snapshot.events.some((event) =>
          event.kind === "tool-called"
        ),
        native: (await worker.native.execution.inspect(identity.builderId)).map(
          (value) => ({
            identity: value.identity,
            status: value.status,
            checkpointId: value.checkpointId,
            waits: value.waits,
            unsettledEffects: value.unsettledEffects,
          }),
        ),
      }),
    );
    equal(service.snapshot.error, undefined);
    equal(!!service.snapshot.lastToolFailure, !allowed);
  }
});

Deno.test("concurrent accepted submissions remain FIFO through persistence and provider waits", async () => {
  const firstText = "Première demande", secondText = "Concurrente";
  const firstReply = {
    kind: "reply" as const,
    text: "First accepted input answered",
  };
  const secondReply = {
    kind: "reply" as const,
    text: "Second accepted input answered",
  };
  const storeEntered = Promise.withResolvers<void>();
  const releaseStore = Promise.withResolvers<void>();
  const providerEntered = Promise.withResolvers<void>();
  const releaseProvider = Promise.withResolvers<ChatDecision>();
  let activeProviders = 0, maximumProviders = 0;
  const observedInputs: string[] = [];
  const { service, agents, store } = await setup([
    async (context) => {
      activeProviders++;
      maximumProviders = Math.max(maximumProviders, activeProviders);
      observedInputs.push(
        context.messages.findLast((message) => message.role === "user")!.text,
      );
      providerEntered.resolve();
      try {
        return await releaseProvider.promise;
      } finally {
        activeProviders--;
      }
    },
    (context) => {
      activeProviders++;
      maximumProviders = Math.max(maximumProviders, activeProviders);
      try {
        equal(activeProviders, 1);
        observedInputs.push(
          context.messages.findLast((message) => message.role === "user")!.text,
        );
        return secondReply;
      } finally {
        activeProviders--;
      }
    },
  ]);
  const save = store.save.bind(store);
  let heldPersistence = false;
  store.save = async (state, expected) => {
    if (
      !heldPersistence && state.busy &&
      state.messages.some((message) =>
        message.role === "user" && message.text === firstText
      )
    ) {
      heldPersistence = true;
      storeEntered.resolve();
      await releaseStore.promise;
    }
    await save(state, expected);
  };
  const worker = commandWorkers.get(service)!;
  const first = service.submit(firstText);
  const second = service.submit(secondText);
  try {
    await Promise.all([first, second]);
    await storeEntered.promise;
    const deliveries = worker.deliveries.filter((value) =>
      value.kind === "contribution"
    );
    equal(deliveries.length, 2);
    deepStrictEqual(deliveries.map((value) => value.payload?.text), [
      firstText,
      secondText,
    ]);
    ok(deliveries[0].id !== deliveries[1].id);
    equal(deliveries[0].identity.operatorId, identity.builderId);
    deepStrictEqual(deliveries[0].identity.scope, deliveries[1].identity.scope);
    equal(
      deliveries[0].identity.invocationKey,
      deliveries[1].identity.invocationKey,
    );
    const firstReceipt = await worker.native.dispatch.inspectAccepted!(
      identity.builderId,
      deliveries[0].id,
    );
    const secondReceipt = await worker.native.dispatch.inspectAccepted!(
      identity.builderId,
      deliveries[1].id,
    );
    ok(firstReceipt && secondReceipt);
    deepStrictEqual(firstReceipt.delivery, deliveries[0]);
    deepStrictEqual(secondReceipt.delivery, deliveries[1]);
    equal(firstReceipt.receipt.status, "running");
    equal(secondReceipt.receipt.status, "queued");
    ok(firstReceipt.receipt.jobId !== secondReceipt.receipt.jobId);
    equal(
      agents.contexts.length,
      0,
      "Neither provider may execute before the first business input is persisted",
    );
    equal(
      (await store.load())!.messages.filter((message) =>
        message.role === "user"
      ).length,
      0,
    );
    // New work submitted after this worker has actually reserved its operation
    // remains a real preacceptance refusal, even while its store write yields.
    await rejects(() => service.submit("Encore concurrente"), /déjà en cours/);
    equal(worker.deliveries.length, 2);
    releaseStore.resolve();
    await providerEntered.promise;
    equal(service.snapshot.busy, true);
    equal(agents.contexts.length, 1);
    equal(activeProviders, 1);
    equal(
      (await worker.native.dispatch.inspectAccepted!(
        identity.builderId,
        deliveries[1].id,
      ))?.receipt.status,
      "queued",
    );
    deepStrictEqual(
      service.snapshot.messages.filter((message) => message.role === "user")
        .map((message) => message.text),
      [firstText],
    );
    const native = await worker.native.execution.inspect(identity.builderId);
    equal(
      native.filter((value) => value.identity.subjectId === deliveries[1].id)
        .length,
      0,
      "The second accepted input cannot open its native conversation while the first provider is pending",
    );
  } finally {
    releaseStore.resolve();
    releaseProvider.resolve(firstReply);
    await Promise.allSettled([first, second]);
    await service.idle();
  }
  const completedDeliveries = worker.deliveries.filter((value) =>
    value.kind === "contribution"
  );
  equal(completedDeliveries.length, 2);
  const native = await worker.native.execution.inspect(identity.builderId);
  for (const delivery of completedDeliveries) {
    const accepted = await worker.native.dispatch.inspectAccepted!(
      identity.builderId,
      delivery.id,
    );
    ok(accepted);
    equal(accepted.receipt.id, delivery.id);
    equal(accepted.receipt.status, "completed");
    deepStrictEqual(accepted.delivery, delivery);
    const receipt = native.find((value) =>
      value.contributionId === delivery.id &&
      value.identity.subjectId === delivery.id
    );
    ok(receipt);
    deepStrictEqual(receipt.identity, delivery.identity);
    deepStrictEqual(receipt.unsettledEffects, []);
  }
  deepStrictEqual(observedInputs, [firstText, secondText]);
  equal(maximumProviders, 1);
  equal(activeProviders, 0);
  deepStrictEqual(
    service.snapshot.messages.filter((message) =>
      message.role === "user" || message.role === "assistant"
    ).map((message) => message.text),
    [firstText, firstReply.text, secondText, secondReply.text],
  );
  equal(service.snapshot.busy, false);
  equal(service.snapshot.error, undefined);
  agents.steps.push(reply);
  await turn(service, "Nouvelle demande");
  equal(agents.contexts.length, 3);
  equal(service.snapshot.error, undefined);
});

Deno.test("restart marks every pending lifecycle stage failed without automatic activation", async () => {
  const stages: Stage[] = [
    "proposed",
    "testing",
    "reviewing",
    "activating",
    "refused",
    "failed",
    "active",
  ];
  const candidates = await Promise.all(
    stages.map(async (stage, index) =>
      await activeCandidate({ id: `c-${index}`, stage })
    ),
  );
  const initial = saved(candidates);
  initial.busy = true;
  initial.messages = [{
    id: "existing",
    role: "assistant",
    text: "Existing conversation",
    at: "now",
  }];
  const { service, model, agents, runner, store } = await setup(
    [reply],
    initial,
  );
  deepStrictEqual(model.initializations, [identity]);
  deepStrictEqual(service.snapshot.candidates.map((c) => c.stage), [
    "failed",
    "failed",
    "failed",
    "failed",
    "refused",
    "failed",
    "active",
  ]);
  deepStrictEqual(
    model.stages,
    [],
    "restart must never rewrite source from saved stages",
  );
  equal(service.snapshot.catalogRevision, initial.catalogRevision);
  equal(service.snapshot.busy, false);
  equal(service.snapshot.messages.length, 1);
  equal(agents.reviews.length, 0);
  equal(runner.tests.length, 0);
  equal(runner.calls.length, 0);
  for (const c of service.snapshot.candidates.slice(0, 4)) {
    ok(c.error!.includes("redémarrage"));
  }
  deepStrictEqual(await store.load(), service.snapshot);
});

/** An expected failure belongs to this actual accepted input, not the ACK. */
async function failedContributionReceipt(
  service: SystemRuntime,
  delivery: OperatorExecutionDelivery,
  expectedError: RegExp,
): Promise<void> {
  const worker = commandWorkers.get(service);
  ok(worker);
  equal(delivery.kind, "contribution");
  const accepted = await worker.native.dispatch.inspectAccepted!(
    identity.builderId,
    delivery.id,
  );
  ok(accepted);
  deepStrictEqual(accepted.delivery, delivery);
  equal(accepted.receipt.id, delivery.id);
  equal(accepted.receipt.status, "failed");
  ok(
    service.snapshot.messages.some((message) =>
      message.id === delivery.id && message.role === "user" &&
      message.text === delivery.payload?.text
    ),
  );
  const failure = service.snapshot.events.find((event) =>
    event.id === `accepted-delivery-error:${delivery.id}`
  );
  ok(failure, "The business failure must correlate to the same accepted input");
  ok(expectedError.test(failure.label));
}
async function refusedTurn(
  service: SystemRuntime,
  expectedError: RegExp,
  text = "Lis https://example.org/",
  verifyError?: (error: unknown) => void,
): Promise<void> {
  const worker = commandWorkers.get(service);
  ok(worker);
  const before = worker.deliveries.length;
  await rejects(() => turn(service, text), (error: unknown) => {
    verifyError?.(error);
    return error instanceof Error && expectedError.test(error.message);
  });
  const deliveries = worker.deliveries.slice(before);
  equal(deliveries.length, 1);
  equal(deliveries[0].payload?.text, text);
  await failedContributionReceipt(service, deliveries[0], expectedError);
}

/** Read only the real retained native promotion and its actual effect ledger. */
async function promotionEvidence(service: SystemRuntime, candidate: Candidate) {
  const worker = commandWorkers.get(service);
  const reference = candidate.promotionExecution;
  ok(worker && reference?.subjectId && reference.inputMessageId);
  const state = service.snapshot;
  const invocation = candidateCaseInvocation(state, candidate);
  ok(invocation, "The candidate must retain its exact original invocation");
  const input = invocationInput({
    ...state,
    caseInvocation: invocation,
    activeInputMessageId: reference.inputMessageId,
  }, invocation);
  equal(
    input?.id,
    reference.inputMessageId,
    "The native input must still resolve to its actual persisted source message",
  );
  const expectedIdentity = nativeExecutionIdentity(
    { ...state, caseInvocation: invocation },
    "promotion",
    reference.subjectId,
  );
  const frames = await worker.native.checkpoints();
  const owners = (await worker.native.execution.inspect(identity.builderId))
    .filter((value) => {
      if (
        canonical(value.identity) !== canonical(expectedIdentity) ||
        value.modelDigest !== reference.modelDigest ||
        reference.threadId !== undefined &&
          value.threadId !== reference.threadId ||
        value.localState?.promotionId !== undefined &&
          value.localState.promotionId !== candidate.id
      ) return false;
      const matchingFrames = frames.filter((frame) =>
        frame.threadId === value.threadId &&
        canonical(frame.request.identity) === canonical(expectedIdentity) &&
        frame.request.model.version.digest === reference.modelDigest &&
        frame.request.contribution.id === value.contributionId &&
        frame.request.contribution.inputMessageId === reference.inputMessageId
      );
      return matchingFrames.length === 1;
    });
  equal(
    owners.length,
    1,
    "The candidate must retain one unambiguous native owner for its exact scope, subject, pin and input",
  );
  const snapshot = owners[0];
  ok(snapshot.threadId && snapshot.checkpointId);
  if (reference.threadId !== undefined) {
    equal(snapshot.threadId, reference.threadId);
  }
  const checkpoints = frames.filter((value) =>
    value.threadId === snapshot.threadId
  );
  equal(checkpoints.length, 1);
  equal(checkpoints[0].checkpointId, snapshot.checkpointId);
  equal(checkpoints[0].request.identity.operatorId, identity.builderId);
  equal(checkpoints[0].request.identity.purpose, "promotion");
  equal(checkpoints[0].request.identity.subjectId, reference.subjectId);
  const activations = checkpoints[0].effects.filter((effect) =>
    effect.node.mechanism === "activate_candidate"
  );
  equal(
    activations.length,
    1,
    "The actual native activation action must own this publication boundary",
  );
  return { snapshot, activation: activations[0] };
}
function unknownActivation(
  evidence: Awaited<ReturnType<typeof promotionEvidence>>,
) {
  equal(evidence.snapshot.status, "uncertain");
  equal(evidence.activation.settled, false);
  ok(evidence.snapshot.unsettledEffects.includes(evidence.activation.key));
}

async function advanceCatalogWithAnotherActiveTool(
  store: MemoryStore,
  model: FakeModel,
) {
  const otherDraft = { ...draft, name: "Another active reader" };
  const digest = await draftDigest(otherDraft);
  const first = (await store.load())!.candidates[0]!;
  const other = await activeCandidate({
    ...otherDraft,
    id: "another-admitted",
    digest,
    binding: {
      elementId: "native-another-admitted",
      graphPath: "catalog/other",
    },
    admission: {
      ...first.admission!,
      candidateId: "another-admitted",
      candidateDigest: digest,
    },
  });
  model.executable.catalog.push({
    nativeId: other.binding!.elementId,
    candidateId: other.id,
    contractId: `contract-${other.kind}`,
    name: other.name,
    kind: other.kind,
    digest: other.digest,
    status: "active",
  });
  const next = (await store.load())!;
  next.revision++;
  next.catalogRevision++;
  next.candidates.push(other);
  await store.save(next, next.revision - 1);
}

Deno.test("restart and a new contribution keep an unknown native activation pending without republishing", async () => {
  const { service, agents, model, runner, store } = await setup([
    propose,
    reply,
    reply,
  ]);
  model.failActivation = true;
  await refusedTurn(service, /Native activation readback failed/);
  const interrupted = service.snapshot.candidates[0]!;
  equal(interrupted.stage, "activating");
  equal(interrupted.activationModelDigest, model.executable.version.digest);
  equal(interrupted.binding, undefined);
  equal(interrupted.admission?.candidateId, interrupted.id);
  equal(interrupted.activationAttempts, 1);
  equal(model.executable.catalog.length, 0);
  equal(model.added.length, 0);
  equal(model.activationCalls, 1);
  equal(service.snapshot.catalogRevision, 0);
  equal(runner.tests.length, 1);
  equal(agents.reviews.length, 1);
  const nativeBefore = await promotionEvidence(service, interrupted);
  unknownActivation(nativeBefore);

  // A healthy publisher and an empty catalog are not a durable reconciliation
  // receipt proving that the first native effect never happened.
  model.failActivation = false;
  const restarted = openRuntime({ agents, model, runner, store });
  await restarted.initialize();
  const pending = restarted.snapshot.candidates[0]!;
  equal(pending.stage, "activating");
  deepStrictEqual(pending.admission, interrupted.admission);
  equal(pending.activationModelDigest, interrupted.activationModelDigest);
  equal(pending.activationAttempts, interrupted.activationAttempts);
  equal(pending.binding, undefined);
  equal(model.activationCalls, 1);
  equal(model.executable.catalog.length, 0);
  equal(model.added.length, 0);
  equal(restarted.snapshot.catalogRevision, 0);
  deepStrictEqual(
    (await promotionEvidence(restarted, pending)).snapshot,
    nativeBefore.snapshot,
  );
  await turn(restarted, "A new request cannot settle the unknown publication");
  equal(model.activationCalls, 1);
  equal(model.added.length, 0);
  equal(restarted.snapshot.candidates[0].stage, "activating");
  equal(restarted.snapshot.candidates[0].activationAttempts, 1);
  deepStrictEqual(
    restarted.snapshot.candidates[0].admission,
    interrupted.admission,
  );
  unknownActivation(
    await promotionEvidence(restarted, restarted.snapshot.candidates[0]),
  );
  equal(runner.tests.length, 1);
  equal(agents.reviews.length, 1);
  deepStrictEqual(await store.load(), restarted.snapshot);
});

Deno.test("restart reconciles exact published activations with unknown or settled native receipts without calling the writer", async () => {
  for (const receipt of ["unknown", "settled"] as const) {
    const { service, agents, model, runner, store } = await setup([
      propose,
      reply,
    ]);
    if (receipt === "unknown") {
      model.onAdd = () => {
        throw new Error("Native publication succeeded but readback failed");
      };
    }
    if (receipt === "unknown") {
      await refusedTurn(
        service,
        /Native publication succeeded but readback failed/,
      );
    } else await turn(service);
    const before = service.snapshot.candidates[0]!;
    equal(before.stage, receipt === "unknown" ? "activating" : "active");
    equal(model.executable.catalog.length, 1);
    equal(model.added.length, 1);
    equal(model.activationCalls, 1);
    equal(service.snapshot.catalogRevision, receipt === "unknown" ? 0 : 1);
    const nativeBefore = await promotionEvidence(service, before);
    if (receipt === "unknown") unknownActivation(nativeBefore);
    else {
      equal(nativeBefore.snapshot.status, "completed");
      equal(nativeBefore.activation.settled, true);
      deepStrictEqual(nativeBefore.snapshot.unsettledEffects, []);
    }
    const restarted = openRuntime({ agents, model, runner, store });
    await restarted.initialize();
    const active = restarted.snapshot.candidates[0]!;
    equal(active.stage, "active");
    equal(active.activationModelDigest, undefined);
    equal(active.binding?.elementId, `native-${active.id}`);
    equal(model.executable.catalog.length, 1);
    equal(model.added.length, 1);
    equal(
      model.activationCalls,
      1,
      "Exact publication reconciliation must be read-only, even when the writer is idempotent",
    );
    equal(restarted.snapshot.catalogRevision, 1);
    deepStrictEqual(
      (await promotionEvidence(restarted, active)).snapshot,
      nativeBefore.snapshot,
    );
    equal(runner.tests.length, 1);
    equal(agents.reviews.length, 1);
    deepStrictEqual(await store.load(), restarted.snapshot);
  }
});

Deno.test("restart reconciles a published activation after another tool advanced the catalog", async () => {
  const { service, agents, model, runner, store } = await setup([
    propose,
    reply,
  ]);
  model.onAdd = () => {
    throw new Error("Native publication succeeded but readback failed");
  };
  await refusedTurn(
    service,
    /Native publication succeeded but readback failed/,
  );
  const interrupted = service.snapshot.candidates[0]!;
  equal(interrupted.stage, "activating");
  equal(model.executable.catalog.length, 1);
  equal(model.activationCalls, 1);
  const nativeBefore = await promotionEvidence(service, interrupted);
  unknownActivation(nativeBefore);
  await advanceCatalogWithAnotherActiveTool(store, model);

  const restarted = openRuntime({ agents, model, runner, store });
  await restarted.initialize();
  const candidates = restarted.snapshot.candidates;
  equal(candidates[0]!.stage, "active");
  equal(candidates[0]!.binding?.elementId, `native-${interrupted.id}`);
  equal(candidates[0]!.activationModelDigest, undefined);
  equal(candidates[1]!.stage, "active");
  equal(restarted.snapshot.catalogRevision, 2);
  equal(model.executable.catalog.length, 2);
  equal(model.added.length, 1);
  equal(model.activationCalls, 1);
  deepStrictEqual(
    (await promotionEvidence(restarted, candidates[0])).snapshot,
    nativeBefore.snapshot,
  );
  equal(runner.tests.length, 1);
  equal(agents.reviews.length, 1);
  deepStrictEqual(await store.load(), restarted.snapshot);
});

Deno.test("an unknown native activation stays pending after another tool advances its catalog base", async () => {
  const { service, agents, model, runner, store } = await setup([
    propose,
    reply,
  ]);
  model.failActivation = true;
  await refusedTurn(service, /Native activation readback failed/);
  const interrupted = service.snapshot.candidates[0]!;
  equal(interrupted.stage, "activating");
  equal(interrupted.activationAttempts, 1);
  equal(model.executable.catalog.length, 0);
  equal(model.activationCalls, 1);
  const nativeBefore = await promotionEvidence(service, interrupted);
  unknownActivation(nativeBefore);
  await advanceCatalogWithAnotherActiveTool(store, model);
  model.failActivation = false;

  const restarted = openRuntime({ agents, model, runner, store });
  await restarted.initialize();
  const pending = restarted.snapshot.candidates[0]!;
  equal(pending.stage, "activating");
  equal(pending.errorCode, undefined);
  equal(pending.binding, undefined);
  equal(pending.activationModelDigest, interrupted.activationModelDigest);
  equal(pending.activationAttempts, interrupted.activationAttempts);
  deepStrictEqual(pending.admission, interrupted.admission);
  equal(
    restarted.snapshot.events.some((event) =>
      event.kind === "tool-failed" && event.code === "CATALOG_BASE_CHANGED" &&
      event.candidateId === pending.id
    ),
    false,
  );
  equal(restarted.snapshot.catalogRevision, 1);
  equal(model.executable.catalog.length, 1);
  equal(model.added.length, 0);
  equal(model.activationCalls, 1);
  deepStrictEqual(
    (await promotionEvidence(restarted, pending)).snapshot,
    nativeBefore.snapshot,
  );
  equal(runner.tests.length, 1);
  equal(agents.reviews.length, 1);
  deepStrictEqual(await store.load(), restarted.snapshot);

  const again = openRuntime({ agents, model, runner, store });
  await again.initialize();
  deepStrictEqual(again.snapshot.candidates[0], pending);
  equal(model.activationCalls, 1);
  equal(model.added.length, 0);
  unknownActivation(
    await promotionEvidence(again, again.snapshot.candidates[0]),
  );
});

Deno.test("new outline proposals keep their kind and leave saved legacy active/refused records intact", async () => {
  const active = await activeCandidate();
  const refused = await activeCandidate({
    id: "legacy-outline",
    name: "Old outline",
    kind: "read_web_page",
    stage: "refused",
    tests: {
      passed: false,
      checks: [{
        name: "extraction fixture 1",
        passed: false,
        detail: "Missing body",
      }],
    },
  });
  const newDraft: ToolDraft = {
    ...draft,
    name: "New outline",
    kind: "read_web_page_outline",
  };
  const { service, agents, runner } = await setup([
    { kind: "propose_tool", text: "Je propose un plan.", tool: newDraft },
    reply,
  ], saved([active, refused]));
  deepStrictEqual(service.snapshot.candidates.slice(0, 2), [active, refused]);
  await turn(service, "Construis un nouvel outil utile.");
  deepStrictEqual(service.snapshot.candidates.slice(0, 2), [active, refused]);
  equal(runner.tests[0]!.kind, "read_web_page_outline");
  equal(agents.reviews[0]!.candidate.kind, "read_web_page_outline");
  equal(service.snapshot.candidates[2]!.kind, "read_web_page_outline");
  equal(service.snapshot.candidates[2]!.stage, "active");
  deepStrictEqual(agents.contexts[1]!.activeTools.map((t) => t.kind), [
    "read_web_page",
    "read_web_page_outline",
  ]);
  equal(agents.contexts[0]!.candidates[1]!.kind, "read_web_page");
});

const mandateProposal: ChatDecision = {
  kind: "propose_mandate_change",
  text: "Je propose une révision bornée du mandat.",
  reason: "Décider de l’admission de mes propres candidats testés",
  requestedRights: { mayAdmitOwnCandidates: true },
};
const reviewerProposal: ChatDecision = {
  kind: "propose_agent_creation",
  text: "Je propose un reviewer distinct.",
  name: "Reviewer des nouveaux outils",
  role: "reviewer",
  reason: "Séparer construction et admission des nouveaux candidats",
  mandate: { mayReviewExactCandidate: true, mayAdmitReviewedCandidates: true },
};
async function approvePendingChange(service: SystemRuntime) {
  // Admission is a case contribution; provide an explicit next judgment when this test has no scripted continuation.
  const agent = testAgents.get(service);
  if (agent && !agent.steps.length) agent.steps.push(reply);
  const configuration = service.snapshot.configuration!;
  const change = configuration.changes.find((c) => c.status === "pending")!;
  await decideChange(service, {
    changeId: change.id,
    expectedRevision: configuration.revision,
    verdict: "approve",
  });
}

// A root above the requesting system: the host's rights judgment refuses it.
const invalidGrant: ChatDecision = {
  kind: "propose_mandate_change",
  text: "I request a right to edit the model.",
  reason: "Edit the model",
  requestedRights: {
    grantModelEditing: {
      file: "configuration.sysml",
      root: "AssemblyLiveBuilder",
      operations: ["insert-member"],
    },
  },
};

Deno.test("a coded refusal of a proposal returns to the agent, which then replies without failing the turn", async () => {
  const { service, agents } = await setup(
    [
      invalidGrant,
      (context) => {
        const observation = context.messages.findLast((message) =>
          message.role === "tool"
        )!;
        const refusal = JSON.parse(observation.text.split("\n")[1]!);
        equal(refusal.code, "INVALID_MODEL_EDIT_GRANT");
        ok(refusal.message.includes("must be within the requesting system"));
        equal(refusal.context.root, "AssemblyLiveBuilder");
        // The agent learns which roots to avoid, not only that it failed.
        ok(refusal.context.excludedRoots.length > 0);
        deepStrictEqual(refusal.recovery, { action: "refuse-and-repropose" });
        return {
          kind: "reply",
          text: "That root is above my system; I will ask for a narrower one.",
        };
      },
    ],
    null,
    {
      configureModel: (initialModel) => {
        initialModel.policy.mayProposeSysmlRevision = true;
      },
    },
  );
  equal(service.snapshot.executionModel!.policy.mayProposeSysmlRevision, true);
  await turn(service, "Let the system edit its own model.");
  equal(agents.contexts.length, 2);
  equal(service.snapshot.error, undefined);
  equal(
    service.snapshot.events.some((event) => event.kind === "turn-failed"),
    false,
  );
  deepStrictEqual(
    service.snapshot.messages.filter((message) => message.role === "assistant")
      .map((message) => message.text),
    ["That root is above my system; I will ask for a narrower one."],
  );
  equal(service.snapshot.configuration!.changes.length, 0);
});

Deno.test("a second coded refusal in the same turn fails it with the English message", async () => {
  const { service, agents, model } = await setup(
    [
      invalidGrant,
      invalidGrant,
    ],
    null,
    {
      configureModel: (initialModel) => {
        initialModel.policy.mayProposeSysmlRevision = true;
      },
    },
  );
  equal(service.snapshot.executionModel!.policy.mayProposeSysmlRevision, true);
  const expectedMessage =
    "The editing root must be within the requesting system and exclude authority declarations: choose a root inside systemName that neither contains nor lies within any of excludedRoots";
  await refusedTurn(
    service,
    /^The editing root must be within the requesting system and exclude authority declarations: choose a root inside systemName that neither contains nor lies within any of excludedRoots$/,
    "Let the system edit its own model.",
    (error) => {
      ok(error instanceof OperatorAuthorityError);
      equal(error.code, "INVALID_MODEL_EDIT_GRANT");
      equal(error.message, expectedMessage);
    },
  );
  equal(agents.contexts.length, 2);
  equal(service.snapshot.error, expectedMessage);
  equal(
    service.snapshot.events.filter((event) => event.kind === "turn-failed")
      .length,
    1,
  );
  const failure = service.snapshot.events.find((event) =>
    event.kind === "turn-failed"
  )!;
  equal(failure.label, expectedMessage);
  const worker = commandWorkers.get(service)!;
  const acceptedInput = worker.deliveries.filter((delivery) =>
    delivery.kind === "contribution" &&
    delivery.payload?.text === "Let the system edit its own model."
  );
  equal(acceptedInput.length, 1);
  equal(failure.id, `accepted-delivery-error:${acceptedInput[0].id}`);
  deepStrictEqual(
    service.snapshot.messages.filter((message) => message.role === "user").map((
      message,
    ) => ({ id: message.id, text: message.text })),
    [{ id: acceptedInput[0].id, text: "Let the system edit its own model." }],
  );
  // Workbench projects current.error into its visible alert. This host failure
  // retains that exact English error; it must not invent a successful reply.
  deepStrictEqual(
    service.snapshot.messages.filter((message) => message.role === "assistant"),
    [],
  );
  equal(model.changeApplications, 0);
  equal(service.snapshot.configuration!.changes.length, 0);
});

Deno.test("a fresh system waits for exact explicit human admission and survives restart", async () => {
  const { service, agents, model, runner, store } = await setup(
    [propose],
    null,
  );
  equal(service.snapshot.configuration!.builder.admissionAuthority, "human");
  equal(service.snapshot.configuration!.reviewer, undefined);
  await turn(service, "Construis un lecteur de pages");
  const candidate = service.snapshot.candidates[0]!;
  equal(candidate.stage, "awaiting-admission");
  equal(candidate.requiredAuthority, "human");
  equal(candidate.tests!.passed, true);
  equal(agents.reviews.length, 0);
  equal(agents.admissions.length, 0);
  equal(service.snapshot.catalogRevision, 0);
  equal(model.stages.includes("active"), false);
  equal(runner.calls.length, 0);
  const restarted = openRuntime({ agents, model, runner, store });
  await restarted.initialize();
  equal(restarted.snapshot.candidates[0]!.stage, "awaiting-admission");
  await rejects(
    () =>
      decideCandidate(restarted, {
        candidateId: candidate.id,
        candidateDigest: "wrong",
        verdict: "approve",
        reason: "Reviewed",
      }),
    /exact/,
  );
  equal(restarted.snapshot.catalogRevision, 0);
  agents.steps.push(reply);
  await decideCandidate(restarted, {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Code et essais examinés",
  });
  equal(restarted.snapshot.catalogRevision, 1);
  equal(restarted.snapshot.candidates[0]!.admission!.authority, "human");
  equal(restarted.snapshot.candidates[0]!.admission!.candidateId, candidate.id);
  equal(restarted.snapshot.candidates[0]!.stage, "active");
  await rejects(
    () =>
      decideCandidate(restarted, {
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "Again",
      }),
    /n’attend pas/,
  );
  equal(restarted.snapshot.catalogRevision, 1);
});

/** Diagnostic only: preserve the real adoption refusal and every dependency. */
async function adoptWithNativeDiagnostics(
  service: SystemRuntime,
  input: Parameters<SystemRuntime["adoptModelVersion"]>[0],
): Promise<void> {
  try {
    await service.adoptModelVersion(input);
  } catch (error) {
    const worker = commandWorkers.get(service);
    ok(worker);
    const state = service.snapshot;
    const snapshots = await worker.native.execution.inspect(identity.builderId);
    const frames = await worker.native.checkpoints();
    const transports = await Promise.all(
      worker.deliveries.map(async (delivery) => ({
        delivery: {
          id: delivery.id,
          kind: delivery.kind,
          identity: delivery.identity,
          modelPin: delivery.modelPin,
          command: parseAcceptedCommand(delivery)?.command,
          inputMessageId: delivery.payload?.inputMessageId,
          text: delivery.payload?.text,
        },
        receipt: (await worker.native.dispatch.inspectAccepted!(
          delivery.identity.operatorId,
          delivery.id,
        ))?.receipt,
      })),
    );
    console.error(JSON.stringify({
      kind: "native-adoption-boundary-diagnostic",
      requested: input,
      failure: error instanceof Error
        ? { name: error.name, message: error.message }
        : String(error),
      runtime: {
        id: state.id,
        revision: state.revision,
        pin: state.executionModel?.version,
        busy: state.busy,
        selected: state.caseInvocation,
        activeInputMessageId: state.activeInputMessageId,
        error: state.error,
      },
      checkpoint: evolutionCheckpoint({ ...state, busy: false }, snapshots),
      snapshots: snapshots.map((snapshot) => ({
        identity: snapshot.identity,
        contributionId: snapshot.contributionId,
        pin: {
          modelDigest: snapshot.modelDigest,
          repositoryVersion: snapshot.repositoryVersion,
        },
        threadId: snapshot.threadId,
        runId: snapshot.runId,
        checkpointId: snapshot.checkpointId,
        status: snapshot.status,
        waits: snapshot.waits,
        unsettledEffects: snapshot.unsettledEffects,
        pendingContributions: snapshot.pendingContributions,
        openImmutableConsultationGroups:
          snapshot.openImmutableConsultationGroups,
        localState: {
          reply: snapshot.localState?.reply,
          promotionId: snapshot.localState?.promotionId,
          pendingCommand: snapshot.localState?.pendingCommand,
        },
        isExactEmptyInputWait: emptyNativeEvolutionAwait(state, snapshot),
        input: state.messages.find((message) =>
          message.id === snapshot.identity.subjectId
        ),
        frame: frames.filter((frame) => frame.threadId === snapshot.threadId)
          .map((frame) => ({
            threadId: frame.threadId,
            runId: frame.runId,
            checkpointId: frame.checkpointId,
            identity: frame.request.identity,
            contribution: frame.request.contribution,
            pin: frame.request.model.version,
            businessRevision: frame.request.businessRevision,
            effects: frame.effects.map((effect) => ({
              key: effect.key,
              mechanism: effect.node.mechanism,
              settled: effect.settled,
            })),
          })),
      })),
      transports,
      changes: state.configuration?.changes.map((change) => ({
        id: change.id,
        status: change.status,
        baseModelDigest: change.baseModelDigest,
        base: change.diff?.base,
        publishedCommit: change.publishedCommit,
        continuation: state.changeDecisionContinuations?.[change.id],
      })),
      batches: state.conversationBatches?.map((batch) => ({
        id: batch.id,
        inputMessageId: batch.inputMessageId,
        invocationKey: batch.invocationKey,
        calls: batch.calls.map((call) => ({
          id: call.id,
          kind: call.decision.kind,
          status: call.status,
          result: call.result
            ? {
              status: call.result.status,
              code: call.result.code,
              details: call.result.details.slice(0, 400),
            }
            : undefined,
        })),
      })),
    }));
    throw error;
  }
}

Deno.test("normal conversation evolves human admission into builder delegation then reviewer admission", async () => {
  const { service, agents, model, runner } = await setup([propose], null);
  await turn(service, "Construis le premier outil");
  const first = service.snapshot.candidates[0]!;
  agents.steps.push(reply);
  await decideCandidate(service, {
    candidateId: first.id,
    candidateDigest: first.digest,
    verdict: "approve",
    reason: "J’admets le premier outil testé",
  });
  agents.steps.push(mandateProposal);
  await turn(
    service,
    "Propose un mandat qui te permette d’admettre tes créations d’outils",
  );
  equal(service.snapshot.configuration!.builder.admissionAuthority, "human");
  equal(service.snapshot.configuration!.changes[0]!.status, "pending");
  deepStrictEqual(service.snapshot.configuration!.changes[0]!.requestedRights, {
    mayAdmitOwnCandidates: true,
  });
  const firstMandateBase = structuredClone(service.snapshot.executionModel!);
  await approvePendingChange(service);
  ok(
    service.snapshot.executionModel!.version.repositoryVersion !==
      firstMandateBase.version.repositoryVersion,
  );
  deepStrictEqual(
    await model.readExecutableModel(
      firstMandateBase.identity,
      firstMandateBase.version.repositoryVersion,
    ),
    firstMandateBase,
  );
  equal(service.snapshot.configuration!.builder.admissionAuthority, "builder");
  equal(service.snapshot.configuration!.builder.mandateRevision, 2);
  equal(model.configurations.length, 1);
  model.executable.contracts[0]!.acceptanceCriteria = [
    "Native criterion for builder admission",
  ];
  model.executable.version.digest = "source-builder-contract";
  await adoptWithNativeDiagnostics(service, {
    expectedDigest: "source-builder-contract",
  });
  agents.steps.push({
    ...propose,
    tool: { ...draft, name: "Builder-admitted reader" },
  }, reply);
  await turn(service, "Crée un deuxième outil utile");
  equal(agents.admissions.length, 1);
  equal(agents.admissions[0]!.context.mandateRevision, 2);
  equal(agents.admissions[0]!.context.configurationRevision, 1);
  deepStrictEqual(
    agents.admissions[0]!.context.contract,
    model.executable.contracts[0],
  );
  equal(
    agents.admissions[0]!.context.modelVersion!.digest,
    "source-builder-contract",
  );
  equal(agents.contexts.at(-1)!.mandate!.mayAdmitOwnCandidates, true);
  equal(agents.contexts.at(-1)!.mandate!.mayActivate, false);
  equal(service.snapshot.candidates[1]!.admission!.authority, "builder");
  equal(service.snapshot.catalogRevision, 2);
  equal(agents.reviews.length, 0);
  agents.steps.push(reviewerProposal);
  await turn(
    service,
    "Crée un second agent reviewer responsable d’examiner et accepter les nouveaux outils",
  );
  equal(service.snapshot.configuration!.reviewer, undefined);
  const reviewerMandateBase = structuredClone(service.snapshot.executionModel!);
  await approvePendingChange(service);
  ok(
    service.snapshot.executionModel!.version.repositoryVersion !==
      reviewerMandateBase.version.repositoryVersion,
  );
  deepStrictEqual(
    await model.readExecutableModel(
      reviewerMandateBase.identity,
      reviewerMandateBase.version.repositoryVersion,
    ),
    reviewerMandateBase,
  );
  equal(service.snapshot.configuration!.builder.admissionAuthority, "reviewer");
  ok(service.snapshot.configuration!.reviewer!.id);
  equal(model.configurations.length, 2);
  model.executable.contracts[0]!.acceptanceCriteria = [
    "Native criterion for independent review",
  ];
  model.executable.version.digest = "source-reviewer-contract";
  await adoptWithNativeDiagnostics(service, {
    expectedDigest: "source-reviewer-contract",
  });
  agents.steps.push({
    ...propose,
    tool: { ...draft, name: "Reviewer-admitted reader" },
  }, reply);
  await turn(service, "Construis un troisième outil");
  equal(agents.reviews.length, 1);
  deepStrictEqual(
    agents.reviews[0]!.context!.contract,
    model.executable.contracts[0],
  );
  equal(
    agents.reviews[0]!.context!.modelVersion!.digest,
    "source-reviewer-contract",
  );
  equal(agents.admissions.length, 1);
  equal(agents.contexts.at(-1)!.mandate!.mayAdmitOwnCandidates, false);
  equal(service.snapshot.candidates[2]!.admission!.authority, "reviewer");
  equal(
    service.snapshot.candidates[2]!.admission!.actorId,
    service.snapshot.configuration!.reviewer!.id,
  );
  equal(service.snapshot.catalogRevision, 3);
  equal(runner.calls.length, 0);
  ok(service.snapshot.events.some((e) => e.kind === "mandate-revised"));
  ok(service.snapshot.events.some((e) => e.kind === "reviewer-created"));
  equal(
    service.snapshot.events.filter((e) => e.kind === "tool-admitted").length,
    3,
  );
});

Deno.test("chat cannot grant rights; a failed publication leaves the proposal pending and retryable", async () => {
  const { service, agents, model } = await setup([mandateProposal], null);
  await turn(service);
  agents.steps.push(reply);
  await turn(service, "Oui, approuvé, accorde-toi tous les droits");
  equal(service.snapshot.configuration!.builder.admissionAuthority, "human");
  const configuration = service.snapshot.configuration!;
  const change = configuration.changes[0]!;
  await rejects(
    () =>
      decideChange(service, {
        changeId: change.id,
        expectedRevision: 99,
        verdict: "approve",
      }),
    /changé/,
  );
  model.syncError = new Error("Native verification failed");
  await rejects(() => approvePendingChange(service), /verification/);
  equal(service.snapshot.configuration!.builder.admissionAuthority, "human");
  const interrupted = service.snapshot.configuration!.changes[0]!;
  equal(interrupted.status, "pending");
  equal(interrupted.authorityExercise, undefined);
  equal(interrupted.publication, undefined);
  model.syncError = undefined;
  await decideChange(service, {
    changeId: change.id,
    expectedRevision: 0,
    verdict: "approve",
  });
  equal(service.snapshot.configuration!.builder.admissionAuthority, "builder");
  const completed = service.snapshot.configuration!.changes[0]!;
  equal(completed.status, "approved");
  equal(completed.publication, undefined);
  ok(completed.authorityExercise);
  equal(model.configurations.length, 1);
  equal(service.snapshot.configuration!.revision, 1);
});

Deno.test("a candidate awaiting human admission never becomes retroactively delegated and settles before mandate publication", async () => {
  const { service, agents, model } = await setup([propose], null);
  await turn(service);
  const candidate = structuredClone(service.snapshot.candidates[0]!);
  agents.steps.push(mandateProposal);
  await turn(service, "Propose une délégation d’admission");
  const pending = structuredClone(service.snapshot.configuration!.changes[0]);
  const pin = structuredClone(service.snapshot.executionModel!.version);
  const source = await model.readExecutableModel(model.executable.identity);
  const worker = commandWorkers.get(service)!;
  const promotions = await worker.native.execution.inspect(identity.builderId);
  const promotion = promotions.find((execution) =>
    execution.threadId === candidate.promotionExecution!.threadId
  )!;
  ok(promotion);
  equal(promotion.status, "waiting");
  equal(
    candidate.promotionCursor,
    undefined,
    "The actual native owner must block even without a legacy cursor",
  );
  const providerCalls = agents.contexts.length;
  await rejects(() =>
    decideChange(service, {
      changeId: pending.id,
      expectedRevision: pending.baseRevision,
      verdict: "approve",
    }), {
    message:
      "Une promotion native suspendue doit être terminée avant cette publication ; la proposition reste en attente.",
  });
  deepStrictEqual(service.snapshot.configuration!.changes[0], pending);
  deepStrictEqual(service.snapshot.executionModel!.version, pin);
  deepStrictEqual(service.snapshot.candidates[0], candidate);
  deepStrictEqual(
    await model.readExecutableModel(
      source.identity,
      source.version.repositoryVersion,
    ),
    source,
  );
  equal(model.changeApplications, 0);
  equal(model.configurations.length, 0);
  equal(agents.contexts.length, providerCalls);
  equal(agents.admissions.length, 0);
  deepStrictEqual(
    (await worker.native.execution.inspect(identity.builderId)).find((
      execution,
    ) => execution.threadId === promotion.threadId),
    promotion,
  );

  // Settle the old proposal while its source is still exact. Human admission
  // then publishes the original candidate, so any new proposal uses that
  // actual catalog/source base rather than rebasing the old approval.
  agents.steps.push(reply);
  await decideChange(service, {
    changeId: pending.id,
    expectedRevision: pending.baseRevision,
    verdict: "refuse",
  });
  agents.steps.push(reply);
  await decideCandidate(service, {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "J’ai examiné ce candidat initial",
  });
  equal(service.snapshot.candidates[0].requiredAuthority, "human");
  equal(service.snapshot.candidates[0].admission!.authority, "human");
  equal(service.snapshot.candidates[0].stage, "active");
  equal(agents.admissions.length, 0);
  equal(model.added.filter((entry) => entry.id === candidate.id).length, 1);
  equal(
    service.snapshot.events.some((event) =>
      event.kind === "promotion-continuation-rebound"
    ),
    false,
    "No old promotion is migrated to another contract",
  );
  agents.steps.push(mandateProposal);
  await turn(service, "Repropose ce mandat après la décision humaine terminée");
  const reproposed = service.snapshot.configuration!.changes.find((change) =>
    change.status === "pending"
  )!;
  ok(reproposed.id !== pending.id);
  await approvePendingChange(service);
  equal(service.snapshot.configuration!.builder.admissionAuthority, "builder");
  equal(model.changeApplications, 1);
  agents.steps.push({
    ...propose,
    tool: { ...draft, name: "Prepared after the admitted mandate" },
  }, reply);
  await turn(service, "Prépare un nouveau candidat sous le mandat admis");
  equal(service.snapshot.candidates[0].admission!.authority, "human");
  equal(service.snapshot.candidates[1].admission!.authority, "builder");
  equal(service.snapshot.candidates[1].stage, "active");
  equal(agents.admissions.length, 1);
});

Deno.test("a builder admission refusal or mismatched digest cannot activate a candidate", async () => {
  for (const verdict of ["refuse", "wrong-digest"] as const) {
    const { service, agents } = await setup([mandateProposal], null);
    await turn(service);
    await approvePendingChange(service);
    agents.admissionStep = (candidate) => ({
      candidateDigest: verdict === "wrong-digest" ? "other" : candidate.digest,
      verdict: "refuse",
      reason: "Builder refuses this exact candidate",
    });
    agents.steps.push(propose, reply);
    await turn(service, "Crée un outil");
    equal(service.snapshot.catalogRevision, 0);
    equal(
      service.snapshot.candidates[0]!.stage,
      verdict === "refuse" ? "refused" : "failed",
    );
    equal(service.snapshot.candidates[0]!.admission, undefined);
    equal(agents.admissions.length, 1);
  }
});

Deno.test("an explicit human admission cannot make an unverified native activation callable", async () => {
  const { service, model, runner } = await setup([propose], null);
  await turn(service);
  const candidate = service.snapshot.candidates[0]!;
  model.failActivation = true;
  await rejects(
    () =>
      decideCandidate(service, {
        candidateId: candidate.id,
        candidateDigest: candidate.digest,
        verdict: "approve",
        reason: "J’admets le candidat testé",
      }),
    /readback failed/,
  );
  equal(service.snapshot.candidates[0]!.stage, "activating");
  equal(
    service.snapshot.candidates[0]!.activationModelDigest,
    model.executable.version.digest,
  );
  equal(model.executable.catalog.length, 0);
  equal(service.snapshot.catalogRevision, 0);
  equal(service.snapshot.busy, false);
  equal(service.snapshot.phase, "Décision interrompue");
  ok(service.snapshot.error!.includes("readback failed"));
  equal(runner.calls.length, 0);
  equal(service.snapshot.events.some((e) => e.kind === "tool-active"), false);
});

Deno.test("the same conversation receives invalid-call feedback and corrects its arguments", async () => {
  const active = await activeCandidate();
  const { service, agents, runner } = await setup(
    [
      invoke(active.id, "example.org"),
      (context) => {
        equal(context.lastToolFailure?.code, "URL_INVALID");
        ok(context.mandate?.network.allowedHosts.includes("example.org"));
        ok(context.messages.at(-1)?.role === "tool");
        return invoke(active.id, "https://example.org/");
      },
      (context) => {
        equal(context.lastToolFailure, undefined);
        return reply;
      },
    ],
    saved([active]),
    { retainActiveSources: true },
  );
  await turn(service, "Lis example.org");
  equal(agents.contexts.length, 3);
  equal(runner.calls.length, 1);
  equal(runner.calls[0]!.input.url, "https://example.org/");
  equal(service.snapshot.messages.filter((m) => m.role === "user").length, 1);
  equal(service.snapshot.error, undefined);
  equal(service.snapshot.lastToolFailure, undefined);
});

const networkProposal = (host: string): ChatDecision => ({
  kind: "propose_mandate_change",
  text: "L’appel a été refusé : je propose une portée réseau ciblée.",
  reason: "Lire la page explicitement demandée nécessite cet hôte exact.",
  requestedRights: { addNetworkHosts: [host] },
});

function scopeBoundInvocation(
  candidate: Candidate,
  input: { url: string },
  scope: NetworkScope,
): PageResult {
  const host = new URL(input.url).hostname;
  if (!scope.allowedHosts.includes(host)) {
    throw new ToolInvocationError({
      code: "NETWORK_SCOPE_DENIED",
      message: "Cet hôte exact ne figure pas dans le mandat réseau courant.",
      retryable: false,
      toolId: candidate.id,
      url: input.url,
      missingPermission: { kind: "network-host", host },
      allowedHosts: scope.allowedHosts,
    });
  }
  return { url: input.url, title: "Observed page", text: "Observed result" };
}

Deno.test("network refusal returns to the agent, awaits an exact mandate decision and resumes the original request", async () => {
  const active = await activeCandidate();
  const host = "research.example.net";
  const url = `https://${host}/guides/start?mode=full`;
  const { service, agents, runner, model } = await setup(
    [
      invoke(active.id, url),
      (context) => {
        equal(context.lastToolFailure?.code, "NETWORK_SCOPE_DENIED");
        equal(context.lastToolFailure?.url, url);
        equal(context.lastToolFailure?.missingPermission?.host, host);
        ok(!context.mandate!.network.allowedHosts.includes(host));
        ok(
          context.mandate!.supportedChanges.some((c) =>
            c.requestedRights === "addNetworkHosts"
          ),
        );
        return networkProposal(host);
      },
      (context) => {
        ok(context.mandate!.network.allowedHosts.includes(host));
        equal(context.lastToolFailure?.url, url);
        return invoke(active.id, url);
      },
      (context) => {
        equal(context.lastToolFailure, undefined);
        return reply;
      },
    ],
    saved([active]),
    { retainActiveSources: true },
  );
  runner.invokeStep = scopeBoundInvocation;
  const systemId = service.snapshot.id;
  await turn(service, `Lis ${host}/guides/start?mode=full`);
  equal(service.snapshot.configuration!.changes.at(-1)!.status, "pending");
  ok(
    !networkScopeFor(service.snapshot.configuration).allowedHosts.includes(
      host,
    ),
  );
  equal(runner.calls.length, 1);
  equal(agents.contexts.length, 2);
  await approvePendingChange(service);
  equal(service.snapshot.id, systemId);
  equal(runner.calls.length, 2);
  equal(runner.calls[1]!.input.url, url);
  ok(runner.scopes[1]!.allowedHosts.includes(host));
  equal(service.snapshot.configuration!.builder.admissionAuthority, "reviewer");
  equal(service.snapshot.configuration!.changes.at(-1)!.status, "approved");
  equal(model.configurations.length, 1);
  equal(service.snapshot.lastToolFailure, undefined);
  equal(service.snapshot.messages.filter((m) => m.role === "user").length, 1);
  equal(service.snapshot.error, undefined);
});

Deno.test("refusing the network change cannot resume or widen the blocked request", async () => {
  const active = await activeCandidate(), host = "notes.example.net";
  const { service, runner, agents } = await setup(
    [
      invoke(active.id, `https://${host}/`),
      networkProposal(host),
    ],
    saved([active]),
    { retainActiveSources: true },
  );
  runner.invokeStep = scopeBoundInvocation;
  await turn(service, host);
  const config = service.snapshot.configuration!,
    change = config.changes.at(-1)!;
  agents.steps.push(reply);
  await decideChange(service, {
    changeId: change.id,
    expectedRevision: config.revision,
    verdict: "refuse",
  });
  equal(runner.calls.length, 1);
  ok(
    !networkScopeFor(service.snapshot.configuration).allowedHosts.includes(
      host,
    ),
  );
  equal(service.snapshot.lastToolFailure?.code, "NETWORK_SCOPE_DENIED");
  equal(service.snapshot.configuration!.changes.at(-1)!.status, "refused");
});

Deno.test("unchanged repeated failures are bounded and do not become false agent success", async () => {
  const active = await activeCandidate();
  const { service, runner, agents } = await setup(
    [
      invoke(active.id),
      invoke(active.id),
      reply,
    ],
    saved([active]),
    { retainActiveSources: true },
  );
  runner.invokeStep = (candidate, input) => {
    throw new ToolInvocationError({
      code: "FETCH_TIMEOUT",
      message: "La lecture a dépassé le délai.",
      retryable: true,
      toolId: candidate.id,
      url: input.url,
    });
  };
  await turn(service);
  equal(runner.calls.length, 2);
  equal(agents.contexts.length, 3);
  equal(service.snapshot.lastToolFailure?.code, "REPEATED_FAILURE");
  equal(service.snapshot.busy, false);
  equal(service.snapshot.error, undefined);
  equal(
    service.snapshot.events.some((event) => event.kind === "tool-completed"),
    false,
  );
});

Deno.test("a new user task clears suspended recovery and cannot authorize an obsolete URL", async () => {
  const active = await activeCandidate(), host = "old-request.example.net";
  const { service, runner, agents } = await setup(
    [
      invoke(active.id, `https://${host}/`),
      networkProposal(host),
      (context) => {
        equal(context.lastToolFailure, undefined);
        return reply;
      },
    ],
    saved([active]),
    { retainActiveSources: true },
  );
  runner.invokeStep = scopeBoundInvocation;
  await turn(service, host);
  const configuration = service.snapshot.configuration!,
    change = configuration.changes.at(-1)!;
  await turn(service, "Oublie la page précédente. Lis https://example.org/new");
  agents.steps.push(reply);
  await decideChange(service, {
    changeId: change.id,
    expectedRevision: configuration.revision,
    verdict: "approve",
  });
  equal(
    runner.calls.length,
    1,
    "Approving an old scope resumed an obsolete request",
  );
  agents.steps.push(invoke(active.id, `https://${host}/`), reply);
  await turn(service, "Lis https://example.org/new");
  equal(
    runner.calls.length,
    1,
    "Historical URL escaped the current request boundary",
  );
  equal(service.snapshot.lastToolFailure?.code, "URL_NOT_USER_SUPPLIED");
});

Deno.test("native promotion guard changes the executed branch without a service change", async () => {
  const { service, model, runner, agents } = await setup([propose, reply]);
  const graph = structuredClone(PROMOTION);
  const guard = graph.edges.find((edge) =>
    edge.guard === "test.result.passed"
  )!;
  ok(guard);
  guard.guard = "false";
  model.executable.flows.promotion = compileModelFlow(graph, {
    rootNativeId: "6ba729a0-81e7-435e-80ce-749f239b3b0d",
    maxSteps: 128,
  });
  model.executable.version.digest = "native-guard-refusal";
  await service.adoptModelVersion({ expectedDigest: "native-guard-refusal" });
  await turn(service);
  equal(runner.tests.length, 1);
  equal(runner.report.passed, true);
  equal(agents.reviews.length, 0);
  equal(service.snapshot.candidates[0]!.stage, "refused");
  equal(model.stages.includes("active"), false);
});

Deno.test("native action ordering can suspend before an agent decision", async () => {
  const { service, model, agents } = await setup([reply]);
  const graph = structuredClone(CONVERSATION);
  const compiled = model.executable.flows.conversation;
  const read = compiled.nodes.find((node) => node.mechanism === "read_case")!;
  const wait = compiled.nodes.find((node) => node.mechanism === "await_input")!;
  const swap = (id: string) =>
    id === read.id ? wait.id : id === wait.id ? read.id : id;
  for (const edge of graph.edges.filter((edge) => edge.kind === "succession")) {
    edge.source = swap(edge.source);
    edge.target = swap(edge.target);
    edge.sourceFeaturePath = [edge.source];
    edge.targetFeaturePath = [edge.target];
  }
  model.executable.flows.conversation = compileModelFlow(graph, {
    rootNativeId: "4c04d8e9-804b-461e-bb9b-e93d835f9e43",
    maxSteps: 128,
  });
  model.executable.version.digest = "native-wait-first";
  await service.adoptModelVersion({ expectedDigest: "native-wait-first" });
  await turn(service);
  equal(agents.contexts.length, 0);
  equal(service.snapshot.error, undefined);
  ok(service.snapshot.events.some((event) => event.kind === "flow-suspended"));
});

Deno.test("native permission changes are passed to the agent and enforced at the mechanism", async () => {
  const { service, model, agents, runner } = await setup([propose]);
  model.executable.mandate.mayPropose = [];
  model.executable.mandate.mayInvoke = false;
  model.executable.contracts = [];
  model.executable.version.digest = "native-no-capabilities";
  await service.adoptModelVersion({ expectedDigest: "native-no-capabilities" });
  await refusedTurn(
    service,
    /^Le mandat natif ne permet pas ce type de candidat\.$/,
  );
  deepStrictEqual(agents.contexts[0]!.mandate!.mayPropose, []);
  equal(agents.contexts[0]!.mandate!.mayInvoke, false);
  deepStrictEqual(agents.contexts[0]!.contracts, []);
  equal(model.added.length, 0);
  equal(runner.tests.length, 0);
  ok(service.snapshot.error?.includes("ne permet pas"));
  // Missing permission and missing contract are separate initial source
  // conditions. The failed native owner above remains pinned and is not
  // implicitly migrated to make another condition executable.
  const missing = await setup([propose, reply], saved(), {
    configureModel: (native) => {
      native.mandate.mayPropose = [...TOOL_KINDS];
      native.contracts = [];
      native.version.digest = "native-missing-contract";
    },
  });
  await turn(missing.service);
  equal(missing.agents.reviews.length, 0);
  equal(missing.runner.tests.length, 0);
  equal(missing.model.added.length, 0);
  equal(missing.service.snapshot.candidates[0]!.stage, "failed");
  ok(missing.service.snapshot.candidates[0]!.error?.includes("contrat unique"));
});

Deno.test("a native version change while the agent is pending blocks its stale decision", async () => {
  const active = await activeCandidate();
  let enter!: () => void, finish!: (decision: ChatDecision) => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const answer = new Promise<ChatDecision>((resolve) => {
    finish = resolve;
  });
  const { service, model, runner } = await setup(
    [() => {
      enter();
      return answer;
    }],
    saved([active]),
    { retainActiveSources: true },
  );
  const admitted = service.snapshot.executionModel!.version.digest;
  const worker = commandWorkers.get(service)!;
  const beforeAccepted = worker.deliveries.length;
  await service.submit("Lis https://example.org/");
  const acceptedInput = worker.deliveries.slice(beforeAccepted);
  equal(acceptedInput.length, 1);
  await entered;
  model.executable.version.digest = "native-external-version";
  model.executable.mandate.mayInvoke = false;
  finish(invoke(active.id));
  await rejects(() => service.idle(), /admission explicite/);
  await failedContributionReceipt(
    service,
    acceptedInput[0],
    /admission explicite/,
  );
  equal(runner.calls.length, 0);
  equal(service.snapshot.executionModel!.version.digest, admitted);
  equal(
    service.snapshot.availableExecutionModel!.version.digest,
    "native-external-version",
  );
  ok(service.snapshot.error?.includes("admission explicite"));
  equal(
    service.snapshot.events.some((event) => event.kind === "tool-called"),
    false,
  );
});

Deno.test("explicit exact catalog adoption defeats a cached active tool without semantic digest drift", async () => {
  const active = await activeCandidate();
  const { service, model, agents, runner } = await setup(
    [invoke(active.id), reply],
    saved([active]),
    { retainActiveSources: true },
  );
  const admitted = structuredClone(service.snapshot.executionModel!.version);
  model.executable.catalog[0]!.status = "refused";
  const changed = await model.readExecutableModel(model.executable.identity);
  equal(changed.version.digest, admitted.digest);
  const repositoryVersion = changed.version.repositoryVersion;
  ok(repositoryVersion && repositoryVersion !== admitted.repositoryVersion);
  equal(
    service.snapshot.candidates[0].stage,
    "active",
    "The cached candidate alone cannot authorize invocation",
  );
  await service.adoptModelVersion({
    expectedDigest: changed.version.digest,
    expectedVersion: repositoryVersion,
  });
  deepStrictEqual(service.snapshot.executionModel!.version, changed.version);
  await turn(service);
  equal(agents.contexts[0]!.activeTools.length, 0);
  equal(agents.contexts[1]!.activeTools.length, 0);
  equal(runner.calls.length, 0);
  equal(service.snapshot.candidates[0].stage, "active");
  equal(service.snapshot.lastToolFailure?.code, "TOOL_UNAVAILABLE");
});

Deno.test("source-only catalog HEAD advancement during a provider call preserves the exact admitted invocation", async () => {
  const active = await activeCandidate();
  let changed: ExecutableModel | undefined;
  const { service, model, agents, runner } = await setup(
    [
      async () => {
        model.executable.catalog[0]!.status = "refused";
        changed = await model.readExecutableModel(model.executable.identity);
        return invoke(active.id);
      },
      reply,
    ],
    saved([active]),
    { retainActiveSources: true },
  );
  const admitted = structuredClone(service.snapshot.executionModel!.version);
  ok(admitted.repositoryVersion);
  await turn(service);
  ok(changed);
  equal(changed.version.digest, admitted.digest);
  ok(changed.version.repositoryVersion !== admitted.repositoryVersion);
  equal(changed.catalog[0].status, "refused");
  const retained = await model.readExecutableModel(
    model.executable.identity,
    admitted.repositoryVersion,
  );
  equal(retained.catalog[0].status, "active");
  deepStrictEqual(service.snapshot.executionModel!.version, admitted);
  for (const context of agents.contexts) {
    equal(context.activeTools.length, 1);
    equal(context.modelVersion!.digest, admitted.digest);
    equal(context.modelVersion!.repositoryVersion, admitted.repositoryVersion);
  }
  equal(runner.calls.length, 1);
  equal(service.snapshot.lastToolFailure, undefined);
  const called = service.snapshot.events.filter((event) =>
    event.kind === "tool-called"
  );
  equal(called.length, 1);
  equal(called[0].execution!.digest, admitted.digest);
  equal(called[0].execution!.repositoryVersion, admitted.repositoryVersion);
  equal(
    service.snapshot.events.some((event) =>
      event.kind === "model-version-admitted"
    ),
    false,
  );
});

Deno.test("admitted native URL policy allows agent selection only within its runner network scope", async () => {
  const active = await activeCandidate();
  const { service, model, runner } = await setup(
    [
      invoke(active.id, "https://example.org/chosen"),
      reply,
    ],
    saved([active]),
    { retainActiveSources: true },
  );
  runner.invokeStep = scopeBoundInvocation;
  model.executable.policy.urlSelectionMode = "authorized-host";
  model.executable.version.digest = "native-authorized-url";
  await rejects(
    () => service.adoptModelVersion({ expectedDigest: "wrong-version" }),
    /changé/,
  );
  await service.adoptModelVersion({ expectedDigest: "native-authorized-url" });
  await turn(service, "Choisis une page pertinente dans ton mandat.");
  equal(runner.calls.length, 1);
  equal(runner.calls[0]!.input.url, "https://example.org/chosen");
  ok(runner.scopes[0]!.allowedHosts.includes("example.org"));
  equal(service.snapshot.error, undefined);
});

Deno.test("actions and physical effects retain their admitted model digest and native action identity", async () => {
  const { service, runner } = await setup([
    propose,
    (context) => invoke(context.activeTools[0]!.id),
    reply,
  ]);
  const admitted = service.snapshot.executionModel!;
  await turn(service);
  equal(runner.calls.length, 1);
  const actionIds = new Set(
    [...admitted.flows.conversation.nodes, ...admitted.flows.promotion.nodes]
      .map((node) => node.nativeId),
  );
  for (
    const event of service.snapshot.events.filter((event) =>
      [
        "flow-action",
        "tool-proposed",
        "admission-decided",
        "tool-active",
        "tool-called",
        "tool-completed",
      ].includes(event.kind)
    )
  ) {
    equal(event.execution?.digest, admitted.version.digest);
    ok(
      event.execution?.actionId && actionIds.has(event.execution.actionId),
      event.kind,
    );
  }
  for (
    const message of service.snapshot.messages.filter((message) =>
      message.role !== "user" &&
      message.text !== service.snapshot.messages[0]!.text
    )
  ) {
    equal(message.execution?.digest, admitted.version.digest);
    ok(
      message.execution?.actionId && actionIds.has(message.execution.actionId),
      message.text,
    );
  }
});

Deno.test("restart keeps an admitted source version and exposes an external version for explicit adoption", async () => {
  const { service, model, agents, runner, store } = await setup([reply]);
  const admitted = service.snapshot.executionModel!.version.digest;
  model.executable.version.digest = "native-restart-version";
  const restarted = openRuntime({ model, agents, runner, store });
  await restarted.initialize();
  equal(restarted.snapshot.executionModel!.version.digest, admitted);
  equal(
    restarted.snapshot.availableExecutionModel!.version.digest,
    "native-restart-version",
  );
  await refusedTurn(restarted, /admission explicite/);
  equal(agents.contexts.length, 0);
  ok(restarted.snapshot.error?.includes("admission explicite"));
  await restarted.adoptModelVersion({
    expectedDigest: "native-restart-version",
  });
  agents.steps.push(reply);
  await turn(restarted);
  equal(restarted.snapshot.error, undefined);
});

Deno.test("explicit adoption checks the immutable source pin even when the executable digest is unchanged", async () => {
  const { service, model } = await setup([reply]);
  const before = service.snapshot.executionModel!;
  model.executable.version.repositoryVersion = "branch:concurrent-head";
  const admittedEvents =
    service.snapshot.events.filter((event) =>
      event.kind === "model-version-admitted"
    ).length;

  await rejects(() =>
    service.adoptModelVersion({
      expectedDigest: before.version.digest,
      expectedVersion: "branch:reviewed-head",
    }), /version du modèle a changé/);
  deepStrictEqual(service.snapshot.executionModel, before);
  equal(
    service.snapshot.events.filter((event) =>
      event.kind === "model-version-admitted"
    ).length,
    admittedEvents,
  );
  equal(service.snapshot.busy, false);

  await service.adoptModelVersion({
    expectedDigest: before.version.digest,
    expectedVersion: "branch:concurrent-head",
  });
  equal(
    service.snapshot.executionModel!.version.repositoryVersion,
    "branch:concurrent-head",
  );
  equal(
    service.snapshot.events.filter((event) =>
      event.kind === "model-version-admitted"
    ).length,
    admittedEvents + 1,
  );
});

/** Inspect the actual accepted human input, selected graph snapshot and official
 * saver together. Business cursor/context fields are not continuation evidence. */
async function nativeInputWait(service: SystemRuntime, inputMessageId: string) {
  const worker = commandWorkers.get(service);
  ok(worker);
  const delivery = worker.deliveries.find((entry) =>
    entry.kind === "contribution" && entry.id === inputMessageId
  );
  ok(delivery, "The input must come from the real accepted queue");
  const accepted = await worker.native.dispatch.inspectAccepted!(
    identity.builderId,
    delivery.id,
  );
  ok(accepted);
  deepStrictEqual(accepted.delivery, delivery);
  equal(accepted.receipt.id, delivery.id);
  equal(accepted.receipt.status, "completed");
  const owners = (await worker.native.execution.inspect(identity.builderId))
    .filter((snapshot) =>
      snapshot.contributionId === inputMessageId &&
      canonical(snapshot.identity) === canonical(delivery.identity)
    );
  equal(owners.length, 1, "The exact input must own one native execution");
  const snapshot = owners[0];
  equal(snapshot.identity.subjectId, inputMessageId);
  equal(snapshot.status, "waiting");
  ok(snapshot.threadId && snapshot.runId && snapshot.checkpointId);
  const checkpoints = (await worker.native.checkpoints()).filter((entry) =>
    entry.threadId === snapshot.threadId
  );
  equal(checkpoints.length, 1);
  const checkpoint = checkpoints[0];
  equal(checkpoint.runId, snapshot.runId);
  equal(checkpoint.checkpointId, snapshot.checkpointId);
  equal(checkpoint.checkpointNamespace, snapshot.checkpointNamespace);
  deepStrictEqual(checkpoint.request.identity, delivery.identity);
  deepStrictEqual(checkpoint.request.contribution, {
    id: inputMessageId,
    kind: "input",
    inputMessageId,
  });
  equal(snapshot.modelDigest, delivery.modelPin.modelDigest);
  equal(snapshot.repositoryVersion, delivery.modelPin.repositoryVersion);
  equal(snapshot.modelDigest, checkpoint.request.model.version.digest);
  equal(
    snapshot.repositoryVersion,
    checkpoint.request.model.version.repositoryVersion,
  );
  deepStrictEqual(
    checkpoint.values.modelPin?.version,
    checkpoint.request.model.version,
  );
  deepStrictEqual(
    checkpoint.values.modelPin?.identity,
    checkpoint.request.model.identity,
  );
  deepStrictEqual(checkpoint.values.executionScope, snapshot.identity.scope);
  const wait = checkpoint.request.flow.nodes.find((node) =>
    node.mechanism === "await_input"
  );
  ok(wait);
  equal(snapshot.flowRootId, checkpoint.request.flow.rootNativeId);
  deepStrictEqual(snapshot.waits, [{
    nodeId: wait.id,
    mechanism: "await_input",
    kind: "input",
  }]);
  equal(checkpoint.values.prepared?.nodeId, wait.id);
  equal(checkpoint.values.prepared?.result.suspend, true);
  deepStrictEqual(checkpoint.values.acceptedContributionIds, [inputMessageId]);
  deepStrictEqual(snapshot.unsettledEffects, []);
  deepStrictEqual(snapshot.openImmutableConsultationGroups ?? [], []);
  return { worker, snapshot, checkpoint };
}

Deno.test("the next human contribution owns its native input thread without consuming the prior wait", async () => {
  const { service, model, agents } = await setup([reply, reply]);
  const graph = structuredClone(CONVERSATION);
  const flow = model.executable.flows.conversation;
  const wait = flow.nodes.find((node) => node.mechanism === "await_input")!;
  const replyNode = flow.nodes.find((node) => node.mechanism === "reply")!;
  const returnEdge = graph.edges.find((edge) =>
    edge.kind === "succession" && edge.source === wait.id
  )!;
  returnEdge.target = replyNode.id;
  returnEdge.targetFeaturePath = [replyNode.nativeId];
  model.executable.flows.conversation = compileModelFlow(graph, {
    rootNativeId: "4c04d8e9-804b-461e-bb9b-e93d835f9e43",
    maxSteps: 128,
  });
  model.executable.version.digest = "native-wait-resumes-reply";
  await service.adoptModelVersion({
    expectedDigest: "native-wait-resumes-reply",
  });
  const caseId = await turn(service, "Première contribution", undefined, true);
  ok(caseId);
  equal(agents.contexts.length, 1);
  const firstInput = service.snapshot.messages.find((message) =>
    message.role === "user" && message.caseId === caseId
  );
  ok(firstInput);
  const first = await nativeInputWait(service, firstInput.id);
  equal(first.snapshot.identity.scope.kind, "request");
  equal(first.snapshot.identity.scope.scopeId, caseId);
  equal(first.snapshot.waits[0].nodeId, wait.id);
  // runtime-production-transition.md:59: human inputs are independent native
  // threads under the same Case. Only a correlated continuation consumes this
  // input's saved succession (covered by the human-admission test below).
  await turn(service, "Seconde contribution", caseId);
  equal(service.cases.cases.length, 1);
  equal(agents.contexts.length, 2);
  const secondInput = service.snapshot.messages.filter((message) =>
    message.role === "user" && message.caseId === caseId
  ).at(-1)!;
  ok(secondInput.id !== firstInput.id);
  const second = await nativeInputWait(service, secondInput.id);
  ok(second.snapshot.threadId !== first.snapshot.threadId);
  ok(second.snapshot.runId !== first.snapshot.runId);
  deepStrictEqual(
    second.snapshot.identity.scope,
    first.snapshot.identity.scope,
  );
  equal(
    second.snapshot.identity.invocationKey,
    first.snapshot.identity.invocationKey,
  );
  for (const observed of [first, second]) {
    deepStrictEqual(
      observed.checkpoint.request.flow,
      model.executable.flows.conversation,
    );
    // R4b: new executions journal observations per run instead of growing
    // the checkpoint trace; the admitted action order is read from the
    // scoped journal of each input's own run.
    deepStrictEqual(observed.checkpoint.values.trace ?? [], []);
    deepStrictEqual(
      observed.checkpoint.nativeObservations.filter((record) =>
        record.event.kind === "action"
      )
        .map((record) => record.event.actionId),
      [
        flow.nodes.find((node) => node.mechanism === "read_case")!.nativeId,
        flow.nodes.find((node) => node.mechanism === "choose_move")!.nativeId,
        replyNode.nativeId,
        wait.nativeId,
      ],
      "Each actual checkpoint follows the admitted flow from entry to its own wait",
    );
  }
  const retained = await nativeInputWait(service, firstInput.id);
  deepStrictEqual(retained.snapshot, first.snapshot);
  deepStrictEqual(retained.checkpoint, first.checkpoint);
  equal(
    service.snapshot.messages.filter((message) =>
      message.role === "assistant" && message.text === reply.text &&
      message.caseId === caseId
    ).length,
    2,
  );
  equal(service.snapshot.error, undefined);
});

Deno.test("restart retains the exact native input wait and a new input reads its own case without recursive context", async () => {
  const { service, model, agents, runner, store } = await setup([reply]);
  await turn(service, "Premier message");
  const firstInput = service.snapshot.messages.find((message) =>
    message.role === "user"
  );
  ok(firstInput);
  const before = await nativeInputWait(service, firstInput.id);
  const restarted = openRuntime({ model, agents, runner, store });
  await restarted.initialize();
  const reopened = await nativeInputWait(restarted, firstInput.id);
  deepStrictEqual(reopened.snapshot, before.snapshot);
  deepStrictEqual(reopened.checkpoint, before.checkpoint);
  agents.steps.push((context) => {
    equal(
      context.messages.filter((message) => message.role === "user").at(-1)!
        .text,
      "Nouveau message",
    );
    return reply;
  });
  await turn(restarted, "Nouveau message");
  equal(agents.contexts.length, 2);
  equal(restarted.snapshot.error, undefined);
  const nextInput = restarted.snapshot.messages.filter((message) =>
    message.role === "user"
  ).at(-1)!;
  const next = await nativeInputWait(restarted, nextInput.id);
  ok(next.snapshot.threadId !== before.snapshot.threadId);
  const values = next.checkpoint.values.values;
  ok(values);
  const read = values.readCaseState as { record?: Record<string, unknown> };
  ok(read.record);
  deepStrictEqual(
    Object.keys(read.record),
    ["__assemblyRuntimeRevision"],
    "The actual saver retains an exact business revision reference, never a copied dossier",
  );
  const hydrated = await hydrateRuntimeValues(
    values,
    next.worker.native.stateHistory,
    next.snapshot.identity,
  );
  const record = (hydrated.readCaseState as {
    record: Record<string, unknown>;
  }).record;
  equal(
    Object.hasOwn(record, "conversationContext"),
    false,
    "continuation storage must not recursively embed earlier contexts",
  );
  equal(Object.hasOwn(record, "conversationCursor"), false);
  equal(record.sessionId, restarted.snapshot.id);
  equal(
    (record.messages as Array<{ role: string; text: string }>)
      .filter((message) => message.role === "user").at(-1)!.text,
    "Nouveau message",
    "The exact native reference hydrates the newly accepted input in its own invocation",
  );
  deepStrictEqual(
    (await nativeInputWait(restarted, firstInput.id)).checkpoint,
    before.checkpoint,
  );
});

Deno.test("native decision budget bounds the flow before another provider call", async () => {
  const active = await activeCandidate();
  const { service, model, agents, runner } = await setup(
    [
      invoke(active.id),
      reply,
    ],
    saved([active]),
    { retainActiveSources: true },
  );
  model.executable.policy.maxAgentDecisions = 1;
  model.executable.version.digest = "native-one-decision";
  await service.adoptModelVersion({ expectedDigest: "native-one-decision" });
  await refusedTurn(
    service,
    /^La limite de décisions du modèle a été atteinte\.$/,
  );
  equal(runner.calls.length, 1);
  equal(agents.contexts.length, 1);
  ok(service.snapshot.error?.includes("limite de décisions"));
});

Deno.test("a publication return failure recovers the exact commit without a second source application", async () => {
  const { service, model } = await setup([mandateProposal], null);
  await turn(service);
  const admitted = service.snapshot.executionModel!.version.digest;
  const apply = model.applyApprovedChange.bind(model);
  model.applyApprovedChange = async (...args) => {
    await apply(...args);
    throw new Error("Lost publication return");
  };
  await approvePendingChange(service);
  equal(model.changeApplications, 1);
  equal(service.snapshot.configuration!.builder.admissionAuthority, "builder");
  const change = service.snapshot.configuration!.changes[0]!;
  equal(change.status, "approved");
  equal(change.authorityExercise?.baseModelDigest, admitted);
  equal(change.publication, undefined);
  await decideChange(service, {
    changeId: change.id,
    expectedRevision: change.baseRevision,
    verdict: "approve",
  });
  equal(model.changeApplications, 1);
});

Deno.test("an adapter without executable source support is rejected before initialization", async () => {
  const model = new FakeModel();
  Object.defineProperty(model, "readExecutableModel", { value: undefined });
  const service = openRuntime({
    model,
    agents: new FakeAgent(),
    runner: new FakeRunner(),
    store: new MemoryStore(),
  });
  await rejects(() => service.initialize(), /modèle exécutable natif/);
  equal(model.initializations.length, 0);
});

Deno.test("human tool admission resumes the native conversation wait with its actual outcome", async () => {
  const { service, model, runner, agents } = await setup([
    propose,
    (context) => {
      equal(context.activeTools.length, 1);
      ok(
        context.messages.some((message) =>
          message.role === "tool" && message.text.includes("ACTIF")
        ),
      );
      return reply;
    },
  ], null);
  await turn(service, "Construis un lecteur");
  const candidate = service.snapshot.candidates[0]!;
  const flow = model.executable.flows.conversation;
  const conversationIds = new Set(flow.nodes.map((node) => node.nativeId));
  const prior =
    service.snapshot.events.filter((event) =>
      event.kind === "flow-action" &&
      conversationIds.has(event.execution!.actionId!)
    ).length;
  await decideCandidate(service, {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Artefact et essais examinés",
  });
  const continuation = service.snapshot.events.filter((event) =>
    event.kind === "flow-action" &&
    conversationIds.has(event.execution!.actionId!)
  ).slice(prior);
  const byId = new Map(
    flow.nodes.map((node) => [node.nativeId, node.mechanism]),
  );
  deepStrictEqual(
    continuation.map((event) => byId.get(event.execution!.actionId!)),
    ["await_input", "read_case", "choose_move", "reply", "await_input"],
  );
  equal(agents.contexts.length, 2);
  equal(runner.calls.length, 0);
});

Deno.test("a native active declaration cannot create a missing local activation receipt on restart", async () => {
  const candidate = await activeCandidate({ stage: "failed" });
  const initial = saved([candidate]);
  const model = new FakeModel([], initial);
  model.executable.catalog[0]!.status = "active";
  const agents = new FakeAgent([invoke(candidate.id), reply]);
  const runner = new FakeRunner();
  const service = openRuntime({
    model,
    agents,
    runner,
    store: new MemoryStore(initial),
  });
  await service.initialize();
  equal(service.snapshot.candidates[0]!.stage, "failed");
  await turn(service);
  equal(runner.calls.length, 0);
  equal(service.snapshot.lastToolFailure?.code, "TOOL_UNAVAILABLE");
});

Deno.test("restart demotes a locally active artifact when the native catalog has revoked it without source writes", async () => {
  const candidate = await activeCandidate();
  const initial = saved([candidate]);
  const model = new FakeModel([], initial);
  model.executable.catalog[0]!.status = "refused";
  const service = openRuntime({
    model,
    agents: new FakeAgent(),
    runner: new FakeRunner(),
    store: new MemoryStore(initial),
  });
  await service.initialize();
  equal(service.snapshot.candidates[0]!.stage, "refused");
  deepStrictEqual(model.stages, []);
});

Deno.test("review receives the unique native contract for the candidate kind", async () => {
  const { service, model, agents } = await setup([propose, reply]);
  const exact = structuredClone(model.executable.contracts[0]!);
  model.executable.contracts.unshift({
    ...exact,
    nativeId: "unrelated-contract",
    kind: "read_web_page_outline",
    acceptanceCriteria: ["Unrelated criteria"],
  });
  model.executable.version.digest = "source-contract-reference-proof";
  await service.adoptModelVersion({
    expectedDigest: "source-contract-reference-proof",
  });
  await turn(service);
  equal(agents.reviews.length, 1);
  deepStrictEqual(agents.reviews[0]!.context!.contract, exact);
  equal(service.snapshot.candidates[0]!.stage, "active");
});

Deno.test("promotion rejects absent and ambiguous native contracts before sandbox or review", async () => {
  for (const mode of ["absent", "ambiguous"] as const) {
    const { service, model, agents, runner } = await setup(
      [propose, reply],
      saved(),
      {
        configureModel: (initialModel) => {
          if (mode === "absent") initialModel.contracts.shift();
          else {initialModel.contracts.push(
              structuredClone(initialModel.contracts[0]!),
            );}
        },
      },
    );
    await turn(service);
    equal(agents.reviews.length, 0);
    equal(runner.tests.length, 0);
    equal(service.snapshot.candidates[0]!.stage, "failed");
    ok(service.snapshot.candidates[0]!.error?.includes("contrat unique"));
    equal(model.stages.includes("active"), false);
  }
});

Deno.test("review and admission execute as distinct native actions with separate evidence", async () => {
  const { service, agents } = await setup([propose, reply]);
  await turn(service);
  const state = service.snapshot;
  const review = state.events.find((event) => event.kind === "review-decided")!;
  const admission = state.events.find((event) =>
    event.kind === "admission-decided"
  )!;
  ok(review);
  ok(admission);
  ok(review.execution!.actionId !== admission.execution!.actionId);
  equal(
    review.execution!.actionId,
    state.candidates[0]!.reviewExecution!.actionId,
  );
  equal(state.candidates[0]!.reviewExecution!.reviewerId, "reviewer");
  equal(
    state.candidates[0]!.reviewExecution!.modelDigest,
    state.executionModel!.version.digest,
  );
  equal(agents.reviews.length, 1);
  equal(agents.admissions.length, 0);
  equal(state.candidates[0]!.admission!.authority, "reviewer");
});

Deno.test("native review refusal branches before admission and feeds its actual reason back", async () => {
  const { service, agents } = await setup([propose, reply]);
  agents.reviewStep = (candidate) => ({
    candidateDigest: candidate.digest,
    verdict: "refuse",
    reason: "Native reviewer rejects the parser",
  });
  await turn(service);
  const state = service.snapshot;
  equal(state.candidates[0]!.stage, "refused");
  equal(state.candidates[0]!.admissionDecision, undefined);
  equal(state.events.some((event) => event.kind === "review-decided"), true);
  equal(
    state.events.some((event) => event.kind === "admission-decided"),
    false,
  );
  ok(
    state.messages.some((message) =>
      message.role === "tool" &&
      message.text.includes("Native reviewer rejects the parser")
    ),
  );
});

Deno.test("a positive review alone grants no admission or activation", async () => {
  const { service, model, agents } = await setup([propose, reply]);
  const flow = model.executable.flows.promotion;
  const review = flow.nodes.find((node) =>
    node.mechanism === "review_candidate"
  )!;
  const completion = flow.nodes.find((node) => node.name === "completion")!;
  flow.edges.find((edge) => edge.source === review.id)!.target = completion.id;
  model.executable.version.digest = "review-without-admission";
  await service.adoptModelVersion({
    expectedDigest: "review-without-admission",
  });
  await turn(service);
  equal(agents.reviews.length, 1);
  equal(service.snapshot.candidates[0]!.review!.verdict, "approve");
  equal(service.snapshot.candidates[0]!.admission, undefined);
  equal(model.stages.includes("active"), false);
});

Deno.test("the admission gate never calls a reviewer to replace a skipped native review", async () => {
  const { service, model, agents } = await setup([propose, reply]);
  const flow = model.executable.flows.promotion;
  const review = flow.nodes.find((node) =>
    node.mechanism === "review_candidate"
  )!;
  const admit = flow.nodes.find((node) =>
    node.mechanism === "decide_admission"
  )!;
  flow.edges.find((edge) => edge.target === review.id)!.target = admit.id;
  flow.bindings = flow.bindings.filter((binding) =>
    binding.targetPath.join(".") !== "admit.review"
  );
  admit.inputs = admit.inputs.filter((input) => input !== "review");
  model.onAdd = (candidate) => {
    candidate.review = {
      candidateDigest: candidate.digest,
      verdict: "approve",
      reason: "Cached provider approval without native execution",
    };
  };
  model.executable.version.digest = "skipped-native-review";
  await service.adoptModelVersion({ expectedDigest: "skipped-native-review" });
  await turn(service);
  equal(agents.reviews.length, 0);
  equal(service.snapshot.candidates[0]!.stage, "failed");
  ok(service.snapshot.candidates[0]!.error!.includes("revue native"));
  equal(model.stages.includes("active"), false);
});

Deno.test("review rejects another performer or mismatched native candidate and test bindings", async () => {
  for (const fault of ["performer", "candidate", "tests", "review"] as const) {
    const { service, model, agents } = await setup([propose, reply]);
    const flow = model.executable.flows.promotion;
    const review = flow.nodes.find((node) =>
      node.mechanism === "review_candidate"
    )!;
    if (fault === "performer") review.performerId = "builder";
    else {
      const target = fault === "review" ? "admit.review" : `review.${fault}`;
      const binding = flow.bindings.find((binding) =>
        binding.targetPath.join(".") === target
      )!;
      binding.sourcePath = fault === "candidate"
        ? ["test", "result"]
        : ["propose", "candidate"];
    }
    model.executable.version.digest = `wrong-review-${fault}`;
    await service.adoptModelVersion({
      expectedDigest: model.executable.version.digest,
    });
    await turn(service);
    equal(service.snapshot.candidates[0]!.stage, "failed");
    equal(agents.reviews.length, fault === "review" ? 1 : 0);
    equal(service.snapshot.candidates[0]!.admission, undefined);
    equal(model.stages.includes("active"), false);
  }
});

/** A parked admission is proved by its exact native owner and official prepared
 * action/effect, not by the removed business promotion cursor. */
async function parkedPromotion(service: SystemRuntime, candidate: Candidate) {
  equal(candidate.stage, "awaiting-admission");
  equal(candidate.requiredAuthority, "human");
  equal(candidate.promotionCursor, undefined);
  const reference = candidate.promotionExecution;
  const worker = commandWorkers.get(service);
  ok(worker && reference?.threadId && reference.inputMessageId);
  const state = service.snapshot;
  const invocation = candidateCaseInvocation(state, candidate);
  ok(invocation);
  const source = {
    ...state,
    caseInvocation: invocation,
    activeInputMessageId: reference.inputMessageId,
  };
  equal(invocationInput(source, invocation)?.id, reference.inputMessageId);
  const expectedIdentity = nativeExecutionIdentity(
    source,
    "promotion",
    reference.subjectId,
  );
  const owners = (await worker.native.execution.inspect(identity.builderId))
    .filter((snapshot) => snapshot.threadId === reference.threadId);
  equal(owners.length, 1);
  const snapshot = owners[0];
  deepStrictEqual(snapshot.identity, expectedIdentity);
  equal(snapshot.modelDigest, reference.modelDigest);
  equal(snapshot.localState?.promotionId, candidate.id);
  equal(snapshot.status, "waiting");
  ok(snapshot.runId && snapshot.checkpointId);
  const checkpoints = (await worker.native.checkpoints()).filter((checkpoint) =>
    checkpoint.threadId === snapshot.threadId
  );
  equal(checkpoints.length, 1);
  const checkpoint = checkpoints[0];
  equal(checkpoint.runId, snapshot.runId);
  equal(checkpoint.checkpointId, snapshot.checkpointId);
  equal(checkpoint.checkpointNamespace, snapshot.checkpointNamespace);
  deepStrictEqual(checkpoint.request.identity, expectedIdentity);
  equal(checkpoint.request.contribution.id, snapshot.contributionId);
  equal(
    checkpoint.request.contribution.inputMessageId,
    reference.inputMessageId,
  );
  equal(checkpoint.request.model.version.digest, reference.modelDigest);
  equal(
    checkpoint.request.model.version.repositoryVersion,
    snapshot.repositoryVersion,
  );
  deepStrictEqual(
    checkpoint.values.modelPin?.version,
    checkpoint.request.model.version,
  );
  const admission = checkpoint.request.flow.nodes.find((node) =>
    node.mechanism === "decide_admission"
  );
  ok(admission);
  equal(snapshot.flowRootId, checkpoint.request.flow.rootNativeId);
  deepStrictEqual(snapshot.waits, [{
    nodeId: admission.id,
    mechanism: "decide_admission",
    kind: "decision",
  }]);
  const prepared = checkpoint.values.prepared;
  ok(prepared);
  equal(prepared.nodeId, admission.id);
  equal(prepared.result.suspend, true);
  equal(prepared.result.suspensionKind, "decision");
  const receipts = checkpoint.effects.filter((effect) =>
    effect.key === prepared.effectKey
  );
  equal(receipts.length, 1);
  equal(receipts[0].node.nativeId, admission.nativeId);
  equal(receipts[0].settled, true);
  equal((receipts[0].result as { suspend?: boolean }).suspend, true);
  equal(
    checkpoint.effects.some((effect) =>
      effect.node.mechanism === "activate_candidate"
    ),
    false,
  );
  deepStrictEqual(snapshot.unsettledEffects, []);
  deepStrictEqual(snapshot.openImmutableConsultationGroups ?? [], []);
  return { snapshot, checkpoint };
}

Deno.test("adoption rejects changing a suspended promotion graph while preserving its dossier", async () => {
  const { service, model, agents, runner } = await setup([propose], null);
  await turn(service);
  const before = service.snapshot;
  const candidate = before.candidates[0]!;
  const nativeBefore = await parkedPromotion(service, candidate);
  const callsBefore = [
    agents.contexts.length,
    agents.reviews.length,
    agents.admissions.length,
    runner.tests.length,
    runner.calls.length,
    model.activationCalls,
    model.changeApplications,
    model.added.length,
    model.configurations.length,
  ];
  model.executable.flows.promotion.edges[0]!.nativeId = "new-promotion-edge";
  model.executable.version.digest = "new-suspended-promotion";
  await rejects(
    () =>
      service.adoptModelVersion({ expectedDigest: "new-suspended-promotion" }),
    {
      name: "EvolutionError",
      code: "EVOLUTION_BOUNDARY_UNSAFE",
      message: /A candidate, promotion or activation remains unsettled/,
    },
  );
  deepStrictEqual(service.snapshot.executionModel, before.executionModel);
  deepStrictEqual(
    await parkedPromotion(service, service.snapshot.candidates[0]!),
    nativeBefore,
  );
  deepStrictEqual(service.snapshot.candidates[0], candidate);
  deepStrictEqual(service.snapshot.messages, before.messages);
  equal(service.snapshot.catalogRevision, before.catalogRevision);
  deepStrictEqual(
    service.snapshot.events.filter((event) =>
      event.kind === "model-version-admitted"
    ),
    before.events.filter((event) => event.kind === "model-version-admitted"),
  );
  deepStrictEqual(
    [
      agents.contexts.length,
      agents.reviews.length,
      agents.admissions.length,
      runner.tests.length,
      runner.calls.length,
      model.activationCalls,
      model.changeApplications,
      model.added.length,
      model.configurations.length,
    ],
    callsBefore,
    "Refused adoption cannot call a provider, rerun tests, activate or publish",
  );
});

Deno.test("review allocation uses native identity while review context and receipt use logical actor identity", async () => {
  const { service, model, agents } = await setup([propose, reply]);
  model.executable.configuration.reviewer!.id = "logical-reviewer";
  model.executable.version.digest = "logical-native-reviewer-identities";
  await service.adoptModelVersion({
    expectedDigest: model.executable.version.digest,
  });
  await turn(service);
  equal(service.snapshot.candidates[0]!.stage, "active");
  equal(agents.reviews[0]!.context!.reviewerId, "logical-reviewer");
  equal(
    service.snapshot.candidates[0]!.reviewExecution!.reviewerId,
    "logical-reviewer",
  );
  equal(service.snapshot.candidates[0]!.admission!.actorId, "logical-reviewer");
  equal(model.executable.identity.reviewerId, "reviewer");
});

Deno.test("reviewer creation is rejected before native publication while human promotion is suspended", async () => {
  const { service, model, agents, runner } = await setup([propose], null);
  await turn(service);
  const candidate = service.snapshot.candidates[0]!;
  equal(candidate.stage, "awaiting-admission");
  agents.steps.push(reviewerProposal);
  await turn(service, "Propose la création du reviewer");
  const pending = service.snapshot.configuration!.changes.find((change) =>
    change.status === "pending"
  )!;
  const nativeBefore = structuredClone(model.executable);
  const messagesBefore = service.snapshot.messages;
  const promotionBefore = await parkedPromotion(service, candidate);
  const pendingBefore = structuredClone(pending);
  const callsBefore = [
    agents.contexts.length,
    agents.reviews.length,
    agents.admissions.length,
    runner.tests.length,
    runner.calls.length,
    model.activationCalls,
    model.added.length,
  ];
  await rejects(() =>
    decideChange(service, {
      changeId: pending.id,
      expectedRevision: service.snapshot.configuration!.revision,
      verdict: "approve",
    }), {
    message:
      "Une promotion native suspendue doit être terminée avant cette publication ; la proposition reste en attente.",
  });
  equal(model.changeApplications, 0);
  deepStrictEqual(model.executable, nativeBefore);
  equal(model.configurations.length, 0);
  equal(
    service.snapshot.executionModel!.version.digest,
    nativeBefore.version.digest,
  );
  equal(
    service.snapshot.configuration!.changes.find((change) =>
      change.id === pending.id
    )!.status,
    "pending",
  );
  equal(service.snapshot.configuration!.reviewer, undefined);
  deepStrictEqual(service.snapshot.candidates[0], candidate);
  deepStrictEqual(service.snapshot.messages, messagesBefore);
  deepStrictEqual(
    service.snapshot.configuration!.changes.find((change) =>
      change.id === pending.id
    ),
    pendingBefore,
  );
  deepStrictEqual(
    await parkedPromotion(service, service.snapshot.candidates[0]!),
    promotionBefore,
  );
  deepStrictEqual(
    [
      agents.contexts.length,
      agents.reviews.length,
      agents.admissions.length,
      runner.tests.length,
      runner.calls.length,
      model.activationCalls,
      model.added.length,
    ],
    callsBefore,
    "The pending publication must preserve its native wait without additional work",
  );
  agents.steps.push(reply);
  await decideCandidate(service, {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "Human admission remains available before reviewer creation",
  });
  equal(service.snapshot.candidates[0]!.stage, "active");
  equal(service.snapshot.candidates[0]!.admission!.authority, "human");
  equal(
    service.snapshot.configuration!.changes.find((change) =>
      change.id === pending.id
    )!.status,
    "pending",
  );
  const afterCandidate = service.snapshot;
  const catalogSource = structuredClone(model.executable);
  const candidateAdmitted = afterCandidate.candidates[0]!;
  ok(
    afterCandidate.executionModel!.version.repositoryVersion !==
      pending.diff!.base.repositoryVersion,
    "Catalog admission advances the exact source pin of the old displayed proposal",
  );
  equal(afterCandidate.executionModel!.version.digest, pending.baseModelDigest);
  const callsAfterCandidate = [
    agents.contexts.length,
    agents.reviews.length,
    agents.admissions.length,
    runner.tests.length,
    runner.calls.length,
    model.activationCalls,
    model.added.length,
  ];
  await rejects(() =>
    decideChange(service, {
      changeId: pending.id,
      expectedRevision: service.snapshot.configuration!.revision,
      verdict: "approve",
    }), {
    name: "ChangePublicationError",
    code: "PUBLICATION_NOT_APPLICABLE",
    recovery: "refuse",
    message: "The source base differs from the exact displayed approval",
  });
  equal(model.changeApplications, 0);
  equal(model.configurations.length, 0);
  deepStrictEqual(model.executable, catalogSource);
  deepStrictEqual(
    service.snapshot.executionModel,
    afterCandidate.executionModel,
  );
  deepStrictEqual(service.snapshot.candidates[0], candidateAdmitted);
  deepStrictEqual(service.snapshot.messages, afterCandidate.messages);
  deepStrictEqual(
    service.snapshot.configuration!.changes.find((change) =>
      change.id === pending.id
    ),
    pendingBefore,
  );
  equal(service.snapshot.configuration!.reviewer, undefined);
  deepStrictEqual(
    [
      agents.contexts.length,
      agents.reviews.length,
      agents.admissions.length,
      runner.tests.length,
      runner.calls.length,
      model.activationCalls,
      model.added.length,
    ],
    callsAfterCandidate,
    "A stale approval must not publish, adopt, invoke a provider or replay the admitted candidate",
  );
  // Resolve the old displayed proposal through its normal decision path, then
  // request a new preview. Neither its diff nor any retained native pin is rebased.
  agents.steps.push(reply);
  await decideChange(service, {
    changeId: pending.id,
    expectedRevision: service.snapshot.configuration!.revision,
    verdict: "refuse",
  });
  equal(
    service.snapshot.configuration!.changes.find((change) =>
      change.id === pending.id
    )!.status,
    "refused",
  );
  agents.steps.push(reviewerProposal);
  await turn(
    service,
    "Repropose le reviewer depuis le catalogue maintenant admis",
  );
  const reproposed = service.snapshot.configuration!.changes.find((change) =>
    change.status === "pending"
  )!;
  ok(reproposed.id !== pending.id);
  equal(
    reproposed.diff!.base.repositoryVersion,
    catalogSource.version.repositoryVersion,
  );
  equal(reproposed.baseModelDigest, catalogSource.version.digest);
  await approvePendingChange(service);
  equal(model.changeApplications, 1);
  equal(service.snapshot.configuration!.builder.admissionAuthority, "reviewer");
  deepStrictEqual(
    service.snapshot.candidates[0]!.admission,
    candidateAdmitted.admission,
  );
  equal(service.snapshot.candidates[0]!.stage, "active");
  equal(
    service.snapshot.configuration!.changes.find((change) =>
      change.id === reproposed.id
    )!.status,
    "approved",
  );
  deepStrictEqual(
    service.snapshot.configuration!.changes.find((change) =>
      change.id === pending.id
    )!.diff,
    pendingBefore.diff,
  );
  equal(
    service.snapshot.events.some((event) =>
      event.kind === "promotion-continuation-rebound"
    ),
    false,
    "The old promotion is never migrated to the future reviewer contract",
  );
});
