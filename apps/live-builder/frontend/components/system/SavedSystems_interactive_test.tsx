import { replaceGlobals } from "../../test/support/globals.ts";
import { localSkillRelease } from "../../test/support/release-opening-fixture.ts";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { options, type VNode } from "preact";
import { act } from "preact/test-utils";
import { renderToString } from "preact-render-to-string";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { SavedSystems } from "./SavedSystems.tsx";
import type { SavedSystemsApi } from "../../lib/system/saved-systems.ts";

const source = {
  branch: { kind: "main" as const },
  sourceVersion: `commit:${"a".repeat(40)}`,
};
const other = { ...source, sourceVersion: `commit:${"b".repeat(40)}` };
const binding = {
  name: "v1",
  refOid: "c".repeat(40),
  commitOid: "a".repeat(40),
};
function handlers(makeNode: () => VNode) {
  const inputs: Array<(event: unknown) => void> = [],
    changes: Array<(event: unknown) => void> = [],
    submits: Array<(event: unknown) => void> = [],
    clicks: Array<() => void> = [];
  const previous = options.attr;
  options.attr = (name, value) => {
    if (typeof value === "function") {
      if (name === "oninput") inputs.push(value as (event: unknown) => void);
      if (name === "onchange") changes.push(value as (event: unknown) => void);
      if (name === "onsubmit") submits.push(value as (event: unknown) => void);
      if (name === "onclick") {
        clicks.push(value as () => void);
        return `data-press="${clicks.length - 1}"`;
      }
    }
    return previous?.(name, value);
  };
  try {
    const html = renderToString(makeNode());
    return {
      html,
      inputs,
      changes,
      submits,
      click(label: string) {
        const button = [
          ...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g),
        ]
          .find(([, , text]) =>
            text.replace(/<[^>]+>/g, "").trim().startsWith(label)
          );
        ok(button, `No button ${label}`);
        const marker = /data-press="(\d+)"/.exec(button[1]);
        ok(marker, `No handler for ${label}`);
        clicks[Number(marker[1])]();
      },
    };
  } finally {
    options.attr = previous;
  }
}
/** The host's answer to who this system is. */
const identity = () =>
  Promise.resolve(Response.json({ projectId: "p", systemId: "s" }));
/** A browser that keeps saved commands in `storage`, at a local origin. */
const browser = (storage: Map<string, string>) =>
  replaceGlobals({
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    location: { origin: "http://localhost" },
    fetch: identity,
  });
const event = (value: string) => ({ currentTarget: { value } });
/** The busy line while the catalogue is read or a Release retained. */
const READING = ">Reading…</p>";
/** An option offers the tag by its name alone. */
const option = (name: string) => `>${name}</option>`;
async function settleUntil(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  }
  ok(done(), "The expected asynchronous state did not settle.");
}

Deno.test("existing tag selection submits its original exact source and stale inventories cannot replace it", async () => {
  const root = probeRoot();
  root.windowListeners();
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.visibilityState = "visible";
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  const storage = new Map<string, string>();
  const restoreGlobals = browser(storage);
  const first = Promise.withResolvers<typeof binding[]>();
  const second = Promise.withResolvers<typeof binding[]>();
  let calls = 0;
  let terminal = false;
  let catalogueReads = 0;
  const sent: unknown[] = [];
  const api: SavedSystemsApi = {
    tags: () => (++calls === 1 ? first.promise : second.promise),
    list: () => {
      catalogueReads++;
      return Promise.resolve([]);
    },
    inspect: () => Promise.reject(new Error("unused")),
    save: (command) => {
      sent.push(command);
      if (!terminal) return Promise.reject(new Error("lost"));
      const view = localSkillRelease("rejected");
      return Promise.resolve({
        ...view,
        saveKey: command.saveKey,
        metadata: { name: command.name, purpose: command.purpose },
        origin: { projectId: "p", systemId: "s", executionSpaceId: "main" },
        source: { ...view.source!, ...command.source },
        status: "conflict" as const,
        manifest: null,
        digest: null,
        rejection: { code: "TAG_UNAVAILABLE" as const, tag: command.tag! },
      });
    },
  };
  let view!: ReturnType<typeof handlers>;
  function Probe(
    props: {
      selected: typeof source;
      invalidation?: number;
      connection?: "live" | "reconnecting";
    },
  ) {
    view = handlers(() =>
      SavedSystems({
        api,
        source: props.selected,
        initiallyCreating: true,
        catalogueInvalidation: props.invalidation,
        catalogueConnection: props.connection,
      })
    );
    return null;
  }
  try {
    await root.show(Probe, { selected: source });
    await root.show(Probe, { selected: other });
    await act(async () => {
      first.resolve([binding]);
      await first.promise;
    });
    ok(!view.html.includes(option("v1")));
    await act(async () => {
      second.resolve([{ ...binding, name: "v2", commitOid: "b".repeat(40) }]);
      await second.promise;
    });
    match(view.html, /v2/);
    await act(() => view.changes[0](event("v2")));
    await act(() => view.inputs[0](event("Title")));
    match(view.html, /value="Title"/);
    await act(() => view.inputs[1](event("Draft notes")));
    const draftRead = catalogueReads;
    await root.show(Probe, { selected: other, invalidation: 1 });
    await settleUntil(() =>
      catalogueReads > draftRead &&
      !view.html.includes(READING)
    );
    match(view.html, /value="Title"/);
    match(view.html, /Draft notes/);
    ok(!view.html.includes(">Refresh</button>"));
    await root.show(Probe, {
      selected: other,
      invalidation: 1,
      connection: "reconnecting" as const,
    });
    // A short status is announced, with the whole sentence in its tooltip.
    match(
      view.html,
      /role="status" title="Live updates are unavailable[^"]*">Not live<\/span>/,
    );
    match(view.html, />Refresh<\/button>/);
    const degradedRead = catalogueReads;
    const degradedTags = calls;
    await act(() => view.click("Refresh"));
    await settleUntil(() =>
      catalogueReads > degradedRead && calls > degradedTags &&
      !view.html.includes(READING)
    );
    match(view.html, /value="Title"/);
    match(view.html, /Draft notes/);
    equal(sent.length, 0);
    await root.show(Probe, {
      selected: other,
      invalidation: 1,
      connection: "live" as const,
    });
    ok(!view.html.includes(">Refresh</button>"));
    ok(!/class="proposal-accept"[^>]*disabled/.test(view.html), view.html);
    await act(() => view.submits[0]({ preventDefault() {} }));
    await settleUntil(() =>
      sent.length === 1 &&
      view.html.includes("Release creation may have been accepted")
    );
    equal(sent.length, 1, view.html);
    const beforeInvalidation = catalogueReads;
    await root.show(Probe, { selected: other, invalidation: 2 });
    await settleUntil(() =>
      catalogueReads > beforeInvalidation &&
      !view.html.includes(READING)
    );
    equal(sent.length, 1);
    match(view.html, /value="Title"/);
    match(view.html, /v2/);
    match(view.html, /Release creation may have been accepted/);
    const command = sent[0] as { source: unknown; tag: unknown };
    deepStrictEqual(command.source, other);
    deepStrictEqual(command.tag, { mode: "existing", name: "v2" });
    match(view.html, /Release creation may have been accepted/);
    await root.unmount();
    await root.show(Probe, { selected: other });
    await settleUntil(() =>
      view.html.includes("Release creation may have been accepted")
    );
    match(view.html, /Release creation may have been accepted/);
    match(view.html, /v2/);
    equal(sent.length, 1);
    terminal = true;
    await act(() => view.click("Retry release creation"));
    await settleUntil(() =>
      sent.length === 2 && storage.size === 0 &&
      view.html.includes("Choose another tag")
    );
    equal(sent.length, 2);
    equal(storage.size, 0);
    match(view.html, /Choose another tag and create a new release/);
  } finally {
    await root.restore();
    restoreGlobals();
  }
});

Deno.test("an uncertain A1 command can resume at its historical source after the admitted Request advances", async () => {
  const root = probeRoot();
  root.windowListeners();
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.visibilityState = "visible";
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  const storage = new Map<string, string>();
  const restoreGlobals = browser(storage);
  const a1 = {
    branch: { kind: "case" as const, caseId: "caseA" },
    sourceVersion: `commit:${"a".repeat(40)}`,
  };
  const a2 = { ...a1, sourceVersion: `commit:${"b".repeat(40)}` };
  const sent: Parameters<SavedSystemsApi["save"]>[0][] = [];
  let terminal = false;
  const api: SavedSystemsApi = {
    tags: (source) =>
      Promise.resolve([{
        name: "v-a1",
        refOid: source.sourceVersion.slice(7),
        commitOid: source.sourceVersion.slice(7),
      }]),
    list: () => Promise.resolve([]),
    inspect: () => Promise.reject(new Error("unused")),
    save: (command) => {
      sent.push(structuredClone(command));
      if (!terminal) return Promise.reject(new Error("acknowledgement lost"));
      const old = localSkillRelease("stale", "caseA");
      return Promise.resolve({
        ...old,
        saveKey: command.saveKey,
        metadata: { name: command.name, purpose: command.purpose },
        origin: {
          projectId: "p",
          systemId: "s",
          executionSpaceId: "space-caseA",
        },
        source: { ...old.source!, ...command.source },
        status: "conflict" as const,
        manifest: null,
        digest: null,
        rejection: { code: "SOURCE_STALE" as const, tag: command.tag! },
      });
    },
  };
  let view!: ReturnType<typeof handlers>;
  function Probe(props: { selected: typeof a1; canCreate: boolean }) {
    view = handlers(() =>
      SavedSystems({
        api,
        source: props.selected,
        canCreate: props.canCreate,
        initiallyCreating: true,
      })
    );
    return null;
  }
  try {
    await root.show(Probe, { selected: a1, canCreate: true });
    // The catalogue opening is a real controller flight. Wait for it before
    // submitting, as a user can only activate the button once it is enabled.
    await settleUntil(() =>
      !view.html.includes(READING) &&
      view.html.includes(option("v-a1"))
    );
    await act(() => view.changes[0](event("v-a1")));
    await act(() => view.inputs[0](event("v-a1")));
    await act(() => view.inputs[1](event("Original A1")));
    match(view.html, /value="v-a1"/);
    match(view.html, /value="Original A1"/);
    ok(!/class="proposal-accept"[^>]*disabled/.test(view.html), view.html);
    await act(() => view.submits[0]({ preventDefault() {} }));
    await settleUntil(() =>
      sent.length === 1 &&
      view.html.includes("Release creation may have been accepted")
    );
    const original = structuredClone(sent[0]);
    deepStrictEqual(original.tag, { mode: "existing", name: "v-a1" });
    await root.show(Probe, { selected: a2, canCreate: true });
    await settleUntil(() =>
      view.html.includes("Reopen release at original source")
    );
    match(view.html, /Retry release creation/);
    match(view.html, /<button[^>]*disabled[^>]*>Retry release creation/);
    equal(sent.length, 1);
    await root.show(Probe, { selected: a1, canCreate: false });
    await settleUntil(() =>
      view.html.includes("Release creation may have been accepted") &&
      !view.html.includes(READING)
    );
    match(view.html, /An exact eligible source is required/);
    ok(!view.html.includes("saved-systems-form"));
    ok(
      !/<button[^>]*disabled[^>]*>Retry release creation/.test(view.html),
      view.html,
    );
    terminal = true;
    await act(() => view.click("Retry release creation"));
    await settleUntil(() =>
      sent.length === 2 && storage.size === 0 &&
      view.html.includes("selected source is no longer eligible")
    );
    deepStrictEqual(sent[1], original);
    equal(storage.size, 0);
    match(view.html, /Reopen an eligible source/);
  } finally {
    await root.restore();
    restoreGlobals();
  }
});

Deno.test("entering fresh creation clears an earlier inspection and keeps a newly acknowledged result", async () => {
  const root = probeRoot();
  root.windowListeners();
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.visibilityState = "visible";
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  const storage = new Map<string, string>();
  const restoreGlobals = browser(storage);
  const request = {
    ...localSkillRelease("request-release", "caseA"),
    metadata: { name: "Old Request Release", purpose: "Previous inspection" },
    origin: { projectId: "p", systemId: "s", executionSpaceId: "space-caseA" },
    status: "retained" as const,
    issues: [],
  };
  const api: SavedSystemsApi = {
    list: () => Promise.resolve([request]),
    tags: () => Promise.resolve([binding]),
    inspect: () => Promise.resolve(request),
    save: (command) =>
      Promise.resolve({
        ...localSkillRelease("new-release"),
        saveKey: command.saveKey,
        metadata: { name: command.name, purpose: command.purpose },
        origin: { projectId: "p", systemId: "s", executionSpaceId: "main" },
        source: { ...localSkillRelease().source!, ...command.source },
        status: "conflict" as const,
        manifest: null,
        digest: null,
        rejection: { code: "TAG_UNAVAILABLE" as const, tag: command.tag! },
      }),
  };
  let view!: ReturnType<typeof handlers>;
  function Probe(props: { creating: boolean }) {
    view = handlers(() =>
      SavedSystems({ api, source, initiallyCreating: props.creating })
    );
    return null;
  }
  try {
    await root.show(Probe, { creating: false });
    await settleUntil(() => view.html.includes("Old Request Release"));
    await act(() => view.click("Old Request Release"));
    await settleUntil(() =>
      view.html.includes('aria-label="Release details"') &&
      view.html.includes("Previous inspection")
    );
    await root.show(Probe, { creating: true });
    await settleUntil(() => view.html.includes(option("v1")));
    ok(!view.html.includes("Previous inspection"));
    ok(!view.html.includes("Create another release"));
    await act(() => view.changes[0](event("v1")));
    await act(() => view.inputs[0](event("New Main Release")));
    await act(() => view.submits[0]({ preventDefault() {} }));
    await settleUntil(() =>
      view.html.includes("New Main Release") &&
      view.html.includes("Choose another tag")
    );
    match(view.html, /Create another release/);
  } finally {
    await root.restore();
    restoreGlobals();
  }
});

Deno.test("shared Release generations refresh same-source views and session changes fence late reads", async () => {
  const root = probeRoot();
  const windowListeners = root.windowListeners();
  const documentListeners = new Map<string, () => void>();
  const doc = globalThis.document as unknown as Record<string, unknown>;
  doc.visibilityState = "visible";
  doc.addEventListener = (name: string, listener: () => void) =>
    documentListeners.set(name, listener);
  doc.removeEventListener = (name: string) => documentListeners.delete(name);
  const restoreFetch = replaceGlobals({ fetch: identity });
  let reads = 0;
  let commands = 0;
  let blocked = false;
  let lateSignal: AbortSignal | undefined;
  const late = Promise.withResolvers<ReturnType<typeof localSkillRelease>[]>();
  const api: SavedSystemsApi = {
    tags: () => Promise.resolve([]),
    list: (signal) => {
      reads++;
      if (blocked) {
        lateSignal = signal;
        blocked = false;
        return late.promise;
      }
      return Promise.resolve([{
        ...localSkillRelease("current"),
        metadata: { name: `Current ${reads}`, purpose: "" },
      }]);
    },
    save: () => {
      commands++;
      throw new Error("unused");
    },
    inspect: () => {
      commands++;
      throw new Error("unused");
    },
  };
  let view!: ReturnType<typeof handlers>;
  function Probe(props: { invalidation: number; session: number }) {
    view = handlers(() =>
      SavedSystems({
        api,
        source,
        catalogueInvalidation: props.invalidation,
        sessionGeneration: props.session,
      })
    );
    return null;
  }
  try {
    await root.show(Probe, { invalidation: 0, session: 0 });
    await settleUntil(() => view.html.includes("Current 1"));
    // A stream reopen increments the generation even with the exact same head.
    await root.show(Probe, { invalidation: 1, session: 0 });
    await settleUntil(() => view.html.includes("Current 2"));
    blocked = true;
    await root.show(Probe, { invalidation: 2, session: 0 });
    await settleUntil(() => lateSignal !== undefined);
    await root.show(Probe, { invalidation: 2, session: 1 });
    await settleUntil(() => view.html.includes("Current 4"));
    equal(lateSignal!.aborted, true);
    await act(async () => {
      late.resolve([{
        ...localSkillRelease("private-old"),
        metadata: { name: "Protected old session", purpose: "" },
      }]);
      await late.promise;
    });
    ok(!view.html.includes("Protected old session"));
    match(view.html, /Current 4/);
    doc.visibilityState = "hidden";
    await root.show(Probe, { invalidation: 3, session: 1 });
    equal(reads, 4);
    doc.visibilityState = "visible";
    await act(() => documentListeners.get("visibilitychange")!());
    await settleUntil(() => view.html.includes("Current 5"));
    equal(commands, 0);
    await root.unmount();
    equal(windowListeners.length, 0);
    equal(documentListeners.size, 0);
  } finally {
    await root.restore();
    restoreFetch();
  }
});
