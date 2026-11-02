import { deepEqual, equal, notEqual, rejects } from "node:assert/strict";
import { SavedSystemAssets } from "./saved-system-assets.ts";
import {
  savedSystemDigest,
  SavedSystemError,
  type SavedSystemManifest,
} from "../../domain/work/saved-systems.ts";
import type { BuildDescriptor } from "../../domain/model/value-objects/build.ts";
import type { ModelBuildService } from "../../application/model/builds/service.ts";
import type {
  SourceRevision,
  validateSourceExecutables,
} from "../model/sources/source-model.ts";
import { toolDraftDigest } from "../../application/work/artifacts/catalog.ts";
import { requestControlModel } from "../../../test/support/request-space-fixture.ts";

Deno.test("Case Release sources refuse before opening any main repository or runtime dependency", async () => {
  const options = new Proxy(
    {} as ConstructorParameters<typeof SavedSystemAssets>[0],
    {
      get() {
        throw new Error("Unavailable Case source must never fall back to main");
      },
    },
  );
  const assets = new SavedSystemAssets(options);
  await rejects(
    () =>
      assets.resolveSource({
        branch: { kind: "case", caseId: "case-a" },
        sourceVersion: `commit:${"a".repeat(40)}`,
      }, { projectId: "p", systemId: "s", executionSpaceId: "main" }),
    (error: unknown) =>
      error instanceof SavedSystemError && error.code === "UNAVAILABLE" &&
      error.message.includes("Case branch"),
  );
});

/** Only the native projection and Git transport are controlled. The real
 * loadExactRevision/exact/inspectModels path owns grouping and all checks. */
async function groupedFixture() {
  const pins = ["a", "b"].map((letter) => `commit:${letter.repeat(40)}`);
  const reads: string[] = [],
    descriptors: string[] = [],
    projections: string[] = [];
  const vaultReads: string[] = [], toolReads: string[] = [];
  let visible = true, visibilityReads = 0, vaultAvailable = true;
  let resolveFailure = false, hideAtEnd = false;
  const draft = {
    name: "reader",
    description: "Controlled retained tool",
    kind: "read_web_page" as const,
    code: "export default () => 'fixture';",
  };
  const digest = await toolDraftDigest(draft);
  const snapshots = new Map<string, {
    revision: SourceRevision & { sourceDigest: string };
    build: BuildDescriptor;
    projected: Awaited<ReturnType<typeof validateSourceExecutables>>;
  }>();
  for (const [index, pin] of pins.entries()) {
    const sharedNetwork = { allowedHosts: [`pin-${index}.example`] };
    const projected = ["operator-a", "operator-b"].map((operatorId) => {
      const model = requestControlModel();
      model.identity.builderId = operatorId;
      model.identity.systemId = `${operatorId}-system`;
      model.version.repositoryVersion = pin;
      model.version.digest = String(index + 1).repeat(64);
      model.configuration.network = sharedNetwork;
      model.catalog = [{
        nativeId: "native-tool",
        candidateId: "tool",
        digest,
        contractId: "contract-read_web_page",
        name: "reader",
        kind: "read_web_page",
        status: "active",
      }];
      return {
        unit: {
          systemQualifiedName: `Fixture::${operatorId}`,
          identity: model.identity,
        },
        model,
      };
    });
    const sourceDigest = String(index + 3).repeat(64);
    snapshots.set(pin, {
      revision: {
        version: pin,
        sourceDigest,
        sources: { "fixture.sysml": pin },
        elements: [],
      },
      build: {
        repositoryId: "repository",
        sourceDigest,
        artifactDigest: String(index + 5).repeat(64),
      } as BuildDescriptor,
      projected,
    });
  }
  const options: ConstructorParameters<typeof SavedSystemAssets>[0] = {
    projectDir: "unused-controlled-repository",
    repositoryId: "repository",
    projectId: "project",
    sourceScopeId: "system",
    primaryOperatorId: "operator-a",
    buildService: {} as ModelBuildService,
    vault: {
      getVerified(digest) {
        vaultReads.push(digest);
        return Promise.resolve(vaultAvailable ? new Uint8Array([1]) : null);
      },
      putVerified() {
        throw new Error("Unexpected retention");
      },
      has() {
        throw new Error("Unexpected retention");
      },
    },
    cache: {
      get() {
        throw new Error("Unexpected cache read");
      },
    },
    retainCommit() {
      throw new Error("Unexpected retention");
    },
    findTool() {
      throw new Error("Unexpected source capture");
    },
    canReadScope() {
      visibilityReads++;
      return Promise.resolve(visible && !(hideAtEnd && visibilityReads > 1));
    },
    resolveTool(_tool, operatorId) {
      toolReads.push(operatorId);
      if (resolveFailure) throw new Error("Current tool unavailable");
      return Promise.resolve(structuredClone(draft));
    },
  };
  const assets = new SavedSystemAssets(options);
  Object.defineProperty(assets, "reader", {
    value: () =>
      Promise.resolve({
        repositoryId: "repository",
        at(pin: string) {
          reads.push(pin);
          return Promise.resolve(snapshots.get(pin)!.revision);
        },
        descriptorAt(pin: string) {
          descriptors.push(pin);
          return Promise.resolve(snapshots.get(pin)!.build);
        },
      }),
  });
  Object.defineProperty(assets, "projectRevision", {
    value: (revision: SourceRevision) => {
      let projected: ReturnType<typeof validateSourceExecutables> | undefined;
      return {
        units: snapshots.get(revision.version)!.projected.map(({ unit }) =>
          unit
        ),
        models() {
          if (!projected) {
            projections.push(revision.version);
            projected = Promise.resolve(
              snapshots.get(revision.version)!.projected,
            );
          }
          return projected;
        },
      };
    },
  });
  const operator = async (pin: string, operatorId: string) => {
    const snapshot = snapshots.get(pin)!;
    const { unit, model } = snapshot.projected.find((entry) =>
      entry.model.identity.builderId === operatorId
    )!;
    return {
      operatorId,
      nativeSystemId: model.identity.systemId,
      systemQualifiedName: unit.systemQualifiedName,
      modelDigest: model.version.digest,
      repositoryVersion: pin,
      settingsDigest: await savedSystemDigest({
        configuration: model.configuration,
        flows: model.flows,
        caseFlows: model.caseFlows ?? null,
        policy: model.policy,
      }),
      sourceDigest: snapshot.revision.sourceDigest,
      build: structuredClone(snapshot.build),
      tools: [{
        candidateId: "tool",
        digest,
        // The live resolver is the authority for this controlled binding.
        sourceBinding: {} as NonNullable<
          SavedSystemManifest["operators"][number]["tools"][number][
            "sourceBinding"
          ]
        >,
      }],
    };
  };
  const manifest: SavedSystemManifest = {
    format: "assembly-saved-system-v1",
    origin: {
      projectId: "project",
      systemId: "system",
      executionSpaceId: "main",
    },
    registeredOperatorIds: ["operator-a", "operator-b"],
    operators: [
      await operator(pins[0], "operator-a"),
      await operator(pins[0], "operator-b"),
    ],
    prerequisites: [],
  };
  return {
    assets,
    manifest,
    pins,
    snapshots,
    operator,
    reads,
    descriptors,
    projections,
    vaultReads,
    toolReads,
    visibilityReads: () => visibilityReads,
    hide: () => visible = false,
    hideAtEnd: () => hideAtEnd = true,
    loseVault: () => vaultAvailable = false,
    loseTool: () => resolveFailure = true,
  };
}

Deno.test("saved asset inspection shares one exact revision per pin only within its call", async () => {
  const f = await groupedFixture();
  const models = await f.assets.inspectModels(f.manifest);
  deepEqual(
    models,
    f.snapshots.get(f.pins[0])!.projected.map(({ model }) => model),
  );
  deepEqual(f.reads, [f.pins[0]]);
  deepEqual(f.descriptors, [f.pins[0]]);
  deepEqual(f.projections, [f.pins[0]]);
  equal(f.vaultReads.length, 2);
  deepEqual(f.toolReads, ["operator-a", "operator-b"]);
  equal(f.visibilityReads(), 2);
  notEqual(models[0].configuration.network, models[1].configuration.network);
  models[0].configuration.network!.allowedHosts.push("mutated.example");
  equal(
    models[1].configuration.network!.allowedHosts.includes("mutated.example"),
    false,
  );
  const next = await f.assets.inspectModels(f.manifest);
  deepEqual(
    next,
    f.snapshots.get(f.pins[0])!.projected.map(({ model }) => model),
  );
  deepEqual(f.reads, [f.pins[0], f.pins[0]]);
});

Deno.test("saved asset inspection keeps only its last pin and never confuses versions", async () => {
  const f = await groupedFixture();
  f.manifest.operators = [
    await f.operator(f.pins[0], "operator-a"),
    await f.operator(f.pins[1], "operator-b"),
    await f.operator(f.pins[0], "operator-a"),
  ];
  const models = await f.assets.inspectModels(f.manifest);
  deepEqual(models.map((model) => model.version.repositoryVersion), [
    f.pins[0],
    f.pins[1],
    f.pins[0],
  ]);
  deepEqual(f.reads, [f.pins[0], f.pins[1], f.pins[0]]);
  deepEqual(f.descriptors, f.reads);
  deepEqual(f.projections, f.reads);
  notEqual(models[0], models[2]);
});

Deno.test("grouped saved asset inspection retains individual exact refusals and current availability", async () => {
  for (
    const field of [
      "operatorId",
      "nativeSystemId",
      "systemQualifiedName",
    ] as const
  ) {
    const f = await groupedFixture();
    f.manifest.operators[1][field] = "foreign";
    await rejects(
      () => f.assets.inspectModels(f.manifest),
      /Exact operator source unavailable/,
    );
  }
  for (const field of ["modelDigest", "settingsDigest"] as const) {
    const f = await groupedFixture();
    f.manifest.operators[1][field] = "changed";
    await rejects(
      () => f.assets.inspectModels(f.manifest),
      /Exact admitted source differs/,
    );
  }
  const differentPin = await groupedFixture();
  differentPin.manifest.operators[1].repositoryVersion = differentPin.pins[1];
  await rejects(
    () => differentPin.assets.inspectModels(differentPin.manifest),
    /Exact admitted source differs/,
  );
  for (const field of ["sourceDigest", "repositoryId"] as const) {
    const f = await groupedFixture();
    const snapshot = f.snapshots.get(f.pins[0])!;
    snapshot.build = { ...snapshot.build, [field]: "changed" };
    await rejects(
      () => f.assets.inspectModels(f.manifest),
      /Exact build descriptor unavailable/,
    );
  }
  const source = await groupedFixture();
  source.manifest.operators[1].sourceDigest = "changed";
  await rejects(
    () => source.assets.inspectModels(source.manifest),
    /Retained build differs/,
  );
  const descriptor = await groupedFixture();
  descriptor.manifest.operators[1].build = {
    ...descriptor.snapshots.get(descriptor.pins[0])!.build,
    artifactDigest: "changed",
  };
  await rejects(
    () => descriptor.assets.inspectModels(descriptor.manifest),
    /Retained build differs/,
  );
  const missing = await groupedFixture();
  await missing.assets.inspectModels(missing.manifest);
  missing.loseVault();
  await rejects(
    () => missing.assets.inspectModels(missing.manifest),
    /Retained build differs/,
  );
  const tool = await groupedFixture();
  await tool.assets.inspectModels(tool.manifest);
  tool.loseTool();
  await rejects(
    () => tool.assets.inspectModels(tool.manifest),
    /Current tool unavailable/,
  );
  const hidden = await groupedFixture();
  await hidden.assets.inspectModels(hidden.manifest);
  hidden.hide();
  await rejects(
    () => hidden.assets.inspectModels(hidden.manifest),
    (error: unknown) =>
      error instanceof SavedSystemError && error.code === "FORBIDDEN",
  );
  const hiddenAtEnd = await groupedFixture();
  hiddenAtEnd.hideAtEnd();
  await rejects(
    () => hiddenAtEnd.assets.inspectModels(hiddenAtEnd.manifest),
    (error: unknown) =>
      error instanceof SavedSystemError && error.code === "FORBIDDEN",
  );
  equal(hiddenAtEnd.toolReads.length, 2);
  equal(hiddenAtEnd.visibilityReads(), 2);
});
