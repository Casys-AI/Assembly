import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  activityFiles,
  type ActivityGroup,
  activityGroups,
  type ActivityRow,
} from "./activity.ts";
import type { RevisionSnapshot, SourceCommit } from "./api.ts";
import {
  changed,
  commit,
  DESIGNER,
  diffBetween,
  HEAD,
  history,
  PARENT,
  proposal,
  PROPOSED,
  ROOT,
} from "../../../test/support/revision-fixture.ts";

const roster = [{ nativeId: DESIGNER, name: "Designer" }];
const groupsOf = (snapshot = history(), names = roster) =>
  activityGroups(snapshot, names);
const rows = (groups: ActivityGroup[], id: string) =>
  groups.find((group) => group.id === id)?.rows ?? [];
const titles = (rows: ActivityRow[]) => rows.map((row) => row.title);

Deno.test("the feed puts what waits first, then main's commits newest first, then what was declined", () => {
  const groups = groupsOf();
  deepStrictEqual(groups.map((group) => [group.id, group.label]), [
    ["waiting", "Waiting for you"],
    ["accepted", "Accepted"],
    ["declined", "Declined"],
  ]);
  // Preparing, proposed and accepting proposals wait, in the repository's order.
  deepStrictEqual(titles(rows(groups, "waiting")), [
    "Draft the reviewer",
    "Add a ranking step",
  ]);
  // An accepted proposal is its commit's row, not a row of its own.
  deepStrictEqual(titles(rows(groups, "accepted")), [
    "Accept a proposal",
    "Add the reader",
    "Admit the initial model",
  ]);
  deepStrictEqual(titles(rows(groups, "declined")), ["Rename everything"]);
});

Deno.test("a proposal that is accepting waits too, and says what it waits for", () => {
  const snapshot = history();
  snapshot.revisions.proposals.push(
    proposal(
      "p-accepting",
      "accepting",
      "Being merged",
      "2026-10-24T08:00:00Z",
    ),
  );
  const waiting = rows(groupsOf(snapshot), "waiting");
  deepStrictEqual(
    waiting.map((row) => [row.key, row.state, row.stage]),
    [
      ["proposal:p-prepare", "pending", "preparing"],
      ["proposal:p-open", "pending", undefined],
      ["proposal:p-accepting", "pending", "accepting"],
    ],
  );
});

Deno.test("groups with nothing in them are left out, and a model with no history has no feed", () => {
  const snapshot = history();
  snapshot.revisions.proposals = [];
  deepStrictEqual(groupsOf(snapshot).map((group) => group.id), ["accepted"]);
  snapshot.history.commits = [];
  deepStrictEqual(groupsOf(snapshot), []);
});

Deno.test("a row says what it is, who made it and what it stands on", () => {
  const groups = groupsOf();
  const [prepared, open] = rows(groups, "waiting");
  deepStrictEqual(
    {
      key: open.key,
      selection: open.selection,
      state: open.state,
      byline: open.byline,
      createdAt: open.createdAt,
      short: open.short,
      main: open.main,
      version: open.version,
    },
    {
      key: "proposal:p-open",
      selection: { kind: "proposal", id: "p-open" },
      state: "pending",
      byline: "proposed by Designer",
      createdAt: "2026-10-24T10:00:00Z",
      short: undefined,
      main: false,
      version: PROPOSED,
    },
  );
  // A proposal still prepared has no version to read yet.
  equal(prepared.version, undefined);
  const [head, parent, root] = rows(groups, "accepted");
  deepStrictEqual(
    [head, parent, root].map((row) => [row.state, row.byline, row.short]),
    [
      ["applied", "admitted by You", "ccccccc"],
      ["accepted", "proposed by Designer, accepted by You", "bbbbbbb"],
      ["applied", "admitted by Assembly", "aaaaaaa"],
    ],
  );
  deepStrictEqual([head.main, parent.main, root.main], [true, false, false]);
  deepStrictEqual(rows(groups, "declined")[0].state, "declined");
  deepStrictEqual(rows(groups, "declined")[0].byline, "proposed by Designer");
});

Deno.test("a commit that accepted a proposal keeps the key the proposal had while it waited", () => {
  const groups = groupsOf();
  const [head, parent, root] = rows(groups, "accepted");
  deepStrictEqual([head.key, parent.key, root.key], [
    `commit:${HEAD}`,
    "proposal:p-taken",
    `commit:${ROOT}`,
  ]);
  // The row opens as the commit; the key is what carries an open row through.
  deepStrictEqual(parent.selection, { kind: "commit", id: PARENT });
  // One proposal is accepted as one commit: a second link does not repeat its key.
  const snapshot = history();
  snapshot.history.commits[0] = {
    ...snapshot.history.commits[0],
    proposalId: "p-taken",
  };
  const keys = rows(groupsOf(snapshot), "accepted").map((row) => row.key);
  equal(new Set(keys).size, keys.length);
  deepStrictEqual(keys.slice(0, 2), ["proposal:p-taken", `commit:${PARENT}`]);
});

Deno.test("authors are labelled from what the host parsed: people, operators, Assembly, and what it did not recognise", () => {
  const snapshot = history();
  const byOther = (version: string, author: string): SourceCommit => ({
    ...commit(
      version,
      undefined,
      author,
      `by ${author}`,
      "2026-10-20T00:00:00Z",
    ),
  });
  snapshot.history.commits = [
    byOther(HEAD, "local-owner"),
    byOther(PARENT, "agent:designer"),
    byOther(ROOT, "ase:approved-change:c1"),
    byOther(`commit:${"1".repeat(40)}`, "agent:gone"),
    byOther(`commit:${"2".repeat(40)}`, "somebody-else"),
  ];
  snapshot.revisions.proposals = [];
  deepStrictEqual(
    rows(groupsOf(snapshot), "accepted").map((row) => row.byline),
    [
      "admitted by You",
      "admitted by Designer",
      "admitted by Assembly · approved change",
      // An operator the roster lacks is not shown by its identity; an author
      // the host itself did not recognise stands as it gave it.
      "admitted by An operator",
      "admitted by somebody-else",
    ],
  );
  // Without a roster no operator can be named.
  equal(
    rows(groupsOf(snapshot, []), "accepted")[1].byline,
    "admitted by An operator",
  );
});

Deno.test("a commit's size is Git's, known at once; a proposal's is known when its change has been read", () => {
  const asked: string[] = [];
  const groups = activityGroups(history(), roster, ({ base, target }) => {
    asked.push(`${base} ${target}`);
    return { files: 1, additions: 2, deletions: 0 };
  });
  deepStrictEqual(
    rows(groups, "accepted").map((row) => row.size),
    [
      { files: 1, additions: 2, deletions: 0 },
      { files: 2, additions: 11, deletions: 1 },
      { files: 2, additions: 14, deletions: 0 },
    ],
  );
  // Only a proposal with a version has a change to ask about: not one in the making.
  deepStrictEqual(asked, [`${HEAD} ${PROPOSED}`, `${HEAD} ${PROPOSED}`]);
  deepStrictEqual(
    rows(groups, "waiting").map((row) => row.size),
    [undefined, { files: 1, additions: 2, deletions: 0 }],
  );
  // Unread, a proposal has no size to show, not zeros.
  deepStrictEqual(
    rows(groupsOf(), "waiting").map((row) => row.size),
    [undefined, undefined],
  );
});

Deno.test("the change to read is the commit against its parent; the initial commit has no parent and none to read", () => {
  const groups = groupsOf();
  deepStrictEqual(
    rows(groups, "accepted").map((row) => row.change),
    [
      { base: PARENT, target: HEAD },
      { base: ROOT, target: PARENT },
      undefined,
    ],
  );
  deepStrictEqual(
    rows(groups, "waiting").map((row) => row.change),
    [undefined, { base: HEAD, target: PROPOSED }],
  );
  // The initial commit still lists the files it added.
  deepStrictEqual(
    rows(groups, "accepted")[2].files?.map((file) => file.path),
    ["configuration.sysml", "lib/units.sysml"],
  );
});

Deno.test("a commit's files link to the file as the commit left it, on main for the head, and a removed file is not a link", () => {
  const [head, parent] = rows(groupsOf(), "accepted");
  deepStrictEqual(activityFiles(head).map((file) => file.href), [
    "/model?page=files&file=configuration.sysml",
  ]);
  deepStrictEqual(
    activityFiles(parent).map((file) => [file.path, file.href]),
    [
      [
        "configuration.sysml",
        `/model?page=files&version=${
          encodeURIComponent(PARENT)
        }&file=configuration.sysml`,
      ],
      [
        "reader.sysml",
        `/model?page=files&version=${
          encodeURIComponent(PARENT)
        }&file=reader.sysml`,
      ],
    ],
  );
  const removed = [
    changed("old.sysml", "deleted", 0, 7),
    { ...changed("new/b.sysml", "renamed", 0, 0), previousPath: "a.sysml" },
  ];
  deepStrictEqual(
    activityFiles({ files: removed, main: true, version: HEAD }).map((file) => [
      file.path,
      file.previousPath,
      file.href,
    ]),
    [
      ["old.sysml", undefined, undefined],
      ["new/b.sysml", "a.sysml", "/model?page=files&file=new%2Fb.sysml"],
    ],
  );
});

Deno.test("a proposal's files are those of its diff, read at the version it proposes", () => {
  const open = rows(groupsOf(), "waiting")[1];
  // Nothing is known of them before the change is read.
  deepStrictEqual(activityFiles(open), []);
  const diff = {
    ...diffBetween(HEAD, PROPOSED),
    files: [
      { path: "a.sysml", kind: "added" as const, additions: 3, deletions: 0 },
      { path: "b.sysml", kind: "changed" as const, additions: 1, deletions: 1 },
      { path: "c.sysml", kind: "deleted" as const, additions: 0, deletions: 4 },
    ],
  };
  const files = activityFiles(open, diff);
  deepStrictEqual(
    files.map((
      file,
    ) => [file.path, file.status, file.additions, file.deletions]),
    [
      ["a.sysml", "added", 3, 0],
      ["b.sysml", "modified", 1, 1],
      ["c.sysml", "deleted", 0, 4],
    ],
  );
  const at = encodeURIComponent(PROPOSED);
  deepStrictEqual(files.map((file) => file.href), [
    `/model?page=files&version=${at}&file=a.sysml`,
    `/model?page=files&version=${at}&file=b.sysml`,
    undefined,
  ]);
});

Deno.test("the files of a commit are Git's own, whatever the text diff says", () => {
  const [head] = rows(groupsOf(), "accepted");
  const other = {
    ...diffBetween(PARENT, HEAD),
    files: [
      { path: "x.sysml", kind: "added" as const, additions: 1, deletions: 0 },
    ],
  };
  deepStrictEqual(
    activityFiles(head, other).map((file) => file.path),
    ["configuration.sysml"],
  );
});

Deno.test("the feed is the same for the same snapshot", () => {
  const snapshot: RevisionSnapshot = history();
  deepStrictEqual(groupsOf(snapshot), groupsOf(snapshot));
  ok(rows(groupsOf(snapshot), "accepted").length > 0);
});
