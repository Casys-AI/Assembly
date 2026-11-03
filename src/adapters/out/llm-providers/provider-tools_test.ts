import { equal, ok } from "node:assert/strict";
import { decisionSchema } from "./output-validation.ts";
import { buildProviderTools } from "./provider-tools.ts";

Deno.test("consult_model tool description prefers bounded discovery before a full source read", () => {
  const description =
    buildProviderTools(decisionSchema).find((tool) =>
      tool.name === "consult_model"
    )!.description;
  ok(description.includes("search, inspect and query"));
  ok(description.includes("read_source"));
  ok(description.indexOf("search") < description.indexOf("read_source"));
  equal(description.includes("avant de décider"), false);
});
