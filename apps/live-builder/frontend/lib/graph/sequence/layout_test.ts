import { deepStrictEqual, equal, notEqual, ok } from "node:assert/strict";
import cytoscape from "cytoscape";
import type { GraphSequence, ObservedGraphSequence } from "../types.ts";
import {
  chooseSequenceOrigin,
  SEQUENCE_ROW_HEIGHT,
  sequenceActivityStatus,
  sequenceCaption,
  sequenceDiagramElements,
  sequencePositionKey,
  sequenceRecordKey,
} from "./layout.ts";

function recorded(): ObservedGraphSequence {
  return {
    id: "observed:session",
    name: "Activité réelle",
    origin: "observed",
    revision: 8,
    busy: true,
    phase: "Tests en cours",
    total: 3,
    omitted: 0,
    limit: 150,
    diagnostics: [],
    lifelines: ["operator/a", "operator/b"].map((id) => ({
      id,
      name: "Même nom",
      typeId: "",
      typeName: "",
      origin: "native",
    })),
    messages: [
      { id: "request", from: "operator/a", to: "operator/b", kind: "message" },
      { id: "note", from: "operator/b", to: "operator/b", kind: "event" },
      { id: "reply", from: "operator/b", to: "operator/a", kind: "message" },
    ].map((record) => ({
      ...record,
      kind: record.kind as "message" | "event",
      name: record.id,
      at: "2026-10-21T10:23:00.000Z",
      recordId: record.id,
      payloadId: "",
      payloadName: "",
      evidence: { nativeSourceIds: [], sourceContextCount: 0 },
    })),
  };
}

Deno.test("sequence requests and returns retain direction and one shared chronological row", () => {
  const sequence = recorded(), unchanged = JSON.stringify(sequence);
  const layout = sequenceDiagramElements(sequence, 600);
  const cy = cytoscape({
    headless: true,
    elements: layout.elements,
    layout: { name: "preset" },
  });
  try {
    const messages = cy.edges(".sequence-message");
    equal(messages.length, 2);
    ok(messages[0].source().position("x") < messages[0].target().position("x"));
    ok(messages[1].source().position("x") > messages[1].target().position("x"));
    equal(messages[0].source().position("y"), SEQUENCE_ROW_HEIGHT / 2);
    equal(messages[0].target().position("y"), SEQUENCE_ROW_HEIGHT / 2);
    equal(messages[1].source().position("y"), SEQUENCE_ROW_HEIGHT * 2.5);
    // Same labels do not merge the identities into a self message.
    equal(cy.nodes(".sequence-participant").length, 2);
    equal(JSON.stringify(sequence), unchanged);
  } finally {
    cy.destroy();
  }
});

Deno.test("observed host events stay points rather than invented exchanges", () => {
  const sequence = recorded();
  const layout = sequenceDiagramElements(sequence, 200);
  const point = layout.elements.find((element) =>
    element.classes === "sequence-event"
  )!;
  equal(point.data.recordIndex, 1);
  equal(point.position!.x, 150);
  equal(point.position!.y, 69);
  ok(!Object.hasOwn(point.data, "source"));
  ok(!Object.hasOwn(point.data, "target"));
  equal(
    layout.elements.filter((element) =>
      String(element.classes).includes("sequence-message")
    ).length,
    2,
  );
});

Deno.test("sequence identity keys cannot collide through punctuation or record categories", () => {
  const sequence = recorded();
  const message = {
    ...sequence.messages[0],
    id: 'event:a:"b',
    recordId: 'event:a:"b',
  };
  const event = { ...message, kind: "event" as const };
  notEqual(sequenceRecordKey(message), sequenceRecordKey(event));
  notEqual(
    sequencePositionKey(sequence, message),
    sequencePositionKey({ id: `${sequence.id}:other` }, message),
  );
  const model = { ...sequence, messages: [message, event] };
  const elements = sequenceDiagramElements(model, 400).elements;
  equal(
    new Set(elements.map((element) => element.data.id)).size,
    elements.length,
  );
  const cy = cytoscape({ headless: true, elements });
  try {
    ok(cy.getElementById(sequencePositionKey(model, message)).length);
    ok(cy.getElementById(sequencePositionKey(model, event)).length);
  } finally {
    cy.destroy();
  }
});

Deno.test("equal timestamps remain in the recorded order and self messages have distinct anchors", () => {
  const sequence = recorded();
  sequence.messages[0].to = sequence.messages[0].from;
  const result = sequenceDiagramElements(sequence, 400);
  const self = result.elements.find((element) =>
    String(element.classes).includes("sequence-self")
  )!;
  const source = result.elements.find((element) =>
    element.data.id === self.data.source
  )!;
  const target = result.elements.find((element) =>
    element.data.id === self.data.target
  )!;
  equal(source.position!.x, target.position!.x);
  ok(source.position!.y < target.position!.y);
  deepStrictEqual(
    [...result.positions.keys()],
    sequence.messages.map((record, index) =>
      sequencePositionKey(sequence, record, index)
    ),
  );
});

Deno.test("cyclic native scenarios cannot be drawn as a valid total chronology", () => {
  const cyclic: GraphSequence = {
    ...recorded(),
    origin: "native",
    ordering: "cyclic",
  };
  const layout = sequenceDiagramElements(cyclic, 600);
  equal(layout.elements.length, 0);
  equal(layout.positions.size, 0);
  // Chronological observations are not interpreted as a design cycle.
  equal(sequenceDiagramElements(recorded(), 600).positions.size, 3);
});

Deno.test("large participant sets keep exchanges without allocating a quadratic guide grid", () => {
  const sequence = recorded();
  sequence.lifelines = Array.from({ length: 500 }, (_, index) => ({
    id: `operator/${index}`,
    name: `Operator ${index}`,
    typeId: "",
    typeName: "",
    origin: "native",
  }));
  sequence.messages = Array.from({ length: 150 }, (_, index) => ({
    ...sequence.messages[0],
    id: `message/${index}`,
    recordId: `message/${index}`,
    from: `operator/${index}`,
    to: `operator/${499 - index}`,
  }));
  const layout = sequenceDiagramElements(sequence, 1000);
  equal(layout.laneWidth, 56);
  equal(
    layout.elements.filter((element) =>
      element.classes === "sequence-grid-point"
    ).length,
    0,
  );
  equal(
    layout.elements.filter((element) => element.classes === "sequence-message")
      .length,
    150,
  );
  ok(layout.elements.length <= 500 * 3 + 150 * 3);
});

Deno.test("origin defaults to real activity while preserving an explicit scenario choice", () => {
  const observed = recorded();
  equal(chooseSequenceOrigin({}), "native");
  equal(chooseSequenceOrigin({ executionSequences: [observed] }), "observed");
  equal(
    chooseSequenceOrigin({ executionSequences: [observed] }, "native"),
    "native",
  );
  equal(chooseSequenceOrigin({}, "observed"), "observed");
});

Deno.test("historical snapshots never advertise a live or running sequence", () => {
  const sequence = recorded();
  deepStrictEqual(sequenceActivityStatus(sequence, null), {
    status: "In progress · Tests en cours",
    running: true,
    follow: true,
  });
  deepStrictEqual(sequenceActivityStatus(sequence, { revision: 34 }), {
    status: "History · revision 34",
    running: false,
    follow: false,
  });
  deepStrictEqual(
    sequenceActivityStatus(sequence, { modelVersion: "commit:old" }),
    {
      status: "History of the model",
      running: false,
      follow: false,
    },
  );
  equal(
    sequenceActivityStatus({ ...sequence, origin: "native" }, null).follow,
    false,
  );
});

Deno.test("captions stay compact while the source record remains intact", () => {
  const source = `A\n  ${"échange ".repeat(30)}`;
  const caption = sequenceCaption(source);
  ok(caption.endsWith("…"));
  ok(caption.length <= 70);
  ok(!caption.includes("\n"));
  ok(source.includes("\n"));
});

Deno.test("a non-linearizable native interaction cannot be flattened into a false sequence", () => {
  const sequence: GraphSequence = {
    ...recorded(),
    origin: "native",
    ordering: "non-linearizable",
  };
  equal(sequenceDiagramElements(sequence, 600).elements.length, 0);
});
