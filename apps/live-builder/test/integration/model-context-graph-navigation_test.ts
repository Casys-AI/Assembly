import { readAssemblyEnv } from "../../src/infrastructure/environment.ts";
/** GH-13: real source/build/index composition and agent decision transport.
 * Only the provider response is scripted; no user project or API key is used. */
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import type { openModelBackend } from "../../src/composition/model-backend.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import { createModelProject } from "../../src/adapters/out/filesystem/model-project.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { openNativeSemanticIndex } from "../../src/adapters/out/oxigraph/runtime.ts";
import { SemanticProjectionProcessClient } from "../../src/adapters/out/oxigraph/process-client.ts";
import {
  createModelSemanticBackend,
  semanticNeighborEvidence,
} from "../../src/adapters/out/oxigraph/backend.ts";
import { SemanticModelContextReader } from "../../src/application/model/consultation/semantic-reader.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import { ClaudeAgents } from "../../src/adapters/out/llm-providers/agents.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { buildAcceptProposalCommand } from "../../src/application/model/publication/write-queue.ts";
import { BoundModelReader } from "../../src/adapters/out/oxigraph/ldkit-reader.ts";
import { DeterministicRdfModelProjector } from "../../src/adapters/out/oxigraph/rdf.ts";
import { ModelSemanticIndexService } from "../../src/application/model/semantic/index-service.ts";
import type { BuildRef } from "../../src/domain/model/value-objects/element-ref.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";
import type {
  ModelContextQueryResult,
  ModelGraphQueryResult,
  ModelSemanticEvidence,
} from "../../src/domain/model/consultation/context.ts";

const bytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
const ready = (result: ModelContextQueryResult) => {
  assert.equal(result.semantic?.state, "ready");
  return result.semantic as Extract<ModelSemanticEvidence, { state: "ready" }>;
};

Deno.test({
  name:
    "GH-13 native agent follows two graph hops, joins/aggregates, and reads the original source through durable publication",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    assert.equal(
      readAssemblyEnv("ASSEMBLY_MODEL_PROJECT_DIR"),
      undefined,
      "No user project environment may be selected",
    );
    const directory = await Deno.makeTempDir({ prefix: "ase-gh13-" });
    let backend: Awaited<ReturnType<typeof openModelBackend>> | undefined;
    let native: Awaited<ReturnType<typeof openNativeSemanticIndex>> | undefined;
    let projectionPreparer: SemanticProjectionProcessClient | undefined;
    let semantic: ReturnType<typeof createModelSemanticBackend> | undefined;
    let postgres:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
      | undefined;
    let workspace:
      | Awaited<ReturnType<typeof openOperatorWorkspace>>
      | undefined;
    try {
      const preparationStart = performance.now();
      const sources = await loadInitialSources();
      sources["navigation.sysml"] =
        "package GH13Navigation { package Branch { part leaf; } part spare1; part spare2; part spare3; }\n";
      await createModelProject({
        root: directory,
        name: "model-project",
        sources,
      });
      postgres = await openPostgresRuntimeFixture({ dataDir: directory });
      backend = postgres.backend;
      const identity = await backend.model.initialize();
      const admitted = await backend.model.readExecutableModel(identity);
      const original = await backend.repository.current();
      const sourcePin = original.version;
      const owner = exerciseOwnerAuthority(admitted, "model-revision");
      const marker = "GH13_NEW_HEAD_ONLY";
      const proposal = await backend.repository.propose({
        baseVersion: sourcePin,
        sources: {
          ...sources,
          "navigation.sysml": sources["navigation.sysml"] + `// ${marker}\n`,
        },
        author: "local-owner",
        reason: "Isolated GH-13 concurrent publication fixture",
        authorization: { kind: "local-owner", authorityExercise: owner },
      });
      const dossier = await buildAcceptProposalCommand({
        repositoryId: backend.project.id,
        proposal,
        expectedVersion: sourcePin,
        author: "local-owner",
        baseSourceDigest: original.sourceDigest,
        recipeDigest: await backend.writer.recipeDigest(),
        decisionAuthorityExercise: owner,
      });
      projectionPreparer = new SemanticProjectionProcessClient(
        backend.buildStorage,
      );
      native = await openNativeSemanticIndex({
        buildCachePath: backend.buildStorage.cachePath,
      });
      const nativeQueryTimings: unknown[] = [];
      let projectionVolume:
        | { quads: number; referenceBytes: number }
        | undefined;
      semantic = createModelSemanticBackend({
        repositoryId: backend.project.id,
        repository: backend.repository,
        buildService: backend.buildService,
        cache: backend.store,
        projectionPreparer,
        native: {
          load() {
            throw new Error(
              "Production graph preparation must never load parent RDF bytes",
            );
          },
          async loadReference(input) {
            assert.equal(Object.hasOwn(input, "quads"), false);
            const referenceBytes = bytes(input);
            assert(referenceBytes < 2048);
            const result = await native!.native.loadReference!(input);
            projectionVolume = {
              quads: result.quadCount,
              referenceBytes,
            };
            return result;
          },
          release: (build) => native!.native.release(build),
          isLoaded: (build) => native!.native.isLoaded(build),
          async query(input) {
            assert(
              input.limits.timeoutMs <= 5000,
              "Native query budgets must remain at most 5 seconds",
            );
            const start = performance.now();
            try {
              return await native!.native.query(input);
            } catch (error) {
              console.error("GH13 query failed", input.sparql);
              throw error;
            } finally {
              nativeQueryTimings.push({
                queryCharacters: input.sparql.length,
                queryBytes: new TextEncoder().encode(input.sparql).length,
                milliseconds: performance.now() - start,
              });
            }
          },
        },
      });
      const reader = new SemanticModelContextReader(
        new ModelContextReader(backend.repository),
        semantic,
      );
      const indexStart = performance.now();
      const graphPin = await semantic.readGraph(
        sourcePin,
        original.sourceDigest,
        ({ build, projection }) => ({ build, projection }),
      );
      const indexPreparationMs = performance.now() - indexStart;
      assert(graphPin.projection);
      const preparationMs = performance.now() - preparationStart;
      const pinnedBackend = backend;
      let held: Awaited<ReturnType<typeof backend.queue.acquire>>;
      let rootCursor = "";
      let rootId = "", branchId = "", endpointPath = "", advanced = "";
      let step = 0;
      let failure: unknown;
      const captures: Array<
        {
          requestBytes: number;
          requestCharacters: number;
          contextBytes: number;
          contextCharacters: number;
        }
      > = [];
      const observations: unknown[] = [];
      const toolMs: Array<
        { operation: string; milliseconds: number; resultBytes: number }
      > = [];
      const information: { current?: DecisionInformationPort } = {};
      const consult = (
        context: ChatContext,
        input: Record<string, unknown>,
      ): ChatDecision => ({
        kind: "consult_model",
        text: `Qualification ${input.operation}`,
        inputJson: JSON.stringify({
          version: context.modelContext!.version,
          ...input,
        }),
      });
      const fake = createClaudeToolsFake(async (view) => {
        try {
          const context = view.context as unknown as ChatContext;
          captures.push({
            requestBytes: bytes(view.body),
            requestCharacters: JSON.stringify(view.body).length,
            contextBytes: bytes(context),
            contextCharacters: JSON.stringify(context).length,
          });
          assert.equal(context.modelTools?.length, 6);
          assert.equal(context.modelContext?.version, sourcePin);
          const observation = context.messages.at(-1)?.observation?.value as {
            result?: unknown;
          } | undefined;
          if (observation) {
            observations.push(observation);
            assert(observation.result, JSON.stringify(observation));
          }
          switch (step++) {
            case 0:
              return {
                decision: consult(context, {
                  operation: "search",
                  query: "GH13Navigation",
                  limit: 20,
                }),
              };
            case 1: {
              const search = observation!.result as Extract<
                ModelContextQueryResult,
                { operation: "search" }
              >;
              rootId = search.items.find((e) =>
                e.qualifiedName === "GH13Navigation"
              )!.id;
              return {
                decision: consult(context, {
                  operation: "inspect",
                  elementId: rootId,
                  limit: 1,
                  graph: { property: "ownedMember", limit: 1 },
                }),
              };
            }
            case 2: {
              const first = ready(
                observation!.result as ModelContextQueryResult,
              );
              assert.deepEqual(first.build, graphPin.build);
              assert.deepEqual(first.projection, graphPin.projection);
              assert.equal(first.neighborPage.complete, false);
              rootCursor = first.neighborPage.nextCursor!;
              assert(rootCursor);
              const branch = first.neighbors[0]!;
              assert(branch.source);
              branchId = branch.ref!.nativeId;
              await pinnedBackend.queue.enqueue(dossier);
              held = await pinnedBackend.queue.acquire(
                pinnedBackend.project.id,
                "gh13-controlled-pending",
                300_000,
              );
              assert(
                held,
                "The deterministic fixture holds the queued write until both hops complete",
              );
              return {
                decision: consult(context, {
                  operation: "inspect",
                  elementId: branchId,
                  graph: { property: "ownedMember", limit: 1 },
                }),
              };
            }
            case 3: {
              const second = ready(
                observation!.result as ModelContextQueryResult,
              );
              assert.deepEqual(second.build, graphPin.build);
              assert.deepEqual(second.projection, graphPin.projection);
              assert.equal(second.neighbors[0]?.source?.version, sourcePin);
              endpointPath = second.neighbors[0]!.source!.path;
              assert.equal(
                (await pinnedBackend.repository.current()).version,
                sourcePin,
              );
              assert.equal(
                (await pinnedBackend.queue.get(
                  pinnedBackend.project.id,
                  proposal.id,
                ))?.state,
                "preparing",
              );
              await pinnedBackend.queue.settle(held!.lease, {
                status: "retryable",
                error: {
                  code: "GH13_RELEASE",
                  message: "Continue the isolated publication",
                },
              });
              await pinnedBackend.writer.pump();
              const published = await pinnedBackend.queue.get(
                pinnedBackend.project.id,
                proposal.id,
              );
              assert.equal(published?.state, "published");
              advanced = published!.publishedVersion!;
              assert.notEqual(advanced, sourcePin);
              const anchored = await pinnedBackend.repository
                .findPublicationByCommand!(proposal.id);
              assert.equal(anchored?.revision.version, advanced);
              return {
                decision: consult(context, {
                  operation: "query",
                  mode: "sparql",
                  expression:
                    'PREFIX ase:<urn:ase:vocab:> PREFIX prop:<urn:ase:vocab:prop:> SELECT ?name ?childName WHERE { ?parent ase:qualifiedName "GH13Navigation"; prop:ownedMember ?child . ?child ase:name ?name; prop:ownedMember ?leaf . ?leaf ase:name ?childName . FILTER(?childName = "leaf") }',
                }),
              };
            }
            case 4: {
              const joined = observation!.result as ModelGraphQueryResult;
              assert.equal(joined.result.form, "solutions");
              assert(
                joined.result.form === "solutions" &&
                  joined.result.rows.length === 1,
              );
              assert.deepEqual(joined.build, graphPin.build);
              assert.deepEqual(joined.projection, graphPin.projection);
              assert.equal(joined.version, sourcePin);
              return {
                decision: consult(context, {
                  operation: "query",
                  mode: "sparql",
                  expression:
                    'PREFIX ase:<urn:ase:vocab:> SELECT (COUNT(?e) AS ?count) WHERE { ?e ase:metaclass "Package"; ase:qualifiedName ?name . FILTER(STRSTARTS(?name, "GH13Navigation")) }',
                }),
              };
            }
            case 5: {
              const aggregate = observation!.result as ModelGraphQueryResult;
              assert(aggregate.result.form === "solutions");
              assert.equal(
                (aggregate.result.rows[0]!.count as { value: string }).value,
                "2",
              );
              assert.deepEqual(aggregate.build, graphPin.build);
              return {
                decision: consult(context, {
                  operation: "read_source",
                  path: endpointPath,
                }),
              };
            }
            case 6:
              assert.equal(
                context.modelSources!.sources[endpointPath],
                sources[endpointPath],
              );
              assert(
                !context.modelSources!.sources[endpointPath]!.includes(marker),
              );
              return {
                decision: {
                  kind: "reply",
                  text: "Two hops and source are pinned to the initial build.",
                },
              };
            default:
              throw new Error("Unexpected provider call");
          }
        } catch (error) {
          failure = error;
          throw error;
        }
      });
      const store = postgres.primary.state;
      const agents = new ClaudeAgents({
        apiKey: "transport-double-only",
        model: "scripted-provider",
        fetch: fake.fetch,
      });
      const executors: BehaviorInvocationPort[] = [];
      const runtime = new SystemRuntime({
        ...postgres.runtimePorts,
        model: backend.model,
        store,
        agents,
        runner: new DenoToolRunner(),
        behaviors: new BehaviorInvocationRegistry(executors),
        information: {
          read: (model, messages) => information.current!.read(model, messages),
          async consultAdmittedModelSource(model, input, messages, budget) {
            const start = performance.now();
            const result = await information.current!
              .consultAdmittedModelSource!(
                model,
                input,
                messages,
                budget,
              );
            toolMs.push({
              operation: String(input.operation),
              milliseconds: performance.now() - start,
              resultBytes: bytes(result),
            });
            return result;
          },
          async consultModel(model, input, messages) {
            const start = performance.now();
            const result = await information.current!.consultModel!(
              model,
              input,
              messages,
            );
            toolMs.push({
              operation: String(input.operation),
              milliseconds: performance.now() - start,
              resultBytes: bytes(result),
            });
            return result;
          },
        },
      });
      await runtime.initialize(undefined, {
        resumeContinuations: false,
        resumeCandidateContinuations: false,
      });
      workspace = await openOperatorWorkspace({
        ...postgres.workspacePorts,
        primaryHistory: store,
        primary: runtime,
        primaryModel: backend.model,
        repository: backend.repository,
        tooling: backend.tooling,
        createSourceModel: backend.createSourceModel,
        agents,
        directory,
        executors,
        modelContextReader: reader,
      });
      information.current = workspace.information;
      await postgres.start(workspace);
      const turnStart = performance.now();
      await runtime.submit(
        "Follow two graph hops from GH13Navigation, run a join and aggregate, then read the exact source while an independent publication advances HEAD.",
      );
      await postgres.idle(runtime);
      if (failure) throw failure;
      assert.equal(runtime.snapshot.error, undefined);
      assert.equal(step, 7);
      assert.equal(
        runtime.snapshot.events.filter((e) => e.kind === "model-tool-completed")
          .length,
        6,
      );
      assert.equal((await backend.repository.current()).version, advanced);
      assert.equal(
        runtime.snapshot.executionModel!.version.digest,
        admitted.version.digest,
      );
      const turnMs = performance.now() - turnStart;
      const continuation = ready(
        await reader.query({
          operation: "inspect",
          version: sourcePin,
          elementId: rootId,
          limit: 1,
          graph: { property: "ownedMember", limit: 2, cursor: rootCursor },
        }),
      );
      assert.equal(continuation.neighbors.length, 2);
      assert.equal(continuation.neighborPage.complete, false);
      const last = ready(
        await reader.query({
          operation: "inspect",
          version: sourcePin,
          elementId: rootId,
          graph: {
            property: "ownedMember",
            limit: 1,
            cursor: continuation.neighborPage.nextCursor,
          },
        }),
      );
      assert.equal(last.neighbors.length, 1);
      assert.equal(last.neighborPage.complete, true);
      assert.equal(last.neighborPage.nextCursor, undefined);
      assert.equal(
        new Set([
          branchId,
          ...continuation.neighbors.map((n) => n.ref!.nativeId),
          last.neighbors[0]!.ref!.nativeId,
        ]).size,
        4,
      );
      const incoming = await semantic.inspect(
        sourcePin,
        original.sourceDigest,
        branchId,
        "references",
        { property: "ownedMember", limit: 1 },
      );
      assert(incoming.state === "ready");
      assert.equal(incoming.neighbors[0]?.direction, "in");
      assert.equal(incoming.neighbors[0]?.ref?.nativeId, rootId);
      const generic = ready(
        await reader.query({
          operation: "inspect",
          version: sourcePin,
          elementId: branchId,
        }),
      );
      assert.equal(generic.neighborPage.limit, 20);
      assert(generic.neighbors.some((n) => n.ref?.nativeId === rootId));
      // Exercise the production system root, not only the sparse added package.
      // This reproduces Main's unfiltered page-20 cursor resumed with graph=2
      // and canonical=1 on the full current model corpus.
      const denseSystem = original.elements.find((e) =>
        e.qualifiedName === "AssemblyLiveBuilder::liveBuilder" &&
        e["@type"] === "PartUsage"
      );
      assert(denseSystem && typeof denseSystem["@id"] === "string");
      const denseId = denseSystem["@id"];
      const denseFirstResult = await reader.query({
        operation: "inspect",
        version: sourcePin,
        elementId: denseId,
        limit: 1,
      });
      assert(denseFirstResult.operation === "inspect");
      assert.equal(denseFirstResult.limit, 1);
      const denseFirst = ready(denseFirstResult);
      assert.equal(denseFirst.neighbors.length, 20);
      assert(denseFirst.neighborPage.nextCursor);
      const denseNextResult = await reader.query({
        operation: "inspect",
        version: sourcePin,
        elementId: denseId,
        limit: 1,
        graph: {
          direction: "out",
          limit: 2,
          cursor: denseFirst.neighborPage.nextCursor,
        },
      });
      assert(denseNextResult.operation === "inspect");
      assert.equal(denseNextResult.limit, 1);
      const denseNext = ready(denseNextResult);
      assert.equal(denseNext.neighbors.length, 2);
      const denseCombined = ready(
        await reader.query({
          operation: "inspect",
          version: sourcePin,
          elementId: denseId,
          limit: 1,
          graph: { limit: 22 },
        }),
      );
      const edgeIdentity = (
        n: typeof denseFirst.neighbors[number],
      ) => [n.direction, n.predicate, n.iri, n.position, n.occurrence];
      assert.deepEqual(
        [...denseFirst.neighbors, ...denseNext.neighbors].map(edgeIdentity),
        denseCombined.neighbors.map(edgeIdentity),
      );
      const denseReferencesResult = await reader.query({
        operation: "references",
        version: sourcePin,
        elementId: denseId,
        limit: 1,
      });
      assert(denseReferencesResult.operation === "references");
      assert.equal(denseReferencesResult.limit, 1);
      const denseReferences = ready(denseReferencesResult);
      assert.equal(denseReferences.neighborPage.limit, 20);
      assert(denseReferences.neighbors.length > 0);
      assert(denseReferences.neighbors.every((n) => n.direction === "in"));
      for (
        const page of [denseFirst, denseNext, denseCombined, denseReferences]
      ) {
        assert.equal(page.version, sourcePin);
        assert.deepEqual(page.build, graphPin.build);
        assert.deepEqual(page.projection, graphPin.projection);
      }
      console.log(
        JSON.stringify({
          qualification: "gh13-native-agent",
          denseSystem: {
            nativeId: denseId,
            qualifiedName: denseSystem.qualifiedName,
            firstInspectNeighbors: denseFirst.neighbors.length,
            resumedInspectNeighbors: denseNext.neighbors.length,
            resumedOffset: 20,
            incomingNeighbors: denseReferences.neighbors.length,
            maxNativeQueryMs: 5000,
          },
          runtime: {
            deno: Deno.version.deno,
            os: Deno.build.os,
            arch: Deno.build.arch,
            semantic: native.provenance,
            recipe: await backend.compiler.recipe(),
          },
          version: sourcePin,
          build: graphPin.build,
          projection: graphPin.projection,
          publishedVersion: advanced,
          sourceVolume: {
            files: Object.keys(sources).length,
            characters: Object.values(sources).reduce(
              (n, s) => n + s.length,
              0,
            ),
            bytes: Object.values(sources).reduce(
              (n, s) => n + new TextEncoder().encode(s).length,
              0,
            ),
            elements: original.elements.length,
          },
          captures,
          graphRows: observations.map((o) =>
            (o as { result?: ModelContextQueryResult }).result?.semantic
                ?.state === "ready"
              ? ((o as { result: ModelContextQueryResult }).result
                .semantic as Extract<ModelSemanticEvidence, { state: "ready" }>)
                .neighbors.length
              : 0
          ),
          projectionVolume,
          loadedSourceVolume: {
            files: 1,
            characters: sources[endpointPath]!.length,
            bytes: new TextEncoder().encode(sources[endpointPath]!).length,
          },
          nativeQueryTimings,
          preparationMs,
          indexPreparationMs,
          toolMs,
          turnMs,
        }),
      );
    } finally {
      await postgres?.stopWorkspace();
      await projectionPreparer?.close();
      await semantic?.close();
      await native?.close();
      await postgres?.close();
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "GH-13 native occurrence pages have exact coverage, full final pages, bounded SELECT/ASK and native truncation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const native = await openNativeSemanticIndex();
    const build: BuildRef = {
      repositoryId: "gh13-occurrences",
      sourceDigest: "1".repeat(64),
      recipeDigest: "2".repeat(64),
      buildKey: "3".repeat(64),
      artifactDigest: "4".repeat(64),
    };
    const index = new ModelSemanticIndexService({
      native: native.native,
      projector: new DeterministicRdfModelProjector(),
      source: {
        verifiedElements: () =>
          Promise.resolve({
            libraryNativeIds: [],
            elements: [
              {
                "@id": "root",
                "@type": "Package",
                ownedMember: [{ "@id": "a" }, { "@id": "b" }, { "@id": "a" }, {
                  "@id": "b",
                }],
              },
              { "@id": "a", "@type": "PartUsage", name: "a" },
              { "@id": "b", "@type": "PartUsage", name: "b" },
              { "@id": "tie-target", "@type": "PartUsage" },
              {
                "@id": "tie-left",
                "@type": "Package",
                alpha: [{ "@id": "tie-target" }],
                beta: { "@id": "tie-target" },
              },
              {
                "@id": "tie-right",
                "@type": "Package",
                alpha: [{ "@id": "tie-target" }],
              },
              // Two canonical occurrence lists for the same element/property
              // exercise the final occurrence tie-breaker, not just IRI order.
              {
                "@id": "tie-carrier",
                "@type": "Package",
                alias: { "@id": "tie-left", alpha: [{ "@id": "tie-target" }] },
              },
            ],
          }),
      },
    });
    try {
      const status = await index.ensureProjection(build);
      assert(status.projection);
      const pin = {
        version: `commit:${"a".repeat(40)}`,
        projection: status.projection,
      };
      const reader = new BoundModelReader(index, build);
      for (const property of [undefined, "ownedMember"]) {
        const first = await reader.neighborsPage({ build, nativeId: "root" }, {
          limit: 2,
          property,
        });
        const last = await reader.neighborsPage({ build, nativeId: "root" }, {
          limit: 2,
          offset: first.nextOffset,
          property,
        });
        assert.equal(first.complete, false);
        assert.equal(first.nextOffset, 2);
        assert.equal(last.complete, true);
        assert.equal(last.nextOffset, undefined);
        const all = [...first.items, ...last.items];
        assert.deepEqual(all.map((n) => n.other!.ref.nativeId), [
          "a",
          "b",
          "a",
          "b",
        ]);
        assert.equal(new Set(all.map((n) => n.occurrence)).size, 4);
      }
      const incoming = await reader.referencesToPage({ build, nativeId: "a" }, {
        property: "ownedMember",
        limit: 2,
      });
      assert.equal(incoming.items.length, 2);
      assert.equal(incoming.complete, true);
      assert.deepEqual(incoming.items.map((n) => n.position), [0, 2]);
      const byteBoundReader = new BoundModelReader(index, build, {
        maxBytes: 900,
      });
      const boundedPositions: number[] = [];
      let cursor: string | undefined;
      let sawNativeTruncation = false;
      let pageCount = 0;
      do {
        const page = await semanticNeighborEvidence(
          byteBoundReader,
          { build, nativeId: "root" },
          "inspect",
          "user",
          { property: "ownedMember", limit: 3, cursor },
          pin,
        );
        sawNativeTruncation ||= page.neighborPage.nativeTruncated === true;
        boundedPositions.push(...page.neighbors.map((n) => n.position!));
        cursor = page.neighborPage.nextCursor;
        assert(
          ++pageCount <= 4,
          "Native byte truncation must advance without omissions or empty loops",
        );
      } while (cursor);
      assert(sawNativeTruncation);
      assert.deepEqual(boundedPositions, [0, 1, 2, 3]);
      const empty = await semanticNeighborEvidence(
        new BoundModelReader(index, build, { maxBytes: 256 }),
        { build, nativeId: "root" },
        "inspect",
        "user",
        { property: "ownedMember" },
        pin,
      );
      assert.deepEqual(empty.neighbors, []);
      assert.deepEqual(empty.neighborPage, {
        limit: 20,
        complete: false,
        nativeTruncated: true,
      });

      const defaultIncoming = async (limit: number) => {
        const found: Extract<
          ModelSemanticEvidence,
          { state: "ready" }
        >["neighbors"][number][] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await semanticNeighborEvidence(
            reader,
            { build, nativeId: "tie-target" },
            "references",
            "user",
            { limit, cursor },
            pin,
          );
          found.push(...page.neighbors);
          cursor = page.neighborPage.nextCursor;
          assert(++pages <= 4);
          if (!cursor) assert.equal(page.neighborPage.complete, true);
        } while (cursor);
        return found;
      };
      const tied = await defaultIncoming(2);
      assert.deepEqual(
        tied.map((n) => [n.direction, n.property, n.ref!.nativeId, n.position]),
        [
          ["in", "alpha", "tie-left", 0],
          ["in", "alpha", "tie-left", 0],
          ["in", "alpha", "tie-right", 0],
          ["in", "beta", "tie-left", undefined],
        ],
      );
      assert.notEqual(tied[0]!.occurrence, tied[1]!.occurrence);
      assert.deepEqual(await defaultIncoming(3), tied);

      const truncated = await index.queryReadOnly({
        build,
        sparql: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
        limits: { maxResults: 2 },
      });
      assert(truncated.form === "solutions" && truncated.truncated);
      const byteTruncated = await index.queryReadOnly({
        build,
        sparql: "SELECT ?s ?p ?o WHERE { ?s ?p ?o }",
        limits: { maxBytes: 128 },
      });
      assert(byteTruncated.form === "solutions" && byteTruncated.truncated);
      assert.deepEqual(await reader.query("ASK { ?s ?p ?o }"), {
        form: "boolean",
        value: true,
      });
      for (
        const forbidden of [
          "DELETE WHERE { ?s ?p ?o }",
          "SELECT * WHERE { SERVICE <https://example.invalid> {?s ?p ?o} }",
          "SELECT * FROM <urn:foreign> WHERE {?s ?p ?o}",
        ]
      ) {
        await assert.rejects(() => reader.query(forbidden));
      }
      const explosive = "SELECT (COUNT(*) AS ?count) WHERE { " +
        Array.from({ length: 9 }, (_, i) => `?s${i} ?p${i} ?o${i} .`).join(
          " ",
        ) + " }";
      await assert.rejects(
        () =>
          index.queryReadOnly({
            build,
            sparql: explosive,
            limits: { timeoutMs: 25 },
          }),
        (error: unknown) =>
          (error as { code: string }).code === "INDEX_TIMEOUT",
      );
      await index.ensureProjection(build);
      assert.deepEqual(await reader.query("ASK { ?s ?p ?o }"), {
        form: "boolean",
        value: true,
      });
    } finally {
      await index.release(build);
      await native.close();
    }
  },
});
