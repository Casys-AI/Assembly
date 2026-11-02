import { deepStrictEqual, equal } from "node:assert/strict";
import { item, values } from "../../../test/support/board-fixture.ts";
import { flagOf, isGrantList, isTextList, textOf, valueOf } from "./values.ts";

const declaring = item("x", "policy", "x", {
  values: values({
    name: "Analyste",
    blank: "  ",
    flag: true,
    off: false,
    count: 3,
    text: "true",
    hosts: ["a"],
    grants: [{ file: "a.sysml", qualifiedRoots: ["A::b"] }],
    none: [],
  }),
});

Deno.test("a declared value is read by its type: what has another type is not there", () => {
  equal(textOf(declaring, "name"), "Analyste");
  equal(textOf(declaring, "flag"), undefined);
  equal(textOf(declaring, "count"), undefined);
  equal(flagOf(declaring, "flag"), true);
  equal(flagOf(declaring, "off"), false);
  // "true" is a text, not a flag: nothing is coerced.
  equal(flagOf(declaring, "text"), undefined);
  equal(flagOf(declaring, "count"), undefined);
});

Deno.test("a blank text is no declaration; a name that is not declared is none", () => {
  equal(textOf(declaring, "blank"), undefined);
  equal(textOf(declaring, "missing"), undefined);
  equal(valueOf(declaring, "missing"), undefined);
  equal(valueOf(undefined, "name"), undefined);
  equal(valueOf(item("y", "policy", "y"), "name"), undefined);
});

Deno.test("the first declaration of a name wins", () => {
  const twice = item("t", "policy", "t", {
    values: [
      { name: "a", line: 1, value: "first" },
      { name: "a", line: 2, value: "second" },
    ],
  });
  equal(textOf(twice, "a"), "first");
});

Deno.test("lists are told apart by what they hold: strings, grants, or nothing", () => {
  deepStrictEqual(valueOf(declaring, "hosts"), ["a"]);
  equal(isTextList(valueOf(declaring, "hosts")), true);
  equal(isGrantList(valueOf(declaring, "hosts")), false);
  equal(isGrantList(valueOf(declaring, "grants")), true);
  equal(isTextList(valueOf(declaring, "grants")), false);
  // An empty list is a list of strings, and no grant.
  equal(isTextList(valueOf(declaring, "none")), true);
  equal(isGrantList(valueOf(declaring, "none")), false);
  equal(isTextList(valueOf(declaring, "name")), false);
  equal(isGrantList(undefined), false);
});
