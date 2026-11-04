import { equal } from "node:assert/strict";
import type { MemoryContent } from "../../domain/memory/entities/memory-record.ts";
import type { Message } from "../work/runtime/state.ts";
import { workspaceMemoryProvenance } from "./workspace-memory-provenance.ts";

Deno.test("workspace memory provenance resolves exact local decisions, sources and observed outcomes", async () => {
  const execution = {
    digest: "digest",
    repositoryVersion: "pin",
    actionId: "action",
    sourceIds: ["action"],
  };
  const messages: Message[] = [
    { id: "decision", role: "assistant", text: "", at: "now", execution },
    {
      id: "source",
      role: "tool",
      text: "",
      at: "now",
      execution,
      observation: { kind: "tool-result", value: "observed" },
    },
  ];
  const provenance = workspaceMemoryProvenance((ownerId) =>
    ownerId === "owner" ? { messages } : undefined
  );
  const content: MemoryContent = {
    text: "A recorded fact",
    origin: { decisionId: "decision", sourceRefs: ["message:source"] },
    scope: ["scope"],
    validUntil: "later",
    outcome: {
      status: "known",
      summary: "Observed",
      evidenceRefs: ["message:source"],
    },
  };
  equal(await provenance.verify("owner", content), true);
  equal(await provenance.verify("another-owner", content), false);
  content.origin.decisionId = "source";
  equal(await provenance.verify("owner", content), false);
  content.origin.decisionId = "decision";
  messages[0].execution = { ...execution, actionId: undefined };
  equal(await provenance.verify("owner", content), false);
  messages[0].execution = execution;
  for (const source of ["source", "message:absent"]) {
    content.origin.sourceRefs = [source];
    equal(await provenance.verify("owner", content), false);
  }
  content.origin.sourceRefs = ["message:source"];
  messages[1].execution = { ...execution, digest: "" };
  equal(await provenance.verify("owner", content), false);
  messages[1].execution = execution;
  delete messages[1].observation;
  equal(await provenance.verify("owner", content), false);
  content.outcome = { status: "pending" };
  equal(await provenance.verify("owner", content), true);
});
