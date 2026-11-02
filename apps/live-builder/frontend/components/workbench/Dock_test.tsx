import { act } from "preact/test-utils";
import type { RefObject } from "preact";
import { probeRoot } from "../../test/support/hook-probe.ts";
import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { renderToString } from "preact-render-to-string";
import { renderLinks } from "../../test/support/links.ts";
import {
  byRole,
  inOrder,
  nameOf,
  queryByRole,
  textOf,
  within,
} from "../../test/support/dom.ts";
import {
  captureDockResizeFocus,
  Dock,
  type DockPlace,
  type DockWork,
  DockWorkList,
  restoreDockResizeFocus,
  useDockSlots,
} from "./Dock.tsx";

function work(agentId: string, patch: Partial<DockWork> = {}): DockWork {
  return {
    kind: "agent",
    id: agentId,
    name: agentId,
    href: `/chat?agent=${agentId}`,
    busy: false,
    pending: false,
    active: false,
    ...patch,
  };
}

const places: DockPlace[] = [{
  id: "system",
  label: "System",
  href: "/system",
  pending: false,
  active: false,
}, {
  id: "model",
  label: "Model",
  href: "/model",
  pending: true,
  active: false,
}, {
  id: "decide",
  label: "To decide",
  href: "/decide",
  pending: false,
  active: false,
  count: 2,
}];

function render(
  items: DockWork[],
  options: {
    talking?: boolean;
    pending?: boolean;
    busy?: boolean;
    places?: DockPlace[];
  } = {},
) {
  return renderToString(
    <Dock
      work={items}
      places={options.places ?? places}
      central={{
        name: "Coordinator",
        busy: options.busy ?? false,
        pending: options.pending ?? false,
      }}
      talking={options.talking ?? false}
      onTalk={() => {}}
    />,
  );
}

const TALK = { name: "Talk to Coordinator" };
/** The links of the places, in the order the Dock shows them. */
const placeLinks = (html: string) =>
  within(byRole(html, "list", { name: "Places" })).allByRole("link");

Deno.test("the Casys logo is a real button between work and the places that opens the central conversation", () => {
  const html = render([work("collector")]);
  const dock = within(html);
  const nav = dock.byRole("navigation", { name: "Dock (Control+Shift+D)" });
  const talk = dock.byRole("button", TALK);
  equal(talk.getAttribute("type"), "button");
  equal(talk.getAttribute("aria-keyshortcuts"), "Control+Shift+D");
  equal(talk.getAttribute("aria-expanded"), "false");
  equal(talk.getAttribute("aria-controls"), "chat-panel");
  // The logo itself: the site's solid Casys disc.
  const logo = talk.querySelector("svg");
  equal(logo?.getAttribute("viewBox"), "69.5 69.5 236 236");
  deepStrictEqual(
    ["cx", "cy", "r", "fill"].map((name) =>
      logo?.firstElementChild?.getAttribute(name)
    ),
    ["187.5", "187.5", "118", "#a48ea4"],
  );
  // Work, the logo, then the places after the separator kept for watches.
  const places = placeLinks(html);
  deepStrictEqual(places.map(nameOf), [
    "System",
    "Model, decision waiting",
    "To decide, 2 pending",
  ]);
  ok(inOrder(
    dock.byRole("link", { name: "collector" }),
    talk,
    nav.querySelector(".dock-separator"),
    ...places,
  ));
  equal(
    byRole(render([], { talking: true }), "button", TALK)
      .getAttribute("aria-expanded"),
    "true",
  );
});

Deno.test("work in progress grows to the left: the oldest item stays next to the circle", () => {
  const dock = within(render([work("first"), work("second"), work("third")]));
  const items = within(dock.byRole("list", { name: "Work in progress" }))
    .allByRole("link");
  deepStrictEqual(items.map(nameOf), ["third", "second", "first"]);
  ok(inOrder(items[2], dock.byRole("button", TALK)));
  // The tile shows the monogram; the name is the label.
  match(textOf(items[2]), /^fi first$/i);
});

Deno.test("dock items mark a waiting decision, work in progress and the opened view", () => {
  const dock = within(render([
    work("collector", { pending: true, busy: true }),
    work("analyst", { active: true, href: "/" }),
  ]));
  const collector = dock.byRole("link", {
    name: "collector, working, decision waiting",
    current: false,
  });
  equal(collector.getAttribute("href"), "/chat?agent=collector");
  ok(collector.classList.contains("is-busy"));
  const analyst = dock.byRole("link", { name: "analyst", current: "page" });
  equal(analyst.getAttribute("href"), "/");
  ok(analyst.classList.contains("is-active"));
  ok(!analyst.classList.contains("is-busy"));
  // The collector's badge, and Model's for its waiting proposal.
  equal(dock.root.querySelectorAll(".dock-badge").length, 2);
});

Deno.test("an empty Dock keeps the logo alone, without an empty work list", () => {
  const dock = within(render([]));
  equal(dock.queryByRole("list", { name: "Work in progress" }), null);
  equal(dock.root.querySelector("[data-agent-id]"), null);
  // The work group stays, for the Requests link.
  ok(dock.root.querySelector(".dock-work"));
  dock.byRole("button", TALK);
});

Deno.test("the circle announces a waiting decision for the central agent without an avatar", () => {
  const dock = within(render([], { pending: true, busy: true }));
  const talk = dock.byRole("button", TALK);
  ok(talk.classList.contains("is-busy"));
  const status = talk.getAttribute("aria-describedby");
  equal(
    textOf(dock.root.querySelector(`[id="${status}"]`)!),
    "A decision is waiting",
  );
  doesNotMatch(render([]), /dock-circle-status/);
});

Deno.test("when work does not fit, the oldest items share one pile next to the circle", () => {
  const items = ["a", "b", "c", "d", "e", "f"].map((id) =>
    work(id, id === "b" ? { pending: true, active: true } : {})
  );
  const html = renderToString(<DockWorkList work={items} slots={3} />);
  const list = within(html);
  // Two newest stay as tiles, newest first; four oldest are piled last.
  const tiles = list.allByRole("link");
  deepStrictEqual(tiles.map(nameOf), ["f", "e"]);
  doesNotMatch(html, /data-agent-id="[abcd]"/);
  const pile = list.byRole("button", { name: "4 earlier, decision waiting" });
  ok(inOrder(...tiles, pile));
  ok(pile.classList.contains("is-active"));
  equal(pile.getAttribute("aria-expanded"), "false");
  equal(pile.getAttribute("aria-controls"), "dock-pile-list");
  match(textOf(pile), /^\+4 /);
  equal(
    queryByRole(
      renderToString(<DockWorkList work={items} slots={6} />),
      "button",
    ),
    null,
  );
});

Deno.test("pinned work stands next to the Requests button, in pin order, and never piles", () => {
  const items = [
    work("a"),
    work("b"),
    work("c"),
    work("p", { pinned: true }),
    work("q", { pinned: true }),
  ];
  const html = renderToString(<DockWorkList work={items} slots={4} />);
  const list = within(html);
  // Two slots left for three unpinned: the oldest two share the pile.
  const pile = list.byRole("button", { name: "2 earlier" });
  const p = list.byRole("link", { name: "p, pinned" });
  ok(inOrder(
    list.byRole("link", { name: "c" }),
    pile,
    list.byRole("link", { name: "q, pinned" }),
    p,
  ));
  doesNotMatch(html, /data-agent-id="[ab]"/);
  match(textOf(pile), /^\+2 /);
  ok(p.classList.contains("is-pinned"));
  // With no room left, the unpinned all pile; the pinned still stand.
  const tight = within(renderToString(<DockWorkList work={items} slots={2} />));
  tight.byRole("link", { name: "p, pinned" });
  tight.byRole("link", { name: "q, pinned" });
  match(textOf(tight.byRole("button", { name: "3 earlier" })), /^\+3 /);
});

Deno.test("system, model and To decide are Dock tiles that mark the open view and what waits", () => {
  const html = render([], {
    places: [{ ...places[0], active: true, href: "/" }, places[1], places[2]],
  });
  const dock = within(html);
  const system = dock.byRole("link", { name: "System", current: "page" });
  equal(system.id, "system-link");
  equal(system.getAttribute("href"), "/");
  ok(system.classList.contains("is-active"));
  const model = dock.byRole("link", { name: "Model, decision waiting" });
  equal(model.id, "model-link");
  equal(model.getAttribute("href"), "/model");
  equal(model.getAttribute("aria-current"), null);
  // Closed, System is a link to its own address.
  const closed = byRole(render([]), "link", { name: "System", current: false });
  equal(closed.getAttribute("href"), "/system");
});

Deno.test("To decide is a place like the others: a link to /decide with the count of what waits", () => {
  const html = render([]);
  const decide = byRole(html, "link", { name: "To decide, 2 pending" });
  equal(decide.id, "decide-link");
  equal(decide.getAttribute("href"), "/decide");
  // The count, then the label, both drawn for the eye only.
  equal(textOf(decide), "2 To decide");
  // The tile is the place's own icon, after System and Model, in the places list.
  deepStrictEqual(placeLinks(html).map((link) => link.id), [
    "system-link",
    "model-link",
    "decide-link",
  ]);
  match(decide.querySelector("svg path")?.getAttribute("d") ?? "", /^M4 13\.5/);
  // Nothing waits: no count, but the place stays and says so.
  const none = byRole(
    render([], {
      places: [places[0], places[1], { ...places[2], count: 0 }],
    }),
    "link",
    { name: "To decide, 0 pending" },
  );
  equal(textOf(none), "To decide");
  // Open: it closes back to the desk, as every place does.
  const open = byRole(
    render([], {
      places: [places[0], places[1], { ...places[2], active: true, href: "/" }],
    }),
    "link",
    { name: "To decide, 2 pending", current: "page" },
  );
  equal(open.getAttribute("href"), "/");
  ok(open.classList.contains("is-active"));
});

Deno.test("the places are links, never buttons that unfold", () => {
  const html = render([work("collector")]);
  const list = byRole(html, "list", { name: "Places" });
  equal(queryByRole(list, "button"), null);
  equal(list.querySelector("[aria-expanded], [aria-controls]"), null);
  equal(placeLinks(html).length, 3);
});

Deno.test("Jobs and Watches each stand behind one button right of the logo, before the places", () => {
  const html = renderToString(
    <Dock
      work={[work("collector")]}
      stacks={[{
        id: "jobs",
        label: "Jobs",
        items: [],
        empty:
          "No jobs yet. Ask Coordinator for something to do on a schedule.",
      }, {
        id: "watches",
        label: "Watches",
        items: [{
          kind: "case",
          caseType: "watch",
          id: "s:case:9",
          name: "Offers",
          detail: "next check in 2 hours",
          href: "/chat?case=s%3Acase%3A9",
          busy: false,
          pending: false,
          active: false,
        }],
        empty: "No watches yet.",
      }]}
      places={places}
      central={{ name: "Coordinator", busy: false, pending: false }}
      talking={false}
      onTalk={() => {}}
    />,
  );
  doesNotMatch(html, /data-state=/);
  const dock = within(html);
  const stacks = within(dock.byRole("list", { name: "Jobs and watches" }));
  const jobs = stacks.byRole("button", { name: "Jobs" });
  const watches = stacks.byRole("button", { name: "Watches (1)" });
  ok(inOrder(
    dock.byRole("button", TALK),
    jobs,
    watches,
    dock.root.querySelector(".dock-separator"),
  ));
  // Folded by default: the stack names its count, the list is not rendered.
  equal(watches.getAttribute("aria-expanded"), "false");
  doesNotMatch(html, /data-case-id="s:case:9"/);
});

Deno.test("following the Requests link in this tab says so, a new tab does not", () => {
  let followed = 0;
  const dock = renderLinks(
    <Dock
      work={[]}
      cases={{ href: "/cases", active: true, onNavigate: () => followed++ }}
      places={places}
      central={{ name: "Coordinator", busy: false, pending: false }}
      talking={false}
      onTalk={() => {}}
    />,
  );
  const requests = byRole(dock.html, "link", { name: "Requests" });
  equal(requests.id, "cases-link");
  equal(requests.getAttribute("href"), "/cases");
  dock.click("cases-link", { metaKey: true });
  dock.click("cases-link", { ctrlKey: true });
  equal(followed, 0);
  dock.click("cases-link");
  equal(followed, 1);
});

Deno.test("model places expose their selected conversation by badge, hover, focus label and accessible name", () => {
  const contextual = places.map((place) =>
    place.id === "decide" ? place : {
      ...place,
      context: { name: "Request · Market analysis", tint: "request" as const },
    }
  );
  const system = byRole(render([], { places: contextual }), "link", {
    name: "System, Request · Market analysis",
  });
  ok(system.classList.contains("has-context"));
  ok(system.classList.contains("is-context-request"));
  equal(system.getAttribute("title"), "System · Request · Market analysis");
  // The badge, then the label the hover and the focus show.
  equal(textOf(system), "MA System · Request · Market analysis");
  // The Main is the default: its places carry no bubble.
  const main = byRole(
    render([], {
      places: places.map((place) =>
        place.id === "decide" ? place : {
          ...place,
          context: { name: "Main Operator", tint: "designer" as const },
        }
      ),
    }),
    "link",
    { name: "System, Main Operator" },
  );
  equal(textOf(main), "System · Main Operator");
});

Deno.test("measured Dock capacity follows growth, shrink and the fixed Requests link", async () => {
  const root = probeRoot();
  const listeners = root.windowListeners();
  const oldObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver",
  );
  const oldStyle = Object.getOwnPropertyDescriptor(
    globalThis,
    "getComputedStyle",
  );
  let callback: () => void = () => {};
  let disconnected = 0;
  let observed: unknown[] = [];
  class Observer {
    constructor(fn: () => void) {
      callback = fn;
      observed = [];
    }
    observe(target: unknown) {
      observed.push(target);
    }
    disconnect() {
      disconnected++;
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: Observer,
  });
  let gap = 14, tile = 50, circleLeft = 420, hasCases = true;
  Object.defineProperty(globalThis, "getComputedStyle", {
    configurable: true,
    value: () => ({
      paddingLeft: "16px",
      getPropertyValue: (name: string) =>
        `${name === "--dock-gap" ? gap : tile}px`,
    }),
  });
  const circle = { getBoundingClientRect: () => ({ left: circleLeft }) };
  const link = { getBoundingClientRect: () => ({ width: tile }) };
  const element = {
    getBoundingClientRect: () => ({ left: 100 }),
    querySelector: (selector: string) =>
      selector === ".dock-circle"
        ? circle
        : selector === "#cases-link" && hasCases
        ? link
        : null,
  };
  const dock = { current: element } as unknown as RefObject<HTMLElement>;
  const workItems = ["a", "b", "c", "d", "e", "f"].map((id) => work(id));
  let slots = 0, html = "";
  function Probe(props: { cases: boolean }) {
    slots = useDockSlots(dock, props.cases, false);
    html = renderToString(<DockWorkList work={workItems} slots={slots} />);
    return null;
  }
  try {
    await root.show(Probe, { cases: true });
    equal(slots, 3);
    match(html, />\+4<\/span>/);
    equal(observed.length, 3);
    circleLeft = 612;
    await act(() => callback());
    equal(slots, 6);
    doesNotMatch(html, /dock-pile/);
    for (const item of workItems) {
      match(html, new RegExp(`data-agent-id="${item.id}"`));
    }
    circleLeft = 420;
    await act(() => callback());
    equal(slots, 3);
    match(html, />\+4<\/span>/);
    const oldCallback = callback;
    hasCases = false;
    await root.show(Probe, { cases: false });
    equal(slots, 4);
    equal(observed.length, 2);
    await act(() => oldCallback());
    equal(
      slots,
      4,
      "a queued callback from the old link cannot restore stale capacity",
    );
    gap = 10;
    tile = 42;
    const resize = listeners.find((entry) => entry.type === "resize");
    ok(resize);
    await act(() => resize.listener({}));
    equal(slots, 5);
    match(html, />\+2<\/span>/);
  } finally {
    await root.restore();
    ok(disconnected >= 2);
    equal(listeners.filter((entry) => entry.type === "resize").length, 0);
    if (oldObserver) {
      Object.defineProperty(globalThis, "ResizeObserver", oldObserver);
    } else Reflect.deleteProperty(globalThis, "ResizeObserver");
    if (oldStyle) {
      Object.defineProperty(globalThis, "getComputedStyle", oldStyle);
    } else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
});

Deno.test("resize preserves keyboard focus when a work tile enters or leaves the pile", () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  const body = {};
  const documentStub: { activeElement: unknown; body: unknown } = {
    activeElement: body,
    body,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentStub,
  });
  const make = (id?: string, pile = false, inDock = true) => {
    const node = {
      isConnected: true,
      closest(selector: string) {
        if (selector === ".dock-work") return inDock ? node : null;
        if (selector === "[data-case-id], [data-agent-id]") {
          return id ? node : null;
        }
        if (selector === "[data-dock-work-pile]") return pile ? node : null;
        return null;
      },
      getAttribute(name: string) {
        return name === "data-agent-id" ? id ?? null : null;
      },
      focus() {
        documentStub.activeElement = node;
      },
    };
    return node;
  };
  const items = [work("a"), work("b"), work("c")];
  const direct = make("a"),
    trigger = make(undefined, true),
    returned = make("b");
  let candidates: ReturnType<typeof make>[] = [];
  let pile: ReturnType<typeof make> | null = trigger;
  const dock = {
    contains: (node: unknown) =>
      node === direct || node === trigger || node === returned,
    querySelectorAll: () => candidates,
    querySelector: () => pile,
  } as unknown as HTMLElement;
  try {
    documentStub.activeElement = direct;
    const enter = captureDockResizeFocus(dock, items, 3, 2);
    ok(enter);
    direct.isConnected = false; // The focused tile moved into a closed pile.
    documentStub.activeElement = body;
    restoreDockResizeFocus(dock, enter);
    equal(documentStub.activeElement, trigger);
    const leave = captureDockResizeFocus(dock, items, 2, 3);
    ok(leave);
    trigger.isConnected = false; // The pile disappeared as its items became visible.
    documentStub.activeElement = body;
    pile = null;
    candidates = [returned];
    restoreDockResizeFocus(dock, leave);
    equal(documentStub.activeElement, returned);
    const outside = make("outside", false, false);
    documentStub.activeElement = outside;
    equal(captureDockResizeFocus(dock, items, 3, 2), null);
    // A user who moved focus elsewhere before the commit is never pulled back.
    documentStub.activeElement = direct;
    direct.isConnected = true;
    const pending = captureDockResizeFocus(dock, items, 3, 2);
    ok(pending);
    direct.isConnected = false;
    documentStub.activeElement = outside;
    restoreDockResizeFocus(dock, pending);
    equal(documentStub.activeElement, outside);
  } finally {
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
