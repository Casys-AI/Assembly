/** Controlled provider for the real Case network-permission witness.
 * It supplies decisions only: it does not fabricate proposals, effects,
 * checkpoints, admissions, decisions, publication or adoption receipts. */
import assert from "node:assert/strict";
import type { AgentPort } from "../../src/application/work/runtime/ports.ts";
import { retainedWitnessUrl } from "./request-retained-tool-witness.ts";

export function caseNetworkWitnessAgent(): {
  agent: AgentPort;
  armProposal(caseId: string): void;
  armTool(caseId: string): void;
  armRefusal(
    caseId: string,
    expected: { changeId: string; inputMessageId: string; modelDigest: string },
  ): void;
  refusals: Array<
    {
      caseId: string;
      changeId: string;
      feedbackId: string;
      inputMessageId: string;
      modelDigest: string;
    }
  >;
  observations: Array<
    { caseId: string; modelDigest: string; version?: string }
  >;
  diagnostics: Array<{ caseId?: string; phase: string; failed?: true }>;
} {
  const phase = new Map<string, "proposal" | "tool" | "refusal">();
  const expectedRefusals = new Map<
    string,
    { changeId: string; inputMessageId: string; modelDigest: string }
  >();
  const refusals: Array<
    {
      caseId: string;
      changeId: string;
      feedbackId: string;
      inputMessageId: string;
      modelDigest: string;
    }
  > = [];
  const observations: Array<
    { caseId: string; modelDigest: string; version?: string }
  > = [];
  const diagnostics: Array<{ caseId?: string; phase: string; failed?: true }> =
    [];
  function observe(caseId: string | undefined, phase: string, failed?: true) {
    if (
      failed &&
      diagnostics.some((entry) =>
        entry.failed && entry.caseId === caseId && entry.phase === phase
      )
    ) return;
    diagnostics.push({ caseId, phase, ...(failed ? { failed } : {}) });
    if (diagnostics.length > 128) {
      const expendable = diagnostics.findIndex((entry) => !entry.failed);
      if (expendable >= 0) diagnostics.splice(expendable, 1);
    }
  }
  return {
    observations,
    refusals,
    diagnostics,
    armProposal(caseId) {
      observe(caseId, "armed-proposal");
      phase.set(caseId, "proposal");
    },
    armTool(caseId) {
      observe(caseId, "armed-tool");
      phase.set(caseId, "tool");
    },
    armRefusal(caseId, expected) {
      observe(caseId, "armed-refusal");
      expectedRefusals.set(caseId, expected);
      phase.set(caseId, "refusal");
    },
    agent: {
      label: "Controlled Case network decision witness",
      decide(context) {
        const caseId = context.case?.id;
        const model = context.admittedModelVersion;
        let checkpoint = "context-case-and-model";
        observe(caseId, checkpoint);
        try {
          assert(
            caseId && model,
            "The provider must see the exact Case and admitted model",
          );
          observations.push({
            caseId,
            modelDigest: model.digest,
            version: model.repositoryVersion,
          });
          const next = phase.get(caseId);
          checkpoint = `decision-${next ?? "default-reply"}`;
          observe(caseId, checkpoint);
          if (next === "refusal") {
            const expected = expectedRefusals.get(caseId);
            checkpoint = "refusal-expectation";
            assert(expected);
            checkpoint = "refusal-active-input";
            assert.equal(context.activeInputMessageId, expected.inputMessageId);
            checkpoint = "refusal-model-pin";
            assert.equal(model.digest, expected.modelDigest);
            checkpoint = "refusal-configuration";
            assert(
              context.configuration?.changes.some((change) =>
                change.id === expected.changeId && change.status === "refused"
              ),
            );
            const feedback = context.messages.filter((message) =>
              message.role === "tool" &&
              message.caseId === caseId &&
              /^network-refusal-feedback:[a-f0-9]{64}$/.test(message.id)
            );
            checkpoint = "refusal-feedback-count";
            assert.equal(
              feedback.length,
              1,
              "The provider must consume the real persisted refusal feedback",
            );
            checkpoint = "refusal-feedback-text";
            assert.equal(
              feedback[0].text,
              "Évolution refusée ; droits conservés.",
            );
            refusals.push({
              caseId,
              changeId: expected.changeId,
              feedbackId: feedback[0].id,
              inputMessageId: expected.inputMessageId,
              modelDigest: model.digest,
            });
            expectedRefusals.delete(caseId);
            phase.delete(caseId);
            observe(caseId, "refusal-reply-selected");
            return Promise.resolve({
              kind: "reply" as const,
              text: "Refusal acknowledged without using that host.",
            });
          }
          if (next === "proposal") {
            phase.delete(caseId);
            return Promise.resolve({
              kind: "propose_mandate_change" as const,
              text: "Request the page host",
              reason: "Read the selected page",
              requestedRights: { addNetworkHosts: ["example.org"] },
            });
          }
          if (next === "tool") {
            checkpoint = "retained-tool-selection";
            const matches = context.activeTools.filter((tool) =>
              tool.name === "retained-page" && tool.kind === "read_web_page"
            );
            assert.equal(
              matches.length,
              1,
              "The exact admitted retained tool is required",
            );
            phase.delete(caseId);
            return Promise.resolve({
              kind: "invoke_tool" as const,
              text: "Read the selected page",
              toolId: matches[0].id,
              input: { url: retainedWitnessUrl },
            });
          }
          return Promise.resolve({
            kind: "reply" as const,
            text: "Witness ready",
          });
        } catch (error) {
          // The check label is fixed witness metadata; assertion messages can
          // contain raw context and therefore never enter this diagnostic.
          observe(caseId, checkpoint, true);
          throw error;
        }
      },
      review() {
        throw new Error("The witness never fabricates a review");
      },
    },
  };
}
