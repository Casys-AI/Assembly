import { persistedOrder } from "../../primitives/persisted-order.ts";
/** Native compiled-flow semantics and source contracts; framework adapters own progression. */
export type FlowValues = Record<string, unknown>;
type Expression =
  | { kind: "literal"; value: unknown }
  | { kind: "path"; path: string[] }
  | { kind: "unary"; operand: Expression }
  | { kind: "binary"; op: string; left: Expression; right: Expression };
const unsafeNames = new Set(["__proto__", "prototype", "constructor"]);
export function safePath(path: string[]): string[] {
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
export function readPath(values: FlowValues, path: string[]): unknown {
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
function parseExpression(source: string): Expression {
  const tokens: string[] = [];
  const pattern =
    /\s*(==|!=|<=|>=|[<>()]|\band\b|\bor\b|\bnot\b|\bimplies\b|true\b|false\b|-?(?:\d+(?:\.\d+)?)(?:[eE][+-]?\d+)?|"(?:[^"\\]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|'(?:[^'\\]|\\['\\])*'|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)/y;
  let offset = 0;
  while (offset < source.length) {
    if (!source.slice(offset).trim()) break;
    pattern.lastIndex = offset;
    const match = pattern.exec(source);
    if (!match) {
      throw new Error(`Unsupported native guard near: ${source.slice(offset)}`);
    }
    tokens.push(match[1]);
    offset = pattern.lastIndex;
  }
  let index = 0;
  const precedence: Record<string, number> = {
    implies: 1,
    or: 2,
    and: 3,
    "==": 4,
    "!=": 4,
    "<": 4,
    "<=": 4,
    ">": 4,
    ">=": 4,
  };
  function atom(): Expression {
    const token = tokens[index++];
    if (!token) throw new Error("Incomplete native guard");
    if (token === "not") return { kind: "unary", operand: atom() };
    if (token === "(") {
      const expression = parse(1);
      if (tokens[index++] !== ")") throw new Error("Unbalanced native guard");
      return expression;
    }
    if (token === "true" || token === "false") {
      return { kind: "literal", value: token === "true" };
    }
    if (/^-?\d/.test(token)) {
      const value = Number(token);
      if (!Number.isFinite(value)) {
        throw new Error("Non-finite native numeric literal");
      }
      return { kind: "literal", value };
    }
    if (token.startsWith('"')) {
      return { kind: "literal", value: JSON.parse(token) };
    }
    if (token.startsWith("'")) {
      return {
        kind: "literal",
        value: token.slice(1, -1).replace(/\\(['\\])/g, "$1"),
      };
    }
    if (
      /^[A-Za-z_]/.test(token) && !Object.hasOwn(precedence, token) &&
      token !== "else"
    ) {
      return { kind: "path", path: safePath(token.split(".")) };
    }
    throw new Error(`Unsupported native guard token: ${token}`);
  }
  function parse(minimum: number): Expression {
    let left = atom();
    while ((precedence[tokens[index]] ?? 0) >= minimum) {
      const op = tokens[index++];
      const right = parse(precedence[op] + (op === "implies" ? 0 : 1));
      left = { kind: "binary", op, left, right };
    }
    return left;
  }
  const expression = parse(1);
  if (index !== tokens.length) {
    throw new Error(`Unsupported native guard token: ${tokens[index]}`);
  }
  return expression;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new Error("Native guard must evaluate to a boolean");
  }
  return value;
}
function evaluate(expression: Expression, values: FlowValues): unknown {
  if (expression.kind === "literal") return expression.value;
  if (expression.kind === "path") return readPath(values, expression.path);
  if (expression.kind === "unary") {
    return !boolean(evaluate(expression.operand, values));
  }
  // Evaluate both operands: a missing native value is never treated as a false branch.
  const left = evaluate(expression.left, values),
    right = evaluate(expression.right, values);
  if (["and", "or", "implies"].includes(expression.op)) {
    const leftBoolean = boolean(left), rightBoolean = boolean(right);
    if (expression.op === "and") return leftBoolean && rightBoolean;
    if (expression.op === "or") return leftBoolean || rightBoolean;
    return !leftBoolean || rightBoolean;
  }
  if (
    (typeof left !== "string" && typeof left !== "number" &&
      typeof left !== "boolean") || typeof left !== typeof right
  ) {
    throw new Error("Native guard compares incompatible values");
  }
  if (expression.op === "==") return left === right;
  if (expression.op === "!=") return left !== right;
  if (typeof left !== "number" && typeof left !== "string") {
    throw new Error("Native ordered comparison requires numbers or strings");
  }
  const comparable = right as string | number;
  if (expression.op === "<") return left < comparable;
  if (expression.op === "<=") return left <= comparable;
  if (expression.op === ">") return left > comparable;
  if (expression.op === ">=") return left >= comparable;
  throw new Error(`Unsupported native operator: ${expression.op}`);
}
export function evaluateGuard(source: string, values: FlowValues): boolean {
  if (source.trim() === "else") {
    throw new Error("else requires the complete native decision branch set");
  }
  return boolean(evaluate(parseExpression(source), values));
}

export const IMPLEMENTATION = {
  ReadCaseState: "read_case",
  ChooseNextMove: "choose_move",
  ReplyOrClarify: "reply",
  AwaitCaseInput: "await_input",
  CheckRequestedAction: "check_invocation",
  ExecuteRequestedAction: "invoke_tool",
  RecordActionRefusal: "report_refusal",
  SubmitChangeProposal: "submit_proposal",
  ObserveOutcomeAndUpdateCase: "observe_outcome",
  ProposeCandidate: "propose_candidate",
  TestCandidate: "test_candidate",
  ReviewCandidate: "review_candidate",
  ConfiguredAdmission: "decide_admission",
  ReviewedConfiguredAdmission: "decide_admission",
  ActivateCandidate: "activate_candidate",
  RefuseCandidate: "refuse_candidate",
} as const;
/** A mechanism is selected from the host's explicit registry during compilation. */
export type FlowMechanism = string;
export interface FlowSource {
  file: string;
  line: string | number;
  quote?: string;
  native?: boolean;
}
export interface FlowProjectionNode {
  id: string;
  nativeId?: string;
  metaclass?: string;
  label: string;
  symbol?: string;
  parentId?: string | null;
  source?: FlowSource;
  declaredDirection?: string;
  dimension?: string;
  category?: string;
  expression?: string;
  expressionSourceIds?: string[];
}
export interface FlowProjectionEdge {
  id: string;
  source: string;
  target: string;
  kind: string;
  nativeId?: string;
  metaclass?: string;
  guard?: string;
  guardIds?: string[];
  event?: string;
  sourceEvidence?: FlowSource;
  sourceFeaturePath?: string[];
  targetFeaturePath?: string[];
}
export interface FlowProjection {
  nodes: readonly FlowProjectionNode[];
  edges: readonly FlowProjectionEdge[];
}
export interface CompiledFlowAssertion {
  nativeId: string;
  name: string;
  expression: string;
  expressionSourceIds: string[];
  inputOnly: boolean;
  source: FlowSource;
}
export interface CompiledFlowNode {
  id: string;
  nativeId: string;
  name: string;
  kind: "action" | "decision" | "merge" | "start" | "done";
  mechanism?: FlowMechanism;
  typeNativeId?: string;
  performerId?: string;
  allocationId?: string;
  /** Exact source-declared bounded read; presence never grants read access. */
  consultationRequest?: string;
  /** Acceptance is implemented by the registered await_input suspension primitive. */
  acceptActionId?: string;
  assertions: CompiledFlowAssertion[];
  source: FlowSource;
  inputs: string[];
  outputs: string[];
}
export interface CompiledFlowEdge {
  id: string;
  nativeId: string;
  source: string;
  target: string;
  guard?: string;
  guardIds: string[];
  sourceEvidence: FlowSource;
}
export interface CompiledFlowBinding {
  nativeId: string;
  sourceFeaturePath: string[];
  targetFeaturePath: string[];
  sourcePath: string[];
  targetPath: string[];
  sourceEvidence: FlowSource;
}
export type OperatorExecutionProfile =
  | "operator-command-v1"
  | "operator-command-immutable-group-v1";

export interface CompiledFlow {
  /** Absent on historical flows, which retain their original dispatch behavior. */
  executionProfile?: OperatorExecutionProfile;
  rootNativeId: string;
  rootOccurrenceId: string;
  name: string;
  source: FlowSource;
  startNodeId: string;
  maxSteps: number;
  nodes: CompiledFlowNode[];
  edges: CompiledFlowEdge[];
  bindings: CompiledFlowBinding[];
}
function evidence(value: FlowSource | undefined, id: string): FlowSource {
  if (!value?.file || value.line === undefined || value.line === "") {
    throw new Error(`Missing native source evidence: ${id}`);
  }
  return { ...value };
}
function nativeId(value: { nativeId?: string; id: string }): string {
  if (!value.nativeId) throw new Error(`Missing native identity: ${value.id}`);
  return value.nativeId;
}
function expressionPaths(expression: Expression): string[][] {
  if (expression.kind === "path") return [expression.path];
  if (expression.kind === "unary") return expressionPaths(expression.operand);
  if (expression.kind === "binary") {
    return [
      ...expressionPaths(expression.left),
      ...expressionPaths(expression.right),
    ];
  }
  return [];
}
export function guardPaths(source: string): string[][] {
  return expressionPaths(parseExpression(source));
}
export function compileModelFlow(
  graph: FlowProjection,
  options: {
    rootNativeId: string;
    maxSteps?: number;
    /** A closed registry keyed by exact qualified SysML ActionDefinition symbols.
     * When present it replaces, rather than extends, the legacy default map. */
    implementations?: Readonly<Record<string, string>>;
  },
): CompiledFlow {
  let implementations: Readonly<Record<string, string>> = IMPLEMENTATION;
  const qualifiedImplementations = options.implementations !== undefined;
  if (qualifiedImplementations) {
    const registry = options.implementations;
    if (
      !registry || typeof registry !== "object" || Array.isArray(registry) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(registry))
    ) throw new Error("Invalid native implementation registry");
    const entries = Object.entries(registry);
    if (!entries.length) {
      throw new Error("Invalid native implementation registry");
    }
    for (const [symbol, mechanism] of entries) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/.test(symbol) ||
        symbol.split("::").some((part) => unsafeNames.has(part)) ||
        typeof mechanism !== "string" || !/^[a-z][a-z0-9_]*$/.test(mechanism) ||
        unsafeNames.has(mechanism)
      ) throw new Error(`Invalid native implementation entry: ${symbol}`);
    }
    // Own copied entries prevent a caller from changing the registry while the
    // compiler reads it. Multiple types may explicitly share a mechanism.
    implementations = Object.freeze(
      Object.fromEntries(entries),
    );
  }
  const roots = graph.nodes.filter((node) =>
    node.nativeId === options.rootNativeId
  );
  if (roots.length !== 1 || roots[0].metaclass !== "PerformActionUsage") {
    throw new Error(
      `Expected one concrete native performed action: ${options.rootNativeId}`,
    );
  }
  const root = roots[0],
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const children = graph.nodes.filter((node) => node.parentId === root.id);
  const owned = new Set<string>([root.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of graph.nodes) {
      if (node.parentId && owned.has(node.parentId) && !owned.has(node.id)) {
        owned.add(node.id);
        changed = true;
      }
    }
  }
  function descendsFrom(node: FlowProjectionNode, ancestorId: string): boolean {
    let parent = node.parentId;
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      if (parent === ancestorId) return true;
      visited.add(parent);
      parent = byId.get(parent)?.parentId;
    }
    return false;
  }
  const nodes: CompiledFlowNode[] = [];
  for (const node of children) {
    const metaclass = node.metaclass;
    if (metaclass === "AssertConstraintUsage") {
      throw new Error(
        `Unsupported composite native assertion: ${nativeId(node)}`,
      );
    }
    if (metaclass === "ForkNode" || metaclass === "JoinNode") {
      throw new Error(`Unsupported native concurrency: ${nativeId(node)}`);
    }
    let kind: CompiledFlowNode["kind"],
      mechanism: FlowMechanism | undefined,
      typeNativeId: string | undefined;
    if (node.symbol === "Actions::Action::start") kind = "start";
    else if (node.symbol === "Actions::Action::done") kind = "done";
    else if (metaclass === "DecisionNode") kind = "decision";
    else if (metaclass === "MergeNode") kind = "merge";
    else if (metaclass === "ActionUsage") {
      const types = graph.edges.filter((edge) =>
        edge.kind === "typing" && edge.source === node.id
      )
        .map((edge) => byId.get(edge.target)).filter((value) =>
          value?.metaclass === "ActionDefinition"
        );
      if (types.length !== 1) {
        throw new Error(
          `Ambiguous or missing native executable type: ${nativeId(node)}`,
        );
      }
      const type = types[0]!;
      const typeName = qualifiedImplementations
        ? type.symbol
        : type.symbol?.split("::").at(-1);
      if (!typeName || !Object.hasOwn(implementations, typeName)) {
        throw new Error(
          `Unsupported native executable type: ${type.symbol ?? type.nativeId}`,
        );
      }
      mechanism = implementations[typeName];
      typeNativeId = nativeId(type);
      kind = "action";
    } else if (
      metaclass?.includes("Action") || node.category === "control" ||
      node.dimension === "behavior"
    ) {
      throw new Error(
        `Unsupported native executable element: ${metaclass} ${nativeId(node)}`,
      );
    } else continue;
    safePath([node.label]);
    const features = graph.nodes.filter((feature) =>
      feature.parentId === node.id
    ).sort((a, b) =>
      persistedOrder(nativeId(a), nativeId(b)) || persistedOrder(a.id, b.id)
    );
    const inputs = features.filter((feature) =>
      feature.declaredDirection === "in"
    ).map((feature) => feature.label);
    const outputs = features.filter((feature) =>
      feature.declaredDirection === "out"
    ).map((feature) => feature.label);
    const assertions: CompiledFlowAssertion[] = [];
    const type = graph.nodes.find((candidate) =>
      candidate.metaclass === "ActionDefinition" &&
      candidate.nativeId === typeNativeId
    );
    const descendants = graph.nodes.filter((candidate) =>
      descendsFrom(candidate, node.id) ||
      !!type && descendsFrom(candidate, type.id)
    );
    let acceptActionId: string | undefined;
    for (const descendant of descendants) {
      if (descendant.metaclass === "AssertConstraintUsage") continue;
      const executable = descendant.metaclass?.includes("Action") ||
        descendant.metaclass?.endsWith("Node") ||
        descendant.metaclass?.includes("Constraint") ||
        descendant.category === "control" ||
        descendant.dimension === "behavior";
      if (!executable) continue;
      if (
        kind === "action" && mechanism === "await_input" &&
        descendant.metaclass === "AcceptActionUsage" &&
        (descendant.parentId === node.id || descendant.parentId === type?.id)
      ) {
        const id = nativeId(descendant);
        if (acceptActionId && acceptActionId !== id) {
          throw new Error(
            `Ambiguous native input acceptance: ${node.nativeId}`,
          );
        }
        acceptActionId = id;
      } else {throw new Error(
          `Unsupported nested native executable element: ${descendant.metaclass} ${
            nativeId(descendant)
          }`,
        );}
    }
    for (
      const assertion of graph.nodes.filter((candidate) =>
        candidate.metaclass === "AssertConstraintUsage" &&
        (descendsFrom(candidate, node.id) ||
          !!type && descendsFrom(candidate, type.id))
      )
    ) {
      if (kind !== "action") {
        throw new Error(
          `Unsupported native assertion placement: ${nativeId(assertion)}`,
        );
      }
      const existingAssertion = assertions.find((compiled) =>
        compiled.nativeId === assertion.nativeId
      );
      if (existingAssertion) {
        if (existingAssertion.expression !== assertion.expression?.trim()) {
          throw new Error(
            `Conflicting native assertion projection: ${nativeId(assertion)}`,
          );
        }
        continue;
      }
      if (!assertion.expression?.trim()) {
        throw new Error(
          `Missing native assertion expression: ${nativeId(assertion)}`,
        );
      }
      const expression = parseExpression(assertion.expression);
      const paths = expressionPaths(expression);
      for (const path of paths) {
        if (!inputs.includes(path[0]) && !outputs.includes(path[0])) {
          throw new Error(
            `Unknown native assertion feature: ${path.join(".")}`,
          );
        }
      }
      assertions.push({
        nativeId: nativeId(assertion),
        name: assertion.label,
        expression: assertion.expression.trim(),
        expressionSourceIds: [...(assertion.expressionSourceIds ?? [])].sort(),
        inputOnly: paths.every((path) => inputs.includes(path[0])),
        source: evidence(assertion.source, assertion.id),
      });
    }
    nodes.push({
      id: node.id,
      nativeId: nativeId(node),
      name: node.label,
      kind,
      mechanism,
      typeNativeId,
      ...(acceptActionId ? { acceptActionId } : {}),
      source: evidence(node.source, node.id),
      inputs,
      outputs,
      assertions: assertions.sort((a, b) =>
        persistedOrder(a.nativeId, b.nativeId)
      ),
    });
  }
  const ids = new Set(nodes.map((node) => node.id));
  const names = new Set<string>();
  for (const node of nodes) {
    if (names.has(node.name)) {
      throw new Error(`Ambiguous native action name: ${node.name}`);
    }
    names.add(node.name);
  }
  const edges: CompiledFlowEdge[] = [];
  for (
    const edge of graph.edges.filter((edge) =>
      edge.kind === "succession" &&
      (ids.has(edge.source) || ids.has(edge.target))
    )
  ) {
    if (!ids.has(edge.source) || !ids.has(edge.target)) {
      throw new Error(`Native control edge leaves selected flow: ${edge.id}`);
    }
    if (
      edge.metaclass !== "SuccessionAsUsage" &&
      edge.metaclass !== "TransitionUsage"
    ) throw new Error(`Unsupported native control relation: ${edge.id}`);
    if (edge.event) {
      throw new Error(
        `Unsupported native event-triggered transition: ${edge.id}`,
      );
    }
    const guard = edge.guard?.trim();
    if (guard && guard !== "else") {
      const expression = parseExpression(guard);
      for (const path of expressionPaths(expression)) {
        const action = nodes.find((node) => node.name === path[0]);
        if (!action || !action.outputs.includes(path[1])) {
          throw new Error(`Unknown native guard feature: ${path.join(".")}`);
        }
      }
      if (!edge.guardIds?.length) {
        throw new Error(`Missing native guard identity: ${edge.id}`);
      }
    }
    edges.push({
      id: edge.id,
      nativeId: nativeId(edge),
      source: edge.source,
      target: edge.target,
      ...(guard ? { guard } : {}),
      guardIds: [...(edge.guardIds ?? [])].sort(),
      sourceEvidence: evidence(edge.sourceEvidence, edge.id),
    });
  }
  const starts = nodes.filter((node) => node.kind === "start");
  if (starts.length !== 1) {
    throw new Error("Expected exactly one native start action");
  }
  const edgeIds = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.nativeId)) {
      throw new Error(`Duplicate native control relation: ${edge.nativeId}`);
    }
    edgeIds.add(edge.nativeId);
  }
  for (const node of nodes) {
    const outgoing = edges.filter((edge) => edge.source === node.id);
    if (node.kind === "done") {
      if (outgoing.length) throw new Error("Native done has outgoing control");
      continue;
    }
    if (!outgoing.length) {
      throw new Error(`Missing native outgoing control: ${node.nativeId}`);
    }
    if (
      node.kind !== "decision" && (outgoing.length !== 1 || outgoing[0].guard)
    ) throw new Error(`Ambiguous native control: ${node.nativeId}`);
    if (
      node.kind === "decision" &&
      (outgoing.length < 2 || outgoing.some((edge) => !edge.guard) ||
        outgoing.filter((edge) => edge.guard === "else").length > 1)
    ) {
      throw new Error(
        `Incomplete or ambiguous native decision: ${node.nativeId}`,
      );
    }
  }
  const reachable = new Set([starts[0].id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const edge of edges) {
      if (reachable.has(edge.source) && !reachable.has(edge.target)) {
        reachable.add(edge.target);
        changed = true;
      }
    }
  }
  if (nodes.some((node) => !reachable.has(node.id))) {
    throw new Error("Unreachable native executable element");
  }
  function featurePath(node: FlowProjectionNode): string[] {
    const path: string[] = [];
    let current: FlowProjectionNode | undefined = node;
    while (current && current.id !== root.id) {
      path.unshift(current.label);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (!current) {
      throw new Error(`Native binding leaves selected occurrence: ${node.id}`);
    }
    return safePath(path);
  }
  function bindingIdentityPath(
    node: FlowProjectionNode,
    chain: string[] | undefined,
  ): string[] {
    if (!chain?.length) {
      throw new Error(`Missing native binding feature path: ${node.id}`);
    }
    const ancestry: string[] = [];
    let current: FlowProjectionNode | undefined = node;
    while (current) {
      ancestry.unshift(nativeId(current));
      if (current.id === root.id) break;
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    if (
      chain.length > ancestry.length ||
      chain.some((id, index) =>
        id !== ancestry[ancestry.length - chain.length + index]
      )
    ) {
      throw new Error(
        `Native binding feature path disagrees with endpoint: ${node.id}`,
      );
    }
    return [...chain];
  }
  const bindings: CompiledFlowBinding[] = [];
  for (
    const edge of graph.edges.filter((edge) =>
      edge.kind === "binding" && owned.has(edge.source) &&
      owned.has(edge.target)
    )
  ) {
    const a = byId.get(edge.source)!, b = byId.get(edge.target)!;
    let source: FlowProjectionNode, target: FlowProjectionNode;
    if (a.declaredDirection === "out" && b.declaredDirection !== "out") {
      [source, target] = [a, b];
    } else if (b.declaredDirection === "out" && a.declaredDirection !== "out") {
      [source, target] = [b, a];
    } else if (a.declaredDirection === "in" && b.declaredDirection !== "in") {
      [source, target] = [b, a];
    } else if (b.declaredDirection === "in" && a.declaredDirection !== "in") {
      [source, target] = [a, b];
    } else throw new Error(`Unsupported native binding direction: ${edge.id}`);
    const sourceNativePath = bindingIdentityPath(
      source,
      source === a ? edge.sourceFeaturePath : edge.targetFeaturePath,
    );
    const targetNativePath = bindingIdentityPath(
      target,
      target === b ? edge.targetFeaturePath : edge.sourceFeaturePath,
    );
    if (
      target.declaredDirection === "in" &&
      bindings.some((binding) =>
        binding.targetPath.join(".") === featurePath(target).join(".")
      )
    ) {
      throw new Error(`Ambiguous native input binding: ${target.id}`);
    }
    bindings.push({
      nativeId: nativeId(edge),
      sourceFeaturePath: sourceNativePath,
      targetFeaturePath: targetNativePath,
      sourcePath: featurePath(source),
      targetPath: featurePath(target),
      sourceEvidence: evidence(edge.sourceEvidence, edge.id),
    });
  }
  const maxSteps = options.maxSteps ?? 256;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10000) {
    throw new Error("Invalid bounded native flow step policy");
  }
  return {
    rootNativeId: nativeId(root),
    rootOccurrenceId: root.id,
    name: root.label,
    source: evidence(root.source, root.id),
    startNodeId: starts[0].id,
    maxSteps,
    nodes: nodes.sort((a, b) =>
      persistedOrder(a.nativeId, b.nativeId) || persistedOrder(a.id, b.id)
    ),
    edges: edges.sort((a, b) =>
      persistedOrder(a.nativeId, b.nativeId) || persistedOrder(a.id, b.id)
    ),
    bindings: bindings.sort((a, b) => persistedOrder(a.nativeId, b.nativeId)),
  };
}

export interface FlowCursor {
  nodeId: string;
}
export interface FlowExecutionEvent {
  kind: "action" | "edge" | "suspended" | "completed";
  actionId?: string;
  edgeId?: string;
  nodeId?: string;
  mechanism?: FlowMechanism;
  guardIds?: string[];
  source: FlowSource;
}
export interface FlowActionResult {
  outputs?: FlowValues;
  suspend?: boolean;
}
export type FlowHandler = (
  action: CompiledFlowNode,
  inputs: FlowValues,
  context: FlowValues,
) => FlowActionResult | Promise<FlowActionResult>;
export interface FlowExecutionOptions {
  cursor?: FlowCursor;
  maxSteps?: number;
  onEvent?: (event: FlowExecutionEvent) => void | Promise<void>;
}
export interface FlowExecutionResult {
  status: "completed" | "suspended";
  context: FlowValues;
  events: FlowExecutionEvent[];
  cursor?: FlowCursor;
}
