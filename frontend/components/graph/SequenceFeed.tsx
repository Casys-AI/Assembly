import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  GraphData,
  GraphHistory,
  GraphSequence,
  GraphSequenceMessage,
  ObservedGraphSequence,
} from "../../lib/graph/types.ts";
import type {
  SequenceController,
  SequenceViewport,
} from "../../lib/graph/sequence/controller.ts";
import {
  chooseSequenceOrigin,
  sequenceActivityStatus,
  sequenceCaption,
  type SequenceOrigin,
  sequenceRecordKey,
} from "../../lib/graph/sequence/layout.ts";
import {
  LEGACY_SEQUENCE_ORIGIN_KEY,
  readBrowserPreference,
  SEQUENCE_ORIGIN_KEY,
} from "../../lib/browser/preferences.ts";

interface ReceiptSelection {
  sequence: GraphSequence;
  record: GraphSequenceMessage;
}
const emptyGraph: GraphData = { nodes: [], edges: [] };
function timeLabel(record: GraphSequenceMessage, index: number) {
  return record.at && Number.isFinite(Date.parse(record.at))
    ? new Date(record.at).toLocaleTimeString("fr-FR", { hour12: false })
    : String(index + 1).padStart(2, "0");
}

export function SequenceReceipt({ selection, onClose }: {
  selection: ReceiptSelection;
  onClose(): void;
}) {
  const { record, sequence } = selection;
  const observed = sequence.origin === "observed";
  const fields: Array<[string, string | number | undefined]> = [
    [
      "Origin",
      observed ? "Recorded activity" : "Scenario declared in the SysML model",
    ],
    [
      "Type",
      observed
        ? record.kind === "event" ? record.eventKind || "event" : "message"
        : "declared message",
    ],
    ["Identifier", record.recordId || record.id],
    ["Date", record.at],
    ["Native action", record.actionId],
    ["Model digest", record.modelDigest],
    ["Model version", record.repositoryVersion],
    [
      "Revision viewed",
      observed ? (sequence as ObservedGraphSequence).revision : undefined,
    ],
  ];
  const evidence = observed ? record.evidence : {
    nativeId: sequence.nativeId || sequence.id,
    sourceEventId: record.sourceEventId,
    targetEventId: record.targetEventId,
    sourceIds: record.sourceIds || sequence.sourceIds || [],
  };
  return (
    <aside
      class="graph-inspector sequence-receipt"
      aria-label="Receipt of the selected step"
    >
      <button
        type="button"
        class="graph-close"
        onClick={onClose}
        aria-label="Close receipt"
      >
        ×
      </button>
      <h2>{record.name}</h2>
      {fields.filter(([, value]) => value !== undefined).map((
        [label, value],
      ) => (
        <p class="graph-muted" key={label}>
          {label}
          <br />
          <code>{value}</code>
        </p>
      ))}
      <h3>
        {observed ? "Recorded provenance" : "Native references of the scenario"}
      </h3>
      <pre>{JSON.stringify(evidence || {}, null, 2)}</pre>
      <details>
        <summary>Full record</summary>
        <pre>{JSON.stringify(record, null, 2)}</pre>
      </details>
    </aside>
  );
}

/** Two read-only layers share a feed: persisted observations and declared scenarios. */
export function SequenceFeed(
  { graph = emptyGraph, history = null, readOnly = false }: {
    graph?: GraphData;
    history?: GraphHistory | null;
    readOnly?: boolean;
  },
) {
  const [explicitOrigin, setExplicitOrigin] = useState<SequenceOrigin | null>(
    null,
  );
  const [selectedSequenceId, setSelectedSequenceId] = useState<string | null>(
    null,
  );
  const [selection, setSelection] = useState<ReceiptSelection | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [following, setFollowing] = useState(true);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [viewport, setViewport] = useState<SequenceViewport>({
    zoom: 1,
    panX: 0,
    laneWidth: 120,
  });
  const body = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLDivElement>(null);
  const controller = useRef<SequenceController | null>(null);
  const origin = chooseSequenceOrigin(graph, explicitOrigin);
  const sequences = origin === "observed"
    ? graph.executionSequences || []
    : graph.sequences || [];
  const sequence = sequences.find((entry) => entry.id === selectedSequenceId) ||
    sequences[0];
  const frozen = readOnly || Boolean(history);
  const effectiveHistory = history ||
    (readOnly ? { modelVersion: "source historique" } : null);
  const activity = sequenceActivityStatus(sequence, effectiveHistory);
  const observed = sequence?.origin === "observed";
  const invalidOrder = !observed &&
    (sequence?.ordering === "cyclic" ||
      sequence?.ordering === "non-linearizable");
  const drawable = Boolean(
    sequence && sequence.messages.length && !invalidOrder,
  );
  const participants = useMemo(
    () =>
      new Map(sequence?.lifelines.map((line) => [line.id, line.name]) || []),
    [sequence],
  );
  const diagnostics = [
    ...new Set([
      ...(origin === "native" ? graph.sequenceDiagnostics || [] : []),
      ...(sequence?.diagnostics || []),
    ]),
  ];
  const callbacks = useRef({ sequence, selection, following, frozen });
  callbacks.current = { sequence, selection, following, frozen };

  function inspect(index: number) {
    const current = callbacks.current.sequence;
    if (!current?.messages[index]) return;
    setFollowing(false);
    setSelection({ sequence: current, record: current.messages[index] });
    setHoverKey(null);
  }
  function originChanged(next: SequenceOrigin) {
    setExplicitOrigin(next);
    setSelectedSequenceId(null);
    setSelection(null);
    setHoverKey(null);
    setFollowing(true);
    try {
      sessionStorage.setItem(SEQUENCE_ORIGIN_KEY, next);
    } catch { /* optional */ }
  }
  useEffect(() => {
    try {
      const saved = readBrowserPreference(
        () => sessionStorage,
        SEQUENCE_ORIGIN_KEY,
        LEGACY_SEQUENCE_ORIGIN_KEY,
      );
      if (saved === "observed" || saved === "native") setExplicitOrigin(saved);
    } catch { /* storage is optional */ }
  }, []);
  useEffect(() => {
    setSelection(null);
    setHoverKey(null);
    setFollowing(true);
  }, [sequence?.id, origin]);
  useEffect(() => {
    if (!drawable || !canvas.current || !body.current) return;
    let disposed = false;
    setError("");
    void import("../../lib/graph/sequence/controller.ts").then(
      ({ SequenceController }) => {
        if (disposed || !canvas.current || !body.current) return;
        controller.current = new SequenceController(
          canvas.current,
          body.current,
          {
            onSelect: inspect,
            onHover(index) {
              const current = callbacks.current.sequence;
              setHoverKey(
                index === null || !current?.messages[index]
                  ? null
                  : sequenceRecordKey(current.messages[index], index),
              );
            },
            onUser: () => setFollowing(false),
            onViewport: setViewport,
            shouldFollow: () =>
              callbacks.current.following &&
              !callbacks.current.frozen &&
              callbacks.current.sequence?.origin === "observed",
          },
        );
        setReady(true);
      },
    ).catch((cause) => {
      if (!disposed) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    });
    return () => {
      disposed = true;
      setReady(false);
      controller.current?.destroy();
      controller.current = null;
    };
  }, [drawable]);
  useEffect(() => {
    if (!ready) return;
    controller.current?.update(sequence || null);
    if (
      callbacks.current.following && !callbacks.current.frozen &&
      sequence?.origin === "observed"
    ) controller.current?.follow();
  }, [sequence, ready]);
  useEffect(() => {
    if (ready && following && !frozen && observed) controller.current?.follow();
  }, [following, frozen, observed, ready]);
  const selectedKey = selection?.sequence.id === sequence?.id
    ? sequenceRecordKey(selection.record)
    : null;
  const highlightedKey = hoverKey || selectedKey;
  useEffect(() => {
    const index = sequence?.messages.findIndex((record, i) =>
      sequenceRecordKey(record, i) === highlightedKey
    ) ?? -1;
    controller.current?.highlight(index >= 0 ? index : null);
  }, [highlightedKey, sequence, ready]);

  return (
    <div class="sequence-feed-shell" data-sequence-origin={origin}>
      <div class="sequence-controls">
        <label>
          Origin{" "}
          <select
            value={origin}
            onChange={(event) =>
              originChanged(event.currentTarget.value as SequenceOrigin)}
          >
            <option value="observed">Observed activity</option>
            <option value="native">SysML scenarios</option>
          </select>
        </label>
        {sequences.length > 1 && (
          <label>
            Sequence{" "}
            <select
              value={sequence?.id || ""}
              onChange={(event) => {
                setSelectedSequenceId(event.currentTarget.value);
                setSelection(null);
                setFollowing(true);
              }}
            >
              {sequences.map((entry) => (
                <option key={entry.id} value={entry.id}>{entry.name}</option>
              ))}
            </select>
          </label>
        )}
        {(observed || frozen) && (
          <span
            class={`sequence-live-status${activity.running ? " running" : ""}`}
            role="status"
          >
            {activity.status}
          </span>
        )}
        {observed && !frozen && (
          <button
            type="button"
            aria-pressed={following}
            onClick={() => {
              setSelection(null);
              setFollowing(true);
              controller.current?.follow();
            }}
          >
            {following ? "Following live" : "Resume live"}
          </button>
        )}
        {drawable && (
          <>
            <button
              type="button"
              aria-label="Zoom out the sequence"
              onClick={() => controller.current?.zoom(.8)}
            >
              −
            </button>
            <button
              type="button"
              aria-label="Zoom in the sequence"
              onClick={() => controller.current?.zoom(1.25)}
            >
              +
            </button>
            <button type="button" onClick={() => controller.current?.reset()}>
              Recenter the sequence
            </button>
          </>
        )}
      </div>
      <div class="sequence-content">
        <div class="sequence-main">
          <div class="sequence-summary">
            {observed
              ? (
                <p>
                  Revision {(sequence as ObservedGraphSequence).revision} ·{" "}
                  {sequence!.messages.length} entries shown of{" "}
                  {(sequence as ObservedGraphSequence).total}
                  {(sequence as ObservedGraphSequence).omitted
                    ? ` · ${
                      (sequence as ObservedGraphSequence).omitted
                    } earlier entries outside the window.`
                    : " · full log shown."}
                </p>
              )
              : sequence && (
                <p>
                  {invalidOrder
                    ? "The declared order does not allow a complete timeline to be drawn."
                    : sequence.ordering === "native-partial-order"
                    ? "Declared scenario · reading of the partial order, distinct from an execution."
                    : "Scenario declared in the model · distinct from an execution trace."}
                </p>
              )}
            {diagnostics.length > 0 && (
              <details class="sequence-diagnostics">
                <summary>Projection limits · {diagnostics.length}</summary>
                <ul>{diagnostics.map((item) => <li key={item}>{item}</li>)}</ul>
              </details>
            )}
          </div>
          {!sequence || !sequence.messages.length
            ? (
              <div class="graph-placeholder">
                <h3>
                  {origin === "observed"
                    ? "No activity recorded"
                    : "No sequence interaction declared"}
                </h3>
                <p>
                  {origin === "observed"
                    ? "Messages and events will appear once the host records them."
                    : "An action flow does not automatically become a message sequence."}
                </p>
              </div>
            )
            : (
              <div class="sequence-body" ref={body}>
                <div
                  class="sequence-feed"
                  role="list"
                  aria-label="Messages and events of the sequence"
                >
                  <div class="sequence-feed-head">
                    <span>
                      {observed ? "Time" : invalidOrder ? "Marker" : "Order"}
                    </span>
                    <span>Event</span>
                    <span>Actor / exchange</span>
                  </div>
                  {sequence.messages.map((record, index) => {
                    const key = sequenceRecordKey(record, index),
                      event = observed && record.kind === "event";
                    const from = participants.get(record.from) || record.from,
                      to = participants.get(record.to) || record.to;
                    const label = record.name.replace(/\s+/g, " ").trim(),
                      time = timeLabel(record, index),
                      route = event ? from : `${from} → ${to}`;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="listitem"
                        class={`sequence-feed-row${
                          highlightedKey === key ? " highlighted" : ""
                        }`}
                        data-sequence-record={index}
                        aria-label={`${time} · ${label} · ${route}`}
                        onMouseEnter={() => setHoverKey(key)}
                        onMouseLeave={() => setHoverKey(null)}
                        onFocus={() => setHoverKey(key)}
                        onBlur={() => setHoverKey(null)}
                        onClick={() => inspect(index)}
                      >
                        <time
                          title={record.at || (invalidOrder
                            ? "Marker in the list, with no chronological order asserted"
                            : "Declared order")}
                        >
                          {time}
                        </time>
                        <span class="sequence-feed-label" title={label}>
                          {sequenceCaption(label)}
                        </span>
                        <span class="sequence-feed-route" title={route}>
                          {route}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div class="sequence-diagram">
                  {invalidOrder
                    ? (
                      <div class="sequence-summary" role="status">
                        <h3>Sequence order cannot be drawn</h3>
                        <p>
                          Messages stay available on the left. Their markers
                          identify the list without asserting a timeline. The
                          diagnostics describe the limit of the drawing.
                        </p>
                      </div>
                    )
                    : (
                      <>
                        <div class="sequence-participants">
                          {sequence.lifelines.map((line, index) => (
                            <span
                              key={line.id}
                              class="sequence-lane-head"
                              title={line.name}
                              style={{
                                left: `${
                                  index * viewport.laneWidth * viewport.zoom +
                                  viewport.panX
                                }px`,
                                width: `${
                                  viewport.laneWidth * viewport.zoom
                                }px`,
                              }}
                            >
                              {line.name}
                            </span>
                          ))}
                        </div>
                        <div
                          class="sequence-canvas"
                          ref={canvas}
                          role="img"
                          aria-label="Exchanges aligned on events, rendered in Cytoscape"
                        />
                      </>
                    )}
                </div>
              </div>
            )}
          {error && <p class="graph-error" role="alert">{error}</p>}
        </div>
        {selection && (
          <SequenceReceipt
            selection={selection}
            onClose={() => {
              setSelection(null);
              controller.current?.resize();
            }}
          />
        )}
      </div>
    </div>
  );
}
