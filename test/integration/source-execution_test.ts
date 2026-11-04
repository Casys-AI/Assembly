import { executeFlow } from "../support/native-flow-oracle.ts";
/** Real source compilation, with recording mechanisms instead of external effects. */
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import assert from "node:assert/strict";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import { sourceSnapshot } from "../../src/domain/model/projections/source-facts.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
async function runPromotion(model: ExecutableModel, calls: string[]) {
  const candidate = { id: "source-proof", digest: "a".repeat(64) };
  return await executeFlow(model.flows.promotion, {}, (node) => {
    calls.push(node.mechanism!);
    switch (node.mechanism) {
      case "propose_candidate":
        return { outputs: { candidate } };
      case "test_candidate":
        return { outputs: { result: { passed: true } } };
      case "decide_admission":
        return {
          outputs: {
            decision: { admitted: true, candidateDigest: candidate.digest },
          },
        };
      case "activate_candidate":
      case "refuse_candidate":
        return {};
      default:
        throw new Error(`Unexpected source mechanism ${node.mechanism}`);
    }
  });
}

Deno.test({
  name:
    "real default immutable group template and the explicit scalar variant both compile",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const original = await loadInitialSources(undefined, {
      information: false,
    });
    const configuration = original["configuration.sysml"]!;
    const groupTemplate =
      "perform action operatorFlowTemplate : ImmutableGroupConversationV1;";
    const groupConversation =
      "perform action conversation : ImmutableGroupConversationV1 {";
    assert.equal(configuration.split(groupTemplate).length, 2);
    assert.equal(configuration.split(groupConversation).length, 2);
    const scalarConfiguration = configuration
      .replace(
        groupTemplate,
        "perform action operatorFlowTemplate : ConsultingConversationV1;",
      )
      .replace(
        groupConversation,
        "perform action conversation : ConsultingConversationV1 {",
      );
    const compile = async (sources: Record<string, string>) =>
      await validateSourceExecutable({
        ...await compiler.compile(sources),
        version: "source-immutable-group-proof",
      }, "git:90926ac5-a5d5-5c79-ba95-6eba338587e1");
    const scalar = await compile({
      ...original,
      "configuration.sysml": scalarConfiguration,
    });
    const groupRevision = {
      ...await compiler.compile(original),
      version: "source-immutable-group-proof",
    };
    const group = await validateSourceExecutable(
      groupRevision,
      "git:90926ac5-a5d5-5c79-ba95-6eba338587e1",
    );
    for (const model of [scalar, group]) {
      assert.equal(model.policy.mayConsultModel, true);
      assert.equal(model.policy.mayProposeSysmlRevision, true);
    }
    assert.equal(
      scalar.flows.conversation.executionProfile,
      "operator-command-v1",
    );
    assert.equal(
      scalar.operatorFlowTemplate?.qualifiedName,
      "AssemblyConversation::ConsultingConversationV1",
    );
    assert.equal(
      scalar.flows.conversation.nodes.filter((node) =>
        node.mechanism === "execute_operator_command"
      ).length,
      1,
    );
    assert.equal(
      group.flows.conversation.executionProfile,
      "operator-command-immutable-group-v1",
    );
    assert.notEqual(group.version.digest, scalar.version.digest);
    assert.equal(
      group.operatorFlowTemplate?.qualifiedName,
      "AssemblyConversation::ImmutableGroupConversationV1",
    );
    assert(group.operatorFlowTemplate?.typeNativeId);
    assert(
      group.version.sourceIds.includes(group.operatorFlowTemplate.typeNativeId),
    );
    const flow = group.flows.conversation;
    assert(group.version.sourceIds.includes(flow.rootNativeId));
    const commands = flow.nodes.filter((node) =>
      node.mechanism === "execute_operator_command"
    );
    assert.equal(commands.length, 1);
    const snapshot = sourceSnapshot(
      groupRevision.elements,
      group.identity.rootId,
    );
    const definitionId = group.operatorFlowTemplate.typeNativeId;
    const roots = snapshot.elements.filter((element) =>
      element.ownerId === group.identity.systemId &&
      ["operatorFlowTemplate", "conversation"].includes(element.name) &&
      element.metaclass === "PerformActionUsage"
    );
    assert.equal(roots.length, 2);
    for (const root of roots) assert.deepEqual(root.typeIds, [definitionId]);
    assert.equal(
      roots.find((root) => root.name === "conversation")!.id,
      flow.rootNativeId,
    );
    assert.notEqual(flow.rootNativeId, definitionId);
    const command = commands[0]!;
    const declaration = snapshot.elements.find((element) =>
      element.id === command.nativeId
    );
    assert(declaration);
    assert.equal(declaration.ownerId, definitionId);
    assert.equal(declaration.name, "executeOperatorCommand");
    assert.equal(declaration.metaclass, "ActionUsage");
    const commandType = snapshot.elements.find((element) =>
      element.id === command.typeNativeId
    );
    assert(commandType);
    assert.equal(
      commandType.qualifiedName,
      "AssemblyConversation::ExecuteOperatorCommand",
    );
    assert(declaration.typeIds.includes(commandType.id));
    assert(group.version.sourceIds.includes(declaration.id));
    // Graph source.line is the native element ID, not a physical file line.
    assert.equal(command.source.native, true);
    assert.equal(command.source.line, declaration.id);
    assert(command.source.file);
    // Both new source templates reach the provider decision without a
    // declared model read. A retained legacy pin is covered separately by the
    // declared-model-consultation integration witness.
    for (const model of [scalar, group]) {
      assert.equal(model.operatorFlowTemplate?.revision, 2);
      assert.equal(
        model.flows.conversation.nodes.filter((node) =>
          node.mechanism === "consult_declared_source"
        ).length,
        0,
      );
      const calls: string[] = [];
      await executeFlow(model.flows.conversation, {}, (node) => {
        calls.push(node.mechanism!);
        if (node.mechanism === "read_case") return { outputs: { record: {} } };
        if (node.mechanism === "choose_move") {
          return { outputs: { choice: { kind: "reply" } } };
        }
        if (node.mechanism === "reply") return { outputs: { response: {} } };
        if (node.mechanism === "await_input") return { suspend: true };
        throw new Error(`Unexpected native mechanism ${node.mechanism}`);
      });
      assert.deepEqual(calls, [
        "read_case",
        "choose_move",
        "reply",
        "await_input",
      ]);
    }
    // Both source-selected profiles must route a completed command according to
    // its declared submission output, without guessing from the operator role.
    for (const model of [scalar, group]) {
      for (const awaitingInput of [true, false]) {
        const visited: string[] = [];
        let choices = 0;
        await executeFlow(model.flows.conversation, {}, (node) => {
          visited.push(node.mechanism!);
          switch (node.mechanism) {
            case "read_case":
              return { outputs: { record: {} } };
            case "choose_move":
              return {
                outputs: {
                  choice: {
                    kind: choices++ ? "reply" : "decide_operator_change",
                  },
                },
              };
            case "execute_operator_command":
              return {
                outputs: {
                  outcome: { succeeded: true },
                  submission: { awaitingInput },
                },
              };
            case "observe_outcome":
              return {};
            case "reply":
              return { outputs: { response: {} } };
            case "await_input":
              return { suspend: true };
            default:
              throw new Error(`Unexpected native mechanism ${node.mechanism}`);
          }
        });
        assert.equal(
          visited.filter((name) => name === "choose_move").length,
          awaitingInput ? 1 : 2,
        );
        assert.equal(visited.includes("observe_outcome"), !awaitingInput);
        assert.equal(visited.at(-1), "await_input");
      }
    }
  },
});

Deno.test({
  name:
    "real SysML edits change execution and permissions without changing the engine",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const original = await loadInitialSources(undefined, {
      information: false,
    });
    const compile = async (sources: Record<string, string>) =>
      await validateSourceExecutable({
        ...await compiler.compile(sources),
        version: "source-execution-proof",
      }, "git:90926ac5-a5d5-5c79-ba95-6eba338587e1");

    const baseline = await compile(original);
    assert.equal(baseline.policy.maxFlowSteps, 128);
    assert.ok(
      baseline.contracts.every((contract) =>
        contract.nativeId &&
        baseline.version.sourceIds.includes(contract.nativeId)
      ),
    );
    assert.equal(
      baseline.flows.conversation.nodes.some((node) =>
        node.name === "executionPolicy"
      ),
      false,
    );
    const admitted: string[] = [];
    assert.equal((await runPromotion(baseline, admitted)).status, "completed");
    assert.deepEqual(admitted, [
      "propose_candidate",
      "test_candidate",
      "decide_admission",
      "activate_candidate",
    ]);

    const changedGuard = {
      ...original,
      "configuration.sysml": original["configuration.sysml"].replace(
        "if test.result.passed then admit;",
        "if false then admit;",
      ),
    };
    assert.notEqual(
      changedGuard["configuration.sysml"],
      original["configuration.sysml"],
    );
    const rejected = await compile(changedGuard);
    const refused: string[] = [];
    await runPromotion(rejected, refused);
    assert.deepEqual(refused, [
      "propose_candidate",
      "test_candidate",
      "refuse_candidate",
    ]);
    assert.notEqual(rejected.version.digest, baseline.version.digest);

    const changedAssertion = {
      ...original,
      "configuration.sysml": original["configuration.sysml"].replace(
        "decision.admitted implies tests.passed and",
        "decision.admitted implies not tests.passed and",
      ),
    };
    assert.notEqual(
      changedAssertion["configuration.sysml"],
      original["configuration.sysml"],
    );
    const assertionModel = await compile(changedAssertion);
    const assertionCalls: string[] = [];
    await assert.rejects(
      () => runPromotion(assertionModel, assertionCalls),
      /Native assertion failed/,
    );
    assert.equal(assertionCalls.includes("activate_candidate"), false);

    const changedPermission = {
      ...original,
      "configuration.sysml": original["configuration.sysml"].replace(
        "attribute :>> mayInvokeActiveCatalog = true;",
        "attribute :>> mayInvokeActiveCatalog = false;",
      ),
    };
    const restricted = await compile(changedPermission);
    assert.equal(baseline.mandate.mayInvoke, "active-catalog-only");
    assert.equal(restricted.mandate.mayInvoke, false);
    assert.notEqual(restricted.version.digest, baseline.version.digest);
    const builderSources = {
      ...original,
      "configuration.sysml": original["configuration.sysml"]
        .replace(
          'attribute admissionMode : String = "human";',
          'attribute admissionMode : String = "builder";',
        )
        .replace(
          "attribute :>> mayAdmit = false;",
          "attribute :>> mayAdmit = true;",
        ),
    };
    const builderModel = await compile(builderSources);
    const builderCalls: string[] = [];
    await runPromotion(builderModel, builderCalls);
    assert.deepEqual(builderCalls, admitted);
  },
});

Deno.test({
  name:
    "real reviewed SysML promotion executes explicit review and rejects invalid native evidence",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const original = await loadInitialSources(undefined, {
      information: false,
    });
    const [reviewer, promotion] = await Promise.all([
      Deno.readTextFile(
        new URL("../../models/configuration-reviewer.sysml", import.meta.url),
      ),
      Deno.readTextFile(
        new URL(
          "../../models/configuration-reviewed-promotion.sysml",
          import.meta.url,
        ),
      ),
    ]);
    const sources = {
      ...original,
      "configuration.sysml": original["configuration.sysml"]
        .replace(
          "part liveBuilder : ConversationSystem {",
          `${promotion}\npart liveBuilder : ConversationSystem {`,
        )
        .replace(
          'attribute admissionMode : String = "human";',
          'attribute admissionMode : String = "reviewer";',
        )
        .replace(
          "part admissionGate : CatalogAdmissionGate;",
          `part admissionGate : CatalogAdmissionGate;\n${
            reviewer.replace(
              "part reviewer : AssemblyLiveBuilder::IndependentReviewer;",
              'part reviewer : AssemblyLiveBuilder::IndependentReviewer { attribute operatorId : String = "reviewer-test"; attribute configuredName : String = "Native reviewer"; }',
            )
          }`,
        )
        .replace(
          "perform action promotion : CapabilityPromotion;",
          "perform action promotion : ReviewedCapabilityPromotion;",
        ),
    };
    const compile = async (input: Record<string, string>) =>
      await validateSourceExecutable({
        ...await compiler.compile(input),
        version: "reviewed-source-execution-proof",
      }, "git:c74d7dd3-c823-5799-a092-20d0e31993a9");
    const model = await compile(sources);
    const review = model.flows.promotion.nodes.find((node) =>
      node.mechanism === "review_candidate"
    )!;
    assert.equal(review.performerId, model.identity.reviewerId);
    assert.ok(model.version.sourceIds.includes(review.nativeId));
    assert.ok(model.version.sourceIds.includes(review.typeNativeId!));
    assert.ok(model.version.sourceIds.includes(review.allocationId!));
    assert.ok(
      model.flows.promotion.bindings.every((binding) =>
        model.version.sourceIds.includes(binding.nativeId)
      ),
    );
    const run = async (
      target: ExecutableModel,
      passed = true,
      approved = true,
      digest = "exact",
    ) => {
      const calls: string[] = [];
      const candidate = { digest: "exact" };
      await executeFlow(target.flows.promotion, {}, (node, inputs) => {
        calls.push(node.mechanism!);
        switch (node.mechanism) {
          case "propose_candidate":
            return { outputs: { candidate } };
          case "test_candidate":
            assert.equal(inputs.candidate, candidate);
            return { outputs: { result: { passed } } };
          case "review_candidate":
            assert.equal(node.performerId, target.identity.reviewerId);
            assert.equal(inputs.candidate, candidate);
            assert.deepEqual(inputs.tests, { passed: true });
            return {
              outputs: { decision: { approved, candidateDigest: digest } },
            };
          case "decide_admission":
            assert.deepEqual(inputs.review, {
              approved,
              candidateDigest: digest,
            });
            return {
              outputs: {
                decision: { admitted: true, candidateDigest: candidate.digest },
              },
            };
          case "activate_candidate":
          case "refuse_candidate":
            return {};
          default:
            throw new Error(`Unexpected reviewed mechanism ${node.mechanism}`);
        }
      });
      return calls;
    };
    assert.deepEqual(await run(model), [
      "propose_candidate",
      "test_candidate",
      "review_candidate",
      "decide_admission",
      "activate_candidate",
    ]);
    assert.deepEqual(await run(model, true, false), [
      "propose_candidate",
      "test_candidate",
      "review_candidate",
      "refuse_candidate",
    ]);
    assert.deepEqual(await run(model, false), [
      "propose_candidate",
      "test_candidate",
      "refuse_candidate",
    ]);
    await assert.rejects(
      () => run(model, true, true, "other"),
      /Native assertion failed after action/,
    );

    const changedGuard = {
      ...sources,
      "configuration.sysml": sources["configuration.sysml"].replace(
        "if review.decision.approved then admit;",
        "if false then admit;",
      ),
    };
    const guarded = await compile(changedGuard);
    assert.deepEqual(await run(guarded), [
      "propose_candidate",
      "test_candidate",
      "review_candidate",
      "refuse_candidate",
    ]);
    assert.notEqual(guarded.version.digest, model.version.digest);

    for (
      const [from, to, error] of [
        [
          "allocate promotion.review to reviewer;",
          "allocate promotion.review to builder;",
          /native primitive performer/,
        ],
        [
          "allocate promotion.review to reviewer;",
          "part otherReviewer : IndependentReviewer; allocate promotion.review to otherReviewer;",
          /native primitive performer/,
        ],
        [
          "allocate promotion.review to reviewer;",
          "allocate promotion.review to reviewer; allocate promotion.review to reviewer;",
          /ambiguous native primitive allocation/,
        ],
        [
          "bind admit.review = review.decision;",
          "",
          /reviewed evidence binding/,
        ],
        [
          "bind admit.review = review.decision;",
          "bind admit.review = admit.decision;",
          /reviewed evidence binding/,
        ],
      ] as const
    ) {
      await assert.rejects(() =>
        compile({
          ...sources,
          "configuration.sysml": sources["configuration.sysml"].replace(
            from,
            to,
          ),
        }), error);
    }
    await assert.rejects(() =>
      compile({
        ...sources,
        "configuration.sysml": sources["configuration.sysml"]
          .replace(
            "perform action promotion : ReviewedCapabilityPromotion;",
            "perform action promotion : CapabilityPromotion;",
          )
          .replace("allocate promotion.review to reviewer;", ""),
      }), /native executable flow promotion/);
  },
});
