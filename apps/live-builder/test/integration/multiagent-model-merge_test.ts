import { SYSML_TOOLKIT_VERSION } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../src/domain/model/records/revision.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
/** Repository integration with real Toolkit and Git, not an end-to-end
 * three-agent/LLM demonstration. Admission merges sources and recompiles them;
 * it does not merge the native graph. Every project directory and journal is test-owned. */
import {
  deepStrictEqual,
  equal,
  notEqual,
  ok,
  rejects,
} from "node:assert/strict";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const market = "merge-market.sysml";
const competition = "merge-competition.sysml";
const actors = ["operator:market", "operator:competition"] as const;
const coordinator = "coordinator";

function declaration(area: "Market" | "Competition", value: number): string {
  return `package Merge${area} {\n    private import ScalarValues::*;\n    attribute evidenceRevision : Integer = ${value};\n}\n`;
}

function nativeDeclaration(revision: ModelRevision, area: string) {
  const matches = revision.elements.filter((element) =>
    element["@type"] === "AttributeUsage" &&
    element.qualifiedName === `Merge${area}::evidenceRevision`
  );
  equal(matches.length, 1, `One native ${area} declaration must survive`);
  const element = matches[0]!;
  const stored = revision.documents.find((document) =>
    document["@id"] === `ElementV0/${element["@id"]}`
  );
  ok(stored, "The provider declaration must also exist in stored native IR");
  equal(stored.metaclass, "AttributeUsage");
  return element;
}

function nativeInteger(
  revision: ModelRevision,
  area: string,
  expected: number,
) {
  const attribute = nativeDeclaration(revision, area);
  const values = revision.elements.filter((element) =>
    element["@type"] === "FeatureValue" &&
    (element.featureWithValue as { "@id"?: string })?.["@id"] ===
      attribute["@id"]
  );
  equal(values.length, 1);
  const literalId = (values[0]!.value as { "@id": string })["@id"];
  const literal = revision.elements.find((element) =>
    element["@id"] === literalId
  );
  equal(literal?.["@type"], "LiteralInteger");
  equal(literal.value, expected);
  const stored = revision.documents.find((document) =>
    document["@id"] === `ElementV0/${literalId}`
  );
  equal(
    stored?.integer_value,
    expected,
    "Compiled integer must survive native IR storage",
  );
}

async function acceptedReceipt(
  repository: GitModelRepository,
  proposal: ProposalRecord,
  admitted: ModelRevision,
  expectedParent: string,
) {
  const receipt = await repository.proposal(proposal.id);
  equal(receipt.author, proposal.author);
  equal(receipt.baseVersion, proposal.baseVersion);
  equal(receipt.proposalVersion, proposal.proposalVersion);
  equal(receipt.sourceDigest, proposal.sourceDigest);
  equal(receipt.status, "accepted");
  equal(receipt.decidedBy, coordinator);
  equal(receipt.acceptanceBaseVersion, expectedParent);
  equal(receipt.acceptedVersion, admitted.version);
  equal(receipt.targetSourceDigest, admitted.sourceDigest);
  ok(receipt.decidedAt);
  return receipt;
}

Deno.test({
  name:
    "repository multi-operator integration: common-base source merge, CAS race, explicit conflict and native diff",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    equal(Deno.version.deno, "2.9.7");
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    equal(await compiler.version(), SYSML_TOOLKIT_VERSION);
    const projectId = `git:${crypto.randomUUID()}`;
    const stateDir = await Deno.makeTempDir({
      prefix: "ase-multi-merge-test-",
    });
    let repository: GitModelRepository;
    let validationCount = 0;
    const gatedCompiler = {
      async compile(sources: Sources) {
        const compiled = await compiler.compile(sources);
        await validateSourceExecutable({
          ...compiled,
          version: "compile-gate",
        }, projectId);
        validationCount++;
        return compiled;
      },
      recipe: () => compiler.recipe(),
    };
    try {
      repository = await GitModelRepository.open({
        projectDir: stateDir,
        compiler: gatedCompiler,
      });
      const base = await repository.initialize(
        await loadInitialSources(undefined, { information: false }),
      );
      const executableBase = await validateSourceExecutable(base, projectId);
      const proposals = await Promise.all([
        repository.propose({
          baseVersion: base.version,
          sources: { ...base.sources, [market]: declaration("Market", 1) },
          author: actors[0],
          reason: "Add independently authored market evidence declaration",
        }),
        repository.propose({
          baseVersion: base.version,
          sources: {
            ...base.sources,
            [competition]: declaration("Competition", 1),
          },
          author: actors[1],
          reason: "Add independently authored competition evidence declaration",
        }),
      ]);
      const [marketProposal, competitionProposal] = proposals;
      notEqual(marketProposal.branch, competitionProposal.branch);
      notEqual(
        marketProposal.proposalVersion,
        competitionProposal.proposalVersion,
      );
      for (const [index, proposal] of proposals.entries()) {
        equal(proposal.baseVersion, base.version);
        equal(proposal.author, actors[index]);
        equal(proposal.status, "proposed");
        equal(proposal.validation, "validated");
        const branch = await repository.at(proposal.proposalVersion!);
        equal(branch.sourceDigest, proposal.sourceDigest);
        equal(market in branch.sources, index === 0);
        equal(competition in branch.sources, index === 1);
        nativeDeclaration(branch, index === 0 ? "Market" : "Competition");
      }
      deepStrictEqual(await repository.current(), base);

      const admittedMarket = await repository.accept({
        id: marketProposal.id,
        expectedVersion: base.version,
        author: coordinator,
      });
      await acceptedReceipt(
        repository,
        marketProposal,
        admittedMarket,
        base.version,
      );
      const merged = await repository.accept({
        id: competitionProposal.id,
        expectedVersion: admittedMarket.version,
        author: coordinator,
      });
      await acceptedReceipt(
        repository,
        competitionProposal,
        merged,
        admittedMarket.version,
      );
      const expectedSources = {
        ...base.sources,
        [market]: declaration("Market", 1),
        [competition]: declaration("Competition", 1),
      };
      deepStrictEqual(merged.sources, expectedSources);
      notEqual(merged.sourceDigest, base.sourceDigest);
      notEqual(merged.semanticDigest, base.semanticDigest);
      const marketId = nativeDeclaration(merged, "Market")["@id"];
      const competitionId = nativeDeclaration(merged, "Competition")["@id"];
      equal(marketId, nativeDeclaration(admittedMarket, "Market")["@id"]);
      equal(
        competitionId,
        nativeDeclaration(
          await repository.at(competitionProposal.proposalVersion!),
          "Competition",
        )["@id"],
      );
      const executableMerged = await validateSourceExecutable(
        merged,
        projectId,
      );
      deepStrictEqual(executableMerged.flows, executableBase.flows);
      deepStrictEqual(executableMerged.policy, executableBase.policy);
      equal(executableMerged.version.digest, executableBase.version.digest);
      deepStrictEqual(
        executableMerged.version.sourceIds,
        executableBase.version.sourceIds,
      );
      equal(executableMerged.version.repositoryVersion, merged.version);
      const diff = await repository.graphDiff(base.version, merged.version);
      equal(diff.engine, "Git");
      equal(diff.fromVersion, base.version);
      equal(diff.toVersion, merged.version);
      deepStrictEqual(diff.sourceDigests, {
        before: base.sourceDigest,
        after: merged.sourceDigest,
      });
      ok(diff.counts.added > 0);
      equal(diff.truncated, false);
      for (const nativeId of [marketId, competitionId]) {
        ok(
          diff.changes.some((change) =>
            change.nativeId === nativeId && change.kind === "added"
          ),
        );
      }

      // Two repository instances share the documented OS lock/state directory.
      const peer = await GitModelRepository.open({
        projectDir: stateDir,
        compiler: gatedCompiler,
      });
      const raceProposals = await Promise.all([
        repository.propose({
          baseVersion: merged.version,
          sources: { ...merged.sources, [market]: declaration("Market", 2) },
          author: actors[0],
          reason: "Advance market evidence independently",
        }),
        peer.propose({
          baseVersion: merged.version,
          sources: {
            ...merged.sources,
            [competition]: declaration("Competition", 2),
          },
          author: actors[1],
          reason: "Advance competition evidence independently",
        }),
      ]);
      const race = await Promise.allSettled(
        raceProposals.map((proposal, index) =>
          (index === 0 ? repository : peer).accept({
            id: proposal.id,
            expectedVersion: merged.version,
            author: coordinator,
          })
        ),
      );
      equal(race.filter((result) => result.status === "fulfilled").length, 1);
      const loser = race.findIndex((result) => result.status === "rejected");
      const failure = race[loser] as PromiseRejectedResult;
      ok(failure.reason instanceof ModelRepositoryError);
      equal(failure.reason.code, "STALE_REVISION");
      deepStrictEqual(
        await repository.proposal(raceProposals[loser]!.id),
        raceProposals[loser],
      );
      const winner = await repository.current();
      const winnerIndex = 1 - loser;
      await acceptedReceipt(
        repository,
        raceProposals[winnerIndex]!,
        winner,
        merged.version,
      );
      const afterRace = await repository.accept({
        id: raceProposals[loser]!.id,
        expectedVersion: winner.version,
        author: coordinator,
      });
      await acceptedReceipt(
        repository,
        raceProposals[loser]!,
        afterRace,
        winner.version,
      );
      equal(afterRace.sources[market], declaration("Market", 2));
      equal(afterRace.sources[competition], declaration("Competition", 2));
      nativeInteger(afterRace, "Market", 2);
      nativeInteger(afterRace, "Competition", 2);

      const clash = await Promise.all(
        [3, 4].map((value, index) =>
          repository.propose({
            baseVersion: afterRace.version,
            sources: {
              ...afterRace.sources,
              [market]: declaration("Market", value),
            },
            author: actors[index]!,
            reason: `Conflicting market evidence revision ${value}`,
          })
        ),
      );
      const clashWinner = await repository.accept({
        id: clash[0]!.id,
        expectedVersion: afterRace.version,
        author: coordinator,
      });
      await acceptedReceipt(
        repository,
        clash[0]!,
        clashWinner,
        afterRace.version,
      );
      const dossierBefore = await repository.listProposals();
      const validationsBeforeConflict = validationCount;
      await rejects(
        () =>
          repository.accept({
            id: clash[1]!.id,
            expectedVersion: clashWinner.version,
            author: coordinator,
          }),
        (error: unknown) =>
          error instanceof ModelRepositoryError &&
          error.code === "SOURCE_CONFLICT" && error.message.includes(market),
      );
      equal(
        validationCount,
        validationsBeforeConflict,
        "Conflicted text must never compile or publish",
      );
      deepStrictEqual(await repository.current(), clashWinner);
      deepStrictEqual(await repository.listProposals(), dossierBefore);
      deepStrictEqual(await repository.proposal(clash[1]!.id), clash[1]);
      equal(
        (await repository.at(clash[1]!.proposalVersion!)).sources[market],
        declaration("Market", 4),
      );
      const finalExecutable = await validateSourceExecutable(
        await repository.current(),
        projectId,
      );
      deepStrictEqual(finalExecutable.flows, executableBase.flows);
      deepStrictEqual(finalExecutable.policy, executableBase.policy);
      equal(finalExecutable.version.digest, executableBase.version.digest);
      deepStrictEqual(
        finalExecutable.version.sourceIds,
        executableBase.version.sourceIds,
      );
      equal(finalExecutable.version.repositoryVersion, clashWinner.version);
      equal(nativeDeclaration(clashWinner, "Market")["@id"], marketId);
      equal(
        nativeDeclaration(clashWinner, "Competition")["@id"],
        competitionId,
      );
      nativeInteger(clashWinner, "Market", 3);
      nativeInteger(clashWinner, "Competition", 2);
      const finalDiff = await repository.graphDiff(
        base.version,
        clashWinner.version,
      );
      equal(finalDiff.fromVersion, base.version);
      equal(finalDiff.toVersion, clashWinner.version);
      equal(finalDiff.truncated, false);
      for (const nativeId of [marketId, competitionId]) {
        ok(
          finalDiff.changes.some((change) =>
            change.nativeId === nativeId && change.kind === "added"
          ),
        );
      }
      deepStrictEqual(await repository.at(base.version), base);
      deepStrictEqual(await repository.at(merged.version), merged);
      const history = await repository.history();
      equal(history.headVersion, clashWinner.version);
      equal(
        history.commits.filter((entry) => entry.author === coordinator).length,
        5,
      );
      ok(
        validationCount >= 10,
        "Sources are revalidated at proposal and admission",
      );
      console.log(JSON.stringify({
        qualification:
          "repository-integration; no LLM calls; source merge then recompile",
        toolchain: {
          deno: Deno.version.deno,
          toolkit: SYSML_TOOLKIT_VERSION,
          repository: "Git",
        },
        baseVersion: base.version,
        mergedVersion: merged.version,
        finalVersion: clashWinner.version,
        finalSourceDigest: clashWinner.sourceDigest,
        executableDigest: finalExecutable.version.digest,
        executableSourceIds: finalExecutable.version.sourceIds.length,
        nativeDeclarationIds: { market: marketId, competition: competitionId },
        nativeDiff: finalDiff.counts,
        validatedCompilations: validationCount,
        cas: { admitted: 1, refused: "STALE_REVISION", retry: "accepted" },
        conflict: {
          code: "SOURCE_CONFLICT",
          headPreserved: true,
          dossiersPreserved: true,
        },
        receipts: dossierBefore.map((
          { id, author, status, baseVersion, acceptedVersion, decidedBy },
        ) => ({ id, author, status, baseVersion, acceptedVersion, decidedBy })),
      }));
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
});
