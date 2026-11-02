/** Bounded test entry point. Importing this module performs no IO. */
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PINNED_DENO = resolve(APP_ROOT, ".data/toolchains/deno-v2.9.7/deno");
const UNIT = [
  "src",
  "test/support",
  "tools/setup-sysml-toolkit_test.ts",
  "tools/package-native-runtimes_test.ts",
  "tools/setup_test.ts",
  "tools/test-runner_test.ts",
];
const SETUP = [
  "tools/migration/move_test.ts",
  "tools/native-distribution_test.ts",
  "tools/setup-rust-vendor_test.ts",
  "tools/setup-semantic-index_test.ts",
  "tools/setup-sysml-toolkit_integration_test.ts",
];
const NATIVE = [
  "test/integration",
  "src/adapters/out/sysml-toolkit/compilation-policies/governance/model-access/administration/policy_test.ts",
  "src/adapters/out/sysml-toolkit/compilation-policies/governance/model-access/editing/policy_test.ts",
  "src/adapters/governance/model-access/delegation/state_test.ts",
  "src/adapters/governance/authority/operator/writer_test.ts",
  "src/adapters/model/sources/editing/host-writer_test.ts",
];
const POSTGRES = [
  "postgres-retirement-job-receipts",
  "postgres-work-stores",
  "postgres-migrations",
  "postgres-memory-skills",
  "postgres-context-skills-service",
  "postgres-production-runtime",
  "postgres-wait-evidence",
  "postgres-native-observations",
  "postgres-wait-turns",
  "postgres-immutable-consultation-group",
  "postgres-budget-continuation",
  "postgres-initial-admission-transfer",
  "postgres-nested-failure-settlement",
  "postgres-operator-command-refusal",
  "postgres-parked-candidate-recovery",
  "postgres-historical-evolution-await",
  "postgres-client-timezone",
  "postgres-foundation",
  "postgres-evolution-store",
  "postgres-scoped-software-budget",
  "postgres-scoped-software-migration",
  "postgres-request-adoption-store",
  "postgres-host-storage",
  "postgres-artifact-sources",
  "postgres-system-state-store",
  "postgres-write-queue",
  "postgres-saved-systems",
  "postgres-request-space-openings",
  "postgres-request-source-admission",
  "postgres-request-source-publication",
  "postgres-request-source-publication-participant",
  "postgres-request-source-composition-ports",
  "postgres-request-space-runtime",
  "postgres-request-readers",
  "postgres-request-supervision",
  "postgres-release-creation-authority",
  "postgres-evolved-release-authority",
  "postgres-primary-runtime-bootstrap",
  "postgres-provider-call-store",
  "postgres-provider-call-correlation",
  "postgres-provider-resource-reader",
  "postgres-shared-native-runtime",
  "postgres-agent-cap",
  "case-numbering",
  "operator-cases",
  "legacy-plan-cases",
  "cases-store",
  "queued-model-writer",
].map((name) => `test/integration/${name}_test.ts`);
const POSTGRES_TOOLKIT = [
  "postgres-request-retained-tools",
  "postgres-request-retained-target",
  "postgres-request-case-network-permission",
  "postgres-request-branch-authority",
  "postgres-request-branch-team",
  "postgres-request-network-refusal",
  "postgres-request-adoption-enrollment-race",
  "postgres-request-runtime-adoption",
  "postgres-request-evolved-release",
  "postgres-request-spaces-composition",
  "postgres-request-source-admission-composition",
  "git-model-workspace",
  "sysml-toolkit-model",
  "work-budget-execution",
  "network-impact-consultation",
  "network-impact",
  "request-value-profile",
  "request-value-flow",
  "request-team-workspace",
  "request-authority-middle",
].map((name) => `test/integration/${name}_test.ts`);
const FRONTEND = [
  "islands",
  "components",
  "lib",
  "test/integration",
  "test/support",
];
const INTEGRATION_PERMISSIONS = [
  "--allow-read",
  "--allow-write",
  "--allow-env",
  "--allow-run",
  "--allow-net=127.0.0.1,localhost",
  "--allow-ffi=./node_modules,.data/toolchains",
];
const SYSTEM_PERMISSIONS = ["--allow-sys=hostname,systemMemoryInfo,cpus"];
const MAXIMUM_DEFAULT_JOBS = 4;
const DEFAULT_LOCK_WAIT_SECONDS = 900;
const MAXIMUM_LOCK_WAIT_SECONDS = 3600;
const LOCK_POLL_MILLISECONDS = 1000;

type StageName =
  | "unit"
  | "setup"
  | "integration"
  | "frontend"
  | "frontend-dom"
  | "toolkit"
  | "postgres"
  | "postgres-toolkit"
  | "heavy"
  | "semantic";
/** Stages whose modules share no process-wide state: no environment or working
 * directory changes, no fixed ports, and temporary files under their own
 * directories. They run with Deno's `--parallel` across `DENO_JOBS` workers;
 * every other stage keeps exactly one worker. */
const PARALLEL_STAGES: ReadonlySet<StageName> = new Set([
  "unit",
  "setup",
  "frontend",
  "frontend-dom",
]);
export type Profile =
  | StageName
  | "standard"
  | "changed"
  | "frontend-changed"
  | "integration-full"
  | "full"
  | "workspace"
  | "workspace-changed"
  | "workspace-full";
export interface RunnerOptions {
  profile: Profile;
  plan: boolean;
  allowSlow: boolean;
  cpuProfile: boolean;
  failFast: boolean;
  timeoutSeconds: number;
  jobs: number;
  waitSeconds: number;
  filter?: string;
  changed?: string | true;
  related: string[];
  selectors: string[];
}
export interface TestStage {
  name: StageName;
  jobs: number;
  budgetSeconds: number;
  cpuProfile?: boolean;
  cwd: string;
  roots: string[];
  relatedRoots: string[];
  selectors: string[];
  args: string[];
  related: string[];
}
/** Native JUnit reports retain per-file suites and case durations, including
 * failure/skipped outcomes, without changing the console reporter. */
export function timedStageArguments(
  args: readonly string[],
  stage: StageName,
  reportDirectory: string,
): string[] {
  return [
    args[0],
    `--junit-path=${resolve(reportDirectory, `${stage}.junit.xml`)}`,
    ...args.slice(1),
  ];
}

export interface TestPlan {
  profile: Profile;
  timeoutSeconds: number;
  slow: boolean;
  failFast: boolean;
  exclusions: string;
  stages: TestStage[];
}
/** Per-stage wall-time budgets in seconds. Normal stages: the slowest of six
 * runs with four parallel workers on a shared 10-CPU machine under load 7 to 15
 * on 31 October 2026 (unit 55 s, setup 23 s, frontend 8 s), plus about half;
 * the DOM stage takes under a second and keeps a 5-second floor for process
 * start. Focused integration keeps its 60-second loop; the slow stages keep
 * their unmeasured 20-minute ceilings. */
const STAGE_SECONDS: Record<StageName, number> = {
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
/** A profile's deadline is the sum of its stage budgets; `budgets` replaces a
 * stage budget for that profile only. */
const PROFILES: Record<
  Profile,
  {
    stages: StageName[];
    budgets?: Partial<Record<StageName, number>>;
    slow?: boolean;
  }
> = {
  standard: { stages: ["unit", "setup"] },
  changed: { stages: ["unit", "setup", "integration"] },
  unit: { stages: ["unit"] },
  setup: { stages: ["setup"] },
  integration: { stages: ["integration"] },
  // 258 s measured serially on 31 October 2026, plus half.
  "integration-full": {
    stages: ["integration"],
    budgets: { integration: 390 },
    slow: true,
  },
  frontend: { stages: ["frontend", "frontend-dom"] },
  "frontend-dom": { stages: ["frontend-dom"] },
  "frontend-changed": { stages: ["frontend", "frontend-dom"] },
  workspace: { stages: ["unit", "setup", "frontend", "frontend-dom"] },
  "workspace-changed": {
    stages: ["unit", "setup", "integration", "frontend", "frontend-dom"],
  },
  toolkit: { stages: ["toolkit"], slow: true },
  postgres: { stages: ["postgres"], slow: true },
  "postgres-toolkit": { stages: ["postgres-toolkit"], slow: true },
  heavy: { stages: ["heavy"], slow: true },
  semantic: { stages: ["semantic"], slow: true },
  full: { stages: ["unit", "setup", "toolkit"], slow: true },
  "workspace-full": {
    stages: ["unit", "setup", "toolkit", "frontend", "frontend-dom"],
    slow: true,
  },
};

function stageSeconds(profile: Profile, stage: StageName): number {
  return PROFILES[profile].budgets?.[stage] ?? STAGE_SECONDS[stage];
}

export function profileSeconds(profile: Profile): number {
  return PROFILES[profile].stages.reduce(
    (total, stage) => total + stageSeconds(profile, stage),
    0,
  );
}

/** Half the logical CPUs, at least one and at most four, so a test run leaves
 * room for the editor, a dev server and another session's work. */
export function defaultJobs(cpus: number): number {
  return Math.min(MAXIMUM_DEFAULT_JOBS, Math.max(1, Math.floor(cpus / 2)));
}

export function parseRunnerOptions(
  args: readonly string[],
  cpus = navigator.hardwareConcurrency,
): RunnerOptions {
  const [name, ...rest] = args;
  if (!name || !Object.hasOwn(PROFILES, name)) {
    throw new Error("Choose a supported test profile");
  }
  const profile = name as Profile;
  const definition = PROFILES[profile];
  const options: RunnerOptions = {
    profile,
    plan: false,
    allowSlow: false,
    cpuProfile: false,
    failFast: true,
    timeoutSeconds: profileSeconds(profile),
    jobs: defaultJobs(cpus),
    waitSeconds: DEFAULT_LOCK_WAIT_SECONDS,
    related: [],
    selectors: [],
  };
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    const key = arg.split("=", 1)[0];
    if (arg.startsWith("--")) {
      if (seen.has(key)) throw new Error(`Repeated option: ${key}`);
      seen.add(key);
    }
    if (arg === "--plan") options.plan = true;
    else if (arg === "--allow-slow") options.allowSlow = true;
    else if (arg === "--cpu-profile") options.cpuProfile = true;
    else if (arg === "--no-fail-fast") options.failFast = false;
    else if (arg.startsWith("--timeout=")) {
      const value = arg.slice("--timeout=".length);
      if (!/^[1-9][0-9]*$/.test(value)) {
        throw new Error("Timeout must be a positive whole number of seconds");
      }
      const seconds = Number(value);
      if (seconds > (definition.slow ? 3600 : options.timeoutSeconds)) {
        throw new Error("Timeout exceeds this profile's permitted budget");
      }
      options.timeoutSeconds = seconds;
    } else if (arg.startsWith("--jobs=")) {
      const value = arg.slice("--jobs=".length);
      const limit = Math.max(1, cpus);
      if (!/^[1-9][0-9]*$/.test(value) || Number(value) > limit) {
        throw new Error(
          `Jobs must be a whole number of workers from 1 to ${limit}`,
        );
      }
      if (!definition.stages.some((stage) => PARALLEL_STAGES.has(stage))) {
        throw new Error(
          "Parallel workers apply only to unit, setup and frontend stages",
        );
      }
      options.jobs = Number(value);
    } else if (arg.startsWith("--wait=")) {
      const value = arg.slice("--wait=".length);
      if (
        !/^(?:0|[1-9][0-9]*)$/.test(value) ||
        Number(value) > MAXIMUM_LOCK_WAIT_SECONDS
      ) {
        throw new Error(
          `Wait must be a whole number of seconds from 0 to ${MAXIMUM_LOCK_WAIT_SECONDS}`,
        );
      }
      options.waitSeconds = Number(value);
    } else if (arg === "--changed" || arg.startsWith("--changed=")) {
      const value = arg === "--changed" ? true : arg.slice("--changed=".length);
      if (
        !value || typeof value === "string" &&
          (value.includes("\0") || /[\r\n]/.test(value))
      ) {
        throw new Error("Invalid changed revision");
      }
      options.changed = value;
    } else if (arg === "--filter" || arg.startsWith("--filter=")) {
      const value = arg === "--filter"
        ? rest[++index]
        : arg.slice("--filter=".length);
      if (!value || value.startsWith("--") || value.includes("\0")) {
        throw new Error("Filter requires a value");
      }
      options.filter = value;
    } else if (arg === "--related" || arg.startsWith("--related=")) {
      const value = arg === "--related"
        ? rest[++index]
        : arg.slice("--related=".length);
      if (!value) {
        throw new Error("Related requires paths inside the profile roots");
      }
      options.related = value.split(",");
    } else if (arg.startsWith("-")) throw new Error("Unsupported test option");
    else options.selectors.push(arg);
  }
  if (profile.endsWith("changed") || profile === "changed") {
    options.changed ??= true;
  }
  if (
    options.cpuProfile &&
    (!(profile === "integration" || profile === "postgres-toolkit") ||
      options.selectors.length !== 1 ||
      !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(options.selectors[0]))
  ) {
    throw new Error(
      "CPU profiling requires integration or postgres-toolkit and one explicit test file selector",
    );
  }
  if (
    profile.startsWith("workspace") &&
    (options.selectors.length || options.related.length)
  ) {
    throw new Error(
      "Workspace file selection is ambiguous; use unit, setup, integration or frontend",
    );
  }
  if (
    profile === "integration" && !options.plan &&
    !options.selectors.length && !options.related.length &&
    options.changed === undefined
  ) {
    throw new Error(
      "Focused integration requires file selectors, --related or --changed; use integration-full --allow-slow for the complete integration suite, or --plan to inspect",
    );
  }
  return options;
}

export function isWithin(path: string, root: string): boolean {
  const tail = relative(root, path);
  return tail === "" ||
    tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
}

/** Lexical check first; execution additionally checks real paths and symlinks. */
export function selectPath(
  path: string,
  cwd: string,
  roots: readonly string[],
): string {
  if (
    !path || path.startsWith("-") || path.includes("\0") ||
    /[\r\n*?\[\]{}]/.test(path) ||
    path.includes("://")
  ) {
    throw new Error(
      "Test selection must be a local path inside the profile roots",
    );
  }
  const absolute = resolve(cwd, path);
  if (!roots.some((root) => isWithin(absolute, resolve(cwd, root)))) {
    throw new Error("Test selection escapes this profile's roots");
  }
  return relative(cwd, absolute) || ".";
}

function definition(
  name: StageName,
): { roots: string[]; permissions: string[] } {
  switch (name) {
    case "unit":
      return {
        roots: UNIT,
        // The SDK reads this absent header override at client construction;
        // stageEnvironment removes inherited values before the worker starts.
        // Prisma debug reads color/debug settings; its runtime falls back to
        // the two host-name variables if the unit worker cannot read hostname.
        permissions: [
          "--allow-env=READABLE_STREAM,ANTHROPIC_CUSTOM_HEADERS,FORCE_COLOR,NODE_DISABLE_COLORS,NO_COLOR,TERM,DEBUG,DEBUG_COLORS,_CLUSTER_NETWORK_NAME_,COMPUTERNAME",
        ],
      };
    case "setup":
      return {
        roots: SETUP,
        permissions: [
          "--allow-read",
          "--allow-write",
        ],
      };
    case "integration":
      return {
        roots: ["test/integration"],
        permissions: INTEGRATION_PERMISSIONS,
      };
    case "frontend":
      return { roots: FRONTEND, permissions: [] };
    case "frontend-dom":
      return { roots: ["test/dom"], permissions: [] };
    case "toolkit":
      return { roots: NATIVE, permissions: INTEGRATION_PERMISSIONS };
    case "postgres":
      return {
        roots: POSTGRES,
        permissions: [...INTEGRATION_PERMISSIONS, ...SYSTEM_PERMISSIONS],
      };
    case "postgres-toolkit":
      return {
        roots: POSTGRES_TOOLKIT,
        permissions: [...INTEGRATION_PERMISSIONS, ...SYSTEM_PERMISSIONS],
      };
    case "heavy":
      return {
        roots: ["test/heavy"],
        permissions: [
          ...INTEGRATION_PERMISSIONS,
          ...SYSTEM_PERMISSIONS,
          "--parallel",
        ],
      };
    case "semantic":
      return {
        roots: ["test/integration/semantic-index_test.ts"],
        permissions: INTEGRATION_PERMISSIONS,
      };
  }
}

export function createTestPlan(
  options: RunnerOptions,
  appRoot = APP_ROOT,
): TestPlan {
  const specification = PROFILES[options.profile];
  const allStages = specification.stages.map((name) => {
    const { roots, permissions } = definition(name);
    const frontend = name === "frontend" || name === "frontend-dom";
    const cwd = frontend ? resolve(appRoot, "frontend") : appRoot;
    const relatedRoots = frontend
      ? [
        ...new Set([
          ...roots,
          ...FRONTEND,
          "test/support",
          "routes",
          "main.ts",
          "client.ts",
          "vite.config.ts",
          "../src",
        ]),
      ]
      : [...roots, "src"];
    const jobs = PARALLEL_STAGES.has(name) ? options.jobs : 1;
    return { name, cwd, roots: [...roots], relatedRoots, permissions, jobs };
  });
  const matches = (
    path: string,
    stage: typeof allStages[number],
    related = false,
  ) => {
    try {
      return selectPath(
        path,
        stage.cwd,
        related ? stage.relatedRoots : stage.roots,
      );
    } catch {
      return undefined;
    }
  };
  for (const path of options.selectors) {
    if (!allStages.some((stage) => matches(path, stage) !== undefined)) {
      throw new Error(
        "A selected path is outside this profile's permitted roots",
      );
    }
  }
  for (const path of options.related) {
    if (!allStages.some((stage) => matches(path, stage, true) !== undefined)) {
      throw new Error(
        "A related dependency is outside this profile's permitted source/test roots",
      );
    }
  }
  const stages: TestStage[] = [];
  for (const stage of allStages) {
    const selectors = options.selectors.length
      ? options.selectors.flatMap((path) => {
        const value = matches(path, stage);
        return value === undefined ? [] : [value];
      })
      : stage.roots;
    if (!selectors.length) continue;
    const related = options.related.flatMap((path) => {
      const value = matches(path, stage, true);
      return value === undefined ? [] : [value];
    });
    if (options.related.length && !related.length) continue;
    const permissions = [...stage.permissions];
    if (options.cpuProfile) {
      const system = permissions.findIndex((flag) =>
        flag.startsWith("--allow-sys=")
      );
      if (system === -1) permissions.push("--allow-sys=inspector");
      else permissions[system] += ",inspector";
    }
    const args = [
      "test",
      "--no-check",
      "--frozen",
      "--no-prompt",
      ...(options.failFast ? ["--fail-fast"] : []),
      ...permissions,
    ];
    // DENO_JOBS sets the worker count; one job keeps a parallel stage serial.
    if (PARALLEL_STAGES.has(stage.name)) args.push("--parallel");
    // DOM tests need the browser JSX transform. Keep server-precompiled tests
    // and their event-capture helpers in the existing frontend stage.
    if (stage.name === "frontend-dom") args.push("--config=deno.dom-test.json");
    if (options.filter !== undefined) args.push(`--filter=${options.filter}`);
    if (options.changed !== undefined) {
      args.push(
        options.changed === true ? "--changed" : `--changed=${options.changed}`,
      );
    }
    if (related.length) args.push(`--related=${related.join(",")}`);
    args.push(...new Set(selectors));
    stages.push({
      name: stage.name,
      jobs: stage.jobs,
      budgetSeconds: stageSeconds(options.profile, stage.name),
      ...(options.cpuProfile ? { cpuProfile: true } : {}),
      cwd: stage.cwd,
      roots: stage.roots,
      relatedRoots: stage.relatedRoots,
      selectors,
      related,
      args,
    });
  }
  if (!stages.length) {
    throw new Error("Selection does not identify any stage in this profile");
  }
  return {
    profile: options.profile,
    slow: !!specification.slow,
    failFast: options.failFast,
    timeoutSeconds: options.timeoutSeconds,
    stages,
    exclusions:
      "Normal standard/workspace stages run unit/setup (plus frontend for workspace); changed profiles retain affected integration. Focused integration requires selection; integration-full explicitly runs the complete non-native integration roots. Normal and integration-full stages exclude inherited Toolkit, PostgreSQL, native builds, SHACL/LDkit and real providers. toolkit/full exclude PostgreSQL and heavy; postgres excludes Toolkit; postgres-toolkit requires both explicit fixtures; semantic selects SHACL/LDkit only. Heavy is explicit, never implied by full. Ignored tests are not qualification evidence.",
  };
}

export function stageEnvironment(
  inherited: Readonly<Record<string, string>>,
  stage: StageName,
  temporaryDirectory: string,
  cpuProfile = false,
  jobs = 1,
): Record<string, string> {
  const env = { ...inherited };
  if (jobs !== 1 && !PARALLEL_STAGES.has(stage)) {
    throw new Error("Parallel workers are unavailable for this test stage");
  }
  delete env.ASSEMBLY_TEST_CPU_PROFILE;
  if (cpuProfile) {
    if (!(stage === "integration" || stage === "postgres-toolkit")) {
      throw new Error("CPU profiling is unavailable for this test stage");
    }
    env.ASSEMBLY_TEST_CPU_PROFILE = "1";
  }
  // Unit imports may initialize Prisma debug; never inherit debug logging.
  if (stage === "unit") {
    delete env.DEBUG;
    delete env.DEBUG_COLORS;
    delete env._CLUSTER_NETWORK_NAME_;
    delete env.COMPUTERNAME;
  }
  for (const name of Object.keys(env)) {
    if (/^(ASSEMBLY|ASE)_.*INTEGRATION$/.test(name)) env[name] = "0";
    if (
      /^(ASSEMBLY|ASE)_REAL_/.test(name) ||
      /^(ASSEMBLY|ASE)_DATABASE_(URL|DIRECT_URL)$/.test(name)
    ) delete env[name];
  }
  delete env.ASSEMBLY_POSTGRES_TEST_URL;
  delete env.SYSML_TOOLKIT_DIR;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_CUSTOM_HEADERS;
  delete env.MUSE_API_KEY;
  delete env.DENO_COVERAGE_DIR;
  delete env.DENO_AUDIT_PERMISSIONS;
  env.ASSEMBLY_SEMANTIC_INTEGRATION = "0";
  env.ASE_SEMANTIC_INTEGRATION = "0";
  if (
    stage === "toolkit" || stage === "postgres-toolkit" || stage === "heavy"
  ) {
    env.SYSML_TOOLKIT_DIR = inherited.SYSML_TOOLKIT_DIR;
    env.ASSEMBLY_SEMANTIC_INTEGRATION = "1";
    env.ASE_SEMANTIC_INTEGRATION = "1";
  }
  if (
    stage === "postgres" || stage === "postgres-toolkit" || stage === "heavy"
  ) {
    env.ASSEMBLY_POSTGRES_TEST_URL = inherited.ASSEMBLY_POSTGRES_TEST_URL;
  }
  if (stage === "semantic") {
    env.ASSEMBLY_SHACL_INTEGRATION = "1";
  }
  Object.assign(env, {
    DENO_JOBS: String(jobs),
    RAYON_NUM_THREADS: "1",
    TOKIO_WORKER_THREADS: "1",
    TMPDIR: temporaryDirectory,
    TMP: temporaryDirectory,
    TEMP: temporaryDirectory,
  });
  return env;
}

export function assertDedicatedPostgresUrl(value: string | undefined): void {
  try {
    const url = new URL(value ?? "");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/assembly_pg1_test" || url.search || url.hash
    ) throw new Error();
  } catch {
    throw new Error(
      "This profile requires ASSEMBLY_POSTGRES_TEST_URL for the dedicated local assembly_pg1_test database",
    );
  }
}

async function verifyPaths(stage: TestStage): Promise<void> {
  const appRoot = await Deno.realPath(APP_ROOT);
  const resolveRoots = (paths: string[]) =>
    Promise.all(paths.map(async (root) => {
      const lexical = resolve(stage.cwd, root);
      const real = await Deno.realPath(lexical);
      if (!isWithin(real, appRoot) || real !== lexical) {
        throw new Error(
          "A permitted test/source root is redirected by a symlink",
        );
      }
      return real;
    }));
  const roots = await resolveRoots(stage.roots);
  const relatedRoots = await resolveRoots(stage.relatedRoots);
  for (const path of stage.related) {
    const real = await Deno.realPath(resolve(stage.cwd, path));
    if (!relatedRoots.some((root) => isWithin(real, root))) {
      throw new Error(
        "A related dependency symlink escapes its permitted source/test roots",
      );
    }
  }
  for (const path of stage.selectors) {
    const lexical = resolve(stage.cwd, path);
    const real = await Deno.realPath(lexical);
    if (!roots.some((root) => isWithin(real, root))) {
      throw new Error("A test selection symlink escapes its permitted roots");
    }
    if (stage.cpuProfile && !(await Deno.stat(real)).isFile) {
      throw new Error("CPU profiling requires a test file, not a directory");
    }
    // Deno recursively discovers directories. Refuse redirected descendants too.
    const visit = async (entry: string): Promise<void> => {
      const info = await Deno.lstat(entry);
      if (info.isSymlink) {
        const target = await Deno.realPath(entry);
        if (!roots.some((root) => isWithin(target, root))) {
          throw new Error(
            "A discovered symlink escapes the permitted test roots",
          );
        }
        // Even an internal directory link can create a discovery cycle.
        if ((await Deno.stat(entry)).isDirectory) {
          throw new Error("Symlinked test directories are not supported");
        }
      } else if (info.isDirectory) {
        for await (const child of Deno.readDir(entry)) {
          await visit(resolve(entry, child.name));
        }
      }
    };
    await visit(lexical);
  }
}

export interface ProcessGroupOptions {
  cwd: string;
  env: Record<string, string>;
  deadline: number;
  signal?: AbortSignal;
  graceMs?: number;
}
const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function interruptionCode(reason: unknown): number {
  return reason === "SIGHUP" ? 129 : reason === "SIGTERM" ? 143 : 130;
}

/** What a runner records in the shared lock so that a waiting runner can name it. */
export interface LockHolder {
  profile: string;
  cwd: string;
  pid: number;
}

/** An empty, partly written or foreign record names no holder. */
export function parseLockHolder(text: string): LockHolder | undefined {
  try {
    const value = JSON.parse(text);
    if (
      typeof value?.profile === "string" && typeof value.cwd === "string" &&
      Number.isSafeInteger(value.pid) && value.pid > 0
    ) return { profile: value.profile, cwd: value.cwd, pid: value.pid };
  } catch {
    // The holder may be writing its record, or predate holder records.
  }
  return undefined;
}

/** A record whose pid has exited is stale: the OS released that holder's lock,
 * so whoever holds it now has not written its own record yet. */
export function describeLockHolder(
  holder: LockHolder | undefined,
  exists: (pid: number) => boolean,
): string {
  if (!holder) return "an unidentified runner";
  if (!exists(holder.pid)) {
    return `an unidentified runner (stale record: pid ${holder.pid} has exited)`;
  }
  return `profile ${holder.profile} in ${holder.cwd} (pid ${holder.pid})`;
}

export interface TestLockAttempt {
  /** One nonblocking exclusive attempt. */
  tryLock: () => boolean;
  /** Names the current holder for messages. */
  holder: () => string;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  log: (message: string) => void;
  signal?: AbortSignal;
}

/** Polls until the lock is free, the bounded wait ends or the run is interrupted. */
export async function waitForTestLock(
  attempt: TestLockAttempt,
  waitSeconds: number,
): Promise<void> {
  if (attempt.tryLock()) return;
  let holder = attempt.holder();
  if (waitSeconds === 0) {
    throw new Error(
      `Another test runner holds this repository's shared lock: ${holder}; pass --wait=SECONDS to wait for it`,
    );
  }
  attempt.log(
    `The shared test lock is held by ${holder}; waiting up to ${waitSeconds}s (--wait=0 fails at once)`,
  );
  const started = attempt.now();
  const end = started + waitSeconds * 1000;
  while (attempt.now() < end) {
    await attempt.sleep(
      Math.min(LOCK_POLL_MILLISECONDS, end - attempt.now()),
    );
    // Checked after each pause, so an interrupted run never takes the lock.
    if (attempt.signal?.aborted) {
      throw new Error("Interrupted while waiting for the shared test lock");
    }
    if (attempt.tryLock()) {
      attempt.log(
        `Acquired the shared test lock after waiting ${
          Math.round((attempt.now() - started) / 1000)
        }s`,
      );
      return;
    }
    const current = attempt.holder();
    if (current !== holder) {
      holder = current;
      attempt.log(`The shared test lock is now held by ${holder}; waiting`);
    }
  }
  throw new Error(
    `The shared test lock is still held by ${holder} after ${waitSeconds}s; retry later or raise --wait`,
  );
}

/** Only ESRCH proves a recorded holder has exited; EPERM means it exists. */
export function processExists(kill: ProcessGroupKill, pid: number): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/** Only slow profiles (Toolkit, PostgreSQL, full integration, heavy, semantic)
 * share the machine-wide lock: they are what can exhaust its memory. Normal
 * profiles last seconds and run alongside them. */
export function holdsSharedTestLock(plan: Pick<TestPlan, "slow">): boolean {
  return plan.slow;
}

/** The shared lock of every checkout using this Git common directory. It lives
 * in `/tmp`, not in the common directory, so that a sandboxed agent whose Git
 * metadata is read-only (Codex `workspace-write`) takes the same lock. */
export function testLockPath(commonDirectory: string): string {
  const repository = createHash("sha256").update(commonDirectory).digest("hex")
    .slice(0, 16);
  return `/tmp/assembly-test-runner-${repository}.lock`;
}

/** One exclusive OS lock at `lockPath`. The OS releases it when its owner
 * exits, so a holder that died without cleaning up never blocks: the next
 * runner takes the lock and replaces its stale record. */
export async function acquireTestLock(
  lockPath: string,
  holder: LockHolder,
  waitSeconds: number,
  signal?: AbortSignal,
): Promise<Deno.FsFile> {
  const lock = await Deno.open(
    lockPath,
    {
      create: true,
      read: true,
      write: true,
    },
  );
  try {
    const { kill } = await import("node:process");
    await waitForTestLock({
      tryLock: () => lock.tryLockSync(true),
      holder: () => {
        // Read through the locked handle: the same file whatever its path does.
        const buffer = new Uint8Array(4096);
        lock.seekSync(0, Deno.SeekMode.Start);
        const length = lock.readSync(buffer) ?? 0;
        return describeLockHolder(
          parseLockHolder(new TextDecoder().decode(buffer.subarray(0, length))),
          (pid) => processExists(kill, pid),
        );
      },
      now: Date.now,
      sleep: pause,
      log: console.log,
      signal,
    }, waitSeconds);
    const record = new TextEncoder().encode(JSON.stringify(holder));
    lock.truncateSync(0);
    lock.seekSync(0, Deno.SeekMode.Start);
    for (let written = 0; written < record.length;) {
      written += lock.writeSync(record.subarray(written));
    }
    return lock;
  } catch (error) {
    lock.close();
    throw error;
  }
}

/** Clears the holder record, then releases the lock by closing it. */
export function releaseTestLock(lock: Deno.FsFile): void {
  try {
    lock.truncateSync(0);
  } finally {
    lock.close();
  }
}

type ProcessGroupKill = (
  pid: number,
  signal: 0 | "SIGTERM" | "SIGKILL",
) => unknown;

/** EPERM does not establish absence: a group may still contain an unowned or
 * transient process. Only ESRCH proves the negative group probe is absent. */
export function probeProcessGroup(
  kill: ProcessGroupKill,
  pid: number,
): "present" | "absent" | "permission-denied" {
  try {
    kill(-pid, 0);
    return "present";
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "permission-denied";
    throw error;
  }
}

/** A failed signal never proves disappearance; callers must probe again. */
export function signalProcessGroup(
  kill: ProcessGroupKill,
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
): "sent" | "absent" | "permission-denied" {
  try {
    kill(-pid, signal);
    return "sent";
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "ESRCH") return "absent";
    if (code === "EPERM") return "permission-denied";
    throw error;
  }
}

/** Exported for explicit process smoke qualification; pure unit tests never call it. */
export async function runProcessGroup(
  command: string,
  args: string[],
  options: ProcessGroupOptions,
): Promise<number> {
  if (Deno.build.os === "windows") {
    throw new Error(
      "Test runner requires POSIX process-group cleanup; Windows is unsupported",
    );
  }
  if (options.signal?.aborted) {
    return interruptionCode(options.signal.reason);
  }
  const remaining = options.deadline - Date.now();
  if (remaining <= 0) return 124;
  const { spawn } = await import("node:child_process");
  const { kill } = await import("node:process");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: "inherit",
  });
  let exitObserved = false;
  let exitCode = 1;
  let requestedCode: number | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("error", () => {
      exitObserved = true;
      resolve();
    });
    child.once("exit", (code, signal) => {
      exitObserved = true;
      exitCode = code ??
        (signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP"
          ? interruptionCode(signal)
          : 1);
      resolve();
    });
  });
  let finishing = false;
  return await new Promise<number>((resolveResult) => {
    let cleanupPhase = "not-started";
    let lastPermissionPhase: string | undefined;
    const exists = (phase: string) => {
      cleanupPhase = phase;
      if (!child.pid) return false;
      const result = probeProcessGroup(kill, child.pid);
      if (result === "permission-denied") lastPermissionPhase = phase;
      return result !== "absent";
    };
    const send = (signal: "SIGTERM" | "SIGKILL") => {
      cleanupPhase = `send-${signal}`;
      if (!child.pid) return;
      if (signalProcessGroup(kill, child.pid, signal) === "permission-denied") {
        lastPermissionPhase = cleanupPhase;
      }
    };
    const finish = async () => {
      if (finishing) return;
      finishing = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      let cleanupFailed = false;
      let cleanupReason: string | undefined;
      try {
        // This also cleans surviving descendants after a successful direct exit.
        if (exists("exists-initial")) {
          send("SIGTERM");
          const grace = Date.now() + (options.graceMs ?? 300);
          while (exists("exists-term-grace") && Date.now() < grace) {
            await pause(10);
          }
          if (exists("exists-before-sigkill")) send("SIGKILL");
          const reap = Date.now() + 1000;
          while (exists("exists-kill-reap") && Date.now() < reap) {
            await pause(10);
          }
          if (exists("exists-after-reap")) {
            cleanupFailed = true;
            cleanupReason =
              "process group still exists after SIGKILL and reap deadline" +
              (lastPermissionPhase
                ? `; EPERM observed at ${lastPermissionPhase}`
                : "");
          }
        }
        if (!exitObserved) {
          let reapTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              exited,
              new Promise<void>((resolve) => {
                reapTimer = setTimeout(resolve, 1000);
              }),
            ]);
          } finally {
            clearTimeout(reapTimer);
          }
        }
        if (!exitObserved) {
          cleanupFailed = true;
          cleanupReason = cleanupReason
            ? `${cleanupReason}; direct child exit was not observed`
            : "direct child exit was not observed before reap deadline";
        }
      } catch (error) {
        cleanupFailed = true;
        const details = error as {
          name?: string;
          code?: string;
          message?: string;
        };
        const phase = cleanupPhase;
        cleanupReason = `cleanup exception at ${phase}: ${
          details?.name ?? "unknown"
        }; code=${details?.code ?? "unknown"}; ${
          details?.message ?? String(error)
        }`;
      }
      if (cleanupFailed) {
        console.error(
          `Owned test process group did not cleanly terminate (pid=${
            child.pid ?? "unknown"
          }; ${cleanupReason ?? "unknown reason"})`,
        );
      }
      resolveResult(requestedCode ?? (cleanupFailed ? 1 : exitCode));
    };
    const abort = () => {
      requestedCode = interruptionCode(options.signal?.reason);
      void finish();
    };
    const timer = setTimeout(() => {
      requestedCode = 124;
      void finish();
    }, remaining);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    void exited.then(finish);
  });
}

export async function main(args: string[]): Promise<number> {
  const options = parseRunnerOptions(args);
  const plan = createTestPlan(options);
  if (options.plan) {
    console.log(
      JSON.stringify(
        {
          ...plan,
          stages: plan.stages.map((stage) => ({
            ...stage,
            command: ["/usr/bin/nice", "-n", "15", PINNED_DENO, ...stage.args],
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  if (plan.slow && !options.allowSlow) {
    throw new Error(
      "Slow profiles require --allow-slow before any process is started",
    );
  }
  if (Deno.build.os === "windows") {
    throw new Error(
      "Test runner requires POSIX process-group cleanup; Windows is unsupported",
    );
  }
  if (Deno.version.deno !== "2.9.7") {
    throw new Error("Run the test runner with pinned Deno 2.9.7");
  }
  const inherited = Deno.env.toObject();
  for (const stage of plan.stages) {
    if (
      stage.name === "postgres" || stage.name === "postgres-toolkit" ||
      stage.name === "heavy"
    ) {
      assertDedicatedPostgresUrl(inherited.ASSEMBLY_POSTGRES_TEST_URL);
    }
    if (
      stage.name === "toolkit" || stage.name === "postgres-toolkit" ||
      stage.name === "heavy"
    ) {
      if (!inherited.SYSML_TOOLKIT_DIR) {
        throw new Error("This profile requires an explicit SYSML_TOOLKIT_DIR");
      }
      if (!(await Deno.stat(inherited.SYSML_TOOLKIT_DIR)).isDirectory) {
        throw new Error("Toolkit package directory is unavailable");
      }
    }
    await verifyPaths(stage);
  }
  if (!(await Deno.stat(PINNED_DENO)).isFile) {
    throw new Error("Prepare the pinned Deno 2.9.7 executable before testing");
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort("SIGINT");
  const terminate = () => controller.abort("SIGTERM");
  const hangup = () => controller.abort("SIGHUP");
  Deno.addSignalListener("SIGINT", interrupt);
  Deno.addSignalListener("SIGTERM", terminate);
  Deno.addSignalListener("SIGHUP", hangup);
  let lock: Deno.FsFile | undefined;
  // Set once the lock is held; until then no test time has been spent.
  let deadline = Number.POSITIVE_INFINITY;
  let runDirectory: string | undefined;
  let temporaryDirectory: string | undefined;
  let domConfiguration: string | undefined;
  let success = false;
  try {
    if (holdsSharedTestLock(plan)) {
      const common = await new Deno.Command("git", {
        cwd: APP_ROOT,
        args: ["rev-parse", "--git-common-dir"],
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(plan.timeoutSeconds * 1000),
        ]),
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!common.success) {
        throw new Error(
          "Cannot resolve the Git common directory for the shared test lock",
        );
      }
      const commonDirectory = await Deno.realPath(
        resolve(APP_ROOT, new TextDecoder().decode(common.stdout).trim()),
      );
      lock = await acquireTestLock(
        testLockPath(commonDirectory),
        { profile: plan.profile, cwd: Deno.cwd(), pid: Deno.pid },
        options.waitSeconds,
        controller.signal,
      );
    }
    // The budget measures the tests, not the wait for another runner.
    deadline = Date.now() + plan.timeoutSeconds * 1000;
    const runs = resolve(APP_ROOT, ".data/test-runs");
    await Deno.mkdir(runs, { recursive: true });
    runDirectory = await Deno.makeTempDir({ dir: runs, prefix: "run-" });
    temporaryDirectory = resolve(runDirectory, "tmp");
    await Deno.mkdir(temporaryDirectory);
    console.log(`Test timing reports: ${runDirectory}`);
    console.log(
      `Test profile ${plan.profile}; overall budget ${plan.timeoutSeconds}s${
        plan.failFast ? "" : "; collecting all failures"
      }. ${plan.exclusions}`,
    );
    // Without fail-fast, a failed stage is recorded and later stages still run;
    // a timeout or interruption always stops the run.
    const failures: string[] = [];
    let firstFailure: number | undefined;
    const failed = (stage: TestStage, code: number) => {
      failures.push(`${stage.name} (exit ${code})`);
      firstFailure ??= code;
    };
    for (const stage of plan.stages) {
      if (controller.signal.aborted) {
        return interruptionCode(controller.signal.reason);
      }
      const env = stageEnvironment(
        inherited,
        stage.name,
        temporaryDirectory,
        false,
        stage.jobs,
      );
      console.log(
        `Test stage: ${stage.name}; ${
          stage.jobs === 1 ? "one job" : `${stage.jobs} parallel jobs`
        }; stage budget ${stage.budgetSeconds}s`,
      );
      const stageStarted = Date.now();
      if (
        stage.name === "toolkit" || stage.name === "postgres-toolkit" ||
        stage.name === "heavy"
      ) {
        const prerequisite = await runProcessGroup("/usr/bin/nice", [
          "-n",
          "15",
          PINNED_DENO,
          "run",
          "--no-check",
          "--no-prompt",
          "--frozen",
          "--allow-read",
          "--allow-env=SYSML_TOOLKIT_DIR",
          "tools/require-toolkit.ts",
        ], { cwd: APP_ROOT, env, deadline, signal: controller.signal });
        if (prerequisite !== 0) {
          if (plan.failFast || prerequisite === 124) return prerequisite;
          failed(stage, prerequisite);
          continue;
        }
      }
      let stageArgs = stage.args;
      if (stage.name === "frontend-dom") {
        // Deno config does not support `extends`. Compose the browser JSX
        // override from the current frontend config rather than copying pins.
        // A sibling file preserves all relative imports and the existing lock.
        const base = JSON.parse(
          await Deno.readTextFile(resolve(stage.cwd, "deno.json")),
        );
        const override = JSON.parse(
          await Deno.readTextFile(resolve(stage.cwd, "deno.dom-test.json")),
        );
        const compilerOptions = {
          ...base.compilerOptions,
          ...override.compilerOptions,
        };
        delete compilerOptions.jsxPrecompileSkipElements;
        domConfiguration = await Deno.makeTempFile({
          dir: stage.cwd,
          prefix: ".dom-test-",
          suffix: ".json",
        });
        await Deno.writeTextFile(
          domConfiguration,
          JSON.stringify({ ...base, compilerOptions }),
        );
        stageArgs = stage.args.map((arg) =>
          arg === "--config=deno.dom-test.json"
            ? `--config=${domConfiguration}`
            : arg
        );
      }
      const code = await runProcessGroup("/usr/bin/nice", [
        "-n",
        "15",
        PINNED_DENO,
        ...timedStageArguments(stageArgs, stage.name, runDirectory),
      ], {
        cwd: stage.cwd,
        // The prerequisite receives the clean environment above. Only the
        // selected test process can opt into its bounded inspector window.
        env: stage.cpuProfile
          ? stageEnvironment(
            inherited,
            stage.name,
            temporaryDirectory,
            true,
            stage.jobs,
          )
          : env,
        deadline,
        signal: controller.signal,
      });
      console.log(
        `Test stage ${stage.name} ended in ${
          ((Date.now() - stageStarted) / 1000).toFixed(1)
        }s of its ${stage.budgetSeconds}s budget`,
      );
      if (code !== 0) {
        if (plan.failFast || code === 124) return code;
        failed(stage, code);
      }
    }
    if (controller.signal.aborted) {
      return interruptionCode(controller.signal.reason);
    }
    if (Date.now() >= deadline) return 124;
    if (firstFailure !== undefined) {
      console.error(`Failed test stages: ${failures.join(", ")}`);
      return firstFailure;
    }
    success = true;
    return 0;
  } catch (error) {
    if (controller.signal.aborted) {
      return interruptionCode(controller.signal.reason);
    }
    if (Date.now() >= deadline) return 124;
    throw error;
  } finally {
    try {
      if (domConfiguration) await Deno.remove(domConfiguration);
      if (temporaryDirectory) {
        if (success) await Deno.remove(temporaryDirectory, { recursive: true });
        else {
          console.error(
            `Test run did not pass; owned evidence retained: ${runDirectory}`,
          );
        }
      }
    } finally {
      try {
        if (lock) releaseTestLock(lock);
      } finally {
        // Live signal listeners would keep the launcher from exiting.
        Deno.removeSignalListener("SIGINT", interrupt);
        Deno.removeSignalListener("SIGTERM", terminate);
        Deno.removeSignalListener("SIGHUP", hangup);
      }
    }
  }
}

if (import.meta.main) {
  const started = Date.now();
  try {
    Deno.exitCode = await main(Deno.args);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Test runner failed",
    );
    Deno.exitCode = 1;
  }
  if (!Deno.args.includes("--plan")) {
    const seconds = ((Date.now() - started) / 1000).toFixed(2);
    const result = Deno.exitCode === 0
      ? "passed"
      : Deno.exitCode === 124
      ? "FAILED: time budget exceeded; narrow the selection or investigate the slow test"
      : `FAILED (exit ${Deno.exitCode})`;
    console.log(`Test run ${result}; elapsed ${seconds}s.`);
  }
}
