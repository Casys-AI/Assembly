import { isPlainRecord as record } from "../../primitives/is-plain-record.ts";
/** Closed, source-admitted authority for exact behavior revisions. */
import type { NativePolicyIdentity } from "../execution/executable-model.ts";
import type { ModelEditOperation } from "../../governance/model-access/model-edit-policy.ts";
import { IMPLEMENTATION } from "../execution/flow.ts";

export const EVOLUTION_FLOW_MECHANISMS: readonly string[] = [
  ...new Set([
    ...Object.values(IMPLEMENTATION),
    "consult_declared_source",
    "execute_operator_command",
  ]),
];

export const EVOLUTION_CATEGORIES = [
  "flow",
  "instructions",
  "budgets",
  "context",
  "memory",
  "contracts",
] as const;
export type EvolutionCategory = typeof EVOLUTION_CATEGORIES[number];
export type EvolutionAct = "prepare" | "accept" | "adopt";
export interface NumericEnvelope {
  min: number;
  max: number;
}
interface FlowEvolutionBounds {
  rootNativeIds: string[];
  allowedMechanisms: string[];
  maxNodes: number;
  maxEdges: number;
}
interface InstructionEvolutionBounds {
  maxCharacters: number;
}
interface BudgetEvolutionBounds {
  fields: Partial<
    Record<
      | "maxAgentDecisions"
      | "maxToolProposals"
      | "maxFlowSteps"
      | "workBudgetLimit",
      NumericEnvelope
    >
  >;
  caseTypes: { caseTypeId: string; limit: NumericEnvelope }[];
}
interface ContextEvolutionBounds {
  fields: Partial<
    Record<
      | "recentMessages"
      | "maxMessageCharacters"
      | "maxCollectionItems"
      | "maxContextCharacters",
      NumericEnvelope
    >
  >;
}
interface MemoryEvolutionBounds {
  fields: {
    allowedScopes?: string[];
    maxValidityMs?: NumericEnvelope;
    requireSourceRefs?: boolean[];
    requireKnownOutcome?: boolean[];
    allowSelfAdmission?: boolean[];
  };
}
interface ContractEvolutionBounds {
  contractNativeIds: string[];
  inputTypeNativeIds: string[];
  allowedExposures: {
    callerNativeId: string;
    targetNativeId: string;
    inputTypeId: string;
  }[];
}
interface EvolutionBoundsByCategory {
  flow: FlowEvolutionBounds;
  instructions: InstructionEvolutionBounds;
  budgets: BudgetEvolutionBounds;
  context: ContextEvolutionBounds;
  memory: MemoryEvolutionBounds;
  contracts: ContractEvolutionBounds;
}
export type EvolutionGrant = {
  [K in EvolutionCategory]: {
    act: EvolutionAct;
    targetNativeId: string;
    category: K;
    bounds: EvolutionBoundsByCategory[K];
  };
}[EvolutionCategory];
export interface NativeEvolutionPolicy extends NativePolicyIdentity {
  holderNativeId: string;
  mandateNativeId: string;
  mandateId: string;
  mandateRevision: number;
  grants: EvolutionGrant[];
}
export interface EvolutionAuthorityExercise {
  act: EvolutionAct;
  operatorNativeId: string;
  systemQualifiedName: string;
  authorityDigest: string;
  policyId: string;
  policyRevision: number;
  mandateNativeId: string;
  mandateId: string;
  mandateRevision: number;
  targets: string[];
  categories: EvolutionCategory[];
  proposalDigest: string;
}
/** Ordinary edit permission remains a separate captured prerequisite. */
interface EvolutionEditAuthorization {
  kind: "operator";
  systemQualifiedName: string;
  operatorQualifiedName: string;
  operatorNativeId: string;
  mandateId: string;
  mandateRevision: number;
  policyId: string;
  policyRevision: number;
  policyDigest: string;
  operations: ModelEditOperation[];
}
export interface EvolutionProposalAuthorization {
  kind: "operator-evolution";
  systemQualifiedName: string;
  operatorNativeId: string;
  editAuthorization: EvolutionEditAuthorization;
  exercise: EvolutionAuthorityExercise;
  recipeDigest: string;
  typedEdits?: import("../editing/tooling.ts").ModelEditRequest;
}
class EvolutionPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionPolicyError";
  }
}
export function requireEvolution(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new EvolutionPolicyError(message);
}
export function evolutionIdentity(value: unknown): value is string {
  return typeof value === "string" && !!value && value.trim() === value &&
    value.length <= 1024 && !value.includes("*") &&
    [...value].every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    );
}
function keys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  requireEvolution(
    record(value) &&
      Object.keys(value).sort().join(",") === [...expected].sort().join(","),
    "Unsupported evolution fields",
  );
}
function integer(
  value: unknown,
  min: number,
  max: number,
): asserts value is number {
  requireEvolution(
    typeof value === "number" && Number.isSafeInteger(value) && value >= min &&
      value <= max,
    "Invalid evolution integer bound",
  );
}
function identities(
  value: unknown,
  minimum = 0,
  maximum = 128,
): asserts value is string[] {
  requireEvolution(
    Array.isArray(value) && value.length >= minimum &&
      value.length <= maximum && value.every(evolutionIdentity) &&
      new Set(value).size === value.length,
    "Invalid evolution identity set",
  );
}
function envelope(value: unknown, min: number, max: number): void {
  keys(value, ["min", "max"]);
  integer(value.min, min, max);
  integer(value.max, min, max);
  requireEvolution(value.min <= value.max, "Inverted evolution envelope");
}
function numericFields(
  value: unknown,
  ranges: Record<string, readonly [number, number]>,
  allowEmpty = false,
): void {
  requireEvolution(
    record(value) && (allowEmpty || Object.keys(value).length > 0),
    "Missing evolution field bounds",
  );
  for (const [name, bound] of Object.entries(value)) {
    requireEvolution(
      Object.hasOwn(ranges, name),
      "Unknown bounded evolution field",
    );
    envelope(bound, ...ranges[name]!);
  }
}
function validateEvolutionBounds(
  category: EvolutionCategory,
  value: unknown,
): void {
  switch (category) {
    case "flow": {
      keys(value, [
        "rootNativeIds",
        "allowedMechanisms",
        "maxNodes",
        "maxEdges",
      ]);
      identities(value.rootNativeIds, 1);
      identities(value.allowedMechanisms, 1, 64);
      requireEvolution(
        value.allowedMechanisms.every((mechanism) =>
          EVOLUTION_FLOW_MECHANISMS.includes(mechanism)
        ),
        "Unsupported evolution flow mechanism",
      );
      integer(value.maxNodes, 1, 1024);
      integer(value.maxEdges, 1, 4096);
      break;
    }
    case "instructions":
      keys(value, ["maxCharacters"]);
      integer(value.maxCharacters, 1, 16000);
      break;
    case "budgets": {
      keys(value, ["fields", "caseTypes"]);
      numericFields(value.fields, {
        maxAgentDecisions: [1, Number.MAX_SAFE_INTEGER],
        maxToolProposals: [0, Number.MAX_SAFE_INTEGER],
        maxFlowSteps: [1, Number.MAX_SAFE_INTEGER],
        workBudgetLimit: [0, 1000000],
      }, true);
      requireEvolution(
        Array.isArray(value.caseTypes) && value.caseTypes.length <= 128,
        "Invalid bounded Case budgets",
      );
      const seen = new Set<string>();
      for (const entry of value.caseTypes) {
        keys(entry, ["caseTypeId", "limit"]);
        requireEvolution(
          evolutionIdentity(entry.caseTypeId) && !seen.has(entry.caseTypeId),
          "Invalid Case budget identity",
        );
        seen.add(entry.caseTypeId);
        envelope(entry.limit, 0, Number.MAX_SAFE_INTEGER);
      }
      requireEvolution(
        Object.keys(value.fields as object).length + value.caseTypes.length > 0,
        "Empty budget bounds",
      );
      break;
    }
    case "context":
      keys(value, ["fields"]);
      numericFields(value.fields, {
        recentMessages: [1, 100],
        maxMessageCharacters: [256, 100000],
        maxCollectionItems: [1, 128],
        maxContextCharacters: [4096, 2000000],
      });
      break;
    case "memory": {
      keys(value, ["fields"]);
      requireEvolution(
        record(value.fields) && Object.keys(value.fields).length > 0,
        "Missing memory bounds",
      );
      for (const [name, bound] of Object.entries(value.fields)) {
        if (name === "allowedScopes") {
          identities(bound, 1, 32);
          requireEvolution(
            bound.every((scope) => scope.length <= 128),
            "Memory scope too long",
          );
        } else if (name === "maxValidityMs") envelope(bound, 1, 31536000000);
        else {
          requireEvolution(
            ["requireSourceRefs", "requireKnownOutcome", "allowSelfAdmission"]
              .includes(name),
            "Unknown memory field",
          );
          requireEvolution(
            Array.isArray(bound) && bound.length >= 1 && bound.length <= 2 &&
              bound.every((entry) => typeof entry === "boolean") &&
              new Set(bound).size === bound.length,
            "Invalid memory review bound",
          );
        }
      }
      break;
    }
    case "contracts": {
      keys(value, [
        "contractNativeIds",
        "inputTypeNativeIds",
        "allowedExposures",
      ]);
      identities(value.contractNativeIds);
      identities(value.inputTypeNativeIds);
      requireEvolution(
        Array.isArray(value.allowedExposures) &&
          value.allowedExposures.length <= 128,
        "Invalid exposure bounds",
      );
      const seen = new Set<string>();
      for (const entry of value.allowedExposures) {
        keys(entry, ["callerNativeId", "targetNativeId", "inputTypeId"]);
        requireEvolution(
          Object.values(entry).every(evolutionIdentity) &&
            !seen.has(JSON.stringify(entry)),
          "Invalid exact exposure",
        );
        seen.add(JSON.stringify(entry));
      }
      requireEvolution(
        value.contractNativeIds.length + value.inputTypeNativeIds.length +
            value.allowedExposures.length > 0,
        "Empty contract bounds",
      );
      break;
    }
    default:
      throw new EvolutionPolicyError("Unknown evolution category");
  }
}
export function parseEvolutionGrants(value: string): EvolutionGrant[] {
  const parsed: unknown = JSON.parse(value);
  requireEvolution(
    Array.isArray(parsed) && parsed.length >= 1 && parsed.length <= 128 &&
      JSON.stringify(parsed) === value,
    "Invalid canonical evolution grants",
  );
  const seen = new Set<string>();
  for (const grant of parsed) {
    keys(grant, ["act", "targetNativeId", "category", "bounds"]);
    requireEvolution(
      ["prepare", "accept", "adopt"].includes(String(grant.act)) &&
        evolutionIdentity(grant.targetNativeId) &&
        EVOLUTION_CATEGORIES.includes(grant.category as EvolutionCategory),
      "Invalid evolution grant",
    );
    const key = JSON.stringify([
      grant.act,
      grant.targetNativeId,
      grant.category,
    ]);
    requireEvolution(!seen.has(key), "Duplicate evolution grant");
    seen.add(key);
    validateEvolutionBounds(grant.category as EvolutionCategory, grant.bounds);
  }
  return parsed as EvolutionGrant[];
}
