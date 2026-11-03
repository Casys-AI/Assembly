import { latestModelObservation } from "../support/model-observation.ts";
import { SYSML_TOOLKIT_VERSION } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { NativeModelSourceAuthorization } from "../../src/adapters/governance/model-access/source-authorization.ts";
import { editPolicy } from "../fixtures/model-edit-mandate.ts";
import type { ModelRevision } from "../../src/domain/model/records/revision.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
/** Local Git, real Toolkit admission and real toolkit editing. The agent
 * transport alone is a double. HTTP handlers run in process without a server. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { inspectModelProject } from "../../src/adapters/out/git/project-inspection.ts";
import {
  createModelProject,
  readModelProject,
  readProjectSources,
} from "../../src/adapters/out/filesystem/model-project.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import {
  SourceModel,
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import { queryModelRevision } from "../../src/adapters/model/sources/editing/tooling.ts";
import { ModelContextReader } from "../../src/application/model/consultation/source-reader.ts";
import { createModelRevisionHandler } from "../../src/adapters/in/http/model/revisions.ts";
import {
  ModelRepositoryError,
} from "../../src/application/model/repository.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import type { BehaviorInvocationPort } from "../../src/application/work/behaviors/invocation.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import type { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const path = "git-evidence.sysml";
const market = "GitEvidence::marketRevision";
const observed = "GitEvidence::marketObserved";
const competition = "GitEvidence::competitionRevision";
const fixture = `package GitEvidence {
    private import ScalarValues::*;
    doc /* Local evidence 台灣: keep every unrelated byte. */
    attribute marketRevision : Integer = 1;

    // Separate lines keep independent edits apart in the same file.
    part def SeparatorA;
    part def SeparatorB;
    part def SeparatorC;
    part def SeparatorD;

    attribute competitionRevision : Integer = 2;
}
`;

function twoScopes(sources: Sources): Sources {
  // Keep information:false: this fixture needs the ordinary native context
  // policy alone, without evidence access, skills, memory or an index bootstrap.
  const contextPolicy = `
part context {
    part policy : APEContext::DecisionContextPolicy {
        attribute :>> id = "decision-context-v1";
        attribute :>> revision = 1;
        attribute :>> recentMessages = 8;
        attribute :>> maxMessageCharacters = 2000;
        attribute :>> maxCollectionItems = 12;
        attribute :>> maxContextCharacters = 250000;
    }
}
`;
  const policy = editPolicy("GitEvidence").replaceAll("mission.sysml", path) +
    contextPolicy;
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
  const peer = source.slice(start, end).replace(
    "part liveBuilder : ConversationSystem {",
    `part collector : ConversationSystem {${policy}
        attribute operatorName : String = "Local collector";
        attribute operatorInstruction : String = "Propose an independent local evidence revision.";
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
    "configuration.sysml": (source.slice(0, close) + "\n    " + peer + "\n" +
      source.slice(close)).replace(
        "part liveBuilder : ConversationSystem {",
        "part liveBuilder : ConversationSystem {" + policy,
      ),
    [path]: fixture,
  };
}

function nativeId(revision: ModelRevision, qualifiedName: string): string {
  const declarations = revision.elements.filter((element) =>
    element.qualifiedName === qualifiedName &&
    element["@type"] === "AttributeUsage"
  );
  assert.equal(declarations.length, 1, qualifiedName);
  assert.equal(typeof declarations[0]!["@id"], "string");
  return String(declarations[0]!["@id"]);
}

function nativeInteger(
  revision: ModelRevision,
  qualifiedName: string,
  expected: number,
) {
  const id = nativeId(revision, qualifiedName);
  const values = revision.elements.filter((element) =>
    element["@type"] === "FeatureValue" &&
    (element.featureWithValue as { "@id"?: string })?.["@id"] === id
  );
  assert.equal(values.length, 1);
  const literalId = (values[0]!.value as { "@id": string })["@id"];
  assert.equal(
    revision.elements.find((element) => element["@id"] === literalId)?.value,
    expected,
  );
  assert.equal(
    revision.documents.find((document) =>
      document["@id"] === `ElementV0/${literalId}`
    )?.integer_value,
    expected,
  );
}

async function git(projectDir: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args: ["--git-dir", join(projectDir, ".git"), ...args],
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
    },
  }).output();
  assert(result.success, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test({
  name:
    "local Git project: real toolkit decisions, pinned context, source merge, HTTP revisions and unchanged drafts/restart pins",
  ignore: !toolkitIntegrationEnabled ||
    !postgresTestEnabled,
  async fn() {
    assert.equal(Deno.version.deno, "2.9.7");
    const root = await Deno.makeTempDir({ prefix: "ase-git-workspace-proof-" });
    let failure: unknown, failed = false;
    const cleanupErrors: unknown[] = [];
    let closeRuntime: (() => Promise<void>) | undefined;
    let postgres:
      | Awaited<ReturnType<typeof openPostgresRuntimeFixture>>
      | undefined;
    try {
      const sources = twoScopes(
        await loadInitialSources(undefined, { information: false }),
      );
      const created = await createModelProject({
        root,
        name: "local-git-proof",
        sources,
      });
      const project = await readModelProject(created.directory);
      assert.equal(project.id, created.project.id);
      assert.deepEqual(await readProjectSources(project.sourcesPath), sources);
      assert.equal(
        (await inspectModelProject(project.projectDir)).admitted,
        null,
      );
      const projectId = `git:${project.id}`;
      const sourceCompiler = new ToolkitCompiler({ packageDir: packageDir! });
      assert.equal(await sourceCompiler.version(), SYSML_TOOLKIT_VERSION);
      let compilationCalls = 0;
      const compiler = {
        async compile(input: Sources) {
          const compiled = await sourceCompiler.compile(input);
          await validateSourceExecutable({
            ...compiled,
            version: "compile-gate",
          }, projectId);
          compilationCalls++;
          return compiled;
        },
        recipe: () => sourceCompiler.recipe(),
      };
      let repository = await GitModelRepository.open({
        projectDir: project.projectDir,
        compiler,
        sourceAuthorization: new NativeModelSourceAuthorization(projectId),
      });
      assert.equal(repository.projectId, projectId);
      const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
      let primaryModel = new SourceModel({
        repository,
        projectId,
        initialSources: sources,
        tooling,
      });
      const peerModel = new SourceModel({
        repository: await GitModelRepository.open({
          projectDir: project.projectDir,
          compiler,
          sourceAuthorization: new NativeModelSourceAuthorization(projectId),
        }),
        projectId,
        systemQualifiedName: "AssemblyLiveBuilder::collector",
        tooling,
      });
      const identity = await primaryModel.initialize();
      const peerIdentity = await peerModel.initialize();
      assert.notEqual(identity.builderId, peerIdentity.builderId);
      for (
        const selected of await Promise.all([
          primaryModel.readExecutableModel(identity),
          peerModel.readExecutableModel(peerIdentity),
        ])
      ) {
        const policy = selected.contextPolicy;
        assert(policy);
        assert.deepEqual({
          kind: policy.kind,
          pattern: policy.pattern,
          id: policy.id,
          revision: policy.revision,
          recentMessages: policy.recentMessages,
          maxMessageCharacters: policy.maxMessageCharacters,
          maxCollectionItems: policy.maxCollectionItems,
          maxContextCharacters: policy.maxContextCharacters,
        }, {
          kind: "separated-context",
          pattern: "5.1",
          id: "decision-context-v1",
          revision: 1,
          recentMessages: 8,
          maxMessageCharacters: 2000,
          maxCollectionItems: 12,
          maxContextCharacters: 250000,
        });
        assert.equal(selected.memoryPolicy, undefined);
        assert.equal(selected.skillPolicy, undefined);
        assert.deepEqual(selected.initialSkills ?? [], []);
      }
      const base = await repository.current();
      assert.match(base.version, /^commit:[a-f0-9]{40}$/);
      assert.deepEqual(base.sources, sources);
      assert.equal(
        await git(project.projectDir, "rev-parse", "refs/heads/admitted"),
        base.version.slice(7),
      );
      assert.equal(
        await git(project.projectDir, "remote"),
        "",
        "The local model project has no remote",
      );
      const inspection = await inspectModelProject(project.projectDir);
      assert.equal(inspection.admitted?.version, base.version);
      assert.notEqual(
        inspection.admitted?.snapshotPathCandidate,
        project.sourcesPath,
      );
      const exportedSources = await repository.exportSources(base.version);
      assert.equal(exportedSources, inspection.admitted!.snapshotPathCandidate);
      assert.deepEqual(
        await readProjectSources(exportedSources),
        sources,
      );

      // Deliberately invalid local draft bytes must survive every source action.
      const draft =
        "// Uncommitted local draft — 台灣\nthis is not admitted SysML\n";
      await Deno.writeTextFile(join(project.sourcesPath, path), draft);
      const peerDigest =
        (await peerModel.readExecutableModel(peerIdentity)).version.digest;
      const peerProposal = await peerModel.proposeEdit(peerIdentity, {
        baseVersion: base.version,
        sourceDigest: base.sourceDigest,
        reason: "Collector independently updates the second attribute",
        edits: [{
          kind: "set-value",
          elementId: nativeId(base, competition),
          expression: "22",
        }],
      }, peerDigest);
      assert.equal((await repository.current()).version, base.version);

      const [
        { ClaudeAgents },
        { openOperatorWorkspace },
        { openPostgresRuntimeFixture },
        { PostgresSystemStateStore },
        { DenoToolRunner },
        { SystemRuntime },
        { BehaviorInvocationRegistry },
      ] = await Promise.all([
        import("../../src/adapters/out/llm-providers/agents.ts"),
        import("../support/operator-workspace.ts"),
        import("../support/postgres-runtime-fixture.ts"),
        import("../../src/adapters/out/postgres/system-state-store.ts"),
        import("../../src/adapters/out/sandbox/runner.ts"),
        import("../support/system-runtime.ts"),
        import("../../src/application/work/behaviors/invocation.ts"),
      ]);
      postgres = await openPostgresRuntimeFixture({
        dataDir: join(root, "postgres-fixture"),
      });
      const runtimeDir = join(root, "instance");
      await Deno.mkdir(runtimeDir);
      let calls = 0,
        selectedId = "",
        phase: "propose" | "restarted" = "propose";
      let providerFailure: unknown;
      let independentlyAdmitted: ModelRevision | undefined;
      const contexts: ChatContext[] = [];
      const consult = (
        context: ChatContext,
        operation: string,
        parameters: Record<string, unknown>,
      ): ChatDecision => ({
        kind: "consult_model",
        text: `Read the pinned model with ${operation}`,
        inputJson: JSON.stringify({
          operation,
          version: context.modelContext!.version,
          ...parameters,
        }),
      });
      const fake = createClaudeToolsFake(async (view) => {
        try {
          assert.equal(
            phase,
            "propose",
            "Restart must not invoke an agent automatically",
          );
          const context = view.context as unknown as ChatContext;
          contexts.push(context);
          assert.equal(context.modelContext!.version, base.version);
          assert.equal(context.modelContext!.sourceDigest, base.sourceDigest);
          assert.deepEqual(context.modelSources!.sources, {});
          const step = calls++;
          let decision: ChatDecision;
          if (step === 0) {
            decision = consult(context, "search", {
              query: "marketRevision",
              limit: 10,
            });
          } else if (step === 1) {
            const result = (latestModelObservation(context, "search") as {
              result: {
                version: string;
                items: Array<{ id: string; qualifiedName?: string }>;
              };
            }).result;
            assert.equal(result.version, base.version);
            selectedId = result.items.find((element) =>
              element.qualifiedName === market
            )!.id;
            assert.equal(selectedId, nativeId(base, market));
            decision = consult(context, "inspect", { elementId: selectedId });
          } else if (step === 2) {
            const refusal = latestModelObservation(
              context,
              "INDEX_UNAVAILABLE",
            ) as {
              status: string;
              code: string;
              version: string;
            };
            // This legacy fixture has no persisted semantic index. A source-only
            // navigation success would violate GH-13; Toolkit remains independent.
            assert.equal(refusal.status, "refused");
            assert.equal(refusal.code, "INDEX_UNAVAILABLE");
            assert.equal(refusal.version, base.version);
            independentlyAdmitted = await repository.accept({
              id: peerProposal.id,
              expectedVersion: base.version,
              author: "local-reviewer",
              decisionAuthorityExercise: exerciseOwnerAuthority(
                await validateSourceExecutable(
                  await repository.current(),
                  projectId,
                ),
                "model-revision",
              ),
            });
            assert.notEqual(independentlyAdmitted.version, base.version);
            decision = consult(context, "query", {
              expression: "ownedMember(GitEvidence)",
            });
          } else {
            assert.equal(step, 3);
            const result = (latestModelObservation(context, "query") as {
              result: {
                operation: string;
                version: string;
                result: Array<
                  { elementId: string | null; qualifiedName?: string }
                >;
              };
            }).result;
            assert.equal(result.operation, "query");
            assert.equal(
              result.version,
              base.version,
              "Query remains on the consulted commit after admitted HEAD advances",
            );
            assert.equal(
              result.result.find((element) => element.qualifiedName === market)!
                .elementId,
              selectedId,
            );
            decision = {
              kind: "propose_sysml_edit",
              text: "Propose the observed market evidence",
              reason:
                "Search, refused navigation and Toolkit query kept one Git source commit",
              baseVersion: base.version,
              sourceDigest: base.sourceDigest,
              edits: [{
                kind: "set-value",
                elementId: selectedId,
                expression: "11",
              }, {
                kind: "rename",
                elementId: selectedId,
                name: "marketObserved",
              }],
            };
            assert.equal(Object.hasOwn(decision, "sources"), false);
          }
          return { decision };
        } catch (error) {
          providerFailure = error;
          throw error;
        }
      });
      const agents = new ClaudeAgents({
        apiKey: "recording-transport-only",
        model: "recording-transport",
        fetch: async (...args) => {
          try {
            return await fake.fetch(...args);
          } catch (error) {
            providerFailure = error;
            throw error;
          }
        },
      });
      const openRuntime = async () => {
        await postgres!.storage.operator(
          (await primaryModel.initialize()).builderId,
        );
        const store = await PostgresSystemStateStore.open(
          postgres!.database.createClient(),
          {
            ...postgres!.storage.scope,
            executionSpaceId: postgres!.storage.executionSpaceId,
            operatorId: (await primaryModel.initialize()).builderId,
          },
        );
        const executors: BehaviorInvocationPort[] = [];
        const information: { current?: DecisionInformationPort } = {};
        const service = new SystemRuntime({
          model: primaryModel,
          store,
          agents,
          runner: new DenoToolRunner(),
          behaviors: new BehaviorInvocationRegistry(executors),
          information: {
            // Main initializes before its workspace. Expose only the real
            // workspace's optional catalogue and pin guards once it exists.
            get modelTools() {
              return information.current?.modelTools;
            },
            read: (native, messages) =>
              information.current!.read(native, messages),
            get assertModelContextPin() {
              return information.current?.assertModelContextPin;
            },
            get withModelContextPin() {
              return information.current?.withModelContextPin;
            },
            consultModel: (native, input, messages, budget) =>
              information.current!.consultModel!(
                native,
                input,
                messages,
                budget,
              ),
            consultAdmittedModelSource: (native, input, messages, budget) =>
              information.current!.consultAdmittedModelSource!(
                native,
                input,
                messages,
                budget,
              ),
          },
        });
        try {
          await service.initialize();
          const workspace = await openOperatorWorkspace({
            primary: service,
            primaryModel,
            repository,
            tooling,
            agents,
            directory: runtimeDir,
            executors,
            postgres: postgres!,
          });
          information.current = workspace.information;
          return {
            service,
            workspace,
            async close() {
              const outcomes = await Promise.allSettled([
                workspace.close(),
                store.close(),
              ]);
              const errors = outcomes.filter((outcome) =>
                outcome.status === "rejected"
              ).map((outcome) => (outcome as PromiseRejectedResult).reason);
              if (errors.length) {
                throw new AggregateError(
                  errors,
                  "Cannot close local workspace",
                );
              }
            },
          };
        } catch (error) {
          await store.close();
          throw error;
        }
      };
      let runtime = await openRuntime();
      closeRuntime = () => runtime.close();
      const admitted = structuredClone(
        runtime.service.snapshot.executionModel!,
      );
      assert.equal(admitted.version.repositoryVersion, base.version);
      assert.equal(
        runtime.workspace.conversations.snapshot.conversations.length,
        2,
      );
      try {
        await runtime.service.submit(
          "Consult the evidence declarations and propose a targeted edit without loading a complete source file.",
        );
        await runtime.service.idle();
      } catch (error) {
        throw providerFailure ?? error;
      }
      if (providerFailure) throw providerFailure;
      assert.equal(runtime.service.snapshot.error, undefined);
      assert.equal(calls, 4);
      assert.equal(contexts.length, 4);
      assert(independentlyAdmitted);
      const proposals = await repository.listProposals();
      const primaryProposal = proposals.find((proposal) =>
        proposal.author === `agent:${identity.builderId}`
      )!;
      assert.equal(primaryProposal.status, "proposed");
      assert.equal(primaryProposal.baseVersion, base.version);
      assert.equal(
        (await repository.proposal(peerProposal.id)).author,
        `agent:${peerIdentity.builderId}`,
      );
      const primaryBranch = await repository.at(
        primaryProposal.proposalVersion!,
      );
      const marketText = fixture.replace(
        "marketRevision : Integer = 1;",
        "marketObserved : Integer = 11;",
      );
      assert.deepEqual(primaryBranch.sources, {
        ...base.sources,
        [path]: marketText,
      });
      nativeInteger(primaryBranch, observed, 11);
      nativeInteger(primaryBranch, competition, 2);
      assert.deepEqual(await repository.current(), independentlyAdmitted);
      assert.deepEqual(
        JSON.parse(JSON.stringify(runtime.service.snapshot.executionModel)),
        JSON.parse(JSON.stringify(admitted)),
        "An agent proposal does not adopt a new runtime pin",
      );

      // Use the production HTTP revision contract without opening a listener.
      const handler = createModelRevisionHandler({
        repository,
        model: primaryModel,
        runtime: runtime.service,
        resolveRuntime: (id) => runtime.workspace.runtimeFor(id)?.runtime,
      });
      const request = async (route: string, method = "GET", body?: unknown) => {
        const response = await handler(
          new Request(`http://local-model.invalid${route}`, {
            method,
            ...(body === undefined ? {} : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
          }),
        );
        assert(response);
        return { response, value: await response.json() };
      };
      const beforeHttp = await request("/api/model-revisions");
      assert.equal(beforeHttp.response.status, 200);
      assert.equal(beforeHttp.value.version, independentlyAdmitted.version);
      assert.equal(beforeHttp.value.agentId, identity.builderId);
      assert.equal(
        beforeHttp.value.runtime.active.repositoryVersion,
        base.version,
      );
      assert.equal(
        beforeHttp.value.runtime.available.repositoryVersion,
        independentlyAdmitted.version,
      );
      const acceptedHttp = await request(
        `/api/model-revisions/${primaryProposal.id}/decision`,
        "POST",
        {
          verdict: "approve",
          expectedVersion: independentlyAdmitted.version,
          sourceDigest: primaryProposal.sourceDigest,
        },
      );
      assert.equal(acceptedHttp.response.status, 200);
      assert.equal(acceptedHttp.value.accepted, true);
      assert.equal(acceptedHttp.value.executionAdopted, false);
      const merged = await repository.current();
      assert.equal(merged.version, acceptedHttp.value.version);
      const mergedText = marketText.replace(
        "competitionRevision : Integer = 2;",
        "competitionRevision : Integer = 22;",
      );
      assert.deepEqual(merged.sources, { ...base.sources, [path]: mergedText });
      nativeInteger(merged, observed, 11);
      nativeInteger(merged, competition, 22);
      assert.equal(
        (await repository.proposal(primaryProposal.id)).acceptanceBaseVersion,
        independentlyAdmitted.version,
      );
      assert.equal(
        (await repository.proposal(primaryProposal.id)).acceptedVersion,
        merged.version,
      );
      const history = await request("/api/model-history");
      assert.equal(history.value.headVersion, merged.version);
      assert(
        history.value.commits.some((commit: { version: string }) =>
          commit.version === base.version
        ),
      );
      const graph = await request(
        `/api/model-graph-diff?${new URLSearchParams({
          from: base.version,
          to: merged.version,
        })}`,
      );
      assert.equal(graph.response.status, 200);
      assert.equal(graph.value.engine, "Git");
      assert.equal(graph.value.fromVersion, base.version);
      assert.equal(graph.value.toVersion, merged.version);
      assert(
        graph.value.counts.added + graph.value.counts.removed +
            graph.value.counts.changed > 0,
      );
      const sourceDiff = await request(
        `/api/model-diff?${new URLSearchParams({
          from: base.version,
          to: merged.version,
        })}`,
      );
      assert.equal(sourceDiff.response.status, 200);
      assert.equal(sourceDiff.value.files.length, 1);
      assert.equal(sourceDiff.value.files[0].path, path);
      assert(sourceDiff.value.patch.includes("marketObserved"));
      assert.deepEqual(
        (await request(
          `/api/model-sources?${new URLSearchParams({
            version: base.version,
          })}`,
        )).value.sources,
        base.sources,
      );
      const pinnedReader = new ModelContextReader(repository);
      const historical = await pinnedReader.query({
        operation: "search",
        version: base.version,
        query: "marketRevision",
        limit: 10,
      });
      assert.equal(historical.version, base.version);
      const historicalQuery = await queryModelRevision(
        tooling,
        await repository.at(base.version),
        "GitEvidence::marketRevision",
      );
      assert.equal(historicalQuery, 1);

      const digest =
        (await primaryModel.readExecutableModel(identity)).version.digest;
      const clash = await Promise.all(
        [33, 44].map((value) =>
          primaryModel.proposeEdit(identity, {
            baseVersion: merged.version,
            sourceDigest: merged.sourceDigest,
            reason: `Explicit conflicting evidence ${value}`,
            edits: [{
              kind: "set-value",
              elementId: nativeId(merged, observed),
              expression: String(value),
            }],
          }, digest)
        ),
      );
      const winner = await repository.accept({
        id: clash[0]!.id,
        expectedVersion: merged.version,
        author: "local-reviewer",
        decisionAuthorityExercise: exerciseOwnerAuthority(
          await validateSourceExecutable(await repository.current(), projectId),
          "model-revision",
        ),
      });
      const dossiers = await repository.listProposals();
      await assert.rejects(
        () =>
          repository.accept({
            id: clash[1]!.id,
            expectedVersion: merged.version,
            author: "local-reviewer",
          }),
        (error: unknown) =>
          error instanceof ModelRepositoryError &&
          error.code === "STALE_REVISION",
      );
      await assert.rejects(
        () =>
          repository.accept({
            id: clash[1]!.id,
            expectedVersion: winner.version,
            author: "local-reviewer",
          }),
        (error: unknown) =>
          error instanceof ModelRepositoryError &&
          error.code === "SOURCE_CONFLICT",
      );
      assert.deepEqual(await repository.current(), winner);
      assert.deepEqual(await repository.listProposals(), dossiers);
      assert.equal(
        await Deno.readTextFile(join(project.sourcesPath, path)),
        draft,
      );
      assert.equal(await git(project.projectDir, "remote"), "");
      const pinsBefore = runtime.workspace.conversations.snapshot.conversations
        .map((conversation) => ({
          id: conversation.agentId,
          version: conversation.repositoryVersion,
          digest: conversation.modelDigest,
        }));
      await runtime.close();
      closeRuntime = undefined;
      phase = "restarted";
      repository = await GitModelRepository.open({
        projectDir: project.projectDir,
        compiler,
        sourceAuthorization: new NativeModelSourceAuthorization(projectId),
      });
      primaryModel = new SourceModel({ repository, projectId, tooling });
      runtime = await openRuntime();
      closeRuntime = () => runtime.close();
      assert.equal(calls, 4);
      assert.equal((await repository.current()).version, winner.version);
      assert.deepEqual(
        runtime.service.snapshot.executionModel!.version,
        admitted.version,
      );
      // PostgreSQL's JSON persistence omits optional properties whose value is
      // undefined; compare the persisted contract and the exact pin above.
      assert.deepEqual(
        JSON.parse(JSON.stringify(runtime.service.snapshot.executionModel)),
        JSON.parse(JSON.stringify(admitted)),
      );
      assert.deepEqual(
        runtime.workspace.conversations.snapshot.conversations.map((
          conversation,
        ) => ({
          id: conversation.agentId,
          version: conversation.repositoryVersion,
          digest: conversation.modelDigest,
        })),
        pinsBefore,
      );
      assert.equal(
        await Deno.readTextFile(join(project.sourcesPath, path)),
        draft,
      );
      assert.deepEqual(
        (await repository.at(base.version)).sources,
        base.sources,
      );
      console.log(JSON.stringify({
        qualification:
          "real local Git/Toolkit/toolkit/workspace; no network/server/LLM",
        projectId,
        initialVersion: base.version,
        mergedVersion: merged.version,
        finalVersion: winner.version,
        providerCalls: calls,
        loadedSourceFiles: 0,
        validatedCompilations: compilationCalls,
        historicalQuery: 1,
        http: "revision/history/source/graph contracts accepted Git commit IDs",
        draftPreserved: true,
        restartPinsPreserved: true,
        conflict:
          "STALE_REVISION then SOURCE_CONFLICT; head and dossiers preserved",
      }));
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        await closeRuntime?.();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await postgres?.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await Deno.remove(root, { recursive: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (failed && cleanupErrors.length) {
      throw new AggregateError(
        [failure, ...cleanupErrors],
        "Git integration failed; cleanup also failed",
      );
    }
    if (failed) throw failure;
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Git integration cleanup failed");
    }
  },
});
