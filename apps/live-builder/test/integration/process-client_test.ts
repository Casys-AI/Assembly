import { equal, ok, rejects } from "node:assert/strict";
import { dirname } from "node:path";
import {
  defaultSnapshotStorage as storage,
  NativeProcessEndpoint,
  readBoundedLines,
} from "../../src/infrastructure/native/process-client.ts";

async function withSnapshots(
  test: (
    root: string,
    create: (epoch?: string) => Promise<string>,
  ) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({
    dir: ".data/test-runs",
    prefix: "snapshot-storage-",
  });
  const snapshots: string[] = [];
  try {
    await Deno.mkdir(`${root}/.data/toolchains`, { recursive: true });
    await test(root, async (epoch = "test") => {
      const directory = await storage.create(root, epoch);
      snapshots.push(directory);
      return directory;
    });
  } finally {
    for (const directory of snapshots) {
      await storage.remove(directory).catch(() => undefined);
    }
    await Deno.remove(root, { recursive: true });
  }
}

async function copy(root: string, name: string): Promise<string> {
  const directory = `${root}/.data/toolchains/${name}`;
  await Deno.mkdir(directory);
  await Deno.writeTextFile(`${directory}/addon.node`, "private addon");
  return directory;
}

async function exists(directory: string): Promise<boolean> {
  try {
    await Deno.stat(directory);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("snapshot sweep reclaims a copy after its owner closes the lock", () =>
  withSnapshots(async (root, create) => {
    const stale = await copy(root, "toolkit-process-dead");
    const owner = await Deno.open(`${stale}/owner.lock`, {
      create: true,
      read: true,
      write: true,
    });
    await owner.lock(true);
    owner.close();
    await create();
    equal(await exists(stale), false);
  }));

Deno.test("snapshot sweep preserves held, legacy and unrelated copies within each app root", () =>
  withSnapshots(async (root, create) => {
    const live = await copy(root, "toolkit-process-live");
    const legacy = await copy(root, "toolkit-process-legacy");
    const unrelated = await copy(root, "other-toolchain");
    const otherRoot = `${root}/other-app`;
    await Deno.mkdir(`${otherRoot}/.data/toolchains`, { recursive: true });
    const other = await copy(otherRoot, "toolkit-process-dead");
    await Deno.writeTextFile(`${other}/owner.lock`, "");
    const owner = await Deno.open(`${live}/owner.lock`, {
      create: true,
      read: true,
      write: true,
    });
    await owner.lock(true);
    try {
      await create();
      for (const directory of [live, legacy, unrelated, other]) {
        equal(await exists(directory), true, directory);
      }
    } finally {
      owner.close();
    }
  }));

Deno.test("snapshot sweep ignores a directory removed during its lock attempt", () =>
  withSnapshots(async (root, create) => {
    const gone = await copy(root, "toolkit-process-gone");
    await Deno.writeTextFile(`${gone}/owner.lock`, "");
    const open = Deno.open;
    let raced = false;
    Deno.open = async (path, options) => {
      if (path === `${gone}/owner.lock`) {
        raced = true;
        await Deno.remove(gone, { recursive: true });
      }
      return await open(path, options);
    };
    try {
      const created = await create();
      equal(raced, true);
      equal(await exists(created), true);
    } finally {
      Deno.open = open;
    }
  }));

Deno.test("snapshot sweep ignores inaccessible locks and continues to the next copy", () =>
  withSnapshots(async (root, create) => {
    const denied = await copy(root, "toolkit-process-denied");
    const stale = await copy(root, "toolkit-process-stale");
    await Deno.writeTextFile(`${stale}/owner.lock`, "");
    const open = Deno.open;
    Deno.open = (path, options) => {
      if (path === `${denied}/owner.lock`) {
        return Promise.reject(new Deno.errors.PermissionDenied("denied"));
      }
      return open(path, options);
    };
    try {
      await create();
      equal(await exists(denied), true);
      equal(await exists(stale), false);
    } finally {
      Deno.open = open;
    }
  }));

Deno.test("snapshot creator retains its copies across its own subsequent sweeps", () =>
  withSnapshots(async (_root, create) => {
    const first = await create("first");
    const second = await create("second");
    for (const directory of [first, second]) {
      equal(await exists(directory), true);
      using observer = await Deno.open(`${directory}/owner.lock`, {
        read: true,
        write: true,
      });
      equal(observer.tryLockSync(true), false);
    }
  }));

Deno.test("snapshot creator retries when a sweeper wins before owner acquisition", () =>
  withSnapshots(async (_root, create) => {
    const open = Deno.open;
    let removed: string | undefined;
    let sweeper: Deno.FsFile | undefined;
    let waited = false;
    Deno.open = async (path, options) => {
      const owner = await open(path, options);
      if (options?.create && removed === undefined) {
        removed = dirname(String(path));
        sweeper = await open(path, { read: true, write: true });
        equal(sweeper.tryLockSync(true), true);
        const lock = owner.lock.bind(owner);
        owner.lock = async (exclusive) => {
          equal(exclusive, true);
          equal(owner.tryLockSync(true), false);
          const pending = lock(exclusive);
          waited = true;
          await Deno.remove(removed!, { recursive: true });
          sweeper!.close();
          sweeper = undefined;
          await pending;
        };
      }
      return owner;
    };
    try {
      const created = await create();
      ok(removed);
      equal(waited, true);
      equal(await exists(removed), false);
      equal(await exists(created), true);
      ok(created !== removed);
    } finally {
      Deno.open = open;
      sweeper?.close();
    }
  }));

Deno.test("snapshot removal retains ownership until deletion and then closes the handle", () =>
  withSnapshots(async (_root, create) => {
    const directory = await create();
    const remove = Deno.remove;
    using observer = await Deno.open(`${directory}/owner.lock`, {
      read: true,
      write: true,
    });
    let checked = false;
    Deno.remove = async (path, options) => {
      if (path === directory) {
        checked = true;
        equal(observer.tryLockSync(true), false);
      }
      await remove(path, options);
    };
    try {
      await storage.remove(directory);
      equal(checked, true);
      equal(observer.tryLockSync(true), true);
    } finally {
      Deno.remove = remove;
    }
  }));

Deno.test("snapshot removal keeps ownership after a deletion failure until retry succeeds", () =>
  withSnapshots(async (_root, create) => {
    const directory = await create();
    const remove = Deno.remove;
    using observer = await Deno.open(`${directory}/owner.lock`, {
      read: true,
      write: true,
    });
    Deno.remove = (path, options) => {
      if (path === directory) {
        return Promise.reject(new Deno.errors.PermissionDenied("denied"));
      }
      return remove(path, options);
    };
    try {
      await rejects(
        () => storage.remove(directory),
        Deno.errors.PermissionDenied,
      );
      equal(await exists(directory), true);
      equal(observer.tryLockSync(true), false);
    } finally {
      Deno.remove = remove;
    }
    await create("after-failure");
    equal(await exists(directory), true);
    await storage.remove(directory);
    equal(observer.tryLockSync(true), true);
  }));

Deno.test("failed native spawn deletes its default snapshot while still owning it", () =>
  withSnapshots(async (root) => {
    let directory = "";
    let observer: Deno.FsFile | undefined;
    const failed = Promise.withResolvers<Error>();
    const endpoint = new NativeProcessEndpoint(
      new URL(
        `${await Deno.realPath(root)}/src/adapters/out/sysml-toolkit/worker.ts`,
        "file://",
      ),
      {
        spawnChild(info) {
          directory = info.snapshotDirectory;
          observer = Deno.openSync(`${directory}/owner.lock`, {
            read: true,
            write: true,
          });
          equal(observer.tryLockSync(true), false);
          throw new Error("spawn refused");
        },
      },
    );
    endpoint.on("error", failed.resolve);
    try {
      endpoint.postMessage({
        id: 1,
        packageDir: "/unused",
        request: { operation: "check", sources: {} },
      });
      equal((await failed.promise).message, "spawn refused");
      ok(directory);
      equal(await exists(directory), false);
      equal(observer?.tryLockSync(true), true);
    } finally {
      observer?.close();
      await endpoint.terminate();
    }
  }));

Deno.test("snapshot sweep reclaims the copy of a SIGKILLed Deno owner", () =>
  withSnapshots(async (root, create) => {
    const module = new URL(
      "../../src/infrastructure/native/process-client.ts",
      import.meta.url,
    ).href;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { defaultSnapshotStorage } from ${JSON.stringify(module)};
console.log(await defaultSnapshotStorage.create(${
          JSON.stringify(root)
        }, "child"));
await Deno.stdin.read(new Uint8Array(1));`,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
    }).spawn();
    let killed = false;
    try {
      let directory = "";
      for await (const line of readBoundedLines(child.stdout, 4096)) {
        directory = line;
        break;
      }
      ok(directory);
      await create("while-alive");
      equal(await exists(directory), true);
      child.kill("SIGKILL");
      killed = true;
      equal((await child.status).signal, "SIGKILL");
      await create("after-death");
      equal(await exists(directory), false);
    } finally {
      if (!killed) child.kill("SIGKILL");
      await child.status;
      await child.stdin.close().catch(() => undefined);
    }
  }));
