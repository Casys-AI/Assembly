import { textOf } from "../../../test/support/dom.ts";
import { createSavedSystemsApi } from "../../../lib/system/saved-systems.ts";
import { ModelLinkContext } from "../../view/ModelContextLink.tsx";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
} from "node:assert/strict";
import { FilesPage } from "./FilesPage.tsx";
import { revealLine, revealTop } from "./FileBlob.tsx";
import {
  createModelFiles,
  MAX_SHOWN_LINES,
} from "../../../lib/model/sources/files.ts";
import { createRevisionApi } from "../../../lib/model/revisions/api.ts";
import { renderToString } from "preact-render-to-string";
import { press } from "../../../test/support/press.ts";
import {
  changed,
  history,
  type HostFiles,
  type HostGate,
  modelHost,
} from "../../../test/support/revision-fixture.ts";
import {
  HEAD,
  PARENT,
  ROOT,
  sourceTexts,
} from "../../../test/support/files-fixture.ts";
import { tidy } from "../../../test/support/markup.ts";

const NOW = Date.parse("2026-10-24T13:00:00Z");

/**
 * The model of the revision fixture with one more file, listed by the commit
 * of the head: the history says which commit last changed a file, so a file the
 * fixture's history does not list cannot be served.
 */
function adding(path: string, content: string) {
  const data = history();
  data.history.commits[0].files.push(changed(path, "added", 1, 0));
  const sources = sourceTexts();
  sources[HEAD][path] = content;
  return { data, sources };
}

/** The page over a host that serves the fixture, with what its effects read. */
async function open(
  search = "",
  options: {
    data?: ReturnType<typeof history>;
    sources?: Record<string, Record<string, string>>;
    gate?: HostGate;
    refuse?: HostFiles["refuse"];
    read?: boolean;
  } = {},
) {
  const host = modelHost({
    data: options.data,
    gate: options.gate,
    files: {
      sources: options.sources ?? sourceTexts(),
      refuse: options.refuse,
    },
  });
  const files = createModelFiles({ api: createRevisionApi(host.request) });
  if (options.read !== false) {
    // What the page's effects do on mount: read the files, then the sources.
    await files.open(new URLSearchParams(search).get("version") ?? undefined);
    const listing = files.listing.peek();
    if (listing.status === "ready") await files.readSources(listing.version);
  }
  const page = (location: string) => (
    <FilesPage location={{ search: location }} files={files} now={NOW} />
  );
  return {
    host,
    files,
    /** The markup of the page at an address. */
    render: (location = search) => tidy(renderToString(page(location))),
    /** The page with its buttons: press one by its label. */
    pressed: (location = search) => {
      const pressed = press(page(location));
      return Object.assign(pressed, { html: tidy(pressed.html) });
    },
  };
}
const tree = (html: string) =>
  html.slice(html.indexOf('<nav class="tree"'), html.indexOf("</nav>"));
const blob = (html: string) => html.slice(html.indexOf('<div class="blob"'));

Deno.test("before the first read the page says it is reading, and shows nothing else", async () => {
  const { render } = await open("", { read: false });
  const html = render();
  match(html, /<p class="rev-empty" role="status">Reading the files…<\/p>/);
  doesNotMatch(html, /class="repo"|class="tree"|class="blob"/);
});

Deno.test("the bare address shows the files of the head, grouped by directory, with the first one open", async () => {
  const { data, sources } = adding("lib/deep/tools.sysml", "package Tools;\n");
  const { render } = await open("", { data, sources });
  const html = render();
  // The version shown: the head of main, by its commit.
  match(html, new RegExp(`<code title="${HEAD}">ccccccc</code>`));
  match(html, /<span class="chip" title="The head of main">main<\/span>/);
  doesNotMatch(html, /Show current model/);
  // The tree: the root's files, then each directory with its files.
  const groups = tree(html);
  match(
    groups,
    /aria-label="Root"[^>]*><a[^>]*>configuration<\/a><a[^>]*>reader<\/a>/,
  );
  match(groups, /<div class="tree-dir">lib<\/div><a[^>]*>units<\/a>/);
  match(groups, /<div class="tree-dir">lib\/deep<\/div><a[^>]*>tools<\/a>/);
  // Each file is a link to its address, and the one open says so.
  match(
    groups,
    /<a class="tree-file" href="\/model\?page=files&amp;file=configuration\.sysml" title="configuration\.sysml" aria-current="true">/,
  );
  match(
    groups,
    /href="\/model\?page=files&amp;file=lib%2Funits\.sysml"[^>]*aria-current="false"/,
  );
  equal((groups.match(/aria-current="true"/g) || []).length, 1);
  // No file is picked by the address: none is written into the links.
  doesNotMatch(groups, /line=/);
});

Deno.test("the file is its path, then its text one line to a row, numbered from 1, each number a link to its line", async () => {
  const { render } = await open("?page=files&file=configuration.sysml");
  const html = render();
  const file = blob(html);
  match(
    file,
    /<nav class="crumbs" aria-label="Path"><b>configuration\.sysml<\/b><\/nav>/,
  );
  const rows = [...file.matchAll(/<div data-line="(\d+)">/g)].map((row) =>
    row[1]
  );
  deepStrictEqual(rows, ["1", "2", "3", "4"]);
  match(
    file,
    /<div data-line="1"><a class="ln" href="\/model\?page=files&amp;file=configuration\.sysml&amp;line=1" aria-label="Line 1" title="Link to this line" aria-current="false">1<\/a><span>package Configuration \{<\/span><\/div>/,
  );
  match(file, /<span> {2}part def Editor;<\/span>/);
  // Plain text: no highlight yet, and nothing the text says is markup.
  doesNotMatch(file, /class="hl"|class="t-/);
  match(file, /&lt;img src=x onerror=attack\(\)> \*\//);
  doesNotMatch(file, /<img/);
  // Seen without markup, the text reads as it was written.
  match(textOf(file), /1 package Configuration \{ 2 part def Editor;/);
});

Deno.test("the line the address points at is highlighted, its link clears it, and the others link to themselves", async () => {
  const { render } = await open("?page=files&file=lib%2Funits.sysml&line=2");
  const html = render();
  const file = blob(html);
  match(
    file,
    /<div class="hl" data-line="2"><a class="ln" href="\/model\?page=files&amp;file=lib%2Funits\.sysml" aria-label="Line 2" title="Clear the line" aria-current="location">2<\/a>/,
  );
  equal((file.match(/class="hl"/g) || []).length, 1);
  match(
    file,
    /<div data-line="1"><a class="ln" href="\/model\?page=files&amp;file=lib%2Funits\.sysml&amp;line=1"/,
  );
  // The file is the one named: the tree opens it.
  match(
    tree(html),
    /href="\/model\?page=files&amp;file=lib%2Funits\.sysml"[^>]*aria-current="true"/,
  );
});

Deno.test("a line the address cannot point at highlights nothing and breaks nothing", async () => {
  const { render } = await open("?file=configuration.sysml");
  for (const line of ["0", "-1", "abc", "2.5", "99", "9999999999999"]) {
    const html = render(
      `?page=files&file=configuration.sysml&line=${line}`,
    );
    doesNotMatch(html, /class="hl"|aria-current="location"/, line);
    match(html, /<div data-line="4">/, line);
  }
});

Deno.test("the last change to the file links to that commit in Revisions, with its message, short hash and date", async () => {
  const { render } = await open("?page=files&file=reader.sysml");
  const html = render();
  match(
    html,
    new RegExp(
      `<a class="last" href="/model\\?commit=${
        encodeURIComponent(PARENT)
      }" title="Last change to this file" aria-current="false"><span class="msg">Add the reader</span><code>bbbbbbb</code><time datetime="2026-10-23T10:30:00Z">yesterday</time></a>`,
    ),
  );
  // Another file, another commit: the first the history lists it in.
  const other = render("?page=files&file=lib%2Funits.sysml");
  match(other, new RegExp(`commit=${encodeURIComponent(ROOT)}"`));
  match(other, /<span class="msg">Admit the initial model<\/span>/);
});

Deno.test("a file the version does not have is told in its place, the tree stays and none is picked for it", async () => {
  for (
    const file of [
      "missing.sysml",
      "constructor",
      "__proto__",
      "lib",
      "Configuration.sysml",
    ]
  ) {
    const { render } = await open();
    const html = render(`?page=files&file=${encodeURIComponent(file)}`);
    match(html, /<p class="rev-empty" data-code="file-absent">/, file);
    match(html, /is not in this version\./, file);
    doesNotMatch(html, /class="blob"/, file);
    equal((tree(html).match(/aria-current="true"/g) || []).length, 0, file);
    equal((tree(html).match(/class="tree-file"/g) || []).length, 3, file);
  }
  const { render } = await open();
  // What the address said, as text.
  const html = render("?page=files&file=%3Cb%3Ex%3C%2Fb%3E");
  match(html, /<code>&lt;b>x&lt;\/b><\/code> is not in this version/);
  doesNotMatch(html, /<b>x/);
});

Deno.test("at an older version the files are those of that version, the links keep it, and a file it lacks is absent", async () => {
  const version = `?page=files&version=${encodeURIComponent(ROOT)}`;
  const { render, host } = await open(version);
  const html = render();
  // Asked for by its identity: the version is shown, with a way back to main.
  match(html, new RegExp(`<code title="${ROOT}">aaaaaaa</code>`));
  doesNotMatch(html, /class="chip"[^>]*>main/);
  match(html, /<a href="\/model\?page=files">Show current model<\/a>/);
  equal((tree(html).match(/class="tree-file"/g) || []).length, 2);
  // Every file link and line link keeps the version.
  const keeps = new RegExp(`version=${encodeURIComponent(ROOT)}`);
  for (const link of tree(html).match(/href="[^"]*"/g)!) match(link, keeps);
  for (const link of blob(html).match(/class="ln" href="[^"]*"/g)!) {
    match(link, keeps);
  }
  // The text is that version's.
  match(html, /<span>package Configuration;<\/span>/);
  // A file HEAD has and this version lacks.
  const absent = render(`${version}&file=reader.sysml`);
  match(absent, /data-code="file-absent"/);
  match(
    absent,
    /<a href="\/model\?page=files&amp;file=reader\.sysml">Show current model<\/a>/,
  );
  // Sources are asked for by the immutable version, not for the moving head.
  deepStrictEqual(
    host.requests.map((entry) => entry.path),
    [
      `/api/model-files?version=${encodeURIComponent(ROOT)}`,
      `/api/model-sources?version=${encodeURIComponent(ROOT)}`,
    ],
  );
});

Deno.test("an address that is not a version, or a version the host lacks, is told with a code and a way back to main", async () => {
  const invalid = await open("?page=files&version=main&file=a.sysml&line=3");
  const html = invalid.render();
  match(
    html,
    /<p class="proposal-error" role="alert" data-code="version-invalid">/,
  );
  match(
    html,
    /<a class="rev-retry" href="\/model\?page=files&amp;file=a\.sysml&amp;line=3">Show current model<\/a>/,
  );
  // Reading it again would only be refused again: the way back is the way out.
  doesNotMatch(html, /class="repo"|Try again/);
  // The host refused it, with its status and its own words, and nothing more.
  match(
    html,
    /<span class="rev-host-says">Pass an immutable model commit identity\.<\/span>/,
  );
  deepStrictEqual(invalid.host.requests.map((entry) => entry.path), [
    "/api/model-files?version=main",
  ]);

  const absent = await open(
    `?page=files&version=${encodeURIComponent(`commit:${"9".repeat(40)}`)}`,
  );
  const told = absent.render();
  match(told, /data-code="version-absent"/);
  match(told, /This version is not in the model's history\./);
  match(told, /<span class="rev-host-says">Unknown model version<\/span>/);
  match(told, /Show current model/);
  doesNotMatch(told, /Try again/);
});

Deno.test("a files read that failed is told with its code and read again on request", async () => {
  let down = true;
  const { render, pressed, files, host } = await open("", {
    refuse: (route) =>
      down && route === "files"
        ? Response.json({ error: "Down." }, { status: 503 })
        : undefined,
  });
  const failed = pressed();
  match(failed.html, /data-code="files-failed"/);
  match(failed.html, /The files could not be read\./);
  match(failed.html, /<span class="rev-host-says">Down\.<\/span>/);
  doesNotMatch(failed.html, /class="repo"/);
  down = false;
  failed.click("Try again");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(files.listing.peek().status, "ready");
  match(render(), /class="repo"/);
  equal(host.requests.length, 2);
});

Deno.test("a files read of an explicit version that failed on the way is read again on request, and main stays one click away", async () => {
  let down = true;
  const version = `?page=files&version=${encodeURIComponent(ROOT)}`;
  const { render, pressed, files, host } = await open(version, {
    refuse: (route) =>
      down && route === "files"
        ? Response.json({ error: "Down." }, { status: 503 })
        : undefined,
  });
  const failed = pressed();
  match(failed.html, /data-code="files-failed"/);
  doesNotMatch(failed.html, /class="repo"/);
  // Both ways out: the version itself, read again, and main.
  deepStrictEqual(failed.labels, ["Try again"]);
  match(
    failed.html,
    /<a class="rev-retry" href="\/model\?page=files">Show current model<\/a>/,
  );
  down = false;
  failed.click("Try again");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const listing = files.listing.peek();
  equal(listing.status, "ready");
  // The same version was asked for again, not the head.
  deepStrictEqual(listing.asked, ROOT);
  deepStrictEqual(
    host.requests.map((entry) => entry.path),
    Array(2).fill(`/api/model-files?version=${encodeURIComponent(ROOT)}`),
  );
  match(render(), /class="repo"/);
});

Deno.test("a file whose text could not be read shows its head and the failure, and reads it again on request", async () => {
  let down = true;
  const { render, pressed, files, host } = await open(
    "?page=files&file=configuration.sysml",
    {
      refuse: (route) =>
        down && route === "sources"
          ? Response.json({ error: "Down." }, { status: 502 })
          : undefined,
    },
  );
  const failed = pressed();
  // The tree and the path are there; only the text is not.
  match(failed.html, /class="tree-file"/);
  match(blob(failed.html), /<b>configuration\.sysml<\/b>/);
  match(failed.html, /data-code="sources-failed"/);
  doesNotMatch(failed.html, /data-line=/);
  down = false;
  failed.click("Try again");
  await new Promise((resolve) => setTimeout(resolve, 0));
  equal(files.sources(HEAD)?.status, "ready");
  match(render(), /data-line="1"/);
  equal(host.requests.length, 3);
});

Deno.test("while the text of a file is read the page says so, under the file's path", async () => {
  const { render, files } = await open("?page=files&file=configuration.sysml", {
    read: false,
  });
  await files.open();
  const html = render();
  match(blob(html), /<b>configuration\.sysml<\/b>/);
  match(
    blob(html),
    /<p class="rev-empty" role="status">Reading the file…<\/p>/,
  );
});

Deno.test("a file the host listed but did not send is a problem, not an empty file", async () => {
  // The list names the configuration; the sources the host sends do not hold it.
  const sent = sourceTexts()[HEAD];
  delete sent["configuration.sysml"];
  const { render } = await open("?page=files&file=configuration.sysml", {
    refuse: (route) =>
      route === "sources"
        ? Response.json({
          version: HEAD,
          sourceDigest: "d".repeat(64),
          sources: sent,
        })
        : undefined,
  });
  const html = render();
  match(html, /data-code="file-unreadable"/);
  doesNotMatch(html, /file-empty|data-line=/);
});

Deno.test("an empty file says it is empty, and a version with no file says so", async () => {
  const sources = sourceTexts();
  sources[HEAD]["configuration.sysml"] = "";
  const { render } = await open("?page=files&file=configuration.sysml", {
    sources,
  });
  const html = render();
  match(
    html,
    /<p class="rev-empty" data-code="file-empty">This file is empty\.<\/p>/,
  );
  doesNotMatch(html, /data-line=/);

  const none = { [HEAD]: {} };
  const bare = (await open("", { sources: none })).render();
  match(
    bare,
    /<p class="rev-empty" data-code="no-files">No files in this version\.<\/p>/,
  );
  doesNotMatch(bare, /class="repo"|class="blob"/);
  // The version is still the one shown.
  match(bare, /ccccccc/);
  const named = (await open("?page=files&file=a.sysml", { sources: none }))
    .render();
  match(named, /No files in this version\./);
});

Deno.test("a path the address names is encoded in every link, and shown only as text", async () => {
  const odd = "lib/a b&c#d?.sysml";
  const { data, sources } = adding(odd, "x");
  const { render } = await open("", { data, sources });
  const html = render(`?page=files&file=${encodeURIComponent(odd)}&line=1`);
  match(
    tree(html),
    /href="\/model\?page=files&amp;file=lib%2Fa\+b%26c%23d%3F\.sysml"/,
  );
  match(html, /<b>a b&amp;c#d\?\.sysml<\/b>/);
  match(
    html,
    /class="ln" href="\/model\?page=files&amp;file=lib%2Fa\+b%26c%23d%3F\.sysml" aria-label="Line 1"/,
  );
});

Deno.test("a long file is drawn as a window of at most the cap, and the page says which lines of how many", async () => {
  const sources = sourceTexts();
  sources[HEAD]["configuration.sysml"] = Array.from(
    { length: 5000 },
    (_, index) => `line ${index + 1}`,
  ).join("\n") + "\n";
  const { render } = await open("", { sources });
  const start = render("?page=files&file=configuration.sysml");
  equal((start.match(/data-line=/g) || []).length, MAX_SHOWN_LINES);
  match(
    start,
    /data-code="file-windowed"[^>]*><span>Lines 1–2,000 of 5,000<\/span><\/p>/,
  );
  doesNotMatch(start, /First lines/);
  // A line beyond the window is brought into one, highlighted.
  const far = render("?page=files&file=configuration.sysml&line=4000");
  equal((far.match(/data-line=/g) || []).length, MAX_SHOWN_LINES);
  match(
    far,
    /Lines 3,000–4,999 of 5,000|Lines 3,000–5,000 of 5,000|Lines 3,000–4,999/,
  );
  match(far, /<div class="hl" data-line="4000">/);
  match(
    far,
    /<a href="\/model\?page=files&amp;file=configuration\.sysml&amp;line=1">First lines<\/a>/,
  );
  // A file under the cap says nothing of it.
  doesNotMatch(
    (await open("?page=files&file=lib%2Funits.sysml")).render(),
    /file-windowed/,
  );
});

/** What an element does for the page: a row to find, a window to scroll. */
function fakeBlob(options: { top?: number; rows?: number[] } = {}) {
  const scrolled: (ScrollIntoViewOptions | undefined)[] = [];
  const asked: string[] = [];
  const row = {
    scrollIntoView: (arg?: ScrollIntoViewOptions) => void scrolled.push(arg),
  };
  return {
    scrolled,
    asked,
    element: {
      querySelector: (selector: string) => {
        asked.push(selector);
        const line = Number(/"(\d+)"/.exec(selector)?.[1]);
        return options.rows?.includes(line) ? row : null;
      },
      getBoundingClientRect: () => ({ top: options.top ?? 10 }),
      scrollIntoView: (arg?: ScrollIntoViewOptions) => void scrolled.push(arg),
    },
  };
}

Deno.test("the line the address points at is brought to the middle of the window, when it is drawn", () => {
  const drawn = fakeBlob({ rows: [12] });
  equal(revealLine(drawn.element, 12), true);
  deepStrictEqual(drawn.asked, ['[data-line="12"]']);
  deepStrictEqual(drawn.scrolled, [{ block: "center" }]);
  // A line that is not drawn, or none, scrolls nothing.
  equal(revealLine(drawn.element, 13), false);
  equal(revealLine(drawn.element, null), false);
  equal(revealLine(null, 12), false);
  equal(drawn.scrolled.length, 1);
});

Deno.test("a file opened without a line starts at its top when the window was left scrolled past it, and is not moved otherwise", () => {
  const above = fakeBlob({ top: -400 });
  equal(revealTop(above.element, null), true);
  deepStrictEqual(above.scrolled, [{ block: "start" }]);
  const inView = fakeBlob({ top: 30 });
  equal(revealTop(inView.element, null), false);
  deepStrictEqual(inView.scrolled, []);
  // With a line, the line decides where the window goes.
  const lined = fakeBlob({ top: -400 });
  equal(revealTop(lined.element, 7), false);
  deepStrictEqual(lined.scrolled, []);
  equal(revealTop(null, null), false);
});

Deno.test("Files creates a Release from its displayed exact source and the Releases view shares that source", async () => {
  const f = await open(`?version=${encodeURIComponent(PARENT)}`);
  match(
    f.render(),
    new RegExp(
      `href="/model\\?page=releases&amp;version=${
        encodeURIComponent(PARENT)
      }&amp;create=1">Create release`,
    ),
  );
  const html = renderToString(
    <FilesPage
      releases
      location={{ search: `?version=${encodeURIComponent(PARENT)}&create=1` }}
      files={f.files}
      now={NOW}
    />,
  );
  match(html, /class="saved-systems-create" aria-label="Create release"/);
  match(html, /Back to releases/);
  doesNotMatch(html, /aria-label="Release actions"|aria-expanded=/);
  match(html, /Create release/);
  // The exact source is its short commit, linking to Files; the whole of it
  // and its branch sit in the tooltip.
  match(
    html,
    new RegExp(
      `title="main · exact source ${PARENT}"><code>[0-9a-f]{7}</code>`,
    ),
  );
  doesNotMatch(html, /View files|<h3>Releases/);
  doesNotMatch(html, /class="tree"|class="blob"/);
  f.files.dispose();
});

Deno.test("rendered Request file, line and revision links follow the selected Case", async () => {
  const { files } = await open(`?version=${HEAD}`);
  const renderCase = (caseId: string) =>
    tidy(renderToString(
      <ModelLinkContext.Provider value={`?caseBranch=${caseId}&agent=operator`}>
        <FilesPage
          location={{ search: `?version=${HEAD}` }}
          files={files}
          caseReadOnly
          now={NOW}
        />
      </ModelLinkContext.Provider>,
    ));
  for (const caseId of ["case-one", "case-two"]) {
    const html = renderCase(caseId);
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((entry) =>
      entry[1]
    );
    match(html, /class="tree-file"/);
    match(html, /class="ln"/);
    match(html, /class="last"/);
    for (const href of links) {
      match(href, new RegExp(`caseBranch=${caseId}`));
      match(href, /agent=operator/);
    }
    doesNotMatch(html, /Create release/);
    doesNotMatch(
      html,
      new RegExp(
        `caseBranch=${caseId === "case-one" ? "case-two" : "case-one"}`,
      ),
    );
  }
});

Deno.test("read-only Request Files expose the existing Release rightbar for the exact Case source without tool-generation actions", async () => {
  const { files } = await open(`?version=${HEAD}`);
  try {
    const html = tidy(
      renderToString(
        <ModelLinkContext.Provider value="?caseBranch=caseA&agent=selected-child">
          <FilesPage
            location={{ search: `?version=${HEAD}` }}
            files={files}
            caseReadOnly
            releaseBranch={{ kind: "case", caseId: "caseA" }}
            requestExecutionVersion={HEAD}
            requestBaseVersion={HEAD}
            requestBranchVersion={HEAD}
          />
        </ModelLinkContext.Provider>,
      ),
    );
    match(html, /Create release/);
    match(html, /page=releases/);
    match(html, /caseBranch=caseA/);
    match(html, /agent=selected-child/);
    doesNotMatch(html, /Generate tool|Propose tool/);
    const releaseApi = createSavedSystemsApi({
      catalogue: { kind: "case", caseId: "caseA" },
      fetch: (() => {
        throw new Error("Rendering must not fetch");
      }) as typeof fetch,
    });
    const release = tidy(
      renderToString(
        <ModelLinkContext.Provider value="?caseBranch=caseA&agent=selected-child">
          <FilesPage
            releases
            location={{ search: `?version=${HEAD}&create=1` }}
            files={files}
            caseReadOnly
            releaseBranch={{ kind: "case", caseId: "caseA" }}
            requestExecutionVersion={HEAD}
            requestBaseVersion={HEAD}
            requestBranchVersion={HEAD}
            releaseApi={releaseApi}
          />
        </ModelLinkContext.Provider>,
      ),
    );
    match(release, /Request caseA.*exact source/s);
    doesNotMatch(release, /main · exact source/);
    const unavailable = renderToString(
      <FilesPage
        releases
        location={{ search: `?version=${HEAD}&create=1` }}
        files={files}
        caseReadOnly
      />,
    );
    match(unavailable, /scoped Request Release context is unavailable/);
    doesNotMatch(unavailable, /saved-systems-form|main · exact source/);
  } finally {
    files.dispose();
  }
});

Deno.test("Request current admitted A1 offers exact Release creation independently of execution while other sources refuse", async () => {
  const { files } = await open(`?version=${HEAD}`);
  try {
    const releaseApi = createSavedSystemsApi({
      catalogue: { kind: "case", caseId: "caseA" },
      fetch: (() => {
        throw new Error("render must not fetch");
      }) as typeof fetch,
    });
    const inspect = (
      executionVersion: string,
      branchVersion: string | undefined,
      releases = false,
    ) =>
      renderToString(
        <ModelLinkContext.Provider value="?caseBranch=caseA&agent=selected-child">
          <FilesPage
            location={{ search: `?version=${HEAD}&create=1` }}
            files={files}
            caseReadOnly
            releases={releases}
            releaseBranch={{ kind: "case", caseId: "caseA" }}
            releaseApi={releaseApi}
            requestExecutionVersion={executionVersion}
            requestBaseVersion={PARENT}
            requestBranchVersion={branchVersion}
          />
        </ModelLinkContext.Provider>,
      );
    const adoptedA1 = inspect(HEAD, HEAD);
    match(adoptedA1, /Create release/);
    match(adoptedA1, /<button[^>]*>Create tag<\/button>/);
    doesNotMatch(adoptedA1, /<h3>Releases<\/h3>|release-source-context/);
    const a1 = inspect(PARENT, HEAD);
    match(a1, /Show current model/);
    match(a1, /Create release/);
    match(a1, /caseBranch=caseA/);
    match(a1, /agent=selected-child/);
    // The release source is a small chip; its exact sentence is the tooltip.
    match(
      a1,
      new RegExp(
        `title="Release source ${HEAD} · execution remains ${PARENT}\\. Creating a Release does not adopt this source\\.">not running</span>`,
      ),
    );
    const a1Releases = inspect(PARENT, HEAD, true);
    match(a1Releases, /Current admitted Request source/);
    match(a1Releases, /saved-systems-form/);
    match(a1Releases, /Request caseA.*exact source/s);
    match(a1Releases, new RegExp(HEAD));
    doesNotMatch(
      a1Releases,
      /An exact eligible source is required|Show current model|main · exact source/,
    );
    const b0WithAdvancedHead = inspect(HEAD, `commit:${"d".repeat(40)}`);
    match(b0WithAdvancedHead, /Request model/);
    match(
      b0WithAdvancedHead,
      /Only the current admitted Request version can be tagged/,
    );
    doesNotMatch(b0WithAdvancedHead, /<button[^>]*>Create tag<\/button>/);
    doesNotMatch(
      b0WithAdvancedHead,
      /Show current model|Create release|head of main/,
    );
    const b0ReleaseCatalogue = inspect(HEAD, `commit:${"d".repeat(40)}`, true);
    match(b0ReleaseCatalogue, /An exact eligible source is required/);
    match(
      b0ReleaseCatalogue,
      new RegExp(
        `page=releases&amp;version=${
          encodeURIComponent(HEAD)
        }&amp;caseBranch=caseA&amp;agent=selected-child`,
      ),
    );
    doesNotMatch(
      b0ReleaseCatalogue,
      /saved-systems-form|<button\b[^>]*>\s*Create release/,
    );
    const unprovenSource = inspect(PARENT, undefined, true);
    match(unprovenSource, /An exact eligible source is required/);
    doesNotMatch(
      unprovenSource,
      /saved-systems-form|Current admitted Request source/,
    );
  } finally {
    files.dispose();
  }
});
