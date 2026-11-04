import { board, unit } from "../support/board-fixture.ts";
import { caseRecord } from "../support/case-fixture.ts";
import { branchOperatorName } from "../../lib/cases/operator-names.ts";
import { createCases, createCasesApi } from "../../lib/cases/cases.ts";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import {
  SavedSystemInspection,
  SavedSystems,
} from "../../components/system/SavedSystems.tsx";
import type { SavedSystemsApi } from "../../lib/system/saved-systems.ts";
import { replaceGlobals } from "../support/globals.ts";
import { withMountedDom } from "../support/mounted-dom.ts";
import {
  localSkillRelease,
  RELEASE_VERSION,
} from "../support/release-opening-fixture.ts";

const source = {
  branch: { kind: "main" as const },
  sourceVersion: RELEASE_VERSION,
};
const tag = { name: "v1", refOid: "a".repeat(40), commitOid: "a".repeat(40) };

async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  }
  ok(done(), "The expected state did not settle");
}

Deno.test("one Release submit survives a catalogue refresh in flight", async () => {
  await withMountedDom(async (document) => {
    const win = document.defaultView!;
    const restore = replaceGlobals({
      addEventListener: win.addEventListener.bind(win),
      removeEventListener: win.removeEventListener.bind(win),
      localStorage: win.localStorage,
      location: win.location,
      fetch: (path: RequestInfo | URL) =>
        Promise.resolve(
          Response.json(
            String(path).includes("/api/model-history")
              ? { headVersion: RELEASE_VERSION, commits: [], truncated: false }
              : { projectId: "p", systemId: "s" },
          ),
        ),
    });
    const pending = Promise.withResolvers<
      ReturnType<typeof localSkillRelease>[]
    >();
    let reads = 0;
    const sent: Parameters<SavedSystemsApi["save"]>[0][] = [];
    const api: SavedSystemsApi = {
      list: () => ++reads === 2 ? pending.promise : Promise.resolve([]),
      tags: () => Promise.resolve([tag]),
      inspect: () => Promise.reject(new Error("unused")),
      save: (command) => {
        sent.push(structuredClone(command));
        return Promise.reject(new Error("response lost"));
      },
    };
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(() =>
        render(
          <SavedSystems api={api} source={source} initiallyCreating />,
          root,
        )
      );
      await until(() =>
        !!root.querySelector('option[value="v1"]') &&
        !root.textContent!.includes("Reading…")
      );
      const select = root.querySelector<HTMLSelectElement>(
        "#saved-system-tag",
      )!;
      const title = root.querySelector<HTMLInputElement>("#saved-system-name")!;
      const notes = root.querySelector<HTMLTextAreaElement>(
        "#saved-system-purpose",
      )!;
      await act(() => {
        select.value = "v1";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        title.value = "Release title";
        title.dispatchEvent(new Event("input", { bubbles: true }));
        notes.value = "Release notes";
        notes.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(() => {
        win.dispatchEvent(new Event("focus"));
      });
      await until(() => reads === 2);
      const submit = root.querySelector<HTMLButtonElement>(
        '#create-release-form button[type="submit"]',
      )!;
      await act(() => submit.click());
      await act(async () => {
        pending.resolve([]);
        await pending.promise;
      });
      await until(() => sent.length === 1);
      equal(sent.length, 1);
      deepStrictEqual({
        name: sent[0].name,
        purpose: sent[0].purpose,
        source: sent[0].source,
        tag: sent[0].tag,
      }, {
        name: "Release title",
        purpose: "Release notes",
        source,
        tag: { mode: "existing", name: "v1" },
      });
    } finally {
      await act(() => render(null, root));
      restore();
    }
  });
});

Deno.test("a tag created on the Release page can be submitted on the first click", async () => {
  await withMountedDom(async (document) => {
    const win = document.defaultView!;
    const requests: Array<{ path: string; body: unknown }> = [];
    let created = false;
    const restore = replaceGlobals({
      addEventListener: win.addEventListener.bind(win),
      removeEventListener: win.removeEventListener.bind(win),
      localStorage: win.localStorage,
      location: win.location,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input);
        if (path.startsWith("/api/model-history")) {
          return Promise.resolve(
            Response.json({
              headVersion: RELEASE_VERSION,
              commits: [],
              truncated: false,
            }),
          );
        }
        if (path === "/api/model-tags/create") {
          requests.push({ path, body: JSON.parse(String(init?.body)) });
          created = true;
          return Promise.resolve(
            Response.json({ source: localSkillRelease().source, tag }),
          );
        }
        return Promise.resolve(
          Response.json({ projectId: "p", systemId: "s" }),
        );
      },
    });
    const sent: Parameters<SavedSystemsApi["save"]>[0][] = [];
    const api: SavedSystemsApi = {
      list: () => Promise.resolve([]),
      tags: () => Promise.resolve(created ? [tag] : []),
      inspect: () => Promise.reject(new Error("unused")),
      save: (command) => {
        sent.push(structuredClone(command));
        return Promise.reject(new Error("response lost"));
      },
    };
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(() =>
        render(
          <SavedSystems api={api} source={source} initiallyCreating />,
          root,
        )
      );
      await until(() =>
        !root.textContent!.includes("Reading…") &&
        !!root.querySelector("#saved-system-name")
      );
      const create = [...root.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent!.trim() === "Create tag");
      ok(create);
      await act(() => create.click());
      const tagInput = root.querySelector<HTMLInputElement>(
        ".create-tag input",
      )!;
      await act(() => {
        tagInput.value = "v1";
        tagInput.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const tagSubmit = root.querySelector<HTMLButtonElement>(
        '.create-tag button[type="submit"]',
      )!;
      await act(() => tagSubmit.click());
      await until(() =>
        requests.length === 1 &&
        root.querySelector<HTMLSelectElement>("#saved-system-tag")?.value ===
          "v1"
      );
      deepStrictEqual(requests, [{
        path: "/api/model-tags/create",
        body: { source, name: "v1" },
      }]);
      const title = root.querySelector<HTMLInputElement>("#saved-system-name")!;
      await act(() => {
        title.value = "New Release";
        title.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(() =>
        root.querySelector<HTMLButtonElement>(
          '#create-release-form button[type="submit"]',
        )!.click()
      );
      await until(() => sent.length === 1);
      deepStrictEqual({
        name: sent[0].name,
        source: sent[0].source,
        tag: sent[0].tag,
      }, {
        name: "New Release",
        source,
        tag: { mode: "existing", name: "v1" },
      });
      equal(sent.length, 1);
    } finally {
      await act(() => render(null, root));
      restore();
    }
  });
});

Deno.test("a Release opened without conversations reads names from its exact scoped model and names its BO", async () => {
  await withMountedDom(async (document) => {
    const record = localSkillRelease("names", "request");
    const request = caseRecord(1, {
      id: "request",
      owner: record.selectedOperators[0].operatorId,
      objective: "Write slogans",
    });
    record.selectedOperators.push({
      ...record.selectedOperators[0],
      operatorId: "operator_reviewer",
    });
    record.manifest!.operators.push({
      ...record.manifest!.operators[0],
      operatorId: "operator_reviewer",
    });
    const model = board({
      team: [
        unit({
          id: "owner",
          title: "owner",
          operator: request.owner,
          declared: { operatorName: "Main Operator" },
        }),
        unit({
          id: "reviewer",
          title: "operator_reviewer",
          operator: "operator_reviewer",
          declared: { operatorName: "Slogan reviewer" },
        }),
      ],
    });
    const reads: string[] = [];
    const metadata = Promise.withResolvers<Response>();
    const requests = createCases({
      port: createCasesApi((path) => {
        equal(path, "/api/cases/request");
        return metadata.promise;
      }),
    });
    const restore = replaceGlobals({
      fetch: (input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
          "http://localhost",
        );
        reads.push(url.pathname + url.search);
        return Promise.resolve(Response.json(model));
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    try {
      await act(() =>
        render(
          <SavedSystemInspection
            record={record}
            requests={requests}
          />,
          container,
        )
      );
      await until(() =>
        !container.querySelector(".saved-system-agents")?.textContent?.includes(
          "Reading name…",
        )
      );
      const agents = container.querySelector(".saved-system-agents")!;
      match(agents.textContent!, /Slogan reviewer/, JSON.stringify(reads));
      equal(requests.byId(request.id), null);
      await act(async () => {
        metadata.resolve(Response.json(request));
        await metadata.promise;
      });
      await until(() =>
        agents.textContent!.includes(branchOperatorName(request))
      );
      match(agents.textContent!, new RegExp(branchOperatorName(request)));
      equal(agents.textContent!.includes("operator_reviewer"), false);
      deepStrictEqual(reads, [
        `/api/case-model/request/api/model/board?version=${
          encodeURIComponent(record.source!.sourceVersion)
        }`,
      ]);
    } finally {
      await act(() => render(null, container));
      requests.dispose();
      restore();
    }
  });
});
