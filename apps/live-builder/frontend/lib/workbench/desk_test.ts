import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  arrivalOrder,
  deskLocation,
  dockPile,
  dockSlots,
  followsLink,
  graphAddress,
  MODEL_PAGES,
  modelHref,
  modelPageOf,
  monogram,
  PLACE_PATH,
  SYSTEM_MORE,
  SYSTEM_PAGE_NAMES,
  SYSTEM_PAGES,
  SYSTEM_TABS,
  systemHref,
  systemPageFor,
  systemPageOf,
} from "./desk.ts";

const at = (path: string) => new URL(path, "https://atelier.test");

Deno.test("desk addresses open Dock items as views and the circle as the central conversation", () => {
  deepStrictEqual(deskLocation(at("/"), "coordinator"), {
    item: null,
    talk: false,
    details: null,
  });
  deepStrictEqual(deskLocation(at("/system"), "coordinator").item, {
    kind: "system",
    page: "team",
  });
  // An old link to a revision of the graph opens it on the Model place.
  deepStrictEqual(deskLocation(at("/model?revision=3"), "coordinator").item, {
    kind: "model",
    page: "graph",
  });
  deepStrictEqual(deskLocation(at("/revisions?proposal=p1"), null).item, {
    kind: "model",
    page: "revisions",
  });
  deepStrictEqual(deskLocation(at("/chat"), "coordinator"), {
    item: null,
    talk: true,
    details: null,
  });
  deepStrictEqual(deskLocation(at("/tools"), "coordinator"), {
    item: null,
    talk: true,
    details: "tools",
  });
  // The tools of a requested operator open beside the conversation.
  deepStrictEqual(deskLocation(at("/tools?agent=collector"), "coordinator"), {
    item: { kind: "agent", agentId: "collector" },
    talk: false,
    details: "tools",
  });
});

Deno.test("an agent address opens that operator beside the conversation, except the central agent", () => {
  deepStrictEqual(
    deskLocation(at("/chat?agent=native%3Acollector"), "coordinator"),
    {
      item: { kind: "agent", agentId: "native:collector" },
      talk: false,
      details: null,
    },
  );
  deepStrictEqual(
    deskLocation(at("/chat?agent=coordinator"), "coordinator"),
    { item: null, talk: true, details: null },
  );
  // Before the roster loads, the requested operator stays a Dock item.
  deepStrictEqual(deskLocation(at("/chat?agent=coordinator"), null).item, {
    kind: "agent",
    agentId: "coordinator",
  });
});

Deno.test("dock monograms tell agents apart without inventing icons", () => {
  equal(monogram("Collecteur"), "Co");
  equal(monogram("market analyst"), "MA");
  equal(monogram("<Relecteur>"), "Re");
  equal(monogram("Économiste"), "Éc");
  equal(monogram("—"), "?");
});

Deno.test("arrival order follows fixed ranks and keeps unranked work after, in catalogue order", () => {
  const thread = (agentId: string) => ({ agentId });
  const ordered = arrivalOrder(
    [thread("new"), thread("c"), thread("a"), thread("b"), thread("unranked")],
    new Map([["a", 1], ["b", 2], ["c", 3], ["new", 4]]),
  );
  deepStrictEqual(ordered.map((entry) => entry.agentId), [
    "a",
    "b",
    "c",
    "new",
    "unranked",
  ]);
});

Deno.test("a full Dock keeps the logo centred and gathers the oldest work in one pile", () => {
  // 1280 px: 640 - 32 half logo - 14 gap - 16 gutter leaves 578 px.
  equal(dockSlots({ room: 578, tile: 50, gap: 14 }), 9);
  equal(dockSlots({ room: 338, tile: 50, gap: 14 }), 5);
  // Even a phone keeps one slot, for the pile.
  equal(dockSlots({ room: 20, tile: 42, gap: 10 }), 1);
  deepStrictEqual(dockPile(3, 5), { piled: 0, shown: 3 });
  deepStrictEqual(dockPile(5, 5), { piled: 0, shown: 5 });
  deepStrictEqual(dockPile(12, 5), { piled: 8, shown: 4 });
  deepStrictEqual(dockPile(4, 1), { piled: 4, shown: 0 });
});

Deno.test("a Case is its own page; the designer's conversation stays closed", () => {
  for (const centralId of ["coordinator", null]) {
    deepStrictEqual(
      deskLocation(at("/chat?case=s%3Acase%3A2"), centralId),
      {
        item: { kind: "case", caseId: "s:case:2" },
        talk: false,
        details: null,
      },
    );
  }
  deepStrictEqual(deskLocation(at("/cases"), null).item, { kind: "cases" });
});

Deno.test("the Requests page names the Request it selects; the old Case addresses lead to it", () => {
  deepStrictEqual(
    deskLocation(at("/cases?case=s%3Acase%3A2"), "coordinator"),
    {
      item: { kind: "cases", caseId: "s:case:2" },
      talk: false,
      details: null,
    },
  );
  // A Case not opened yet is the Requests page with nothing selected.
  deepStrictEqual(deskLocation(at("/chat?case=new"), null).item, {
    kind: "cases",
  });
  // An empty selection is no selection.
  deepStrictEqual(deskLocation(at("/cases?case="), null).item, {
    kind: "cases",
  });
});

Deno.test("the Requests page names the sub-agent it reads in a Request, and only in one", () => {
  deepStrictEqual(
    deskLocation(at("/cases?case=s%3Acase%3A2&agent=collector"), null).item,
    { kind: "cases", caseId: "s:case:2", agentId: "collector" },
  );
  // No Request, no conversation to read: the list ignores the agent.
  deepStrictEqual(deskLocation(at("/cases?agent=collector"), null).item, {
    kind: "cases",
  });
});

Deno.test("only a plain click follows a link in this tab", () => {
  const click = {
    button: 0,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
  };
  equal(followsLink(click), true);
  // A new tab, a new window, the middle button and a handled click stay here.
  for (
    const other of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ]
  ) {
    equal(followsLink({ ...click, ...other }), false);
  }
});

Deno.test("System is /system, Model is /model, and /revisions stays an address of Model", () => {
  deepStrictEqual(PLACE_PATH, {
    system: "/system",
    model: "/model",
    decide: "/decide",
  });
  deepStrictEqual(deskLocation(at("/system"), "coordinator"), {
    item: { kind: "system", page: "team" },
    talk: false,
    details: null,
  });
  // The links of decisions and of commits that predate /model keep their
  // query: they open Revisions on that revision. The bare address opens the
  // first page, whichever of the two addresses it is.
  for (
    const old of [
      "/revisions?proposal=p1",
      "/revisions?commit=commit%3Aabc&from=empty",
      "/model?proposal=p1",
      "/model?commit=commit%3Aabc&from=empty",
    ]
  ) {
    deepStrictEqual(deskLocation(at(old), "coordinator"), {
      item: { kind: "model", page: "revisions" },
      talk: false,
      details: null,
    }, old);
  }
  for (const bare of ["/revisions", "/model"]) {
    deepStrictEqual(deskLocation(at(bare), "coordinator"), {
      item: { kind: "model", page: "activity" },
      talk: false,
      details: null,
    }, bare);
  }
  // No other path opens a place, and a look-alike never does.
  for (const other of ["/systems", "/system/", "/models", "/revisions/x"]) {
    deepStrictEqual(deskLocation(at(other), "coordinator").item, null, other);
  }
});

Deno.test("numeric execution links keep their graph; source and graph aliases open SysML", () => {
  for (
    const old of [
      "/model?revision=7",
      "/revisions?revision=7",
      "/revisions?page=graph&revision=7",
    ]
  ) {
    deepStrictEqual(deskLocation(at(old), "coordinator"), {
      item: { kind: "model", page: "graph" },
      talk: false,
      details: null,
    }, old);
  }
  for (
    const alias of [
      "/model?page=sysml",
      "/model?page=graph",
      "/revisions?page=graph",
      "/model?modelVersion=commit%3Aabc",
      "/model?page=graph&modelVersion=commit%3Aabc",
    ]
  ) {
    deepStrictEqual(deskLocation(at(alias), null).item, {
      kind: "model",
      page: "sysml",
    }, alias);
  }
  // A page the address names wins over the link's old meaning.
  deepStrictEqual(
    deskLocation(at("/model?page=files&revision=7"), null).item,
    { kind: "model", page: "files" },
  );
  // A revision of the history (not of the graph) still reads as Revisions.
  deepStrictEqual(
    deskLocation(at("/model?commit=commit%3Aabc&revision=7"), null).item,
    { kind: "model", page: "revisions" },
  );
});

Deno.test("the System place opens on Team, then Performance, Explore, Flows, Requirements and Rights as tabs, and ?page= or ?select= never leave it empty", () => {
  // The tabs, then the pages the More menu keeps: every page is exactly one of them.
  deepStrictEqual(SYSTEM_TABS, [
    "team",
    "performance",
    "explore",
    "flows",
    "requirements",
    "rights",
    "diagnostics",
  ]);
  deepStrictEqual(SYSTEM_MORE, ["parts", "allocations"]);
  deepStrictEqual(SYSTEM_PAGES, [...SYSTEM_TABS, ...SYSTEM_MORE]);
  deepStrictEqual(SYSTEM_PAGE_NAMES, {
    team: "Team",
    performance: "Performance",
    explore: "Explore",
    flows: "Flows",
    requirements: "Requirements",
    rights: "Rights",
    diagnostics: "Diagnostics",
    parts: "Parts",
    allocations: "Allocations",
  });
  const page = (address: string) => deskLocation(at(address), null).item;
  for (
    const address of [
      "/system",
      "/system?page=team",
      "/system?select=analyst",
      "/system?page=unknown",
      "/system?page=",
      "/system?page=__proto__",
      "/system?page=TEAM",
      // The graph and the files are pages of Model, not of System.
      "/system?page=graph",
      "/system?page=files",
    ]
  ) {
    deepStrictEqual(page(address), { kind: "system", page: "team" }, address);
  }
  equal(systemPageOf(at("/system?page=team")), "team");
  equal(systemPageOf(at("/system?page=performance")), "performance");
  equal(systemPageOf(at("/system?page=diagnostics")), "diagnostics");
  equal(systemHref("diagnostics"), "/system?page=diagnostics");
  equal(systemHref("performance"), "/system?page=performance");
  equal(systemPageOf(at("/system?page=nope")), "team");
  // Explore is named, and keeps what the address selects and the version it reads.
  equal(systemPageOf(at("/system?page=explore")), "explore");
  deepStrictEqual(
    deskLocation(at("/system?page=explore&select=x"), null).item,
    {
      kind: "system",
      page: "explore",
    },
  );
  // The pages of the More menu are named like the others, and open from their address.
  for (const page of SYSTEM_MORE) {
    equal(systemPageOf(at(`/system?page=${page}`)), page);
    equal(systemHref(page, { select: "x" }), `/system?page=${page}&select=x`);
  }
  equal(systemHref("explore"), "/system?page=explore");
  equal(
    systemHref("explore", { select: "a b", version: "commit:abc" }),
    "/system?page=explore&select=a+b&version=commit%3Aabc",
  );
  equal(systemHref("explore", { select: null }), "/system?page=explore");
  // A page link has the place's address; the first page is not named.
  equal(systemHref(), "/system");
  equal(systemHref("team"), "/system");
  equal(systemHref("team", { select: "unit-1" }), "/system?select=unit-1");
  equal(
    systemHref("team", { select: "a b&c" }),
    "/system?select=a+b%26c",
  );
  equal(systemHref("team", { select: null, version: undefined }), "/system");
  for (const page of SYSTEM_PAGES) {
    deepStrictEqual(deskLocation(at(systemHref(page)), null).item, {
      kind: "system",
      page,
    });
  }
});

Deno.test("To decide is a place of its own at /decide, whatever the query", () => {
  for (const address of ["/decide", "/decide?x=1", "/decide?page=graph"]) {
    deepStrictEqual(deskLocation(at(address), "coordinator"), {
      item: { kind: "decide" },
      talk: false,
      details: null,
    });
  }
  // No other address opens it, and it draws no graph.
  deepStrictEqual(deskLocation(at("/decided"), "coordinator").item, null);
  equal(graphAddress({ kind: "decide" }), null);
});

Deno.test("the Model place opens on Activity, a revision's link on Revisions, and ?page= names another of its pages", () => {
  deepStrictEqual(MODEL_PAGES, [
    "activity",
    "revisions",
    "files",
    "releases",
    "sysml",
  ]);
  const page = (address: string) => deskLocation(at(address), null).item;
  deepStrictEqual(page("/model"), { kind: "model", page: "activity" });
  // A link to a revision (a decision's, a commit's) reads as Revisions on it.
  for (
    const link of [
      "/model?proposal=p1",
      "/model?commit=commit%3Aabc",
      "/model?commit=commit%3Aabc&from=empty",
    ]
  ) {
    deepStrictEqual(page(link), { kind: "model", page: "revisions" }, link);
  }
  // A name with nothing behind it names no revision.
  deepStrictEqual(page("/model?commit="), {
    kind: "model",
    page: "activity",
  });
  // The page asked for wins, a revision's link or not.
  deepStrictEqual(page("/model?page=graph"), {
    kind: "model",
    page: "sysml",
  });
  deepStrictEqual(page("/model?page=graph&revision=7"), {
    kind: "model",
    page: "graph",
  });
  deepStrictEqual(page("/model?page=activity&proposal=p1"), {
    kind: "model",
    page: "activity",
  });
  deepStrictEqual(page("/model?page=revisions"), {
    kind: "model",
    page: "revisions",
  });
  // Files is a page of the place, whatever file, line and version it is given.
  for (
    const files of [
      "/model?page=files",
      "/model?page=files&file=lib%2Fa.sysml&line=12",
      `/model?page=files&version=commit%3A${"a".repeat(40)}`,
    ]
  ) {
    deepStrictEqual(page(files), { kind: "model", page: "files" });
  }
  // An unknown page never leaves the place empty: the address reads as it would
  // without it.
  for (const unknown of ["file", "", "GRAPH", "FILES", "__proto__"]) {
    deepStrictEqual(
      page(`/model?page=${unknown}`),
      { kind: "model", page: "activity" },
      unknown,
    );
    deepStrictEqual(
      page(`/model?page=${unknown}&commit=commit%3Aabc`),
      { kind: "model", page: "revisions" },
      unknown,
    );
  }
  // The Model place is read from either of its addresses.
  deepStrictEqual(page("/revisions?page=files"), {
    kind: "model",
    page: "files",
  });
});

Deno.test("the page an address of the Model place opens is read from the address alone", () => {
  const read = (search: string) =>
    modelPageOf(new URL(`/model${search}`, "https://atelier.test"));
  equal(read(""), "activity");
  equal(read("?commit=commit%3Aabc"), "revisions");
  equal(read("?proposal=p1"), "revisions");
  equal(read("?page=files&proposal=p1"), "files");
  equal(read("?from=empty"), "activity");
  // The links the graph's page always had: a revision, or a source version.
  equal(read("?revision=7"), "graph");
  equal(read("?modelVersion=commit%3Aabc"), "sysml");
  equal(read("?page=graph"), "sysml");
  equal(read("?page=sysml"), "sysml");
  equal(read("?page=sysml&revision=7"), "sysml");
  equal(read("?commit=commit%3Aabc&revision=7"), "revisions");
  equal(read("?proposal=p1&revision=7"), "revisions");
  equal(read("?revision="), "activity");
  equal(read("?page=revisions&revision=7"), "revisions");
});

Deno.test("a Request Model dock address defaults to Files while explicit pages and Main keep their meaning", () => {
  const read = (search: string) =>
    modelPageOf(new URL(`/model${search}`, "https://atelier.test"));
  const branch =
    "caseBranch=request-one&version=commit%3Aabc&conversation=main";
  equal(read(`?${branch}`), "files");
  deepStrictEqual(deskLocation(at(`/model?${branch}`), null).item, {
    kind: "model",
    page: "files",
  });
  for (const selected of ["files", "releases", "sysml", "activity"] as const) {
    equal(read(`?${branch}&page=${selected}`), selected);
  }
  equal(read("?version=commit%3Aabc&conversation=main"), "activity");
  equal(read(`?${branch}&commit=commit%3Aabc`), "revisions");
  equal(read(`?${branch}&modelVersion=commit%3Aabc`), "sysml");
  equal(read(`?${branch}&revision=7`), "graph");
});

Deno.test("a Model page link has the place's address, and the page an address reads without being told is not named", () => {
  equal(modelHref(), "/model");
  equal(modelHref("activity"), "/model");
  equal(modelHref("revisions"), "/model?page=revisions");
  equal(modelHref("graph"), "/model?page=graph");
  equal(modelHref("sysml"), "/model?page=sysml");
  equal(modelHref("files"), "/model?page=files");
  equal(
    modelHref("files", { file: "lib/a.sysml", line: "12" }),
    "/model?page=files&file=lib%2Fa.sysml&line=12",
  );
  // A revision of the graph is the link the graph always had: it reads as Graph.
  equal(modelHref("graph", { revision: "7" }), "/model?revision=7");
  equal(
    modelHref("graph", { modelVersion: "commit:abc" }),
    "/model?page=graph&modelVersion=commit%3Aabc",
  );
  equal(
    modelHref("files", { revision: "7" }),
    "/model?page=files&revision=7",
  );
  // A revision's link keeps its own parameter alone: it reads as Revisions.
  equal(
    modelHref("revisions", { commit: "commit:abc" }),
    "/model?commit=commit%3Aabc",
  );
  equal(
    modelHref("revisions", { proposal: "p 1", from: undefined }),
    "/model?proposal=p+1",
  );
  // A link to the first page drops what another page was given.
  equal(modelHref("activity", { revision: null }), "/model");
  // Another page than the one the parameters read as is named.
  equal(
    modelHref("activity", { commit: "commit:abc" }),
    "/model?page=activity&commit=commit%3Aabc",
  );
  equal(
    modelHref("graph", { commit: "commit:abc" }),
    "/model?page=graph&commit=commit%3Aabc",
  );
  // Every page link reads back as the page it names.
  for (const page of MODEL_PAGES) {
    deepStrictEqual(deskLocation(at(modelHref(page)), null).item, {
      kind: "model",
      page,
    });
    deepStrictEqual(
      deskLocation(at(modelHref(page, { commit: "commit:abc" })), null).item,
      { kind: "model", page },
    );
  }
});

Deno.test("the execution graph is drawn only for legacy execution revision links", () => {
  const graph = (path: string) =>
    graphAddress(deskLocation(at(path), "coordinator").item);
  // It keeps the revision inspections on its own address, whichever old link
  // or alias reached it.
  equal(graph("/model?page=graph"), null);
  equal(graph("/model?page=graph&revision=3"), "/model?page=graph");
  equal(graph("/model?revision=3"), "/model?page=graph");
  equal(graph("/model?modelVersion=commit%3Aabc"), null);
  equal(graph("/revisions?page=graph"), null);
  // No other page, place or conversation draws it, so none opens its stream.
  for (
    const other of [
      "/",
      "/chat",
      "/tools",
      "/cases",
      "/system",
      "/system?page=graph",
      "/model",
      "/revisions",
      "/model?commit=commit%3Aabc",
      "/model?page=unknown",
      "/model?page=sysml",
      "/model?page=files&file=a.sysml&line=3",
      "/chat?agent=collector",
    ]
  ) {
    equal(graph(other), null, other);
  }
  equal(graphAddress(null), null);
});

Deno.test("an element is at home on the System page that shows it as its subject; what has no page of its own is left to Explore", () => {
  equal(systemPageFor("team"), "team");
  equal(systemPageFor("structure"), "parts");
  equal(systemPageFor("behavior"), "flows");
  equal(systemPageFor("requirements"), "requirements");
  // Explore holds what no other page shows.
  equal(systemPageFor("explore"), "explore");
  // Every page it names is a page of the place.
  for (
    const home of [
      "team",
      "structure",
      "behavior",
      "requirements",
      "explore",
    ] as const
  ) {
    ok(SYSTEM_PAGES.includes(systemPageFor(home)), home);
  }
});
