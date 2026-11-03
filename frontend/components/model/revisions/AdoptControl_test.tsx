import { textOf } from "../../../test/support/dom.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { AdoptControl, type UnreadRuntime } from "./AdoptControl.tsx";
import type {
  AdoptionOffer,
  HistoryProblem,
} from "../../../lib/model/revisions/history.ts";
import { press } from "../../../test/support/press.ts";
import {
  DESIGNER,
  designer,
  DIGEST,
  HEAD,
  REVIEWER,
  reviewer,
} from "../../../test/support/revision-fixture.ts";
import type { RuntimeOperator } from "../../../lib/model/revisions/api.ts";

const offer = (operator: RuntimeOperator): AdoptionOffer => ({
  operator,
  adoption: {
    agentId: operator.nativeId,
    expectedDigest: DIGEST,
    expectedVersion: HEAD,
  },
});
const designerOffer = offer(designer);
const reviewerOffer = offer(reviewer);

function control(
  props: Partial<Parameters<typeof AdoptControl>[0]> = {},
  sent: string[] = [],
  chosen: string[] = [],
) {
  return press(
    <AdoptControl
      offers={[designerOffer]}
      onChoose={(agentId) => chosen.push(agentId)}
      adopting={null}
      available
      idle
      unread={[]}
      onAdopt={(agentId) => sent.push(agentId)}
      {...props}
    />,
  );
}
const problem = (code: HistoryProblem["code"], detail?: string) => ({
  code,
  message: `message of ${code}`,
  ...(detail ? { detail } : {}),
});

Deno.test("with nobody to put the model in service for, it shows nothing", () => {
  equal(control({ offers: [] }).html, "");
});

Deno.test("one operator waits: it is named, and one button puts the model in service for it", () => {
  const sent: string[] = [];
  const page = control({}, sent);
  deepStrictEqual(page.labels, ["Put in service"]);
  match(page.html, /<span class="adopt-who">Designer<\/span>/);
  // No menu for a choice of one.
  doesNotMatch(page.html, /<select/);
  // The exact words are in the tooltip: which version, for whom.
  match(page.html, /title="Puts ccccccc in service for Designer"/);
  page.click("Put in service");
  deepStrictEqual(sent, [DESIGNER]);
});

Deno.test("several operators wait: a menu offers them, and the button acts for the one chosen", () => {
  const sent: string[] = [];
  const chosen: string[] = [];
  const first = control(
    { offers: [designerOffer, reviewerOffer] },
    sent,
    chosen,
  );
  match(first.html, /<select aria-label="Operator"/);
  match(first.html, new RegExp(`value="${DESIGNER}" selected`));
  doesNotMatch(first.html, new RegExp(`value="${REVIEWER}" selected`));
  first.click("Put in service");
  // Choosing another operator is told to the page, which holds the choice.
  ok(first.change, "the menu does something when it changes");
  first.change!({ currentTarget: { value: REVIEWER } });
  deepStrictEqual(chosen, [REVIEWER]);
  // Drawn again with that choice, the button acts for the reviewer.
  const second = control(
    { offers: [designerOffer, reviewerOffer], chosen: REVIEWER },
    sent,
    chosen,
  );
  match(second.html, new RegExp(`value="${REVIEWER}" selected`));
  match(second.html, /title="Puts ccccccc in service for Reviewer"/);
  second.click("Put in service");
  deepStrictEqual(sent, [DESIGNER, REVIEWER]);
  // A choice that is no longer offered gives way to the first offer.
  const gone = control({ offers: [reviewerOffer], chosen: DESIGNER });
  match(gone.html, /<span class="adopt-who">Reviewer<\/span>/);
});

Deno.test("while a read is unsettled or another change is in flight the button is shut, and says nothing more", () => {
  const shut = control({ available: false });
  match(shut.html, /class="proposal-accept"\s+disabled/);
  const menu = control({
    offers: [designerOffer, reviewerOffer],
    available: false,
  });
  match(menu.html, /<select[^>]*disabled/);
});

Deno.test("while an operator is running the button is shut and says why: the host would refuse", () => {
  const busy = control({ idle: false });
  match(busy.html, /class="proposal-accept"\s+disabled/);
  match(busy.html, /title="An operator is running"/);
  doesNotMatch(busy.html, /Puts ccccccc/);
  // The operator is still named, and the menu can still be used to choose.
  match(busy.html, /<span class="adopt-who">Designer<\/span>/);
  const menu = control({ offers: [designerOffer, reviewerOffer], idle: false });
  doesNotMatch(menu.html, /<select[^>]*disabled/);
  // Idle again: the same button acts.
  const sent: string[] = [];
  control({}, sent).click("Put in service");
  deepStrictEqual(sent, [DESIGNER]);
});

Deno.test("an adoption in flight shows it on its button and shuts the others", () => {
  const working = control({ adopting: DESIGNER });
  deepStrictEqual(working.labels, ["Working…"]);
  match(working.html, /disabled/);
  // Another operator's adoption in flight: this button waits, unchanged.
  const waiting = control({ adopting: REVIEWER });
  deepStrictEqual(waiting.labels, ["Put in service"]);
  match(waiting.html, /disabled/);
});

Deno.test("a refusal is told under the control with its code, the operator and what the host said", () => {
  const html = control({
    refusal: {
      operator: "Designer",
      problem: problem("adoption-conflict", "The contract moved."),
    },
  }).html;
  match(html, /role="alert" data-code="adoption-conflict"/);
  match(
    textOf(html),
    /Designer ?: message of adoption-conflict The contract moved\./,
  );
  // The button is still there, to try again after reading.
  match(html, /Put in service/);
  // Alone, a refusal is told without a button.
  const alone = control({
    offers: [],
    refusal: { problem: problem("adoption-failed") },
  }).html;
  match(alone, /data-code="adoption-failed"/);
  doesNotMatch(alone, /<button/);
});

Deno.test("an operator whose runtime could not be read is named with the code, and offered nothing", () => {
  const unread: UnreadRuntime[] = [{
    operator: reviewer,
    problem: problem("runtime-failed", "Hors ligne."),
  }];
  const html = control({ offers: [], unread }).html;
  match(html, /data-code="runtime-failed"/);
  match(textOf(html), /Reviewer ?: message of runtime-failed Hors ligne\./);
  doesNotMatch(html, /<button/);
});

Deno.test("what the host said is text, never markup", () => {
  const html = control({
    refusal: { problem: problem("adoption-failed", "<img src=x onerror=a()>") },
  }).html;
  match(html, /&lt;img src=x onerror=a\(\)>/);
  doesNotMatch(html, /<img/);
});
