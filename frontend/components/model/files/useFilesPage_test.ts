import { replaceGlobals } from "../../../test/support/globals.ts";
import { settle } from "../../../test/support/settle.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import type { ModelLive } from "../../../lib/model/live.ts";
import { modelFeed } from "../../../test/support/model-feed.ts";
import {
  HEAD,
  PARENT,
  ROOT,
  sourceTexts,
} from "../../../test/support/files-fixture.ts";
import {
  type HostGate,
  modelHost,
} from "../../../test/support/revision-fixture.ts";
import { type FilesPageProps, useFilesPage } from "./useFilesPage.ts";

/** A host that serves the revision fixture's history, files and sources. */
const filesHost = (options: { gate?: HostGate } = {}) =>
  modelHost({ gate: options.gate, files: { sources: sourceTexts() } });

/**
 * The page's own lifecycle, against a fake host and Preact's real hooks. The
 * probe renders no nodes (as in useRevisionsPage_test.ts): what is under test
 * is what the page reads, when, and what it would draw first.
 */
async function mount(
  search: string,
  options: {
    host?: ReturnType<typeof filesHost>;
    generation?: number;
    live?: ModelLive;
  } = {},
) {
  const host = options.host ?? filesHost();
  const root = probeRoot();
  // The page makes its own revision API: the one that answers is the host.
  const restoreFetch = replaceGlobals({ fetch: host.request });
  /** What every pass of the page decided to draw. */
  const passes: {
    listing: string;
    asked: string | undefined;
    file?: string;
  }[] = [];
  let page!: ReturnType<typeof useFilesPage>;
  function Probe(props: FilesPageProps) {
    page = useFilesPage(props);
    passes.push({
      listing: page.listing.status,
      asked: page.listing.asked,
      file: page.shown?.kind === "file" ? page.shown.entry.path : undefined,
    });
    return null;
  }
  const show = (next: string, generation = options.generation) =>
    root.show(Probe, {
      versionInfo: { source: { kind: "main" as const } },
      location: { search: next },
      generation,
      live: options.live,
    });
  const paths = () =>
    host.requests.map((entry) => {
      const url = new URL(entry.path, "http://host.test");
      return url.pathname +
        (url.searchParams.get("version")
          ? `@${url.searchParams.get("version")!.slice(7, 9)}`
          : "");
    });
  const restore = async () => {
    await root.unmount();
    restoreFetch();
    await root.restore();
  };
  await show(search);
  return {
    host,
    passes,
    page: () => page,
    show,
    settle,
    paths,
    unmount: root.unmount,
    restore,
  };
}

Deno.test("a mount reads the files of the head, then the sources of that version, and nothing more", async () => {
  const run = await mount("?page=files");
  try {
    await run.settle();
    deepStrictEqual(run.paths(), ["/api/model-files", "/api/model-sources@cc"]);
    // The sources are asked for by the version the head is at, not for the head.
    equal(run.page().version, HEAD);
    equal(run.page().text?.status, "ready");
    const shown = run.page().shown;
    ok(shown?.kind === "file");
    equal(shown.entry.path, "configuration.sysml");
    // Drawn again with the same address: nothing is read again.
    await run.show("?page=files");
    await run.settle();
    equal(run.host.requests.length, 2);
  } finally {
    await run.restore();
  }
});

Deno.test("moving from one file to another, or to a line, of the same version reads nothing", async () => {
  const run = await mount("?page=files&file=configuration.sysml");
  try {
    await run.settle();
    equal(run.host.requests.length, 2);
    await run.show("?page=files&file=lib%2Funits.sysml");
    await run.settle();
    const text = run.page().text;
    ok(text?.status === "ready");
    ok(text.text.startsWith("package Units"));
    await run.show("?page=files&file=lib%2Funits.sysml&line=2");
    await run.settle();
    equal(run.page().line, 2);
    equal(run.host.requests.length, 2);
    // A file the version lacks: absent, and no sources read for it.
    await run.show("?page=files&file=nope.sysml");
    await run.settle();
    equal(run.page().shown?.kind, "absent");
    equal(run.page().text, undefined);
    equal(run.host.requests.length, 2);
  } finally {
    await run.restore();
  }
});

Deno.test("another version is read once, and never drawn as the tree of the one before it", async () => {
  const run = await mount("?page=files");
  try {
    await run.settle();
    run.passes.length = 0;
    await run.show(`?page=files&version=${encodeURIComponent(ROOT)}`);
    await run.settle();
    // The first pass after the address moved has nothing to show yet.
    deepStrictEqual(run.passes[0], {
      listing: "reading",
      asked: ROOT,
      file: undefined,
    });
    equal(run.passes.at(-1)?.listing, "ready");
    equal(run.passes.at(-1)?.asked, ROOT);
    equal(run.page().groups.flatMap((group) => group.files).length, 2);
    deepStrictEqual(run.paths().slice(2), [
      "/api/model-files@aa",
      "/api/model-sources@aa",
    ]);
    // And back to the head: the sources it has are not read again.
    await run.show("?page=files");
    await run.settle();
    deepStrictEqual(run.paths().slice(4), ["/api/model-files"]);
    equal(run.page().version, HEAD);
  } finally {
    await run.restore();
  }
});

Deno.test("a decision anywhere moves the head, which is read again; a version named in the address never moves", async () => {
  const run = await mount("?page=files", { generation: 0 });
  try {
    await run.settle();
    equal(run.host.requests.length, 2);
    // Nothing moved: the same generation reads nothing.
    await run.show("?page=files", 0);
    await run.settle();
    equal(run.host.requests.length, 2);
    // A decision elsewhere: the files are read again, the head still the same,
    // so its sources are kept.
    await run.show("?page=files", 1);
    await run.settle();
    deepStrictEqual(run.paths().slice(2), ["/api/model-files"]);
    // An older version does not move with the head.
    await run.show(`?page=files&version=${encodeURIComponent(PARENT)}`, 1);
    await run.settle();
    const before = run.host.requests.length;
    await run.show(`?page=files&version=${encodeURIComponent(PARENT)}`, 2);
    await run.settle();
    equal(run.host.requests.length, before);
  } finally {
    await run.restore();
  }
});

Deno.test("an address that is not a version is refused by the host, and no sources are read for it", async () => {
  const run = await mount("?page=files&version=main");
  try {
    await run.settle();
    deepStrictEqual(run.paths(), ["/api/model-files@"]);
    const listing = run.page().listing;
    ok(listing.status === "failed");
    equal(listing.problem.code, "version-invalid");
    equal(listing.problem.status, 400);
    equal(run.page().shown, null);
  } finally {
    await run.restore();
  }
});

Deno.test("leaving the page lets the read go: nothing is stored from one still in flight", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const run = await mount("?page=files", { host: filesHost({ gate }) });
  try {
    const store = run.page().store;
    await run.unmount();
    release();
    await run.settle();
    equal(store.listing.value.status, "reading");
    // It asked for the files once and for no sources: it never knew a version.
    deepStrictEqual(run.paths(), ["/api/model-files"]);
  } finally {
    await run.restore();
  }
});

Deno.test("the host's word that the model moved reads the new head's files once, at its address", async () => {
  const { live, tell } = modelFeed();
  const run = await mount("?page=files", { live });
  try {
    await run.settle();
    deepStrictEqual(run.paths(), ["/api/model-files", "/api/model-sources@cc"]);
    // The host begins by saying where it stands: the page has that head.
    tell(HEAD);
    await run.settle();
    equal(run.host.requests.length, 2);
    // The model moved (an adoption, a proposal accepted in another window).
    tell(PARENT);
    await run.settle();
    deepStrictEqual(run.paths().slice(2), [
      "/api/model-files@bb",
      "/api/model-sources@bb",
    ]);
    equal(run.page().version, PARENT);
    equal(run.page().text?.status, "ready");
    equal(run.page().asked, undefined, "the page still follows the head");
    // A proposal made with the head where it is: nothing to read.
    tell(PARENT, { pending: 1, digest: "journal-1" });
    await run.settle();
    equal(run.host.requests.length, 4);
    await run.unmount();
    tell(HEAD, { pending: 0, digest: "journal-2" });
    await run.settle();
    equal(run.host.requests.length, 4, "a page that is gone reads nothing");
  } finally {
    await run.restore();
  }
});

Deno.test("the host's word that outruns the first read of the files waits for it: one listing, not an aborted one and a second", async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => release = resolve);
  const host = filesHost({
    gate: (path) => path === "/api/model-files" ? first : undefined,
  });
  const { live, tell } = modelFeed();
  const run = await mount("?page=files", { host, live });
  try {
    // The host's first word comes before the first answer does.
    tell(HEAD);
    await run.settle();
    deepStrictEqual(run.paths(), ["/api/model-files"]);
    release();
    await run.settle();
    deepStrictEqual(run.paths(), ["/api/model-files", "/api/model-sources@cc"]);
    equal(run.page().version, HEAD);
  } finally {
    await run.restore();
  }
});

Deno.test("a version the address names does not move with the head", async () => {
  const { live, tell } = modelFeed();
  const run = await mount(`?page=files&version=${encodeURIComponent(ROOT)}`, {
    live,
  });
  try {
    await run.settle();
    const reads = run.host.requests.length;
    tell(PARENT);
    await run.settle();
    equal(run.host.requests.length, reads);
    equal(run.page().version, ROOT);
  } finally {
    await run.restore();
  }
});
