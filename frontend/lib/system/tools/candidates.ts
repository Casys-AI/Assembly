import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import { indexBoard } from "../board/lookup.ts";
import type { ProfileChip } from "../team/projection.ts";
import type {
  OperatorTool,
  OperatorToolsSnapshot,
} from "../../../../src/domain/work/records/conversations.ts";
import type { Candidate } from "../../../../src/domain/work/candidates.ts";
import { operatorToolKey } from "./decisions.ts";

export interface CandidateRead {
  catalogue: OperatorToolsSnapshot | null;
  loading: boolean;
  stale: boolean;
  error: string;
}

export interface CandidateState {
  label: string;
  tone: "plain" | "active" | "warning" | "failed";
  note?: string;
}

/** An active declaration needs its native binding; a graph path is only navigation. */
export function candidateState(candidate: Candidate): CandidateState {
  switch (candidate.stage) {
    case "proposed":
      return { label: "Proposed", tone: "plain" };
    case "testing":
      return { label: "Testing", tone: "plain" };
    case "reviewing":
      return { label: "Under review", tone: "plain" };
    case "awaiting-admission":
      return { label: "Awaiting admission", tone: "warning" };
    case "activating":
      return { label: "Activating", tone: "plain" };
    case "refused":
      return {
        label: "Refused",
        tone: "failed",
        note: candidate.admissionDecision?.reason ||
          (candidate.review?.verdict === "refuse"
            ? candidate.review.reason
            : undefined),
      };
    case "failed":
      return { label: "Failed", tone: "failed", note: candidate.error };
    case "active":
      if (
        typeof candidate.binding?.elementId === "string" &&
        candidate.binding.elementId.trim().length > 0
      ) return { label: "Active", tone: "active" };
      return {
        label: "Unknown state",
        tone: "warning",
        note: "The active tool's native binding is missing.",
      };
    default:
      return { label: "Unknown state", tone: "warning" };
  }
}

/** A candidate's exact occurrence, ready to be drawn in any existing tool surface. */
export function candidatePresentation(tool: OperatorTool, read: CandidateRead) {
  const state = candidateState(tool.candidate);
  const observed = read.loading || read.stale;
  return {
    key: operatorToolKey(tool),
    tool,
    state: observed
      ? {
        ...state,
        label: `Last observed: ${state.label}`,
        tone: "plain" as const,
      }
      : state,
  };
}

/** A retained command error does not change a successfully reconciled read. */
export function candidateReadMessage(read: CandidateRead): string | undefined {
  if (!read.catalogue) {
    return read.error ||
      (read.loading
        ? "Loading the tools…"
        : "The tool catalogue is not available.");
  }
  if (read.stale || read.loading) {
    return `${
      read.stale && read.error ? read.error : "Tool status is refreshing."
    } Showing last observed states; current activity is unknown.`;
  }
  return undefined;
}

/** Native roster identities are translated explicitly; unknown owners have no fallback. */
export function ownerIdsFor(
  nativeIds: readonly string[],
  roster: readonly { nativeId: string; agentId?: string }[],
): string[] {
  return [
    ...new Set(
      roster.filter((entry) => nativeIds.includes(entry.nativeId))
        .flatMap((entry) => entry.agentId ? [entry.agentId] : []),
    ),
  ];
}

/** Labels and local candidate ids never join owners. No candidates enter the board. */
export function candidatesFor(
  read: CandidateRead,
  ownerIds: readonly string[],
): OperatorTool[] {
  return read.catalogue?.tools.filter((tool) =>
    ownerIds.includes(tool.agentId)
  ) ?? [];
}

export interface HasToolChip {
  chip?: ProfileChip;
  candidates: readonly OperatorTool[];
}

/** Replace only the declared native tool a binding identifies; homonymous skills/tools remain. */
export function hasToolChips(
  board: ModelBoard,
  declared: readonly ProfileChip[],
  tools: readonly OperatorTool[],
): HasToolChip[] {
  const index = indexBoard(board);
  const claimed = new Set<OperatorTool>();
  const chips = declared.map((chip) => {
    const candidates = index.get(chip.id)?.kind === "tool"
      ? tools.filter((tool) => {
        const binding = tool.candidate.binding;
        return binding?.elementId &&
          index.resolve(binding.elementId) === chip.id;
      })
      : [];
    for (const tool of candidates) claimed.add(tool);
    return { chip, candidates };
  });
  return [
    ...chips,
    ...tools.filter((tool) => !claimed.has(tool)).map((tool) => ({
      candidates: [tool],
    })),
  ];
}
