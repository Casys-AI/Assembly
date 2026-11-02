import { normalizeToolkit, toolkitTokens } from "./normalizer.ts";
function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}
Deno.test("Toolkit byte provenance preserves multibyte source columns and semantic flags", () => {
  const text = "/*é*/ part p;";
  const start = new TextEncoder().encode("/*é*/ ").length;
  const result = normalizeToolkit(
    [{ "@id": "p", "@type": "PartUsage", isReference: true }],
    new Map([["p", {
      memberExtent: {
        unit: 7,
        start,
        end: new TextEncoder().encode(text).length,
      },
    }]]),
    [{ unit: 7, name: "x.sysml", text }],
  );
  equal(result[0]["sysx:sourceColumn"], 8);
  equal(result[0]["sysx:sourceText"], "part p;");
  equal(result[0].isReference, true);
});
Deno.test("Toolkit decision branches use native ownership, guards and succession identities", () => {
  const raw = [
    {
      "@id": "o",
      "@type": "ActionUsage",
      ownedMember: [{ "@id": "d" }, { "@id": "t" }, { "@id": "e" }],
    },
    { "@id": "d", "@type": "DecisionNode" },
    {
      "@id": "t",
      "@type": "TransitionUsage",
      source: { "@id": "t" },
      guardExpression: { "@id": "g" },
      succession: { "@id": "s" },
    },
    {
      "@id": "e",
      "@type": "TransitionUsage",
      source: { "@id": "e" },
      succession: { "@id": "z" },
    },
    { "@id": "s", "@type": "SuccessionAsUsage" },
    { "@id": "z", "@type": "SuccessionAsUsage" },
  ];
  const text = "if true then a;else b;";
  const result = normalizeToolkit(
    raw,
    new Map([["t", { memberExtent: { unit: 0, start: 0, end: 15 } }], ["e", {
      memberExtent: { unit: 0, start: 15, end: 22 },
    }]]),
    [{ unit: 0, name: "x.sysml", text }],
  );
  equal(result[2].source, { "@id": "d" });
  equal(result[3]["sysx:isElse"], true);
  equal(result[4]["sysx:sourceMember"], { "@id": "d" });
  equal(raw[2].source, { "@id": "t" });
});
Deno.test("Toolkit refuses unexplained self-source transitions", () => {
  let failed = false;
  try {
    normalizeToolkit(
      [{ "@id": "t", "@type": "TransitionUsage", source: { "@id": "t" } }],
      new Map(),
      [],
    );
  } catch {
    failed = true;
  }
  equal(failed, true);
  equal(toolkitTokens('/* if { */ "else" // }\n then'), ['"else"', "then"]);
});
Deno.test("native transition sources retain else semantics without endpoint repair", () => {
  const text = "else b;first d then b;";
  const raw = [
    {
      "@id": "o",
      "@type": "ActionUsage",
      ownedMember: [{ "@id": "e" }, { "@id": "t" }],
    },
    { "@id": "d", "@type": "DecisionNode" },
    { "@id": "e", "@type": "TransitionUsage", source: { "@id": "d" } },
    { "@id": "t", "@type": "TransitionUsage", source: { "@id": "d" } },
  ];
  const result = normalizeToolkit(
    raw,
    new Map([
      ["e", { memberExtent: { unit: 0, start: 0, end: 7 } }],
      ["t", { memberExtent: { unit: 0, start: 7, end: text.length } }],
    ]),
    [{ unit: 0, name: "native.sysml", text }],
  );
  equal(result[2].source, { "@id": "d" });
  equal(result[2]["sysx:isElse"], true);
  equal(result[3]["sysx:isElse"], undefined);
  equal("sysx:isElse" in raw[2], false);
});
Deno.test("a native else branch cannot also claim an explicit guard", () => {
  let failed = false;
  try {
    normalizeToolkit(
      [
        { "@id": "o", "@type": "ActionUsage", ownedMember: [{ "@id": "e" }] },
        {
          "@id": "e",
          "@type": "TransitionUsage",
          source: { "@id": "d" },
          guardExpression: { "@id": "g" },
        },
      ],
      new Map([["e", { memberExtent: { unit: 0, start: 0, end: 7 } }]]),
      [{ unit: 0, name: "native.sysml", text: "else b;" }],
    );
  } catch {
    failed = true;
  }
  equal(failed, true);
});
Deno.test("Toolkit direct part reference evidence distinguishes declarations and aliases", () => {
  const declarations = [
    "part ordinary : T;",
    "ref part alias : T;",
    "/* ref part */ private part ordinary : T;",
    "part def T { ref part nested : T; }",
    "alias ordinary for T;",
  ];
  const expected = [false, true, false, undefined, undefined];
  declarations.forEach((text, index) => {
    const result = normalizeToolkit(
      [{
        "@id": "p",
        "@type": index === 3 ? "PartDefinition" : "PartUsage",
        isReference: true,
      }],
      new Map([["p", {
        memberExtent: {
          unit: 0,
          start: 0,
          end: new TextEncoder().encode(text).length,
        },
      }]]),
      [{ unit: 0, name: "x.sysml", text }],
    );
    equal(result[0]["sysx:declaredReference"], expected[index]);
    equal(result[0].isReference, true);
  });
});
