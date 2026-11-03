import assert from "node:assert/strict";
import { isSpellable, spelling } from "../../model/editing/host-edit.ts";
import {
  assertToolName,
  MAX_TOOL_NAME_LENGTH,
  ToolNameError,
  toolNameProblem,
} from "./tool-name.ts";

Deno.test("tool names that the literal writer cannot spell are refused at proposal time", () => {
  const refused: Array<[string, ReturnType<typeof toolNameProblem>]> = [
    ["", "EMPTY"],
    ["   ", "EMPTY"],
    ["a".repeat(MAX_TOOL_NAME_LENGTH + 1), "TOO_LONG"],
    ["lone\ud800high", "LONE_SURROGATE"],
    ["lone\udc00low", "LONE_SURROGATE"],
    ["line separator", "LINE_SEPARATOR"],
    ["paragraph separator", "LINE_SEPARATOR"],
    ["nul\u0000", "CONTROL_CHARACTER"],
    ["start\u0001heading", "CONTROL_CHARACTER"],
    ["unit\u001fseparator", "CONTROL_CHARACTER"],
    ["new\nline", "CONTROL_CHARACTER"],
    ["tab\tname", "CONTROL_CHARACTER"],
    ["carriage\rreturn", "CONTROL_CHARACTER"],
    ["delete\u007f", "CONTROL_CHARACTER"],
    ["next\u0085line", "CONTROL_CHARACTER"],
  ];
  for (const [name, problem] of refused) {
    assert.equal(toolNameProblem(name), problem, JSON.stringify(name));
    assert.throws(
      () => assertToolName(name),
      (error: unknown) =>
        error instanceof ToolNameError && error.code === "TOOL_NAME_INVALID" &&
        error.context.problem === problem && error.recovery === "refuse" &&
        error.context.length === name.length &&
        error.message.includes("TOOL_NAME_INVALID"),
    );
  }
});

Deno.test("ordinary names, quotes, backslashes, emoji and the length bound are accepted", () => {
  for (
    const name of [
      "Page reader",
      'He said "hi"',
      "back\\slash",
      "*/ part x;",
      "emoji 🙂 é",
      "nbsp zwsp​",
      "a".repeat(MAX_TOOL_NAME_LENGTH),
    ]
  ) {
    assert.equal(toolNameProblem(name), undefined, JSON.stringify(name));
    assert.doesNotThrow(() => assertToolName(name));
  }
});

Deno.test("every accepted name is a spellable SysML literal", () => {
  // Names are stricter than literals: whatever a name accepts must be spellable.
  for (const name of ["Reader v2", 'quote"', "back\\slash", "🙂", "é"]) {
    assert.equal(toolNameProblem(name), undefined);
    assert.equal(isSpellable(name), true);
    assert.equal(JSON.parse(spelling(name)), name);
  }
});

Deno.test("isSpellable follows the escapes the SysML lexer rejects", () => {
  // JSON short escapes round-trip through the lexer; \uXXXX escapes do not.
  for (const text of ["\b", "\t", "\n", "\f", "\r", "\u007f", "\u0085", "🙂"]) {
    assert.equal(isSpellable(text), true, JSON.stringify(text));
  }
  for (
    const text of [
      "\u0000",
      "\u0001",
      "\u001f",
      " ",
      " ",
      "\ud800",
      "\udc00",
    ]
  ) {
    assert.equal(isSpellable(text), false, JSON.stringify(text));
  }
});

Deno.test("the tool name bound counts code points, not UTF-16 units", () => {
  assert.equal(toolNameProblem("😀".repeat(200)), undefined);
  assert.equal(toolNameProblem("😀".repeat(201)), "TOO_LONG");
  assert.equal(toolNameProblem("😀".repeat(150)), undefined);
  assert.throws(
    () => assertToolName("😀".repeat(201)),
    (error: unknown) =>
      error instanceof ToolNameError && error.context.length === 201,
  );
});
