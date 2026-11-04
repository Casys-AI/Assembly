import { deepStrictEqual, equal } from "node:assert/strict";
import { publishedArtifact } from "../../../../test/support/tool-artifact-fixture.ts";
import type { MessageObservation } from "../../../domain/work/policies/context-separation.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type {
  ConversationObservationHost,
  ConversationTurnState,
} from "./turn-context.ts";
import { observeOutcome } from "./observation.ts";

Deno.test("completed source tools are observed without manufacturing a Candidate; local history keeps its candidate identity", async () => {
  const { model, candidate } = await publishedArtifact();
  const page = {
    url: "https://example.org/page",
    title: "Observed page",
    text: "External content",
  };
  for (const local of [false, true]) {
    const state: SystemRuntimeState = {
      id: "case-runtime",
      revision: 0,
      catalogRevision: 0,
      messages: [],
      candidates: local ? [structuredClone(candidate)] : [],
      events: [],
      busy: false,
      phase: "idle",
      provider: "fixture",
    };
    const feedback: { text: string; observation?: MessageObservation }[] = [];
    const host: ConversationObservationHost = {
      ports: { clock: { now: () => "2026-11-03T00:00:00.000Z" } },
      state,
      get snapshot() {
        return structuredClone(state);
      },
      update(change) {
        change(state);
        return Promise.resolve();
      },
      currentModel: () => Promise.resolve(model),
      inspectModelVersion: () => Promise.resolve(model),
      say: () => Promise.resolve(),
      feedback: (text, observation) => {
        feedback.push({ text, observation });
        return Promise.resolve();
      },
      candidate: () => {
        throw new Error("Observation must not resolve a Candidate");
      },
      observeToolFailure: () => Promise.reject(new Error("Unexpected failure")),
    };
    const turn: ConversationTurnState = {
      resumedContribution: false,
      proposals: 0,
      decisions: 0,
      sourceDecision: {},
      failures: new Map(),
    };
    await observeOutcome.call(host, turn, model, {
      outcome: {
        succeeded: true,
        code: "TOOL_COMPLETED",
        toolId: candidate.id,
        result: page,
        details: JSON.stringify(page),
      },
    });
    equal(feedback.length, 1);
    equal(feedback[0].text.includes(candidate.name), true);
    deepStrictEqual(feedback[0].observation, {
      kind: "tool-result",
      value: page,
    });
    equal(state.phase, "L’agent prépare sa réponse");
    equal(state.events.length, 1);
    equal(state.events[0].kind, "tool-completed");
    equal(state.events[0].candidateId, local ? candidate.id : undefined);
    equal(
      state.events[0].elementId,
      local ? candidate.binding?.elementId : model.catalog[0].nativeId,
    );
    deepStrictEqual(state.candidates, local ? [candidate] : []);
  }
});
