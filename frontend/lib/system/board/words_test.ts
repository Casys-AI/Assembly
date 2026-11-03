import { equal, ok } from "node:assert/strict";
import { BOARD_ITEM_KINDS } from "./parse.ts";
import {
  compact,
  duration,
  figure,
  humanize,
  isMasked,
  kindWord,
  lastName,
  listing,
  perSystem,
  rawValue,
  readableValue,
  STEP_KINDS,
  stepKind,
  withoutUnit,
} from "./words.ts";

Deno.test("an identifier in camel case is a phrase, whose first word is capitalised", () => {
  equal(humanize("maxAgentDecisions"), "Max agent decisions");
  equal(humanize("DecisionContextPolicy"), "Decision context policy");
  equal(humanize("recentMessages"), "Recent messages");
  equal(humanize("tool"), "Tool");
  equal(humanize("URLSelection"), "URLSelection");
  equal(humanize("limit2Items"), "Limit2 items");
  equal(humanize(""), "");
  // Said in lower case, as a label: the caller lowers it.
  equal(humanize("maxLoadedSkills").toLowerCase(), "max loaded skills");
});

Deno.test("an identifier in snake case is a phrase too: the tools the model names that way read as words", () => {
  equal(humanize("read_web_page"), "Read web page");
  equal(humanize("read_web_page_outline"), "Read web page outline");
  equal(humanize("max_tokens"), "Max tokens");
  equal(humanize("__x__"), "X");
});

Deno.test("a count is said in full below ten thousand, then as thousands and millions", () => {
  equal(compact(0), "0");
  equal(compact(8), "8");
  equal(compact(2000), "2,000");
  equal(compact(9999), "9,999");
  equal(compact(10_000), "10k");
  equal(compact(66_000), "66k");
  equal(compact(250_000), "250k");
  equal(compact(999_000), "999k");
  equal(compact(999_999), "1M");
  equal(compact(1_000_000), "1M");
  equal(compact(1_500_000), "1.5M");
});

Deno.test("a duration is said in the largest unit it fills, without a trailing zero", () => {
  equal(duration(500), "0.5 s");
  equal(duration(1500), "1.5 s");
  equal(duration(30_000), "30 s");
  equal(duration(60_000), "1 min");
  equal(duration(90_000), "1.5 min");
  equal(duration(3_600_000), "1 h");
  equal(duration(86_400_000), "24 h");
  equal(duration(5_400_000), "1.5 h");
});

Deno.test("the last name of a qualified name is its own", () => {
  equal(lastName("A::b::c"), "c");
  equal(lastName("c"), "c");
  equal(lastName("A::"), "A::");
  equal(lastName(""), "");
});

Deno.test("names in a sentence: one alone, two with 'and', more with commas", () => {
  equal(listing([]), "");
  equal(listing(["a"]), "a");
  equal(listing(["a", "b"]), "a and b");
  equal(listing(["a", "b", "c"]), "a, b and c");
});

Deno.test("the mark of an element declared in several units says which, and says nothing when no unit is known", () => {
  equal(perSystem(["a", "b"]), "one per system: a and b");
  equal(perSystem(["a"]), "one per system: a");
  equal(perSystem([]), undefined);
});

Deno.test("an element is called by its kind as a person says it; some kinds have no word", () => {
  const word = (kind: string, keyword = "part") => kindWord({ kind, keyword });
  equal(word("scope"), "system");
  equal(word("capability"), "flow");
  equal(word("requirement", "requirement def"), "guarantee");
  equal(word("capability-type"), "tool type");
  equal(word("action"), "step");
  equal(word("port", "port"), "port");
  // A goto is an arrow on a flow, not a thing to name.
  equal(word("goto"), "");
  // What the table does not know is a check when it declares a constraint.
  equal(word("something", "assert constraint"), "check");
  equal(word("something", "item"), "");
  // The words of the language are no kinds.
  for (const name of ["constructor", "toString", "__proto__"]) {
    equal(word(name), "", name);
  }
});

Deno.test("every kind of item the board holds has a word of its own, never the SysML keyword", () => {
  for (const kind of BOARD_ITEM_KINDS) {
    const said = kindWord({ kind, keyword: "part" });
    ok(said !== "" && said !== "part", `${kind} is called "${said}"`);
  }
  // The two a reader of the real board meets without the table knowing them.
  equal(kindWord({ kind: "skill", keyword: "part" }), "skill");
  equal(kindWord({ kind: "authority", keyword: "part" }), "right");
});

Deno.test("every kind of step has one definition: the kinds are known, those that are not elements say nothing", () => {
  for (const kind of STEP_KINDS) equal(stepKind({ kind }), kind);
  // A kind the model invents is none: the page draws it as a plain step.
  for (const kind of ["accept", "send", "", "constructor", "__proto__"]) {
    equal(stepKind({ kind }), undefined, kind);
  }
  // The ends of a thread (and a jump) have no word: there is nothing to name or open.
  for (const kind of ["start", "end", "done", "goto"]) {
    equal(kindWord({ kind, keyword: "action" }), "", kind);
  }
  // The others are named as a person says them.
  for (const kind of ["action", "decision", "merge", "fork", "join"]) {
    ok(kindWord({ kind, keyword: "part" }) !== "", kind);
  }
});

Deno.test("a measure that ends in Ms is a duration: its figure says the unit, and its name does not", () => {
  equal(figure(90_000, "timeoutMs"), "1.5 min");
  equal(figure(90_000, "maxLines"), "90k");
  equal(figure(30_000, "idleMs"), "30 s");
  equal(withoutUnit("timeoutMs"), "timeout");
  equal(withoutUnit("maxLines"), "maxLines");
  // Only a unit at the end of the name is one.
  equal(withoutUnit("Msgs"), "Msgs");
  equal(figure(5, "Msgs"), "5");
});

Deno.test("identity and versioning are masked in the readable view, and nothing else is", () => {
  for (
    const name of [
      "id",
      "version",
      "revision",
      "configurationId",
      "configurationRevision",
      "envelopeKind",
      "envelopePattern",
      "evidenceLevel",
      "source",
      "operatorName",
    ]
  ) {
    equal(isMasked(name), true, name);
  }
  for (
    const name of [
      "identity",
      "versions",
      "sourceUrl",
      "envelope",
      "maxAgentDecisions",
      "Id",
    ]
  ) {
    equal(isMasked(name), false, name);
  }
});

Deno.test("a value is read in words, or written as the model writes it", () => {
  equal(readableValue(true, "mayAdmit"), "yes");
  equal(readableValue(false, "mayAdmit"), "no");
  equal(readableValue(12, "maxAgentDecisions"), "12");
  equal(readableValue(250_000, "maxContextCharacters"), "250k");
  // A duration is a name ending in Ms.
  equal(readableValue(90_000, "timeoutMs"), "1.5 min");
  equal(readableValue(90_000, "maxLines"), "90k");
  equal(readableValue("authorized-host", "mode"), "authorized-host");
  equal(readableValue([], "hosts"), "none");
  equal(readableValue([], "allowedScopes"), "none");
  equal(readableValue(["a", "b"], "hosts"), "a, b");
  equal(
    readableValue([{ file: "m.sysml", qualifiedRoots: ["A::b", "A::c"] }], "g"),
    "m.sysml: b, c",
  );
  equal(rawValue(true), "true");
  equal(rawValue(12), "12");
  equal(rawValue("x"), "x");
  equal(rawValue(["a", "b"]), '["a","b"]');
  equal(rawValue([]), "[]");
});
