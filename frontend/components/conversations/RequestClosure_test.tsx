import { equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import type { CaseRecord } from "../../lib/cases/cases.ts";
import { RequestClosure } from "./RequestClosure.tsx";

Deno.test("an open Request shows nothing; a closed one says how it ended", () => {
  const view = (record: Pick<CaseRecord, "status" | "verdict">) =>
    renderToString(<RequestClosure record={record} />);
  equal(view({ status: "open" }), "");
  equal(
    view({ status: "closed-done", verdict: "accepted" }),
    '<p class="request-closed" role="status">Closed · accepted by you</p>',
  );
  match(view({ status: "closed-abandoned" }), />Closed · abandoned<\/p>$/);
});
