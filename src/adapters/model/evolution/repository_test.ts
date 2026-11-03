// deno-lint-ignore-file require-await -- Deterministic asynchronous port doubles.
import assert from "node:assert/strict";
import type { ModelEditRequest } from "../../../domain/model/editing/tooling.ts";
import { NativeEvolutionRepository } from "./repository.ts";
import type { EvolutionDossier } from "../../../application/model/evolution/ports.ts";
import type { ModelRepositoryPort } from "../../../application/model/repository.ts";
import type { EvolutionProposalAuthorization } from "../../../domain/model/evolution/policy.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../domain/model/records/revision.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import {
  buildDescriptor,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import { buildAcceptProposalCommand } from "../../../application/model/publication/write-queue.ts";
import { modelWriteCommandDigest } from "../../../domain/model/editing/write-command.ts";

const hex = (value: string) => value.repeat(64);
const version = `commit:${"1".repeat(40)}`;
const stagedVersion = `commit:${"2".repeat(40)}`;
const admittedVersion = `commit:${"3".repeat(40)}`;
const recipe = {
  toolkit: { version: "1", bundleDigest: hex("b") },
  format: "json",
  normalizerVersion: 1,
  irVersion: "1",
  artifactSchema: 1,
  engineVersion: "1",
};
async function revision(
  sources: Record<string, string>,
  version: string,
): Promise<ModelRevision> {
  return {
    version,
    sources,
    elements: [],
    documents: [],
    sourceDigest: await modelSourceDigest(sources),
    semanticDigest: hex("c"),
    provenanceDigest: hex("d"),
    sourceHashes: {},
    engineVersion: "1",
  };
}
async function setup(typed = false) {
  const oldText = "package P {\n  attribute x = 1;\n}\n";
  const newText = "package P {\n  attribute x = 2;\n}\n";
  let head = await revision({ "model.sysml": oldText }, version);
  head.elements = [{
    "@id": "package",
    "@type": "Package",
    qualifiedName: "P",
    "sysx:sourceDocument": "model.sysml",
  }, {
    "@id": "attribute",
    "@type": "AttributeUsage",
    qualifiedName: "P::x",
    owner: { "@id": "package" },
    "sysx:sourceLine": 2,
    "sysx:sourceColumn": 3,
    "sysx:sourceEndLine": 2,
    "sysx:sourceEndColumn": 19,
  }];
  const base = head;
  const after = await revision({ "model.sysml": newText }, stagedVersion);
  const recipeHash = await recipeDigest(recipe);
  const descriptor = buildDescriptor({
    repositoryId: "repo",
    sourceDigest: after.sourceDigest,
    recipe,
    recipeDigest: recipeHash,
    buildKey: hex("a"),
    artifactDigest: hex("b"),
    bytes: 1,
  });
  const preparation = {
    act: "prepare" as const,
    operatorNativeId: "preparer",
    systemQualifiedName: "System",
    authorityDigest: hex("a"),
    policyId: "evolve",
    policyRevision: 1,
    mandateNativeId: "mandate",
    mandateId: "mandate",
    mandateRevision: 1,
    targets: ["target"],
    categories: ["instructions" as const],
    proposalDigest: hex("f"),
  };
  const authorization: EvolutionProposalAuthorization = {
    kind: "operator-evolution",
    systemQualifiedName: "System",
    operatorNativeId: "preparer",
    exercise: preparation,
    recipeDigest: recipeHash,
    editAuthorization: {
      kind: "operator",
      systemQualifiedName: "System",
      operatorQualifiedName: "System::preparer",
      operatorNativeId: "preparer",
      mandateId: "mandate",
      mandateRevision: 1,
      policyId: "edit",
      policyRevision: 1,
      policyDigest: hex("c"),
      operations: ["replace-source"],
    },
  };
  let record: ProposalRecord;
  let anchor: { revision: ModelRevision; commandDigest: string } | null = null;
  let acceptCalls = 0;
  let proposalCalls = 0;
  const repository = {
    current: async () => head,
    at: async () => after,
    header: async () => base,
    descriptorAt: async () => descriptor,
    propose: async (input: Parameters<ModelRepositoryPort["propose"]>[0]) => {
      proposalCalls++;
      record = {
        id: "11111111-1111-4111-8111-111111111111",
        branch: "proposal",
        author: input.author,
        reason: input.reason,
        authorization: input.authorization,
        baseVersion: input.baseVersion,
        createdAt: "now",
        status: "proposed",
        validation: "validated",
        sourceDigest: after.sourceDigest,
        proposalVersion: after.version,
        diff: [{
          path: "model.sysml",
          kind: "changed",
          before: oldText,
          after: newText,
        }],
      };
      return record;
    },
    proposal: async () => record,
    findPublicationByCommand: async () => anchor,
    accept: async (input: Parameters<ModelRepositoryPort["accept"]>[0]) => {
      acceptCalls++;
      assert.equal(input.decisionAuthorityExercise, undefined);
      assert.equal(input.evolutionDecision?.operatorNativeId, "acceptor");
      const command = await buildAcceptProposalCommand({
        repositoryId: "repo",
        proposal: record,
        expectedVersion: input.expectedVersion,
        author: input.author,
        baseSourceDigest: head.sourceDigest,
        recipeDigest: recipeHash,
        evolutionDecision: input.evolutionDecision,
      });
      head = { ...after, version: admittedVersion };
      anchor = {
        revision: head,
        commandDigest: await modelWriteCommandDigest(command.command),
      };
      record = { ...record, status: "accepted", acceptedVersion: head.version };
      return head;
    },
  };
  let editCalls = 0;
  const typedRequest: ModelEditRequest = {
    baseVersion: version,
    sourceDigest: base.sourceDigest,
    reason: "Update instructions",
    edits: [{ kind: "set-value", elementId: "attribute", expression: "2" }],
  };
  const adapter = new NativeEvolutionRepository({
    repositoryId: "repo",
    repository,
    compiler: { compile: async () => after, recipe: async () => recipe },
    tooling: {
      edit: async (sources, edits) => {
        editCalls++;
        assert.equal(sources["model.sysml"], oldText);
        assert.deepEqual(edits, [{
          kind: "set-value",
          target: {
            qualifiedName: "P::x",
            metaclass: "AttributeUsage",
            source: { path: "model.sysml", text: "attribute x = 1;" },
          },
          expression: "2",
        }]);
        return {
          sources: after.sources,
          targets: [],
          splices: [{
            unit: "model.sysml",
            start: oldText.indexOf("1;"),
            end: oldText.indexOf("1;") + 1,
            text: "2",
          }],
          idMap: [],
          diagnostics: [],
          provider: { name: "double", version: "1" },
        };
      },
    },
    assess: {
      authorizePreparation: async (input) => {
        if (input.typedEdits) {
          authorization.typedEdits = input.typedEdits;
          authorization.editAuthorization.operations = input.typedEdits.edits
            .map((edit) => edit.kind);
        }
        return ({
          authorization,
          targets: [{
            operatorId: "target",
            previousDigest: hex("a"),
            candidateDigest: hex("b"),
          }],
          categories: ["instructions"],
          digest: hex("f"),
        });
      },
    },
  });
  const proposal = await adapter.prepare({
    id: "evolution",
    repositoryId: "repo",
    actorId: "preparer",
    finalizerActorId: "acceptor",
    origin: { operatorId: "preparer" },
    expectedVersion: version,
    ...(typed ? { edit: typedRequest } : { sources: after.sources }),
    reason: "Update instructions",
  });
  const dossier: EvolutionDossier = {
    v: 1,
    id: "evolution",
    repositoryId: "repo",
    revision: 1,
    status: "prepared",
    origin: { operatorId: "preparer" },
    finalizerActorId: "acceptor",
    accounting: { id: "evolution", agentInvocations: 0 },
    createdAt: "now",
    updatedAt: "now",
    proposal,
    preparation,
    acceptance: { ...preparation, act: "accept", operatorNativeId: "acceptor" },
    adoptions: [],
    blockers: [],
  };
  return {
    adapter,
    dossier,
    authorization,
    typedRequest,
    editCalls: () => editCalls,
    calls: () => ({ acceptCalls, proposalCalls }),
    setHead: (value: ModelRevision) => {
      head = value;
    },
    setStatus: (value: ProposalRecord["status"]) => {
      record.status = value;
    },
    setAnchor: (value: typeof anchor) => {
      anchor = value;
    },
    after,
  };
}

Deno.test("evolution stages off HEAD, publishes only at finalization, and proves the exact queued anchor", async () => {
  const fixture = await setup();
  assert.deepEqual(fixture.calls(), { acceptCalls: 0, proposalCalls: 1 });
  assert(fixture.dossier.proposal.build);
  await assert.rejects(
    () => fixture.adapter.publish(fixture.dossier),
    /finalization checkpoint/,
  );
  const publishing = { ...fixture.dossier, status: "publishing" as const };
  const publication = await fixture.adapter.publish(publishing);
  assert.equal(publication.version, admittedVersion);
  assert.equal(publication.proposalDigest, publishing.proposal.digest);
  assert.deepEqual(await fixture.adapter.publish(publishing), publication);
  assert.equal(fixture.calls().acceptCalls, 1);
  fixture.setAnchor({
    ...{ revision: { ...fixture.after, version: admittedVersion } },
    commandDigest: hex("0"),
  });
  await assert.rejects(
    () => fixture.adapter.findPublication(publishing),
    /exact frozen command/,
  );
});

Deno.test("evolution refuses source drift and keeps interrupted publication uncertain", async () => {
  const fixture = await setup();
  fixture.setHead({ ...fixture.after, version: admittedVersion });
  await assert.rejects(
    () => fixture.adapter.revalidate(fixture.dossier),
    /cannot rebase/,
  );
  assert.equal(fixture.calls().acceptCalls, 0);
  fixture.setStatus("accepting");
  await assert.rejects(
    () => fixture.adapter.findPublication(fixture.dossier),
    /outcome remains uncertain/,
  );
});

Deno.test("targeted evolution resolves the admitted native element and preserves exact operation evidence", async () => {
  const fixture = await setup(true);
  assert.equal(fixture.editCalls(), 1);
  assert.deepEqual(fixture.authorization.editAuthorization.operations, [
    "set-value",
  ]);
  assert.deepEqual(fixture.authorization.typedEdits, fixture.typedRequest);
  assert.equal(fixture.calls().acceptCalls, 0);
  await fixture.adapter.revalidate(fixture.dossier);
  assert.equal(fixture.calls().acceptCalls, 0);
  const malformed = {
    id: "mixed",
    repositoryId: "repo",
    actorId: "preparer",
    finalizerActorId: "acceptor",
    origin: { operatorId: "preparer" },
    expectedVersion: version,
    reason: "invalid",
    edit: fixture.typedRequest,
    sources: { "model.sysml": "arbitrary" },
  };
  // Runtime JSON must obey the same exclusive input shape as typed callers.
  await assert.rejects(
    () => fixture.adapter.prepare(malformed as never),
    /Choose targeted edits/,
  );
  await assert.rejects(
    () =>
      fixture.adapter.prepare({
        ...malformed,
        sources: undefined,
        edit: { ...fixture.typedRequest, sourceDigest: hex("0") },
      }),
    /consulted exact base/,
  );
  assert.equal(fixture.editCalls(), 1);
});
