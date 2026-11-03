/** Test-only historical differential oracle. Production never imports this file.
 * Keep independent of the framework compiler to compare admitted native semantics. */
import {
  type CompiledFlow,
  evaluateGuard,
  type FlowExecutionEvent,
  type FlowExecutionOptions,
  type FlowExecutionResult,
  type FlowHandler,
  type FlowValues,
} from "../../src/domain/model/execution/flow.ts";
const unsafeNames = new Set(["__proto__", "prototype", "constructor"]);
function safePath(path: string[]): string[] {
  if (
    !path.length ||
    path.some((part) =>
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part) || unsafeNames.has(part)
    )
  ) {
    throw new Error(`Unsupported native feature path: ${path.join(".")}`);
  }
  return path;
}
function readPath(values: FlowValues, path: string[]): unknown {
  let value: unknown = values;
  for (const part of safePath(path)) {
    if (
      value === null || typeof value !== "object" || !Object.hasOwn(value, part)
    ) {
      throw new Error(`Missing native feature value: ${path.join(".")}`);
    }
    value = (value as FlowValues)[part];
  }
  if (value === undefined) {
    throw new Error(`Missing native feature value: ${path.join(".")}`);
  }
  return value;
}
function writePath(values: FlowValues, path: string[], value: unknown): void {
  safePath(path);
  let current = values;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(current, key)) current[key] = {};
    const next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(`Invalid native binding container: ${path.join(".")}`);
    }
    current = next as FlowValues;
  }
  current[path.at(-1)!] = value;
}
export async function executeFlow(
  flow: CompiledFlow,
  context: FlowValues,
  handler: FlowHandler,
  options: FlowExecutionOptions = {},
): Promise<FlowExecutionResult> {
  const maxSteps = options.maxSteps ?? flow.maxSteps;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > flow.maxSteps) {
    throw new Error("Execution step limit exceeds admitted native policy");
  }
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  let current = options.cursor?.nodeId ?? flow.startNodeId;
  if (!nodes.has(current)) {
    throw new Error(`Unknown native resume cursor: ${current}`);
  }
  const events: FlowExecutionEvent[] = [];
  async function emit(event: FlowExecutionEvent): Promise<void> {
    events.push(event);
    await options.onEvent?.(event);
  }
  function propagate(path: string[]): void {
    const pending = [path], applied = new Set<string>();
    while (pending.length) {
      const sourcePath = pending.shift()!;
      for (const binding of flow.bindings) {
        if (
          applied.has(binding.nativeId) ||
          binding.sourcePath.join(".") !== sourcePath.join(".")
        ) continue;
        writePath(
          context,
          binding.targetPath,
          readPath(context, binding.sourcePath),
        );
        applied.add(binding.nativeId);
        pending.push(binding.targetPath);
      }
    }
  }
  for (let steps = 0; steps < maxSteps; steps++) {
    const node = nodes.get(current)!;
    if (node.kind === "done") {
      await emit({
        kind: "completed",
        actionId: node.nativeId,
        nodeId: node.id,
        source: node.source,
      });
      return { status: "completed", context, events };
    }
    if (node.kind === "action") {
      const inputs: FlowValues = {};
      for (const name of node.inputs) {
        inputs[name] = readPath(context, [node.name, name]);
      }
      for (
        const assertion of node.assertions.filter((assertion) =>
          assertion.inputOnly
        )
      ) {
        if (!evaluateGuard(assertion.expression, inputs)) {
          throw new Error(
            `Native assertion failed before action: ${assertion.nativeId}`,
          );
        }
      }
      await emit({
        kind: "action",
        actionId: node.nativeId,
        nodeId: node.id,
        mechanism: node.mechanism,
        source: node.source,
      });
      const result = await handler(node, inputs, context);
      if (!result || typeof result !== "object") {
        throw new Error(`Missing primitive action result: ${node.nativeId}`);
      }
      const outputs = result.outputs ?? {};
      if (Object.keys(outputs).some((name) => !node.outputs.includes(name))) {
        throw new Error(`Undeclared native action output: ${node.nativeId}`);
      }
      if (
        !result.suspend &&
        node.outputs.some((name) =>
          !Object.hasOwn(outputs, name) || outputs[name] === undefined
        )
      ) {
        throw new Error(
          `Missing declared native action output: ${node.nativeId}`,
        );
      }
      const retainedInputs = Object.fromEntries(
        node.inputs.map((name) => [name, inputs[name]]),
      );
      const values = { ...retainedInputs, ...outputs };
      if (!result.suspend) {
        for (const assertion of node.assertions) {
          if (!evaluateGuard(assertion.expression, values)) {
            throw new Error(
              `Native assertion failed after action: ${assertion.nativeId}`,
            );
          }
        }
      }
      context[node.name] = values;
      for (const name of Object.keys(outputs)) propagate([node.name, name]);
      if (result.suspend) {
        await emit({
          kind: "suspended",
          actionId: node.nativeId,
          nodeId: node.id,
          mechanism: node.mechanism,
          source: node.source,
        });
        return {
          status: "suspended",
          cursor: { nodeId: node.id },
          context,
          events,
        };
      }
    }
    const outgoing = flow.edges.filter((edge) => edge.source === current);
    const matches = outgoing.filter((edge) =>
      edge.guard !== "else" &&
      (!edge.guard || evaluateGuard(edge.guard, context))
    );
    if (matches.length > 1) {
      throw new Error(`Multiple native guards match: ${node.nativeId}`);
    }
    const edge = matches[0] ?? outgoing.find((edge) => edge.guard === "else");
    if (!edge) {
      throw new Error(`No native control branch matches: ${node.nativeId}`);
    }
    await emit({
      kind: "edge",
      edgeId: edge.nativeId,
      nodeId: node.id,
      guardIds: edge.guardIds,
      source: edge.sourceEvidence,
    });
    current = edge.target;
  }
  throw new Error(`Native flow exceeded admitted step limit: ${maxSteps}`);
}
