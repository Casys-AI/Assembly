import type { ComponentChildren, Ref } from "preact";
import { useRef } from "preact/hooks";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { AgentContextPanel } from "./AgentContextPanel.tsx";
import { useOutsidePress } from "../view/useOutsidePress.ts";

export type AgentDetail = "mission" | "mandate" | "tools";
const details: Record<AgentDetail, string> = {
  mission: "Mission",
  mandate: "Mandate",
  tools: "Tools",
};

/**
 * A quiet panel header: the agent name reveals its mission, mandate and tools.
 * The details are read views of the selected operator; they grant nothing.
 */
export function AgentHeader(
  {
    state,
    conversation,
    fallbackName,
    detail,
    onDetail,
    idPrefix = "",
    nameRef,
    historicalRevision = null,
    team = [],
    activity,
    children,
  }: {
    state: WorkbenchState;
    /** `undefined` uses the selected conversation; `null` is unavailable. */
    conversation: AgentConversation | null | undefined;
    fallbackName: string;
    detail: AgentDetail | null;
    onDetail(detail: AgentDetail | null): void;
    idPrefix?: string;
    nameRef?: Ref<HTMLButtonElement>;
    /**
     * A past revision being read: the header names that era's agent from
     * `fallbackName` and offers no present details, never mixing two times.
     */
    historicalRevision?: number | null;
    /** The other operators, reached from the central agent's name. */
    team?: readonly {
      agentId: string;
      name: string;
      busy: boolean;
      href: string;
    }[];
    /** What the agent is doing, in a few words; replaces the raw phase. */
    activity?: string;
    children?: ComponentChildren;
  },
) {
  const area = useRef<HTMLElement>(null);
  const nameButton = useRef<HTMLButtonElement | null>(null);
  // Closing the details gives the focus back to the name when it was in them.
  // After a click elsewhere, wait for the click's own focus change: the name
  // only takes the focus if nothing else did (it would fall to the document).
  function closeDetails() {
    const inside = area.current?.contains(document.activeElement);
    onDetail(null);
    if (!inside && document.activeElement !== document.body) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (!active || active === document.body) nameButton.current?.focus();
    }, 0);
  }
  useOutsidePress(area, closeDetails, Boolean(detail));
  if (historicalRevision !== null) {
    return (
      <header class="agent-header is-historical">
        <span class="agent-header-title">{fallbackName}</span>
        <span class="agent-header-phase" role="status">
          Historical view · revision {historicalRevision}
        </span>
        {children}
      </header>
    );
  }
  const name = conversation?.name || fallbackName;
  // An unavailable operator (`null`) never shows the primary's activity.
  const legacy = conversation === undefined;
  const busy = legacy ? state.current.value?.busy : conversation?.busy;
  const phase = legacy
    ? state.current.value?.phase || ""
    : conversation?.phase || "";
  return (
    <header class="agent-header" ref={area}>
      <button
        type="button"
        class="agent-header-name"
        ref={(element) => {
          nameButton.current = element;
          if (typeof nameRef === "function") nameRef(element);
          else if (nameRef) nameRef.current = element;
        }}
        aria-expanded={detail ? "true" : "false"}
        aria-controls={`${idPrefix}agent-details`}
        onClick={() => onDetail(detail ? null : "mission")}
      >
        <span>{name}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      <span
        class={`agent-header-phase${busy ? " is-busy" : ""}`}
        role="status"
      >
        {activity ?? (busy ? phase : <span class="sr-only">{phase}</span>)}
      </span>
      {children}
      {detail && (
        <div class="agent-details" id={`${idPrefix}agent-details`}>
          <div
            class="agent-details-tabs"
            role="group"
            aria-label="Agent information"
          >
            {(Object.keys(details) as AgentDetail[]).map((tab) => (
              <button
                type="button"
                key={tab}
                id={`${idPrefix}agent-${tab}-button`}
                aria-pressed={detail === tab ? "true" : "false"}
                onClick={() => onDetail(tab)}
              >
                {details[tab]}
              </button>
            ))}
          </div>
          <AgentContextPanel
            key={`${conversation?.nativeId}:${detail}`}
            state={state}
            conversation={conversation}
            tab={detail}
            onClose={closeDetails}
          />
          {team.length > 0 && (
            <nav class="agent-team" aria-label="Operators">
              <h3>Operators</h3>
              <ul>
                {team.map((member) => (
                  <li key={member.agentId}>
                    <a
                      href={member.href}
                      data-agent-id={member.agentId}
                      onClick={() => onDetail(null)}
                    >
                      <span>{member.name}</span>
                      {member.busy && (
                        <span class="agent-team-busy">working</span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      )}
    </header>
  );
}
