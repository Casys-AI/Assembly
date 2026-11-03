import {
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
} from "node:assert/strict";
import { validateModelSources } from "./sources.ts";

Deno.test("source validation preserves legacy en-US compilation unit order", () => {
  const paths = [
    "Zeta.sysml",
    "alpha.sysml",
    "a_b.sysml",
    "a-b.sysml",
    "a1.sysml",
    "a_1.sysml",
  ];
  const legacy = paths.toSorted((a, b) => a.localeCompare(b, "en-US"));
  deepStrictEqual(legacy, [
    "a_1.sysml",
    "a_b.sysml",
    "a-b.sysml",
    "a1.sysml",
    "alpha.sysml",
    "Zeta.sysml",
  ]);
  notDeepStrictEqual(legacy, paths.toSorted());
  deepStrictEqual(
    Object.keys(validateModelSources(Object.fromEntries(
      paths.map((path) => [path, "package P;"]),
    ))),
    legacy,
  );
});

Deno.test("model source paths form an unambiguous portable file tree", () => {
  for (
    const paths of [
      ["a.sysml", "a.sysml/b.sysml"],
      ["A.sysml", "a.sysml/b.sysml"],
      ["Folder/a.sysml", "folder/b.sysml"],
      ["a.sysml", "A.sysml"],
      ["../a.sysml"],
    ]
  ) {
    throws(() =>
      validateModelSources(
        Object.fromEntries(paths.map((path) => [path, "package A;"])),
      )
    );
  }
  deepStrictEqual(
    validateModelSources({
      "folder/a.sysml": "package A;",
      "folder/b.sysml": "package B;",
    }),
    { "folder/a.sysml": "package A;", "folder/b.sysml": "package B;" },
  );
});
