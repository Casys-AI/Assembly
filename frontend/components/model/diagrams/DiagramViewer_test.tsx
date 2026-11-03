import assert from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { ModelView } from "../../../../src/domain/model/records/diagram-views.ts";
import { DiagramViewer } from "./DiagramViewer.tsx";

Deno.test("diagram server rendering needs no DOM and keeps page controls in its toolbar", () => {
  const view: ModelView = {
    id: "structure:Example",
    title: "Example",
    kind: "interconnection",
    group: "structure",
    element: "Example",
    nodes: 2,
    edges: 2,
    diagram: {
      nodes: [
        { id: "a", name: "a", kind: "block", rows: [] },
        { id: "b", name: "b", kind: "block", rows: [] },
      ],
      edges: [
        { source: "a", target: "b", kind: "connection" },
        { source: "a", target: "b", kind: "binding" },
      ],
    },
  };
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  const html = renderToString(
    <DiagramViewer
      view={view}
      version={`commit:${"a".repeat(40)}`}
      toolbar={
        <select aria-label="View">
          <option>Example</option>
        </select>
      }
    />,
  );
  assert.ok(
    html.indexOf('aria-label="View"') <
      html.indexOf('aria-label="Relationships"'),
  );
  assert.match(html, /<button[^>]*disabled[^>]*>SVG/);
  assert.match(html, /role="status"[^>]*>Drawing the view/);
  assert.match(html, /aria-pressed="false"/);
  assert.doesNotMatch(html, /<iframe|<script|<h[12]/);
  assert.deepEqual(
    Object.getOwnPropertyDescriptor(globalThis, "document"),
    before,
  );
});

Deno.test("the sole hidden binding kind can be revealed from the toolbar", () => {
  const view: ModelView = {
    id: "structure:Bindings",
    title: "Bindings",
    kind: "interconnection",
    group: "structure",
    element: "Bindings",
    nodes: 2,
    edges: 1,
    diagram: {
      nodes: [{ id: "a", name: "a", kind: "block", rows: [] }, {
        id: "b",
        name: "b",
        kind: "block",
        rows: [],
      }],
      edges: [{ source: "a", target: "b", kind: "binding" }],
    },
  };
  const html = renderToString(
    <DiagramViewer view={view} version={`commit:${"a".repeat(40)}`} />,
  );
  assert.match(html, /aria-label="Relationships"/);
  assert.match(html, /aria-pressed="false"[^>]*>binding/);
});
