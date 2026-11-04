import { equal, match, ok } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { Workspace } from "../../islands/Workbench.tsx";
import {
  createWorkbenchState,
  type WorkbenchEventSource,
} from "../../lib/workbench/state.ts";
import { caseRecord, caseScope } from "../support/case-fixture.ts";
import { replaceGlobals } from "../support/globals.ts";
import { withMountedDom } from "../support/mounted-dom.ts";
import { snapshot } from "../support/workbench-fixture.ts";

const record = caseRecord(1, { id: "request-one" });
const refusal = "The selected Request is unavailable";

class Events implements WorkbenchEventSource {
  listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  closed = false;
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  open() {
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }
  emit(type: string, value: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(value) });
    }
  }
  close() {
    this.closed = true;
  }
}

async function settle() {
  for (let i = 0; i < 12; i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
  }
}

for (const failure of ["business", "session"] as const) {
  Deno.test(`Request ${failure} refusal has the right session and stream lifecycle`, async () => {
    await withMountedDom(async (document) => {
      const win = document.defaultView!;
      let intervalTime = 0, intervalId = 0;
      const intervals = new Map<number, {
        callback: () => void;
        period: number;
        next: number;
      }>();
      const onlineListeners = new Set<EventListenerOrEventListenerObject>();
      const restore = replaceGlobals({
        location: win.location,
        localStorage: win.localStorage,
        getComputedStyle: win.getComputedStyle.bind(win),
        addEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) {
          if (type === "online") onlineListeners.add(listener);
          win.addEventListener(type, listener);
        },
        removeEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject,
        ) {
          if (type === "online") onlineListeners.delete(listener);
          win.removeEventListener(type, listener);
        },
        setInterval(callback: () => void, period: number) {
          const id = ++intervalId;
          intervals.set(id, { callback, period, next: intervalTime + period });
          return id;
        },
        clearInterval(id: number) {
          intervals.delete(id);
        },
      });
      const advanceIntervals = async (milliseconds: number) => {
        const end = intervalTime + milliseconds;
        while (true) {
          const due = [...intervals.values()].filter((timer) =>
            timer.next <= end
          )
            .sort((a, b) => a.next - b.next)[0];
          if (!due) break;
          intervalTime = due.next;
          due.next += due.period;
          due.callback();
          await settle();
        }
        intervalTime = end;
        await settle();
      };
      const sources: Events[] = [];
      let posts = 0, reads = 0;
      let latest = "Before persisted progress";
      let rejectNext = false;
      let offline = false;
      const host = { projectId: "git:project", systemId: "ui-fixture" };
      const collection = { systemId: host.systemId, cases: [record] };
      const conversations = {
        systemId: "runtime-projection",
        defaultAgentId: "owner",
        version: "v1",
        conversations: [{
          agentId: "owner",
          nativeId: "native:coordinator",
          runtimeOwned: true,
          name: "Owner",
          responsibility: "Answer",
          primary: false,
          canSend: false,
          revision: 1,
          busy: false,
          phase: "Ready",
          modelDigest: "c".repeat(64),
          repositoryVersion: `commit:${"a".repeat(40)}`,
          messages: [{
            id: "persisted-message",
            role: "assistant",
            text: latest,
            at: "2026-11-04T00:00:00Z",
            caseId: record.id,
          }],
        }],
      };
      const state = createWorkbenchState({
        initialState: snapshot(),
        eventSourceFactory: () => {
          const events = new Events();
          sources.push(events);
          // A real EventSource opens asynchronously after its listeners exist.
          queueMicrotask(() => events.open());
          return events;
        },
        fetch: (path) => {
          if (path === "/api/environment") {
            return Promise.resolve(
              Response.json({ environment: "development" }),
            );
          }
          if (path === "/api/space-session/local") {
            posts++;
            return Promise.resolve(Response.json({
              expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            }));
          }
          if (path === "/api/request-space-openings/context") {
            return Promise.resolve(Response.json(host));
          }
          if (path === "/api/cases?space=requests") {
            return Promise.resolve(Response.json(collection));
          }
          if (path === "/api/cases/request-one?space=requests") {
            return Promise.resolve(
              Response.json({ systemId: host.systemId, case: record }),
            );
          }
          if (path === "/api/case-model/request-one") {
            return Promise.resolve(
              Response.json(
                caseScope("request-one", `commit:${"a".repeat(40)}`),
              ),
            );
          }
          if (path === "/api/conversations?caseId=request-one") {
            reads++;
            if (offline) {
              return Promise.reject(new TypeError("Failed to fetch"));
            }
            if (rejectNext) {
              if (failure === "session") rejectNext = false;
              // Stop a broken loop from flooding the runner while retaining its evidence.
              if (reads > 12) return new Promise<Response>(() => {});
              return Promise.resolve(Response.json({
                code: "FORBIDDEN",
                error: refusal,
                ...(failure === "session"
                  ? { context: { session: "invalid" } }
                  : {}),
              }, { status: 403 }));
            }
            conversations.conversations[0].messages[0].text = latest;
            return Promise.resolve(Response.json(conversations));
          }
          if (path.startsWith("/api/saved-systems/list")) {
            return Promise.resolve(Response.json([]));
          }
          return Promise.resolve(Response.json(snapshot()));
        },
      });
      const element = document.createElement("div");
      document.body.append(element);
      const stop = state.start();
      try {
        await act(() =>
          render(
            <Workspace
              state={state}
              started
              initialUrl="/cases?case=request-one"
            />,
            element,
          )
        );
        await settle();
        equal(state.requests.sessionReady.peek(), true);
        equal(posts, 1);
        const initialGeneration = state.requests.sessionGeneration.peek();
        const initialSources = sources.length;
        const initialReads = reads;
        ok(initialReads > 0);
        equal(onlineListeners.size, 1);
        await advanceIntervals(6_001);
        equal(
          reads,
          initialReads,
          "idle time beyond three former polling periods starts no reads",
        );
        rejectNext = true;
        await act(async () => await state.requests.refresh(record.id));
        await settle();
        if (failure === "business") {
          equal(state.requests.sessionReady.peek(), true);
          equal(state.requests.sessionGeneration.peek(), initialGeneration);
          equal(posts, 1);
          equal(sources.length, initialSources);
          equal(reads, initialReads + 1);
          equal(state.requests.readErrors.peek().get(record.id), refusal);
          match(
            element.textContent ?? "",
            /The selected Request is unavailable/,
          );
          await settle();
          equal(reads, initialReads + 1);
          equal(posts, 1);
          rejectNext = false;
          latest = "Persisted progress after advisory event";
          await act(async () => {
            sources.at(-1)!.emit("request-conversations-invalidated", {
              schemaVersion: 1,
              caseId: record.id,
            });
            await settle();
          });
          equal(reads, initialReads + 2);
          equal(state.requests.readErrors.peek().get(record.id), "");
          match(
            element.textContent ?? "",
            /Persisted progress after advisory event/,
          );
          latest = "Persisted completion missed offline";
          await act(async () => {
            sources.at(-1)!.open();
            await settle();
          });
          equal(reads, initialReads + 3);
          match(
            element.textContent ?? "",
            /Persisted completion missed offline/,
          );
          offline = true;
          await act(async () => {
            sources.at(-1)!.emit("request-conversations-invalidated", {
              schemaVersion: 1,
              caseId: record.id,
            });
            await settle();
          });
          equal(state.connection.peek(), "live");
          equal(
            state.requests.readErrors.peek().get(record.id),
            "Failed to fetch",
          );
          latest = "Persisted answer recovered after browser online";
          offline = false;
          await act(async () => {
            win.dispatchEvent(new Event("online"));
            await settle();
          });
          equal(reads, initialReads + 5);
          equal(state.requests.readErrors.peek().get(record.id), "");
          match(
            element.textContent ?? "",
            /Persisted answer recovered after browser online/,
          );
          equal(posts, 1, "a ready session is not renewed on browser online");
          equal(
            sources.length,
            initialSources,
            "online keeps the live SSE stream",
          );
        } else {
          equal(posts, 2);
          equal(state.requests.sessionGeneration.peek(), initialGeneration + 1);
          equal(sources.length, initialSources + 1);
          ok(sources[initialSources - 1].closed);
          equal(state.requests.sessionReady.peek(), true);
          ok(reads >= initialReads + 2);
          equal(state.requests.readErrors.peek().get(record.id), "");
        }
      } finally {
        await act(() => render(null, element));
        stop();
        restore();
        equal(
          onlineListeners.size,
          0,
          "stop removes the browser online listener",
        );
      }
    });
  });
}
