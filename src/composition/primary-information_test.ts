import assert from "node:assert/strict";
import { primaryInformationPort } from "./primary-information.ts";
import {
  consultDeclaredModelSource,
  type DeclaredModelConsultationHost,
} from "../application/work/conversation/declared-model-consultation.ts";
import type { DecisionInformationPort } from "../application/work/context/information-ports.ts";
import type { MessageObservation } from "../domain/work/policies/context-separation.ts";
import { selectDesignerInvocation } from "../application/work/cases/runtime.ts";
import { requestControlState } from "../../test/support/request-space-fixture.ts";

function fixture() {
  const state = requestControlState();
  const model = state.executionModel!;
  model.policy.mayProposeSysmlRevision = true;
  model.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  selectDesignerInvocation(state);
  state.messages.push({
    id: "main-diagnostics-question",
    role: "user",
    text: "Show Diagnostics",
    at: "2026-10-30T00:00:00.000Z",
    designerScopeId: state.designer!.scopeId,
  });
  const observations: MessageObservation[] = [];
  let reads = 0, freeConsultations = 0;
  const workspace: DecisionInformationPort = {
    read: () => Promise.resolve({ memoryGuidance: [] }),
    consultModel() {
      freeConsultations++;
      throw new Error(
        "An admitted read must never fall back to design consultation",
      );
    },
    consultAdmittedModelSource(current, input, messages, budget) {
      reads++;
      assert.deepEqual(current, model);
      assert.deepEqual(input, {
        operation: "read_source",
        path: "conversation.sysml",
        version: model.version.repositoryVersion,
      });
      assert.deepEqual(messages, state.messages);
      assert.equal(budget?.maxResponseCharacters, 65536);
      return Promise.resolve({
        modelVersion: {
          digest: model.version.digest,
          repositoryVersion: model.version.repositoryVersion,
        },
        result: {
          operation: "read_source",
          version: model.version.repositoryVersion,
          path: input.path,
        },
      });
    },
  };
  let selected: DecisionInformationPort | undefined;
  const host: DeclaredModelConsultationHost = {
    snapshot: state,
    currentModel: () => Promise.resolve(structuredClone(model)),
    ports: { information: primaryInformationPort(() => selected) },
    feedback(_text, observation) {
      if (observation) observations.push(observation);
      return Promise.resolve();
    },
  };
  const run = () =>
    consultDeclaredModelSource.call(host, model, {
      nativeId: "main-mandatory-source-read",
      consultationRequest: JSON.stringify({
        operation: "read_source",
        path: "conversation.sysml",
      }),
    });
  return {
    model,
    workspace,
    observations,
    run,
    select: (reader?: DecisionInformationPort) => {
      selected = reader;
    },
    counts: () => ({ reads, freeConsultations }),
  };
}

Deno.test("Main workspace bridge lets the declared native source read retain its admitted pin and observation", async () => {
  const f = fixture();
  f.select(f.workspace);
  const outcome = await f.run();
  assert.equal(
    (outcome.outputs?.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  assert.deepEqual(f.counts(), { reads: 1, freeConsultations: 0 });
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].kind, "model-context");
  const evidence = f.observations[0].value as {
    modelVersion: { repositoryVersion: string };
    result: { version: string };
  };
  assert.equal(
    evidence.modelVersion.repositoryVersion,
    f.model.version.repositoryVersion,
  );
  assert.equal(evidence.result.version, f.model.version.repositoryVersion);
});

Deno.test("Main workspace bridge remains unavailable before binding and never replaces a missing or refused admitted source reader", async () => {
  const f = fixture();
  for (
    const reader of [
      undefined,
      { ...f.workspace, consultAdmittedModelSource: undefined },
      {
        ...f.workspace,
        consultAdmittedModelSource: () =>
          Promise.reject(
            Object.assign(new Error("Current source read refused"), {
              code: "MODEL_CONTEXT_AUTHORITY",
            }),
          ),
      },
    ]
  ) {
    f.select(reader);
    const outcome = await f.run();
    assert.equal(
      (outcome.outputs?.consultation as { succeeded: boolean }).succeeded,
      false,
    );
  }
  assert.deepEqual(f.counts(), { reads: 0, freeConsultations: 0 });
  assert.equal(f.observations.length, 0);
  // The same proxy starts working only when its actual workspace is available.
  f.select(f.workspace);
  assert.equal(
    ((await f.run()).outputs?.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  assert.deepEqual(f.counts(), { reads: 1, freeConsultations: 0 });
});

Deno.test("Main workspace bridge serves a declared source read without the revision right, never a design consultation", async () => {
  const f = fixture();
  f.select(f.workspace);
  f.model.policy.mayProposeSysmlRevision = false;
  const outcome = await f.run();
  assert.equal(
    (outcome.outputs?.consultation as { succeeded: boolean }).succeeded,
    true,
  );
  assert.deepEqual(f.counts(), { reads: 1, freeConsultations: 0 });
  assert.equal(f.observations.length, 1);
});
