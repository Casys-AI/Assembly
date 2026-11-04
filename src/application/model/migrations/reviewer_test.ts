import { equal, ok } from "node:assert/strict";
import {
  DYNAMIC_MANDATE_SOURCE,
  LEGACY_DYNAMIC_MANDATE_SOURCE,
} from "../../../domain/governance/mandates.ts";
import { declareReviewer } from "./reviewer.ts";

Deno.test("reviewer declaration keeps replacement patterns in names literal", () => {
  const template =
    "package P { part reviewer : ASELiveBuilder::IndependentReviewer; }";
  const declared = declareReviewer(template, "rev-$&", "Rev $' and $` here");
  ok(declared.includes('"rev-$&"'));
  ok(declared.includes('"Rev $\' and $` here"'));
  equal(
    declared.includes("part reviewer : ASELiveBuilder::IndependentReviewer;"),
    false,
  );
  equal(
    declared.startsWith(
      "package P { part reviewer : ASELiveBuilder::IndependentReviewer {",
    ),
    true,
  );
  equal(declared.endsWith("; } }"), true);
});

Deno.test("new reviewer declarations refresh only their exact historical provenance field", () => {
  const template = `part reviewer : AssemblyLiveBuilder::IndependentReviewer;
item reviewerMandate : AssemblyCore::ConfiguredMandate {
    attribute :>> source = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};
    attribute :>> scope = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};
    attribute :>> mayAdmit = true;
}`;
  const declared = declareReviewer(template, "new-reviewer", "New reviewer");
  ok(
    declared.includes(
      `attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};`,
    ),
  );
  ok(
    declared.includes(
      `attribute :>> scope = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};`,
    ),
  );
  ok(declared.includes("attribute :>> mayAdmit = true;"));
  ok(
    template.includes(
      `attribute :>> source = ${
        JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)
      };`,
    ),
  );
  const currentTemplate = template.replace(
    `attribute :>> source = ${JSON.stringify(LEGACY_DYNAMIC_MANDATE_SOURCE)};`,
    `attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};`,
  );
  equal(
    declareReviewer(currentTemplate, "new-reviewer", "New reviewer"),
    declared,
  );
});
