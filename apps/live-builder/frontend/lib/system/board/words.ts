import type {
  BoardItemKind,
  BoardValue,
} from "../../../../src/domain/model/records/board.ts";
import { isTextList } from "./values.ts";

/**
 * The words the System pages put on what the board declares: an identifier in
 * camel case as a phrase, a count or a duration as a person says it, what a
 * kind of element is called, a value as it reads. Pure, and English (the
 * interface's language); the same input always reads the same.
 */

/** `maxAgentDecisions` as "Max agent decisions", `read_web_page` as "Read web page". */
export function humanize(identifier: string): string {
  return identifier
    .replace(/_+/g, " ")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (first) => first.toUpperCase())
    .replace(
      / ([A-Z])(?=[a-z])/g,
      (_, letter: string) => ` ${letter.toLowerCase()}`,
    );
}

/** 1500000 as "1.5M", 12000 as "12k", anything smaller in full. */
export function compact(count: number): string {
  // 999,600 rounds to 1000k, which is a million.
  return count >= 999_500
    ? `${+(count / 1e6).toFixed(1)}M`
    : count >= 1e4
    ? `${Math.round(count / 1e3)}k`
    : count.toLocaleString("en");
}

/** Milliseconds as "30 s", "2 min" or "1.5 h". */
export function duration(ms: number): string {
  return ms >= 3_600_000
    ? `${+(ms / 3_600_000).toFixed(2)} h`
    : ms >= 60_000
    ? `${+(ms / 60_000).toFixed(2)} min`
    : `${+(ms / 1000).toFixed(2)} s`;
}

/** A name that ends in `Ms` measures a duration, in milliseconds. */
const isDuration = (name: string) => /Ms$/.test(name);

/** The name of a measure without its unit: `timeoutMs` as "timeout". */
export function withoutUnit(name: string): string {
  return name.replace(/Ms$/, "");
}

/** A number as the figure called `name` says it: a duration with its unit, else a count. */
export function figure(value: number, name: string): string {
  return isDuration(name) ? duration(value) : compact(value);
}

/**
 * What the model says of an element in its own note: the note of a package
 * describes the package, not the element that happens to be its first, so it
 * is not the element's.
 */
export function ownSummary(
  element: { summary?: string; summarySource?: string },
): string | undefined {
  return element.summarySource === "package-doc" ? undefined : element.summary;
}

/** The last name of a qualified name: `A::b::c` as "c". */
export function lastName(qualified: string): string {
  return qualified.split("::").pop() || qualified;
}

/** Names in a sentence: "a", "a and b", "a, b and c". */
export function listing(names: readonly string[]): string {
  return names.length < 2
    ? names.join("")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What the mark of an element declared in several units says: one in each of them; nothing when no unit is known. */
export function perSystem(units: readonly string[]): string | undefined {
  return units.length > 0 ? `one per system: ${listing(units)}` : undefined;
}

/**
 * The kinds of the steps of a flow. The board types them as plain text; these
 * are the ones the pages know: what the model declares (`action`, `decision`,
 * `merge`, `fork`, `join`), a jump (`goto`), and the marks of the thread's
 * ends (`start` and `done` are the library's own, `end` is the model's).
 */
export const STEP_KINDS = [
  "action",
  "decision",
  "merge",
  "goto",
  "fork",
  "join",
  "start",
  "end",
  "done",
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/**
 * The kind of a step as the pages know it; a kind the model invents is none
 * (the page draws it as a plain step). Comparing what this gives is checked by
 * the compiler, comparing the board's own text is not.
 */
export function stepKind(step: { kind: string }): StepKind | undefined {
  return (STEP_KINDS as readonly string[]).includes(step.kind)
    ? step.kind as StepKind
    : undefined;
}

type KnownKind = BoardItemKind | StepKind | "port" | "clause" | "state";

/**
 * What a kind of element is called by a person; some have no word. Typed by
 * the board's kinds, so a kind the contract adds is a type error until it has
 * its entry here.
 */
const KIND_WORDS: Readonly<Record<KnownKind, string>> = {
  scope: "system",
  operator: "operator",
  machine: "component",
  capability: "flow",
  "capability-type": "tool type",
  tool: "tool",
  skill: "skill",
  access: "access",
  policy: "policy",
  mandate: "mandate",
  authority: "right",
  requirement: "guarantee",
  constraint: "check",
  lifecycle: "lifecycle",
  information: "information",
  action: "step",
  decision: "decision",
  merge: "merge",
  goto: "",
  fork: "fork",
  join: "join",
  // The marks of the ends of a thread say nothing: they are not elements to open.
  start: "",
  end: "",
  done: "",
  port: "port",
  state: "state",
  clause: "clause",
};

const isKnown = (kind: string): kind is KnownKind =>
  Object.hasOwn(KIND_WORDS, kind);

/**
 * The word for an element of the model: its kind as a person says it. The
 * keyword of its declaration says a check when it declares a constraint, for
 * kinds the table does not know; the empty string is no word.
 */
export function kindWord(
  element: { kind: string; keyword: string },
): string {
  if (isKnown(element.kind)) return KIND_WORDS[element.kind];
  return element.keyword.includes("constraint") ? "check" : "";
}

/**
 * Names a person does not read as facts about an element: identity and
 * versioning. The one list of them: every readable view of what the model
 * declares (the detail of an element, the profile of an agent) leaves them
 * out; the SysML view keeps them.
 */
export function isMasked(name: string): boolean {
  return /^(id|version|revision|configurationId|configurationRevision|envelope[A-Z]\w*|evidenceLevel|source|operatorName)$/
    .test(name);
}

/** A declared value as a person reads it: yes and no, a duration, a count, a list. */
export function readableValue(value: BoardValue, name: string): string {
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return figure(value, name);
  if (typeof value === "string") return value;
  if (isTextList(value)) return value.length === 0 ? "none" : value.join(", ");
  return value.map((grant) =>
    `${grant.file}: ${grant.qualifiedRoots.map(lastName).join(", ")}`
  ).join("; ");
}

/** A declared value as the SysML view shows it: as written, lists as JSON. */
export function rawValue(value: BoardValue): string {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}
