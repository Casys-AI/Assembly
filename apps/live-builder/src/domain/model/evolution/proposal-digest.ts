import { persistedOrder } from "../../primitives/persisted-order.ts";
import { executionDigest } from "../../primitives/execution-digest.ts";
import type { EvolutionCategory } from "./policy.ts";
import type { CompiledModel } from "../records/compiled-model.ts";

/** One recipe for staging, source admission, restart and receipt validation. */
export async function evolutionProposalDigest(input: {
  before: { version: string; sourceDigest: string };
  after: CompiledModel;
  recipeDigest: string;
  targets: {
    operatorId: string;
    previousDigest: string;
    candidateDigest: string;
  }[];
  categories: EvolutionCategory[];
}): Promise<string> {
  return await executionDigest({
    kind: "assembly-behavior-evolution/v1",
    baseVersion: input.before.version,
    baseSourceDigest: input.before.sourceDigest,
    sourceDigest: input.after.sourceDigest,
    semanticDigest: input.after.semanticDigest,
    provenanceDigest: input.after.provenanceDigest,
    engineVersion: input.after.engineVersion,
    provider: input.after.provider,
    recipeDigest: input.recipeDigest,
    targets: [...input.targets].sort((a, b) =>
      persistedOrder(a.operatorId, b.operatorId)
    ),
    categories: [...input.categories].sort(),
  });
}
