/** Serializable graph and sequence view contracts. */
export type Dimension =
  | "structure"
  | "behavior"
  | "requirements"
  | "constraints";

type GraphRole = "usage" | "definition";
type GraphOrigin = "declared" | "typed-projection" | "design-projection";

export interface GraphNode {
  id: string;
  label: string;
  dimension: Dimension;
  kind: string;
  symbol: string;
  parentId: string | null;
  subsystem: string;
  description: string;
  source: { file: string; line: string; quote: string; native: true };
  level: number;
  origin: GraphOrigin;
  packageId: string;
  patternId?: string;
  role?: GraphRole;
  provenance?: "ASE" | "APE";
  category?: string;
  subtitle?: string;
  fields?: string[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: string;
  origin: GraphOrigin;
  sourceEvidence: { file: string; line: string };
}

export interface GraphData {
  title: string;
  sourceFile: string;
  projectionNote: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  scopes: Array<{ id: string; label: string; nodeIds: string[] }>;
  packages: Array<{ id: string; label: string }>;
  levels: Array<{ id: string; label: string; maxLevel: number }>;
  sequences?: SequenceData[];
}

interface SequenceLifeline {
  id: string;
  name: string;
  typeId: string;
  typeName: string;
  patternId?: string;
}

interface SequenceMessage {
  id: string;
  name: string;
  from: string;
  to: string;
  payloadId: string;
  payloadName: string;
}

export interface SequenceData {
  id: string;
  name: string;
  qualifiedName: string;
  doc: string;
  lifelines: SequenceLifeline[];
  messages: SequenceMessage[];
}
