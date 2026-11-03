import { deepStrictEqual, equal, notEqual } from "node:assert/strict";
import type { BoardItem } from "../../../../src/domain/model/records/board.ts";
import { item, tool } from "../../../test/support/board-fixture.ts";
import { groupTitle, twinKey, twinsOf } from "./twins.ts";

const search = (id: string, scope: string, over: Partial<BoardItem> = {}) => ({
  ...tool(id, scope, "search", "Reads a page."),
  ...over,
});

Deno.test("items are twins when nothing a person reads tells them apart, whatever unit declares them", () => {
  equal(twinKey(search("a.t", "a")), twinKey(search("b.t", "b")));
  for (
    const [what, other] of [
      ["summary", search("c.t", "c", { summary: "Another note." })],
      ["title", search("c.t", "c", { title: "other" })],
      ["kind", search("c.t", "c", { kind: "skill" })],
      ["type", search("c.t", "c", { type: { title: "T", qname: "M::T" } })],
      [
        "values",
        search("c.t", "c", {
          values: [{ name: "module", line: 1, value: "x" }],
        }),
      ],
      [
        "heading",
        search("c.t", "c", { group: [{ element: "g", title: "g" }] }),
      ],
      [
        "steps",
        search("c.t", "c", {
          steps: [{ id: "s", kind: "action", title: "s" }],
        }),
      ],
    ] as const
  ) {
    notEqual(twinKey(search("a.t", "a")), twinKey(other), what);
  }
});

Deno.test("twins come as sets, in the order each set first appears and each in the order of its items", () => {
  const items = [
    search("a.t", "a"),
    item("x", "information", "x"),
    search("b.t", "b"),
    item("y", "information", "y"),
    search("c.t", "c"),
  ];
  deepStrictEqual(
    twinsOf(items).map((set) => set.map((entry) => entry.id)),
    [["a.t", "b.t", "c.t"], ["x"], ["y"]],
  );
  deepStrictEqual(twinsOf([]), []);
});

Deno.test("a page that draws more than the twin key gives a key of its own", () => {
  const items = [search("a.t", "a"), search("b.t", "b")];
  deepStrictEqual(
    twinsOf(items, (entry) => `${twinKey(entry)}|${entry.scope}`).map((set) =>
      set.map((entry) => entry.id)
    ),
    [["a.t"], ["b.t"]],
  );
});

Deno.test("the heading the model puts an item under joins its groups", () => {
  equal(groupTitle(item("p", "policy", "p")), "");
  equal(
    groupTitle(item("p", "policy", "p", {
      group: [{ element: "g1", title: "context" }, {
        element: "g2",
        title: "skills",
      }],
    })),
    "context · skills",
  );
});
