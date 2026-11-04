import { createSourceModel } from "../../src/composition/source-model-services.ts";
import { latestModelObservation } from "../support/model-observation.ts";
import { SYSML_TOOLKIT_VERSION } from "../../src/adapters/out/sysml-toolkit/runtime/loader.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import { editPolicy } from "../fixtures/model-edit-mandate.ts";
import { NativeModelSourceAuthorization } from "../../src/application/governance/model-access/source-authorization.ts";
import { assertModelEditScope } from "../../src/domain/model/editing/scope.ts";
import { sameSysmlQualifiedName } from "../../src/domain/model/value-objects/sysml-qualified-name.ts";
import { resolveModelEdits } from "../../src/domain/model/editing/source-index.ts";
/** Real toolkit → native-ID authoring → Toolkit admission → Git.
 * No MCP transport, agent provider, or application database is involved. */
import assert from "node:assert/strict";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import type { SourceModel } from "../../src/application/model/source-model.ts";
import {
  sourceCompilation,
  sourceEvolutionCompilation,
  validateSourceExecutable,
} from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import { type ModelRevision } from "../../src/domain/model/records/revision.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import type {
  ModelEdit,
  ModelEditRequest,
  ResolvedModelEdit,
} from "../../src/domain/model/editing/tooling.ts";
import type { ChatContext } from "../../src/application/work/conversation/chat-context.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import type { BehaviorInvocationPort } from "../../src/application/work/behaviors/invocation.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import { postgresTestEnabled } from "../support/postgres.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const evidencePath = "toolkit-evidence.sysml";
const firstName = "ToolkitEvidence::marketRevision";
const secondName = "ToolkitEvidence::competitionRevision";
const quotedName = "ToolkitEvidence::révision-台灣";
const renamedQuotedName = "ToolkitEvidence::révision-更新";
const evidence = `package ToolkitEvidence {
    private import ScalarValues::*;
    doc /* Évidence 台灣: preserve these UTF-8 bytes and the comments. */
    attribute marketRevision : Integer = 1;

    // Distant declarations exercise a same-file three-way merge.
    doc /* First unchanged separator. */
    part def SeparatorA;
    part def SeparatorB;
    part def SeparatorC;
    doc /* Second unchanged separator. */

    attribute competitionRevision : Integer = 2;
    attribute 'révision-台灣' : Integer = 3;
    attribute dependent : Integer = marketRevision;
}
`;

/** A second native occurrence gives proposals genuinely distinct authors. */
function twoScopes(sources: Sources): Sources {
  const source = sources["configuration.sysml"]!.replace(
    "part liveBuilder : ConversationSystem {",
    "part liveBuilder : ConversationSystem {" +
      editPolicy("ToolkitEvidence").replaceAll("mission.sysml", evidencePath),
  );
  const code = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,
    (text) => text.replace(/[^\n]/g, " "),
  );
  const start = code.indexOf("part liveBuilder : ConversationSystem {");
  assert(start >= 0);
  const open = code.indexOf("{", start);
  let end = open + 1;
  let depth = 1;
  while (depth && end < code.length) {
    if (code[end] === "{") depth++;
    if (code[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0);
  const sibling = source.slice(start, end).replace(
    "part liveBuilder : ConversationSystem {",
    `part toolkitPeer : ConversationSystem {
        attribute operatorName : String = "Toolkit peer";
        attribute operatorInstruction : String = "Propose a separate source edit.";
        attribute primaryContact : Boolean = false;
        attribute humanInputEnabled : Boolean = false;`,
  ).replace(
    'configurationId : String = "live-builder-native"',
    'configurationId : String = "toolkit-peer-native"',
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
    "configuration.sysml": source.slice(0, close) + "\n    " + sibling + "\n" +
      source.slice(close),
    [evidencePath]: evidence,
  };
}

function nativeId(revision: ModelRevision, qualifiedName: string): string {
  const found = revision.elements.filter((element) =>
    typeof element.qualifiedName === "string" &&
    sameSysmlQualifiedName(element.qualifiedName, qualifiedName) &&
    element["@type"] === "AttributeUsage"
  );
  assert.equal(found.length, 1, `One native declaration for ${qualifiedName}`);
  assert.equal(typeof found[0]!["@id"], "string");
  return String(found[0]!["@id"]);
}

function nativeInteger(
  revision: ModelRevision,
  qualifiedName: string,
  expected: number,
) {
  const attributeId = nativeId(revision, qualifiedName);
  const values = revision.elements.filter((element) =>
    element["@type"] === "FeatureValue" &&
    (element.featureWithValue as { "@id"?: string })?.["@id"] === attributeId
  );
  assert.equal(values.length, 1);
  const literalId = (values[0]!.value as { "@id": string })["@id"];
  const literal = revision.elements.find((element) =>
    element["@id"] === literalId
  );
  assert.equal(literal?.["@type"], "LiteralInteger");
  assert.equal(literal.value, expected);
  assert.equal(
    revision.documents.find((document) =>
      document["@id"] === `ElementV0/${literalId}`
    )?.integer_value,
    expected,
    "The recompiled native value must survive Git readback",
  );
}

async function sourceDigest(sources: Sources): Promise<string> {
  const sha256 = async (value: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
      ),
    )
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const parts = await Promise.all(
    Object.keys(sources).sort().map(async (path) =>
      `${path}\0${await sha256(sources[path]!)}`
    ),
  );
  return await sha256(parts.join("\n"));
}

function request(base: ModelRevision, edits: ModelEdit[]): ModelEditRequest {
  return {
    baseVersion: base.version,
    sourceDigest: base.sourceDigest,
    reason: "Real toolkit native-ID authoring qualification",
    edits,
  };
}

function exactSources(
  revision: ModelRevision,
  base: ModelRevision,
  text: string,
) {
  const expected: Sources = { ...base.sources, [evidencePath]: text };
  assert.deepEqual(revision.sources, expected);
  for (const [path, source] of Object.entries(base.sources)) {
    if (path === evidencePath) continue;
    assert.deepEqual(
      new TextEncoder().encode(revision.sources[path]),
      new TextEncoder().encode(source),
    );
  }
}

/** The provider transport is the sole double: normal provider decoding,
 * consultation, decision dispatch, SDK editing and repository storage run. */
async function workspaceEdit(
  repository: GitModelRepository,
  model: SourceModel,
  tooling: SysmlToolkitAdapter,
  head: ModelRevision,
  stateDir: string,
) {
  // Keep operational infrastructure loading inside the enabled integration test.
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
  const directory = `${stateDir}/operator-workspace`;
  const postgres = await openPostgresRuntimeFixture({
    dataDir: `${directory}/postgres-fixture`,
  });
  await Deno.mkdir(directory, { recursive: true });
  const dossiersBefore = await repository.listProposals();
  await postgres.storage.operator((await model.initialize()).builderId);
  const store = await PostgresSystemStateStore.open(
    postgres.database.createClient(),
    {
      ...postgres.storage.scope,
      executionSpaceId: postgres.storage.executionSpaceId,
      operatorId: (await model.initialize()).builderId,
    },
  );
  let workspace: Awaited<ReturnType<typeof openOperatorWorkspace>> | undefined;
  let failure: unknown;
  let failed = false;
  const cleanupErrors: unknown[] = [];
  let providerFailure: unknown;
  let calls = 0;
  let selectedId = "";
  const captures: ChatContext[] = [];
  const fake = createClaudeToolsFake((view) => {
    try {
      const context = view.context as unknown as ChatContext;
      captures.push(context);
      assert.equal(context.modelContext!.version, head.version);
      assert.equal(context.modelContext!.sourceDigest, head.sourceDigest);
      assert.deepEqual(context.modelSources!.sources, {});
      assert.equal(context.modelEditing?.targetedEdits, true);
      assert.equal(context.modelEditing?.rawRevision, false);
      assert.deepEqual(context.modelEditing?.policy?.grants, [{
        file: evidencePath,
        qualifiedRoots: ["ToolkitEvidence"],
      }]);
      assert(context.modelTools!.some((tool) => tool.id === "model.query"));
      assert(
        !JSON.stringify(context).includes(
          JSON.stringify(head.sources[evidencePath]!).slice(1, -1),
        ),
        "Whole source text must not enter the provider request",
      );
      let decision: ChatDecision;
      if (calls++ === 0) {
        decision = {
          kind: "consult_model",
          text:
            "Find the evidence declarations in the admitted source version.",
          inputJson: JSON.stringify({
            operation: "query",
            version: context.modelContext!.version,
            expression: "ownedMember(ToolkitEvidence)",
          }),
        };
      } else {
        assert.equal(calls, 2, "One query followed by one targeted proposal");
        const queried = (latestModelObservation(context, "query") as {
          result: {
            operation: string;
            result: Array<
              {
                qualifiedName?: string;
                elementId: string | null;
                toolkitElementId: string;
              }
            >;
          };
        }).result;
        assert.equal(queried.operation, "query");
        const declaration = queried.result.find((element) =>
          element.qualifiedName === quotedName ||
          element.qualifiedName === "ToolkitEvidence::'révision-台灣'"
        )!;
        selectedId = declaration.elementId!;
        assert.equal(selectedId, nativeId(head, quotedName));
        assert.equal(
          declaration.toolkitElementId,
          selectedId,
          "Toolkit provider identity must survive compilation and Git publication unchanged",
        );
        decision = {
          kind: "propose_sysml_edit",
          text: "Submit the evidence value for explicit admission.",
          reason: "Target selected through the real model.query operation",
          baseVersion: context.modelContext!.version,
          sourceDigest: context.modelContext!.sourceDigest,
          edits: [{
            kind: "set-value",
            elementId: selectedId,
            expression: "13",
          }, {
            kind: "rename",
            elementId: selectedId,
            name: "révision-更新",
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
  try {
    const executors: BehaviorInvocationPort[] = [];
    const information: { current?: DecisionInformationPort } = {};
    const service = new SystemRuntime({
      model,
      store,
      agents,
      runner: new DenoToolRunner(),
      behaviors: new BehaviorInvocationRegistry(executors),
      information: {
        read: (native, messages) => information.current!.read(native, messages),
        consultModel: (native, input, messages) =>
          information.current!.consultModel!(native, input, messages),
        consultAdmittedModelSource: (native, input, messages, budget) =>
          information.current!.consultAdmittedModelSource!(
            native,
            input,
            messages,
            budget,
          ),
      },
    });
    await service.initialize();
    const admitted = structuredClone(service.snapshot.executionModel!);
    workspace = await openOperatorWorkspace({
      primary: service,
      primaryModel: model,
      repository,
      tooling,
      agents,
      directory,
      executors,
      postgres,
    });
    information.current = workspace.information;
    assert.equal(workspace.conversations.snapshot.conversations.length, 2);
    assert(
      service.snapshot.modelTools!.some((tool) => tool.id === "model.query"),
    );
    await service.submit(
      "Find the evidence attribute and propose a targeted value change without loading source files.",
    );
    await service.idle();
    if (providerFailure) throw providerFailure;
    assert.equal(service.snapshot.error, undefined);
    assert.equal(calls, 2);
    assert.equal(captures.length, 2);
    const proposals = await repository.listProposals();
    assert.equal(proposals.length, dossiersBefore.length + 1);
    const proposal = proposals.find((entry) =>
      !dossiersBefore.some((prior) => prior.id === entry.id)
    )!;
    assert.equal(proposal.author, `agent:${admitted.identity.builderId}`);
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.baseVersion, head.version);
    const branch = await repository.at(proposal.proposalVersion!);
    exactSources(
      branch,
      head,
      head.sources[evidencePath]!.replace(
        "'révision-台灣' : Integer = 3;",
        "'révision-更新' : Integer = 13;",
      ),
    );
    nativeInteger(branch, renamedQuotedName, 13);
    nativeInteger(branch, firstName, 333);
    assert.equal(proposal.sourceDigest, await sourceDigest(branch.sources));
    assert.deepEqual(
      await repository.current(),
      head,
      "Submitting a decision must not admit its proposal",
    );
    assert.deepEqual(
      JSON.parse(JSON.stringify(service.snapshot.executionModel)),
      JSON.parse(JSON.stringify(admitted)),
      "Submitting a decision must not adopt a different execution pin",
    );
    assert(
      service.snapshot.events.some((event) =>
        event.kind === "model-tool-completed"
      ),
    );
    assert(
      service.snapshot.events.some((event) =>
        event.kind === "model-revision-proposed"
      ),
    );
    console.log(JSON.stringify({
      workspace:
        "real operatorWorkspace/SystemRuntime/provider-decision validation",
      providerCalls: calls,
      loadedSourceFiles: 0,
      selectedNativeId: selectedId,
      proposal: proposal.id,
      status: proposal.status,
      headPreserved: true,
      executionPinPreserved: true,
    }));
  } catch (error) {
    failed = true;
    failure = providerFailure ?? error;
  } finally {
    try {
      await workspace?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await store.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await postgres.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failed && cleanupErrors.length) {
    throw new AggregateError(
      [failure, ...cleanupErrors],
      "Workspace proof failed; cleanup also failed",
    );
  }
  if (failed) throw failure;
  if (cleanupErrors.length) {
    throw new AggregateError(cleanupErrors, "Workspace cleanup failed");
  }
}

Deno.test({
  name:
    "sysml-toolkit real SDK: assembled-model query, UTF-8 description and isolated edit sessions",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
    const sources: Sources = {
      ...await loadInitialSources(undefined, { information: false }),
      [evidencePath]: evidence,
    };
    const before = structuredClone(sources);
    const target = {
      qualifiedName: firstName,
      metaclass: "AttributeUsage",
      source: {
        path: evidencePath,
        text: "attribute marketRevision : Integer = 1;",
      },
    };
    assert.deepEqual(await tooling.check(sources), []);
    assert.equal(await tooling.query(sources, firstName), 1);
    const description = await tooling.describe(sources, target);
    assert.equal(description.qualifiedName, firstName);
    assert.equal(description.metaclass, "AttributeUsage");
    assert.equal(description.owner?.qualifiedName, "ToolkitEvidence");
    assert(
      description.types.some((type) =>
        type.qualifiedName === "ScalarValues::Integer"
      ),
    );
    assert.equal(description.source.path, evidencePath);
    assert.equal(description.source.text, target.source.text);
    assert.equal(
      new TextDecoder().decode(
        new TextEncoder().encode(evidence).slice(
          description.source.startByte,
          description.source.endByte,
        ),
      ),
      target.source.text,
      "Toolkit source extents are UTF-8 byte coordinates after non-ASCII text",
    );
    const edited = await tooling.edit(sources, [{
      kind: "set-value",
      target,
      expression: "11",
    }]);
    assert.deepEqual(edited.sources, {
      ...before,
      [evidencePath]: evidence.replace(
        "marketRevision : Integer = 1;",
        "marketRevision : Integer = 11;",
      ),
    });
    assert.deepEqual(edited.provider, {
      name: "sysml-toolkit",
      version: SYSML_TOOLKIT_VERSION,
    });
    assert(edited.splices.length > 0);
    assert.deepEqual(
      sources,
      before,
      "The caller's immutable source snapshot is preserved",
    );
    assert.deepEqual(
      await Promise.all([
        tooling.query(sources, firstName),
        tooling.query(edited.sources, firstName),
      ]),
      [1, 11],
      "Concurrent queries use separate sessions and source bases",
    );
    await assert.rejects(() =>
      tooling.describe(sources, {
        ...target,
        source: {
          ...target.source,
          text: target.source.text.replace("= 1", "= 999"),
        },
      }), /source|preimage/i);
    const temporaryDeclaration = "attribute temporaryEvidence : Integer = 9;";
    const inserted = await tooling.edit(sources, [{
      kind: "insert-member",
      target: {
        qualifiedName: "ToolkitEvidence",
        metaclass: "Package",
        source: { path: evidencePath, text: evidence.trimEnd() },
      },
      text: temporaryDeclaration,
    }]);
    assert.deepEqual(
      inserted.sources,
      {
        ...before,
        [evidencePath]: evidence.replace(
          "\n}\n",
          `\n    ${temporaryDeclaration}\n}\n`,
        ),
      },
      "Insert-member changes only the requested member bytes in its owning file",
    );
    assert.deepEqual(await tooling.check(inserted.sources), []);
    assert.equal(
      await tooling.query(
        inserted.sources,
        "ToolkitEvidence::temporaryEvidence",
      ),
      9,
    );
    const removed = await tooling.edit(inserted.sources, [{
      kind: "remove",
      target: {
        qualifiedName: "ToolkitEvidence::temporaryEvidence",
        metaclass: "AttributeUsage",
        source: { path: evidencePath, text: temporaryDeclaration },
      },
    }]);
    assert.deepEqual(
      removed.sources,
      before,
      "Removing the new member restores every original byte",
    );
    assert.deepEqual(await tooling.check(removed.sources), []);
  },
});

Deno.test({
  name:
    "sysml-toolkit real SDK: retype retains a member body and incoming allocation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const path = "retype-fixture.sysml";
    const declaration =
      "perform action work : FlowA { doc /* retained body */ }";
    const source = `package TypeFixture {
    action def FlowA;
    action def FlowB;
    part def Workspace {
        part worker;
        ${declaration}
        allocate work to worker;
    }
}
`;
    const sources: Sources = { [path]: source };
    const target = {
      qualifiedName: "TypeFixture::Workspace::work",
      metaclass: "PerformActionUsage",
      source: { path, text: declaration },
    };
    const owner = {
      qualifiedName: "TypeFixture::Workspace",
      metaclass: "PartDefinition",
      source: {
        path,
        text: `part def Workspace {
        part worker;
        ${declaration}
        allocate work to worker;
    }`,
      },
    };
    const directory = await Deno.makeTempDir({
      prefix: "assembly-retype-toolkit-",
    });
    try {
      const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
      const repository = await GitModelRepository.open({
        projectDir: directory,
        compiler: new ToolkitCompiler({ packageDir: packageDir! }),
      });
      const base = await repository.initialize(sources);
      assert.deepEqual(await tooling.check(sources), []);
      await assert.rejects(() =>
        tooling.edit(sources, [
          { kind: "remove", target },
          {
            kind: "insert-member",
            target: owner,
            text: declaration.replace("FlowA", "FlowB"),
          },
        ])
      );
      assert.deepEqual(sources, base.sources);
      const edited = await tooling.edit(sources, [{
        kind: "set-type",
        target,
        type: "TypeFixture::FlowB",
      }]);
      assert.deepEqual(edited.sources, {
        [path]: source.replace("work : FlowA", "work : TypeFixture::FlowB"),
      });
      assert.match(edited.sources[path]!, /doc \/\* retained body \*\//);
      assert.match(edited.sources[path]!, /allocate work to worker;/);
      assert.deepEqual(await tooling.check(edited.sources), []);
      const readback = await tooling.describe(edited.sources, {
        ...target,
        source: {
          path,
          text: declaration.replace("FlowA", "TypeFixture::FlowB"),
        },
      });
      assert(
        readback.types.some((type) =>
          type.qualifiedName === "TypeFixture::FlowB"
        ),
      );
      await assert.rejects(() =>
        tooling.edit(sources, [{
          kind: "set-type",
          target,
          type: "TypeFixture::MissingFlow",
        }])
      );
      assert.deepEqual(sources, base.sources);
      assert.equal((await repository.current()).version, base.version);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "sysml-toolkit source authorization refuses ungranted and out-of-scope set-type edits",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    for (const allowSetType of [false, true]) {
      const directory = await Deno.makeTempDir({
        prefix: "assembly-retype-authority-",
      });
      const projectId = `git:${crypto.randomUUID()}`;
      try {
        const compiler = new ToolkitCompiler({ packageDir: packageDir! });
        const repository = await GitModelRepository.open({
          projectDir: directory,
          compiler,
          sourceAuthorization: new NativeModelSourceAuthorization(
            projectId,
            sourceCompilation,
            sourceEvolutionCompilation,
          ),
        });
        const sources = twoScopes(
          await loadInitialSources(undefined, { information: false }),
        );
        sources[evidencePath] +=
          "\npackage OtherEvidence { private import ScalarValues::*; attribute outside : Integer; }\n";
        if (allowSetType) {
          const policy = editPolicy("ToolkitEvidence").replaceAll(
            "mission.sysml",
            evidencePath,
          );
          const operations = JSON.stringify(
            JSON.stringify(["set-value", "rename", "insert-member", "remove"]),
          );
          const extended = JSON.stringify(
            JSON.stringify([
              "set-value",
              "rename",
              "insert-member",
              "remove",
              "set-type",
            ]),
          );
          assert(sources["configuration.sysml"]!.includes(policy));
          sources["configuration.sysml"] = sources["configuration.sysml"]!
            .replace(
              policy,
              policy.replace(operations, extended),
            );
        }
        const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
        const model = createSourceModel({
          repository,
          projectId,
          tooling,
          initialSources: sources,
        });
        const identity = await model.initialize();
        const base = await repository.current();
        const admitted = await model.readExecutableModel(identity);
        assert.equal(
          admitted.modelEditPolicy!.operations.includes("set-type"),
          allowSetType,
        );
        const targets = allowSetType
          ? [
            "OtherEvidence::outside",
            "AssemblyLiveBuilder::liveBuilder::operatorFlowTemplateRevision",
          ]
          : [firstName];
        for (const name of targets) {
          const beforeProposals = await repository.listProposals();
          const edit: ModelEdit = {
            kind: "set-type",
            elementId: nativeId(base, name),
            typeName: "ScalarValues::Real",
          };
          if (allowSetType) {
            const preview = await tooling.edit(
              base.sources,
              resolveModelEdits(base, [edit]),
            );
            assert.notDeepEqual(preview.sources, base.sources);
          }
          await assert.rejects(
            () =>
              model.proposeEdit(
                identity,
                request(base, [edit]),
                admitted.version.digest,
              ),
            (error: unknown) =>
              error instanceof ModelRepositoryError &&
              error.code === "EDIT_SCOPE_DENIED",
          );
          assert.deepEqual(await repository.current(), base);
          assert.deepEqual(await repository.listProposals(), beforeProposals);
        }
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }
  },
});

Deno.test({
  name:
    "sysml-toolkit real integration: native targets, isolated same-file edits, refusals, merge and CAS",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    assert.equal(Deno.version.deno, "2.9.7");
    const stateDir = await Deno.makeTempDir({
      prefix: "ase-toolkit-integration-",
    });
    const projectId = `git:${crypto.randomUUID()}`;
    let validationCount = 0;
    let failure: unknown;
    let failed = false;
    const cleanupErrors: unknown[] = [];
    try {
      const compiler = new ToolkitCompiler({ packageDir: packageDir! });
      assert.equal(await compiler.version(), SYSML_TOOLKIT_VERSION);
      const options = {
        projectDir: stateDir,
        sourceAuthorization: new NativeModelSourceAuthorization(
          projectId,
          sourceCompilation,
          sourceEvolutionCompilation,
        ),
        compiler: {
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
        },
      };
      const repository = await GitModelRepository.open(options);
      const peerRepository = await GitModelRepository.open(options);
      const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
      const primary = createSourceModel({
        repository,
        projectId,
        tooling,
        initialSources: twoScopes(
          await loadInitialSources(undefined, { information: false }),
        ),
      });
      const peer = createSourceModel({
        repository: peerRepository,
        projectId,
        tooling,
        systemQualifiedName: "AssemblyLiveBuilder::toolkitPeer",
      });
      const primaryIdentity = await primary.initialize();
      const peerIdentity = await peer.initialize();
      assert.notEqual(primaryIdentity.builderId, peerIdentity.builderId);
      const base = await repository.current();
      assert.equal(base.sourceDigest, await sourceDigest(base.sources));
      const primaryDigest =
        (await primary.readExecutableModel(primaryIdentity)).version.digest;
      const peerDigest =
        (await peer.readExecutableModel(peerIdentity)).version.digest;
      const firstId = nativeId(base, firstName);
      const secondId = nativeId(base, secondName);
      const firstRequest = request(base, [{
        kind: "set-value",
        elementId: firstId,
        expression: "11",
      }]);
      assert.equal(
        Object.hasOwn(firstRequest, "sources"),
        false,
        "Authoring input contains no full source payload",
      );
      const proposals = await Promise.all([
        primary.proposeEdit(primaryIdentity, firstRequest, primaryDigest),
        peer.proposeEdit(
          peerIdentity,
          request(base, [{
            kind: "set-value",
            elementId: secondId,
            expression: "22",
          }]),
          peerDigest,
        ),
      ]);
      const records = await Promise.all(
        proposals.map((proposal) => repository.proposal(proposal.id)),
      );
      assert.notEqual(records[0]!.branch, records[1]!.branch);
      assert.deepEqual(records.map((record) => record.author), [
        `agent:${primaryIdentity.builderId}`,
        `agent:${peerIdentity.builderId}`,
      ]);
      const expected = [
        evidence.replace(
          "marketRevision : Integer = 1;",
          "marketRevision : Integer = 11;",
        ),
        evidence.replace(
          "competitionRevision : Integer = 2;",
          "competitionRevision : Integer = 22;",
        ),
      ];
      for (const [index, record] of records.entries()) {
        assert.equal(record.baseVersion, base.version);
        assert.equal(record.status, "proposed");
        assert.equal(record.validation, "validated");
        const branch = await repository.at(record.proposalVersion!);
        exactSources(branch, base, expected[index]!);
        assert.equal(record.sourceDigest, await sourceDigest(branch.sources));
        nativeInteger(branch, firstName, index === 0 ? 11 : 1);
        nativeInteger(branch, secondName, index === 1 ? 22 : 2);
      }
      assert.deepEqual(await repository.current(), base);

      // Every refusal preserves admitted sources and every existing proposal dossier.
      const refuse = async (
        editRequest: ModelEditRequest,
        expectedError: RegExp,
        digest = primaryDigest,
      ) => {
        const dossiers = await repository.listProposals();
        const head = await repository.current();
        await assert.rejects(
          () => primary.proposeEdit(primaryIdentity, editRequest, digest),
          expectedError,
        );
        assert.deepEqual(await repository.current(), head);
        assert.deepEqual(await repository.listProposals(), dossiers);
      };
      await refuse(
        { ...firstRequest, sourceDigest: "0".repeat(64) },
        /Source digest differs/,
      );
      await refuse(firstRequest, /Execution model changed/, "0".repeat(64));
      await refuse(
        request(base, [{
          kind: "set-value",
          elementId: "foreign-native-id",
          expression: "7",
        }]),
        /target is absent/,
      );
      await refuse(
        request(base, [{
          kind: "set-value",
          elementId: firstId,
          expression: "1 + (",
        }]),
        /does not parse|syntax|preview refused/,
      );
      await refuse(
        request(base, [{
          kind: "set-value",
          elementId: firstId,
          expression: "missingToolkitReference",
        }]),
        /dropped operations|validation refused|unresolved/i,
      );
      // SDK 0.10.10 drops a colliding sibling rename with a finding; a mixed
      // batch must therefore refuse rather than silently publish its other edit.
      await refuse(
        request(base, [
          { kind: "rename", elementId: firstId, name: "competitionRevision" },
          { kind: "set-value", elementId: secondId, expression: "99" },
        ]),
        /dropped operations/,
      );

      const admittedFirst = await repository.accept({
        id: records[0]!.id,
        expectedVersion: base.version,
        author: "toolkit-coordinator",
        decisionAuthorityExercise: exerciseOwnerAuthority(
          await validateSourceExecutable(await repository.current(), projectId),
          "model-revision",
        ),
      });
      const merged = await peerRepository.accept({
        id: records[1]!.id,
        expectedVersion: admittedFirst.version,
        author: "toolkit-coordinator",
        decisionAuthorityExercise: exerciseOwnerAuthority(
          await validateSourceExecutable(
            await peerRepository.current(),
            projectId,
          ),
          "model-revision",
        ),
      });
      const mergedText = expected[0]!.replace(
        "competitionRevision : Integer = 2;",
        "competitionRevision : Integer = 22;",
      );
      exactSources(merged, base, mergedText);
      nativeInteger(merged, firstName, 11);
      nativeInteger(merged, secondName, 22);
      assert.equal(merged.sourceDigest, await sourceDigest(merged.sources));
      for (const record of records) {
        const receipt = await repository.proposal(record.id);
        assert.equal(receipt.status, "accepted");
        assert.equal(receipt.decidedBy, "toolkit-coordinator");
      }

      const makeProposal = async (
        actor: "primary" | "peer",
        revision: ModelRevision,
        name: string,
        expression: string,
      ) => {
        const model = actor === "primary" ? primary : peer;
        const identity = actor === "primary" ? primaryIdentity : peerIdentity;
        const digest =
          (await model.readExecutableModel(identity)).version.digest;
        return await model.proposeEdit(
          identity,
          request(revision, [{
            kind: "set-value",
            elementId: nativeId(revision, name),
            expression,
          }]),
          digest,
        );
      };
      const races = await Promise.all([
        makeProposal("primary", merged, firstName, "111"),
        makeProposal("peer", merged, secondName, "222"),
      ]);
      const raceRecords = await Promise.all(
        races.map((proposal) => repository.proposal(proposal.id)),
      );
      // Both contenders have the same prior authority; CAS, not missing
      // admission metadata, must select the winner.
      const raceAuthority = exerciseOwnerAuthority(
        await validateSourceExecutable(await repository.current(), projectId),
        "model-revision",
      );
      const race = await Promise.allSettled(
        races.map((proposal, index) =>
          (index === 0 ? repository : peerRepository).accept({
            id: proposal.id,
            expectedVersion: merged.version,
            author: "toolkit-coordinator",
            decisionAuthorityExercise: raceAuthority,
          })
        ),
      );
      assert.equal(
        race.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const loser = race.findIndex((result) => result.status === "rejected");
      const error = (race[loser] as PromiseRejectedResult).reason;
      assert(error instanceof ModelRepositoryError);
      assert.equal(error.code, "STALE_REVISION");
      assert.deepEqual(
        await repository.proposal(races[loser]!.id),
        raceRecords[loser],
      );
      const winner = await repository.current();
      const afterRace = await repository.accept({
        id: races[loser]!.id,
        expectedVersion: winner.version,
        author: "toolkit-coordinator",
        decisionAuthorityExercise: exerciseOwnerAuthority(
          await validateSourceExecutable(await repository.current(), projectId),
          "model-revision",
        ),
      });
      exactSources(
        afterRace,
        base,
        evidence.replace(
          "marketRevision : Integer = 1;",
          "marketRevision : Integer = 111;",
        )
          .replace(
            "competitionRevision : Integer = 2;",
            "competitionRevision : Integer = 222;",
          ),
      );
      nativeInteger(afterRace, firstName, 111);
      nativeInteger(afterRace, secondName, 222);

      const clashes = await Promise.all([
        makeProposal("primary", afterRace, firstName, "333"),
        makeProposal("peer", afterRace, firstName, "444"),
      ]);
      const clashWinner = await repository.accept({
        id: clashes[0]!.id,
        expectedVersion: afterRace.version,
        author: "toolkit-coordinator",
        decisionAuthorityExercise: exerciseOwnerAuthority(
          await validateSourceExecutable(await repository.current(), projectId),
          "model-revision",
        ),
      });
      const beforeConflict = await repository.listProposals();
      const validationsBeforeConflict = validationCount;
      await assert.rejects(
        () =>
          peerRepository.accept({
            id: clashes[1]!.id,
            expectedVersion: clashWinner.version,
            author: "toolkit-coordinator",
          }),
        (error: unknown) =>
          error instanceof ModelRepositoryError &&
          error.code === "SOURCE_CONFLICT",
      );
      assert.equal(validationCount, validationsBeforeConflict);
      assert.deepEqual(await repository.current(), clashWinner);
      assert.deepEqual(await repository.listProposals(), beforeConflict);
      nativeInteger(clashWinner, firstName, 333);
      nativeInteger(clashWinner, secondName, 222);
      assert.deepEqual(await repository.at(base.version), base);
      assert.equal(
        (await primary.readExecutableModel(primaryIdentity)).version.digest,
        primaryDigest,
      );
      console.log(JSON.stringify({
        qualification: "real toolkit/Toolkit/Git; no LLM calls",
        nativeIds: [firstId, secondId],
        sourceDigest: clashWinner.sourceDigest,
        validatedCompilations: validationCount,
        cas: "one accepted, one STALE_REVISION, retry accepted",
        conflict: "SOURCE_CONFLICT; head and dossiers preserved",
      }));
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        await Deno.remove(stateDir, { recursive: true });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (failed && cleanupErrors.length) {
      throw new AggregateError(
        [failure, ...cleanupErrors],
        "Integration failed; cleanup also failed",
      );
    }
    if (failed) throw failure;
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Integration cleanup failed");
    }
  },
});

Deno.test({
  name:
    "sysml-toolkit provider workspace: native query and scoped edit proposal",
  ignore: !toolkitIntegrationEnabled ||
    !postgresTestEnabled,
  async fn() {
    const stateDir = await Deno.makeTempDir({
      prefix: "ase-toolkit-workspace-",
    });
    const projectId = `git:${crypto.randomUUID()}`;
    try {
      const compiler = new ToolkitCompiler({ packageDir: packageDir! });
      const repository = await GitModelRepository.open({
        projectDir: stateDir,
        sourceAuthorization: new NativeModelSourceAuthorization(
          projectId,
          sourceCompilation,
          sourceEvolutionCompilation,
        ),
        compiler: {
          async compile(sources) {
            const compiled = await compiler.compile(sources);
            await validateSourceExecutable({
              ...compiled,
              version: "compile-gate",
            }, projectId);
            return compiled;
          },
          recipe: () => compiler.recipe(),
        },
      });
      const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
      const sources = twoScopes(
        await loadInitialSources(undefined, { information: false }),
      );
      sources[evidencePath] = evidence
        .replace(
          "marketRevision : Integer = 1;",
          "marketRevision : Integer = 333;",
        )
        .replace(
          "competitionRevision : Integer = 2;",
          "competitionRevision : Integer = 222;",
        );
      const model = createSourceModel({
        repository,
        projectId,
        tooling,
        initialSources: sources,
      });
      await model.initialize();
      await workspaceEdit(
        repository,
        model,
        tooling,
        await repository.current(),
        stateDir,
      );
    } finally {
      await Deno.remove(stateDir, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "sysml-toolkit exact reference retarget preserves occurrence and allocation",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const path = "reference-site.sysml";
    const declaration =
      "perform action conversation : OldFlow { doc /* retained */ }";
    const source = `package RefSiteProof {
  doc /* unicode 台灣 */
  action def OldFlow { action readCaseState; }
  action def NewFlow { action readCaseState; }
  part system {
    part worker;
    ${declaration}
    /* 😀 */ allocate conversation.readCaseState to worker;
  }
}\n`;
    const sources: Sources = { [path]: source };
    const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
    const model = await tooling.snapshot(sources);
    const id = (name: string) => {
      const found = model.elements.filter((entry) =>
        entry.qualifiedName === name
      );
      assert.equal(found.length, 1, name);
      return String(found[0]!["@id"]);
    };
    const fromId = id("RefSiteProof::OldFlow::readCaseState");
    const toId = id("RefSiteProof::NewFlow::readCaseState");
    const occurrenceId = id("RefSiteProof::system::conversation");
    const sites = await tooling.referenceSites(sources, fromId);
    const selected = sites.filter((site) =>
      site.unit === path && site.chainRootId === occurrenceId
    );
    assert.equal(selected.length, 1);
    const edits: ResolvedModelEdit[] = [{
      kind: "set-type",
      target: {
        qualifiedName: "RefSiteProof::system::conversation",
        metaclass: "PerformActionUsage",
        source: { path, text: declaration },
      },
      type: "RefSiteProof::NewFlow",
    }, { kind: "retarget-reference", fromId, toId, site: selected[0]! }];
    const result = await tooling.edit(sources, edits);
    assert.match(result.sources[path]!, /doc \/\* retained \*\//);
    assert.match(
      result.sources[path]!,
      /allocate conversation\..*NewFlow::readCaseState to worker;/,
    );
    assert.deepEqual(await tooling.check(result.sources), []);
    const changed = structuredClone(edits);
    const changedSite = changed[1]!;
    assert(changedSite.kind === "retarget-reference");
    changedSite.site.preimage += "x";
    await assert.rejects(() => tooling.edit(sources, changed));
    assert.deepEqual(sources, { [path]: source });
  },
});

Deno.test({
  name:
    "sysml-toolkit retarget batch requires an explicit operation and confines every source effect",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    for (const grantRetarget of [false, true]) {
      const directory = await Deno.makeTempDir({
        prefix: "assembly-retarget-authority-",
      });
      const projectId = `git:${crypto.randomUUID()}`;
      try {
        const compiler = new ToolkitCompiler({ packageDir: packageDir! });
        const repository = await GitModelRepository.open({
          projectDir: directory,
          compiler,
          sourceAuthorization: new NativeModelSourceAuthorization(
            projectId,
            sourceCompilation,
            sourceEvolutionCompilation,
          ),
        });
        const sources = twoScopes(
          await loadInitialSources(undefined, { information: false }),
        );
        sources[evidencePath] = `package ToolkitEvidence {
  action def OldFlow { action readCaseState; }
  action def NewFlow { action readCaseState; }
  part Other;
  part system {
    part worker;
    perform action conversation : OldFlow { doc /* retained */ }
    allocate conversation.readCaseState to worker;
  }
}\n`;
        const policy = editPolicy("ToolkitEvidence").replaceAll(
          "mission.sysml",
          evidencePath,
        );
        const operations = JSON.stringify(
          JSON.stringify(["set-value", "rename", "insert-member", "remove"]),
        );
        const extended = JSON.stringify(JSON.stringify([
          "set-value",
          "rename",
          "insert-member",
          "remove",
          "set-type",
          ...(grantRetarget ? ["retarget-reference"] : []),
        ]));
        assert(sources["configuration.sysml"]!.includes(policy));
        sources["configuration.sysml"] = sources["configuration.sysml"]!
          .replace(policy, policy.replace(operations, extended));
        const tooling = new SysmlToolkitAdapter({ packageDir: packageDir! });
        const model = createSourceModel({
          repository,
          projectId,
          tooling,
          initialSources: sources,
        });
        const identity = await model.initialize();
        const base = await repository.current();
        const admitted = await model.readExecutableModel(identity);
        assert.equal(
          admitted.modelEditPolicy!.operations.includes("retarget-reference"),
          grantRetarget,
        );
        const id = (name: string) => {
          const found = base.elements.filter((element) =>
            element.qualifiedName === name
          );
          assert.equal(found.length, 1, name);
          return String(found[0]!["@id"]);
        };
        const fromId = id("ToolkitEvidence::OldFlow::readCaseState");
        const toId = id("ToolkitEvidence::NewFlow::readCaseState");
        const occurrence = id("ToolkitEvidence::system::conversation");
        const sites = (await tooling.referenceSites(base.sources, fromId))
          .filter((site) =>
            site.unit === evidencePath && site.chainRootId === occurrence
          );
        assert.equal(sites.length, 1);
        const edits: ModelEdit[] = [
          {
            kind: "set-type",
            elementId: occurrence,
            typeName: "ToolkitEvidence::NewFlow",
          },
          { kind: "retarget-reference", fromId, toId, site: sites[0]! },
        ];
        const preview = await tooling.edit(
          base.sources,
          resolveModelEdits(base, edits),
        );
        assert.notDeepEqual(preview.sources, base.sources);
        const compiled = await compiler.compile(preview.sources);
        assert.throws(() =>
          assertModelEditScope(base, compiled, [{
            file: evidencePath,
            qualifiedRoots: ["ToolkitEvidence::Other"],
          }]), /outside its exact admitted source scope/);
        assert.throws(() =>
          assertModelEditScope(base, compiled, [{
            file: "configuration.sysml",
            qualifiedRoots: ["AssemblyLiveBuilder::liveBuilder"],
          }]), /outside its exact admitted source scope/);
        assert.deepEqual(await repository.current(), base);
        const before = await repository.listProposals();
        if (!grantRetarget) {
          await assert.rejects(
            () =>
              model.proposeEdit(
                identity,
                request(base, edits),
                admitted.version.digest,
              ),
            (error: unknown) =>
              error instanceof ModelRepositoryError &&
              error.code === "EDIT_SCOPE_DENIED",
          );
          assert.deepEqual(await repository.listProposals(), before);
        } else {
          const proposed = await model.proposeEdit(
            identity,
            request(base, edits),
            admitted.version.digest,
          );
          assert.equal(
            (await repository.proposal(proposed.id)).status,
            "proposed",
          );
        }
        assert.deepEqual(await repository.current(), base);
      } finally {
        await Deno.remove(directory, { recursive: true });
      }
    }
  },
});
