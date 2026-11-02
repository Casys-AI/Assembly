import { replaceGlobals } from "../support/globals.ts";
import { deepStrictEqual } from "node:assert/strict";
import { act } from "preact/test-utils";
import {
  releaseSourceContext,
  useReleaseSourceHead,
} from "../../islands/Workbench.tsx";
import { probeRoot } from "../support/hook-probe.ts";

Deno.test("release head read distinguishes equal, changed, unavailable and reordered answers", async () => {
  const root = probeRoot();
  let tick: () => void = () => {};
  const pending: Array<ReturnType<typeof Promise.withResolvers<Response>>> = [];
  const restoreGlobals = replaceGlobals({
    setInterval: (fn: () => void) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
    fetch: () => {
      const next = Promise.withResolvers<Response>();
      pending.push(next);
      return next.promise;
    },
  });
  const source = `commit:${"a".repeat(40)}`;
  const historical = `commit:${"b".repeat(40)}`;
  let classification!: ReturnType<typeof releaseSourceContext>;
  function Probe() {
    classification = releaseSourceContext(source, useReleaseSourceHead(source));
    return null;
  }
  const answer = (version: string) => Response.json({ version, files: [] });
  try {
    await root.show(Probe, {});
    deepStrictEqual(classification, {
      label: "release source",
      divergent: false,
    });
    await act(async () => {
      pending[0].resolve(answer(source));
      await pending[0].promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    });
    deepStrictEqual(classification, {
      label: "current release source",
      divergent: false,
    });
    await act(() => tick());
    await act(() => tick());
    await act(async () => {
      pending[2].resolve(answer(historical));
      await pending[2].promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    });
    deepStrictEqual(classification, {
      label: "historical release source",
      divergent: true,
    });
    await act(async () => {
      pending[1].resolve(answer(source));
      await pending[1].promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    });
    deepStrictEqual(classification, {
      label: "historical release source",
      divergent: true,
    });
    await act(() => tick());
    await act(async () => {
      pending[3].reject(new Error("offline"));
      try {
        await pending[3].promise;
      } catch { /* expected */ }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    });
    deepStrictEqual(classification, {
      label: "release source",
      divergent: false,
    });
  } finally {
    await root.restore();
    restoreGlobals();
  }
});
