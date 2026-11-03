/** A Case record as `/api/cases` returns it, with a field the UI ignores. */
export function caseRecord(
  number: number,
  patch: Record<string, unknown> = {},
) {
  return {
    id: `ui-fixture:case:${number}`,
    number,
    type: "request",
    caseTypeId: "request:builder",
    objective: `Objective ${number}`,
    owner: "native:coordinator",
    openedBy: "native:coordinator",
    openedFrom: { conversationId: "ui-fixture", messageId: `m${number}` },
    modelPin: { digest: "pin", repositoryVersion: "commit:abc" },
    status: "open",
    budget: { budgetId: "budget", scopeId: `ui-fixture:case:${number}` },
    createdAt: `2026-10-24T1${number}:00:00Z`,
    ...patch,
  };
}

/** A Job as the page expects it once the backend serves Jobs. */
export function jobRecord(number = 7) {
  return caseRecord(number, {
    type: "job",
    objective: "Monthly market report",
    createdAt: "2026-10-01T09:00:00Z",
    job: {
      schedule: "1st of the month, 09:00",
      steps: [
        { id: "collect", label: "Collect sources", state: "done" },
        { id: "draft", label: "Draft the report", state: "done" },
        {
          id: "review",
          label: "Review the draft",
          state: "judgment",
          judgment: {
            question: "Publish this draft?",
            options: [{ id: "publish", label: "Publish" }, {
              id: "revise",
              label: "Ask for changes",
            }],
          },
        },
        { id: "send", label: "Send to the team", state: "pending" },
      ],
      runs: [
        { id: "r1", startedAt: "2026-08-01T09:00:00Z", outcome: "done" },
        { id: "r2", startedAt: "2026-09-01T09:00:00Z", outcome: "failed" },
        { id: "r3", startedAt: "2026-10-01T09:00:00Z", outcome: "running" },
      ],
    },
  });
}

/** A Watch as the page expects it once the backend serves Watches. */
export function watchRecord(number = 8, state = "watching") {
  return caseRecord(number, {
    type: "watch",
    objective: "New AI training offers",
    createdAt: "2026-10-20T08:00:00Z",
    watch: {
      state,
      nextWakeAt: "2026-10-24T15:00:00Z",
      wakes: [
        { at: "2026-10-24T09:00:00Z", changed: false },
        { at: "2026-10-24T10:00:00Z", changed: false },
        { at: "2026-10-24T11:00:00Z", changed: true, summary: "2 new offers" },
        { at: "2026-10-24T12:00:00Z", changed: false },
        { at: "2026-10-24T13:00:00Z", changed: false },
        { at: "2026-10-24T14:00:00Z", changed: false },
      ],
    },
  });
}
