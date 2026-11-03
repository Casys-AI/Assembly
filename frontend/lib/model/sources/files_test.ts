import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  codeLines,
  codeWindow,
  createModelFiles,
  crumbs,
  fileGroups,
  fileName,
  filesHref,
  fileText,
  MAX_SHOWN_LINES,
  shownFile,
  textLines,
} from "./files.ts";
import { createRevisionApi } from "../revisions/api.ts";
import {
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

const entry = (path: string) => ({
  path,
  lastChange: {
    version: HEAD,
    createdAt: "2026-10-24T09:00:00Z",
    message: "m",
  },
});

Deno.test("files are grouped by directory: the root first, then each directory by name, files by name", () => {
  const files = [
    "z.sysml",
    "lib/b.sysml",
    "a.sysml",
    "lib/deep/c.sysml",
    "lib/a.sysml",
    "app/main.sysml",
  ].map(entry);
  const groups = fileGroups(files);
  deepStrictEqual(
    groups.map((group) => [group.dir, group.files.map((row) => row.name)]),
    [
      ["", ["a", "z"]],
      ["app", ["main"]],
      ["lib", ["a", "b"]],
      ["lib/deep", ["c"]],
    ],
  );
  // Each row keeps what the host knows of its file, under the full path.
  equal(groups[3].files[0].entry.path, "lib/deep/c.sysml");
  // The same files make the same tree, whatever order they came in.
  deepStrictEqual(fileGroups([...files].reverse()), groups);
  deepStrictEqual(fileGroups([]), []);
});

Deno.test("a file's name drops the .sysml every source has, and nothing else", () => {
  equal(fileName("lib/units.sysml"), "units");
  equal(fileName("units.sysml"), "units");
  equal(fileName("lib/notes.txt"), "notes.txt");
  equal(fileName("a.sysml.bak"), "a.sysml.bak");
  deepStrictEqual(crumbs("lib/deep/tools.sysml"), {
    dirs: ["lib", "deep"],
    name: "tools.sysml",
  });
  deepStrictEqual(crumbs("a.sysml"), { dirs: [], name: "a.sysml" });
});

Deno.test("the file shown is the one named, else the first of the tree; one the version lacks is absent, never replaced", () => {
  const groups = fileGroups(["lib/a.sysml", "b.sysml", "c.sysml"].map(entry));
  // The first of the tree is the root's first, not the first path in the list.
  deepStrictEqual(shownFile(groups, null), {
    kind: "file",
    entry: entry("b.sysml"),
  });
  deepStrictEqual(shownFile(groups, "lib/a.sysml"), {
    kind: "file",
    entry: entry("lib/a.sysml"),
  });
  deepStrictEqual(shownFile(groups, "missing.sysml"), {
    kind: "absent",
    path: "missing.sysml",
  });
  // Only the files the version lists exist: no inherited name is one.
  for (
    const name of ["constructor", "__proto__", "toString", "lib", "B.sysml"]
  ) {
    deepStrictEqual(shownFile(groups, name), { kind: "absent", path: name });
  }
  deepStrictEqual(shownFile([], null), { kind: "none" });
  deepStrictEqual(shownFile([], "a.sysml"), {
    kind: "absent",
    path: "a.sysml",
  });
});

Deno.test("lines are counted from 1; a final line break ends the last line and adds none", () => {
  deepStrictEqual(codeLines("a\nb\n"), {
    lines: ["a", "b"],
    first: 1,
    total: 2,
  });
  deepStrictEqual(codeLines("a\nb"), { lines: ["a", "b"], first: 1, total: 2 });
  // Blank lines are lines; CRLF is one break, not two.
  deepStrictEqual(codeLines("a\n\nb\r\nc\r\n"), {
    lines: ["a", "", "b", "c"],
    first: 1,
    total: 4,
  });
  deepStrictEqual(codeLines("\n"), { lines: [""], first: 1, total: 1 });
  // An empty file has no line at all.
  deepStrictEqual(codeLines(""), { lines: [], first: 1, total: 0 });
});

Deno.test("a long file shows a window of at most the cap, and the line pointed at is inside it", () => {
  const text = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`)
    .join("\n") + "\n";
  const start = codeLines(text);
  equal(start.lines.length, MAX_SHOWN_LINES);
  equal(start.first, 1);
  equal(start.total, 5000);
  equal(start.lines[0], "line 1");
  // A line inside the first window leaves it where it is.
  equal(codeLines(text, MAX_SHOWN_LINES).first, 1);
  // Beyond it, the window is centred on the line, and the line is in it.
  const far = codeLines(text, 3500);
  equal(far.lines.length, MAX_SHOWN_LINES);
  equal(far.lines[3500 - far.first], "line 3500");
  equal(far.first, 2500);
  // At the end, the window ends with the file.
  const last = codeLines(text, 5000);
  equal(last.first, 5000 - MAX_SHOWN_LINES + 1);
  equal(last.lines.at(-1), "line 5000");
  // A line the file does not have is not a reason to leave the start.
  equal(codeLines(text, 9999).first, 1);
  // A file that fits is never windowed.
  const small = codeLines("a\nb\nc", 3, 10);
  deepStrictEqual(small, { lines: ["a", "b", "c"], first: 1, total: 3 });
});

Deno.test("a window already on show stays while it holds the line pointed at or none is: clearing a line does not move the text", () => {
  const all = textLines(
    Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join("\n"),
  );
  const far = codeWindow(all, 4000);
  equal(far.first, 3000);
  // The highlight is cleared: the window is where it was, not back at the top.
  equal(codeWindow(all, null, MAX_SHOWN_LINES, far.first).first, 3000);
  // Another line of the window is highlighted: nothing moves under the reader.
  equal(codeWindow(all, 3500, MAX_SHOWN_LINES, far.first).first, 3000);
  equal(codeWindow(all, 3500, MAX_SHOWN_LINES).first, 2500, "from scratch");
  // A line the window does not hold takes it there, as an address would.
  equal(codeWindow(all, 100, MAX_SHOWN_LINES, far.first).first, 1);
  equal(codeWindow(all, 5000, MAX_SHOWN_LINES, 1).first, 3001);
  // A line the file does not have points at nothing: the window stays.
  equal(codeWindow(all, 9999, MAX_SHOWN_LINES, far.first).first, 3000);
  // A window kept for a text that has since become shorter ends with the text.
  equal(codeWindow(all.slice(0, 2500), null, MAX_SHOWN_LINES, 3000).first, 501);
  deepStrictEqual(
    codeWindow(["a", "b"], null, MAX_SHOWN_LINES, 7),
    { lines: ["a", "b"], first: 1, total: 2 },
  );
  // The text of codeLines is the same lines.
  deepStrictEqual(codeLines("a\nb\n", null, 10, 1), codeWindow(["a", "b"]));
});

Deno.test("a file's address names the version, the file and the line, and only those that are set", () => {
  equal(filesHref(), "/model?page=files");
  equal(filesHref({ file: "a.sysml" }), "/model?page=files&file=a.sysml");
  equal(
    filesHref({ file: "lib/a b&c.sysml", line: 12 }),
    "/model?page=files&file=lib%2Fa+b%26c.sysml&line=12",
  );
  equal(
    filesHref({ version: PARENT, file: "a.sysml", line: 3 }),
    `/model?page=files&version=${
      encodeURIComponent(PARENT)
    }&file=a.sysml&line=3`,
  );
  // Unset, empty or no line at all: nothing written.
  equal(
    filesHref({ version: null, file: "", line: null }),
    "/model?page=files",
  );
  equal(
    filesHref({ file: "a.sysml", line: 0 }),
    "/model?page=files&file=a.sysml",
  );
});

Deno.test("the text of a file comes from the sources of its version; a path the host did not send is a problem, never an empty file", () => {
  deepStrictEqual(fileText(undefined, "a.sysml"), { status: "reading" });
  deepStrictEqual(fileText({ status: "reading" }, "a.sysml"), {
    status: "reading",
  });
  deepStrictEqual(
    fileText({ status: "ready", sources: { "a.sysml": "x" } }, "a.sysml"),
    {
      status: "ready",
      text: "x",
    },
  );
  // An empty file is a file.
  deepStrictEqual(
    fileText({ status: "ready", sources: { "a.sysml": "" } }, "a.sysml"),
    {
      status: "ready",
      text: "",
    },
  );
  const failed = fileText({ status: "ready", sources: {} }, "a.sysml");
  equal(failed.status, "failed");
  equal(failed.status === "failed" && failed.problem.code, "file-unreadable");
  // A name every object has is not a file the sources hold.
  equal(
    fileText({ status: "ready", sources: {} }, "constructor").status,
    "failed",
  );
  const problem = { code: "sources-failed" as const, message: "no" };
  deepStrictEqual(fileText({ status: "failed", problem }, "a.sysml"), {
    status: "failed",
    problem,
  });
});

/** A version no host holds, but that is a commit identity. */
const ABSENT = `commit:${"9".repeat(40)}`;

/** The store over a host that serves the revision fixture's files and sources. */
const store = (
  options: {
    sources?: Record<string, Record<string, string>>;
    gate?: HostGate;
    refuse?: HostFiles["refuse"];
  } = {},
) => {
  const host = modelHost({
    gate: options.gate,
    files: {
      sources: options.sources ?? sourceTexts(),
      refuse: options.refuse,
    },
  });
  return {
    host,
    files: createModelFiles({ api: createRevisionApi(host.request) }),
  };
};

Deno.test("the head is read fresh and answers the version it is at", async () => {
  const { host, files } = store();
  deepStrictEqual(files.listing.value, { asked: undefined, status: "reading" });
  await files.open();
  const listing = files.listing.value;
  equal(listing.status, "ready");
  ok(listing.status === "ready");
  equal(listing.asked, undefined);
  equal(listing.version, HEAD);
  deepStrictEqual(listing.files.map((file) => file.path), [
    "configuration.sysml",
    "reader.sysml",
    "lib/units.sysml",
  ]);
  // The head moves: the browser is not allowed to keep the answer.
  deepStrictEqual(host.requests, [{
    path: "/api/model-files",
    method: "GET",
    cache: "no-store",
  }]);
});

Deno.test("a version is read once for the browser to keep", async () => {
  const { host, files } = store();
  await files.open(ROOT);
  const listing = files.listing.value;
  ok(listing.status === "ready");
  equal(listing.asked, ROOT);
  equal(listing.version, ROOT);
  equal(listing.files.length, 2);
  equal(host.requests.length, 1);
  equal(host.requests[0].cache, "default");
});

Deno.test("what a version looks like is the host's rule alone: its refusal is the page's version-invalid, with the host's own words", async () => {
  const { host, files } = store();
  for (
    const bad of [
      "main",
      "HEAD",
      "branch:" + "c".repeat(40),
      "commit:" + "c".repeat(39),
      "commit:" + "C".repeat(40),
      "commit:" + "c".repeat(41),
      " " + HEAD,
    ]
  ) {
    await files.open(bad);
    const refused = files.listing.value;
    ok(refused.status === "failed", bad);
    equal(refused.asked, bad);
    equal(refused.problem.code, "version-invalid", bad);
    equal(refused.problem.status, 400, bad);
    equal(
      refused.problem.detail,
      "Pass an immutable model commit identity.",
      bad,
    );
  }
  // Each one went to the host: the page holds no copy of the rule.
  equal(host.requests.length, 7);
});

Deno.test("a version the host lacks is told with its code, status and the host's own words; a failure is read again on request", async () => {
  let down = true;
  const { host, files } = store({
    refuse: (route) =>
      down && route === "files"
        ? Response.json({ error: "Down." }, { status: 503 })
        : undefined,
  });
  await files.open(ABSENT);
  let listing = files.listing.value;
  ok(listing.status === "failed");
  equal(listing.problem.code, "files-failed");
  equal(listing.problem.status, 503);
  equal(listing.problem.detail, "Down.");
  down = false;
  // Not held by the host: 404.
  await files.open(ABSENT);
  listing = files.listing.value;
  ok(listing.status === "failed");
  equal(listing.problem.code, "version-absent");
  equal(listing.problem.status, 404);
  equal(listing.problem.detail, "Unknown model version");
  await files.open();
  equal(files.listing.value.status, "ready");
  equal(host.requests.length, 3);
});

Deno.test("the same version read again keeps what it showed until the answer; another one starts over", async () => {
  let release!: () => void;
  let closed = false;
  const gate = new Promise<void>((resolve) => release = resolve);
  const { files, host } = store({ gate: () => closed ? gate : undefined });
  await files.open();
  const first = files.listing.value;
  ok(first.status === "ready");
  // The host is slow now: the head is read again and the tree stays.
  closed = true;
  const again = files.open();
  equal(files.listing.value, first);
  // Another version: nothing of the head is shown under it.
  const other = files.open(PARENT);
  deepStrictEqual(files.listing.value, { asked: PARENT, status: "reading" });
  release();
  await Promise.all([again, other]);
  equal(host.requests.length, 3);
  // The head read again was overtaken by the other version, and dropped.
  const listing = files.listing.value;
  ok(listing.status === "ready");
  equal(listing.asked, PARENT);
});

Deno.test("a read of the head that ends after the next one has begun does not replace it", async () => {
  let release!: () => void;
  const slow = new Promise<void>((resolve) => release = resolve);
  const { files } = store({
    gate: (path) => path === "/api/model-files" ? slow : undefined,
  });
  const stale = files.open();
  const latest = files.open(PARENT);
  await latest;
  // The version asked last is shown; the head, answering late, is not.
  const shown = files.listing.value;
  ok(shown.status === "ready");
  equal(shown.asked, PARENT);
  release();
  await stale;
  equal(files.listing.value, shown);
});

Deno.test("sources are read once for a version, however many ask, and kept", async () => {
  const { host, files } = store();
  await Promise.all([files.readSources(HEAD), files.readSources(HEAD)]);
  await files.readSources(HEAD);
  equal(host.requests.length, 1);
  equal(files.sources(HEAD)?.status, "ready");
  equal(files.sources(PARENT), undefined);
  const state = files.sources(HEAD);
  ok(state?.status === "ready");
  equal(
    state.sources["lib/units.sysml"],
    "package Units {\n  attribute metre;\n}\n",
  );
  // Not a route the browser keeps: the text of a version can weigh megabytes.
  equal(host.requests[0].cache, "no-store");
});

Deno.test("sources that fail are told with a code, and read again when asked again", async () => {
  let down = true;
  const { host, files } = store({
    refuse: (route) =>
      down && route === "sources"
        ? Response.json({ error: "Down." }, { status: 502 })
        : undefined,
  });
  await files.readSources(HEAD);
  const failed = files.sources(HEAD);
  ok(failed?.status === "failed");
  equal(failed.problem.code, "sources-failed");
  equal(failed.problem.status, 502);
  down = false;
  await files.readSources(HEAD);
  equal(files.sources(HEAD)?.status, "ready");
  equal(host.requests.length, 2);
});

Deno.test("only the latest few versions' sources stay at hand", async () => {
  const sources = sourceTexts();
  const more = Array.from(
    { length: 4 },
    (_, index) => `commit:${String(index).repeat(40)}`,
  );
  for (const version of more) sources[version] = sources[HEAD];
  const { host, files } = store({ sources });
  for (const version of more) await files.readSources(version);
  equal(files.sources(more[0]), undefined);
  for (const version of more.slice(1)) {
    equal(files.sources(version)?.status, "ready");
  }
  // The one dropped is read again if it is asked for.
  await files.readSources(more[0]);
  equal(host.requests.length, 5);
});

Deno.test("after dispose nothing is stored: a read still in flight is dropped", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  const { files } = store({ gate });
  const listing = files.open();
  const sources = files.readSources(HEAD);
  files.dispose();
  release();
  await Promise.all([listing, sources]);
  equal(files.listing.value.status, "reading");
  equal(files.sources(HEAD)?.status, "reading");
  // And it asks for nothing more.
  const { host, files: other } = store();
  other.dispose();
  await other.open();
  await other.readSources(HEAD);
  equal(host.requests.length, 0);
});

Deno.test("the head the host announces is read once, at its own address; the sources already read stay for a person who returns", async () => {
  // PARENT stands for the new head: a commit the files fixture lists.
  const { host, files } = store();
  await files.open();
  await files.readSources(HEAD);
  equal(files.sources(HEAD)?.status, "ready");
  await files.moved(PARENT);
  const listing = files.listing.value;
  ok(listing.status === "ready");
  equal(listing.asked, undefined, "it still follows the head");
  equal(listing.version, PARENT);
  equal(files.sources(HEAD)?.status, "ready", "the old head is still at hand");
  deepStrictEqual(host.requests.at(-1), {
    path: `/api/model-files?version=${encodeURIComponent(PARENT)}`,
    method: "GET",
    cache: "default",
  });
  // The same head announced again (a proposal made) reads nothing.
  await files.moved(PARENT);
  equal(host.requests.length, 3, "the listing, the sources, the new head");
});

Deno.test("the listing on show stays until the announced head answers", async () => {
  let release!: () => void;
  let closed = false;
  const gate = new Promise<void>((resolve) => release = resolve);
  const { files } = store({ gate: () => closed ? gate : undefined });
  await files.open();
  const held = files.listing.value;
  closed = true;
  const reading = files.moved(PARENT);
  equal(files.listing.value, held);
  release();
  await reading;
  const listing = files.listing.value;
  ok(listing.status === "ready");
  equal(listing.version, PARENT);
});

Deno.test("a version the page names never moves with the head, and a listing that holds the head reads nothing", async () => {
  const { host, files } = store();
  await files.open(ROOT);
  await files.moved(PARENT);
  equal(host.requests.length, 1);
  const listing = files.listing.value;
  ok(listing.status === "ready");
  equal(listing.asked, ROOT);
  await files.open();
  await files.moved(HEAD);
  equal(host.requests.length, 2);
});

Deno.test("a head announced while the last was still being read replaces it, and only the newer answer is shown", async () => {
  const release: Record<string, () => void> = {};
  const { files } = store({
    gate: (path) =>
      path.includes("?version=")
        ? new Promise<void>((resolve) => {
          release[decodeURIComponent(path.split("=")[1])] = resolve;
        })
        : undefined,
  });
  await files.open();
  const toParent = files.moved(PARENT);
  const toRoot = files.moved(ROOT);
  release[ROOT]();
  await toRoot;
  release[PARENT]();
  await toParent;
  const listing = files.listing.value;
  ok(listing.status === "ready");
  equal(listing.version, ROOT);
});

Deno.test("a failed listing of the head is read again when the host speaks again, and a failure of the announced head says why", async () => {
  let down = true;
  const { host, files } = store({
    refuse: (route) =>
      down && route === "files"
        ? Response.json({ error: "Down." }, { status: 503 })
        : undefined,
  });
  // Assertions narrow what they read: the listing is read afresh each time.
  const now = () => files.listing.value;
  await files.open();
  equal(now().status, "failed");
  down = false;
  await files.moved(HEAD);
  equal(now().status, "ready");
  down = true;
  await files.moved(PARENT);
  const failed = now();
  ok(failed.status === "failed");
  equal(failed.asked, undefined);
  equal(failed.problem.code, "files-failed");
  equal(host.requests.length, 3);
});

/** A host whose read of the head's files waits until the test lets it answer. */
function slowHead() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => release = resolve);
  return {
    release: () => release(),
    ...store({
      gate: (path) => path === "/api/model-files" ? gate : undefined,
    }),
  };
}

Deno.test("a head announced while the first read of the files is on its way waits for it: the commit it brings is the announced one, so there is one request", async () => {
  const { host, files, release } = slowHead();
  const opening = files.open();
  const announced = files.moved(HEAD);
  equal(host.requests.length, 1, "no second request while the first is out");
  release();
  await Promise.all([opening, announced]);
  equal(host.requests.length, 1);
  const listing = files.listing.value;
  ok(listing.status === "ready");
  equal(listing.version, HEAD);
});

Deno.test("a head announced while the first read is on its way, and newer than what that read brings, is read once the first answer has come", async () => {
  const { host, files, release } = slowHead();
  const opening = files.open();
  const announced = files.moved(PARENT);
  release();
  await Promise.all([opening, announced]);
  deepStrictEqual(
    host.requests.map((request) => request.path),
    [
      "/api/model-files",
      `/api/model-files?version=${encodeURIComponent(PARENT)}`,
    ],
  );
  const listing = files.listing.value;
  ok(listing.status === "ready");
  equal(listing.version, PARENT);
});
