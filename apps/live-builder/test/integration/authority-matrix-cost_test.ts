import assert from "node:assert/strict";
import { CompiledAuthorityMatrixReader } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/reader.ts";
import { AuthorityMatrixService } from "../../src/application/governance/authority-matrix.ts";
import type { AuthorityMatrix } from "../../src/domain/governance/records/authority-matrix.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import {
  authorityMatrixProcessStats,
  MATRIX_PROCESS_HEAP_MIB,
  type MatrixProcessObserver,
  projectAuthorityMatrixWorker,
} from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import {
  matrixArtifactRepository,
  prepareMatrixArtifact,
} from "../support/authority-matrix-artifact-fixtures.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";

const projectId = "git:6746bbca-29a4-42d7-9555-85cb2fa1ed13";
const version = parseModelRevisionId(`commit:${"c".repeat(40)}`);
function describe(matrix: AuthorityMatrix) {
  return {
    rows: matrix.rows.length,
    columns: matrix.columns.length,
    cells: matrix.cells.length,
    coordinates: matrix.summary.coordinates,
    diagnostics: matrix.diagnostics,
    digest: matrix.digest,
  };
}
interface ChildSample {
  pid: number;
  phase: string;
  heapLimitMiB: number;
  exit?: { code: number; signal: string | null };
  usage?: {
    heapSizeLimit: number;
    maxRssBytes: number;
    samples: { phase: string; rss: number; heapUsed: number }[];
  };
}

/** Production path: every matrix owns a heap-limited OS process and includes
 * executable validation. Host RSS is sampled during work; each child reports
 * its kernel high-water RSS plus separate phase samples and effective V8 limit.
 * No GC intervention, extra warmup or failed-run retry is hidden. */
Deno.test({
  name:
    "artifact matrix process first and thirty calls, live RSS, cold reader and hot cache cost",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const start = performance.now();
    let phase = "setup";
    const hostSamples: { atMs: number; phase: string; rss: number }[] = [];
    const sampleHost = () =>
      hostSamples.push({
        atMs: performance.now() - start,
        phase,
        rss: Deno.memoryUsage().rss,
      });
    sampleHost();
    const hostTimer = setInterval(sampleHost, 10);
    const children = new Map<number, ChildSample>();
    const activePids = new Set<number>();
    const preparation: { bytes: number; yields: number; maxSliceMs: number }[] =
      [];
    const observer: MatrixProcessObserver = {
      onSpawn(info) {
        children.set(info.pid, { ...info, phase });
        activePids.add(info.pid);
        sampleHost();
      },
      onExit(info) {
        activePids.delete(info.pid);
        children.get(info.pid)!.exit = { code: info.code, signal: info.signal };
        sampleHost();
      },
      onPrepared(stats) {
        preparation.push(stats);
      },
      onUsage(usage) {
        children.get(usage.pid)!.usage = {
          heapSizeLimit: usage.heapSizeLimit,
          maxRssBytes: usage.maxRssBytes,
          samples: usage.samples,
        };
      },
    };
    try {
      const prepared = await prepareMatrixArtifact("initial", {
        packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
        projectId,
        version,
      });
      const { revision, units, pin } = prepared;
      sampleHost();
      console.log(JSON.stringify({
        phase: "isolated-artifact-setup",
        qualification:
          "source compilation and setup executable validation run only in an exited setup child; host RSS sampling already active",
        ...prepared.setup,
        compiledElements: revision.elements.length,
        units: units.length,
        sourcePin: pin,
        hostRss: {
          samples: hostSamples.filter((sample) =>
            sample.phase === "setup"
          ).length,
          peak: Math.max(
            ...hostSamples.filter((sample) => sample.phase === "setup").map((
              sample,
            ) => sample.rss),
          ),
        },
      }));
      const project = () =>
        projectAuthorityMatrixWorker(
          { revision, pin, projectId, name: "initial" },
          undefined,
          observer,
        );
      phase = "first";
      const firstStart = performance.now();
      const cold = await project();
      const firstMs = performance.now() - firstStart;
      assert.equal(cold.summary.coordinates.mismatches, 0);
      console.log(JSON.stringify({
        phase: "first-artifact-process-call",
        qualification:
          "production OS child startup, incremental input, independent source-pin verification, executable validation, projection and awaited exit",
        elapsedMs: firstMs,
        children: [...children.values()].filter((child) =>
          child.phase === "first"
        ),
        ...describe(cold),
      }));

      phase = "warm";
      const baseline = Deno.memoryUsage().rss;
      const calls = 30;
      const timingsMs: number[] = [];
      const finalRssSamples: number[] = [];
      let latest = cold;
      for (let index = 0; index < calls; index++) {
        const callStart = performance.now();
        latest = await project();
        timingsMs.push(performance.now() - callStart);
        finalRssSamples.push(Deno.memoryUsage().rss);
        sampleHost();
        assert.equal(latest.digest, cold.digest);
        assert.equal(latest.summary.coordinates.mismatches, 0);
      }
      const final = Deno.memoryUsage().rss;
      const warmChildren = [...children.values()].filter((child) =>
        child.phase === "warm"
      );
      const queueAfter30 = authorityMatrixProcessStats();
      const hostWarm = hostSamples.filter((sample) => sample.phase === "warm");
      const hostPeak = Math.max(
        baseline,
        ...hostWarm.map((sample) => sample.rss),
      );
      const blocks = Array.from({ length: 3 }, (_, index) => {
        const samples = finalRssSamples.slice(index * 10, (index + 1) * 10);
        return {
          fromCall: index * 10 + 1,
          throughCall: (index + 1) * 10,
          min: Math.min(...samples),
          median: samples.toSorted((a, b) => a - b)[samples.length >> 1]!,
          max: Math.max(...samples),
          final: samples.at(-1)!,
        };
      });
      console.log(JSON.stringify({
        phase: "thirty-production-process-calls",
        calls,
        timingsMs,
        minMs: Math.min(...timingsMs),
        maxMs: Math.max(...timingsMs),
        meanMs: timingsMs.reduce((sum, value) => sum + value, 0) / calls,
        hostRss: {
          samplePeriodMs: 10,
          baseline,
          peak: hostPeak,
          final,
          finalGrowth: final - baseline,
          peakGrowth: hostPeak - baseline,
          finalRssSamples,
          blocks,
          samples: hostWarm,
        },
        childRss: {
          source:
            "child node:process.resourceUsage().maxRSS kernel high-water RSS converted from KiB with *1024; phase snapshots listed separately",
          peak: Math.max(
            ...warmChildren.map((child) => child.usage?.maxRssBytes ?? 0),
          ),
          children: warmChildren,
        },
        inputPreparation: preparation,
        queueAfter30,
        ...describe(latest),
      }));
      assert.equal(
        warmChildren.length,
        calls,
        "thirty production calls spawn thirty children",
      );
      for (const child of warmChildren) {
        assert.deepEqual(
          child.exit,
          { code: 0, signal: null },
          `child ${child.pid} OS exit awaited`,
        );
        assert.equal(child.heapLimitMiB, 512);
        assert.ok(
          child.usage,
          `child ${child.pid} reported kernel/heap telemetry`,
        );
        // V8 reports old space plus the young generation: 512 MiB of old space
        // gives 608 MiB (637534208) on Deno 2.9.7. Without the flag the limit is
        // several GiB, so this window proves the flag is applied.
        assert.ok(
          child.usage.heapSizeLimit >= MATRIX_PROCESS_HEAP_MIB * 1024 * 1024 &&
            child.usage.heapSizeLimit <=
              (MATRIX_PROCESS_HEAP_MIB + 128) * 1024 * 1024,
          `child ${child.pid} effective V8 heap limit ${child.usage.heapSizeLimit} is bounded for old-space ${MATRIX_PROCESS_HEAP_MIB} MiB`,
        );
        assert.ok(
          Number.isFinite(child.usage.maxRssBytes) &&
            child.usage.maxRssBytes > 0,
          `child ${child.pid} reports a positive kernel RSS high-water mark`,
        );
        assert.ok(
          child.usage.samples.some((sample) => sample.phase === "validated"),
        );
        assert.ok(
          child.usage.samples.some((sample) => sample.phase === "projected"),
        );
      }
      assert.equal(MATRIX_PROCESS_HEAP_MIB, 512);
      assert.deepEqual(
        queueAfter30,
        { active: 0, queued: 0, retiring: 0 },
        "no active, waiting or retiring request remains",
      );
      assert.equal(activePids.size, 0);

      phase = "reader";
      let repositoryReads = 0, pinReads = 0;
      const repository = matrixArtifactRepository(prepared);
      const service = new AuthorityMatrixService(
        new CompiledAuthorityMatrixReader({
          at(requested) {
            repositoryReads++;
            return repository.at(requested);
          },
          header(requested) {
            pinReads++;
            return repository.header(requested);
          },
        }, projectId),
      );
      const fillStart = performance.now();
      const cached = await service.read(version);
      const cacheFillMs = performance.now() - fillStart;
      assert.equal(cached.digest, cold.digest);
      assert.equal(repositoryReads, 1);
      assert.equal(pinReads, 1);
      console.log(
        JSON.stringify({
          phase: "cold-compiled-reader",
          qualification:
            "in-memory stub repository: the artifact is already a ready object, so this excludes Git, snapshot parsing and verification; see the real-Git test below",
          elapsedMs: cacheFillMs,
          repositoryReads,
          pinReads,
          ...describe(cached),
        }),
      );
      phase = "hot-cache";
      const hotReads = 100;
      const hotStart = performance.now();
      for (let index = 0; index < hotReads; index++) {
        assert.strictEqual(await service.read(version), cached);
      }
      const hotElapsedMs = performance.now() - hotStart;
      assert.equal(repositoryReads, 1);
      assert.equal(pinReads, 1);
      console.log(JSON.stringify({
        phase: "hot-cache",
        reads: hotReads,
        elapsedMs: hotElapsedMs,
        meanMs: hotElapsedMs / hotReads,
        additionalRepositoryReads: repositoryReads - 1,
        additionalPinReads: pinReads - 1,
        queue: authorityMatrixProcessStats(),
        ...describe(cached),
      }));
      const limit = 128 * 1024 * 1024;
      assert.ok(
        final - baseline <= limit,
        `final host RSS growth ${final - baseline} exceeds ${limit}`,
      );
      // The baseline above still carries the fixture's setup garbage, so the
      // final growth alone can be negative and prove little. These three gates
      // use the same 128 MiB limit on what the host actually does while the
      // child computes: the sampled peak, the settled plateau (median of the
      // last ten calls against the ten before, after a ten-call warmup), and
      // the child's own kernel high-water mark against a coarse 1 GiB sanity
      // cap (the V8 flag bounds old space; WASM, ICU and stacks sit on top).
      assert.ok(
        hostPeak - baseline <= limit,
        `host RSS peak growth ${hostPeak - baseline} exceeds ${limit}`,
      );
      assert.ok(
        blocks[2]!.median - blocks[1]!.median <= limit,
        `host RSS plateau grew ${
          blocks[2]!.median - blocks[1]!.median
        } between call blocks, limit ${limit}`,
      );
      const childPeak = Math.max(
        ...warmChildren.map((child) => child.usage?.maxRssBytes ?? 0),
      );
      assert.ok(
        childPeak <= 1024 * 1024 * 1024,
        `child RSS high-water ${childPeak} exceeds 1 GiB`,
      );
    } finally {
      clearInterval(hostTimer);
      console.log(JSON.stringify({
        phase: "whole-test-host-rss",
        samplePeriodMs: 10,
        samples: hostSamples.length,
        peakIncludingPreparation: Math.max(
          ...hostSamples.map((sample) => sample.rss),
        ),
        final: Deno.memoryUsage().rss,
      }));
    }
  },
});

/** Regression guard for a cost this lot does not own. GitModelRepository.at()
 * parses the stored snapshot (about 12 MiB for the initial model), re-checks its
 * canonical digest and, on first read, re-materializes the artifact, all
 * synchronously in the host. The board route pays the same cost. The matrix
 * moved the projection into a child process and made its own preparation
 * incremental, but it cannot make this stage cooperative: the figure below is
 * the lag of the host event loop while the REAL repository loads, which the stub
 * repositories of the other tests cannot show. Observed on this machine over
 * several runs and loads: 180-590 ms per distinct-version load, cold or warm.
 * The bound is a ceiling several times that, so that only a real regression (an
 * unbounded, accidentally quadratic or repeated load, or a long GC pause) fails;
 * it is not a claim that 2 s of blocking is acceptable. */
const REAL_GIT_LOAD_LAG_BOUND_MS = 2_000;

async function withEventLoopLag<T>(
  work: () => Promise<T>,
): Promise<{ value: T; elapsedMs: number; maxLagMs: number }> {
  let maxLagMs = 0, last = performance.now(), stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const now = performance.now();
    maxLagMs = Math.max(maxLagMs, now - last - 1);
    last = now;
    if (!stopped) timer = setTimeout(tick, 1);
  };
  timer = setTimeout(tick, 1);
  const started = performance.now();
  try {
    const value = await work();
    const elapsedMs = performance.now() - started;
    // Let the pending tick observe a stall that ended with the work itself.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { value, elapsedMs, maxLagMs };
  } finally {
    stopped = true;
    clearTimeout(timer);
  }
}

Deno.test({
  name:
    "real GitModelRepository load path: event-loop lag of the pin read, cold and warm at(), and of a full read",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const prepared = await prepareMatrixArtifact("initial", {
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
      projectId,
      version,
    });
    const projectDir = await Deno.makeTempDir({
      prefix: "ase-matrix-real-git-",
    });
    try {
      const { version: _setupVersion, ...compiled } = prepared.revision;
      const options = {
        projectDir,
        repositoryId: projectId.slice("git:".length),
        compiler: {
          // Reuse the setup artifact; this repository never starts Toolkit.
          compile: () => Promise.resolve(structuredClone(compiled)),
          recipe() {
            throw new Error("A recipe must not be requested");
          },
        },
      };
      const admitted = await (await GitModelRepository.open(options))
        .initialize(prepared.revision.sources);
      const real = admitted.version;
      const rss = () => Deno.memoryUsage().rss;

      // A reopened repository holds none of the previous instance's caches.
      const repository = await GitModelRepository.open(options);
      const rssBefore = rss();
      const pin = await withEventLoopLag(() => repository.header(real));
      const cold = await withEventLoopLag(() => repository.at(real));
      const rssAfterCold = rss();
      const warm = await withEventLoopLag(() => repository.at(real));
      const rssAfterWarm = rss();
      assert.equal(cold.value.elements.length, compiled.elements.length);

      // Full read: pin, at(), incremental preparation and the child process,
      // on a repository instance that has not read this version yet.
      let maxSliceMs = 0, yields = 0;
      const service = new AuthorityMatrixService(
        new CompiledAuthorityMatrixReader(
          await GitModelRepository.open(options),
          projectId,
          undefined,
          undefined,
          {
            onPrepared: (stats) => {
              maxSliceMs = Math.max(stats.maxSliceMs, maxSliceMs);
              yields = stats.yields;
            },
          },
        ),
      );
      const full = await withEventLoopLag(() => service.read(real));
      assert.equal(full.value.version, real);
      assert.equal(full.value.summary.coordinates.mismatches, 0);
      assert.equal(full.value.rows.length, 2);
      assert.equal(full.value.columns.length, 28);
      assert.equal(full.value.cells.length, 38);

      const MiB = 1024 * 1024;
      console.log(JSON.stringify({
        phase: "real-git-load-path",
        qualification:
          "GitModelRepository on disk, artifact of the initial model; lag is the longest stall of a 1 ms host timer during each step",
        elements: compiled.elements.length,
        boundMs: REAL_GIT_LOAD_LAG_BOUND_MS,
        header: {
          elapsedMs: pin.elapsedMs,
          maxLagMs: pin.maxLagMs,
        },
        atCold: { elapsedMs: cold.elapsedMs, maxLagMs: cold.maxLagMs },
        atWarmVerified: {
          elapsedMs: warm.elapsedMs,
          maxLagMs: warm.maxLagMs,
        },
        fullRead: {
          elapsedMs: full.elapsedMs,
          maxLagMs: full.maxLagMs,
          preparationMaxSliceMs: maxSliceMs,
          preparationYields: yields,
        },
        hostRssMiB: {
          beforeLoads: rssBefore / MiB,
          afterColdAt: rssAfterCold / MiB,
          afterWarmAt: rssAfterWarm / MiB,
          note: "informational, no gate: RSS returns to the OS only after GC",
        },
      }));
      assert.ok(
        pin.maxLagMs < REAL_GIT_LOAD_LAG_BOUND_MS,
        `header blocked the loop ${pin.maxLagMs} ms`,
      );
      assert.ok(
        cold.maxLagMs < REAL_GIT_LOAD_LAG_BOUND_MS,
        `cold at() blocked the loop ${cold.maxLagMs} ms`,
      );
      assert.ok(
        warm.maxLagMs < REAL_GIT_LOAD_LAG_BOUND_MS,
        `warm at() blocked the loop ${warm.maxLagMs} ms`,
      );
      assert.ok(
        full.maxLagMs < REAL_GIT_LOAD_LAG_BOUND_MS,
        `a full matrix read blocked the loop ${full.maxLagMs} ms`,
      );
      // Everything after at() is the matrix's own work and stays cooperative:
      // the serializer yields every 4 ms and the child runs in another process.
      // A whole-artifact serialization is only about 25 ms, so the yield count
      // is the structural proof; the slice gate (which also counts GC pauses)
      // only guards against a stall.
      assert.ok(yields >= 25, `preparation yielded only ${yields} times`);
      assert.ok(maxSliceMs < 100, `preparation slice ${maxSliceMs} ms`);
      assert.deepEqual(authorityMatrixProcessStats(), {
        active: 0,
        queued: 0,
        retiring: 0,
      });
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
});
