import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import {
  agentActivity,
  caseAgentHref,
  caseHref,
  type CaseRecord,
  type CasesPort,
  type CasesSnapshot,
  caseTitle,
  createCases,
  createCasesApi,
  groupWakes,
  isOpenCase,
  messageCaseId,
  parseCasesSnapshot,
  since,
} from "./cases.ts";
import {
  caseRecord,
  jobRecord,
  watchRecord,
} from "../../test/support/case-fixture.ts";

Deno.test("the cases parser keeps the fields it knows and ignores the others", () => {
  const snapshot = parseCasesSnapshot({
    systemId: "ui-fixture",
    futureField: true,
    cases: [caseRecord(1, { priority: "high", owner: "native:coordinator" })],
  });
  equal(snapshot.cases[0].number, 1);
  equal("priority" in snapshot.cases[0], false);
  equal("caseTypeId" in snapshot.cases[0], false);
  equal(snapshot.cases[0].budget?.scopeId, "ui-fixture:case:1");
});

Deno.test("the cases parser rejects invalid entries without hiding valid Cases", () => {
  for (
    const bad of [
      { number: 0 },
      { type: "routine" },
      { type: ["request"] },
      { status: "paused" },
      { status: ["open"] },
      { type: 1 },
      { status: null },
      { objective: " " },
      { createdAt: "yesterday" },
      { modelPin: {} },
      { openedFrom: { conversationId: "" } },
      { budget: { budgetId: "budget" } },
    ]
  ) {
    const parsed = parseCasesSnapshot({
      systemId: "s",
      cases: [caseRecord(1, bad), caseRecord(2, { futureField: true })],
    });
    deepStrictEqual(parsed.cases.map((entry) => entry.number), [2]);
    equal("futureField" in parsed.cases[0], false);
  }
  throws(() =>
    parseCasesSnapshot({ systemId: "s", cases: [caseRecord(1), caseRecord(1)] })
  );
  throws(() => parseCasesSnapshot({ systemId: "s" }));
});

Deno.test("the cases parser requires string enums in Job and Watch details too", () => {
  const invalid = [
    caseRecord(1, {
      type: "job",
      job: { steps: [{ id: "s", label: "Step", state: ["done"] }], runs: [] },
    }),
    caseRecord(2, {
      type: "job",
      job: {
        steps: [],
        runs: [{
          id: "r",
          startedAt: "2026-10-24T12:00:00Z",
          outcome: ["done"],
        }],
      },
    }),
    caseRecord(3, {
      type: "watch",
      watch: { state: ["watching"], wakes: [] },
    }),
  ];
  deepStrictEqual(
    parseCasesSnapshot({ systemId: "s", cases: [...invalid, caseRecord(4)] })
      .cases.map((entry) => entry.number),
    [4],
  );
});

Deno.test("open cases, case ids on messages and case addresses", () => {
  equal(isOpenCase({ status: "waiting" }), true);
  equal(isOpenCase({ status: "closed-done" }), false);
  equal(messageCaseId({ id: "m", caseId: "s:case:2" }), "s:case:2");
  equal(messageCaseId({ id: "m", caseId: "" }), undefined);
  equal(messageCaseId({ id: "m" }), undefined);
  // A Request opens on the Requests page, selected; a Job or a Watch on its own page.
  equal(caseHref("s:case:2"), "/cases?case=s%3Acase%3A2");
  equal(caseHref("s:case:2", "request"), "/cases?case=s%3Acase%3A2");
  equal(caseHref("s:case:7", "job"), "/chat?case=s%3Acase%3A7");
  equal(caseHref("s:case:8", "watch"), "/chat?case=s%3Acase%3A8");
  // A sub-agent's messages in a Request are in the address too.
  equal(
    caseAgentHref("s:case:2", "collector"),
    "/cases?case=s%3Acase%3A2&agent=collector",
  );
});

Deno.test("a backend without cases answers 404: the store marks them unsupported without an error", async () => {
  const api = createCasesApi(() =>
    Promise.resolve(Response.json({ error: "Introuvable" }, { status: 404 }))
  );
  equal(await api.read(), null);
  const store = createCases({ port: api });
  await store.refresh();
  equal(store.supported.value, false);
  equal(store.error.value, "");
  deepStrictEqual(store.open.value, []);
});

Deno.test("open cases come oldest first, and a live snapshot replaces the list", async () => {
  const port: CasesPort = {
    read: () =>
      Promise.resolve(parseCasesSnapshot({
        systemId: "ui-fixture",
        cases: [
          caseRecord(2),
          caseRecord(1, {
            status: "closed-done",
            closedAt: "2026-10-24T12:00:00Z",
          }),
          caseRecord(3, { status: "waiting" }),
        ],
      })),
    close: () => Promise.resolve(),
    act: () => Promise.resolve(),
    readOne: () => Promise.resolve(null),
  };
  const store = createCases({ port });
  await store.refresh();
  equal(store.supported.value, true);
  deepStrictEqual(store.open.value.map((entry) => entry.number), [2, 3]);
  // The SSE `cases` event: the agent has just opened Case #4.
  store.accept({
    systemId: "ui-fixture",
    cases: [caseRecord(2), caseRecord(3), caseRecord(4)],
  });
  deepStrictEqual(store.open.value.map((entry) => entry.number), [2, 3, 4]);
  equal(store.byId("ui-fixture:case:4")?.objective, "Objective 4");
});

Deno.test("a suspended GET never replaces a newer SSE snapshot", async () => {
  let finish!: (value: CasesSnapshot | null) => void;
  let collectionReads = 0;
  const old = parseCasesSnapshot({ systemId: "s", cases: [caseRecord(1)] });
  const store = createCases({
    port: {
      read: () => {
        collectionReads++;
        return new Promise((resolve) => finish = resolve);
      },
      readOne: () => Promise.resolve(null),
      close: () => Promise.resolve(),
      act: () => Promise.resolve(),
    },
  });
  const pending = store.refresh();
  // Deliver the event while the GET is still suspended, not after it settles.
  store.accept({ systemId: "s", cases: [caseRecord(1), caseRecord(2)] });
  finish(old);
  await pending;
  deepStrictEqual(store.open.value.map((entry) => entry.number), [1, 2]);
  equal(store.supported.value, true);
  equal(store.error.value, "");
  equal(collectionReads, 1);
});

Deno.test("an obsolete GET 404 or failure cannot undo a newer SSE event", async () => {
  for (const failure of [false, true]) {
    let finish!: (value: CasesSnapshot | null) => void;
    let reject!: (reason: Error) => void;
    const store = createCases({
      port: {
        read: () =>
          new Promise((resolve, fail) => {
            finish = resolve;
            reject = fail;
          }),
        readOne: () => Promise.resolve(null),
        close: () => Promise.resolve(),
        act: () => Promise.resolve(),
      },
    });
    const pending = store.refresh();
    store.accept({ systemId: "s", cases: [caseRecord(1), caseRecord(2)] });
    if (failure) reject(new Error("Old failure"));
    else finish(null);
    await pending;
    deepStrictEqual(store.open.value.map((entry) => entry.number), [1, 2]);
    equal(store.supported.value, true);
    equal(store.error.value, "");
  }
});

Deno.test("a GET started after the latest SSE can update the collection", async () => {
  const store = createCases({
    port: createCasesApi(() =>
      Promise.resolve(Response.json({
        systemId: "s",
        cases: [caseRecord(1, { status: "closed-done" })],
      }))
    ),
  });
  store.accept({ systemId: "s", cases: [caseRecord(1)] });
  await store.refresh();
  deepStrictEqual(store.open.value, []);
});

Deno.test("the detail reader uses the existing encoded Case endpoint and strict parser", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  let body: unknown = caseRecord(1, { futureField: true });
  const api = createCasesApi((path, init) => {
    calls.push({ path, init });
    return Promise.resolve(Response.json(body));
  });
  const record = await api.readOne("ui-fixture:case:1");
  equal(record?.number, 1);
  equal("futureField" in record!, false);
  equal(calls[0].path, "/api/cases/ui-fixture%3Acase%3A1");
  equal(calls[0].init?.cache, "no-store");
  equal(calls[0].init?.method, undefined);
  body = caseRecord(1, { type: ["request"] });
  await rejects(() => api.readOne("ui-fixture:case:1"), /unreadable/);
  body = caseRecord(2);
  await rejects(() => api.readOne("ui-fixture:case:1"), /does not match/);
});

Deno.test("a missing collection Case is read once without changing the Dock collection", async () => {
  const paths: string[] = [];
  const store = createCases({
    port: createCasesApi((path) => {
      paths.push(path);
      return Promise.resolve(Response.json(caseRecord(2, {
        status: "closed-done",
        closedAt: "2026-10-24T12:00:00Z",
      })));
    }),
  });
  store.accept({ systemId: "s", cases: [caseRecord(1)] });
  await store.ensure("ui-fixture:case:1");
  deepStrictEqual(paths, []);
  const pending = store.ensure("ui-fixture:case:2");
  equal(store.detailStatus("ui-fixture:case:2"), "loading");
  equal(store.ensure("ui-fixture:case:2"), pending);
  await pending;
  equal(store.byId("ui-fixture:case:2")?.status, "closed-done");
  deepStrictEqual(store.open.value.map((entry) => entry.number), [1]);
  deepStrictEqual(paths, ["/api/cases/ui-fixture%3Acase%3A2"]);
  await store.ensure("ui-fixture:case:2");
  equal(paths.length, 1);
});

Deno.test("a Case detail 404 is not-found, while a failed read retains its error", async () => {
  for (const status of [404, 503]) {
    const api = createCasesApi(() =>
      Promise.resolve(Response.json({
        error: { message: "Please try again" },
      }, { status }))
    );
    if (status === 404) equal(await api.readOne("missing"), null);
    const store = createCases({ port: api });
    await store.ensure("missing");
    equal(store.byId("missing"), null);
    equal(
      store.detailStatus("missing"),
      status === 404 ? "not-found" : "error",
    );
    equal(
      store.detailError("missing"),
      status === 404 ? "" : "Please try again",
    );
    // A detail 404 says nothing about support for the collection endpoint.
    equal(store.supported.value, null);
    equal(store.error.value, "");
  }
});

Deno.test("SSE data wins over an in-flight detail read, and disposed reads stay inert", async () => {
  let finish!: (record: CaseRecord | null) => void;
  const store = createCases({
    port: {
      read: () => Promise.resolve(null),
      readOne: () => new Promise((resolve) => finish = resolve),
      close: () => Promise.resolve(),
      act: () => Promise.resolve(),
    },
  });
  const pending = store.ensure("ui-fixture:case:1");
  store.accept({
    systemId: "s",
    cases: [caseRecord(1, { status: "waiting" })],
  });
  finish(
    parseCasesSnapshot({ systemId: "s", cases: [caseRecord(1)] }).cases[0],
  );
  await pending;
  equal(store.byId("ui-fixture:case:1")?.status, "waiting");
  const disposed = store.ensure("missing");
  store.dispose();
  finish(null);
  await disposed;
  equal(store.detailStatus("missing"), undefined);
});

Deno.test("a newer collection invalidates a suspended open detail even without SSE", async () => {
  let finish!: (record: CaseRecord | null) => void;
  let detailReads = 0;
  const old = parseCasesSnapshot({ systemId: "s", cases: [caseRecord(1)] })
    .cases[0];
  const closed = { ...old, status: "closed-done" as const };
  const store = createCases({
    port: {
      read: () => Promise.resolve({ systemId: "s", cases: [] }),
      readOne: () => {
        detailReads++;
        return detailReads === 1
          ? new Promise((resolve) => finish = resolve)
          : Promise.resolve(closed);
      },
      close: () => Promise.resolve(),
      act: () => Promise.resolve(),
    },
  });
  const pending = store.ensure(old.id);
  // The Case closes while SSE is disconnected; only the collection catches up.
  await store.refresh();
  finish(old);
  await pending;
  equal(store.byId(old.id)?.status, "closed-done");
  equal(detailReads, 2);
  await store.ensure(old.id);
  equal(detailReads, 2);
  equal(await store.close(old.id, "done", "accepted"), false);
  deepStrictEqual(store.open.value, []);
});

Deno.test("a suspended collection cannot overwrite a newer accepted detail", async () => {
  let finish!: (snapshot: CasesSnapshot | null) => void;
  let collectionReads = 0;
  const old = parseCasesSnapshot({ systemId: "s", cases: [caseRecord(1)] });
  const closed = { ...old.cases[0], status: "closed-done" as const };
  const store = createCases({
    port: {
      read: () => {
        collectionReads++;
        return new Promise((resolve) => finish = resolve);
      },
      readOne: () => Promise.resolve(closed),
      close: () => Promise.resolve(),
      act: () => Promise.resolve(),
    },
  });
  const pending = store.refresh();
  await store.ensure(closed.id);
  finish(old);
  await Promise.resolve();
  equal(collectionReads, 2);
  equal(store.byId(closed.id)?.status, "closed-done");
  deepStrictEqual(store.open.value, []);
  finish({ systemId: "s", cases: [] });
  await pending;
  equal(store.byId(closed.id)?.status, "closed-done");
  deepStrictEqual(store.open.value, []);
});

Deno.test("a detail accepted during startup does not strand the first collection read", async () => {
  let finish!: (snapshot: CasesSnapshot | null) => void;
  let collectionReads = 0;
  const old = parseCasesSnapshot({ systemId: "s", cases: [caseRecord(1)] });
  const current = parseCasesSnapshot({
    systemId: "s",
    cases: [caseRecord(1, { objective: "Current objective" }), caseRecord(3)],
  });
  const closed = parseCasesSnapshot({
    systemId: "s",
    cases: [caseRecord(2, { status: "closed-done" })],
  }).cases[0];
  const store = createCases({
    port: {
      read: () => {
        collectionReads++;
        return collectionReads === 1
          ? new Promise((resolve) => finish = resolve)
          : Promise.resolve(current);
      },
      readOne: () => Promise.resolve(closed),
      close: () => Promise.resolve(),
      act: () => Promise.resolve(),
    },
  });
  const pending = store.refresh();
  await store.ensure(closed.id);
  finish(old);
  await pending;
  equal(store.supported.value, true);
  equal(collectionReads, 2);
  equal(store.byId("ui-fixture:case:1")?.objective, "Current objective");
  deepStrictEqual(store.open.value.map((entry) => entry.number), [1, 3]);
  equal(store.byId(closed.id)?.status, "closed-done");
});

Deno.test("closing a Case outside the collection refreshes its cached detail", async () => {
  const paths: string[] = [];
  let closed = false;
  const store = createCases({
    port: createCasesApi((path, init) => {
      paths.push(path);
      if (init?.method === "POST") {
        closed = true;
        return Promise.resolve(Response.json({ closed: true }));
      }
      return Promise.resolve(
        Response.json(
          path === "/api/cases"
            ? { systemId: "s", cases: [] }
            : caseRecord(1, { status: closed ? "closed-done" : "open" }),
        ),
      );
    }),
  });
  await store.ensure("ui-fixture:case:1");
  equal(await store.close("ui-fixture:case:1", "done", "accepted"), true);
  equal(store.byId("ui-fixture:case:1")?.status, "closed-done");
  equal(await store.close("ui-fixture:case:1", "done", "accepted"), false);
  deepStrictEqual(paths, [
    "/api/cases/ui-fixture%3Acase%3A1",
    "/api/cases/ui-fixture%3Acase%3A1/close",
    "/api/cases",
    "/api/cases/ui-fixture%3Acase%3A1",
  ]);
});

Deno.test("a cached detail retains the latest SSE status when the collection later omits it", async () => {
  const store = createCases({
    port: createCasesApi(() => Promise.resolve(Response.json(caseRecord(1)))),
  });
  await store.ensure("ui-fixture:case:1");
  store.accept({
    systemId: "s",
    cases: [caseRecord(1, { status: "closed-done" })],
  });
  store.accept({ systemId: "s", cases: [] });
  equal(store.byId("ui-fixture:case:1")?.status, "closed-done");
});

Deno.test("an open detail omitted by a newer collection is reread on the same Case location", async () => {
  let closed = false;
  const store = createCases({
    port: createCasesApi(() =>
      Promise.resolve(Response.json(caseRecord(1, {
        status: closed ? "closed-done" : "open",
      })))
    ),
  });
  await store.ensure("ui-fixture:case:1");
  store.accept({ systemId: "s", cases: [] });
  equal(store.byId("ui-fixture:case:1"), null);
  closed = true;
  await store.ensure("ui-fixture:case:1");
  equal(store.byId("ui-fixture:case:1")?.status, "closed-done");
});

Deno.test("closing a case is one explicit local command, then a reread", async () => {
  const calls: Array<{ path: string; body?: string }> = [];
  let closed = false;
  const api = createCasesApi((path, init) => {
    calls.push({ path, body: init?.body as string | undefined });
    if (init?.method === "POST") {
      closed = true;
      return Promise.resolve(Response.json({ closed: true }));
    }
    return Promise.resolve(Response.json({
      systemId: "ui-fixture",
      cases: [
        closed
          ? caseRecord(1, {
            status: "closed-done",
            closedAt: "2026-10-24T12:00:00Z",
          })
          : caseRecord(1),
      ],
    }));
  });
  const store = createCases({ port: api });
  await store.refresh();
  equal(await store.close("ui-fixture:case:1", "done", "accepted"), true);
  deepStrictEqual(calls.map((call) => call.path), [
    "/api/cases",
    "/api/cases/ui-fixture%3Acase%3A1/close",
    "/api/cases",
  ]);
  equal(
    calls[1].body,
    JSON.stringify({ outcome: "done", verdict: "accepted" }),
  );
  deepStrictEqual(store.open.value, []);
  // A closed case cannot be closed again.
  equal(await store.close("ui-fixture:case:1", "done", "accepted"), false);
  equal(calls.length, 3);
});

Deno.test("job and watch details are read when present, strictly", () => {
  const snapshot = parseCasesSnapshot({
    systemId: "ui-fixture",
    cases: [jobRecord(), watchRecord()],
  });
  equal(snapshot.cases[0].job?.steps[2].judgment?.options.length, 2);
  equal(snapshot.cases[0].job?.schedule, "1st of the month, 09:00");
  equal(snapshot.cases[1].watch?.wakes.length, 6);
  // A Request never carries Job details, even when sent.
  equal(
    parseCasesSnapshot({
      systemId: "s",
      cases: [caseRecord(1, { job: { steps: [], runs: [] } })],
    }).cases[0].job,
    undefined,
  );
  deepStrictEqual(
    parseCasesSnapshot({
      systemId: "s",
      cases: [
        caseRecord(1, { type: "job", job: { steps: [{ id: "x" }], runs: [] } }),
      ],
    }).cases,
    [],
  );
  deepStrictEqual(
    parseCasesSnapshot({
      systemId: "s",
      cases: [
        caseRecord(1, {
          type: "watch",
          watch: { state: "sleeping", wakes: [] },
        }),
      ],
    }).cases,
    [],
  );
});

Deno.test("wakes without change fold into one line between changes, newest first", () => {
  const wakes = parseCasesSnapshot({
    systemId: "s",
    cases: [watchRecord()],
  }).cases[0].watch!.wakes;
  deepStrictEqual(
    groupWakes(wakes).map((group) =>
      group.kind === "change" ? group.wake.summary : group.count
    ),
    [3, "2 new offers", 2],
  );
});

Deno.test("the central agent in a few words", () => {
  const openCase = {
    objective: "Prepare the monthly report",
    status: "open" as const,
  };
  equal(
    agentActivity({ busy: true, openCase, decisionWaiting: false }),
    "Working on Prepare the monthly report",
  );
  equal(
    agentActivity({ busy: true, openCase: null, decisionWaiting: false }),
    "Working",
  );
  equal(
    agentActivity({ busy: false, openCase, decisionWaiting: false }),
    "Waiting for you",
  );
  equal(
    agentActivity({ busy: false, openCase: null, decisionWaiting: true }),
    "Waiting for you",
  );
  equal(
    agentActivity({ busy: false, openCase: null, decisionWaiting: false }),
    "Idle",
  );
});

Deno.test("a Case is named by what was asked, not by its number", () => {
  equal(
    caseTitle({
      objective:
        "Can you list three name ideas for a small coffee shop, with a reason?",
    }),
    "List three name ideas for a small coffee shop,…",
  );
  equal(
    caseTitle({ objective: "Bonjour, peux-tu résumer ce PDF ?" }),
    "Résumer ce PDF",
  );
  equal(
    caseTitle({ objective: "Watch the price.\nThen tell me." }),
    "Watch the price",
  );
  equal(caseTitle({ objective: "  " }), "Untitled");
});

Deno.test("a closed Request stays in reach for a day, oldest closure first", () => {
  const now = Date.parse("2026-10-24T12:00:00.000Z");
  const store = createCases({ now: () => now });
  store.accept({
    systemId: "ui-fixture",
    cases: [
      caseRecord(1, {
        status: "closed-done",
        createdAt: "2026-10-22T10:00:00.000Z",
        closedAt: "2026-10-23T11:00:00.000Z",
      }),
      caseRecord(2, {
        status: "closed-done",
        createdAt: "2026-10-22T10:00:00.000Z",
        closedAt: "2026-10-24T09:00:00.000Z",
      }),
      caseRecord(3, {
        status: "closed-abandoned",
        createdAt: "2026-10-22T10:00:00.000Z",
        closedAt: "2026-10-24T08:00:00.000Z",
      }),
      caseRecord(4),
    ],
  });
  deepStrictEqual(store.recentlyClosed.value.map((entry) => entry.number), [
    3,
    2,
  ]);
  deepStrictEqual(store.open.value.map((entry) => entry.number), [4]);
});

Deno.test("a closed Request leaves the Dock when the desk clock passes a day", () => {
  let at = Date.parse("2026-10-24T12:00:00.000Z");
  const store = createCases({ now: () => at });
  store.accept({
    systemId: "ui-fixture",
    cases: [caseRecord(2, {
      status: "closed-done",
      createdAt: "2026-10-24T09:00:00.000Z",
      closedAt: "2026-10-24T11:00:00.000Z",
    })],
  });
  equal(store.recentlyClosed.value.length, 1);
  at = Date.parse("2026-10-25T11:30:00.000Z");
  store.tick();
  equal(store.recentlyClosed.value.length, 0);
});

Deno.test("Job and Watch actions post to their route, then reread the Cases", async () => {
  const posts: string[] = [];
  const api = createCasesApi((path, init) => {
    if (init?.method === "POST") posts.push(`${path} ${init.body}`);
    return Promise.resolve(
      new Response(
        JSON.stringify(
          init?.method === "POST"
            ? { ok: true }
            : { systemId: "ui-fixture", cases: [jobRecord(7)] },
        ),
        { status: 200 },
      ),
    );
  });
  const store = createCases({ port: api });
  await store.refresh();
  equal(await store.act("ui-fixture:case:7", "run"), true);
  deepStrictEqual(posts, ["/api/cases/ui-fixture%3Acase%3A7/run {}"]);
  equal(store.acting.value, null);
});

Deno.test("an opener does not swallow the subject of the request", () => {
  equal(
    caseTitle({ objective: "Bonjour ! Peux-tu résumer le rapport ?" }),
    "Résumer le rapport",
  );
});

Deno.test("Case readout parses static initial refusal separately from open lifecycle and rejects invented outcome payloads", () => {
  const read = parseCasesSnapshot({
    systemId: "host",
    cases: [
      caseRecord(1, { status: "waiting", initialExecutionOutcome: "refused" }),
    ],
  });
  equal(read.cases[0].initialExecutionOutcome, "refused");
  equal(read.cases[0].status, "waiting");
  equal(isOpenCase(read.cases[0]), true);
  for (
    const invalid of [
      ...["failed", { message: "PRIVATE" }, 1, null].map((outcome) => ({
        initialExecutionOutcome: outcome,
      })),
      { status: "closed-done", initialExecutionOutcome: "refused" },
    ]
  ) {
    const parsed = parseCasesSnapshot({
      systemId: "host",
      cases: [caseRecord(1, invalid), caseRecord(2)],
    });
    deepStrictEqual(parsed.cases.map((entry) => entry.number), [2]);
  }
});

Deno.test("older Case dates use the same UTC day as version labels", () => {
  equal(
    since("2026-11-03T23:30:00-04:00", Date.parse("2026-11-12T12:00:00Z")),
    "4 Nov",
  );
});

Deno.test("a slower Case detail applies after another Case completes without rereading either", async () => {
  const initial = parseCasesSnapshot({
    systemId: "s",
    cases: [caseRecord(1), caseRecord(2)],
  });
  const [a, b] = initial.cases;
  const gates = new Map(
    initial.cases.map((
      entry,
    ) => [entry.id, Promise.withResolvers<CaseRecord>()]),
  );
  const reads = new Map<string, number>();
  const store = createCases({
    port: {
      read: () => Promise.reject(new Error("Unexpected collection read")),
      readOne(id) {
        const count = (reads.get(id) ?? 0) + 1;
        reads.set(id, count);
        if (count > 1) {
          return Promise.reject(new Error("Unexpected repeated detail read"));
        }
        return gates.get(id)!.promise;
      },
      close: () => Promise.resolve(),
      act: () => Promise.resolve(),
    },
  });
  store.accept(initial);
  const left = store.refreshOne(a.id);
  const right = store.refreshOne(b.id);
  gates.get(b.id)!.resolve({ ...b, status: "waiting" });
  await right;
  gates.get(a.id)!.resolve({ ...a, objective: "Current A" });
  await left;
  equal(store.byId(a.id)?.objective, "Current A");
  equal(store.byId(b.id)?.status, "waiting");
  deepStrictEqual([...reads], [[a.id, 1], [b.id, 1]]);
  store.dispose();
});
