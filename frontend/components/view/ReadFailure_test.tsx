import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { press } from "../../test/support/press.ts";
import { ReadFailure } from "./ReadFailure.tsx";

const problem = { code: "read-failed", message: "It could not be read." };

Deno.test("a failure with no way out is only the problem", () => {
  const view = press(<ReadFailure problem={problem} />);
  match(
    view.html,
    /^<p class="proposal-error" role="alert" data-code="read-failed">/,
  );
  doesNotMatch(view.html, /<button|Show current model/);
});

Deno.test("reading again is a button that reads again; it is shut while a read is under way", () => {
  let reads = 0;
  const open = press(
    <ReadFailure problem={problem} again={{ run: () => reads++ }} />,
  );
  deepStrictEqual(open.labels, ["Try again"]);
  doesNotMatch(open.html, /disabled/);
  open.click("Try again");
  equal(reads, 1);
  const busy = press(
    <ReadFailure
      problem={problem}
      again={{ run: () => reads++, busy: true }}
    />,
  );
  match(busy.html, /<button[^>]*disabled/);
});

Deno.test("a host that asked to wait is waited for: the button says how long and is shut", () => {
  const waiting = press(
    <ReadFailure problem={problem} again={{ run: () => {}, wait: 7 }} />,
  );
  deepStrictEqual(waiting.labels, ["Try again in 7 s"]);
  match(waiting.html, /<button[^>]*disabled/);
  const none = press(
    <ReadFailure problem={problem} again={{ run: () => {}, wait: 0 }} />,
  );
  deepStrictEqual(none.labels, ["Try again"]);
});

Deno.test("a page that reads a version has Show current model beside it, with or without a button", () => {
  const view = press(
    <ReadFailure problem={problem} home="/model?page=files" />,
  );
  match(
    view.html,
    /<a class="rev-retry" href="\/model\?page=files">Show current model<\/a>/,
  );
  doesNotMatch(view.html, /<button/);
  const both = press(
    <ReadFailure problem={problem} again={{ run: () => {} }} home="/x" />,
  );
  deepStrictEqual(both.labels, ["Try again"]);
  match(
    both.html,
    /Try again<\/button><a class="rev-retry" href="\/x">Show current model/,
  );
});
