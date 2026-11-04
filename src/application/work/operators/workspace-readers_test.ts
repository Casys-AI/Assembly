import {
  deepStrictEqual,
  equal,
  notStrictEqual,
  rejects,
  strictEqual,
} from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { Candidate } from "../../../domain/work/records/candidates.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { WorkspaceRuntime } from "./workspace-registry.ts";
import { createWorkspaceReaders } from "./workspace-readers.ts";

function fixture() {
  const model = executableFixture({
    projectId: "git:eaa8ee83-b912-5b8d-b114-db28a72570bd",
    rootId: "root",
    editingContextId: "context",
    systemId: "system",
    catalogId: "catalog",
    builderId: "caller",
  });
  model.version.repositoryVersion = "admitted";
  const state = {
    model: model.identity,
    executionModel: structuredClone(model),
    candidates: [],
  } as unknown as SystemRuntimeState;
  const selected: Array<[string, string]> = [];
  const imported: unknown[] = [];
  const candidate = {
    id: "active",
    digest: "exact",
    stage: "active",
  } as Candidate;
  let native = model;
  const entry = {
    scope: "Team::main",
    history: {},
    model: {
      readExecutableModel: () => Promise.resolve(native),
      readSourceRevision: (identity: unknown) => Promise.resolve({ identity }),
    },
    runtime: {
      get snapshot() {
        return structuredClone(state);
      },
      readPersistedState: () => Promise.resolve(state),
      resolveBoundCandidateSource(id: string, digest: string) {
        selected.push([id, digest]);
        return Promise.resolve(candidate);
      },
      importAdmittedArtifact(input: unknown) {
        imported.push(input);
        return Promise.resolve({ candidateId: "imported" });
      },
    },
  } as unknown as WorkspaceRuntime;
  const runtimes = new Map([["caller", entry]]);
  const pins = new Map<string, Promise<ExecutableModel | null>>();
  let compile = () => Promise.resolve(model);
  let compilations = 0;
  const readers = createWorkspaceReaders({
    projectId: model.identity.projectId,
    runtimes,
    pins,
    targets: new Map([["inbox", "caller"]]),
    repository: {
      at: () => Promise.resolve({ version: "admitted" } as ModelRevision),
    },
    compilation: {
      compile() {
        compilations++;
        return compile();
      },
    },
  });
  return {
    readers,
    entry,
    state,
    model,
    selected,
    imported,
    candidate,
    pins,
    compilations: () => compilations,
    setCompile: (value: typeof compile) => {
      compile = value;
    },
    setNative: (value: ExecutableModel) => {
      native = value;
    },
  };
}

Deno.test("workspace caller reader shares pending pins, clones results and rejects a changed admitted digest", async () => {
  const f = fixture();
  const version = {
    digest: f.model.version.digest,
    repositoryVersion: "admitted",
  };
  const pending = Promise.withResolvers<ExecutableModel>();
  f.setCompile(() => pending.promise);
  const first = f.readers.resolveCallerModel("caller", version);
  const second = f.readers.resolveCallerModel("caller", version);
  await Promise.resolve();
  equal(f.compilations(), 1);
  f.state.executionModel!.version.digest = "changed";
  pending.resolve(f.model);
  deepStrictEqual(await Promise.all([first, second]), [null, null]);
  f.state.executionModel!.version.digest = version.digest;
  const read = await f.readers.resolveCallerModel("caller", version);
  deepStrictEqual(read, f.model);
  notStrictEqual(read, f.model);
  equal(f.compilations(), 1);
  equal(await f.readers.resolveCallerModel("unknown", version), null);
});

Deno.test("workspace caller reader retries rejected immutable reads without hiding the failure", async () => {
  const f = fixture();
  const failure = new Error("Immutable source unavailable");
  f.setCompile(() => Promise.reject(failure));
  const version = {
    digest: f.model.version.digest,
    repositoryVersion: "admitted",
  };
  await rejects(
    f.readers.resolveCallerModel("caller", version),
    (error) => error === failure,
  );
  equal(f.pins.size, 0);
  f.setCompile(() => Promise.resolve(f.model));
  deepStrictEqual(
    await f.readers.resolveCallerModel("caller", version),
    f.model,
  );
  equal(f.compilations(), 2);
});

Deno.test("workspace artifact reader exposes only active bound candidates from the admitted native digest", async () => {
  const f = fixture();
  f.state.candidates = [
    f.candidate,
    { ...f.candidate, id: "draft", stage: "proposed" } as Candidate,
  ];
  const listed = await f.readers.listArtifacts();
  equal(listed.length, 1);
  strictEqual(listed[0].candidate, f.candidate);
  strictEqual(
    (await f.readers.findArtifact("caller", "active", "exact"))!.candidate,
    f.candidate,
  );
  equal(await f.readers.findArtifact("caller", "active", "other"), null);
  equal(await f.readers.findArtifact("caller", "draft", "exact"), null);
  deepStrictEqual(f.selected, [["active", "exact"], ["active", "exact"]]);
  f.setNative({
    ...f.model,
    version: { ...f.model.version, digest: "unadmitted" },
  });
  deepStrictEqual(await f.readers.listArtifacts(), []);
  equal(await f.readers.findArtifact("caller", "active", "exact"), null);
});

Deno.test("workspace source and evidence readers retain own identity and persisted observation selection", async () => {
  const f = fixture();
  equal((await f.readers.ownEvidenceScope("caller"))!.ownerId, "caller");
  equal(await f.readers.ownEvidenceScope("unknown"), null);
  f.state.executionModel!.identity.builderId = "another";
  equal(await f.readers.ownEvidenceScope("caller"), null);
  deepStrictEqual(await f.readers.readSourceRevision("caller"), {
    identity: f.state.model,
  });
  await rejects(
    f.readers.readSourceRevision("unknown"),
    /no source revision reader/,
  );
  strictEqual(
    await f.readers.observationTarget("caller")!.store.load(),
    f.state,
  );
  const stored = { ...f.state, revision: 81 };
  f.entry.store = { load: () => Promise.resolve(stored) } as NonNullable<
    WorkspaceRuntime["store"]
  >;
  strictEqual(
    await f.readers.observationTarget("caller")!.store.load(),
    stored,
  );
  equal(f.readers.observationTarget("unknown"), undefined);
  equal(f.readers.canContribute("caller", "unknown"), true);
});
