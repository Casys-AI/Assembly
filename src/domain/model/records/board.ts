import type { ModelEditGrant } from "../../governance/model-access/model-edit-policy.ts";
/** Board contract ase.board/1: the home table behind the System pages.
 *
 * The frontend codes the Team, Explore, Flows, Requirements, Rights and
 * Building-block pages against these closed unions and the two fixture boards
 * in prototypes/model-views/data/board-*.json. Source columns are one-based
 * UTF-16 code units, matching Toolkit coordinates. The Toolkit projector (lot B3)
 * is the only producer; nothing here reads SysML text.
 *
 * Three deliberate breaks with the mockup's ad-hoc shapes:
 * - values are typed (string, number, boolean, string array, grant list),
 *   never JSON held in a string;
 * - context elements carry a family instead of an APEContext/APESkills/
 *   APEMemory package-prefix check;
 * - a requirement lists its satisfying owners instead of a bare count.
 */

export const BOARD_SCHEMA = "ase.board/1" as const;
export type BoardSchema = typeof BOARD_SCHEMA;

export type BoardColumnId =
  | "team"
  | "cando"
  | "rules"
  | "guarantees"
  | "information";

export type BoardItemKind =
  | "scope"
  | "operator"
  | "machine"
  | "capability"
  | "capability-type"
  | "tool"
  | "skill"
  | "access"
  | "policy"
  | "mandate"
  | "authority"
  | "requirement"
  | "constraint"
  | "lifecycle"
  | "information";

export type BoardLinkKind =
  | "allocate"
  | "bind"
  | "can-call"
  | "connect"
  | "constrain"
  | "exhibit"
  | "own"
  | "perform"
  | "satisfy"
  | "subject";

/** Bind role carried by the bound feature; only bind links carry one. */
export type BoardBindRole =
  | "caller"
  | "target"
  | "mandate"
  | "holder"
  | "issuer";

/** Context facet of a policy card. */
export type BoardContextFamily = "context" | "skill" | "memory";

export type BoardOperatorKind = "human" | "software";

export interface BoardRef {
  title: string;
  qname: string;
}

export type BoardScalar = string | number | boolean;

/** Read-only projection derived from the canonical authorization grant. */
export type BoardGrant = Readonly<Omit<ModelEditGrant, "qualifiedRoots">> & {
  readonly qualifiedRoots: readonly string[];
};

/** Structured values: JSON held in a string is never used here. The
 * projector parses host lists and grant records once, at projection time. */
export type BoardValue =
  | BoardScalar
  | readonly string[]
  | readonly BoardGrant[];

export interface BoardValueEntry {
  name: string;
  line: number;
  defines?: string | null;
  value: BoardValue;
}

export interface BoardAccess {
  access: string;
  title: string;
  caller: string;
  enabled: boolean;
}

export interface BoardPortItem {
  dir: string;
  title: string;
  type?: string;
}

export interface BoardPort {
  id: string;
  element: string;
  keyword: string;
  title: string;
  qname: string;
  file: string;
  line: number;
  col?: number;
  type?: BoardRef;
  conjugated: boolean;
  inherited: boolean;
  items: readonly BoardPortItem[];
  linked?: number;
}

export interface BoardIo {
  dir: string;
  title: string;
  type?: string;
  element?: string;
}

export interface BoardLoop {
  to: string;
  toTitle: string;
}

export interface BoardStep {
  id: string;
  /** Absent for synthetic library start/done nodes. */
  element?: string;
  kind: string;
  branch?: string;
  col?: number;
  depth?: number;
  file?: string;
  forward?: boolean;
  unreachable?: boolean;
  guard?: string;
  keyword?: string;
  line?: number;
  loops?: readonly BoardLoop[];
  n?: number;
  qname?: string;
  title?: string;
  to?: string;
  toTitle?: string;
  type?: BoardRef;
}

export interface BoardClause {
  id: string;
  element: string;
  keyword: string;
  title: string;
  qname: string;
  file: string;
  line: number;
  col?: number;
  expression?: string;
}

export interface BoardFlow {
  nodes: number;
  edges: number;
  back: number;
  supplemented: number;
  unresolved: number;
  sequential: boolean;
  summary: {
    steps: number;
    decisions: number;
    merges: number;
    forks: number;
    loops: number;
    unreachable: number;
  };
}

export interface BoardTrackTransition {
  id: string;
  element: string;
  name: string | null;
  on: string | null;
  guard: string | null;
  to: string;
  toTitle: string;
  back: boolean;
  inherited: boolean;
  file: string;
  line: number;
}

export interface BoardTrackState {
  id: string;
  element: string;
  keyword: string;
  title: string;
  qname: string;
  file: string;
  line: number;
  col: number;
  rank: number | null;
  initial: boolean;
  terminal: boolean;
  inherited: boolean;
  out: readonly BoardTrackTransition[];
}

export interface BoardTrack {
  /** Absent when no initial state is declared. */
  initial?: string;
  mainCount: number;
  transitions: number;
  extends?: BoardRef;
  states: readonly BoardTrackState[];
}

export interface BoardGroup {
  element: string;
  title: string;
}

export interface BoardItem {
  id: string;
  element: string;
  keyword: string;
  title: string;
  summary?: string;
  summarySource?: string;
  qname: string | null;
  file: string;
  line: number;
  col?: number;
  kind: BoardItemKind;
  type?: BoardRef;
  definition?: boolean;
  group?: readonly BoardGroup[];
  scope?: string;
  family?: BoardContextFamily;
  operatorKind?: BoardOperatorKind;
  titleSource?: string;
  subject?: BoardRef;
  /** Owners declared to satisfy a requirement; a bare count is never used. */
  satisfiedBy?: readonly string[];
  owner?: BoardRef;
  expression?: string | null;
  inForce?: boolean;
  values?: readonly BoardValueEntry[];
  access?: readonly BoardAccess[];
  children?: readonly BoardItem[];
  ports?: readonly BoardPort[];
  steps?: readonly BoardStep[];
  io?: readonly BoardIo[];
  flow?: BoardFlow;
  track?: BoardTrack;
  clauses?: readonly BoardClause[];
  depth?: number;
  open?: boolean;
}

export interface BoardLink {
  id: string;
  kind: BoardLinkKind;
  role?: BoardBindRole;
  from: string;
  to: string;
  via: string | null;
  file: string;
  line: number;
  exact: boolean;
  derived?: boolean;
  enabled?: boolean;
  strength?: string;
}

export interface BoardColumn {
  id: BoardColumnId;
  title: string;
  /** Projector-owned selection rules; opaque to the frontend. */
  rule: Record<string, unknown>;
  items: readonly BoardItem[];
}

export interface BoardIndexEntry {
  column: BoardColumnId;
  card: string;
}

export interface BoardDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  context: Record<string, unknown>;
  recovery: string;
}

export interface BoardMeta {
  model: string;
  mode: "ase" | "generic";
  toolkit?: { version: string };
  sourceDigest: string;
  modeRule?: string;
  anchors?: Record<string, readonly string[]>;
  linkLabels?: Record<
    string,
    { forward: string; reverse: string; derived?: boolean }
  >;
  counts?: {
    files: number;
    namedElements: number;
    items: readonly { column: BoardColumnId; items: number }[];
    linksTotal?: number;
    invariants?: { checked: number; violations: number };
  };
  packages?: readonly {
    qname: string;
    doc: string;
    file: string;
    line: number;
  }[];
  diagnostics: readonly BoardDiagnostic[];
  fieldSources?: Record<string, string>;
  timingMs?: Record<string, number>;
  /** sha256 over columns, links and index; same sources give the same digest. */
  digest: string;
}

export interface ModelBoard {
  schema: BoardSchema;
  meta: BoardMeta;
  columns: readonly BoardColumn[];
  links: readonly BoardLink[];
  index: Record<string, BoardIndexEntry>;
}
