import { deepStrictEqual, equal } from "node:assert/strict";
import {
  currentContextModelHref,
  inheritModelViewContext,
  modelConversationHidden,
  modelConversationHref,
  modelInspectionVersion,
  modelPlaceConversationHref,
  modelViewContext,
  reopenModelViewContext,
  switchModelViewContext,
  unavailableModelScope,
  withModelViewContext,
} from "./model-context.ts";

const request = { caseId: "request:7", agentId: "collector" };

Deno.test("model conversation transitions preserve exact scope for hiding and use full chat from page-only", () => {
  const original =
    "/model?page=files&caseBranch=request%3A7&agent=collector&branch=requests%2F7&version=commit%3Aold&file=a.sysml";
  const hidden = modelConversationHref(
    original,
    request,
    request,
    "/cases?case=request%3A7&agent=collector",
  );
  equal(hidden, `${original}&conversation=hidden`);
  equal(modelConversationHidden(new URL(hidden, "http://atelier.test")), true);
  equal(
    modelConversationHref(
      hidden,
      request,
      request,
      "/cases?case=request%3A7&agent=collector",
    ),
    "/cases?case=request%3A7&agent=collector",
  );
  equal(
    modelConversationHref(
      hidden,
      request,
      { caseId: null, agentId: null },
      "/chat",
    ),
    `${original}&conversation=main`,
  );
  equal(
    modelConversationHref(original, request, {
      caseId: "other",
      agentId: "worker",
    }, "/cases?case=other&agent=worker"),
    "/model?page=files&caseBranch=other&agent=worker",
  );
  equal(
    modelConversationHref(
      "/system?page=rights&version=commit%3Aold",
      { caseId: null, agentId: null },
      { caseId: null, agentId: null },
      "/chat",
    ),
    "/system?page=rights&version=commit%3Aold&conversation=hidden",
  );
  equal(modelPlaceConversationHref(hidden, false), original);
  equal(modelPlaceConversationHref(original, true), hidden);
  const main = modelConversationHref(original, request, {
    caseId: null,
    agentId: null,
  }, "/chat");
  equal(main, `${original}&conversation=main`);
  equal(
    modelConversationHref(main, request, request, "/cases?case=request%3A7"),
    original,
  );
  equal(
    inheritModelViewContext(
      "/system?page=team",
      new URL(main, "http://atelier.test").search,
    ),
    "/system?page=team&caseBranch=request%3A7&branch=requests%2F7&agent=collector&conversation=main",
  );
  equal(
    inheritModelViewContext(
      "/system?page=rights",
      new URL(hidden, "http://atelier.test").search,
    ),
    "/system?page=rights&caseBranch=request%3A7&branch=requests%2F7&agent=collector&conversation=hidden",
  );
});

Deno.test("model context round-trips the exact Case and sub-operator without inventing a branch", () => {
  const href = withModelViewContext("/model?page=files", request);
  equal(href, "/model?page=files&caseBranch=request%3A7&agent=collector");
  const url = new URL(href, "http://atelier.test");
  deepStrictEqual(modelViewContext(url), request);
  equal(url.searchParams.has("branch"), false);
  equal(unavailableModelScope(url.searchParams), true);
});

Deno.test("all unsupported source scopes fail closed, including empty explicit scopes", () => {
  for (
    const scope of [
      "caseBranch=request%3A7",
      "caseBranch=",
      "branch=requests/7",
      "branch=",
    ]
  ) {
    equal(unavailableModelScope(new URLSearchParams(scope)), true, scope);
  }
  for (const scope of ["", "branch=main", "version=commit%3Aold"]) {
    equal(unavailableModelScope(new URLSearchParams(scope)), false, scope);
  }
});

Deno.test("selecting a different conversation retains its page and clears only inspection selection", () => {
  const href = switchModelViewContext(
    "/system?page=rights&caseBranch=old&agent=old-agent&version=commit%3Aold&select=element",
    request,
  );
  equal(href, "/system?page=rights&caseBranch=request%3A7&agent=collector");
  equal(
    switchModelViewContext(href, { caseId: null, agentId: null }),
    "/system?page=rights",
  );
});

Deno.test("returning to the current model retains the conversation, source scope and page", () => {
  const url = new URL(
    "http://atelier.test/model?page=files&caseBranch=request%3A7&agent=collector&version=commit%3Aold&file=a.sysml",
  );
  equal(
    currentContextModelHref(url),
    "/model?page=files&caseBranch=request%3A7&agent=collector&file=a.sysml",
  );
  deepStrictEqual(modelViewContext(url), request);
});

Deno.test("tabs retain Case scope and selected conversation independently of the inspected version", () => {
  equal(
    inheritModelViewContext(
      "/system?page=team&version=commit%3Aold",
      "?caseBranch=request%3A7&agent=collector",
    ),
    "/system?page=team&version=commit%3Aold&caseBranch=request%3A7&agent=collector",
  );
  equal(
    inheritModelViewContext("/cases?case=other", "?caseBranch=request%3A7"),
    "/cases?case=other",
  );
});

Deno.test("reopening a place keeps its inspection for the same conversation, never another Case", () => {
  const href =
    "/model?page=files&caseBranch=request%3A7&agent=collector&version=commit%3Aold";
  equal(reopenModelViewContext(href, request), href);
  equal(
    reopenModelViewContext(href, { caseId: "other", agentId: null }),
    "/model?page=files&caseBranch=other",
  );
});

Deno.test("inspection aliases follow the mounted page's real reader contract", () => {
  const cases: [string, string | null][] = [
    ["/model?page=activity&modelVersion=commit%3Aold", null],
    ["/model?page=activity&commit=commit%3Aold", null],
    ["/model?page=files&modelVersion=commit%3Aold", null],
    ["/model?page=files&commit=commit%3Aold", null],
    ["/model?page=releases&modelVersion=commit%3Aold", null],
    ["/model?page=revisions&modelVersion=commit%3Aold", null],
    ["/system?modelVersion=commit%3Aold", null],
    ["/system?commit=commit%3Aold", null],
    ["/model?page=sysml&commit=commit%3Aold", null],
    ["/model?page=sysml&modelVersion=commit%3Aold", "commit:old"],
    ["/model?modelVersion=commit%3Aold", "commit:old"],
    ["/revisions?modelVersion=commit%3Aold", "commit:old"],
    [
      "/model?page=sysml&version=commit%3Achosen&modelVersion=commit%3Aold",
      "commit:chosen",
    ],
    [
      "/model?page=files&version=commit%3Achosen&modelVersion=commit%3Aold",
      "commit:chosen",
    ],
    ["/system?version=commit%3Achosen&commit=commit%3Aold", "commit:chosen"],
    ["/model?commit=commit%3Aold", "commit:old"],
    ["/model?page=revisions&proposal=proposal-a&commit=commit%3Aold", null],
    ["/model?page=graph&revision=3&version=commit%3Aold", null],
  ];
  for (const [href, expected] of cases) {
    equal(
      modelInspectionVersion(new URL(href, "http://atelier.test")),
      expected,
      href,
    );
  }
});
