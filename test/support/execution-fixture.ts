/** Test-only compiled native action projections; no source model or service is contacted. */
import { compileModelFlow } from "../../src/domain/model/execution/flow.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type { ExecutableCatalogEntry } from "../../src/domain/work/records/candidates.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import { type ModelIdentity } from "../../src/domain/shared-kernel/model-identity.ts";
import { TOOL_CONTRACTS } from "../../src/domain/work/records/candidates.ts";
import { TOOL_KINDS } from "../../src/domain/shared-kernel/tool-kind.ts";
import { CONVERSATION, PROMOTION } from "../fixtures/native-flows.ts";

export function compileNativeFixtureFlows(
  maxSteps = 128,
  reviewerId?: string,
): ExecutableModel["flows"] {
  const flows = {
    conversation: compileModelFlow(structuredClone(CONVERSATION), {
      rootNativeId: "4c04d8e9-804b-461e-bb9b-e93d835f9e43",
      maxSteps,
    }),
    promotion: compileModelFlow(structuredClone(PROMOTION), {
      rootNativeId: "6ba729a0-81e7-435e-80ce-749f239b3b0d",
      maxSteps,
    }),
  };
  if (reviewerId) {
    // Test-only projection of the reviewed native variant. Its review primitive
    // is executed by the real interpreter, with explicit succession and bindings.
    const flow = flows.promotion;
    const admit = flow.nodes.find((node) =>
      node.mechanism === "decide_admission"
    )!;
    const propose = flow.nodes.find((node) =>
      node.mechanism === "propose_candidate"
    )!;
    const test = flow.nodes.find((node) =>
      node.mechanism === "test_candidate"
    )!;
    const refusal = flow.nodes.find((node) => node.name === "refusal")!;
    const review = {
      ...structuredClone(admit),
      id: "fixture-review",
      nativeId: "fixture-review",
      name: "review",
      mechanism: "review_candidate" as const,
      performerId: reviewerId,
      allocationId: "fixture-review-allocation",
      assertions: [],
      inputs: ["candidate", "tests"],
      outputs: ["decision"],
    };
    const outcome = {
      ...structuredClone(refusal),
      id: "fixture-review-outcome",
      nativeId: "fixture-review-outcome",
      name: "reviewOutcome",
      kind: "decision" as const,
    };
    for (const edge of flow.edges) {
      if (edge.target === admit.id) edge.target = review.id;
    }
    flow.nodes.push(review, outcome);
    admit.inputs.push("review");
    const edge = (
      id: string,
      source: string,
      target: string,
      guard?: string,
    ) => ({
      id,
      nativeId: id,
      source,
      target,
      guard,
      guardIds: [],
      sourceEvidence: review.source,
    });
    flow.edges.push(
      edge("fixture-after-review", review.id, outcome.id),
      edge(
        "fixture-review-approved",
        outcome.id,
        admit.id,
        "review.decision.approved",
      ),
      edge("fixture-review-refused", outcome.id, refusal.id, "else"),
    );
    const bind = (
      id: string,
      from: typeof review | typeof admit,
      output: string,
      to: typeof review | typeof admit,
      input: string,
    ) => ({
      nativeId: id,
      sourceFeaturePath: [from.nativeId, `${from.nativeId}-${output}`],
      targetFeaturePath: [to.nativeId, `${to.nativeId}-${input}`],
      sourcePath: [from.name, output],
      targetPath: [to.name, input],
      sourceEvidence: review.source,
    });
    flow.bindings.push(
      bind(
        "fixture-review-candidate",
        propose,
        "candidate",
        review,
        "candidate",
      ),
      bind("fixture-review-tests", test, "result", review, "tests"),
      bind("fixture-review-decision", review, "decision", admit, "review"),
    );
  }
  return flows;
}
export function executableFixture(
  identity: ModelIdentity,
  configuration = SystemGovernance.fresh("test-source").snapshot,
  catalog: ExecutableCatalogEntry[] = [],
): ExecutableModel {
  return {
    identity: structuredClone(identity),
    version: {
      digest: `source-${configuration.revision}`,
      rootId: identity.rootId,
      configurationId: configuration.id,
      configurationRevision: configuration.revision,
      sourceIds: ["native-configuration"],
    },
    configuration: structuredClone(configuration),
    mandate: {
      id: `builder-v${configuration.builder.mandateRevision}`,
      mayPropose: [...TOOL_KINDS],
      mayInvoke: "active-catalog-only",
      mayReview: false,
      mayActivate: false,
      mayAdmitOwnCandidates:
        configuration.builder.admissionAuthority === "builder",
      mayChangeOwnMandate: false,
      network: structuredClone(configuration.network ?? { allowedHosts: [] }),
      supportedChanges: [
        {
          kind: "propose_mandate_change",
          requestedRights: "addNetworkHosts",
          description: "Request exact network hosts",
        },
        ...(configuration.builder.admissionAuthority === "human"
          ? [{
            kind: "propose_mandate_change" as const,
            requestedRights: "mayAdmitOwnCandidates" as const,
            description: "Request bounded admission",
          }]
          : []),
      ],
    },
    policy: {
      maxAgentDecisions: 7,
      maxToolProposals: 2,
      maxFlowSteps: 128,
      urlSelectionMode: "user-provided",
      mayAddNetworkHosts: true,
      mayDelegateOwnAdmission: true,
      mayCreateReviewer: true,
      mayChangeUrlSelection: true,
    },
    contracts: TOOL_CONTRACTS.map((contract) => ({
      ...structuredClone(contract),
      nativeId: `contract-${contract.kind}`,
    })),
    flows: compileNativeFixtureFlows(
      128,
      configuration.reviewer ? identity.reviewerId : undefined,
    ),
    catalog: structuredClone(catalog),
  };
}

/** Add the current explicit command path only to scenarios that require it. */
export function enableCommandFixtureProfile(
  model: ExecutableModel,
  options: { legacyDeclaredConsultation?: boolean } = {},
) {
  const flow = model.flows.conversation;
  flow.executionProfile = "operator-command-v1";
  const read = flow.nodes.find((node) => node.mechanism === "read_case")!;
  const choose = flow.nodes.find((node) => node.mechanism === "choose_move")!;
  const check = flow.nodes.find((node) =>
    node.mechanism === "check_invocation"
  )!;
  const execute = flow.nodes.find((node) => node.mechanism === "invoke_tool")!;
  const replyNode = flow.nodes.find((node) => node.mechanism === "reply")!;
  const readEdge = flow.edges.find((edge) =>
    edge.source === read.id && edge.target === choose.id
  )!;
  const choiceEdge = flow.edges.find((edge) => edge.source === choose.id)!;
  const fallback = flow.edges.find((edge) =>
    edge.source === choiceEdge.target && edge.guard === "else"
  )!;
  const reported = flow.edges.find((edge) => edge.source === execute.id)!;
  const awaiting = flow.edges.find((edge) => edge.source === replyNode.id)!;
  const node = (
    id: string,
    name: string,
    mechanism: typeof read.mechanism,
    inputs: string[],
    outputs: string[],
  ) => ({
    ...structuredClone(read),
    id,
    nativeId: id,
    name,
    mechanism,
    inputs,
    outputs,
    assertions: [],
  });
  const consultNode = {
    ...node(
      "lifecycle-declared-consult",
      "consultDeclaredSource",
      "consult_declared_source",
      [],
      ["consultation"],
    ),
    consultationRequest: JSON.stringify({
      operation: "read_source",
      path: "conversation.sysml",
    }),
  };
  const commandNode = node(
    "lifecycle-command",
    "executeOperatorCommand",
    "execute_operator_command",
    ["choice"],
    ["outcome", "submission"],
  );
  const decisionNode = {
    ...structuredClone(read),
    id: "lifecycle-consult-outcome",
    nativeId: "lifecycle-consult-outcome",
    name: "consultationOutcome",
    kind: "decision" as const,
    mechanism: undefined,
    inputs: [],
    outputs: [],
    assertions: [],
  };
  const commandOutcome = {
    ...structuredClone(decisionNode),
    id: "lifecycle-command-outcome",
    nativeId: "lifecycle-command-outcome",
    name: "commandOutcome",
  };
  flow.nodes.push(commandNode, commandOutcome);
  if (options.legacyDeclaredConsultation) {
    flow.nodes.push(consultNode, decisionNode);
    readEdge.target = consultNode.id;
  }
  const addEdge = (
    id: string,
    source: string,
    target: string,
    guard?: string,
  ) =>
    flow.edges.push({
      ...structuredClone(readEdge),
      id,
      nativeId: id,
      source,
      target,
      ...(guard ? { guard } : {}),
    });
  if (options.legacyDeclaredConsultation) {
    addEdge("lifecycle-consult-decision", consultNode.id, decisionNode.id);
    addEdge(
      "lifecycle-consult-success",
      decisionNode.id,
      choose.id,
      "consultDeclaredSource.consultation.succeeded",
    );
    addEdge(
      "lifecycle-consult-refusal",
      decisionNode.id,
      awaiting.target,
      "else",
    );
  }
  addEdge(
    "lifecycle-command-choice",
    fallback.source,
    commandNode.id,
    '(chooseNextMove.choice.kind == "consult_model") or (chooseNextMove.choice.kind == "inspect_operator_candidate") or (chooseNextMove.choice.kind == "decide_operator_candidate") or (chooseNextMove.choice.kind == "decide_operator_change") or (chooseNextMove.choice.kind == "open_request") or (chooseNextMove.choice.kind == "resume_request")',
  );
  addEdge("lifecycle-command-outcome", commandNode.id, commandOutcome.id);
  addEdge(
    "lifecycle-command-awaiting-input",
    commandOutcome.id,
    awaiting.target,
    "executeOperatorCommand.submission.awaitingInput",
  );
  addEdge(
    "lifecycle-command-reported",
    commandOutcome.id,
    reported.target,
    "else",
  );
  const choiceBinding = flow.bindings.find((binding) =>
    binding.targetPath.join(".") === `${check.name}.choice`
  )!;
  flow.bindings.push({
    ...structuredClone(choiceBinding),
    nativeId: "lifecycle-command-choice-binding",
    targetPath: [commandNode.name, "choice"],
    targetFeaturePath: [commandNode.nativeId, "choice"],
  });
  const outcomeBinding = flow.bindings.find((binding) =>
    binding.sourcePath.join(".") === `${execute.name}.outcome`
  )!;
  flow.bindings.push({
    ...structuredClone(outcomeBinding),
    nativeId: "lifecycle-command-outcome-binding",
    sourcePath: [commandNode.name, "outcome"],
    sourceFeaturePath: [commandNode.nativeId, "outcome"],
  });
}
