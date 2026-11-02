/** Replayed host operations retain their identity and base member preimage. */
export type Scalar = string | boolean | number;
export interface EditTarget {
  id: string;
  qualifiedName: string;
  metaclass: string;
  preimage: string;
  ownerId?: string;
}
export type HostTarget = { qualifiedName: string } | { elementId: string };
export interface LiteralExpectation {
  kind: "literal";
  path: string;
  value: Scalar;
}
export interface MemberExpectation {
  kind: "member";
  qualifiedName: string;
  metaclass: string;
  sourceText?: string;
  sourceDigest?: string;
}
/** Large declarations are stored once, losslessly, rather than repeated in proofs. */
export type StoredSourceText = string | {
  encoding: "gzip-base64";
  data: string;
};
export type InsertionExpectation = LiteralExpectation | MemberExpectation;
/** Existing builders may omit the literal tag; every new receipt includes it. */
export type InsertionRequestExpectation =
  | InsertionExpectation
  | (Omit<LiteralExpectation, "kind"> & { kind?: "literal" });
type Operation<T, E = InsertionExpectation, Text = string> =
  | { op: "setFeatureValue"; target: T; value: Scalar }
  | {
    op: "insertMember";
    owner: T;
    text: Text;
    expect: E[];
    intent?: "authority";
    expectDigest?: string;
  }
  | { op: "replaceMember"; target: T; text: Text }
  | { op: "setFeatureType"; target: T; type: string }
  | { op: "remove"; target: T };
export interface IntroducedMember {
  qualifiedName: string;
  metaclass: string;
  value?: Scalar;
  valueDigest?: string;
}
export type HostEdit =
  & Operation<EditTarget, InsertionExpectation, StoredSourceText>
  & {
    /** Absent only on historical operations projected by the compatibility reader. */
    format?: 1;
    batch?: number;
    introduced?: IntroducedMember[];
  };
export type HostEditRequest =
  & Operation<HostTarget, InsertionRequestExpectation>
  & { batch?: number };
export function hostEditTarget<T>(edit: Operation<T, unknown, unknown>): T {
  return edit.op === "insertMember" ? edit.owner : edit.target;
}
export class HostEditError extends Error {
  readonly recovery: "refuse" | { readonly action: "reload" };
  constructor(
    readonly code:
      | "TARGET_MISSING"
      | "TARGET_AMBIGUOUS"
      | "TARGET_MODIFIED"
      | "LITERAL_KIND_CHANGED"
      | "SPLICE_OUT_OF_SCOPE"
      | "TOOLKIT_REFUSED"
      | "READ_BACK_MISMATCH"
      | "COMPILE_ERROR"
      | "MIGRATION_DEPENDENT_REFERENCE",
    readonly context: {
      opIndex: number;
      /** Host operation, or `proposeEdit` for a whole targeted-proposal call. */
      op: string;
      target: HostTarget | EditTarget;
    },
    message: string,
  ) {
    super(message);
    this.name = "HostEditError";
    this.recovery = code === "TARGET_MODIFIED"
      ? { action: "reload" }
      : "refuse";
  }
}

/** True when `spelling` needs no `\u` escape for this text. The SysML lexer
 * rejects that escape, so a lone surrogate, U+2028/2029 or a control character
 * other than \b \t \n \f \r cannot be written as a literal. */
export function isSpellable(text: string): boolean {
  if (!text.isWellFormed()) return false;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code === 0x2028 || code === 0x2029) return false;
    if (
      code < 0x20 && code !== 0x08 && code !== 0x09 && code !== 0x0a &&
      code !== 0x0c && code !== 0x0d
    ) return false;
  }
  return true;
}

/** The only text generated for scalar operations is the literal expression. */
export function spelling(value: unknown): string {
  if (
    !(typeof value === "string" || typeof value === "boolean" ||
      typeof value === "number" && Number.isFinite(value))
  ) {
    throw new Error("Only scalar literal edits are supported");
  }
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll(
    "\u2029",
    "\\u2029",
  );
}
