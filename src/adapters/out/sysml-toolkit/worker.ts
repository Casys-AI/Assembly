/** Native toolkit child-process entry point.
 *
 * Spawned by NativeProcessEndpoint as `deno run <this file> --epoch=<epoch>`.
 * All behavior lives in toolkit-native-process.ts; this file only binds the
 * process main so the production entry URL stays stable for the scheduler.
 * The historical node:worker_threads/WASM host is gone: no parentPort, no trap.
 */
import {
  processEpochFromArgs,
  runToolkitNativeProcess,
  snapshotDirectoryFromArgs,
} from "./native-process.ts";
import { configureTechnicalLogging } from "../../../infrastructure/logging.ts";

if (import.meta.main) {
  await configureTechnicalLogging();
  await runToolkitNativeProcess({
    processEpoch: processEpochFromArgs(),
    snapshotDirectory: snapshotDirectoryFromArgs(),
  });
}
