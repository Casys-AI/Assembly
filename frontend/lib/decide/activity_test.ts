import { equal, match, ok } from "node:assert/strict";
import { activityEvents } from "./activity.ts";
import {
  activityInput,
  recorded,
} from "../../test/support/activity-fixture.ts";
import {
  creation,
  grant,
  operatorRoster,
} from "../../test/support/operator-fixture.ts";
import { localSkillRelease } from "../../test/support/release-opening-fixture.ts";
import { commit, HEAD } from "../../test/support/revision-fixture.ts";
import { snapshot } from "../../test/support/workbench-fixture.ts";

Deno.test("only dated decisions and proven publications create events; a roster, approval or incomplete Release does not", () => {
  const made = creation({
    ...recorded,
    kind: "operator-creation",
    name: "Research",
    publishedCommit: HEAD,
  });
  const approved = creation({
    ...recorded,
    id: "approved-only",
    kind: "operator-creation",
  });
  const undated = grant({ status: "refused" });
  const input = activityInput({
    conversations: operatorRoster([made, approved, undated]).conversations,
    releases: [localSkillRelease()],
    history: {
      headVersion: HEAD,
      truncated: false,
      commits: [
        commit(HEAD, undefined, "owner", "created", "2026-11-03T10:03:00Z"),
      ],
    },
  });
  const events = activityEvents(input);
  equal(events.filter((event) => event.kind === "decision").length, 2);
  const members = events.filter((event) => event.kind === "member-created");
  equal(members.length, 1);
  equal(members[0].at, "2026-11-03T10:03:00Z");
  equal(events.some((event) => event.kind === "release-created"), false);
  equal(
    activityEvents({ ...input, history: null }).some((event) =>
      event.kind === "member-created"
    ),
    false,
  );
  equal(
    activityEvents(
      activityInput({ conversations: operatorRoster().conversations }),
    ).length,
    0,
  );
});

Deno.test("a completion notice without a Case reports a notification, not an invented closure or owner name", () => {
  const events = activityEvents(activityInput({
    mainMessages: [{
      id: "report",
      role: "tool",
      text: "report",
      at: "2026-11-03T10:00:00Z",
      operatorNotice: {
        kind: "request-completed",
        caseId: "unknown-case",
        owner: "unknown-operator",
        openedBy: "main",
        status: "closed-done",
        result: "Done",
      },
    }],
  }));
  equal(events.length, 1);
  equal(events[0].title, "Request completion reported · Done");
  equal(events[0].byline, undefined);
  equal(
    events[0].facts.find((fact) => fact.label === "Reported at")?.value,
    "2026-11-03T10:00:00Z",
  );
});

Deno.test("a recorded tool admission is dated by its own receipt, while an undated refusal contributes no event", () => {
  const candidate = snapshot().candidates[0];
  const admission = {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    mandateRevision: 1,
    authority: "human" as const,
    actorId: "owner",
    configurationRevision: 1,
    reason: "Accepted",
    at: "2026-11-03T10:00:00Z",
  };
  const tools = [{
    agentId: "designer",
    agentName: "Designer",
    revision: 1,
    candidate: { ...candidate, admission },
  }];
  const events = activityEvents(activityInput({ tools }));
  equal(events.length, 1);
  equal(events[0].at, admission.at);
  equal(events[0].byline, "Decided by you");
  equal(
    activityEvents(
      activityInput({
        tools: [{ ...tools[0], candidate: { ...candidate, stage: "refused" } }],
      }),
    ).length,
    0,
  );
});
Deno.test("an operator handoff is visible before any decision and names the recorded decider", () => {
  const actor = {
    operatorId: "native:designer",
    executionSpaceId: "main",
    policyId: "policy",
    policyRevision: 1,
  };
  const input = activityInput({
    conversations: operatorRoster().conversations,
    mainMessages: [{
      id: "handoff",
      at: "2026-11-04T00:00:00Z",
      role: "tool",
      text: "record",
      operatorNotice: {
        kind: "authority-escalation",
        caseId: "request",
        changeId: "change",
        requestedBy: "native:research",
        recipient: "native:designer",
        decisionAuthority: "operator",
        reason: "Extend web access",
        route: {
          version: 2,
          changeId: "change",
          caseId: "request",
          requestedBy: "native:research",
          targetOperatorId: "native:research",
          baseRevision: 1,
          modelDigest: "digest",
          status: "actor-decision",
          responsibleOperatorId: "native:designer",
          requester: {
            operatorId: "native:research",
            projectId: "project",
            systemId: "system",
            executionSpaceId: "request-space",
          },
          designatedDecider: actor,
          trace: [{ ...actor, eligibility: "eligible" }],
        },
      },
    }],
  });
  const events = activityEvents(input);
  equal(events.length, 1);
  equal(events[0].kind, "handoff");
  match(
    events[0].title,
    /Research asked Extend web access, handed to Designer/,
  );
  equal(events[0].href, "/cases?case=request");
  equal(events[0].decision, undefined);
  const first = input.mainMessages[0];
  const notice = first.operatorNotice!;
  ok(notice.kind === "authority-escalation");
  const historical = activityEvents({
    ...input,
    mainMessages: [first, {
      ...first,
      id: "another-handoff",
      at: "2026-11-04T01:00:00Z",
      operatorNotice: { ...notice, route: undefined },
    }],
  });
  equal(historical.length, 2);
  equal(
    historical[0].title,
    "Research asked Extend web access · Operator decision",
  );
});
