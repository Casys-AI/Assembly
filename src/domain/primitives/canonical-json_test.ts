import { deepStrictEqual, equal } from "node:assert/strict";
import { canonical, compareCodeUnits } from "./canonical-json.ts";
import { sha256 } from "./execution-digest.ts";

Deno.test("canonical preserves top-level undefined despite its string return annotation", () => {
  equal(canonical(undefined), undefined);
});

Deno.test("canonical encodes NaN as null", () => {
  equal(canonical(NaN), "null");
});

Deno.test("canonical sorts object keys and omits undefined properties", () => {
  equal(canonical({ z: 2, absent: undefined, a: 1 }), '{"a":1,"z":2}');
});

Deno.test("canonical preserves nested undefined array slots in historical encoding", () => {
  equal(
    canonical([undefined, { z: [undefined, NaN], a: undefined }, [
      1,
      undefined,
      3,
    ]]),
    '[,{"z":[,null]},[1,,3]]',
  );
});

Deno.test("recovery metadata ordering preserves legacy Git path fingerprints", async () => {
  const paths = [
    "objects",
    "objects/info",
    "info",
    "commondir",
    "objects/info/alternates",
    "objects/info/http-alternates",
    "config",
    "config.worktree",
    "shallow",
    "info/grafts",
    "objects/info/commit-graph",
    "objects/info/commit-graphs",
    "objects/info/commit-graphs/commit-graph-chain",
    "objects/pack",
  ];
  for (let i = 0; i < 256; i++) {
    const prefix = i.toString(16).padStart(2, "0");
    const oid = prefix.repeat(20);
    paths.push(`objects/${prefix}`, `objects/${prefix}/${oid.slice(2)}`);
    paths.push(`objects/info/commit-graphs/graph-${oid}.graph`);
    for (const extension of ["idx", "pack", "rev", "bitmap", "keep"]) {
      paths.push(`objects/pack/pack-${oid}.${extension}`);
    }
  }
  const entries = paths.map((path, i) => [path, `metadata-${i}`]);
  const legacy = entries.toSorted(([a], [b]) => a.localeCompare(b, "en-US"));
  const ordered = entries.toSorted(([a], [b]) => compareCodeUnits(a, b));
  deepStrictEqual(ordered, legacy);
  equal(
    await sha256(canonical({ records: [], refs: "", objects: ordered })),
    await sha256(canonical({ records: [], refs: "", objects: legacy })),
  );
});
