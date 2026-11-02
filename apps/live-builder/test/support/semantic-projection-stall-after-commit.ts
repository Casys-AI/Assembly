import { runSemanticProjectionProcess } from "../../src/adapters/out/oxigraph/process.ts";

// Integration fixture: verified persistence completed, but the child never
// closes stdout. The parent must refuse late success and observe termination.
await runSemanticProjectionProcess();
await new Promise(() => setInterval(() => {}, 1000));
