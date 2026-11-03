import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  decisionBatchError,
  decisionSchema,
  relevantErrors,
  validateDecision,
} from "./output-validation.ts";
import { modelDiagnosticAddresses } from "../../../domain/model/value-objects/diagnostic-address.ts";
import {
  validateGrantModelEditing,
  validateRequestOperatorSpec,
} from "../../../domain/governance/operator-authority.ts";
import { toolNameProblem } from "../../../domain/work/value-objects/tool-name.ts";
import { validateWorkResultValues } from "../../../domain/work/policies/verified-effect-closure.ts";

Deno.test("Watch replies carry a closed observation result without authority fields", () => {
  const reply = { kind: "reply", text: "Observation" };
  for (const changed of [false, true]) {
    equal(
      validateDecision({
        ...reply,
        watchResult: { changed, summary: "Source consultée." },
      }),
      true,
    );
  }
  for (
    const watchResult of [
      null,
      {},
      { changed: "true", summary: "Observation" },
      { changed: false },
      { changed: true, summary: "x".repeat(4001) },
      { changed: true, summary: "Observation", owner: "another-agent" },
    ]
  ) equal(validateDecision({ ...reply, watchResult }), false);
});

Deno.test("Case closure is an optional explicit reply outcome, never an authority field", () => {
  const reply = { kind: "reply", text: "Résultat" };
  equal(validateDecision(reply), true);
  for (const caseClosure of ["done", "abandoned"]) {
    equal(validateDecision({ ...reply, caseClosure }), true);
  }
  for (
    const caseClosure of ["closed-done", "job", "watch", true, null, {}]
  ) {
    equal(validateDecision({ ...reply, caseClosure }), false);
  }
  equal(validateDecision({ ...reply, caseId: "another-case" }), false);
  equal(validateDecision({ ...reply, owner: "another-operator" }), false);
  const invocation = {
    kind: "invoke_tool",
    text: "Lire",
    toolId: "tool",
    input: { url: "https://example.test/" },
  };
  equal(validateDecision(invocation), true);
  equal(validateDecision({ ...invocation, caseClosure: "done" }), false);
});

const targeted = {
  kind: "propose_sysml_edit",
  text: "Proposition ciblée",
  reason: "Réviser le membre inspecté",
  baseVersion: "commit:source-base",
  sourceDigest: "a".repeat(64),
  edits: [
    { kind: "set-value", elementId: "native-a", expression: "42" },
    { kind: "rename", elementId: "native-b", name: "Revised" },
    { kind: "insert-member", elementId: "native-c", text: "part child;" },
    { kind: "remove", elementId: "native-d" },
    { kind: "set-type", elementId: "native-e", typeName: "Flows::Private" },
  ],
};

Deno.test("targeted source edits have a closed bounded transport contract", () => {
  equal(validateDecision(targeted), true);
  for (
    const invalid of [
      { ...targeted, sourceDigest: "not-a-source-digest" },
      { ...targeted, baseVersion: "main" },
      { ...targeted, edits: [] },
      {
        ...targeted,
        edits: Array.from({ length: 33 }, () => targeted.edits[3]),
      },
      {
        ...targeted,
        edits: [{ kind: "upsert-triples", elementId: "native-a" }],
      },
      {
        ...targeted,
        edits: [{ kind: "remove", elementId: "native-a", approved: true }],
      },
      {
        ...targeted,
        edits: [{
          kind: "set-value",
          elementId: "native-a",
          expression: "x".repeat(4097),
        }],
      },
      {
        ...targeted,
        edits: [{ kind: "rename", elementId: "native-a", name: "" }],
      },
      { ...targeted, sources: { "system.sysml": "package Injected;" } },
    ]
  ) equal(validateDecision(invalid), false, JSON.stringify(invalid));
});

Deno.test("type edit provider transport accepts native names and rejects source fragments and host fields", () => {
  for (
    const typeName of [
      "Flows::Private",
      "::Flows::'révision-台灣'",
      "'L\\'atelier'::'a\\\\b'",
      "T".repeat(4096),
      "'" + "😀".repeat(4094) + "'",
    ]
  ) {
    equal(
      validateDecision({
        ...targeted,
        edits: [{ kind: "set-type", elementId: "native-e", typeName }],
      }),
      true,
      typeName,
    );
  }
  for (
    const edit of [
      ...[
        "",
        " ",
        "T".repeat(4097),
        "A::",
        "A::'bad\\q'",
        "T\n",
        "T; attribute injected = 1;",
        "T { attribute injected = 1; }",
      ].map(
        (typeName) => ({ kind: "set-type", elementId: "native-e", typeName }),
      ),
      {
        kind: "set-type",
        elementId: "x".repeat(513),
        typeName: "Flows::Private",
      },
      { kind: "set-type", elementId: "native-e", type: "Flows::Private" },
      {
        kind: "set-type",
        elementId: "native-e",
        typeName: "Flows::Private",
        target: {},
      },
      { kind: "replace-member", elementId: "native-e", text: "raw" },
    ]
  ) equal(validateDecision({ ...targeted, edits: [edit] }), false);
});

Deno.test("type edit grant requests enumerate explicit operations without admitting host replacement", () => {
  const operations = [
    "set-value",
    "set-type",
    "rename",
    "insert-member",
    "remove",
  ];
  const grant = {
    file: "system.sysml",
    root: "System::conversation",
    operations,
  };
  const mandate = {
    kind: "propose_mandate_change",
    text: "Request exact editing rights",
    reason: "Retype the inspected flow",
    requestedRights: { grantModelEditing: grant },
  };
  const delegation = {
    kind: "propose_model_delegation",
    text: "Propose bounded rights",
    reason: "Retype the inspected flow",
    baseVersion: "commit:base",
    sourceDigest: "a".repeat(64),
    change: {
      kind: "grant",
      id: "flow-edit",
      targetSystem: "System::peer",
      operations: [...operations, "replace-source"],
      grants: [{ file: grant.file, qualifiedRoots: [grant.root] }],
      mayEdit: true,
      recipients: [],
      maxRedelegationDepth: null,
    },
  };
  equal(validateDecision(mandate), true);
  deepStrictEqual(validateGrantModelEditing(grant), grant);
  equal(validateDecision(delegation), true);
  for (
    const denied of [
      "replace-member",
      "setFeatureType",
      "type",
      "set-type,set-type",
    ]
  ) {
    const invalidOperations = denied.split(",");
    equal(
      validateDecision({
        ...mandate,
        requestedRights: {
          grantModelEditing: { ...grant, operations: invalidOperations },
        },
      }),
      false,
    );
    equal(
      validateDecision({
        ...delegation,
        change: { ...delegation.change, operations: invalidOperations },
      }),
      false,
    );
  }
});

Deno.test("the existing full-file proposal contract remains accepted", () => {
  equal(
    validateDecision({
      kind: "propose_sysml_revision",
      text: "Whole-file proposal",
      reason: "Existing contract",
      baseVersion: "branch:existing-base",
      sources: { "system.sysml": "package Existing;" },
    }),
    true,
  );
});

Deno.test("diagnostic addresses are optional, exact and bounded on both revision decisions", () => {
  const raw = {
    kind: "propose_sysml_revision",
    text: "Correct a diagnostic",
    reason: "Add a missing control",
    baseVersion: "commit:base",
    sources: { "system.sysml": "package Revised;" },
  };
  const address = { code: "LOOP_WITHOUT_BUDGET", elementId: "native-a" };
  for (const proposal of [targeted, raw]) {
    equal(validateDecision({ ...proposal, addresses: [address] }), true);
    for (
      const addresses of [
        null,
        [address, address],
        [{ code: address.code }],
        [{ code: address.code, elementId: null }],
        [{ code: " ", elementId: "native-a" }],
        [{ code: address.code, elementId: " " }],
        [{ ...address, resolved: true }],
        Array.from(
          { length: 129 },
          (_, i) => ({ ...address, elementId: `${i}` }),
        ),
      ]
    ) {
      equal(validateDecision({ ...proposal, addresses }), false);
    }
  }
});

Deno.test("a correction names the error of the branch the value chose, not those of the other kinds", () => {
  const said = (value: unknown) => {
    equal(validateDecision(value), false);
    return relevantErrors(decisionSchema, value, validateDecision.errors)
      .map((error) => `${error.instancePath} ${error.message}`);
  };
  const creation = {
    kind: "propose_agent_creation",
    role: "operator",
    name: "Research",
    reason: "Process a Request",
    text: "Proposal",
    operator: {
      instruction: "x".repeat(4001),
      networkHosts: [],
      requestType: { name: "Research request", maxInvocations: 4 },
      firstRequest: { objective: "Read example.org." },
    },
  };
  deepStrictEqual(said(creation), [
    "/operator/instruction must NOT have more than 4000 characters",
  ]);
  deepStrictEqual(
    said({
      ...creation,
      operator: {
        kind: "request-team-member",
        instruction: "x".repeat(4001),
        provision: {
          budget: {
            maxAgentDecisions: 1,
            maxToolProposals: 0,
            maxFlowSteps: 1,
          },
          networkHosts: [],
          mayPropose: [],
          mayInvokeActiveCatalog: false,
        },
      },
    }),
    ["/operator/instruction must NOT have more than 4000 characters"],
  );
  const delegation = {
    kind: "propose_model_delegation",
    text: "Proposer des droits bornés",
    reason: "Mise à jour",
    baseVersion: "commit:base",
    sourceDigest: "a".repeat(64),
    change: {
      kind: "grant",
      id: "worker-edit",
      targetSystem: "Project::worker",
      operations: ["rename"],
      grants: [{ file: "system.sysml", qualifiedRoots: ["Project::data"] }],
      mayEdit: true,
      recipients: [],
      maxRedelegationDepth: 12,
    },
  };
  const delegationErrors = said(delegation);
  ok(delegationErrors.length > 0);
  ok(
    delegationErrors.every((error) =>
      error.startsWith("/change/maxRedelegationDepth")
    ),
    delegationErrors.join("; "),
  );
  const edit = {
    kind: "propose_sysml_edit",
    text: "Renommer",
    reason: "Nom plus clair",
    baseVersion: "commit:base",
    sourceDigest: "a".repeat(64),
    edits: [{ kind: "rename", elementId: "e" }],
  };
  deepStrictEqual(said(edit), [
    "/edits/0 must have required property 'name'",
  ]);
  // A value that names no branch keeps every error.
  const unknown = { kind: "propose_nothing", text: "?" };
  equal(validateDecision(unknown), false);
  equal(
    relevantErrors(decisionSchema, unknown, validateDecision.errors).length,
    validateDecision.errors!.length,
  );
});

const operatorAuthority = {
  policyId: "network-decision",
  expectedPolicyRevision: 0,
  enabled: true,
  recipients: ["native:research"],
  acts: ["addNetworkHosts"],
  networkHosts: ["example.org"],
  toolIds: [],
  maxDelegationDepth: 0,
};

Deno.test("candidate delegation commands bind one exact operator, digest, Request and policy without actor selection", () => {
  const reference = {
    operatorId: "native:research",
    candidateId: "candidate",
    candidateDigest: "a".repeat(64),
    expectedRevision: 5,
    caseId: "request",
    policyId: "tool-admission",
    policyRevision: 1,
  };
  const inspect = {
    kind: "inspect_operator_candidate",
    text: "Inspect",
    ...reference,
  };
  const decision = {
    kind: "decide_operator_candidate",
    text: "Approve",
    ...reference,
    verdict: "approve",
    reason: "Tests and contract checked",
  };
  equal(validateDecision(inspect), true);
  equal(validateDecision(decision), true);
  for (const command of [inspect, decision]) {
    for (const key of Object.keys(reference)) {
      const missing: Record<string, unknown> = { ...command };
      delete missing[key];
      equal(validateDecision(missing), false, key);
    }
    for (
      const patch of [
        { actorId: "human" },
        { authority: "human" },
        { candidateDigest: "other" },
        { caseId: "" },
        { expectedRevision: -1 },
        { policyRevision: 0 },
      ]
    ) {
      equal(
        validateDecision({ ...command, ...patch }),
        false,
        JSON.stringify(patch),
      );
    }
  }
});

Deno.test("creation grant requests carry exact bounded hosts, capacity and mode without a target", () => {
  const request = {
    networkHosts: ["example.org"],
    maxChildren: 3,
    mode: "autonomous",
  };
  const proposal = (operatorCreation: unknown) => ({
    kind: "propose_mandate_change",
    text: "Request the right",
    reason: "Ask a reviewer to contribute",
    requestedRights: { operatorCreation },
  });
  equal(validateDecision(proposal(request)), true);
  equal(
    validateDecision(
      proposal({ ...request, mode: "per-creation", networkHosts: [] }),
    ),
    true,
  );
  for (
    const patch of [
      { maxChildren: 4 },
      { maxChildren: 0 },
      { mode: "automatic" },
      { networkHosts: ["*"] },
      { holderNativeId: "other" },
      { executionSpaceId: "main" },
      { maxDelegationDepth: 1 },
    ]
  ) {
    equal(
      validateDecision(proposal({ ...request, ...patch })),
      false,
      JSON.stringify(patch),
    );
  }
  const { mode: _mode, ...missingMode } = request;
  equal(validateDecision(proposal(missingMode)), false);
});

Deno.test("tool admission grants accept native recipients and supported kinds without network or redelegation bounds", () => {
  const toolAdmission = {
    policyId: "tool-admission",
    expectedPolicyRevision: 0,
    enabled: true,
    recipients: ["native:research"],
    toolKinds: ["read_web_page"],
    maxDelegationDepth: 0,
  };
  const proposal = {
    kind: "propose_mandate_change",
    text: "Propose",
    reason: "Bounded tool admission",
    requestedRights: { toolAdmission },
  };
  equal(validateDecision(proposal), true);
  for (
    const patch of [
      { recipients: [] },
      { recipients: ["*"] },
      { toolKinds: [] },
      { toolKinds: ["run_shell"] },
      { networkHosts: ["example.org"] },
      { maxDelegationDepth: 1 },
      { actorId: "human" },
    ]
  ) {
    equal(
      validateDecision({
        ...proposal,
        requestedRights: { toolAdmission: { ...toolAdmission, ...patch } },
      }),
      false,
      JSON.stringify(patch),
    );
  }
});
const authorityProposal = (policy: unknown) => ({
  kind: "propose_mandate_change",
  text: "Bound operator decisions",
  reason: "Exact scope",
  requestedRights: { operatorAuthority: policy },
});
Deno.test("operator authority transport is closed, exact and bounded", () => {
  equal(validateDecision(authorityProposal(operatorAuthority)), true);
  equal(
    validateDecision(
      authorityProposal({
        ...operatorAuthority,
        policyId: "p".repeat(128),
        expectedPolicyRevision: 1,
        enabled: false,
        recipients: Array.from({ length: 32 }, (_, i) => `native:${i}`),
        networkHosts: Array.from(
          { length: 32 },
          (_, i) => `host${i}.example.org`,
        ),
      }),
    ),
    true,
  );
  for (const key of Object.keys(operatorAuthority)) {
    const missing: Record<string, unknown> = { ...operatorAuthority };
    delete missing[key];
    equal(validateDecision(authorityProposal(missing)), false, key);
  }
  for (
    const patch of [
      { policyId: "" },
      { policyId: "p".repeat(129) },
      { expectedPolicyRevision: -1 },
      { expectedPolicyRevision: 0.5 },
      { expectedPolicyRevision: "0" },
      { enabled: "true" },
      { recipients: [] },
      { recipients: ["native:a", "native:a"] },
      { recipients: ["*"] },
      { recipients: ["native a"] },
      { recipients: [""] },
      { recipients: ["x".repeat(513)] },
      { recipients: Array.from({ length: 33 }, (_, i) => `native:${i}`) },
      { acts: [] },
      { acts: ["addNetworkHosts", "addNetworkHosts"] },
      { acts: ["admitTool"] },
      { networkHosts: [] },
      { networkHosts: ["example.org", "example.org"] },
      { networkHosts: ["*.example.org"] },
      { networkHosts: ["https://example.org"] },
      { networkHosts: ["127.0.0.1"] },
      { networkHosts: ["EXAMPLE.org"] },
      {
        networkHosts: Array.from(
          { length: 33 },
          (_, i) => `host${i}.example.org`,
        ),
      },
      { toolIds: ["tool"] },
      { maxDelegationDepth: 1 },
      { maxDelegationDepth: "0" },
      { approved: true },
    ]
  ) {
    equal(
      validateDecision(authorityProposal({ ...operatorAuthority, ...patch })),
      false,
      JSON.stringify(patch),
    );
  }
  equal(
    validateDecision({
      ...authorityProposal(operatorAuthority),
      requestedRights: { operatorAuthority, addNetworkHosts: ["example.org"] },
    }),
    false,
  );
});
Deno.test("operator change decisions carry only exact target, policy revision and verdict", () => {
  const decision = {
    kind: "decide_operator_change",
    text: "Approve request",
    operatorId: "native:research",
    changeId: "change-1",
    expectedRevision: 0,
    policyId: "network-decision",
    policyRevision: 1,
    verdict: "approve",
  };
  equal(validateDecision(decision), true);
  equal(validateDecision({ ...decision, verdict: "refuse" }), true);
  for (const key of Object.keys(decision)) {
    const missing: Record<string, unknown> = { ...decision };
    delete missing[key];
    equal(validateDecision(missing), false, key);
  }
  for (
    const patch of [
      { operatorId: "" },
      { operatorId: "*" },
      { operatorId: "native a" },
      { operatorId: "x".repeat(513) },
      { changeId: "" },
      { changeId: "x".repeat(129) },
      { policyId: "" },
      { policyId: "x".repeat(129) },
      { expectedRevision: -1 },
      { expectedRevision: 0.5 },
      { expectedRevision: "0" },
      { policyRevision: 0 },
      { policyRevision: 1.5 },
      { policyRevision: "1" },
      { verdict: "accept" },
      { requestedRights: { addNetworkHosts: ["example.org"] } },
      { receipt: {} },
      { authority: "human" },
    ]
  ) {
    equal(
      validateDecision({ ...decision, ...patch }),
      false,
      JSON.stringify(patch),
    );
  }
});

Deno.test("schema and domain agree at emoji bounds, in code points", () => {
  const tool = (name: string) => ({
    kind: "propose_tool",
    text: "Propose",
    tool: { name, description: "Reads", kind: "read_web_page", code: "x" },
  });
  equal(validateDecision(tool("😀".repeat(200))), true);
  equal(toolNameProblem("😀".repeat(200)), undefined);
  equal(validateDecision(tool("😀".repeat(201))), false);
  equal(toolNameProblem("😀".repeat(201)), "TOO_LONG");
  equal(toolNameProblem("😀".repeat(150)), undefined);
  equal(validateDecision(tool("😀".repeat(150))), true);

  const reply = (summary: string) => ({
    kind: "reply",
    text: "Observation",
    watchResult: { changed: true, summary },
  });
  equal(validateDecision(reply("😀".repeat(4000))), true);
  equal(validateDecision(reply("😀".repeat(4001))), false);

  const revision = (addresses: unknown) => ({
    kind: "propose_sysml_revision",
    text: "Correct",
    reason: "Fix",
    baseVersion: "branch:base",
    sources: { "system.sysml": "package Existing;" },
    addresses,
  });
  const atBound = [{ code: "😀".repeat(128), elementId: "😀".repeat(512) }];
  equal(validateDecision(revision(atBound)), true);
  deepStrictEqual(modelDiagnosticAddresses(atBound), atBound);
  for (
    const over of [
      [{ code: "😀".repeat(129), elementId: "e" }],
      [{ code: "c", elementId: "😀".repeat(513) }],
    ]
  ) {
    equal(validateDecision(revision(over)), false);
    let refused = false;
    try {
      modelDiagnosticAddresses(over);
    } catch {
      refused = true;
    }
    equal(refused, true);
  }

  const operator = (patch: Record<string, unknown>) => ({
    instruction: "Answer bounded requests.",
    networkHosts: [],
    requestType: { name: "Research request", maxInvocations: 4 },
    firstRequest: { objective: "Ask." },
    ...patch,
  });
  const creation = (op: ReturnType<typeof operator>) => ({
    kind: "propose_agent_creation",
    role: "operator",
    name: "Research",
    reason: "Process a Request",
    text: "Proposal",
    operator: op,
  });
  const good = operator({
    instruction: "😀".repeat(4000),
    requestType: { name: "😀".repeat(80), maxInvocations: 4 },
    firstRequest: { objective: "😀".repeat(2000) },
  });
  equal(validateDecision(creation(good)), true);
  deepStrictEqual(validateRequestOperatorSpec(good), good);
  for (
    const bad of [
      operator({ instruction: "😀".repeat(4001) }),
      operator({
        requestType: { name: "😀".repeat(81), maxInvocations: 4 },
      }),
      operator({ firstRequest: { objective: "😀".repeat(2001) } }),
    ]
  ) {
    equal(validateDecision(creation(bad)), false);
    let refused = false;
    try {
      validateRequestOperatorSpec(bad);
    } catch {
      refused = true;
    }
    equal(refused, true);
  }

  const consult = (inputJson: string) => ({
    kind: "consult_model",
    text: "Consult",
    inputJson,
  });
  equal(validateDecision(consult("😀".repeat(65_536))), true);
  equal(validateDecision(consult("😀".repeat(65_537))), false);

  // An authored JSON Schema maxLength counts code points in the domain too.
  const workSchema = {
    type: "object",
    properties: { value: { type: "string", maxLength: 2 } },
    required: ["value"],
    additionalProperties: false,
  };
  equal(validateWorkResultValues(workSchema, { value: "😀😀" }), true);
  equal(validateWorkResultValues(workSchema, { value: "😀😀😀" }), false);
});

Deno.test("batch validation preserves member IDs, closed shapes and terminal ordering", () => {
  const read = { kind: "consult_model", text: "Inspect", inputJson: "{}" };
  const reply = { kind: "reply", text: "Done" };
  const calls = [{ id: "read", decision: read }, {
    id: "reply",
    decision: reply,
  }];
  equal(decisionBatchError({ calls }), undefined);
  for (
    const invalid of [
      {},
      { calls: [] },
      { calls: [{ decision: read }] },
      { calls: [{ id: " ", decision: read }] },
      { calls: [{ id: "a", decision: read }, { id: "a", decision: read }] },
      {
        calls: Array.from(
          { length: 9 },
          (_, i) => ({ id: `${i}`, decision: read }),
        ),
      },
      { calls: [{ id: "a", decision: reply }, { id: "b", decision: read }] },
      { calls: [{ id: "a", decision: { ...read, approved: true } }] },
      { calls, admitted: true },
      { calls: [{ ...calls[0], authority: "human" }] },
      { calls, assistantBlocks: {} },
      { calls, providerRepairs: {} },
      { calls, providerRepairs: [{ userBlocks: {} }] },
      { calls, providerRepairs: [{ userBlocks: [], assistantBlocks: {} }] },
      { calls, providerRepairs: [{ userBlocks: [] }, { userBlocks: [] }] },
    ]
  ) ok(decisionBatchError(invalid), JSON.stringify(invalid));
  const change = {
    kind: "decide_operator_change",
    text: "Decide",
    operatorId: "native:research",
    changeId: "change",
    expectedRevision: 0,
    policyId: "policy",
    policyRevision: 1,
    verdict: "approve",
  };
  ok(
    decisionBatchError({
      calls: [{ id: "terminal", decision: change }, {
        id: "read",
        decision: read,
      }],
    }),
  );
});

Deno.test("4.8d D4: a delegated policy request may name a recipient Case, never a recipient space", () => {
  const operatorAuthority = {
    policyId: "bo-x-network",
    expectedPolicyRevision: 0,
    enabled: true,
    recipients: ["builder"],
    acts: ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [],
    maxDelegationDepth: 0,
  };
  const toolAdmission = {
    policyId: "bo-x-tools",
    expectedPolicyRevision: 0,
    enabled: true,
    recipients: ["builder"],
    toolKinds: ["read_web_page"],
    maxDelegationDepth: 0,
  };
  const proposal = (requestedRights: unknown) => ({
    kind: "propose_mandate_change",
    text: "Ask",
    reason: "Decide for Case X's operator",
    requestedRights,
  });
  for (const rights of [{ operatorAuthority }, { toolAdmission }]) {
    const [key, value] = Object.entries(rights)[0];
    equal(validateDecision(proposal(rights)), true);
    equal(
      validateDecision(
        proposal({ [key]: { ...value, recipientCaseId: "case-x" } }),
      ),
      true,
    );
    for (
      const invalid of [
        { ...value, recipientExecutionSpaceId: "space-x" },
        { ...value, recipientCaseId: "" },
        { ...value, recipientCaseId: "case x" },
        { ...value, recipientCaseId: "x".repeat(129) },
      ]
    ) equal(validateDecision(proposal({ [key]: invalid })), false);
  }
});

Deno.test("4.8d D3: a Request opening names its source, never its operator or caller authority", () => {
  const command = {
    kind: "open_request",
    text: "Open the Request",
    objective: "Compare the sources",
    openingId: "opening-1",
    source: { kind: "current-main" },
  };
  equal(validateDecision(command), true);
  equal(
    validateDecision({
      ...command,
      source: {
        kind: "release",
        releaseId: "release-1",
        digest: "a".repeat(64),
      },
    }),
    true,
  );
  for (
    const invalid of [
      { ...command, operatorId: "owner" },
      { ...command, caseTypeId: "request-type" },
      { ...command, executionSpaceId: "branch" },
      { ...command, actorId: "Main" },
      { ...command, openedBy: "Main" },
      { ...command, openedFrom: { caseId: "another-case" } },
      { ...command, objective: " " },
      { ...command, objective: "x".repeat(2001) },
      { ...command, openingId: " " },
      { ...command, openingId: "x".repeat(129) },
      { ...command, source: undefined },
      { ...command, source: { kind: "current-main", expectedVersion: "v" } },
      { ...command, source: { kind: "release", releaseId: "release-1" } },
      {
        ...command,
        source: { kind: "release", releaseId: "r 1", digest: "a".repeat(64) },
      },
    ]
  ) equal(validateDecision(invalid), false, JSON.stringify(invalid));
});

Deno.test("team creation accepts a closed specification without provider authority or Request opening", () => {
  const operator = {
    kind: "request-team-member",
    instruction: "Contribute evidence to this Request.",
    provision: {
      budget: { maxAgentDecisions: 2, maxToolProposals: 1, maxFlowSteps: 10 },
      networkHosts: ["example.org"],
      mayPropose: ["read_web_page"],
      mayInvokeActiveCatalog: false,
    },
    creationGrant: { networkHosts: [], maxChildren: 2, maxDelegationDepth: 0 },
  };
  const decision = {
    kind: "propose_agent_creation",
    role: "operator",
    name: "Evidence operator",
    reason: "Contribute to the active Request",
    text: "Propose a team member",
    operator,
  };
  equal(validateDecision(decision), true);
  equal(
    validateDecision({
      ...decision,
      operator: {
        ...operator,
        provision: { ...operator.provision, mayAddNetworkHosts: true },
      },
    }),
    true,
  );
  equal(
    validateDecision({
      ...decision,
      operator: {
        ...operator,
        provision: { ...operator.provision, mayAddNetworkHosts: "true" },
      },
    }),
    false,
  );
  const { creationGrant: _grant, ...withoutGrant } = operator;
  equal(validateDecision({ ...decision, operator: withoutGrant }), true);
  const { provision: _provision, ...withoutProvision } = operator;
  equal(validateDecision({ ...decision, operator: withoutProvision }), false);
  for (
    const patch of [
      { requestType: { name: "Another Request", maxInvocations: 2 } },
      { firstRequest: { objective: "Open another Request" } },
      { actorId: "main" },
      { teamOrigin: { operatorId: "main", requestId: "request" } },
      { caseId: "request" },
      { creationGrant: { ...operator.creationGrant, maxChildren: 0 } },
      { creationGrant: { ...operator.creationGrant, maxDelegationDepth: -1 } },
      { creationGrant: { ...operator.creationGrant, actorId: "main" } },
      { networkHosts: ["*.example.org"] },
      { provision: { ...operator.provision, networkHosts: ["*.example.org"] } },
      { provision: { ...operator.provision, mayPropose: ["delete_files"] } },
    ]
  ) {
    equal(
      validateDecision({ ...decision, operator: { ...operator, ...patch } }),
      false,
    );
  }
  equal(validateDecision({ ...decision, actorId: "main" }), false);
  equal(
    validateDecision({ ...decision, teamOrigin: { requestId: "request" } }),
    false,
  );
});

Deno.test("initial Request operator creation carries only an explicit optional bounded creation grant", () => {
  const operator = {
    instruction: "Own the Request and compose a bounded team.",
    networkHosts: [],
    requestType: { name: "Research request", maxInvocations: 4 },
    firstRequest: { objective: "Research the question." },
  };
  const creationGrant = {
    networkHosts: ["example.org"],
    maxChildren: 3,
    maxDelegationDepth: 1,
  };
  const decision = {
    kind: "propose_agent_creation",
    role: "operator",
    name: "Research",
    reason: "Own a Request",
    text: "Prepare the operator",
    operator,
  };
  equal(validateDecision(decision), true);
  equal("creationGrant" in decision.operator, false);
  equal(
    validateDecision({ ...decision, operator: { ...operator, creationGrant } }),
    true,
  );
  for (
    const grant of [
      { ...creationGrant, maxChildren: 0 },
      { ...creationGrant, maxChildren: 1.5 },
      { ...creationGrant, maxDelegationDepth: -1 },
      { ...creationGrant, networkHosts: ["*.example.org"] },
      { ...creationGrant, actorId: "main" },
      { ...creationGrant, parentOperatorId: "main" },
      { ...creationGrant, requestId: "request" },
    ]
  ) {
    equal(
      validateDecision({
        ...decision,
        operator: { ...operator, creationGrant: grant },
      }),
      false,
    );
  }
});

Deno.test("Request resumption admits only bounded identity and instruction, never caller authority", () => {
  const command = {
    kind: "resume_request",
    text: "Continue",
    operatorId: "owner",
    caseId: "request",
    resumeId: "r1",
    instruction: "Collect",
  };
  equal(validateDecision(command), true);
  const { operatorId: _operatorId, ...defaultTarget } = command;
  equal(validateDecision(defaultTarget), true);
  equal(validateDecision({ ...command, operatorId: "member" }), true);
  for (
    const invalid of [
      { ...command, operatorId: "" },
      { ...command, actorId: "Main" },
      { ...command, resumeId: " " },
      { ...command, instruction: " " },
      { ...command, instruction: "x".repeat(2001) },
    ]
  ) equal(validateDecision(invalid), false);
});

Deno.test("team model rights are optional explicit booleans at the provider boundary", () => {
  const decision = {
    kind: "propose_agent_creation",
    role: "operator",
    name: "Reader",
    reason: "Read the exact model",
    text: "Propose reader",
    operator: {
      kind: "request-team-member",
      instruction: "Inspect the model",
      provision: {
        budget: { maxAgentDecisions: 2, maxToolProposals: 0, maxFlowSteps: 32 },
        networkHosts: [],
        mayPropose: [],
        mayInvokeActiveCatalog: false,
      },
    },
  };
  for (const read of [undefined, false, true]) {
    for (const revision of [undefined, false, true]) {
      ok(
        validateDecision({
          ...decision,
          operator: {
            ...decision.operator,
            provision: {
              ...decision.operator.provision,
              ...(read === undefined ? {} : { mayConsultModel: read }),
              ...(revision === undefined
                ? {}
                : { mayProposeSysmlRevision: revision }),
            },
          },
        }),
      );
    }
  }
  for (const field of ["mayConsultModel", "mayProposeSysmlRevision"]) {
    for (const value of [null, "true", 1]) {
      ok(
        !validateDecision({
          ...decision,
          operator: {
            ...decision.operator,
            provision: { ...decision.operator.provision, [field]: value },
          },
        }),
      );
    }
  }
});
