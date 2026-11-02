import { replaceGlobals } from "../../../test/support/globals.ts";
import { settle } from "../../../test/support/settle.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { act } from "preact/test-utils";
import type {
  RevisionLocation,
  RuntimeOperator,
} from "../../../lib/model/revisions/api.ts";
import { localSources } from "../../../lib/model/sources/command.ts";
import type { ModelLive } from "../../../lib/model/live.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { modelFeed } from "../../../test/support/model-feed.ts";
import {
  DESIGNER,
  designer,
  HEAD,
  modelHost,
  operators,
  PARENT,
  PROPOSED,
  REVIEWER,
  reviewer,
  ROOT,
  runtimes,
} from "../../../test/support/revision-fixture.ts";
import {
  type RevisionsPageProps,
  useRevisionsPage,
} from "./useRevisionsPage.ts";

/**
 * The page's own lifecycle, against a fake host and Preact's real hooks. The
 * probe renders no nodes (as in lib/revision-location_test.ts): what is under
 * test is what the page reads, when, and what it would draw first.
 */
async function mount(
  search: string,
  options: {
    host?: ReturnType<typeof modelHost>;
    location?: RevisionLocation;
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
  /** What every pass of the page decided to draw: the list and the revision. */
  const passes: { tab: string; shown: string | undefined }[] = [];
  let page!: ReturnType<typeof useRevisionsPage>;
  function Probe(props: RevisionsPageProps) {
    page = useRevisionsPage(props);
    passes.push({ tab: page.tab, shown: page.shown?.selection.id });
    return null;
  }
  const show = (
    next: string,
    shownOn: RevisionLocation | undefined = undefined,
    revisionKey = options.revisionKey,
    operators = options.operators,
  ) =>
    root.show(Probe, {
      location: shownOn ?? { search: next },
      sources,
      onChanged: () => {},
      revisionKey,
      operators,
      live: options.live,
    });
  const paths = () =>
    host.requests.map((entry) => {
      const url = new URL(entry.path, "http://host.test");
      return url.pathname +
        (url.searchParams.get("to") ? `?to=${url.searchParams.get("to")}` : "");
    });
  const restore = async () => {
    await root.unmount();
    restoreFetch();
    await root.restore();
  };
  await show(search, options.location);
  return {
    host,
    sources,
    passes,
    page: () => page,
    show,
    settle,
    paths,
    unmount: root.unmount,
    restore,
  };
}

Deno.test("a mount reads the history once, then the changes of the revision it shows, and nothing more", async () => {
  const run = await mount("?proposal=p-open");
  try {
    await run.settle();
    deepStrictEqual(run.paths().sort(), [
      "/api/model-diff?to=" + PROPOSED,
      "/api/model-history",
      "/api/model-revisions",
    ]);
    equal(run.page().view?.id, "p-open");
    equal(run.page().diff?.status, "ready");
    // Drawn again with the same address: nothing is read again.
    await run.show("?proposal=p-open");
    await run.settle();
    equal(run.host.requests.length, 3);
  } finally {
    await run.restore();
  }
});

Deno.test("the page reads the search of its address, whichever path reached the Model place", async () => {
  const run = await mount("", {
    location: {
      pathname: "/model",
      search: "?commit=" + encodeURIComponent(PARENT),
    },
  });
  try {
    await run.settle();
    equal(run.page().snapshot?.revisions.version, HEAD);
    equal(run.page().tab, "commit");
    equal(run.page().shown?.selection.id, PARENT);
    equal(run.page().view?.title, "Add the reader");
  } finally {
    await run.restore();
  }
});

Deno.test("an address that moves to another kind of revision draws that revision in its first pass", async () => {
  const run = await mount("?proposal=p-open");
  try {
    await run.settle();
    equal(run.page().tab, "proposal");
    const before = run.passes.length;
    await run.show("?commit=" + encodeURIComponent(PARENT));
    const after = run.passes.slice(before);
    ok(after.length > 0);
    // Never the proposal's list, nor its revision, for a frame.
    for (const pass of after) {
      deepStrictEqual(pass, { tab: "commit", shown: PARENT });
    }
    await run.settle();
    equal(run.page().view?.title, "Add the reader");
    // And back to a proposal.
    const mark = run.passes.length;
    await run.show("?proposal=p-taken");
    for (const pass of run.passes.slice(mark)) {
      deepStrictEqual(pass, { tab: "proposal", shown: "p-taken" });
    }
  } finally {
    await run.restore();
  }
});

Deno.test("a list chosen by hand lasts while the address stays; the address wins when it moves", async () => {
  const run = await mount("?commit=" + encodeURIComponent(HEAD));
  try {
    await run.settle();
    await act(() => run.page().setTab("proposal"));
    equal(run.page().tab, "proposal");
    // The tab opens on the proposal waiting for a decision.
    equal(run.page().shown?.selection.id, "p-open");
    await run.show("?commit=" + encodeURIComponent(HEAD));
    equal(run.page().tab, "proposal");
    await run.show("?commit=" + encodeURIComponent(ROOT));
    equal(run.page().tab, "commit");
    equal(run.page().shown?.selection.id, ROOT);
  } finally {
    await run.restore();
  }
});

Deno.test("the history is read again when the runtime or a decision elsewhere moves it, and when the address names another revision", async () => {
  const run = await mount("?commit=" + encodeURIComponent(HEAD));
  try {
    await run.settle();
    const reads = () =>
      run.paths().filter((path) => path === "/api/model-history").length;
    equal(reads(), 1);
    await run.show("?commit=" + encodeURIComponent(HEAD), undefined, 2);
    await run.settle();
    equal(reads(), 2, "the runtime moved");
    await act(() => run.sources.invalidate());
    await run.settle();
    equal(reads(), 3, "a decision was made elsewhere");
    await run.show("?proposal=p-open", undefined, 2);
    await run.settle();
    equal(reads(), 4, "another revision is addressed");
    await run.show(
      "?proposal=p-open&from=" + encodeURIComponent(ROOT),
      undefined,
      2,
    );
    await run.settle();
    equal(reads(), 4, "a comparison parameter alone reads nothing");
  } finally {
    await run.restore();
  }
});

Deno.test("leaving the page lets the history go: a read still in flight is dropped", async () => {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => open = resolve);
  const run = await mount("", { host: modelHost({ gate }) });
  try {
    const page = run.page();
    equal(page.snapshot, undefined);
    await run.unmount();
    open();
    await run.settle();
    equal(page.history.snapshot.peek(), undefined);
    // Nor were the changes asked for: nothing was shown to ask them for.
    equal(
      run.paths().filter((path) => path.startsWith("/api/model-diff")).length,
      0,
    );
  } finally {
    await run.restore();
  }
});

const served = () => modelHost({ runtimes: runtimes(), primary: DESIGNER });
const asked = (run: { host: ReturnType<typeof modelHost> }) =>
  run.host.requests.filter((entry) => entry.path.includes("agentId")).map((
    entry,
  ) => decodeURIComponent(entry.path.split("agentId=")[1]));

Deno.test("each operator is asked what it runs with the history, and the page offers the model to those behind", async () => {
  const run = await mount("", {
    host: served(),
    operators,
  });
  try {
    await run.settle();
    // The history answers for the designer; only the reviewer is asked.
    deepStrictEqual(asked(run), [REVIEWER]);
    deepStrictEqual(run.page().running, [
      { name: "Designer", version: PARENT },
      { name: "Reviewer", version: HEAD },
    ]);
    deepStrictEqual(
      run.page().offers.map((offer) => offer.operator.nativeId),
      [DESIGNER],
    );
    deepStrictEqual(run.page().unread, []);
    // Drawn again with the same operators: nobody is asked again.
    await run.show("");
    await run.settle();
    deepStrictEqual(asked(run), [REVIEWER]);
  } finally {
    await run.restore();
  }
});

Deno.test("the operator picked is kept by the page while the address moves", async () => {
  const run = await mount("", {
    host: served(),
    operators,
  });
  try {
    await run.settle();
    equal(run.page().chosen, undefined);
    await act(() => run.page().chooseOperator(REVIEWER));
    equal(run.page().chosen, REVIEWER);
    // The address moves, the choice stays.
    await run.show("?proposal=p-open");
    equal(run.page().chosen, REVIEWER);
  } finally {
    await run.restore();
  }
});

Deno.test("the page says when an operator is running, and stops saying it when it has finished", async () => {
  const run = await mount("", { host: served(), operators });
  try {
    await run.settle();
    equal(run.page().idle, true);
    await run.show("", undefined, undefined, [
      designer,
      { ...reviewer, busy: true },
    ]);
    equal(run.page().idle, false);
    await run.show("", undefined, undefined, [designer, reviewer]);
    equal(run.page().idle, true);
    // The same operators, running or not: nobody is asked what they run again.
    deepStrictEqual(asked(run), [REVIEWER]);
  } finally {
    await run.restore();
  }
});

Deno.test("a roster that arrives after the page is asked what it runs, once", async () => {
  const run = await mount("", { host: served() });
  try {
    await run.settle();
    deepStrictEqual(asked(run), []);
    deepStrictEqual(run.page().offers, []);
    const reads = () =>
      run.paths().filter((path) => path === "/api/model-history").length;
    equal(reads(), 1);
    await run.show("", undefined, undefined, operators);
    await run.settle();
    equal(reads(), 2, "the history is read again with the roster");
    deepStrictEqual(asked(run), [REVIEWER]);
    deepStrictEqual(
      run.page().offers.map((offer) => offer.operator.nativeId),
      [DESIGNER],
    );
    // The same roster in a new array reads nothing.
    await run.show("", undefined, undefined, [...operators]);
    await run.settle();
    equal(reads(), 2);
  } finally {
    await run.restore();
  }
});

Deno.test("a commit that is the version of a proposal opens that proposal, on the Proposals list, once the history says so", async () => {
  const run = await mount(`?commit=${encodeURIComponent(PROPOSED)}`);
  try {
    await run.settle();
    // The history lists the proposal that made this version: it is that one.
    equal(run.page().tab, "proposal");
    equal(run.page().shown?.selection.kind, "proposal");
    equal(run.page().view?.kind, "proposal");
    equal(run.page().view?.target, PROPOSED);
    // Before the history was read nothing was known of it: nothing is shown.
    deepStrictEqual(run.passes[0], { tab: "commit", shown: undefined });
    // The Commits list can still be chosen by hand; the history is not read again.
    await act(() => run.page().setTab("commit"));
    equal(run.page().tab, "commit");
    await run.settle();
    equal(
      run.paths().filter((path) => path === "/api/model-history").length,
      1,
    );
  } finally {
    await run.restore();
  }
});

Deno.test("a commit main has stays a commit, whatever the proposals say of its version", async () => {
  const run = await mount(`?commit=${encodeURIComponent(PARENT)}`);
  try {
    await run.settle();
    equal(run.page().tab, "commit");
    equal(run.page().view?.kind, "commit");
    equal(run.page().view?.id, PARENT);
  } finally {
    await run.restore();
  }
});

Deno.test("the host's word that the model moved reads the history again", async () => {
  const { live, tell } = modelFeed();
  const run = await mount("?page=revisions", { live });
  try {
    await run.settle();
    const reads = () =>
      run.paths().filter((path) => path === "/api/model-history").length;
    equal(reads(), 1);
    tell(HEAD);
    await run.settle();
    equal(reads(), 2, "one announcement, one more read of the history");
    tell(HEAD);
    await run.settle();
    equal(reads(), 2, "the same announcement is not news");
    tell(HEAD, { pending: 1, digest: "journal-1" });
    await run.settle();
    equal(reads(), 3, "a proposal made appears");
  } finally {
    await run.restore();
  }
});

Deno.test("the initial admission reads no unused full patch; another commit still reads its diff", async () => {
  const run = await mount("?commit=" + encodeURIComponent(ROOT));
  try {
    await run.settle();
    equal(run.page().shown?.selection.id, ROOT);
    equal(run.page().diff, undefined);
    equal(
      run.paths().some((path) => path.startsWith("/api/model-diff")),
      false,
    );
    await run.show("?commit=" + encodeURIComponent(HEAD));
    await run.settle();
    ok(run.paths().some((path) => path === "/api/model-diff?to=" + HEAD));
    equal(run.page().diff?.status, "ready");
  } finally {
    await run.restore();
  }
});
