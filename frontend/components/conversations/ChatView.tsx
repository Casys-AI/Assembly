import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentConversation } from "../../../src/application/work/operators/conversation-types.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { caseOperatorName } from "../../lib/cases/operator-names.ts";
import { createScrollKeeper } from "../../lib/conversations/scroll.ts";
import { takesHumanMessage } from "../../lib/conversations/state.ts";
import {
  caseExchanges,
  caseModelUpdates,
  chatEntries,
  ChatTimeline,
  type ConversationTarget,
  entriesFor,
  pendingProposalCount,
  withExchanges,
} from "./ChatTimeline.tsx";
import { exceedsBound, FreeTextCount } from "./FreeTextCount.tsx";

/**
 * One conversation read top to bottom: the oldest entry first, the latest just
 * above the composer, with the view following new messages like Messages.
 * Without `conversation`, it shows the selected agent and its shared draft; a
 * view bound to another agent writes to it and prefixes its element ids. Every
 * draft lives in the conversations store, so it follows its agent across panels.
 */
export function ChatView(
  {
    state,
    active,
    showHeading = true,
    idPrefix = "",
    presentHref,
    ...props
  }: {
    state: WorkbenchState;
    active: boolean;
    showHeading?: boolean;
    conversation?: AgentConversation | null;
    idPrefix?: string;
    /** Where "back to the present" navigates when a URL holds the revision. */
    presentHref?: string;
    /**
     * Which conversation of the central agent: the designer's (no Case), one
     * Case, or a new Case. Only its entries show and a message goes to it; a
     * first message in a new Case reports the Case it opened. A Case's thread
     * also folds what the other agents said for it, one line per agent.
     */
    target?: ConversationTarget;
    onCaseStarted?(caseId: string): void;
    /** Replaces the composer's placeholder and its accessible name. */
    placeholder?: string;
    /** False for a conversation that ends: no composer, nothing to write in. */
    composer?: boolean;
    /** Durable Request transport; never use the Main conversation as recovery. */
    independentRequest?: boolean;
    beforeComposer?: ComponentChildren;
  },
) {
  const snapshot = props.independentRequest ? null : state.displayed.value;
  const input = useRef<HTMLTextAreaElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const independent = props.independentRequest === true;
  const readOnly = !independent && state.readOnly.value;
  const newRequest = independent && props.target === "new-case";
  const bound = independent || props.conversation !== undefined;
  const conversation = bound
    ? props.conversation ?? null
    : state.selectedConversation.value;
  const conversations = independent
    ? typeof props.target === "object"
      ? state.requests.snapshots.value.get(props.target.caseId) ?? null
      : null
    : state.conversationSnapshot.value;
  // A bound view of another agent writes to that agent, with that agent's draft.
  const own = bound && conversation !== null &&
    conversation.agentId !== state.selectedConversation.value?.agentId;
  // A Case page keeps its own draft per Case: never the designer's.
  const caseScoped = props.target !== undefined && props.target !== "designer";
  const targetCaseId = typeof props.target === "object"
    ? props.target.caseId
    : undefined;
  // In a Case, its generic operator goes by its Branch Operator's name.
  const addressee = conversation &&
    caseOperatorName(
      conversation.name,
      state.requests.cases.byId(targetCaseId),
    );
  const draftKey = targetCaseId ?? "new-case";
  const [caseDrafts, setCaseDrafts] = useState<Record<string, string>>({});
  const caseDraft = caseDrafts[draftKey] ?? "";
  const setCaseDraft = (value: string) =>
    setCaseDrafts((drafts) => ({ ...drafts, [draftKey]: value }));
  const draft = caseScoped
    ? caseDraft
    : own
    ? state.agentConversations.draftFor(conversation.agentId)
    : state.draft.value;
  function setDraft(value: string) {
    if (caseScoped) setCaseDraft(value);
    else if (own) {
      state.agentConversations.setDraft(conversation.agentId, value);
    } else state.draft.value = value;
  }
  // An operator without a human entry still continues the open Request it owns.
  const canAct = independent
    ? newRequest
      ? state.requests.sessionReady.value && !state.requests.pending.value
      : !!targetCaseId && state.requests.canSend(targetCaseId, conversation)
    : own
    ? !readOnly &&
      state.agentConversations.canSendTo(conversation.agentId, targetCaseId)
    : state.canChat.value;
  const takesMessage = independent || !conversation ||
    takesHumanMessage(conversation, targetCaseId);
  const messages = conversation?.messages ||
    (bound ? [] : snapshot?.messages) || [];
  const all = independent
    ? [
      ...(conversation?.messages ?? []).map((message) => ({
        kind: "message" as const,
        id: `message:${message.id}`,
        at: message.at,
        message,
      })),
      ...(conversation?.effectiveModelUpdates ?? []).map((update) => ({
        kind: "model-update" as const,
        id: `model-update:${update.id}`,
        at: update.activatedAt,
        update,
      })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    : bound && !conversation
    ? []
    : chatEntries(state, conversation);
  const target = props.target;
  const scopedEntries = target ? entriesFor(all, target) : all;
  const entries = independent && targetCaseId && conversation
    ? [
      ...scopedEntries,
      ...(conversation.proposalContext?.changes ?? []).filter((change) =>
        change.caseId === targetCaseId
      ).map((change) => ({
        kind: "change" as const,
        id: `change:${conversation.agentId}:${change.id}`,
        at: change.requestedAt,
        change,
      })),
    ].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0))
    : scopedEntries;
  const proposalsPending = pendingProposalCount(entries);
  const timeline = withExchanges(
    entries,
    !independent && !readOnly && typeof target === "object"
      ? caseExchanges(
        conversations?.conversations ?? [],
        target.caseId,
        conversation,
      )
      : [],
    !independent && !readOnly && typeof target === "object"
      ? caseModelUpdates(
        conversations?.conversations ?? [],
        target.caseId,
        conversation,
      )
      : [],
  );
  const conversationKey = readOnly
    ? `history:${state.selectedRevision.value}`
    : JSON.stringify([
      conversations?.systemId || snapshot?.id || "",
      conversation?.nativeId || "legacy",
      ...(caseScoped ? [draftKey] : []),
    ]);
  const [keeper] = useState(createScrollKeeper);
  const id = (name: string) => idPrefix + name;
  const operatorId = conversation?.nativeId ||
    (bound ? undefined : snapshot?.executionModel?.identity.builderId);
  useEffect(() => {
    if (
      independent || !active || readOnly || !operatorId ||
      conversation?.runtimeOwned === false ||
      snapshot?.busy || conversation?.busy
    ) return;
    const timer = setTimeout(() => {
      void state.chatProposals.refresh(operatorId);
    }, 80);
    return () => clearTimeout(timer);
  }, [
    active,
    readOnly,
    operatorId,
    snapshot?.revision,
    conversations?.version,
  ]);
  useEffect(() => {
    keeper.settle(scroll.current, conversationKey, active);
  }, [
    conversationKey,
    messages.length,
    messages.at(-1)?.text,
    timeline.length,
    active,
  ]);
  // Past the host's bound the text stays whole and sending waits: no cut.
  const tooLong = exceedsBound(draft);
  const ready = canAct && draft.trim() !== "" && !tooLong;
  useEffect(() => {
    if (newRequest && state.requests.intent.value) {
      setCaseDraft(state.requests.intent.value.text);
    }
  }, [newRequest, state.requests.intent.value?.openingKey]);
  async function send() {
    if (independent) {
      if (newRequest) {
        const caseId = await state.requests.open(caseDraft);
        if (caseId) {
          setCaseDraft("");
          props.onCaseStarted?.(caseId);
        }
      } else if (
        targetCaseId && conversation &&
        await state.requests.send(targetCaseId, conversation, caseDraft)
      ) {
        setCaseDraft("");
      }
      input.current?.focus();
      return;
    }
    if (!own) {
      const caseId = target === undefined || target === "designer"
        ? undefined
        : target === "new-case"
        ? null
        : target.caseId;
      if (await state.sendMessage(caseScoped ? caseDraft : undefined, caseId)) {
        if (caseScoped) setCaseDraft("");
        input.current?.focus();
        if (target === "new-case") {
          // The host opened a Case for this first message: follow it.
          const opened = state.selectedConversation.peek()?.messages
            .findLast((message) => message.role === "user" && message.caseId)
            ?.caseId;
          if (opened) props.onCaseStarted?.(opened);
        }
      }
      return;
    }
    // A Case page writes into its Request; another agent's field, into its thread.
    if (
      await state.agentConversations.sendTo(
        conversation.agentId,
        draft,
        !caseScoped,
        target === "new-case" ? null : targetCaseId,
      )
    ) {
      if (caseScoped) setCaseDraft("");
      input.current?.focus();
    }
  }
  // Errors belong to the conversation that produced them, never to its neighbour.
  const conversationError = independent
    ? targetCaseId
      ? [
        state.requests.writeErrors.value.get(targetCaseId),
        state.requests.readErrors.value.get(targetCaseId),
      ].filter(Boolean).join(" ")
      : state.requests.error.value
    : own
    ? state.agentConversations.errorFor(conversation.agentId)
    : state.agentConversations.error.value;
  const feedError = independent
    ? ""
    : (operatorId ? state.chatProposals.errorFor(operatorId) : "") ||
      state.changeError.value || state.operatorTools.error.value;
  const sending = independent
    ? state.requests.pending.value ||
      state.requests.sending.value === targetCaseId
    : own
    ? conversation.busy ||
      state.agentConversations.pendingAgentIds.value.includes(
        conversation.agentId,
      )
    : state.pending.value || (conversation
      ? conversation.busy ||
        state.agentConversations.pendingAgentIds.value.includes(
          conversation.agentId,
        )
      : state.current.value?.busy);
  if (bound && !conversation && !newRequest) {
    return (
      <div class="conversation-layout">
        <p class="conversation-unavailable" role="status">
          {independent
            ? targetCaseId &&
                state.requests.readErrors.value.get(targetCaseId) ||
              "Reading the Request conversation…"
            : state.agentConversations.loading.value
            ? "Loading the conversation…"
            : "This conversation is not available."}
        </p>
      </div>
    );
  }
  return (
    <div class="conversation-layout">
      <section
        class="conversation-main"
        aria-label={conversation?.name || "System conversation"}
      >
        {showHeading && (
          <div class="section-head">
            <h2>{conversation?.name || "Conversation"}</h2>
            <span class="phase" id={id("phase")} role="status">
              {readOnly
                ? `Conversation at revision ${state.selectedRevision.value}`
                : conversation?.phase || snapshot?.phase || (snapshot?.busy
                  ? "Working"
                  : snapshot
                  ? "Ready for your request"
                  : "Loading…")}
            </span>
          </div>
        )}
        {independent && targetCaseId &&
          conversation?.initialExecutionOutcome === "refused" && (
          <p class="conversation-read-error" role="status">
            The initial execution was refused. This Request remains open. Retry
            is not automatic.
          </p>
        )}
        <div
          class="history-notice"
          id={id("history-notice")}
          hidden={!readOnly}
        >
          <p id={id("history-notice-label")} role="status">
            Read-only · revision{" "}
            {state.selectedRevision.value}. The system keeps evolving in the
            present.
          </p>
          <div class="controls">
            {presentHref
              ? (
                <a
                  class="action primary"
                  id={id("return-current")}
                  href={presentHref}
                >
                  Back to the present
                </a>
              )
              : (
                <button
                  type="button"
                  class="action primary"
                  id={id("return-current")}
                  onClick={() => {
                    state.resetToCurrent();
                    input.current?.focus();
                  }}
                >
                  Back to the present
                </button>
              )}
          </div>
        </div>
        {!readOnly && proposalsPending > 0 && (
          <button
            type="button"
            class="proposal-jump"
            onClick={() =>
              scroll.current?.querySelector(".chat-proposal.is-pending")
                ?.scrollIntoView({
                  block: "start",
                  behavior:
                    matchMedia("(prefers-reduced-motion: reduce)").matches
                      ? "instant"
                      : "smooth",
                })}
          >
            <span class="proposal-count">{proposalsPending}</span>{" "}
            {proposalsPending === 1
              ? "proposal to decide"
              : "proposals to decide"}
          </button>
        )}
        {!readOnly && feedError &&
          (
            <div class="proposal-feed-error" role="alert">
              <span>{feedError}</span>
              <button
                type="button"
                onClick={() => {
                  if (operatorId) {
                    void state.chatProposals.refresh(
                      operatorId,
                    );
                  }
                  void state.agentConversations.refresh();
                  void state.operatorTools.refresh();
                }}
              >
                Refresh
              </button>
            </div>
          )}
        <div
          class="scroll"
          id={id("scroll")}
          ref={scroll}
          onScroll={() => {
            if (scroll.current && active) {
              keeper.record(scroll.current, conversationKey);
            }
          }}
          hidden={readOnly && !snapshot}
        >
          <div class="messages" id={id("messages")}>
            {!independent && !conversation && snapshot &&
              !snapshot.messages.some((m) => m.role === "user") && (
              <div class="empty">
                <h3>A request, then the capabilities to answer it.</h3>
                <p>
                  If a tool is missing, the Main Operator can propose it. Its
                  admission follows the mandate in force.
                </p>
                <button
                  type="button"
                  class="example"
                  disabled={!canAct}
                  onClick={() => {
                    setDraft(
                      "Read https://example.org and summarise this page.",
                    );
                    input.current?.focus();
                  }}
                >
                  Read https://example.org and summarise this page.
                </button>
              </div>
            )}
            {conversation && !messages.length && (
              <p class="conversation-empty">
                No exchange recorded for this agent.
              </p>
            )}
            <ChatTimeline
              state={state}
              entries={timeline}
              conversation={conversation}
              caseLinks={!caseScoped}
              independentRequest={independent}
              caseId={independent ? targetCaseId : undefined}
            />
          </div>
        </div>
        {props.beforeComposer}
        {!readOnly && conversationError && (
          <p class="proposal-error" role="alert">
            {conversationError}
          </p>
        )}
        {/* A thread without human input says so where the composer would be. */}
        {props.composer === false
          ? null
          : !takesMessage && !readOnly
          ? (
            <p class="conversation-readonly" role="status">
              {conversation?.readOnlyReason ||
                "This thread shows the recorded activity of this agent."}
            </p>
          )
          : (
            <form
              class="composer"
              id={id("composer")}
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
            >
              <div class="input-row">
                <textarea
                  class="composer-input"
                  id={id("input")}
                  ref={input}
                  rows={1}
                  aria-label={props.placeholder ?? (addressee
                    ? `Your message to ${addressee}`
                    : "Your message to the system")}
                  aria-describedby={`${id("input-note")} ${id("input-count")}`}
                  aria-invalid={tooLong || undefined}
                  placeholder={readOnly
                    ? "Go back to the present to continue the conversation."
                    : props.placeholder ?? (addressee
                      ? `Write to ${addressee}…`
                      : "Ask the system for something…")}
                  required
                  readOnly={newRequest && state.requests.intent.value !== null}
                  disabled={!canAct}
                  value={draft}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" && !event.shiftKey &&
                      !event.isComposing && event.keyCode !== 229
                    ) {
                      event.preventDefault();
                      if (ready) void send();
                    }
                  }}
                />
                <button
                  type="submit"
                  class={`send${sending ? " is-busy" : ""}`}
                  id={id("send")}
                  disabled={!ready}
                >
                  <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
                    <path d="M10 15.5v-11M5.5 9 10 4.5 14.5 9" />
                  </svg>
                  <span class="sr-only">
                    {sending
                      ? "Working…"
                      : newRequest && state.requests.intent.value
                      ? "Retry opening"
                      : "Send"}
                  </span>
                </button>
              </div>
              <FreeTextCount text={draft} id={id("input-count")} />
              <p class="input-note sr-only" id={id("input-note")}>
                Enter to send · Shift + Enter for a new line
              </p>
            </form>
          )}
      </section>
    </div>
  );
}
