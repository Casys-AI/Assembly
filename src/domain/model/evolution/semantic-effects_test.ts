import {
  deepStrictEqual as assertEquals,
  throws as assertThrows,
} from "node:assert/strict";
import type { ExecutableModel } from "../execution/executable-model.ts";
import {
  classifyEvolutionEffects,
  type ScopedExecutableModel,
} from "./semantic-effects.ts";

function scope(id = "operator"): ScopedExecutableModel {
  const model = {
    identity: { builderId: id, systemId: `${id}-system` },
    operator: {
      instruction: "previous",
      name: id,
      primary: false,
      humanInput: false,
    },
    policy: {
      maxAgentDecisions: 10,
      maxFlowSteps: 100,
      mayProposeSysmlRevision: true,
    },
    flows: {
      conversation: {
        rootNativeId: `${id}-flow`,
        maxSteps: 100,
        nodes: [],
        edges: [],
        bindings: [],
      },
    },
    catalog: [],
    contracts: [],
    version: { digest: "old", sourceIds: ["instruction"] },
  } as unknown as ExecutableModel;
  return {
    systemQualifiedName: `Test::${id}`,
    model,
    evidence: {
      digestInputs: [{
        operator: structuredClone(model.operator),
        policy: structuredClone(model.policy),
        allocations: [{ id: "allocation", performer: id }],
        sourceIds: ["instruction"],
      }],
      sourceFacts: {
        instruction: { value: "previous" },
        unknown: { value: "protected" },
      },
      sourceCategories: { instruction: "instructions" },
    },
  };
}

Deno.test("the optional callable-catalog digest layer is contracts-only while other settings retain stable paths", () => {
  const before = scope(), after = structuredClone(before);
  before.model.behaviors = [];
  before.evidence.digestInputs.push({
    base: "verified",
    behaviors: [{ id: "access" }],
  });
  const policy = { maxValidityMs: 86400000 };
  before.evidence.digestInputs.push({ base: "verified", memoryPolicy: policy });
  after.evidence.digestInputs.push({ base: "verified", memoryPolicy: policy });
  assertEquals(
    classifyEvolutionEffects([before], [after]).map((effect) =>
      effect.category
    ),
    ["contracts"],
  );
});

Deno.test("an extra protected field prevents removal of a callable-catalog digest layer", () => {
  const before = scope(), after = structuredClone(before);
  before.evidence.digestInputs.push({
    base: "verified",
    behaviors: [],
    hiddenGate: true,
  });
  assertThrows(
    () => classifyEvolutionEffects([before], [after]),
    /Protected or unclassified/,
  );
});
Deno.test("semantic projection allows the exact instruction but protects endpoint role and host policy", () => {
  const before = scope(), after = structuredClone(before);
  after.model.operator!.instruction = "next";
  (after.evidence.digestInputs[0].operator as Record<string, unknown>)
    .instruction = "next";
  after.evidence.sourceFacts.instruction = { value: "next" };
  assertEquals(
    classifyEvolutionEffects([before], [after]).map((effect) =>
      effect.category
    ),
    ["instructions"],
  );
  after.model.operator!.primary = true;
  assertThrows(
    () => classifyEvolutionEffects([before], [after]),
    /Protected or unclassified/,
  );
  after.model.operator!.primary = false;
  after.model.policy.mayProposeSysmlRevision = false;
  assertThrows(
    () => classifyEvolutionEffects([before], [after]),
    /Protected or unclassified/,
  );
});
Deno.test("an unclassified native or compiler fact cannot hide behind an authorized category", () => {
  const before = scope(), after = structuredClone(before);
  after.evidence.sourceFacts.unknown = { value: "changed" };
  assertThrows(
    () => classifyEvolutionEffects([before], [after]),
    /Protected or unclassified/,
  );
  after.evidence.sourceFacts.unknown = { value: "protected" };
  after.evidence.digestInputs[0].hiddenHostGate = true;
  assertThrows(
    () => classifyEvolutionEffects([before], [after]),
    /Protected or unclassified/,
  );
});
Deno.test("every affected consumer is enumerated and native replacement is refused", () => {
  const a = scope("a"), b = scope("b"), next = structuredClone(b);
  next.model.operator!.instruction = "new shared instruction";
  assertEquals(
    classifyEvolutionEffects([a, b], [a, next]).map((effect) =>
      effect.targetNativeId
    ),
    ["b"],
  );
  assertThrows(
    () => classifyEvolutionEffects([a, b], [a]),
    /create, remove or replace/,
  );
});
Deno.test("a derived flow step ceiling requires budget authority, not flow authority", () => {
  const before = scope(), after = structuredClone(before);
  after.model.policy.maxFlowSteps = 200;
  after.model.flows.conversation.maxSteps = 200;
  (after.evidence.digestInputs[0].policy as Record<string, unknown>)
    .maxFlowSteps = 200;
  assertEquals(
    classifyEvolutionEffects([before], [after]).map((effect) =>
      effect.category
    ),
    ["budgets"],
  );
});

// Container facts arrive already normalized by the trusted collector
// (whole-container source-text copies removed there; see evidence_test).
Deno.test("normalized container facts do not change an unaffected consumer", () => {
  const main = scope("main"), peer = scope("peer");
  for (const entry of [main, peer]) {
    entry.evidence.sourceFacts.package = {
      "@id": "package",
      "@type": "Package",
      qualifiedName: "Test",
      unknownSemanticFlag: false,
    };
  }
  main.evidence.sourceFacts.system = {
    "@id": "main-system",
    "@type": "PartUsage",
    qualifiedName: "Test::Main",
    "sysx:declaredReference": false,
  };
  const nextMain = structuredClone(main), nextPeer = structuredClone(peer);
  nextMain.model.operator!.instruction = "new instruction";
  (nextMain.evidence.digestInputs[0].operator as Record<string, unknown>)
    .instruction = "new instruction";
  nextMain.evidence.sourceFacts.instruction = { value: "new instruction" };
  assertEquals(
    classifyEvolutionEffects([main, peer], [nextMain, nextPeer]).map((
      effect,
    ) => [effect.targetNativeId, effect.category]),
    [["main", "instructions"]],
  );
  (nextPeer.evidence.sourceFacts.package as Record<string, unknown>)
    .unknownSemanticFlag = true;
  assertThrows(
    () => classifyEvolutionEffects([main, peer], [nextMain, nextPeer]),
    /Protected or unclassified/,
  );
  (nextPeer.evidence.sourceFacts.package as Record<string, unknown>)
    .unknownSemanticFlag = false;
  (nextMain.evidence.sourceFacts.system as Record<string, unknown>)[
    "sysx:declaredReference"
  ] = true;
  assertThrows(
    () => classifyEvolutionEffects([main, peer], [nextMain, nextPeer]),
    /Protected or unclassified/,
  );
});

Deno.test("native transition source text remains protected", () => {
  const before = scope(), after = structuredClone(before);
  before.evidence.sourceFacts.transition = {
    "@type": "TransitionUsage",
    "sysx:sourceText": "if condition then action",
  };
  after.evidence.sourceFacts.transition = {
    "@type": "TransitionUsage",
    "sysx:sourceText": "else action",
  };
  assertThrows(
    () => classifyEvolutionEffects([before], [after]),
    /Protected or unclassified/,
  );
});

Deno.test("pairwise ownership comparison preserves identical raw lists without hiding protected changes", () => {
  const keys = [
    "ownedMember",
    "ownedMembership",
    "ownedRelationship",
    "ownedFeature",
    "ownedFeatureMembership",
  ];
  for (const key of keys) {
    const before = scope(), after = structuredClone(before);
    before.evidence.sourceFacts.container = {
      "@type": "Package",
      [key]: [{ "@id": "flow-child" }],
      owner: "root",
    };
    after.evidence.sourceFacts.container = structuredClone(
      before.evidence.sourceFacts.container,
    );
    after.evidence.sourceFacts["flow-child"] = { "@type": "ActionDefinition" };
    after.evidence.sourceCategories["flow-child"] = "flow";
    assertEquals(
      classifyEvolutionEffects([before], [after]).map((effect) =>
        effect.category
      ),
      ["flow"],
    );
    const changed = structuredClone(after);
    (changed.evidence.sourceFacts.container as Record<string, unknown>)[key] =
      [];
    assertThrows(
      () => classifyEvolutionEffects([before], [changed]),
      /Protected or unclassified/,
    );
    const absent = structuredClone(after);
    delete (absent.evidence.sourceFacts.container as Record<string, unknown>)[
      key
    ];
    assertThrows(
      () => classifyEvolutionEffects([before], [absent]),
      /Protected or unclassified/,
    );
    const emptyBefore = structuredClone(before),
      absentAfter = structuredClone(after);
    (emptyBefore.evidence.sourceFacts.container as Record<string, unknown>)[
      key
    ] = [];
    delete (absentAfter.evidence.sourceFacts.container as Record<
      string,
      unknown
    >)[key];
    assertThrows(
      () => classifyEvolutionEffects([emptyBefore], [absentAfter]),
      /Protected or unclassified/,
    );
    const missing = structuredClone(after);
    delete missing.evidence.sourceFacts.container;
    assertThrows(
      () => classifyEvolutionEffects([before], [missing]),
      /Protected or unclassified/,
    );
    const categorized = structuredClone(after);
    categorized.evidence.sourceCategories.container = "flow";
    assertThrows(
      () => classifyEvolutionEffects([before], [categorized]),
      /Protected or unclassified/,
    );
    for (
      const [field, value] of [["@type", "PartUsage"], ["owner", "other"], [
        "mandate",
        "changed",
      ]]
    ) {
      const altered = structuredClone(after);
      (altered.evidence.sourceFacts.container as Record<string, unknown>)[
        field
      ] = value;
      assertThrows(
        () => classifyEvolutionEffects([before], [altered]),
        /Protected or unclassified/,
      );
    }
    const unknown = structuredClone(after);
    unknown.evidence.sourceFacts.unknown = { value: "changed" };
    assertThrows(
      () => classifyEvolutionEffects([before], [unknown]),
      /Protected or unclassified/,
    );
    const peer = scope("peer"), nextPeer = structuredClone(peer);
    nextPeer.evidence.sourceFacts.unknown = { value: "changed" };
    assertThrows(
      () => classifyEvolutionEffects([before, peer], [after, nextPeer]),
      /Protected or unclassified/,
    );
  }
});
