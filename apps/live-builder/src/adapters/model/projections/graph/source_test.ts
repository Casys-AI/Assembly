import { sourceSnapshot } from "./source.ts";
Deno.test("owned documentation preserves sibling order and the first native owner", () => {
  const elements = [
    { "@id": "first", "@type": "PartDefinition", declaredName: "First" },
    { "@id": "second", "@type": "PartDefinition", declaredName: "Second" },
    {
      "@id": "doc-b",
      "@type": "Documentation",
      owner: [{ "@id": "first" }, { "@id": "second" }],
      body: "Earlier documentation",
    },
    {
      "@id": "other-doc",
      "@type": "Documentation",
      owner: { "@id": "second" },
      body: "Other owner",
    },
    {
      "@id": "doc-a",
      "@type": "Documentation",
      owner: { "@id": "first" },
      body: "Later documentation",
    },
  ];
  const snapshot = sourceSnapshot(elements, "root");
  const first = snapshot.elements.find((element) => element.id === "first");
  const second = snapshot.elements.find((element) => element.id === "second");
  if (first?.doc !== "Earlier documentation\nLater documentation") {
    throw new Error("Owned documentation lost native sibling order");
  }
  if (second?.doc !== "Other owner") {
    throw new Error("Documentation was attached beyond its first native owner");
  }
});
Deno.test("catalog identities stay referenceable without becoming partial graph definitions", () => {
  const elements = [
    {
      "@id": "package",
      "@type": "Package",
      declaredName: "P",
      qualifiedName: "P",
    },
    {
      "@id": "part",
      "@type": "PartUsage",
      declaredName: "p",
      owner: { "@id": "package" },
      type: [{ "@id": "definition" }],
      isReference: true,
      "sysx:declaredReference": false,
    },
    {
      "@id": "definition",
      "@type": "PartDefinition",
      declaredName: "T",
      owner: { "@id": "package" },
    },
    {
      "@id": "action",
      "@type": "ActionUsage",
      declaredName: "action",
      owner: { "@id": "package" },
      type: [{ "@id": "library" }],
    },
    {
      "@id": "library",
      "@type": "ActionDefinition",
      declaredName: "Action",
      qualifiedName: "Actions::Action",
      "toolkit:catalogOnly": true,
    },
  ];
  const snapshot = sourceSnapshot(elements, "root");
  if (snapshot.elements.some((e) => e.id === "library")) {
    throw new Error(
      "Incomplete catalog type rendered as a model-owned definition",
    );
  }
  const part = snapshot.elements.find((e) => e.id === "part");
  if (!part?.isReference || part.declaredReference !== false) {
    throw new Error("Native reference flag or declaration evidence lost");
  }
  const action = snapshot.elements.find((e) => e.id === "action");
  if (JSON.stringify(action?.typeIds) !== JSON.stringify(["library"])) {
    throw new Error("Native catalog identity lost from type references");
  }
});
Deno.test("owned explicit typing selects a narrowed redefinition contract over inherited generic types", () => {
  const elements = [
    { "@id": "p", "@type": "Package", declaredName: "P" },
    {
      "@id": "f",
      "@type": "ItemUsage",
      declaredName: "input",
      owner: { "@id": "p" },
      type: [{ "@id": "specific" }, { "@id": "generic" }],
      ownedTyping: [{ "@id": "typing" }],
    },
    {
      "@id": "typing",
      "@type": "FeatureTyping",
      isImplied: false,
      target: [{ "@id": "specific" }],
    },
  ];
  const input = sourceSnapshot(elements, "root").elements.find((e) =>
    e.id === "f"
  );
  if (JSON.stringify(input?.typeIds) !== JSON.stringify(["specific"])) {
    throw new Error(
      "Inherited generic type made a native narrowed contract ambiguous",
    );
  }
});
