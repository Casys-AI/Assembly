import assert from "node:assert/strict";
import { needsEvolutionSettingsPreflight } from "./assessment.ts";
import type { EvolutionCategory } from "../../../domain/model/evolution/policy.ts";

Deno.test("evolution settings categories require runtime preflight even without a context policy", () => {
  const needs = (category: EvolutionCategory) =>
    needsEvolutionSettingsPreflight({
      before: [],
      after: [],
      effects: [{
        targetNativeId: "operator",
        systemQualifiedName: "System",
        category,
        before: {},
        after: {},
      }],
    });
  for (
    const category of ["budgets", "context", "memory", "contracts"] as const
  ) {
    assert.equal(needs(category), true);
  }
  assert.equal(
    needsEvolutionSettingsPreflight({ before: [], after: [], effects: [] }),
    false,
  );
});
