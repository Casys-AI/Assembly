import { persistedOrder } from "../../../../../domain/primitives/persisted-order.ts";
/** Exact native flow selection and the bounded versioned operator-command profile. */
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import {
  type CompiledFlow,
  compileModelFlow,
  type FlowProjection,
  type OperatorExecutionProfile,
} from "../../../../../domain/model/execution/flow.ts";
import type { NativeLiteral } from "./execution-model.ts";

const PROFILES: readonly OperatorExecutionProfile[] = [
  "operator-command-v1",
  "operator-command-immutable-group-v1",
];

/** Catalog-only library rows are intentionally absent from ModelSnapshot. Resolve
 * this one permitted implicit base from the original native compiler evidence. */
export function resolveNativeActionBaseIds(
  elements: readonly Record<string, unknown>[],
): ReadonlySet<string> {
  const matches = elements.filter((element) =>
    element.qualifiedName === "Actions::Action"
  );
  if (!matches.length) return new Set();
  const base = matches[0]!;
  if (
    matches.length !== 1 || base["@type"] !== "ActionDefinition" ||
    base["toolkit:catalogOnly"] !== true || base.isLibraryElement !== true ||
    typeof base["@id"] !== "string" || !base["@id"].trim() ||
    elements.filter((element) => element["@id"] === base["@id"]).length !== 1
  ) throw new Error("Invalid native builtin action base evidence");
  return new Set([base["@id"]]);
}
const PRIMITIVES: Readonly<Record<string, string>> = {
  ReadCaseState: "read_case",
  ChooseNextMove: "choose_move",
  ReplyOrClarify: "reply",
  AwaitCaseInput: "await_input",
  CheckRequestedAction: "check_invocation",
  ExecuteRequestedAction: "invoke_tool",
  RecordActionRefusal: "report_refusal",
  SubmitChangeProposal: "submit_proposal",
  ObserveOutcomeAndUpdateCase: "observe_outcome",
  ConsultDeclaredModelSource: "consult_declared_source",
  ExecuteOperatorCommand: "execute_operator_command",
};

export const OPERATOR_FLOW_PERFORMERS: Readonly<Record<string, string>> = {
  read_case: "admissionGate",
  choose_move: "builder",
  reply: "builder",
  await_input: "admissionGate",
  check_invocation: "admissionGate",
  invoke_tool: "catalog",
  report_refusal: "admissionGate",
  submit_proposal: "admissionGate",
  observe_outcome: "admissionGate",
  consult_declared_source: "admissionGate",
  execute_operator_command: "admissionGate",
};

/** Require an owned, explicitly typed native scalar; inherited defaults are not selection. */
export function flowLiteral(
  snapshot: ModelSnapshot,
  literals: readonly NativeLiteral[],
  ownerId: string,
  name: string,
  scalar: "String" | "Integer",
): NativeLiteral {
  const attributes = snapshot.elements.filter((element) =>
    element.ownerId === ownerId && element.name === name &&
    element.metaclass === "AttributeUsage"
  );
  const values = literals.filter((literal) =>
    literal.owner === ownerId && literal.name === name
  );
  const attribute = attributes[0], value = values[0];
  if (
    attributes.length !== 1 || values.length !== 1 || !attribute || !value ||
    value.attributeId !== attribute.id || value.kind !== `Literal${scalar}` ||
    attribute.typeIds.length !== 1 || value.typeIds.length !== 1 ||
    attribute.typeIds[0] !== value.typeIds[0] || value.typeNames.length !== 1 ||
    !/(?:^|::)ScalarValues::(?:String|Integer)$/.test(value.typeNames[0]!) ||
    !value.typeNames[0]!.endsWith(`::${scalar}`) || !value.literalId
  ) {
    throw new Error(`Invalid typed native flow field: ${name}`);
  }
  return value;
}

export function selectedFlowRoot(
  snapshot: ModelSnapshot,
  systemId: string,
  name: string,
): { root: ElementRecord; definition: ElementRecord } {
  const roots = snapshot.elements.filter((element) =>
    element.ownerId === systemId && element.name === name &&
    element.metaclass === "PerformActionUsage"
  );
  const root = roots[0];
  const definition = root?.typeIds.length === 1
    ? snapshot.elements.find((element) =>
      element.id === root.typeIds[0] && element.metaclass === "ActionDefinition"
    )
    : undefined;
  if (roots.length !== 1 || !root || !definition) {
    throw new Error(`Unresolved native executable flow ${name}`);
  }
  return { root, definition };
}

export function declaredFlowProfile(
  snapshot: ModelSnapshot,
  literals: readonly NativeLiteral[],
  definition: ElementRecord,
  nativeActionBaseIds: ReadonlySet<string> = new Set(),
): {
  profile: OperatorExecutionProfile;
  revision: number;
  sourceIds: string[];
} {
  const profile = flowLiteral(
    snapshot,
    literals,
    definition.id,
    "executionProfile",
    "String",
  );
  const revision = flowLiteral(
    snapshot,
    literals,
    definition.id,
    "templateRevision",
    "Integer",
  );
  if (
    !PROFILES.includes(profile.value as OperatorExecutionProfile) ||
    !/^[1-9][0-9]*$/.test(revision.value) ||
    !Number.isSafeInteger(Number(revision.value))
  ) {
    throw new Error(
      "Unsupported native operator flow profile or template revision",
    );
  }
  // Composite inheritance/redefinition is deliberately outside this bounded profile.
  if (
    definition.generalIds.some((id) => !nativeActionBaseIds.has(id))
  ) {
    throw new Error(
      "Operator flow profiles require a standalone native action definition",
    );
  }
  return {
    profile: profile.value as OperatorExecutionProfile,
    revision: Number(revision.value),
    sourceIds: [
      definition.id,
      profile.attributeId,
      profile.literalId,
      ...profile.typeIds,
      revision.attributeId,
      revision.literalId,
      ...revision.typeIds,
    ],
  };
}

function validateConsultationRequest(source: string): void {
  if (source.length > 4096) {
    throw new Error("Native consultation request exceeds its bound");
  }
  const value: unknown = JSON.parse(source);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unsupported native consultation request");
  }
  const request = value as Record<string, unknown>;
  const selector = request.operation === "inspect"
    ? "elementId"
    : request.operation === "read_source"
    ? "path"
    : undefined;
  if (
    !selector ||
    Object.keys(request).some((key) =>
      !["operation", "version", selector].includes(key)
    ) || typeof request[selector] !== "string" ||
    !(request[selector] as string).trim() ||
    (request[selector] as string).length > (selector === "path" ? 240 : 512) ||
    request.version !== undefined &&
      (typeof request.version !== "string" || !request.version.trim() ||
        request.version.length > 256)
  ) throw new Error("Unsupported native consultation request");
}

/** One compiler refusal for an invalid declared operator-command structure. */
export class OperatorFlowValidationError extends Error {
  readonly code = "OPERATOR_FLOW_INVALID";
  readonly recovery =
    "Declare one decision and command action, and explicit success and failure branches for each optional model consultation.";
  constructor(
    message: string,
    readonly context: { mechanism: string; nodeId?: string },
  ) {
    super(message);
    this.name = "OperatorFlowValidationError";
  }
}

/** Optional reads retain their own modeled outcomes; the flow governs ordering. */
export function validateOperatorCommandFlow(flow: CompiledFlow): void {
  for (const mechanism of ["choose_move", "execute_operator_command"]) {
    if (
      flow.nodes.filter((node) => node.mechanism === mechanism).length !== 1
    ) {
      throw new OperatorFlowValidationError(
        `Operator-command profile requires one ${mechanism} action`,
        { mechanism },
      );
    }
  }
  const nodes = new Map(flow.nodes.map((node) => [node.id, node]));
  for (
    const consult of flow.nodes.filter((node) =>
      node.mechanism === "consult_declared_source"
    )
  ) {
    const invalidOutcome = () =>
      new OperatorFlowValidationError(
        "A declared consultation requires explicit native success and failure branches on every path before another action, completion or cycle",
        { mechanism: "consult_declared_source", nodeId: consult.id },
      );
    const pending = flow.edges.filter((edge) => edge.source === consult.id).map(
      (edge) => ({ id: edge.target, after: false }),
    );
    if (!pending.length) throw invalidOutcome();
    const states = new Map<string, "visiting" | "checked">();
    while (pending.length) {
      const { id, after } = pending.pop()!;
      if (after) {
        states.set(id, "checked");
        continue;
      }
      if (states.get(id) === "checked") continue;
      if (states.get(id) === "visiting") throw invalidOutcome();
      const node = nodes.get(id);
      if (!node || node.kind === "action" || node.kind === "done") {
        throw invalidOutcome();
      }
      const edges = flow.edges.filter((edge) => edge.source === id);
      if (!edges.length) throw invalidOutcome();
      if (node.kind === "decision") {
        const guards = edges.map((edge) => edge.guard?.trim());
        const succeeded =
          guards.includes(`${consult.name}.consultation.succeeded`) ||
          guards.includes(`${consult.name}.consultation.succeeded == true`);
        const failed = guards.includes("else") ||
          guards.includes(`not ${consult.name}.consultation.succeeded`) ||
          guards.includes(`${consult.name}.consultation.succeeded == false`);
        if (succeeded && failed) {
          states.set(id, "checked");
          continue;
        }
      }
      states.set(id, "visiting");
      pending.push(
        { id, after: true },
        ...edges.map((edge) => ({ id: edge.target, after: false })),
      );
    }
  }
}

export function compileSelectedOperatorFlow(
  snapshot: ModelSnapshot,
  graph: FlowProjection,
  literals: readonly NativeLiteral[],
  systemId: string,
  name: string,
  maxSteps: number,
  nativeActionBaseIds: ReadonlySet<string> = new Set(),
): {
  flow: CompiledFlow;
  definition: ElementRecord;
  revision?: number;
  sourceIds: string[];
} {
  const { root, definition } = selectedFlowRoot(snapshot, systemId, name);
  const declared = snapshot.elements.some((element) =>
    element.ownerId === definition.id && element.name === "executionProfile"
  );
  if (!declared) {
    const historicalDefinitions = snapshot.elements.filter((element) =>
      element.metaclass === "ActionDefinition" &&
      sameProductName(
        element.qualifiedName,
        "AssemblyConversation::ConversationCase",
      )
    );
    if (
      name !== "conversation" || historicalDefinitions.length !== 1 ||
      historicalDefinitions[0]!.id !== definition.id
    ) {
      throw new Error(
        "A private native flow requires an explicit supported execution profile",
      );
    }
    return {
      flow: compileModelFlow(graph, { rootNativeId: root.id, maxSteps }),
      definition,
      sourceIds: [definition.id],
    };
  }
  const profile = declaredFlowProfile(
    snapshot,
    literals,
    definition,
    nativeActionBaseIds,
  );
  const implementations: Record<string, string> = {};
  for (const [name, mechanism] of Object.entries(PRIMITIVES)) {
    const types = snapshot.elements.filter((element) =>
      element.metaclass === "ActionDefinition" &&
      sameProductName(element.qualifiedName, `AssemblyConversation::${name}`)
    );
    if (types.length > 1) {
      throw new Error(`Ambiguous native operator primitive: ${name}`);
    }
    if (types[0]) implementations[types[0].qualifiedName] = mechanism;
  }
  const flow = compileModelFlow(graph, {
    rootNativeId: root.id,
    maxSteps,
    implementations,
  });
  flow.executionProfile = profile.profile;
  const sourceIds = [...profile.sourceIds];
  for (
    const action of flow.nodes.filter((node) =>
      node.mechanism === "consult_declared_source"
    )
  ) {
    const request = flowLiteral(
      snapshot,
      literals,
      action.nativeId,
      "consultationRequest",
      "String",
    );
    validateConsultationRequest(request.value);
    action.consultationRequest = request.value;
    sourceIds.push(request.attributeId, request.literalId, ...request.typeIds);
  }
  validateOperatorCommandFlow(flow);
  return { flow, definition, revision: profile.revision, sourceIds };
}

/** Identical legacy semantics; selected profiles add only their explicit field. */
export function operatorFlowSemantics(entries: Record<string, CompiledFlow>) {
  return Object.fromEntries(
    Object.entries(entries).map(([name, flow]) => [name, {
      ...(flow.executionProfile
        ? { executionProfile: flow.executionProfile }
        : {}),
      rootNativeId: flow.rootNativeId,
      startNodeId: flow.startNodeId,
      maxSteps: flow.maxSteps,
      nodes: flow.nodes.map(({ source: _source, assertions, ...node }) => ({
        ...node,
        assertions: assertions.map((
          { source: _assertionSource, ...assertion },
        ) => assertion),
      })).sort((a, b) => persistedOrder(a.id, b.id)),
      edges: flow.edges.map(({ sourceEvidence: _source, ...edge }) => edge)
        .sort((a, b) => persistedOrder(a.id, b.id)),
      bindings: flow.bindings.map(({ sourceEvidence: _source, ...binding }) =>
        binding
      ).sort((a, b) => persistedOrder(a.nativeId, b.nativeId)),
    }]),
  );
}
