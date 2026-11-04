import assert from "node:assert/strict";

async function* sourceFiles(directory: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(directory)) {
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) yield* sourceFiles(url);
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")) {
      yield url;
    }
  }
}

Deno.test("production string comparison uses the shared persisted order", async () => {
  for await (
    const file of sourceFiles(new URL("../../src/", import.meta.url))
  ) {
    const source = await Deno.readTextFile(file);
    assert.doesNotMatch(
      source,
      /\blocaleCompare\s*\(/,
      `${file}: use domain/primitives/persisted-order.ts instead of localeCompare`,
    );
  }
});

function importSpecifiers(source: string): string[] {
  const declarations =
    /^\s*(?:import\s+(?:(?:type\s+)?[^;]*?\sfrom\s*)?|export\s+(?:type\s+)?\{[^;]*?\}\s+from\s*)["']([^"']+)["']/gm;
  const dynamic = /\bimport\(\s*["']([^"']+)["']/g;
  return [...source.matchAll(declarations), ...source.matchAll(dynamic)]
    .map((match) => match[1]!);
}

Deno.test("atelier production imports keep the DDD dependency direction", async () => {
  for (
    const root of [
      new URL("../../src/", import.meta.url),
    ]
  ) {
    for (const layer of ["domain", "application"]) {
      const directory = new URL(`${layer}/`, root);
      for await (const file of sourceFiles(directory)) {
        const source = await Deno.readTextFile(file);
        for (const specifier of importSpecifiers(source)) {
          if (!specifier.startsWith(".")) {
            assert.notEqual(layer, "domain", `${file}: external ${specifier}`);
            continue;
          }
          const dependency = new URL(specifier, file);
          assert(
            dependency.href.startsWith(root.href),
            `${file}: dependency outside the application (${specifier})`,
          );
          assert(
            !dependency.href.startsWith(new URL("adapters/", root).href),
            `${file}: outward dependency on ${specifier}`,
          );
          assert(
            !dependency.href.startsWith(new URL("infrastructure/", root).href),
            `${file}: dependency on infrastructure (${specifier})`,
          );
          assert(
            !dependency.href.startsWith(new URL("composition/", root).href),
            `${file}: dependency on composition (${specifier})`,
          );
          if (layer === "domain") {
            assert(
              dependency.href.startsWith(directory.href),
              `${file}: domain depends on ${specifier}`,
            );
          }
        }
      }
    }
    // infrastructure/ (lot 2, ex adapters/platform) serves every context: it
    // may implement application ports, so application imports are allowed.
    // Adapters imports are inherited debt, tracked by the dated warn-list in
    // the next test; no new adapters edge may appear there.
    const infra = new URL("infrastructure/", root);
    try {
      for await (const file of sourceFiles(infra)) {
        const source = await Deno.readTextFile(file);
        for (const specifier of importSpecifiers(source)) {
          if (!specifier.startsWith(".")) continue;
          const dependency = new URL(specifier, file);
          assert(
            !dependency.href.startsWith(new URL("adapters/", root).href) ||
              INFRASTRUCTURE_ADAPTERS_WARNLIST.some((allowed) =>
                file.href.endsWith(allowed.file) &&
                specifier.endsWith(allowed.specifierEndsWith)
              ),
            `${file}: infrastructure depends on adapters (${specifier})`,
          );
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
});

// Dated warn-list (2026-10-28, lot 2): adapters edges inherited by the
// platform -> infrastructure move. Each entry names the exact file and
// specifier; the list may only shrink (an entry that no longer matches
// must be deleted in the same change that removes the edge).
const INFRASTRUCTURE_ADAPTERS_WARNLIST: Array<
  { file: string; specifierEndsWith: string }
> = [
  {
    file: "infrastructure/runtime-provenance.ts",
    specifierEndsWith: "adapters/out/sysml-toolkit/runtime/loader.ts",
  },
  {
    file: "infrastructure/runtime-provenance.ts",
    specifierEndsWith: "adapters/out/sysml-toolkit/worker-client.ts",
  },
  {
    file: "infrastructure/native/runtime-location.ts",
    specifierEndsWith: "adapters/sysml-toolkit-pin.ts",
  },
  {
    file: "infrastructure/native/process-client.ts",
    specifierEndsWith: "adapters/out/sysml-toolkit/runtime/native-addon.ts",
  },
  {
    file: "infrastructure/native/process-client.ts",
    specifierEndsWith: "adapters/out/sysml-toolkit/worker-client.ts",
  },
  {
    file: "infrastructure/native/process-client.ts",
    specifierEndsWith: "adapters/out/sysml-toolkit/runtime/loader.ts",
  },
];

// Dated warn-list (2026-10-28, lot 1 of the hexagonal organisation
// migration; lowered 2026-10-28 in lot 8): existing cross-context domain
// import edges, counted per (from -> to) context pair. `primitives` and
// `shared-kernel` are the shared kernels and are not warned. This list may
// only shrink: a count above the recorded value is a new edge and fails; a
// count below it means an edge was removed and the recorded value must be
// lowered in the same change. Zeroed entries are removed (memory->model and
// skills->model reached 0 in lot 8 via shared-kernel).
// Explicit reviewed exception (2026-10-29, ROOT-approved CAP-3/branches):
// nine type imports and two calls to the canonical business act normalizer are
// legitimate collaboration with transverse governance (D-Gov), not technical
// access or new context pairs. The reviewed inventory includes the preserved NCG
// outcome and the already-committed budget pin edge.
// These four reviewed ceilings are frozen again; this exception authorizes no
// automatic future growth. All equality/direction/new-pair checks remain strict.
const DOMAIN_CROSS_CONTEXT_WARNLIST: Record<string, number> = {
  "governance->model": 15,
  "governance->work": 7,
  "model->governance": 16,
  "model->work": 9,
  "skills->work": 1,
  // 2026-11-02, 4.8e Q7: a Main order's caller carries the scoped operator
  // identity in the delegated work context (case-context.ts), the identity
  // type defined beside ExecutionSpaceRef for exactly this use.
  "work->governance": 8,
  "work->model": 12,
  "work->skills": 1,
};

const SHARED_KERNELS = new Set(["primitives", "shared-kernel"]);

function contextOf(root: URL, file: URL): string | undefined {
  const domain = new URL("domain/", root).href;
  if (!file.href.startsWith(domain)) return undefined;
  const rest = file.href.slice(domain.length);
  // Files directly under domain/ belong to no context and form no
  // cross-context edge (lot 8: previously produced junk contexts such as
  // "network-impact.ts").
  if (!rest.includes("/")) return undefined;
  return rest.split("/")[0];
}

Deno.test("domain cross-context edges stay within the dated warn-list", async () => {
  const root = new URL("../../src/", import.meta.url);
  const counts = new Map<string, number>();
  // Cost lot 1 (2026-11-02): provision bounds use the canonical model-read
  // policy directly. Track this one required business dependency separately;
  // none of the inherited context ceilings gains room for another import.
  let modelReadProvisionEdges = 0;
  const domain = new URL("domain/", root);
  for await (const file of sourceFiles(domain)) {
    const from = contextOf(root, file);
    if (!from || SHARED_KERNELS.has(from)) continue;
    const source = await Deno.readTextFile(file);
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const dependency = new URL(specifier, file);
      const to = contextOf(root, dependency);
      if (!to || to === from || SHARED_KERNELS.has(to)) continue;
      if (
        file.href ===
          new URL(
            "domain/governance/policies/operator-creation-policy.ts",
            root,
          ).href &&
        dependency.href ===
          new URL("domain/model/consultation/model-read-policy.ts", root).href
      ) {
        modelReadProvisionEdges++;
        continue;
      }
      const key = `${from}->${to}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  assert.equal(
    modelReadProvisionEdges,
    1,
    "Provision bounds import the canonical model-read policy exactly once",
  );
  for (const [key, recorded] of Object.entries(DOMAIN_CROSS_CONTEXT_WARNLIST)) {
    const actual = counts.get(key) ?? 0;
    assert(
      actual <= recorded,
      `new domain cross-context edge ${key}: ${actual} > warn-list ${recorded}`,
    );
    assert.equal(
      actual,
      recorded,
      `domain edge ${key} shrank to ${actual}; lower the dated warn-list entry in this change`,
    );
    counts.delete(key);
  }
  assert.deepEqual(
    [...counts.keys()],
    [],
    `unrecorded domain cross-context edges: ${[...counts.keys()].join(", ")}`,
  );
});

Deno.test("the sysml toolkit pin stays at its frozen path", async () => {
  const root = new URL("../../src/", import.meta.url);
  const pin = new URL("adapters/sysml-toolkit-pin.ts", root);
  const stat = await Deno.stat(pin);
  assert(stat.isFile, "sysml-toolkit-pin.ts must exist at its frozen path");
  // No second copy may appear elsewhere in src/.
  for await (const file of sourceFiles(root)) {
    if (file.href.endsWith("sysml-toolkit-pin.ts")) {
      assert.equal(file.href, pin.href, `duplicate toolkit pin at ${file}`);
    }
  }
});

Deno.test("adapters top level contains only incoming and outgoing adapters and the frozen toolkit pin", async () => {
  const root = new URL("../../src/adapters/", import.meta.url);
  for await (const entry of Deno.readDir(root)) {
    assert(
      entry.name === "sysml-toolkit-pin.ts" && entry.isFile ||
        (entry.name === "in" || entry.name === "out") && entry.isDirectory,
      `unexpected adapters top-level entry: ${entry.name}`,
    );
  }
});
