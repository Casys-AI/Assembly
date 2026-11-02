import { doesNotMatch, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { newToolPatch, ProposalCodeDiff } from "./ProposalCodeDiff.tsx";

Deno.test("new tool diff shows exact additions, preserves missing newline and escapes code", () => {
  const patch = newToolPatch(
    "tool/1",
    "export default () => '<script>attack()</script>';",
  );
  match(patch, /\+export default/);
  match(patch, /No newline at end of file/);
  const rendered = renderToString(<ProposalCodeDiff patch={patch} />);
  match(rendered, /d2h-ins/);
  match(rendered, /&lt;script/);
  doesNotMatch(rendered, /<script>|onerror=/);
});
