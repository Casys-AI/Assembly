import { createSourceModel } from "../../src/composition/source-model-services.ts";
import { SYSML_TOOLKIT_VERSION } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { editPolicy } from "../fixtures/model-edit-mandate.ts";
import { NativeModelSourceAuthorization } from "../../src/application/governance/model-access/source-authorization.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
/** Real shared-repository qualification, without LLM calls or a live server.
 * Two native ConversationSystem occurrences share commits and an OS writer lock;
 * their authority, candidates, contracts and observations remain scope-owned. */
import assert from "node:assert/strict";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  sourceCompilation,
  sourceEvolutionCompilation,
  validateSourceExecutable,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { discoverConversationUnits } from "../../src/domain/model/records/source-identity.ts";
import {
  sourceLiterals,
  sourceRefs,
} from "../../src/domain/model/projections/source-facts.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import type {
  Candidate,
  ModelBinding,
} from "../../src/domain/work/records/candidates.ts";
import type { ModelIdentity } from "../../src/domain/shared-kernel/model-identity.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const initialInstruction =
  "Examiner le dossier reçu et ses sources autorisées.";
const revisedInstruction = "Examiner strictement le dossier transmis.";

// This standalone seed deliberately duplicates no executable test imports.
function twoScopes(sources: Sources): Sources {
  const source = sources["configuration.sysml"]!;
  const code = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,
    (text) => text.replace(/[^\n]/g, " "),
  );
  const start = code.indexOf("part liveBuilder : ConversationSystem {");
  assert(start >= 0);
  const open = code.indexOf("{", start);
  let end = open + 1, depth = 1;
  while (depth && end < code.length) {
    if (code[end] === "{") depth++;
    if (code[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0);
  const second = source.slice(start, end).replace(
    "part liveBuilder : ConversationSystem {",
    `part collector : ConversationSystem {
        attribute operatorName : String = "Collecteur";
        attribute operatorInstruction : String = "${initialInstruction}";
        attribute primaryContact : Boolean = false;
        attribute humanInputEnabled : Boolean = false;`,
  ).replace(
    'configurationId : String = "live-builder-native"',
    'configurationId : String = "collector-native"',
  ) // B11: cloned unit keeps its own endpoint; drop the copied designer fields.
    .replace(
      /\n *attribute operatorName : String = "(?:Designer|Main Operator)";/,
      "",
    )
    .replace(
      /\n *attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests\.";/,
      "",
    )
    .replace(/\n *attribute primaryContact : Boolean = true;/, "")
    .replace(/\n *attribute humanInputEnabled : Boolean = true;/, "");
  const close = source.lastIndexOf("\n}");
  assert(close > end);
  return {
    ...sources,
    "configuration.sysml": (source.slice(0, close) + "\n    " + second + "\n" +
      source.slice(close)).replace(
        "part liveBuilder : ConversationSystem {",
        "part liveBuilder : ConversationSystem {" +
          editPolicy("ConcurrentProof", true).replaceAll(
            "mission.sysml",
            "concurrent-proof.sysml",
          ),
      ),
    "concurrent-proof.sysml":
      "package ConcurrentProof { private import ScalarValues::*; attribute admittedBase : Integer = 0; }\n",
  };
}

function candidate(
  id: string,
  kind: Candidate["kind"],
  digest: string,
  model: ExecutableModel,
  identity: ModelIdentity,
): Candidate {
  const authority = model.configuration.builder.admissionAuthority;
  return {
    id,
    kind,
    digest,
    name: id,
    description: "Concurrent scoped repository qualification",
    code: "export default () => ({title:'Title',text:'Text'})",
    stage: "proposed",
    createdAt: "2026-10-21T00:00:00Z",
    baseCatalogRevision: 0,
    tests: { passed: true, checks: [] },
    admission: {
      candidateId: id,
      candidateDigest: digest,
      mandateRevision: model.configuration.builder.mandateRevision,
      configurationRevision: model.configuration.revision,
      authority,
      actorId: authority === "builder"
        ? identity.builderId
        : authority === "reviewer"
        ? identity.reviewerId!
        : identity.rootId,
      reason: "Exact scoped admission fixture",
      at: "2026-10-21T00:01:00Z",
    },
  };
}

function sourceOrigin(revision: ModelRevision, nativeId: string) {
  // Toolkit 0.10.1 emits sourceDocument on the root package, while nested
  // declarations retain source coordinates/text. Follow native ownership to
  // that stored root origin instead of inventing a direct literal origin.
  let current: string | undefined = nativeId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    visited.add(current);
    const origin = revision.documents.find((document) =>
      document["@id"] === `OriginV0/${current}`
    );
    if (origin) {
      const path = revision.documents.find((document) =>
        document["@id"] === origin.source_path
      );
      assert.equal(path?.path, "configuration.sysml");
      return origin;
    }
    const element = revision.elements.find((element) =>
      element["@id"] === current
    );
    current = sourceRefs(element?.owner)[0];
  }
  assert.fail("Native declaration must reach a stored source-package origin");
}

function nativeReadback(
  revision: ModelRevision,
  identity: ModelIdentity,
  binding: ModelBinding,
  expected: Candidate,
) {
  const occurrence = revision.elements.find((element) =>
    element["@id"] === binding.elementId
  );
  assert(occurrence);
  assert.equal(sourceRefs(occurrence.owner)[0], identity.catalogId);
  assert.equal(occurrence["@type"], "PartUsage");
  const stored = revision.documents.find((document) =>
    document["@id"] === `ElementV0/${binding.elementId}`
  );
  assert.equal(stored?.owner, `ElementV0/${identity.catalogId}`);
  const native = sourceLiterals(revision.elements).filter((value) =>
    value.owner === binding.elementId
  );
  for (
    const [name, value] of [
      ["candidateId", expected.id],
      ["digest", expected.digest],
      ["kind", expected.kind],
    ] as const
  ) {
    const fields = native.filter((literal) => literal.name === name);
    assert.equal(fields.length, 1, `One ${name} literal per scoped candidate`);
    assert.equal(fields[0]!.value, value);
    const storedLiteral = revision.documents.find((document) =>
      document["@id"] === `ElementV0/${fields[0]!.literalId}`
    );
    assert.equal(storedLiteral?.text_value, value);
    sourceOrigin(revision, fields[0]!.attributeId);
    const declaration = revision.elements.find((element) =>
      element["@id"] === fields[0]!.attributeId
    )!;
    const sourceLine = declaration["sysx:sourceLine"];
    assert.equal(typeof sourceLine, "number");
    assert(
      revision.sources["configuration.sysml"]!.split(
        "\n",
      )[Number(sourceLine) - 1]!.includes(
        `attribute ${name} : ScalarValues::String = "${value}";`,
      ),
    );
  }
  assert.equal(native.filter((literal) => literal.name === "status").length, 0);
  const source = revision.sources["configuration.sysml"]!;
  assert(
    source.includes(
      `attribute candidateId : ScalarValues::String = "${expected.id}";`,
    ),
  );
  assert(
    source.includes(
      `attribute digest : ScalarValues::String = "${expected.digest}";`,
    ),
  );
  sourceOrigin(revision, binding.elementId);
  return {
    nativeId: binding.elementId,
    candidateId: expected.id,
    digest: expected.digest,
    status: "active",
  };
}

Deno.test({
  name:
    "concurrent system updates retain both native scopes and scope-valid proposals from an older source base",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    assert.equal(Deno.version.deno, "2.9.7");
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    assert.equal(await compiler.version(), SYSML_TOOLKIT_VERSION);
    const projectId = `git:${crypto.randomUUID()}`;
    const stateDir = await Deno.makeTempDir({
      prefix: "ase-concurrent-system-test-",
    });
    let compilationCalls = 0;
    const gatedCompiler = {
      async compile(sources: Sources) {
        compilationCalls++;
        const compiled = await compiler.compile(sources);
        await validateSourceExecutable({
          ...compiled,
          version: "compile-gate",
        }, projectId);
        return compiled;
      },
      recipe: () => compiler.recipe(),
    };
    try {
      const options = {
        projectDir: stateDir,
        compiler: gatedCompiler,
        sourceAuthorization: new NativeModelSourceAuthorization(
          projectId,
          sourceCompilation,
          sourceEvolutionCompilation,
        ),
      };
      const repository = await GitModelRepository.open(options);
      const peer = await GitModelRepository.open(options);
      assert.notEqual(repository, peer);
      const primary = createSourceModel({
        tooling: new SysmlToolkitAdapter({ packageDir: packageDir! }),
        repository,
        projectId,
        initialSources: twoScopes(
          await loadInitialSources(undefined, { information: false }),
        ),
      });
      const collector = createSourceModel({
        tooling: new SysmlToolkitAdapter({ packageDir: packageDir! }),
        repository: peer,
        projectId,
        systemQualifiedName: "AssemblyLiveBuilder::collector",
      });
      const primaryIdentity = await primary.initialize();
      const collectorIdentity = await collector.initialize();
      const s0 = await repository.current();
      assert.equal(discoverConversationUnits(s0, projectId).length, 2);
      const primaryS0 = await primary.readExecutableModel(primaryIdentity);
      const collectorS0 = await collector.readExecutableModel(
        collectorIdentity,
      );
      assert.notEqual(primaryIdentity.builderId, collectorIdentity.builderId);
      assert.notEqual(primaryIdentity.catalogId, collectorIdentity.catalogId);

      let siblingUpdateCalls = 0;
      const siblingChanged = await peer.updateSystemSources((current) => {
        siblingUpdateCalls++;
        assert.equal(current.version, s0.version);
        return {
          ...current.sources,
          "configuration.sysml": current.sources["configuration.sysml"]!
            .replace(initialInstruction, revisedInstruction),
        };
      }, "operator:competition");
      assert.equal(siblingUpdateCalls, 1);
      assert.notEqual(siblingChanged.version, s0.version);
      const primaryUnchanged = await primary.readExecutableModel(
        primaryIdentity,
      );
      const collectorChanged = await collector.readExecutableModel(
        collectorIdentity,
      );
      assert.equal(primaryUnchanged.version.digest, primaryS0.version.digest);
      assert.deepEqual(
        primaryUnchanged.version.sourceIds,
        primaryS0.version.sourceIds,
      );
      assert.notEqual(
        collectorChanged.version.digest,
        collectorS0.version.digest,
      );
      assert.equal(collectorChanged.operator?.instruction, revisedInstruction);

      const request = {
        baseVersion: s0.version,
        sources: {
          "concurrent-proof.sysml":
            "package ConcurrentProof { private import ScalarValues::*; attribute admittedBase : Integer = 1; }\n",
        },
        reason:
          "Source base remains immutable; this scope's executable contract is unchanged",
      };
      const proposed = await primary.proposeRevision(
        primaryIdentity,
        request,
        primaryS0.version.digest,
      );
      assert.equal(proposed.baseVersion, s0.version);
      assert.equal(proposed.status, "pending");
      const dossier = await repository.proposal(proposed.id);
      assert.equal(dossier.author, `agent:${primaryIdentity.builderId}`);
      assert.equal(dossier.status, "proposed");
      assert.equal(dossier.baseVersion, s0.version);
      const proposalReadback = await repository.at(dossier.proposalVersion!);
      assert.equal(
        proposalReadback.sources["concurrent-proof.sysml"],
        request.sources["concurrent-proof.sysml"],
      );
      assert(
        proposalReadback.sources["configuration.sysml"]!.includes(
          initialInstruction,
        ),
      );
      assert(
        proposalReadback.elements.some((element) =>
          element.qualifiedName === "ConcurrentProof::admittedBase"
        ),
      );
      assert.equal(
        (await repository.current()).version,
        siblingChanged.version,
      );
      await assert.rejects(
        () =>
          collector.proposeRevision(
            collectorIdentity,
            request,
            collectorS0.version.digest,
          ),
        /Execution model changed before source proposal/,
      );
      assert.equal((await repository.listProposals()).length, 1);
      assert.equal(
        (await repository.current()).version,
        siblingChanged.version,
      );

      const candidates = [
        candidate(
          "market-extractor",
          "read_web_page",
          "a".repeat(64),
          primaryUnchanged,
          primaryIdentity,
        ),
        candidate(
          "competition-outline",
          "read_web_page_outline",
          "b".repeat(64),
          collectorChanged,
          collectorIdentity,
        ),
      ] as const;
      const beforeActivations = compilationCalls;
      const [primaryBinding, collectorBinding] = await Promise.all([
        primary.activateCandidate(
          primaryIdentity,
          candidates[0],
          primaryUnchanged.version.digest,
        ),
        collector.activateCandidate(
          collectorIdentity,
          candidates[1],
          collectorChanged.version.digest,
        ),
      ]);
      assert.equal(
        compilationCalls - beforeActivations,
        2,
        "Each concurrent activation compiles once without optimistic replay",
      );
      assert.notEqual(primaryBinding.elementId, collectorBinding.elementId);
      const observed = await repository.current();
      nativeReadback(
        observed,
        primaryIdentity,
        primaryBinding,
        candidates[0],
      );
      nativeReadback(
        observed,
        collectorIdentity,
        collectorBinding,
        candidates[1],
      );
      const primaryNative = nativeReadback(
        observed,
        primaryIdentity,
        primaryBinding,
        candidates[0],
      );
      const collectorNative = nativeReadback(
        observed,
        collectorIdentity,
        collectorBinding,
        candidates[1],
      );
      const currentModels = await Promise.all([
        primary.readExecutableModel(primaryIdentity),
        collector.readExecutableModel(collectorIdentity),
      ]);
      for (const [index, model] of currentModels.entries()) {
        const identity = index === 0 ? primaryIdentity : collectorIdentity;
        const binding = index === 0 ? primaryBinding : collectorBinding;
        const expected = candidates[index]!;
        assert.equal(model.catalog.length, 1);
        const entry = model.catalog[0]!;
        assert.equal(entry.nativeId, binding.elementId);
        assert.equal(entry.candidateId, expected.id);
        assert.equal(entry.digest, expected.digest);
        assert.equal(entry.status, "active");
        const contracts = model.contracts.filter((contract) =>
          contract.nativeId === entry.contractId
        );
        assert.equal(contracts.length, 1);
        assert.equal(contracts[0]!.kind, expected.kind);
        const contract = observed.elements.find((element) =>
          element["@id"] === entry.contractId
        )!;
        assert.equal(sourceRefs(contract.owner)[0], identity.catalogId);
        assert(
          observed.documents.some((document) =>
            document["@id"] === `ElementV0/${entry.contractId}`
          ),
        );
        assert(
          observed.sources["configuration.sysml"]!.includes(
            `bind contract = AssemblyLiveBuilder::${
              index === 0 ? "liveBuilder" : "collector"
            }.catalog.${
              index === 0 ? "readWebPageContract" : "readWebPageOutlineContract"
            };`,
          ),
        );
        const expectedScope = index === 0 ? primaryUnchanged : collectorChanged;
        assert.equal(model.version.digest, expectedScope.version.digest);
        assert.deepEqual(
          model.version.sourceIds,
          expectedScope.version.sourceIds,
        );
        assert.deepEqual(model.flows, expectedScope.flows);
        assert.deepEqual(model.policy, expectedScope.policy);
        assert.equal(model.version.repositoryVersion, observed.version);
      }
      assert.notEqual(
        currentModels[0]!.catalog[0]!.contractId,
        currentModels[1]!.catalog[0]!.contractId,
      );
      assert(
        observed.sources["configuration.sysml"]!.includes(revisedInstruction),
      );

      const beforeRefusals = await repository.current();
      const proposalsBefore = await repository.listProposals();
      let noOpCalls = 0;
      const beforeNoOpCompile = compilationCalls;
      const noOp = await repository.updateSystemSources((current) => {
        noOpCalls++;
        return current.sources;
      }, "operator:market");
      assert.equal(noOpCalls, 1);
      assert.equal(noOp.version, beforeRefusals.version);
      assert.equal(compilationCalls, beforeNoOpCompile);
      assert.deepEqual(
        await primary.activateCandidate(primaryIdentity, {
          ...candidates[0],
          stage: "testing",
        }, primaryUnchanged.version.digest),
        primaryBinding,
      );
      assert.equal(
        (await repository.current()).version,
        beforeRefusals.version,
      );
      await assert.rejects(
        () =>
          primary.activateCandidate(primaryIdentity, {
            ...candidates[0],
            digest: "f".repeat(64),
          }, primaryUnchanged.version.digest),
        /candidate|digest|collision|identity/i,
      );
      let deniedCalls = 0;
      await assert.rejects(() =>
        repository.updateSystemSources(() => {
          deniedCalls++;
          throw new Error("Intentional pure transformation refusal");
        }, "operator:market"), /Intentional pure transformation refusal/);
      assert.equal(deniedCalls, 1);
      assert.equal(compilationCalls, beforeNoOpCompile);
      let invalidCalls = 0;
      await assert.rejects(() =>
        peer.updateSystemSources((current) => {
          invalidCalls++;
          return {
            ...current.sources,
            "invalid.sysml": "package Invalid { part ??? }",
          };
        }, "operator:competition"), /Toolkit validation/);
      assert.equal(invalidCalls, 1);
      assert.equal(compilationCalls, beforeNoOpCompile + 1);
      assert.deepEqual(await repository.current(), beforeRefusals);
      assert.deepEqual(await repository.listProposals(), proposalsBefore);
      const isStale = (error: unknown) =>
        error instanceof ModelRepositoryError &&
        error.code === "STALE_REVISION";
      await assert.rejects(
        () =>
          repository.publishSystemSources(
            s0.sources,
            s0.version,
            "operator:market",
          ),
        isStale,
      );
      await assert.rejects(
        () =>
          repository.accept({
            id: dossier.id,
            expectedVersion: s0.version,
            author: "coordinator",
          }),
        isStale,
      );
      assert.deepEqual(await repository.current(), beforeRefusals);
      assert.deepEqual(await repository.proposal(dossier.id), dossier);
      assert.deepEqual(await repository.at(s0.version), s0);
      const history = await repository.history();
      for (const identity of [primaryIdentity, collectorIdentity]) {
        assert.equal(
          history.commits.filter((commit) =>
            commit.author === `ase:activate-candidate:${identity.builderId}`
          ).length,
          1,
        );
      }
      assert.equal(
        history.commits.filter((commit) =>
          commit.author === "operator:competition"
        ).length,
        1,
      );
      assert.equal(history.headVersion, observed.version);
      console.log(JSON.stringify({
        qualification: "real repository integration; no LLM or live server",
        toolchain: {
          deno: Deno.version.deno,
          toolkit: SYSML_TOOLKIT_VERSION,
          repository: "Git",
        },
        baseVersion: s0.version,
        finalVersion: observed.version,
        sourceDigest: observed.sourceDigest,
        scopes: [primaryNative, collectorNative],
        proposalFromOldBase: {
          id: dossier.id,
          baseVersion: dossier.baseVersion,
          sourceDigest: dossier.sourceDigest,
        },
        sameScopeStaleDigestRefused: true,
        mutationRefusalPreservesHead: true,
        compilerRefusalPreservesHead: true,
        provenanceAuthors: history.commits.map(({ author }) => author),
        compilationCalls,
      }));
    } catch (error) {
      // Keep the assertion or model failure visible if database cleanup also fails.
      console.error(
        "Concurrent system qualification failed before cleanup:",
        error,
      );
      throw error;
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
});
