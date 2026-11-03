/** Native diagram views of a model revision: SysML Toolkit `toGraph`
 * projections, read-only, with the Toolkit's element ids and source spans.
 * Node names and types are separate fields; no composite `label` is kept. */

export type ModelViewKind = "interconnection" | "action" | "state" | "tree";

export type ModelViewGroup =
  | "structure"
  | "behavior"
  | "state"
  | "definitions"
  | "declared";

interface ModelDiagramRow {
  id?: string;
  label: string;
  section: string;
  qname?: string;
  file?: string;
  line?: number;
  col?: number;
}

export interface ModelDiagramNode {
  id: string;
  kind: string;
  /** Declared name only, never the composite `"name : Type"` label. */
  name: string;
  typeName?: string;
  metaclass?: string;
  qname?: string;
  stereo?: string;
  nodeKind?: string;
  parent?: string;
  conjugated?: boolean;
  rows: ModelDiagramRow[];
  file?: string;
  line?: number;
  col?: number;
}

export interface ModelDiagramEdge {
  id?: string;
  kind: string;
  source: string;
  target: string;
  label?: string;
  guard?: string;
  directed?: boolean;
  metaclass?: string;
  qname?: string;
  sourcePath?: string;
  targetPath?: string;
}

export interface ModelDiagram {
  nodes: ModelDiagramNode[];
  edges: ModelDiagramEdge[];
}

export interface ModelViewSummary {
  id: string;
  title: string;
  kind: ModelViewKind;
  group: ModelViewGroup;
  element: string;
  nodes: number;
  edges: number;
}

export interface ModelView extends ModelViewSummary {
  diagram: ModelDiagram;
}

export interface ModelViewDiagnostic {
  code: "VIEW_UNPROJECTABLE" | "SHAPE_TRUNCATED" | "VIEW_EMPTY";
  severity: "warning" | "error";
  context: { group?: ModelViewGroup; element?: string; message: string };
  recovery: string;
}

export interface ModelViewList {
  toolkit: string;
  views: ModelViewSummary[];
  diagnostics: ModelViewDiagnostic[];
  /** SHA-256 of the canonical `{toolkit, views, diagnostics}` body, computed
   * once per projection and memoised with the list; never per HTTP request. */
  digest: string;
}

export interface ModelViewDiagramDocument {
  toolkit: string;
  view: ModelView;
  /** SHA-256 of the canonical `{toolkit, view}` body, computed once per
   * projection and memoised with the document; never per HTTP request. */
  digest: string;
}

export const modelViewId = (group: ModelViewGroup, element: string) =>
  `${group}:${element}`;

/** On-demand native PlantUML source; digest covers the exact exported bytes. */
export interface ModelViewPlantumlDocument {
  text: string;
  digest: string;
}
