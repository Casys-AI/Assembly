import type {
  BoardAccess,
  BoardBindRole,
  BoardClause,
  BoardColumn,
  BoardColumnId,
  BoardContextFamily,
  BoardDiagnostic,
  BoardFlow,
  BoardGrant,
  BoardGroup,
  BoardIndexEntry,
  BoardIo,
  BoardItem,
  BoardItemKind,
  BoardLink,
  BoardLinkKind,
  BoardLoop,
  BoardMeta,
  BoardOperatorKind,
  BoardPort,
  BoardPortItem,
  BoardRef,
  BoardStep,
  BoardTrack,
  BoardTrackState,
  BoardTrackTransition,
  BoardValue,
  BoardValueEntry,
  ModelBoard,
} from "../../../../src/domain/model/records/board.ts";
import { isRecord } from "../../transport/is-record.ts";
import { ParseError } from "../../transport/unreadable-answer.ts";

/**
 * The strict reading of a board (schema ase.board/1). Every System page draws
 * from these types and never from a guess, so a body that is not exactly the
 * contract is refused whole, with the path of the first thing that is wrong:
 * a value of the wrong type, a name outside a closed union, a property that
 * is `null` where the contract says "absent". Properties the contract does not
 * name are dropped, so no page can come to read one. Only types are imported
 * from the host's domain: the contract itself is spelled here once.
 */

/** Where the body stopped being a board, and what it should have been. */
export class BoardParseError extends ParseError {
  override name = "BoardParseError";
}

type Reader<T> = (value: unknown, path: string) => T;

const bad = (path: string, expected: string): never => {
  throw new BoardParseError(path, expected);
};

const text: Reader<string> = (value, path) =>
  typeof value === "string" ? value : bad(path, "a string");
const number: Reader<number> = (value, path) =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : bad(path, "a finite number");
const flag: Reader<boolean> = (value, path) =>
  typeof value === "boolean" ? value : bad(path, "a boolean");
const nullable = <T>(read: Reader<T>): Reader<T | null> => (value, path) =>
  value === null ? null : read(value, path);

/** A closed union of names: anything else is the contract moving. */
const oneOf = <const Names extends readonly string[]>(
  names: Names,
): Reader<Names[number]> =>
(value, path) =>
  typeof value === "string" && names.includes(value)
    ? value as Names[number]
    : bad(path, `one of ${names.join(", ")}`);

const list = <T>(read: Reader<T>): Reader<T[]> => (value, path) =>
  Array.isArray(value)
    ? value.map((entry, index) => read(entry, `${path}[${index}]`))
    : bad(path, "an array");

const dictionary =
  <T>(read: Reader<T>): Reader<Record<string, T>> => (value, path) => {
    if (!isRecord(value)) return bad(path, "an object");
    const out: Record<string, T> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = read(entry, `${path}.${key}`);
    }
    return out;
  };

const anyRecord: Reader<Record<string, unknown>> = (value, path) =>
  isRecord(value) ? { ...value } : bad(path, "an object");

type OptionalKeys<T> = {
  [Key in keyof T]-?: object extends Pick<T, Key> ? Key : never;
}[keyof T];
type RequiredKeys<T> = Exclude<keyof T, OptionalKeys<T>>;
type Fields<T, Keys extends keyof T> = {
  [Key in Keys]-?: Reader<Exclude<T[Key], undefined>>;
};

/**
 * A record of the contract: `required` names are there, `optional` ones are
 * there or absent (never `undefined`, never `null` unless their reader says
 * so), nothing else is kept. Both lists must name every property of `T`: a
 * property added to the contract is a compile error here until it is read.
 */
function record<T extends object>(
  required: Fields<T, RequiredKeys<T>>,
  optional: Fields<T, OptionalKeys<T>>,
): Reader<T>;
function record<T extends object>(
  required: Fields<T, RequiredKeys<T>>,
  optional?: undefined,
): Reader<T>;
function record<T extends object>(
  required: Record<string, Reader<unknown>>,
  optional: Record<string, Reader<unknown>> = {},
): Reader<T> {
  return (value, path) => {
    if (!isRecord(value)) return bad(path, "an object");
    const out: Record<string, unknown> = {};
    for (const [key, read] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) bad(`${path}.${key}`, "a value");
      out[key] = read(value[key], `${path}.${key}`);
    }
    for (const [key, read] of Object.entries(optional)) {
      if (Object.hasOwn(value, key)) {
        out[key] = read(value[key], `${path}.${key}`);
      }
    }
    return out as T;
  };
}

/**
 * The names of a closed union of the contract, as a list a body can be checked
 * against: a name the contract has and the list lacks is a compile error.
 */
const closedUnion =
  <Union extends string>() =>
  <const Names extends readonly Union[]>(
    names:
      & Names
      & ([Exclude<Union, Names[number]>] extends [never] ? unknown
        : never),
  ): Names => names;

export const BOARD_COLUMN_IDS = closedUnion<BoardColumnId>()([
  "team",
  "cando",
  "rules",
  "guarantees",
  "information",
]);
export const BOARD_ITEM_KINDS = closedUnion<BoardItemKind>()([
  "scope",
  "operator",
  "machine",
  "capability",
  "capability-type",
  "tool",
  "skill",
  "access",
  "policy",
  "mandate",
  "authority",
  "requirement",
  "constraint",
  "lifecycle",
  "information",
]);
export const BOARD_LINK_KINDS = closedUnion<BoardLinkKind>()([
  "allocate",
  "bind",
  "can-call",
  "connect",
  "constrain",
  "exhibit",
  "own",
  "perform",
  "satisfy",
  "subject",
]);
const BIND_ROLES = closedUnion<BoardBindRole>()([
  "caller",
  "target",
  "mandate",
  "holder",
  "issuer",
]);
const CONTEXT_FAMILIES = closedUnion<BoardContextFamily>()([
  "context",
  "skill",
  "memory",
]);
const OPERATOR_KINDS = closedUnion<BoardOperatorKind>()([
  "human",
  "software",
]);

const ref = record<BoardRef>({ title: text, qname: text });
const group = record<BoardGroup>({ element: text, title: text });

const grant: Reader<BoardGrant> = record<BoardGrant>({
  file: text,
  qualifiedRoots: list(text),
});

/**
 * A typed value: a scalar, a list of strings, or a list of model-editing
 * grants. JSON held in a string is not a value of the contract. An empty list
 * is a list of strings.
 */
const boardValue: Reader<BoardValue> = (value, path) => {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return number(value, path);
  if (!Array.isArray(value)) return bad(path, "a scalar, strings or grants");
  if (value.every((entry) => typeof entry === "string")) return value;
  return list(grant)(value, path);
};

const valueEntry = record<BoardValueEntry>(
  { name: text, line: number, value: boardValue },
  { defines: nullable(text) },
);

const access = record<BoardAccess>({
  access: text,
  title: text,
  caller: text,
  enabled: flag,
});

const portItem = record<BoardPortItem>({ dir: text, title: text }, {
  type: text,
});

const port = record<BoardPort>({
  id: text,
  element: text,
  keyword: text,
  title: text,
  qname: text,
  file: text,
  line: number,
  conjugated: flag,
  inherited: flag,
  items: list(portItem),
}, { col: number, type: ref, linked: number });

const io = record<BoardIo>({ dir: text, title: text }, {
  type: text,
  element: text,
});

const loop = record<BoardLoop>({ to: text, toTitle: text });

const step = record<BoardStep>({ id: text, kind: text }, {
  element: text,
  branch: text,
  col: number,
  depth: number,
  file: text,
  forward: flag,
  unreachable: flag,
  guard: text,
  keyword: text,
  line: number,
  loops: list(loop),
  n: number,
  qname: text,
  title: text,
  to: text,
  toTitle: text,
  type: ref,
});

const clause = record<BoardClause>({
  id: text,
  element: text,
  keyword: text,
  title: text,
  qname: text,
  file: text,
  line: number,
}, { col: number, expression: text });

const flow = record<BoardFlow>({
  nodes: number,
  edges: number,
  back: number,
  supplemented: number,
  unresolved: number,
  sequential: flag,
  summary: record<BoardFlow["summary"]>({
    steps: number,
    decisions: number,
    merges: number,
    forks: number,
    loops: number,
    unreachable: number,
  }),
});

const transition = record<BoardTrackTransition>({
  id: text,
  element: text,
  name: nullable(text),
  on: nullable(text),
  guard: nullable(text),
  to: text,
  toTitle: text,
  back: flag,
  inherited: flag,
  file: text,
  line: number,
});

const trackState = record<BoardTrackState>({
  id: text,
  element: text,
  keyword: text,
  title: text,
  qname: text,
  file: text,
  line: number,
  col: number,
  rank: nullable(number),
  initial: flag,
  terminal: flag,
  inherited: flag,
  out: list(transition),
});

const track = record<BoardTrack>({
  mainCount: number,
  transitions: number,
  states: list(trackState),
}, { initial: text, extends: ref });

/** An item holds its children: the reader is recursive, and built once. */
let itemReader: Reader<BoardItem> | undefined;
const item: Reader<BoardItem> = (value, path) =>
  (itemReader ??= record<BoardItem>({
    id: text,
    element: text,
    keyword: text,
    title: text,
    qname: nullable(text),
    file: text,
    line: number,
    kind: oneOf(BOARD_ITEM_KINDS),
  }, {
    summary: text,
    summarySource: text,
    col: number,
    type: ref,
    definition: flag,
    group: list(group),
    scope: text,
    family: oneOf(CONTEXT_FAMILIES),
    operatorKind: oneOf(OPERATOR_KINDS),
    titleSource: text,
    subject: ref,
    satisfiedBy: list(text),
    owner: ref,
    expression: nullable(text),
    inForce: flag,
    values: list(valueEntry),
    access: list(access),
    children: list(item),
    ports: list(port),
    steps: list(step),
    io: list(io),
    flow,
    track,
    clauses: list(clause),
    depth: number,
    open: flag,
  }))(value, path);

const column = record<BoardColumn>({
  id: oneOf(BOARD_COLUMN_IDS),
  title: text,
  rule: anyRecord as Reader<Record<string, unknown>>,
  items: list(item),
});

const link = record<BoardLink>({
  id: text,
  kind: oneOf(BOARD_LINK_KINDS),
  from: text,
  to: text,
  via: nullable(text),
  file: text,
  line: number,
  exact: flag,
}, {
  role: oneOf(BIND_ROLES),
  derived: flag,
  enabled: flag,
  strength: text,
});

const diagnostic = record<BoardDiagnostic>({
  code: text,
  severity: oneOf(["error", "warning", "info"] as const),
  context: anyRecord,
  recovery: text,
});

const meta = record<BoardMeta>({
  model: text,
  mode: oneOf(["ase", "generic"] as const),
  sourceDigest: text,
  diagnostics: list(diagnostic),
  digest: text,
}, {
  toolkit: record<NonNullable<BoardMeta["toolkit"]>>({ version: text }),
  modeRule: text,
  anchors: dictionary(list(text)),
  linkLabels: dictionary(
    record<NonNullable<BoardMeta["linkLabels"]>[string]>(
      { forward: text, reverse: text },
      { derived: flag },
    ),
  ),
  counts: record<NonNullable<BoardMeta["counts"]>>({
    files: number,
    namedElements: number,
    items: list(record<{ column: BoardColumn["id"]; items: number }>({
      column: oneOf(BOARD_COLUMN_IDS),
      items: number,
    })),
  }, {
    linksTotal: number,
    invariants: record<
      NonNullable<NonNullable<BoardMeta["counts"]>["invariants"]>
    >({ checked: number, violations: number }),
  }),
  packages: list(record<NonNullable<BoardMeta["packages"]>[number]>({
    qname: text,
    doc: text,
    file: text,
    line: number,
  })),
  fieldSources: dictionary(text),
  timingMs: dictionary(number),
});

const indexEntry = record<BoardIndexEntry>({
  column: oneOf(BOARD_COLUMN_IDS),
  card: text,
});

const board = record<ModelBoard>({
  schema: oneOf(["ase.board/1"] as const),
  meta,
  columns: list(column),
  links: list(link),
  index: dictionary(indexEntry),
});

/**
 * The board a body is, or the first thing that is not one. Pure and total:
 * it throws `BoardParseError` and nothing else.
 */
export function parseModelBoard(body: unknown): ModelBoard {
  return board(body, "board");
}
