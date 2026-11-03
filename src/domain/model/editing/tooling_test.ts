import { equal } from "node:assert/strict";
import { isModelEditTypeName, isWholeMemberText } from "./tooling.ts";

Deno.test("inserted text is whole members when everything it opens closes inside it", () => {
  for (
    const text of [
      "attribute x = 1;",
      "part a; part b;",
      "part def A { part b; }",
      "doc /* } */ part c;",
      "attribute 'a}b' = 1;",
      "attribute 'it\\'s' = 1;",
      'attribute s : String = "}";',
      'attribute s : String = "a\\"}";',
      "// }\npart x;",
      "part a { // note\r}",
      "//* } \n */ part y;",
      "part x {\r\n  part y;\r\n}",
    ]
  ) equal(isWholeMemberText(text), true, text);
});

Deno.test("inserted text that closes its owner or leaves something open is refused", () => {
  for (
    const text of [
      "} part def Escaped {",
      "}",
      "{",
      "part x {",
      "part a; } part b { part c;",
      "} /* a */ part def E { /* b */",
      "}\r\npart def E {",
      "// note\r} part def Escaped {",
      "/* never closed",
      "//* never closed",
      "'never closed",
      '"never closed',
    ]
  ) equal(isWholeMemberText(text), false, text);
});

Deno.test("type edits accept only bounded native qualified names, never source fragments", () => {
  for (
    const typeName of [
      "Flow",
      "Assembly::PrivateFlow",
      "::Assembly::PrivateFlow",
      "Assembly::'révision-台灣'",
      "'L\\'atelier'::'a\\\\b'",
      "'name; with {punctuation}'",
      "T".repeat(4096),
      "'" + "😀".repeat(4094) + "'",
    ]
  ) equal(isModelEditTypeName(typeName), true, typeName);
  for (
    const typeName of [
      "",
      " ",
      "T".repeat(4097),
      "'" + "😀".repeat(4095) + "'",
      "A::",
      "A::::B",
      "A:B",
      "A::'unclosed",
      "A::''",
      "A::'bad\\q'",
      " A::B",
      "A::B ",
      "A::B\n",
      "A::'B\nC'",
      "T; attribute injected = 1;",
      "T { attribute injected = 1; }",
      "T/* comment */",
      "T // comment",
      "T, Other",
      "T[*]",
      "A::unquoted name",
      "A::révision-台灣",
    ]
  ) equal(isModelEditTypeName(typeName), false, typeName);
  for (const value of [null, undefined, {}, [], 42]) {
    equal(isModelEditTypeName(value), false);
  }
});
