import { RequestSource } from "./RequestSource.tsx";
import { useEffect, useRef } from "preact/hooks";
import { withModelViewContext } from "../../lib/workbench/model-context.ts";
import { followsLink, modelHref } from "../../lib/workbench/desk.ts";
import { viewHref } from "../../lib/workbench/view-location.ts";
import {
  caseAgentHref,
  caseHref,
  caseKindLabel,
  type CaseRecord,
  caseStatusLabel,
  caseTitle,
  isOpenCase,
  since,
} from "../../lib/cases/cases.ts";
import {
  caseHasPendingDecision,
  type PendingDecision,
} from "../../lib/decide/pending.ts";
import { caseTree, caseTreeAgent } from "../../lib/cases/tree.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { AgentPanel } from "../conversations/AgentPanel.tsx";
import { CaseTree } from "./CaseTree.tsx";
import { ChatView } from "../conversations/ChatView.tsx";
import { caseActivity } from "../../lib/cases/seen.ts";
import { ChatTimeline, entriesFor } from "../conversations/ChatTimeline.tsx";

const pinMark = (
  <svg
    class="cases-pin"
    viewBox="0 0 16 16"
    role="img"
    aria-label="Pinned"
  >
    <title>Pinned</title>
    <path d="M6 2.5h4M6.8 2.5v4L4.5 9h7L9.2 6.5v-4M8 9v4.5" />
  </svg>
);

/** Newest first: an open Request by its start, a closed one by its end. */
function newestFirst(records: CaseRecord[]): CaseRecord[] {
  const at = (record: CaseRecord) =>
    Date.parse(isOpenCase(record) ? record.createdAt : record.closedAt ?? "") ||
    Date.parse(record.createdAt);
  return records.sort((a, b) => at(b) - at(a) || b.number - a.number);
}

/** The way back to the list; following it lets go of a Case just started. */
const backLink = (onBack: () => void, mainHidden: boolean) => (
  <a
    class="cases-back"
    href={viewHref("/cases", { main: mainHidden ? "hidden" : null })}
    onClick={(event) => followsLink(event) && onBack()}
  >
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
    Requests
  </a>
);

/**
 * The Requests page, in two views. `/cases` lists every Request, open ones first,
 * with the field below: writing there starts a new Case, which replaces the
 * list. `/cases?case=` is one Request: its actions above, its agents as a tree
 * on the left (the owner, then each agent under the one that asked it for
 * work), the selected conversation in the middle, with the composer under the
 * owner's thread, and the selected agent's panel on the right. A sub-agent's
 * messages are only read.
 */
export function CasesPage(
  {
    state,
    active,
    selectedId,
    agentId,
    decisions,
    onStarted,
    onBack,
    now,
    compact = false,
    mainHidden = false,
  }: {
    state: WorkbenchState;
    /** The page is on screen: its conversation follows new messages. */
    active: boolean;
    /** The Request selected by the address, or the one just started here. */
    selectedId: string | null;
    /** The sub-agent whose messages in the Request the address reads. */
    agentId?: string | null;
    /** What waits for the person, in main and in the Requests. */
    decisions: readonly PendingDecision[];
    onStarted(caseId: string): void;
    /** The link to the list was followed: the page's address is `/cases`. */
    onBack(): void;
    now?: number;
    /** The same selected conversation beside System/Model; no auxiliary panels. */
    compact?: boolean;
    mainHidden?: boolean;
  },
) {
  const cases = state.requests.cases;
  const snapshot = cases.snapshot.value;
  const selected = cases.byId(selectedId);
  const agents = selectedId
    ? state.requests.snapshots.value.get(selectedId)?.conversations ?? []
    : [];
  useEffect(() => {
    if (!active || !selectedId) return;
    void cases.ensure(selectedId);
    void state.requests.loadScope(selectedId);
    const refresh = () => {
      if (
        state.requests.sessionReady.peek() &&
        (typeof document === "undefined" ||
          document.visibilityState === "visible")
      ) void state.requests.refresh(selectedId);
    };
    refresh();
    // Request SSE is not connected. Only the selected read is polled; no work starts.
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [active, selectedId, state.requests.sessionReady.value]);
  // Writing in a new Case replaces the list by the Case's own field while the
  // Case loads: the person keeps writing there.
  const root = useRef<HTMLDivElement>(null);
  const justStarted = useRef(false);
  useEffect(() => {
    if (!justStarted.current || !selected || !isOpenCase(selected)) return;
    justStarted.current = false;
    root.current?.querySelector<HTMLTextAreaElement>(".composer-input")
      ?.focus();
  }, [selected?.id]);
  const requests = (snapshot?.cases ?? []).filter((record) =>
    record.type === "request"
  );
  const lists = {
    open: newestFirst(requests.filter(isOpenCase)),
    done: newestFirst(requests.filter((record) => !isOpenCase(record))),
  };
  const openCases = cases.open.value;
  const ownerOf = (record: CaseRecord) =>
    agents.find((entry) => entry.nativeId === record.owner);
  // What happened in each Case since the viewer last looked; the Case on
  // screen is seen as it happens.
  const activity = caseActivity(agents);
  const seenKey = JSON.stringify(activity);
  useEffect(() => {
    if (snapshot) state.caseSeen.baseline(activity);
    if (active && selected) {
      state.caseSeen.mark(selected.id, activity[selected.id]);
    }
  }, [Boolean(snapshot), active, selected?.id, seenKey]);
  const renderRow = (record: CaseRecord) => {
    const needsYou = isOpenCase(record) &&
      caseHasPendingDecision(
        record,
        openCases,
        ownerOf(record)?.agentId,
        decisions,
      );
    // A filled dot: something to see, a decision or what happened since.
    const toSee = needsYou ||
      state.caseSeen.unseen(record.id, activity[record.id]);
    return (
      <li key={record.id}>
        <a
          class="rev-row"
          href={viewHref(caseHref(record.id), {
            main: mainHidden ? "hidden" : null,
          })}
          title={record.objective}
        >
          <span
            class={toSee ? "rev-dot is-filled" : "rev-dot"}
            aria-label={toSee ? "Something to see" : undefined}
          />
          <span class="rev-title">{caseTitle(record, 80)}</span>
          <span class="rev-meta">
            <span>
              {since(
                isOpenCase(record)
                  ? record.createdAt
                  : record.closedAt ?? record.createdAt,
                now,
              )}
            </span>
            {needsYou && <span class="chip warn">needs you</span>}
            {state.pins.has(record.id) && pinMark}
          </span>
        </a>
      </li>
    );
  };
  if (selectedId === null) {
    return (
      <div class="cases-page is-list" ref={root}>
        <header class="cases-head">
          <h1>Requests</h1>
        </header>
        <div class="cases-body">
          <nav class="cases-list" aria-label="Requests">
            {snapshot === null
              ? (
                <p class="cases-note" role="status">
                  {cases.error.value || (cases.supported.value === false
                    ? "Not available yet"
                    : "Loading…")}
                </p>
              )
              : (["open", "done"] as const).map((group) =>
                lists[group].length > 0 && (
                  <section
                    key={group}
                    aria-label={group === "open" ? "Open" : "Done"}
                  >
                    <p class="feed-group">
                      {group === "open" ? "Open" : "Done"}
                    </p>
                    <ol>{lists[group].map(renderRow)}</ol>
                  </section>
                )
              )}
          </nav>
          <section class="cases-detail chat" aria-label="New request">
            <ChatView
              state={state}
              active={active}
              showHeading={false}
              idPrefix="cases-"
              target="new-case"
              independentRequest
              beforeComposer={<RequestSource state={state} active={active} />}
              onCaseStarted={(caseId) => {
                justStarted.current = true;
                onStarted(caseId);
              }}
              placeholder="What do you need?"
            />
          </section>
        </div>
      </div>
    );
  }
  if (!selected) {
    return (
      <div
        class={`cases-page is-case${compact ? " is-compact" : ""}`}
        ref={root}
      >
        {backLink(onBack, mainHidden)}
        <section class="cases-detail chat" aria-label="Case">
          <CaseUnavailable state={state} caseId={selectedId} />
          <RequestSource state={state} active={active} authOnly />
        </section>
      </div>
    );
  }
  const owner = ownerOf(selected);
  const tree = caseTree(agents, selected, owner ?? null);
  // An agent that took no part in this Case leaves the owner's thread selected.
  const reading = caseTreeAgent(tree, agentId);
  const shown = reading ?? tree;
  const unsupportedSelection = !!agentId && agentId !== owner?.agentId &&
    !reading;
  return (
    <div class={`cases-page is-case${compact ? " is-compact" : ""}`} ref={root}>
      {compact
        ? (
          <a
            class="cases-back"
            href={agentId
              ? caseAgentHref(selected.id, agentId)
              : caseHref(selected.id)}
          >
            Open full Request
          </a>
        )
        : backLink(onBack, mainHidden)}
      {!state.requests.sessionReady.value && (
        <RequestSource state={state} active={active} authOnly />
      )}
      <CaseHead
        state={state}
        record={selected}
        owner={owner?.name}
        agentId={agentId}
      />
      {compact && agentId && (
        <p class="cases-selected-conversation">
          {reading?.name ?? (agentId === owner?.agentId ? owner.name : agentId)}
        </p>
      )}
      <div class={`cases-body${shown.agent ? "" : " no-panel"}`}>
        <CaseTree
          key={selected.id}
          root={tree}
          caseId={selected.id}
          selected={shown}
          showLiveStatus={isOpenCase(selected)}
          mainHidden={mainHidden}
        />
        {unsupportedSelection
          ? (
            <section class="cases-detail chat">
              <p class="conversation-unavailable" role="status">
                The selected Request conversation is unavailable.
              </p>
            </section>
          )
          : reading
          ? (
            <section
              class="cases-detail chat"
              aria-label={reading.name}
            >
              <div class="exchange-messages cases-reading">
                {/* What this agent asks of the person in this Request waits here. */}
                <ChatTimeline
                  state={state}
                  entries={reading.agent
                    ? entriesFor(
                      reading.agent.messages.map((message) => ({
                        kind: "message" as const,
                        id: `message:${message.id}`,
                        at: message.at,
                        message,
                      })).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
                      {
                        caseId: selected.id,
                      },
                    ).concat(
                      (reading.agent.proposalContext?.changes ?? []).filter((
                        change,
                      ) =>
                        change.caseId === selected.id
                      ).map((change) => ({
                        kind: "change" as const,
                        id: `change:${reading.agent!.agentId}:${change.id}`,
                        at: change.requestedAt,
                        change,
                      })),
                    )
                    : []}
                  conversation={reading.agent}
                  independentRequest
                  caseId={selected.id}
                  caseLinks={false}
                />
              </div>
            </section>
          )
          : (
            <section
              class="cases-detail chat"
              aria-label={caseTitle(selected)}
            >
              {/* The owner's conversation: an operator's Request is its own. */}
              <ChatView
                state={state}
                active={active}
                showHeading={false}
                idPrefix="cases-"
                conversation={owner}
                target={{ caseId: selected.id }}
                independentRequest
                placeholder="Reply…"
                composer={isOpenCase(selected)}
              />
            </section>
          )}
        {shown.agent && (
          <AgentPanel
            key={shown.agent.agentId}
            state={state}
            conversation={shown.agent}
            requestCaseId={selected.id}
          />
        )}
      </div>
    </div>
  );
}

/** A Case named by the address that is loading, missing, or unreadable. */
function CaseUnavailable(
  { state, caseId }: { state: WorkbenchState; caseId: string },
) {
  const status = state.requests.cases.detailStatus(caseId);
  return (
    <p class="cases-note" role="status">
      {status === "not-found"
        ? "Case not found"
        : status === "error"
        ? state.requests.cases.detailError(caseId)
        : "Loading…"}
    </p>
  );
}

/** What the selected Request is, and what can be done to it. */
function CaseHead(
  { state, record, owner, agentId }: {
    state: WorkbenchState;
    record: CaseRecord;
    owner?: string;
    agentId?: string | null;
  },
) {
  const name = caseTitle(record, 96);
  const scope = state.requests.scopes.value.get(record.id);
  const pinned = state.pins.has(record.id);
  const current = state.requests.snapshots.value.get(record.id);
  // Current conversation polling owns this selected observation, including its
  // disappearance after a later input. An older cases-cache flag cannot revive it.
  const outcome = current
    ? current.conversations.find((agent) =>
      agent.agentId === current.defaultAgentId
    )?.initialExecutionOutcome
    : record.initialExecutionOutcome;

  return (
    <header class="cases-detail-head">
      <h2>{name}</h2>
      <p class="workspace-model-version" title={scope?.version}>
        {scope
          ? `Request · ${scope.branchId} · Model ${
            scope.version.replace(/^commit:/, "").slice(0, 8)
          } · read-only`
          : "Request · model version unavailable"}
      </p>
      {/* The full request only when it says more than its name. */}
      {name.replace(/[.?!\s]+$/, "") !==
          record.objective.trim().replace(/[.?!\s]+$/, "") && (
        <p class="cases-objective" title={record.objective}>
          {record.objective}
        </p>
      )}
      <div class="cases-bar">
        <div class="cases-chips">
          <span class="chip">{caseKindLabel[record.type]}</span>
          <span class="chip">{caseStatusLabel[record.status]}</span>
          {outcome === "refused" && (
            <span class="chip">Initial execution refused</span>
          )}
          {owner && <span class="chip ghost">{owner}</span>}
        </div>
        <div class="decide">
          <a
            href={withModelViewContext(modelHref("files"), {
              caseId: record.id,
              agentId: agentId ?? null,
            })}
          >
            View model
          </a>
          <button type="button" onClick={() => state.pins.toggle(record.id)}>
            {pinned ? "Unpin" : "Pin"}
          </button>
        </div>
      </div>
      {state.requests.error.value && (
        <p class="cases-error" role="alert">{state.requests.error.value}</p>
      )}
    </header>
  );
}
