import { unexpectedModelAuthoring } from "../../../../test/support/model-authoring.ts";
import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import { enableCommandFixtureProfile } from "../../../../test/support/execution-fixture.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import { ModelNavigationError } from "../../../domain/model/consultation/context.ts";
import type { ModelContextOverview } from "../../../domain/model/consultation/context.ts";
import { modelContextTools } from "../../../domain/model/consultation/context.ts";
import { DEFAULT_NETWORK_IMPACT_LIMITS } from "../../../domain/model/consultation/network-impact.ts";
import type {
  ChatContext,
  ChatDecision,
  ModelRevisionRequest,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import type { DecisionInformationPort } from "../context/information-ports.ts";
import type { ModelDiagnosticsPort, ModelPort, StorePort } from "./ports.ts";
import type { ModelDiagnostic } from "../../../domain/model/policies/diagnostics.ts";
import type { ModelEditRequest } from "../../../domain/model/editing/tooling.ts";
import type { ConversationsSnapshot } from "../../../domain/work/records/conversations.ts";

const source = "package Exact {\n" +
  "// À conserver exactement.\n".repeat(200) + "}\n";
const overview: ModelContextOverview = {
  version: "branch:source-pin",
  sourceDigest: "a".repeat(64),
  files: [{
    path: "system.sysml",
    sha256: "b".repeat(64),
    characters: source.length,
    byteLength: new TextEncoder().encode(source).length,
  }],
  roots: { items: [], total: 0, truncated: false },
  limits: {
    maxPageSize: 50,
    maxSourceBytes: 131072,
    maxInspectSourceBytes: 24576,
  },
  coverage: "bounded-discovery-not-exhaustive-impact",
};

function fixture(options: {
  information?: DecisionInformationPort;
  decide?: (context: ChatContext) => ChatDecision;
  allowed?: boolean;
  editing?: boolean;
  noEditPolicy?: boolean;
  modelDiagnostics?: ModelDiagnosticsPort;
  operatorPrimary?: boolean;
  sourceVersion?: string;
  explicitCommands?: true;
  legacyDeclaredConsultation?: boolean;
} = {}) {
  const model = artifactModel("builder");
  if (options.sourceVersion) {
    model.version.repositoryVersion = options.sourceVersion;
  }
  if (options.explicitCommands) {
    ok(
      options.information,
      "Explicit commands require the controlled source reader",
    );
    enableCommandFixtureProfile(model, {
      legacyDeclaredConsultation: options.legacyDeclaredConsultation ?? false,
    });
  }
  if (options.operatorPrimary !== undefined) {
    model.operator = {
      name: "Fixture operator",
      instruction: "Respecter le mandat admis.",
      primary: options.operatorPrimary,
      humanInput: true,
    };
  }
  if (!options.noEditPolicy) {
    model.modelEditPolicy = {
      id: "edit",
      revision: 1,
      elementId: "edit-policy",
      sourceIds: [],
      holderNativeId: "builder",
      mandateNativeId: "mandate",
      mandateId: "mandate",
      mandateRevision: 1,
      operations: [
        ...(options.editing
          ? ["set-value", "rename", "insert-member", "remove"] as const
          : []),
        "replace-source",
      ],
      grants: [{ file: "system.sysml", qualifiedRoots: ["Exact"] }],
    };
  }
  model.policy.mayProposeSysmlRevision = options.allowed !== false;
  model.contextPolicy = {
    kind: "separated-context",
    pattern: "5.1",
    id: "context",
    revision: 1,
    elementId: "context-policy",
    sourceIds: [],
    recentMessages: 1,
    maxMessageCharacters: 256,
    maxCollectionItems: 1,
    maxContextCharacters: 30000,
  };
  let persisted: SystemRuntimeState | null = null,
    fullReads = 0,
    proposals = 0;
  const contexts: ChatContext[] = [];
  const revisionRequests: ModelRevisionRequest[] = [];
  const editRequests: Array<{
    request: ModelEditRequest;
    expectedDigest: string;
  }> = [];
  const forbidden = () => {
    throw new Error("Unexpected external effect");
  };
  const native: ModelPort = {
    ...unexpectedModelAuthoring,
    initialize: () => Promise.resolve(structuredClone(model.identity)),
    readExecutableModel: () => Promise.resolve(structuredClone(model)),
    readSourceRevision: () => {
      fullReads++;
      return Promise.resolve({
        version: overview.version,
        sources: { "system.sysml": source },
      });
    },
    proposeRevision: (_identity, request) => {
      proposals++;
      revisionRequests.push(structuredClone(request));
      return Promise.resolve({
        id: "proposal",
        baseVersion: request.baseVersion,
        status: "pending",
      });
    },
    proposeEdit: (_identity, request, expectedDigest) => {
      editRequests.push({ request: structuredClone(request), expectedDigest });
      return Promise.resolve({
        id: "targeted-proposal",
        baseVersion: request.baseVersion,
        status: "pending",
      });
    },
    applyApprovedChange: forbidden,
    activateCandidate: forbidden,
    graph: () => Promise.resolve({}),
  };
  const store: StorePort = {
    load: () => Promise.resolve(structuredClone(persisted)),
    save(next, expected) {
      equal(persisted?.revision ?? null, expected);
      persisted = structuredClone(next);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  const execution = options.explicitCommands
    ? createTestNativeExecution(store)
    : undefined;
  const consultations: Array<{
    succeeded: boolean;
    code: string;
    details: string;
  }> = [];
  let admittedSourceReads = 0;
  const currentInformation = execution
    ? {
      ...options.information,
      read: options.information!.read,
      consultAdmittedModelSource(current, input) {
        equal(current.version.digest, model.version.digest);
        equal(current.version.repositoryVersion, "commit:shared-source");
        deepStrictEqual(input, {
          operation: "read_source",
          path: "conversation.sysml",
          version: "commit:shared-source",
        });
        admittedSourceReads++;
        return Promise.resolve({
          modelVersion: {
            digest: current.version.digest,
            repositoryVersion: current.version.repositoryVersion,
          },
          result: { path: input.path },
        });
      },
    } satisfies DecisionInformationPort
    : options.information;
  const service = new SystemRuntime({
    model: native,
    ...(currentInformation ? { information: currentInformation } : {}),
    ...(options.modelDiagnostics
      ? { modelDiagnostics: options.modelDiagnostics }
      : {}),
    store: execution?.store ?? store,
    ...(execution
      ? {
        dispatch: execution.dispatch,
        stateHistory: execution.stateHistory,
        execution: {
          closeScope: (snapshot, closure) =>
            execution.execution.closeScope(snapshot, closure),
          inspect: (operatorId) => execution.execution.inspect(operatorId),
          retireAndAdvance: (snapshot, authorization, targetModel) =>
            execution.execution.retireAndAdvance(
              snapshot,
              authorization,
              targetModel,
            ),
          run: (request, handlers) =>
            execution.execution.run(request, {
              ...handlers,
              async handle(node, inputs, values, action) {
                const result = await handlers.handle(
                  node,
                  inputs,
                  values,
                  action,
                );
                if (node.mechanism === "consult_declared_source") {
                  const consultation = result.outputs?.consultation as
                    | Record<string, unknown>
                    | undefined;
                  ok(consultation);
                  const { succeeded, code, details } = consultation;
                  ok(typeof succeeded === "boolean");
                  ok(typeof code === "string");
                  ok(typeof details === "string");
                  consultations.push({ succeeded, code, details });
                }
                return result;
              },
            }),
        },
      } satisfies Pick<
        ConstructorParameters<typeof SystemRuntime>[0],
        "dispatch" | "execution" | "stateHistory"
      >
      : {}),
    agents: {
      label: "recording-agent",
      decide(context) {
        contexts.push(structuredClone(context));
        return Promise.resolve(
          options.decide?.(context) ?? { kind: "reply", text: "Observed" },
        );
      },
      review: forbidden,
    },
    runner: { run: forbidden, test: forbidden },
  });
  if (execution) {
    const initialize = service.initialize.bind(service);
    service.initialize = async (...args) => {
      await initialize(...args);
      const localIdle = service.idle.bind(service);
      execution.bind(service);
      service.idle = async () => {
        await localIdle();
        await execution.idle();
        await localIdle();
      };
    };
  }
  const conversation = {
    agentId: model.identity.builderId,
    nativeId: model.identity.builderId,
    name: "Fixture operator",
    responsibility: "Admitted mandate",
    primary: options.operatorPrimary === true,
    runtimeOwned: true,
    canSend: true,
    revision: 1,
    busy: false,
    phase: "Ready",
    messages: [],
    modelDigest: model.version.digest,
    repositoryVersion: model.version.repositoryVersion,
  };
  const registry: { snapshot: ConversationsSnapshot } = {
    snapshot: {
      systemId: model.identity.systemId,
      defaultAgentId: model.identity.builderId,
      version: "registry-version",
      conversations: [
        conversation,
        ...(options.operatorPrimary === false
          ? [{
            ...conversation,
            agentId: "primary",
            nativeId: "primary",
            primary: true,
          }]
          : []),
      ],
    },
  };
  if (options.operatorPrimary !== undefined) {
    service.bindOperatorRegistry(registry);
  }
  return {
    service,
    model,
    registry,
    contexts,
    consultations,
    execution,
    saved: () => structuredClone(persisted),
    counts: () => ({ fullReads, proposals }),
    editRequests: () => structuredClone(editRequests),
    revisionRequests: () => structuredClone(revisionRequests),
  };
}

async function expectFailedTurn(
  f: ReturnType<typeof fixture>,
  message: string,
): Promise<void> {
  await rejects(() => f.service.idle(), { message });
  equal(f.service.snapshot.error, message);
}

function information(loaded = false): DecisionInformationPort {
  return {
    consultModel() {
      throw new Error("No consultation expected in this fixture");
    },
    read(_model, messages) {
      ok(messages?.some((m) => m.role === "user"));
      const sources: Record<string, string> = loaded
        ? { "system.sysml": source }
        : {};
      return Promise.resolve({
        memoryGuidance: [],
        modelContext: {
          ...overview,
          loadedSources: [],
          maxLoadedCharacters: 120000,
        },
        modelSources: {
          version: overview.version,
          sources,
        },
      });
    },
  };
}

Deno.test("selective decisions receive a source map without requesting the complete source bundle", async () => {
  const f = fixture({ information: information() });
  await f.service.initialize();
  equal(f.saved()!.modelTools!.length, 6);
  await f.service.submit("Inspect the system");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.contexts.length, 1);
  deepStrictEqual(f.contexts[0]!.modelSources!.sources, {});
  equal(f.contexts[0]!.modelContext!.version, overview.version);
  equal(
    f.contexts[0]!.admittedModelVersion!.repositoryVersion,
    "commit:shared-source",
  );
  equal(f.counts().fullReads, 0);
});

Deno.test("query tooling is always exposed while targeted editing follows the native policy", async () => {
  const disabled = fixture({ information: information() });
  await disabled.service.initialize();
  await disabled.service.submit("Inspect");
  await disabled.service.idle();
  equal(disabled.contexts[0]!.modelTools!.length, 6);
  equal(disabled.contexts[0]!.modelEditing!.targetedEdits, false);
  const enabled = fixture({
    information: information(),
    editing: true,
  });
  await enabled.service.initialize();
  equal(enabled.service.snapshot.modelTools!.length, 6);
  await enabled.service.submit("Inspect");
  await enabled.service.idle();
  equal(enabled.contexts[0]!.modelTools!.length, 6);
  equal(enabled.contexts[0]!.modelTools!.at(-1)!.id, "model.query");
  equal(enabled.contexts[0]!.modelEditing!.targetedEdits, true);
  equal(enabled.contexts[0]!.modelEditing!.policy!.id, "edit");
});

Deno.test("targeted edits propose against the exact consulted source digest without loading whole files or adopting execution", async () => {
  const f = fixture({
    information: information(),
    editing: true,
    decide(context) {
      deepStrictEqual(context.modelSources!.sources, {});
      return {
        kind: "propose_sysml_edit",
        text: "Targeted proposal",
        reason: "Rename the inspected element",
        baseVersion: context.modelContext!.version,
        sourceDigest: context.modelContext!.sourceDigest,
        edits: [{
          kind: "rename",
          elementId: "exact-native-element",
          name: "Revised",
        }],
      };
    },
  });
  await f.service.initialize();
  const admitted = structuredClone(f.service.snapshot.executionModel);
  await f.service.submit("Propose a targeted rename");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  const requests = f.editRequests();
  equal(requests.length, 1);
  equal(requests[0]!.request.baseVersion, overview.version);
  equal(requests[0]!.request.sourceDigest, overview.sourceDigest);
  equal(requests[0]!.expectedDigest, admitted!.version.digest);
  equal(Object.hasOwn(requests[0]!.request, "sources"), false);
  deepStrictEqual(f.counts(), { fullReads: 0, proposals: 0 });
  deepStrictEqual(f.service.snapshot.executionModel, admitted);
  equal(f.service.snapshot.candidates.length, 0);
  equal(
    f.service.snapshot.events.filter((event) =>
      event.kind === "model-revision-proposed"
    ).length,
    1,
  );
});

Deno.test("targeted edit proposals refuse changed consultation bases and source digests before calling the model port", async () => {
  for (const changed of ["base", "digest"] as const) {
    const f = fixture({
      information: information(),
      editing: true,
      decide: () => ({
        kind: "propose_sysml_edit",
        text: "Invalid targeted proposal",
        reason: "Must keep the consulted pin",
        baseVersion: changed === "base" ? "commit:other" : overview.version,
        sourceDigest: changed === "digest"
          ? "c".repeat(64)
          : overview.sourceDigest,
        edits: [{ kind: "remove", elementId: "exact-native-element" }],
      }),
    });
    await f.service.initialize();
    await f.service.submit("Propose edit");
    await expectFailedTurn(
      f,
      "La proposition ciblée doit conserver la version et le digest des sources consultées.",
    );
    equal(f.editRequests().length, 0);
    ok(f.service.snapshot.error?.includes("version et le digest"));
  }
});

Deno.test("targeted edits cannot bypass an empty editing grant, policy or an execution change during the decision", async () => {
  for (const denied of ["grant", "policy", "execution"] as const) {
    let changeExecution = () => {};
    const f = fixture({
      information: information(),
      editing: denied !== "grant",
      allowed: denied !== "policy",
      decide: () => {
        if (denied === "execution") changeExecution();
        return {
          kind: "propose_sysml_edit",
          text: "Refused targeted proposal",
          reason: "Requires host capability and current authority",
          baseVersion: overview.version,
          sourceDigest: overview.sourceDigest,
          edits: [{ kind: "remove", elementId: "exact-native-element" }],
        };
      },
    });
    changeExecution = () => {
      f.model.version.digest = "changed-during-decision";
    };
    await f.service.initialize();
    await f.service.submit("Propose edit");
    await expectFailedTurn(
      f,
      denied === "execution"
        ? "Le modèle natif a changé ; une admission explicite de sa version est requise avant toute décision ou effet."
        : "Le modèle natif ne permet pas de proposer une édition SysML ciblée.",
    );
    equal(f.editRequests().length, 0);
    ok(f.service.snapshot.error);
  }
});

Deno.test("default model tools cannot grant permission and their calls share the decision limit", async () => {
  let reads = 0;
  const reader = {
    ...information(),
    consultModel() {
      reads++;
      return Promise.resolve({ result: { operation: "search", items: [] } });
    },
  };
  const consult: ChatDecision = {
    kind: "consult_model",
    text: "Search",
    inputJson: JSON.stringify({
      operation: "search",
      version: overview.version,
    }),
  };
  const denied = fixture({
    explicitCommands: true,
    information: reader,
    allowed: false,
    decide: () => consult,
  });
  await denied.service.initialize();
  equal(denied.saved()!.modelTools!.length, 0);
  await denied.service.submit("Search");
  await rejects(() => denied.service.idle(), {
    name: "ModelContextAccessError",
    code: "MODEL_CONTEXT_AUTHORITY",
    context: { authority: "model-read" },
  });
  equal(reads, 0);
  equal(denied.contexts.length, 1);
  deepStrictEqual(denied.contexts[0].modelTools ?? [], []);
  equal(denied.consultations.length, 0);
  const bounded = fixture({
    explicitCommands: true,
    information: reader,
    decide: () => consult,
  });
  await bounded.service.initialize();
  await bounded.service.submit("Search");
  await expectFailedTurn(
    bounded,
    "La limite de décisions du modèle a été atteinte.",
  );
  equal(
    reads,
    bounded.service.snapshot.executionModel!.policy.maxAgentDecisions,
  );
  equal(bounded.contexts.length, reads);
  ok(bounded.service.snapshot.error?.includes("limite de décisions"));
});

Deno.test("network consultation uses the same host catalog in snapshots, decisions and dispatch with exact bounded observations", async () => {
  const tools = modelContextTools({
    networkImpact: {
      scope: "own-history",
      limits: { ...DEFAULT_NETWORK_IMPACT_LIMITS },
      maxPageSize: 3,
      maxResponseCharacters: 12_000,
    },
  });
  const result = {
    operation: "network_impact",
    action: "details",
    analysisRef: "opaque",
    items: [{ explanation: "exact observation ".repeat(80) }],
  };
  let reads = 0;
  let decisions = 0;
  let correlatedId = "", correlatedResult = "";
  const reader: DecisionInformationPort = {
    ...information(),
    modelTools: () => structuredClone(tools),
    consultModel(_model, input, _messages, budget) {
      reads++;
      equal(input.operation, "network_impact");
      ok(budget?.maxResponseCharacters);
      ok(budget.maxResponseCharacters < 30_000);
      return Promise.resolve(result);
    },
  };
  const f = fixture({
    explicitCommands: true,
    information: reader,
    decide: (context) => {
      deepStrictEqual(context.modelTools, tools);
      decisions++;
      if (decisions === 1) {
        return {
          kind: "consult_model",
          text: "Read a bounded page",
          inputJson: JSON.stringify({
            operation: "network_impact",
            version: overview.version,
            action: "details",
            analysisRef: "opaque",
            view: "evidence",
          }),
        };
      }
      // The one-message projection retains the newer declared source read.
      // The explicit command's correlated receipt must still reach the provider
      // intact, independently of which journal messages the policy selects.
      const receipts = context.toolCallHistory?.flatMap((exchange) =>
        exchange.results.map((entry) => ({
          id: entry.id,
          encoded: entry.result,
          result: JSON.parse(entry.result),
        }))
      );
      equal(receipts?.length, 1);
      match(receipts![0]!.id, /^host-scalar:/);
      correlatedId = receipts![0]!.id;
      correlatedResult = receipts![0]!.encoded;
      deepStrictEqual(context.toolCallHistory![0].assistantBlocks, []);
      equal(context.contextEvidence!.policy.recentMessages, 1);
      equal(receipts![0]!.result.code, "MODEL_CONSULTATION_COMPLETED");
      equal(receipts![0]!.result.status, "succeeded");
      deepStrictEqual(receipts![0]!.result.value, result);
      ok(JSON.stringify(context).length <= 30_000);
      return { kind: "reply", text: "Observed" };
    },
  });
  await f.service.initialize();
  deepStrictEqual(f.saved()!.modelTools, tools);
  await f.service.submit("Consult history");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(reads, 1);
  equal(decisions, 2);
  const batch = f.saved()!.conversationBatches!.find((batch) =>
    batch.calls.some((call) => call.id === correlatedId)
  )!;
  equal(Object.hasOwn(batch, "assistantBlocks"), false);
  equal(batch.calls[0].status, "completed");
  deepStrictEqual(batch.calls[0].result, JSON.parse(correlatedResult));
  deepStrictEqual(
    f.service.snapshot.messages.findLast((message) =>
      message.observation?.kind === "model-context" &&
      (message.observation.value as { operation?: string }).operation ===
        "network_impact"
    )?.observation?.value,
    result,
  );

  let forbiddenReads = 0;
  let deniedDecisions = 0;
  const denied = fixture({
    explicitCommands: true,
    information: {
      ...reader,
      modelTools: () => modelContextTools(),
      consultModel() {
        forbiddenReads++;
        return Promise.resolve({});
      },
    },
    decide: () =>
      ++deniedDecisions === 1
        ? {
          kind: "consult_model",
          text: "Try unavailable history",
          inputJson: JSON.stringify({
            operation: "network_impact",
            version: overview.version,
            action: "details",
            analysisRef: "opaque",
            view: "evidence",
          }),
        }
        : { kind: "reply", text: "Unavailable" },
  });
  await denied.service.initialize();
  await denied.service.submit("Consult history");
  await denied.service.idle();
  equal(forbiddenReads, 0);
  ok(
    denied.service.snapshot.events.some((event) =>
      event.kind === "model-tool-refused"
    ),
  );
});

Deno.test("an explicit flow without declared consultation persists its reply without a read token", async () => {
  const f = fixture({
    explicitCommands: true,
    legacyDeclaredConsultation: false,
    information: information(),
  });
  await f.service.initialize();
  await f.service.submit("Continue without rereading the flow");
  await f.service.idle();
  equal(f.contexts.length, 1);
  equal(f.consultations.length, 0);
  equal(f.service.snapshot.error, undefined);
  ok(
    f.service.snapshot.messages.some((message) =>
      message.role === "assistant" && message.text === "Observed"
    ),
  );
});

Deno.test("an old pinned flow preserves an oversized exact scalar receipt and visibly refuses the next decision", async () => {
  const result = { operation: "search", text: "x".repeat(40_000) };
  let reads = 0;
  const f = fixture({
    explicitCommands: true,
    legacyDeclaredConsultation: true,
    information: {
      ...information(),
      consultModel() {
        reads++;
        return Promise.resolve(result);
      },
    },
    decide: () => ({
      kind: "consult_model",
      text: "Read one exact result",
      inputJson: JSON.stringify({
        operation: "search",
        version: overview.version,
      }),
    }),
  });
  await f.service.initialize();
  await f.service.submit("Inspect the exact result within the context policy");
  await f.service.idle();
  equal(
    f.contexts.length,
    1,
    "No provider receives a partial correlated result",
  );
  equal(reads, 1);
  equal(f.service.snapshot.error, undefined);
  equal(f.model.contextPolicy!.recentMessages, 1);
  equal(f.model.contextPolicy!.maxContextCharacters, 30_000);
  ok(
    f.consultations.length > 0,
    "The old pinned graph still executes its consultation",
  );
  ok(f.consultations.every((consultation) => consultation.succeeded));
  const refusalMessage = f.service.snapshot.messages.find((message) =>
    message.role === "assistant" &&
    message.text.includes("DECISION_CONTEXT_REFUSED")
  );
  ok(refusalMessage, "The refusal is visible in the conversation");
  const refusal = JSON.parse(refusalMessage.text.split("\n")[1]);
  equal(refusal.code, "DECISION_CONTEXT_REFUSED");
  equal(refusal.context.modelDigest, f.model.version.digest);
  equal(refusal.context.maximumCharacters, 30_000);
  ok(refusal.context.minimumCharacters > 30_000);
  ok(refusal.recovery.length > 0);
  match(
    refusal.message,
    /^The required decision context and evidence index need [0-9]+ JSON characters; the native policy permits 30000\.$/,
  );
  const batch = f.saved()!.conversationBatches![0];
  match(batch.calls[0].id, /^host-scalar:/);
  equal(batch.calls[0].status, "completed");
  equal(Object.hasOwn(batch, "assistantBlocks"), false);
  deepStrictEqual(batch.calls[0].result?.value, result);
  equal(batch.calls[0].result?.details, "Model consultation completed.");
  // An old pinned flow is not a native provider turn: its exact value stays
  // inline (one copy, above) and no journal reference is created.
  equal(batch.calls[0].result?.reference, undefined);
  const [execution] = await f.execution!.execution.inspect(
    f.model.identity.builderId,
  );
  equal(execution.status, "waiting");
  equal(execution.waits.length, 1);
  equal(execution.waits[0].mechanism, "await_input");
  deepStrictEqual(execution.unsettledEffects, []);
});

Deno.test("consult_model inputJson bound counts code points, not UTF-16 units", async () => {
  for (const over of [false, true]) {
    let reads = 0;
    const reader = {
      ...information(),
      consultModel() {
        reads++;
        return Promise.resolve({ result: { operation: "search", items: [] } });
      },
    };
    const skeleton = JSON.stringify({
      operation: "search",
      version: overview.version,
      pad: "",
    });
    const inputJson = JSON.stringify({
      operation: "search",
      version: overview.version,
      pad: "😀".repeat(65_536 - skeleton.length + (over ? 1 : 0)),
    });
    let calls = 0;
    const f = fixture({
      explicitCommands: true,
      information: reader,
      decide: (): ChatDecision => {
        calls++;
        return calls === 1
          ? { kind: "consult_model", text: "Search", inputJson }
          : { kind: "reply", text: "Observed" };
      },
    });
    await f.service.initialize();
    await f.service.submit("Search");
    await f.service.idle();
    equal(f.service.snapshot.error, undefined);
    equal(reads, over ? 0 : 1);
  }
});

Deno.test("loaded source bytes survive a tight message projection and can be proposed at their exact base", async () => {
  const f = fixture({
    information: information(true),
    decide(context) {
      equal(context.modelSources!.sources["system.sysml"], source);
      return {
        kind: "propose_sysml_revision",
        text: "Proposal",
        reason: "Scoped edit",
        baseVersion: context.modelSources!.version,
        sources: { "system.sysml": source.replace("Exact", "Revised") },
      };
    },
  });
  await f.service.initialize();
  await f.service.submit("Propose a revision");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  deepStrictEqual(f.counts(), { fullReads: 0, proposals: 1 });
});

Deno.test("selective proposals cannot overwrite unread files or silently change base", async () => {
  for (const changedBase of [false, true]) {
    const f = fixture({
      information: information(changedBase),
      decide: () => ({
        kind: "propose_sysml_revision",
        text: "Proposal",
        reason: "Invalid edit",
        baseVersion: changedBase ? "branch:other" : overview.version,
        sources: { "system.sysml": "package Guessed;" },
      }),
    });
    await f.service.initialize();
    await f.service.submit("Propose a revision");
    await expectFailedTurn(
      f,
      changedBase
        ? "La proposition doit conserver la version source consultée."
        : "Le fichier system.sysml doit être lu intégralement avant sa modification.",
    );
    equal(f.counts().proposals, 0);
    ok(
      f.service.snapshot.error?.includes(
        changedBase ? "version source consultée" : "lu intégralement",
      ),
    );
  }
});

Deno.test("an incomplete standard reader fails closed while custom legacy adapters remain supported", async () => {
  const missing = fixture({
    information: {
      read: () => Promise.resolve({ memoryGuidance: [] }),
      consultModel: () => {
        throw new Error("Unavailable");
      },
    },
  });
  await missing.service.initialize();
  await missing.service.submit("Inspect");
  await expectFailedTurn(
    missing,
    "La consultation du modèle admise exige une base source exacte et son lecteur local.",
  );
  equal(missing.contexts.length, 0);
  equal(missing.counts().fullReads, 0);
  ok(missing.service.snapshot.error?.includes("lecteur local"));
  const legacy = fixture();
  await legacy.service.initialize();
  await legacy.service.submit("Inspect");
  await legacy.service.idle();
  equal(legacy.service.snapshot.error, undefined);
  equal(legacy.contexts[0]!.modelContext, undefined);
  equal(legacy.contexts[0]!.modelSources!.sources["system.sysml"], source);
  equal(legacy.counts().fullReads, 1);
});

Deno.test("consultation remains available without an edit policy and fake edits are rejected", async () => {
  const f = fixture({
    information: information(),
    editing: true,
    noEditPolicy: true,
    decide: (context) => {
      equal(context.modelTools!.length, 6);
      equal(context.modelEditing!.targetedEdits, false);
      equal(context.modelEditing!.rawRevision, false);
      return {
        kind: "propose_sysml_edit",
        text: "fake",
        reason: "fake",
        baseVersion: overview.version,
        sourceDigest: overview.sourceDigest,
        edits: [{ kind: "remove", elementId: "member" }],
      };
    },
  });
  await f.service.initialize();
  await f.service.submit("Edit");
  await expectFailedTurn(
    f,
    "Le modèle natif ne permet pas de proposer une édition SysML ciblée.",
  );
  equal(f.counts().proposals, 0);
  equal(f.editRequests().length, 0);
  ok(f.service.snapshot.error);
});

Deno.test("a direct raw revision decision cannot bypass absent scoped policy", async () => {
  const f = fixture({
    information: information(),
    noEditPolicy: true,
    decide: () => ({
      kind: "propose_sysml_revision",
      text: "fake",
      reason: "fake",
      baseVersion: overview.version,
      sources: { "new.sysml": "package New;" },
    }),
  });
  await f.service.initialize();
  await f.service.submit("Edit");
  await expectFailedTurn(
    f,
    "Le modèle natif ne permet pas de proposer une révision SysML.",
  );
  equal(f.counts().proposals, 0);
  ok(f.service.snapshot.error);
});

Deno.test("a direct targeted decision cannot bypass the admitted operation list", async () => {
  const f = fixture({
    information: information(),
    editing: true,
    decide: () => ({
      kind: "propose_sysml_edit",
      text: "fake",
      reason: "fake",
      baseVersion: overview.version,
      sourceDigest: overview.sourceDigest,
      edits: [{ kind: "remove", elementId: "member" }],
    }),
  });
  f.model.modelEditPolicy!.operations = ["rename"];
  await f.service.initialize();
  await f.service.submit("Edit");
  await expectFailedTurn(
    f,
    "Le modèle natif ne permet pas de proposer une édition SysML ciblée.",
  );
  equal(f.editRequests().length, 0);
  ok(f.service.snapshot.error);
});

function diagnostic(
  code: string,
  severity: ModelDiagnostic["severity"] = "warning",
  masked = false,
): ModelDiagnostic & { masked: boolean } {
  return { code, severity, finding: "absent", message: code, masked };
}

Deno.test("a Case conversation never receives designer diagnostics", async () => {
  const versions: string[] = [];
  const f = fixture({
    operatorPrimary: true,
    modelDiagnostics: {
      read(model) {
        versions.push(model.version.repositoryVersion!);
        return Promise.resolve([diagnostic("UNMASKED_ERROR", "error")]);
      },
    },
  });
  await f.service.initialize();
  await f.service.submit("Inspecter le modèle", undefined, undefined, true);
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  // Warnings belong to the designer, never to a Request, Job or Watch.
  deepStrictEqual(versions, []);
  equal(Object.hasOwn(f.contexts[0]!, "modelDiagnostics"), false);
  ok(f.contexts[0]!.contextEvidence);
});
Deno.test("designer decision context carries the declared operator mission (B11)", async () => {
  const f = fixture({ operatorPrimary: true });
  f.model.operator = {
    name: "Designer",
    instruction:
      "Design and evolve this system with the person, and create operators to handle Requests.",
    primary: true,
    humanInput: true,
  };
  await f.service.initialize();
  await f.service.submit("Design the next operator");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  deepStrictEqual(f.contexts[0]!.operator, {
    nativeId: f.model.identity.builderId,
    name: "Designer",
    instruction:
      "Design and evolve this system with the person, and create operators to handle Requests.",
  });
});
Deno.test("secondary operators neither read nor receive designer diagnostics", async () => {
  let reads = 0;
  const f = fixture({
    operatorPrimary: false,
    modelDiagnostics: {
      read() {
        reads++;
        return Promise.resolve([diagnostic("DESIGNER_ONLY")]);
      },
    },
  });
  await f.service.initialize();
  await f.service.submit("Effectuer la mission");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(reads, 0);
  equal(Object.hasOwn(f.contexts[0]!, "modelDiagnostics"), false);
});

Deno.test("diagnostics and addresses fail closed for missing, ambiguous or stale registered roles", async () => {
  for (const targeted of [false, true]) {
    for (
      const role of [
        "secondary-without-metadata",
        "secondary-with-primary-metadata",
        "missing-entry",
        "empty-registry",
        "ambiguous-primary",
        "unknown-primary",
        "audit-only",
        "stale-digest",
        "stale-version",
        "unavailable-registry",
      ]
    ) {
      let reads = 0;
      const address = { code: "DESIGNER_ONLY", elementId: "native-element" };
      const f = fixture({
        information: information(true),
        editing: targeted,
        operatorPrimary: !role.startsWith("secondary"),
        modelDiagnostics: {
          read() {
            reads++;
            return Promise.resolve([{
              ...diagnostic(address.code),
              ...address,
            }]);
          },
        },
        decide(context) {
          equal(Object.hasOwn(context, "modelDiagnostics"), false, role);
          const common = {
            text: "Propose a correction",
            reason: "Claim a diagnostic correction",
            baseVersion: overview.version,
            addresses: [address],
          };
          return targeted
            ? {
              ...common,
              kind: "propose_sysml_edit",
              sourceDigest: overview.sourceDigest,
              edits: [{ kind: "remove", elementId: address.elementId }],
            }
            : {
              ...common,
              kind: "propose_sysml_revision",
              sources: { "system.sysml": "package Revised;" },
            };
        },
      });
      if (role === "secondary-with-primary-metadata") {
        f.model.operator!.primary = true;
      } else delete f.model.operator;
      const entry = f.registry.snapshot.conversations[0]!;
      if (role === "missing-entry") entry.agentId = entry.nativeId = "other";
      if (role === "empty-registry") f.registry.snapshot.conversations = [];
      if (role === "ambiguous-primary") {
        f.registry.snapshot.conversations.push({
          ...entry,
          agentId: "other",
          nativeId: "other",
        });
      }
      if (role === "unknown-primary") {
        delete (entry as Partial<typeof entry>).primary;
      }
      if (role === "audit-only") entry.runtimeOwned = false;
      if (role === "stale-digest") entry.modelDigest = "obsolete";
      if (role === "stale-version") entry.repositoryVersion = "obsolete";
      if (role === "unavailable-registry") {
        f.service.bindOperatorRegistry({
          get snapshot(): ConversationsSnapshot {
            throw new Error("Unavailable registry");
          },
        });
      }
      await f.service.initialize();
      await f.service.submit("Correct the diagnostic");
      await expectFailedTurn(
        f,
        "Only the primary operator may address model diagnostics",
      );
      equal(f.contexts.length, 1, role);
      equal(reads, 0, role);
      equal(f.revisionRequests().length, 0, role);
      equal(f.editRequests().length, 0, role);
      ok(f.service.snapshot.error?.includes("Only the primary operator"), role);
    }
  }
});

Deno.test("an absent diagnostics port preserves existing conversation contexts", async () => {
  const f = fixture();
  await f.service.initialize();
  await f.service.submit("Continuer");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(Object.hasOwn(f.contexts[0]!, "modelDiagnostics"), false);
});

Deno.test("an unavailable diagnostic or mask reader cannot block the conversational decision", async () => {
  const f = fixture({
    operatorPrimary: true,
    modelDiagnostics: {
      read: () => Promise.reject(new Error("Instance mask store unavailable")),
    },
  });
  await f.service.initialize();
  await f.service.submit("Continuer malgré la panne du linter");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(f.contexts.length, 1);
  equal(Object.hasOwn(f.contexts[0]!, "modelDiagnostics"), false);
  ok(
    f.service.snapshot.messages.some((message) =>
      message.role === "assistant" && message.text === "Observed"
    ),
  );
});

Deno.test("omitting diagnostics still rejects an oversized required decision context", async () => {
  const f = fixture({
    modelDiagnostics: {
      read: () => Promise.resolve([diagnostic("OPTIONAL_WARNING")]),
    },
  });
  f.model.contextPolicy!.maxContextCharacters = 4096;
  await f.service.initialize();
  await f.service.submit("Inspecter le modèle");
  await f.service.idle();
  equal(f.contexts.length, 0);
  equal(f.service.snapshot.error, undefined);
  const refusalMessage = f.service.snapshot.messages.find((message) =>
    message.role === "assistant" &&
    message.text.includes("DECISION_CONTEXT_REFUSED")
  );
  ok(
    refusalMessage,
    "The context refusal must be persisted as a visible reply",
  );
  const refusal = JSON.parse(refusalMessage.text.split("\n")[1]);
  equal(refusal.code, "DECISION_CONTEXT_REFUSED");
  equal(refusal.context.modelDigest, f.model.version.digest);
  equal(refusal.context.maximumCharacters, 4096);
  ok(refusal.context.minimumCharacters > 4096);
  ok(refusal.recovery.length > 0);
  match(
    refusal.message,
    /^The required decision context and evidence index need [0-9]+ JSON characters; the native policy permits 4096\.$/,
  );
});

Deno.test("registered and historical primary corrections validate the full base beyond the prompt subset", async () => {
  for (const operatorPrimary of [undefined, true]) {
    for (const targeted of [false, true]) {
      const address = { code: "INFORMATION", elementId: "native-element" };
      const reads: Array<string | undefined> = [];
      const f = fixture({
        information: information(true),
        editing: targeted,
        operatorPrimary,
        modelDiagnostics: {
          read(_model, version) {
            reads.push(version);
            return Promise.resolve(
              version === undefined
                ? Array.from(
                  { length: 25 },
                  (_, i) => diagnostic(`WARNING_${i}`),
                )
                : [{ ...diagnostic(address.code, "info", true), ...address }],
            );
          },
        },
        decide(context) {
          equal(context.modelDiagnostics?.length, 20);
          const common = {
            text: "Propose a correction",
            reason: "Correct the base-version finding",
            baseVersion: overview.version,
            addresses: [address],
          };
          return targeted
            ? {
              ...common,
              kind: "propose_sysml_edit",
              sourceDigest: overview.sourceDigest,
              edits: [{ kind: "remove", elementId: address.elementId }],
            }
            : {
              ...common,
              kind: "propose_sysml_revision",
              sources: { "system.sysml": "package Revised;" },
            };
        },
      });
      await f.service.initialize();
      await f.service.submit("Correct the diagnostic");
      await f.service.idle();
      equal(f.service.snapshot.error, undefined);
      // The full correction base is independent of the bounded prompt diagnostics.
      deepStrictEqual(reads, [undefined, overview.version]);
      const request = targeted
        ? f.editRequests()[0]!.request
        : f.revisionRequests()[0]!;
      deepStrictEqual(request.addresses, [address]);
      equal(
        f.service.snapshot.executionModel?.version.repositoryVersion,
        "commit:shared-source",
      );
    }
  }
});

Deno.test("secondary operators can propose revisions and edits with empty diagnostic addresses", async () => {
  for (const targeted of [false, true]) {
    for (const withDiagnostics of [false, true]) {
      let reads = 0;
      const f = fixture({
        information: information(true),
        editing: targeted,
        operatorPrimary: false,
        ...(withDiagnostics
          ? {
            modelDiagnostics: {
              read() {
                reads++;
                return Promise.resolve([]);
              },
            },
          }
          : {}),
        decide() {
          const common = {
            text: "Propose a change",
            reason: "No diagnostic correction is claimed",
            baseVersion: overview.version,
            addresses: [],
          };
          return targeted
            ? {
              ...common,
              kind: "propose_sysml_edit",
              sourceDigest: overview.sourceDigest,
              edits: [{ kind: "remove", elementId: "native-element" }],
            }
            : {
              ...common,
              kind: "propose_sysml_revision",
              sources: { "system.sysml": "package Revised;" },
            };
        },
      });
      await f.service.initialize();
      await f.service.submit("Propose a change");
      await f.service.idle();
      equal(f.service.snapshot.error, undefined);
      equal(reads, 0);
      const requests = targeted
        ? f.editRequests().map(({ request }) => request)
        : f.revisionRequests();
      equal(requests.length, 1);
      equal(Object.hasOwn(requests[0]!, "addresses"), false);
    }
  }
});

Deno.test("diagnostic correction rejects unknown pairs, wrong base, unavailable validation and secondary operators", async () => {
  for (
    const denied of [
      "code",
      "element",
      "base",
      "unavailable",
      "secondary",
      "reader-failed",
    ] as const
  ) {
    const reads: Array<string | undefined> = [];
    const address = {
      code: "LOOP_WITHOUT_BUDGET",
      elementId: "native-element",
    };
    const f = fixture({
      information: information(true),
      operatorPrimary: denied !== "secondary",
      ...(denied !== "unavailable"
        ? {
          modelDiagnostics: {
            read(
              _model: Parameters<ModelDiagnosticsPort["read"]>[0],
              version?: string,
            ) {
              reads.push(version);
              if (version && denied === "reader-failed") {
                return Promise.reject(
                  new Error("Diagnostic reader unavailable"),
                );
              }
              return Promise.resolve(
                version && denied === "base"
                  ? []
                  : [{ ...diagnostic(address.code), ...address }],
              );
            },
          },
        }
        : {}),
      decide: () => ({
        kind: "propose_sysml_revision",
        text: "Invalid correction",
        reason: "Must address an existing base diagnostic",
        baseVersion: overview.version,
        sources: { "system.sysml": "package Revised;" },
        addresses: [{
          code: denied === "code" ? "INVENTED" : address.code,
          elementId: denied === "element" ? "other-element" : address.elementId,
        }],
      }),
    });
    await f.service.initialize();
    await f.service.submit("Correct the diagnostic");
    await expectFailedTurn(
      f,
      denied === "secondary"
        ? "Only the primary operator may address model diagnostics"
        : denied === "unavailable"
        ? "Diagnostic validation is unavailable for this proposal"
        : denied === "reader-failed"
        ? "Diagnostic reader unavailable"
        : "Every addressed diagnostic must exist in the proposal's base version",
    );
    equal(f.revisionRequests().length, 0);
    ok(f.service.snapshot.error);
    if (denied === "secondary") deepStrictEqual(reads, []);
    if (["code", "element", "base"].includes(denied)) {
      ok(f.service.snapshot.error?.includes("proposal's base version"));
    }
  }
});

Deno.test("conversation serialization preserves full known graph failure provenance in context and durable receipt", async () => {
  const build = {
    repositoryId: "fixture",
    sourceDigest: overview.sourceDigest,
    recipeDigest: "c".repeat(64),
    buildKey: "d".repeat(64),
    artifactDigest: "e".repeat(64),
  };
  const projection = {
    kind: "rdf-quads",
    projectorVersion: "pinned-projector",
    artifactDigest: build.artifactDigest,
    projectionDigest: "f".repeat(64),
  };
  const recovery =
    "Restore the exact pinned index and retry this source version";
  const expected = {
    status: "refused",
    operation: "inspect",
    code: "INDEX_TIMEOUT",
    message: "Native graph deadline exceeded",
    version: overview.version,
    build,
    projection,
    recovery,
  };
  let calls = 0;
  let correlatedId = "", correlatedResult = "";
  const f = fixture({
    explicitCommands: true,
    information: {
      ...information(),
      consultModel() {
        throw new ModelNavigationError({
          state: "unavailable",
          advisory: true,
          version: overview.version,
          code: "INDEX_TIMEOUT",
          message: expected.message,
          build,
          projection,
          recovery,
        });
      },
    },
    decide(context) {
      if (calls++ === 0) {
        return {
          kind: "consult_model",
          text: "Inspect the pinned graph",
          inputJson: JSON.stringify({
            operation: "inspect",
            version: overview.version,
            elementId: "native",
          }),
        };
      }
      const receipts = context.toolCallHistory?.flatMap((exchange) =>
        exchange.results
      );
      equal(receipts?.length, 1);
      equal(receipts![0]!.isError, true);
      match(receipts![0]!.id, /^host-scalar:/);
      correlatedId = receipts![0]!.id;
      correlatedResult = receipts![0]!.result;
      deepStrictEqual(context.toolCallHistory![0].assistantBlocks, []);
      equal(context.contextEvidence!.policy.recentMessages, 1);
      ok(JSON.stringify(context).length <= 30_000);
      const receipt = JSON.parse(receipts![0]!.result);
      equal(receipt.code, "MODEL_CONSULTATION_REFUSED");
      equal(receipt.status, "refused");
      deepStrictEqual(receipt.value, expected);
      return { kind: "reply", text: "The known graph failure stays pinned" };
    },
  });
  await f.service.initialize();
  await f.service.submit("Inspect the source-pinned graph");
  await f.service.idle();
  equal(f.service.snapshot.error, undefined);
  equal(calls, 2);
  const batch = f.saved()!.conversationBatches!.find((batch) =>
    batch.calls.some((call) => call.id === correlatedId)
  )!;
  equal(Object.hasOwn(batch, "assistantBlocks"), false);
  equal(batch.calls[0].status, "completed");
  deepStrictEqual(batch.calls[0].result, JSON.parse(correlatedResult));
  const receipt = f.saved()!.messages.find((m) =>
    m.observation?.kind === "model-context" &&
    (m.observation.value as { code?: string }).code === "INDEX_TIMEOUT"
  )!;
  deepStrictEqual(receipt.observation, {
    kind: "model-context",
    value: expected,
  });
  equal(
    f.saved()!.events.filter((e) => e.kind === "model-tool-refused").length,
    1,
  );
});

Deno.test("designer warnings carry a clickable exact-source Diagnostics destination only after a successful read", async () => {
  const version = `commit:${"c".repeat(40)}`;
  for (const unavailable of [false, true]) {
    const f = fixture({
      operatorPrimary: true,
      sourceVersion: version,
      modelDiagnostics: {
        read(model) {
          equal(model.version.repositoryVersion, version);
          return unavailable
            ? Promise.reject(new Error("diagnostics unavailable"))
            : Promise.resolve([diagnostic("DESIGN_WARNING")]);
        },
      },
    });
    await f.service.initialize();
    await f.service.submit("Show the design problems");
    await f.service.idle();
    equal(f.service.snapshot.error, undefined);
    const view = f.contexts[0]!.modelDiagnosticsView;
    if (unavailable) {
      equal(view, undefined);
      equal(f.contexts[0]!.modelDiagnostics, undefined);
    } else {
      equal(view?.version, version);
      const address = new URL(view!.href, "http://local");
      equal(address.pathname, "/system");
      equal(address.searchParams.get("page"), "diagnostics");
      equal(address.searchParams.get("version"), version);
      equal(address.searchParams.has("caseBranch"), false);
    }
  }
});

Deno.test("model consultation receipts carry exact-source Diagnostics links for Main and Request", async () => {
  const version = `commit:${"d".repeat(40)}`;
  for (const request of [false, true]) {
    let decisions = 0;
    const baseline = information();
    const reader: DecisionInformationPort = {
      ...baseline,
      async read(model, messages) {
        const data = await baseline.read(model, messages);
        ok(data.modelContext);
        ok(data.modelSources);
        return {
          ...data,
          modelContext: { ...data.modelContext, version },
          modelSources: { ...data.modelSources, version },
        };
      },
      consultModel(_model, query) {
        equal(query.version, version);
        return Promise.resolve({
          modelVersion: {
            digest: "execution",
            repositoryVersion: "commit:other-pin",
          },
          result: { operation: "search", version, items: [] },
        });
      },
    };
    const f = fixture({
      information: reader,
      explicitCommands: true,
      decide: () =>
        ++decisions === 1
          ? {
            kind: "consult_model",
            text: "Inspect",
            inputJson: JSON.stringify({ operation: "search", version }),
          }
          : { kind: "reply", text: "Observed" },
    });
    await f.service.initialize();
    await f.service.submit(
      "Inspect model",
      undefined,
      undefined,
      request ? true : undefined,
    );
    await f.service.idle();
    equal(f.service.snapshot.error, undefined);
    const observations = f.service.snapshot.messages.filter((message) => {
      const value = message.observation?.value as {
        result?: { version?: string };
      } | undefined;
      return message.observation?.kind === "model-context" &&
        value?.result?.version === version;
    });
    equal(
      observations.length,
      1,
      "select the exact search receipt, not the automatic admitted-source read",
    );
    const observation = observations[0]!.observation!;
    const value = observation.value as {
      modelDiagnosticsView?: { version: string; href: string };
    };
    ok(value.modelDiagnosticsView);
    equal(value.modelDiagnosticsView.version, version);
    const address = new URL(value.modelDiagnosticsView.href, "http://local");
    equal(address.searchParams.get("version"), version);
    equal(address.searchParams.get("page"), "diagnostics");
    equal(
      address.searchParams.get("caseBranch"),
      request ? f.contexts[0]!.case!.id : null,
    );
    equal(f.contexts[0]!.modelDiagnostics, undefined);
  }
});

for (
  const [read, revision, allowed] of [
    [true, true, true],
    [true, false, true],
    [false, false, false],
    [undefined, true, true],
    [undefined, false, false],
  ] as const
) {
  Deno.test(`runtime snapshot model tools read=${read}, revision=${revision} follow read authority`, async () => {
    const f = fixture({ information: information() });
    f.model.policy.mayProposeSysmlRevision = revision;
    if (read !== undefined) f.model.policy.mayConsultModel = read;
    else delete f.model.policy.mayConsultModel;
    await f.service.initialize();
    equal(!!f.service.snapshot.modelTools?.length, allowed);
    await f.service.submit("Continue within the admitted rights");
    await f.service.idle();
    equal(!!f.service.snapshot.modelTools?.length, allowed);
    equal(!!f.contexts[0].modelTools?.length, allowed);
    equal(f.contexts[0].modelEditing?.targetedEdits, false);
    equal(f.service.snapshot.error, undefined);
  });
}
