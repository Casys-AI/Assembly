import { equal, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { ModelLinkContext } from "../../view/ModelContextLink.tsx";
import { ViewPicker } from "./ViewPicker.tsx";
import { press } from "../../../test/support/press.ts";

Deno.test("SysML picker renders Case and operator in GET fields and submit action", () => {
  const version = `commit:${"a".repeat(40)}`;
  for (const caseId of ["case-one", "case-two"]) {
    const picker = (
      <ModelLinkContext.Provider value={`?caseBranch=${caseId}&agent=operator`}>
        <ViewPicker views={[]} version={version} />
      </ModelLinkContext.Provider>
    );
    const html = renderToString(picker);
    match(html, new RegExp(`action="[^"]*caseBranch=${caseId}`));
    match(html, new RegExp(`name="caseBranch" value="${caseId}"`));
    match(html, /name="agent" value="operator"/);
    match(html, /name="version" value="commit:/);
    const captured = press(picker);
    const previous = globalThis.FormData;
    try {
      globalThis.FormData = class {
        get() {
          return "view-new";
        }
      } as unknown as typeof FormData;
      const form = { action: "" };
      captured.submit!({ currentTarget: form });
      const action = new URL(form.action, "https://atelier.test");
      equal(action.searchParams.get("caseBranch"), caseId);
      equal(action.searchParams.get("agent"), "operator");
      equal(action.searchParams.get("version"), version);
      equal(action.searchParams.get("view"), "view-new");
    } finally {
      globalThis.FormData = previous;
    }
  }
});
