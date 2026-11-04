import type {
  AgentConversation,
  OperatorTool,
  OperatorToolsSnapshot,
} from "../../../src/application/work/operators/conversation-types.ts";
import { modelHref } from "../workbench/desk.ts";
import type { RevisionLocation } from "./revisions/api.ts";

/** A runtime proposal is addressed by its exact owner, candidate and content. */
export interface ToolProposalIdentity {
  operator: string;
  candidate: string;
  digest: string;
}

export function toolProposalHref(
  tool: Pick<OperatorTool, "agentId" | "candidate"> | ToolProposalIdentity,
): string {
  const target = "agentId" in tool
    ? {
      operator: tool.agentId,
      candidate: tool.candidate.id,
      digest: tool.candidate.digest,
    }
    : tool;
  return modelHref("activity", { ...target });
}

export type ToolProposalSelection =
  | { kind: "none" }
  | { kind: "invalid"; message: string }
  | { kind: "selected"; target: ToolProposalIdentity };

/** Partial, ambiguous or mixed historical addresses never select a tool. */
export function toolProposalSelection(
  location: Pick<RevisionLocation, "search">,
): ToolProposalSelection {
  const params = new URLSearchParams(location.search);
  const names = ["operator", "candidate", "digest"] as const;
  if (!names.some((name) => params.has(name))) return { kind: "none" };
  if (
    names.some((name) =>
      params.getAll(name).length !== 1 || !params.get(name)?.trim()
    )
  ) {
    return {
      kind: "invalid",
      message:
        "The tool proposal address needs one operator, candidate and digest.",
    };
  }
  if (
    ["commit", "proposal", "from", "revision", "modelVersion", "version"]
      .some((name) => params.has(name))
  ) {
    return {
      kind: "invalid",
      message:
        "A current tool proposal cannot be mixed with a historical model selection.",
    };
  }
  return {
    kind: "selected",
    target: {
      operator: params.get("operator")!,
      candidate: params.get("candidate")!,
      digest: params.get("digest")!,
    },
  };
}

export type ToolProposalRead =
  | { status: "ready"; tool: OperatorTool; conversation: AgentConversation }
  | { status: "unavailable"; code: string; message: string };

/** Resolve only catalog occurrences; legacy primary candidates have no invented owner. */
export function readToolProposal(
  target: ToolProposalIdentity,
  read: {
    catalogue: OperatorToolsSnapshot | null;
    conversations: readonly AgentConversation[] | undefined;
    loading: boolean;
    stale: boolean;
    historical: boolean;
  },
): ToolProposalRead {
  const unavailable = (code: string, message: string): ToolProposalRead => ({
    status: "unavailable",
    code,
    message,
  });
  if (read.historical) {
    return unavailable(
      "tool-proposal-historical",
      "Current tool proposals are unavailable while viewing a historical model.",
    );
  }
  if (read.loading) {
    return unavailable("tool-proposal-loading", "Reading the tool catalogue…");
  }
  if (!read.catalogue) {
    return unavailable(
      "tool-proposal-catalogue-absent",
      "The tool catalogue is not available.",
    );
  }
  if (read.stale) {
    return unavailable(
      "tool-proposal-catalogue-stale",
      "The tool catalogue is out of date. Read it again to inspect this proposal.",
    );
  }
  const conversation = read.conversations?.find((entry) =>
    entry.agentId === target.operator
  );
  if (!conversation) {
    return unavailable(
      "tool-proposal-owner-absent",
      "The operator that owns this tool proposal is not available.",
    );
  }
  const tool = read.catalogue.tools.find((entry) =>
    entry.agentId === target.operator && entry.candidate.id === target.candidate
  );
  if (!tool) {
    return unavailable(
      "tool-proposal-candidate-absent",
      "This tool proposal is not in this operator’s catalogue.",
    );
  }
  if (tool.candidate.digest !== target.digest) {
    return unavailable(
      "tool-proposal-digest-changed",
      "This tool proposal has changed. Open its current chip to inspect the new content.",
    );
  }
  return { status: "ready", tool, conversation };
}
