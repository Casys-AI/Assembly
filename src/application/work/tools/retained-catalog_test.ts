import { deepStrictEqual, rejects } from "node:assert/strict";
import { publishedArtifact } from "../../../../test/support/tool-artifact-fixture.ts";
import { assertRetainedCatalog } from "./retained-catalog.ts";

Deno.test("retained opening covers active catalogue contracts and exact seeds without approving pending tools", async () => {
  const { model, candidate } = await publishedArtifact();
  const tools = [{
    candidateId: candidate.id,
    digest: candidate.digest,
    sourceBinding: candidate.sourceBinding,
  }];
  const { name, description, kind, code } = candidate;
  model.initialTools = [{
    id: "seed",
    nativeId: "native-seed",
    sourceIds: ["native-seed"],
    draft: { name, description, kind, code },
  }];
  const before = structuredClone(model);
  await assertRetainedCatalog(model, tools);
  deepStrictEqual(model, before);
  await rejects(() => assertRetainedCatalog(model, []));
  const changed = structuredClone(model);
  changed.catalog[0].status = "awaiting-admission";
  await rejects(() => assertRetainedCatalog(changed, tools));
  const uncovered = structuredClone(model);
  uncovered.initialTools![0].draft.code += " ";
  await rejects(
    () => assertRetainedCatalog(uncovered, tools),
    /initial tool seed/,
  );
  const contract = structuredClone(model);
  contract.contracts = [];
  await rejects(() => assertRetainedCatalog(contract, tools), /contract/);
  await rejects(() => assertRetainedCatalog(model, [...tools, ...tools]));
});
