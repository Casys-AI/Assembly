import assert from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { WorkPlanExecutor } from "../../../application/work/plans/executor.ts";
import type { ExecutableModel } from "../execution/executable-model.ts";
import { lintModelDiagnostics } from "./diagnostics.ts";
import type { NativeBehaviorContract } from "../execution/native-contracts.ts";
import type { OperatorEntry } from "../records/operator-entry.ts";
import type { WorkResultContract } from "../../work/policies/verified-effect-closure.ts";
import { InformationBehavior } from "../../../application/work/context/information-behavior.ts";
import { projectModelDiagnosticFacts } from "./diagnostics.ts";
import type { SourceRevision } from "../records/source-revision.ts";
import { ToolReuseBehavior } from "../../../application/work/behaviors/tool-reuse.ts";
import { WorkPlanBehavior } from "../../../../test/support/work-plan-behavior.ts";
import { legacyOwnerAuthority } from "../../governance/authority.ts";

function model(id: string): ExecutableModel {
  return executableFixture({
    projectId: "diagnostics",
    editingContextId: "context",
    rootId: "root",
    systemId: id,
    builderId: `${id}-builder`,
    catalogId: `${id}-catalog`,
  });
}

function entry(id: string, kind: OperatorEntry["kind"]): OperatorEntry {
  return {
    id,
    kind,
    typeId: `${kind}-type`,
    performerId: "performer",
    allocationId: `${id}-allocation`,
    sourceIds: [id],
  };
}

function behavior(
  id: string,
  targetNativeId: string,
  callerNativeId: string,
): NativeBehaviorContract {
  return {
    id,
    name: id,
    description: "Build, write and publish are only words in a description.",
    targetNativeId,
    targetTypeId: "target-type",
    inputTypeId: "input-type",
    callerNativeId,
    inputSchema: { type: "object" },
    sourceIds: [id, targetNativeId],
  };
}

function result(
  workBehaviorId: string,
  callerNativeId: string,
): WorkResultContract {
  return {
    schemaVersion: "verified-effect-closure/v2",
    id: `${workBehaviorId}-result`,
    callerNativeId,
    workBehaviorId,
    observationBehaviorId: "observe",
    expected: { typeId: "expected", schema: {}, values: {} },
    observed: { typeId: "observed", schema: {} },
    condition: {
      nativeId: "condition",
      expression: { kind: "literal", value: true },
      sourceIds: ["condition"],
    },
    maxObservations: 1,
    sourceIds: [workBehaviorId],
  };
}

const revision: SourceRevision = {
  version: "v1",
  sources: { "model.sysml": "package Model;" },
  elements: [{
    "@id": "first",
    qualifiedName: "Model::first",
    "sysx:sourceDocument": "model.sysml",
    "sysx:sourceLine": 12,
    "sysx:sourceColumn": 3,
  }],
};

Deno.test("diagnostic source projection needs no snapshot without compiled models", () => {
  assert.deepEqual(
    projectModelDiagnosticFacts({
      ...revision,
      elements: [revision.elements[0]!, revision.elements[0]!],
    }, []),
    {
      units: [],
      effects: [],
      networkCapabilities: [],
      graphContext: { units: [], capabilities: [] },
    },
  );
});

Deno.test("diagnostic source projection localizes every conversational scope", () => {
  const first = model("first"), second = model("second");
  first.ownerAuthority = {
    ...legacyOwnerAuthority("first"),
    ownerSource: "modeled",
  };
  first.configuration.builder.admissionAuthority = "builder";
  first.operator = {
    name: "first",
    instruction: "",
    primary: true,
    humanInput: true,
  };
  const facts = projectModelDiagnosticFacts(revision, [first, second]);
  assert.equal(facts.units.length, 2);
  assert.deepEqual(facts.units[0]!.location, {
    elementId: "first",
    qualifiedName: "Model::first",
    source: { file: "model.sysml", line: 12, column: 3 },
  });
  assert.deepEqual(facts.units[1]!.location, { elementId: "second" });
  assert.equal(facts.units[0]!.admissionMode, "builder");
  assert.equal(facts.units[1]!.admissionMode, "human");
  const owners = lintModelDiagnostics(facts).filter((diagnostic) =>
    diagnostic.code === "NO_ACCOUNTABLE_OWNER"
  );
  assert.deepEqual(owners.map((diagnostic) => diagnostic.finding), [
    "indeterminate",
    "indeterminate",
  ]);
  for (
    const changes of [
      { "sysx:sourceDocument": "outside.sysml" },
      { "sysx:sourceLine": 0 },
      { "sysx:sourceColumn": 1.5 },
    ]
  ) {
    const invalid = {
      ...revision,
      elements: [{ ...revision.elements[0], ...changes }],
    };
    assert.equal(
      projectModelDiagnosticFacts(invalid, [first]).units[0]!.location.source,
      undefined,
    );
  }
});

Deno.test("diagnostic source projection uses the caller budget for its own exposed plans", () => {
  const caller = model("caller"), provider = model("provider");
  caller.operatorEntries = [entry("shared-plan", "work-plan")];
  provider.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    elementId: "budget",
    sourceIds: ["budget"],
    unit: "agent-invocation",
    limit: 2,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  caller.behaviors = [
    behavior("first-plan-access", "shared-plan", caller.identity.builderId),
    behavior("second-plan-access", "shared-plan", caller.identity.builderId),
  ];
  const facts = projectModelDiagnosticFacts(revision, [caller, provider]);
  const plans = facts.units.filter((unit) => unit.kind === "plan");
  assert.equal(plans.length, 1);
  assert.equal(plans[0]!.hasInvocationBudget, false);
  caller.workBudgetPolicy = provider.workBudgetPolicy;
  delete provider.workBudgetPolicy;
  assert.equal(
    projectModelDiagnosticFacts(revision, [caller, provider]).units.find((
      unit,
    ) => unit.kind === "plan")!.hasInvocationBudget,
    true,
  );
  assert.deepEqual(
    projectModelDiagnosticFacts(revision, [caller, provider]).graphContext!
      .units.filter((unit) => unit.ownerSystemId === "caller"),
    [
      {
        elementId: "caller",
        kind: "conversation",
        ownerSystemId: "caller",
        budgetPolicyId: "budget",
      },
      {
        elementId: "shared-plan",
        kind: "plan",
        ownerSystemId: "caller",
        budgetPolicyId: "budget",
      },
    ],
  );
  caller.behaviors = [];
  assert.equal(
    projectModelDiagnosticFacts(revision, [caller, provider]).units.some((
      unit,
    ) => unit.kind === "plan"),
    false,
  );
});

Deno.test("diagnostic source projection ignores foreign unbudgeted access refused by WorkPlanBehavior", async () => {
  const first = model("first"), second = model("second");
  first.operatorEntries = [entry("shared-plan", "work-plan")];
  first.behaviors = [
    behavior("first-access", "shared-plan", first.identity.builderId),
  ];
  second.behaviors = [
    behavior("second-access", "shared-plan", second.identity.builderId),
  ];
  for (const value of [first, second]) {
    value.version.repositoryVersion = revision.version;
  }
  const adapter = new WorkPlanBehavior({
    executor: new WorkPlanExecutor({
      now: () => "2026-11-03T00:00:00.000Z",
      store: {
        load() {
          throw new Error("Availability must not load a plan");
        },
        save() {
          throw new Error("Availability must not save a plan");
        },
      },
      invokeTarget() {
        throw new Error("Availability must not dispatch work");
      },
    }),
    resolveCallerModel(callerId) {
      return Promise.resolve(
        callerId === first.identity.builderId ? first : second,
      );
    },
    planTargetIds: new Set(["shared-plan"]),
    planTargetOwners: new Map([["shared-plan", first.identity.builderId]]),
    workTargetIds: new Set(),
    workInvoker: {
      supports: () => Promise.resolve(false),
      invoke() {
        throw new Error("Availability must not invoke work");
      },
    },
  });
  const version = { digest: first.version.digest, repositoryVersion: "v1" };
  assert.equal(await adapter.supports(first.behaviors[0]!, version), true);
  assert.equal(await adapter.supports(second.behaviors[0]!, version), false);
  await assert.rejects(
    () =>
      adapter.invoke({
        behavior: second.behaviors![0]!,
        callerId: second.identity.builderId,
        invocationId: "foreign-plan-invocation",
        modelVersion: version,
        input: { tasksJson: "[]" },
      }),
    /does not belong to its caller/,
  );
  const diagnostics = () => {
    const facts = projectModelDiagnosticFacts(revision, [first, second]);
    assert.equal(facts.units.filter((unit) => unit.kind === "plan").length, 1);
    const findings = lintModelDiagnostics(facts);
    assert.deepEqual(
      findings,
      lintModelDiagnostics(
        projectModelDiagnosticFacts(revision, [second, first]),
      ),
    );
    return findings.filter((finding) => finding.elementId === "shared-plan");
  };
  const unbudgeted = ["LOOP_WITHOUT_BUDGET", "NO_ACCOUNTABLE_OWNER"];
  assert.deepEqual(diagnostics().map((finding) => finding.code), unbudgeted);
  first.workBudgetPolicy = {
    id: "budget",
    revision: 1,
    elementId: "budget",
    sourceIds: ["budget"],
    unit: "agent-invocation",
    limit: 2,
    onExhausted: "wait",
    exhaustionRecipient: "local-control",
  };
  assert.deepEqual(diagnostics().map((finding) => finding.code), [
    "NO_ACCOUNTABLE_OWNER",
  ]);
  first.behaviors = [];
  assert.equal(
    projectModelDiagnosticFacts(revision, [first, second]).units.some((unit) =>
      unit.kind === "plan"
    ),
    false,
  );
});

Deno.test("diagnostic source projection excludes mismatched or ambiguous planning callers", () => {
  const caller = model("caller");
  caller.operatorEntries = [entry("plan", "work-plan")];
  caller.behaviors = [behavior("access", "plan", "foreign-caller")];
  const plans = () =>
    projectModelDiagnosticFacts(revision, [caller]).units.filter((unit) =>
      unit.kind === "plan"
    );
  assert.deepEqual(plans(), []);
  const access = behavior("access", "plan", caller.identity.builderId);
  caller.behaviors = [access, structuredClone(access)];
  assert.deepEqual(plans(), []);
  caller.behaviors = [access];
  assert.equal(plans().length, 1);
  assert.equal(plans()[0]!.hasInvocationBudget, false);
});

Deno.test("diagnostic source projection ignores foreign effects refused by their executors", async () => {
  const owner = model("owner"), peer = model("peer");
  owner.operatorEntries = [
    entry("reuse", "reuse-tool"),
    entry("capture", "memory-capture"),
  ];
  owner.memoryPolicy = {
    id: "memory-policy",
    revision: 1,
    elementId: "memory-policy",
    sourceIds: ["memory-policy"],
    kind: "governed-memory",
    pattern: "5.2",
    ownerId: owner.identity.builderId,
    allowedScopes: ["construction"],
    requireSourceRefs: true,
    requireKnownOutcome: true,
    maxValidityMs: 3_600_000,
    allowSelfAdmission: true,
  };
  for (const caller of [owner, peer]) {
    caller.version.repositoryVersion = revision.version;
    caller.behaviors = owner.operatorEntries.map((target) => {
      const fields = target.kind === "reuse-tool"
        ? ["sourceAgentId", "candidateId", "digest"]
        : ["id", "contentJson"];
      return {
        ...behavior(
          `${caller.identity.builderId}-${target.id}-access`,
          target.id,
          caller.identity.builderId,
        ),
        targetTypeId: target.typeId,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(
            fields.map((field) => [field, { type: "string" }]),
          ),
          required: fields,
          additionalProperties: false,
        },
      };
    });
  }
  const resolveCallerModel = (callerId: string) =>
    Promise.resolve(callerId === owner.identity.builderId ? owner : peer);
  const adapters = [
    new ToolReuseBehavior({
      reuseTargetIds: new Set(["reuse"]),
      reuseTargetOwners: new Map([["reuse", owner.identity.builderId]]),
      resolveCallerModel,
      findArtifact() {
        throw new Error("Availability must not read artifacts");
      },
      importForCaller() {
        throw new Error("Availability must not import artifacts");
      },
    }),
    new InformationBehavior({
      entries: new Map([["capture", {
        ownerId: owner.identity.builderId,
        kind: "memory-capture",
      }]]),
      resolveCallerModel,
      snapshotForCaller() {
        throw new Error("Availability must not read the runtime");
      },
      memory() {
        throw new Error("Availability must not access memory");
      },
    }),
  ];
  for (const [index, adapter] of adapters.entries()) {
    for (const caller of [owner, peer]) {
      assert.equal(
        await adapter.supports(caller.behaviors![index]!, {
          digest: caller.version.digest,
          repositoryVersion: revision.version,
        }),
        caller === owner,
      );
    }
  }
  const facts = projectModelDiagnosticFacts(revision, [owner, peer]);
  assert.deepEqual(
    facts.effects.map((effect) => effect.location.elementId),
    [owner.behaviors![0]!.id],
  );
  assert.deepEqual(
    lintModelDiagnostics(facts).filter((d) => d.code === "EFFECT_NOT_VERIFIED")
      .map((d) => d.elementId).sort(),
    [owner.behaviors![0]!.id],
  );
  assert.deepEqual(
    lintModelDiagnostics(facts),
    lintModelDiagnostics(projectModelDiagnosticFacts(revision, [peer, owner])),
  );
  owner.behaviors = [];
  assert.deepEqual(
    projectModelDiagnosticFacts(revision, [owner, peer]).effects,
    [],
  );
});

Deno.test("diagnostic source projection associates result contracts to exact local caller and exposure", () => {
  const caller = model("caller"), provider = model("provider");
  caller.operatorEntries = [
    entry("reuse", "reuse-tool"),
    entry("write", "reuse-tool"),
  ];
  caller.behaviors = [
    behavior("reuse-access", "reuse", caller.identity.builderId),
    behavior("write-access", "write", caller.identity.builderId),
  ];
  caller.workResultContracts = [
    result("another-access", caller.identity.builderId),
    result("write-access", provider.identity.builderId),
  ];
  let facts = projectModelDiagnosticFacts(revision, [caller, provider]);
  assert.deepEqual(facts.effects.map((effect) => effect.effect), [
    "construction",
    "construction",
  ]);
  assert.deepEqual(
    facts.effects.map((effect) => effect.hasWorkResultContract),
    [
      false,
      false,
    ],
  );
  caller.workResultContracts.push(
    result("write-access", caller.identity.builderId),
  );
  facts = projectModelDiagnosticFacts(revision, [caller, provider]);
  assert.deepEqual(
    facts.effects.map((effect) => effect.hasWorkResultContract),
    [
      false,
      true,
    ],
  );
  assert.deepEqual(
    lintModelDiagnostics(facts).filter((d) => d.code === "EFFECT_NOT_VERIFIED")
      .map((d) => d.elementId),
    ["reuse-access"],
  );
});

Deno.test("diagnostic source projection excludes committed local state commands and read or unknown primitives", () => {
  const caller = model("caller");
  const writeKinds: OperatorEntry["kind"][] = [
    "memory-capture",
    "memory-revise",
    "memory-review",
    "memory-withdraw",
    "skill-install",
    "skill-load",
    "skill-unload",
  ];
  const otherKinds: OperatorEntry["kind"][] = [
    "inbox",
    "published-tools",
    "inspect-work-artifacts",
    "context-evidence",
    "memory-recall",
    "skill-list",
  ];
  caller.operatorEntries = [...writeKinds, ...otherKinds, "reuse-tool" as const]
    .map((kind) => entry(kind, kind));
  caller.behaviors = [
    ...writeKinds,
    ...otherKinds,
    "reuse-tool",
    "arbitrary-action",
  ].map(
    (kind) => behavior(`${kind}-access`, kind, caller.identity.builderId),
  );
  const facts = projectModelDiagnosticFacts(revision, [caller]);
  assert.deepEqual(
    facts.effects.map((effect) => effect.location.elementId),
    ["reuse-tool-access"],
  );
  assert.equal(facts.effects[0]!.effect, "construction");
  caller.behaviors = [];
  assert.deepEqual(projectModelDiagnosticFacts(revision, [caller]).effects, []);
});

Deno.test("diagnostic source projection compares each skill policy with its own operator network", () => {
  const first = model("first"), second = model("second");
  first.configuration.network = { allowedHosts: ["example.org"] };
  second.configuration.network = { allowedHosts: ["skills.example.org"] };
  first.skillPolicy = {
    id: "skills",
    revision: 1,
    elementId: "skills",
    sourceIds: ["skills"],
    kind: "lazy-skills",
    ownerId: first.identity.builderId,
    allowedHosts: ["skills.example.org"],
    maxSkillBytes: 1024,
    maxInstalledSkills: 3,
    maxLoadedSkills: 2,
    maxLoadedCharacters: 2048,
  };
  const withAttributes = {
    ...revision,
    elements: [...revision.elements, {
      "@id": "allowed-base",
      "@type": "AttributeUsage",
      declaredName: "allowedHosts",
    }, {
      "@id": "allowed-attr",
      "@type": "AttributeUsage",
      owner: { "@id": "skills" },
      ownedRedefinition: [{ "@id": "allowed-redefinition" }],
    }, {
      "@id": "allowed-redefinition",
      "@type": "Redefinition",
      general: { "@id": "allowed-base" },
    }, {
      "@id": "network-attr",
      "@type": "AttributeUsage",
      owner: { "@id": "first" },
      declaredName: "networkHosts",
    }, {
      "@id": "foreign-network-attr",
      "@type": "AttributeUsage",
      owner: { "@id": "second" },
      declaredName: "networkHosts",
    }],
  };
  let facts = projectModelDiagnosticFacts(withAttributes, [first, second]);
  assert.deepEqual(facts.graphContext!.capabilities, [{
    policyElementId: "skills",
    ownerSystemId: "first",
    allowedHostsAttributeId: "allowed-attr",
    networkHostsAttributeId: "network-attr",
  }]);
  assert.deepEqual(
    facts.graphContext,
    projectModelDiagnosticFacts({
      ...withAttributes,
      elements: [...withAttributes.elements].reverse(),
    }, [second, first]).graphContext,
  );

  assert.equal(facts.networkCapabilities.length, 1);
  assert.equal(
    lintModelDiagnostics(facts).filter((d) =>
      d.code === "CAPABILITY_BEYOND_MANDATE"
    ).length,
    1,
  );
  first.configuration.network.allowedHosts.push("skills.example.org");
  facts = projectModelDiagnosticFacts(withAttributes, [first, second]);
  assert.equal(
    lintModelDiagnostics(facts).some((d) =>
      d.code === "CAPABILITY_BEYOND_MANDATE"
    ),
    false,
  );
  first.configuration.network.allowedHosts = [];
  const withoutNetworkAttribute = {
    ...withAttributes,
    elements: withAttributes.elements.filter((element) =>
      element["@id"] !== "network-attr"
    ),
  };
  const noNetwork = projectModelDiagnosticFacts(withoutNetworkAttribute, [
    first,
    second,
  ]);
  assert.deepEqual(noNetwork.graphContext!.capabilities, [{
    policyElementId: "skills",
    ownerSystemId: "first",
    allowedHostsAttributeId: "allowed-attr",
  }]);
  assert.deepEqual(noNetwork.networkCapabilities[0]!.mandateHosts, []);
  first.configuration.network.allowedHosts = ["example.org"];
  assert.throws(
    () => projectModelDiagnosticFacts(withoutNetworkAttribute, [first, second]),
    /no source attribute provenance/,
  );
  delete first.skillPolicy;
  assert.deepEqual(
    projectModelDiagnosticFacts(withAttributes, [first, second])
      .networkCapabilities,
    [],
  );
});

Deno.test("compiler graph context retains each admitted plan owner and no business verdicts", () => {
  const first = model("first"),
    second = model("second"),
    foreign = model("foreign");
  for (const owner of [first, second]) {
    owner.operatorEntries = [entry("shared-plan", "work-plan")];
    owner.behaviors = [
      behavior(
        `${owner.identity.systemId}-access`,
        "shared-plan",
        owner.identity.builderId,
      ),
    ];
  }
  foreign.behaviors = [
    behavior("foreign-access", "shared-plan", foreign.identity.builderId),
  ];
  const projected = projectModelDiagnosticFacts(revision, [
    first,
    second,
    foreign,
  ]);
  const context = projected.graphContext!;
  assert.deepEqual(
    context,
    projectModelDiagnosticFacts(revision, [foreign, second, first])
      .graphContext,
  );
  assert.deepEqual(
    context.units.filter((u) => u.kind === "plan").map((u) => u.ownerSystemId),
    ["first", "second"],
  );
  assert.equal(projected.units.filter((u) => u.kind === "plan").length, 1);
  assert.equal(JSON.stringify(context).includes("hasInvocationBudget"), false);
  assert.equal(JSON.stringify(context).includes("outsideHosts"), false);
});
