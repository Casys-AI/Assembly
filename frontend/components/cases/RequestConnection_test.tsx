import { RequestSource } from "./RequestSource.tsx";
import {
  localSkillRelease,
  RELEASE_HOST,
} from "../../test/support/release-opening-fixture.ts";
import { doesNotMatch, match } from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { CasesPage } from "./CasesPage.tsx";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { caseRecord } from "../../test/support/case-fixture.ts";
import { parseConversationsSnapshot } from "../../lib/conversations/state.ts";

const version = `commit:${"a".repeat(40)}`;
function fixture() {
  const state = createWorkbenchState({
    fetch: () => {
      throw new Error("Rendering must not make a request");
    },
  });
  state.requests.context.value = { projectId: "project", systemId: "host" };
  state.requests.environment.value = "production";
  state.requests.sessionReady.value = true;
  state.requests.cases.accept({
    systemId: "host",
    cases: [
      caseRecord(1, {
        id: "caseA",
        owner: "same-native",
        objective: "Request A",
      }),
      caseRecord(2, {
        id: "caseB",
        owner: "same-native",
        objective: "Request B",
      }),
    ],
  });
  const snapshot = (caseId: string, text: string) =>
    parseConversationsSnapshot({
      systemId: `request-runtime-${caseId}`,
      version: caseId,
      defaultAgentId: "same-native",
      conversations: [{
        agentId: "same-native",
        nativeId: "same-native",
        name: "Owner",
        responsibility: "Answer requests",
        primary: true,
        canSend: true,
        runtimeOwned: true,
        revision: 4,
        busy: false,
        phase: "Ready",
        modelDigest: "model",
        repositoryVersion: version,
        messages: [{
          id: `message-${caseId}`,
          caseId,
          text,
          role: "assistant",
          at: "2026-10-30T00:00:00Z",
        }],
      }],
    });
  state.agentConversations.accept(
    snapshot("mainCase", "Main-only conversation"),
  );
  state.requests.snapshots.value = new Map([
    ["caseA", snapshot("caseA", "A-only conversation")],
    ["caseB", snapshot("caseB", "B-only conversation")],
  ]);
  state.requests.scopes.value = new Map([["caseB", {
    caseId: "caseB",
    branchId: "branchB",
    executionSpaceId: "spaceB",
    branchVersion: version,
    executionVersion: version,
    version,
    readOnly: true,
    release: null,
  }]]);
  return state;
}

Deno.test("existing Request page reads only the selected durable scope despite the shared Main native owner", () => {
  const state = fixture();
  const html = renderToString(
    <CasesPage
      state={state}
      active
      selectedId="caseB"
      decisions={[]}
      onStarted={() => {}}
      onBack={() => {}}
    />,
  );
  match(html, /B-only conversation/);
  doesNotMatch(html, /A-only conversation|Main-only conversation/);
  match(html, /branchB/);
  match(html, /aria-label="Request 2 · In service · Read-only"/);
  match(html, /View model/);
  match(
    html,
    new RegExp(
      `page=releases&amp;caseBranch=caseB&amp;create=1&amp;version=${
        encodeURIComponent(version)
      }`,
    ),
  );
  match(html, /create=1/);
  doesNotMatch(html, />Close<|Effort /);
});

Deno.test("compact Request context retains an unavailable selected conversation instead of switching to its owner", () => {
  const state = fixture();
  const html = renderToString(
    <CasesPage
      state={state}
      active
      compact
      selectedId="caseB"
      agentId="saved-member"
      decisions={[]}
      onStarted={() => {}}
      onBack={() => {}}
    />,
  );
  match(html, /is-compact/);
  match(html, /cases-selected-conversation">Conversation unavailable/);
  match(html, /selected Request conversation is unavailable/);
  match(html, /case=caseB&amp;agent=saved-member/);
  doesNotMatch(
    html,
    /A-only conversation|B-only conversation|Main-only conversation/,
  );
});

Deno.test("new Request reuses the composer with explicit Current Main/Release choice and no Main message content", () => {
  const state = fixture();
  state.requests.sessionReady.value = false;
  const html = renderToString(
    <CasesPage
      state={state}
      active
      selectedId={null}
      decisions={[]}
      onStarted={() => {}}
      onBack={() => {}}
    />,
  );
  match(html, /Start from<select/);
  match(html, /Current Main/);
  match(html, /Import local control file/);
  match(html, /class="composer"/);
  doesNotMatch(
    html,
    /Main-only conversation|A-only conversation|B-only conversation/,
  );
});

Deno.test("existing Request source selector names owned incomplete Release candidates and explains automatic startup checks", () => {
  const state = fixture();
  const record = {
    ...localSkillRelease("ownedRelease", "caseA"),
    assetAvailability: "verified" as const,
  };
  state.requests.context.value = RELEASE_HOST;
  state.requests.releases.value = [record];
  state.requests.source.value = {
    kind: "release",
    releaseId: record.id,
    digest: record.digest!,
  };
  const html = renderToString(<RequestSource state={state} active />);
  match(html, /Start from<select/);
  match(html, /title="[^"]*Request caseA[^"]*"/);
  // The startup check is told in the tooltip, never as a paragraph.
  match(
    html,
    /<select[^>]*title="[^"]*Checked automatically at start: the host verifies exact bundled skills and current authority[^"]*"/,
  );
  doesNotMatch(html, /<p[^>]*>Checked automatically/);
  doesNotMatch(html, /Retention completed|Release is eligible|Adopt|Activate/);
});

Deno.test("runtime development mode and unresolved metadata never render a file selector", () => {
  const state = fixture();
  state.requests.sessionReady.value = false;
  state.requests.context.value = null;
  for (const authOnly of [true, false]) {
    for (const error of ["", "Local development session unavailable."]) {
      state.requests.error.value = error;
      for (const mode of [null, "development"] as const) {
        state.requests.environment.value = mode;
        const html = renderToString(
          <RequestSource state={state} active authOnly={authOnly} />,
        );
        doesNotMatch(
          html,
          /type="file"|Local control file|Import local control file/,
        );
        if (authOnly && error) {
          match(html, /Local development session unavailable/);
        }
      }
    }
  }
  state.requests.environment.value = "production";
  const manual = renderToString(
    <RequestSource state={state} active authOnly />,
  );
  match(manual, /Import local control file/);
});
