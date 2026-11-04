import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { CasesPage } from "../../components/cases/CasesPage.tsx";
import { RequestSource } from "../../components/cases/RequestSource.tsx";
import { ChatView } from "../../components/conversations/ChatView.tsx";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { snapshot } from "../support/workbench-fixture.ts";
import { caseRecord, caseScope } from "../support/case-fixture.ts";
import {
  localSkillRelease,
  RELEASE_HOST,
} from "../support/release-opening-fixture.ts";
import { withMountedDom } from "../support/mounted-dom.ts";
import { replaceGlobals } from "../support/globals.ts";

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
async function submit(root: HTMLElement, text: string) {
  const input = root.querySelector("textarea")!;
  await act(async () => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await flush();
  });
  equal(input.value, text);
  ok(!input.disabled);
  await act(async () => {
    root.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
  });
  return input;
}

Deno.test("sending while inspecting a Release waits for its exact source or retains the draft on failure", async () => {
  for (const fail of [false, true]) {
    await withMountedDom(async (document) => {
      const restore = replaceGlobals({
        location: document.defaultView!.location,
        localStorage: document.defaultView!.localStorage,
      });
      const release = {
        ...localSkillRelease(),
        status: "retained" as const,
        issues: [],
        prerequisites: [],
        assetAvailability: "verified" as const,
      };
      let resolve!: (response: Response) => void;
      const inspection = new Promise<Response>((done) => resolve = done);
      const posts: unknown[] = [];
      const state = createWorkbenchState({
        initialState: snapshot(),
        fetch: (path, init) => {
          if (path.endsWith("/inspect")) return inspection;
          if (path === "/api/request-space-openings/open") {
            posts.push(JSON.parse(String(init?.body)));
            return Promise.resolve(Response.json({}));
          }
          throw new Error(`Unexpected route ${path}`);
        },
      });
      state.requests.context.value = RELEASE_HOST;
      state.requests.sessionReady.value = true;
      state.requests.releases.value = [release];
      const root = document.createElement("div");
      document.body.append(root);
      try {
        await act(() =>
          render(
            <>
              <RequestSource state={state} active={false} />
              <ChatView
                state={state}
                active
                independentRequest
                target="new-case"
              />
            </>,
            root,
          )
        );
        const select = root.querySelector("select")!;
        await act(async () => {
          select.value = release.id;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await flush();
        });
        const input = await submit(root, "Exact request");
        equal(posts.length, 0);
        await act(async () => {
          resolve(
            fail
              ? Response.json({ error: "Inspection refused" }, { status: 403 })
              : Response.json(release),
          );
          await flush();
        });
        if (fail) {
          equal(posts.length, 0);
          equal(input.value, "Exact request");
          match(
            root.querySelector('[role="alert"]')?.textContent ?? "",
            /Inspection refused/,
          );
        } else {
          equal(posts.length, 1);
          const body = posts[0] as { text: string; source: unknown };
          equal(body.text, "Exact request");
          deepStrictEqual(body.source, {
            kind: "release",
            releaseId: release.id,
            digest: release.digest,
          });
        }
      } finally {
        await act(() => render(null, root));
        root.remove();
        restore();
      }
    });
  }
});

Deno.test("a stale Request contribution exposes the coded error", async () => {
  await withMountedDom(async (document) => {
    const conversation = () => ({
      agentId: "owner",
      nativeId: "owner",
      runtimeOwned: true,
      name: "Owner",
      responsibility: "",
      primary: false,
      canSend: false,
      revision: 7,
      busy: false,
      phase: "Ready",
      modelDigest: "digest",
      messages: [],
    });
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path) => {
        if (path === "/api/cases?space=requests") {
          return Promise.resolve(
            Response.json({
              systemId: RELEASE_HOST.systemId,
              cases: [caseRecord(1, { id: "caseA", owner: "owner" })],
            }),
          );
        }
        if (path === "/api/conversations?caseId=caseA") {
          return Promise.resolve(
            Response.json({
              systemId: "runtime",
              defaultAgentId: "owner",
              version: "v7",
              conversations: [conversation()],
            }),
          );
        }
        if (path === "/api/conversations/owner/messages?space=requests") {
          return Promise.resolve(
            Response.json({
              code: "STALE_CONVERSATION",
              error: "Conversation changed",
            }, { status: 409 }),
          );
        }
        throw new Error(`Unexpected route ${path}`);
      },
    });
    state.requests.sessionReady.value = true;
    await state.requests.cases.refresh();
    await state.requests.refresh("caseA");
    const owner = state.requests.conversation("caseA");
    ok(owner);
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(() =>
        render(
          <ChatView
            state={state}
            active
            independentRequest
            target={{ caseId: "caseA" }}
            conversation={owner}
          />,
          root,
        )
      );
      await submit(root, "Keep my message");
      match(
        root.querySelector('[role="alert"]')?.textContent ?? "",
        /STALE_CONVERSATION/,
      );
    } finally {
      await act(() => render(null, root));
      root.remove();
    }
  });
});

Deno.test("Request page reads Release catalogue only after session and host are available", async () => {
  await withMountedDom(async (document) => {
    const reads: string[] = [];
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path) => {
        if (path.startsWith("/api/saved-systems/list")) reads.push(path);
        return Promise.resolve(Response.json([]));
      },
    });
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(async () => {
        render(
          <CasesPage
            state={state}
            active
            selectedId="caseA"
            decisions={[]}
            onStarted={() => {}}
            onBack={() => {}}
          />,
          root,
        );
        await flush();
      });
      equal(reads.length, 0);
      await act(async () => {
        state.requests.sessionReady.value = true;
        await flush();
      });
      equal(reads.length, 0);
      await act(async () => {
        state.requests.context.value = RELEASE_HOST;
        await flush();
      });
      equal(reads.length, 2);
      ok(reads.every((path) => path.startsWith("/api/saved-systems/list")));
    } finally {
      await act(() => render(null, root));
      state.dispose();
      root.remove();
    }
  });
});

Deno.test("the Request list reads at most ten open scopes and never reads closed or inactive rows", async () => {
  await withMountedDom(async (document) => {
    const reads: string[] = [];
    const cases = Array.from({ length: 14 }, (_, i) =>
      caseRecord(i + 1, {
        id: `request-${i + 1}`,
        createdAt: new Date(Date.UTC(2026, 10, 3, i)).toISOString(),
        status: i === 13 ? "closed-done" : "open",
      }));
    const collection = { systemId: RELEASE_HOST.systemId, cases };
    const state = createWorkbenchState({
      initialState: snapshot(),
      fetch: (path) => {
        if (path.startsWith("/api/case-model/")) {
          const id = path.slice("/api/case-model/".length);
          reads.push(id);
          return Promise.resolve(
            Response.json(caseScope(id, `commit:${"a".repeat(40)}`)),
          );
        }
        if (path === "/api/environment") {
          return Promise.resolve(Response.json({ environment: "production" }));
        }
        if (path === "/api/request-space-openings/context") {
          return Promise.resolve(Response.json(RELEASE_HOST));
        }
        if (path === "/api/cases?space=requests") {
          return Promise.resolve(Response.json(collection));
        }
        if (path.startsWith("/api/saved-systems/list")) {
          return Promise.resolve(Response.json([]));
        }
        throw new Error(`Unexpected read ${path}`);
      },
    });
    const restore = replaceGlobals({
      location: document.defaultView!.location,
      localStorage: document.defaultView!.localStorage,
      addEventListener: document.defaultView!.addEventListener.bind(
        document.defaultView,
      ),
      removeEventListener: document.defaultView!.removeEventListener.bind(
        document.defaultView,
      ),
    });
    state.requests.context.value = RELEASE_HOST;
    state.requests.sessionReady.value = true;
    state.requests.cases.accept(collection);
    const root = document.createElement("div");
    document.body.append(root);
    const show = (active: boolean) =>
      render(
        <CasesPage
          state={state}
          active={active}
          selectedId={null}
          decisions={[]}
          onStarted={() => {}}
          onBack={() => {}}
        />,
        root,
      );
    try {
      await act(async () => {
        show(false);
        await flush();
      });
      equal(reads.length, 0);
      await act(async () => {
        show(true);
        await flush();
      });
      deepStrictEqual(
        reads,
        Array.from({ length: 10 }, (_, i) => `request-${13 - i}`),
      );
      equal(root.querySelectorAll(".cases-list .rev-row").length, 14);
    } finally {
      await act(() => render(null, root));
      state.dispose();
      restore();
    }
  });
});
