import { deepStrictEqual } from "node:assert/strict";
import { createCaseBranchHandler } from "./case-branch.ts";
import type { createCaseBranchReader } from "../../../../application/model/case-branch-reader.ts";
import type { SpaceController } from "../../../../domain/work/request-spaces.ts";
const version = `commit:${"a".repeat(40)}`;
Deno.test("Case facade resolves before delegation and never delegates writes or unrelated routes", async () => {
  let resolved = 0, delegated = 0;
  const handler = createCaseBranchHandler({
    authenticate: () => Promise.resolve({} as SpaceController),
    reader: {
      resolve: (_caseId, _controller, asked) => {
        resolved++;
        return Promise.resolve(
          { version: asked ?? version } as Awaited<
            ReturnType<ReturnType<typeof createCaseBranchReader>["resolve"]>
          >,
        );
      },
    },
    handlers: [(req) => {
      delegated++;
      deepStrictEqual(new URL(req.url).searchParams.get("version"), version);
      return Promise.resolve(new Response("ok"));
    }],
  });
  const response = await handler(
    new Request("http://local/api/case-model/case1/api/model/board"),
  );
  deepStrictEqual(response?.status, 200);
  deepStrictEqual(response?.headers.get("cache-control"), "no-store");
  deepStrictEqual(
    (await handler(
      new Request("http://local/api/case-model/case1/api/model/board", {
        method: "POST",
      }),
    ))?.status,
    405,
  );
  deepStrictEqual(
    (await handler(
      new Request("http://local/api/case-model/case1/api/model-history"),
    ))?.status,
    404,
  );
  deepStrictEqual([resolved, delegated], [1, 1]);
});

const diagnosticPaths = [
  "/api/model/diagnostics",
  "/api/model/diagnostics/shapes",
  "/api/model/attention",
];
function diagnosticFixture() {
  const controller = {} as SpaceController;
  const calls: string[] = [];
  let revoked = false;
  let revokeDuringRead = false;
  const handler = createCaseBranchHandler({
    authenticate: () => Promise.resolve(controller),
    revalidate: (current) => {
      deepStrictEqual(current, controller);
      calls.push("revalidate");
      if (revoked) return Promise.reject(new Error("control revoked"));
      return Promise.resolve();
    },
    reader: {
      resolve: (caseId, current, asked) => {
        deepStrictEqual(caseId, "case1");
        deepStrictEqual(current, controller);
        calls.push(`resolve:${asked ?? "admitted"}`);
        if (asked !== undefined && asked !== version) {
          return Promise.reject(new Error("foreign version"));
        }
        return Promise.resolve({
          caseId,
          branchId: "request-branch",
          executionSpaceId: "request-space",
          branchVersion: version,
          version,
          executionVersion: version,
          baseVersion: version,
          release: null,
          readOnly: true as const,
        });
      },
    },
    handlers: [(req) => {
      const delegated = new URL(req.url);
      deepStrictEqual(delegated.searchParams.get("version"), version);
      calls.push(`read:${delegated.pathname}`);
      if (revokeDuringRead) revoked = true;
      return Promise.resolve(
        Response.json({ version, privateReport: "scoped" }),
      );
    }],
  });
  return {
    handler,
    calls,
    revokeDuringRead: () => {
      revokeDuringRead = true;
    },
  };
}
Deno.test("Case diagnostics resolve exact authorized source and revalidate every delegated read", async () => {
  for (const path of diagnosticPaths) {
    for (const query of ["", `?version=${version}`]) {
      const { handler, calls } = diagnosticFixture();
      const result = await handler(
        new Request(
          `http://local/api/case-model/case1${path}${query}`,
        ),
      );
      deepStrictEqual(result?.status, 200);
      deepStrictEqual(result?.headers.get("cache-control"), "no-store");
      deepStrictEqual((await result?.json()).version, version);
      deepStrictEqual(calls, [
        `resolve:${query ? version : "admitted"}`,
        "revalidate",
        `read:${path}`,
        "revalidate",
      ]);
    }
  }
});
Deno.test("Case diagnostics never delegate foreign sources, masks, writes or revoked reads", async () => {
  for (const path of diagnosticPaths) {
    const { handler, calls } = diagnosticFixture();
    const foreign = await handler(
      new Request(
        `http://local/api/case-model/case1${path}?version=commit:${
          "b".repeat(40)
        }`,
      ),
    );
    deepStrictEqual(foreign?.status, 404);
    deepStrictEqual(calls.length, 1);
    const revoked = diagnosticFixture();
    revoked.revokeDuringRead();
    const result = await revoked.handler(
      new Request(
        `http://local/api/case-model/case1${path}?version=${version}`,
      ),
    );
    deepStrictEqual(result?.status, 404);
    deepStrictEqual((await result?.json()).code, "CASE_MODEL_UNAVAILABLE");
  }
  const { handler, calls } = diagnosticFixture();
  deepStrictEqual(
    (await handler(
      new Request(
        "http://local/api/case-model/case1/api/model/diagnostics/masks",
      ),
    ))?.status,
    404,
  );
  deepStrictEqual(
    (await handler(
      new Request(
        "http://local/api/case-model/case1/api/model/diagnostics",
        { method: "POST" },
      ),
    ))?.status,
    405,
  );
  deepStrictEqual(calls, []);
});

Deno.test("Case diagnostics cannot be read without a current authenticated controller", async () => {
  for (const path of diagnosticPaths) {
    let resolved = 0, delegated = 0;
    const handler = createCaseBranchHandler({
      authenticate: () => Promise.reject(new Error("session unavailable")),
      reader: {
        resolve: () => {
          resolved++;
          return Promise.reject(new Error("must not resolve unauthenticated"));
        },
      },
      handlers: [() => {
        delegated++;
        return Promise.resolve(new Response("must not be exposed"));
      }],
    });
    const response = await handler(
      new Request(
        `http://local/api/case-model/case1${path}?version=${version}`,
      ),
    );
    deepStrictEqual(response?.status, 404);
    deepStrictEqual((await response?.json()).code, "CASE_MODEL_UNAVAILABLE");
    deepStrictEqual([resolved, delegated], [0, 0]);
  }
});
