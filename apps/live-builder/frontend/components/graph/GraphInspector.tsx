import type { ComponentChildren } from "preact";
import {
  display,
  isControl,
  isDefinition,
  isItem,
  isPort,
  mandateScopeForView,
} from "../../lib/graph/projection.ts";
import type { GraphEdge, GraphNode } from "../../lib/graph/types.ts";
import {
  DiagramModel,
  edgeLabels,
  stageLabels,
} from "../../lib/graph/view-model.ts";

function Values({ values }: { values: string[] }) {
  return (
    <ul>
      {values.map((value, index) => <li key={`${index}:${value}`}>{value}</li>)}
    </ul>
  );
}
function Evidence({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <p class="graph-evidence">
      {label}
      <br />
      <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
    </p>
  );
}
export function OperatorDetails(
  { model, node: original }: { model: DiagramModel; node: GraphNode },
) {
  let node = original;
  if (node.category === "view") {
    const plan = model.viewPlan,
      group = plan?.groups.find((group) => group.view.id === node.id);
    const scope = plan && group
      ? mandateScopeForView(group, plan, model.nodes, model.graph.edges)
      : null;
    if (scope) node = scope.holder;
  }
  const operator = model.operator(node);
  if (!operator) return null;
  const mandate = model.mandate(node);
  const names = operator.depictedJudgmentRefs.map((id) =>
    model.graph.nodes.find((candidate) => candidate.nativeId === id)
  ).filter(Boolean).map(display);
  const bindings = (operator.capabilityBindings || []).filter((binding) =>
    binding.evidenceLevel === "configured" &&
    Array.isArray(binding.sourceRefs) && binding.sourceRefs.length &&
    ["may-propose", "may-invoke"].includes(binding.relationship) &&
    (binding.relationship !== "may-invoke" ||
      model.graph.nodes.some((candidate) =>
        candidate.nativeId === binding.nativeId &&
        candidate.runtimeStage === "active"
      ))
  );
  const network = mandate?.networkScope;
  return (
    <>
      <h3>Represented judgment</h3>
      <p>{operator.roleLabel || display(node)} · {names.join(", ")}</p>
      <details>
        <summary>Native allocations</summary>
        <Values values={operator.depictedJudgmentRefs} />
      </details>
      {mandate
        ? (
          <>
            <h3>Configured mandate</h3>
            <p>
              <b>{mandate.scopeLabel}</b>
            </p>
            <p>
              <code>{mandate.id} · version {mandate.version}</code>
            </p>
            <h3>Delegated choices</h3>
            <Values values={mandate.allowedChoices} />
            <h3>Limits</h3>
            <Values values={mandate.limits || []} />
            <p>
              Operator granting the mandate:{" "}
              {mandate.grantingOperator === "unknown"
                ? "not documented"
                : mandate.grantingOperator || "not documented"}
            </p>
            <details>
              <summary>Sources · configuration evidence</summary>
              <Evidence label="Native element" value={mandate.nativeId} />
              <Evidence label="Holder" value={mandate.holderNativeId} />
              <Values values={mandate.sourceRefs} />
            </details>
          </>
        )
        : <p class="graph-muted">mandate not documented in this projection</p>}
      <h3>Documented authorizations</h3>
      {bindings.length
        ? bindings.map((binding, index) => (
          <div key={`${index}:${binding.nativeId}`}>
            <p>
              <b>
                {binding.relationship === "may-propose"
                  ? "May propose"
                  : "May invoke"} · {binding.name || binding.kind}
              </b>
            </p>
            <details>
              <summary>Configuration</summary>
              <code>{binding.nativeId || ""}</code>
              <Values values={binding.sourceRefs} />
            </details>
          </div>
        ))
        : (
          <p class="graph-muted">
            No capability authorization documented in this projection.
          </p>
        )}
      <h3>Network scope</h3>
      {network && Array.isArray(network.allowedHosts) &&
          Array.isArray(network.sourceRefs) && network.sourceRefs.length
        ? (
          <>
            {network.allowedHosts.length
              ? <Values values={network.allowedHosts} />
              : <p>No allowed domain.</p>}
            <details>
              <summary>Native configuration evidence</summary>
              <Values values={network.sourceRefs} />
            </details>
          </>
        )
        : (
          <p class="graph-muted">
            Network scope not verified in this projection.
          </p>
        )}
    </>
  );
}
export interface GraphSelection {
  id: string;
  isEdge: boolean;
}
export function GraphInspector(
  { model, selection, digest, onSelect, onClose }: {
    model: DiagramModel;
    selection: GraphSelection;
    digest: string;
    onSelect(id: string, center?: boolean): void;
    onClose(): void;
  },
) {
  const record = selection.isEdge
    ? model.edges.find((edge) => edge.id === selection.id)
    : model.map.get(selection.id);
  if (!record) return null;
  const node = selection.isEdge ? null : record as GraphNode,
    edge = selection.isEdge ? record as GraphEdge : null;
  const visible = new Set(model.nodes.map((node) => node.id));
  const relations = model.graph.edges.filter((edge) =>
    (edge.source === selection.id || edge.target === selection.id) &&
    visible.has(edge.source) && visible.has(edge.target)
  );
  const type = edge
    ? edge.displayOnly
      ? "configured right · presentation"
      : edge.projection
      ? "native connection projection"
      : "relationship"
    : node?.category || node?.kind;
  const fields: Array<[string, unknown]> = [
    [
      record.displayOnly ? "Presentation identity" : "Native identity",
      record.nativeId || record.id,
    ],
    ["Native parent", node?.parentId],
    ["Native owner namespace", node?.ownerNativeId],
    ["Native exposures", node?.viewMembers],
    ["State role", node?.stateRole],
    ["State role source", node?.stateRoleSourceId],
    ["Metaclass", record.metaclass || record.kind],
    ["Context", node?.contextPath],
    ["Symbol", node?.symbol],
    ["Declared direction", node?.declaredDirection],
    ["Conjugated port", node?.conjugated ? "yes" : undefined],
    ["Conjugation evidence", node?.conjugationSourceIds],
    ["Effective direction", node?.effectiveDirection],
    ["Applied conjugation", node?.directionConjugationIds],
    ["Read projection", record.projection],
    ["Projection", digest],
  ];
  let ports: ComponentChildren = null;
  if (node && isPort(node)) {
    const payloads = model.nodes.filter((child) =>
      child.parentId === node.id && isItem(child) && !isDefinition(child)
    );
    if (payloads.length) {
      ports = (
        <>
          <h3>Port contract</h3>
          {payloads.map((child) => (
            <div key={child.id}>
              <button
                type="button"
                class="graph-relation"
                onClick={() => onSelect(child.id, true)}
              >
                {display(child)}
                {model.type(child) ? ` : ${model.type(child)}` : ""}
              </button>
              {(child.effectiveDirection || child.declaredDirection) && (
                <p>
                  Direction{" "}
                  {child.effectiveDirection ? "effective" : "declared"} :{" "}
                  <b>{child.effectiveDirection || child.declaredDirection}</b>
                </p>
              )}
            </div>
          ))}
        </>
      );
    }
  }
  return (
    <aside class="graph-inspector" aria-label="Model inspector">
      <button
        type="button"
        class="graph-close"
        aria-label="Close inspector"
        onClick={onClose}
      >
        ×
      </button>
      <h2>
        {edge
          ? edge.label || edgeLabels[edge.kind] || edge.kind
          : display(node!)}
      </h2>
      <div class="graph-badges">
        <span>{node && isControl(node) ? "flow control" : type}</span>
        <span>{record.kind || record.metaclass}</span>
        {node && (
          <>
            <span>{isDefinition(node) ? "definition" : "usage"}</span>
            {model.type(node) && <span>Type: {model.type(node)}</span>}
          </>
        )}
      </div>
      {Boolean(record.projection) && (
        <p class="graph-muted">
          Declared connection between ports, projected here onto their owning
          parts.
        </p>
      )}
      {node?.observedState && (
        <>
          <h3>State observed by host</h3>
          <p>Current state matched to the native context of this candidate.</p>
          <pre>{JSON.stringify(node.runtimeStateEvidence || {}, null, 2)}</pre>
        </>
      )}
      {node?.runtimeStage && (
        <p>
          Executed catalog state:{" "}
          <b>{stageLabels[node.runtimeStage] || node.runtimeStage}</b>
        </p>
      )}
      {node?.modelStage && (
        <p>
          Native model state:{" "}
          <b>{stageLabels[node.modelStage] || node.modelStage}</b>
        </p>
      )}
      {record.description && <p>{record.description}</p>}
      {record.guard && (
        <p>
          Guard: <code>{record.guard}</code>
        </p>
      )}
      {node && model.allocationLabels(node).length > 0 && (
        <p>Declared allocation: {model.allocationLabels(node).join(", ")}</p>
      )}
      {node && <OperatorDetails model={model} node={node} />}
      {ports}
      <details open>
        <summary>
          {record.displayOnly ? "Configuration evidence" : "Model evidence"}
        </summary>
        {fields.map(([label, value]) => (
          <Evidence key={label} label={label} value={value} />
        ))}
        {Boolean(record.sourceEvidence) && (
          <pre>{JSON.stringify(record.sourceEvidence, null, 2)}</pre>
        )}
      </details>
      <h3>Native relationships</h3>
      {relations.map((edge) => {
        const target = edge.source === selection.id ? edge.target : edge.source,
          other = model.map.get(target);
        return other && (
          <button
            key={edge.id}
            type="button"
            class="graph-relation"
            onClick={() => onSelect(target, true)}
          >
            {edge.source === selection.id ? "→ " : "← "}
            {edgeLabels[edge.kind] || edge.kind}
            {edge.guard ? ` [${edge.guard}]` : ""} · {display(other)}
          </button>
        );
      })}
      {edge && (
        <p>
          <code>{edge.source} → {edge.target}</code>
        </p>
      )}
    </aside>
  );
}
