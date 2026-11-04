import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { editPolicy } from "../fixtures/model-edit-mandate.ts";
/** Source contracts → normal workspace → exact provider transport double →
 * durable local memory. No model provider or application server is contacted. */
import assert from "node:assert/strict";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import type { PostgresTestDatabase } from "../support/postgres.ts";
import { createClaudeToolsFake } from "../support/claude-tools-fake.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import { ClaudeAgents } from "../../src/adapters/out/llm-providers/agents.ts";
import { ToolkitCompiler } from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";
import { type SourceModel } from "../../src/application/model/source-model.ts";
import { validateSourceExecutable } from "../../src/adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { DenoToolRunner } from "../../src/adapters/out/sandbox/runner.ts";
import type { ContextEvidenceReference } from "../../src/application/work/context/evidence.ts";
import type { MemoryGuidance } from "../../src/domain/memory/governed-memory-promotion.ts";
import type { ChatContext } from "../../src/application/work/conversation/chat-context.ts";
import type { ChatDecision } from "../../src/application/work/conversation/chat-decision.ts";
import type { Message } from "../../src/application/work/runtime/state.ts";

const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR");
const behaviors = [
  [
    "ReadEvidence",
    "APEContext::ReadContextEvidence",
    "APEContext::ContextEvidenceRequest",
  ],
  [
    "CaptureNote",
    "APEMemory::CaptureMemory",
    "APEMemory::CaptureMemoryRequest",
  ],
  ["RecallNotes", "APEMemory::RecallMemory", "APEMemory::RecallMemoryRequest"],
  ["ReviewNote", "APEMemory::ReviewMemory", "APEMemory::ReviewMemoryRequest"],
  [
    "WithdrawNote",
    "APEMemory::WithdrawMemory",
    "APEMemory::WithdrawMemoryRequest",
  ],
] as const;

async function informationSources() {
  const sources = await loadInitialSources(undefined, { information: false });
  sources["behavior-invocations.sysml"] = await Deno.readTextFile(
    new URL("../../models/behavior-invocations.sysml", import.meta.url),
  );
  sources["mission.sysml"] =
    `package QualificationWork { private import ScalarValues::*; package evidence { attribute value : Integer = 1; } }\n`;
  const declarations = `${editPolicy("QualificationWork::evidence", true)}
        part decisionContext : APEContext::DecisionContextPolicy {
            attribute :>> id = "qualified-context";
            attribute :>> revision = 1;
            attribute :>> recentMessages = 1;
            attribute :>> maxMessageCharacters = 512;
            attribute :>> maxCollectionItems = 4;
            attribute :>> maxContextCharacters = 250000;
        }
        part governedMemory : APEMemory::GovernedMemoryPolicy {
            attribute :>> id = "qualified-memory";
            attribute :>> revision = 1;
            attribute :>> allowedScopes = ${
    JSON.stringify(JSON.stringify(["modeling"]))
  };
            attribute :>> requireSourceRefs = true;
            attribute :>> requireKnownOutcome = true;
            attribute :>> maxValidityMs = 86400000;
            attribute :>> allowSelfAdmission = true;
        }
        part designGuidance : APEContext::ModelingGuidance {
            attribute :>> id = "qualification-advice";
            attribute :>> revision = 1;
            attribute :>> content = "Separate observation, candidate guidance and admitted guidance.";
        }
${
    behaviors.map(([name, action, input]) => `
        perform action ${name}Entry : ${action};
        allocate ${name}Entry to admissionGate;
        part ${name}Access : AssemblyInvocations::BehaviorAccess {
            attribute :>> name = "${name}";
            attribute :>> description = "Local information operation ${name}.";
            attribute :>> enabled = true;
            ref item :>> input : ${input};
        }
        bind ${name}Access.caller = builder;
        bind ${name}Access.target = ${name}Entry;
`).join("")
  }
`;
  sources["configuration.sysml"] = sources["configuration.sysml"].replace(
    "part liveBuilder : ConversationSystem {",
    `part liveBuilder : ConversationSystem {${declarations}`,
  );
  return sources;
}

function invoke(
  context: ChatContext,
  name: string,
  input: Record<string, unknown>,
): ChatDecision {
  const matches =
    context.modeledBehaviors?.filter((behavior) => behavior.name === name) ??
      [];
  assert.equal(matches.length, 1, `Expected exact admitted ${name} behavior`);
  return {
    kind: "invoke_behavior",
    behaviorId: matches[0]!.id,
    inputJson: JSON.stringify(input),
    text: `Request the admitted ${name} operation.`,
  };
}

function lastObservation(context: ChatContext): Record<string, unknown> {
  const observation = [...context.messages].reverse().find((message) =>
    message.observation
  )?.observation;
  assert(observation, "Expected a recorded native observation");
  assert(observation.value && typeof observation.value === "object");
  return observation.value as Record<string, unknown>;
}

Deno.test({
  name:
    "adding uninstantiated information definitions preserves the historical executable digest and rights",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const source = await loadInitialSources(undefined, { information: false });
    assert(source["context.sysml"] && source["memory.sysml"]);
    const historical = { ...source };
    delete historical["context.sysml"];
    delete historical["memory.sysml"];
    const compiler = new ToolkitCompiler({ packageDir: packageDir! });
    const compile = async (sources: Record<string, string>) =>
      await validateSourceExecutable({
        ...await compiler.compile(sources),
        version: "uninstantiated-library-proof",
      }, "git:d57fab5d-e2ba-5683-82a0-7b5d2f3d56a1");
    const before = await compile(historical);
    const after = await compile(source);
    assert.equal(after.version.digest, before.version.digest);
    assert.deepEqual(after.version.sourceIds, before.version.sourceIds);
    assert.deepEqual(after.mandate, before.mandate);
    assert.deepEqual(after.policy, before.policy);
    assert.deepEqual(after.behaviors, before.behaviors);
    assert.deepEqual(after.operatorEntries, before.operatorEntries);
    assert.equal(after.contextPolicy, undefined);
    assert.equal(after.memoryPolicy, undefined);
    assert.equal(after.modelingGuidance, undefined);
  },
});

Deno.test({
  name:
    "normal native information operations preserve evidence and govern durable guidance across restart",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const directory = await Deno.makeTempDir({
      prefix: "ase-information-execution-",
    });
    let current: {
      service: SystemRuntime;
      postgres: Awaited<ReturnType<typeof openPostgresRuntimeFixture>>;
      model: SourceModel;
      workspace: Awaited<ReturnType<typeof openOperatorWorkspace>>;
    } | undefined;
    let database: PostgresTestDatabase | undefined;
    try {
      const sources = await informationSources();
      let repository: Awaited<
        ReturnType<typeof openPostgresRuntimeFixture>
      >["repository"];
      let phase = "seed", step = 0;
      let proposalId = "";
      let evidenceReference: ContextEvidenceReference;
      let candidate: Pick<MemoryGuidance, "revision" | "digest">;
      const noteText =
        "Consult the exact recorded result before promoting an observation into reusable guidance.";
      const seedText = ("Evidence qualification payload: " +
        "exact durable evidence; ".repeat(300)).trimEnd();
      const changedGuidance =
        "Inspect the exact scoped evidence before proposing reusable guidance.";
      const captured: Array<
        { phase: string; context: ChatContext; wire: Record<string, unknown> }
      > = [];
      let transportFailure: unknown;
      const fake = createClaudeToolsFake((view) => {
        try {
          assert.equal(
            view.url,
            "https://api.anthropic.com/v1/messages",
          );
          const context = view.context as unknown as ChatContext;
          captured.push({
            phase,
            context: structuredClone(context),
            wire: view.body as unknown as Record<string, unknown>,
          });
          assert(
            context.contextEvidence,
            "The source policy must reach the actual provider boundary",
          );
          assert.equal(context.contextEvidence.policy.recentMessages, 1);
          assert(JSON.stringify(context).length <= 250_000);
          assert.deepEqual(
            context.mandate,
            current!.service.snapshot.executionModel!.mandate,
          );
          assert.equal(
            context.modelVersion!.digest,
            current!.service.snapshot.executionModel!.version.digest,
          );
          assert.equal(
            context.admittedModelVersion!.digest,
            context.modelVersion!.digest,
          );
          assert.equal(
            context.modelingGuidance![0]!.id,
            "qualification-advice",
          );
          assert(
            context.sourceProposals!.some((proposal) =>
              proposal.id === proposalId && proposal.status === "proposed"
            ),
          );
          assert.equal(context.activeTools.length, 0);
          assert.equal(context.modeledBehaviors!.length, behaviors.length);
          let result: ChatDecision;
          const first = step++ === 0;
          if (phase === "seed") {
            result = {
              kind: "reply",
              text:
                "The observation is recorded; no guidance has been admitted.",
            };
          } else if (phase === "evidence") {
            if (first) {
              assert(
                !context.messages.some((message) =>
                  message.id === evidenceMessage.id
                ),
              );
              assert(
                context.contextEvidence.originalMessageCharacters >
                  context.contextEvidence.projectedMessageCharacters,
              );
              const reference = context.contextEvidence.references.find((
                reference,
              ) => reference.messageId === evidenceMessage.id)!;
              assert(reference.reasons.includes("history"));
              evidenceReference = reference;
              result = invoke(context, "ReadEvidence", {
                messageId: reference.messageId,
                messageDigest: reference.messageDigest,
              });
            } else {
              const observation = lastObservation(context);
              const actual = observation.result as {
                reference: ContextEvidenceReference;
                message: Message;
              };
              assert.deepEqual(
                actual.reference.messageDigest,
                evidenceReference.messageDigest,
              );
              assert.deepEqual(actual.message, evidenceMessage);
              assert.equal(actual.message.text, seedText);
              assert(
                context.messages.some((message) =>
                  message.observation?.kind === "context-evidence"
                ),
              );
              result = {
                kind: "reply",
                text:
                  "The exact historical evidence was read without truncation.",
              };
            }
          } else if (phase === "capture") {
            assert.deepEqual(context.memoryGuidance, []);
            if (first) {
              const observed = [...current!.service.snapshot.messages]
                .reverse()
                .find((message) =>
                  message.observation?.kind === "context-evidence"
                )!;
              assert(observed.execution?.actionId);
              result = invoke(context, "CaptureNote", {
                id: "qualified-note",
                contentJson: JSON.stringify({
                  text: noteText,
                  origin: {
                    decisionId: originatingDecision.id,
                    sourceRefs: [`message:${originatingDecision.id}`],
                  },
                  scope: ["modeling"],
                  validUntil: new Date(Date.now() + 3_600_000).toISOString(),
                  outcome: {
                    status: "known",
                    summary:
                      "The requested local evidence was returned intact.",
                    evidenceRefs: [`message:${observed.id}`],
                  },
                }),
              });
            } else {
              const receipt = lastObservation(context).result as {
                memory: MemoryGuidance;
              };
              assert.equal(receipt.memory.status, "candidate");
              assert.equal(receipt.memory.usableAsGuidance, false);
              candidate = {
                revision: receipt.memory.revision,
                digest: receipt.memory.digest,
              };
              result = {
                kind: "reply",
                text: "Captured candidate remains unadmitted.",
              };
            }
          } else if (phase === "recall-candidate") {
            assert.deepEqual(context.memoryGuidance, []);
            if (first) {
              result = invoke(context, "RecallNotes", {
                id: "qualified-note",
              });
            } else {
              const { memories } = lastObservation(context).result as {
                memories: MemoryGuidance[];
              };
              assert.equal(memories.length, 1);
              assert.equal(memories[0]!.content.text, noteText);
              assert.equal(memories[0]!.status, "candidate");
              assert.equal(memories[0]!.usableAsGuidance, false);
              result = {
                kind: "reply",
                text: "Recall did not promote the candidate.",
              };
            }
          } else if (phase === "admit") {
            if (first) {
              assert.deepEqual(context.memoryGuidance, []);
              result = invoke(context, "ReviewNote", {
                id: "qualified-note",
                expectedRevision: candidate!.revision,
                expectedDigest: candidate!.digest,
                decision: "admit",
                reason:
                  "The modeled source and outcome conditions have recorded evidence.",
              });
            } else {
              assert.equal(context.memoryGuidance!.length, 1);
              assert.equal(
                context.memoryGuidance![0]!.content.text,
                noteText,
              );
              assert.equal(context.memoryGuidance![0]!.status, "admitted");
              assert.equal(
                context.memoryGuidance![0]!.usableAsGuidance,
                true,
              );
              result = {
                kind: "reply",
                text:
                  "Exact admitted guidance is available to the next decision.",
              };
            }
          } else if (phase === "withdraw") {
            if (first) {
              const admitted = context.memoryGuidance![0]!;
              assert.equal(admitted.status, "admitted");
              result = invoke(context, "WithdrawNote", {
                id: admitted.id,
                expectedRevision: admitted.revision,
                expectedDigest: admitted.digest,
                reason: "Explicit modeled withdrawal for qualification.",
              });
            } else {
              assert.deepEqual(context.memoryGuidance, []);
              const receipt = lastObservation(context).result as {
                memory: MemoryGuidance;
              };
              assert.equal(receipt.memory.status, "withdrawn");
              assert.equal(receipt.memory.revision, 3);
              result = {
                kind: "reply",
                text: "Withdrawal removed the note from current guidance.",
              };
            }
          } else if (phase === "restart-recall") {
            assert.deepEqual(context.memoryGuidance, []);
            if (first) {
              result = invoke(context, "RecallNotes", {
                id: "qualified-note",
              });
            } else {
              const { memories } = lastObservation(context).result as {
                memories: MemoryGuidance[];
              };
              assert.equal(memories[0]!.status, "withdrawn");
              assert.equal(memories[0]!.revision, 3);
              assert.equal(memories[0]!.historyLength, 3);
              assert.equal(memories[0]!.usableAsGuidance, false);
              assert.equal(memories[0]!.content.text, noteText);
              result = {
                kind: "reply",
                text: "The withdrawn state survived restart.",
              };
            }
          } else if (phase === "stale-admission") {
            assert.deepEqual(context.memoryGuidance, []);
            if (first) {
              result = invoke(context, "ReviewNote", {
                id: "qualified-note",
                expectedRevision: candidate!.revision,
                expectedDigest: candidate!.digest,
                decision: "admit",
                reason:
                  "Attempt using the original candidate revision after withdrawal.",
              });
            } else {
              const failure = lastObservation(context);
              assert.equal(failure.code, "BEHAVIOR_RESULT_UNCONFIRMED");
              assert.match(
                String(failure.details),
                /revision|digest|withdrawn|candidate/i,
              );
              result = {
                kind: "reply",
                text: "A stale admission cannot revive withdrawn guidance.",
              };
            }
          } else if (phase === "adopted-policy") {
            assert.equal(
              context.contextEvidence.policy.maxMessageCharacters,
              1024,
            );
            assert.equal(
              context.modelingGuidance![0]!.content,
              changedGuidance,
            );
            assert.deepEqual(context.memoryGuidance, []);
            result = {
              kind: "reply",
              text: "The explicitly adopted information policy is now applied.",
            };
          } else throw new Error(`Unexpected qualification phase ${phase}`);
          return {
            decision: result,
            id: `qualification-${captured.length}`,
            model: "qualification-transport-double",
          };
        } catch (error) {
          transportFailure = error;
          throw error;
        }
      });
      const agent: ClaudeAgents = new ClaudeAgents({
        apiKey: "qualification-no-provider",
        model: "qualification-transport-double",
        fetch: fake.fetch,
      });
      const open = async (): Promise<NonNullable<typeof current>> => {
        const postgres = await openPostgresRuntimeFixture({
          dataDir: directory,
          database,
          ...(database ? {} : { sources }),
        });
        database = postgres.database;
        repository = postgres.repository;
        const model = postgres.backend.model;
        const store = postgres.primary.state;
        const executors: BehaviorInvocationPort[] = [];
        let information: DecisionInformationPort | undefined;
        const service = new SystemRuntime({
          ...postgres.runtimePorts,
          agents: agent,
          model,
          store,
          runner: new DenoToolRunner(),
          behaviors: new BehaviorInvocationRegistry(executors),
          information: {
            async read(model, messages) {
              assert(information, "Workspace information is not initialized");
              return await information.read(model, messages);
            },
            async consultModel(model, input, messages) {
              assert(information?.consultModel);
              return await information.consultModel(model, input, messages);
            },
            async consultAdmittedModelSource(model, input, messages, budget) {
              assert(information?.consultAdmittedModelSource);
              return await information.consultAdmittedModelSource(
                model,
                input,
                messages,
                budget,
              );
            },
          },
        });
        try {
          await service.initialize(undefined, {
            resumeContinuations: false,
            resumeCandidateContinuations: false,
          });
          const workspace = await openOperatorWorkspace({
            ...postgres.workspacePorts,
            createSourceModel: postgres.backend.createSourceModel,
            primaryHistory: store,
            tooling: postgres.backend.tooling,
            primary: service,
            primaryModel: model,
            repository,
            agents: agent,
            directory,
            executors,
          });
          information = workspace.information;
          await postgres.start(workspace);
          return { service, postgres, model, workspace };
        } catch (error) {
          await postgres.close();
          throw error;
        }
      };
      const close = async () => {
        await current?.postgres.close({ retainDatabase: true });
        current = undefined;
      };
      current = await open();
      repository = current.postgres.repository;
      const model = current.service.snapshot.executionModel!;
      assert(model.contextPolicy && model.memoryPolicy);
      assert.equal(model.operatorEntries!.length, behaviors.length);
      assert.equal(model.behaviors!.length, behaviors.length);
      assert.equal(
        current.workspace.conversations.snapshot.conversations.length,
        1,
      );
      const source = await repository.current();
      const proposal = await current.model.proposeRevision(model.identity, {
        baseVersion: source.version,
        reason:
          "A current proposed source record must remain visible under context separation.",
        sources: {
          "mission.sysml": source.sources["mission.sysml"]!.replace(
            "value : Integer = 1",
            "value : Integer = 2",
          ),
        },
      }, model.version.digest);
      proposalId = proposal.id;
      const submit = async (nextPhase: string, text: string) => {
        phase = nextPhase;
        step = 0;
        const conversation = current!.workspace.conversations.snapshot
          .conversations[0]!;
        const before = captured.length;
        await current!.workspace.conversations.submitHuman({
          agentId: conversation.agentId,
          text,
          expectedRevision: conversation.revision,
        });
        await current!.postgres.idle(current!.service);
        await current!.workspace.conversations.idle();
        await current!.postgres.idle();
        assert.equal(
          transportFailure instanceof Error
            ? transportFailure.stack
            : current!.service.snapshot.error,
          undefined,
          current!.service.snapshot.error,
        );
        assert.equal(
          captured.length - before,
          ["seed", "adopted-policy"].includes(nextPhase) ? 1 : 2,
          `Expected normal source flow decisions in ${nextPhase}`,
        );
      };
      await submit("seed", seedText);
      const evidenceMessage: Message = current.service.snapshot.messages.find((
        message,
      ) => message.role === "user" && message.text === seedText)!;
      const originatingDecision: Message = [
        ...current.service.snapshot.messages,
      ]
        .reverse()
        .find((message) =>
          message.role === "assistant" && message.execution?.actionId
        )!;
      assert(originatingDecision.execution?.actionId);
      await submit(
        "evidence",
        "Read the exact evidence from the previous request.",
      );
      assert.deepEqual(
        current.service.snapshot.messages.find((message) =>
          message.id === evidenceMessage.id
        ),
        evidenceMessage,
      );
      await submit(
        "capture",
        "Capture the observed result as candidate guidance.",
      );
      await submit(
        "recall-candidate",
        "Inspect the candidate without promoting it.",
      );
      await submit("admit", "Review the exact candidate for admission.");
      await submit("withdraw", "Withdraw the admitted guidance explicitly.");
      const messagesBeforeRestart = current.service.snapshot.messages;
      const callsBeforeRestart = captured.length;
      await close();
      current = await open();
      assert.equal(
        captured.length,
        callsBeforeRestart,
        "Restart must not replay an agent decision",
      );
      assert.deepEqual(
        current.service.snapshot.messages,
        messagesBeforeRestart,
      );
      await submit(
        "restart-recall",
        "Inspect the same persisted note after restart.",
      );
      await submit(
        "stale-admission",
        "Attempt the old candidate admission after withdrawal.",
      );
      const currentInformation = await current.workspace.information.read(
        current.service.snapshot.executionModel!,
      );
      assert.deepEqual(currentInformation.memoryGuidance, []);
      assert.deepEqual(currentInformation.modelSources!.sources, {});
      assert.equal(currentInformation.modelContext!.version, source.version);
      const readBack = await current.model.readExecutableModel(
        current.service.snapshot.model!,
      );
      assert.equal(readBack.version.digest, model.version.digest);
      assert.equal((await repository.current()).version, source.version);
      assert.equal(captured.length, 15);

      // This control publication qualifies HEAD versus executable adoption.
      // Proposal admission and concurrent source merging have their own tests.
      const changedSources = {
        ...source.sources,
        "configuration.sysml": source.sources["configuration.sysml"]
          .replace(
            "attribute :>> maxMessageCharacters = 512;",
            "attribute :>> maxMessageCharacters = 1024;",
          )
          .replace(
            "Separate observation, candidate guidance and admitted guidance.",
            changedGuidance,
          ),
      };
      assert.notEqual(
        changedSources["configuration.sysml"],
        source.sources["configuration.sysml"],
      );
      const changed = await repository.publishSystemSources(
        changedSources,
        source.version,
        "qualification-control",
      );
      const prospective = await current.model.readExecutableModel(
        model.identity,
      );
      assert.notEqual(prospective.version.digest, model.version.digest);
      assert.equal(prospective.contextPolicy!.maxMessageCharacters, 1024);
      assert.equal(prospective.modelingGuidance![0]!.content, changedGuidance);
      assert.equal(
        current.service.snapshot.executionModel!.version.digest,
        model.version.digest,
        "Publication must not replace the admitted execution contract",
      );

      const beforeAdoptionCalls = captured.length;
      await current.service.submit(
        "Use the newly published information policy.",
      );
      await current.postgres.idle(current.service);
      assert.match(current.service.snapshot.error!, /admission explicite/);
      assert.equal(captured.length, beforeAdoptionCalls);
      assert.equal(
        current.service.snapshot.executionModel!.version.digest,
        model.version.digest,
      );
      assert.equal(
        current.service.snapshot.availableExecutionModel!.version.digest,
        prospective.version.digest,
      );

      const command = {
        agentId: model.identity.builderId,
        expectedDigest: prospective.version.digest,
        expectedVersion: changed.version,
      };
      await current.workspace.adopt(
        command,
        () => current!.service.adoptModelVersion(command),
      );
      assert.equal(captured.length, beforeAdoptionCalls);
      assert.equal(
        current.service.snapshot.executionModel!.version.repositoryVersion,
        changed.version,
      );
      await submit("adopted-policy", "Use the explicitly adopted policy.");
      assert.equal(captured.length, beforeAdoptionCalls + 1);
      await close();
    } finally {
      try {
        await current?.postgres.close();
      } finally {
        await database?.close();
      }
      await Deno.remove(directory, { recursive: true });
    }
  },
});
