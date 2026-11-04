import { assert as requireValue } from "../../primitives/assert.ts";
import { TOOL_KINDS, type ToolKind } from "../../shared-kernel/tool-kind.ts";
import type { ToolDraft } from "./candidates.ts";

/** Selection supplies exact bytes for ordinary promotion, never admission. */
export interface InitialToolSelection {
  id: string;
  draft: ToolDraft;
}

export interface NativeInitialToolSeed extends InitialToolSelection {
  nativeId: string;
  sourceIds: string[];
}

export const MAX_INITIAL_TOOLS = 8;
export const MAX_INITIAL_TOOLS_JSON_CHARACTERS = 384_000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exact(value: Record<string, unknown>, fields: string[]) {
  return Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maximum && !value.includes("\0");
}

function controlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/** The manifest is deliberately closed: it cannot carry verdicts or stages. */
export function validateInitialToolManifest(
  value: unknown,
): InitialToolSelection[] {
  requireValue(
    record(value) && exact(value, ["format", "tools"]) && value.format === 1 &&
      Array.isArray(value.tools) && value.tools.length <= MAX_INITIAL_TOOLS,
    "Initial tool manifest must contain format:1 and at most 8 selected tools",
  );
  const ids = new Set<string>(), names = new Set<string>();
  const selection = value.tools.map((tool): InitialToolSelection => {
    requireValue(
      record(tool) &&
        exact(tool, ["id", "name", "description", "kind", "code"]) &&
        typeof tool.id === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(tool.id) &&
        bounded(tool.name, 120) && tool.name.trim() === tool.name &&
        !controlCharacters(tool.name) &&
        bounded(tool.description, 4000) && bounded(tool.code, 40_000) &&
        TOOL_KINDS.includes(tool.kind as ToolKind),
      "Initial tool selection requires exact id, name, description, kind and code",
    );
    requireValue(
      !ids.has(tool.id) && !names.has(tool.name),
      "Initial tool ids and names must be distinct",
    );
    ids.add(tool.id);
    names.add(tool.name);
    return {
      id: tool.id,
      draft: {
        name: tool.name,
        description: tool.description,
        kind: tool.kind as ToolKind,
        code: tool.code,
      },
    };
  });
  requireValue(
    JSON.stringify(selection).length <= MAX_INITIAL_TOOLS_JSON_CHARACTERS,
    "Initial tool selection is too large",
  );
  return selection;
}
