import { mayConsultModel } from "../../../domain/model/consultation/model-read-policy.ts";
/** Application side of the admitted native immutable-read refinement. Workers
 * stage data only; the single join owns canonical publication. */
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { characterCount } from "../../../domain/primitives/character-count.ts";
import {
  type ModelContextTool,
  modelContextTools,
} from "../context/model-tools.ts";
import {
  immutableModelConsultation,
  modelConsultationRefusalEvidence,
  ModelContextAccessError,
  ModelNavigationError,
} from "../../../domain/model/consultation/context.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { CompiledFlow } from "../../../domain/model/execution/flow.ts";
import type { ChatDecision } from "./chat-decision.ts";
import type {
  ConversationBatchExecution,
  SystemRuntimeState,
} from "../runtime/state.ts";
import type { SchemaValidationPort } from "../behaviors/schema-validation.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import {
  caseExecutionContext,
  caseMessages,
  designerExecutionContext,
} from "../cases/runtime.ts";
import { withModelDiagnosticsView } from "./model-diagnostics-link.ts";
import { authorityNoticeInput } from "./notice-turn.ts";
import {
  activeBatchCall,
  batchInScope,
  MAX_PARALLEL_READS,
} from "./batches.ts";
import type { ConversationTurnHost } from "./turn-context.ts";
import {
  type ImmutableConsultationGroupManifest,
  type ImmutableConsultationGroupMember,
  type ImmutableConsultationGroupPublication,
  nativeExecutionIdentity,
  type NativeImmutableConsultationHandlers,
  runtimeRevisionReference,
} from "../native-execution/contract.ts";
import { errorText } from "../runtime/values.ts";
import type { ModelConsultationPin } from "../context/information-ports.ts";

type Request = ImmutableConsultationGroupMember["request"];
type ReadChoice = Extract<ChatDecision, { kind: "consult_model" }>;

/** Stop at the first barrier; never scan ahead or coalesce provider identities. */
export function immutableConsultationPrefix(
  batch: ConversationBatchExecution,
  firstOrdinal: number,
  tools: readonly ModelContextTool[],
  validator: SchemaValidationPort,
): Array<
  { ordinal: number; callId: string; choice: ReadChoice; request: Request }
> {
  if (
    !Number.isSafeInteger(firstOrdinal) || firstOrdinal < 0 ||
    firstOrdinal >= batch.calls.length
  ) return [];
  const version = batch.sourceDecision.modelContext?.version;
  if (
    !version || !batch.sourceDecision.modelContext?.sourceDigest ||
    batch.sourceDecision.modelSources?.version !== version
  ) return [];
  const seen = new Set<string>();
  const members: ReturnType<typeof immutableConsultationPrefix> = [];
  for (
    let ordinal = firstOrdinal;
    ordinal < batch.calls.length && members.length < MAX_PARALLEL_READS;
    ordinal++
  ) {
    const call = batch.calls[ordinal]!;
    if (
      (call.status !== "queued" &&
        !(ordinal === firstOrdinal && call.status === "started")) ||
      call.effectStarted || call.result ||
      call.decision.kind !== "consult_model" ||
      characterCount(call.decision.inputJson) > 65536
    ) break;
    let request: unknown;
    try {
      request = JSON.parse(call.decision.inputJson);
    } catch {
      break;
    }
    if (!immutableModelConsultation(request)) break;
    const input = request as Request;
    const tool = tools.find((item) => item.operation === input.operation);
    if (
      !tool || input.version !== version ||
      !validator.validate(tool.inputSchema, input).valid
    ) break;
    const key = canonical(input);
    if (seen.has(key)) break;
    seen.add(key);
    members.push({
      ordinal,
      callId: call.id,
      choice: structuredClone(call.decision),
      request: structuredClone(input),
    });
  }
  return members;
}

function assertBatch(
  state: SystemRuntimeState,
  manifest: ImmutableConsultationGroupManifest,
): ConversationBatchExecution {
  if (
    canonical(
        nativeExecutionIdentity(
          state,
          "conversation",
          manifest.identity.subjectId,
        ),
      ) !== canonical(manifest.identity) ||
    state.activeInputMessageId !== manifest.contribution.inputMessageId ||
    state.executionModel?.version.digest !==
      manifest.executionPin.modelDigest ||
    state.executionModel.version.repositoryVersion !==
      manifest.executionPin.repositoryVersion
  ) {
    throw new Error(
      "Immutable consultation invocation or admitted pin changed",
    );
  }
  if (manifest.identity.scope.kind === "request") {
    // A delegated Request remains owned by its actual operator. It travels as
    // the host-captured context, never as a new local Case. PostgreSQL also
    // rereads that owner's authoritative record under its live closure fence.
    const context = caseExecutionContext(state);
    const record = context?.record;
    if (
      !context || !record ||
      context.caseId !== manifest.identity.scope.scopeId ||
      manifest.identity.scope.rootRequestId !== context.caseId ||
      record.id !== context.caseId ||
      context.number !== undefined && context.number !== record.number ||
      canonical(context.modelPin) !== canonical(record.modelPin) ||
      !record.owner.trim() ||
      state.caseInvocation?.kind === "local" &&
        record.owner !== state.executionModel.identity.builderId ||
      !isOpenCase(record)
    ) {
      throw new Error(
        "Immutable consultation Request is closed or its exact Case context is unavailable",
      );
    }
  }
  const batch = state.conversationBatches?.find((item) =>
    item.id === manifest.batchId && batchInScope(state, item)
  );
  if (
    !batch || batch.modelDigest !== manifest.executionPin.modelDigest ||
    batch.sourceDecision.modelContext?.version !== manifest.sourcePin.version ||
    batch.sourceDecision.modelContext.sourceDigest !==
      manifest.sourcePin.digest ||
    batch.sourceDecision.modelSources?.version !== manifest.sourcePin.version ||
    manifest.members.some((member) => {
      const call = batch.calls[member.ordinal];
      return call?.id !== member.callId ||
        canonical(call.decision) !== canonical(member.choice) ||
        ["cancelled", "unknown"].includes(call.status);
    })
  ) throw new Error("Immutable consultation batch or source pin changed");
  return batch;
}

export function createImmutableConsultationHandlers(
  host: ConversationTurnHost,
  flow: CompiledFlow,
  model: () => ExecutableModel,
): NativeImmutableConsultationHandlers {
  async function boundary(manifest: ImmutableConsultationGroupManifest) {
    const current = await host.currentModel();
    if (!mayConsultModel(current.policy)) {
      throw new ModelContextAccessError(
        "MODEL_CONTEXT_AUTHORITY",
        "Immutable consultation requires current model read authority",
      );
    }
    if (
      current.version.digest !== manifest.executionPin.modelDigest ||
      current.version.repositoryVersion !==
        manifest.executionPin.repositoryVersion
    ) {
      throw new Error(
        "Immutable consultation requires its exact admitted native pin",
      );
    }
    return assertBatch(host.snapshot, manifest);
  }
  async function snapshot(manifest: ImmutableConsultationGroupManifest) {
    const ref = manifest.businessRevision.__assemblyRuntimeRevision;
    const state = await host.ports.stateHistory!.loadRevision(ref.revision);
    if (
      !state ||
      canonical(runtimeRevisionReference(state)) !==
        canonical(manifest.businessRevision)
    ) {
      throw new Error(
        "Immutable consultation source business revision unavailable",
      );
    }
    assertBatch(state, manifest);
    return state;
  }
  function contextPin(
    state: SystemRuntimeState,
    manifest: ImmutableConsultationGroupManifest,
  ): ModelConsultationPin {
    const batch = assertBatch(state, manifest);
    if (
      !batch.sourceDecision.modelSources || !batch.sourceDecision.modelContext
    ) throw new Error("Immutable consultation has no exact working set");
    return {
      version: manifest.sourcePin.version,
      sourceDigest: manifest.sourcePin.digest,
      modelContext: structuredClone(batch.sourceDecision.modelContext),
      modelSources: structuredClone(batch.sourceDecision.modelSources),
    };
  }
  async function assertPin(
    state: SystemRuntimeState,
    manifest: ImmutableConsultationGroupManifest,
  ): Promise<void> {
    const verify = host.ports.information?.assertModelContextPin;
    if (!verify) {
      throw new Error(
        "Immutable consultation working set verification unavailable",
      );
    }
    await verify.call(
      host.ports.information,
      state.executionModel!,
      caseMessages(state),
      contextPin(state, manifest),
    );
  }
  return {
    async plan(node, _inputs, _values, context) {
      if (
        flow.executionProfile !== "operator-command-immutable-group-v1" ||
        node.mechanism !== "execute_operator_command"
      ) return undefined;
      const active = activeBatchCall(host.snapshot);
      if (
        !active || !host.ports.information?.consultModel ||
        !host.ports.stateHistory
      ) return undefined;
      const batch = active.batch;
      const firstOrdinal = batch.calls.findIndex((call) =>
        call.id === active.call.id
      );
      const selected = immutableConsultationPrefix(
        batch,
        firstOrdinal,
        host.ports.information.modelTools?.(model()) ?? modelContextTools(),
        host.ports.schemaValidator,
      );
      if (!selected.length) return undefined;
      const admitted = await host.currentModel();
      if (
        admitted.version.digest !== context.request.model.version.digest ||
        admitted.version.repositoryVersion !==
          context.request.model.version.repositoryVersion ||
        batch.modelDigest !== admitted.version.digest ||
        canonical(
            nativeExecutionIdentity(
              host.snapshot,
              "conversation",
              context.request.identity.subjectId,
            ),
          ) !== canonical(context.request.identity)
      ) {
        throw new Error(
          "Immutable consultation planning requires the exact admitted invocation",
        );
      }
      if (
        !Number.isSafeInteger(batch.recordedRevision) ||
        !Number.isSafeInteger(batch.decisionContextCharacters)
      ) {
        throw new Error(
          "Immutable consultation requires the exact accepted batch revision and context reservation",
        );
      }
      const flowSteps = selected.length + 1;
      if (
        context.segmentStep + flowSteps >
          Math.min(context.request.maxSteps, flow.maxSteps)
      ) {
        throw new Error(
          "Immutable consultation exceeds the native segment step budget",
        );
      }
      const referenceCharacters = JSON.stringify(
        host.executionReference(model(), { actionId: node.nativeId }),
      ).length;
      const envelope = selected.reduce(
        (sum, member) =>
          sum + JSON.stringify(member.choice.text).length +
          referenceCharacters * 6 + 4096,
        0,
      );
      const alreadyPublished = batch.calls.reduce(
        (sum, call) =>
          sum +
          (call.result ? JSON.stringify(call.result).length * 6 + 4096 : 0),
        0,
      );
      const remaining = (model().contextPolicy?.maxContextCharacters ?? 65536) -
        batch.decisionContextCharacters! - alreadyPublished - envelope;
      // Result value/details, observation and their JSON envelopes share one
      // reservation. Never lend the full scalar allowance to each sibling.
      const responseCharacters = Math.floor(remaining / (selected.length * 6));
      if (responseCharacters < 1) {
        throw new Error(
          "Immutable consultation has no remaining decision-context budget",
        );
      }
      const groupId = `immutable:${await executionDigest({
        runId: context.runId,
        occurrenceId: node.id,
        batchId: batch.id,
        firstOrdinal,
      })}`;
      const members = await Promise.all(selected.map(async (member, index) => ({
        ...member,
        effectKey: `${groupId}:${member.ordinal}`,
        argumentsDigest: await executionDigest(member.request),
        responseCharacters,
        flowStepOrdinal: context.step + index + 1,
      })));
      const businessRevision = runtimeRevisionReference(host.snapshot);
      businessRevision.__assemblyRuntimeRevision.revision = batch
        .recordedRevision!;
      const body = {
        groupId,
        runId: context.runId,
        occurrenceId: node.id,
        batchId: batch.id,
        firstOrdinal,
        identity: structuredClone(context.request.identity),
        contribution: structuredClone(context.request.contribution),
        businessRevision,
        executionPin: {
          modelDigest: model().version.digest,
          ...(model().version.repositoryVersion
            ? { repositoryVersion: model().version.repositoryVersion }
            : {}),
        },
        sourcePin: {
          version: batch.sourceDecision.modelContext!.version,
          digest: batch.sourceDecision.modelContext!.sourceDigest,
        },
        members:
          members as unknown as ImmutableConsultationGroupManifest["members"],
        limits: {
          responseCharacters: responseCharacters * members.length,
          flowSteps,
        },
      };
      return { ...body, manifestDigest: await executionDigest(body) };
    },
    async execute(manifest, member) {
      await boundary(manifest);
      if (
        !manifest.members.some((item) => canonical(item) === canonical(member))
      ) {
        throw new Error(
          "Immutable consultation member differs from its manifest",
        );
      }
      const state = await snapshot(manifest);
      const current = structuredClone(state.executionModel!);
      await assertPin(state, manifest);
      const node = flow.nodes.find((item) =>
        item.id === manifest.occurrenceId
      )!;
      if (!node || node.mechanism !== "execute_operator_command") {
        throw new Error("Immutable consultation native occurrence unavailable");
      }
      let value: unknown;
      let status: "succeeded" | "failed" | "refused" = "succeeded";
      try {
        value = await host.ports.information!.consultModel!(
          current,
          structuredClone(member.request),
          structuredClone(caseMessages(state)),
          {
            maxResponseCharacters: member.responseCharacters,
            expectedPin: contextPin(state, manifest),
          },
        );
        // This read publishes through the native immutable join rather than
        // decision.ts. Keep navigation on the same verified historical scope,
        // and account for its bytes in the existing reserved response budget.
        const requestContext = caseExecutionContext(state);
        const requestId = requestContext?.record?.type === "request"
          ? requestContext.caseId
          : undefined;
        if (
          requestId !== undefined ||
          (!requestContext && designerExecutionContext(state))
        ) {
          value = withModelDiagnosticsView(
            value,
            member.request.version,
            requestId,
          );
        }
        if (
          typeof JSON.stringify(value) !== "string" ||
          JSON.stringify(value).length > member.responseCharacters
        ) {
          throw Object.assign(
            new Error("Immutable read exceeds its reserved response budget"),
            { code: "MODEL_CONTEXT_BUDGET" },
          );
        }
      } catch (error) {
        if (
          error instanceof Error && (error.name === "AbortError" ||
            "code" in error && typeof error.code === "string" &&
              [
                "MODEL_CONTEXT_STALE_PIN",
                "MODEL_CONTEXT_STALE_REQUEST",
                "MODEL_CONTEXT_AUTHORITY",
                "MODEL_CONTEXT_VERSION",
                "MODEL_CONTEXT_NOT_PINNED",
              ].includes(error.code))
        ) throw error;
        status = error instanceof ModelNavigationError ||
            error && typeof error === "object" && "code" in error
          ? "refused"
          : "failed";
        value = {
          status,
          operation: member.request.operation,
          message: errorText(error),
          ...modelConsultationRefusalEvidence(error),
        };
      }
      await boundary(manifest);
      await assertPin(state, manifest);
      const at = host.ports.clock.now();
      const key = (kind: string) =>
        `immutable:${JSON.stringify([manifest.groupId, member.callId, kind])}`;
      const execution = structuredClone(
        host.executionReference(current, { actionId: node.nativeId }),
      );
      const scope = manifest.identity.scope.kind === "request"
        ? { caseId: manifest.identity.scope.scopeId }
        : { designerScopeId: manifest.identity.scope.scopeId };
      const eventScope = manifest.identity.scope.kind === "request"
        ? { caseId: manifest.identity.scope.scopeId }
        : {};
      const details = JSON.stringify(value);
      return {
        groupId: manifest.groupId,
        callId: member.callId,
        effectKey: member.effectKey,
        argumentsDigest: member.argumentsDigest,
        result: {
          status,
          code: status === "succeeded"
            ? "MODEL_CONSULTATION_COMPLETED"
            : status === "refused"
            ? "MODEL_CONSULTATION_REFUSED"
            : "MODEL_CONSULTATION_FAILED",
          details,
          value,
        },
        messages: [
          ...(node.outputs.includes("submission") &&
              authorityNoticeInput(state, manifest.contribution.inputMessageId)
            ? []
            : [{
              id: key("assistant"),
              role: "assistant" as const,
              text: member.choice.text,
              at,
              execution,
              ...scope,
            }]),
          {
            id: key("tool"),
            role: "tool",
            text:
              "Résultat de consultation du modèle. Données de la version source consultée ; aucun changement ni admission.\n" +
              details,
            observation: { kind: "model-context", value },
            at,
            execution,
            ...scope,
          },
        ],
        events: [{
          id: key("called"),
          kind: "model-tool-called",
          label: `Consultation du modèle : ${member.request.operation}`,
          at,
          execution,
          ...eventScope,
        }, {
          id: key("settled"),
          kind: status === "succeeded"
            ? "model-tool-completed"
            : "model-tool-refused",
          label: `Consultation ${
            status === "succeeded" ? "terminée" : "refusée"
          } : ${member.request.operation}`,
          at,
          execution,
          ...eventScope,
        }],
      };
    },
    async publish(manifest, outcomes) {
      const batch = await boundary(manifest);
      const sourceState = await snapshot(manifest);
      await assertPin(sourceState, manifest);
      if (
        outcomes.length !== manifest.members.length ||
        new Set(outcomes.map((item) => item.callId)).size !== outcomes.length
      ) {
        throw new Error(
          "Immutable join requires exactly every terminal member",
        );
      }
      const ordered = manifest.members.map((member) => {
        const outcome = outcomes.find((item) => item.callId === member.callId);
        if (
          !outcome || outcome.groupId !== manifest.groupId ||
          outcome.effectKey !== member.effectKey ||
          outcome.argumentsDigest !== member.argumentsDigest ||
          !["succeeded", "failed", "refused", "cancelled"].includes(
            outcome.result.status,
          )
        ) {
          throw new Error(
            "Immutable join receipt does not match its registered member",
          );
        }
        return outcome;
      });
      const members = await Promise.all(
        ordered.map(async (outcome) => ({
          callId: outcome.callId,
          effectKey: outcome.effectKey,
          receiptDigest: await executionDigest(outcome),
        })),
      );
      const saved = batch.immutableGroup?.groupId === manifest.groupId
        ? batch.immutableGroup.publication
        : undefined;
      const expectedRevision = host.snapshot.revision;
      const businessRevision = runtimeRevisionReference(host.snapshot);
      businessRevision.__assemblyRuntimeRevision.revision = saved?.revision ??
        expectedRevision + 1;
      const body = {
        groupId: manifest.groupId,
        manifestDigest: manifest.manifestDigest,
        members,
        businessRevision,
      };
      const publication: ImmutableConsultationGroupPublication = {
        ...body,
        publicationDigest: await executionDigest(body),
      };
      if (saved && saved.publicationDigest !== publication.publicationDigest) {
        throw new Error(
          "Immutable publication replay differs from its canonical receipt",
        );
      }
      if (!saved) {
        for (const [index, outcome] of ordered.entries()) {
          // Admission refusals can have no value. Their full representation is
          // still checked by the decision-context guard below.
          if (outcome.result.value === undefined) continue;
          const serialized = JSON.stringify(outcome.result.value);
          if (
            typeof serialized !== "string" ||
            serialized.length > manifest.members[index]!.responseCharacters
          ) {
            throw new Error(
              "Immutable read exceeds its reserved response budget",
            );
          }
        }
        const applyPublication = (state: SystemRuntimeState) => {
          const target = assertBatch(state, manifest);
          if (
            state.revision !== expectedRevision ||
            target.immutableGroup && !target.immutableGroup.publication &&
              (target.immutableGroup.groupId !== manifest.groupId ||
                target.immutableGroup.manifestDigest !==
                  manifest.manifestDigest)
          ) {
            throw new Error("Immutable publication state moved before commit");
          }
          for (const outcome of ordered) {
            const call = target.calls.find((item) =>
              item.id === outcome.callId
            )!;
            if (
              call.result &&
              canonical(call.result) !== canonical(outcome.result)
            ) throw new Error("Conflicting canonical immutable result");
            call.result = structuredClone(outcome.result);
            call.status = outcome.result.status === "cancelled"
              ? "cancelled"
              : "completed";
            for (const message of outcome.messages) {
              const prior = state.messages.find((item) =>
                item.id === message.id
              );
              if (prior && canonical(prior) !== canonical(message)) {
                throw new Error("Conflicting immutable message");
              }
              if (!prior) state.messages.push(structuredClone(message));
            }
            for (const event of outcome.events) {
              const prior = state.events.find((item) => item.id === event.id);
              if (prior && canonical(prior) !== canonical(event)) {
                throw new Error("Conflicting immutable observation");
              }
              if (!prior) state.events.push(structuredClone(event));
            }
          }
          target.immutableGroup = {
            groupId: manifest.groupId,
            manifestDigest: manifest.manifestDigest,
            publication: {
              publicationDigest: publication.publicationDigest,
              revision: expectedRevision + 1,
            },
          };
          if (state.activeBatchCall?.batchId === target.id) {
            delete state.activeBatchCall;
          }
        };
        const prospective = host.snapshot;
        applyPublication(prospective);
        if (!host.assertDecisionContextRepresentable) {
          throw new Error(
            "Immutable publication requires the admitted context representation guard",
          );
        }
        await host.assertDecisionContextRepresentable(model(), prospective);
        await boundary(manifest);
        const withPin = host.ports.information?.withModelContextPin;
        if (!withPin) {
          throw new Error(
            "Immutable consultation working set fence unavailable",
          );
        }
        await withPin.call(
          host.ports.information,
          sourceState.executionModel!,
          caseMessages(sourceState),
          contextPin(sourceState, manifest),
          () => host.update(applyPublication),
        );
      }
      return {
        publication,
        action: {
          outputs: {
            ...(flow.nodes.find((node) => node.id === manifest.occurrenceId)
                ?.outputs.includes("submission")
              ? { submission: { awaitingInput: false } }
              : {}),
            outcome: {
              succeeded: true,
              code: "IMMUTABLE_CONSULTATION_GROUP_COMPLETED",
              details:
                "Every registered immutable consultation has a terminal receipt.",
            },
          },
        },
      };
    },
  };
}
