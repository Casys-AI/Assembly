import type {
  MatrixCellCode,
  MatrixColumnId,
  MatrixFamily,
} from "../../../../src/domain/governance/records/authority-matrix.ts";
import { lastName } from "../board/words.ts";
import type {
  AuthorityMatrix,
  MatrixCell,
  MatrixColumn,
  MatrixRow,
  MatrixSource,
} from "./api.ts";
import { YOU } from "../team/projection.ts";

/**
 * Who may do what, read from the authority matrix: the actors (you first), the
 * families of rights, a mark for each right, and the words to tell them in.
 * Pure: the same matrix and the same names always give the same reading.
 *
 * The host's names are closed unions today (states, codes, families), and it
 * may add one before this module knows it. A name outside them is never an
 * error: a state the host adds looks as the host says it looks (`display`),
 * a code is shown as it is, a family is named by its own label. Columns are
 * told from what the host types about them (`group`, `target`), never by
 * taking their identifier apart. Where this module spells a name the host has
 * today (a code, a family, a column), it is checked against the host's union
 * (`satisfies`, a `Partial<Record<…>>` table), so a name the host renames does
 * not compile here; a name the host adds is no error, it is just not told.
 */

/**
 * The codes that say a right is granted but of no use. They are the host's
 * (`UNUSABLE` in `src/domain/authority-matrix.ts`); a mistyped one does not compile.
 */
export const UNUSABLE = [
  "RIGHT_WITHOUT_OBJECT",
  "EFFECTIVELY_UNREACHABLE",
  "NO_REACHABLE_HOST",
  "NETWORK_SCOPE_UNUSED",
] as const satisfies readonly MatrixCellCode[];

/** The codes that say a right is never given, to anyone but the host or the owner. */
export const HARD = [
  "HARD_DENIED",
  "HOST_RESERVED",
] as const satisfies readonly MatrixCellCode[];

/** What each code of the host means, in a phrase; a code not listed is shown as it is. */
const CODE_WORDS: Readonly<Partial<Record<MatrixCellCode, string>>> = {
  RIGHT_WITHOUT_OBJECT: "nothing to act on",
  EFFECTIVELY_UNREACHABLE: "unreachable under the current policy",
  NO_REACHABLE_HOST: "no host declared for tool calls",
  NETWORK_SCOPE_UNUSED: "its mandate may not call tools",
  NEEDS_HUMAN_DECISION: "waits for a person's decision",
  ADMISSION_BY_HUMAN: "a person admits",
  PRIVATE_UNTIL_DECIDED: "private until it is decided",
  HARD_DENIED: "never allowed",
  HOST_RESERVED: "reserved to the host",
  OWNER_ONLY_PATH: "only the owner takes this path",
  OWNER_ROOT_GRANT_UNDIFFERENTIATED: "the owner holds one grant for everything",
  OWNER_IMPLICIT: "the owner is not declared in the model",
  ADMISSION_BY_BUILDER: "the builder admits its own tools",
  ADMISSION_BY_REVIEWER: "a reviewer admits",
  HUMAN_ADMISSION_NOT_REQUIRED: "no person has to admit",
  MODEL_POLICY_FORBIDS: "the model's policy forbids it",
  NO_ADMINISTRATION_POLICY: "no administration policy declared",
  NO_EDIT_POLICY: "no edit policy declared",
  NO_HOSTS_DECLARED: "no host declared",
  SELF_ADMISSION_FORBIDDEN: "may not admit its own work",
  POLICY_INACTIVE_WITHOUT_FLAG: "the policy is off without its flag",
  EXPOSURE_DISABLED: "the exposure is disabled",
  ALREADY_CREATED: "already created",
  ALREADY_DELEGATED: "already delegated",
};

/** What a code means, in a phrase, when it is one the host has told us about. */
export const codeWords = (code: string): string | undefined =>
  Object.hasOwn(CODE_WORDS, code)
    ? CODE_WORDS[code as MatrixCellCode]
    : undefined;

const hasAny = (cell: Pick<MatrixCell, "codes">, codes: readonly string[]) =>
  cell.codes.some((code) => codes.includes(code));

/** A right is granted, offered as a proposal, or not given. */
type Standing = "granted" | "proposes" | "denied";

/**
 * How a cell stands. The host gives every cell its look (`display`: allowed,
 * propose-only or denied) from its state and its mode, so a state it adds
 * needs no word here. A cell without one (an older snapshot) stands as its
 * state says, and a state with no look is not given.
 */
function standingOf(cell: Pick<MatrixCell, "state" | "display">): Standing {
  switch (cell.display ?? cell.state) {
    case "allowed":
    case "inherited":
      return "granted";
    case "propose-only":
      return "proposes";
    default:
      return "denied";
  }
}

/** The states the host has today, which a cell without a look stands by. */
const KNOWN_STATES = ["allowed", "inherited", "propose-only", "denied"];

/**
 * The right can be used: granted, and not by a code that says it is of no use
 * (nothing to act on, no host to reach, a mandate that may not call tools...).
 */
export function usable(cell: Pick<MatrixCell, "state" | "display" | "codes">) {
  return standingOf(cell) === "granted" && !hasAny(cell, UNUSABLE);
}

/**
 * What a cell is, as a mark: `full` (can be done alone), `half` (can be
 * proposed, a decision follows), `lock` (never given), `empty` (not given, or
 * granted but of no use: then `unusable`).
 */
export type MarkKind = "full" | "half" | "empty" | "lock";

export interface Mark {
  kind: MarkKind;
  /** Granted by the model, but of no use (see `UNUSABLE`). */
  unusable: boolean;
  /** The state, when the host's state is one this page has no look for: told as it is. */
  other?: string;
}

export function markOf(
  cell: Pick<MatrixCell, "state" | "display" | "codes">,
): Mark {
  const standing = standingOf(cell);
  if (standing === "granted" && !hasAny(cell, UNUSABLE)) {
    return { kind: "full", unusable: false };
  }
  if (standing === "proposes") return { kind: "half", unusable: false };
  const unusable = standing === "granted";
  if (!unusable && hasAny(cell, HARD)) return { kind: "lock", unusable: false };
  return {
    kind: "empty",
    unusable,
    ...(KNOWN_STATES.includes(cell.state) || cell.display !== undefined
      ? {}
      : { other: cell.state }),
  };
}

/**
 * Several marks as one: it can be done alone if any can, proposed if any can,
 * never given only if none is; granted-but-unusable when that is all there is.
 */
export function foldMarks(marks: readonly Mark[]): Mark {
  if (marks.some((mark) => mark.kind === "full")) {
    return { kind: "full", unusable: false };
  }
  if (marks.some((mark) => mark.kind === "half")) {
    return { kind: "half", unusable: false };
  }
  if (marks.length > 0 && marks.every((mark) => mark.kind === "lock")) {
    return { kind: "lock", unusable: false };
  }
  const other = marks.find((mark) => mark.other !== undefined)?.other;
  return {
    kind: "empty",
    unusable: marks.some((mark) => mark.unusable),
    ...(other !== undefined && marks.every((mark) => mark.other !== undefined)
      ? { other }
      : {}),
  };
}

/** A mark in a word, for a tooltip. */
export function said(mark: Mark): string {
  return mark.kind === "full"
    ? "yes"
    : mark.kind === "half"
    ? "proposes"
    : mark.kind === "lock"
    ? "never"
    : mark.unusable
    ? "granted, unusable"
    : mark.other ?? "no";
}

/** What the codes of a cell that make it unusable say, each once. */
export function unusableWords(
  cells: readonly Pick<MatrixCell, "codes">[],
): string[] {
  return [
    ...new Set(
      cells.flatMap((cell) =>
        cell.codes.filter((code) =>
          (UNUSABLE as readonly string[]).includes(code)
        )
          .map((code) => codeWords(code) ?? code)
      ),
    ),
  ];
}

/** A family of rights: the columns that share a `group`, in the host's order. */
export interface Family {
  id: string;
  /** The host's own name for it. */
  label: string;
  /** A short name for a column heading; the label when this page has none. */
  short: string;
  columns: readonly MatrixColumn[];
}

/** The short headings the families of the host have today; one it adds is headed by its label. */
const SHORT: Readonly<Partial<Record<MatrixFamily, string>>> = {
  "tools": "Tools",
  "admission": "Approve",
  "mandate": "Mandate",
  "model": "Model",
  "memory-skills": "Memory",
  "behaviors": "Work",
};

const shortOf = (family: string, label: string): string =>
  Object.hasOwn(SHORT, family) ? SHORT[family as MatrixFamily]! : label;

const inOrder = <T extends { order: number }>(entries: readonly T[]): T[] =>
  entries.map((entry, at) => ({ entry, at }))
    .sort((a, b) => (a.entry.order - b.entry.order) || a.at - b.at)
    .map(({ entry }) => entry);

/**
 * The families of the matrix that have columns, in the host's order. A column
 * whose family the host did not list (a family it adds) makes one, after the
 * others, named by its id.
 */
export function familiesOf(matrix: AuthorityMatrix): Family[] {
  const listed = inOrder(matrix.groups);
  const orphans = [
    ...new Set(
      matrix.columns.map((column) => column.group).filter((id) =>
        !listed.some((group) => group.id === id)
      ),
    ),
  ];
  return [
    ...listed.map((group) => ({ id: group.id, label: group.label })),
    ...orphans.map((id) => ({ id, label: id })),
  ].map(({ id, label }) => ({
    id,
    label,
    short: shortOf(id, label),
    columns: inOrder(matrix.columns.filter((column) => column.group === id)),
  })).filter((family) => family.columns.length > 0);
}

/** A unit of the model as the page calls it, by the qualified name the matrix knows it by. */
export interface UnitName {
  qname: string | null | undefined;
  name: string;
}

/** Someone, or something, that holds rights: the person (all the owner's rows), or one operator. */
export interface Actor {
  /** `you` for the person, else the row of the operator. */
  id: string;
  label: string;
  you: boolean;
  /** The matrix rows it stands for; none until the matrix is read. */
  rows: readonly MatrixRow[];
  /**
   * Builds tools and admits them itself, with no operator in the model that
   * may review them (the build cells say who admits).
   */
  selfApproves: boolean;
}

/** The families of rights in which a self-approving actor is flagged. */
export const FLAGGED_FAMILIES: readonly string[] = [
  "tools",
  "admission",
] satisfies readonly MatrixFamily[];

/** The rights of the host that tell who reviews and who admits a tool, and the family of the tools. */
const REVIEW = "candidate.review" satisfies MatrixColumnId;
const ADMIT = "candidate.admit" satisfies MatrixColumnId;
const TOOLS = "tools" satisfies MatrixFamily;

/** The code of a build cell that says the builder admits its own tools. */
const BY_BUILDER = "ADMISSION_BY_BUILDER" satisfies MatrixCellCode;

/** What the flag says, for a tooltip. */
export const SELF_APPROVAL =
  "Approves its own tools; no operator may review them";

/** The key of a cell of the matrix, as the address names it: the row, then the column. */
export const cellKey = (row: string, column: string) => `${row}|${column}`;

/** The key of the mark of an actor in a family, as the address names it. */
export const markKey = (actor: string, family: string) => `${actor}|${family}`;

/** One right of a family, and what an actor holds of it. */
export interface Line {
  column: MatrixColumn;
  /** The actor's cells of the column, one per row it stands for that has one. */
  cells: readonly MatrixCell[];
  mark: Mark;
}

export interface Rights {
  families: readonly Family[];
  /** You first, then the operators in the order of the matrix (or of the team without one). */
  actors: readonly Actor[];
  at(row: string, column: string): MatrixCell | undefined;
  /** The rights of a family the actor has a cell for; none when it has none in it. */
  lines(actor: Actor, family: Family): readonly Line[];
  /** What the actor holds in the family, as one mark; none when it holds nothing in it. */
  markIn(actor: Actor, family: Family): Mark | undefined;
  /** The flag of a self-approving actor, where it is drawn. */
  flagged(actor: Actor, family: Family): boolean;
  /** A column of rights, as the page calls it (the matrix's own label in SysML's words). */
  columnLabel(column: MatrixColumn, sysml: boolean): string;
  /** A row of the matrix, as the page calls it. */
  rowLabel(row: MatrixRow, sysml: boolean): string;
}

/**
 * The rights of the model, ready to draw. `units` are the units of the board
 * as the page calls them, which name the operators of the matrix; without a
 * matrix yet the actors are the team's own and hold nothing.
 */
export function rightsOf(
  matrix: AuthorityMatrix | undefined,
  units: readonly UnitName[],
): Rights {
  const cells = new Map<string, Map<string, MatrixCell>>();
  for (const cell of matrix?.cells ?? []) {
    const row = cells.get(cell.row) ?? new Map<string, MatrixCell>();
    cells.set(cell.row, row.set(cell.column, cell));
  }
  const at = (row: string, column: string) => cells.get(row)?.get(column);
  const unitName = (qname: string | undefined) =>
    qname === undefined
      ? undefined
      : units.find((unit) => unit.qname === qname)?.name ?? lastName(qname);

  const rows = matrix?.rows ?? [];
  const holders = rows.filter((row) => usable(at(row.id, REVIEW) ?? NO_CELL));
  const toolColumns = (matrix?.columns ?? []).filter((column) =>
    column.group === TOOLS
  );
  const selfApproves = (row: MatrixRow) =>
    row.kind !== "human" && holders.length === 0 &&
    toolColumns.some((column) =>
      at(row.id, column.id)?.codes.includes(BY_BUILDER)
    ) &&
    usable(at(row.id, ADMIT) ?? NO_CELL);

  const operators = rows.filter((row) => row.kind !== "human");
  const crowded = (row: MatrixRow) =>
    operators.some((other) => other !== row && other.unit === row.unit);
  const operatorLabel = (row: MatrixRow) => {
    const name = unitName(row.unit) ?? row.label;
    return crowded(row) ? `${name} · ${row.role ?? row.label}` : name;
  };
  const people = rows.filter((row) => row.kind === "human");
  const actors: Actor[] = [
    {
      id: YOU,
      label: "You",
      you: true,
      rows: people,
      selfApproves: false,
    },
    ...(matrix
      ? operators.map((row) => ({
        id: row.id,
        label: operatorLabel(row),
        you: false,
        rows: [row],
        selfApproves: selfApproves(row),
      }))
      : units.map((unit) => ({
        id: unit.qname ?? unit.name,
        label: unit.name,
        you: false,
        rows: [],
        selfApproves: false,
      }))),
  ];

  const families = matrix ? familiesOf(matrix) : [];
  const lines = (actor: Actor, family: Family): Line[] =>
    family.columns.flatMap((column) => {
      const held = actor.rows.flatMap((row) => at(row.id, column.id) ?? []);
      return held.length > 0
        ? [{ column, cells: held, mark: foldMarks(held.map(markOf)) }]
        : [];
    });
  const distinctUnits = new Set(
    (matrix?.columns ?? []).flatMap((column) => column.target?.unit ?? []),
  );

  return {
    families,
    actors,
    at,
    lines,
    markIn(actor, family) {
      const held = lines(actor, family);
      return held.length > 0
        ? foldMarks(held.map((line) => line.mark))
        : undefined;
    },
    flagged: (actor, family) =>
      actor.selfApproves && FLAGGED_FAMILIES.includes(family.id),
    columnLabel(column, sysml) {
      const unit = column.target?.unit;
      if (sysml || unit === undefined) return column.label;
      const name = unitName(unit)!;
      if (column.target?.ref === "inbox") return `Hand work to ${name}`;
      // The label names the unit it is bound to after a dot: the heading says it once.
      const suffix = ` · ${lastName(unit)}`;
      const own = column.label.endsWith(suffix)
        ? column.label.slice(0, -suffix.length)
        : column.label;
      return distinctUnits.size > 1 ? `${own} of ${name}` : own;
    },
    rowLabel(row, sysml) {
      if (row.kind === "human") {
        const unit = unitName(row.unit);
        return unit ? `You · in ${unit}` : "You";
      }
      return sysml
        ? `${row.role ?? row.label} · ${unitName(row.unit) ?? row.label}`
        : operatorLabel(row);
    },
  };
}

/** The actor of the global Main, beside a Case's rights. */
export const MAIN_ACTOR = "main-operator";

/**
 * One operator in another system's rights, as an actor of its own: the row of
 * `operatorId` there. A Case runs the same operator as the Main, so this is the
 * Main in the main system's matrix, or a Branch Operator in its branch's. Other
 * rows of the same unit (a reviewer) are not that operator's. No row while the
 * matrix is not read, or when it lacks the operator.
 */
export function operatorActorOf(
  rights: Rights,
  operatorId: string,
  as: { id: string; label: string },
): Actor {
  return {
    ...as,
    you: false,
    rows: rights.actors
      .filter((actor) => !actor.you)
      .flatMap((actor) => actor.rows)
      .filter((row) => row.id === operatorId),
    selfApproves: false,
  };
}

/** The global Main in the main system's rights. */
export const mainActorOf = (rights: Rights, operatorId: string): Actor =>
  operatorActorOf(rights, operatorId, {
    id: MAIN_ACTOR,
    label: "Main Operator",
  });

/**
 * A line read from another system's rights, drawn muted beside the page's
 * own: the global Main in a Case, a Branch Operator on the main system.
 */
export interface ReferenceRights {
  rights: Rights;
  actor: Actor;
  /** Where its own system shows those rights. */
  href: string;
  /** Its initials, as its Dock tile or Team node shows them. */
  initials: string;
  /** What the line is, for its tooltip. */
  about: string;
  /** Why its marks are missing, when its rights could not be read. */
  problem?: string;
}

/** A right nobody holds: it is not usable. */
const NO_CELL = { state: "denied", codes: [] } as const;

/**
 * How a cell is drawn as a dot of the matrix: `allowed` (filled),
 * `inherited` (ringed in ink), `propose` (half), `denied` (ringed, faint). A
 * state the host adds is drawn as the host says it looks.
 */
export function dotOf(
  cell: Pick<MatrixCell, "state" | "display">,
): "allowed" | "inherited" | "propose" | "denied" {
  if (cell.state === "inherited") return "inherited";
  const standing = standingOf(cell);
  return standing === "granted"
    ? "allowed"
    : standing === "proposes"
    ? "propose"
    : "denied";
}

/** Why a cell is what it is, in words: the rule of the host, or where the grant comes from. */
export function ruleOf(cell: Pick<MatrixCell, "via">): string | undefined {
  const via = cell.via;
  if (!via) return undefined;
  const fact = (name: string) =>
    via[name] === undefined ? undefined : String(via[name]);
  switch (via.kind) {
    case "own-declaration":
      return "declared by the operator itself";
    case "unit-configuration":
      return `the unit's ${fact("attribute") ?? "configuration"}`;
    case "exposure":
      return `exposed as ${fact("accessName") ?? "an access"}`;
    case "delegation":
      return `delegated${fact("record") ? ` by ${fact("record")}` : ""}${
        fact("revision") ? `, revision ${fact("revision")}` : ""
      }`;
    case "root-grant":
      return `the root grant ${fact("grant") ?? ""} of mandate ${
        fact("mandate") ?? ""
      }`.replace(/\s+/g, " ").trim();
    default:
      return fact("rule") ?? via.kind;
  }
}

/** A place in the model's sources, as a chip names it: the last two names of the element, else its role; none when it has neither. */
export function sourceName(source: MatrixSource): string | undefined {
  return source.qname
    ? source.qname.split("::").slice(-2).join("::")
    : source.role;
}

/** The places the cell's rule is declared in a file of the model, each once. */
export function declaredBy(
  cell: Pick<MatrixCell, "sources">,
): readonly (MatrixSource & { file: string })[] {
  const seen = new Set<string>();
  return cell.sources.flatMap((source) => {
    if (source.file === undefined) return [];
    const key = `${source.file}:${source.line ?? ""}:${source.qname ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [source as MatrixSource & { file: string }];
  });
}

/** What the matrix says it does not tell, in a sentence, by the host's code. */
const CAVEAT_WORDS: Readonly<Record<string, string>> = {
  ADOPTED_VERSION_ONLY:
    "These are the rights of the version shown above, as its sources declare them; proposals waiting for a decision are not counted.",
  ALLOWED_IS_DECLARED_NOT_EXECUTED:
    "Allowed means declared: every action still passes the host's checks when it is done.",
  ABSENT_CELL_IS_NOT_APPLICABLE:
    "A blank cell means nothing declares a right there.",
  OWNER_CELLS_ARE_HOST_RULES_BEFORE_LOT_3:
    "The owner is not declared in this model: its cells are rules of the host.",
};

/**
 * What the page says the matrix does not tell. `version` is always said, read
 * or not, and plainly: which version the rights are of. `note` is the rest, for
 * a tooltip, a line for each caveat of the matrix: in the page's words when it
 * knows them, as the host wrote them when it does not; none when there is
 * nothing more to say.
 */
export function caveatsOf(
  matrix: AuthorityMatrix | undefined,
): { version: string; note?: string } {
  const notes = (matrix?.caveats ?? []).flatMap((caveat) =>
    caveat === "ADOPTED_VERSION_ONLY"
      ? []
      : [Object.hasOwn(CAVEAT_WORDS, caveat) ? CAVEAT_WORDS[caveat] : caveat]
  );
  return {
    version: CAVEAT_WORDS.ADOPTED_VERSION_ONLY,
    ...(notes.length > 0 ? { note: notes.join("\n") } : {}),
  };
}
