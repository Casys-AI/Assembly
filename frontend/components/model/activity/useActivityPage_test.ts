import { replaceGlobals } from "../../../test/support/globals.ts";
import { settle } from "../../../test/support/settle.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { act } from "preact/test-utils";
import type { RuntimeOperator } from "../../../lib/model/revisions/api.ts";
import { localSources } from "../../../lib/model/sources/command.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import type { ModelLive } from "../../../lib/model/live.ts";
import { modelFeed } from "../../../test/support/model-feed.ts";
import {
  commit,
  designer,
  HEAD,
  history,
  modelHost,
  operators,
  PARENT,
  PROPOSED,
  ROOT,
  runtimes,
} from "../../../test/support/revision-fixture.ts";
import { type ActivityPageProps, useActivityPage } from "./useActivityPage.ts";

/**
 * The page's own lifecycle, against a fake host and Preact's real hooks. The
 * probe renders no nodes (as in useRevisionsPage_test.ts): what is under test
 * is what the page reads, when, and what it would draw first.
 */
async function mount(
  options: {
    host?: ReturnType<typeof modelHost>;
    revisionKey?: number;
    operators?: readonly RuntimeOperator[];
    live?: ModelLive;
  } = {},
) {
  const host = options.host ?? modelHost();
  const root = probeRoot();
  // The page makes its own revision API: the one that answers is the host.
  const restoreFetch = replaceGlobals({ fetch: host.request });
  const sources = localSources();
  const changed: number[] = [];
  let page!: ReturnType<typeof useActivityPage>;
  function Probe(props: ActivityPageProps) {
    page = useActivityPage(props);
    return null;
  }
  const show = (
    revisionKey = options.revisionKey,
    names = options.operators,
  ) =>
    root.show(Probe, {
      sources,
      onChanged: () => {
        changed.push(sources.generation.peek());
      },
      revisionKey,
      operators: names,
      live: options.live,
    });
  const paths = () =>
    host.requests.map((entry) => {
      const url = new URL(entry.path, "http://host.test");
      return url.pathname +
        (url.searchParams.get("to") ? `?to=${url.searchParams.get("to")}` : "");
    });
  const reads = () => paths().filter((path) => path === "/api/model-history");
  const restore = async () => {
    await root.unmount();
    restoreFetch();
    await root.restore();
  };
  await show();
  return {
    host,
    sources,
    changed,
    page: () => page,
    show,
    settle,
    paths,
    reads,
    unmount: root.unmount,
    restore,
  };
}

Deno.test("a mount reads the history once and nothing else: no change is read until a line is opened", async () => {
  const run = await mount();
  try {
    await run.settle();
    deepStrictEqual(run.paths().sort(), [
      "/api/model-history",
      "/api/model-revisions",
    ]);
    equal(run.page().snapshot?.revisions.version, HEAD);
    equal(run.page().opened, null);
    equal(run.page().row, undefined);
    // Drawn again with the same props: nothing is read again.
    await run.show();
    await run.settle();
    equal(run.host.requests.length, 2);
  } finally {
    await run.restore();
  }
});

Deno.test("the feed does not ask the operators what they run, whatever the roster", async () => {
  const run = await mount({
    host: modelHost({
      runtimes: runtimes(),
      primary: "designer",
    }),
    operators,
  });
  try {
    await run.settle();
    deepStrictEqual(
      run.host.requests.map((entry) => entry.path).filter((path) =>
        path.includes("agentId")
      ),
      [],
    );
    // The roster still names the proposers.
    const open = run.page().groups[0].rows[1];
    equal(open.byline, "proposed by Designer");
    // A roster that arrives late reads nothing, and names them at once.
    await run.show(undefined, [designer]);
    await run.settle();
    equal(run.reads().length, 1);
  } finally {
    await run.restore();
  }
});

Deno.test("opening a line reads its change once; one line is open at a time and opening it again shuts it", async () => {
  const run = await mount();
  try {
    await run.settle();
    const diffs = () =>
      run.paths().filter((path) => path.startsWith("/api/model-diff"));
    await act(() => run.page().toggle(`commit:${HEAD}`));
    await run.settle();
    equal(run.page().opened, `commit:${HEAD}`);
    equal(run.page().view?.title, "Accept a proposal");
    equal(run.page().diff?.status, "ready");
    deepStrictEqual(diffs(), [`/api/model-diff?to=${HEAD}`]);
    // Another line opens, the first shuts.
    await act(() => run.page().toggle("proposal:p-open"));
    await run.settle();
    equal(run.page().opened, "proposal:p-open");
    equal(run.page().view?.id, "p-open");
    deepStrictEqual(diffs(), [
      `/api/model-diff?to=${HEAD}`,
      `/api/model-diff?to=${PROPOSED}`,
    ]);
    // The first, opened again, has its change already.
    await act(() => run.page().toggle(`commit:${HEAD}`));
    await run.settle();
    equal(run.page().diff?.status, "ready");
    equal(diffs().length, 2);
    // Opened a second time, a line shuts.
    await act(() => run.page().toggle(`commit:${HEAD}`));
    equal(run.page().opened, null);
    equal(run.page().view, undefined);
    equal(run.page().files, undefined);
  } finally {
    await run.restore();
  }
});

Deno.test("the files of an open line are Git's for a commit, and those of the change once read for a proposal", async () => {
  const run = await mount();
  try {
    await run.settle();
    await act(() => run.page().toggle("proposal:p-taken"));
    deepStrictEqual(
      run.page().files?.map((file) => file.path),
      ["configuration.sysml", "reader.sysml"],
    );
    await act(() => run.page().toggle("proposal:p-open"));
    await run.settle();
    deepStrictEqual(
      run.page().files?.map((file) => file.path),
      ["configuration.sysml"],
    );
  } finally {
    await run.restore();
  }
});

Deno.test("the initial commit, and a proposal still being prepared, have no change to read", async () => {
  const run = await mount();
  try {
    await run.settle();
    await act(() => run.page().toggle(`commit:${ROOT}`));
    await run.settle();
    equal(run.page().view?.title, "Admit the initial model");
    equal(run.page().diff, undefined);
    deepStrictEqual(
      run.page().files?.map((file) => file.path),
      ["configuration.sysml", "lib/units.sysml"],
    );
    await act(() => run.page().toggle("proposal:p-prepare"));
    await run.settle();
    equal(
      run.page().view?.notice,
      "The operator is still preparing this proposal.",
    );
    equal(run.page().diff, undefined);
    equal(
      run.paths().filter((path) => path.startsWith("/api/model-diff")).length,
      0,
    );
  } finally {
    await run.restore();
  }
});

Deno.test("a change that could not be read can be read again", async () => {
  let failing = true;
  const base = modelHost();
  const host = {
    ...base,
    request:
      (async (input: string | URL | Request, init?: RequestInit) =>
        failing && String(input).startsWith("/api/model-diff")
          ? Response.json({ error: "Too big." }, { status: 500 })
          : await base.request(input, init)) as typeof fetch,
  };
  const run = await mount({ host });
  try {
    await run.settle();
    await act(() => run.page().toggle(`commit:${HEAD}`));
    await run.settle();
    equal(run.page().diff?.status, "failed");
    failing = false;
    await act(() => run.page().retryDiff());
    await run.settle();
    equal(run.page().diff?.status, "ready");
  } finally {
    await run.restore();
  }
});

Deno.test("the history is read again when the runtime or a decision elsewhere moves it, and not when the page is only drawn again", async () => {
  const run = await mount();
  try {
    await run.settle();
    equal(run.reads().length, 1);
    await run.show(undefined);
    await run.settle();
    equal(run.reads().length, 1, "drawn again");
    await run.show(2);
    await run.settle();
    equal(run.reads().length, 2, "the runtime moved");
    await act(() => run.sources.invalidate());
    await run.settle();
    equal(run.reads().length, 3, "a decision was made elsewhere");
  } finally {
    await run.restore();
  }
});

Deno.test("accepting the open proposal decides it through the shared source state and tells the other views once", async () => {
  const run = await mount();
  try {
    await run.settle();
    await act(() => run.page().toggle("proposal:p-open"));
    await run.settle();
    await act(() => {
      run.page().decide("approve");
      // Pressed again while it is in flight: nothing more is sent.
      run.page().decide("approve");
    });
    await run.settle();
    deepStrictEqual(run.host.writes().map((write) => write.body), [{
      verdict: "approve",
      expectedVersion: HEAD,
      sourceDigest: "p-open-digest",
    }]);
    deepStrictEqual(run.changed, [1]);
    equal(run.sources.generation.peek(), 1);
  } finally {
    await run.restore();
  }
});

Deno.test("a commit, and a proposal that is not for deciding, cannot be decided from its line", async () => {
  const run = await mount();
  try {
    await run.settle();
    for (
      const key of [
        `commit:${HEAD}`,
        "proposal:p-prepare",
        "proposal:p-declined",
      ]
    ) {
      await act(() => run.page().toggle(key));
      await run.settle();
      await act(() => run.page().decide("approve"));
      await act(() => run.page().decide("refuse"));
    }
    equal(run.host.writes().length, 0);
  } finally {
    await run.restore();
  }
});

Deno.test("a line left open through its acceptance stays open, now as the commit that accepted it", async () => {
  // The host answers the decision as it would: p-open becomes a commit on main.
  const data = history();
  const NEW = `commit:${"9".repeat(40)}`;
  const host = modelHost({
    data,
    decision: () => {
      const accepted = data.revisions.proposals.find((entry) =>
        entry.id === "p-open"
      )!;
      accepted.status = "accepted";
      accepted.acceptedVersion = NEW;
      data.revisions.version = NEW;
      data.history.headVersion = NEW;
      data.history.commits.unshift(commit(
        NEW,
        HEAD,
        "local-owner",
        "Accept p-open: Add a ranking step",
        "2026-10-24T12:30:00Z",
        [],
        { proposalId: "p-open" },
      ));
      return Response.json({ accepted: true });
    },
  });
  const run = await mount({ host });
  try {
    await run.settle();
    await act(() => run.page().toggle("proposal:p-open"));
    await run.settle();
    equal(run.page().row?.selection.kind, "proposal");
    await act(() => run.page().decide("approve"));
    await run.settle();
    // Same line, same key: it is open, and it is the merged commit now.
    equal(run.page().opened, "proposal:p-open");
    equal(run.page().row?.key, "proposal:p-open");
    deepStrictEqual(run.page().row?.selection, { kind: "commit", id: NEW });
    equal(run.page().row?.state, "accepted");
    // No roster is given here: the proposer is an operator, not its identity.
    equal(run.page().row?.byline, "proposed by An operator, accepted by You");
    equal(run.page().view?.decidable, false);
    // And no longer among those that wait.
    deepStrictEqual(
      run.page().groups.find((group) => group.id === "waiting")?.rows.map((
        row,
      ) => row.key),
      ["proposal:p-prepare"],
    );
    ok(run.paths().includes(`/api/model-diff?to=${NEW}`));
  } finally {
    await run.restore();
  }
});

Deno.test("leaving the page lets the history go: a read still in flight is dropped", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => open = resolve);
  const run = await mount({ host: modelHost({ gate }) });
  try {
    const page = run.page();
    equal(page.snapshot, undefined);
    await run.unmount();
    open();
    await run.settle();
    equal(page.history.snapshot.peek(), undefined);
  } finally {
    await run.restore();
  }
});

Deno.test("a line open at the start is the one the page was given", async () => {
  const host = modelHost();
  const root = probeRoot();
  const restoreFetch = replaceGlobals({ fetch: host.request });
  let page!: ReturnType<typeof useActivityPage>;
  try {
    await root.show(function Probe(props: ActivityPageProps) {
      page = useActivityPage(props);
      return null;
    }, {
      sources: localSources(),
      onChanged: () => {},
      open: `commit:${PARENT}`,
    });
    equal(page.opened, `commit:${PARENT}`);
  } finally {
    await root.unmount();
    restoreFetch();
    await root.restore();
  }
});

Deno.test("the host's word that the model moved reads the history again, once for each announcement that is new", async () => {
  const { live, tell } = modelFeed();
  const run = await mount({ live });
  try {
    await run.settle();
    equal(run.reads().length, 1);
    // The host begins by saying where it stands, as a reader opens the place:
    // the history is read once more, and no more than that.
    tell(HEAD);
    await run.settle();
    equal(run.reads().length, 2);
    // The same announcement is not news.
    tell(HEAD);
    await run.settle();
    equal(run.reads().length, 2);
    // An agent proposes a change: the head is where it was, the journal is not.
    tell(HEAD, { pending: 1, digest: "journal-1" });
    await run.settle();
    equal(run.reads().length, 3);
    // Drawn again, the page follows no second time.
    await run.show();
    tell(HEAD, { pending: 0, digest: "journal-2" });
    await run.settle();
    equal(run.reads().length, 4);
    await run.unmount();
    tell(HEAD, { pending: 2, digest: "journal-3" });
    await run.settle();
    equal(run.reads().length, 4, "a page that is gone reads nothing");
  } finally {
    await run.restore();
  }
});
