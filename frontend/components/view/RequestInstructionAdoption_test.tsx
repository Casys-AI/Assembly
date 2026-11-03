import { doesNotMatch, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import {
  RequestInstructionActivationAction,
  RequestInstructionAdoption,
  RequestInstructionAdoptionReceipt,
} from "./RequestInstructionAdoption.tsx";
import { ModelUpdateDivider } from "../conversations/ModelUpdateDivider.tsx";
const executing = `commit:${"a".repeat(40)}`,
  admitted = `commit:${"b".repeat(40)}`;
Deno.test("historical Request inspection cannot offer activation before current eligibility", () => {
  const html = renderToString(
    <RequestInstructionAdoption
      sessionReady
      scope={{
        caseId: "caseA",
        branchId: "branchA",
        executionSpaceId: "spaceA",
        version: admitted,
        executionVersion: executing,
        branchVersion: admitted,
        release: null,
        readOnly: true,
      }}
    />,
  );
  doesNotMatch(
    html,
    /proposal-adjustment|Running instruction|Inspect exact admitted source/,
  );
  doesNotMatch(html, /Activate current instruction/);
});
Deno.test("Request committed update never links to Main", () => {
  const html = renderToString(
    <ModelUpdateDivider
      requestScoped
      update={{
        id: "activation",
        operatorId: "operator",
        kind: "model",
        activatedAt: "2026-10-30T00:00:00Z",
        caseId: "caseA",
        from: { digest: "a".repeat(64), repositoryVersion: executing },
        to: { digest: "b".repeat(64), repositoryVersion: admitted },
      }}
    />,
  );
  match(html, /Version/);
  doesNotMatch(html, /href=/);
});

Deno.test("initial instruction activation uses the existing proposal action context and primary button", () => {
  const html = renderToString(
    <RequestInstructionActivationAction
      disabled
      onActivate={() => {
        throw new Error("Rendering cannot activate");
      }}
    />,
  );
  match(
    html,
    /<div class="proposal-actions"><button[^>]*class="proposal-accept"[^>]*disabled[^>]*>Activate current instruction<\/button><\/div>/,
  );
});
Deno.test("aligned Request does not render a redundant activation banner", () => {
  const html = renderToString(
    <RequestInstructionAdoption
      sessionReady
      scope={{
        caseId: "caseA",
        branchId: "branchA",
        executionSpaceId: "spaceA",
        version: executing,
        executionVersion: executing,
        branchVersion: executing,
        release: null,
        readOnly: true,
      }}
    />,
  );
  doesNotMatch(
    html,
    /proposal-adjustment|Running instruction|Inspect exact admitted source/,
  );
});
Deno.test("committed receipt details expose exact command, digest and durable revisions", () => {
  const html = renderToString(
    <RequestInstructionAdoptionReceipt
      receipt={{
        commandId: `request-adoption:${"a".repeat(64)}`,
        receiptDigest: "b".repeat(64),
        journalDigest: "c".repeat(64),
        committedRuntimeRevision: 12,
        journalRevision: 5,
        recordedAt: "2026-10-30T00:00:00.000Z",
      }}
    />,
  );
  match(html, /<summary>Committed activation receipt<\/summary>/);
  match(html, /Runtime revision<\/dt><dd>12/);
  match(html, /Journal revision<\/dt><dd>5/);
  match(html, new RegExp("b".repeat(64)));
  match(html, /2026-10-30T00:00:00.000Z/);
});
