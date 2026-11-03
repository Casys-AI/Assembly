/** Changes between stored model graphs, independently of their presentation. */
interface GraphFieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface GraphChange {
  /** Exact IR document identity, including for endpoints. */
  id: string;
  /** Native SysML identity; endpoints use their owning relationship's identity. */
  nativeId: string;
  kind: "added" | "removed" | "changed";
  category: "element" | "relationship" | "endpoint";
  metaclass: string;
  label?: string;
  qualifiedName?: string;
  fields: GraphFieldChange[];
}

export interface GraphDiff {
  /** Null denotes a verified empty schema ancestor of the target model. */
  fromVersion: string | null;
  toVersion: string;
  sourceDigests?: { before: string | null; after: string };
  engine: "Git";
  changes: GraphChange[];
  /** Exact totals before applying the display limit. */
  counts: { added: number; removed: number; changed: number };
  truncated: boolean;
}
