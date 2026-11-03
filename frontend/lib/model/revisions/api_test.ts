import {
  createRevisionApi,
  problemOf,
  renderSourceDiff,
  requestFailure,
  resolveRevision,
  retainInspectedCommit,
  RevisionClientError,
  revisionComparisonAction,
  revisionInspectionHref,
  RevisionRequestError,
  type RevisionSnapshot,
  runtimeAdoption,
  selectedRevision,
  selectedRuntimeOperator,
  selectionBase,
  selectionTarget,
  type SourceCommit,
  type SourceProposal,
  synchronizeRevisionLocation,
  versionMessages,
  versionProblemOf,
} from "./api.ts";
import { PLACE_PATH } from "../../workbench/view-location.ts";
function assert(
  condition: unknown,
  detail = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(detail);
}
function equal(actual: unknown, expected: unknown) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}
const sourceDigest = "a".repeat(64);
const executableDigest = "b".repeat(64);
function commit(version: string, parentVersion?: string): SourceCommit {
  return {
    version,
    parentVersion,
    parents: parentVersion ? [parentVersion] : [],
    author: "local-control",
    message: version,
    createdAt: "2026-10-21T00:00:00Z",
    sourceDigest,
    parsedAuthor: { kind: "host", ref: "local-control" },
    files: [],
    additions: 0,
    deletions: 0,
  };
}
function fixture(version = "branch:head"): RevisionSnapshot {
  return {
    revisions: {
      version,
      sourceDigest,
      proposals: [],
      runtime: {
        active: null,
        available: { digest: executableDigest, repositoryVersion: version },
        executable: true,
      },
    },
    history: {
      headVersion: version,
      commits: [commit(version, "commit:parent")],
      truncated: false,
    },
  };
}
const asFetch = (
  request: (path: string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch =>
  ((path: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(request(String(path), init))) as typeof fetch;

Deno.test("revision snapshot reads source history, and accepts equivalent immutable prefixes", async () => {
  const data = fixture();
  data.history.headVersion = "commit:head";
  const requests: string[] = [];
  const api = createRevisionApi(asFetch((path, init) => {
    requests.push(path);
    equal(init?.cache, "no-store");
    return Response.json(
      path === "/api/model-revisions" ? data.revisions : data.history,
    );
  }));
  equal(await api.snapshot(), data);
  equal(requests.sort(), ["/api/model-history", "/api/model-revisions"]);
});

Deno.test("incoherent source snapshot fails after a read-only recheck", async () => {
  const data = fixture();
  data.history.headVersion = "commit:newer";
  let reads = 0;
  const api = createRevisionApi(asFetch((path, init) => {
    assert(!init?.method, "A consistency check must not write");
    if (path === "/api/model-revisions") reads++;
    return Response.json(
      path === "/api/model-revisions" ? data.revisions : data.history,
    );
  }));
  let failed = false;
  try {
    await api.snapshot();
  } catch (error) {
    failed = error instanceof RevisionClientError &&
      error.code === "history-moved";
  }
  assert(failed);
  equal(reads, 2);
});

Deno.test("source decision and runtime adoption preserve their distinct CAS contracts", async () => {
  const requests: { path: string; input: unknown }[] = [];
  const api = createRevisionApi(asFetch((path, init) => {
    equal(init?.method, "POST");
    equal(new Headers(init?.headers).get("content-type"), "application/json");
    requests.push({ path, input: JSON.parse(String(init?.body)) });
    return Response.json({ accepted: true, executionAdopted: false });
  }));
  await api.decide({
    id: "proposal/id",
    verdict: "approve",
    expectedVersion: "branch:examined",
    sourceDigest,
  });
  await api.decide({
    id: "proposal/id",
    verdict: "refuse",
    expectedVersion: "branch:examined",
    sourceDigest,
  });
  await api.adopt(executableDigest);
  equal(requests, [
    {
      path: "/api/model-revisions/proposal%2Fid/decision",
      input: {
        verdict: "approve",
        expectedVersion: "branch:examined",
        sourceDigest,
      },
    },
    {
      path: "/api/model-revisions/proposal%2Fid/decision",
      input: {
        verdict: "refuse",
        expectedVersion: "branch:examined",
        sourceDigest,
      },
    },
    {
      path: "/api/model-version/adopt",
      input: { expectedDigest: executableDigest },
    },
  ]);
});

Deno.test("a rejected CAS is surfaced once without automatic write or read retry", async () => {
  let calls = 0;
  const api = createRevisionApi(asFetch(() => {
    calls++;
    return Response.json({
      error: "Le modèle courant a changé ; rechargez avant de décider.",
    }, { status: 409 });
  }));
  let failure: unknown;
  try {
    await api.decide({
      id: "proposal",
      verdict: "approve",
      expectedVersion: "branch:old",
      sourceDigest,
    });
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof RevisionRequestError);
  equal(failure.status, 409);
  assert(failure.message.includes("rechargez"));
  equal(calls, 1);
});

Deno.test("revision writes cannot overlap, including decision followed by adoption", async () => {
  let finish!: (response: Response) => void;
  let calls = 0;
  const api = createRevisionApi(asFetch(() => {
    calls++;
    return new Promise<Response>((resolve) => {
      finish = resolve;
    });
  }));
  const pending = api.decide({
    id: "p",
    verdict: "approve",
    expectedVersion: "branch:examined",
    sourceDigest,
  });
  let rejected = false;
  try {
    await api.adopt(executableDigest);
  } catch (error) {
    rejected = error instanceof RevisionClientError &&
      error.code === "command-in-flight";
  }
  assert(rejected);
  equal(calls, 1);
  finish(Response.json({ accepted: true }));
  await pending;
});

Deno.test("historical inspection survives a refresh that moves the commit out of the recent list", () => {
  const before = fixture();
  const old = commit("commit:old", "commit:older");
  before.history.commits.push(old);
  const next = fixture("branch:new-head");
  next.history.truncated = true;
  const selection = { kind: "commit", id: "branch:old" } as const;
  const retained = retainInspectedCommit(next, before, selection);
  equal(selectedRevision(retained, selection), old);
  equal(retained.revisions.version, "branch:new-head");
  equal(selectionBase(selection, old), "commit:older");
  equal(selectionTarget(selection, old), "commit:old");
  equal(next.history.commits.length, 1); // The loaded history is not mutated.
});

Deno.test("proposal comparisons use their immutable source base and target, root comparisons use empty", () => {
  const proposal: SourceProposal = {
    id: "proposal",
    author: "agent",
    reason: "Proposal",
    baseVersion: "commit:base",
    proposalVersion: "commit:proposal",
    createdAt: "2026-10-21",
    status: "rejected",
    sourceDigest,
  };
  const selection = { kind: "proposal", id: proposal.id } as const;
  equal(selectionBase(selection, proposal), "commit:base");
  equal(selectionTarget(selection, proposal), "commit:proposal");
  equal(
    selectionBase({ kind: "commit", id: "commit:root" }, commit("commit:root")),
    "empty",
  );
});

Deno.test("diff requests encode source identities and preserve explicit comparison base", async () => {
  const requests: string[] = [];
  const api = createRevisionApi(asFetch((path) => {
    requests.push(path);
    return Response.json({ patch: "", files: [], additions: 0, deletions: 0 });
  }));
  await api.diff("commit:chosen", "branch:historical");
  equal(requests, [
    "/api/model-diff?from=commit%3Achosen&to=branch%3Ahistorical",
  ]);
});

Deno.test("revision query navigation restores the new commit and chosen base after reload or history navigation", () => {
  const initial = synchronizeRevisionLocation({}, {
    pathname: "/model",
    search: "?commit=commit%3AA&from=commit%3AparentA",
  }).inspection;
  const changed = {
    selection: { kind: "commit", id: "commit:B" } as const,
    base: "commit:C",
  };
  const href = revisionInspectionHref(changed);
  equal(href, "/model?commit=commit%3AB&from=commit%3AC");
  const nextUrl = new URL(href, "http://localhost");
  const reloaded = synchronizeRevisionLocation({}, {
    pathname: nextUrl.pathname,
    search: nextUrl.search,
  });
  equal(reloaded.inspection, changed);
  // The earlier address of the place is still the place.
  const backward = synchronizeRevisionLocation(changed, {
    pathname: "/revisions",
    search: "?commit=commit%3AA&from=commit%3AparentA",
  });
  equal(backward.inspection, initial);
});

Deno.test("proposal URLs preserve their exact id and base, replacing the previous commit query", () => {
  const proposal = {
    selection: { kind: "proposal", id: "proposal_2" } as const,
    base: "empty",
  };
  const href = revisionInspectionHref(proposal);
  equal(href, "/model?proposal=proposal_2&from=empty");
  const url = new URL(href, "http://localhost");
  equal(
    synchronizeRevisionLocation({}, {
      pathname: url.pathname,
      search: url.search,
    }).inspection,
    proposal,
  );
});

Deno.test("native GET submit records freshly selected form values in the action URL exactly once", () => {
  for (const kind of ["commit", "proposal"] as const) {
    const fields = new FormData();
    fields.set(kind, kind === "commit" ? "commit:B" : "proposal_2");
    fields.set("from", "commit:C");
    const action = new URL(
      revisionComparisonAction(fields),
      "http://localhost",
    );
    equal(action.pathname, "/model");
    equal(action.searchParams.getAll(kind), [
      kind === "commit" ? "commit:B" : "proposal_2",
    ]);
    equal(action.searchParams.getAll("from"), ["commit:C"]);
    fields.set("from", "empty");
    equal(
      new URL(revisionComparisonAction(fields), "http://localhost").searchParams
        .get("from"),
      "empty",
    );
    equal([...action.searchParams.keys()].length, 2);
  }
});

Deno.test("hidden revisions ignore other view URLs and restore their mounted inspection through the rail", () => {
  const inspection = {
    selection: { kind: "commit", id: "commit:B" } as const,
    base: "commit:C",
  };
  const hidden = synchronizeRevisionLocation(inspection, {
    pathname: "/system",
    search: "?select=other",
  });
  equal(hidden.inspection, inspection);
  const returned = synchronizeRevisionLocation(hidden.inspection, {
    pathname: "/model",
    search: "",
  });
  equal(returned.inspection, inspection);
  equal(
    revisionInspectionHref(returned.inspection),
    "/model?commit=commit%3AB&from=commit%3AC",
  );
});

Deno.test("pinned diff renderer escapes hostile source code and filenames in both modes", () => {
  const patch = [
    "diff --git a/<img src=x onerror=alert(1)>.sysml b/<img src=x onerror=alert(1)>.sysml",
    "--- a/<img src=x onerror=alert(1)>.sysml",
    "+++ b/<img src=x onerror=alert(1)>.sysml",
    "@@ -1 +1,2 @@",
    "-part before;",
    "+<script>globalThis.injected=true</script>",
    "+<img src=x onerror=alert(1)>",
    "",
  ].join("\n");
  for (const mode of ["line-by-line", "side-by-side"] as const) {
    const output = renderSourceDiff(patch, mode);
    assert(
      output.includes("d2h-wrapper"),
      "The established renderer must produce the diff",
    );
    assert(
      !output.includes("<script>"),
      "Source scripts must never become HTML",
    );
    assert(
      !output.includes("<img src=x"),
      "Source markup and filenames must never become HTML",
    );
    assert(
      output.includes("&lt;script&gt;"),
      "Escaped source remains inspectable",
    );
    assert(
      output.includes("&lt;img"),
      "Escaped hostile filename remains inspectable",
    );
  }
});

Deno.test("graph diff reads only the graph endpoint with immutable selected versions and cancellation", async () => {
  const controller = new AbortController();
  const requests: string[] = [];
  const api = createRevisionApi(asFetch((path, init) => {
    requests.push(path);
    equal(init?.cache, "no-store");
    equal(init?.signal, controller.signal);
    assert(!init?.method, "Graph inspection must not write");
    return Response.json({
      fromVersion: null,
      toVersion: "commit:historical",
      engine: "Git",
      changes: [],
      counts: { added: 0, removed: 0, changed: 0 },
      truncated: false,
    });
  }));
  const result = await api.graphDiff(
    "empty",
    "branch:historical",
    controller.signal,
  );
  equal(result.fromVersion, null);
  equal(requests, ["/api/model-graph-diff?from=empty&to=branch%3Ahistorical"]);
});
Deno.test("graph diff accepts Git without relaxing selected-version checks", async () => {
  const payload = {
    fromVersion: "commit:base",
    toVersion: "commit:target",
    engine: "Git",
    changes: [],
    counts: { added: 0, removed: 0, changed: 0 },
    truncated: false,
  };
  const api = createRevisionApi(asFetch(() => Response.json(payload)));
  equal((await api.graphDiff("commit:base", "commit:target")).engine, "Git");
  const wrong = createRevisionApi(
    asFetch(() => Response.json({ ...payload, toVersion: "commit:other" })),
  );
  let rejected = false;
  try {
    await wrong.graphDiff("commit:base", "commit:target");
  } catch {
    rejected = true;
  }
  assert(rejected);
});
Deno.test("graph diff rejects another version's response and preserves endpoint errors without retries", async () => {
  for (
    const mismatch of [{
      fromVersion: "commit:wrong",
      toVersion: "commit:target",
    }, { fromVersion: "commit:base", toVersion: "commit:wrong" }]
  ) {
    const api = createRevisionApi(
      asFetch(() => Response.json({ engine: "Git", ...mismatch })),
    );
    let failed = false;
    try {
      await api.graphDiff("commit:base", "commit:target");
    } catch (error) {
      failed = error instanceof RevisionClientError &&
        error.code === "comparison-mismatch";
    }
    assert(failed);
  }
  let reads = 0;
  const api = createRevisionApi(asFetch(() => {
    reads++;
    return Response.json({ error: "Version TerminusDB indisponible" }, {
      status: 404,
    });
  }));
  let failure: unknown;
  try {
    await api.graphDiff("commit:base", "commit:target");
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof RevisionRequestError);
  equal(failure.status, 404);
  equal(failure.message, "Version TerminusDB indisponible");
  equal(reads, 1);
});

Deno.test("operator runtime inspection reads the exact native identity, preserves cancellation, and cannot replace global history", async () => {
  const nativeId = "native:operator/one?exact";
  const controller = new AbortController();
  const requests: string[] = [];
  const revisions = { ...fixture().revisions, agentId: nativeId };
  const api = createRevisionApi(asFetch((path, init) => {
    requests.push(path);
    equal(init?.signal, controller.signal);
    equal(init?.cache, "no-store");
    assert(!init?.method);
    return Response.json(revisions);
  }));
  equal(await api.runtime(nativeId, controller.signal), {
    agentId: nativeId,
    version: revisions.version,
    runtime: revisions.runtime,
  });
  equal(requests, [
    "/api/model-revisions?agentId=native%3Aoperator%2Fone%3Fexact",
  ]);
});
Deno.test("operator runtime responses cannot be mistaken for a different selected operator", async () => {
  const api = createRevisionApi(
    asFetch(() =>
      Response.json({ ...fixture().revisions, agentId: "primary" })
    ),
  );
  let rejected = false;
  try {
    await api.runtime("other");
  } catch (error) {
    rejected = error instanceof RevisionClientError &&
      error.code === "contract-mismatch";
  }
  assert(rejected);
});
Deno.test("explicit adoption pins the inspected operator digest and repository version, while source decisions remain global", async () => {
  const requests: { path: string; input: unknown }[] = [];
  const api = createRevisionApi(asFetch((path, init) => {
    requests.push({ path, input: JSON.parse(String(init?.body)) });
    return Response.json({ accepted: true });
  }));
  const runtime = fixture().revisions.runtime;
  const adoption = runtimeAdoption("native:worker", runtime);
  assert(adoption);
  const { expectedDigest, ...target } = adoption;
  await api.adopt(expectedDigest, target);
  await api.decide({
    id: "proposal",
    verdict: "approve",
    expectedVersion: "commit:source",
    sourceDigest,
  });
  equal(requests, [
    {
      path: "/api/model-version/adopt",
      input: {
        expectedDigest: executableDigest,
        agentId: "native:worker",
        expectedVersion: "branch:head",
      },
    },
    {
      path: "/api/model-revisions/proposal/decision",
      input: {
        verdict: "approve",
        expectedVersion: "commit:source",
        sourceDigest,
      },
    },
  ]);
});
Deno.test("operator selection never falls back silently, and incomplete or already admitted contracts cannot be adopted", () => {
  const operators = [{ nativeId: "primary", name: "Primary", primary: true }, {
    nativeId: "worker",
    name: "Worker",
    primary: false,
  }];
  equal(selectedRuntimeOperator(operators)?.nativeId, "primary");
  equal(selectedRuntimeOperator(operators, "worker")?.nativeId, "worker");
  equal(selectedRuntimeOperator(operators.slice(0, 1), "worker"), undefined);
  const runtime = fixture().revisions.runtime;
  runtime.available!.repositoryVersion = undefined;
  equal(runtimeAdoption("worker", runtime), undefined);
  runtime.available!.repositoryVersion = "commit:available";
  runtime.active = runtime.available;
  equal(runtimeAdoption("worker", runtime), undefined);
  runtime.active = null;
  runtime.executable = false;
  equal(runtimeAdoption("worker", runtime), undefined);
});

Deno.test("revision addresses are built from the Model place: the Revisions page, a revision, an empty base dropped", () => {
  // The bare place opens Activity: the Revisions page is named.
  equal(revisionInspectionHref({}), `${PLACE_PATH.model}?page=revisions`);
  equal(
    revisionInspectionHref({
      selection: { kind: "proposal", id: "p 1" },
      base: "",
    }),
    "/model?proposal=p+1",
  );
  const fields = new FormData();
  fields.set("commit", "commit:x");
  equal(
    revisionComparisonAction(fields),
    `${PLACE_PATH.model}?commit=commit%3Ax`,
  );
});

Deno.test("a host failure that says nothing is told in English, with its status", async () => {
  const api = createRevisionApi(
    asFetch(() => Response.json({}, { status: 500 })),
  );
  let failure: unknown;
  try {
    await api.diff("commit:a", "commit:b");
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof RevisionRequestError);
  equal(failure.status, 500);
  equal(failure.message, "The request failed.");
});

const HEAD_ID = `commit:${"c".repeat(40)}`;
const change = {
  version: `commit:${"b".repeat(40)}`,
  createdAt: "2026-10-23T10:30:00Z",
  message: "Add the reader",
};

Deno.test("files read the head fresh, and a version the browser may keep", async () => {
  const seen: { path: string; cache?: string }[] = [];
  const api = createRevisionApi(asFetch((path, init) => {
    seen.push({ path, cache: init?.cache });
    return Response.json({
      version: HEAD_ID,
      files: [{ path: "a.sysml", lastChange: change }],
    });
  }));
  equal((await api.files()).files[0].path, "a.sysml");
  await api.files(HEAD_ID);
  equal(seen, [
    { path: "/api/model-files", cache: "no-store" },
    {
      path: `/api/model-files?version=${encodeURIComponent(HEAD_ID)}`,
      cache: "default",
    },
  ]);
});

Deno.test("files and sources refuse an answer for another version or in another form, with a code", async () => {
  const code = async (read: () => Promise<unknown>) => {
    try {
      await read();
    } catch (failure) {
      assert(failure instanceof RevisionClientError);
      return failure.code;
    }
    return "answered";
  };
  const answering = (body: unknown) =>
    createRevisionApi(asFetch(() => Response.json(body)));
  // The version asked for is the one answered.
  equal(
    await code(() =>
      answering({ version: `commit:${"d".repeat(40)}`, files: [] }).files(
        HEAD_ID,
      )
    ),
    "version-mismatch",
  );
  equal(
    await code(() =>
      answering({ version: "commit:other", sourceDigest: "x", sources: {} })
        .sources(HEAD_ID)
    ),
    "version-mismatch",
  );
  // The shape the page reads: a list of files with their last change, texts.
  for (
    const body of [
      null,
      { version: HEAD_ID },
      { version: HEAD_ID, files: {} },
      { version: HEAD_ID, files: [{ path: "a.sysml" }] },
      {
        version: HEAD_ID,
        files: [{ path: "a.sysml", lastChange: { version: 1 } }],
      },
    ]
  ) {
    equal(await code(() => answering(body).files()), "unexpected-response");
  }
  for (
    const body of [
      { version: HEAD_ID, sourceDigest: "x" },
      { version: HEAD_ID, sources: ["a"] },
      { version: HEAD_ID, sources: { "a.sysml": 3 } },
    ]
  ) {
    equal(
      await code(() => answering(body).sources(HEAD_ID)),
      "unexpected-response",
    );
  }
  equal(
    await code(() =>
      answering({
        version: HEAD_ID,
        sourceDigest: "x",
        sources: { "a.sysml": "text" },
      })
        .sources(HEAD_ID)
    ),
    "answered",
  );
});

Deno.test("sources are read for one immutable version, and the host's versioned failure is told with its status", async () => {
  const seen: string[] = [];
  const api = createRevisionApi(asFetch((path) => {
    seen.push(path);
    return path.startsWith("/api/model-sources")
      ? Response.json({
        version: HEAD_ID,
        sourceDigest: "x",
        sources: { "a.sysml": "text" },
      })
      : Response.json(
        {
          code: "NOT_FOUND",
          context: { message: "Unknown model version" },
          recovery: "Reload file metadata from a valid model version.",
        },
        { status: 404 },
      );
  }));
  equal((await api.sources(HEAD_ID)).sources, { "a.sysml": "text" });
  equal(seen, [`/api/model-sources?version=${encodeURIComponent(HEAD_ID)}`]);
  let failure: unknown;
  try {
    await api.files(HEAD_ID);
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof RevisionRequestError);
  equal(failure.status, 404);
  // The versioned routes say it in `context.message`, the older ones in `error`.
  equal(failure.message, "Unknown model version");
});

Deno.test("the history is read at the host's usual length, or at the length asked for", async () => {
  const data = fixture();
  data.history.headVersion = "commit:head";
  const requests: string[] = [];
  const api = createRevisionApi(asFetch((path) => {
    requests.push(path);
    return Response.json(
      path === "/api/model-revisions" ? data.revisions : data.history,
    );
  }));
  await api.snapshot();
  await api.snapshot(undefined, { limit: 200 });
  equal(requests.filter((path) => path.startsWith("/api/model-history")), [
    "/api/model-history",
    "/api/model-history?limit=200",
  ]);
});

Deno.test("a commit that is the version of a proposal names that proposal; every other address is left as it was", () => {
  const data = fixture("commit:head");
  const made: SourceProposal = {
    id: "p-1",
    author: "agent:designer",
    reason: "Add a step",
    baseVersion: "commit:head",
    createdAt: "2026-10-21T00:00:00Z",
    status: "proposed",
    sourceDigest,
    proposalVersion: "commit:made",
  };
  data.revisions.proposals = [made];
  // Not on main, but the version a proposal made: the proposal.
  equal(resolveRevision(data, { kind: "commit", id: "commit:made" }), {
    kind: "proposal",
    id: "p-1",
  });
  // However it is written.
  equal(resolveRevision(data, { kind: "commit", id: "made" }), {
    kind: "proposal",
    id: "p-1",
  });
  // A commit main has stays a commit, even if a proposal claims the version.
  data.revisions.proposals = [{ ...made, proposalVersion: "commit:head" }];
  const head = { kind: "commit", id: "commit:head" } as const;
  assert(resolveRevision(data, head) === head);
  // Anything neither main nor a proposal has stays as it was named.
  data.revisions.proposals = [made];
  const gone = { kind: "commit", id: "commit:gone" } as const;
  assert(resolveRevision(data, gone) === gone);
  const proposal = { kind: "proposal", id: "p-1" } as const;
  assert(resolveRevision(data, proposal) === proposal);
  // A proposal still in the making has no version to be found by.
  data.revisions.proposals = [{ ...made, proposalVersion: undefined }];
  assert(
    resolveRevision(data, { kind: "commit", id: "commit:made" }).kind ===
      "commit",
  );
});

Deno.test("a failure is told as a coded problem: the page's own code and sentence, and what the host said", () => {
  equal(problemOf("read-failed", "It failed."), {
    code: "read-failed",
    message: "It failed.",
  });
  equal(
    problemOf(
      "read-failed",
      "It failed.",
      new RevisionRequestError("Down.", 503),
    ),
    {
      code: "read-failed",
      message: "It failed.",
      status: 503,
      detail: "Down.",
    },
  );
  // Whatever else went wrong says what it can, with no status to invent.
  equal(problemOf("read-failed", "It failed.", new TypeError("offline")), {
    code: "read-failed",
    message: "It failed.",
    detail: "offline",
  });
  equal(problemOf("read-failed", "It failed.", "text"), {
    code: "read-failed",
    message: "It failed.",
  });
});

Deno.test("a failed response is read once: the older routes' error, or the envelope's message, code, recovery and wait", () => {
  const answer = (status: number, wait?: string) => ({
    status,
    headers: new Headers(wait ? { "retry-after": wait } : {}),
  });
  // The older routes say `error`.
  const old = requestFailure(answer(409), { error: "Rechargez." });
  equal([old.message, old.status, old.code], ["Rechargez.", 409, undefined]);
  // The versioned ones, in their envelope; the wait is whole seconds.
  const envelope = requestFailure(answer(502, "3"), {
    code: "TOOLKIT_TIMEOUT",
    context: { message: "Too slow." },
    recovery: "Wait.",
  });
  equal(
    [envelope.message, envelope.code, envelope.recovery, envelope.retryAfter],
    ["Too slow.", "TOOLKIT_TIMEOUT", "Wait.", 3],
  );
  // What is not said is absent, never invented; blank is not said.
  const bare = requestFailure(answer(500, "soon"), {
    code: " ",
    context: { message: "" },
    recovery: 7,
  });
  equal(bare.message, "The request failed.");
  for (const name of ["code", "recovery", "retryAfter"] as const) {
    equal(name in bare && bare[name] !== undefined, false);
  }
  // Whatever is not an object is no envelope.
  for (const body of [undefined, null, "oops", [1], 3]) {
    const failure = requestFailure(answer(503), body);
    equal([failure.message, failure.status, failure.code], [
      "The request failed.",
      503,
      undefined,
    ]);
  }
});

Deno.test("a version is refused in two ways: not a commit's identity (400), no such commit (404); nothing else is about the version", () => {
  const failed = (status: number) => new RevisionRequestError("x", status);
  equal(versionProblemOf(failed(400)), "version-invalid");
  equal(versionProblemOf(failed(404)), "version-absent");
  for (const status of [401, 409, 500, 502, 503]) {
    equal(versionProblemOf(failed(status)), undefined);
  }
  equal(versionProblemOf(new TypeError("down")), undefined);
  equal(versionProblemOf(undefined), undefined);
  equal(Object.keys(versionMessages), ["version-invalid", "version-absent"]);
});

Deno.test("the revision client turns a versioned route's envelope into the error the pages read", async () => {
  const api = createRevisionApi(
    (() =>
      Promise.resolve(
        Response.json({
          code: "INVALID_VERSION",
          context: { message: "Not a commit." },
          recovery: "Pass commit:<sha>.",
        }, { status: 400 }),
      )) as typeof fetch,
  );
  let failure: unknown;
  try {
    await api.files("main");
  } catch (error) {
    failure = error;
  }
  assert(failure instanceof RevisionRequestError);
  equal(
    [failure.message, failure.status, failure.code, failure.recovery],
    ["Not a commit.", 400, "INVALID_VERSION", "Pass commit:<sha>."],
  );
  equal(versionProblemOf(failure), "version-invalid");
});
