import { deepStrictEqual, throws } from "node:assert/strict";
import {
  declaredFlowProfile,
  resolveNativeActionBaseIds,
  validateOperatorCommandFlow,
} from "./operator-flow.ts";
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type { NativeLiteral } from "./execution-model.ts";

function fixture() {
  const definition: ElementRecord = {
    id: "private-flow",
    name: "PrivateFlow",
    qualifiedName: "Work::PrivateFlow",
    metaclass: "ActionDefinition",
    ownerId: "work",
    typeIds: [],
    generalIds: ["native-action-base"],
    direction: "",
    isReference: false,
    redefinedIds: [],
    multiplicity: "",
    doc: "",
  };
  const fields = [["executionProfile", "String", "operator-command-v1"], [
    "templateRevision",
    "Integer",
    "1",
  ]] as const;
  const snapshot: ModelSnapshot = {
    rootId: "root",
    elements: [
      definition,
      ...fields.map(([name, scalar]) => ({
        ...definition,
        id: name,
        name,
        qualifiedName: `Work::PrivateFlow::${name}`,
        metaclass: "AttributeUsage",
        ownerId: definition.id,
        generalIds: [],
        typeIds: [`scalar-${scalar}`],
      })),
    ],
    connectors: [],
    invocations: [],
    patternIds: [],
    messages: [],
  };
  const literals: NativeLiteral[] = fields.map(([name, scalar, value]) => ({
    owner: definition.id,
    name,
    attributeId: name,
    literalId: `${name}-literal`,
    kind: `Literal${scalar}`,
    value,
    typeIds: [`scalar-${scalar}`],
    typeNames: [`ScalarValues::${scalar}`],
  }));
  const builtin = {
    "@id": "native-action-base",
    "@type": "ActionDefinition",
    qualifiedName: "Actions::Action",
    "toolkit:catalogOnly": true,
    isLibraryElement: true,
  };
  return { definition, snapshot, literals, builtin };
}

Deno.test("operator profile permits its exact native catalog builtin without adding it to snapshot", () => {
  const f = fixture();
  const ids = resolveNativeActionBaseIds([f.builtin]);
  deepStrictEqual([...ids], ["native-action-base"]);
  deepStrictEqual(
    declaredFlowProfile(f.snapshot, f.literals, f.definition, ids).revision,
    1,
  );
});

Deno.test("operator profile rejects source shadows and malformed native builtin evidence", () => {
  const f = fixture();
  for (
    const changed of [
      { ...f.builtin, isLibraryElement: false },
      { ...f.builtin, "toolkit:catalogOnly": false },
      { ...f.builtin, "@type": "PartDefinition" },
    ]
  ) throws(() => resolveNativeActionBaseIds([changed]), /builtin action base/);
  throws(() =>
    resolveNativeActionBaseIds([f.builtin, {
      ...f.builtin,
      "@id": "own-shadow",
      isLibraryElement: false,
    }]), /builtin action base/);
  f.snapshot.elements.push({
    ...f.definition,
    id: "native-action-base",
    qualifiedName: "Actions::Action",
  });
  throws(
    () => declaredFlowProfile(f.snapshot, f.literals, f.definition),
    /standalone/,
  );
});

Deno.test("operator profile rejects unresolved and custom generalizations", () => {
  const f = fixture();
  throws(
    () =>
      declaredFlowProfile(
        f.snapshot,
        f.literals,
        f.definition,
        resolveNativeActionBaseIds([]),
      ),
    /standalone/,
  );
  f.definition.generalIds.push("custom-parent");
  throws(
    () =>
      declaredFlowProfile(
        f.snapshot,
        f.literals,
        f.definition,
        resolveNativeActionBaseIds([f.builtin]),
      ),
    /standalone/,
  );
});

Deno.test("immutable group profile is explicit and rejects unsupported values", () => {
  const f = fixture();
  const ids = resolveNativeActionBaseIds([f.builtin]);
  const field = f.literals.find((literal) =>
    literal.name === "executionProfile"
  )!;
  field.value = "operator-command-immutable-group-v1";
  deepStrictEqual(
    declaredFlowProfile(f.snapshot, f.literals, f.definition, ids).profile,
    "operator-command-immutable-group-v1",
  );
  field.value = "operator-command-immutable-group-v2";
  throws(
    () => declaredFlowProfile(f.snapshot, f.literals, f.definition, ids),
    /Unsupported native operator flow profile/,
  );
});

function commandFlow(
  consultations = 0,
): import("../../../../../domain/model/execution/flow.ts").CompiledFlow {
  const source = { file: "flow.sysml", line: 1 };
  const flow:
    import("../../../../../domain/model/execution/flow.ts").CompiledFlow = {
      rootNativeId: "flow",
      rootOccurrenceId: "flow",
      name: "flow",
      source,
      startNodeId: "choose",
      maxSteps: 30,
      nodes: [],
      edges: [],
      bindings: [],
    };
  const node = (
    id: string,
    mechanism?:
      | "choose_move"
      | "execute_operator_command"
      | "consult_declared_source",
  ) => ({
    id,
    nativeId: id,
    name: id,
    kind: mechanism ? "action" as const : "decision" as const,
    ...(mechanism ? { mechanism } : {}),
    assertions: [],
    source,
    inputs: [],
    outputs: [],
  });
  flow.nodes.push(
    node("choose", "choose_move"),
    node("command", "execute_operator_command"),
  );
  for (let i = 0; i < consultations; i++) {
    const id = `consult${i}`, outcome = `outcome${i}`;
    flow.nodes.push(node(id, "consult_declared_source"), node(outcome));
    flow.edges.push(...[
      { id: `${id}-outcome`, source: id, target: outcome },
      {
        id: `${id}-success`,
        source: outcome,
        target: "choose",
        guard: `${id}.consultation.succeeded`,
      },
      {
        id: `${id}-failure`,
        source: outcome,
        target: "command",
        guard: "else",
      },
    ].map((edge) => ({
      ...edge,
      nativeId: edge.id,
      guardIds: [],
      sourceEvidence: source,
    })));
  }
  return flow;
}

Deno.test("operator-command consultation is optional and each declared read has its own outcome", () => {
  for (const count of [0, 1, 2]) {
    validateOperatorCommandFlow(commandFlow(count));
  }
});

for (const bypass of ["choose", "done", "gate", "outcome0"]) {
  Deno.test(`declared consultation path through ${bypass} requires its own outcome`, () => {
    const flow = commandFlow(1);
    const outcome = flow.nodes.find((node) => node.id === "outcome0")!;
    flow.nodes.push({ ...outcome, id: "gate", nativeId: "gate", name: "gate" });
    if (bypass === "done") {
      flow.nodes.push({
        ...outcome,
        id: "done",
        nativeId: "done",
        kind: "done",
      });
    }
    flow.edges.find((edge) => edge.source === "consult0")!.target = "gate";
    for (
      const [suffix, target, guard] of [
        ["checked", "outcome0", "record.busy"],
        ["other", bypass, "else"],
      ]
    ) {
      flow.edges.push({
        ...flow.edges[0]!,
        id: `gate-${suffix}`,
        nativeId: `gate-${suffix}`,
        source: "gate",
        target,
        guard,
      });
    }
    if (bypass === "outcome0") {
      // Converging paths are not a pre-outcome cycle.
      validateOperatorCommandFlow(flow);
    } else {
      throws(() => validateOperatorCommandFlow(flow), (error: unknown) => {
        const refusal = error as { code: string; context: { nodeId: string } };
        deepStrictEqual(refusal.code, "OPERATOR_FLOW_INVALID");
        deepStrictEqual(refusal.context.nodeId, "consult0");
        return true;
      });
    }
  });
}

Deno.test("operator-command refuses each missing outcome and retains required command primitives", () => {
  for (const suffix of ["success", "failure"]) {
    const flow = commandFlow(2);
    flow.edges = flow.edges.filter((edge) => edge.id !== `consult1-${suffix}`);
    throws(() => validateOperatorCommandFlow(flow), (error: unknown) => {
      const refusal = error as Error & {
        code: string;
        context: { nodeId: string };
        recovery: string;
      };
      deepStrictEqual(refusal.code, "OPERATOR_FLOW_INVALID");
      deepStrictEqual(refusal.context.nodeId, "consult1");
      deepStrictEqual(typeof refusal.recovery, "string");
      return /explicit native success and failure branches/.test(
        refusal.message,
      );
    });
  }
  for (const mechanism of ["choose_move", "execute_operator_command"]) {
    const flow = commandFlow();
    flow.nodes = flow.nodes.filter((node) => node.mechanism !== mechanism);
    throws(
      () => validateOperatorCommandFlow(flow),
      new RegExp(`requires one ${mechanism}`),
    );
  }
});
