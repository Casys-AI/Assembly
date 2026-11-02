import { ModelContextLink } from "../view/ModelContextLink.tsx";
import type { OperatorTool } from "../../../src/domain/work/records/conversations.ts";
import {
  candidatePresentation,
  type CandidateRead,
} from "../../lib/system/tools/candidates.ts";
import { toolProposalHref } from "../../lib/model/tool-proposal-location.ts";

/** One exact runtime occurrence; the visible words carry its state as well as its colour. */
export function ToolCandidateChip(
  { tool, read, label = tool.candidate.name || "Unnamed tool", occurrence }: {
    tool: OperatorTool;
    read: CandidateRead;
    label?: string;
    occurrence?: string;
  },
) {
  const { state } = candidatePresentation(tool, read);
  return (
    <ModelContextLink
      class={`chip tool-candidate-chip${
        state.tone === "warning" &&
          tool.candidate.stage === "awaiting-admission"
          ? " warn"
          : state.tone === "failed"
          ? " is-failed"
          : ""
      }`}
      href={toolProposalHref(tool)}
      title={[
        tool.candidate.description,
        state.note,
        `Operator: ${tool.agentName || tool.agentId} (${tool.agentId})`,
      ].filter(Boolean).join("\n")}
      data-operator={tool.agentId}
      data-candidate={tool.candidate.id}
      data-occurrence={occurrence}
    >
      <span>{label}</span>
      <span class="tool-chip-state">{state.label}</span>
    </ModelContextLink>
  );
}
