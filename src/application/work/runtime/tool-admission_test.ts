/** Unit recovery retains/reloads business state through controlled stores.
 * Main source decisions use real memory native effects/history. Recipient
 * reconstruction from edited snapshots is not a process/PG saver recovery
 * witness; the dedicated PostgreSQL profiles own that separate qualification. */
import { deepStrictEqual, equal, ok, rejects } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import {
  openToolAdmissionMainFixture,
  toolAdmissionMainCaseId,
} from "../../../../test/support/tool-admission-main-fixture.ts";
import { legacyOwnerAuthority } from "../../../domain/governance/authority.ts";
import { CandidateActivationError } from "../../../domain/work/policies/candidate-activation.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { CandidateDelegatedActor } from "../../../domain/governance/policies/tool-admission-policy.ts";
import type {
  Candidate,
  ToolDraft,
} from "../../../domain/work/records/candidates.ts";
import type { ChatDecision } from "../conversation/chat-decision.ts";
import type { SystemRuntimeState } from "./state.ts";
import {
  OperatorConversations,
  type OperatorWorkContribution,
} from "../operators/conversations.ts";
import {
  invocationInput,
  invocationKey,
  recordedOperatorWork,
} from "../operators/journal.ts";
import {
  caseExecutionContext,
  selectCaseInvocation,
} from "../cases/runtime.ts";
import type {
  AgentPort,
  ModelPort,
  StorePort,
  ToolRunnerPort,
} from "./ports.ts";

// Every expanded scenario owns its Main subscriptions and memory worker ports.
// Deno executes these top-level tests serially; no resource is shared by cases.
let using: (dispose: () => Promise<void>) => void = () => {
  throw new Error("A tool-admission fixture must belong to its current test");
};
let mains = new Map<string, ReturnType<typeof openToolAdmissionMainFixture>>();
let recipientExecutions = new WeakMap<
  MemoryStore,
  ReturnType<typeof createTestNativeExecution>
>();
function test(name: string, body: () => Promise<void>): void {
  Deno.test(name, async () => {
    const disposals: Array<() => Promise<void>> = [];
    mains = new Map();
    recipientExecutions = new WeakMap();
    using = (dispose) => {
      disposals.push(dispose);
    };
    let bodyFailure: unknown;
    let failed = false;
    try {
      await body();
    } catch (error) {
      failed = true;
      bodyFailure = error;
    }
    const results = await Promise.allSettled(
      disposals.reverse().map(async (dispose) => await dispose()),
    );
    mains.clear();
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length) {
      throw new AggregateError(
        failed ? [bodyFailure, ...failures] : failures,
        "Tool-admission scenario/disposal failed",
      );
    }
    if (failed) throw bodyFailure;
  });
}

const actor: CandidateDelegatedActor = {
  actorId: "main",
  policyId: "tested-tools",
  policyRevision: 1,
};
const draft: ToolDraft = {
  name: "Lecteur testé",
  kind: "read_web_page",
  description: "Extrait la page demandée",
  code: "export default ({html}) => ({title:'Page',text:html})",
};
const propose: ChatDecision = {
  kind: "propose_tool",
  text: "Je prépare le lecteur demandé.",
  tool: draft,
};
const reply: ChatDecision = { kind: "reply", text: "Request terminé" };

function admitted(granted = true): ExecutableModel {
  const model = executableFixture({
    projectId: "git:f0ec3282-6343-587f-aa0d-25f8a858c7e2",
    editingContextId: "context",
    rootId: "root",
    systemId: "worker-system",
    catalogId: "worker-catalog",
    builderId: "worker",
  });
  model.version.repositoryVersion = "branch:admitted";
  model.ownerAuthority = {
    ...legacyOwnerAuthority(model.identity.systemId),
    ownerSource: "modeled",
  };
  if (granted) grant(model);
  return model;
}

function grant(model: ExecutableModel): void {
  model.toolAdmissionPolicies = [{
    id: actor.policyId,
    revision: actor.policyRevision,
    enabled: true,
    recipients: [model.identity.builderId],
    toolKinds: [draft.kind],
    maxDelegationDepth: 0,
    elementId: "native-tool-admission-policy",
    holderNativeId: actor.actorId,
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    rootAuthority: {
      ...legacyOwnerAuthority("main-system"),
      ownerSource: "modeled",
    },
    sourceIds: ["native-tool-admission-policy"],
  }];
}

class MemoryStore implements StorePort {
  constructor(public value: SystemRuntimeState | null = null) {}
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

class CompletionFailOnceStore extends MemoryStore {
  armed = false;
  failures = 0;
  override save(state: SystemRuntimeState, expected: number | null) {
    const completions = (value: SystemRuntimeState | null) =>
      value?.events.filter((event) => event.kind === "operator-work-completed")
        .length ?? 0;
    if (
      this.armed && completions(state) > completions(this.value) &&
      state.messages.some((message) => message.text === reply.text)
    ) {
      this.armed = false;
      this.failures++;
      throw new Error("Correlated completion persistence unavailable");
    }
    return super.save(state, expected);
  }
}

/** Technical ports only: candidate preparation and admission use the real interpreter. */
function fixture(
  model = admitted(),
  store = new MemoryStore(),
  steps: Array<ChatDecision | Error> = [propose, reply],
  publication?: (
    candidate: Candidate,
  ) => "interrupt" | "published-interrupt" | void,
  testedCode = draft.code,
  useAuthoritativeCase = true,
) {
  let decisions = 0;
  let tests = 0;
  let publications = 0;
  const publishedAdmissions: Candidate[] = [];
  const agents: AgentPort = {
    label: "scripted-tool-admission",
    decide() {
      decisions++;
      const step = steps.shift();
      if (!step) throw new Error("Unexpected additional provider call");
      if (step instanceof Error) throw step;
      return Promise.resolve(structuredClone(step));
    },
    review() {
      throw new Error("The recipient does not have a reviewer admission mode");
    },
    admit() {
      throw new Error("The recipient does not have a builder admission mode");
    },
  };
  const source: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize() {
      return Promise.resolve(structuredClone(model.identity));
    },
    readExecutableModel() {
      return Promise.resolve(structuredClone(model));
    },
    applyApprovedChange() {
      throw new Error("No model change belongs to this runtime test");
    },
    activateCandidate(_identity, candidate, admittedDigest) {
      equal(admittedDigest, candidate.activationModelDigest);
      equal(candidate.requiredAuthority, "human");
      equal(candidate.admission?.authority, "delegate");
      publishedAdmissions.push(structuredClone(candidate));
      const result = publication?.(candidate);
      if (result === "interrupt") throw new Error("Publication unavailable");
      const existing = model.catalog.find((entry) =>
        entry.candidateId === candidate.id && entry.digest === candidate.digest
      );
      const binding = {
        elementId: existing?.nativeId ?? `native-${candidate.id}`,
        graphPath: "fixture.catalog.reader",
      };
      if (!existing) {
        publications++;
        model.catalog.push({
          nativeId: binding.elementId,
          candidateId: candidate.id,
          contractId: `contract-${candidate.kind}`,
          name: candidate.name,
          kind: candidate.kind,
          digest: candidate.digest,
          status: "active",
        });
      }
      if (result === "published-interrupt") {
        throw new Error("Publication succeeded before interruption");
      }
      return Promise.resolve(binding);
    },
    findCandidate(_identity, candidate) {
      const entry = model.catalog.find((entry) =>
        entry.candidateId === candidate.id && entry.digest === candidate.digest
      );
      return Promise.resolve(
        entry
          ? { elementId: entry.nativeId, graphPath: "fixture.catalog.reader" }
          : null,
      );
    },
    graph() {
      return Promise.resolve({});
    },
  };
  const runner: ToolRunnerPort = {
    test(candidate) {
      tests++;
      equal(candidate.code, testedCode);
      const prepared = candidate as Candidate;
      if (prepared.toolAdmissionPolicyPins?.length) {
        deepStrictEqual(
          prepared.toolAdmissionContract,
          model.contracts.find((contract) => contract.kind === prepared.kind),
        );
      }
      return Promise.resolve({
        passed: true,
        checks: [{ name: "contract", passed: true, detail: "Exact output" }],
      });
    },
    run() {
      throw new Error("No tool invocation belongs to this test");
    },
  };
  // Reopening the same store rebinds a worker to its actual retained memory
  // queue, ledger, saver and accepted state-history revisions. Edited snapshot
  // stores intentionally start a different controlled reconstruction witness.
  let native = recipientExecutions.get(store);
  if (!native) {
    native = createTestNativeExecution(store);
    recipientExecutions.set(store, native);
  }
  const retainedNative = native;
  const service = new SystemRuntime({
    agents,
    model: source,
    runner,
    store: retainedNative.store,
    execution: retainedNative.execution,
    dispatch: retainedNative.dispatch,
    stateHistory: retainedNative.stateHistory,
    artifactSources: retainedNative.artifactSources,
  });
  const initialize = service.initialize.bind(service);
  const localIdle = service.idle.bind(service);
  service.initialize = async (...args) => {
    await initialize(...args);
    retainedNative.bind(service);
    service.idle = async () => {
      await localIdle();
      await retainedNative.idle();
      await localIdle();
    };
  };
  // This host-owned status is independent of any delegated context retained by
  // the receiving runtime. A copied caller snapshot never supplies authority.
  const authoritativeCase = {
    id: request().proof.caseId!,
    status: "open" as "open" | "closed-abandoned",
  };
  const publicationRegistry: Parameters<
    SystemRuntime["bindOperatorRegistry"]
  >[0] = {
    snapshot: {
      systemId: model.identity.systemId,
      defaultAgentId: model.identity.builderId,
      version: "authoritative-fixture-case",
      conversations: [],
    },
    ...(useAuthoritativeCase
      ? {
        async withCandidateContinuation<T>(
          caseId: string,
          action: (
            context:
              import("../../../domain/work/execution/modeled-behavior.ts").CaseExecutionContext,
          ) => Promise<T>,
        ): Promise<T> {
          return await (await main()).conversations.withCandidateContinuation(
            caseId,
            action,
          );
        },
        withCandidatePublication<T>(
          input: {
            agentId: string;
            caseId: string;
            candidateId: string;
            candidateDigest: string;
          },
          publish: () => Promise<T>,
        ) {
          equal(input.agentId, model.identity.builderId);
          equal(input.caseId, authoritativeCase.id);
          const candidate = service.snapshot.candidates.find((entry) =>
            entry.id === input.candidateId
          );
          ok(candidate);
          equal(input.candidateDigest, candidate.digest);
          equal(input.caseId, candidate.caseId);
          if (authoritativeCase.status === "closed-abandoned") {
            throw new CandidateActivationError(
              "CASE_ABANDONED",
              { candidateId: candidate.id, caseId: authoritativeCase.id },
              "The host's authoritative Request was abandoned",
            );
          }
          return publish();
        },
      }
      : {}),
  };
  if (useAuthoritativeCase) {
    service.bindOperatorRegistry(publicationRegistry);
  }
  async function main(actorId = actor.actorId) {
    const recipient = {
      target: service,
      model,
      bindNotifications(conversations: OperatorConversations) {
        if (!useAuthoritativeCase) {
          // The actual manager leases the recipient's own authoritative local
          // Case when Main routes a delegated decision to that recipient.
          // Reconstructions without a manager still exercise standalone
          // validation and cannot publish a copied central Case context.
          service.bindOperatorRegistry(conversations);
          return;
        }
        service.bindOperatorRegistry({
          ...publicationRegistry,
          withCandidateContinuation: (caseId, action) =>
            conversations.withCandidateContinuation(caseId, action),
          notifyCommandCompletion: (accepted) =>
            conversations.notifyCommandCompletion(accepted),
        });
      },
    };
    let opening = mains.get(actorId);
    if (!opening) {
      opening = openToolAdmissionMainFixture({
        ...recipient,
        actorId,
        using,
      });
      mains.set(actorId, opening);
    }
    const source = await opening;
    await source.attach(recipient);
    return source;
  }
  async function submitWork(input: OperatorWorkContribution) {
    const source = await main();
    const actual = structuredClone(input);
    if (
      actual.proof.callerId === actor.actorId &&
      actual.proof.caseId === toolAdmissionMainCaseId
    ) {
      actual.proof.caseContext = source.context();
    }
    await service.submitWork(actual);
  }
  using(() => store.close());
  return {
    service,
    authoritativeCase,
    model,
    store,
    source,
    executions: () =>
      retainedNative.execution.inspect(model.identity.builderId),
    async injectBusinessState(state: SystemRuntimeState) {
      // Explicit business-state fault injection. Native checkpoints, queue
      // claims and effect receipts remain in the original retained fixture.
      await retainedNative.store.save({
        ...structuredClone(state),
        revision: state.revision + 1,
      }, state.revision);
    },
    publishedAdmissions,
    main,
    submitWork,
    async decide(
      input: Parameters<SystemRuntime["decideCandidate"]>[0],
      delegated: CandidateDelegatedActor,
    ) {
      await (await main(delegated.actorId)).decide(input, delegated);
    },
    get decisions() {
      return decisions;
    },
    get tests() {
      return tests;
    },
    get publications() {
      return publications;
    },
  };
}

function request(): OperatorWorkContribution {
  return {
    text: "Prépare le lecteur pour ce Request.",
    correlationId: "request:reader:one",
    proof: {
      caseId: toolAdmissionMainCaseId,
      caseContext: {
        caseId: toolAdmissionMainCaseId,
        number: 1,
        modelPin: {
          digest: "main-admitted",
          repositoryVersion: "branch:main",
        },
      },
      callerId: actor.actorId,
      invocationId: "request-reader-invocation",
      modelVersion: {
        digest: "main-admitted",
        repositoryVersion: "branch:main",
      },
      behavior: {
        id: "access-worker",
        name: "Dispatch",
        description: "Admitted inbox",
        targetNativeId: "inbox-worker",
        targetTypeId: "inbox-type",
        inputTypeId: "work-input",
        callerNativeId: actor.actorId,
        sourceIds: ["access-native"],
        inputSchema: { type: "object" },
      },
    },
  };
}

test("two delegated contributions to one Request resume in reverse order after restart without repeating preparation", async () => {
  const a = request();
  const b = structuredClone(a);
  b.correlationId = "request:reader:two";
  b.proof.invocationId = "invocation:reader:two";
  b.text = "Prepare another reader for the same Request.";
  const first = fixture(admitted(), new MemoryStore(), [propose, {
    ...propose,
    tool: { ...draft, name: "Second reader" },
  }]);
  await first.service.initialize();
  await first.submitWork(a);
  await first.service.idle();
  const candidateA = first.service.snapshot.candidates[0];
  await first.submitWork(b);
  await first.service.idle();
  const candidateB = first.service.snapshot.candidates[1];
  ok(candidateA);
  ok(candidateB);
  const persisted = first.store.value;
  ok(persisted, "Both accepted contributions must have persisted their state");
  const context = caseExecutionContext(persisted);
  ok(
    context?.record,
    "The delegated invocation must retain its real central Case context",
  );
  equal(context.caseId, toolAdmissionMainCaseId);
  equal(context.record.owner, actor.actorId);
  deepStrictEqual(context, (await first.main()).context());
  equal(Object.hasOwn(context, "candidates"), false);
  equal(
    JSON.stringify(context).includes(
      '"invocationContinuations"',
    ),
    false,
  );
  equal(first.tests, 2);
  equal(
    recordedOperatorWork(
      first.service.snapshot,
      "worker",
      actor.actorId,
      a.correlationId,
    )?.result.status,
    "waiting",
  );

  const revokedModel = structuredClone(first.model);
  revokedModel.toolAdmissionPolicies = [];
  const revoked = fixture(
    revokedModel,
    new MemoryStore(structuredClone(first.store.value)),
    [],
  );
  await revoked.service.initialize();
  await rejects(() =>
    revoked.service.inspectCandidate({
      candidateId: candidateA.id,
      candidateDigest: candidateA.digest,
      caseId: candidateA.caseId!,
    }, actor)
  );
  equal(revoked.tests, 0);
  equal(revoked.publications, 0);
  equal(revoked.decisions, 0);

  const restarted = fixture(first.model, first.store, [reply, reply]);
  await restarted.service.initialize();
  for (const candidate of [candidateB, candidateA]) {
    await restarted.decide({
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      caseId: candidate.caseId,
      verdict: "refuse",
      reason: "Declined exact work",
    }, actor);
  }
  for (const contribution of [a, b]) {
    const result = recordedOperatorWork(
      restarted.service.snapshot,
      "worker",
      actor.actorId,
      contribution.correlationId,
    )?.result;
    equal(result?.status, "completed");
    equal(result?.invocationId, contribution.proof.invocationId);
    equal(
      result?.messages.filter((message) => message.text === reply.text).length,
      1,
    );
  }
  equal(restarted.tests, 0);
  equal(restarted.publications, 0);
  equal(restarted.decisions, 2);
  await restarted.service.resumeDecidedChanges();
  await restarted.service.idle();
  equal(restarted.decisions, 2);
});

function work(state: SystemRuntimeState) {
  return recordedOperatorWork(
    state,
    "worker",
    actor.actorId,
    request().correlationId,
  )!.result;
}

async function selectedConversation(
  f: ReturnType<typeof fixture>,
  state = f.service.snapshot,
) {
  const invocation = state.caseInvocation;
  const input = invocationInput(state);
  ok(invocation && input, "An exact selected invocation/input is required");
  const selected = (await f.executions()).filter((execution) =>
    execution.identity.purpose === "conversation" &&
    execution.identity.invocationKey === invocationKey(invocation) &&
    execution.identity.subjectId === input.id
  );
  equal(
    selected.length,
    1,
    "The selected Case/input must have one actual native conversation",
  );
  return selected[0];
}

function decisionNodeId(state: SystemRuntimeState) {
  const node = state.executionModel?.flows.conversation.nodes.find((node) =>
    node.mechanism === "choose_move"
  );
  ok(node, "The budget fault must name the admitted decision action");
  return node.id;
}

async function prepare(f: ReturnType<typeof fixture>) {
  await f.service.initialize();
  await f.submitWork(request());
  await f.service.idle();
  const candidate = f.service.snapshot.candidates[0]!;
  equal(candidate.stage, "awaiting-admission");
  equal(candidate.requiredAuthority, "human");
  equal(work(f.service.snapshot).status, "waiting");
  equal(f.decisions, 1);
  equal(f.tests, 1);
  return candidate;
}

function command(
  candidate: Candidate,
  verdict: "approve" | "refuse" = "approve",
) {
  return {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    caseId: candidate.caseId!,
    verdict,
    reason: "Code, contrat et essais exacts examinés",
  };
}

test("a recipient may publish under the real delegated Case lease for its own authoritative local Request", async () => {
  const f = fixture(
    admitted(),
    new MemoryStore(),
    [propose, reply],
    undefined,
    draft.code,
    false,
  );
  await f.service.initialize();
  await f.service.submit(
    "Prépare le lecteur pour mon Request local",
    undefined,
    undefined,
    true,
  );
  await f.service.idle();
  const candidate = f.service.snapshot.candidates[0];
  const record = f.service.snapshot.cases!.find((value) =>
    value.id === candidate.caseId
  )!;
  equal(record.owner, f.model.identity.builderId);
  equal(candidate.stage, "awaiting-admission");
  await f.decide(command(candidate), actor);
  equal(f.service.snapshot.candidates[0].stage, "active");
  equal(f.service.snapshot.candidates[0].admission!.authority, "delegate");
  equal(f.publications, 1);
  equal(f.model.catalog.length, 1);
});

test("prior tool grant enables bounded inspection and delegated native admission of the same Request", async () => {
  const f = fixture();
  const candidate = await prepare(f);
  deepStrictEqual(candidate.toolAdmissionPolicyPins, [{
    policyId: actor.policyId,
    policyRevision: actor.policyRevision,
    holderNativeId: actor.actorId,
    policyElementId: "native-tool-admission-policy",
  }]);
  const inspected = await f.service.inspectCandidate(command(candidate), actor);
  equal(inspected.operatorId, "worker");
  equal(inspected.candidate.code, draft.code);
  deepStrictEqual(inspected.candidate.tests, candidate.tests);
  deepStrictEqual(inspected.contract, f.model.contracts[0]);
  // Inspection cannot mutate the stored code or tests through its returned data.
  inspected.candidate.code = "untrusted replacement";
  inspected.candidate.tests!.checks.length = 0;
  equal(f.service.snapshot.candidates[0].code, draft.code);
  equal(f.service.snapshot.candidates[0].tests!.checks.length, 1);

  await f.decide(command(candidate), actor);
  const state = f.service.snapshot;
  const active = state.candidates[0]!;
  equal(active.stage, "active");
  equal(active.requiredAuthority, "human");
  equal(state.configuration!.builder.admissionAuthority, "human");
  equal(active.admission?.authority, "delegate");
  equal(active.admission?.actorId, actor.actorId);
  const proof = active.admission!.authorityExercise!.candidateDelegation!;
  equal(proof.actorId, actor.actorId);
  equal(proof.policyId, actor.policyId);
  equal(proof.policyRevision, actor.policyRevision);
  equal(proof.requestedBy, "worker");
  equal(proof.candidateId, candidate.id);
  equal(proof.candidateDigest, candidate.digest);
  equal(proof.caseId, request().proof.caseId);
  deepStrictEqual(proof.tests, candidate.tests);
  deepStrictEqual(proof.contract, f.model.contracts[0]);
  deepStrictEqual(
    proof.policyIssuer,
    f.model.toolAdmissionPolicies![0].rootAuthority,
  );
  equal(active.admission!.authorityExercise!.delegation, undefined);
  equal(
    state.events.filter((event) => event.kind === "human-admission-decided")
      .length,
    0,
  );
  equal(
    state.events.filter((event) => event.kind === "delegated-admission-decided")
      .length,
    1,
  );
  equal(
    state.events.filter((event) => event.kind === "tool-admitted").length,
    1,
  );
  equal(f.publications, 1);
  equal(f.tests, 1);
  equal(f.decisions, 2);
  equal(work(state).status, "completed");
  equal(work(state).caseId, candidate.caseId);
  equal(work(state).invocationId, request().proof.invocationId);
  equal(work(state).messages.at(-1)!.text, reply.text);
  deepStrictEqual(work(state).candidateIds, [candidate.id]);
  equal(f.publishedAdmissions[0].stage, "activating");
  ok(f.publishedAdmissions[0].admission);
  ok(f.publishedAdmissions[0].activationModelDigest);
  await rejects(
    () => f.decide(command(candidate), actor),
    { code: "AUTHORITY_REQUEST_STALE" },
  );
  equal(f.publications, 1);
  equal(f.model.catalog.length, 1);
  await f.submitWork(request());
  equal(f.decisions, 2);
  deepStrictEqual(work(f.service.snapshot), work(state));
});

test("exact candidate inspection includes a large source once and excludes private continuation data", async () => {
  const prefix = `${draft.code};\n/*`;
  const suffix = "*/";
  const code = prefix + "x".repeat(65_536 - prefix.length - suffix.length) +
    suffix;
  equal(code.length, 65_536);
  const largeDraft = { ...draft, code };
  const first = fixture(
    admitted(),
    new MemoryStore(),
    [{ ...propose, tool: largeDraft }],
    undefined,
    code,
  );
  const candidate = await prepare(first);
  const saved = first.service.snapshot;
  const privateMarker = "PRIVATE-WORK-RECEIPT-AND-PROMOTION-CONTEXT";
  saved.candidates[0].promotionContext = {
    ...saved.candidates[0].promotionContext,
    copiedCode: code.repeat(3),
    privateWorkData: { marker: privateMarker, proof: request().proof },
  };
  ok(saved.caseInvocation?.kind === "delegated");
  saved.candidates[0].admissionContinuation = {
    modelDigest: first.model.version.digest,
    fingerprint: privateMarker,
    inputMessageId: saved.messages[0].id,
    messageStart: 0,
    priorCandidateIds: [candidate.id],
    work: {
      receipt: structuredClone(saved.caseInvocation.work),
      messageRanges: [{ start: 0, end: saved.messages.length }],
      candidateIds: [candidate.id],
    },
  };
  const restarted = fixture(
    first.model,
    new MemoryStore(saved),
    [],
    undefined,
    code,
  );
  await restarted.service.initialize(undefined, {
    resumeCandidateContinuations: false,
  });
  ok(restarted.service.snapshot.candidates[0].admissionContinuation);
  const inspected = await restarted.service.inspectCandidate(
    command(candidate),
    actor,
  );
  equal(inspected.candidate.code, code);
  deepStrictEqual(inspected.candidate.tests, candidate.tests);
  deepStrictEqual(inspected.contract, first.model.contracts[0]);
  deepStrictEqual(
    Object.keys(inspected.candidate).sort(),
    [
      "id",
      "name",
      "description",
      "kind",
      "code",
      "digest",
      "caseId",
      "stage",
      "baseCatalogRevision",
      "requiredAuthority",
      "tests",
    ].sort(),
  );
  const serialized = JSON.stringify(inspected);
  equal(serialized.split(JSON.stringify(code)).length, 2);
  equal(serialized.includes(privateMarker), false);
  for (
    const internal of [
      "promotionContext",
      "promotionCursor",
      "admissionContinuation",
      "priorCandidateIds",
      "messageRanges",
      "inputMessageId",
      "privateWorkData",
      "copiedCode",
      "toolAdmissionContract",
    ]
  ) equal(serialized.includes(`\"${internal}\"`), false);
  ok(serialized.length < code.length + 10_000);
  equal(restarted.tests, 0);
  equal(restarted.decisions, 0);
  equal(restarted.publications, 0);
});

test("delegated refusal uses native refusal and resumes its Request without admission or publication", async () => {
  const f = fixture();
  const candidate = await prepare(f);
  await f.decide(command(candidate, "refuse"), actor);
  const state = f.service.snapshot;
  equal(state.candidates[0].stage, "refused");
  equal(state.candidates[0].requiredAuthority, "human");
  equal(state.candidates[0].admission, undefined);
  equal(
    state.candidates[0].admissionDecision!.authorityExercise!
      .candidateDelegation!.actorId,
    actor.actorId,
  );
  equal(
    state.events.filter((event) => event.kind === "human-admission-decided")
      .length,
    0,
  );
  equal(
    state.events.filter((event) => event.kind === "tool-admitted").length,
    0,
  );
  equal(f.publications, 0);
  equal(f.model.catalog.length, 0);
  equal(work(state).status, "completed");
  equal(work(state).caseId, candidate.caseId);
});

test("inspection and delegated command reject exact-target, actor and policy mismatches without admission", async () => {
  const f = fixture();
  const candidate = await prepare(f);
  const before = f.service.snapshot;
  for (
    const wrong of [
      { ...command(candidate), candidateDigest: "wrong" },
      { ...command(candidate), caseId: "another-request" },
    ]
  ) {
    await rejects(() => f.service.inspectCandidate(wrong, actor));
    await rejects(() => f.decide(wrong, actor), {
      code: "AUTHORITY_REQUEST_STALE",
    });
  }
  for (
    const wrong of [
      { ...actor, actorId: "worker" },
      { ...actor, actorId: "other-main" },
      { ...actor, policyId: "network-policy" },
      { ...actor, policyRevision: 2 },
    ]
  ) {
    const authorityCode = wrong.policyId !== actor.policyId ||
        wrong.policyRevision !== actor.policyRevision
      ? "AUTHORITY_POLICY_STALE"
      : "AUTHORITY_OUT_OF_BOUNDS";
    await rejects(() => f.service.inspectCandidate(command(candidate), wrong), {
      code: authorityCode,
    });
    if (wrong.actorId === "worker") {
      const source = await f.main();
      equal(
        source.main.snapshot.executionModel!.identity.builderId,
        actor.actorId,
      );
      ok(source.main !== f.service);
      const decide = f.service.decideCandidate;
      let attempts = 0;
      // Substitute the claimed actor only at the delegated decision port,
      // after Main verified its real native effect and inspection. The command
      // parser must reject this identity mismatch against that intact origin.
      f.service.decideCandidate = async (input, delegated, origin) => {
        attempts++;
        deepStrictEqual(delegated, actor);
        ok(origin);
        equal(
          origin.businessRevision.__assemblyRuntimeRevision.operatorId,
          actor.actorId,
        );
        deepStrictEqual(origin, source.main.currentExecutionOrigin());
        await decide.call(f.service, input, wrong, origin);
      };
      try {
        await rejects(
          () => source.decide(command(candidate), actor),
          /Delegated actor does not match the durable source scope/,
        );
      } finally {
        f.service.decideCandidate = decide;
      }
      equal(
        attempts,
        1,
        "The real native Main decision must reach the command parser exactly once",
      );
    } else {
      // In particular, other-main is a distinct actual Main actor. Its real
      // native inspection must refuse the mandate held by main; this is
      // separate from substituting an actor against an intact main origin.
      await rejects(() => f.decide(command(candidate), wrong), {
        code: authorityCode,
      });
    }
  }
  deepStrictEqual(f.service.snapshot.candidates, before.candidates);
  equal(f.publications, 0);
  equal(
    f.service.snapshot.events.filter((event) => event.kind === "tool-admitted")
      .length,
    0,
  );
});

test("a new grant cannot replace the admitted pin above an unsettled candidate", async () => {
  const f = fixture(admitted(false));
  const candidate = await prepare(f);
  const admittedPin = structuredClone(
    f.service.snapshot.executionModel!.version,
  );
  equal(candidate.toolAdmissionPolicyPins, undefined);
  // This admitted model has no policy at all: the domain guard rejects its
  // missing policy before it can consider candidate preparation pins.
  await rejects(() => f.service.inspectCandidate(command(candidate), actor), {
    code: "AUTHORITY_POLICY_STALE",
  });
  await rejects(() => f.decide(command(candidate), actor), {
    code: "AUTHORITY_POLICY_STALE",
  });
  grant(f.model);
  f.model.version.digest = "grant-admitted-later";
  f.model.version.repositoryVersion = "branch:late-grant";
  await rejects(
    () =>
      f.service.adoptModelVersion({ expectedDigest: f.model.version.digest }),
    { code: "EVOLUTION_BOUNDARY_UNSAFE" },
  );
  deepStrictEqual(f.service.snapshot.executionModel!.version, admittedPin);
  deepStrictEqual(f.service.snapshot.candidates, [candidate]);
  equal(f.service.snapshot.candidates[0].toolAdmissionPolicyPins, undefined);
  equal(f.service.snapshot.candidates[0].stage, "awaiting-admission");
  equal(f.service.snapshot.executionModel!.toolAdmissionPolicies, undefined);
  equal(f.publications, 0);
});

for (const changed of ["native-identity", "acceptance-criteria"] as const) {
  test(`an unsettled candidate blocks adoption of a ${changed} contract change even when the promotion flow is unchanged`, async () => {
    const f = fixture();
    const candidate = await prepare(f);
    const testedContract = structuredClone(f.model.contracts[0]);
    const originalFlow = structuredClone(f.model.flows.promotion);
    const admittedPin = structuredClone(
      f.service.snapshot.executionModel!.version,
    );
    deepStrictEqual(candidate.toolAdmissionContract, testedContract);
    if (changed === "native-identity") {
      f.model.contracts[0].nativeId = "a-different-native-contract";
    } else {
      f.model.contracts[0].acceptanceCriteria = [
        ...f.model.contracts[0].acceptanceCriteria,
        "A new acceptance criterion that the recorded tests did not exercise",
      ];
    }
    f.model.version.digest = `changed-contract-${changed}`;
    f.model.version.repositoryVersion = `branch:changed-contract-${changed}`;
    await rejects(
      () =>
        f.service.adoptModelVersion({ expectedDigest: f.model.version.digest }),
      { code: "EVOLUTION_BOUNDARY_UNSAFE" },
    );
    const rebound = f.service.snapshot.candidates[0];
    deepStrictEqual(f.service.snapshot.executionModel!.version, admittedPin);
    equal(rebound.promotionModelDigest, candidate.promotionModelDigest);
    deepStrictEqual(rebound, candidate);
    deepStrictEqual(f.model.flows.promotion, originalFlow);
    deepStrictEqual(rebound.toolAdmissionContract, testedContract);
    await rejects(
      () => f.service.inspectCandidate(command(candidate), actor),
      /admission explicite/,
    );
    await rejects(
      () => f.decide(command(candidate), actor),
      /admission explicite/,
    );
    equal(f.service.snapshot.candidates[0].stage, "awaiting-admission");
    equal(f.service.snapshot.candidates[0].requiredAuthority, "human");
    equal(f.service.snapshot.candidates[0].admissionDecision, undefined);
    equal(f.service.snapshot.candidates[0].admission, undefined);
    equal(f.publications, 0);
    equal(f.publishedAdmissions.length, 0);
    equal(f.tests, 1);
    equal(f.decisions, 1);
  });
}

test("an older candidate without a tested contract pin does not gain delegated admission", async () => {
  const first = fixture();
  const candidate = await prepare(first);
  const saved = first.service.snapshot;
  delete saved.candidates[0].toolAdmissionContract;
  const reopened = fixture(first.model, new MemoryStore(saved), []);
  await reopened.service.initialize();
  await rejects(
    () => reopened.service.inspectCandidate(command(candidate), actor),
    {
      code: "AUTHORITY_OUT_OF_BOUNDS",
    },
  );
  await rejects(
    () => reopened.decide(command(candidate), actor),
    {
      code: "AUTHORITY_OUT_OF_BOUNDS",
    },
  );
  equal(reopened.service.snapshot.candidates[0].stage, "awaiting-admission");
  equal(reopened.service.snapshot.candidates[0].requiredAuthority, "human");
  equal(reopened.service.snapshot.candidates[0].admission, undefined);
  equal(reopened.publications, 0);
  equal(reopened.publishedAdmissions.length, 0);
  equal(reopened.tests, 0);
  equal(reopened.decisions, 0);
});

test("external model changes and revocation block delegated inspection before a new admission effect", async () => {
  const f = fixture();
  const candidate = await prepare(f);
  f.model.toolAdmissionPolicies![0].enabled = false;
  f.model.toolAdmissionPolicies![0].revision++;
  f.model.version.digest = "revoked-model";
  f.model.version.repositoryVersion = "branch:revoked";
  await rejects(
    () => f.service.inspectCandidate(command(candidate), actor),
    /admission explicite/,
  );
  await rejects(
    () => f.decide(command(candidate), actor),
    /admission explicite/,
  );
  const source = await f.main();
  const uncertain = (await source.executions()).filter((execution) =>
    execution.status === "uncertain" && execution.unsettledEffects.length > 0
  );
  equal(
    uncertain.length,
    1,
    "The failed native inspection must remain explicitly uncertain",
  );
  const originalUnknown = uncertain[0];
  ok(originalUnknown.identity.scope.kind === "request");
  ok(originalUnknown.identity.scope.scopeId !== candidate.caseId);
  equal(
    f.service.snapshot.executionModel!.version.digest,
    candidate.promotionModelDigest,
  );
  equal(
    f.service.snapshot.availableExecutionModel!.version.digest,
    f.model.version.digest,
  );
  await rejects(
    () =>
      f.service.adoptModelVersion({ expectedDigest: f.model.version.digest }),
    { code: "EVOLUTION_BOUNDARY_UNSAFE" },
  );
  equal(
    f.service.snapshot.executionModel!.version.digest,
    candidate.promotionModelDigest,
  );
  deepStrictEqual(f.service.snapshot.candidates, [candidate]);
  await rejects(
    () => f.service.inspectCandidate(command(candidate), actor),
    /admission explicite/,
  );
  await rejects(
    () => f.decide(command(candidate), actor),
    /admission explicite/,
  );
  deepStrictEqual(
    (await source.executions()).find((execution) =>
      execution.threadId === originalUnknown.threadId
    ),
    originalUnknown,
    "The distinct new source Request must neither replay nor settle the former unknown effect",
  );
  equal(f.service.snapshot.candidates[0].stage, "awaiting-admission");
  equal(f.service.snapshot.candidates[0].admission, undefined);
  equal(f.publications, 0);
});

test("incomplete tests and a changed catalog base refuse delegated inspection and admission", async () => {
  for (
    const mutate of [
      (state: SystemRuntimeState) => state.candidates[0].tests!.checks = [],
      (state: SystemRuntimeState) =>
        state.candidates[0].tests!.checks[0].passed = false,
      (state: SystemRuntimeState) => state.catalogRevision++,
    ]
  ) {
    const first = fixture();
    const candidate = await prepare(first);
    const saved = first.service.snapshot;
    mutate(saved);
    const resumed = fixture(first.model, new MemoryStore(saved), []);
    await resumed.service.initialize();
    await rejects(() =>
      resumed.service.inspectCandidate(command(candidate), actor)
    );
    await rejects(
      () => resumed.decide(command(candidate), actor),
      (error) =>
        error instanceof Error && (
          "code" in error && error.code === "AUTHORITY_OUT_OF_BOUNDS" ||
          error.message ===
            "The inspection requires an exact tested candidate in its open Request."
        ),
    );
    equal(resumed.service.snapshot.candidates[0].stage, "awaiting-admission");
    equal(resumed.service.snapshot.candidates[0].admission, undefined);
    equal(resumed.publications, 0);
    equal(resumed.decisions, 0);
    equal(resumed.tests, 0);
  }
});

test("an uncertain delegated publication preserves its admission without replay through restart or workspace recovery", async () => {
  const model = admitted();
  const first = fixture(model, new MemoryStore(), [propose], () => "interrupt");
  const candidate = await prepare(first);
  await rejects(
    () => first.decide(command(candidate), actor),
    /Publication unavailable/,
  );
  const interruptedState = first.service.snapshot;
  const interrupted = interruptedState.candidates[0];
  equal(interrupted.stage, "activating");
  equal(interrupted.admission!.authority, "delegate");
  ok(interrupted.activationModelDigest);
  equal(first.publications, 0);
  const promotion = (await first.executions()).find((execution) =>
    execution.identity.purpose === "promotion" &&
    execution.identity.subjectId === interrupted.promotionExecution!.subjectId
  );
  ok(promotion?.checkpointId);
  equal(promotion.status, "uncertain");
  equal(promotion.unsettledEffects.length, 1);
  const receipt = structuredClone(interrupted.admission);
  const restarted = fixture(model, first.store, [reply]);
  await restarted.service.initialize();
  const source = await restarted.main();
  await source.conversations.resumeCandidateContinuations();
  await restarted.service.idle();
  equal(restarted.service.snapshot.candidates[0].stage, "activating");
  ok(restarted.service.snapshot.candidates[0].admissionContinuation);
  deepStrictEqual(restarted.service.snapshot.candidates[0].admission, receipt);
  deepStrictEqual(
    (await restarted.executions()).find((execution) =>
      execution.threadId === promotion.threadId
    ),
    promotion,
  );
  equal(restarted.publications, 0);
  equal(restarted.publishedAdmissions.length, 0);
  equal(model.catalog.length, 0);
  equal(restarted.tests, 0);
  equal(
    restarted.service.snapshot.events.filter((event) =>
      event.kind === "tool-admitted"
    ).length,
    1,
  );
  equal(
    restarted.service.snapshot.events.filter((event) =>
      event.kind === "human-admission-decided"
    ).length,
    0,
  );
  deepStrictEqual(work(restarted.service.snapshot), work(interruptedState));
  equal(restarted.decisions, 0);
});

test("startup defers exact published-effect reconciliation until its host settles the Case", async () => {
  const { first, candidate, receipt } = await publishedInterruption();
  equal(first.model.catalog.length, 1);
  const restarted = fixture(first.model, first.store, [reply]);
  await restarted.service.initialize(undefined, {
    resumeCandidateContinuations: false,
  });
  equal(restarted.service.snapshot.candidates[0].stage, "activating");
  equal(restarted.publications, 0);
  equal(restarted.publishedAdmissions.length, 0);
  equal(restarted.decisions, 0);
  ok(restarted.service.snapshot.candidates[0].admissionContinuation);
  await restarted.service.settleDelegatedCandidateActivations({
    caseId: candidate.caseId!,
  });
  equal(restarted.service.snapshot.candidates[0].stage, "active");
  equal(restarted.publications, 0);
  equal(restarted.publishedAdmissions.length, 0);
  equal(restarted.decisions, 0);
  await restarted.service.resumeDecidedChanges({ candidatesOnly: true });
  await restarted.service.idle();
  const state = restarted.service.snapshot;
  equal(work(state).status, "completed");
  equal(work(state).caseId, candidate.caseId);
  equal(work(state).invocationId, request().proof.invocationId);
  deepStrictEqual(state.candidates[0].admission, receipt);
  equal(state.candidates[0].admissionContinuation, undefined);
  equal(restarted.decisions, 1);
  equal(restarted.tests, 0);
  equal(restarted.model.catalog.length, 1);
  equal(
    state.events.filter((event) => event.kind === "tool-admitted").length,
    1,
  );
});

test("host abandonment cannot infer a terminal outcome from an unknown delegated publication", async () => {
  const first = fixture(
    admitted(),
    new MemoryStore(),
    [propose],
    () => "interrupt",
  );
  const candidate = await prepare(first);
  await rejects(
    () => first.decide(command(candidate), actor),
    /Publication unavailable/,
  );
  const receipt = first.service.snapshot.candidates[0].admission;
  const executions = await first.executions();
  const restarted = fixture(first.model, first.store, []);
  await restarted.service.initialize(undefined, {
    resumeCandidateContinuations: false,
  });
  equal(restarted.service.snapshot.candidates[0].stage, "activating");
  await rejects(
    () =>
      restarted.service.settleDelegatedCandidateActivations({
        caseId: candidate.caseId!,
        abandon: true,
      }),
    /native activation effect is unresolved/,
  );
  await restarted.service.resumeDecidedChanges({ candidatesOnly: true });
  await restarted.service.idle();
  const state = restarted.service.snapshot;
  equal(state.candidates[0].stage, "activating");
  ok(state.candidates[0].activationModelDigest);
  ok(state.candidates[0].admissionContinuation);
  deepStrictEqual(await restarted.executions(), executions);
  deepStrictEqual(state.candidates[0].admission, receipt);
  equal(restarted.publications, 0);
  equal(restarted.publishedAdmissions.length, 0);
  equal(restarted.decisions, 0);
  equal(restarted.tests, 0);
  equal(restarted.model.catalog.length, 0);
  equal(
    state.events.filter((event) => event.kind === "tool-admitted").length,
    1,
  );
  equal(state.events.filter((event) => event.kind === "tool-active").length, 0);
});

test("host abandonment reconciles an already published delegated effect through reads alone", async () => {
  const { first, candidate, receipt } = await publishedInterruption();
  const restarted = fixture(first.model, first.store, []);
  await restarted.service.initialize(undefined, {
    resumeCandidateContinuations: false,
  });
  equal(restarted.service.snapshot.candidates[0].stage, "activating");
  equal(restarted.publishedAdmissions.length, 0);
  await restarted.service.settleDelegatedCandidateActivations({
    caseId: candidate.caseId!,
    abandon: true,
  });
  await restarted.service.resumeDecidedChanges({ candidatesOnly: true });
  await restarted.service.idle();
  const state = restarted.service.snapshot;
  equal(state.candidates[0].stage, "active");
  equal(state.candidates[0].activationModelDigest, undefined);
  equal(state.candidates[0].admissionContinuation, undefined);
  deepStrictEqual(state.candidates[0].admission, receipt);
  equal(restarted.publications, 0);
  equal(restarted.publishedAdmissions.length, 0);
  equal(restarted.decisions, 0);
  equal(restarted.tests, 0);
  equal(restarted.model.catalog.length, 1);
  equal(
    state.events.filter((event) => event.kind === "tool-admitted").length,
    1,
  );
  equal(state.events.filter((event) => event.kind === "tool-active").length, 1);
});

function withRequestB(saved: SystemRuntimeState) {
  const id = "worker:RequestB";
  const budget = { budgetId: "RequestB-budget", scopeId: "RequestB-scope" };
  saved.cases!.push({
    id,
    number: Math.max(0, ...saved.cases!.map((record) => record.number)) + 1,
    type: "request",
    objective: "Process the independent local RequestB",
    owner: "worker",
    openedBy: "human",
    openedFrom: { conversationId: saved.id },
    modelPin: {
      digest: saved.executionModel!.version.digest,
      repositoryVersion: saved.executionModel!.version.repositoryVersion,
    },
    status: "open",
    budget,
    createdAt: "2026-10-26T00:00:00.000Z",
  });
  return { id, budget };
}

test("a copied open central Case cannot replace a missing native activation owner", async () => {
  const first = fixture(
    admitted(),
    new MemoryStore(),
    [propose],
    () => "interrupt",
  );
  const candidate = await prepare(first);
  await rejects(
    () => first.decide(command(candidate), actor),
    /Publication unavailable/,
  );
  const saved = first.service.snapshot;
  ok(saved.caseInvocation?.kind === "delegated");
  saved.caseInvocation.work.caseContext.record = {
    id: candidate.caseId!,
    number: 1,
    type: "request",
    objective: request().text,
    owner: actor.actorId,
    openedBy: "human",
    openedFrom: { conversationId: "authoritative-main-conversation" },
    modelPin: structuredClone(request().proof.modelVersion),
    status: "open",
    createdAt: "2026-10-24T00:00:00.000Z",
  };
  equal(saved.cases!.some((record) => record.id === candidate.caseId), false);
  const restarted = fixture(
    first.model,
    new MemoryStore(saved),
    [],
    undefined,
    draft.code,
    false,
  );
  await restarted.service.initialize(undefined, { resumeContinuations: false });
  const state = restarted.service.snapshot;
  ok(state.caseInvocation?.kind === "delegated");
  equal(state.caseInvocation.work.caseContext.record!.status, "open");
  equal(state.candidates[0].stage, "activating");
  ok(state.candidates[0].admissionContinuation);
  equal(restarted.publications, 0);
  equal(restarted.publishedAdmissions.length, 0);
  equal(restarted.model.catalog.length, 0);
  equal(restarted.decisions, 0);
  equal(restarted.tests, 0);
});

test("a generic retry preserves unknown delegated RequestA while a new local RequestB proceeds", async () => {
  const first = fixture(
    admitted(),
    new MemoryStore(),
    [propose],
    () => "interrupt",
  );
  const candidate = await prepare(first);
  await rejects(
    () => first.decide(command(candidate), actor),
    /Publication unavailable/,
  );
  const saved = first.service.snapshot;
  const requestB = withRequestB(saved);
  await first.injectBusinessState(saved);
  const executionsA = await first.executions();
  const restarted = fixture(first.model, first.store, [reply]);
  await restarted.service.initialize(undefined, {
    resumeCandidateContinuations: false,
  });
  const gates: unknown[] = [];
  restarted.service.bindOperatorRegistry({
    snapshot: {
      systemId: first.model.identity.systemId,
      defaultAgentId: "worker",
      version: "host-bound-case-guard",
      conversations: [],
    },
    withCandidatePublication(input) {
      gates.push(structuredClone(input));
      deepStrictEqual(restarted.service.snapshot.caseInvocation, {
        kind: "local",
        caseId: requestB.id,
      });
      deepStrictEqual(
        restarted.service.snapshot.workBudgetBinding,
        requestB.budget,
      );
      throw new CandidateActivationError(
        "CASE_ABANDONED",
        { candidateId: candidate.id, caseId: candidate.caseId! },
        "The authoritative RequestA was abandoned before publication",
      );
    },
  });
  const selections: SystemRuntimeState["caseInvocation"][] = [];
  const unsubscribe = restarted.service.onState((state) => {
    selections.push(structuredClone(state.caseInvocation));
  });
  await restarted.service.submit(
    "Continue the independent RequestB",
    undefined,
    requestB.id,
  );
  await restarted.service.idle();
  unsubscribe();
  const state = restarted.service.snapshot;
  deepStrictEqual(
    gates,
    [],
    "An unknown native effect cannot request a new publication lease",
  );
  equal(state.candidates[0].stage, "activating");
  deepStrictEqual(
    (await restarted.executions()).filter((execution) =>
      executionsA.some((previous) => previous.threadId === execution.threadId)
    ),
    executionsA,
  );
  equal(restarted.publishedAdmissions.length, 0);
  equal(restarted.publications, 0);
  equal(restarted.model.catalog.length, 0);
  equal(restarted.decisions, 1);
  equal(state.messages.at(-1)!.text, reply.text);
  equal(state.error, undefined);
  ok(selections.length);
  for (const selected of selections) {
    deepStrictEqual(selected, { kind: "local", caseId: requestB.id });
  }
  deepStrictEqual(state.workBudgetBinding, requestB.budget);
  const executionB = await selectedConversation(restarted, state);
  equal(executionB.identity.scope.scopeId, requestB.id);
  equal(executionB.status, "waiting");
  deepStrictEqual(executionB.waits.map((wait) => wait.mechanism), [
    "await_input",
  ]);
  deepStrictEqual(executionB.unsettledEffects, []);
  equal(
    state.events.filter((event) => event.kind === "tool-admitted").length,
    1,
  );
});

test("a generic retry reconciles published RequestA without a Case gate while RequestB proceeds", async () => {
  const { first, receipt } = await publishedInterruption();
  const saved = first.service.snapshot;
  const requestB = withRequestB(saved);
  await first.injectBusinessState(saved);
  const restarted = fixture(first.model, first.store, [reply]);
  await restarted.service.initialize(undefined, {
    resumeCandidateContinuations: false,
  });
  let gates = 0;
  restarted.service.bindOperatorRegistry({
    snapshot: {
      systemId: first.model.identity.systemId,
      defaultAgentId: "worker",
      version: "host-bound-case-guard",
      conversations: [],
    },
    withCandidatePublication() {
      gates++;
      throw new Error("Published effects require no new Case authorization");
    },
  });
  await restarted.service.submit(
    "Continue the independent RequestB",
    undefined,
    requestB.id,
  );
  await restarted.service.idle();
  const state = restarted.service.snapshot;
  equal(gates, 0);
  equal(state.candidates[0].stage, "active");
  deepStrictEqual(state.candidates[0].admission, receipt);
  equal(restarted.publications, 0);
  equal(restarted.model.catalog.length, 1);
  equal(restarted.decisions, 1);
  equal(state.messages.at(-1)!.text, reply.text);
  deepStrictEqual(state.caseInvocation, { kind: "local", caseId: requestB.id });
  deepStrictEqual(state.workBudgetBinding, requestB.budget);
  equal(state.error, undefined);
  equal(
    state.events.filter((event) => event.kind === "tool-admitted").length,
    1,
  );
  equal(
    state.events.filter((event) => event.kind === "delegated-admission-decided")
      .length,
    1,
  );
  equal(
    state.events.filter((event) => event.kind === "human-admission-decided")
      .length,
    0,
  );
});

for (const path of ["initial-command", "activation-recovery"] as const) {
  test(`a failed final receipt save on ${path} preserves terminal recovery without provider replay`, async () => {
    let model: ExecutableModel;
    let faulting: ReturnType<typeof fixture>;
    let store: CompletionFailOnceStore;
    let originalReceipt: Candidate["admission"];
    if (path === "initial-command") {
      model = admitted();
      store = new CompletionFailOnceStore();
      faulting = fixture(model, store, [propose, reply]);
      const candidate = await prepare(faulting);
      store.armed = true;
      await rejects(
        () => faulting.decide(command(candidate), actor),
        /Correlated completion persistence unavailable/,
      );
      originalReceipt = faulting.service.snapshot.candidates[0].admission;
      equal(faulting.decisions, 2);
    } else {
      store = new CompletionFailOnceStore();
      const first = fixture(
        admitted(),
        store,
        [propose],
        () => "published-interrupt",
      );
      const candidate = await prepare(first);
      await rejects(
        () => first.decide(command(candidate), actor),
        /Publication succeeded before interruption/,
      );
      model = first.model;
      originalReceipt = first.service.snapshot.candidates[0].admission;
      store.armed = true;
      faulting = fixture(model, store, [reply]);
      await rejects(
        () => faulting.service.initialize(),
        /Correlated completion persistence unavailable/,
      );
      equal(faulting.decisions, 1);
    }
    equal(store.failures, 1);
    const durable = (await store.load())!;
    equal(durable.candidates[0].stage, "active");
    ok(durable.candidates[0].admissionContinuation);
    deepStrictEqual(durable.candidates[0].admission, originalReceipt);
    equal(
      durable.messages.filter((message) => message.text === reply.text).length,
      1,
    );
    equal(
      durable.events.filter((event) => event.kind === "operator-work-completed")
        .length,
      0,
    );
    const terminal = await selectedConversation(faulting, durable);
    ok(
      terminal.status === "completed" ||
        terminal.status === "waiting" &&
          terminal.waits.every((wait) => wait.kind === "input"),
    );
    deepStrictEqual(terminal.unsettledEffects, []);
    equal(model.catalog.length, 1);
    const restarted = fixture(model, store, []);
    await restarted.service.initialize();
    await restarted.service.resumeDecidedChanges({ candidatesOnly: true });
    await restarted.service.idle();
    const state = restarted.service.snapshot;
    equal(state.candidates[0].stage, "active");
    equal(state.candidates[0].admissionContinuation, undefined);
    deepStrictEqual(state.candidates[0].admission, originalReceipt);
    equal(work(state).status, "completed");
    equal(work(state).caseId, request().proof.caseId);
    equal(work(state).invocationId, request().proof.invocationId);
    equal(
      state.messages.filter((message) => message.text === reply.text).length,
      1,
    );
    equal(
      state.events.filter((event) => event.kind === "operator-work-completed")
        .length,
      1,
    );
    equal(
      state.events.filter((event) => event.kind === "tool-admitted").length,
      1,
    );
    equal(
      state.events.filter((event) =>
        event.kind === "delegated-admission-decided"
      ).length,
      1,
    );
    equal(restarted.decisions, 0);
    equal(restarted.tests, 0);
    equal(restarted.publications, 0);
    equal(restarted.publishedAdmissions.length, 0);
    equal(model.catalog.length, 1);
  });
}

test("provider failure after delegated activation does not become an automatic startup retry", async () => {
  const first = fixture(admitted(), new MemoryStore(), [
    propose,
    new Error("Provider continuation unavailable"),
  ]);
  const candidate = await prepare(first);
  await rejects(
    () => first.decide(command(candidate), actor),
    /Provider continuation unavailable/,
  );
  const settled = first.service.snapshot;
  equal(settled.candidates[0].stage, "active");
  equal(settled.candidates[0].admissionContinuation, undefined);
  equal(settled.candidates[0].admission!.authority, "delegate");
  equal(work(settled).status, "failed");
  equal(first.publications, 1);
  equal(first.decisions, 2);
  const failedConversation = await selectedConversation(first, settled);
  equal(failedConversation.status, "uncertain");
  ok(failedConversation.unsettledEffects.length > 0);
  ok(settled.error?.includes("Provider continuation unavailable"));
  const receipt = settled.candidates[0].admission;
  const restarted = fixture(first.model, first.store, []);
  await restarted.service.initialize();
  await restarted.service.resumeDecidedChanges();
  await restarted.service.idle();
  deepStrictEqual(await selectedConversation(restarted), failedConversation);
  equal(restarted.service.snapshot.error, settled.error);
  equal(restarted.service.snapshot.candidates[0].stage, "active");
  equal(
    restarted.service.snapshot.candidates[0].admissionContinuation,
    undefined,
  );
  deepStrictEqual(restarted.service.snapshot.candidates[0].admission, receipt);
  deepStrictEqual(work(restarted.service.snapshot), work(settled));
  equal(restarted.decisions, 0);
  equal(restarted.tests, 0);
  equal(restarted.publications, 0);
  equal(first.model.catalog.length, 1);
  equal(
    restarted.service.snapshot.events.filter((event) =>
      event.kind === "tool-admitted"
    ).length,
    1,
  );
});

async function publishedInterruption() {
  const first = fixture(
    admitted(),
    new MemoryStore(),
    [propose],
    () => "published-interrupt",
  );
  const candidate = await prepare(first);
  await rejects(
    () => first.decide(command(candidate), actor),
    /Publication succeeded before interruption/,
  );
  equal(first.publications, 1);
  equal(first.service.snapshot.candidates[0].stage, "activating");
  ok(first.service.snapshot.candidates[0].admissionContinuation);
  return {
    first,
    candidate,
    receipt: first.service.snapshot.candidates[0].admission,
  };
}

test("registry recovery completes a parked decided invocation after another same-Request contribution without replay or attribution leakage", async () => {
  const { first, candidate, receipt } = await publishedInterruption();
  const restarted = fixture(first.model, first.store, [
    { kind: "reply", text: "B-only reply" },
    { kind: "reply", text: "A-recovered reply" },
  ]);
  await restarted.service.initialize(undefined, {
    resumeCandidateContinuations: false,
  });
  const b = request();
  b.correlationId = "contribution-B";
  b.proof.invocationId = "invocation-B";
  b.text = "Private contribution B";
  await restarted.submitWork(b);
  await restarted.service.idle();
  const before = restarted.service.snapshot;
  const conversationB = await selectedConversation(restarted, before);
  ok(before.candidates[0].admissionContinuation);
  // Keep the actual native Main and original authoritative Case while only
  // the recipient runtime is reopened. No synthetic primary snapshot is used.
  const source = await restarted.main();
  const manager = source.conversations;
  restarted.service.bindOperatorRegistry(manager);
  await manager.resumeCandidateContinuations();
  await restarted.service.idle();
  const state = restarted.service.snapshot;
  equal(state.candidates[0].admissionContinuation, undefined);
  deepStrictEqual(state.candidates[0].admission, receipt);
  equal(state.candidates[0].id, candidate.id);
  equal(
    recordedOperatorWork(
      state,
      "worker",
      actor.actorId,
      request().correlationId,
    )!.result.status,
    "completed",
  );
  const aMessages = recordedOperatorWork(
    state,
    "worker",
    actor.actorId,
    request().correlationId,
  )!.result.messages;
  equal(
    aMessages.some((message) =>
      message.text === b.text || message.text === "B-only reply"
    ),
    false,
  );
  equal(
    aMessages.filter((message) => message.text === "A-recovered reply").length,
    1,
  );
  deepStrictEqual(state.caseInvocation, before.caseInvocation);
  deepStrictEqual(await selectedConversation(restarted, state), conversationB);
  equal(restarted.publications, 0);
  equal(restarted.tests, 0);
  equal(restarted.decisions, 2);
  await manager.resumeCandidateContinuations();
  await restarted.service.idle();
  equal(restarted.decisions, 2);
  equal(first.model.catalog.length, 1);
  await manager.dispose();
});

test("deferred host readiness resumes its exact delegated Request once without republishing", async () => {
  const { first, candidate, receipt } = await publishedInterruption();
  const restarted = fixture(first.model, first.store, [reply]);
  await restarted.service.initialize(undefined, { resumeContinuations: false });
  equal(restarted.service.snapshot.candidates[0].stage, "active");
  equal(work(restarted.service.snapshot).status, "failed");
  ok(restarted.service.snapshot.candidates[0].admissionContinuation);
  equal(restarted.decisions, 0);
  await restarted.service.resumeDecidedChanges();
  await restarted.service.idle();
  equal(work(restarted.service.snapshot).status, "completed");
  equal(work(restarted.service.snapshot).caseId, candidate.caseId);
  equal(
    work(restarted.service.snapshot).invocationId,
    request().proof.invocationId,
  );
  equal(
    restarted.service.snapshot.candidates[0].admissionContinuation,
    undefined,
  );
  const completed = work(restarted.service.snapshot);
  for (let repeat = 0; repeat < 2; repeat++) {
    await restarted.service.initialize();
    await restarted.service.resumeDecidedChanges();
    await restarted.service.idle();
  }
  deepStrictEqual(work(restarted.service.snapshot), completed);
  deepStrictEqual(restarted.service.snapshot.candidates[0].admission, receipt);
  equal(restarted.decisions, 1);
  equal(restarted.publications, 0);
  equal(first.model.catalog.length, 1);
  equal(
    restarted.service.snapshot.events.filter((event) =>
      event.kind === "tool-admitted"
    ).length,
    1,
  );
});

test("a different selected Case parks the exact delegated continuation without false work completion", async () => {
  const { first, receipt } = await publishedInterruption();
  const saved = first.service.snapshot;
  const originalInvocation = structuredClone(saved.caseInvocation!);
  const originalContinuation = structuredClone(
    saved.candidates[0].admissionContinuation,
  );
  const originalConversation = await selectedConversation(first);
  const priorWork = work(saved);
  const requestB = withRequestB(saved);
  // Inject only a business selection through the production selector. It parks
  // A under its exact invocation key; no native graph state is manufactured.
  selectCaseInvocation(saved, { kind: "local", caseId: requestB.id });
  await first.injectBusinessState(saved);
  const restarted = fixture(first.model, first.store, []);
  await restarted.service.initialize();
  await restarted.service.resumeDecidedChanges();
  await restarted.service.idle();
  const state = restarted.service.snapshot;
  deepStrictEqual(state.caseInvocation, { kind: "local", caseId: requestB.id });
  deepStrictEqual(state.workBudgetBinding, requestB.budget);
  deepStrictEqual(
    state.invocationContinuations?.[invocationKey(originalInvocation)]
      ?.invocation,
    originalInvocation,
  );
  deepStrictEqual(
    state.candidates[0].admissionContinuation,
    originalContinuation,
  );
  deepStrictEqual(
    (await restarted.executions()).find((execution) =>
      execution.threadId === originalConversation.threadId
    ),
    originalConversation,
  );
  deepStrictEqual(work(state), priorWork);
  equal(state.candidates[0].stage, "active");
  deepStrictEqual(state.candidates[0].admission, receipt);
  equal(restarted.decisions, 0);
  equal(restarted.publications, 0);
  equal(first.model.catalog.length, 1);
  equal(
    state.events.filter((event) => event.kind === "operator-work-completed")
      .length,
    0,
  );
});

for (
  const blocked of [
    "exhausted",
    "suspended",
    "pending-Case-budget",
    "reserved-dispatch",
  ] as const
) {
  test(`delegated recovery waits for ${blocked} accounting without replay or false completion`, async () => {
    const { first, receipt } = await publishedInterruption();
    const saved = first.service.snapshot;
    equal(saved.budgetSuspension, undefined);
    saved.workBudget = {
      budgetId: "waiting-budget",
      scopeId: "waiting-budget-scope",
      unit: "agent-invocation",
      limit: blocked === "reserved-dispatch" ? 7 : 4,
      consumed: 4,
      reserved: blocked === "reserved-dispatch" ? 1 : 0,
      remaining: blocked === "reserved-dispatch" ? 2 : 0,
      exhausted: blocked === "exhausted",
      suspended: blocked === "suspended",
      onExhausted: "wait",
      exhaustionRecipient: "local-control",
    };
    if (blocked === "pending-Case-budget") saved.caseBudgetPending = true;
    const before = structuredClone({
      invocation: saved.caseInvocation,
      context: caseExecutionContext(saved),
      budget: saved.workBudget,
      pending: saved.caseBudgetPending,
      error: saved.error,
      work: work(saved),
    });
    const conversation = await selectedConversation(first);
    await first.injectBusinessState(saved);
    const restarted = fixture(first.model, first.store, []);
    await restarted.service.initialize();
    await restarted.service.resumeDecidedChanges();
    await restarted.service.idle();
    const state = restarted.service.snapshot;
    equal(state.budgetSuspension, undefined);
    deepStrictEqual(state.caseInvocation, before.invocation);
    deepStrictEqual(caseExecutionContext(state), before.context);
    deepStrictEqual(await selectedConversation(restarted, state), conversation);
    deepStrictEqual(state.workBudget, before.budget);
    equal(state.caseBudgetPending, before.pending);
    equal(state.error, before.error);
    deepStrictEqual(work(state), before.work);
    equal(state.candidates[0].stage, "active");
    deepStrictEqual(state.candidates[0].admission, receipt);
    ok(state.candidates[0].admissionContinuation);
    equal(restarted.decisions, 0);
    equal(restarted.publications, 0);
    equal(first.model.catalog.length, 1);
    equal(
      state.events.filter((event) => event.kind === "operator-work-completed")
        .length,
      0,
    );
    equal(
      state.events.filter((event) => event.kind === "tool-admitted").length,
      1,
    );
  });
}

for (const originalVerdict of ["approve", "refuse"] as const) {
  test(`a recorded ${originalVerdict} decision cannot be overwritten or resumed without its exact native continuation`, async () => {
    const first = fixture();
    const candidate = await prepare(first);
    const originalModel = structuredClone(first.model);
    let beforeIntent: SystemRuntimeState | undefined;
    const unsubscribe = first.service.onState((state) => {
      const prepared = state.candidates[0];
      if (
        !beforeIntent && prepared?.stage === "awaiting-admission" &&
        prepared.admissionDecision && prepared.admissionContinuation &&
        !prepared.admission && !prepared.activationModelDigest
      ) beforeIntent = structuredClone(state);
    });
    await first.decide(
      command(candidate, originalVerdict),
      actor,
    );
    unsubscribe();
    ok(beforeIntent);
    const decision = structuredClone(
      beforeIntent.candidates[0].admissionDecision,
    );
    beforeIntent.budgetSuspension = {
      nodeId: decisionNodeId(beforeIntent),
      operation: "decide",
      recipient: "local-control",
      reason: "exhausted",
      diagnostic: "The recorded decision must await explicit budget resolution",
      dispatchStarted: false,
    };
    const blocked = fixture(originalModel, new MemoryStore(beforeIntent), []);
    await blocked.service.initialize();
    equal(blocked.service.snapshot.candidates[0].stage, "awaiting-admission");
    ok(blocked.service.snapshot.candidates[0].admissionContinuation);
    await rejects(
      () => blocked.service.inspectCandidate(command(candidate), actor),
      { code: "AUTHORITY_REQUEST_STALE" },
    );
    await rejects(
      () =>
        blocked.decide(
          command(
            candidate,
            originalVerdict === "approve" ? "refuse" : "approve",
          ),
          actor,
        ),
      { code: "AUTHORITY_REQUEST_STALE" },
    );
    deepStrictEqual(
      blocked.service.snapshot.candidates[0].admissionDecision,
      decision,
    );
    equal(blocked.service.snapshot.candidates[0].admission, undefined);
    equal(blocked.publications, 0);
    equal(blocked.publishedAdmissions.length, 0);
    equal(blocked.decisions, 0);
    equal(
      blocked.service.snapshot.events.filter((event) =>
        event.kind === "delegated-admission-decided"
      ).length,
      1,
    );
    const unblocked = blocked.service.snapshot;
    delete unblocked.budgetSuspension;
    const priorWork = work(unblocked);
    const completionsBefore = unblocked.events.filter((event) =>
      event.kind === "operator-work-completed"
    );
    // This is a reconstruction from a recorded business snapshot. The copied
    // fingerprint does not restore the native saver/ledger from that instant.
    const restarted = fixture(originalModel, new MemoryStore(unblocked), []);
    await restarted.service.initialize();
    const state = restarted.service.snapshot;
    equal(state.candidates[0].stage, "awaiting-admission");
    deepStrictEqual(state.candidates[0].admissionDecision, decision);
    equal(state.candidates[0].admissionContinuation, undefined);
    equal(state.candidates[0].admission, undefined);
    equal(restarted.publications, 0);
    equal(restarted.model.catalog.length, 0);
    equal(restarted.tests, 0);
    equal(restarted.decisions, 0);
    // With no terminal receipt, recordedOperatorWork projects the current
    // state revision into a synthetic failed result; it is not a new receipt.
    const { revision: priorRevision, ...priorResult } = priorWork;
    const { revision: currentRevision, ...currentResult } = work(state);
    equal(priorRevision, unblocked.revision);
    equal(currentRevision, state.revision);
    deepStrictEqual(currentResult, priorResult);
    deepStrictEqual(
      state.events.filter((event) => event.kind === "operator-work-completed"),
      completionsBefore,
    );
    equal(work(state).caseId, candidate.caseId);
    equal(work(state).invocationId, request().proof.invocationId);
    equal(
      state.events.filter((event) =>
        event.kind === "delegated-admission-decided"
      ).length,
      1,
    );
    equal(
      state.events.filter((event) => event.kind === "human-admission-decided")
        .length,
      0,
    );
  });
}

for (
  const boundary of [
    "superseding-input",
    "closed-Case",
    "budget-suspension",
  ] as const
) {
  test(`published delegated activation preserves its receipt without provider replay after ${boundary}`, async () => {
    const { first, candidate, receipt } = await publishedInterruption();
    const saved = first.service.snapshot;
    if (boundary === "superseding-input") {
      saved.messages.push({
        id: "superseding-request-input",
        role: "user",
        caseId: candidate.caseId,
        text: "Une nouvelle demande remplace la suite antérieure.",
        at: "2026-10-26T00:00:00.000Z",
      });
      saved.activeInputMessageId = "superseding-request-input";
    } else if (boundary === "closed-Case") {
      saved.cases!.push({
        id: candidate.caseId!,
        number: 1,
        type: "request",
        objective: request().text,
        owner: "worker",
        openedBy: actor.actorId,
        openedFrom: { conversationId: saved.id },
        modelPin: structuredClone(saved.executionModel!.version),
        status: "closed-done",
        createdAt: "2026-10-24T00:00:00.000Z",
        closedAt: "2026-10-26T00:00:00.000Z",
      });
    } else {
      saved.budgetSuspension = {
        nodeId: decisionNodeId(saved),
        operation: "decide",
        recipient: "local-control",
        reason: "exhausted",
        diagnostic: "An explicit local budget decision is required",
        dispatchStarted: false,
      };
    }
    const restarted = fixture(first.model, new MemoryStore(saved), []);
    await restarted.service.initialize();
    await restarted.service.resumeDecidedChanges();
    await restarted.service.idle();
    await restarted.service.initialize();
    equal(restarted.service.snapshot.candidates[0].stage, "active");
    deepStrictEqual(
      restarted.service.snapshot.candidates[0].admission,
      receipt,
    );
    equal(work(restarted.service.snapshot).status, "failed");
    equal(restarted.decisions, 0);
    equal(restarted.tests, 0);
    equal(restarted.publications, 0);
    equal(first.model.catalog.length, 1);
    equal(
      restarted.service.snapshot.events.filter((event) =>
        event.kind === "tool-admitted"
      ).length,
      1,
    );
    equal(
      restarted.service.snapshot.events.filter((event) =>
        event.kind === "human-admission-decided"
      ).length,
      0,
    );
    equal(
      Boolean(restarted.service.snapshot.candidates[0].admissionContinuation),
      boundary === "budget-suspension",
    );
  });
}

test("an already published delegated effect reconciles after revocation without a new admission or catalog entry", async () => {
  const model = admitted();
  const first = fixture(
    model,
    new MemoryStore(),
    [propose],
    () => "published-interrupt",
  );
  const candidate = await prepare(first);
  await rejects(
    () => first.decide(command(candidate), actor),
    /Publication succeeded before interruption/,
  );
  equal(first.publications, 1);
  equal(first.service.snapshot.candidates[0].stage, "activating");
  const receipt = first.service.snapshot.candidates[0].admission;
  model.toolAdmissionPolicies![0].enabled = false;
  model.toolAdmissionPolicies![0].revision++;
  model.version.digest = "revoked-after-publication";
  model.version.repositoryVersion = "branch:revoked-after-publication";
  const restarted = fixture(model, first.store, []);
  await restarted.service.initialize();
  await restarted.service.resumeDecidedChanges();
  await restarted.service.idle();
  await restarted.service.initialize();
  equal(restarted.service.snapshot.candidates[0].stage, "active");
  deepStrictEqual(restarted.service.snapshot.candidates[0].admission, receipt);
  equal(restarted.publications, 0);
  equal(model.catalog.length, 1);
  equal(restarted.decisions, 0);
  equal(restarted.tests, 0);
  equal(work(restarted.service.snapshot).status, "failed");
  ok(restarted.service.snapshot.candidates[0].admissionContinuation);
  equal(
    restarted.service.snapshot.availableExecutionModel!.version.digest,
    model.version.digest,
  );
  equal(
    restarted.service.snapshot.events.filter((event) =>
      event.kind === "tool-admitted"
    ).length,
    1,
  );
});
