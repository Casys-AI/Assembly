import assert from "node:assert/strict";
import type { ExecutableModel } from "../../../../../../../domain/model/execution/executable-model.ts";
import {
  classifyEvolutionEffects,
  type ScopedExecutableModel,
} from "../../../../../../../domain/model/evolution/semantic-effects.ts";
import { executionDigest } from "../../../../../../../domain/primitives/execution-digest.ts";
import { createEvolutionCompilationEvidence } from "./evidence.ts";
import { requireEvolutionEffectBounds } from "../../../../../../../domain/model/evolution/authorization.ts";

type Fact = Record<string, unknown>;
const ref = (id: string) => ({ "@id": id });
const fact = (
  id: string,
  type: string,
  owner?: string,
  extra: Fact = {},
): Fact => ({
  "@id": id,
  "@type": type,
  ...(owner ? { owner: ref(owner) } : {}),
  ...extra,
});

/** Minimal native IR input to the production collector; no compiler double or
 * copied classification algorithm. Connector ends use the real native shape. */
function fixture() {
  const elements: Fact[] = [
    fact("main", "PartUsage"),
    fact("flow", "PerformActionUsage", "main", {
      declaredName: "conversation",
      type: [ref("definition")],
    }),
    fact("definition", "ActionDefinition"),
    fact("first-action", "ActionUsage", "definition"),
    fact("next-action", "ActionUsage", "definition"),
    fact("decision", "DecisionNode", "definition"),
    fact("merge", "MergeNode", "definition"),
    fact("performer", "PartUsage", "main", { mayAdmit: false }),
    fact("other-performer", "PartUsage", "main", { mayAdmit: false }),
    fact("allocation", "AllocationUsage", "main", {
      connectorEnd: [ref("action-end"), ref("role-end")],
    }),
    fact("action-end", "ReferenceUsage", "allocation", {
      ownedReferenceSubsetting: ref("action-subset"),
    }),
    fact("action-subset", "ReferenceSubsetting", "action-end", {
      referencedFeature: ref("action-chain"),
    }),
    fact("action-chain", "Feature", "action-end", {
      chainingFeature: [ref("flow"), ref("first-action")],
      featureTarget: ref("first-action"),
    }),
    fact("action-link", "FeatureChaining", "action-chain", {
      chainingFeature: ref("first-action"),
    }),
    fact("role-end", "ReferenceUsage", "allocation", {
      ownedReferenceSubsetting: ref("role-subset"),
    }),
    fact("role-subset", "ReferenceSubsetting", "role-end", {
      referencedFeature: ref("performer"),
    }),
    fact("unrelated", "Feature", "main", { featureTarget: ref("performer") }),
    // A non-support member must remain protected even under a support owner.
    fact("policy", "PartUsage", "action-chain", { mayAdmit: false }),
    fact("request", "PartUsage", "main"),
    fact("behavior", "ActionUsage", "request", { declaredName: "behavior" }),
    fact("behavior-value", "FeatureValue", "behavior", {
      featureWithValue: ref("behavior"),
      value: ref("behavior-expression"),
    }),
    fact("behavior-expression", "FeatureReferenceExpression", "behavior"),
    fact("behavior-result", "Feature", "behavior-expression", {
      type: [ref("definition")],
    }),
    fact("behavior-binding", "BindingConnector", "behavior-expression"),
    fact("behavior-binding-end", "Feature", "behavior-binding", {
      type: [ref("definition")],
    }),
  ];
  const model = {
    identity: { builderId: "operator", systemId: "main", rootId: "global" },
    configuration: { builder: { mandateRevision: 1 } },
    mandate: { id: "mandate" },
    contracts: [],
    caseTypes: [{ id: "request", behaviorId: "flow" }],
    policy: { maxFlowSteps: 100 },
    flows: {
      conversation: {
        rootNativeId: "flow",
        rootOccurrenceId: "flow",
        maxSteps: 100,
        nodes: [{
          id: "action",
          nativeId: "first-action",
          name: "readCaseState",
          kind: "action",
          mechanism: "read_case",
          performerId: "performer",
          allocationId: "allocation",
          assertions: [],
          inputs: [],
          outputs: [],
        }],
        edges: [],
        bindings: [],
      },
    },
    evolutionPolicy: {
      holderNativeId: "operator",
      mandateId: "mandate",
      mandateRevision: 1,
      rootAuthority: { ownerSource: "modeled" },
      grants: [{
        act: "prepare",
        targetNativeId: "operator",
        category: "flow",
        bounds: {
          rootNativeIds: ["flow"],
          allowedMechanisms: ["read_case"],
          maxNodes: 10,
          maxEdges: 10,
        },
      }],
    },
    version: {
      digest: "",
      sourceIds: elements.map((element) => String(element["@id"])),
    },
  } as unknown as ExecutableModel;
  return { elements, model };
}

async function capture(
  input: ReturnType<typeof fixture>,
): Promise<ScopedExecutableModel> {
  const model = structuredClone(input.model);
  const digestInputs = [{
    flows: structuredClone(model.flows),
    sourceIds: [...model.version.sourceIds],
  }];
  model.version.digest = await executionDigest(digestInputs[0]);
  return {
    systemQualifiedName: "Test::Main",
    model,
    evidence: await createEvolutionCompilationEvidence(
      model,
      digestInputs,
      input.elements,
    ),
  };
}

function change(input: ReturnType<typeof fixture>, id: string): Fact {
  return input.elements.find((element) => element["@id"] === id)!;
}

Deno.test("an arbitrary part resembling a disabled access remains protected without validated declarations", async () => {
  const input = fixture();
  input.elements.push(
    fact("fake-access", "PartUsage", "main", {
      declaredName: "RecallNotesAccess",
    }),
    fact("fake-enabled", "AttributeUsage", "fake-access", {
      declaredName: "enabled",
    }),
    fact("fake-value", "LiteralBoolean", "fake-enabled", { value: false }),
  );
  const before = await capture(input);
  for (const id of ["fake-access", "fake-enabled", "fake-value"]) {
    assert.equal(before.evidence.sourceCategories[id], undefined);
  }
  const next = structuredClone(input);
  change(next, "fake-value").value = true;
  const after = await capture(next);
  assert.throws(
    () => classifyEvolutionEffects([before], [after]),
    /Protected or unclassified/,
  );
});

Deno.test("a supplied callable catalog cannot manufacture native declaration provenance", async () => {
  const input = fixture();
  input.model.behaviors = [{
    id: "fake-access",
    name: "RecallNotes",
    description: "No native declaration supports this catalog entry",
    callerNativeId: "operator",
    targetNativeId: "first-action",
    targetTypeId: "definition",
    inputTypeId: "input",
    inputSchema: { type: "object" },
    sourceIds: [],
  }];
  await assert.rejects(
    () => capture(input),
    /provenance differs from the callable catalog/,
  );
});

Deno.test("flow evidence covers compiled controls and owned reference supports with exact provenance", async () => {
  const scope = await capture(fixture());
  for (
    const id of [
      "decision",
      "merge",
      "allocation",
      "action-end",
      "action-subset",
      "action-chain",
      "action-link",
      "behavior-expression",
      "behavior-result",
      "behavior-binding",
      "behavior-binding-end",
    ]
  ) {
    assert.equal(scope.evidence.sourceCategories[id], "flow", id);
    assert.deepEqual(scope.evidence.sourceFlowRoots![id], ["flow"], id);
  }
  for (
    const id of [
      "role-end",
      "role-subset",
      "performer",
      "other-performer",
      "unrelated",
      "policy",
    ]
  ) {
    assert.equal(scope.evidence.sourceCategories[id], undefined, id);
  }
});

Deno.test("a compiled action-end rebind is flow-only and remains constrained to the granted root", async () => {
  const input = fixture(), next = structuredClone(input);
  next.model.flows.conversation.nodes[0]!.nativeId = "next-action";
  change(next, "action-chain").chainingFeature = [
    ref("flow"),
    ref("next-action"),
  ];
  change(next, "action-chain").featureTarget = ref("next-action");
  change(next, "action-link").chainingFeature = ref("next-action");
  change(next, "behavior-result").type = [ref("next-action")];
  change(next, "behavior-binding-end").type = [ref("next-action")];
  const before = await capture(input), after = await capture(next);
  const effects = classifyEvolutionEffects([before], [after]);
  assert.deepEqual(effects.map((effect) => effect.category), ["flow"]);
  requireEvolutionEffectBounds(before.model, "prepare", effects, [before], [
    after,
  ]);
  const outside = structuredClone(before.model);
  const grant = outside.evolutionPolicy!.grants[0]!;
  assert(grant.category === "flow");
  grant.bounds.rootNativeIds = ["another-flow"];
  assert.throws(
    () =>
      requireEvolutionEffectBounds(outside, "prepare", effects, [before], [
        after,
      ]),
    /exact granted root/,
  );
});

Deno.test("reference support classification does not authorize a performer, policy or unrelated reference change", async () => {
  const original = fixture(), before = await capture(original);
  for (const mutation of ["performer", "policy", "unrelated"] as const) {
    const next = structuredClone(original);
    if (mutation === "performer") {
      change(next, "role-subset").referencedFeature = ref("other-performer");
      next.model.flows.conversation.nodes[0]!.performerId = "other-performer";
    } else if (mutation === "policy") {
      change(next, "policy").mayAdmit = true;
    } else {
      change(next, "unrelated").featureTarget = ref("other-performer");
    }
    const after = await capture(next);
    assert.throws(
      () => classifyEvolutionEffects([before], [after]),
      /Protected or unclassified/,
      mutation,
    );
  }
});

Deno.test("collector refuses an allocation whose compiled role does not match the native ends", async () => {
  const input = fixture();
  input.model.flows.conversation.nodes[0]!.performerId = "other-performer";
  await assert.rejects(
    () => capture(input),
    /endpoints differ from the compiled action/,
  );
});

Deno.test("unrecognized unchanged allocation evidence stays accepted with supports protected", async () => {
  for (
    const representation of ["source-target", "missing-performer"] as const
  ) {
    const input = fixture();
    if (representation === "source-target") {
      const allocation = change(input, "allocation");
      delete allocation.connectorEnd;
      allocation.sourceFeature = ref("action-chain");
      allocation.targetFeature = [ref("performer")];
    } else {
      delete input.model.flows.conversation.nodes[0]!.performerId;
    }
    const before = await capture(input),
      unchanged = await capture(structuredClone(input));
    assert.equal(
      before.evidence.sourceCategories["action-chain"],
      undefined,
      representation,
    );
    assert.deepEqual(
      classifyEvolutionEffects([before], [unchanged]),
      [],
      representation,
    );
    const changed = structuredClone(input);
    changed.model.flows.conversation.nodes[0]!.nativeId = "next-action";
    change(changed, "action-chain").chainingFeature = [
      ref("flow"),
      ref("next-action"),
    ];
    change(changed, "action-chain").featureTarget = ref("next-action");
    change(changed, "action-link").chainingFeature = ref("next-action");
    const after = await capture(changed);
    assert.equal(
      after.evidence.sourceCategories["action-chain"],
      undefined,
      representation,
    );
    assert.throws(
      () => classifyEvolutionEffects([before], [after]),
      /Protected or unclassified/,
      representation,
    );
  }
});

Deno.test("evidence follows every owner through shared cyclic descendants and stops at nested systems", async () => {
  const input = fixture();
  // These new facts are deliberately absent from the admitted source IDs:
  // collection must discover them through ownership rather than the seed set.
  const admittedSourceIds = [...input.model.version.sourceIds];
  input.elements.push(
    fact("left", "PartUsage", "main", {
      owner: [ref("main"), ref("ownership-loop")],
    }),
    fact("right", "PartUsage", "main"),
    fact("shared", "PartUsage", undefined, {
      owner: [ref("outside"), ref("left"), ref("left"), ref("right")],
    }),
    fact("shared-leaf", "PartUsage", "shared"),
    fact("ownership-loop", "PartUsage", "shared"),
    fact("conversation-system-type", "PartDefinition", undefined, {
      qualifiedName: "AssemblyLiveBuilder::ConversationSystem",
    }),
    fact("nested-system", "PartUsage", "main", {
      type: [ref("conversation-system-type")],
    }),
    fact("nested-private", "PartUsage", "nested-system"),
    fact("nested-shared", "PartUsage", undefined, {
      owner: [ref("nested-system"), ref("right")],
    }),
    fact("outside", "PartUsage"),
    fact("outside-private", "PartUsage", "outside"),
    fact("shared-action", "ActionUsage", undefined, {
      owner: [ref("outside"), ref("definition"), ref("definition")],
    }),
    fact("shared-action-support", "ReferenceUsage", "shared-action"),
  );
  const scope = await capture(input);
  for (
    const id of [
      "left",
      "right",
      "shared",
      "shared-leaf",
      "ownership-loop",
      "nested-shared",
      "shared-action",
      "shared-action-support",
    ]
  ) {
    assert.deepEqual(scope.evidence.sourceFacts[id], change(input, id), id);
  }
  for (
    const id of [
      "nested-system",
      "nested-private",
      "conversation-system-type",
      "outside",
      "outside-private",
    ]
  ) {
    assert.equal(Object.hasOwn(scope.evidence.sourceFacts, id), false, id);
  }
  for (const id of ["shared-action", "shared-action-support"]) {
    assert.equal(scope.evidence.sourceCategories[id], "flow", id);
    assert.deepEqual(scope.evidence.sourceFlowRoots![id], ["flow"], id);
  }
  for (
    const id of ["shared", "shared-leaf", "ownership-loop", "nested-shared"]
  ) {
    assert.equal(scope.evidence.sourceCategories[id], undefined, id);
  }
  assert.deepEqual(scope.model.version.sourceIds, admittedSourceIds);
  assert.deepEqual(input.model.version.sourceIds, admittedSourceIds);
});
Deno.test("collector removes container source-text copies and keeps transition text protected", async () => {
  const input = fixture();
  change(input, "main")["sysx:sourceText"] = "part main { old }";
  input.elements.push(
    fact("pkg", "Package", "main", {
      "sysx:sourceText": "package Test { old }",
    }),
    fact("trans", "TransitionUsage", "main", {
      "sysx:sourceText": "if condition then action",
    }),
  );
  input.model.version.sourceIds.push("pkg", "trans");
  const before = await capture(input);
  assert.equal(
    Object.hasOwn(
      before.evidence.sourceFacts.main as Fact,
      "sysx:sourceText",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(before.evidence.sourceFacts.pkg as Fact, "sysx:sourceText"),
    false,
  );
  assert.equal(
    (before.evidence.sourceFacts.trans as Fact)["sysx:sourceText"],
    "if condition then action",
  );
  const containersOnly = structuredClone(input);
  change(containersOnly, "main")["sysx:sourceText"] = "part main { new }";
  change(containersOnly, "pkg")["sysx:sourceText"] = "package Test { new }";
  assert.deepEqual(
    classifyEvolutionEffects([before], [await capture(containersOnly)]),
    [],
  );
  const transitionChanged = structuredClone(input);
  change(transitionChanged, "trans")["sysx:sourceText"] = "else action";
  const afterTransition = await capture(transitionChanged);
  assert.throws(
    () => classifyEvolutionEffects([before], [afterTransition]),
    /Protected or unclassified/,
  );
});
