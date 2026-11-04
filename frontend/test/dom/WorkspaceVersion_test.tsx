import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { WorkspaceVersion } from "../../components/workbench/WorkspaceVersion.tsx";
import { modelLive } from "../../lib/model/live.ts";
import { withMountedDom } from "../support/mounted-dom.ts";
import { replaceGlobals } from "../support/globals.ts";
import { commit, HEAD, PARENT, ROOT } from "../support/revision-fixture.ts";

const history = (headVersion = HEAD) => ({
  headVersion,
  commits: [
    commit(HEAD, PARENT, "operator:main", "New", "2026-11-03T09:00:00Z"),
    commit(PARENT, ROOT, "operator:main", "Prior", "2026-11-02T09:00:00Z"),
  ],
  truncated: false,
});
async function until(done: () => boolean) {
  for (let i = 0; i < 100 && !done(); i++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  }
  ok(done(), "The version metadata did not settle");
}

Deno.test("Main's title and pinned pill use exact commit dates and refresh service status when the admitted head moves", async () => {
  await withMountedDom(async (document) => {
    const reads: string[] = [];
    let current = history(PARENT);
    const restore = replaceGlobals({
      fetch: (path: RequestInfo | URL) => {
        reads.push(String(path));
        return Promise.resolve(Response.json(current));
      },
    });
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(() =>
        render(
          <>
            <WorkspaceVersion
              followHead
              info={{
                source: { kind: "main" },
                version: ROOT,
                inService: ROOT,
                modelDigest: "runtime-only",
              }}
            />
            <WorkspaceVersion
              info={{
                source: { kind: "main" },
                version: PARENT,
                inService: ROOT,
                readOnly: true,
              }}
            />
          </>,
          root,
        )
      );
      await until(() =>
        root.querySelector("summary")?.textContent === "Main · 2 Nov"
      );
      deepStrictEqual(reads, ["/api/model-history?limit=200"]);
      const pinned = root.querySelectorAll("summary")[1];
      equal(
        pinned.getAttribute("aria-label"),
        "Inspect Main · 2 Nov · Not in service · Read-only",
      );
      equal(root.textContent!.includes("runtime-only"), false);
      current = history();
      await act(() => modelLive.accept(JSON.stringify({ head: HEAD })));
      await until(() =>
        root.querySelector("summary")?.textContent === "Main · 3 Nov"
      );
      equal(pinned.textContent, "Main · 2 Nov");
      equal(
        pinned.getAttribute("aria-label"),
        "Inspect Main · 2 Nov · Past version · Read-only",
      );
      equal(reads.length, 2);
    } finally {
      await act(() => render(null, root));
      restore();
    }
  });
});

Deno.test("opening Main's inspector retries unavailable commit metadata without inventing a date", async () => {
  await withMountedDom(async (document) => {
    let reads = 0;
    const restore = replaceGlobals({
      fetch: () =>
        ++reads === 1
          ? Promise.reject(new Error("offline"))
          : Promise.resolve(Response.json(history())),
    });
    const root = document.createElement("div");
    document.body.append(root);
    try {
      await act(() =>
        render(
          <WorkspaceVersion
            info={{
              source: { kind: "main" },
              version: PARENT,
              inService: HEAD,
            }}
          />,
          root,
        )
      );
      await until(() => reads === 1);
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      equal(root.querySelector("summary")!.textContent, "Main");
      match(root.querySelector("dl")!.textContent!, /Commit date unavailable/);
      const disclosure = root.querySelector("details")!;
      await act(() => {
        disclosure.open = true;
        disclosure.dispatchEvent(new Event("toggle"));
      });
      await until(() =>
        root.querySelector("summary")!.textContent === "Main · 2 Nov"
      );
      equal(reads, 2);
    } finally {
      await act(() => render(null, root));
      restore();
    }
  });
});
