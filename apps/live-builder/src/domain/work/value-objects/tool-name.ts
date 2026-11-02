import { characterCount } from "../../primitives/character-count.ts";
import { isSpellable } from "../../model/editing/host-edit.ts";

/** Names are written into a SysML string literal at activation, so they are
 * bounded and checked when the candidate is proposed, long before admission. */
export const MAX_TOOL_NAME_LENGTH = 200;

type ToolNameProblem =
  | "EMPTY"
  | "TOO_LONG"
  | "CONTROL_CHARACTER"
  | "LINE_SEPARATOR"
  | "LONE_SURROGATE";

/** The first reason a tool name cannot be published, or undefined when it can.
 * A name is a single-line label: any control character is refused, not only
 * those the literal writer cannot spell. */
export function toolNameProblem(name: string): ToolNameProblem | undefined {
  if (name.trim() === "") return "EMPTY";
  if (characterCount(name) > MAX_TOOL_NAME_LENGTH) return "TOO_LONG";
  if (!name.isWellFormed()) return "LONE_SURROGATE";
  for (const character of name) {
    const code = character.codePointAt(0)!;
    if (code === 0x2028 || code === 0x2029) return "LINE_SEPARATOR";
    if (code < 0x20 || code >= 0x7f && code <= 0x9f) return "CONTROL_CHARACTER";
  }
  // Defensive: every name accepted above must also be a spellable literal.
  return isSpellable(name) ? undefined : "CONTROL_CHARACTER";
}

/** Machine-readable refusal raised at proposal time, before any test or review. */
export class ToolNameError extends Error {
  readonly code = "TOOL_NAME_INVALID" as const;
  readonly recovery = "refuse" as const;
  constructor(readonly context: { problem: ToolNameProblem; length: number }) {
    super(
      `TOOL_NAME_INVALID (${context.problem}) : le nom d’un tool tient en une ligne de ${MAX_TOOL_NAME_LENGTH} caractères au plus, sans caractère de contrôle ni séparateur de ligne.`,
    );
    this.name = "ToolNameError";
  }
}

/** Proposal-time guard shared by every way a candidate can be proposed. */
export function assertToolName(name: string): void {
  const problem = toolNameProblem(name);
  if (problem) {
    throw new ToolNameError({ problem, length: characterCount(name) });
  }
}
