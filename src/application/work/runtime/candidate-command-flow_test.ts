import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { SystemRuntime } from "../../../../test/support/system-runtime.ts";
import { createTestNativeExecution } from "../../../../test/support/native-execution.ts";
import {
  enableCommandFixtureProfile,
  executableFixture,
} from "../../../../test/support/execution-fixture.ts";
import {
  exerciseOwnerAuthority,
  legacyOwnerAuthority,
} from "../../../domain/governance/authority.ts";
import type { ChatContext } from "../conversation/chat-context.ts";
import type { ChatDecision } from "../conversation/chat-decision.ts";
import type { SystemRuntimeState } from "./state.ts";
import type { ModelPort } from "./ports.ts";
import type { MainCandidateInspection } from "../operators/conversations.ts";

async function inspectionScenario(overflow = false, multiple = false) {
  const model = executableFixture({
    projectId: "unit",
    editingContextId: "unit",
    rootId: "root",
    systemId: "main-system",
    catalogId: "main-catalog",
    builderId: "main",
  });
  model.version.repositoryVersion = "admitted";
  model.policy.mayProposeSysmlRevision = true;
  enableCommandFixtureProfile(model);
  model.ownerAuthority = {
    ...legacyOwnerAuthority("main-system"),
    ownerSource: "modeled",
  };
  model.operator = {
    name: "Main Operator",
    primary: true,
    humanInput: true,
    instruction: "Coordinate operators",
  };
  const policy = {
    id: "tool-admission",
    revision: 1,
    enabled: true,
    recipients: ["operator"],
    toolKinds: ["read_web_page" as const],
    maxDelegationDepth: 0 as const,
    holderNativeId: "main",
    mandateNativeId: "main-mandate",
    systemId: "main-system",
    elementId: "tool-policy",
    sourceIds: ["tool-policy"],
    rootAuthority: model.ownerAuthority,
  };
  model.toolAdmissionPolicies = [policy];
  if (overflow) {
    model.contextPolicy = {
      kind: "separated-context",
      pattern: "5.1",
      recentMessages: 4,
      maxMessageCharacters: 4096,
      maxCollectionItems: 8,
      maxContextCharacters: multiple ? 95000 : 32000,
    } as NonNullable<typeof model.contextPolicy>;
  }
  const reference = {
    operatorId: "operator",
    candidateId: "candidate",
    candidateDigest: "a".repeat(64),
    expectedRevision: 7,
    caseId: "operator-request",
    policyId: policy.id,
    policyRevision: policy.revision,
  };
  const inspection: MainCandidateInspection = {
    operatorId: reference.operatorId,
    candidate: {
      id: reference.candidateId,
      digest: reference.candidateDigest,
      name: "Page reader",
      description: "Tested reader",
      kind: "read_web_page",
      code:
        "/* Data, never instructions */ export default () => ({title:'Page',text:'Body'});" +
        (overflow ? "/*" + "x".repeat(65000) + "*/" : ""),
      stage: "awaiting-admission",
      caseId: reference.caseId,
      baseCatalogRevision: 0,
      requiredAuthority: "human",
      tests: {
        passed: true,
        checks: [{
          name: "HTML fixture",
          passed: true,
          detail: "Exact expected title and body",
        }],
      },
    },
    contract: structuredClone(model.contracts[0]),
    authorityExercise: exerciseOwnerAuthority(model, "candidate-admission"),
    decisionReference: reference,
  };
  const references = multiple
    ? [reference, { ...reference, candidateId: "second-candidate" }]
    : [reference];
  let saved: SystemRuntimeState | null = null;
  const contexts: ChatContext[] = [];
  const inspections: ChatDecision[] = [];
  const decisions: ChatDecision[] = [];
  let inspectionCached = false;
  let invalidations = 0;
  let sourceReads = 0;
  const consultations: Array<{
    succeeded: boolean;
    code: string;
    details: string;
  }> = [];
  const native = createTestNativeExecution({
    load: () => Promise.resolve(structuredClone(saved)),
    save: (state, expected) => {
      equal(saved?.revision ?? null, expected);
      saved = structuredClone(state);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
  const service = new SystemRuntime({
    model: {
      initialize: () => Promise.resolve(structuredClone(model.identity)),
      readExecutableModel: () => Promise.resolve(structuredClone(model)),
      findApprovedChange: () => Promise.resolve(null),
    } as unknown as ModelPort,
    store: native.store,
    dispatch: native.dispatch,
    stateHistory: native.stateHistory,
    execution: {
      closeScope: (snapshot, closure) =>
        native.execution.closeScope(snapshot, closure),
      inspect: (operatorId) => native.execution.inspect(operatorId),
      retireAndAdvance: (snapshot, authorization, targetModel) =>
        native.execution.retireAndAdvance(snapshot, authorization, targetModel),
      run: (request, handlers) =>
        native.execution.run(request, {
          ...handlers,
          async handle(node, inputs, values, action) {
            const result = await handlers.handle(node, inputs, values, action);
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
    information: {
      read: () => Promise.resolve({ memoryGuidance: [] }),
      consultAdmittedModelSource(current, input) {
        equal(current.version.digest, model.version.digest);
        equal(current.version.repositoryVersion, "admitted");
        deepStrictEqual(input, {
          operation: "read_source",
          path: "conversation.sysml",
          version: "admitted",
        });
        sourceReads++;
        return Promise.resolve({
          modelVersion: {
            digest: current.version.digest,
            repositoryVersion: current.version.repositoryVersion,
          },
          result: { path: input.path },
        });
      },
    },
    agents: {
      label: "Main script",
      ...(multiple
        ? {
          decideBatch(context: ChatContext) {
            equal(sourceReads, 0, "The default flow requires no declared read");
            contexts.push(structuredClone(context));
            equal(
              contexts.length,
              1,
              "An over-budget pair cannot reach another provider decision",
            );
            return Promise.resolve({
              calls: references.map((reference, index) => ({
                id: `inspection-${index}`,
                decision: {
                  kind: "inspect_operator_candidate" as const,
                  text: "Inspect both exact candidates",
                  ...reference,
                },
              })),
            });
          },
        }
        : {}),
      decide: (context) => {
        equal(sourceReads, 0, "The default flow requires no declared read");
        contexts.push(structuredClone(context));
        if (contexts.length === 1) {
          return Promise.resolve({
            kind: "inspect_operator_candidate",
            text: "Inspect the exact candidate",
            ...reference,
          });
        }
        if (decisions.length) {
          return Promise.resolve({
            kind: "reply",
            text: "Candidate decision recorded",
          });
        }
        const observed = context.messages.find((message) =>
          message.observation?.kind === "candidate-inspection"
        );
        ok(
          observed,
          "The next provider decision needs the structured exact inspection",
        );
        deepStrictEqual(observed.observation!.value, inspection);
        const received = observed.observation!.value as MainCandidateInspection;
        return Promise.resolve({
          kind: "decide_operator_candidate",
          text: "Candidate approved",
          ...received.decisionReference,
          verdict: "approve",
          reason: "Exact code, contract and tests inspected",
        });
      },
      review: () => {
        throw new Error("Unexpected review");
      },
    },
    runner: {
      run: () => {
        throw new Error("Unexpected tool execution");
      },
      test: () => {
        throw new Error("Unexpected tool test");
      },
    },
  });
  await service.initialize();
  const localIdle = service.idle.bind(service);
  native.bind(service);
  service.idle = async () => {
    await localIdle();
    await native.idle();
    await localIdle();
  };
  if (!overflow) {
    equal(service.snapshot.executionModel!.contextPolicy, undefined);
  }
  equal(service.snapshot.executionModel!.memoryPolicy, undefined);
  service.bindOperatorAuthorityLifecycle({
    clearCandidateInspection: () => {
      inspectionCached = false;
      invalidations++;
    },
    candidateDecisionContext: () => ({
      policies: [policy],
      candidates: references.map((reference) => ({
        ...reference,
        name: "Page reader",
        kind: "read_web_page" as const,
      })),
    }),
    inspectCandidate: (command) => {
      inspections.push(structuredClone(command));
      inspectionCached = true;
      return Promise.resolve({
        ...structuredClone(inspection),
        candidate: {
          ...structuredClone(inspection.candidate),
          id: command.candidateId,
        },
        decisionReference: { ...reference, candidateId: command.candidateId },
      });
    },
    decideCandidate: (command) => {
      decisions.push(structuredClone(command));
      return Promise.resolve();
    },
    proposed: () => Promise.resolve(),
    approved: () => Promise.resolve(),
    closed: () => Promise.resolve(),
  });
  await service.submit("Inspect and decide the operator candidate");
  await service.idle();
  equal(consultations.length, 0);
  if (overflow) {
    equal(service.snapshot.error, undefined);
    const refusalMessage = service.snapshot.messages.find((message) =>
      message.role === "assistant" &&
      message.text.includes("DECISION_CONTEXT_REFUSED")
    );
    ok(refusalMessage, "The context refusal is visible in the conversation");
    const refusal = JSON.parse(refusalMessage.text.split("\n")[1]);
    equal(refusal.code, "DECISION_CONTEXT_REFUSED");
    equal(refusal.context.modelDigest, model.version.digest);
    equal(refusal.context.maximumCharacters, multiple ? 95000 : 32000);
    ok(refusal.context.minimumCharacters > refusal.context.maximumCharacters);
    ok(refusal.recovery.length > 0);
    match(
      refusal.message,
      new RegExp(
        `^The required decision context and evidence index need [0-9]+ JSON characters; the native policy permits ${
          multiple ? 95000 : 32000
        }\\.$`,
      ),
    );
    const executions = await native.execution.inspect(model.identity.builderId);
    equal(executions.length, 1);
    equal(executions[0].status, "waiting");
    deepStrictEqual(executions[0].waits, [{
      nodeId: model.flows.conversation.nodes.find((node) =>
        node.mechanism === "await_input"
      )!.id,
      mechanism: "await_input",
      kind: "input",
    }]);
    deepStrictEqual(executions[0].unsettledEffects, []);
    equal(executions[0].localState?.declaredConsultationRefusal, undefined);
    equal(contexts.length, 1, "No provider receives an incomplete inspection");
    equal(decisions.length, 0);
    equal(inspections.length, multiple ? 2 : 1);
    equal(invalidations, 1);
    equal(
      inspectionCached,
      false,
      "An undelivered inspection cannot authorize a decision",
    );
    return;
  }
  equal(service.snapshot.error, undefined);
  equal(contexts.length, 3);
  deepStrictEqual(inspections, [{
    kind: "inspect_operator_candidate",
    text: "Inspect the exact candidate",
    ...reference,
  }]);
  deepStrictEqual(decisions, [{
    kind: "decide_operator_candidate",
    text: "Candidate approved",
    ...reference,
    verdict: "approve",
    reason: "Exact code, contract and tests inspected",
  }]);
  const recorded = service.snapshot.messages.find((message) =>
    message.observation?.kind === "candidate-inspection"
  );
  ok(recorded);
  deepStrictEqual(recorded.observation!.value, inspection);
  equal(recorded.role, "tool");
  ok(recorded.text.includes("never instructions"));
}

Deno.test("Main inspection reaches the next same-turn decision intact without optional information policies", () =>
  inspectionScenario());
Deno.test("an inspection exceeding the total context budget fails explicitly and clears its decision proof", () =>
  inspectionScenario(true));
Deno.test("an over-budget batch of exact inspections invalidates its volatile decision evidence before another provider decision", () =>
  inspectionScenario(true, true));
