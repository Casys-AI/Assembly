import {
  versionMessages,
  type VersionProblemCode,
} from "../../model/revisions/api.ts";
import { isRecord } from "../../transport/is-record.ts";
import { ParseError } from "../../transport/unreadable-answer.ts";
import {
  canRetry,
  type ReadCodes,
  type ReadProblem,
  readProblemOf,
  readVersioned,
} from "../../model/versioned-read.ts";

/**
 * The one client of the authority matrix: `GET /api/model/authority-matrix`,
 * who may do what in the model as it declares it (the host's contract is
 * `src/domain/authority-matrix.ts`, schema `ase.authority-matrix/1`), read the
 * way every versioned route is (see `readVersioned`). The projection is slow
 * the first time a commit is asked for, so a page tells it is reading.
 *
 * The contract spells its names as closed unions (states, basis, codes,
 * families), and the host may add one before this page knows it. So the shape
 * is checked once, here: what identifies a thing (an id, the pair a cell
 * stands at, its state) must be there, and anything else is read as loosely as
 * the host may change it: a name outside the unions the host has today is kept
 * as it is, for the page to show as it is, and a value that is not there stays
 * absent. The types below are that loose reading, the page's own; the host's
 * closed unions (`src/domain/authority-matrix.ts`) are imported, as types, by
 * the modules that name the host's own words (`rights.ts`), so that a word the
 * host renames does not compile there.
 */

/** A place in the model's sources, as the host resolved it. */
export interface MatrixSource {
  /** What the place is to the cell: `grant`, `flag`, `scope`, `holder`... */
  role?: string;
  elementId?: string;
  qname?: string;
  /** The file of the model, by its path in the model. */
  file?: string;
  /** Counted from 1. */
  line?: number;
  column?: number;
}

/** Why a cell is what it is: the kind of rule, and the facts the kind gives (`rule`, `enforcedAt`, `grant`...). */
export interface MatrixVia {
  kind?: string;
  [fact: string]: string | number | boolean | undefined;
}

export interface MatrixGroup {
  id: string;
  label: string;
  order: number;
}

export interface MatrixRow {
  id: string;
  /** `software` or `human`, as the host says. */
  kind?: string;
  role?: string;
  label: string;
  /** The qualified name of the unit the row acts in. */
  unit?: string;
  /** Absent for the implicit owner of a model that does not declare one. */
  declared?: boolean;
  element?: MatrixSource;
}

export interface MatrixColumn {
  id: string;
  /** The family it belongs to. */
  group: string;
  label: string;
  order: number;
  /** What a right of the column does: `execute`, `propose`, `review`, `admit`. */
  mode?: string;
  tier?: string;
  /** What the right is, in a sentence. */
  doc?: string;
  /** What the column is about, typed: a column bound to a unit says which (`entry-kind`, `unit`). */
  target?: { kind: string; ref?: string; unit?: string };
}

export interface MatrixCell {
  row: string;
  column: string;
  /** `allowed`, `propose-only`, `denied`, `inherited`, `delegated`; a name the host adds is kept. */
  state: string;
  /** The three looks the host gives a state: `allowed`, `propose-only` or `denied`. */
  display?: string;
  mode?: string;
  basis?: string;
  sources: readonly MatrixSource[];
  via?: MatrixVia;
  /** The bounds of the right (`hosts`, `activeTools`, `operations`...), as the host projects them. */
  scope?: Readonly<Record<string, unknown>>;
  /** Why the cell is what it is, in the host's codes; one it adds is kept. */
  codes: readonly string[];
  /** What the host could not tell for sure, with what it says of it. */
  uncertain?: { code?: string; reason?: string };
}

export interface MatrixDiagnostic {
  code?: string;
  severity?: string;
  recovery?: string;
}

export interface AuthorityMatrix {
  /** The commit the matrix describes, when the body says. */
  version?: string;
  /** The model's name, and the way it declares its owner. */
  model: { name?: string; authoritySchema?: string };
  groups: readonly MatrixGroup[];
  rows: readonly MatrixRow[];
  columns: readonly MatrixColumn[];
  cells: readonly MatrixCell[];
  diagnostics: readonly MatrixDiagnostic[];
  /** What the matrix does not say, by the host's codes; the first is `ADOPTED_VERSION_ONLY`. */
  caveats: readonly string[];
  /** Identifies the content: the same digest is the same matrix. */
  digest?: string;
}

/** Where the body stopped being a matrix, and what it should have been. */
export class MatrixParseError extends ParseError {
  override name = "MatrixParseError";
}

const bad = (path: string, expected: string): never => {
  throw new MatrixParseError(path, expected);
};

/** A property that is a string, or is not there: what is of another type says nothing. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const flag = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;
/** The properties that are there, and only those: an absent value is absent, never `undefined`. */
const some = <T extends object>(
  entries: T,
): { [Name in keyof T]?: Exclude<T[Name], undefined> } =>
  Object.fromEntries(
    Object.entries(entries).filter(([, value]) => value !== undefined),
  ) as { [Name in keyof T]?: Exclude<T[Name], undefined> };

/** What identifies a thing must be a string. */
function required(value: unknown, path: string): string {
  return typeof value === "string" && value !== ""
    ? value
    : bad(path, "a string");
}

function entries(value: unknown, path: string): readonly unknown[] {
  return Array.isArray(value) ? value : bad(path, "an array");
}

function record(value: unknown, path: string): Record<string, unknown> {
  return isRecord(value) ? value : bad(path, "an object");
}

/** A place that says anything of itself: what it is to the cell, or where it is. */
function source(value: unknown): MatrixSource | undefined {
  if (!isRecord(value)) return undefined;
  const found = some({
    role: text(value.role),
    elementId: text(value.elementId),
    qname: text(value.qname),
    file: text(value.file),
    line: count(value.line),
    column: count(value.column),
  });
  return Object.keys(found).length > 0 ? found : undefined;
}

/** A rule that gives any plain fact: its kind, and the facts the kind gives. */
function via(value: unknown): MatrixVia | undefined {
  if (!isRecord(value)) return undefined;
  const facts: MatrixVia = {};
  for (const [name, fact] of Object.entries(value)) {
    if (
      typeof fact === "string" || typeof fact === "number" ||
      typeof fact === "boolean"
    ) facts[name] = fact;
  }
  return Object.keys(facts).length > 0 ? facts : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function group(value: unknown, at: number, path: string): MatrixGroup {
  const found = record(value, path);
  const id = required(found.id, `${path}.id`);
  return {
    id,
    label: text(found.label) ?? id,
    order: count(found.order) ?? at,
  };
}

function row(value: unknown, path: string): MatrixRow {
  const found = record(value, path);
  const id = required(found.id, `${path}.id`);
  return {
    id,
    label: text(found.label) ?? id,
    ...some({
      kind: text(found.kind),
      role: text(found.role),
      unit: text(found.unit),
      declared: flag(found.declared),
      element: source(found.element),
    }),
  };
}

function column(value: unknown, at: number, path: string): MatrixColumn {
  const found = record(value, path);
  const id = required(found.id, `${path}.id`);
  const aim = isRecord(found.target) ? found.target : {};
  const kind = text(aim.kind);
  return {
    id,
    group: required(found.group, `${path}.group`),
    label: text(found.label) ?? id,
    order: count(found.order) ?? at,
    ...some({
      mode: text(found.mode),
      tier: text(found.tier),
      doc: text(found.doc),
      target: kind === undefined
        ? undefined
        : { kind, ...some({ ref: text(aim.ref), unit: text(aim.unit) }) },
    }),
  };
}

function cell(value: unknown, path: string): MatrixCell {
  const found = record(value, path);
  const sources = Array.isArray(found.sources)
    ? found.sources.flatMap((entry) => source(entry) ?? [])
    : [];
  const unsure = isRecord(found.uncertain)
    ? some({
      code: text(found.uncertain.code),
      reason: text(found.uncertain.reason),
    })
    : undefined;
  const uncertain = unsure && Object.keys(unsure).length > 0
    ? unsure
    : undefined;
  return {
    row: required(found.row, `${path}.row`),
    column: required(found.column, `${path}.column`),
    state: required(found.state, `${path}.state`),
    sources,
    codes: strings(found.codes),
    ...some({
      display: text(found.display),
      mode: text(found.mode),
      basis: text(found.basis),
      via: via(found.via),
      scope: isRecord(found.scope) ? { ...found.scope } : undefined,
      uncertain,
    }),
  };
}

/** A diagnostic that says anything: what it is, how grave, or what to do. */
function diagnostic(value: unknown): MatrixDiagnostic[] {
  if (!isRecord(value)) return [];
  const found = some({
    code: text(value.code),
    severity: text(value.severity),
    recovery: text(value.recovery),
  });
  return Object.keys(found).length > 0 ? [found] : [];
}

/**
 * The matrix from a body, checked once. A body that is not a matrix of the
 * schema this page reads, or whose rows, columns and cells do not say what
 * they are, is refused with the path of the first thing wrong; everything the
 * page does not read is dropped, a name the host added is kept, and a value
 * that is not there stays absent (a place without a role keeps its file).
 */
export function parseMatrix(body: unknown): AuthorityMatrix {
  const found = record(body, "matrix");
  if (found.schema !== "ase.authority-matrix/1") {
    bad("matrix.schema", "ase.authority-matrix/1");
  }
  const model = isRecord(found.model) ? found.model : {};
  return {
    model: some({
      name: text(model.name),
      authoritySchema: text(model.authoritySchema),
    }),
    groups: Array.isArray(found.groups)
      ? found.groups.map((entry, at) =>
        group(entry, at, `matrix.groups[${at}]`)
      )
      : [],
    rows: entries(found.rows, "matrix.rows").map((entry, at) =>
      row(entry, `matrix.rows[${at}]`)
    ),
    columns: entries(found.columns, "matrix.columns").map((entry, at) =>
      column(entry, at, `matrix.columns[${at}]`)
    ),
    cells: entries(found.cells, "matrix.cells").map((entry, at) =>
      cell(entry, `matrix.cells[${at}]`)
    ),
    diagnostics: Array.isArray(found.diagnostics)
      ? found.diagnostics.flatMap(diagnostic)
      : [],
    caveats: strings(found.caveats),
    ...some({ version: text(found.version), digest: text(found.digest) }),
  };
}

/**
 * What went wrong, for a program to act on; `message` is for the person. The
 * version asked for may be refused (`VersionProblemCode`).
 */
export type MatrixProblemCode =
  | VersionProblemCode
  /** The Toolkit did not answer in time: reading again may work. */
  | "matrix-timeout"
  /** The host could not be reached. */
  | "matrix-unavailable"
  /** The host answered, but not with a matrix this page can read. */
  | "matrix-invalid"
  /** The host failed to project the matrix. */
  | "matrix-failed";

export type MatrixProblem = ReadProblem<MatrixProblemCode>;

/** What the matrix's reads fail with: the codes of `MatrixProblemCode`. */
const CODES: ReadCodes<MatrixProblemCode> = {
  timeout: "matrix-timeout",
  unavailable: "matrix-unavailable",
  invalid: "matrix-invalid",
  failed: "matrix-failed",
};

/** The one way a page turns a failed read into a coded problem (see `readProblemOf`). */
export function matrixProblem(
  failure: unknown,
  asked: boolean = false,
): MatrixProblem {
  return readProblemOf<MatrixProblemCode>(failure, asked, {
    ...CODES,
    messages: {
      ...versionMessages,
      "matrix-timeout": "The rights took too long to read.",
      "matrix-unavailable": "The rights could not be read.",
      "matrix-invalid": "The rights were read in a form this page cannot use.",
      "matrix-failed": "The rights could not be read.",
    },
  });
}

/** Reading again helps when the host or the Toolkit did not answer, not when the version is refused or the answer is not a matrix. */
export const matrixCanRetry = (
  problem: Pick<MatrixProblem, "code">,
): boolean => canRetry(problem, CODES);

/** A matrix, and the commit of the model it describes. */
export interface MatrixRead {
  matrix: AuthorityMatrix;
  /** The immutable commit the matrix describes: the head's when none was asked. */
  version: string;
}

export function createMatrixApi(
  options: { fetch?: typeof fetch } = {},
) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    /**
     * The matrix of `version`, or of the head without one. A commit never
     * changes, so the browser may keep its answer; the head is always asked.
     */
    async read(version?: string, signal?: AbortSignal): Promise<MatrixRead> {
      const read = await readVersioned(
        request,
        "/api/model/authority-matrix",
        version,
        signal,
      );
      return { matrix: parseMatrix(read.body), version: read.version };
    },
  };
}

export type MatrixApi = ReturnType<typeof createMatrixApi>;
