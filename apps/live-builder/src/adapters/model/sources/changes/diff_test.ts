import { deepStrictEqual, equal, match, throws } from "node:assert/strict";
import { applyPatch, parsePatch } from "diff";
import { compareModelSources, ModelSourceDiffLimitError } from "./diff.ts";

Deno.test("source Git diff isolates the changed cap and round-trips with the established patch library", () => {
  const before = "package Refund {\n  attribute cap = 5000;\n}\n";
  const after = before.replace("5000", "2000");
  const oldTree = {
    "refund.sysml": before,
    "untouched.sysml": "package Base;",
  };
  const newTree = { ...oldTree, "refund.sysml": after };
  const result = compareModelSources(oldTree, newTree);
  deepStrictEqual(result.files, [{
    path: "refund.sysml",
    kind: "changed",
    additions: 1,
    deletions: 1,
  }]);
  equal(result.additions, 1);
  equal(result.deletions, 1);
  match(result.patch, /^diff --git a\/refund.sysml b\/refund.sysml\n/);
  match(
    result.patch,
    /- {2}attribute cap = 5000;\n\+ {2}attribute cap = 2000;/,
  );
  equal(applyPatch(before, result.patch), after);
  equal(parsePatch(result.patch).length, 1);
  equal(oldTree["refund.sysml"], before);
});

Deno.test("source Git diff represents additions, deletions and empty file identity", () => {
  const result = compareModelSources(
    { "deleted.sysml": "package Gone;\n", "empty-removed.sysml": "" },
    { "added.sysml": "package New;\n", "empty-added.sysml": "" },
  );
  deepStrictEqual(result.files.map((file) => [file.path, file.kind]), [
    ["added.sysml", "added"],
    ["deleted.sysml", "deleted"],
    ["empty-added.sysml", "added"],
    ["empty-removed.sysml", "deleted"],
  ]);
  equal(result.additions, 1);
  equal(result.deletions, 1);
  const parsed = parsePatch(result.patch);
  equal(parsed.length, 4);
  equal(parsed[0]!.oldFileName, "/dev/null");
  equal(parsed[0]!.isCreate, true);
  equal(parsed[1]!.newFileName, "/dev/null");
  equal(parsed[1]!.isDelete, true);
  equal(parsed[2]!.isCreate, true);
  equal(parsed[3]!.isDelete, true);
  match(
    result.patch,
    /diff --git a\/empty-added.sysml b\/empty-added.sysml\nnew file mode 100644/,
  );
});

Deno.test("source Git diff preserves final-newline differences and an unchanged tree is empty", () => {
  const source = "package Exact;";
  const result = compareModelSources(
    { "system.sysml": source },
    { "system.sysml": source + "\n" },
  );
  match(result.patch, /\\ No newline at end of file/);
  equal(applyPatch(source, result.patch), source + "\n");
  deepStrictEqual(compareModelSources({}, {}), {
    patch: "",
    files: [],
    additions: 0,
    deletions: 0,
  });
  equal(
    compareModelSources({ "same.sysml": source }, { "same.sysml": source })
      .patch,
    "",
  );
});

Deno.test("source Git diff rejects unsafe paths and refuses partial output when bounded", () => {
  throws(
    () => compareModelSources({}, { "../outside.sysml": "package X;" }),
    /Unsafe/,
  );
  throws(
    () => compareModelSources({}, { "header\n+evil.sysml": "package X;" }),
    /Unsafe/,
  );
  throws(() =>
    compareModelSources(
      { "system.sysml": "a\nb\n" },
      { "system.sysml": "c\nd\n" },
      { maxEditLength: 1 },
    ), ModelSourceDiffLimitError);
  throws(
    () =>
      compareModelSources({}, { "system.sysml": "a\n" }, { maxPatchBytes: 1 }),
    ModelSourceDiffLimitError,
  );
  throws(
    () => compareModelSources({}, {}, { timeoutMs: 0 }),
    /Invalid source diff limit/,
  );
});
