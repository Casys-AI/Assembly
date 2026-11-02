import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  HEAD,
  item,
  linkedBoard,
} from "../../../test/support/board-fixture.ts";
import { searchBoard, searchResultHref } from "./search.ts";

Deno.test("board search matches titles and qualified names without indexing unrelated keys", () => {
  const board = linkedBoard();
  const title = searchBoard(board, "READ_WEB_PAGE");
  ok(title.some((element) => element.title === "read_web_page"));
  deepStrictEqual(searchBoard(board, "  "), []);
  deepStrictEqual(searchBoard(board, "unrelated-proposal-id"), []);
  const named = {
    ...board,
    columns: [{
      ...board.columns[0],
      items: [item("one", "tool", "Tool", { qname: "System::Qualified" })],
    }],
  };
  equal(searchBoard(named, "qualified")[0]?.id, "one");
});

Deno.test("board search caps and deduplicates results and preserves version and Case in links", () => {
  const board = linkedBoard();
  const many = {
    ...board,
    columns: [{
      ...board.columns[0],
      items: Array.from(
        { length: 14 },
        (_, n) => item(`id${n}`, "tool", `Match ${n}`),
      ),
    }],
  };
  const results = searchBoard(many, "match");
  equal(results.length, 12);
  const url = new URL(
    searchResultHref(results[0], HEAD, "?caseBranch=case-1&branch=branch-1"),
    "http://example.test",
  );
  equal(url.searchParams.get("select"), "id0");
  equal(url.searchParams.get("version"), HEAD);
  equal(url.searchParams.get("caseBranch"), "case-1");
  equal(url.searchParams.get("branch"), "branch-1");
});
