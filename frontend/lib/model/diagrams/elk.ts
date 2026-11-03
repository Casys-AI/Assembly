/** Browser-only lazy ELK engine with an in-thread worker. */
import type { ElkNode } from "./layout.ts";
interface ElkEngine {
  layout(graph: ElkNode): Promise<ElkNode>;
}
let engine: Promise<ElkEngine> | undefined;
export async function layoutDiagram(graph: ElkNode): Promise<ElkNode> {
  engine ??= Promise.all([
    import("elkjs/lib/elk-api.js"),
    import("elkjs/lib/elk-worker.min.js"),
  ]).then(([api, worker]) => {
    type Worker = new (url?: string) => unknown;
    const exports = worker as unknown as {
      Worker?: Worker;
      default?: { Worker?: Worker };
    };
    const InThreadWorker = exports.Worker ?? exports.default?.Worker;
    const Elk = api.default as unknown as new (
      options: { workerFactory: (url?: string) => unknown },
    ) => ElkEngine;
    if (!InThreadWorker) throw new Error("ELK worker is unavailable.");
    return new Elk({ workerFactory: (url) => new InThreadWorker(url) });
  }).catch((error: unknown) => {
    engine = undefined;
    throw error;
  });
  return (await engine).layout(graph);
}
