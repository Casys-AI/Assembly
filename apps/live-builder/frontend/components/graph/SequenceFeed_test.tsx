import { doesNotMatch, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { SequenceFeed, SequenceReceipt } from "./SequenceFeed.tsx";
import type {
  GraphSequence,
  ObservedGraphSequence,
} from "../../lib/graph/types.ts";

function observed(): ObservedGraphSequence {
  return {
    id: "observed:session",
    name: "Activité réelle",
    origin: "observed",
    revision: 4,
    busy: true,
    phase: "Construction",
    total: 1,
    omitted: 0,
    limit: 150,
    diagnostics: [],
    lifelines: [{
      id: "host",
      name: "Hôte Assembly",
      origin: "host",
      typeId: "",
      typeName: "",
    }],
    messages: [{
      id: "event:receipt",
      recordId: "receipt",
      name: "Action enregistrée",
      kind: "event",
      eventKind: "flow-action",
      from: "host",
      to: "host",
      at: "2026-10-21T10:00:00Z",
      payloadId: "",
      payloadName: "",
      evidence: {
        eventId: "receipt",
        nativeSourceIds: [],
        sourceContextCount: 0,
      },
    }],
  };
}

Deno.test("historical source reads freeze a busy observed feed even without history metadata", () => {
  const sequence = observed();
  const graph = { nodes: [], edges: [], executionSequences: [sequence] };
  const live = renderToString(<SequenceFeed graph={graph} />);
  match(live, /sequence-live-status running/);
  match(live, /In progress · Construction/);
  match(live, /Following live/);
  for (const history of [null, { revision: 4 }]) {
    const frozen = renderToString(
      <SequenceFeed graph={graph} readOnly history={history} />,
    );
    match(frozen, /History/);
    match(frozen, /data-sequence-record="0"/);
    match(frozen, /Action enregistrée/);
    doesNotMatch(
      frozen,
      /sequence-live-status running|In progress|Following live/,
    );
  }
});

Deno.test("observed receipts preserve provenance and untrusted text without executable markup", () => {
  const sequence = observed();
  const record = sequence.messages[0];
  record.name = '<img src=x onerror="unsafe()">';
  record.repositoryVersion = "<script>unsafe()</script>";
  record.evidence.nativeSourceIds = ['<svg onload="unsafe()">'];
  const html = renderToString(
    <SequenceReceipt selection={{ sequence, record }} onClose={() => {}} />,
  );
  match(html, /Recorded activity/);
  match(html, /Recorded provenance/);
  match(html, /Revision viewed/);
  match(html, /Full record/);
  match(html, /&lt;img/);
  match(html, /&lt;script/);
  match(html, /&lt;svg/);
  doesNotMatch(html, /<(?:img|script|svg)\b/);
});

for (const ordering of ["cyclic", "non-linearizable"] as const) {
  Deno.test(`sequence ${ordering} keeps message receipts reachable without drawing a false timeline`, () => {
    const sequence: GraphSequence = {
      id: "interaction",
      name: "Échanges croisés",
      ordering,
      lifelines: [{ id: "a", name: "Agent A" }, { id: "b", name: "Agent B" }],
      messages: [{ id: "first", name: "Premier échange", from: "a", to: "b" }, {
        id: "second",
        name: "Retour croisé",
        from: "b",
        to: "a",
      }],
    };
    const html = renderToString(
      <SequenceFeed graph={{ nodes: [], edges: [], sequences: [sequence] }} />,
    );
    match(html, /data-sequence-record="0"/);
    match(html, /data-sequence-record="1"/);
    match(html, /Premier échange/);
    match(html, /Retour croisé/);
    match(html, /Marker/);
    match(html, /without asserting a timeline/);
    doesNotMatch(html, /class="sequence-canvas"/);
  });
}
