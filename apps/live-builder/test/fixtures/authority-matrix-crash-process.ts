/** Stand-in for the matrix process entry with failure modes selected by the
 * job name. It receives the same bounded child flags as production. */
import { getHeapStatistics } from "node:v8";

const job: { name?: string } = JSON.parse(
  await new Response(Deno.stdin.readable).text(),
);
if (job.name === "heap") {
  // Retain small live objects so the old-space limit is reached, not a timeout.
  const live: unknown[] = [];
  for (;;) live.push({ index: live.length, value: [live.length] });
} else if (job.name === "exit") {
  Deno.exit(7);
}
console.log(JSON.stringify({
  ok: true,
  matrix: { marker: job.name, cwd: Deno.cwd() },
  usage: {
    pid: Deno.pid,
    heapSizeLimit: getHeapStatistics().heap_size_limit,
    maxRssBytes: 1,
    samples: [],
  },
}));
