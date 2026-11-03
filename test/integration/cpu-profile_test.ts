/** Real inspector smoke only; no PostgreSQL, Toolkit or product startup. */
import assert from "node:assert/strict";
import {
  type CapturedTestCpuProfile,
  withTestCpuProfile,
} from "../support/cpu-profile.ts";

// The runner grants sys:inspector only with --cpu-profile and a file selector.
const cpuProfileEnabled = Deno.env.get("ASSEMBLY_TEST_CPU_PROFILE") === "1";

function cpuProfileSmokeWork(): number {
  const deadline = performance.now() + 50;
  let value = 1;
  while (performance.now() < deadline) {
    value = Math.imul(value, 1664525) + 1013904223;
  }
  return value;
}

async function assertCaptured(
  capture: CapturedTestCpuProfile,
  outcome: string,
  phase: string,
) {
  assert.equal(capture.pid, Deno.pid);
  assert.equal(capture.outcome, outcome);
  assert.equal(capture.phase, phase);
  assert(capture.elapsedMs >= 0);
  const metadata = JSON.parse(await Deno.readTextFile(capture.metadataPath));
  assert.deepEqual(metadata, capture);
  const profile = JSON.parse(await Deno.readTextFile(capture.profilePath));
  assert(Array.isArray(profile.nodes) && profile.nodes.length > 0);
  assert(Array.isArray(profile.samples) && profile.samples.length > 0);
  assert(profile.endTime >= profile.startTime);
  assert(
    // V8 may inline the hot workload on the second invocation; the source
    // module remains a stable witness of the calling test isolate.
    profile.nodes.some((node: { callFrame: { url: string } }) =>
      node.callFrame.url === import.meta.url
    ),
    "The actual test-isolate workload must appear in the CPU profile",
  );
  for (const path of [capture.profilePath, capture.metadataPath]) {
    const mode = (await Deno.stat(path)).mode;
    if (mode !== null) assert.equal(mode & 0o777, 0o600);
  }
}

Deno.test({
  name:
    "CPU profiler captures the actual test isolate and preserves the return",
  ignore: !cpuProfileEnabled,
  async fn() {
    const expected = { result: "preserved" };
    let captured: CapturedTestCpuProfile | undefined;
    const actual = await withTestCpuProfile(() => {
      cpuProfileSmokeWork();
      return Promise.resolve(expected);
    }, {
      enabled: true,
      phase: "smoke-return",
      onCaptured: (capture) => captured = capture,
    });
    assert.equal(actual, expected);
    assert(captured);
    await assertCaptured(captured, "returned", "smoke-return");
  },
});

Deno.test({
  name:
    "CPU profiler captures a failed operation and rethrows its original error",
  ignore: !cpuProfileEnabled,
  async fn() {
    const expected = new Error("Controlled opening failure");
    let captured: CapturedTestCpuProfile | undefined;
    let actual: unknown;
    try {
      await withTestCpuProfile(() => {
        cpuProfileSmokeWork();
        return Promise.reject(expected);
      }, {
        enabled: true,
        phase: "smoke-throw",
        onCaptured: (capture) => captured = capture,
      });
    } catch (error) {
      actual = error;
    }
    assert.equal(actual, expected);
    assert(captured);
    await assertCaptured(captured, "threw", "smoke-throw");
  },
});
