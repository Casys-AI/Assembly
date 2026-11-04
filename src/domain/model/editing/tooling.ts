import { characterCount } from "../../primitives/character-count.ts";
import { parseSysmlQualifiedName } from "../value-objects/sysml-qualified-name.ts";

// Native source names are narrower than provider display names. Quoted segments
// retain Unicode/nonbasic names without interpreting their contents as SysML.
const nativeName = String
  .raw`(?:[A-Za-z_][A-Za-z0-9_]*|'(?:[^'\\\u0000-\u001f\u007f]|\\['\\])+')`;
export const MODEL_EDIT_TYPE_NAME_PATTERN =
  `^(?:::)?${nativeName}(?:::${nativeName})*(?![\\s\\S])`;
const nativeTypeName = new RegExp(MODEL_EDIT_TYPE_NAME_PATTERN, "u");

export function isModelEditTypeName(value: unknown): value is string {
  return typeof value === "string" && characterCount(value) <= 4096 &&
    nativeTypeName.test(value) && !!parseSysmlQualifiedName(value);
}

/** A native reference-site selector; it is evidence, never authority. */
export interface ReferenceSiteFingerprint {
  unit: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  kind: string;
  ownerId: string;
  chainRootId: string | null;
  preimage: string;
}

function boundedNativeText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    new TextEncoder().encode(value).length <= maxBytes;
}

export function isReferenceSiteFingerprint(
  value: unknown,
): value is ReferenceSiteFingerprint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const site = value as Record<string, unknown>;
  if (
    Object.keys(site).sort().join(",") !==
      "chainRootId,col,endCol,endLine,kind,line,ownerId,preimage,unit"
  ) return false;
  const coordinate = (v: unknown): v is number =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 2147483647;
  return boundedNativeText(site.unit, 4096) &&
    boundedNativeText(site.kind, 128) &&
    boundedNativeText(site.ownerId, 128) &&
    (site.chainRootId === null || boundedNativeText(site.chainRootId, 128)) &&
    boundedNativeText(site.preimage, 65536) && coordinate(site.line) &&
    coordinate(site.col) && coordinate(site.endLine) &&
    coordinate(site.endCol) &&
    (site.endLine > site.line ||
      site.endLine === site.line && site.endCol > site.col);
}

export function isNativeReferenceId(value: unknown): value is string {
  return boundedNativeText(value, 128);
}

/** Targeted authoring requests refer to elements in one immutable source base. */
export type ModelEdit =
  | { kind: "set-value"; elementId: string; expression: string }
  | { kind: "set-type"; elementId: string; typeName: string }
  | {
    kind: "retarget-reference";
    fromId: string;
    toId: string;
    site: ReferenceSiteFingerprint;
  }
  | { kind: "rename"; elementId: string; name: string }
  | { kind: "insert-member"; elementId: string; text: string }
  | { kind: "remove"; elementId: string };

/** Whether inserted text is whole members as far as nesting goes: comments,
 * strings and quoted names close inside it, and its braces never close the
 * owner's body. Lexical only; the Toolkit still parses and checks the text. */
export function isWholeMemberText(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length;) {
    const c = text[i], next = text[i + 1];
    if (c === "/" && (next === "*" || (next === "/" && text[i + 2] === "*"))) {
      // `//*` opens a note like `/*` in the SysML lexer.
      const end = text.indexOf("*/", i + (next === "*" ? 2 : 3));
      if (end < 0) return false;
      i = end + 2;
    } else if (c === "/" && next === "/") {
      // A line note ends at CR as well as LF.
      i += 2;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return false;
      i = j + 1;
    } else {
      if (c === "{") depth++;
      else if (c === "}" && --depth < 0) return false;
      i++;
    }
  }
  return depth === 0;
}

export interface ModelEditRequest {
  baseVersion: string;
  sourceDigest: string;
  reason: string;
  edits: ModelEdit[];
  addresses?:
    import("../value-objects/diagnostic-address.ts").ModelDiagnosticAddress[];
}

/** Host-resolved identity and preimage; never accepted directly from an agent. */
export interface ModelToolingTarget {
  qualifiedName: string;
  metaclass: string;
  source: { path: string; text: string };
}

export type ResolvedModelEdit =
  | { kind: "set-value"; target: ModelToolingTarget; expression: string }
  | { kind: "rename"; target: ModelToolingTarget; name: string }
  | { kind: "insert-member"; target: ModelToolingTarget; text: string }
  | { kind: "remove"; target: ModelToolingTarget }
  | { kind: "replace-member"; target: ModelToolingTarget; text: string }
  | {
    kind: "retarget-reference";
    fromId: string;
    toId: string;
    site: ReferenceSiteFingerprint;
  }
  | { kind: "set-type"; target: ModelToolingTarget; type: string };
