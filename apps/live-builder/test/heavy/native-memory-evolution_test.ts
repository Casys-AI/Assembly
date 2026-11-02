/** Real native admission, evolution, InformationBehavior and PostgreSQL memory.
 * Only the provider is scripted; no behavior or memory receipt is fabricated. */
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  nativeEvolutionMain,
  nativeEvolutionPeer,
  openNativeEvolutionFixture,
} from "../fixtures/native-evolution.ts";
import { nativeId } from "../fixtures/model-edit-mandate.ts";
import { validateSourceExecutable } from "../../src/adapters/model/sources/source-model.ts";
import type { ChatDecision } from "../../src/domain/work/dialogue.ts";
import type {
  MemoryContent,
  MemoryRecord,
} from "../../src/domain/memory/entities/memory-record.ts";
import type { MemoryGuidance } from "../../src/domain/memory/governed-memory-promotion.ts";

type Fixture = Awaited<ReturnType<typeof openNativeEvolutionFixture>>;
type Invocation = Extract<ChatDecision, { kind: "invoke_behavior" }>;
const sortedNotes = (records: readonly MemoryRecord[]) =>
  records.toSorted((a, b) => a.id.localeCompare(b.id));

function behavior(f: Fixture, name: "CaptureNote" | "RecallNotes") {
  const matches =
    f.primary.snapshot.executionModel!.behaviors?.filter((entry) =>
      entry.name === name
    ) ?? [];
  assert.equal(matches.length, 1, `Expected exact native ${name} exposure`);
  return matches[0]!;
}

function choice(id: string, input: Record<string, unknown>): Invocation {
  return {
    kind: "invoke_behavior",
    behaviorId: id,
    inputJson: JSON.stringify(input),
    text: "Invoke the exact admitted local memory operation.",
  };
}

async function invoke(f: Fixture, request: Invocation) {
  const start = f.primary.snapshot.messages.length;
  const eventStart = f.primary.snapshot.events.length;
  const pin = f.primary.snapshot.executionModel!.version;
  await f.turn([request]);
  const observations = f.primary.snapshot.messages.slice(start).filter((
    message,
  ) => message.observation?.kind === "behavior-result");
  assert.equal(
    observations.length,
    1,
    "One actual native behavior observation is required",
  );
  const message = observations[0]!;
  assert.equal(message.execution?.digest, pin.digest);
  assert.equal(message.execution?.repositoryVersion, pin.repositoryVersion);
  const value = message.observation!.value;
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert(f.primary.snapshot.activeInputMessageId);
  return {
    message,
    value: value as Record<string, unknown>,
    events: f.primary.snapshot.events.slice(eventStart),
    contributionId: f.primary.snapshot.activeInputMessageId,
  };
}

async function adoptSetting(
  f: Fixture,
  field: string,
  expression: string,
  category: "memory" | "contracts",
) {
  const head = await f.backend.repository.current();
  const owner = f.primary.snapshot.executionModel!.identity.builderId;
  const prior = await f.evolutionStore.listRecent(f.backend.project.id, 256);
  await f.turn([
    {
      kind: "consult_model",
      text: "Read the exact source before the bounded memory revision.",
      inputJson: JSON.stringify({
        operation: "read_source",
        path: "configuration.sysml",
        version: head.version,
      }),
    },
    {
      kind: "prepare_operator_evolution",
      text: "Prepare the bounded native setting change.",
      reason: "Qualify the effect on a subsequent real local memory operation.",
      editJson: JSON.stringify({
        edits: [{
          kind: "set-value",
          elementId: nativeId(head, `${nativeEvolutionMain}::${field}`),
          expression,
        }],
      }),
    },
  ]);
  const dossiers = await f.evolutionStore.listRecent(f.backend.project.id, 256);
  const added = dossiers.filter((entry) =>
    !prior.some((old) => old.id === entry.id)
  );
  assert.equal(
    added.length,
    1,
    "The real preparation command must create one dossier",
  );
  const prepared = added[0]!;
  assert.equal(prepared.status, "prepared");
  assert.deepEqual(prepared.proposal.categories, [category]);
  assert.deepEqual(
    prepared.proposal.targets.map((target) => target.operatorId),
    [owner],
  );
  assert.equal(prepared.proposal.baseVersion, head.version);
  assert.equal((await f.backend.repository.current()).version, head.version);
  await f.turn([{
    kind: "decide_operator_evolution",
    text: "Accept this exact memory revision.",
    dossierId: prepared.id,
    decision: "accept",
  }]);
  const accepted = (await f.evolutionStore.get(prepared.id))!;
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.acceptance!.proposalDigest, prepared.proposal.digest);
  assert.equal((await f.backend.repository.current()).version, head.version);
  await f.turn([{
    kind: "adopt_operator_evolution",
    text: "Arm adoption after this native contribution returns.",
    dossierId: prepared.id,
  }]);
  const binding = f.primary.snapshot.workBudgetBinding!;
  assert(binding);
  const budget = await f.ledger.load(binding.scopeId);
  const providerCalls = f.contexts.length;
  await f.captureEvidence(`memory-${category}-before-finalize`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const adopted = await Promise.race([
      f.workspace.evolution!.finalize(prepared.id),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(
            "Native memory witness diagnostic deadline (300s)",
          );
          error.name = "NativeEvolutionDiagnosticTimeout";
          reject(error);
        }, 300_000);
      }),
    ]);
    assert.equal(adopted.status, "adopted", JSON.stringify(adopted.blockers));
    assert.equal(
      f.contexts.length,
      providerCalls,
      "Finalization cannot invoke the provider",
    );
    assert.deepEqual(
      await f.ledger.load(binding.scopeId),
      budget,
      "Finalization must preserve the budget ledger",
    );
    assert.equal(adopted.accounting.agentInvocations, 0);
    assert.equal(adopted.adoptions.length, 1);
    assert(adopted.publication);
    const queued = await f.backend.queue.get(
      f.backend.project.id,
      adopted.proposal.id,
    );
    assert.equal(queued?.state, "published");
    assert.equal(queued?.commandDigest, adopted.publication.commandDigest);
    const publication = await f.backend.repository.findPublicationByCommand!(
      adopted.proposal.id,
    );
    assert.equal(publication?.revision.version, adopted.publication.version);
    assert.equal(publication?.commandDigest, adopted.publication.commandDigest);
    const active = f.primary.snapshot.executionModel!;
    assert.equal(active.version.repositoryVersion, adopted.publication.version);
    assert.equal(
      active.version.digest,
      adopted.proposal.targets[0].candidateDigest,
    );
    assert.equal(
      (await f.backend.repository.current()).version,
      adopted.publication.version,
    );
    const dividers = f.primary.snapshot.events.filter((event) =>
      event.effectiveModelUpdate?.dossierId === adopted.id
    );
    assert.equal(dividers.length, 1);
    assert.equal(
      dividers[0].effectiveModelUpdate!.from.repositoryVersion,
      head.version,
    );
    assert.equal(
      dividers[0].effectiveModelUpdate!.to.repositoryVersion,
      adopted.publication.version,
    );
    await f.captureEvidence(`memory-${category}-adopted`);
    return adopted;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function retained(f: Fixture) {
  const head = await f.backend.repository.current();
  const peer = await validateSourceExecutable(
    head,
    f.backend.projectId,
    nativeEvolutionPeer,
  );
  return {
    peer,
    candidates: structuredClone(f.primary.snapshot.candidates),
    mandate: structuredClone(f.primary.snapshot.executionModel!.mandate),
    editPolicy: structuredClone(
      f.primary.snapshot.executionModel!.modelEditPolicy,
    ),
    evolutionPolicy: structuredClone(
      f.primary.snapshot.executionModel!.evolutionPolicy,
    ),
  };
}

async function assertRetained(
  f: Fixture,
  before: Awaited<ReturnType<typeof retained>>,
) {
  const peer = await validateSourceExecutable(
    await f.backend.repository.current(),
    f.backend.projectId,
    nativeEvolutionPeer,
  );
  assert.equal(peer.version.digest, before.peer.version.digest);
  assert.deepEqual(peer.mandate, before.peer.mandate);
  assert.deepEqual(peer.flows, before.peer.flows);
  assert.deepEqual(f.primary.snapshot.candidates, before.candidates);
  assert.deepEqual(f.primary.snapshot.executionModel!.mandate, before.mandate);
  assert.deepEqual(
    f.primary.snapshot.executionModel!.modelEditPolicy,
    before.editPolicy,
  );
  assert.deepEqual(
    f.primary.snapshot.executionModel!.evolutionPolicy,
    before.evolutionPolicy,
  );
}

Deno.test({
  name:
    "native memory lifetime adoption permits the same 36-hour candidate only after the 48-hour policy is effective",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openNativeEvolutionFixture({ memoryOperations: true });
    try {
      const before = await retained(f);
      const owner = f.primary.snapshot.executionModel!.identity.builderId;
      const capture = behavior(f, "CaptureNote");
      const oldPin = structuredClone(
        f.primary.snapshot.executionModel!.version,
      );
      assert.equal(
        f.primary.snapshot.executionModel!.memoryPolicy!.maxValidityMs,
        86400000,
      );
      await f.turn([{
        kind: "reply",
        text: "A real scoped decision anchors the memory candidate.",
      }]);
      const decision = [...f.primary.snapshot.messages].reverse().find((
        message,
      ) => message.role === "assistant" && message.execution?.actionId)!;
      assert(decision?.execution?.actionId);
      assert.equal(
        decision.text,
        "A real scoped decision anchors the memory candidate.",
      );
      const capturedAt = new Date().toISOString();
      const content: MemoryContent = {
        text:
          "Retain the exact local observation as a candidate; separate admission is required.",
        origin: { decisionId: decision.id, sourceRefs: [] },
        scope: ["local"],
        validUntil: new Date(Date.parse(capturedAt) + 36 * 3_600_000)
          .toISOString(),
        outcome: { status: "pending" },
      };
      const id = "native-36-hour-candidate";
      const request = choice(capture.id, {
        id,
        contentJson: JSON.stringify(content),
      });
      await Deno.writeTextFile(
        `${f.directory}/qualification-memory-lifetime-input.json`,
        JSON.stringify({ capturedAt, oldPin, request, decision }, null, 2),
      );
      const refused = await invoke(f, request);
      assert.equal(refused.value.code, "BEHAVIOR_RESULT_UNCONFIRMED");
      assert.match(
        String(refused.value.details),
        /candidate validity exceeds the modeled lifetime/,
      );
      assert.equal(
        refused.events.filter((event) => event.kind === "behavior-called")
          .length,
        1,
      );
      assert.deepEqual(
        sortedNotes(await f.postgres.diagnostics.memory(owner)),
        sortedNotes(f.retainedMemory),
      );
      await f.captureEvidence("memory-lifetime-old-refusal");
      const adopted = await adoptSetting(
        f,
        "memoryPolicy::maxValidityMs",
        "172800000",
        "memory",
      );
      assert.notEqual(
        f.primary.snapshot.executionModel!.version.digest,
        oldPin.digest,
      );
      assert.equal(
        f.primary.snapshot.executionModel!.memoryPolicy!.maxValidityMs,
        172800000,
      );
      assert.deepEqual(behavior(f, "CaptureNote"), capture);
      const remaining = Date.parse(content.validUntil) - Date.now();
      assert(
        remaining > 86400000 && remaining <= 172800000,
        "The same payload must still distinguish the two lifetime policies",
      );
      const succeeded = await invoke(f, request);
      assert.notEqual(succeeded.contributionId, refused.contributionId);
      assert.equal(succeeded.value.behaviorId, capture.id);
      assert.equal(
        succeeded.events.filter((event) => event.kind === "behavior-called")
          .length,
        1,
      );
      const result = succeeded.value.result as {
        memory: Omit<MemoryGuidance, "content">;
        operation: Record<string, unknown>;
        replayed: boolean;
      };
      assert.equal(result.memory.id, id);
      assert.equal(result.memory.ownerId, owner);
      assert.equal(result.memory.status, "candidate");
      assert.equal(result.memory.usableAsGuidance, false);
      assert.equal(result.replayed, false);
      const records = await f.postgres.diagnostics.memory(owner);
      const candidate = records.find((record) => record.id === id)!;
      assert(candidate);
      assert.equal(candidate.revision, 1);
      assert.equal(candidate.status, "candidate");
      assert.deepEqual(candidate.content, content);
      assert.equal(candidate.history.length, 1);
      assert.equal(candidate.history[0].operation, "capture");
      assert.equal(candidate.history[0].callerId, owner);
      assert.equal(candidate.history[0].behaviorId, capture.id);
      assert.equal(
        candidate.history[0].invocationId,
        succeeded.value.invocationId,
      );
      assert.deepEqual(
        candidate.history[0].modelVersion,
        succeeded.value.modelVersion,
      );
      assert.equal(
        candidate.history[0].modelVersion.repositoryVersion,
        adopted.publication!.version,
      );
      assert.equal(
        candidate.history[0].policyId,
        f.primary.snapshot.executionModel!.memoryPolicy!.id,
      );
      const { content: _operationContent, ...recordedOperation } =
        candidate.history[0];
      assert.deepEqual(result.operation, recordedOperation);
      assert.equal(result.memory.digest, candidate.digest);
      assert.deepEqual(
        sortedNotes(records.filter((record) => record.id !== id)),
        sortedNotes(f.retainedMemory),
      );
      await assertRetained(f, before);
      await f.captureEvidence("memory-lifetime-candidate-after-adoption");
      await f.verifyRetainedMemory([candidate]);
    } catch (error) {
      f.preserveEvidence();
      await f.captureEvidence("memory-lifetime-failure");
      throw error;
    } finally {
      await f.close();
    }
  },
});

Deno.test({
  name:
    "native memory recall exposure adoption refuses the old exact access before any behavior effect",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const f = await openNativeEvolutionFixture({ memoryOperations: true });
    try {
      const before = await retained(f);
      const model = f.primary.snapshot.executionModel!;
      const owner = model.identity.builderId;
      const recall = behavior(f, "RecallNotes");
      const capture = behavior(f, "CaptureNote");
      const note = f.retainedMemory.find((record) =>
        record.status === "candidate"
      )!;
      assert(note);
      for (
        const grant of model.evolutionPolicy!.grants.filter((grant) =>
          grant.category === "contracts"
        )
      ) {
        assert(grant.bounds.contractNativeIds.includes(recall.id));
        assert(grant.bounds.inputTypeNativeIds.includes(recall.inputTypeId));
        assert(
          grant.bounds.allowedExposures.some((entry) =>
            entry.callerNativeId === recall.callerNativeId &&
            entry.targetNativeId === recall.targetNativeId &&
            entry.inputTypeId === recall.inputTypeId
          ),
        );
      }
      const request = choice(recall.id, { id: note.id });
      const recalled = await invoke(f, request);
      assert.equal(recalled.value.behaviorId, recall.id);
      const result = recalled.value.result as { memories: MemoryGuidance[] };
      assert.equal(result.memories.length, 1);
      assert.equal(result.memories[0].id, note.id);
      assert.deepEqual(result.memories[0].content, note.content);
      assert.equal(result.memories[0].status, "candidate");
      assert.equal(result.memories[0].usableAsGuidance, false);
      assert.equal(
        recalled.events.filter((event) => event.kind === "behavior-called")
          .length,
        1,
      );
      assert.deepEqual(
        sortedNotes(await f.postgres.diagnostics.memory(owner)),
        sortedNotes(f.retainedMemory),
      );
      const adopted = await adoptSetting(
        f,
        "RecallNotesAccess::enabled",
        "false",
        "contracts",
      );
      assert.notEqual(
        f.primary.snapshot.executionModel!.version.digest,
        model.version.digest,
      );
      assert(
        !f.primary.snapshot.executionModel!.behaviors?.some((entry) =>
          entry.id === recall.id
        ),
      );
      assert.deepEqual(behavior(f, "CaptureNote"), capture);
      assert.deepEqual(
        f.primary.snapshot.executionModel!.behaviors,
        model.behaviors!.filter((entry) => entry.id !== recall.id),
        "Only the exact RecallNotes exposure may disappear",
      );
      assert.deepEqual(
        f.primary.snapshot.executionModel!.memoryPolicy,
        model.memoryPolicy,
      );
      const refused = await invoke(f, request);
      assert.notEqual(refused.contributionId, recalled.contributionId);
      assert.equal(refused.value.code, "BEHAVIOR_NOT_AUTHORIZED");
      assert.equal(
        refused.events.filter((event) => event.kind === "behavior-called")
          .length,
        0,
      );
      assert.equal(
        refused.events.filter((event) => event.kind === "behavior-completed")
          .length,
        0,
      );
      assert.equal(
        f.primary.snapshot.executionModel!.version.repositoryVersion,
        adopted.publication!.version,
      );
      assert.deepEqual(
        sortedNotes(await f.postgres.diagnostics.memory(owner)),
        sortedNotes(f.retainedMemory),
      );
      await assertRetained(f, before);
      await f.captureEvidence("memory-recall-disabled-refusal");
      await f.verifyRetainedMemory();
    } catch (error) {
      f.preserveEvidence();
      await f.captureEvidence("memory-recall-failure");
      throw error;
    } finally {
      await f.close();
    }
  },
});
