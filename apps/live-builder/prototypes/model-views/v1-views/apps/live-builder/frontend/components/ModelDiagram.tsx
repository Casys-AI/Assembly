import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import ElkApi from "elkjs/lib/elk-api.js";
import * as elkWorker from "elkjs/lib/elk-worker.min.js";
import type {
  ModelDiagramNode,
  ModelView,
} from "../../src/domain/model-views.ts";
import {
  buildDiagram,
  defaultFolds,
  type ElkNode,
  type FontRole,
  header,
  keyword,
  METRICS,
  roundedPath,
  type Scene,
  type SceneEdge,
  type SceneNode,
  sceneOf,
  sections,
  splitLabel,
} from "../lib/model-diagram-layout.ts";

const FONTS: Record<FontRole, string> = {
  stereo: "500 10px var-font",
  name: "600 12.5px var-font",
  type: "400 12.5px var-font",
  sect: "italic 400 10px var-font",
  row: "400 11.5px var-font",
  port: "500 10.5px var-font",
  edge: "400 10.5px var-font",
  note: "400 11px var-font",
  ctl: "500 10.5px var-font",
};

function textMeasure() {
  const context = document.createElement("canvas").getContext("2d")!;
  const family = getComputedStyle(document.documentElement)
    .getPropertyValue("--font").trim() || "system-ui, sans-serif";
  return (text: string, role: FontRole) => {
    context.font = FONTS[role].replace("var-font", family);
    return context.measureText(text).width;
  };
}

/** Edge kinds that would crowd the first picture; one click shows them. */
const QUIET_KINDS = new Set(["binding", "note"]);

const MARKERS: Record<string, { end?: string; start?: string }> = {
  succession: { end: "md-arrow" },
  transition: { end: "md-arrow" },
  allocation: { end: "md-arrow" },
  satisfy: { end: "md-arrow" },
  specialization: { end: "md-triangle" },
  typing: { end: "md-triangle" },
  composition: { start: "md-diamond" },
  membership: { start: "md-member" },
};

interface Viewport {
  k: number;
  x: number;
  y: number;
}

interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}
// The bundled elkjs build reaches for Node's `web-worker`; the API with its
// in-thread worker stays browser-only. Both are CommonJS without usable typings.
type ElkWorkerConstructor = new (url?: string) => unknown;
const workerExports = elkWorker as unknown as {
  Worker?: ElkWorkerConstructor;
  default?: { Worker?: ElkWorkerConstructor };
};
const ElkWorker = workerExports.Worker ?? workerExports.default?.Worker;
const Elk = ElkApi as unknown as new (options: {
  workerFactory: (url?: string) => unknown;
}) => ElkEngine;
let elk: ElkEngine | undefined;

export function ModelDiagram({ view }: { view: ModelView }) {
  const [folded, setFolded] = useState(() =>
    defaultFolds(view.kind, view.diagram)
  );
  const [hidden, setHidden] = useState(() => new Set(QUIET_KINDS));
  const [scene, setScene] = useState<Scene | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; from: Viewport } | null>(null);

  useEffect(() => {
    setFolded(defaultFolds(view.kind, view.diagram));
    setSelected(null);
    setViewport(null);
  }, [view.id]);

  useEffect(() => {
    let current = true;
    const model = buildDiagram(
      view.kind,
      view.diagram,
      { folded, hiddenKinds: hidden },
      textMeasure(),
    );
    elk ??= new Elk({ workerFactory: (url) => new ElkWorker!(url) });
    elk.layout(model.graph).then((laid) => {
      if (current) {
        setScene(sceneOf(model, laid));
        setError(null);
      }
    }).catch((reason: unknown) => {
      if (current) setError(String(reason));
    });
    return () => {
      current = false;
    };
  }, [view, folded, hidden]);

  const fit = () => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !scene) return;
    const margin = 32;
    const k = Math.min(
      (box.width - 2 * margin) / Math.max(scene.width, 1),
      (box.height - 2 * margin) / Math.max(scene.height, 1),
      1.25,
    );
    setViewport({
      k,
      x: (box.width - scene.width * k) / 2,
      y: (box.height - scene.height * k) / 2,
    });
  };
  useEffect(() => {
    if (scene && !viewport) fit();
  }, [scene]);

  const parents = useMemo(
    () => new Map(view.diagram.nodes.map((n) => [n.id, n.parent])),
    [view],
  );
  const within = (id: string, root: string) => {
    for (let at: string | undefined = id; at; at = parents.get(at)) {
      if (at === root) return true;
    }
    return false;
  };
  const focus = selected ?? hover;
  const related = useMemo(() => {
    if (!focus || !scene) return null;
    const owner = new Map(scene.ports.map((p) => [p.id, p.owner]));
    const inFocus = (end: string) => within(owner.get(end) ?? end, focus);
    const edges = new Set<string>();
    const nodes = new Set<string>();
    for (const e of scene.edges) {
      if (inFocus(e.source) || inFocus(e.target)) {
        edges.add(e.id);
        for (const end of [e.source, e.target]) {
          nodes.add(end);
          const o = owner.get(end);
          if (o) nodes.add(o);
        }
      }
    }
    for (const n of scene.nodes) if (within(n.id, focus)) nodes.add(n.id);
    return { edges, nodes };
  }, [focus, scene]);

  const kinds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of view.diagram.edges) {
      counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    }
    const notes = view.diagram.nodes.filter((n) => n.kind === "note").length;
    if (notes) counts.set("note", notes);
    return [...counts];
  }, [view]);

  const zoom = (factor: number, cx?: number, cy?: number) => {
    if (!viewport) return;
    const box = frame.current!.getBoundingClientRect();
    const x = cx ?? box.width / 2, y = cy ?? box.height / 2;
    const k = Math.max(0.15, Math.min(3, viewport.k * factor));
    setViewport({
      k,
      x: x - ((x - viewport.x) * k) / viewport.k,
      y: y - ((y - viewport.y) * k) / viewport.k,
    });
  };
  const onWheel = (event: JSX.TargetedWheelEvent<HTMLDivElement>) => {
    if (!viewport) return;
    event.preventDefault();
    const box = frame.current!.getBoundingClientRect();
    if (event.ctrlKey || event.metaKey) {
      zoom(
        Math.exp(-event.deltaY * 0.01),
        event.clientX - box.left,
        event.clientY - box.top,
      );
    } else {
      setViewport({
        ...viewport,
        x: viewport.x - event.deltaX,
        y: viewport.y - event.deltaY,
      });
    }
  };
  const onPointerDown = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest(".md-node, .md-port") || !viewport) {
      return;
    }
    drag.current = { x: event.clientX, y: event.clientY, from: viewport };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setViewport({
      ...d.from,
      x: d.from.x + event.clientX - d.x,
      y: d.from.y + event.clientY - d.y,
    });
  };
  const onPointerUp = (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (
      d && Math.abs(event.clientX - d.x) + Math.abs(event.clientY - d.y) < 3
    ) setSelected(null);
  };
  const toggleFold = (node: SceneNode) => {
    const hasChildren = view.diagram.nodes.some((n) =>
      n.parent === node.id && n.kind !== "port"
    );
    if (!hasChildren) return;
    const next = new Set(folded);
    next.has(node.id) ? next.delete(node.id) : next.add(node.id);
    setFolded(next);
  };

  const selectedNode = selected
    ? view.diagram.nodes.find((n) => n.id === selected)
    : undefined;

  return (
    <div class="md">
      <div class="md-toolbar">
        {kinds.length > 1 && (
          <div class="md-chips" role="group" aria-label="Relationships">
            {kinds.map(([kind, count]) => (
              <button
                type="button"
                key={kind}
                aria-pressed={!hidden.has(kind)}
                onClick={() => {
                  const next = new Set(hidden);
                  next.has(kind) ? next.delete(kind) : next.add(kind);
                  setHidden(next);
                }}
              >
                {kind}
                <span>{count}</span>
              </button>
            ))}
          </div>
        )}
        <div class="md-tools">
          <button type="button" onClick={fit} title="Fit">Fit</button>
          <button type="button" onClick={() => zoom(1.25)} title="Zoom in">
            +
          </button>
          <button type="button" onClick={() => zoom(0.8)} title="Zoom out">
            −
          </button>
        </div>
      </div>
      <div
        class="md-canvas"
        ref={frame}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {error && <p class="md-error" role="alert">{error}</p>}
        {scene && viewport && (
          <svg
            class={related ? "md-focus" : ""}
            role="img"
            aria-label={`${view.title} diagram`}
          >
            <defs>
              <marker
                id="md-arrow"
                viewBox="0 0 12 10"
                markerWidth="12"
                markerHeight="10"
                refX="11"
                refY="5"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <path d="M1,1 L11,5 L1,9" class="md-mark-line" />
              </marker>
              <marker
                id="md-triangle"
                viewBox="0 0 14 12"
                markerWidth="14"
                markerHeight="12"
                refX="13"
                refY="6"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <path d="M1,1 L13,6 L1,11 Z" class="md-mark-hollow" />
              </marker>
              <marker
                id="md-diamond"
                viewBox="0 0 18 10"
                markerWidth="18"
                markerHeight="10"
                refX="1"
                refY="5"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <path d="M1,5 L9,1 L17,5 L9,9 Z" class="md-mark-fill" />
              </marker>
              <marker
                id="md-member"
                viewBox="0 0 12 12"
                markerWidth="12"
                markerHeight="12"
                refX="1"
                refY="6"
                orient="auto-start-reverse"
                markerUnits="userSpaceOnUse"
              >
                <circle cx="6" cy="6" r="5" class="md-mark-hollow" />
                <path d="M3,6 H9 M6,3 V9" class="md-mark-line" />
              </marker>
            </defs>
            <g
              transform={`translate(${viewport.x},${viewport.y}) scale(${viewport.k})`}
            >
              {scene.nodes.map((n) => (
                <NodeShape
                  key={n.id}
                  n={n}
                  selected={n.id === selected}
                  lit={related?.nodes.has(n.id) ?? false}
                  onEnter={() => setHover(n.id)}
                  onLeave={() => setHover(null)}
                  onSelect={() => setSelected(n.id)}
                  onToggle={() => toggleFold(n)}
                />
              ))}
              {scene.edges.map((e) => (
                <EdgeShape key={e.id} e={e} lit={related?.edges.has(e.id)} />
              ))}
              {scene.ports.filter((p) => !p.implicit).map((p) => (
                <g
                  key={p.id}
                  class={`md-port${p.node?.conjugated ? " conjugated" : ""}${
                    related?.nodes.has(p.id) ? " lit" : ""
                  }`}
                  onPointerEnter={() => setHover(p.id)}
                  onPointerLeave={() => setHover(null)}
                  onClick={() => setSelected(p.id)}
                >
                  <title>{p.node?.label}</title>
                  <rect x={p.x} y={p.y} width={p.w} height={p.h} rx="1.5" />
                  {p.label && (
                    <text x={p.label.x + 2} y={p.label.y + 10}>
                      {p.label.text}
                    </text>
                  )}
                </g>
              ))}
            </g>
          </svg>
        )}
      </div>
      {selectedNode && (
        <Inspector
          view={view}
          node={selectedNode}
          onClose={() => setSelected(null)}
          onSelect={setSelected}
        />
      )}
    </div>
  );
}

function NodeShape(
  { n, selected, lit, onEnter, onLeave, onSelect, onToggle }: {
    n: SceneNode;
    selected: boolean;
    lit: boolean;
    onEnter: () => void;
    onLeave: () => void;
    onSelect: () => void;
    onToggle: () => void;
  },
) {
  const { x, y, w, h, node } = n;
  const classes = [
    "md-node",
    n.shape,
    n.compound ? "compound" : "leaf",
    `depth${n.depth}`,
    node.nodeKind === "def" ? "def" : "",
    node.nodeKind === "ref" ? "ref" : "",
    selected ? "selected" : "",
    lit ? "lit" : "",
  ].join(" ");
  const events = {
    onPointerEnter: onEnter,
    onPointerLeave: onLeave,
    onClick: (event: MouseEvent) => {
      event.stopPropagation();
      onSelect();
    },
    onDblClick: onToggle,
  };
  switch (n.shape) {
    case "diamond":
      return (
        <g class={classes} {...events}>
          <path
            class="md-body"
            d={`M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${
              y + h
            } L${x},${y + h / 2} Z`}
          />
          {n.labels.map((l) => (
            <text class="md-ctl" x={l.x} y={l.y + 10}>{l.text}</text>
          ))}
        </g>
      );
    case "bar":
      return (
        <g class={classes} {...events}>
          <rect
            class="md-body md-solid"
            x={x}
            y={y}
            width={w}
            height={h}
            rx="2"
          />
        </g>
      );
    case "initial":
      return (
        <g class={classes} {...events}>
          <circle
            class="md-body md-solid"
            cx={x + w / 2}
            cy={y + h / 2}
            r={w / 2}
          />
        </g>
      );
    case "final":
      return (
        <g class={classes} {...events}>
          <circle class="md-ring" cx={x + w / 2} cy={y + h / 2} r={w / 2} />
          <circle
            class="md-body md-solid"
            cx={x + w / 2}
            cy={y + h / 2}
            r={w / 2 - 4}
          />
        </g>
      );
    case "note":
      return (
        <g class={classes} {...events}>
          <path
            class="md-body"
            d={`M${x},${y} H${x + w - 10} L${x + w},${y + 10} V${
              y + h
            } H${x} Z`}
          />
          <path
            class="md-fold"
            d={`M${x + w - 10},${y} V${y + 10} H${x + w}`}
          />
          {(n.noteLines ?? []).map((line, i) => (
            <text class="md-note" x={x + 12} y={y + 19 + i * 15}>{line}</text>
          ))}
        </g>
      );
    case "frame":
    case "package": {
      const tab = Math.min(w, 220);
      return (
        <g class={classes} {...events}>
          <rect
            class="md-body"
            x={x}
            y={y}
            width={w}
            height={h}
            rx={n.shape === "frame" ? 10 : 2}
          />
          <path
            class="md-tab"
            d={n.shape === "frame"
              ? `M${x + 10},${y} H${x + tab} V${y + 18} Q${x + tab},${y + 26} ${
                x + tab - 8
              },${y + 26} H${x} V${y + 10} Q${x},${y} ${x + 10},${y} Z`
              : `M${x},${y} H${x + tab} V${y + 26} H${x} Z`}
          />
          <text x={x + 12} y={y + 17}>
            <tspan class="md-stereo">{keyword(node)}</tspan>
            <tspan class="md-name" dx="6">{node.label}</tspan>
          </text>
        </g>
      );
    }
    case "pill": {
      const [name, type] = splitLabel(node.label);
      return (
        <g class={classes} {...events}>
          {selected && (
            <rect
              class="md-ring-select"
              x={x - 4}
              y={y - 4}
              width={w + 8}
              height={h + 8}
              rx="16"
            />
          )}
          <rect
            class="md-body"
            x={x}
            y={y}
            width={w}
            height={h}
            rx={Math.min(14, h / 2)}
          />
          <text
            class="md-name"
            x={x + w / 2}
            y={y + (type ? 19 : 20)}
            text-anchor="middle"
          >
            {name}
          </text>
          {type && (
            <text class="md-type" x={x + w / 2} y={y + 35} text-anchor="middle">
              {type}
            </text>
          )}
        </g>
      );
    }
    default:
      return (
        <Block n={n} classes={classes} selected={selected} events={events} />
      );
  }
}

/** Definitions keep square corners and usages are rounded, as in SysML v2. */
function Block(
  { n, classes, selected, events }: {
    n: SceneNode;
    classes: string;
    selected: boolean;
    events: Record<string, unknown>;
  },
) {
  const M = METRICS;
  const { x, y, w, h, node } = n;
  const rx = node.nodeKind === "def" ? 1.5 : 9;
  const head = header(node, () => 0);
  const center = !n.compound;
  const tx = center ? x + w / 2 : x + M.padX;
  const anchor = center ? "middle" : "start";
  let cy = y + M.padTop;
  const lines: JSX.Element[] = [];
  if (head.stereo) {
    lines.push(
      <text class="md-stereo" x={tx} y={cy + 10} text-anchor={anchor}>
        {head.stereo}
      </text>,
    );
    cy += M.stereoH;
  }
  lines.push(
    <text x={tx} y={cy + 13} text-anchor={anchor}>
      <tspan class="md-name">{head.name}</tspan>
      {head.type && <tspan class="md-type">{` ${head.type}`}</tspan>}
    </text>,
  );
  cy += M.nameH + 4;
  if (!n.compound) {
    for (const [section, rows] of sections(node)) {
      lines.push(
        <line class="md-rule" x1={x} x2={x + w} y1={cy + 2} y2={cy + 2} />,
        <text
          class="md-sect"
          x={x + w / 2}
          y={cy + M.sectH}
          text-anchor="middle"
        >
          {section}
        </text>,
      );
      cy += M.sectGap + M.sectH;
      for (const row of rows) {
        lines.push(
          <text class="md-row" x={x + M.padX} y={cy + 11}>{row.label}</text>,
        );
        cy += M.rowH;
      }
    }
  }
  const badge = n.folded ? `+${n.folded}` : "";
  return (
    <g class={classes} {...events}>
      <title>
        {n.folded ? `${node.label} · double-click to unfold` : node.label}
      </title>
      {selected && (
        <rect
          class="md-ring-select"
          x={x - 4}
          y={y - 4}
          width={w + 8}
          height={h + 8}
          rx={rx + 4}
        />
      )}
      <rect class="md-body" x={x} y={y} width={w} height={h} rx={rx} />
      {lines}
      {badge && (
        <g class="md-badge">
          <rect x={x + w - 44} y={y + h - 22} width="36" height="15" rx="7.5" />
          <text x={x + w - 26} y={y + h - 11} text-anchor="middle">
            {badge}
          </text>
        </g>
      )}
    </g>
  );
}

function EdgeShape({ e, lit }: { e: SceneEdge; lit?: boolean }) {
  const marker = MARKERS[e.kind] ?? {};
  return (
    <g class={`md-edge ${e.kind}${lit ? " lit" : ""}`}>
      {e.paths.map((points) => (
        <path
          class="md-line"
          d={roundedPath(points)}
          marker-end={marker.end ? `url(#${marker.end})` : undefined}
          marker-start={marker.start ? `url(#${marker.start})` : undefined}
        />
      ))}
      {e.labels.map((l) =>
        l.lines.map((line, i) => (
          <text
            class={e.guard ? "md-guard" : undefined}
            x={l.x + 3}
            y={l.y + 11 + i * 13}
          >
            {line}
          </text>
        ))
      )}
    </g>
  );
}

function Inspector(
  { view, node, onClose, onSelect }: {
    view: ModelView;
    node: ModelDiagramNode;
    onClose: () => void;
    onSelect: (id: string) => void;
  },
) {
  const [name, type] = splitLabel(node.label);
  const touches = (end: string) =>
    end === node.id ||
    view.diagram.nodes.some((n) =>
      n.id === end && n.kind === "port" && n.parent === node.id
    );
  const relations = view.diagram.edges.filter((e) =>
    touches(e.source) || touches(e.target)
  );
  const label = (id: string) => {
    const n = view.diagram.nodes.find((x) => x.id === id);
    return n?.label || n?.stereo || id;
  };
  const ownerOf = (id: string) => {
    const n = view.diagram.nodes.find((x) => x.id === id);
    return n?.kind === "port" ? n.parent ?? id : id;
  };
  return (
    <aside class="md-inspector" aria-label="Element">
      <button type="button" class="md-close" onClick={onClose} title="Close">
        ×
      </button>
      <p class="md-kicker">{keyword(node) || node.stereo}</p>
      <h3>
        {name || "(anonymous)"}
        {type && <span>{` ${type}`}</span>}
      </h3>
      <dl>
        <dt>Metaclass</dt>
        <dd>{node.metaclass ?? node.kind}</dd>
        {node.qname && (
          <>
            <dt>Name</dt>
            <dd>
              <code>{node.qname}</code>
            </dd>
          </>
        )}
        {node.file && (
          <>
            <dt>Source</dt>
            <dd>
              <code>{`${node.file}:${node.line}:${node.col}`}</code>
            </dd>
          </>
        )}
        {node.rows.map((row) => (
          <>
            <dt>{row.section}</dt>
            <dd>{row.label}</dd>
          </>
        ))}
      </dl>
      {relations.length > 0 && (
        <>
          <p class="md-kicker">Relationships · {relations.length}</p>
          <ul>
            {relations.map((e, i) => {
              const outgoing = touches(e.source);
              const other = outgoing ? e.target : e.source;
              return (
                <li
                  key={e.id ?? i}
                  onClick={() => onSelect(ownerOf(other))}
                >
                  <span class="md-kind">
                    {outgoing ? "→" : "←"} {e.kind}
                  </span>
                  <span class="md-other">{label(other)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}
