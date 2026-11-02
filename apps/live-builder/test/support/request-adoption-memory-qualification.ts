/** Actual scoped memory operations over the enrollment witness's native R0
 * evidence and adopted R1. No memory record, policy or authority is fabricated. */
import assert from "node:assert/strict";
import type { ExecutableModel } from "../../src/domain/model/execution/executable-model.ts";
import type { MemoryContent } from "../../src/domain/memory/entities/memory-record.ts";
import {
  MemoryError,
  type MemoryGuidance,
} from "../../src/domain/memory/governed-memory-promotion.ts";
import type { OperatorEntry } from "../../src/domain/model/records/operator-entry.ts";
import type { BehaviorInvocationRequest } from "../../src/domain/work/execution/modeled-behavior.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import {
  type openInitialNormalRequest,
  type openNormalAdmissionWitnessHost,
} from "./request-source-admission-normal-host.ts";

type Host = Awaited<ReturnType<typeof openNormalAdmissionWitnessHost>>;
type Initial = Awaited<ReturnType<typeof openInitialNormalRequest>>;
type Dependencies = ReturnType<Host["dependencies"]["create"]>;

function request(
  model: ExecutableModel,
  kind: OperatorEntry["kind"],
  input: Record<string, unknown>,
): BehaviorInvocationRequest {
  const entries = model.operatorEntries!.filter((entry) => entry.kind === kind);
  const behaviors = model.behaviors!.filter((behavior) =>
    behavior.callerNativeId === model.identity.builderId &&
    entries.some((entry) => entry.id === behavior.targetNativeId)
  );
  assert.equal(behaviors.length, 1, `one actually compiled ${kind} exposure`);
  return {
    behavior: behaviors[0]!,
    callerId: model.identity.builderId,
    invocationId: `retained-memory-${crypto.randomUUID()}`,
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion!,
    },
    input,
  };
}

async function inScope<T>(
  host: Host,
  initial: Initial,
  operation: (
    deps: Dependencies,
    model: ExecutableModel,
    stores: Initial["stores"],
  ) => Promise<T>,
): Promise<T> {
  return await host.stage.runtime.withInstructionAdoptionReservation(
    initial.record,
    `memory-observation-${crypto.randomUUID()}`,
    ({ runtime, stores }) => {
      const model = runtime.snapshot.executionModel!;
      assert(model);
      const deps = host.dependencies.create(
        stores,
        model,
        () => runtime.snapshot,
      );
      return operation(deps, model, stores);
    },
  );
}

export async function captureRequestAdoptionMemory(
  host: Host,
  initial: Initial,
) {
  return await inScope(host, initial, async (deps, model, stores) => {
    const state = await stores.state.load();
    assert(state?.executionModel && model.memoryPolicy);
    assert.deepEqual(model, initial.state.executionModel);
    const accepted = initial.initialReceipt!;
    assert.equal(accepted.delivery.id, initial.record.initialContributionId);
    assert.equal(accepted.receipt.status, "completed");
    const contribution = await host.storage.client.executionContribution
      .findFirstOrThrow({
        where: {
          ...stores.scope,
          threadId: accepted.receipt.threadId,
          contributionId: accepted.delivery.id,
        },
      });
    assert.equal(contribution.status, "completed");
    assert(contribution.runId);
    const run = await host.storage.client.executionRun.findFirstOrThrow({
      where: {
        ...stores.scope,
        threadId: contribution.threadId,
        runId: contribution.runId,
        contributionId: contribution.contributionId,
      },
    });
    const pin = JSON.parse(run.pinJson).version;
    assert.equal(pin.digest, model.version.digest);
    assert.equal(pin.repositoryVersion, model.version.repositoryVersion);
    const inputIndex = state.messages.findIndex((message) =>
      message.id === accepted.delivery.id && message.role === "user" &&
      message.caseId === initial.record.caseId
    );
    assert(
      inputIndex >= 0,
      "the accepted native contribution has its real input",
    );
    const turn = state.messages.slice(inputIndex + 1).filter((message) =>
      message.caseId === initial.record.caseId
    );
    assert(
      !turn.some((message) => message.role === "user"),
      "no later input may contaminate initial contribution evidence",
    );
    const messages = turn.filter((message) =>
      message.caseId === initial.record.caseId &&
      message.execution?.digest === model.version.digest &&
      message.execution.repositoryVersion === model.version.repositoryVersion &&
      !!message.execution.actionId
    );
    const outcome = messages.find((message) =>
      message.role === "tool" && message.observation?.kind === "model-context"
    );
    assert(outcome, "actual R0 native source-consultation outcome is required");
    const outcomeIndex = state.messages.indexOf(outcome);
    const decision = messages.find((message) =>
      message.role === "assistant" &&
      state.messages.indexOf(message) > outcomeIndex
    );
    assert(
      decision,
      "actual R0 assistant decision must follow the source-consultation outcome",
    );
    // Source consultation and reply are distinct modeled actions in this real
    // native contribution. Historical provenance requires their exact R0 pin,
    // not an invented shared action identity.
    assert.notEqual(decision.execution!.actionId, outcome.execution!.actionId);
    assert(inputIndex < outcomeIndex);
    assert(model.memoryPolicy.allowedScopes.length > 0);
    assert(model.memoryPolicy.maxValidityMs > 0);
    const content: MemoryContent = {
      text: `Retained observation from native R0 decision ${decision.id}`,
      origin: {
        decisionId: decision.id,
        sourceRefs: [`message:${decision.id}`, `message:${outcome.id}`],
      },
      scope: [model.memoryPolicy.allowedScopes[0]!],
      validUntil: new Date(
        Date.now() + Math.min(model.memoryPolicy.maxValidityMs, 600_000),
      ).toISOString(),
      outcome: {
        status: "known",
        summary: `Recorded native source observation ${outcome.id}`,
        evidenceRefs: [`message:${outcome.id}`],
      },
    };
    const id = `retained-r0-${crypto.randomUUID()}`;
    await deps.behaviors!.invoke(request(model, "memory-capture", {
      id,
      contentJson: JSON.stringify(content),
    }));
    const captured = await stores.memory.load(model.identity.builderId, id);
    assert(captured);
    assert.equal(captured.status, "candidate");
    assert.deepEqual(captured.content, content);
    assert.equal(captured.history.length, 1);
    assert.equal(captured.history[0]!.operation, "capture");
    assert.equal(
      captured.history[0]!.modelVersion.digest,
      model.version.digest,
    );
    assert.equal(
      captured.history[0]!.modelVersion.repositoryVersion,
      model.version.repositoryVersion,
    );
    const persisted = await host.storage.client.governedMemory.findFirstOrThrow(
      {
        where: { ...stores.scope, ownerId: captured.ownerId, id },
      },
    );
    const invocations = await host.storage.client.memoryInvocation.findMany({
      where: { ...stores.scope, ownerId: captured.ownerId, noteId: id },
      orderBy: { invocationId: "asc" },
    });
    assert.equal(invocations.length, 1);
    return {
      captured,
      persisted,
      invocations,
      model: structuredClone(model),
      decision: structuredClone(decision),
      outcome: structuredClone(outcome),
    };
  });
}

export async function qualifyRetainedRequestAdoptionMemory(
  host: Host,
  initial: Initial,
  retained: Awaited<ReturnType<typeof captureRequestAdoptionMemory>>,
) {
  await inScope(host, initial, async (deps, model, stores) => {
    const { captured } = retained, ownerId = model.identity.builderId;
    assert.notEqual(model.version.digest, retained.model.version.digest);
    assert.notEqual(
      model.version.repositoryVersion,
      retained.model.version.repositoryVersion,
    );
    const state = await stores.state.load();
    assert(state);
    assert.deepEqual(
      state.messages.find((m) => m.id === retained.decision.id),
      retained.decision,
    );
    assert.deepEqual(
      state.messages.find((m) => m.id === retained.outcome.id),
      retained.outcome,
    );
    assert.deepEqual(await stores.memory.load(ownerId, captured.id), captured);
    assert.deepEqual(
      await host.storage.client.governedMemory.findFirstOrThrow({
        where: { ...stores.scope, ownerId, id: captured.id },
      }),
      retained.persisted,
    );
    assert.deepEqual(
      await host.storage.client.memoryInvocation.findMany({
        where: { ...stores.scope, ownerId, noteId: captured.id },
        orderBy: { invocationId: "asc" },
      }),
      retained.invocations,
    );
    const recalled = await deps.behaviors!.invoke(
      request(model, "memory-recall", { id: captured.id }),
    );
    const memories =
      (recalled.result as { memories: MemoryGuidance[] }).memories;
    assert.equal(memories.length, 1);
    assert.deepEqual(memories[0]!.content, captured.content);
    assert.equal(memories[0]!.usableAsGuidance, false);
    assert.deepEqual(await stores.memory.load(ownerId, captured.id), captured);

    // Recall checks representation/scope. This same-content revision separately
    // proves the real historical resolver ran; no resolver result is replaced.
    const resolver = host.stage.executedModels!;
    assert(resolver);
    const original = resolver.historical;
    const descriptor = Object.getOwnPropertyDescriptor(resolver, "historical");
    assert(descriptor);
    const observations: Array<{
      scope: Parameters<typeof original>[0];
      version: Parameters<typeof original>[1];
      model: ExecutableModel | null;
    }> = [];
    Object.defineProperty(resolver, "historical", {
      ...descriptor,
      value: async (...args: Parameters<typeof original>) => {
        const selected = await Reflect.apply(original, resolver, args);
        observations.push({
          scope: structuredClone(args[0]),
          version: structuredClone(args[1]),
          model: structuredClone(selected),
        });
        return selected;
      },
    });
    try {
      await deps.behaviors!.invoke(request(model, "memory-revise", {
        id: captured.id,
        expectedRevision: captured.revision,
        expectedDigest: captured.digest,
        contentJson: JSON.stringify(captured.content),
      }));
    } finally {
      Object.defineProperty(resolver, "historical", descriptor);
    }
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0]!.scope, stores.scope);
    assert.deepEqual(observations[0]!.version, {
      digest: retained.model.version.digest,
      repositoryVersion: retained.model.version.repositoryVersion,
    });
    const historical = observations[0]!.model;
    assert(historical);
    assert.equal(historical.version.digest, retained.model.version.digest);
    assert.equal(
      historical.version.repositoryVersion,
      retained.model.version.repositoryVersion,
    );
    // The real Toolkit reader retains optional undefined object properties;
    // persisted runtime JSON omits them. Compare the complete domain encoding,
    // as RequestExecutedModels does, without dropping any persisted model value.
    assert.equal(canonical(historical), canonical(retained.model));
    const revised = await stores.memory.load(ownerId, captured.id);
    assert(revised);
    assert.equal(revised.revision, captured.revision + 1);
    assert.equal(revised.digest, captured.digest);
    assert.deepEqual(revised.content, captured.content);
    assert.deepEqual(
      revised.history.slice(0, captured.history.length),
      captured.history,
    );
    assert.equal(revised.history.at(-1)!.operation, "revise");
    assert.equal(
      revised.history.at(-1)!.modelVersion.digest,
      model.version.digest,
    );
    assert.equal(
      revised.history.at(-1)!.modelVersion.repositoryVersion,
      model.version.repositoryVersion,
    );

    if (model.memoryPolicy!.allowSelfAdmission === false) {
      await assert.rejects(
        () =>
          deps.behaviors!.invoke(request(model, "memory-review", {
            id: revised.id,
            expectedRevision: revised.revision,
            expectedDigest: revised.digest,
            decision: "admit",
            reason:
              "Exercise existing self-admission refusal without widening authority",
          })),
        (error) =>
          error instanceof MemoryError && error.code === "forbidden" &&
          error.message.includes(
            "modeled policy forbids contributor self-admission",
          ),
      );
      assert.deepEqual(await stores.memory.load(ownerId, captured.id), revised);
    }
    await deps.behaviors!.invoke(request(model, "memory-review", {
      id: revised.id,
      expectedRevision: revised.revision,
      expectedDigest: revised.digest,
      decision: "request-revision",
      reason:
        "Actual R1 governance review retains verified original R0 evidence",
    }));
    const reviewed = await stores.memory.load(ownerId, captured.id);
    assert(reviewed);
    assert.equal(reviewed.status, "revision-requested");
    assert.equal(reviewed.revision, revised.revision + 1);
    assert.equal(reviewed.digest, captured.digest);
    assert.deepEqual(reviewed.content, captured.content);
    assert.deepEqual(
      reviewed.history.slice(0, revised.history.length),
      revised.history,
    );
    assert.equal(reviewed.history.at(-1)!.operation, "request-revision");
    assert.deepEqual(reviewed.history.at(-1)!.modelVersion, {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion,
    });
  });
  console.info(
    "Retained-memory witness: actual R0 capture, preserved evidence, R1 recall/historical verification/revision and governance review; no admitted guidance or native memory-call claim",
  );
}
