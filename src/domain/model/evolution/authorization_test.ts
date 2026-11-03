import {
  deepStrictEqual as assertEquals,
  rejects as assertRejects,
  throws as assertThrows,
} from "node:assert/strict";
import type { ExecutableModel } from "../execution/executable-model.ts";
import type { CompiledFlow } from "../execution/flow.ts";
import type { EvolutionAct, EvolutionGrant } from "./policy.ts";
import { artifactModel } from "../../../../test/support/tool-artifact-fixture.ts";
import type {
  EvolutionBehaviorDeclaration,
  EvolutionEffect,
  ScopedExecutableModel,
} from "./semantic-effects.ts";
import {
  createEvolutionAuthorityExercise,
  requireEvolutionEffectBounds,
  revalidateEvolutionAuthorityExercise,
} from "./authorization.ts";

function declarationFixture() {
  const actor = model();
  actor.contracts = [];
  const declaration: EvolutionBehaviorDeclaration = {
    id: "recall-access",
    name: "RecallNotes",
    description: "Read local notes",
    enabled: false,
    callerNativeId: "self",
    targetNativeId: "recall-entry",
    targetTypeId: "recall-action",
    inputTypeId: "recall-input",
    inputSchema: { type: "object" },
    sourceIds: ["enabled-value"],
  };
  const bounds = {
    contractNativeIds: [declaration.id],
    inputTypeNativeIds: [declaration.inputTypeId],
    allowedExposures: [{
      callerNativeId: declaration.callerNativeId,
      targetNativeId: declaration.targetNativeId,
      inputTypeId: declaration.inputTypeId,
    }],
  };
  actor.evolutionPolicy!.grants = (["prepare", "accept", "adopt"] as const)
    .map((act) => ({
      act,
      targetNativeId: "self",
      category: "contracts",
      bounds: structuredClone(bounds),
    }));
  const scope = (): ScopedExecutableModel => ({
    systemQualifiedName: "Test::Self",
    model: structuredClone(actor),
    evidence: {
      digestInputs: [{}],
      sourceCategories: { "enabled-value": "contracts" },
      sourceFacts: { "enabled-value": { value: false } },
      behaviorDeclarations: [structuredClone(declaration)],
    },
  });
  const before = scope(), after = scope();
  const effect: EvolutionEffect = {
    targetNativeId: "self",
    systemQualifiedName: "Test::Self",
    category: "contracts",
    before: {},
    after: {},
  };
  return {
    actor,
    before,
    after,
    check: (act: EvolutionAct = "prepare") =>
      requireEvolutionEffectBounds(actor, act, [effect], [before], [after]),
  };
}

Deno.test("disabled declarations retain exact per-act grants across disable and re-enable", () => {
  for (const enabled of [true, false]) {
    const f = declarationFixture();
    f.before.evidence.behaviorDeclarations![0].enabled = !enabled;
    f.after.evidence.behaviorDeclarations![0].enabled = enabled;
    for (const act of ["prepare", "accept", "adopt"] as const) {
      f.check(act);
      const missing = structuredClone(f.actor.evolutionPolicy!.grants);
      f.actor.evolutionPolicy!.grants = missing.filter((grant) =>
        grant.act !== act
      );
      assertThrows(() => f.check(act), /Missing .* evolution category grant/);
      f.actor.evolutionPolicy!.grants = missing;
    }
  }
});

Deno.test("an inactive-to-inactive metadata or native-only change cannot escape its access-ID grant", () => {
  for (const nativeOnly of [false, true]) {
    const f = declarationFixture();
    if (nativeOnly) {
      f.after.evidence.sourceFacts["enabled-value"] = { changedSupport: true };
    } else {
      f.after.evidence.behaviorDeclarations![0].description =
        "Changed latent description";
    }
    f.check();
    for (const id of ["recall-entry", "recall-action", "unrelated-access"]) {
      for (const grant of f.actor.evolutionPolicy!.grants) {
        if (grant.category === "contracts") {
          grant.bounds.contractNativeIds = [id];
        }
      }
      assertThrows(
        () => f.check(),
        /declaration is outside its prior native scope/,
      );
    }
  }
});

Deno.test("changed disabled declarations check both prior and proposed input and exposure bounds", () => {
  for (
    const field of ["inputTypeId", "targetNativeId", "callerNativeId"] as const
  ) {
    const f = declarationFixture();
    const declaration = f.after.evidence.behaviorDeclarations![0];
    declaration[field] = "replacement";
    assertThrows(() => f.check(), /input type|explicit exposure authority/);
    for (const grant of f.actor.evolutionPolicy!.grants) {
      if (grant.category !== "contracts") continue;
      if (!grant.bounds.inputTypeNativeIds.includes(declaration.inputTypeId)) {
        grant.bounds.inputTypeNativeIds.push(declaration.inputTypeId);
      }
      grant.bounds.allowedExposures.push({
        callerNativeId: declaration.callerNativeId,
        targetNativeId: declaration.targetNativeId,
        inputTypeId: declaration.inputTypeId,
      });
    }
    f.check();
    // Keeping only proposed bounds cannot erase the old declaration's scope.
    for (const grant of f.actor.evolutionPolicy!.grants) {
      if (grant.category !== "contracts") continue;
      grant.bounds.allowedExposures = grant.bounds.allowedExposures.slice(1);
    }
    assertThrows(() => f.check(), /explicit exposure authority/);
  }
});

Deno.test("one missing side of native declaration provenance refuses instead of falling back", () => {
  const f = declarationFixture();
  delete f.after.evidence.behaviorDeclarations;
  assertThrows(() => f.check(), /Incomplete behavior declaration provenance/);
});

function model(): ExecutableModel {
  return {
    identity: { builderId: "self" },
    configuration: { builder: { mandateRevision: 1 } },
    mandate: { id: "mandate" },
    operator: { instruction: "old" },
    evolutionPolicy: {
      id: "evolution",
      revision: 1,
      elementId: "policy",
      sourceIds: [],
      holderNativeId: "self",
      mandateId: "mandate",
      mandateNativeId: "mandate-native",
      mandateRevision: 1,
      rootAuthority: { ownerSource: "modeled" },
      grants: [{
        act: "prepare",
        targetNativeId: "self",
        category: "instructions",
        bounds: { maxCharacters: 20 },
      }],
    },
  } as unknown as ExecutableModel;
}
const subject = {
  act: "prepare" as const,
  systemQualifiedName: "Test::Self",
  targets: ["self"],
  categories: ["instructions" as const],
  proposalDigest: "exact-proposal",
};

const settingGrants: EvolutionGrant[] = [{
  act: "prepare",
  targetNativeId: "self",
  category: "instructions",
  bounds: { maxCharacters: 20 },
}, {
  act: "prepare",
  targetNativeId: "self",
  category: "budgets",
  bounds: {
    fields: {
      maxAgentDecisions: { min: 3, max: 10 },
      maxToolProposals: { min: 1, max: 3 },
      maxFlowSteps: { min: 64, max: 150 },
      workBudgetLimit: { min: 3, max: 8 },
    },
    caseTypes: [{ caseTypeId: "request-type", limit: { min: 3, max: 8 } }],
  },
}, {
  act: "prepare",
  targetNativeId: "self",
  category: "context",
  bounds: {
    fields: {
      recentMessages: { min: 4, max: 12 },
      maxMessageCharacters: { min: 512, max: 2048 },
      maxCollectionItems: { min: 4, max: 12 },
      maxContextCharacters: { min: 10000, max: 120000 },
    },
  },
}, {
  act: "prepare",
  targetNativeId: "self",
  category: "memory",
  bounds: {
    fields: {
      allowedScopes: ["local", "project"],
      maxValidityMs: { min: 3600000, max: 172800000 },
      requireSourceRefs: [true],
      requireKnownOutcome: [true],
      allowSelfAdmission: [false],
    },
  },
}, {
  act: "prepare",
  targetNativeId: "self",
  category: "contracts",
  bounds: {
    contractNativeIds: ["contract"],
    inputTypeNativeIds: ["input"],
    allowedExposures: [{
      callerNativeId: "self",
      targetNativeId: "target",
      inputTypeId: "input",
    }],
  },
}];

function settingsActor(grants: EvolutionGrant[]) {
  const actor = artifactModel("self");
  actor.evolutionPolicy = {
    ...structuredClone(model().evolutionPolicy!),
    mandateId: actor.mandate.id,
    mandateRevision: actor.configuration.builder.mandateRevision,
    grants: structuredClone(grants),
  };
  return actor;
}

Deno.test("every non-flow category requires its exact act and target grant and rejects selective revocation", async () => {
  const acts = ["prepare", "accept", "adopt"] as const;
  const allGrants = acts.flatMap((act) =>
    settingGrants.map((grant) => ({ ...structuredClone(grant), act }))
  );
  for (const template of settingGrants) {
    for (const act of acts) {
      const actor = settingsActor([{ ...structuredClone(template), act }]);
      const exact = { ...subject, act, categories: [template.category] };
      const exercise = await createEvolutionAuthorityExercise(actor, exact);
      assertEquals(exercise.categories, [template.category]);
      assertEquals(exercise.targets, ["self"]);
      await revalidateEvolutionAuthorityExercise(actor, exercise);
      await assertRejects(
        () =>
          createEvolutionAuthorityExercise(actor, {
            ...exact,
            targets: ["foreign-target"],
          }),
        /Missing .* grant for foreign-target/,
      );
      for (
        const other of settingGrants.filter((grant) =>
          grant.category !== template.category
        )
      ) {
        await assertRejects(
          () =>
            createEvolutionAuthorityExercise(actor, {
              ...exact,
              categories: [other.category],
            }),
          /Missing .* grant for self/,
        );
      }
      // Remove only this subject: every other category/act remains authorized.
      actor.evolutionPolicy!.grants = structuredClone(allGrants);
      const beforeRevocation = await createEvolutionAuthorityExercise(
        actor,
        exact,
      );
      actor.evolutionPolicy!.grants = allGrants.filter((grant) =>
        grant.act !== act || grant.category !== template.category
      );
      assertEquals(actor.evolutionPolicy!.grants.length, allGrants.length - 1);
      await assertRejects(
        () => createEvolutionAuthorityExercise(actor, exact),
        /Missing .* grant for self/,
      );
      await assertRejects(
        () => revalidateEvolutionAuthorityExercise(actor, beforeRevocation),
        /Missing .* grant for self/,
      );
      for (const remaining of actor.evolutionPolicy!.grants) {
        await createEvolutionAuthorityExercise(actor, {
          ...subject,
          act: remaining.act,
          categories: [remaining.category],
        });
      }
    }
  }
});

Deno.test("budget context and memory semantic changes stay inside their exact prior field envelopes", () => {
  for (const act of ["prepare", "accept", "adopt"] as const) {
    for (const template of settingGrants) {
      if (
        !(["budgets", "context", "memory"] as string[]).includes(
          template.category,
        )
      ) continue;
      const actor = settingsActor([{ ...structuredClone(template), act }]);
      actor.workBudgetPolicy = {
        id: "budget",
        revision: 1,
        elementId: "budget",
        sourceIds: [],
        unit: "agent-invocation",
        limit: 5,
        onExhausted: "wait",
        exhaustionRecipient: "local-control",
      };
      actor.caseTypes = [{
        id: "request-type",
        name: "Request",
        type: "request",
        ownerId: "self",
        envelope: "conversational",
        behaviorId: actor.flows.conversation.rootNativeId,
        maxInvocations: 5,
        sourceIds: ["request-type"],
      }];
      actor.contextPolicy = {
        id: "context",
        revision: 1,
        elementId: "context",
        sourceIds: [],
        kind: "separated-context",
        pattern: "5.1",
        recentMessages: 8,
        maxMessageCharacters: 1024,
        maxCollectionItems: 8,
        maxContextCharacters: 100000,
      };
      actor.memoryPolicy = {
        id: "memory",
        revision: 1,
        elementId: "memory",
        sourceIds: [],
        kind: "governed-memory",
        pattern: "5.2",
        ownerId: "self",
        allowedScopes: ["local"],
        maxValidityMs: 86400000,
        requireSourceRefs: true,
        requireKnownOutcome: true,
        allowSelfAdmission: false,
      };
      const check = (
        before: ExecutableModel,
        after: ExecutableModel,
        grant: EvolutionGrant = actor.evolutionPolicy!.grants[0],
      ) => {
        const authorized = settingsActor([grant]);
        const scoped = (value: ExecutableModel): ScopedExecutableModel => ({
          model: value,
          systemQualifiedName: "Test::Self",
          evidence: { digestInputs: [], sourceFacts: {}, sourceCategories: {} },
        });
        const effect: EvolutionEffect = {
          targetNativeId: "self",
          systemQualifiedName: "Test::Self",
          category: template.category,
          before: {},
          after: {},
        };
        requireEvolutionEffectBounds(authorized, act, [effect], [
          scoped(before),
        ], [scoped(after)]);
      };
      if (template.category === "budgets") {
        const setters = {
          maxAgentDecisions: (next: ExecutableModel, value: number) => {
            next.policy.maxAgentDecisions = value;
          },
          maxToolProposals: (next: ExecutableModel, value: number) => {
            next.policy.maxToolProposals = value;
          },
          maxFlowSteps: (next: ExecutableModel, value: number) => {
            next.policy.maxFlowSteps = value;
          },
          workBudgetLimit: (next: ExecutableModel, value: number) => {
            next.workBudgetPolicy!.limit = value;
          },
        };
        for (
          const field of Object.keys(setters) as Array<keyof typeof setters>
        ) {
          const bound = template.bounds.fields[field]!;
          const next = structuredClone(actor);
          setters[field](next, bound.max);
          check(actor, next);
          for (const value of [bound.min - 1, bound.max + 1]) {
            setters[field](next, value);
            assertThrows(() => check(actor, next), /prior field envelope/);
          }
          setters[field](next, bound.max);
          const missing = structuredClone(template);
          missing.act = act;
          delete missing.bounds.fields[field];
          assertThrows(
            () => check(actor, next, missing),
            /prior field envelope/,
          );
        }
        const next = structuredClone(actor);
        for (const value of [3, 8]) {
          next.caseTypes![0].maxInvocations = value;
          check(actor, next);
        }
        for (const value of [2, 9]) {
          next.caseTypes![0].maxInvocations = value;
          assertThrows(() => check(actor, next), /prior field envelope/);
        }
        next.caseTypes![0].maxInvocations = 8;
        const foreign = structuredClone(template);
        foreign.act = act;
        foreign.bounds.caseTypes[0].caseTypeId = "foreign-type";
        assertThrows(() => check(actor, next, foreign), /prior field envelope/);
      } else if (template.category === "context") {
        for (
          const field of [
            "recentMessages",
            "maxMessageCharacters",
            "maxCollectionItems",
            "maxContextCharacters",
          ] as const
        ) {
          const bound = template.bounds.fields[field]!;
          const next = structuredClone(actor);
          next.contextPolicy![field] = bound.max;
          check(actor, next);
          for (const value of [bound.min - 1, bound.max + 1]) {
            next.contextPolicy![field] = value;
            assertThrows(() => check(actor, next), /prior field envelope/);
          }
          next.contextPolicy![field] = bound.max;
          const missing = structuredClone(template);
          missing.act = act;
          delete missing.bounds.fields[field];
          assertThrows(
            () => check(actor, next, missing),
            /prior field envelope/,
          );
        }
      } else if (template.category === "memory") {
        const next = structuredClone(actor);
        next.memoryPolicy!.allowedScopes = ["project"];
        check(actor, next);
        next.memoryPolicy!.allowedScopes = ["project", "ungranted-scope"];
        assertThrows(() => check(actor, next), /Memory scope exceeds/);
        next.memoryPolicy!.allowedScopes = ["local"];
        const bound = template.bounds.fields.maxValidityMs!;
        next.memoryPolicy!.maxValidityMs = bound.max;
        check(actor, next);
        for (const value of [bound.min - 1, bound.max + 1]) {
          next.memoryPolicy!.maxValidityMs = value;
          assertThrows(() => check(actor, next), /prior field envelope/);
        }
        for (
          const [field, allowed] of [["requireSourceRefs", true], [
            "requireKnownOutcome",
            true,
          ], ["allowSelfAdmission", false]] as const
        ) {
          const before = structuredClone(actor), after = structuredClone(actor);
          before.memoryPolicy![field] = !allowed;
          after.memoryPolicy![field] = allowed;
          check(before, after);
          before.memoryPolicy![field] = allowed;
          after.memoryPolicy![field] = !allowed;
          assertThrows(
            () => check(before, after),
            /Memory review change exceeds/,
          );
        }
      }
    }
  }
});

Deno.test("explicit self preparation does not grant acceptance or adoption", async () => {
  const actor = model();
  const exercise = await createEvolutionAuthorityExercise(actor, subject);
  assertEquals(exercise.operatorNativeId, "self");
  await assertRejects(() =>
    createEvolutionAuthorityExercise(actor, { ...subject, act: "accept" })
  );
  await assertRejects(() =>
    createEvolutionAuthorityExercise(actor, { ...subject, act: "adopt" })
  );
  await assertRejects(() =>
    createEvolutionAuthorityExercise(actor, {
      ...subject,
      targets: ["created-child"],
    })
  );
});
Deno.test("unchanged grants survive a behavior digest change; revocation and stale mandate fail", async () => {
  const actor = model(),
    exercise = await createEvolutionAuthorityExercise(actor, subject);
  actor.version = { digest: "new-behavior" } as ExecutableModel["version"];
  actor.operator!.instruction = "new";
  await revalidateEvolutionAuthorityExercise(actor, exercise);
  actor.configuration.builder.mandateRevision = 2;
  await assertRejects(() =>
    revalidateEvolutionAuthorityExercise(actor, exercise)
  );
  actor.configuration.builder.mandateRevision = 1;
  actor.evolutionPolicy = undefined;
  await assertRejects(() =>
    revalidateEvolutionAuthorityExercise(actor, exercise)
  );
});
Deno.test("the preparer's exact instruction envelope applies after semantic classification", () => {
  const a = model(), b = structuredClone(a);
  const scoped = (value: ExecutableModel) =>
    ({
      model: value,
      systemQualifiedName: "Test::Self",
    }) as ScopedExecutableModel;
  const effects: EvolutionEffect[] = [{
    targetNativeId: "self",
    systemQualifiedName: "Test::Self",
    category: "instructions",
    before: "old",
    after: "new",
  }];
  b.operator!.instruction = "new";
  requireEvolutionEffectBounds(a, "prepare", effects, [scoped(a)], [scoped(b)]);
  b.operator!.instruction = "this exceeds the authorized instruction size";
  assertThrows(() =>
    requireEvolutionEffectBounds(a, "prepare", effects, [scoped(a)], [
      scoped(b),
    ])
  );
});

Deno.test("a native-only flow effect still requires its exact flow root", () => {
  const actor = model();
  actor.evolutionPolicy!.grants = [{
    act: "prepare",
    targetNativeId: "self",
    category: "flow",
    bounds: {
      rootNativeIds: ["authorized-flow"],
      allowedMechanisms: ["read_case"],
      maxNodes: 20,
      maxEdges: 30,
    },
  }];
  actor.flows = {} as ExecutableModel["flows"];
  const old: ScopedExecutableModel = {
    model: actor,
    systemQualifiedName: "Test::Self",
    evidence: {
      digestInputs: [{}],
      sourceFacts: { fact: { value: "old" } },
      sourceCategories: { fact: "flow" },
      sourceFlowRoots: { fact: ["other-flow"] },
    },
  };
  const next = structuredClone(old);
  next.evidence.sourceFacts.fact = { value: "new" };
  const effects: EvolutionEffect[] = [{
    targetNativeId: "self",
    systemQualifiedName: "Test::Self",
    category: "flow",
    before: "old",
    after: "new",
  }];
  assertThrows(
    () =>
      requireEvolutionEffectBounds(actor, "prepare", effects, [old], [next]),
    /exact granted root/,
  );
});

function flow(root: string, mechanism = "read_case", count = 1): CompiledFlow {
  return {
    rootNativeId: root,
    rootOccurrenceId: root,
    name: root,
    source: { file: "model.sysml", line: 1 },
    startNodeId: "step-0",
    maxSteps: 100,
    nodes: Array.from({ length: count }, (_, index) => ({
      id: `step-${index}`,
      nativeId: `native-step-${index}`,
      name: `step-${index}`,
      kind: "action",
      mechanism,
      assertions: [],
      source: { file: "model.sysml", line: 1 },
      inputs: [],
      outputs: [],
    })),
    edges: [],
    bindings: [],
  };
}
function flowFixture() {
  const actor = model();
  actor.flows = {
    conversation: flow("conversation"),
    promotion: flow("promotion"),
  };
  actor.caseFlows = { a: flow("case-a"), b: flow("case-b") };
  actor.evolutionPolicy!.grants =
    (["prepare", "accept", "adopt"] as EvolutionAct[]).map((act) => ({
      act,
      targetNativeId: "self",
      category: "flow",
      bounds: {
        rootNativeIds: ["conversation"],
        allowedMechanisms: ["read_case"],
        maxNodes: 1,
        maxEdges: 1,
      },
    }));
  const scoped = (model: ExecutableModel): ScopedExecutableModel => ({
    model,
    systemQualifiedName: "Test::Self",
    evidence: { digestInputs: [], sourceFacts: {}, sourceCategories: {} },
  });
  const before = scoped(actor), after = structuredClone(before);
  const effects: EvolutionEffect[] = [{
    targetNativeId: "self",
    systemQualifiedName: "Test::Self",
    category: "flow",
    before: {},
    after: {},
  }];
  const check = (act: EvolutionAct) =>
    requireEvolutionEffectBounds(actor, act, effects, [before], [after]);
  return { actor, before, after, check };
}

Deno.test("Muse 1: future-template-only changes obey exact roots for prepare accept and adopt", () => {
  const f = flowFixture();
  f.after.model.operatorFlowTemplate = {
    qualifiedName: "Test::PrivateTemplate",
    revision: 1,
    typeNativeId: "private-type",
    digest: "private-template-digest",
    sourceIds: [],
  };
  f.after.evidence.templateFlow = flow("future-template");
  // Ordinary current and scheduled flows are deliberately unchanged.
  assertEquals(f.before.model.flows, f.after.model.flows);
  assertEquals(f.before.model.caseFlows, f.after.model.caseFlows);
  for (const act of ["prepare", "accept", "adopt"] as const) {
    assertThrows(() => f.check(act), /Creator template.*exact granted root/);
  }
});

Deno.test("Muse 1: an in-scope future template still obeys mechanism and node limits", () => {
  const f = flowFixture();
  for (const grant of f.actor.evolutionPolicy!.grants) {
    if (grant.category === "flow") {
      grant.bounds.rootNativeIds.push("future-template");
    }
  }
  f.after.model.operatorFlowTemplate = {
    qualifiedName: "Test::PrivateTemplate",
    revision: 1,
    typeNativeId: "private-type",
    digest: "private-template-digest",
    sourceIds: [],
  };
  f.after.evidence.templateFlow = flow(
    "future-template",
    "execute_operator_command",
  );
  assertThrows(() => f.check("prepare"), /Flow exceeds/);
  f.after.evidence.templateFlow = flow("future-template", "read_case", 2);
  assertThrows(() => f.check("prepare"), /Flow exceeds/);
  f.after.evidence.templateFlow = flow("future-template");
  f.check("prepare");
});

Deno.test("Muse 1: switching a Case to an unchanged existing flow cannot bypass the exact root", () => {
  const f = flowFixture();
  f.before.model.caseTypes = [{
    id: "case-type",
    name: "Case",
    type: "job",
    envelope: "conversational",
    ownerId: "self",
    behaviorId: "case-a",
    sourceIds: [],
  }];
  f.after.model.caseTypes = [{
    ...f.before.model.caseTypes[0],
    behaviorId: "case-b",
  }];
  assertEquals(f.before.model.caseFlows, f.after.model.caseFlows);
  for (const act of ["prepare", "accept", "adopt"] as const) {
    assertThrows(() => f.check(act), /Case behavior.*exact granted flow root/);
  }
  for (const grant of f.actor.evolutionPolicy!.grants) {
    if (grant.category === "flow") grant.bounds.rootNativeIds.push("case-b");
  }
  f.check("prepare");
  // Selecting an existing graph must enforce its mechanism envelope too.
  f.before.model.caseFlows!.b = f.after.model.caseFlows!.b = flow(
    "case-b",
    "execute_operator_command",
  );
  assertThrows(() => f.check("prepare"), /Flow exceeds/);
});
