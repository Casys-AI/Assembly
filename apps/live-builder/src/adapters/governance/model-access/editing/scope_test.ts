import { throws } from "node:assert/strict";
import { assertModelEditScope } from "./scope.ts";

type Element = Record<string, unknown>;
function fixture(
  bodies = ["part A { attribute café = 1; }", "part AB { attribute x = 2; }"],
  names = ["A", "AB"],
  extra = "// outside\n",
) {
  const source = `package P {\n${bodies.join("\n")}\n}\n${extra}`;
  const elements: Element[] = [{
    "@id": "p",
    "@type": "Package",
    declaredName: "P",
    qualifiedName: "P",
    "sysx:sourceDocument": "m.sysml",
  }];
  bodies.forEach((body, i) => {
    const prefix = source.slice(0, source.indexOf(body));
    elements.push({
      "@id": `r${i}`,
      "@type": "PartUsage",
      declaredName: names[i],
      qualifiedName: `P::${names[i]}`,
      owner: { "@id": "p" },
      "sysx:sourceLine": prefix.split("\n").length,
      "sysx:sourceColumn":
        new TextEncoder().encode(prefix.split("\n").at(-1)!).length + 1,
      "sysx:sourceEndLine": prefix.split("\n").length,
      "sysx:sourceEndColumn":
        new TextEncoder().encode(prefix.split("\n").at(-1)! + body).length + 1,
      "sysx:sourceText": body,
    });
  });
  return { sources: { "m.sysml": source } as Record<string, string>, elements };
}
const grants = [{ file: "m.sysml", qualifiedRoots: ["P::A"] }];
Deno.test("scope allows child changes and Unicode byte-length changes", () => {
  assertModelEditScope(
    fixture(),
    fixture([
      "part A { attribute café = '台灣'; }",
      "part AB { attribute x = 2; }",
    ]),
    grants,
  );
});
Deno.test("scope preserves outside comments and whitespace exactly", () => {
  throws(() =>
    assertModelEditScope(
      fixture(),
      fixture(undefined, undefined, "// changed\n"),
      grants,
    )
  );
  throws(() =>
    assertModelEditScope(
      fixture(),
      fixture([
        "part A { attribute café = 1; }",
        "part AB { attribute x = 3; }",
      ]),
      grants,
    )
  );
});
Deno.test("scope rejects external reference changes in same and other files", () => {
  throws(() =>
    assertModelEditScope(
      fixture(undefined, undefined, "ref P::A;"),
      fixture(undefined, undefined, "ref P::B;"),
      grants,
    )
  );
  const before = fixture(), after = fixture();
  before.sources["ref.sysml"] = "ref P::A;";
  after.sources["ref.sysml"] = "ref P::B;";
  throws(() => assertModelEditScope(before, after, grants));
  delete after.sources["ref.sysml"];
  throws(() => assertModelEditScope(before, after, grants));
});
Deno.test("scope rejects brace breakout according to independently compiled root extent", () => {
  const after = fixture([
    "part A { } part evil { attribute café = 1; }",
    "part AB { attribute x = 2; }",
  ]);
  after.elements[1]!["sysx:sourceEndColumn"] = 11;
  after.elements[1]!["sysx:sourceText"] = "part A { }";
  throws(() => assertModelEditScope(fixture(), after, grants));
});
Deno.test("scope rejects root rename, absent range, duplicate identities and duplicate roots", () => {
  throws(() =>
    assertModelEditScope(fixture(), fixture(undefined, ["B", "AB"]), grants)
  );
  for (const property of ["sysx:sourceEndColumn", "sysx:sourceLine"]) {
    const after = fixture();
    delete after.elements[1]![property];
    throws(() => assertModelEditScope(fixture(), after, grants));
  }
  const duplicate = fixture();
  duplicate.elements.push({ ...duplicate.elements[1] });
  throws(() => assertModelEditScope(fixture(), duplicate, grants));
  const duplicateRoot = fixture();
  duplicateRoot.elements.push({ ...duplicateRoot.elements[1], "@id": "other" });
  throws(() => assertModelEditScope(fixture(), duplicateRoot, grants));
  throws(() =>
    assertModelEditScope(fixture(), fixture(), [...grants, ...grants])
  );
});
Deno.test("scope handles multiple disjoint roots and quoted colon names without prefix inference", () => {
  const both = [{ file: "m.sysml", qualifiedRoots: ["P::A", "P::AB"] }];
  assertModelEditScope(fixture(), fixture(["part A { }", "part AB { }"]), both);
  const quoted = fixture(["part 'A::B' { attribute café = 1; }"], ["A::B"]);
  const changed = fixture(["part 'A::B' { attribute café = 2; }"], ["A::B"]);
  assertModelEditScope(quoted, changed, [{
    file: "m.sysml",
    qualifiedRoots: ["P::'A::B'"],
  }]);
  throws(() =>
    assertModelEditScope(quoted, changed, [{
      file: "m.sysml",
      qualifiedRoots: ["P::A::B"],
    }])
  );
});
Deno.test("scope rejects catalog, owner cycles, root metaclass change and UTF-8 splits", () => {
  for (
    const change of [
      (e: Element) => e["toolkit:catalogOnly"] = true,
      (e: Element) => e.owner = { "@id": "r0" },
      (e: Element) => e["@type"] = "Package",
      (e: Element) => e["sysx:sourceEndColumn"] = 24,
    ]
  ) {
    const after = fixture();
    change(after.elements[1]!);
    throws(() => assertModelEditScope(fixture(), after, grants));
  }
});

Deno.test("scope rejects insertions at either declaration boundary", () => {
  for (const beforeRoot of [true, false]) {
    const after = fixture();
    const body = String(after.elements[1]!["sysx:sourceText"]);
    after.sources["m.sysml"] = after.sources["m.sysml"]!.replace(
      body,
      beforeRoot ? `/* outside */${body}` : `${body}/* outside */`,
    );
    if (beforeRoot) {
      after.elements[1]!["sysx:sourceColumn"] = 14;
      after.elements[1]!["sysx:sourceEndColumn"] =
        Number(after.elements[1]!["sysx:sourceEndColumn"]) + 13;
    }
    throws(() => assertModelEditScope(fixture(), after, grants));
  }
});
Deno.test("scope rejects a split UTF-8 boundary without sourceText metadata", () => {
  const after = fixture();
  delete after.elements[1]!["sysx:sourceText"];
  const bytes = new TextEncoder().encode(
    after.sources["m.sysml"]!.split("\n")[1]!,
  );
  const continuation = bytes.findIndex((byte) => byte >= 128 && byte < 192);
  after.elements[1]!["sysx:sourceEndColumn"] = continuation + 1;
  throws(() => assertModelEditScope(fixture(), after, grants));
});
