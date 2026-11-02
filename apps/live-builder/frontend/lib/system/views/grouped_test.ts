import { deepStrictEqual } from "node:assert/strict";
import { grouped } from "./grouped.ts";

Deno.test("items are grouped by key, the groups in the order their key first appears", () => {
  deepStrictEqual(
    grouped(["b1", "a1", "b2", "c1", "a2"], (name) => name[0]),
    [["b", ["b1", "b2"]], ["a", ["a1", "a2"]], ["c", ["c1"]]],
  );
  deepStrictEqual(grouped([], () => "x"), []);
});

Deno.test("a key that names an inherited property is a key like any other", () => {
  deepStrictEqual(
    grouped(["a", "b"], () => "constructor"),
    [["constructor", ["a", "b"]]],
  );
});
