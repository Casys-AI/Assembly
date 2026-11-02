/** Native qualification composition: only the provider is scripted.
 * Owner setup uses the same exact-source proposal/queued acceptance as the app.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { openPostgresRuntimeFixture } from "../support/postgres-runtime-fixture.ts";
import { PostgresGovernedMemoryStore } from "../../src/adapters/out/postgres/memory-store.ts";
import { PostgresEvolutionStore } from "../../src/adapters/out/postgres/evolution-store.ts";
import { createModelProject } from "../../src/adapters/out/filesystem/model-project.ts";
import {
  validateSourceEvolutionExecutables,
  validateSourceExecutable,
} from "../../src/adapters/model/sources/source-model.ts";
import { buildEvolutionPolicyEdits } from "../support/evolution-policy/writer.ts";
import { NativeEvolutionSourceAssessment } from "../../src/adapters/model/evolution/assessment.ts";
import { NativeEvolutionAuthority } from "../../src/adapters/model/evolution/authority.ts";
import { createEvolutionSettingsPreflight } from "../../src/adapters/model/evolution/settings-preflight.ts";
import { WorkBudgetService } from "../../src/application/work/budget/service.ts";
import type {
  MemoryOperation,
  MemoryRecord,
} from "../../src/domain/memory/entities/memory-record.ts";
import { memoryContentDigest } from "../../src/domain/memory/governed-memory-promotion.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import type {
  ChatContext,
  ChatDecision,
} from "../../src/domain/work/dialogue.ts";
import type { EvolutionGrant } from "../../src/domain/model/evolution/policy.ts";
import { EVOLUTION_FLOW_MECHANISMS } from "../../src/domain/model/evolution/policy.ts";
import { exerciseOwnerAuthority } from "../../src/domain/governance/authority.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import type { ResolvedModelEdit } from "../../src/domain/model/editing/tooling.ts";
import { SystemRuntime } from "../../src/application/work/runtime/system.ts";
import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "../../src/application/work/behaviors/invocation.ts";
import { openOperatorWorkspace } from "../support/operator-workspace.ts";
import { editPolicy, mandateSources, nativeId } from "./model-edit-mandate.ts";
import { writeEvolutionProtectedDiagnostics } from "../support/evolution-protected-diagnostics.ts";

export const nativeEvolutionMain = "AssemblyLiveBuilder::liveBuilder";
export const nativeEvolutionPeer = "AssemblyLiveBuilder::mandatePeer";
export const privateEvolutionFlow =
  "AssemblyLiveBuilder::PrivateConversationV1";
export const nativeEvolutionNow = "2026-10-27T00:00:00.000Z";

/** Copy one real native definition, preserving all bindings and refusal edges. */
function actionDefinition(source: string, name: string): string {
  const start = source.indexOf(`action def ${name} {`);
  assert(start >= 0);
  const masked = source.replace(
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g,
    (text) => text.replace(/[^\n]/g, " "),
  );
  let end = masked.indexOf("{", start) + 1, depth = 1;
  while (depth && end < masked.length) {
    if (masked[end] === "{") depth++;
    if (masked[end] === "}") depth--;
    end++;
  }
  assert.equal(depth, 0);
  return source.slice(start, end);
}

interface NativeEvolutionFixtureOptions {
  /** Explicit source composition for the separate memory runtime witnesses. */
  memoryOperations?: true;
  /** Admit the existing consultation allocation before the private-flow edit. */
  consultingStartingContract?: true;
}

export async function nativeEvolutionSources(
  options: NativeEvolutionFixtureOptions = {},
): Promise<Sources> {
  const sources = await mandateSources({ ownSystem: true });
  const mainPolicy = editPolicy(nativeEvolutionMain);
  const extendedMainPolicy = mainPolicy.replace(
    JSON.stringify(
      JSON.stringify(["set-value", "rename", "insert-member", "remove"]),
    ),
    JSON.stringify(
      JSON.stringify([
        "set-value",
        "rename",
        "insert-member",
        "remove",
        "set-type",
        "retarget-reference",
      ]),
    ),
  );
  assert.notEqual(extendedMainPolicy, mainPolicy);
  assert(sources["configuration.sysml"]!.includes(mainPolicy));
  sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
    mainPolicy,
    extendedMainPolicy,
  );
  // Peer can ordinarily edit its own source, but has no evolution grant.
  // Its refusal therefore tests the separate evolution authority prerequisite.
  sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
    editPolicy("Work::beta"),
    editPolicy(nativeEvolutionPeer),
  );
  const declarations = `
  part EvolutionRequest : AssemblyCases::CaseType {
    attribute :>> envelope = AssemblyCases::EnvelopeKind::conversational;
    ref action :>> behavior = conversation;
    ref part :>> owner = builder;
    attribute :>> maxInvocations = 100;
  }
  part invocationBudget : APEWorkBudget::InvocationBudgetPolicy {
    attribute :>> id = "native-evolution-budget";
    attribute :>> revision = 1;
    attribute :>> unit = "agent-invocation";
    attribute :>> limit = 100;
    attribute :>> onExhausted = "wait";
    attribute :>> exhaustionRecipient = "local-control";
  }
  part contextPolicy : APEContext::DecisionContextPolicy {
    attribute :>> id = "native-evolution-context";
    attribute :>> revision = 1;
    attribute :>> recentMessages = 20;
    attribute :>> maxMessageCharacters = 4096;
    attribute :>> maxCollectionItems = 32;
    attribute :>> maxContextCharacters = 1000000;
  }
  part memoryPolicy : APEMemory::GovernedMemoryPolicy {
    attribute :>> id = "native-evolution-memory";
    attribute :>> revision = 1;
    attribute :>> allowedScopes = "[\\"local\\"]";
    attribute :>> requireSourceRefs = false;
    attribute :>> requireKnownOutcome = false;
    attribute :>> maxValidityMs = 86400000;
    attribute :>> allowSelfAdmission = false;
  }
${
    options.memoryOperations
      ? ([
        ["CaptureNote", "CaptureMemory", "CaptureMemoryRequest"],
        ["RecallNotes", "RecallMemory", "RecallMemoryRequest"],
      ] as const).map(([name, action, input]) => `
  perform action ${name}Entry : APEMemory::${action};
  allocate ${name}Entry to admissionGate;
  part ${name}Access : AssemblyInvocations::BehaviorAccess {
    attribute :>> name = "${name}";
    attribute :>> description = "Local memory runtime witness ${name}.";
    attribute :>> enabled = true;
    ref item :>> input : APEMemory::${input};
  }
  bind ${name}Access.caller = builder;
  bind ${name}Access.target = ${name}Entry;
`).join("")
      : ""
  }`;
  const marker = "part liveBuilder : ConversationSystem {";
  sources["configuration.sysml"] = sources["configuration.sysml"]!.replace(
    marker,
    marker + declarations,
  );
  const originalDefinition = actionDefinition(
    sources["conversation.sysml"]!,
    "ImmutableGroupConversationV1",
  );
  // The private definition keeps a declared read with its modeled outcomes.
  // The selected default revision 2 remains free of that read unless this
  // fixture explicitly admits the customized consulting starting contract.
  assert(
    originalDefinition.includes("first readCaseState then chooseNextMove;"),
  );
  const consultingDefinition = originalDefinition.replace(
    "action chooseNextMove : ChooseNextMove;",
    `action consultDeclaredSource : ConsultDeclaredModelSource {
            attribute consultationRequest : String = "{\\"operation\\":\\"read_source\\",\\"path\\":\\"conversation.sysml\\"}";
        }
        action chooseNextMove : ChooseNextMove;`,
  ).replace(
    "first readCaseState then chooseNextMove;",
    `first readCaseState then consultDeclaredSource;
        first consultDeclaredSource then consultationOutcome;
        decide consultationOutcome;
            if consultDeclaredSource.consultation.succeeded then chooseNextMove;
            else awaitingContribution;`,
  );
  const definition = consultingDefinition.replace(
    "action def ImmutableGroupConversationV1",
    "action def PrivateConversationV1",
  );
  if (options.consultingStartingContract) {
    sources["conversation.sysml"] = sources["conversation.sysml"]!.replace(
      originalDefinition,
      consultingDefinition,
    );
    const allocation = "allocate conversation.readCaseState to admissionGate;";
    assert.equal(
      sources["configuration.sysml"]!.split(allocation).length - 1,
      2,
    );
    sources["configuration.sysml"] = sources["configuration.sysml"]!.replaceAll(
      allocation,
      allocation +
        "\n        allocate conversation.consultDeclaredSource to admissionGate;",
    );
  }
  const close = sources["configuration.sysml"]!.lastIndexOf("\n}");
  assert(close > 0);
  sources["configuration.sysml"] =
    sources["configuration.sysml"]!.slice(0, close) +
    `\n ${definition}\n` + sources["configuration.sysml"]!.slice(close);
  return sources;
}

export async function openNativeEvolutionFixture(
  options: NativeEvolutionFixtureOptions = {},
) {
  assert(
    !Deno.env.get("ASSEMBLY_MODEL_PROJECT_DIR") &&
      !Deno.env.get("ASE_MODEL_PROJECT_DIR"),
  );
  const directory = await Deno.makeTempDir({
    prefix: "assembly-native-evolution-",
  });
  console.error(`Native evolution qualification fixture: ${directory}`);
  const qualificationEpoch = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const preserveSuccess =
    Deno.env.get("ASSEMBLY_PRESERVE_EVOLUTION_EVIDENCE") === "1";
  await Deno.writeTextFile(
    join(directory, "qualification-run.json"),
    JSON.stringify(
      {
        kind: "assembly-native-evolution-qualification/v1",
        qualificationEpoch,
        startedAt,
        pid: Deno.pid,
        selectedCategory: Deno.env.get("ASSEMBLY_EVOLUTION_CATEGORY") ?? null,
        preserveSuccess,
        ...(options.memoryOperations ? { memoryOperations: true } : {}),
      },
      null,
      2,
    ),
  );
  let diagnosticPath: string | undefined;
  let retainEvidence = preserveSuccess;
  const dataDir = join(directory, "instance");
  await createModelProject({
    root: dataDir,
    name: "model-project",
    sources: await nativeEvolutionSources(options),
  });
  const postgres = await openPostgresRuntimeFixture({ dataDir });
  const backend = postgres.backend;
  let fixtureReady = false;
  try {
    const identity = await backend.model.initialize();
    const original = await backend.model.readExecutableModel(identity);
    const ownerPublish = async (sources: Sources, reason: string) => {
      const before = await backend.repository.current();
      const owner = exerciseOwnerAuthority(
        await validateSourceExecutable(before, backend.projectId),
        "model-revision",
      );
      const proposal = await backend.repository.propose({
        baseVersion: before.version,
        sources,
        author: "local-owner",
        reason,
        authorization: { kind: "local-owner", authorityExercise: owner },
      });
      const accepted = await backend.repository.accept({
        id: proposal.id,
        expectedVersion: before.version,
        author: "local-owner",
        decisionAuthorityExercise: owner,
      });
      const queued = await backend.queue.get(backend.project.id, proposal.id);
      assert.equal(queued?.state, "published");
      return accepted;
    };
    const head = await backend.repository.current();
    const target = original.identity.builderId;
    const contract = original.contracts.find((entry) =>
      entry.kind === "read_web_page"
    )!;
    assert(contract);
    const recall = options.memoryOperations
      ? original.behaviors?.find((behavior) => behavior.name === "RecallNotes")
      : undefined;
    if (options.memoryOperations) {
      assert(
        recall,
        "The memory witness requires its exact native RecallNotes exposure",
      );
      assert.equal(recall.callerNativeId, target);
      assert(
        original.behaviors?.some((behavior) => behavior.name === "CaptureNote"),
      );
    }
    const bounds: Array<Omit<EvolutionGrant, "act" | "targetNativeId">> = [
      { category: "instructions", bounds: { maxCharacters: 4096 } },
      {
        category: "budgets",
        bounds: {
          fields: {
            maxAgentDecisions: { min: 1, max: 32 },
            workBudgetLimit: { min: 0, max: 200 },
          },
          caseTypes: [],
        },
      },
      {
        category: "context",
        bounds: { fields: { recentMessages: { min: 1, max: 100 } } },
      },
      {
        category: "memory",
        bounds: { fields: { maxValidityMs: { min: 1, max: 172800000 } } },
      },
      {
        category: "contracts",
        bounds: {
          contractNativeIds: [
            contract.nativeId,
            ...(recall ? [recall.id] : []),
          ],
          inputTypeNativeIds: recall ? [recall.inputTypeId] : [],
          allowedExposures: recall
            ? [{
              callerNativeId: recall.callerNativeId,
              targetNativeId: recall.targetNativeId,
              inputTypeId: recall.inputTypeId,
            }]
            : [],
        },
      },
      {
        category: "flow",
        bounds: {
          rootNativeIds: [
            original.flows.conversation.rootNativeId,
            // The creator's template is a separate Main occurrence of the same
            // definition. This fixture grants it explicitly before preparation.
            nativeId(head, `${nativeEvolutionMain}::operatorFlowTemplate`),
            nativeId(head, privateEvolutionFlow),
          ],
          allowedMechanisms: [...EVOLUTION_FLOW_MECHANISMS],
          maxNodes: 128,
          maxEdges: 256,
        },
      },
    ];
    const grants = bounds.flatMap((bound) =>
      (["prepare", "accept", "adopt"] as const).map((act) => ({
        ...bound,
        act,
        targetNativeId: target,
      } as EvolutionGrant))
    );
    const edits: ResolvedModelEdit[] = buildEvolutionPolicyEdits(
      head,
      identity,
      {
        id: "native-evolution",
        expectedRevision: 0,
        grants,
      },
    );
    const changed = await backend.tooling.edit(head.sources, edits);
    await ownerPublish(
      changed.sources,
      "Human grants bounded evolution; Peer receives no grant",
    );
    const admitted = await backend.model.readExecutableModel(identity);
    // Retained historical notes are fixture input, not fabricated runtime results.
    // Their native owner, policy and capture definition all come from compilation.
    const memoryStore = new PostgresGovernedMemoryStore(
      postgres.storage.client,
      postgres.primary.scope,
    );
    const retainedMemory: MemoryRecord[] = [];
    try {
      for (
        const [status, operation] of [
          ["candidate", "capture"],
          ["admitted", "admit"],
          ["rejected", "reject"],
          ["revision-requested", "request-revision"],
          ["withdrawn", "withdraw"],
        ] as const
      ) {
        const content: MemoryRecord["content"] = {
          text: `Historical ${status} guidance`,
          origin: { decisionId: `historical-${status}`, sourceRefs: [] },
          scope: ["local"],
          validUntil: "2026-10-27T12:00:00.000Z",
          outcome: { status: "pending" },
        };
        const digest = await memoryContentDigest(target, content);
        const operations: MemoryOperation[] = operation === "capture"
          ? ["capture"]
          : ["capture", operation];
        const history: MemoryRecord["history"] = operations.map((
          operation,
          index,
        ) => ({
          operation,
          callerId: target,
          behaviorId: nativeId(head, "APEMemory::CaptureMemory"),
          invocationId: `historical-${status}-${index}`,
          modelVersion: {
            digest: admitted.version.digest,
            repositoryVersion: admitted.version.repositoryVersion!,
          },
          policyId: admitted.memoryPolicy!.id,
          requestDigest: digest,
          at: nativeEvolutionNow,
          revision: index + 1,
          digest,
          status: index === 0 ? "candidate" : status,
          content,
        }));
        const record: MemoryRecord = {
          id: `retained-${status}`,
          ownerId: target,
          contributorId: target,
          revision: history.length,
          digest,
          content,
          status,
          createdAt: nativeEvolutionNow,
          updatedAt: nativeEvolutionNow,
          history,
        };
        // Replay valid historical transitions through the store's real CAS checks.
        for (let index = 0; index < history.length; index++) {
          await memoryStore.save({
            ...record,
            revision: index + 1,
            status: history[index]!.status,
            history: history.slice(0, index + 1),
          }, index === 0 ? null : { revision: index, digest });
        }
        retainedMemory.push(record);
      }
    } finally {
      await memoryStore.close();
    }
    const evolutionStore = new PostgresEvolutionStore(
      postgres.storage.client,
      postgres.storage.scope,
    );
    const store = postgres.primary.state;
    const ledger = postgres.primary.budget;
    const workBudget = new WorkBudgetService(ledger);
    let script: (context: ChatContext) => ChatDecision = () => ({
      kind: "reply",
      text: "Completed bounded contribution.",
    });
    const contexts: ChatContext[] = [];
    let failure: unknown;
    const agents: AgentPort = {
      label: "native-evolution-script",
      decide(context) {
        contexts.push(structuredClone(context));
        try {
          return Promise.resolve(script(context));
        } catch (error) {
          failure = error;
          throw error;
        }
      },
      review() {
        throw new Error("No provider review is authorized");
      },
    };
    const reader: { current?: DecisionInformationPort } = {};
    const consultationDiagnostics: Array<
      { stage: "read" | "consult"; outcome: "returned" } | {
        stage: "read" | "consult";
        outcome: "threw";
        code?: string;
        message: string;
      }
    > = [];
    let consultationDiagnosticsOmitted = 0;
    const observeInformation = async <T>(
      stage: "read" | "consult",
      operation: () => Promise<T>,
    ): Promise<T> => {
      const record = (entry: typeof consultationDiagnostics[number]) => {
        if (consultationDiagnostics.length === 20) {
          consultationDiagnostics.shift();
          consultationDiagnosticsOmitted++;
        }
        consultationDiagnostics.push(entry);
      };
      try {
        const result = await operation();
        record({ stage, outcome: "returned" });
        return result;
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error &&
            typeof error.code === "string"
          ? error.code.slice(0, 128)
          : undefined;
        record({
          stage,
          outcome: "threw",
          ...(code ? { code } : {}),
          message: (error instanceof Error ? error.message : String(error))
            .slice(0, 2048),
        });
        throw error;
      }
    };
    const executors: BehaviorInvocationPort[] = [];
    const primary = new SystemRuntime({
      ...postgres.runtimePorts,
      model: backend.model,
      store,
      agents,
      ...(options.memoryOperations
        ? { behaviors: new BehaviorInvocationRegistry(executors) }
        : {}),
      workBudget,
      clock: { now: () => nativeEvolutionNow },
      runner: {
        run() {
          throw new Error("No network");
        },
        test() {
          throw new Error("No generated tool");
        },
      },
      information: {
        read: (model, messages) =>
          observeInformation(
            "read",
            () => reader.current!.read(model, messages),
          ),
        consultModel: (model, input, messages, budget) =>
          observeInformation(
            "consult",
            () => reader.current!.consultModel!(model, input, messages, budget),
          ),
        consultAdmittedModelSource: (model, input, messages, budget) =>
          observeInformation(
            "consult",
            () =>
              reader.current!.consultAdmittedModelSource!(
                model,
                input,
                messages,
                budget,
              ),
          ),
      },
    });
    await primary.initialize(undefined, {
      resumeContinuations: false,
      resumeCandidateContinuations: false,
    });
    const workspace = await openOperatorWorkspace({
      ...postgres.workspacePorts,
      primary,
      primaryModel: backend.model,
      primaryHistory: store,
      repository: backend.repository,
      tooling: backend.tooling,
      createSourceModel: backend.createSourceModel,
      agents,
      workBudget,
      directory,
      executors,
      clock: { now: () => nativeEvolutionNow },
      evolutionFactory(context) {
        const validateSettings = createEvolutionSettingsPreflight({
          context,
          store: evolutionStore,
          repositoryId: backend.project.id,
        });
        const assessment = new NativeEvolutionSourceAssessment({
          projectId: backend.projectId,
          validateSettings,
        });
        const diagnosticAssessment = {
          async authorizePreparation(
            input: Parameters<
              NativeEvolutionSourceAssessment["authorizePreparation"]
            >[0],
          ) {
            try {
              return await assessment.authorizePreparation(input);
            } catch (error) {
              if (
                error instanceof Error &&
                error.message.includes(
                  "Protected or unclassified executable effect",
                )
              ) {
                diagnosticPath = await writeEvolutionProtectedDiagnostics({
                  directory,
                  before: await validateSourceEvolutionExecutables(
                    input.before,
                    backend.projectId,
                  ),
                  after: await validateSourceEvolutionExecutables({
                    ...input.after,
                    version: "unpublished-evolution-assessment",
                  }, backend.projectId),
                });
              }
              throw error;
            }
          },
        };
        return Promise.resolve({
          repositoryId: backend.project.id,
          store: evolutionStore,
          authority: new NativeEvolutionAuthority({
            projectId: backend.projectId,
            repository: backend.repository,
            validateSettings,
          }),
          repository: backend.createEvolutionRepository(
            diagnosticAssessment,
          ),
        });
      },
    });
    reader.current = workspace.information;
    await postgres.start(workspace);
    let workspaceClosed = false;
    const turn = async (
      decisions: ChatDecision[] | ((context: ChatContext) => ChatDecision),
      text = "Perform the next bounded step",
      scope: { caseId?: string; newConversation?: true } = {},
    ) => {
      const queue = Array.isArray(decisions) ? [...decisions] : undefined;
      script = typeof decisions === "function"
        ? decisions
        : () =>
          queue!.shift() ??
            { kind: "reply", text: "Completed bounded contribution." };
      failure = undefined;
      const caseId = await primary.submit(
        text,
        undefined,
        scope.caseId,
        scope.newConversation,
      );
      await postgres.idle(primary);
      if (failure) throw failure;
      assert.equal(primary.snapshot.error, undefined);
      assert.equal(
        queue?.length ?? 0,
        0,
        "Every requested command must actually execute",
      );
      return caseId;
    };
    const captureEvidence = async (label: string) => {
      assert(/^[a-z0-9_-]+$/i.test(label));
      const dossiers = await evolutionStore.listRecent(backend.project.id, 256);
      const source = await backend.repository.current();
      const nativeEpochs: Array<{ pid: number; processEpoch: string }> = [];
      let nativeEpochDiagnostic: string | undefined;
      try {
        // Inspect only this fixture process's own children. Never retain complete
        // process arguments or enumerate unrelated application processes.
        const children = await new Deno.Command("/usr/bin/pgrep", {
          args: ["-P", String(Deno.pid)],
          stdout: "piped",
          stderr: "null",
        }).output();
        const pids = new TextDecoder().decode(children.stdout).trim().split(
          /\s+/,
        )
          .filter((pid) => /^[0-9]+$/.test(pid)).slice(0, 64);
        for (const pid of pids) {
          const process = await new Deno.Command("/bin/ps", {
            args: ["-p", pid, "-o", "command="],
            stdout: "piped",
            stderr: "null",
          }).output();
          const command = new TextDecoder().decode(process.stdout);
          if (!command.includes("/sysml-toolkit/worker.ts")) continue;
          const epoch = /(?:^|\s)--epoch=([A-Za-z0-9-]+)/.exec(command)?.[1];
          if (epoch) {
            nativeEpochs.push({ pid: Number(pid), processEpoch: epoch });
          }
        }
        if (!nativeEpochs.length) {
          nativeEpochDiagnostic =
            "No exact Toolkit worker epoch observed among this fixture's live child processes";
        }
      } catch (error) {
        nativeEpochDiagnostic = error instanceof Error
          ? error.message
          : "Own-child process epoch unavailable";
      }
      const operators = [
        ...new Set([
          admitted.identity.builderId,
          ...dossiers.flatMap((dossier) =>
            dossier.proposal.targets.map((target) => target.operatorId)
          ),
        ]),
      ];
      const runtimePins = operators.map((operatorId) => {
        const snapshot = workspace.runtimeFor(operatorId)?.runtime.snapshot;
        return {
          operatorId,
          version: snapshot?.executionModel?.version,
          phase: snapshot?.phase,
          busy: snapshot?.busy,
          error: snapshot?.error,
          activations: snapshot?.events.filter((event) =>
            event.effectiveModelUpdate
          ).map((event) => event.effectiveModelUpdate),
        };
      });
      const nativeExecutions = await Promise.all(
        operators.map(async (operatorId) => {
          try {
            const snapshots = await postgres.native.execution.inspect(
              operatorId,
            );
            return {
              operatorId,
              snapshotsOmitted: Math.max(0, snapshots.length - 20),
              snapshots: snapshots.slice(-20).map((
                {
                  contributionId,
                  identity,
                  threadId,
                  modelDigest,
                  repositoryVersion,
                  flowRootId,
                  status,
                  checkpointId,
                  refusal,
                  waits,
                },
              ) => ({
                contributionId,
                identity,
                threadId,
                modelDigest,
                repositoryVersion,
                flowRootId,
                status,
                checkpointId,
                refusal,
                waits: waits.slice(0, 20),
                waitsOmitted: Math.max(0, waits.length - 20),
              })),
            };
          } catch (error) {
            return {
              operatorId,
              error: (error instanceof Error ? error.message : String(error))
                .slice(0, 2048),
            };
          }
        }),
      );
      const path = join(directory, `qualification-${label}.json`);
      await Deno.writeTextFile(
        path,
        JSON.stringify(
          {
            qualificationEpoch,
            startedAt,
            capturedAt: new Date().toISOString(),
            pid: Deno.pid,
            projectId: backend.projectId,
            projectDirectory: backend.project.projectDir,
            toolkitPackageDirectory: backend.toolkitPackageDirectory,
            nativeEpochs,
            ...(nativeEpochDiagnostic ? { nativeEpochDiagnostic } : {}),
            providerInvocations: contexts.length,
            consultationDiagnostics,
            consultationDiagnosticsOmitted,
            nativeExecutions,
            sourcePin: {
              repositoryVersion: source.version,
              sourceDigest: source.sourceDigest,
              semanticDigest: source.semanticDigest,
              provenanceDigest: source.provenanceDigest,
              engineVersion: source.engineVersion,
              provider: source.provider,
              build: await backend.repository.descriptorAt?.(source.version),
            },
            dossiers,
            runtimePins,
            operationalEvidence: await Promise.all(
              operators.map(async (operatorId) => {
                const state = await postgres.diagnostics.state(operatorId);
                const stores = await postgres.storage.operator(operatorId);
                return {
                  operatorId,
                  state,
                  memory: await postgres.diagnostics.memory(operatorId),
                  budget: state?.workBudgetBinding
                    ? await stores.budget.load(state.workBudgetBinding.scopeId)
                    : null,
                };
              }),
            ),
          },
          null,
          2,
        ),
      );
      console.error(`Native evolution qualification evidence: ${path}`);
      return path;
    };
    fixtureReady = true;
    return {
      directory,
      backend,
      primary,
      postgres,
      workspace,
      evolutionStore,
      ledger,
      workBudget,
      contexts,
      ownerPublish,
      turn,
      retainedMemory,
      preserveEvidence() {
        retainEvidence = true;
      },
      captureEvidence,
      async verifyRetainedMemory(additional: readonly MemoryRecord[] = []) {
        await postgres.stopWorkspace();
        workspaceClosed = true;
        const client = postgres.database.createClient();
        const store = new PostgresGovernedMemoryStore(
          client,
          postgres.primary.scope,
        );
        try {
          const actual = await store.list(target);
          const retainedIds = new Set(
            retainedMemory.map((record) => record.id),
          );
          assert.equal(
            new Set(additional.map((record) => record.id)).size,
            additional.length,
          );
          for (const record of additional) {
            assert.equal(record.ownerId, target);
            assert(
              !retainedIds.has(record.id),
              "A new candidate cannot replace historical notes",
            );
          }
          assert.deepEqual(
            actual.toSorted((a, b) => a.id.localeCompare(b.id)),
            [...retainedMemory, ...additional].toSorted((a, b) =>
              a.id.localeCompare(b.id)
            ),
          );
        } finally {
          await store.close();
          await client.$disconnect();
        }
      },
      async close() {
        const preserve = retainEvidence || diagnosticPath || failure ||
          primary.snapshot.error;
        try {
          if (preserve) await captureEvidence("before-close");
          if (!workspaceClosed) await postgres.stopWorkspace();
          if (preserve) await captureEvidence("after-close");
        } finally {
          try {
            await evolutionStore.close();
          } finally {
            await postgres.close();
          }
        }
        if (preserve) {
          console.error(
            `Preserved native evolution qualification fixture (${
              preserveSuccess ? "success opt-in or failure" : "failure"
            }): ${directory}`,
          );
        } else await Deno.remove(directory, { recursive: true });
      },
    };
  } finally {
    if (!fixtureReady) await postgres.close();
  }
}
