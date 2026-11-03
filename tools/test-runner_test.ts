import {
  deepStrictEqual,
  equal,
  ok,
  rejects,
  throws,
} from "node:assert/strict";
import {
  assertDedicatedPostgresUrl,
  createTestPlan,
  defaultJobs,
  describeLockHolder,
  holdsSharedTestLock,
  interruptionCode,
  isWithin,
  main,
  parseLockHolder,
  parseRunnerOptions,
  probeProcessGroup,
  processExists,
  type Profile,
  profileSeconds,
  selectPath,
  signalProcessGroup,
  stageEnvironment,
  type TestLockAttempt,
  testLockPath,
  timedStageArguments,
  waitForTestLock,
} from "./test-runner.ts";

Deno.test("runner cleanup treats EPERM as unknown until an ESRCH probe proves absence", () => {
  const permission = Object.assign(new Error("permission denied"), {
    code: "EPERM",
  });
  const missing = Object.assign(new Error("no group"), { code: "ESRCH" });
  const calls: Array<[number, number | string]> = [];
  const responses = [permission, permission, permission, missing];
  const kill = (pid: number, signal: 0 | "SIGTERM" | "SIGKILL") => {
    calls.push([pid, signal]);
    throw responses.shift()!;
  };
  equal(probeProcessGroup(kill, 42), "permission-denied");
  equal(signalProcessGroup(kill, 42, "SIGTERM"), "permission-denied");
  equal(signalProcessGroup(kill, 42, "SIGKILL"), "permission-denied");
  equal(probeProcessGroup(kill, 42), "absent");
  deepStrictEqual(calls, [[-42, 0], [-42, "SIGTERM"], [-42, "SIGKILL"], [
    -42,
    0,
  ]]);
  equal(
    probeProcessGroup(() => {
      throw permission;
    }, 42),
    "permission-denied",
  );
  equal(
    probeProcessGroup(() => {
      throw permission;
    }, 42) !== "absent",
    true,
    "persistent EPERM remains an outstanding group at the reap deadline",
  );
  equal(probeProcessGroup(() => {}, 42), "present");
  equal(signalProcessGroup(() => {}, 42, "SIGTERM"), "sent");
  equal(
    signalProcessGroup(
      () => {
        throw missing;
      },
      42,
      "SIGTERM",
    ),
    "absent",
  );
  throws(() =>
    probeProcessGroup(() => {
      throw new Error("unexpected");
    }, 42), /unexpected/);
  throws(() =>
    signalProcessGroup(
      () => {
        throw new Error("unexpected");
      },
      42,
      "SIGKILL",
    ), /unexpected/);
});

Deno.test("runner normal profiles are bounded sequential production test roots", () => {
  const options = parseRunnerOptions(["standard"]);
  const plan = createTestPlan(options);
  equal(plan.timeoutSeconds, 115);
  deepStrictEqual(plan.stages.map((stage) => stage.name), [
    "unit",
    "setup",
  ]);
  const workspace = createTestPlan(parseRunnerOptions(["workspace"]));
  equal(workspace.timeoutSeconds, 132);
  equal(workspace.slow, false);
  deepStrictEqual(workspace.stages.map((stage) => stage.name), [
    "unit",
    "setup",
    "frontend",
    "frontend-dom",
  ]);
  ok(plan.stages[0].roots.includes("tools/test-runner_test.ts"));
  deepStrictEqual(
    plan.stages[0].args.filter((flag) => flag.startsWith("--allow-")),
    [
      "--allow-env=READABLE_STREAM,ANTHROPIC_CUSTOM_HEADERS,FORCE_COLOR,NODE_DISABLE_COLORS,NO_COLOR,TERM,DEBUG,DEBUG_COLORS,_CLUSTER_NETWORK_NAME_,COMPUTERNAME",
    ],
  );
  for (const stage of plan.stages) {
    for (
      const flag of [
        "--no-check",
        "--frozen",
        "--no-prompt",
        "--fail-fast",
        "--parallel",
      ]
    ) ok(stage.args.includes(flag));
    ok(!stage.roots.includes("test/heavy"));
  }
  equal(parseRunnerOptions(["changed"]).timeoutSeconds, 175);
  equal(parseRunnerOptions(["changed"]).changed, true);
  equal(parseRunnerOptions(["unit"]).timeoutSeconds, 80);
  equal(parseRunnerOptions(["setup"]).timeoutSeconds, 35);
  equal(parseRunnerOptions(["frontend"]).timeoutSeconds, 17);
});

Deno.test("runner default workers are half the CPUs, at least one and at most four", () => {
  for (
    const [cpus, jobs] of [[1, 1], [2, 1], [3, 1], [6, 3], [8, 4], [10, 4], [
      64,
      4,
    ]]
  ) equal(defaultJobs(cpus), jobs, `${cpus} CPUs`);
  equal(parseRunnerOptions(["standard"], 10).jobs, 4);
  equal(parseRunnerOptions(["standard"], 2).jobs, 1);
  equal(parseRunnerOptions(["frontend", "--jobs=2"], 10).jobs, 2);
  equal(parseRunnerOptions(["workspace-changed", "--jobs=10"], 10).jobs, 10);
  for (const value of ["0", "-1", "1.5", "two", "", "11"]) {
    throws(
      () => parseRunnerOptions(["unit", `--jobs=${value}`], 10),
      /Jobs must be a whole number of workers from 1 to 10/,
    );
  }
  throws(
    () => parseRunnerOptions(["unit", "--jobs=2", "--jobs=3"], 10),
    /Repeated option: --jobs/,
  );
  throws(() => parseRunnerOptions(["unit", "--jobs"], 10), /Unsupported/);
  for (
    const profile of [
      "integration-full",
      "toolkit",
      "postgres",
      "postgres-toolkit",
      "heavy",
      "semantic",
    ]
  ) {
    throws(
      () => parseRunnerOptions([profile, "--plan", "--jobs=2"], 10),
      /Parallel workers apply only to unit, setup and frontend stages/,
    );
  }
});

Deno.test("runner parallelizes only unit, setup and frontend stages", () => {
  const parallel = ["unit", "setup", "frontend", "frontend-dom"];
  const plans = [
    createTestPlan(parseRunnerOptions(["workspace-full", "--jobs=3"], 10)),
    createTestPlan(parseRunnerOptions(["changed", "--jobs=3"], 10)),
    ...["postgres", "postgres-toolkit", "heavy", "semantic"].map((profile) =>
      createTestPlan(parseRunnerOptions([profile, "--plan"], 10))
    ),
  ];
  const seen = new Set<string>();
  for (const stage of plans.flatMap((plan) => plan.stages)) {
    seen.add(stage.name);
    const isParallel = parallel.includes(stage.name);
    equal(stage.jobs, isParallel ? 3 : 1, stage.name);
    equal(
      stage.args.includes("--parallel"),
      isParallel || stage.name === "heavy",
      stage.name,
    );
    equal(
      stageEnvironment({}, stage.name, "/owned", false, stage.jobs).DENO_JOBS,
      String(stage.jobs),
      stage.name,
    );
  }
  equal(seen.size, 10);
  const single = createTestPlan(parseRunnerOptions(["unit", "--jobs=1"], 10));
  equal(single.stages[0].jobs, 1);
  ok(single.stages[0].args.includes("--parallel"));
  const env = stageEnvironment({ DENO_JOBS: "9" }, "unit", "/owned", false, 4);
  equal(env.DENO_JOBS, "4");
  equal(env.RAYON_NUM_THREADS, "1");
  equal(env.TOKIO_WORKER_THREADS, "1");
  equal(stageEnvironment({ DENO_JOBS: "9" }, "unit", "/owned").DENO_JOBS, "1");
  for (
    const stage of [
      "integration",
      "toolkit",
      "postgres",
      "postgres-toolkit",
      "heavy",
      "semantic",
    ] as const
  ) {
    throws(
      () => stageEnvironment({}, stage, "/owned", false, 2),
      /Parallel workers are unavailable for this test stage/,
    );
  }
});

Deno.test("runner fails fast by default and collects every failure on request", () => {
  const fast = createTestPlan(parseRunnerOptions(["workspace"]));
  equal(fast.failFast, true);
  ok(fast.stages.every((stage) => stage.args.includes("--fail-fast")));
  const options = parseRunnerOptions(["workspace", "--no-fail-fast"]);
  equal(options.failFast, false);
  const collecting = createTestPlan(options);
  equal(collecting.failFast, false);
  deepStrictEqual(
    collecting.stages.map((stage) => stage.name),
    fast.stages.map((stage) => stage.name),
  );
  ok(collecting.stages.every((stage) => !stage.args.includes("--fail-fast")));
  ok(
    createTestPlan(
      parseRunnerOptions([
        "integration",
        "--no-fail-fast",
        "test/integration/tool-runner_test.ts",
      ]),
    ).stages[0].args.every((flag) => flag !== "--fail-fast"),
  );
  throws(
    () => parseRunnerOptions(["unit", "--no-fail-fast", "--no-fail-fast"]),
    /Repeated option: --no-fail-fast/,
  );
  throws(
    () => parseRunnerOptions(["unit", "--no-fail-fast=true"]),
    /Unsupported test option/,
  );
});

Deno.test("runner deadlines are the sum of measured per-stage budgets", () => {
  const budgets = {
    unit: 80,
    setup: 35,
    frontend: 12,
    "frontend-dom": 5,
    integration: 60,
    toolkit: 1200,
    postgres: 1200,
    "postgres-toolkit": 1200,
    heavy: 1200,
    semantic: 1200,
  };
  const profiles: Profile[] = [
    "standard",
    "changed",
    "unit",
    "setup",
    "integration",
    "integration-full",
    "frontend",
    "frontend-dom",
    "frontend-changed",
    "workspace",
    "workspace-changed",
    "toolkit",
    "postgres",
    "postgres-toolkit",
    "heavy",
    "semantic",
    "full",
    "workspace-full",
  ];
  for (const profile of profiles) {
    const plan = createTestPlan(parseRunnerOptions([profile, "--plan"]));
    const sum = plan.stages.reduce(
      (total, stage) => total + stage.budgetSeconds,
      0,
    );
    equal(plan.timeoutSeconds, sum, profile);
    equal(profileSeconds(profile), sum, profile);
    for (const stage of plan.stages) {
      equal(
        stage.budgetSeconds,
        profile === "integration-full" ? 390 : budgets[stage.name],
        `${profile}/${stage.name}`,
      );
    }
    throws(
      () =>
        parseRunnerOptions([
          profile,
          "--plan",
          `--timeout=${plan.slow ? 3601 : sum + 1}`,
        ]),
      /Timeout exceeds this profile's permitted budget/,
      profile,
    );
  }
  equal(profileSeconds("workspace"), 132);
  equal(profileSeconds("full"), 1315);
  // A narrowed selection keeps the profile deadline and each stage budget.
  const narrowed = createTestPlan(
    parseRunnerOptions(["workspace-changed", "--filter=x"]),
  );
  equal(narrowed.timeoutSeconds, 192);
  const unitOnly = createTestPlan(
    parseRunnerOptions(["standard", "src/domain/work/types_test.ts"]),
  );
  equal(unitOnly.timeoutSeconds, 115);
  deepStrictEqual(
    unitOnly.stages.map((stage) => [stage.name, stage.budgetSeconds]),
    [["unit", 80]],
  );
});

Deno.test("runner waits a bounded time for the shared lock by default", () => {
  equal(parseRunnerOptions(["standard"]).waitSeconds, 900);
  equal(parseRunnerOptions(["standard", "--wait=0"]).waitSeconds, 0);
  equal(parseRunnerOptions(["frontend", "--wait=60"]).waitSeconds, 60);
  equal(
    parseRunnerOptions(["heavy", "--plan", "--wait=3600"]).waitSeconds,
    3600,
  );
  for (const value of ["", "-1", "1.5", "01", "3601", "soon"]) {
    throws(
      () => parseRunnerOptions(["unit", `--wait=${value}`]),
      /Wait must be a whole number of seconds from 0 to 3600/,
    );
  }
  throws(() => parseRunnerOptions(["unit", "--wait"]), /Unsupported/);
  throws(
    () => parseRunnerOptions(["unit", "--wait=1", "--wait=2"]),
    /Repeated option: --wait/,
  );
});

Deno.test("runner takes the shared lock only for slow profiles", () => {
  for (const profile of ["workspace", "unit", "changed"]) {
    equal(
      holdsSharedTestLock(createTestPlan(parseRunnerOptions([profile]))),
      false,
      profile,
    );
  }
  for (
    const profile of [
      "postgres-toolkit",
      "toolkit",
      "integration-full",
      "heavy",
    ]
  ) {
    equal(
      holdsSharedTestLock(
        createTestPlan(parseRunnerOptions([profile, "--allow-slow"])),
      ),
      true,
      profile,
    );
  }
});

Deno.test("runner lock path is one /tmp file per Git common directory", () => {
  const common = "/repo/.git";
  equal(testLockPath(common), testLockPath(common));
  ok(
    /^\/tmp\/assembly-test-runner-[0-9a-f]{16}\.lock$/.test(
      testLockPath(common),
    ),
  );
  ok(testLockPath(common) !== testLockPath("/other/.git"));
});

Deno.test("runner lock records name a live holder and treat an exited pid as stale", () => {
  const holder = { profile: "workspace", cwd: "/repo/worktree", pid: 42 };
  deepStrictEqual(parseLockHolder(JSON.stringify(holder)), holder);
  deepStrictEqual(
    parseLockHolder(JSON.stringify({ ...holder, extra: "ignored" })),
    holder,
  );
  for (
    const text of [
      "",
      '{"profile":"workspace","cwd":"/re',
      "null",
      "[]",
      JSON.stringify({ ...holder, pid: 0 }),
      JSON.stringify({ ...holder, pid: -3 }),
      JSON.stringify({ ...holder, pid: 1.5 }),
      JSON.stringify({ ...holder, pid: "42" }),
      JSON.stringify({ ...holder, cwd: 7 }),
      JSON.stringify({ cwd: "/repo", pid: 42 }),
    ]
  ) equal(parseLockHolder(text), undefined, text);
  equal(
    describeLockHolder(holder, () => true),
    "profile workspace in /repo/worktree (pid 42)",
  );
  equal(
    describeLockHolder(holder, () => false),
    "an unidentified runner (stale record: pid 42 has exited)",
  );
  equal(describeLockHolder(undefined, () => true), "an unidentified runner");
  const calls: Array<[number, number | string]> = [];
  const failing = (code: string) => (pid: number, signal: 0 | string) => {
    calls.push([pid, signal]);
    throw Object.assign(new Error(code), { code });
  };
  equal(
    processExists((pid, signal) => {
      calls.push([pid, signal]);
    }, 42),
    true,
  );
  equal(processExists(failing("ESRCH"), 42), false);
  equal(processExists(failing("EPERM"), 42), true);
  throws(() => processExists(failing("EINVAL"), 42), /EINVAL/);
  deepStrictEqual(calls, [[42, 0], [42, 0], [42, 0], [42, 0]]);
});

function lockAttempt(
  free: boolean[],
  holders: string[] = ["profile workspace in /repo/a (pid 42)"],
  signal?: AbortSignal,
) {
  let time = 0;
  const sleeps: number[] = [];
  const logs: string[] = [];
  let attempts = 0;
  const attempt: TestLockAttempt = {
    tryLock: () => free[attempts++] ?? false,
    holder: () => holders.length > 1 ? holders.shift()! : holders[0],
    now: () => time,
    sleep: (milliseconds) => {
      sleeps.push(milliseconds);
      time += milliseconds;
      return Promise.resolve();
    },
    log: (message) => logs.push(message),
    signal,
  };
  return { attempt, sleeps, logs, attempts: () => attempts };
}

Deno.test("runner lock wait acquires a free lock without waiting or logging", async () => {
  const free = lockAttempt([true]);
  await waitForTestLock(free.attempt, 900);
  equal(free.attempts(), 1);
  deepStrictEqual(free.sleeps, []);
  deepStrictEqual(free.logs, []);
});

Deno.test("runner lock wait zero fails at once and names the holder", async () => {
  const busy = lockAttempt([false]);
  await rejects(
    () => waitForTestLock(busy.attempt, 0),
    (error: Error) =>
      error.message ===
        "Another test runner holds this repository's shared lock: profile workspace in /repo/a (pid 42); pass --wait=SECONDS to wait for it",
  );
  equal(busy.attempts(), 1);
  deepStrictEqual(busy.sleeps, []);
});

Deno.test("runner lock wait polls until the holder releases the lock", async () => {
  const later = lockAttempt([false, false, false, true]);
  await waitForTestLock(later.attempt, 900);
  equal(later.attempts(), 4);
  deepStrictEqual(later.sleeps, [1000, 1000, 1000]);
  deepStrictEqual(later.logs, [
    "The shared test lock is held by profile workspace in /repo/a (pid 42); waiting up to 900s (--wait=0 fails at once)",
    "Acquired the shared test lock after waiting 3s",
  ]);
});

Deno.test("runner lock wait is bounded and reports each new holder", async () => {
  const busy = lockAttempt([], [
    "profile workspace in /repo/a (pid 42)",
    "profile workspace in /repo/a (pid 42)",
    "profile frontend in /repo/b (pid 43)",
  ]);
  await rejects(
    () => waitForTestLock(busy.attempt, 2),
    (error: Error) =>
      error.message ===
        "The shared test lock is still held by profile frontend in /repo/b (pid 43) after 2s; retry later or raise --wait",
  );
  deepStrictEqual(busy.sleeps, [1000, 1000]);
  equal(busy.attempts(), 3);
  deepStrictEqual(busy.logs, [
    "The shared test lock is held by profile workspace in /repo/a (pid 42); waiting up to 2s (--wait=0 fails at once)",
    "The shared test lock is now held by profile frontend in /repo/b (pid 43); waiting",
  ]);
});

Deno.test("runner lock wait stops when the run is interrupted, even if the lock frees", async () => {
  const controller = new AbortController();
  const busy = lockAttempt([false, true], undefined, controller.signal);
  const sleep = busy.attempt.sleep;
  busy.attempt.sleep = async (milliseconds) => {
    await sleep(milliseconds);
    controller.abort("SIGINT");
  };
  await rejects(
    () => waitForTestLock(busy.attempt, 900),
    /Interrupted while waiting for the shared test lock/,
  );
  deepStrictEqual(busy.sleeps, [1000]);
  equal(busy.attempts(), 1, "an interrupted wait never retries the lock");
});

Deno.test("runner focused integration requires explicit affected-test selection", () => {
  for (const extra of [[], ["--filter=source"], ["--allow-slow"]]) {
    throws(
      () => parseRunnerOptions(["integration", ...extra]),
      /Focused integration requires/,
    );
  }
  const planOnly = createTestPlan(
    parseRunnerOptions(["integration", "--plan"]),
  );
  equal(planOnly.timeoutSeconds, 60);
  equal(planOnly.slow, false);
  deepStrictEqual(planOnly.stages[0].selectors, ["test/integration"]);
  const file = "test/integration/request-release-catalogue_test.ts";
  const selected = createTestPlan(parseRunnerOptions(["integration", file]));
  deepStrictEqual(selected.stages[0].selectors, [file]);
  const related = createTestPlan(parseRunnerOptions([
    "integration",
    "--related=src/application/work/runtime/system.ts",
  ]));
  ok(
    related.stages[0].args.includes(
      "--related=src/application/work/runtime/system.ts",
    ),
  );
  const changed = createTestPlan(
    parseRunnerOptions(["integration", "--changed=HEAD~1"]),
  );
  ok(changed.stages[0].args.includes("--changed=HEAD~1"));
  throws(() =>
    parseRunnerOptions(["integration", file, "--timeout=61", "--allow-slow"])
  );
});

Deno.test("runner CPU profiling requires one file in an explicitly supported profile", () => {
  const file = "test/integration/tool-runner_test.ts";
  const selected = parseRunnerOptions(["integration", "--cpu-profile", file]);
  equal(selected.cpuProfile, true);
  equal(selected.timeoutSeconds, 60);
  equal(parseRunnerOptions(["standard"]).cpuProfile, false);
  for (
    const profile of [
      "standard",
      "full",
      "integration-full",
      "toolkit",
      "postgres",
      "heavy",
    ]
  ) {
    throws(
      () => parseRunnerOptions([profile, "--cpu-profile", file]),
      /CPU profiling requires/,
    );
  }
  for (
    const selection of [
      [],
      ["test/integration"],
      ["--related=src/a.ts"],
      [file, file],
    ]
  ) {
    throws(
      () =>
        parseRunnerOptions([
          "integration",
          "--plan",
          "--cpu-profile",
          ...selection,
        ]),
      /CPU profiling requires/,
    );
  }
  throws(
    () =>
      parseRunnerOptions([
        "integration",
        "--cpu-profile",
        "--cpu-profile",
        file,
      ]),
    /Repeated option/,
  );
  throws(
    () => parseRunnerOptions(["integration", "--cpu-profile=true", file]),
    /Unsupported test option/,
  );
  throws(() =>
    createTestPlan(parseRunnerOptions([
      "integration",
      "--cpu-profile",
      "../outside_test.ts",
    ]))
  );
});

Deno.test("runner CPU profiling merges only the inspector permission and retains profile budgets", () => {
  const integration = createTestPlan(parseRunnerOptions([
    "integration",
    "--cpu-profile",
    "test/integration/tool-runner_test.ts",
  ]));
  deepStrictEqual(
    integration.stages[0].args.filter((flag) => flag.startsWith("--allow-sys")),
    ["--allow-sys=inspector"],
  );
  equal(integration.timeoutSeconds, 60);
  equal(integration.stages[0].cpuProfile, true);
  ok(!integration.stages[0].args.includes("--cpu-profile"));
  const combined = createTestPlan(parseRunnerOptions([
    "postgres-toolkit",
    "--allow-slow",
    "--cpu-profile",
    "test/integration/postgres-request-retained-target_test.ts",
  ]));
  deepStrictEqual(
    combined.stages[0].args.filter((flag) => flag.startsWith("--allow-sys")),
    ["--allow-sys=hostname,systemMemoryInfo,cpus,inspector"],
  );
  equal(combined.timeoutSeconds, 1200);
  equal(combined.slow, true);
  const ordinary = createTestPlan(parseRunnerOptions([
    "postgres-toolkit",
    "test/integration/postgres-request-retained-target_test.ts",
  ]));
  deepStrictEqual(
    ordinary.stages[0].args.filter((flag) => flag.startsWith("--allow-sys")),
    ["--allow-sys=hostname,systemMemoryInfo,cpus"],
  );
  ok(ordinary.stages[0].args.every((flag) => !flag.includes("inspector")));
});

Deno.test("runner CPU profiling strips inherited activation and enables only selected test environments", () => {
  const inherited = { ASSEMBLY_TEST_CPU_PROFILE: "1", PATH: "/bin" };
  for (
    const stage of [
      "unit",
      "setup",
      "integration",
      "frontend",
      "frontend-dom",
      "toolkit",
      "postgres",
      "postgres-toolkit",
      "heavy",
      "semantic",
    ] as const
  ) {
    equal(
      stageEnvironment(inherited, stage, "/owned").ASSEMBLY_TEST_CPU_PROFILE,
      undefined,
    );
  }
  for (const stage of ["integration", "postgres-toolkit"] as const) {
    equal(
      stageEnvironment(inherited, stage, "/owned", true)
        .ASSEMBLY_TEST_CPU_PROFILE,
      "1",
    );
    equal(
      stageEnvironment({}, stage, "/owned", true).ASSEMBLY_TEST_CPU_PROFILE,
      "1",
    );
  }
  throws(
    () => stageEnvironment(inherited, "toolkit", "/owned", true),
    /CPU profiling is unavailable/,
  );
  equal(inherited.ASSEMBLY_TEST_CPU_PROFILE, "1");
});

Deno.test("runner changed loops retain affected integration within their stage budgets", () => {
  for (const profile of ["changed", "workspace-changed"]) {
    const plan = createTestPlan(
      parseRunnerOptions([profile, "--changed=HEAD~1"]),
    );
    equal(plan.timeoutSeconds, profile === "changed" ? 175 : 192);
    equal(plan.slow, false);
    deepStrictEqual(
      plan.stages.map((stage) => stage.name),
      profile === "changed"
        ? ["unit", "setup", "integration"]
        : ["unit", "setup", "integration", "frontend", "frontend-dom"],
    );
    ok(plan.stages.every((stage) => stage.args.includes("--changed=HEAD~1")));
    deepStrictEqual(
      plan.stages.find((stage) => stage.name === "integration")?.selectors,
      ["test/integration"],
    );
  }
});

Deno.test("runner complete integration is an explicit unfiltered sequential profile", () => {
  const plan = createTestPlan(
    parseRunnerOptions(["integration-full", "--plan"]),
  );
  equal(plan.timeoutSeconds, 390);
  equal(plan.stages[0].budgetSeconds, 390);
  equal(plan.slow, true);
  deepStrictEqual(plan.stages.map((stage) => stage.name), ["integration"]);
  deepStrictEqual(plan.stages[0].roots, ["test/integration"]);
  deepStrictEqual(plan.stages[0].selectors, ["test/integration"]);
  ok(
    !plan.stages[0].args.some((arg) =>
      /^--(?:changed|related|filter|parallel)(?:=|$)/.test(arg)
    ),
  );
  const reduced = parseRunnerOptions([
    "integration-full",
    "--allow-slow",
    "--timeout=90",
  ]);
  equal(reduced.timeoutSeconds, 90);
  throws(() =>
    parseRunnerOptions(["integration-full", "--timeout=3601", "--allow-slow"])
  );
});

Deno.test("runner complete integration refuses missing slow acknowledgement before IO", async () => {
  await rejects(
    () => main(["integration-full"]),
    /Slow profiles require --allow-slow/,
  );
});

Deno.test("runner slow budgets cannot leak into normal profiles", () => {
  throws(() => parseRunnerOptions(["unit", "--timeout=81"]));
  throws(() =>
    parseRunnerOptions(["standard", "--timeout=116", "--allow-slow"])
  );
  equal(parseRunnerOptions(["standard", "--timeout=115"]).timeoutSeconds, 115);
  equal(parseRunnerOptions(["standard", "--timeout=5"]).timeoutSeconds, 5);
  equal(
    parseRunnerOptions(["heavy", "--allow-slow", "--timeout=3600"])
      .timeoutSeconds,
    3600,
  );
  throws(() => parseRunnerOptions(["full", "--timeout=3601"]));
  for (const value of ["0", "1.5", "NaN", "Infinity", "-1"]) {
    throws(() => parseRunnerOptions(["unit", `--timeout=${value}`]));
  }
  const full = createTestPlan(parseRunnerOptions(["full", "--plan"]));
  equal(full.slow, true);
  deepStrictEqual(full.stages.map((stage) => stage.name), [
    "unit",
    "setup",
    "toolkit",
  ]);
  const toolkit = createTestPlan(parseRunnerOptions(["toolkit", "--plan"]));
  deepStrictEqual(full.stages[2].roots, toolkit.stages[0].roots);
  ok(toolkit.stages[0].roots.includes("test/integration"));
  const workspaceFull = createTestPlan(
    parseRunnerOptions(["workspace-full", "--plan"]),
  );
  deepStrictEqual(workspaceFull.stages.map((stage) => stage.name), [
    "unit",
    "setup",
    "toolkit",
    "frontend",
    "frontend-dom",
  ]);
  deepStrictEqual(workspaceFull.stages[2].roots, toolkit.stages[0].roots);
  deepStrictEqual(
    createTestPlan(parseRunnerOptions(["heavy"])).stages[0].roots,
    ["test/heavy"],
  );
  const evolution = "test/heavy/native-evolution_test.ts";
  const heavy = createTestPlan(parseRunnerOptions(["heavy", evolution]));
  deepStrictEqual(heavy.stages[0].selectors, [evolution]);
  throws(() => createTestPlan(parseRunnerOptions(["integration", evolution])));
});

Deno.test("runner forwards only scoped file selectors and native test selection flags", () => {
  const plan = createTestPlan(
    parseRunnerOptions([
      "standard",
      "--filter",
      "mandate",
      "--changed=HEAD~1",
      "src/domain/work/types_test.ts",
    ]),
  );
  equal(plan.stages.length, 1);
  equal(plan.stages[0].name, "unit");
  ok(plan.stages[0].args.includes("--filter=mandate"));
  ok(plan.stages[0].args.includes("--changed=HEAD~1"));
  ok(
    createTestPlan(
      parseRunnerOptions([
        "integration",
        "--related=test/integration/a_test.ts",
      ]),
    ).stages[0].args.includes("--related=test/integration/a_test.ts"),
  );
  const dependencyPlan = createTestPlan(
    parseRunnerOptions([
      "integration",
      "--related=src/application/work/runtime/system.ts",
    ]),
  );
  ok(
    dependencyPlan.stages[0].args.includes(
      "--related=src/application/work/runtime/system.ts",
    ),
  );
  deepStrictEqual(dependencyPlan.stages[0].selectors, ["test/integration"]);
  throws(() =>
    createTestPlan(
      parseRunnerOptions(["integration", "--related=../outside.ts"]),
    )
  );
  for (
    const flag of [
      "--allow-all",
      "-A",
      "--config=elsewhere",
      "--ignore=x",
      "--no-check",
      "--",
      "--timeout=3",
      "--filter",
    ]
  ) {
    const args = flag === "--timeout=3" ? ["unit", flag, flag] : ["unit", flag];
    throws(() => parseRunnerOptions(args));
  }
  throws(() =>
    createTestPlan(parseRunnerOptions(["heavy", "src/work_test.ts"]))
  );
  throws(() =>
    createTestPlan(parseRunnerOptions(["setup", "tools/test-runner_test.ts"]))
  );
});

Deno.test("runner rejects lexical traversal, external selectors and workspace ambiguity", () => {
  for (
    const path of [
      "../outside_test.ts",
      "src/../../outside_test.ts",
      "test/heavy/a_test.ts",
      "src-other/a_test.ts",
      "https://invalid/test.ts",
      "src/**/*.ts",
    ]
  ) {
    throws(() => selectPath(path, "/repo/app", ["src"]));
  }
  equal(
    selectPath("src/domain/a_test.ts", "/repo/app", ["src"]),
    "src/domain/a_test.ts",
  );
  equal(isWithin("/repo/app/src-other", "/repo/app/src"), false);
  throws(() => parseRunnerOptions(["workspace", "src/a_test.ts"]));
  throws(() => parseRunnerOptions(["workspace-changed", "--related=src/a.ts"]));
  const workspace = createTestPlan(
    parseRunnerOptions(["workspace-changed", "--filter=result"]),
  );
  equal(workspace.timeoutSeconds, 192);
  deepStrictEqual(workspace.stages.map((stage) => stage.name), [
    "unit",
    "setup",
    "integration",
    "frontend",
    "frontend-dom",
  ]);
  ok(workspace.stages.every((stage) => stage.args.includes("--changed")));
});

Deno.test("runner strips inherited opt-ins and credentials without disclosing them in a plan", () => {
  const inherited = {
    PATH: "/bin",
    DEBUG: "prisma:*",
    DEBUG_COLORS: "true",
    _CLUSTER_NETWORK_NAME_: "private-host",
    COMPUTERNAME: "private-host",
    SYSML_TOOLKIT_DIR: "/native",
    ASSEMBLY_POSTGRES_TEST_URL: "private-url",
    ASSEMBLY_SEMANTIC_INTEGRATION: "1",
    ASE_SEMANTIC_INTEGRATION: "1",
    ASSEMBLY_SHACL_INTEGRATION: "1",
    ASSEMBLY_LDKIT_INTEGRATION: "1",
    ASSEMBLY_NATIVE_BUILD_INTEGRATION: "1",
    ASE_NATIVE_BUILD_INTEGRATION: "1",
    ASSEMBLY_OTHER_INTEGRATION: "1",
    ANTHROPIC_API_KEY: "private-key",
    ANTHROPIC_CUSTOM_HEADERS: "Authorization: Bearer inherited-secret",
    ASSEMBLY_DATABASE_URL: "private-database",
    DENO_COVERAGE_DIR: "/outside/coverage",
    DENO_AUDIT_PERMISSIONS: "/outside/permissions.jsonl",
    ASSEMBLY_REAL_CLAUDE: "1",
  };
  const env = stageEnvironment(inherited, "integration", "/owned/run");
  const complete = createTestPlan(
    parseRunnerOptions(["integration-full", "--plan"]),
  );
  deepStrictEqual(
    stageEnvironment(inherited, complete.stages[0].name, "/owned/run"),
    env,
  );
  const unitEnv = stageEnvironment(inherited, "unit", "/owned/run");
  equal(unitEnv.DEBUG, undefined);
  equal(unitEnv.DEBUG_COLORS, undefined);
  equal(unitEnv._CLUSTER_NETWORK_NAME_, undefined);
  equal(unitEnv.COMPUTERNAME, undefined);
  equal(inherited.DEBUG, "prisma:*");
  equal(inherited.DEBUG_COLORS, "true");
  equal(env.ASSEMBLY_SEMANTIC_INTEGRATION, "0");
  equal(env.ASSEMBLY_SHACL_INTEGRATION, "0");
  equal(env.ASSEMBLY_OTHER_INTEGRATION, "0");
  equal(env.ASE_NATIVE_BUILD_INTEGRATION, "0");
  for (
    const name of [
      "ASSEMBLY_POSTGRES_TEST_URL",
      "SYSML_TOOLKIT_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ASSEMBLY_DATABASE_URL",
      "ASSEMBLY_REAL_CLAUDE",
      "DENO_COVERAGE_DIR",
      "DENO_AUDIT_PERMISSIONS",
    ]
  ) equal(env[name], undefined);
  for (
    const stage of [
      "unit",
      "setup",
      "integration",
      "frontend",
      "frontend-dom",
      "toolkit",
      "postgres",
      "heavy",
      "semantic",
    ] as const
  ) {
    equal(
      Object.hasOwn(
        stageEnvironment(inherited, stage, "/owned/run"),
        "ANTHROPIC_CUSTOM_HEADERS",
      ),
      false,
      stage,
    );
  }
  equal(
    inherited.ANTHROPIC_CUSTOM_HEADERS,
    "Authorization: Bearer inherited-secret",
  );
  for (
    const name of ["DENO_JOBS", "RAYON_NUM_THREADS", "TOKIO_WORKER_THREADS"]
  ) equal(env[name], "1");
  for (const name of ["TMPDIR", "TMP", "TEMP"]) equal(env[name], "/owned/run");
  const plan = JSON.stringify(
    createTestPlan(parseRunnerOptions(["postgres", "--plan"])),
  );
  ok(!plan.includes("private-url"));
  ok(!plan.includes("private-key"));
  ok(!plan.includes("inherited-secret"));
});

Deno.test("runner preserves conventional interrupt exit codes including terminal hangup", () => {
  equal(interruptionCode("SIGINT"), 130);
  equal(interruptionCode("SIGTERM"), 143);
  equal(interruptionCode("SIGHUP"), 129);
});

Deno.test("runner opt-in profiles enable only their named dependencies", () => {
  const inherited = {
    SYSML_TOOLKIT_DIR: "/native",
    ASSEMBLY_POSTGRES_TEST_URL: "private-url",
  };
  const pg = stageEnvironment(inherited, "postgres", "/owned");
  equal(pg.ASSEMBLY_POSTGRES_TEST_URL, "private-url");
  equal(pg.SYSML_TOOLKIT_DIR, undefined);
  equal(pg.ASSEMBLY_SEMANTIC_INTEGRATION, "0");
  const toolkit = stageEnvironment(inherited, "toolkit", "/owned");
  equal(toolkit.SYSML_TOOLKIT_DIR, "/native");
  equal(toolkit.ASSEMBLY_POSTGRES_TEST_URL, undefined);
  const combined = stageEnvironment(inherited, "postgres-toolkit", "/owned");
  equal(combined.SYSML_TOOLKIT_DIR, "/native");
  equal(
    combined.ASSEMBLY_POSTGRES_TEST_URL,
    inherited.ASSEMBLY_POSTGRES_TEST_URL,
  );
  equal(combined.ASSEMBLY_SEMANTIC_INTEGRATION, "1");
  const combinedPlan = createTestPlan(
    parseRunnerOptions(["postgres-toolkit", "--plan"]),
  );
  equal(combinedPlan.slow, true);
  equal(
    combinedPlan.stages[0]!.roots.includes(
      "test/integration/work-budget-execution_test.ts",
    ),
    true,
  );
  const heavy = stageEnvironment(inherited, "heavy", "/owned");
  equal(heavy.ASSEMBLY_POSTGRES_TEST_URL, "private-url");
  equal(heavy.ASSEMBLY_SEMANTIC_INTEGRATION, "1");
  const semantic = stageEnvironment(inherited, "semantic", "/owned");
  equal(semantic.ASSEMBLY_SHACL_INTEGRATION, "1");
  equal(semantic.ASSEMBLY_SEMANTIC_INTEGRATION, "0");
});

Deno.test("runner postgres selects Request adoption and evolved Release authority without native opt-ins", () => {
  const files = [
    "test/integration/postgres-request-adoption-store_test.ts",
    "test/integration/postgres-evolved-release-authority_test.ts",
  ];
  const baseline = createTestPlan(parseRunnerOptions(["postgres", "--plan"]));
  const selected = createTestPlan(
    parseRunnerOptions(["postgres", "--plan", ...files]),
  );
  equal(selected.timeoutSeconds, 1200);
  equal(selected.stages.length, 1);
  equal(selected.stages[0].name, "postgres");
  deepStrictEqual(selected.stages[0].selectors, files);
  deepStrictEqual(
    selected.stages[0].args.filter((flag) => flag.startsWith("--allow-")),
    baseline.stages[0].args.filter((flag) => flag.startsWith("--allow-")),
  );
  for (const file of files) {
    ok(selected.stages[0].roots.includes(file));
    const single = createTestPlan(
      parseRunnerOptions(["postgres", "--plan", file]),
    );
    deepStrictEqual(single.stages[0].selectors, [file]);
    for (const profile of ["standard", "postgres-toolkit"]) {
      throws(
        () => createTestPlan(parseRunnerOptions([profile, "--plan", file])),
        /permitted roots/,
      );
    }
  }
});

Deno.test("runner postgres-toolkit selects Request adoption and evolved Release witnesses exactly", () => {
  const files = [
    "test/integration/postgres-request-adoption-enrollment-race_test.ts",
    "test/integration/postgres-request-runtime-adoption_test.ts",
    "test/integration/postgres-request-evolved-release_test.ts",
  ];
  const baseline = createTestPlan(
    parseRunnerOptions(["postgres-toolkit", "--plan"]),
  );
  const selected = createTestPlan(
    parseRunnerOptions(["postgres-toolkit", "--plan", ...files]),
  );
  equal(selected.timeoutSeconds, 1200);
  equal(selected.slow, true);
  equal(selected.stages.length, 1);
  equal(selected.stages[0].name, "postgres-toolkit");
  deepStrictEqual(selected.stages[0].selectors, files);
  for (const file of files) ok(selected.stages[0].roots.includes(file));
  deepStrictEqual(
    selected.stages[0].args.filter((flag) => flag.startsWith("--allow-")),
    baseline.stages[0].args.filter((flag) => flag.startsWith("--allow-")),
  );
  for (const file of files) {
    const single = createTestPlan(
      parseRunnerOptions(["postgres-toolkit", "--plan", file]),
    );
    deepStrictEqual(single.stages[0].selectors, [file]);
    for (const profile of ["standard", "postgres"]) {
      throws(
        () => createTestPlan(parseRunnerOptions([profile, "--plan", file])),
        /permitted roots/,
      );
    }
  }
});

Deno.test("runner postgres-toolkit selects the Request team and middle-authority scenarios, which need both fixtures", () => {
  for (
    const file of [
      "test/integration/request-team-workspace_test.ts",
      "test/integration/request-authority-middle_test.ts",
    ]
  ) {
    const plan = createTestPlan(
      parseRunnerOptions(["postgres-toolkit", "--plan", file]),
    );
    equal(plan.stages[0].name, "postgres-toolkit");
    deepStrictEqual(plan.stages[0].selectors, [file]);
    for (const profile of ["standard", "postgres"]) {
      throws(
        () => createTestPlan(parseRunnerOptions([profile, "--plan", file])),
        /permitted roots/,
      );
    }
  }
});

Deno.test("runner dedicated PG URL errors are safe and fail closed", () => {
  assertDedicatedPostgresUrl(
    "postgresql://fixture:secret@127.0.0.1:5432/assembly_pg1_test",
  );
  for (
    const value of [
      undefined,
      "postgresql://private:password@remote/db",
      "postgresql://localhost/demo",
      "postgresql://localhost/assembly_pg1_test?host=remote",
      "https://localhost/assembly_pg1_test",
    ]
  ) {
    throws(
      () => assertDedicatedPostgresUrl(value),
      (error) => error instanceof Error && !error.message.includes("password"),
    );
  }
});

Deno.test("frontend keeps mounted DOM JSX separate from server-precompiled tests", () => {
  const plan = createTestPlan(parseRunnerOptions(["frontend"]));
  equal(plan.timeoutSeconds, 17);
  deepStrictEqual(plan.stages.map((stage) => stage.name), [
    "frontend",
    "frontend-dom",
  ]);
  ok(!plan.stages[0].roots.includes("test/dom"));
  ok(plan.stages[0].roots.includes("test/support"));
  deepStrictEqual(plan.stages[1].roots, ["test/dom"]);
  deepStrictEqual(
    createTestPlan(
      parseRunnerOptions(["frontend", "test/support/markup_test.ts"]),
    ).stages.map((stage) => stage.name),
    ["frontend"],
  );
  ok(plan.stages[1].args.includes("--config=deno.dom-test.json"));
  const exact = createTestPlan(
    parseRunnerOptions(["frontend", "test/dom/ChatTimeline_test.tsx"]),
  );
  deepStrictEqual(exact.stages.map((stage) => stage.name), ["frontend-dom"]);
  equal(exact.stages[0].cwd, plan.stages[0].cwd);
  const ssr = createTestPlan(
    parseRunnerOptions([
      "frontend",
      "components/conversations/ChatTimeline_test.tsx",
    ]),
  );
  deepStrictEqual(ssr.stages.map((stage) => stage.name), ["frontend"]);
});

Deno.test("runner timing reports preserve selected commands and isolate stage artifacts", () => {
  const args = ["test", "--parallel", "--filter=a case", "src/example_test.ts"];
  deepStrictEqual(timedStageArguments(args, "unit", "/run/evidence"), [
    "test",
    "--junit-path=/run/evidence/unit.junit.xml",
    ...args.slice(1),
  ]);
  deepStrictEqual(timedStageArguments(args, "setup", "/run/evidence"), [
    "test",
    "--junit-path=/run/evidence/setup.junit.xml",
    ...args.slice(1),
  ]);
  deepStrictEqual(args, [
    "test",
    "--parallel",
    "--filter=a case",
    "src/example_test.ts",
  ]);
});
