import { deepStrictEqual, equal, throws } from "node:assert/strict";
import {
  parseSysmlQualifiedName,
  sameSysmlQualifiedName,
  spellSysmlQualifiedName,
} from "./sysml-qualified-name.ts";

Deno.test("qualified names compare Unicode and quoted display spellings by exact segments", () => {
  equal(
    sameSysmlQualifiedName(
      "ASELiveBuilder::Mémoire",
      "ASELiveBuilder::'Mémoire'",
    ),
    true,
  );
  equal(
    sameSysmlQualifiedName(
      "P::awaiting-admission",
      "'P'::'awaiting-admission'",
    ),
    true,
  );
  equal(
    sameSysmlQualifiedName("::P::révision-台灣", "P::'révision-台灣'"),
    true,
  );
  equal(sameSysmlQualifiedName("P::É", "P::é"), false);
  equal(sameSysmlQualifiedName("P::é", "P::e\u0301"), false);
});

Deno.test("quoted separators and escaped quote/backslash preserve segment boundaries", () => {
  deepStrictEqual(parseSysmlQualifiedName("P::'a::b'"), ["P", "a::b"]);
  equal(sameSysmlQualifiedName("P::'a::b'", "P::a::b"), false);
  const names = [
    "part",
    "L'atelier",
    "a\\b",
    "a::b",
    "台灣😀",
    " leading space",
  ];
  deepStrictEqual(
    parseSysmlQualifiedName(spellSysmlQualifiedName(names)),
    names,
  );
  deepStrictEqual(parseSysmlQualifiedName("P::'L\\'atelier'::'a\\\\b'"), [
    "P",
    "L'atelier",
    "a\\b",
  ]);
});

Deno.test("malformed qualified names and unknown escapes cannot alias a valid target", () => {
  for (
    const invalid of [
      "",
      "::",
      "P::",
      "P::::a",
      "P:a",
      "P::'a",
      "P::'a'b",
      "P::''",
      " P::a",
      "P:: a",
      "P::'a\\q'",
      "P::'a\n'",
    ]
  ) {
    equal(parseSysmlQualifiedName(invalid), undefined, invalid);
    equal(sameSysmlQualifiedName(invalid, invalid), false, invalid);
  }
  throws(() => spellSysmlQualifiedName([]), /segments/);
  throws(() => spellSysmlQualifiedName(["P", ""]), /segments/);
});
