import type { ScopedOperatorRef as DomainScopedOperatorRef } from "../../../domain/governance/authority.ts";
import {
  EVOLUTION_CATEGORIES,
  type EvolutionCategory,
} from "../../../domain/model/evolution/policy.ts";
import {
  canonical,
  compareCodeUnits,
} from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import { EvolutionError } from "./ports.ts";
import {
  parseScopedSoftwareContext,
  type ScopedSoftwareContextV2,
} from "./scoped-software-context.ts";

/** Signature preimage only. Source assessment v1 remains evidence, not an
 * authority receipt. Software publication/D2 and adoption proofs are not yet
 * implemented and must never be fabricated from the human Request v2 path. */
export interface ScopedSoftwareProposalV2 {
  readonly format: "software-evolution-scoped/v2";
  readonly context: ScopedSoftwareContextV2;
  readonly sourceAssessmentDigest: string;
  readonly targets: readonly {
    readonly target: Readonly<DomainScopedOperatorRef>;
    readonly candidateDigest: string;
  }[];
  readonly categories: readonly EvolutionCategory[];
}
function invalid(): never {
  throw new EvolutionError(
    "EVOLUTION_INVALID",
    "Invalid scoped software proposal",
  );
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) invalid();
  return record;
}
function hash(value: unknown): asserts value is string {
  if (!isSha256Hex(value)) invalid();
}
/** No grants or semantic compatibility are proved by this closed grammar. */
export function parseScopedSoftwareProposal(
  value: unknown,
): ScopedSoftwareProposalV2 {
  const v = object(structuredClone(value), [
    "format",
    "context",
    "sourceAssessmentDigest",
    "targets",
    "categories",
  ]);
  if (v.format !== "software-evolution-scoped/v2") invalid();
  const context = parseScopedSoftwareContext(v.context);
  hash(v.sourceAssessmentDigest);
  if (
    !Array.isArray(v.targets) || v.targets.length !== context.targets.length
  ) invalid();
  const seen = new Set<string>();
  const targets = Array.from(v.targets).map((entry) => {
    const t = object(entry, ["target", "candidateDigest"]);
    object(t.target, [
      "projectId",
      "systemId",
      "executionSpaceId",
      "operatorId",
    ]);
    const expected = context.targets.find((item) =>
      canonical(item.target) === canonical(t.target)
    );
    if (!expected) invalid();
    const key = canonical(expected.target);
    if (seen.has(key)) invalid();
    seen.add(key);
    hash(t.candidateDigest);
    if (t.candidateDigest === expected.previousPin.modelDigest) invalid();
    return Object.freeze({
      target: expected.target,
      candidateDigest: t.candidateDigest,
    });
  }).sort((a, b) => compareCodeUnits(canonical(a.target), canonical(b.target)));
  if (
    !Array.isArray(v.categories) || !v.categories.length ||
    v.categories.length > EVOLUTION_CATEGORIES.length ||
    new Set(v.categories).size !== v.categories.length ||
    Array.from(v.categories).some((category) =>
      !EVOLUTION_CATEGORIES.includes(category)
    )
  ) invalid();
  const categories: EvolutionCategory[] = [...v.categories];
  return Object.freeze<ScopedSoftwareProposalV2>({
    format: "software-evolution-scoped/v2",
    context,
    sourceAssessmentDigest: v.sourceAssessmentDigest,
    targets: Object.freeze(targets),
    categories: Object.freeze(categories.sort(compareCodeUnits)),
  });
}

/** Capture/validate all caller data before the first await. All three native
 * acts must sign this scoped digest; scope cannot be attached after signing. */
export async function scopedSoftwareProposalDigest(
  value: unknown,
): Promise<string> {
  const proposal = parseScopedSoftwareProposal(value);
  return await canonicalDigest(proposal);
}
