/** Native diagram views of a model revision: SysML Toolkit `toGraph`
 * projections, read-only, with the Toolkit's element ids and source spans. */

export type ModelViewKind = "interconnection" | "action" | "state" | "tree";

/** How the Model space lists views; declared views come from `view` usages. */
export type ModelViewGroup =
  | "structure"
  | "behavior"
  | "state"
  | "definitions"
  | "declared";

export interface ModelDiagramRow {
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
  label: string;
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
  /** Guard of a decision branch, `else` for the default branch. */
  guard?: string;
  directed?: boolean;
  metaclass?: string;
  qname?: string;
  sourcePath?: string;
  targetPath?: string;
  /** Edge added by ASE where the Toolkit omits it (sysml-toolkit#13). */
  supplemented?: boolean;
}

export interface ModelDiagram {
  nodes: ModelDiagramNode[];
  edges: ModelDiagramEdge[];
}

export interface ModelViewSummary {
  /** Stable within a revision: the group and the projected element. */
  id: string;
  title: string;
  kind: ModelViewKind;
  group: ModelViewGroup;
  /** Qualified name of the projected element, or of the declared view. */
  element: string;
  nodes: number;
  edges: number;
}

export interface ModelView extends ModelViewSummary {
  diagram: ModelDiagram;
}

/** What the Toolkit computes from one source set. */
export interface ModelViewProjection {
  toolkit: string;
  views: ModelView[];
  /** Views the Toolkit could not project, one line each; never silently dropped. */
  problems: string[];
}

export interface ModelViewProjector {
  views(sources: Record<string, string>): Promise<ModelViewProjection>;
}

export const modelViewId = (group: ModelViewGroup, element: string) =>
  `${group}:${element}`;
