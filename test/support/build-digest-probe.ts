import { compileExecutableModel } from "../../src/adapters/out/sysml-toolkit/compilation-policies/work/execution-model.ts";
import { evolutionProposalDigest } from "../../src/domain/model/evolution/proposal-digest.ts";
import {
  localeExecutableFixture,
  localeIdentifiers,
} from "./locale-executable-fixture.ts";
import { artifactDigest } from "../../src/domain/model/value-objects/build.ts";
import { executionDigest } from "../../src/domain/primitives/execution-digest.ts";
import {
  modelSourceDigest,
  validateModelSources,
} from "../../src/domain/model/value-objects/sources.ts";
import { materialize } from "../../src/adapters/model/builds/materialization/artifact.ts";

/** Exercise every locale-sensitive ordering site, with nonempty origins. */
const input = JSON.parse(await Deno.readTextFile(Deno.args[0]));
const canary = ["aa", "z", "ä", "ø", "o", "I", "i", "ı", "İ"].toSorted((a, b) =>
  a.localeCompare(b)
);
const compiled = await materialize(
  input.elements,
  input.sources,
  input.engineVersion,
  input.provider,
);
const fixture = localeExecutableFixture();
let executableInput: Record<string, unknown> = {};
const executable = await compileExecutableModel(
  fixture.snapshot,
  fixture.graph,
  fixture.literals,
  fixture.identity,
  [],
  (value) => executableInput = value,
);
const targets = localeIdentifiers.map((operatorId) => ({
  operatorId,
  previousDigest: "previous",
  candidateDigest: "candidate",
}));
const proposalDigest = await evolutionProposalDigest({
  before: { version: "base", sourceDigest: "base-source" },
  after: compiled,
  recipeDigest: "recipe",
  targets,
  categories: [],
});
const flows = executable.flows;
const flow = flows.conversation;
const fixtureOrders = {
  nodes: flow.nodes.map((node) => node.id),
  edges: flow.edges.map((edge) => edge.id),
  bindings: flow.bindings.map((binding) => binding.nativeId),
  inputs: flow.nodes.find((node) => node.name === "step1")!.inputs,
  assertions: flow.nodes.find((node) => node.name === "step0")!.assertions.map((
    assertion,
  ) => assertion.nativeId),
  allocations: (executableInput.allocations as { id: string }[]).map((
    allocation,
  ) => allocation.id),
};
const legacyOrders = Object.fromEntries(
  Object.entries(fixtureOrders).map(([name, order]) => [
    name,
    name === "inputs"
      ? fixture.graph.nodes.filter((node) =>
        node.parentId === "conversation-z" && node.declaredDirection === "in"
      ).toSorted((a, b) => a.nativeId!.localeCompare(b.nativeId!)).map((node) =>
        node.label
      )
      : order.toSorted((a, b) => a.localeCompare(b)),
  ]),
);
legacyOrders.targets = targets.toSorted((a, b) =>
  a.operatorId.localeCompare(b.operatorId)
).map((target) => target.operatorId);
const providerContent =
  compiled.documents.find((document) =>
    document["@type"] === "ProviderArtifactV0"
  )!.content;
console.log(JSON.stringify({
  sourcePaths: Object.keys(validateModelSources(input.sources)),
  sourceDigest: await modelSourceDigest(input.sources),
  artifactDigest: await artifactDigest({
    provider: input.provider,
    engineVersion: input.engineVersion,
    elements: input.elements,
  }),
  executionDigest: await executionDigest(input.value),
  semanticDigest: compiled.semanticDigest,
  provenanceDigest: compiled.provenanceDigest,
  providerContent,
  canary,
  executableDigest: executable.version.digest,
  proposalDigest,
  fixtureOrders,
  legacyOrders,
}));
