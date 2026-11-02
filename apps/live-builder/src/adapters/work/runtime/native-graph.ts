import { persistedOrder } from "../../../domain/primitives/persisted-order.ts";
import {
  assertImmutableGroupShape,
  immutableReceiptKey,
  type ImmutableReceiptUpdate,
  mergeImmutableReceipts,
} from "../../../application/work/conversation/immutable-consultation-group.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import type {
  NativeWaitConsumptionEvidence,
  NativeWaitEvidence,
} from "./checkpoint-wait-evidence.ts";
import {
  nativeObservationBatchDigest,
  type NativeObservationEmission,
  type NativeObservationPhase,
} from "./native-observation.ts";
/** Admitted native flow compilation to LangGraph.
 * LangGraph alone schedules transitions and owns suspension/checkpoints.
 * Host handlers still own current authority, bounded choices and effect receipts.
 */
import {
  Annotation,
  type BaseCheckpointSaver,
  type BaseStore,
  END,
  interrupt,
  type LangGraphRunnableConfig,
  type Messages,
  messagesStateReducer,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type {
  ExecutableModel,
  ExecutableModelVersion,
} from "../../../domain/model/execution/executable-model.ts";
import {
  type CompiledFlow,
  type CompiledFlowNode,
  evaluateGuard,
  type FlowActionResult,
  type FlowExecutionEvent,
  type FlowSource,
  type FlowValues,
  guardPaths,
  type OperatorExecutionProfile,
  readPath,
  safePath,
} from "../../../domain/model/execution/flow.ts";

import type {
  ImmutableConsultationGroupManifest,
  ImmutableConsultationGroupMember,
  ImmutableConsultationMemberOutcome,
  NativeChangeApprovalWait,
  NativeExecutionScope,
  NativeModelAdvanceEvidence,
} from "../../../application/work/runtime/execution.ts";

interface PreparedNativeAction {
  nodeId: string;
  inputs: FlowValues;
  result: NativeActionResult;
  step: number;
  segmentStep: number;
  effectKey: string;
}

export interface NativeModelPin {
  identity: ExecutableModel["identity"];
  version: ExecutableModelVersion;
  rootNativeId: string;
  rootOccurrenceId: string;
  executionProfile?: OperatorExecutionProfile;
}

export interface NativeTrace extends FlowExecutionEvent {
  step: number;
  immutableGroupId?: string;
  immutableCallId?: string;
  operatorId: string;
  rootRequestId?: string;
  performerId?: string;
  allocationId?: string;
  acceptActionId?: string;
  modelDigest: string;
  modelSourceIds: string[];
  repositoryVersion?: string;
}

/** Technical checkpoints retain all historical messages and business evidence.
 * operatorData is handler-owned JSON state, not model authority. The `trace`
 * channel stays readable for historical checkpoints; journaled executions
 * (R4b) record observations durably per run and add nothing to it, so an
 * inherited historical array is retained unchanged, never trimmed. */
const NativeOperatorState = Annotation.Root({
  values: Annotation<FlowValues>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  trace: Annotation<NativeTrace[]>({
    reducer: (previous, next) => previous.concat(next),
    default: () => [],
  }),
  messages: Annotation<BaseMessage[], Messages>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  journal: Annotation<FlowValues[]>({
    reducer: (previous, next) => previous.concat(next),
    default: () => [],
  }),
  operatorData: Annotation<FlowValues>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  /** Official Deep Agents async tools return a task-id keyed merge patch. */
  asyncTasks: Annotation<Record<string, FlowValues>>({
    reducer: (previous, next) => ({ ...previous, ...next }),
    default: () => ({}),
  }),
  steps: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  segmentSteps: Annotation<number>({
    reducer: (_previous, next) => next,
    default: () => 0,
  }),
  acceptedContributionIds: Annotation<string[]>({
    reducer: (previous, next) => previous.concat(next),
    default: () => [],
  }),
  /** One checkpoint-commit candidate, replaced on the next consumption. The
   * immutable ledger retains history; this technical channel is not a journal. */
  waitConsumptions: Annotation<NativeWaitConsumptionEvidence[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  modelPin: Annotation<NativeModelPin>(),
  rootRequestId: Annotation<string | undefined>(),
  executionScope: Annotation<NativeExecutionScope>(),
  resumeAction: Annotation<
    { nodeId: string; contributionId: string } | undefined
  >({ reducer: (_previous, next) => next, default: () => undefined }),
  continuationRef: Annotation<string | undefined>({
    reducer: (_previous, next) => next,
    default: () => undefined,
  }),
  prepared: Annotation<PreparedNativeAction | undefined>({
    reducer: (_previous, next) => next,
    default: () => undefined,
  }),
  immutableGroup: Annotation<
    { manifest: ImmutableConsultationGroupManifest; nodeId: string } | undefined
  >({
    reducer: (_previous, next) => next,
    default: () => undefined,
  }),
  immutableOutcomes: Annotation<
    Record<string, ImmutableConsultationMemberOutcome>,
    ImmutableReceiptUpdate
  >({
    reducer: mergeImmutableReceipts,
    default: () => ({}),
  }),
  operatorId: Annotation<string>(),
  nextNode: Annotation<string>(),
});

export type NativeState = typeof NativeOperatorState.State;

/** Projection of the official prepared wait, never an effect admission proof.
 * The ledger separately verifies the exact tuple and settled/absent effect. */
export function nativeBudgetContinuationSource(
  state: Partial<NativeState>,
  waits: readonly { nodeId: string; mechanism?: string; kind: string }[],
) {
  if (
    waits.length !== 1 || !state.prepared ||
    state.prepared.nodeId !== waits[0].nodeId ||
    !state.prepared.effectKey || !state.prepared.result.suspend ||
    state.prepared.result.modelAdvance
  ) return undefined;
  const sourceKind = waits[0].kind === "budget" &&
      state.prepared.result.suspensionKind === "budget"
    ? "settled-budget-wait" as const
    : waits[0].kind === "input" && waits[0].mechanism === "await_input" &&
        state.prepared.result.suspensionKind === undefined
    ? "unconsumed-input-wait" as const
    : undefined;
  return sourceKind
    ? {
      sourceKind,
      occurrenceId: state.prepared.nodeId,
      preparedNodeId: nativeFrameworkNodeName(
        state.prepared.nodeId,
        "await-preparation",
      ),
      settledEffectKey: state.prepared.effectKey,
    }
    : undefined;
}
interface NativeInvocation {
  state: Readonly<NativeState>;
  config: LangGraphRunnableConfig;
  /** Only set after a real framework interrupt has accepted a resume value. */
  resume?: unknown;
  step: number;
  segmentStep: number;
  /** Stable across checkpoint replay. A durable host receipt is still required. */
  effectKey: string;
}
interface NativeResume extends FlowValues {
  /** Authenticated host delivery receipt; reuse never opens a fresh segment. */
  contributionId: string;
}
export interface NativeActionResult extends FlowActionResult {
  suspensionKind?: "budget" | "decision" | "contribution";
  modelAdvance?: NativeModelAdvanceEvidence;
  messages?: Messages;
  journal?: FlowValues[];
  operatorData?: FlowValues;
  asyncTasks?: Record<string, FlowValues>;
}
type NativeFlowHandler = (
  action: CompiledFlowNode,
  inputs: FlowValues,
  context: FlowValues,
  invocation: NativeInvocation,
) => NativeActionResult | Promise<NativeActionResult>;

interface NativeGraphOptions {
  immutableConsultations?: {
    plan(
      node: CompiledFlowNode,
      inputs: FlowValues,
      values: FlowValues,
      invocation: NativeInvocation,
    ): Promise<ImmutableConsultationGroupManifest | undefined>;
    register(
      manifest: ImmutableConsultationGroupManifest,
    ): Promise<ImmutableConsultationGroupManifest>;
    member(
      manifest: ImmutableConsultationGroupManifest,
      member: ImmutableConsultationGroupMember,
      node: CompiledFlowNode,
    ): Promise<ImmutableConsultationMemberOutcome>;
    join(
      manifest: ImmutableConsultationGroupManifest,
      outcomes: ImmutableConsultationMemberOutcome[],
    ): Promise<NativeActionResult>;
  };
  effectNamespace?: string;
  assertTechnicalBoundary?: () => Promise<void>;
  scope?: NativeExecutionScope;
  flow?: CompiledFlow;
  onEvent?: (event: NativeTrace) => void | Promise<void>;
  /** Durable journal mode (R4b): each emission is awaited at deterministic
   * producer coordinates and no new `trace` additions enter checkpoints.
   * State-only fork/verification graphs omit it and never execute nodes. */
  onObservation?: (
    emission: NativeObservationEmission,
  ) => void | Promise<void>;
  shouldAwait?: (
    state: Readonly<NativeState>,
    node: CompiledFlowNode,
  ) => boolean | Promise<boolean>;
  resolveValues?: (values: FlowValues) => Promise<FlowValues>;
  rootRequestId?: string;
  /** Native operator identity, never a provider-generated role or thread name. */
  operatorId?: string;
  checkpointer?: BaseCheckpointSaver | boolean;
  store?: BaseStore;
  name?: string;
  maxSteps?: number;
  /** Recheck current membership/authority at every native node and resume.
   * The caller must supply authenticated host facts; framework input is not proof.
   */
  assertBoundary: (
    state: Readonly<NativeState>,
    node: Readonly<CompiledFlowNode>,
    config: LangGraphRunnableConfig,
  ) => void | Promise<void>;
}

/** Injective scheduling names; canonical occurrence IDs remain model evidence. */
export function nativeFrameworkNodeName(
  nativeNodeId: string,
  phase: "node" | "await-preparation" = "node",
): string {
  return `${phase === "node" ? "native_" : "native_wait_"}${
    encodeURIComponent(nativeNodeId)
  }`;
}
// Binding operations consume only admitted paths; structural nodes are compiled
// to real framework edges rather than executed by a second walker.
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
function propagate(
  flow: CompiledFlow,
  values: FlowValues,
  path: string[],
): void {
  const pending = [path], applied = new Set<string>();
  while (pending.length) {
    const sourcePath = pending.shift()!;
    for (const binding of flow.bindings) {
      if (
        applied.has(binding.nativeId) ||
        binding.sourcePath.join(".") !== sourcePath.join(".")
      ) continue;
      writePath(
        values,
        binding.targetPath,
        readPath(values, binding.sourcePath),
      );
      applied.add(binding.nativeId);
      pending.push(binding.targetPath);
    }
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value).sort(([a], [b]) => persistedOrder(a, b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(
          ",",
        )
    }}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
function source(value: FlowSource, id: string): void {
  if (!value?.file || value.line === undefined || value.line === "") {
    throw new Error(`Missing native source evidence: ${id}`);
  }
}
function validate(flow: CompiledFlow): void {
  if (
    flow.executionProfile !== undefined &&
    flow.executionProfile !== "operator-command-v1" &&
    flow.executionProfile !== "operator-command-immutable-group-v1"
  ) {
    throw new Error("Unsupported admitted native execution profile");
  }
  source(flow.source, flow.rootNativeId);
  if (
    !flow.rootNativeId || !flow.rootOccurrenceId ||
    !Number.isSafeInteger(flow.maxSteps) || flow.maxSteps < 1 ||
    flow.maxSteps > 10000
  ) {
    throw new Error("Invalid native flow identity/step policy");
  }
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  if (
    nodes.size !== flow.nodes.length ||
    nodes.get(flow.startNodeId)?.kind !== "start"
  ) {
    throw new Error("Invalid native nodes/start");
  }
  const names = new Set<string>(), edgeIds = new Set<string>();
  for (const node of flow.nodes) {
    if (
      !node.id || !node.nativeId || names.has(node.name)
    ) {
      throw new Error(`Invalid native node identity: ${node.id}`);
    }
    safePath([node.name]);
    names.add(node.name);
    source(node.source, node.nativeId);
    if (!["action", "start", "done", "decision", "merge"].includes(node.kind)) {
      throw new Error(`Unsupported native node kind: ${node.id}`);
    }
    for (const name of [...node.inputs, ...node.outputs]) safePath([name]);
    if (node.kind === "action" && !node.mechanism) {
      throw new Error(`Missing native primitive: ${node.nativeId}`);
    }
    if (node.acceptActionId && node.mechanism !== "await_input") {
      throw new Error(`Accept action requires await_input: ${node.nativeId}`);
    }
    for (const assertion of node.assertions) {
      source(assertion.source, assertion.nativeId);
    }
  }
  for (const edge of flow.edges) {
    if (
      !edge.nativeId || edgeIds.has(edge.nativeId) ||
      !nodes.has(edge.source) || !nodes.has(edge.target)
    ) {
      throw new Error(`Invalid native edge: ${edge.nativeId}`);
    }
    edgeIds.add(edge.nativeId);
    source(edge.sourceEvidence, edge.nativeId);
  }
  const bindingIds = new Set<string>();
  for (const binding of flow.bindings) {
    if (!binding.nativeId || bindingIds.has(binding.nativeId)) {
      throw new Error(`Invalid native binding: ${binding.nativeId}`);
    }
    bindingIds.add(binding.nativeId);
    safePath(binding.sourcePath);
    safePath(binding.targetPath);
    source(binding.sourceEvidence, binding.nativeId);
  }
}

/** Compile the exact admitted flow; production and qualification share this code. */
export function compileNativeOperatorGraph(
  original: ExecutableModel,
  handler: NativeFlowHandler,
  options: NativeGraphOptions,
) {
  const model = structuredClone(original);
  const flow = structuredClone(options.flow ?? model.flows.conversation);
  validate(flow);
  const operatorId = options.operatorId ?? model.identity.builderId;
  const scope: NativeExecutionScope = options.scope ?? (() => {
    if (!options.rootRequestId) throw new Error("Missing trusted native scope");
    return {
      kind: "request",
      scopeId: options.rootRequestId,
      rootRequestId: options.rootRequestId,
    };
  })();
  if (
    !scope.scopeId || !operatorId || !model.version.digest ||
    !options.assertBoundary ||
    scope.kind === "request" && !scope.rootRequestId ||
    scope.kind === "designer" && !scope.ownerId
  ) {
    throw new Error(
      "Native graph requires trusted scope/operator/model and boundary admission",
    );
  }
  const rootRequestId = scope.kind === "request"
    ? scope.rootRequestId
    : undefined;
  const maxSteps = options.maxSteps ?? flow.maxSteps;
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > flow.maxSteps) {
    throw new Error("Execution step limit exceeds admitted native policy");
  }
  const pin: NativeModelPin = {
    identity: model.identity,
    version: model.version,
    rootNativeId: flow.rootNativeId,
    rootOccurrenceId: flow.rootOccurrenceId,
    ...(flow.executionProfile
      ? { executionProfile: flow.executionProfile }
      : {}),
  };
  const expectedPin = canonical(pin), expectedScope = canonical(scope);
  async function boundary(
    state: NativeState,
    node: CompiledFlowNode,
    config: LangGraphRunnableConfig,
  ): Promise<void> {
    if (canonical(state.modelPin) !== expectedPin) {
      throw new Error("Native checkpoint model version mismatch");
    }
    if (
      state.operatorId !== operatorId ||
      state.rootRequestId !== rootRequestId ||
      canonical(state.executionScope) !== expectedScope
    ) {
      throw new Error("Native checkpoint scope/operator mismatch");
    }
    const context = config.context as Record<string, unknown> | undefined;
    if (
      context &&
      ((context.rootRequestId !== undefined &&
        context.rootRequestId !== rootRequestId) ||
        (context.operatorId !== undefined && context.operatorId !== operatorId))
    ) {
      throw new Error("Native invocation context Request/operator mismatch");
    }
    await options.assertBoundary(state, structuredClone(node), config);
  }
  function nextStep(state: NativeState): number {
    if (
      !Number.isSafeInteger(state.steps) || state.steps < 0 ||
      state.steps >= Number.MAX_SAFE_INTEGER
    ) {
      throw new Error("Invalid native total step counter");
    }
    return state.steps + 1;
  }
  function nextSegment(state: NativeState): number {
    if (
      !Number.isSafeInteger(state.segmentSteps) || state.segmentSteps < 0 ||
      state.segmentSteps >= maxSteps
    ) {
      throw new Error(`Native flow exceeded admitted step limit: ${maxSteps}`);
    }
    return state.segmentSteps + 1;
  }
  function event(
    node: CompiledFlowNode,
    count: number,
    value: FlowExecutionEvent,
  ): NativeTrace {
    return {
      ...value,
      step: count,
      operatorId,
      ...(rootRequestId ? { rootRequestId } : {}),
      ...(node.performerId ? { performerId: node.performerId } : {}),
      ...(node.allocationId ? { allocationId: node.allocationId } : {}),
      ...(node.acceptActionId ? { acceptActionId: node.acceptActionId } : {}),
      modelDigest: model.version.digest,
      modelSourceIds: structuredClone(model.version.sourceIds),
      ...(model.version.repositoryVersion
        ? { repositoryVersion: model.version.repositoryVersion }
        : {}),
    };
  }
  function actionEvent(
    node: CompiledFlowNode,
    count: number,
    kind: "action" | "suspended",
  ): NativeTrace {
    return event(node, count, {
      kind,
      actionId: node.nativeId,
      nodeId: node.id,
      mechanism: node.mechanism,
      source: node.source,
    });
  }
  // Journal mode emits each constructed batch item-by-item at stable
  // producer coordinates; legacy mode keeps the historical onEvent loop.
  // In journal mode the node must omit its `trace` addition (emitTrace).
  const journaled = !!options.onObservation;
  const emitTrace = (trace: NativeTrace[]) => journaled ? {} : { trace };
  async function emit(
    producerPhase: NativeObservationPhase,
    node: CompiledFlowNode,
    emissionStep: number,
    trace: NativeTrace[],
  ): Promise<void> {
    if (!options.onObservation) {
      for (const item of trace) await options.onEvent?.(item);
      return;
    }
    if (!trace.length) return;
    const batchDigest = await nativeObservationBatchDigest({
      producerPhase,
      occurrenceId: node.id,
      emissionStep,
      events: trace,
    });
    for (let eventOrdinal = 0; eventOrdinal < trace.length; eventOrdinal++) {
      await options.onObservation({
        producerPhase,
        occurrenceId: node.id,
        emissionStep,
        eventOrdinal,
        batchCount: trace.length,
        batchDigest,
        event: structuredClone(trace[eventOrdinal]),
      });
    }
  }
  function inputsFor(
    node: CompiledFlowNode,
    values: FlowValues,
    assertions = true,
  ): FlowValues {
    const inputs = Object.fromEntries(
      node.inputs.map((name) => [name, readPath(values, [node.name, name])]),
    );
    for (
      const assertion of node.assertions.filter((item) =>
        assertions && item.inputOnly
      )
    ) {
      if (!evaluateGuard(assertion.expression, inputs)) {
        throw new Error(
          `Native assertion failed before action: ${assertion.nativeId}`,
        );
      }
    }
    return inputs;
  }
  async function resolvePaths(
    values: FlowValues,
    paths: string[][],
  ): Promise<FlowValues> {
    if (!options.resolveValues || !paths.length) return structuredClone(values);
    const selected: FlowValues = {};
    for (const path of paths) {
      let source: unknown = values;
      const prefix: string[] = [];
      for (const part of path) {
        if (!source || typeof source !== "object" || Array.isArray(source)) {
          break;
        }
        if (Object.hasOwn(source, "__assemblyRuntimeRevision")) break;
        if (!Object.hasOwn(source, part)) break;
        prefix.push(part);
        source = (source as FlowValues)[part];
      }
      if (prefix.length) writePath(selected, prefix, structuredClone(source));
    }
    if (!Object.keys(selected).length) return structuredClone(values);
    const resolved = await options.resolveValues(selected);
    const merged = structuredClone(values);
    function overlay(target: FlowValues, patch: FlowValues): void {
      for (const [key, value] of Object.entries(patch)) {
        const old = target[key];
        if (
          old && value && typeof old === "object" &&
          typeof value === "object" &&
          !Array.isArray(old) && !Array.isArray(value) &&
          !Object.hasOwn(old, "__assemblyRuntimeRevision")
        ) {
          overlay(old as FlowValues, value as FlowValues);
        } else target[key] = value;
      }
    }
    overlay(merged, resolved);
    return merged;
  }
  function resolveInputs(
    node: CompiledFlowNode,
    values: FlowValues,
  ): Promise<FlowValues> {
    return resolvePaths(values, node.inputs.map((name) => [node.name, name]));
  }
  function route(node: CompiledFlowNode, values: FlowValues, count: number) {
    const outgoing = flow.edges.filter((edge) => edge.source === node.id);
    const matches = outgoing.filter((edge) =>
      edge.guard !== "else" &&
      (!edge.guard || evaluateGuard(edge.guard, values))
    );
    if (matches.length > 1) {
      throw new Error(`Multiple native guards match: ${node.nativeId}`);
    }
    const edge = matches[0] ?? outgoing.find((edge) => edge.guard === "else");
    if (!edge) {
      throw new Error(`No native control branch matches: ${node.nativeId}`);
    }
    return {
      nextNode: edge.target,
      edgeEvent: event(node, count, {
        kind: "edge",
        edgeId: edge.nativeId,
        nodeId: node.id,
        guardIds: edge.guardIds,
        source: edge.sourceEvidence,
      }),
    };
  }
  const effectKeyFor = async (
    node: CompiledFlowNode,
    count: number,
    config: LangGraphRunnableConfig,
  ) =>
    `native-effect:${await executionDigest({
      version: 1,
      execution: options.effectNamespace ??
        String(config.configurable?.thread_id ?? "unpersisted"),
      scope,
      operatorId,
      modelPin: pin,
      flowOccurrenceId: flow.rootOccurrenceId,
      nodeId: node.id,
      nativeId: node.nativeId,
      step: count,
    })}`;
  const State = Annotation.Root({
    ...NativeOperatorState.spec,
    modelPin: Annotation<NativeModelPin>({
      reducer: (_previous, next) => next,
      default: () => structuredClone(pin),
    }),
    rootRequestId: Annotation<string | undefined>({
      reducer: (_previous, next) => next,
      default: () => rootRequestId,
    }),
    executionScope: Annotation<NativeExecutionScope>({
      reducer: (_previous, next) => next,
      default: () => structuredClone(scope),
    }),
    operatorId: Annotation<string>({
      reducer: (_previous, next) => next,
      default: () => operatorId,
    }),
  });
  const builder = new StateGraph<
    typeof State,
    NativeState,
    typeof State.Update,
    string
  >(State);
  const prepareName = (id: string) =>
    nativeFrameworkNodeName(id, "await-preparation");
  async function waitEvidenceFor(
    state: NativeState,
    node: CompiledFlowNode,
    prepared: PreparedNativeAction,
    kind: NativeWaitEvidence["kind"],
  ): Promise<NativeWaitEvidence> {
    const {
      localState: _localState,
      messages: _messages,
      journal: _journal,
      operatorData: _operatorData,
      asyncTasks: _asyncTasks,
      ...result
    } = prepared.result as NativeActionResult & { localState?: unknown };
    const promotionId = state.operatorData.promotionId;
    return {
      version: 1,
      kind,
      nodeId: node.id,
      actionId: node.nativeId,
      preparedNodeId: prepareName(node.id),
      effectKey: prepared.effectKey,
      modelPin: structuredClone(state.modelPin),
      executionScope: structuredClone(state.executionScope),
      operatorId: state.operatorId,
      ...(state.rootRequestId ? { rootRequestId: state.rootRequestId } : {}),
      resultDigest: await executionDigest(result),
      inputs: structuredClone(prepared.inputs),
      ...(typeof promotionId === "string" ? { promotionId } : {}),
      ...(state.operatorData.changeApprovalWait !== undefined
        ? {
          changeApprovalWait: structuredClone(
            state.operatorData.changeApprovalWait,
          ) as unknown as NativeChangeApprovalWait,
        }
        : {}),
      ...(prepared.result.modelAdvance
        ? { evidence: structuredClone(prepared.result.modelAdvance) }
        : {}),
    };
  }
  const entry = prepareName;
  for (const node of flow.nodes) {
    // The effectful primitive finishes and its result is checkpointed before a
    // separate node can interrupt. Framework resume never replays that primitive.
    builder.addNode(
      prepareName(node.id),
      async (state: NativeState, config: LangGraphRunnableConfig) => {
        await boundary(state, node, config);
        const count = nextStep(state), segment = nextSegment(state);
        const resolved = node.kind === "action"
          ? await resolveInputs(node, state.values)
          : structuredClone(state.values);
        const inputs = node.kind === "action" ? inputsFor(node, resolved) : {};
        const retainedInputs = node.kind === "action"
          ? inputsFor(node, state.values, false)
          : {};
        const effectKey = await effectKeyFor(node, count, config);
        let result: NativeActionResult = {};
        if (node.mechanism === "await_input") {
          result = {
            suspend: await options.shouldAwait?.(state, node) ?? true,
          };
        } else if (node.kind === "action") {
          const invocation: NativeInvocation = {
            state,
            config,
            step: count,
            segmentStep: segment,
            ...(state.resumeAction?.nodeId === node.id
              ? {
                resume: { contributionId: state.resumeAction.contributionId },
              }
              : {}),
            effectKey,
          };
          if (
            flow.executionProfile === "operator-command-immutable-group-v1" &&
            node.mechanism === "execute_operator_command"
          ) {
            if (!options.immutableConsultations) {
              throw new Error("Immutable group handlers unavailable");
            }
            const proposed = await options.immutableConsultations.plan(
              structuredClone(node),
              structuredClone(inputs),
              structuredClone(resolved),
              invocation,
            );
            if (proposed) {
              assertImmutableGroupShape(proposed);
              if (
                proposed.occurrenceId !== node.id ||
                proposed.members.some((member, index) =>
                  member.flowStepOrdinal !== count + index + 1
                ) ||
                count + proposed.limits.flowSteps > Number.MAX_SAFE_INTEGER ||
                segment + proposed.limits.flowSteps > maxSteps
              ) {
                throw new Error(
                  "Immutable group exceeds admitted native step budget",
                );
              }
              const manifest = await options.immutableConsultations.register(
                structuredClone(proposed),
              );
              if (canonical(manifest) !== canonical(proposed)) {
                throw new Error("Immutable group registration mismatch");
              }
              // Persist the complete registered reference before dispatching workers.
              return { immutableGroup: { manifest, nodeId: node.id } };
            }
          }
          result = await handler(
            structuredClone(node),
            inputs,
            resolved,
            invocation,
          );
          if (!result || typeof result !== "object" || Array.isArray(result)) {
            throw new Error(
              `Missing primitive action result: ${node.nativeId}`,
            );
          }
        }
        const trace = node.kind === "action"
          ? [actionEvent(node, count, "action")]
          : [];
        if (result.suspend) trace.push(actionEvent(node, count, "suspended"));
        await emit("preparation", node, count, trace);
        return {
          prepared: {
            nodeId: node.id,
            inputs: retainedInputs,
            result: {
              ...result,
              // Large unrelated extension channels are not embedded again in prepared.
              messages: undefined,
              journal: undefined,
              operatorData: undefined,
              asyncTasks: undefined,
            },
            step: count,
            segmentStep: segment,
            effectKey,
          },
          steps: count,
          segmentSteps: segment,
          ...emitTrace(trace),
          ...(state.resumeAction?.nodeId === node.id
            ? { resumeAction: undefined }
            : {}),
          ...(result.messages ? { messages: result.messages } : {}),
          ...(result.journal ? { journal: result.journal } : {}),
          ...(result.operatorData ? { operatorData: result.operatorData } : {}),
          ...(result.asyncTasks ? { asyncTasks: result.asyncTasks } : {}),
        };
      },
    );
    if (
      flow.executionProfile === "operator-command-immutable-group-v1" &&
      node.mechanism === "execute_operator_command"
    ) {
      const workerName = `immutable_worker_${encodeURIComponent(node.id)}`;
      const joinName = `immutable_join_${encodeURIComponent(node.id)}`;
      builder.addNode(
        workerName,
        async (
          task: {
            manifest: ImmutableConsultationGroupManifest;
            member: ImmutableConsultationGroupMember;
          },
          _config: LangGraphRunnableConfig,
        ) => {
          await options.assertTechnicalBoundary?.();
          const outcome = await options.immutableConsultations!.member(
            structuredClone(task.manifest),
            structuredClone(task.member),
            structuredClone(node),
          );
          if (
            outcome.groupId !== task.manifest.groupId ||
            outcome.callId !== task.member.callId ||
            outcome.effectKey !== task.member.effectKey ||
            outcome.argumentsDigest !== task.member.argumentsDigest
          ) {
            throw new Error("Immutable group member receipt identity mismatch");
          }
          await options.assertTechnicalBoundary?.();
          return {
            immutableOutcomes: {
              kind: "merge" as const,
              receipts: {
                [
                  immutableReceiptKey(task.manifest.groupId, task.member.callId)
                ]: outcome,
              },
            },
          };
        },
      );
      builder.addNode(
        joinName,
        async (state: NativeState, config: LangGraphRunnableConfig) => {
          await boundary(state, node, config);
          const group = state.immutableGroup;
          if (!group || group.nodeId !== node.id) {
            throw new Error("Immutable group checkpoint mismatch");
          }
          const outcomes = group.manifest.members.map((member) => {
            const receipt = state
              .immutableOutcomes[
                immutableReceiptKey(group.manifest.groupId, member.callId)
              ];
            if (!receipt) {
              throw new Error(
                "Immutable group join requires every member receipt",
              );
            }
            return structuredClone(receipt);
          });
          const result = await options.immutableConsultations!.join(
            structuredClone(group.manifest),
            outcomes,
          );
          const count = nextStep(state), segment = nextSegment(state);
          const reserved = group.manifest.limits.flowSteps;
          if (segment + reserved > maxSteps) {
            throw new Error("Immutable group step reservation exceeded");
          }
          const retainedInputs = inputsFor(node, state.values, false);
          const effectKey = await effectKeyFor(node, count, config);
          const finalStep = count + reserved;
          const trace = [
            actionEvent(node, count, "action"),
            ...group.manifest.members.map((member) => ({
              ...actionEvent(node, member.flowStepOrdinal, "action"),
              immutableGroupId: group.manifest.groupId,
              immutableCallId: member.callId,
            })),
          ];
          if (result.suspend) {
            trace.push(actionEvent(node, finalStep, "suspended"));
          }
          await emit("immutable-group-join", node, count, trace);
          return {
            prepared: {
              nodeId: node.id,
              inputs: retainedInputs,
              result,
              step: finalStep,
              segmentStep: segment + reserved,
              effectKey,
            },
            immutableGroup: undefined,
            immutableOutcomes: {
              kind: "clear" as const,
              groupId: group.manifest.groupId,
            },
            steps: finalStep,
            segmentSteps: segment + reserved,
            ...emitTrace(trace),
            ...(state.resumeAction?.nodeId === node.id
              ? { resumeAction: undefined }
              : {}),
            ...(result.operatorData
              ? { operatorData: result.operatorData }
              : {}),
          };
        },
      );
      builder.addConditionalEdges(
        prepareName(node.id),
        (state: NativeState) => {
          const group = state.immutableGroup;
          if (!group) return nativeFrameworkNodeName(node.id);
          if (group.nodeId !== node.id) {
            throw new Error("Immutable group occurrence mismatch");
          }
          return group.manifest.members.map((member) =>
            new Send(workerName, {
              manifest: structuredClone(group.manifest),
              member: structuredClone(member),
            })
          );
        },
        [nativeFrameworkNodeName(node.id), workerName],
      );
      builder.addEdge(workerName, joinName);
      builder.addEdge(joinName, nativeFrameworkNodeName(node.id));
    } else {builder.addEdge(
        prepareName(node.id),
        nativeFrameworkNodeName(node.id),
      );}
    builder.addNode(
      nativeFrameworkNodeName(node.id),
      async (state: NativeState, config: LangGraphRunnableConfig) => {
        const prepared = state.prepared;
        if (!prepared || prepared.nodeId !== node.id) {
          throw new Error("Native prepared action mismatch");
        }
        const advance = prepared.result.modelAdvance;
        if (
          advance &&
          canonical({
              identity: state.modelPin.identity,
              version: state.modelPin.version,
            }) === canonical(advance.from)
        ) {
          await options.assertTechnicalBoundary?.();
          interrupt({
            kind: "native-model-advance",
            nodeId: node.id,
            preparedNodeId: prepareName(node.id),
            settledEffectKey: prepared.effectKey,
            evidence: advance,
            waitEvidence: await waitEvidenceFor(
              state,
              node,
              prepared,
              "technical-advance",
            ),
          });
          throw new Error(
            "A technical model advance cannot consume an input resume",
          );
        }
        if (
          advance && (!state.continuationRef ||
            canonical({
                identity: state.modelPin.identity,
                version: state.modelPin.version,
              }) !== canonical(advance.to))
        ) {
          throw new Error(
            "The prepared publication has no selected immutable continuation",
          );
        }
        await boundary(state, node, config);
        let contributionId: string | undefined;
        let resumedResult: NativeActionResult | undefined;
        let consumedWait: NativeWaitConsumptionEvidence | undefined;
        if (prepared.result.suspend) {
          const waitEvidence = await waitEvidenceFor(
            state,
            node,
            prepared,
            node.mechanism === "await_input"
              ? "input"
              : prepared.result.suspensionKind === "decision"
              ? "decision"
              : prepared.result.suspensionKind === "contribution"
              ? "contribution"
              : "budget",
          );
          const resume = interrupt({
            kind: node.mechanism === "await_input"
              ? "native-await-input"
              : prepared.result.suspensionKind === "decision"
              ? "native-decision-wait"
              : prepared.result.suspensionKind === "contribution"
              ? "native-contribution-wait"
              : "native-budget-wait",
            nodeId: node.id,
            actionId: node.nativeId,
            acceptActionId: node.acceptActionId,
            ...(rootRequestId ? { rootRequestId } : {}),
            executionScope: structuredClone(scope),
            operatorId,
            modelPin: structuredClone(pin),
            waitEvidence,
          });
          if (
            !resume || typeof resume !== "object" ||
            typeof (resume as NativeResume).contributionId !== "string" ||
            !(resume as NativeResume).contributionId.trim()
          ) {
            throw new Error(
              "Native resume requires an authenticated contribution receipt id",
            );
          }
          contributionId = (resume as NativeResume).contributionId;
          if (state.acceptedContributionIds.includes(contributionId)) {
            throw new Error("Native contribution receipt already accepted");
          }
          // LangGraph clears configurable.checkpoint_id for nodes; its public
          // execution metadata retains the exact checkpoint that supplied this wait.
          const sourceCheckpointId = config.executionInfo?.checkpointId;
          if (typeof sourceCheckpointId !== "string" || !sourceCheckpointId) {
            throw new Error(
              "Native wait consumption requires an exact source checkpoint",
            );
          }
          // Budget suspension retries only the unexecuted operation. Await input
          // finishes its already-prepared native acceptance without replaying it.
          if (node.mechanism !== "await_input") {
            const consultation = node.mechanism === "choose_move" &&
                flow.executionProfile !== undefined
              ? flow.nodes.find((item) =>
                item.mechanism === "consult_declared_source"
              )
              : undefined;
            return {
              nextNode: consultation?.id ?? node.id,
              prepared: undefined,
              segmentSteps: 0,
              acceptedContributionIds: [contributionId],
              waitConsumptions: [
                {
                  version: 1,
                  kind: "wait-v1",
                  contributionId,
                  sourceCheckpointId,
                  wait: waitEvidence,
                } satisfies NativeWaitConsumptionEvidence,
              ],
              resumeAction: { nodeId: node.id, contributionId },
            };
          }
          // The acceptance primitive runs only after the real interrupt accepts
          // this contribution. No preceding primitive is restarted.
          const resolved = await resolveInputs(node, state.values);
          resumedResult = await handler(
            structuredClone(node),
            inputsFor(node, resolved),
            resolved,
            {
              state,
              config,
              resume,
              step: nextStep(state),
              segmentStep: 1,
              effectKey: await effectKeyFor(node, nextStep(state), config),
            },
          );
          if (resumedResult.suspend) {
            throw new Error("Accepted native input cannot suspend again");
          }
          consumedWait = {
            version: 1,
            kind: "wait-v1",
            contributionId,
            sourceCheckpointId,
            wait: waitEvidence,
          };
        }
        const count = contributionId ? nextStep(state) : prepared.step,
          values = structuredClone(state.values),
          trace: NativeTrace[] = [];
        if (contributionId && node.mechanism === "await_input") {
          trace.push(actionEvent(node, count, "action"));
        }
        if (node.kind === "done") {
          trace.push(
            event(node, count, {
              kind: "completed",
              actionId: node.nativeId,
              nodeId: node.id,
              source: node.source,
            }),
          );
        } else {
          if (node.kind === "action") {
            const outputs = (resumedResult ?? prepared.result).outputs ?? {};
            if (
              Object.keys(outputs).some((name) => !node.outputs.includes(name))
            ) {
              throw new Error(
                `Undeclared native action output: ${node.nativeId}`,
              );
            }
            if (
              node.outputs.some((name) =>
                !Object.hasOwn(outputs, name) || outputs[name] === undefined
              )
            ) {
              throw new Error(
                `Missing declared native action output: ${node.nativeId}`,
              );
            }
            const actionValues = { ...prepared.inputs, ...outputs };
            const resolvedAction = await resolvePaths(
              actionValues,
              node.assertions.flatMap((assertion) =>
                guardPaths(assertion.expression)
              ),
            );
            for (const assertion of node.assertions) {
              if (!evaluateGuard(assertion.expression, resolvedAction)) {
                throw new Error(
                  `Native assertion failed after action: ${assertion.nativeId}`,
                );
              }
            }
            values[node.name] = actionValues;
            for (const name of Object.keys(outputs)) {
              propagate(flow, values, [node.name, name]);
            }
          }
          const resolved = await resolvePaths(
            values,
            flow.edges
              .filter((edge) =>
                edge.source === node.id && edge.guard && edge.guard !== "else"
              )
              .flatMap((edge) => guardPaths(edge.guard!)),
          );
          const next = route(node, resolved, count);
          trace.push(next.edgeEvent);
          await emit("node-commit", node, count, trace);
          return {
            values,
            ...emitTrace(trace),
            prepared: undefined,
            nextNode: next.nextNode,
            ...(resumedResult?.messages
              ? { messages: resumedResult.messages }
              : {}),
            ...(resumedResult?.journal
              ? { journal: resumedResult.journal }
              : {}),
            ...(resumedResult?.operatorData
              ? { operatorData: resumedResult.operatorData }
              : {}),
            ...(resumedResult?.asyncTasks
              ? { asyncTasks: resumedResult.asyncTasks }
              : {}),
            ...(contributionId
              ? {
                acceptedContributionIds: [contributionId],
                ...(consumedWait ? { waitConsumptions: [consumedWait] } : {}),
                steps: count,
                segmentSteps: 1,
              }
              : {}),
          };
        }
        await emit("node-commit", node, count, trace);
        return { values, ...emitTrace(trace), prepared: undefined };
      },
    );
    if (node.kind === "done") {
      builder.addEdge(
        nativeFrameworkNodeName(node.id),
        END,
      );
    } else {builder.addConditionalEdges(
        nativeFrameworkNodeName(node.id),
        (state: NativeState) => entry(state.nextNode),
        [
          ...new Set([
            ...flow.edges.filter((edge) => edge.source === node.id).map(
              (edge) => entry(edge.target),
            ),
            entry(node.id),
            ...flow.nodes.filter((item) =>
              item.mechanism === "consult_declared_source"
            ).map((item) => entry(item.id)),
          ]),
        ],
      );}
  }
  builder.addEdge(START, entry(flow.startNodeId));
  return {
    graph: builder.compile({
      checkpointer: options.checkpointer,
      store: options.store,
      name: options.name,
    })
      .withConfig({ recursionLimit: 2 * maxSteps + 4 }),
    metadata: structuredClone({
      frameworkNodeNames: Object.fromEntries(
        flow.nodes.map(
          (node) => [node.id, {
            node: nativeFrameworkNodeName(node.id),
            entry: entry(node.id),
          }],
        ),
      ),
      modelPin: pin,
      flow,
      maxSteps,
      operatorId,
      rootRequestId,
      executionScope: scope,
    }),
    initialState(
      values: FlowValues = {},
      operatorData: FlowValues = {},
    ): typeof State.Update {
      return {
        values: structuredClone(values),
        operatorData: structuredClone(operatorData),
        steps: 0,
        segmentSteps: 0,
        acceptedContributionIds: [],
        waitConsumptions: [],
        modelPin: structuredClone(pin),
        rootRequestId,
        executionScope: structuredClone(scope),
        operatorId,
        trace: [],
        messages: [],
        journal: [],
      };
    },
  };
}
