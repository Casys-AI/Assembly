import { deepEqual, equal, rejects } from "node:assert/strict";
import {
  materializeNativeAddonSnapshot,
  type NativeAddonSnapshotFileSystem,
} from "./addon-snapshot.ts";

Deno.test("engine-neutral snapshot rejects corruption before returning a native path", async () => {
  const removed: string[] = [];
  const modes: number[] = [];
  const fs: NativeAddonSnapshotFileSystem = {
    makeTempDir: () => Promise.resolve("/private/random"),
    chmod: (_path, mode) => {
      modes.push(mode);
      return Promise.resolve();
    },
    open: (_path, options) => {
      equal(options.createNew, true);
      equal(options.mode, 0o600);
      return Promise.resolve({
        write: (bytes) => Promise.resolve(bytes.length),
        close() {},
      });
    },
    lstat: () => Promise.resolve({ isFile: true, isSymlink: false }),
    // Corruption after writing must never become a returned require path.
    readFile: () => Promise.resolve(new Uint8Array([66])),
    remove: (directory) => {
      removed.push(directory);
      return Promise.resolve();
    },
  };
  await rejects(
    () =>
      materializeNativeAddonSnapshot(
        new Uint8Array([65]),
        "digest",
        "/private",
        fs,
      ),
    {
      code: "NATIVE_ADDON_SNAPSHOT_UNAVAILABLE",
      recovery: "PROVISION_PRIVATE_NATIVE_SNAPSHOT_DIRECTORY",
    },
  );
  deepEqual(modes, [0o700, 0o400]);
  deepEqual(removed, ["/private/random"]);
});
