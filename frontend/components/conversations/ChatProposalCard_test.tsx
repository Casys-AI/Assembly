import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { press } from "../../test/support/press.ts";
import { withAdjustment } from "../../test/support/adjustment-probe.tsx";
import { MAX_USER_MESSAGE_CHARS } from "../../../src/domain/work/records/conversations.ts";
import {
  AcceptDecline,
  ChatProposalCard,
  type ProposalDecisionProps,
} from "./ChatProposalCard.tsx";

const decided: string[] = [];
const render = (
  props: Partial<Parameters<typeof AcceptDecline>[0]> = {},
) =>
  press(
    <AcceptDecline
      busy={false}
      onDecide={(verdict) => decided.push(verdict)}
      {...props}
    />,
  );

Deno.test("Accept and Decline each send their own verdict", () => {
  decided.length = 0;
  const view = render();
  deepStrictEqual(view.labels, ["Accept", "Decline"]);
  match(view.html, /class="proposal-accept"/);
  view.click("Accept");
  view.click("Decline");
  deepStrictEqual(decided, ["approve", "refuse"]);
});

Deno.test("a named approval keeps the existing approve verdict and busy behavior", () => {
  decided.length = 0;
  const named = render({ acceptLabel: "Admit and integrate" });
  deepStrictEqual(named.labels, ["Admit and integrate", "Decline"]);
  named.click("Admit and integrate");
  deepStrictEqual(decided, ["approve"]);
  deepStrictEqual(
    render({ acceptLabel: "Admit and integrate", busy: true }).labels,
    ["Working…", "Decline"],
  );
});

Deno.test("the card passes its optional approval label and preserves Accept for other proposals", () => {
  const props = {
    id: "p1",
    title: "Proposal",
    status: "Pending",
    open: true,
    adjustmentMessage: (text: string) => text,
    onAdjustment: () => Promise.resolve(true),
    onDecide: () => Promise.resolve(true),
  };
  deepStrictEqual(press(<ChatProposalCard {...props} />).labels, [
    "Accept",
    "Decline",
    "Adjust",
  ]);
  deepStrictEqual(
    press(<ChatProposalCard {...props} acceptLabel="Admit and integrate" />)
      .labels,
    ["Admit and integrate", "Decline", "Adjust"],
  );
});

Deno.test("a decision in flight says so on Accept and shuts both", () => {
  const { html, labels } = render({ busy: true });
  deepStrictEqual(labels, ["Working…", "Decline"]);
  match(html, /class="proposal-accept"\s+disabled/);
  match(html, /<button type="button" disabled/);
});

Deno.test("disabled shuts both; acceptDisabled shuts Accept alone", () => {
  const both = render({ disabled: true }).html;
  deepStrictEqual(both.match(/disabled/g)?.length, 2);
  const accept = render({ acceptDisabled: true }).html;
  deepStrictEqual(accept.match(/disabled/g)?.length, 1);
  match(accept, /class="proposal-accept"\s+disabled/);
});

/** The markup without the field's (possibly huge) text: failures stay readable. */
const bare = (html: string) => html.replace(/ value="[^"]*"/, ' value="…"');

const PREFIX = "Adjust the proposal “Create operator Research” (network):\n";
const REASON = "Adjustment requested in the conversation.";
const asked = (text: string) => PREFIX + text;
const answer = (outcome: boolean | Error) =>
  outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);

/**
 * The owner of one proposal: it records what the card hands it, in order, and
 * answers as `answers` say (changed between two presses to model a retry).
 */
function owner(
  answers: { message: boolean | Error; refusal: boolean | Error } = {
    message: true,
    refusal: true,
  },
) {
  const calls: Array<[string, string?]> = [];
  const props: ProposalDecisionProps = {
    adjustmentMessage: asked,
    onAdjustment: (message) => {
      calls.push(["adjust", message]);
      return answer(answers.message);
    },
    onDecide: (verdict, reason) => {
      calls.push([verdict, reason]);
      return answer(answers.refusal);
    },
  };
  return { props, calls, answers };
}

Deno.test("a 50,000-character adjustment is kept whole, the proposal is declined with a short reason, then the message goes whole", async () => {
  const text = "y".repeat(50_000);
  const { props, calls } = owner();
  await withAdjustment(props, async (adjustment) => {
    await adjustment.start();
    await adjustment.type(text);
    const form = adjustment.form();
    doesNotMatch(bare(form.html), /maxlength/i);
    ok(form.html.includes(`value="${text}"`));
    doesNotMatch(
      bare(form.html),
      /free-text-count|Message too long|aria-invalid/,
    );
    doesNotMatch(bare(form.html), /type="submit"[^>]*disabled/);
    await adjustment.send();
    // The reason names the conversation and does not copy the text.
    deepStrictEqual(calls, [["refuse", REASON], ["adjust", asked(text)]]);
    const flow = adjustment.flow();
    equal(flow.error, "");
    equal(flow.adjusting, false);
    equal(flow.sent, true);
  });
});

Deno.test("the whole message, prefix included, is what is measured against the bound", async () => {
  const room = MAX_USER_MESSAGE_CHARS - PREFIX.length;
  const { props, calls } = owner();
  await withAdjustment(props, async (adjustment) => {
    await adjustment.start();
    // One character too many in the message, though the field alone is below
    // the bound: it stays whole, cannot be sent and says why.
    const text = "y".repeat(room + 1);
    ok(text.length < MAX_USER_MESSAGE_CHARS);
    await adjustment.type(text);
    const form = adjustment.form();
    const html = bare(form.html);
    doesNotMatch(html, /maxlength/i);
    ok(form.html.includes(`value="${text}"`));
    match(
      html,
      /<p class="free-text-count is-over" id="adjust-p1-count" role="status">Message too long: 100,001 \/ 100,000 characters<\/p>/,
    );
    match(html, /aria-invalid/);
    match(html, /type="submit" class="proposal-accept" disabled/);
    // Not even a direct submit declines the proposal or sends the request.
    await adjustment.send();
    equal(calls.length, 0);
    // One character fewer and the message is exactly at the bound: it goes.
    await adjustment.type("y".repeat(room));
    const fitting = bare(adjustment.form().html);
    doesNotMatch(fitting, /Message too long|aria-invalid|disabled/);
    match(fitting, />100,000 \/ 100,000</);
    await adjustment.send();
    equal(calls.length, 2);
    equal(calls[0][0], "refuse");
    equal(calls[1][0], "adjust");
    equal(calls[1][1]!.length, MAX_USER_MESSAGE_CHARS);
  });
});

/** A proposal the host would not decline: nothing is sent, the text is kept. */
async function declineFails(refusal: boolean | Error, shown: string) {
  const { props, calls, answers } = owner({ message: true, refusal });
  await withAdjustment(props, async (adjustment) => {
    await adjustment.start();
    await adjustment.type("Fewer hosts");
    await adjustment.send();
    deepStrictEqual(calls, [["refuse", REASON]]);
    const flow = adjustment.flow();
    equal(flow.error, shown);
    equal(flow.adjusting, true);
    equal(flow.sent, false);
    equal(flow.adjustment, "Fewer hosts");
    equal(flow.pending, false);
    // Said again once the host can decline: it declines, then it sends.
    answers.refusal = true;
    await adjustment.send();
    deepStrictEqual(calls.slice(1), [
      ["refuse", REASON],
      ["adjust", asked("Fewer hosts")],
    ]);
    equal(adjustment.flow().sent, true);
  });
}

Deno.test("a decline the host refuses sends nothing and keeps the text in the form", async () => {
  await declineFails(
    false,
    "The proposal could not be declined. Nothing was sent.",
  );
});

Deno.test("a decline that fails with its own reason says it, sends nothing and keeps the text", async () => {
  await declineFails(
    new Error("Decision not confirmed."),
    "Decision not confirmed.",
  );
});

/**
 * A request that did not go after the proposal was declined: the text is still
 * in the form, and pressing again sends it without declining a second time.
 */
async function sendFails(message: boolean | Error) {
  const { props, calls, answers } = owner({ message, refusal: true });
  await withAdjustment(props, async (adjustment) => {
    await adjustment.start();
    await adjustment.type("Fewer hosts");
    await adjustment.send();
    deepStrictEqual(calls, [["refuse", REASON], [
      "adjust",
      asked("Fewer hosts"),
    ]]);
    let flow = adjustment.flow();
    equal(
      flow.error,
      "The proposal was declined, but the request was not sent. Send it again.",
    );
    equal(flow.adjusting, true);
    equal(flow.sent, false);
    equal(flow.adjustment, "Fewer hosts");
    equal(flow.pending, false);
    doesNotMatch(bare(adjustment.form().html), /type="submit"[^>]*disabled/);
    answers.message = true;
    await adjustment.send();
    deepStrictEqual(calls.slice(2), [["adjust", asked("Fewer hosts")]]);
    flow = adjustment.flow();
    equal(flow.error, "");
    equal(flow.sent, true);
    equal(flow.adjusting, false);
  });
}

Deno.test("a message the host refuses after the decline keeps the text in the form and resends without declining again", async () => {
  await sendFails(false);
});

Deno.test("a message that fails after the decline says the proposal was declined and keeps the text", async () => {
  await sendFails(new Error("Network down."));
});
