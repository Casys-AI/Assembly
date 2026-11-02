/** Real process/OS-lock contracts only; no product, native compiler or database. */
import { equal, ok } from "node:assert/strict";
import { kill } from "node:process";
import { resolve } from "node:path";
import {
  acquireTestLock,
  APP_ROOT,
  releaseTestLock,
  runProcessGroup,
  stageEnvironment,
} from "../../tools/test-runner.ts";

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const runnerUrl = new URL("../../tools/test-runner.ts", import.meta.url).href;

function alive(pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "ESRCH") return false;
    throw error;
  }
}

function stopOwnedPid(pid: number): void {
  try {
    kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as { code?: string }).code !== "ESRCH") throw error;
  }
}

async function recordedPid(
  directory: string,
  name: string,
): Promise<number | undefined> {
  try {
    const pid = Number(await Deno.readTextFile(resolve(directory, name)));
    if (Number.isInteger(pid) && pid > 0 && pid !== Deno.pid) return pid;
    throw new Error("Invalid owned fixture PID");
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function withOwnedTemp(
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const base = Deno.env.get("TMPDIR") ?? resolve(APP_ROOT, ".data/test-runs");
  await Deno.mkdir(base, { recursive: true });
  const directory = await Deno.makeTempDir({
    dir: base,
    prefix: "runner-contract-",
  });
  try {
    await run(directory);
  } finally {
    // Assertion failures must still clean only the exact PIDs this fixture created.
    for (const name of ["parent.pid", "grandchild.pid"]) {
      const pid = await recordedPid(directory, name);
      if (pid) {
        stopOwnedPid(name === "parent.pid" ? -pid : pid);
      }
    }
    await Deno.remove(directory, { recursive: true });
  }
}

function processTree(directory: string, parentExits: boolean): string {
  const grandchild = `
    ${parentExits ? "" : 'Deno.addSignalListener("SIGTERM", () => {});'}
    Deno.writeTextFileSync(${
    JSON.stringify(resolve(directory, "grandchild.pid"))
  }, String(Deno.pid));
    setInterval(() => {}, 1000);
  `;
  return `
    Deno.addSignalListener("SIGTERM", () => {});
    const child = new Deno.Command(Deno.execPath(), {
      args: ["eval", "--no-check", ${JSON.stringify(grandchild)}],
      stdin: "null", stdout: "null", stderr: "inherit",
    }).spawn();
    Deno.writeTextFileSync(${
    JSON.stringify(resolve(directory, "parent.pid"))
  }, String(Deno.pid));
    while (true) {
      try { await Deno.stat(${
    JSON.stringify(resolve(directory, "grandchild.pid"))
  }); break; }
      catch (error) { if (!(error instanceof Deno.errors.NotFound)) throw error; }
      await new Promise(done => setTimeout(done, 5));
    }
    ${parentExits ? "Deno.exit(0);" : "await child.status;"}
  `;
}

function runFixture(
  directory: string,
  source: string,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
  return runProcessGroup(Deno.execPath(), ["eval", "--no-check", source], {
    cwd: APP_ROOT,
    env: stageEnvironment(Deno.env.toObject(), "integration", directory),
    deadline: Date.now() + (options.timeoutMs ?? 1000),
    graceMs: 50,
    signal: options.signal,
  });
}

Deno.test("runner timeout kills its real SIGTERM-resistant grandchild", async () => {
  await withOwnedTemp(async (directory) => {
    equal(
      await runFixture(directory, processTree(directory, false), {
        timeoutMs: 700,
      }),
      124,
    );
    for (const name of ["parent.pid", "grandchild.pid"]) {
      const pid = await recordedPid(directory, name);
      ok(pid, `${name} must have started before the timeout`);
      equal(alive(pid), false, `${name} must not survive the runner`);
    }
  });
});

Deno.test("runner cleans surviving descendants even when the direct parent succeeds", async () => {
  await withOwnedTemp(async (directory) => {
    equal(await runFixture(directory, processTree(directory, true)), 0);
    const pid = await recordedPid(directory, "grandchild.pid");
    ok(pid);
    equal(alive(pid), false);
  });
});

Deno.test("runner propagates real failures and SIGTERM/SIGHUP cancellation", async () => {
  await withOwnedTemp(async (directory) => {
    equal(await runFixture(directory, "Deno.exit(17)"), 17);
    for (const [reason, code] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
      const controller = new AbortController();
      const marker = resolve(directory, "ready");
      const pending = runFixture(
        directory,
        `Deno.writeTextFileSync(${
          JSON.stringify(marker)
        }, "ready"); setInterval(() => {}, 1000)`,
        {
          signal: controller.signal,
        },
      );
      try {
        const deadline = Date.now() + 700;
        while (true) {
          try {
            await Deno.stat(marker);
            break;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          ok(Date.now() < deadline, "signal fixture must become ready");
          await pause(5);
        }
        controller.abort(reason);
        equal(await pending, code);
      } finally {
        controller.abort(reason);
        await pending;
        await Deno.remove(marker).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      }
    }
  });
});

/** Another process tries the lock once (or waits) and records why it failed
 * and what it logged while waiting. */
function lockFixture(directory: string, waitSeconds = 0): string {
  return `
    import { acquireTestLock, releaseTestLock } from ${
    JSON.stringify(runnerUrl)
  };
    console.log = (message) => Deno.writeTextFileSync(${
    JSON.stringify(resolve(directory, "waiting.log"))
  }, message + "\\n", { append: true });
    try {
      const lock = await acquireTestLock(${
    JSON.stringify(resolve(directory, "assembly-test-runner.lock"))
  }, {
        profile: "unit", cwd: ${JSON.stringify(directory)}, pid: Deno.pid,
      }, ${waitSeconds});
      releaseTestLock(lock);
    } catch (error) {
      Deno.writeTextFileSync(${
    JSON.stringify(resolve(directory, "refusal.txt"))
  }, error.message);
      Deno.exit(23);
    }
  `;
}

async function exitedPid(): Promise<number> {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", ""],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  await child.status;
  return child.pid;
}

Deno.test("runner production lock records its holder, names it to another process and clears on release", async () => {
  await withOwnedTemp(async (directory) => {
    const path = resolve(directory, "assembly-test-runner.lock");
    const holder = { profile: "standard", cwd: directory, pid: Deno.pid };
    const lock = await acquireTestLock(
      resolve(directory, "assembly-test-runner.lock"),
      holder,
      0,
    );
    try {
      equal(await Deno.readTextFile(path), JSON.stringify(holder));
      equal(await runFixture(directory, lockFixture(directory)), 23);
      equal(
        await Deno.readTextFile(resolve(directory, "refusal.txt")),
        `Another test runner holds this repository's shared lock: profile standard in ${directory} (pid ${Deno.pid}); pass --wait=SECONDS to wait for it`,
      );
    } finally {
      releaseTestLock(lock);
    }
    equal(await Deno.readTextFile(path), "");
    equal(await runFixture(directory, lockFixture(directory)), 0);
  });
});

Deno.test("runner production lock waits in another process until its holder releases", async () => {
  await withOwnedTemp(async (directory) => {
    const lock = await acquireTestLock(
      resolve(directory, "assembly-test-runner.lock"),
      {
        profile: "standard",
        cwd: directory,
        pid: Deno.pid,
      },
      0,
    );
    const log = resolve(directory, "waiting.log");
    const waiting = runFixture(directory, lockFixture(directory, 10), {
      timeoutMs: 8000,
    });
    try {
      // Release only once the other process has seen the lock busy and is
      // polling, so the exit code proves the wait rather than a free lock.
      const deadline = Date.now() + 6000;
      while (true) {
        try {
          if ((await Deno.readTextFile(log)).includes("waiting up to")) break;
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        ok(Date.now() < deadline, "the other process must report a busy lock");
        await pause(20);
      }
    } finally {
      releaseTestLock(lock);
    }
    equal(await waiting, 0);
    const lines = (await Deno.readTextFile(log)).trim().split("\n");
    equal(
      lines[0],
      `The shared test lock is held by profile standard in ${directory} (pid ${Deno.pid}); waiting up to 10s (--wait=0 fails at once)`,
    );
    ok(/^Acquired the shared test lock after waiting \d+s$/.test(lines[1]));
    equal(lines.length, 2);
  });
});

Deno.test("runner production lock reports and replaces a record whose pid has exited", async () => {
  await withOwnedTemp(async (directory) => {
    const path = resolve(directory, "assembly-test-runner.lock");
    const pid = await exitedPid();
    equal(alive(pid), false);
    const stale = JSON.stringify({ profile: "workspace", cwd: "/gone", pid });
    await Deno.writeTextFile(path, stale);
    // A holder without a record (an older runner) keeps the stale one visible.
    const unrecorded = await Deno.open(path, { read: true, write: true });
    try {
      ok(unrecorded.tryLockSync(true));
      equal(await runFixture(directory, lockFixture(directory)), 23);
      equal(
        await Deno.readTextFile(resolve(directory, "refusal.txt")),
        `Another test runner holds this repository's shared lock: an unidentified runner (stale record: pid ${pid} has exited); pass --wait=SECONDS to wait for it`,
      );
    } finally {
      unrecorded.close();
    }
    // Free again: the stale record never blocks and is replaced.
    const holder = { profile: "standard", cwd: directory, pid: Deno.pid };
    const lock = await acquireTestLock(
      resolve(directory, "assembly-test-runner.lock"),
      holder,
      0,
    );
    try {
      equal(await Deno.readTextFile(path), JSON.stringify(holder));
    } finally {
      releaseTestLock(lock);
    }
  });
});
