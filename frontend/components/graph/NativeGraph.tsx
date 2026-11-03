import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { GraphController } from "../../lib/graph/controller.ts";
import {
  bindLiveSource,
  createLiveSync,
  graphSource,
  type LiveSource,
  type LiveStatus,
  parseGraphSnapshot,
} from "../../lib/graph/live.ts";
import type { GraphNode, GraphSnapshot } from "../../lib/graph/types.ts";
import {
  display,
  isDefinition,
  terminalIds,
} from "../../lib/graph/projection.ts";
import {
  defaultDiagramOptions,
  DiagramModel,
  type DiagramOptions,
  emptyGraph,
  viewLabels,
  viewNames,
} from "../../lib/graph/view-model.ts";
import { GraphInspector, type GraphSelection } from "./GraphInspector.tsx";
import { SequenceFeed } from "./SequenceFeed.tsx";
import {
  LEGACY_NATIVE_GRAPH_OPTIONS_KEY,
  NATIVE_GRAPH_OPTIONS_KEY,
  readBrowserPreference,
} from "../../lib/browser/preferences.ts";

const emptyText = {
  "action-flow": [
    "No native action flow to show",
    "This view needs a performed behavior and successions declared in the model.",
  ],
  interconnection: [
    "No structure declared",
    "This view shows the parts, their ports and their items.",
  ],
  general: [
    "No elements to show",
    "Change the filter to view the other elements of the model.",
  ],
  "state-transition": [
    "No native state declared",
    "States and transitions will appear once they are declared in the model.",
  ],
  requirements: [
    "No requirement declared",
    "This table shows the native requirements and their satisfaction relationships.",
  ],
  sequence: [
    "No sequence declared",
    "No sequence exchange is declared in the model.",
  ],
};
function loadOptions(): DiagramOptions {
  const options = defaultDiagramOptions();
  try {
    const saved: Partial<DiagramOptions> = JSON.parse(
      readBrowserPreference(
        () => sessionStorage,
        NATIVE_GRAPH_OPTIONS_KEY,
        LEGACY_NATIVE_GRAPH_OPTIONS_KEY,
      ) || "{}",
    );
    if (saved.view && viewNames.includes(saved.view)) options.view = saved.view;
    if (
      saved.filter &&
      ["usages", "definitions", "definitions-only", "constraints"].includes(
        saved.filter,
      )
    ) options.filter = saved.filter;
    options.sequenceId = saved.sequenceId || null;
    options.flowScopeId = saved.flowScopeId || null;
  } catch {
    /* Storage is optional; SSR always uses a deterministic default. */
  }
  return options;
}
function ModelBrowser(
  { model, selectedId, onSelect }: {
    model: DiagramModel;
    selectedId?: string;
    onSelect(id: string): void;
  },
) {
  const nodes = model.nodes.filter((node) => !isDefinition(node)),
    ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const parent = ids.has(node.parentId || "") ? node.parentId! : "";
    children.set(parent, [...(children.get(parent) || []), node]);
  }
  const seen = new Set<string>();
  const item = (node: GraphNode) => {
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    return (
      <li key={node.id}>
        <button
          type="button"
          class={selectedId === node.id ? "current" : undefined}
          onClick={() => onSelect(node.id)}
        >
          {display(node)}
          <small>{node.category || node.kind}</small>
        </button>
        {children.get(node.id)?.length
          ? <ul>{children.get(node.id)!.map(item)}</ul>
          : null}
      </li>
    );
  };
  const definitions = model.graph.nodes.filter(isDefinition);
  return (
    <nav class="graph-browser" aria-label="Native element tree">
      {Boolean(model.graph.diagnostics?.length) && (
        <details>
          <summary class="graph-error">
            Projection limits · {model.graph.diagnostics!.length}
          </summary>
          <ul>
            {model.graph.diagnostics!.map((diagnostic, index) => (
              <li key={index}>{diagnostic}</li>
            ))}
          </ul>
        </details>
      )}
      <h3>Native usages</h3>
      <ul>{(children.get("") || []).map(item)}</ul>
      <details>
        <summary>Definitions · {definitions.length}</summary>
        <ul>{definitions.map(item)}</ul>
      </details>
      {Boolean(model.graph.views?.length) && (
        <>
          <h3>Native views</h3>
          <ul>
            {model.graph.views!.map((view) => (
              <li key={view.id}>
                <button
                  type="button"
                  onClick={() => onSelect(view.id)}
                >
                  «view» {view.label}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </nav>
  );
}
export function NativeGraph({ source }: { source: string }) {
  const endpoint = graphSource(source);
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [status, setStatus] = useState<LiveStatus>({
    connected: false,
    stale: true,
    message: "Connecting",
  });
  const [options, setOptions] = useState(defaultDiagramOptions);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [controllerReady, setControllerReady] = useState(false);
  const container = useRef<HTMLDivElement>(null),
    controller = useRef<GraphController | null>(null);
  const digest = useRef("");
  const activityDigest = useRef("");
  // Journal updates refresh the feed without rebuilding a native diagram.
  const nativeGraph = useMemo(
    () => snapshot?.graph || emptyGraph,
    [snapshot?.projectionDigest],
  );
  const model = useMemo(
    () => new DiagramModel(nativeGraph, options),
    [nativeGraph, options],
  );
  const previousOptions = useRef<DiagramOptions | null>(null);
  function update(patch: Partial<DiagramOptions>) {
    setOptions((previous) => ({ ...previous, ...patch }));
  }
  function select(id: string, center = false) {
    setSelection({ id, isEdge: false });
    controller.current?.select(id, center);
  }
  useEffect(() => {
    setOptions(loadOptions());
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        NATIVE_GRAPH_OPTIONS_KEY,
        JSON.stringify({
          view: options.view,
          filter: options.filter,
          sequenceId: options.sequenceId,
          flowScopeId: options.flowScopeId,
        }),
      );
    } catch { /* optional storage */ }
  }, [options]);
  useEffect(() => {
    let disposed = false;
    void import("../../lib/graph/controller.ts").then(({ GraphController }) => {
      if (disposed || !container.current) return;
      controller.current = new GraphController(
        container.current,
        (id, isEdge) => setSelection({ id, isEdge }),
      );
      setControllerReady(true);
    }).catch((error) => {
      if (!disposed) {
        setStatus({
          connected: false,
          stale: true,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return () => {
      disposed = true;
      controller.current?.destroy();
      controller.current = null;
    };
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    digest.current = "";
    activityDigest.current = "";
    setSnapshot(null);
    setSelection(null);
    const sync = createLiveSync({
      readState: async () => {
        const response = await fetch(endpoint.path, {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as {
            error?: string;
          };
          throw new Error(data.error || "Model read unavailable");
        }
        return parseGraphSnapshot(await response.json());
      },
      getDigest: () => digest.current,
      getActivityDigest: () => activityDigest.current,
      applyState: (fresh, changed) => {
        if (changed) {
          digest.current = fresh.projectionDigest;
          activityDigest.current = fresh.activityDigest || "";
          setSnapshot(fresh);
        }
      },
      onStatus: setStatus,
    });
    let source: EventSource | null = null;
    if (endpoint.historical) void sync.open();
    else {
      source = new EventSource("/api/model-events");
      const events = source;
      const adapter: LiveSource = {
        addEventListener: (type, listener) =>
          events.addEventListener(
            type,
            (event) => listener({ data: (event as MessageEvent<string>).data }),
          ),
        get onopen() {
          return null;
        },
        set onopen(listener) {
          events.onopen = listener;
        },
        get onerror() {
          return null;
        },
        set onerror(listener) {
          events.onerror = listener;
        },
      };
      bindLiveSource(adapter, sync);
      void sync.request();
    }
    return () => {
      sync.dispose();
      abort.abort();
      source?.close();
    };
  }, [endpoint.path, endpoint.historical]);
  useEffect(() => {
    if (!controllerReady) return;
    const preserve = previousOptions.current === options;
    controller.current?.render(model, preserve);
    previousOptions.current = options;
    setSelection((previous) =>
      previous &&
        (previous.isEdge
          ? model.edges.some((edge) => edge.id === previous.id)
          : model.map.has(previous.id))
        ? previous
        : null
    );
  }, [model, controllerReady]);
  useEffect(() => {
    controller.current?.resize();
  }, [browserOpen, selection?.id]);
  const flows = model.flowScopes,
    scaffold = model.scaffold,
    states = model.stateScopes;
  const hasElements = options.view === "sequence" ||
    model.visibleNodes.length > 0;
  const canvasVisible = hasElements &&
    !["requirements", "sequence"].includes(options.view);
  const version = snapshot?.version || "";
  const history = snapshot?.history;
  const historyLabel = history
    ? history.modelVersion
      ? `Model revision ${history.modelVersion}`
      : `Revision ${history.revision} recorded`
    : "Current model";
  const note = options.view === "action-flow"
    ? `${
      model.flowScope
        ? display(model.flowScope.scope)
        : "No native action flow available"
    } · native actions and guards · select an element for its native identity`
    : options.view === "interconnection"
    ? "Native parts and ports · declared contracts and bindings · conversation frame: native context"
    : options.view === "state-transition"
    ? scaffold.mode === "library"
      ? "Definition canvas · no observed execution state"
      : "States and transitions declared in the model"
    : "Native exposures and allocations · configured rights kept separate";
  return (
    <div
      class="native-graph"
      id="model-graph"
      data-model-source={endpoint.path}
    >
      <div class="graph-toolbar">
        <p
          class={`graph-status${status.stale ? " stale" : ""}`}
          role="status"
          title={(snapshot?.graph.diagnostics || []).join("\n")}
        >
          {historyLabel}
          {version ? ` · snapshot ${version.slice(0, 8)}` : ""} ·{" "}
          {model.nodes.length}{" "}
          elements{endpoint.historical ? " · read-only" : ""}
          {status.stale ? ` · snapshot not refreshed · ${status.message}` : ""}
          {snapshot?.projectionDigestScope === "legacy-with-activity"
            ? " · historical fingerprint including activity"
            : ""}
          {snapshot?.graph.diagnostics?.length
            ? ` · ${snapshot.graph.diagnostics.length} projection limits`
            : ""}
        </p>
        <div class="graph-tabs" role="group" aria-label="SysML v2 views">
          {viewNames.map((view) => (
            <button
              key={view}
              type="button"
              aria-pressed={options.view === view}
              onClick={() => update({ view })}
            >
              {viewLabels[view]}
            </button>
          ))}
        </div>
        <div class="graph-controls">
          <button
            type="button"
            aria-expanded={browserOpen}
            onClick={() => setBrowserOpen(!browserOpen)}
          >
            Model
          </button>
          {options.view === "general" && (
            <label>
              Show{" "}
              <select
                value={options.filter}
                onChange={(event) =>
                  update({
                    filter: event.currentTarget
                      .value as DiagramOptions["filter"],
                  })}
              >
                <option value="usages">Overview</option>
                <option value="definitions">Usages and definitions</option>
                <option value="definitions-only">Definitions only</option>
                <option value="constraints">Constraints</option>
              </select>
            </label>
          )}
          {options.view === "action-flow" && (
            <label>
              <input
                type="checkbox"
                checked={options.showData}
                onChange={(event) =>
                  update({ showData: event.currentTarget.checked })}
              />Declared data flows
            </label>
          )}
          {options.view === "general" && options.filter === "usages" && (
            <label>
              <input
                type="checkbox"
                checked={options.showAllocated}
                onChange={(event) =>
                  update({ showAllocated: event.currentTarget.checked })}
              />Allocated actions and outputs
            </label>
          )}
          {terminalIds(model.graph.nodes).size > 0 && (
            <label>
              <input
                type="checkbox"
                checked={options.showTerminal}
                onChange={(event) =>
                  update({ showTerminal: event.currentTarget.checked })}
              />Finished candidates
            </label>
          )}
          {options.view === "action-flow" && flows.length > 1 && (
            <label>
              Behavior{" "}
              <select
                value={model.flowScope?.scope.id || ""}
                onChange={(event) =>
                  update({ flowScopeId: event.currentTarget.value })}
              >
                {flows.map((entry) => (
                  <option key={entry.scope.id} value={entry.scope.id}>
                    {display(entry.scope)}
                    {entry.typeName ? ` : ${entry.typeName}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
          {["state-transition", "requirements"].includes(options.view) &&
            scaffold.library.length > 0 && (
            <label>
              Source{" "}
              <select
                value={scaffold.mode}
                onChange={(event) =>
                  update({
                    scaffoldMode: event.currentTarget.value as
                      | "instances"
                      | "library",
                    stateScopeId: null,
                  })}
              >
                <option value="instances">Usages</option>
                <option value="library">Definitions · canvas</option>
              </select>
            </label>
          )}
          {options.view === "state-transition" && states.length > 1 && (
            <label>
              Cycle{" "}
              <select
                value={model.stateScope?.id || ""}
                onChange={(event) =>
                  update({ stateScopeId: event.currentTarget.value })}
              >
                {states.map((node) => (
                  <option key={node.id} value={node.id}>{display(node)}</option>
                ))}
              </select>
            </label>
          )}
          {canvasVisible && (
            <>
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => controller.current?.zoom(.8)}
              >
                −
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => controller.current?.zoom(1.25)}
              >
                +
              </button>
              <button type="button" onClick={() => controller.current?.fit()}>
                Recenter
              </button>
            </>
          )}
        </div>
        <div class="graph-legend">
          {options.view === "sequence"
            ? "Recorded messages and events · receipts available to view"
            : options.view === "general"
            ? "Part · native allocation · declared output · authorized call = configuration · dashed ochre frame: mandate scope"
            : options.view === "action-flow"
            ? "Native action · → succession · declared [guard]"
            : options.view === "state-transition"
            ? "Native state · → declared transition"
            : options.view === "requirements"
            ? "Native requirements · declared satisfaction · execution proof kept separate"
            : "Part · port on the edge · item / data"}
        </div>
      </div>
      <div class="graph-body">
        {browserOpen && (
          <ModelBrowser
            model={model}
            selectedId={selection?.id}
            onSelect={(id) => select(id, true)}
          />
        )}
        <div class="graph-stage">
          <div
            class="graph-canvas"
            ref={container}
            hidden={!canvasVisible}
            role="img"
            aria-label={`SysML graph · ${viewLabels[options.view]}`}
          />
          {!snapshot
            ? (
              <div class="graph-placeholder">
                <h3>
                  {status.stale && status.message !== "Connecting" &&
                      status.message !== "Refreshing"
                    ? "Model unavailable"
                    : "Loading model…"}
                </h3>
                <p>{status.message}</p>
              </div>
            )
            : !hasElements
            ? (
              <div class="graph-placeholder">
                <h3>{emptyText[options.view][0]}</h3>
                <p>{emptyText[options.view][1]}</p>
              </div>
            )
            : options.view === "requirements"
            ? (
              <div class="graph-table">
                <p>
                  {scaffold.mode === "library"
                    ? "Native definitions canvas · no instance or execution satisfaction asserted."
                    : "Satisfaction declared in the model. The execution proof can be viewed separately in the conversation."}
                </p>
                <table>
                  <thead>
                    <tr>
                      <th>Requirement</th>
                      <th>Text</th>
                      <th>Component · declared satisfaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {model.visibleNodes.map((node) => (
                      <tr key={node.id}>
                        <td>
                          <button
                            type="button"
                            onClick={() => select(node.id)}
                          >
                            {display(node)}
                          </button>
                        </td>
                        <td>{node.description}</td>
                        <td>
                          {model.graph.edges.filter((edge) =>
                            ["satisfy", "satisfies"].includes(edge.kind) &&
                            edge.target === node.id
                          ).map((edge) => (
                            <button
                              key={edge.id}
                              type="button"
                              onClick={() => select(edge.source)}
                            >
                              {display(model.map.get(edge.source)) ||
                                edge.source}
                            </button>
                          ))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
            : options.view === "sequence"
            ? (
              <SequenceFeed
                graph={snapshot.graph}
                history={snapshot.history}
                readOnly={endpoint.historical}
              />
            )
            : null}
          {canvasVisible && <p class="graph-note">{note}</p>}
        </div>
        {selection && options.view !== "sequence" && (
          <GraphInspector
            model={model}
            selection={selection}
            digest={snapshot?.projectionDigest || ""}
            onSelect={select}
            onClose={() => {
              setSelection(null);
              controller.current?.clearSelection();
            }}
          />
        )}
      </div>
    </div>
  );
}
