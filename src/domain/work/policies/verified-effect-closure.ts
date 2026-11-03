import { isPlainRecord as object } from "../../primitives/is-plain-record.ts";
/** APE 3.4: correlated source facts satisfy a prior native completion predicate. */
import type { BehaviorModelVersion } from "../../shared-kernel/behavior-model-version.ts";
import { canonical } from "../../primitives/canonical-json.ts";
import { characterCount } from "../../primitives/character-count.ts";
export type WorkResultScalar = string | number | boolean;
export type WorkResultExpression =
  | { kind: "literal"; value: WorkResultScalar }
  | {
    kind: "path";
    root: "expected" | "observed";
    path: string[];
    sourceIds?: string[];
  }
  | { kind: "unary"; op: "not"; operand: WorkResultExpression }
  | {
    kind: "binary";
    op: "and" | "or" | "implies" | "==" | "!=" | "<" | ">" | "<=" | ">=";
    left: WorkResultExpression;
    right: WorkResultExpression;
  };
export interface WorkResultType {
  typeId: string;
  schema: Record<string, unknown>;
}
export interface WorkResultContract {
  schemaVersion: "verified-effect-closure/v2";
  id: string;
  callerNativeId: string;
  workBehaviorId: string;
  observationBehaviorId: string;
  input?: WorkResultType & { sourceIds: string[] };
  valueBindings?: {
    target: "expected" | "query";
    targetField: string;
    inputField: string;
    sourceIds: string[];
  }[];
  expected: WorkResultType & { values: Record<string, unknown> };
  observed: WorkResultType;
  query?: WorkResultType & { values: Record<string, unknown> };
  condition: {
    nativeId: string;
    expression: WorkResultExpression;
    sourceIds: string[];
  };
  maxObservations: number;
  sourceIds: string[];
}
export interface WorkResultObservation {
  callerId: string;
  workInvocationId: string;
  workBehaviorId: string;
  workInputDigest: string;
  modelVersion: BehaviorModelVersion;
  available: boolean;
  reason?: string;
  source?: { id: string; revision: string };
  values?: Record<string, unknown>;
}
export type ResultVerificationStatus =
  | "pending"
  | "verified"
  | "unknown"
  | "contradicted"
  | "exhausted";
export interface WorkResultVerification {
  status: ResultVerificationStatus;
  attempts: number;
  observations: {
    at: string;
    status: ResultVerificationStatus;
    receipt?: unknown;
    error?: string;
  }[];
}
function identity(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim()) &&
    value.length <= 512;
}
/** Deliberately bounded native flat scalar schemas; unsupported schema vocabulary refuses admission. */
export function validateWorkResultValues(
  schema: Record<string, unknown>,
  values: unknown,
): boolean {
  if (!object(schema) || !object(schema.properties) || !object(values)) {
    return false;
  }
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    return false;
  }
  if (!Array.isArray(schema.required)) return false;
  const allowed = ["type", "properties", "required", "additionalProperties"];
  if (Object.keys(schema).some((key) => !allowed.includes(key))) return false;
  const properties = schema.properties;
  if (Object.keys(properties).length > 32) return false;
  for (const key of schema.required) {
    if (typeof key !== "string") return false;
    if (!Object.hasOwn(properties, key) || !Object.hasOwn(values, key)) {
      return false;
    }
  }
  // Keys outside the contract are ignored: they are no proof either way.
  for (const [name, field] of Object.entries(properties)) {
    if (!identity(name) || !object(field)) return false;
    const fieldKeys = ["type", "maxLength", "minimum", "maximum"];
    if (Object.keys(field).some((key) => !fieldKeys.includes(key))) {
      return false;
    }
    if (
      !["string", "boolean", "integer", "number"].includes(String(field.type))
    ) return false;
    if (field.maxLength !== undefined) {
      if (field.type !== "string" || !Number.isSafeInteger(field.maxLength)) {
        return false;
      }
      if ((field.maxLength as number) < 0) return false;
    }
    for (const bound of [field.minimum, field.maximum]) {
      if (bound === undefined) continue;
      if (typeof bound !== "number" || !Number.isFinite(bound)) return false;
      if (field.type !== "integer" && field.type !== "number") return false;
    }
    if (!Object.hasOwn(values, name)) continue;
    const value = values[name];
    if (field.type === "integer") {
      if (!Number.isSafeInteger(value)) return false;
    } else if (field.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
    } else if (field.type === "string") {
      if (typeof value !== "string") return false;
    } else if (typeof value !== "boolean") return false;
    if (typeof value === "string" && typeof field.maxLength === "number") {
      if (characterCount(value) > field.maxLength) return false;
    }
    if (typeof value === "number") {
      if (typeof field.minimum === "number" && value < field.minimum) {
        return false;
      }
      if (typeof field.maximum === "number" && value > field.maximum) {
        return false;
      }
    }
  }
  return true;
}
function evaluate(
  expression: WorkResultExpression,
  expected: Record<string, unknown>,
  observed: Record<string, unknown>,
  depth = 0,
  budget = { remaining: 256 },
): WorkResultScalar {
  if (!expression || depth > 32 || --budget.remaining < 0) {
    throw new Error("Invalid completion predicate");
  }
  if (expression.kind === "literal") {
    if (
      !["string", "number", "boolean"].includes(typeof expression.value) ||
      typeof expression.value === "number" && !Number.isFinite(expression.value)
    ) throw new Error("Invalid predicate literal");
    return expression.value;
  }
  if (expression.kind === "path") {
    if (
      !["expected", "observed"].includes(expression.root) ||
      !Array.isArray(expression.path) || expression.path.length !== 1 ||
      !identity(expression.path[0])
    ) throw new Error("Unsupported predicate path");
    const source = expression.root === "expected" ? expected : observed;
    if (!Object.hasOwn(source, expression.path[0]!)) {
      throw new Error("Missing predicate value");
    }
    const value = source[expression.path[0]!] as WorkResultScalar;
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new Error("Invalid predicate value");
    }
    return value;
  }
  if (expression.kind === "unary") {
    const value = evaluate(
      expression.operand,
      expected,
      observed,
      depth + 1,
      budget,
    );
    if (expression.op !== "not" || typeof value !== "boolean") {
      throw new Error("Invalid unary predicate");
    }
    return !value;
  }
  if (expression.kind !== "binary") throw new Error("Invalid predicate node");
  const left = evaluate(expression.left, expected, observed, depth + 1, budget);
  const right = evaluate(
    expression.right,
    expected,
    observed,
    depth + 1,
    budget,
  );
  switch (expression.op) {
    case "and":
    case "or":
    case "implies":
      if (typeof left !== "boolean" || typeof right !== "boolean") {
        throw new Error("Boolean predicate requires booleans");
      }
      if (expression.op === "and") return left && right;
      if (expression.op === "or") return left || right;
      return !left || right;
    case "==":
    case "!=":
      if (typeof left !== typeof right) {
        throw new Error("Predicate operands have different types");
      }
      if (expression.op === "==") return left === right;
      return left !== right;
    case "<":
    case ">":
    case "<=":
    case ">=":
      if (typeof left !== "number" || typeof right !== "number") {
        throw new Error("Ordered predicate requires numbers");
      }
      if (expression.op === "<") return left < right;
      if (expression.op === ">") return left > right;
      if (expression.op === "<=") return left <= right;
      return left >= right;
    default:
      throw new Error("Unsupported predicate operator");
  }
}
export function validateWorkResultContract(contract: WorkResultContract): void {
  validateBindingShape(contract);
  if (!contract || contract.schemaVersion !== "verified-effect-closure/v2") {
    throw new Error(
      "Legacy or unsupported work result contract version; explicit readmission required",
    );
  }
  const fields = [
    contract.id,
    contract.callerNativeId,
    contract.workBehaviorId,
    contract.observationBehaviorId,
    contract.expected?.typeId,
    contract.observed?.typeId,
    contract.condition?.nativeId,
  ];
  if (
    !fields.every(identity) ||
    !Number.isSafeInteger(contract.maxObservations) ||
    contract.maxObservations < 1 || contract.maxObservations > 8 ||
    !Array.isArray(contract.sourceIds) || !contract.sourceIds.length ||
    !contract.sourceIds.every(identity) ||
    !Array.isArray(contract.condition.sourceIds) ||
    !contract.condition.sourceIds.length ||
    !contract.condition.sourceIds.every(identity) ||
    !validateWorkResultValues(
      contract.expected.schema,
      contract.expected.values,
    )
  ) throw new Error("Invalid work result contract");
  const dummy: Record<string, unknown> = {};
  const properties = contract.observed.schema.properties;
  if (!object(properties)) throw new Error("Invalid observed type");
  for (const [name, field] of Object.entries(properties)) {
    if (!object(field)) throw new Error("Invalid observed field");
    if (field.type === "string") dummy[name] = "";
    else if (field.type === "boolean") dummy[name] = false;
    else if (typeof field.minimum === "number") dummy[name] = field.minimum;
    else if (typeof field.maximum === "number" && field.maximum < 0) {
      dummy[name] = field.maximum;
    } else dummy[name] = 0;
  }
  const predicateResult = evaluate(
    contract.condition.expression,
    contract.expected.values,
    dummy,
  );
  if (
    !validateWorkResultValues(contract.observed.schema, dummy) ||
    typeof predicateResult !== "boolean"
  ) throw new Error("Invalid completion predicate/type");
  if (
    contract.query &&
    (!identity(contract.query.typeId) ||
      !validateWorkResultValues(contract.query.schema, contract.query.values) ||
      Object.keys(contract.query.values).some((k) =>
        ["workInvocationId", "workBehaviorId", "workInputDigest"].includes(k)
      ))
  ) throw new Error("Invalid observation query");
}
export function compareWorkResult(
  contract: WorkResultContract,
  value: unknown,
  subject: Pick<
    WorkResultObservation,
    | "callerId"
    | "workInvocationId"
    | "workBehaviorId"
    | "workInputDigest"
    | "modelVersion"
  >,
): ResultVerificationStatus {
  // An invalid contract or predicate fails loudly with its reason: it is a
  // host bug, not an unproven effect.
  validateWorkResultContract(contract);
  if (!object(value)) return "unknown";
  const observation = value as unknown as WorkResultObservation;
  if (
    observation.callerId !== subject.callerId ||
    observation.workInvocationId !== subject.workInvocationId ||
    observation.workBehaviorId !== subject.workBehaviorId ||
    observation.workInputDigest !== subject.workInputDigest ||
    canonical(observation.modelVersion) !== canonical(subject.modelVersion)
  ) return "contradicted";
  if (
    observation.available !== true || !observation.source ||
    !identity(observation.source.id) ||
    !identity(observation.source.revision) ||
    // Missing or mistyped data for a contract field is never "verified";
    // keys outside the contract are ignored by the validation itself.
    !validateWorkResultValues(contract.observed.schema, observation.values)
  ) return "unknown";
  let result: WorkResultScalar;
  try {
    result = evaluate(
      contract.condition.expression,
      contract.expected.values,
      observation.values!,
    );
  } catch (error) {
    // Targeted capture: only a value absent from the observed facts is an
    // unproven effect. Every other predicate failure keeps its reason.
    if (error instanceof Error && error.message === "Missing predicate value") {
      return "unknown";
    }
    throw error;
  }
  if (typeof result !== "boolean") {
    throw new Error("Invalid completion predicate");
  }
  return result ? "verified" : "contradicted";
}

function schemaSample(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  if (!object(schema) || !object(schema.properties)) {
    throw new Error("Invalid binding schema");
  }
  const values: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!object(field)) throw new Error("Invalid binding field");
    if (field.type === "string") values[name] = "";
    else if (field.type === "boolean") values[name] = false;
    else if (typeof field.minimum === "number") values[name] = field.minimum;
    else if (typeof field.maximum === "number" && field.maximum < 0) {
      values[name] = field.maximum;
    } else values[name] = 0;
  }
  if (!validateWorkResultValues(schema, values)) {
    throw new Error("Invalid binding schema");
  }
  return values;
}
function validateBindingShape(contract: WorkResultContract): void {
  if (!contract || contract.schemaVersion !== "verified-effect-closure/v2") {
    throw new Error(
      "Legacy or unsupported work result contract version; explicit readmission required",
    );
  }
  if (contract.input) {
    if (
      !identity(contract.input.typeId) ||
      !Array.isArray(contract.input.sourceIds) ||
      !contract.input.sourceIds.length ||
      !contract.input.sourceIds.every(identity)
    ) throw new Error("Invalid native input binding type");
    schemaSample(contract.input.schema);
  }
  if (contract.valueBindings === undefined) return;
  if (
    !Array.isArray(contract.valueBindings) ||
    contract.valueBindings.length > 32 || !contract.input
  ) throw new Error("Invalid native input bindings");
  const targets = new Set<string>();
  for (const binding of contract.valueBindings) {
    if (
      !binding || !["expected", "query"].includes(binding.target) ||
      !identity(binding.targetField) || !identity(binding.inputField) ||
      !Array.isArray(binding.sourceIds) || !binding.sourceIds.length ||
      !binding.sourceIds.every(identity)
    ) throw new Error("Invalid native value binding");
    if (
      binding.target === "query" &&
      ["workInvocationId", "workBehaviorId", "workInputDigest"].includes(
        binding.targetField,
      )
    ) throw new Error("Reserved observation query binding");
    const target = contract[binding.target];
    const targetProperties = target?.schema.properties;
    const inputProperties = contract.input.schema.properties;
    if (
      !object(targetProperties) || !object(inputProperties) ||
      !Object.hasOwn(targetProperties, binding.targetField) ||
      !Object.hasOwn(inputProperties, binding.inputField)
    ) throw new Error("Missing native binding field");
    const to = targetProperties[binding.targetField];
    const from = inputProperties[binding.inputField];
    if (!object(to) || !object(from) || to.type !== from.type) {
      throw new Error("Native binding field types differ");
    }
    const key = JSON.stringify([binding.target, binding.targetField]);
    if (targets.has(key)) throw new Error("Duplicate native value binding");
    targets.add(key);
  }
}
/** Native model templates may omit exactly those fields supplied by admitted work input. */
export function validateWorkResultContractTemplate(
  template: WorkResultContract,
): void {
  validateBindingShape(template);
  const complete = structuredClone(template);
  for (const binding of template.valueBindings ?? []) {
    const target = complete[binding.target]!;
    if (Object.hasOwn(target.values, binding.targetField)) {
      throw new Error("Native binding conflicts with literal value");
    }
    target.values[binding.targetField] =
      schemaSample(target.schema)[binding.targetField];
  }
  validateWorkResultContract(complete);
}
/** No effect or observation is invoked while resolving scalar native bindings. */
export function instantiateWorkResultContract(
  template: WorkResultContract,
  admittedInput: Record<string, unknown>,
): WorkResultContract {
  validateWorkResultContractTemplate(template);
  if (
    template.input &&
    !validateWorkResultValues(template.input.schema, admittedInput)
  ) throw new Error("Work input does not satisfy native binding type");
  const resolved = structuredClone(template);
  for (const binding of resolved.valueBindings ?? []) {
    if (!Object.hasOwn(admittedInput, binding.inputField)) {
      throw new Error("Missing admitted native binding value");
    }
    resolved[binding.target]!.values[binding.targetField] =
      admittedInput[binding.inputField];
  }
  validateWorkResultContract(resolved);
  return resolved;
}
export function validateResolvedWorkResultContract(
  contract: WorkResultContract,
  admittedInput: Record<string, unknown>,
): void {
  validateWorkResultContract(contract);
  const template = structuredClone(contract);
  for (const binding of template.valueBindings ?? []) {
    delete template[binding.target]!.values[binding.targetField];
  }
  const expected = instantiateWorkResultContract(template, admittedInput);
  if (canonical(expected) !== canonical(contract)) {
    throw new Error(
      "Resolved completion contract differs from admitted work input",
    );
  }
}
