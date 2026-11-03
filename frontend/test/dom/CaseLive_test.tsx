import { equal, ok } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { SystemFrame } from "../../components/system/SystemFrame.tsx";
import { ModelSpace } from "../../components/model/ModelSpace.tsx";
import { createViewPrefs } from "../../lib/system/view-prefs.ts";
import {
  createWorkbenchState,
  type WorkbenchEventSource,
} from "../../lib/workbench/state.ts";
import {
  boardHost,
  BUILDER,
  HEAD,
  initialBoard,
  watchBoard,
} from "../support/board-fixture.ts";
import { createBoardApi } from "../../lib/system/board/api.ts";
import { createBoardStore } from "../../lib/system/board/store.ts";
import { createMatrixApi } from "../../lib/system/rights/api.ts";
import { createMatrixStore } from "../../lib/system/rights/store.ts";
import { caseRecord } from "../support/case-fixture.ts";
import { matrixHost } from "../support/matrix-fixture.ts";
import type { AuthorityMatrix } from "../../lib/system/rights/api.ts";
import { withMountedDom } from "../support/mounted-dom.ts";
import { snapshot } from "../support/workbench-fixture.ts";

const BIRTH = `commit:${"1".repeat(40)}`;
const ADOPTED = `commit:${"2".repeat(40)}`;

class Events implements WorkbenchEventSource {
  listeners = new Map<string, Array<(event: { data?: string }) => void>>();
  addEventListener(type: string, listener: (event: { data?: string }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, value: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(value) });
    }
  }
  close() {}
}

/**
 * The host of one Case: its scope runs `runs.version`, and its facade answers
 * the board and the files of each version (the head when none is asked for,
 * as the real facade resolves it). It records what was read.
 */
function caseHost() {
  const runs = { version: BIRTH };
  const reads: string[] = [];
  const board = boardHost({
    head: BIRTH,
    boards: { [BIRTH]: initialBoard(), [ADOPTED]: watchBoard() },
  });
  const files: Record<string, string> = {
    [BIRTH]: "birth.sysml",
    [ADOPTED]: "adopted.sysml",
  };
  const fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      "http://127.0.0.1:4311",
    );
    reads.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/api/case-model/A") {
      return Promise.resolve(Response.json({
        caseId: "A",
        branchId: "branch-A",
        executionSpaceId: "space-A",
        branchVersion: runs.version,
        executionVersion: runs.version,
        version: url.searchParams.get("version") ?? runs.version,
        release: null,
        readOnly: true,
      }));
    }
    const version = url.searchParams.get("version") ?? runs.version;
    if (url.pathname === "/api/case-model/A/api/model/board") {
      board.state.head = runs.version;
      return board.fetch(
        `/api/model/board${url.search}`,
        input instanceof Request ? { signal: input.signal } : undefined,
      );
    }
    if (url.pathname === "/api/case-model/A/api/model-files") {
      return Promise.resolve(Response.json({
        version,
        files: [{
          path: files[version],
          lastChange: {
            version,
            createdAt: "2026-10-31T00:00:00Z",
            message: "m",
          },
        }],
      }));
    }
    if (url.pathname === "/api/case-model/A/api/model-sources") {
      return Promise.resolve(Response.json({
        version,
        sourceDigest: "d".repeat(64),
        sources: { [files[version]]: "package P;\n" },
      }));
    }
    return Promise.resolve(Response.json(snapshot()));
  };
  return { runs, reads, fetch };
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1)));
  }
}

/** A Case page mounted with the real workbench state on its own connection. */
async function withCasePage(
  page: (state: ReturnType<typeof createWorkbenchState>) => preact.JSX.Element,
  exercise: (
    root: HTMLElement,
    host: ReturnType<typeof caseHost>,
    events: Events,
  ) => Promise<void>,
) {
  await withMountedDom(async (document) => {
    const host = caseHost();
    const before = globalThis.fetch;
    globalThis.fetch = host.fetch as typeof fetch;
    const events = new Events();
    const state = createWorkbenchState({
      initialState: snapshot(),
      eventSourceFactory: () => events,
      fetch: (path, init) =>
        host.fetch(new Request(new URL(path, "http://127.0.0.1:4311"), init)),
    });
    const stop = state.start();
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(() => {
        render(page(state), root);
      });
      await settle();
      await exercise(root, host, events);
    } finally {
      await act(() => {
        render(null, root);
      });
      stop();
      globalThis.fetch = before;
    }
  });
}

const adopted = {
  schemaVersion: 1,
  caseId: "A",
  branchVersion: ADOPTED,
  executionVersion: ADOPTED,
};

Deno.test("a System page inside a Case reads its board again when the host says the Case's model moved", async () => {
  const prefs = createViewPrefs(() => ({
    getItem: () => null,
    setItem: () => {},
  }));
  await withCasePage(
    (state) => (
      <SystemFrame
        state={state}
        page="explore"
        location={{ search: "?caseBranch=A" }}
        prefs={prefs}
      />
    ),
    async (root, host, events) => {
      ok(root.textContent!.includes("liveBuilder"), root.textContent!);
      // The adopted model's units go by their operators' names.
      equal(root.textContent!.includes("Analyste"), false);
      host.runs.version = ADOPTED;
      await act(() => {
        events.emit("case-model-version", adopted);
      });
      // What the page shows stays while the Case is read again.
      equal(root.textContent!.includes("Reading the Request model"), false);
      await settle();
      ok(root.textContent!.includes("Analyste"), root.textContent!);
      ok(
        host.reads.includes(
          `/api/case-model/A/api/model/board?version=${
            encodeURIComponent(ADOPTED)
          }`,
        ),
        host.reads.join("\n"),
      );
      // Another Case's word moves nothing here.
      const before = host.reads.length;
      await act(() => {
        events.emit("case-model-version", { ...adopted, caseId: "B" });
      });
      await settle();
      equal(host.reads.length, before);
    },
  );
});

Deno.test("a Model page inside a Case reads its files again when the host says the Case's model moved", async () => {
  await withCasePage(
    (state) => (
      <ModelSpace
        state={state}
        page="files"
        location={{ pathname: "/model", search: "?caseBranch=A" }}
        operators={[]}
      />
    ),
    async (root, host, events) => {
      ok(root.textContent!.includes("birth.sysml"), root.textContent!);
      host.runs.version = ADOPTED;
      // The main system's word says nothing of a Case's files.
      await act(() => {
        events.emit("model-version", { head: `commit:${"9".repeat(40)}` });
      });
      await settle();
      ok(root.textContent!.includes("birth.sysml"));
      await act(() => {
        events.emit("case-model-version", adopted);
      });
      await settle();
      ok(root.textContent!.includes("adopted.sysml"), root.textContent!);
      equal(root.textContent!.includes("birth.sysml"), false);
      ok(
        host.reads.includes(
          `/api/case-model/A/api/model-files?version=${
            encodeURIComponent(ADOPTED)
          }`,
        ),
        host.reads.join("\n"),
      );
    },
  );
});

Deno.test("the main Rights page reads a Branch Operator's rights again when the host says its Case's model moved", async () => {
  const prefs = createViewPrefs(() => ({
    getItem: () => null,
    setItem: () => {},
  }));
  const board = createBoardStore({
    api: createBoardApi({ fetch: boardHost().fetch }),
  });
  await board.open(undefined);
  const mainMatrices = matrixHost();
  const matrix = createMatrixStore({
    api: createMatrixApi({ fetch: mainMatrices.fetch }),
  });
  await matrix.open(HEAD);
  const branchReads: string[] = [];
  const branchMatrix = (await createMatrixApi({ fetch: mainMatrices.fetch })
    .read(HEAD)).matrix as AuthorityMatrix;
  await withCasePage(
    (state) => {
      const systemId = state.current.value!.id;
      state.requests.context.value = { projectId: "project", systemId };
      state.requests.sessionReady.value = true;
      state.requests.cases.accept({
        systemId,
        cases: [caseRecord(1, { id: "A", owner: BUILDER })],
      });
      return (
        <SystemFrame
          state={state}
          page="rights"
          location={{ search: "" }}
          board={board}
          matrix={matrix}
          prefs={prefs}
          branchMatrixReader={{
            read(caseId, version) {
              branchReads.push(`${caseId}@${version}`);
              return Promise.resolve(branchMatrix);
            },
          }}
        />
      );
    },
    async (_root, host, events) => {
      equal(branchReads.join(), `A@${BIRTH}`);
      host.runs.version = ADOPTED;
      await act(() => {
        events.emit("case-model-version", adopted);
      });
      await settle();
      equal(branchReads.join(), `A@${BIRTH},A@${ADOPTED}`);
    },
  );
});
