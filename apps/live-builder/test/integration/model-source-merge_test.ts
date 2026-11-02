import { deepStrictEqual, rejects } from "node:assert/strict";
import {
  diffSources,
  mergeSources,
} from "../../src/adapters/model/sources/changes/merge.ts";

Deno.test("source merge preserves independent changes, additions and deletions", async () => {
  const base = {
    "a.sysml": "package A {\n    doc /* old */\n}\n",
    "b.sysml": "package B;\n",
  };
  const current = {
    ...base,
    "a.sysml": "package A {\n    doc /* ours */\n}\n",
    "c.sysml": "package C;\n",
  };
  const proposed = { "a.sysml": base["a.sysml"] };
  const merged = await mergeSources(base, current, proposed);
  deepStrictEqual(merged, {
    "a.sysml": current["a.sysml"],
    "c.sysml": current["c.sysml"],
  });
  deepStrictEqual(
    diffSources(base, merged).map(({ path, kind }) => ({ path, kind })),
    [
      { path: "a.sysml", kind: "changed" },
      { path: "b.sysml", kind: "deleted" },
      { path: "c.sysml", kind: "added" },
    ],
  );
});

Deno.test("source merge refuses same-field and delete-versus-change conflicts", async () => {
  const base = { "a.sysml": "package A {\n    doc /* old */\n}\n" };
  const current = { "a.sysml": "package A {\n    doc /* ours */\n}\n" };
  const proposed = { "a.sysml": "package A {\n    doc /* theirs */\n}\n" };
  await rejects(() => mergeSources(base, current, proposed), /conflict/i);
  await rejects(() => mergeSources(base, {}, proposed), /add\/delete conflict/);
});

Deno.test("source merge uses a real three-way same-file merge", async () => {
  const base = {
    "a.sysml":
      "package A {\n    doc /* first */\n    part def Thing;\n    part root : Thing;\n    doc /* second */\n}\n",
  };
  const current = {
    "a.sysml": base["a.sysml"].replace("first", "first changed"),
  };
  const proposed = {
    "a.sysml": base["a.sysml"].replace("second", "second changed"),
  };
  deepStrictEqual(await mergeSources(base, current, proposed), {
    "a.sysml": base["a.sysml"].replace("first", "first changed").replace(
      "second",
      "second changed",
    ),
  });
});
