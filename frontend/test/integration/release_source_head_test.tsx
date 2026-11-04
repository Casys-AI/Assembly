import { replaceGlobals } from "../support/globals.ts";
import { deepStrictEqual } from "node:assert/strict";
import { act } from "preact/test-utils";
import {
  releaseSourceContext,
  useReleaseSourceHead,
} from "../../islands/Workbench.tsx";
import { createModelLive } from "../../lib/model/live.ts";
import type { WorkbenchState } from "../../lib/workbench/state.ts";
import { probeRoot } from "../support/hook-probe.ts";

const source = `commit:${"a".repeat(40)}`;
const other = `commit:${"b".repeat(40)}`;
const neutral = { label: "release source", divergent: false };
const current = { label: "current release source", divergent: false };
const historical = { label: "historical release source", divergent: true };

function fixture() {
  const root = probeRoot();
  const live = createModelLive();
  const pending: Array<ReturnType<typeof Promise.withResolvers<Response>>> = [];
  let intervals = 0;
  let followers = 0;
  const restoreGlobals = replaceGlobals({
    setInterval: () => ++intervals,
    clearInterval: () => {},
    fetch: () => {
      const next = Promise.withResolvers<Response>();
      pending.push(next);
      return next.promise;
    },
  });
  const following = {
    ...live,
    follow: (read: Parameters<typeof live.follow>[0]) => {
      followers++;
      const stop = live.follow(read);
      return () => {
        followers--;
        stop();
      };
    },
  };
  let classification = neutral;
  function Probe(props: {
    keyValue?: string | null;
    connection?: WorkbenchState["connection"]["value"];
    generation?: number;
  }) {
    const key = props.keyValue === undefined ? source : props.keyValue;
    classification = releaseSourceContext(
      key ?? source,
      useReleaseSourceHead(key, { ...props, live: following }),
    );
    return null;
  }
  return {
    root,
    show: (props: Parameters<typeof Probe>[0] = {}) => root.show(Probe, props),
    announce: (head: string) =>
      act(() => live.accept(JSON.stringify({ head }))),
    async answer(index: number, version: string | Error) {
      await act(async () => {
        if (version instanceof Error) pending[index].reject(version);
        else pending[index].resolve(Response.json({ version, files: [] }));
        await pending[index].promise.catch(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      });
    },
    get classification() {
      return classification;
    },
    get reads() {
      return pending.length;
    },
    get intervals() {
      return intervals;
    },
    get followers() {
      return followers;
    },
    async restore() {
      await root.restore();
      restoreGlobals();
    },
  };
}

Deno.test("release source follows the shared head without polling and ignores superseded reads", async () => {
  const f = fixture();
  try {
    // Followers do not replay the announcement sent before this page opens.
    await f.announce(source);
    await f.show();
    deepStrictEqual(f.classification, neutral);
    deepStrictEqual(f.reads, 1);
    await f.answer(0, source);
    deepStrictEqual(f.classification, current);
    await f.announce(other);
    deepStrictEqual(f.classification, historical);
    deepStrictEqual([f.reads, f.intervals], [1, 0]);

    await f.show({ keyValue: other });
    deepStrictEqual(f.classification, neutral);
    await f.announce(source);
    await f.answer(1, other);
    deepStrictEqual(f.classification, historical);
    await f.show({ keyValue: null });
    deepStrictEqual(f.classification, neutral);
    deepStrictEqual(f.followers, 0);
    await f.show();
    await f.root.unmount();
    await f.answer(2, source);
    deepStrictEqual(f.followers, 0);
  } finally {
    await f.restore();
  }
});

Deno.test("release source reconciles after reconnect including a repeated head and failed read", async () => {
  const f = fixture();
  try {
    await f.show({ connection: "connecting" });
    deepStrictEqual(f.classification, neutral);
    deepStrictEqual([f.reads, f.followers], [0, 0]);
    await f.show({ connection: "live", generation: 1 });
    deepStrictEqual([f.reads, f.followers], [1, 1]);
    await f.announce(source);
    await f.answer(0, new Error("superseded failure"));
    deepStrictEqual(f.classification, current);
    await f.show({ connection: "reconnecting", generation: 1 });
    deepStrictEqual(f.classification, neutral);
    deepStrictEqual(f.reads, 1);
    await f.show({ generation: 2 });
    await f.announce(source); // The shared bus suppresses this repeated head.
    await f.answer(1, new Error("offline"));
    deepStrictEqual(f.classification, neutral);
    // A connection can close and reopen between two renders.
    await f.show({ generation: 3 });
    await f.answer(2, source);
    deepStrictEqual(f.classification, current);
    await f.show({ connection: "closed", generation: 3 });
    deepStrictEqual(f.classification, neutral);
    deepStrictEqual(f.followers, 0);
  } finally {
    await f.restore();
  }
});
