/** Read-only geometry of the recorded feed and declared interaction scenarios. */
import type { ElementDefinition, Position } from "cytoscape";
import type {
  GraphData,
  GraphHistory,
  GraphSequence,
  GraphSequenceMessage,
  ObservedGraphSequence,
} from "../types.ts";

export const SEQUENCE_ROW_HEIGHT = 46;
export type SequenceOrigin = "observed" | "native";

export function sequenceRecordKey(
  record: GraphSequenceMessage,
  index = 0,
): string {
  return JSON.stringify([
    record.kind || "message",
    record.recordId || record.id || index,
  ]);
}

export function sequencePositionKey(
  sequence: Pick<GraphSequence, "id">,
  record: GraphSequenceMessage,
  index = 0,
): string {
  return JSON.stringify([sequence.id, sequenceRecordKey(record, index)]);
}

export function sequenceCaption(value: string, length = 70): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > length ? `${text.slice(0, length - 3)}…` : text;
}

export function chooseSequenceOrigin(
  graph: Pick<GraphData, "sequences" | "executionSequences">,
  explicitOrigin: SequenceOrigin | null = null,
): SequenceOrigin {
  return explicitOrigin ??
    (graph.executionSequences?.length ? "observed" : "native");
}

export function sequenceActivityStatus(
  sequence: GraphSequence | undefined,
  history: GraphHistory | null | undefined,
): { status: string; running: boolean; follow: boolean } {
  if (history) {
    return {
      follow: false,
      running: false,
      status: "History" +
        (history.revision !== undefined
          ? ` · revision ${history.revision}`
          : " of the model"),
    };
  }
  if (sequence?.origin !== "observed") {
    return { status: "SysML scenario", running: false, follow: false };
  }
  const observed = sequence as ObservedGraphSequence;
  const running = observed.busy === true;
  return {
    follow: true,
    running,
    status: (running ? "In progress" : "Waiting") +
      (observed.phase ? ` · ${observed.phase}` : ""),
  };
}

export interface SequenceDiagramLayout {
  elements: ElementDefinition[];
  positions: Map<string, Position>;
  laneWidth: number;
  width: number;
  lastY: number;
  lastX: number;
  rowHeight: number;
}

/** A native cycle has no valid complete chronology; observations retain their order. */
export function sequenceDiagramElements(
  sequence: GraphSequence,
  viewportWidth = 0,
): SequenceDiagramLayout {
  const laneWidth = viewportWidth > 0
    ? Math.max(56, viewportWidth / Math.max(1, sequence.lifelines.length))
    : 120;
  const elements: ElementDefinition[] = [];
  const positions = new Map<string, Position>();
  const lanes = new Map(sequence.lifelines.map((line, index) => [line.id, {
    id: `sequence-participant:${index}`,
    x: laneWidth * (index + .5),
  }]));
  const width = Math.max(56, sequence.lifelines.length * laneWidth);
  if (
    sequence.origin !== "observed" &&
    ["cyclic", "non-linearizable"].includes(sequence.ordering ?? "")
  ) {
    return {
      elements,
      positions,
      laneWidth,
      width,
      lastY: 0,
      lastX: laneWidth / 2,
      rowHeight: SEQUENCE_ROW_HEIGHT,
    };
  }
  const lastY = SEQUENCE_ROW_HEIGHT *
    Math.max(.5, sequence.messages.length - .5);
  let lastX = laneWidth / 2;
  for (const line of sequence.lifelines) {
    const lane = lanes.get(line.id)!;
    elements.push({
      data: {
        id: lane.id,
        participantId: line.id,
        width: laneWidth - 12,
      },
      position: { x: lane.x, y: 0 },
      classes: "sequence-participant",
    }, {
      data: { id: `${lane.id}:bottom` },
      position: { x: lane.x, y: lastY + SEQUENCE_ROW_HEIGHT / 2 },
      classes: "sequence-anchor",
    }, {
      data: {
        id: `${lane.id}:lifeline`,
        source: lane.id,
        target: `${lane.id}:bottom`,
      },
      classes: "sequence-lifeline",
    });
  }
  sequence.messages.forEach((record, index) => {
    const source = lanes.get(record.from), target = lanes.get(record.to);
    if (!source || !target) return;
    lastX = (source.x + target.x) / 2;
    const y = (index + .5) * SEQUENCE_ROW_HEIGHT;
    const key = sequencePositionKey(sequence, record, index);
    positions.set(key, { x: lastX, y });
    // Grid marks are decorative. Avoid quadratic expansion for many operators.
    if (lanes.size <= 20) {
      for (const lane of lanes.values()) {
        elements.push({
          data: { id: `${key}:guide:${lane.id}` },
          position: { x: lane.x, y },
          classes: "sequence-grid-point",
        });
      }
    }
    if (sequence.origin === "observed" && record.kind === "event") {
      elements.push({
        data: {
          id: key,
          label: sequenceCaption(record.name),
          recordIndex: index,
          recordId: record.recordId,
        },
        position: { x: source.x, y },
        classes: "sequence-event",
      });
      return;
    }
    const from = `${key}:from`, to = `${key}:to`;
    const self = source.id === target.id;
    elements.push({
      data: { id: from, recordIndex: index },
      position: { x: source.x, y: y - (self ? 6 : 0) },
      classes: "sequence-point",
    }, {
      data: { id: to, recordIndex: index },
      position: { x: target.x, y: y + (self ? 6 : 0) },
      classes: "sequence-point",
    }, {
      data: {
        id: key,
        source: from,
        target: to,
        label: sequenceCaption(record.name),
        recordIndex: index,
        recordId: record.recordId,
      },
      classes: "sequence-message" + (self ? " sequence-self" : ""),
    });
  });
  return {
    elements,
    positions,
    laneWidth,
    width,
    lastY,
    lastX,
    rowHeight: SEQUENCE_ROW_HEIGHT,
  };
}
