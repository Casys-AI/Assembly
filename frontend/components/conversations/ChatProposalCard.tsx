import type { ComponentChildren } from "preact";
import { useMemo, useRef } from "preact/hooks";
import { signal } from "@preact/signals";
import type { ProposalDifference } from "../../lib/conversations/proposals.ts";
import { exceedsBound, FreeTextCount } from "./FreeTextCount.tsx";

export function BeforeAfter({ rows }: { rows: ProposalDifference[] }) {
  return (
    <div class="proposal-comparison" role="table" aria-label="Before and after">
      <div class="proposal-comparison-head" role="row">
        <span role="columnheader">Before</span>
        <span role="columnheader">After</span>
      </div>
      {rows.map((row) => (
        <div class="proposal-difference" key={row.id} role="rowgroup">
          <div class="proposal-property">{row.label}</div>
          <div class="proposal-values" role="row">
            <div class="proposal-before" role="cell">{row.before || "—"}</div>
            <div class="proposal-after" role="cell">{row.after || "—"}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** What deciding a proposal needs, whatever the card that shows it. */
export interface ProposalDecisionProps {
  decisionState?: ProposalDecisionState;
  disabled?: boolean;
  acceptDisabled?: boolean;
  /** A proposal may name its approval effect; other cards keep Accept. */
  acceptLabel?: string;
  adjustDisabled?: boolean;
  onDecide(verdict: "approve" | "refuse", reason?: string): Promise<boolean>;
  /** The message that asks for the adjustment: measured, then sent as built. */
  adjustmentMessage(text: string): string;
  /** Sends that message; whether the host accepted it. */
  onAdjustment(message: string): Promise<boolean>;
}

export interface ChatProposalCardProps extends ProposalDecisionProps {
  id: string;
  title: string;
  /** A word, or the chip of a decision's state. */
  status: ComponentChildren;
  open: boolean;
  actions?: boolean;
  rows?: ProposalDifference[];
  reason?: string;
  notice?: string;
  details?: ComponentChildren;
  children?: ComponentChildren;
}

/**
 * Why the host is told the proposal is declined when an adjustment is asked.
 * It names the conversation and never copies the request: the message carries
 * it under the one bound of free text, and the host bounds a reason far below.
 * This fixed reason travels for source proposals and operator tools; a mandate
 * or model change and a primary candidate carry only the verdict. The person's
 * text always travels in the message.
 */
const ADJUSTMENT_REASON = "Adjustment requested in the conversation.";
const NOT_DECLINED = "The proposal could not be declined. Nothing was sent.";
const NOT_SENT =
  "The proposal was declined, but the request was not sent. Send it again.";

/** The exact proposal owner may retain its draft while a card moves or refreshes. */
export function createProposalDecisionState() {
  return {
    adjusting: signal(false),
    adjustment: signal(""),
    pending: signal(false),
    error: signal(""),
    sent: signal(false),
    declined: false,
  };
}
export type ProposalDecisionState = ReturnType<
  typeof createProposalDecisionState
>;

/**
 * Accept, Decline and Adjust for one proposal: the pending state, the errors,
 * and the order an adjustment follows (the proposal is declined first, then the
 * request is sent; the text stays in the form until the host took it). A card
 * draws the controls where it wants them.
 */
export function useProposalDecision(props: ProposalDecisionProps) {
  const held = useMemo(
    () => props.decisionState ?? createProposalDecisionState(),
    [props.decisionState],
  );
  const adjusting = held.adjusting.value;
  const adjustment = held.adjustment.value;
  const pending = held.pending.value;
  const error = held.error.value;
  const sent = held.sent.value;
  const setAdjusting = (value: boolean) => {
    held.adjusting.value = value;
  };
  const setAdjustment = (value: string) => {
    held.adjustment.value = value;
  };
  const setPending = (value: boolean) => {
    held.pending.value = value;
  };
  const setError = (value: string) => {
    held.error.value = value;
  };
  const setSent = (value: boolean) => {
    held.sent.value = value;
  };
  const textInput = useRef<HTMLTextAreaElement>(null);
  async function decide(verdict: "approve" | "refuse") {
    if (
      held.pending.peek() || props.disabled ||
      verdict === "approve" && props.acceptDisabled
    ) return;
    setPending(true);
    setError("");
    try {
      if (!await props.onDecide(verdict)) {
        setError("Decision not confirmed. Review the proposal and try again.");
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Decision not confirmed.",
      );
    } finally {
      setPending(false);
    }
  }
  // What is measured is what is sent: the whole message, not the field alone.
  const text = adjustment.trim();
  const message = text ? props.adjustmentMessage(text) : "";
  const tooLong = exceedsBound(message);
  async function requestAdjustment() {
    if (held.pending.peek() || !text || tooLong || props.adjustDisabled) return;
    setPending(true);
    setError("");
    try {
      if (!held.declined) {
        if (!await props.onDecide("refuse", ADJUSTMENT_REASON)) {
          setError(NOT_DECLINED);
          return;
        }
        held.declined = true;
      }
      if (await props.onAdjustment(message)) {
        setSent(true);
        setAdjusting(false);
      } else setError(NOT_SENT);
    } catch (cause) {
      setError(
        held.declined
          ? NOT_SENT
          : cause instanceof Error
          ? cause.message
          : NOT_DECLINED,
      );
    } finally {
      setPending(false);
    }
  }
  function startAdjusting() {
    setAdjusting(true);
    requestAnimationFrame(() => textInput.current?.focus());
  }
  return {
    adjusting,
    adjustment,
    setAdjustment,
    message,
    tooLong,
    pending,
    error,
    sent,
    textInput,
    decide,
    requestAdjustment,
    startAdjusting,
    stopAdjusting: () => setAdjusting(false),
  };
}
export type ProposalDecision = ReturnType<typeof useProposalDecision>;

/**
 * Accept and Decline, the two pills every proposal decides with. `busy` says
 * this proposal's decision is in flight; `disabled` shuts both, and
 * `acceptDisabled` only Accept (a decision that cannot be approved yet).
 */
export function AcceptDecline(
  { busy, disabled, acceptDisabled, acceptLabel = "Accept", onDecide }: {
    busy: boolean;
    disabled?: boolean;
    acceptDisabled?: boolean;
    acceptLabel?: string;
    onDecide(verdict: "approve" | "refuse"): void;
  },
) {
  return (
    <>
      <button
        type="button"
        class="proposal-accept"
        disabled={busy || disabled || acceptDisabled}
        onClick={() => onDecide("approve")}
      >
        {busy ? "Working…" : acceptLabel}
      </button>
      <button
        type="button"
        disabled={busy || disabled}
        onClick={() => onDecide("refuse")}
      >
        Decline
      </button>
    </>
  );
}

/** Accept, Decline and Adjust, as the buttons of one proposal. */
export function ProposalButtons(
  { flow, ...props }:
    & { flow: ProposalDecision }
    & Pick<
      ProposalDecisionProps,
      "disabled" | "acceptDisabled" | "acceptLabel" | "adjustDisabled"
    >,
) {
  return (
    <>
      <AcceptDecline
        busy={flow.pending}
        disabled={props.disabled}
        acceptDisabled={props.acceptDisabled}
        acceptLabel={props.acceptLabel}
        onDecide={(verdict) => void flow.decide(verdict)}
      />
      <button
        type="button"
        class="proposal-adjust"
        disabled={flow.pending || props.disabled || props.adjustDisabled}
        onClick={flow.startAdjusting}
      >
        Adjust
      </button>
    </>
  );
}

/** The field that says what should change; sending it declines the proposal. */
export function ProposalAdjustment(
  { id, flow, adjustDisabled }: {
    id: string;
    flow: ProposalDecision;
    adjustDisabled?: boolean;
  },
) {
  return (
    <form
      class="proposal-adjustment"
      onSubmit={(event) => {
        event.preventDefault();
        void flow.requestAdjustment();
      }}
    >
      <label for={`adjust-${id}`}>What should change</label>
      <textarea
        ref={flow.textInput}
        id={`adjust-${id}`}
        value={flow.adjustment}
        required
        disabled={flow.pending}
        aria-describedby={`adjust-${id}-count`}
        aria-invalid={flow.tooLong || undefined}
        placeholder="For example: limit access to a single site…"
        onInput={(event) => flow.setAdjustment(event.currentTarget.value)}
      />
      <FreeTextCount text={flow.message} id={`adjust-${id}-count`} />
      <div class="proposal-actions">
        <button
          type="submit"
          class="proposal-accept"
          disabled={flow.pending || adjustDisabled || !flow.message ||
            flow.tooLong}
        >
          {flow.pending ? "Sending…" : "Request adjustment"}
        </button>
        <button
          type="button"
          disabled={flow.pending}
          onClick={flow.stopAdjusting}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function ChatProposalCard(props: ChatProposalCardProps) {
  const flow = useProposalDecision(props);
  const content = (
    <>
      {props.rows && props.rows.length > 0 && <BeforeAfter rows={props.rows} />}
      {props.notice && (
        <p class="proposal-notice" role="status">{props.notice}</p>
      )}
      {props.details}
      {props.reason && (
        <details class="proposal-rationale">
          <summary>Reason</summary>
          <p>{props.reason}</p>
        </details>
      )}
      {props.open && props.actions !== false && !flow.adjusting && (
        <div class="proposal-actions">
          <ProposalButtons
            flow={flow}
            disabled={props.disabled}
            acceptDisabled={props.acceptDisabled}
            acceptLabel={props.acceptLabel}
            adjustDisabled={props.adjustDisabled}
          />
        </div>
      )}
      {flow.adjusting && (
        <ProposalAdjustment
          id={props.id}
          flow={flow}
          adjustDisabled={props.adjustDisabled}
        />
      )}
      {flow.error && <p class="proposal-error" role="alert">{flow.error}</p>}
      {props.children}
    </>
  );
  return (
    <article
      class={`chat-proposal${props.open ? " is-pending" : " is-settled"}`}
      data-proposal-id={props.id}
      aria-label={props.title}
    >
      {props.open || flow.adjusting || flow.pending
        ? (
          <>
            <header class="proposal-heading">
              <h3>{props.title}</h3>
              <span class="proposal-status">{props.status}</span>
            </header>
            {content}
          </>
        )
        : (
          <details
            class="proposal-receipt"
            open={Boolean(props.notice || flow.error)}
          >
            <summary>
              <span>{props.title}</span>
              <span class="proposal-status">
                {flow.sent ? "Adjustment requested" : props.status}
              </span>
            </summary>
            {content}
          </details>
        )}
    </article>
  );
}
