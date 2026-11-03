import { deepStrictEqual, equal } from "node:assert/strict";
import {
  type LegacyRequestAuthorityRoute,
  noticeRequest,
  type NoticeRoute,
  type OperatorNotice,
  readNoticeRoute,
  readOperatorNotice,
  routeCodeLabel,
  shortSummary,
} from "./operator-notice.ts";
import type {
  AuthorityRouteCode,
  RequestAuthorityRoute,
} from "../../../src/domain/governance/operator-authority.ts";

const route: LegacyRequestAuthorityRoute = {
  version: 1,
  changeId: "change:network",
  caseId: "case:research",
  requestedBy: "native:leaf",
  targetOperatorId: "native:leaf",
  responsibleOperatorId: "native:research-owner",
  baseRevision: 3,
  modelDigest: "current-model",
  status: "actor-decision",
  designatedDecider: {
    operatorId: "native:main",
    policyId: "grant:network",
    policyRevision: 2,
  },
  trace: [{
    operatorId: "native:research-owner",
    eligibility: "not-covered",
  }, {
    operatorId: "native:main",
    eligibility: "eligible",
    policyId: "grant:network",
    policyRevision: 2,
  }],
};
type Escalation = Extract<OperatorNotice, { kind: "authority-escalation" }>;
// A historical notice holds the version 1 route it recorded, outside its type.
const routedNotice = (value: NoticeRoute = route): Escalation => ({
  kind: "authority-escalation",
  changeId: route.changeId,
  caseId: route.caseId,
  requestedBy: route.requestedBy,
  recipient: "native:main",
  decisionAuthority: value.status === "actor-decision"
    ? "operator"
    : value.status === "human-decision"
    ? "human"
    : "unresolved",
  reason: "Read example.org",
  route: value as Escalation["route"],
});

Deno.test("notice routes require exact request binding and a matching checked actor grant", () => {
  equal(readNoticeRoute(routedNotice()), route);
  const initialConfiguration = { ...route, baseRevision: 0 };
  equal(
    readNoticeRoute(routedNotice(initialConfiguration)),
    initialConfiguration,
  );
  for (
    const patch of [
      { changeId: "other" },
      { caseId: "other" },
      { requestedBy: "other" },
      { targetOperatorId: "other" },
      { modelDigest: "" },
      { baseRevision: -1 },
      { designatedDecider: { ...route.designatedDecider!, policyRevision: 0 } },
      { trace: [] },
      { designatedDecider: { ...route.designatedDecider!, policyRevision: 8 } },
      { trace: [...route.trace, route.trace[0]!] },
      { status: "human-decision" as const },
    ]
  ) equal(readNoticeRoute(routedNotice({ ...route, ...patch })), undefined);
  const human: LegacyRequestAuthorityRoute = {
    ...route,
    status: "human-decision",
    designatedDecider: undefined,
    trace: route.trace.map((hop) => ({ ...hop, eligibility: "not-covered" })),
  };
  equal(readNoticeRoute(routedNotice(human)), human);
  equal(
    readNoticeRoute(routedNotice({ ...human, status: "needs-resolution" }))
      ?.status,
    "needs-resolution",
  );
});

const space = {
  projectId: "project",
  systemId: "system",
  executionSpaceId: "main",
};
const routeV2: RequestAuthorityRoute = {
  version: 2,
  changeId: route.changeId,
  caseId: route.caseId,
  requestedBy: route.requestedBy,
  requester: { ...space, operatorId: route.requestedBy },
  targetOperatorId: route.targetOperatorId,
  responsibleOperatorId: "native:research-owner",
  baseRevision: 3,
  modelDigest: "current-model",
  status: "actor-decision",
  designatedDecider: {
    operatorId: "native:main",
    executionSpaceId: "main",
    policyId: "grant:network",
    policyRevision: 2,
  },
  trace: [{
    operatorId: "native:research-owner",
    executionSpaceId: "main",
    eligibility: "not-covered",
  }, {
    operatorId: "native:main",
    executionSpaceId: "main",
    eligibility: "eligible",
    policyId: "grant:network",
    policyRevision: 2,
  }],
};
/** A Branch Operator asks; its Main Operator shares its native ID, in main. */
const branchV2: RequestAuthorityRoute = {
  ...routeV2,
  requester: {
    ...space,
    executionSpaceId: "request:1",
    operatorId: "native:bo",
  },
  requestedBy: "native:bo",
  targetOperatorId: "native:bo",
  openingId: "opening:1",
  responsibleOperatorId: "native:bo",
  designatedDecider: {
    operatorId: "native:bo",
    executionSpaceId: "main",
    policyId: "grant:network",
    policyRevision: 2,
  },
  trace: [{
    operatorId: "native:bo",
    executionSpaceId: "main",
    eligibility: "eligible",
    policyId: "grant:network",
    policyRevision: 2,
  }],
};
const branchNotice = (value: NoticeRoute): Escalation => ({
  ...routedNotice(value),
  requestedBy: "native:bo",
});

Deno.test("version 2 routes are read with the same binding as version 1, on instances", () => {
  equal(readNoticeRoute(routedNotice(routeV2)), routeV2);
  equal(readNoticeRoute(branchNotice(branchV2)), branchV2);
  // The requester and its Main Operator share a native ID: only the space differs.
  equal(
    readNoticeRoute(branchNotice({
      ...branchV2,
      designatedDecider: {
        ...branchV2.designatedDecider!,
        executionSpaceId: "request:1",
      },
      trace: [{ ...branchV2.trace[0]!, executionSpaceId: "request:1" }],
    })),
    undefined,
  );
  // The same native ID in two spaces is two hops, not a repeated one.
  const crossing: RequestAuthorityRoute = {
    ...branchV2,
    trace: [
      {
        operatorId: "native:bo",
        executionSpaceId: "request:1",
        eligibility: "not-covered",
      },
      branchV2.trace[0]!,
    ],
  };
  equal(readNoticeRoute(branchNotice(crossing)), crossing);
  for (
    const patch of [
      { version: 3 },
      { version: "2" },
      { changeId: "other" },
      { caseId: "other" },
      { requestedBy: "other" },
      { targetOperatorId: "other" },
      { requester: undefined },
      { requester: { ...routeV2.requester, operatorId: "other" } },
      { requester: { ...routeV2.requester, executionSpaceId: "" } },
      { requester: { ...routeV2.requester, systemId: undefined } },
      { openingId: "" },
      { code: "CHAIN_UNVERIFIED" },
      { scopedActors: {} },
      {
        designatedDecider: {
          ...routeV2.designatedDecider!,
          executionSpaceId: undefined,
        },
      },
      {
        designatedDecider: {
          ...routeV2.designatedDecider!,
          executionSpaceId: "request:1",
        },
      },
      {
        trace: [
          { ...routeV2.trace[0]!, executionSpaceId: undefined },
          routeV2
            .trace[1]!,
        ],
      },
      { trace: [...routeV2.trace, routeV2.trace[0]!] },
      { trace: [] },
      { status: "human-decision" },
    ]
  ) {
    equal(
      readNoticeRoute(routedNotice({ ...routeV2, ...patch } as NoticeRoute)),
      undefined,
      JSON.stringify(patch),
    );
  }
  // A route of one version carries nothing of the other.
  for (
    const patch of [
      { requester: routeV2.requester },
      { openingId: "opening:1" },
      { code: "CHAIN_UNVERIFIED" },
      {
        designatedDecider: {
          ...route.designatedDecider!,
          executionSpaceId: "main",
        },
      },
      { trace: [{ ...route.trace[0]!, executionSpaceId: "main" }] },
    ]
  ) {
    equal(
      readNoticeRoute(
        routedNotice({ ...route, ...patch } as unknown as NoticeRoute),
      ),
      undefined,
      JSON.stringify(patch),
    );
  }
});

Deno.test("version 2 routes with no decider are read, a needs-resolution one with its closed code", () => {
  // What the host records for a Request branch whose Main policy is unknown.
  const human: RequestAuthorityRoute = {
    ...branchV2,
    status: "human-decision",
    responsibleOperatorId: undefined,
    designatedDecider: undefined,
    trace: [],
    reason: "Existing native-ID policies do not grant cross-space authority.",
  };
  equal(readNoticeRoute(branchNotice(human)), human);
  const unresolved = (code: unknown): Escalation => ({
    ...branchNotice({
      ...human,
      status: "needs-resolution",
      code: code as AuthorityRouteCode,
    }),
    decisionAuthority: "unresolved",
  });
  for (const code of Object.keys(routeCodeLabel)) {
    equal(readNoticeRoute(unresolved(code))?.code, code);
  }
  // A stale proposal keeps its route and says why it needs resolution.
  equal(readNoticeRoute(unresolved("CHANGE_STALE"))?.code, "CHANGE_STALE");
  equal(
    routeCodeLabel.CHANGE_STALE,
    "The change was proposed on an older revision",
  );
  for (const code of [undefined, "", "OTHER", 1, null, "toString"]) {
    equal(readNoticeRoute(unresolved(code)), undefined, String(code));
  }
  // A notice that says another authority than its route is not read.
  equal(
    readNoticeRoute({
      ...unresolved("MAIN_UNAVAILABLE"),
      decisionAuthority: "human",
    }),
    undefined,
  );
});

Deno.test("a notice says what was asked on one line, from the rights recorded with it", () => {
  const asked = (patch: object): Escalation => ({
    ...routedNotice(routeV2),
    changeKind: "mandate-change",
    requestedRights: { addNetworkHosts: ["example.org", "example.net"] },
    ...patch,
  });
  equal(
    noticeRequest(asked({})),
    "Extend web access: example.org, example.net",
  );
  equal(
    noticeRequest(
      asked({ requestedRights: { setUrlSelectionMode: "user-provided" } }),
    ),
    "Choose which pages to read",
  );
  // Recorded before the rights: nothing to say.
  equal(noticeRequest(asked({ requestedRights: undefined })), undefined);
  equal(noticeRequest(asked({ changeKind: undefined })), undefined);
  equal(
    noticeRequest({
      kind: "request-completed",
      caseId: "case",
      owner: "native:r",
      openedBy: "native:d",
      status: "closed-done",
      result: "Done",
    }),
    undefined,
  );
});

Deno.test("a summary is the first sentence, cut at a word, and never longer than asked", () => {
  equal(
    shortSummary("Read example.org. I need it to answer."),
    "Read example.org",
  );
  equal(shortSummary("  Allow\n  two hosts?  "), "Allow");
  equal(shortSummary(""), "");
  const long =
    "Read every page of the example website and compare them one by one";
  const cut = shortSummary(long, 30);
  equal(cut, "Read every page of the…");
  equal([...shortSummary("é".repeat(200), 20)].length, 20);
});

Deno.test("only the three exact shapes of notice are read", () => {
  const escalation = {
    kind: "authority-escalation",
    changeId: "c",
    requestedBy: "native:r",
    caseId: "case",
    recipient: "native:d",
    decisionAuthority: "human",
    reason: "Read example.org",
  };
  const completed = {
    kind: "request-completed",
    caseId: "case",
    owner: "native:r",
    openedBy: "native:d",
    status: "closed-done",
    result: "Done",
  };
  const order = {
    kind: "subordinate-order",
    invocationId: "invocation:1",
    caseId: "case",
    subordinate: "native:sub",
    orderedBy: { operatorId: "native:main", executionSpaceId: "main" },
    summary: "Read example.org",
  };
  for (const operatorNotice of [escalation, completed, order]) {
    deepStrictEqual(
      readOperatorNotice({ operatorNotice } as never),
      operatorNotice,
    );
  }
  const unreadable = [
    undefined,
    null,
    "authority-escalation",
    { ...escalation, kind: "other" },
    { ...escalation, caseId: "" },
    { ...escalation, reason: 1 },
    { ...completed, status: "closed-open" },
    { ...completed, owner: undefined },
    { ...completed, result: undefined },
    { ...order, invocationId: "" },
    { ...order, caseId: undefined },
    { ...order, subordinate: 1 },
    { ...order, orderedBy: undefined },
    { ...order, orderedBy: "native:main" },
    { ...order, orderedBy: { executionSpaceId: "main" } },
    { ...order, orderedBy: { operatorId: "" } },
    { ...order, orderedBy: { operatorId: "native:main", executionSpaceId: 1 } },
    {
      ...order,
      orderedBy: { operatorId: "native:main", executionSpaceId: "" },
    },
    { ...order, summary: undefined },
    { ...order, summary: 1 },
  ];
  for (const operatorNotice of unreadable) {
    equal(readOperatorNotice({ operatorNotice } as never), undefined);
  }
  // An order from the Case's own space names no space; an empty text is still one.
  const { executionSpaceId: _, ...local } = order.orderedBy;
  for (
    const operatorNotice of [{ ...order, orderedBy: local }, {
      ...order,
      summary: "",
    }]
  ) {
    deepStrictEqual(
      readOperatorNotice({ operatorNotice } as never),
      operatorNotice,
    );
  }
});
