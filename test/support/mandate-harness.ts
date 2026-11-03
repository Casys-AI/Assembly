/** Shared mandate-change test harness for both suite tiers.
 *
 * The memory composition (host-agnostic semantics) and the durable PostgreSQL
 * host (restart recovery, queue drain, pin fences, lost-save reconciliation)
 * share this FileRepository fixture, the session drivers and the compile
 * cache. No assertion lives here; suites own their assertions.
 */
import type { HostEdit } from "../../src/domain/model/editing/host-edit.ts";
import { compileVerifiedSources } from "../support/memory-source-repository.ts";
import { sha256 } from "../../src/adapters/model/builds/materialization/artifact.ts";
import { SysmlToolkitAdapter } from "../../src/adapters/out/sysml-toolkit/adapter.ts";
import {
  TOOLKIT_COMPILER_DESCRIPTOR,
  ToolkitCompiler,
} from "../../src/adapters/out/sysml-toolkit/compilation/compiler.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import {
  type ChangePublication,
  publicationFailure,
} from "../../src/domain/model/publication/change.ts";
import { isHostEdit } from "../../src/domain/model/publication/compatibility.ts";
import { canonical } from "../../src/domain/primitives/canonical-json.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import {
  SourceModel,
  type SourceRepository,
  type SourceRevision,
} from "../../src/adapters/model/sources/source-model.ts";
import type { CompiledModel } from "../../src/domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import type {
  ModelCompiler,
  ModelCompilerRecipe,
} from "../../src/application/model/builds/ports/out/model-compiler.port.ts";
import type {
  MandateRequestedRights,
  PendingChange,
} from "../../src/domain/governance/records/pending-change.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import { SystemRuntime } from "../support/system-runtime.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";
import { SystemRuntime as DurableSystemRuntime } from "../../src/application/work/runtime/system.ts";
import type { ModelPort } from "../../src/application/work/runtime/ports.ts";
import type { DecisionInformationPort } from "../../src/application/work/context/information-ports.ts";
import { openPostgresDurableRecoveryHost } from "../support/postgres-runtime-fixture.ts";
import type { PostgresHostStorage } from "../../src/adapters/out/postgres/host-storage.ts";
import { MemoryStateStore } from "../support/memory-state-store.ts";

/** Durable acceptance still requires the native toolkit AND an isolated
 * PostgreSQL campaign database. The gates stay orthogonal: without either,
 * the suite is ignored, never passed. */
const postgresMandateTestUrl = Deno.env.get("ASSEMBLY_POSTGRES_TEST_URL");
export const mandateRecoveryEnabled = toolkitIntegrationEnabled &&
  !!postgresMandateTestUrl;

/** Content-keyed compile store for the harness FileRepository path (declared
 * first: the shared-compiler getter below clears it on toolkit switches). */
const mandateCompileCache = new Map<string, Promise<CompiledModel>>();
export function mandateCompileCacheSize(): number {
  return mandateCompileCache.size;
}

/** One ToolkitCompiler per test process: FileRepository instances share it
 * instead of constructing a compiler per scenario. */
let sharedMandateCompilerInstance: ToolkitCompiler | undefined;
let sharedMandateCompilerPackageDir: string | undefined;
export function sharedMandateCompiler(): ToolkitCompiler {
  const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
  if (
    !sharedMandateCompilerInstance ||
    sharedMandateCompilerPackageDir !== packageDir
  ) {
    mandateCompileCache.clear();
    sharedMandateCompilerInstance = new ToolkitCompiler({ packageDir });
    sharedMandateCompilerPackageDir = packageDir;
  }
  return sharedMandateCompilerInstance;
}

/** Content-keyed compile memoization for the harness FileRepository path.
 * The key covers the full model sources plus the toolkit identity (package
 * directory, compiler name and version); different source bytes never share
 * an entry, a miss compiles exactly as before, and failures are never
 * cached. Every hit returns a fresh clone, so per-scenario compile hooks
 * may mutate their own compiled model without poisoning later scenarios. */
async function mandateCompileCacheKey(sources: Sources): Promise<string> {
  return await sha256(canonical({
    sources,
    toolkit: {
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR") ?? "",
      name: TOOLKIT_COMPILER_DESCRIPTOR.name,
      version: TOOLKIT_COMPILER_DESCRIPTOR.version,
      format: TOOLKIT_COMPILER_DESCRIPTOR.format,
    },
  }));
}
export async function memoizedToolkitCompile(
  sources: Sources,
): Promise<CompiledModel> {
  const key = await mandateCompileCacheKey(sources);
  const hit = mandateCompileCache.get(key);
  if (hit) return structuredClone(await hit);
  const pending = sharedMandateCompiler().compile(structuredClone(sources))
    .then((compiled) => structuredClone(compiled));
  mandateCompileCache.set(key, pending);
  try {
    return structuredClone(await pending);
  } catch (error) {
    if (mandateCompileCache.get(key) === pending) {
      mandateCompileCache.delete(key);
    }
    throw error;
  }
}

/** Per-repository compiler facade behind the shared process compiler and the
 * memo. Scenarios may still wrap or replace `compile` per test exactly as
 * before; one scenario's hook never leaks into another repository. */
export class MandateToolkitCompiler implements ModelCompiler {
  compile(input: Sources): Promise<CompiledModel> {
    return memoizedToolkitCompile(input);
  }
  recipe(): Promise<ModelCompilerRecipe> {
    return sharedMandateCompiler().recipe();
  }
}

/** Durable immutable source snapshots, using the real compiler and SourceModel.
 * This fixture exercises publication loss without running Git write commands. */
export class FileRepository implements SourceRepository {
  readonly compiler: MandateToolkitCompiler = new MandateToolkitCompiler();
  beforePublish?: () => Promise<void>;
  beforeUpdate?: () => Promise<void>;
  afterPublish?: () => Promise<void>;
  beforeCompile?: (sources: Record<string, string>) => Record<string, string>;
  divergentReceipt = false;
  constructor(readonly directory: string) {}
  async initialize(sources: Record<string, string>) {
    try {
      return await this.current();
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      return await this.publishSystemSources(sources, "", "initial");
    }
  }
  async current() {
    return await this.at(await Deno.readTextFile(`${this.directory}/HEAD`));
  }
  async at(version: string): Promise<SourceRevision> {
    return JSON.parse(
      await Deno.readTextFile(`${this.directory}/${version}.json`),
    );
  }
  async history(options: { limit?: number } = {}) {
    const records = JSON.parse(
      await Deno.readTextFile(`${this.directory}/history.json`),
    ) as {
      version: string;
      sourceDigest: string;
      author: string;
      createdAt: string;
    }[];
    const limit = options.limit ?? records.length;
    return {
      headVersion: (await this.current()).version,
      truncated: records.length > limit,
      commits: records.slice(0, limit),
    };
  }
  async publishSystemSources(
    sources: Record<string, string>,
    expected: string,
    author: string,
    receipt?: ChangePublication,
    verify?: NonNullable<
      Parameters<SourceRepository["updateSystemSources"]>[2]
    >["verify"],
  ) {
    if (expected) equal((await this.current()).version, expected);
    const compiled = await (async () => {
      try {
        return await compileVerifiedSources(
          this.compiler,
          this.beforeCompile?.(sources) ?? sources,
          expected
            ? await this.current()
            : { version: "", sources: {}, elements: [] },
          verify,
        );
      } catch (error) {
        if (!receipt) throw error;
        throw publicationFailure(error, {
          changeId: receipt.changeId,
          systemId: receipt.authorityExercise.systemId,
        }, "refuse");
      }
    })();
    const records = expected ? (await this.history()).commits : [];
    const version = `snapshot-${records.length + 1}`;
    const storedReceipt = structuredClone(receipt);
    if (storedReceipt && this.divergentReceipt) {
      const divergent = storedReceipt.edits.find((edit) =>
        "op" in edit
          ? edit.op === "setFeatureValue" &&
            edit.target.qualifiedName.endsWith("::networkHosts")
          : edit.name === "networkHosts"
      );
      ok(
        divergent &&
          (!("op" in divergent) || divergent.op === "setFeatureValue"),
      );
      if (!("op" in divergent) || divergent.op === "setFeatureValue") {
        divergent.value = '["divergent.example"]';
      }
    }
    const revision = { ...compiled, version, receipt: storedReceipt };
    await this.beforePublish?.();
    await Deno.writeTextFile(
      `${this.directory}/${version}.json`,
      JSON.stringify(revision),
    );
    await Deno.writeTextFile(
      `${this.directory}/history.json`,
      JSON.stringify([{
        version,
        sourceDigest: compiled.sourceDigest,
        author,
        createdAt: new Date().toISOString(),
      }, ...records]),
    );
    await Deno.writeTextFile(`${this.directory}/next`, version);
    await Deno.rename(`${this.directory}/next`, `${this.directory}/HEAD`);
    await this.afterPublish?.();
    return revision;
  }
  async updateSystemSources(
    update: Parameters<SourceRepository["updateSystemSources"]>[0],
    author: string,
    { publication: receipt, verify }: NonNullable<
      Parameters<SourceRepository["updateSystemSources"]>[2]
    > = {},
  ) {
    if (receipt && !("authorityExercise" in receipt)) {
      throw new Error("Only mandate change receipts belong to this fixture");
    }
    if (receipt) {
      const found = await this.findPublication(receipt.changeId);
      if (found) {
        deepStrictEqual(
          { ...receipt, edits: found.receipt!.edits },
          found.receipt,
        );
        receipt.edits = structuredClone(found.receipt!.edits);
        return found.revision;
      }
    }
    await this.beforeUpdate?.();
    const current = await this.current();
    const sources = await update(current);
    return JSON.stringify(sources) === JSON.stringify(current.sources)
      ? current
      : await this.publishSystemSources(
        sources,
        current.version,
        author,
        receipt,
        verify,
      );
  }
  async findPublication(changeId: string) {
    const record = (await this.history()).commits.find((entry) =>
      entry.author === `ase:approved-change:${changeId}`
    );
    if (!record) return null;
    const revision = await this.at(record.version) as SourceRevision & {
      receipt?: ChangePublication;
    };
    return { revision, receipt: revision.receipt };
  }
  propose(): ReturnType<SourceRepository["propose"]> {
    throw new Error("No source proposal in mandate recovery test");
  }
}

export function runtime(
  model: SourceModel,
  store: MemoryStateStore,
  proposed = false,
  requestedRights: MandateRequestedRights = {
    addNetworkHosts: ["recovery.example"],
  },
) {
  return new SystemRuntime({
    model,
    store,
    agents: {
      label: "Mandate recovery fixture",
      decide() {
        if (proposed) {
          return Promise.resolve({ kind: "reply", text: "Done." } as const);
        }
        proposed = true;
        return Promise.resolve(
          {
            kind: "propose_mandate_change",
            text: "Request one host.",
            reason: "Exact network extension",
            requestedRights,
          } as const,
        );
      },
      review() {
        throw new Error("No candidate review in mandate recovery test");
      },
    },
    runner: {
      test() {
        throw new Error("No tool tests in mandate recovery test");
      },
      run() {
        throw new Error("No tool invocation in mandate recovery test");
      },
    },
  });
}

const mandateProjectId = "git:cdc1ab4f-083e-533c-90ca-953c38b63a92";

function mandateAgents(
  proposed = false,
  requestedRights: MandateRequestedRights = {
    addNetworkHosts: ["recovery.example"],
  },
) {
  return {
    label: "Mandate recovery fixture",
    decide() {
      if (proposed) {
        return Promise.resolve({ kind: "reply", text: "Done." } as const);
      }
      proposed = true;
      return Promise.resolve(
        {
          kind: "propose_mandate_change",
          text: "Request one host.",
          reason: "Exact network extension",
          requestedRights,
        } as const,
      );
    },
    review() {
      throw new Error("No candidate review in mandate recovery test");
    },
  };
}

function mandateRunner() {
  return {
    test() {
      throw new Error("No tool tests in mandate recovery test");
    },
    run() {
      throw new Error("No tool invocation in mandate recovery test");
    },
  };
}

/** SourceModel behind the durable ModelPort: every real compilation and
 * publication primitive, with edit proposals closed exactly like the file
 * fixture they replace. */
function mandateModelPort(model: SourceModel): ModelPort {
  return {
    readExecutableModel: (identity, repositoryVersion) =>
      model.readExecutableModel(identity, repositoryVersion),
    previewApprovedChange: (identity, change, expectedDigest) =>
      model.previewApprovedChange(identity, change, expectedDigest),
    applyApprovedChange: (identity, change, expectedDigest, publication) =>
      model.applyApprovedChange(identity, change, expectedDigest, publication),
    findApprovedChange: (identity, changeId) =>
      model.findApprovedChange(identity, changeId),
    initialize: (existing, configuration) =>
      model.initialize(existing, configuration),
    activateCandidate: (identity, candidate, admittedModelDigest) =>
      model.activateCandidate(identity, candidate, admittedModelDigest),
    graph: (identity) => model.graph(identity),
    proposeEdit: () =>
      Promise.reject(
        new Error("No source proposal in mandate recovery test"),
      ),
  };
}

/** Read-only information port so real mandate conversations pass the mandatory
 * declared-source consultation. Those reads come from the fixture repository's
 * exact admitted revision, independently of HEAD; the mandate agent
 * ignores context, so the exercised path (turn, proposal, ledger fence) is
 * real while the inert content never grants anything. */
function mandateInformation(
  repository: SourceRepository,
): DecisionInformationPort {
  return {
    read: (model) =>
      Promise.resolve({
        memoryGuidance: [],
        modelContext: {
          version: model.version.repositoryVersion ?? "",
          sourceDigest: model.version.digest,
          files: [],
          roots: { items: [], total: 0, truncated: false },
          limits: {
            maxPageSize: 0,
            maxSourceBytes: 0,
            maxInspectSourceBytes: 0,
          },
          coverage: "bounded-discovery-not-exhaustive-impact" as const,
          loadedSources: [],
          maxLoadedCharacters: 0,
        },
        modelSources: {
          version: model.version.repositoryVersion ?? "",
          sources: {},
        },
      }),
    consultAdmittedModelSource: async (model, input) => {
      if (
        !model.policy.mayProposeSysmlRevision ||
        !model.version.repositoryVersion ||
        input.version !== model.version.repositoryVersion ||
        input.operation !== "read_source" || typeof input.path !== "string" ||
        Object.keys(input).some((key) =>
          !["operation", "version", "path"].includes(key)
        )
      ) {
        throw new Error(
          "The mandatory mandate read requires its exact admitted source pin",
        );
      }
      const revision = await repository.at(model.version.repositoryVersion);
      equal(revision.version, model.version.repositoryVersion);
      const content = revision.sources[input.path];
      if (typeof content !== "string") {
        throw new Error("The exact declared source is absent");
      }
      return {
        modelVersion: {
          digest: model.version.digest,
          repositoryVersion: model.version.repositoryVersion,
        },
        result: {
          operation: "read_source",
          version: revision.version,
          sourceDigest: await modelSourceDigest(revision.sources),
          path: input.path,
          sha256: await sha256(content),
          characters: content.length,
          content,
        },
      };
    },
    consultModel: async (model, input) => {
      if (
        input.operation !== "read_source" || typeof input.path !== "string"
      ) {
        throw new Error(
          "The mandate information fixture only reads pinned sources",
        );
      }
      const revision = await repository.current();
      return {
        modelVersion: {
          digest: model.version.digest,
          repositoryVersion: model.version.repositoryVersion,
        },
        result: revision.sources[input.path] ?? "",
      };
    },
  };
}

async function eventuallySettled<T>(
  read: () => Promise<T | undefined>,
  what: string,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${what} did not settle before the test deadline`);
}

type MandateRecoveryHost = Awaited<
  ReturnType<typeof openPostgresDurableRecoveryHost>
>;
type MandateRecoverySession = Awaited<
  ReturnType<MandateRecoveryHost["openSession"]>
>;

export interface MandateDurableSession {
  readonly kind: "durable";
  recovery: MandateRecoveryHost;
  session: MandateRecoverySession;
  service: DurableSystemRuntime;
  storage: Awaited<ReturnType<PostgresHostStorage["operator"]>>;
  model: SourceModel;
  workerErrors: unknown[];
}

export type MandateSession = MandateDurableSession | MandateMemorySession;

/** Memory-composition mandate session: the same SourceModel, agents and
 * SystemRuntime worker path as the durable host, over a cloned CAS memory state port
 * with the in-memory operator dispatch. decideChange still only enqueues;
 * refusals surface from the worker drain (idle) plus the canonical journal,
 * never as synchronous decideChange rejections. There is no pg-boss queue,
 * no delayed retry and no cross-restart fencing here: restart recovery,
 * native-pin fences and lost-save reconciliation stay on the durable tier. */
export interface MandateMemorySession {
  readonly kind: "memory";
  service: SystemRuntime;
  model: SourceModel;
  store: MemoryStateStore;
  storage: { state: MemoryStateStore };
  directory: string;
  eventCursor: number;
  close(): Promise<void>;
}

async function startMemoryService(
  memory: MandateMemorySession,
  options: {
    requestedRights?: MandateRequestedRights;
    preProposed?: boolean;
  } = {},
): Promise<SystemRuntime> {
  const service = new SystemRuntime({
    model: memory.model,
    store: memory.store,
    agents: mandateAgents(!!options.preProposed, options.requestedRights),
    runner: mandateRunner(),
  });
  await service.initialize();
  memory.service = service;
  memory.eventCursor = service.snapshot.events.length;
  return service;
}

export async function openMandateMemorySession(options: {
  directory: string;
  repository: FileRepository;
  initialSources?: Record<string, string>;
  requestedRights?: MandateRequestedRights;
  preProposed?: boolean;
}): Promise<MandateMemorySession> {
  const model = new SourceModel({
    tooling: new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    }),
    repository: options.repository,
    projectId: mandateProjectId,
    ...(options.initialSources
      ? { initialSources: options.initialSources }
      : {}),
  });
  await model.initialize();
  const store = new MemoryStateStore();
  const memory: MandateMemorySession = {
    kind: "memory",
    service: undefined as unknown as SystemRuntime,
    model,
    store,
    storage: { state: store },
    directory: options.directory,
    eventCursor: 0,
    close: () => store.close(),
  };
  await startMemoryService(memory, {
    requestedRights: options.requestedRights,
    preProposed: options.preProposed,
  });
  return memory;
}

/** Same-store restart: the fresh runtime reloads the filed proposal from the
 * memory store, mirroring the durable same-session restart without workers
 * to reassign (the in-memory dispatch binds to the new service). */
export async function restartMemoryService(
  memory: MandateMemorySession,
): Promise<SystemRuntime> {
  return await startMemoryService(memory, { preProposed: true });
}

/** Memory accept-then-drain for a refused decideChange: the call only
 * enqueues, so the refusal is observed when the worker tails settle, then
 * read back from the rejection plus the canonical journal. */
async function drainMemoryDecisionRefusal(
  memory: MandateMemorySession,
  check: (error: unknown) => void,
): Promise<unknown[]> {
  const error = await memory.service.idle().then(
    () => undefined,
    (error) => error,
  );
  if (error === undefined) {
    throw new Error(
      "The memory mandate worker succeeded where a refusal was expected",
    );
  }
  check(error);
  memory.eventCursor = memory.service.snapshot.events.length;
  return [error];
}

/** Memory accept-then-drain for a successful decideChange: the worker
 * completes the publication and the journal records the completion. */
async function drainMemoryDecisionCompletion(
  memory: MandateMemorySession,
  changeId: string,
  status: "approved" | "refused",
): Promise<void> {
  const beforeEvents = memory.eventCursor;
  await memory.service.idle();
  const current = await memory.store.load();
  const change = current?.configuration?.changes.find((entry) =>
    entry.id === changeId
  );
  if (!change || change.status !== status) {
    throw new Error(
      `The memory mandate decision (${status}) did not settle before the drain`,
    );
  }
  const completed = memory.service.snapshot.events.slice(beforeEvents).some(
    (event) => event.id.startsWith("operator-command-completed:"),
  );
  if (!completed) {
    throw new Error(
      `The memory mandate decision (${status}) journalled no completion receipt`,
    );
  }
  memory.eventCursor = memory.service.snapshot.events.length;
}

/** Memory queue settle: no delayed retries exist behind the in-memory
 * dispatch, so settled tails mean no successor can re-execute a refused
 * command. A pending worker failure surfaces here: every decision must be
 * drained for its own outcome first, as the suites do. */
async function drainMemoryQueue(
  memory: MandateMemorySession,
): Promise<void> {
  await memory.service.idle();
  memory.eventCursor = memory.service.snapshot.events.length;
}

/** One durable-recovery host session around a real SourceModel: the exact
 * composition of postgres-production-runtime_test.ts, with the mandate
 * agents proposing the change under test. The worker drains through the real
 * PostgreSQL queue; refusals surface as worker errors plus canonical
 * journal (state.events) entries, never as synchronous decideChange
 * rejections. */
export async function openMandateDurableSession(options: {
  repository: FileRepository;
  initialSources?: Record<string, string>;
  requestedRights?: MandateRequestedRights;
  preProposed?: boolean;
}): Promise<MandateDurableSession> {
  const model = new SourceModel({
    tooling: new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    }),
    repository: options.repository,
    projectId: mandateProjectId,
    ...(options.initialSources
      ? { initialSources: options.initialSources }
      : {}),
  });
  const identity = await model.initialize();
  const recovery = await openPostgresDurableRecoveryHost({
    scope: { projectId: mandateProjectId, systemId: identity.systemId },
  });
  const session = await recovery.openSession();
  const storage = await session.storage.operator(identity.builderId);
  const workerErrors: unknown[] = [];
  const durable: MandateDurableSession = {
    kind: "durable",
    recovery,
    session,
    service: undefined as unknown as DurableSystemRuntime,
    storage,
    model,
    workerErrors,
  };
  durable.service = await startMandateService(durable, session, model, {
    requestedRights: options.requestedRights,
    preProposed: options.preProposed,
  });
  return durable;
}

/** Start the real PostgreSQL workers for one session; deliveries always route
 * to the currently attached service, so restarts only reassign the field. */
export async function startMandateService(
  durable: MandateDurableSession,
  session: MandateDurableSession["session"],
  model: SourceModel,
  options: {
    requestedRights?: MandateRequestedRights;
    preProposed?: boolean;
    /** A same-session restart reuses the running workers. */
    startWorkers?: boolean;
  } = {},
): Promise<DurableSystemRuntime> {
  const builderId = (await model.initialize()).builderId;
  const service = new DurableSystemRuntime({
    ...await session.runtimePortsFor(builderId),
    clock: { now: () => "2026-10-27T00:00:00.000Z" },
    agents: mandateAgents(!!options.preProposed, options.requestedRights),
    model: mandateModelPort(model),
    runner: mandateRunner(),
    information: mandateInformation(model.repository),
    // No work budget: the memory composition this replaces never admitted
    // one, and an unadmitted budget suspends mandate turns without a decision.
  });
  await service.initialize();
  durable.service = service;
  if (options.startWorkers === false) return service;
  await session.start(async (delivery) => {
    try {
      await durable.service.processAcceptedContribution(delivery);
    } catch (error) {
      durable.workerErrors.push(error);
      throw error;
    }
  });
  return service;
}

/** Explicit stop boundary: workers and pools close while the database and
 * every framework schema stay for the successor session, mirroring a fenced
 * successor. Retried refusals must be terminal first, otherwise the new
 * session would re-execute the previous session's refused command. */
export async function reopenMandateSession(
  durable: MandateDurableSession,
  repository: FileRepository,
  options: {
    initialSources?: Record<string, string>;
    requestedRights?: MandateRequestedRights;
  } = {},
): Promise<
  { session: MandateDurableSession["session"]; service: DurableSystemRuntime }
> {
  await drainMandateQueue(durable);
  await durable.session.stop();
  const session = await durable.recovery.openSession();
  const model = new SourceModel({
    tooling: new SysmlToolkitAdapter({
      packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    }),
    repository,
    projectId: mandateProjectId,
    ...(options.initialSources
      ? { initialSources: options.initialSources }
      : {}),
  });
  const storage = await session.storage.operator(
    durable.service.snapshot.model!.builderId,
  );
  durable.session = session;
  durable.storage = storage;
  const service = await startMandateService(durable, session, model, {
    requestedRights: options.requestedRights,
    preProposed: true,
  });
  return { session, service };
}

/** Accept-then-drain for a refused decideChange: the call itself only
 * enqueues, so the refusal is observed on the worker side, first as the
 * worker error, then as the canonical journal entries and the unchanged
 * pending change. */
export async function drainDecisionRefusal(
  session: MandateDurableSession,
  check: (error: unknown) => void,
  settle?: boolean,
): Promise<unknown[]>;
export async function drainDecisionRefusal(
  session: MandateMemorySession,
  check: (error: unknown) => void,
  settle?: boolean,
): Promise<unknown[]>;
export async function drainDecisionRefusal(
  session: MandateDurableSession | MandateMemorySession,
  check: (error: unknown) => void,
  settle = true,
): Promise<unknown[]> {
  if (session.kind === "memory") {
    return await drainMemoryDecisionRefusal(session, check);
  }
  const durable = session;
  const before = durable.workerErrors.length;
  const errors = await eventuallySettled(
    () =>
      Promise.resolve(
        durable.workerErrors.length > before
          ? durable.workerErrors.slice(before)
          : undefined,
      ),
    "The durable mandate worker refusal",
  );
  check(errors[0]);
  await durable.session.idle(durable.service);
  // Settle the refusal's own retries and release the scope key, so the next
  // command in the suite is fetched instead of starving behind this failure.
  // Suites asserting first-attempt effects (compilation counts) opt out: the
  // suite's own later drain (or its finally) settles the retries after the
  // assertions ran.
  if (settle) await drainMandateQueue(durable);
  return errors;
}

/** Accept-then-drain for a successful decideChange: the worker completes the
 * publication and the journal records the completion. */
export async function drainDecisionCompletion(
  session: MandateDurableSession,
  changeId: string,
  status: "approved" | "refused",
): Promise<void>;
export async function drainDecisionCompletion(
  session: MandateMemorySession,
  changeId: string,
  status: "approved" | "refused",
): Promise<void>;
export async function drainDecisionCompletion(
  session: MandateDurableSession | MandateMemorySession,
  changeId: string,
  status: "approved" | "refused",
): Promise<void> {
  if (session.kind === "memory") {
    return await drainMemoryDecisionCompletion(session, changeId, status);
  }
  const durable = session;
  // Only failures raised by this decision count: earlier phases (and their
  // retried refusals) already settled their own worker errors.
  const beforeEvents = durable.service.snapshot.events.length;
  // Completion is proven by the journal receipt for a command the drain
  // itself observed, not by the absence of attempt noise: a first attempt
  // may fail (for example the post-approval resume trips a stale ledger pin
  // once) while its retry completes the same delivery. Errors that arrive
  // after the completion receipt still fail the drain.
  const settled = await eventuallySettled(async () => {
    const current = await durable.storage.state.load();
    const change = current?.configuration?.changes.find((entry) =>
      entry.id === changeId
    );
    if (!change || change.status !== status) return undefined;
    const completed = durable.service.snapshot.events.slice(beforeEvents)
      .some((event) => event.id.startsWith("operator-command-completed:"));
    if (!completed) return undefined;
    return { errorCount: durable.workerErrors.length };
  }, `The durable mandate decision (${status})`);
  await durable.session.idle(durable.service);
  const recent = durable.workerErrors.slice(settled.errorCount);
  if (recent.length) {
    throw new AggregateError(
      recent,
      "The durable mandate worker failed after the decision settled",
    );
  }
}

/** File the mandate proposal exactly as the designer turn would, saved
 * through the memory state store, then restart on the same store so the
 * attached runtime loads the filed proposal. Exercises the memory
 * decideChange worker, which is the contract under test for this tier. */
async function proposeMemoryMandateChange(
  memory: MandateMemorySession,
  requestedRights: MandateRequestedRights = {
    addNetworkHosts: ["recovery.example"],
  },
): Promise<{
  service: SystemRuntime;
  proposed: PendingChange;
}> {
  const base = memory.service.snapshot.executionModel!;
  const builderId = base.identity.builderId;
  const governance = SystemGovernance.fromExecutable(base);
  const proposed = governance.propose(
    {
      kind: "propose_mandate_change",
      text: "Request one host.",
      reason: "Exact network extension",
      requestedRights,
    },
    crypto.randomUUID(),
    "now",
    { requestedBy: builderId, designerScopeId: "recovery-test:designer" },
  );
  proposed.diff = await memory.model.previewApprovedChange(
    memory.service.snapshot.model!,
    proposed,
    base.version.digest,
  );
  const saved = (await memory.store.load())!;
  saved.designer = { scopeId: "recovery-test:designer" };
  saved.caseInvocation = {
    kind: "designer",
    scopeId: "recovery-test:designer",
  };
  saved.configuration!.changes = [proposed];
  // No decision continuation entry: the turn would file "pending", which
  // blocks model adoption and spurious startup resumes. The worker records
  // its own outcome continuations after the decision drains.
  // The turn's input message is filed so post-decision dialogue resumption
  // finds its authenticated input receipt, exactly as after a real submit.
  // The turn's assistant proposal receipt is filed with it: without a reply
  // after the input, a later pin adoption reads the parked resumption as a
  // non-empty await and refuses it, which a real submit never does.
  const inputMessageId = crypto.randomUUID();
  saved.messages = [
    ...(saved.messages ?? []),
    {
      id: inputMessageId,
      role: "user",
      text: "Request one host.",
      at: "now",
      designerScopeId: "recovery-test:designer",
    },
    {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "La proposition d’évolution est visible.",
      at: "now",
      designerScopeId: "recovery-test:designer",
    },
  ];
  saved.activeInputMessageId = inputMessageId;
  const previous = saved.revision++;
  await memory.store.save(saved, previous);
  // Same-store restart so the attached runtime loads the filed proposal
  // from the memory store.
  const service = await startMemoryService(memory, { preProposed: true });
  return { service, proposed };
}

/** File the mandate proposal exactly as the designer turn would: the same
 * governance proposal with the same actor, previewed diff and continuation
 * bookkeeping, saved through the durable state store. The designer agent
 * turn parks at the compiled await_input node with no resumption in this
 * tree, so suites file the proposal directly and exercise the durable
 * decideChange worker, which is the contract under test. */
export async function proposeMandateChange(
  session: MandateDurableSession,
  requestedRights?: MandateRequestedRights,
): Promise<{
  service: DurableSystemRuntime;
  proposed: PendingChange;
}>;
export async function proposeMandateChange(
  session: MandateMemorySession,
  requestedRights?: MandateRequestedRights,
): Promise<{
  service: SystemRuntime;
  proposed: PendingChange;
}>;
export async function proposeMandateChange(
  session: MandateDurableSession | MandateMemorySession,
  requestedRights: MandateRequestedRights = {
    addNetworkHosts: ["recovery.example"],
  },
): Promise<{
  service: DurableSystemRuntime;
  proposed: PendingChange;
}> {
  if (session.kind === "memory") {
    return await proposeMemoryMandateChange(session, requestedRights);
  }
  const durable = session;
  const base = durable.service.snapshot.executionModel!;
  const builderId = base.identity.builderId;
  const governance = SystemGovernance.fromExecutable(base);
  const proposed = governance.propose(
    {
      kind: "propose_mandate_change",
      text: "Request one host.",
      reason: "Exact network extension",
      requestedRights,
    },
    crypto.randomUUID(),
    "now",
    { requestedBy: builderId, designerScopeId: "recovery-test:designer" },
  );
  proposed.diff = await durable.model.previewApprovedChange(
    durable.service.snapshot.model!,
    proposed,
    base.version.digest,
  );
  const saved = (await durable.storage.state.load())!;
  saved.designer = { scopeId: "recovery-test:designer" };
  saved.caseInvocation = {
    kind: "designer",
    scopeId: "recovery-test:designer",
  };
  saved.configuration!.changes = [proposed];
  // No decision continuation entry: the turn would file "pending", which
  // blocks model adoption and spurious startup resumes. The worker records
  // its own outcome continuations after the decision drains.
  // The turn's input message is filed so post-decision dialogue resumption
  // finds its authenticated input receipt, exactly as after a real submit.
  // The turn's assistant proposal receipt is filed with it: without a reply
  // after the input, a later pin adoption reads the parked resumption as a
  // non-empty await and refuses it, which a real submit never does.
  const inputMessageId = crypto.randomUUID();
  saved.messages = [
    ...(saved.messages ?? []),
    {
      id: inputMessageId,
      role: "user",
      text: "Request one host.",
      at: "now",
      designerScopeId: "recovery-test:designer",
    },
    {
      id: crypto.randomUUID(),
      role: "assistant",
      text: "La proposition d’évolution est visible.",
      at: "now",
      designerScopeId: "recovery-test:designer",
    },
  ];
  saved.activeInputMessageId = inputMessageId;
  const previous = saved.revision++;
  await durable.storage.state.save(saved, previous);
  // Same-session restart so the attached runtime loads the filed proposal
  // from PostgreSQL; the running workers route to it.
  const service = await startMandateService(
    durable,
    durable.session,
    durable.model,
    { preProposed: true, startWorkers: false },
  );
  return { service, proposed };
}

/** Retried refusals stay scheduled behind pg-boss delays: a session boundary
 * must wait until every queue job is terminal, otherwise the successor
 * session would re-execute the previous session's refused command.
 * Terminal failures are then cancelled: the operator queue runs
 * key_strict_fifo on the scope digest, so a failed job blocks every later
 * command for its scope until it is resolved. The refusal was already
 * observed from the worker error and the canonical journal; cancelling only
 * releases the scope key for the next command. */
export async function drainMandateQueue(
  session: MandateDurableSession,
  timeoutMs?: number,
): Promise<void>;
export async function drainMandateQueue(
  session: MandateMemorySession,
  timeoutMs?: number,
): Promise<void>;
export async function drainMandateQueue(
  session: MandateDurableSession | MandateMemorySession,
  timeoutMs = 120_000,
): Promise<void> {
  if (session.kind === "memory") {
    return await drainMemoryQueue(session);
  }
  const durable = session;
  const queueSchema = durable.recovery.schemas.queueSchema;
  await eventuallySettled(
    async () => {
      const rows = await durable.recovery.database.client.$queryRawUnsafe<
        Array<{ state: string }>
      >(`SELECT state::text AS state FROM "${queueSchema}".job`);
      return rows.every((row) =>
          ["completed", "failed", "cancelled", "expired"].includes(row.state)
        )
        ? true
        : undefined;
    },
    "The durable mandate queue",
    timeoutMs,
  );
  await durable.recovery.database.client.$queryRawUnsafe(
    `UPDATE "${queueSchema}".job SET state='cancelled' WHERE state='failed'`,
  );
}

/** New publications must retain tagged expectations before legacy projections. */
export function currentHostEdits(receipt: ChangePublication): HostEdit[] {
  return receipt.edits.map((edit) => {
    ok(isHostEdit(edit), "New publications must use host operations");
    if (edit.op === "insertMember") {
      ok(
        edit.expect.every((expectation) =>
          expectation.kind === "literal" || expectation.kind === "member"
        ),
        "New insertion expectations must carry their kind",
      );
    }
    return edit as HostEdit;
  });
}
