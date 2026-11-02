import { useState } from "preact/hooks";
import { caseAgentHref, caseHref } from "../../lib/cases/cases.ts";
import type { CaseTreeNode } from "../../lib/cases/tree.ts";
import { monogram } from "../../lib/workbench/desk.ts";
import { viewHref } from "../../lib/workbench/view-location.ts";

const chevron = (
  <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    <path d="M4.5 3 7.5 6 4.5 9" />
  </svg>
);

/**
 * The agents of a Case as a compact tree, like a sidebar of files: the owner
 * at the root, each agent under the one that asked it for work. Every row is a
 * link to that agent's conversation in the Case; a branch can be folded.
 */
export function CaseTree(
  {
    root,
    caseId,
    selected,
    defaultFolded,
    showLiveStatus = true,
    mainHidden = false,
  }: {
    root: CaseTreeNode;
    caseId: string;
    /** The node whose conversation is on screen. */
    selected: CaseTreeNode;
    /** The agents whose branch starts folded; every branch starts open. */
    defaultFolded?: ReadonlySet<string>;
    /** Closed Cases retain history, not the operators' present activity. */
    showLiveStatus?: boolean;
    mainHidden?: boolean;
  },
) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(
    defaultFolded ?? new Set(),
  );
  const toggle = (key: string) =>
    setFolded((before) => {
      const next = new Set(before);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const row = (node: CaseTreeNode, level: number) => {
    const key = node.agent?.agentId ?? "owner";
    const branch = node.children.length > 0;
    const open = !folded.has(key);
    const current = node === selected;
    const count = node.messages.length;
    return (
      <li
        key={key}
        role="treeitem"
        aria-level={level}
        aria-expanded={branch ? (open ? "true" : "false") : undefined}
        aria-selected={current ? "true" : "false"}
        aria-label={node.name}
      >
        <div class="tree-row" style={`--depth:${level - 1}`}>
          {branch
            ? (
              <button
                type="button"
                class="tree-toggle"
                aria-label={`${open ? "Collapse" : "Expand"} ${node.name}`}
                onClick={() => toggle(key)}
              >
                {chevron}
              </button>
            )
            : <span class="tree-toggle" aria-hidden="true" />}
          <a
            class="tree-link"
            href={viewHref(
              level > 1 && node.agent
                ? caseAgentHref(caseId, node.agent.agentId)
                : caseHref(caseId),
              { main: mainHidden ? "hidden" : null },
            )}
            aria-current={current ? "true" : undefined}
            title={node.name}
          >
            <span class="agent-tile" aria-hidden="true">
              {monogram(node.name)}
            </span>
            <span class="tree-name">{node.name}</span>
            {showLiveStatus && node.busy && (
              <span class="tree-busy" role="img" aria-label="Working" />
            )}
            {showLiveStatus && !node.busy && count === 0 && node.agent?.phase &&
              (
                <span class="tree-phase" title={node.agent.phase}>
                  {node.agent.phase}
                </span>
              )}
            {count > 0 && (
              <span class="tree-count">
                {count}
                <span class="sr-only">
                  {count === 1 ? " message" : " messages"}
                </span>
              </span>
            )}
          </a>
        </div>
        {branch && open && (
          <ul role="group">
            {node.children.map((child) => row(child, level + 1))}
          </ul>
        )}
      </li>
    );
  };
  return (
    <nav class="case-tree" aria-label="Conversations">
      <ul role="tree" aria-label="Agents">{row(root, 1)}</ul>
    </nav>
  );
}
