import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { act } from "preact/test-utils";
import type {
  ModelView,
  ModelViewList,
} from "../../../../src/domain/model/records/diagram-views.ts";
import { probeRoot } from "../../../test/support/hook-probe.ts";
import { modelFeed } from "../../../test/support/model-feed.ts";
import type { ViewsApi } from "../../../lib/model/diagrams/api.ts";
import { type SysmlPageProps, useSysmlPage } from "./useSysmlPage.ts";

const HEAD = `commit:${"a".repeat(40)}`, NEXT = `commit:${"b".repeat(40)}`;
const view = (id: string): ModelView => ({
  id,
  title: id,
  kind: "tree",
  group: "definitions",
  element: id,
  nodes: 1,
  edges: 0,
  diagram: { nodes: [{ id, name: id, kind: "block", rows: [] }], edges: [] },
});
const list: ModelViewList = {
  toolkit: "0.10.10",
  views: [view("A"), view("B")],
  diagnostics: [],
  digest: "d",
};
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
};

Deno.test("view navigation reuses the versioned list, never reads PlantUML, and pinned pages ignore live announcements", async () => {
  const root = probeRoot(), feed = modelFeed(), reads: string[] = [];
  let page!: ReturnType<typeof useSysmlPage>;
  const api: ViewsApi = {
    list: (version) => {
      reads.push(`list:${version}`);
      return Promise.resolve({ version: version ?? HEAD, list });
    },
    diagram: (version, id) => {
      reads.push(`diagram:${version}:${id}`);
      return Promise.resolve(view(id));
    },
    plantuml: () => {
      throw new Error("Unexpected export");
    },
  };
  function Probe(props: SysmlPageProps) {
    page = useSysmlPage(props);
    return null;
  }
  const show = (search: string) =>
    root.show(Probe, { location: { search }, api, live: feed.live });
  try {
    await show(`?version=${HEAD}&view=A`);
    await settle();
    equal(page.view?.id, "A");
    await show(`?version=${HEAD}&view=B`);
    await settle();
    equal(page.view?.id, "B");
    feed.tell(NEXT);
    await settle();
    deepStrictEqual(reads, [
      `list:${HEAD}`,
      `diagram:${HEAD}:A`,
      `diagram:${HEAD}:B`,
    ]);
  } finally {
    await root.restore();
  }
});
Deno.test("a late diagram from another version cannot replace the view currently selected", async () => {
  const root = probeRoot();
  let resolveOld!: (view: ModelView) => void,
    oldSignal: AbortSignal | undefined;
  let page!: ReturnType<typeof useSysmlPage>;
  const api: ViewsApi = {
    list: (version) => Promise.resolve({ version: version ?? HEAD, list }),
    diagram: (version, id, signal) => {
      if (version === HEAD) {
        oldSignal = signal;
        return new Promise((resolve) => resolveOld = resolve);
      }
      return Promise.resolve(view(id));
    },
    plantuml: () => Promise.resolve(""),
  };
  function Probe(props: SysmlPageProps) {
    page = useSysmlPage(props);
    return null;
  }
  try {
    await root.show(Probe, {
      location: { search: `?version=${HEAD}&view=A` },
      api,
    });
    await settle();
    await root.show(Probe, {
      location: { search: `?version=${NEXT}&view=B` },
      api,
    });
    await settle();
    equal(page.view?.id, "B");
    ok(oldSignal?.aborted);
    resolveOld(view("A"));
    await settle();
    equal(page.view?.id, "B");
    equal(page.listing?.version, NEXT);
  } finally {
    await root.restore();
  }
});

Deno.test("an open live diagram reloads automatically on publication and ignores the previous render", async () => {
  const root = probeRoot(), feed = modelFeed();
  const reads: string[] = [];
  let head = HEAD;
  let oldSignal: AbortSignal | undefined;
  let resolveOld!: (value: ModelView) => void;
  let page!: ReturnType<typeof useSysmlPage>;
  const api: ViewsApi = {
    list: (version) => Promise.resolve({ version: version ?? head, list }),
    diagram: (version, id, signal) => {
      reads.push(`${version}:${id}`);
      if (version === HEAD) {
        oldSignal = signal;
        return new Promise((resolve) => resolveOld = resolve);
      }
      return Promise.resolve({ ...view(id), title: "Published diagram" });
    },
    plantuml: () => {
      throw new Error("No export requested");
    },
  };
  function Probe(props: SysmlPageProps) {
    page = useSysmlPage(props);
    return null;
  }
  try {
    await root.show(Probe, {
      location: { search: "?view=A" },
      api,
      live: feed.live,
    });
    await settle();
    head = NEXT;
    feed.tell(NEXT);
    await settle();
    equal(page.listing?.version, NEXT);
    equal(page.view?.title, "Published diagram");
    ok(oldSignal?.aborted);
    resolveOld({ ...view("A"), title: "Stale diagram" });
    await settle();
    equal(page.view?.title, "Published diagram");
    deepStrictEqual(reads, [`${HEAD}:A`, `${NEXT}:A`]);
  } finally {
    await root.restore();
  }
});
