import { deepStrictEqual, equal, throws } from "node:assert/strict";
import { bindLiveSource, createLiveSync, parseGraphSnapshot } from "./live.ts";
import type { GraphSnapshot } from "./types.ts";

function snapshot(activityDigest?: string): GraphSnapshot {
  return {
    projectionDigest: "native-unchanged",
    projectionDigestScope: "native",
    activityDigest,
    version: "native-unchanged",
    history: null,
    error: null,
    graph: { nodes: [], edges: [] },
  };
}

Deno.test("an activity event reconciles the feed while the native projection identity stays stable", async () => {
  let next = snapshot("activity-one");
  let nativeDigest = "", activityDigest = "";
  const applied: boolean[] = [];
  const identities: string[] = [];
  const sync = createLiveSync({
    readState: () => Promise.resolve(next),
    getDigest: () => nativeDigest,
    getActivityDigest: () => activityDigest,
    applyState(fresh, changed) {
      applied.push(changed);
      identities.push(fresh.projectionDigest);
      nativeDigest = fresh.projectionDigest;
      activityDigest = fresh.activityDigest || "";
    },
    onStatus() {},
  });
  const listeners = new Map<string, (event: { data: string }) => unknown>();
  const source = {
    onopen: null as (() => unknown) | null,
    onerror: null as (() => unknown) | null,
    addEventListener(
      name: string,
      callback: (event: { data: string }) => unknown,
    ) {
      listeners.set(name, callback);
    },
  };
  bindLiveSource(source, sync);
  try {
    await source.onopen!();
    next = snapshot("activity-two");
    await listeners.get("model-activity")!({ data: "{}" });
    await listeners.get("model-activity")!({ data: "{}" });
    deepStrictEqual(applied, [true, true, false]);
    deepStrictEqual(new Set(identities), new Set(["native-unchanged"]));
    equal(activityDigest, "activity-two");
  } finally {
    sync.dispose();
  }
});

Deno.test("legacy projection responses need no activity digest and retain their recorded identity", () => {
  const value = snapshot();
  delete value.activityDigest;
  value.projectionDigestScope = "legacy-with-activity";
  value.history = { revision: 84 };
  equal(parseGraphSnapshot(value), value);
  equal(parseGraphSnapshot(value).projectionDigest, "native-unchanged");
});

Deno.test("activity transport rejects malformed identities or unknown digest scopes", () => {
  for (const activityDigest of [42, {}, [], ""]) {
    throws(
      () => parseGraphSnapshot({ ...snapshot(), activityDigest }),
      /Invalid native projection/,
    );
  }
  throws(
    () =>
      parseGraphSnapshot({ ...snapshot(), projectionDigestScope: "unknown" }),
    /Invalid native projection/,
  );
});
