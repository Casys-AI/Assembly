import assert from "node:assert/strict";
import { bootstrapPrimaryRuntime } from "./primary-runtime-bootstrap.ts";
import {
  requestControlModel,
  requestControlState,
} from "../../test/support/request-space-fixture.ts";
import type { SystemRuntimeState } from "../application/work/runtime/state.ts";

function fixture(saved: SystemRuntimeState | null = requestControlState()) {
  const source = requestControlModel();
  const calls: string[] = [];
  let loaded = saved;
  let locator: string | undefined = "operator";
  let binding:
    | { primaryOperatorId: string; sourceSystemNativeId: string }
    | undefined;
  const primaryStorage = { state: { load: () => Promise.resolve(loaded) } };
  const options: Parameters<
    typeof bootstrapPrimaryRuntime<typeof primaryStorage>
  >[0] = {
    directory: "unused-test-locator",
    storage: {
      scope: {
        projectId: source.identity.projectId,
        systemId: "sql-host-uuid",
      },
      executionSpaceId: "main",
      readPrimaryRuntimeState(operatorId) {
        calls.push("read-state");
        assert.equal(operatorId, "operator");
        return Promise.resolve(saved);
      },
      bindPrimarySpaceControl(value) {
        calls.push("bind");
        binding = value;
      },
      operator(operatorId) {
        calls.push("open-store");
        assert.equal(operatorId, "operator");
        assert.ok(binding);
        return Promise.resolve(primaryStorage);
      },
    },
    model: {
      initialize() {
        calls.push("initialize-source");
        return Promise.resolve(source.identity);
      },
      readExecutableModel(identity) {
        calls.push("read-source");
        assert.equal(identity, source.identity);
        return Promise.resolve(source);
      },
    },
    hasPersistedRuntimes: () => Promise.resolve(Boolean(saved)),
    async resolvePrimaryOperator(input) {
      calls.push("locator");
      if (locator) return locator;
      assert.equal(await input.hasPersistedRuntimes(), false);
      return await input.initialize();
    },
  };
  return {
    options,
    source,
    saved,
    calls,
    binding: () => binding,
    loaded: (state: SystemRuntimeState | null) => loaded = state,
    locator: (value: string | undefined) => locator = value,
  };
}

Deno.test("PRIMARY restored bootstrap binds the adopted native identity without consulting HEAD", async () => {
  const f = fixture();
  f.options.model.initialize = () =>
    Promise.reject(new Error("HEAD unavailable"));
  f.options.model.readExecutableModel = () =>
    Promise.reject(new Error("HEAD changed"));
  const result = await bootstrapPrimaryRuntime(f.options);
  assert.equal(result.primaryOperatorId, "operator");
  assert.equal(result.admittedInitialModel, undefined);
  assert.deepEqual(f.calls, ["locator", "read-state", "bind", "open-store"]);
  assert.deepEqual(f.binding(), {
    primaryOperatorId: "operator",
    sourceSystemNativeId: f.saved!.executionModel!.identity.systemId,
  });
  assert.notEqual(
    f.binding()!.sourceSystemNativeId,
    f.options.storage.scope.systemId,
  );
});

Deno.test("PRIMARY fresh bootstrap initializes once and retains the same exact policy-free model", async () => {
  const f = fixture(null);
  f.locator(undefined);
  delete f.source.spaceControlPolicy;
  const result = await bootstrapPrimaryRuntime(f.options);
  assert.equal(result.admittedInitialModel, f.source);
  assert.deepEqual(f.calls, [
    "locator",
    "initialize-source",
    "read-source",
    "read-state",
    "bind",
    "open-store",
  ]);
  assert.ok(f.binding());
});

Deno.test("PRIMARY locator without state initializes once and refuses another source owner before binding", async () => {
  const f = fixture(null);
  const result = await bootstrapPrimaryRuntime(f.options);
  assert.equal(result.admittedInitialModel, f.source);
  assert.deepEqual(f.calls, [
    "locator",
    "read-state",
    "initialize-source",
    "read-source",
    "bind",
    "open-store",
  ]);
  const foreign = fixture(null);
  foreign.source.identity.builderId = "different-owner";
  await assert.rejects(
    () => bootstrapPrimaryRuntime(foreign.options),
    /coherent exact/,
  );
  assert.equal(foreign.binding(), undefined);
  assert.ok(!foreign.calls.includes("open-store"));
});

Deno.test("PRIMARY malformed or foreign adopted evidence refuses without source fallback or stores", async () => {
  const mutations: Array<(state: SystemRuntimeState) => void> = [
    (state) => delete state.executionModel,
    (state) => delete state.model,
    (state) => state.model!.builderId = "another-owner",
    (state) => state.executionModel!.identity.projectId = "foreign-project",
    (state) => state.executionModel!.version.repositoryVersion = "HEAD",
    (state) => state.executionModel!.version.digest = "missing-exact-digest",
    (state) => state.executionModel!.mandate.id = "",
    (state) => state.executionModel!.flows.conversation.nodes = [],
  ];
  for (const mutate of mutations) {
    const saved = structuredClone(requestControlState());
    mutate(saved);
    const f = fixture(saved);
    await assert.rejects(() => bootstrapPrimaryRuntime(f.options), /PRIMARY/);
    assert.deepEqual(f.calls, ["locator", "read-state"]);
    assert.equal(f.binding(), undefined);
  }
});

Deno.test("PRIMARY bootstrap refuses a non-Main host before locator or source reads", async () => {
  const f = fixture();
  const options = {
    ...f.options,
    storage: { ...f.options.storage, executionSpaceId: "case-space" },
  };
  await assert.rejects(
    () => bootstrapPrimaryRuntime(options),
    /Main execution space/,
  );
  assert.deepEqual(f.calls, []);
});

Deno.test("PRIMARY fresh exact-source and identity checks refuse before binding", async () => {
  for (const kind of ["mutable", "project", "identity"] as const) {
    const f = fixture(null);
    if (kind === "mutable") f.source.version.repositoryVersion = "HEAD";
    if (kind === "project") f.source.identity.projectId = "foreign-project";
    if (kind === "identity") {
      f.options.model.initialize = () =>
        Promise.resolve({ ...f.source.identity, rootId: "other-root" });
      f.options.model.readExecutableModel = () => Promise.resolve(f.source);
    }
    await assert.rejects(() => bootstrapPrimaryRuntime(f.options), /PRIMARY/);
    assert.equal(f.binding(), undefined);
    assert.ok(!f.calls.includes("open-store"));
  }
});

Deno.test("PRIMARY post-open validation refuses a disappeared or divergent native state", async () => {
  for (const kind of ["missing", "native", "runtime", "control"] as const) {
    const f = fixture();
    const loaded = structuredClone(f.saved!);
    if (kind === "native") {
      loaded.model!.systemId = "other-native-system";
      loaded.executionModel!.identity.systemId = "other-native-system";
    }
    if (kind === "runtime") loaded.id = "another-runtime";
    if (kind === "control") {
      loaded.executionModel!.spaceControlPolicy!.holderNativeId =
        "foreign-holder";
      assert.equal(loaded.id, f.saved!.id);
      assert.deepEqual(loaded.model, f.saved!.model);
      assert.deepEqual(
        loaded.executionModel!.identity,
        f.saved!.executionModel!.identity,
      );
    }
    f.loaded(kind === "missing" ? null : loaded);
    await assert.rejects(
      () => bootstrapPrimaryRuntime(f.options),
      kind === "control" ? /space-control/ : /PRIMARY/,
    );
    assert.deepEqual(f.calls, ["locator", "read-state", "bind", "open-store"]);
  }
});

Deno.test("PRIMARY pre-store technical failure propagates without source initialization or binding", async () => {
  const f = fixture();
  const failure = new Error("storage unavailable");
  f.options.storage.readPrimaryRuntimeState = () => Promise.reject(failure);
  await assert.rejects(
    () => bootstrapPrimaryRuntime(f.options),
    (error) => error === failure,
  );
  assert.equal(f.binding(), undefined);
  assert.deepEqual(f.calls, ["locator"]);
});

Deno.test("PRIMARY canonical control validation refuses malformed fresh or saved evidence before binding or stores", async () => {
  const mutations: Array<
    (model: ReturnType<typeof requestControlModel>) => void
  > = [
    (model) => model.spaceControlPolicy!.systemId = "foreign-native-system",
    (model) => model.spaceControlPolicy!.holderNativeId = "foreign-holder",
    (model) => model.spaceControlPolicy!.revision = 0,
    (model) => model.spaceControlPolicy!.operatorIds = ["*"],
    (model) => delete model.ownerAuthority,
  ];
  for (const restored of [false, true]) {
    for (const mutate of mutations) {
      const saved = restored ? structuredClone(requestControlState()) : null;
      const f = fixture(saved);
      mutate(saved?.executionModel ?? f.source);
      await assert.rejects(
        () => bootstrapPrimaryRuntime(f.options),
        /space-control/,
      );
      assert.equal(f.binding(), undefined);
      assert.ok(!f.calls.includes("open-store"));
      assert.deepEqual(
        f.calls,
        restored
          ? ["locator", "read-state"]
          : ["locator", "read-state", "initialize-source", "read-source"],
      );
    }
  }
});

Deno.test("PRIMARY canonical control validation preserves absent and disabled saved policies", async () => {
  for (const kind of ["absent", "disabled"] as const) {
    const saved = requestControlState();
    if (kind === "absent") delete saved.executionModel!.spaceControlPolicy;
    else saved.executionModel!.spaceControlPolicy!.enabled = false;
    const f = fixture(saved);
    const result = await bootstrapPrimaryRuntime(f.options);
    assert.equal(result.admittedInitialModel, undefined);
    assert.deepEqual(f.calls, ["locator", "read-state", "bind", "open-store"]);
  }
});
