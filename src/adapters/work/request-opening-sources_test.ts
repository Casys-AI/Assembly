import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { RequestOpeningSources } from "./request-opening-sources.ts";
import { requestOpeningInitialSkillIssues } from "./request-opening-host.ts";
import { inspectRequestInitialSkills } from "../skills/request-initial-skills.ts";
import { BundledSkillReadError } from "../out/filesystem/skill-bundles.ts";
import { skillContentDigest } from "../../domain/skills/context-skills.ts";
import { requestSpaceDigest } from "../../domain/work/request-spaces.ts";
import type {
  SavedSystemManifest,
  SavedSystemView,
} from "../../domain/work/saved-systems.ts";
import {
  requestControlModel,
  requestOpeningBase,
  requestSpaceScope,
} from "../../../test/support/request-space-fixture.ts";

Deno.test("source resolver refuses an explicit main mismatch before retaining or substituting another version", async () => {
  let registryCalls = 0;
  const sources = new RequestOpeningSources({
    sourceScope: { ...requestSpaceScope, executionSpaceId: "main" },
    sourceProjectId: requestSpaceScope.projectId,
    currentMainVersion: () => Promise.resolve(`commit:${"b".repeat(40)}`),
    reader() {
      throw new Error("Must not read another source");
    },
    registry: {
      resolveSource() {
        registryCalls++;
        throw new Error("Must not retain another source");
      },
    },
    assets: {
      retain() {
        throw new Error("Must not retain");
      },
      inspect() {
        throw new Error("Must not inspect");
      },
      readTool() {
        throw new Error("Must not read tool");
      },
    },
    releases: {
      inspect() {
        throw new Error("No Release requested");
      },
    },
    supportsHost: () => Promise.resolve(true),
  });
  await rejects(
    () =>
      sources.resolve({
        kind: "current-main",
        expectedVersion: `commit:${"a".repeat(40)}`,
      }),
    /explicitly expected version/,
  );
  equal(registryCalls, 0);
});

async function incompleteSkillRelease() {
  const base = await requestOpeningBase("a", true);
  base.manifest.prerequisites = [{
    kind: "skill",
    code: "SKILL_DEPENDENCY",
    operatorId: base.requestOwner.operatorId,
  }];
  base.manifestDigest = await requestSpaceDigest(base.manifest);
  base.release = { id: "release", digest: base.manifestDigest };
  const view: SavedSystemView = {
    id: "release",
    saveKey: "release-key",
    metadata: { name: "Normal foundation", purpose: "" },
    status: "incomplete",
    manifest: structuredClone(base.manifest),
    digest: base.manifestDigest,
    origin: { ...requestSpaceScope, executionSpaceId: "main" },
    source: structuredClone(base.manifest.source),
    createdAt: "2026-10-29T00:00:00Z",
    assetAvailability: "verified",
    issues: ["PREREQUISITES_REQUIRED"],
    revision: 1,
    selectedOperators: [],
    prerequisites: structuredClone(base.manifest.prerequisites),
  };
  return { base, view };
}

function releaseSources(
  view: SavedSystemView,
  supportsHost: (manifest: SavedSystemManifest) => Promise<boolean> = () =>
    Promise.resolve(false),
  inspectAssets: () => Promise<void> = () => Promise.resolve(),
  inspectHostSupport?: (manifest: SavedSystemManifest) => Promise<{
    supported: boolean;
    issues: string[];
  }>,
) {
  let sourceReads = 0, hostReads = 0, assetReads = 0;
  const exactSourceFailure = new Error(
    "Exact retained source must still be read",
  );
  const unexpected = () => {
    throw new Error(
      "Release selection must not fall back to main or retain new assets",
    );
  };
  const sources = new RequestOpeningSources({
    sourceScope: { ...requestSpaceScope, executionSpaceId: "main" },
    sourceProjectId: requestSpaceScope.projectId,
    currentMainVersion: unexpected,
    registry: { resolveSource: unexpected },
    releases: { inspect: () => Promise.resolve(structuredClone(view)) },
    reader() {
      sourceReads++;
      throw exactSourceFailure;
    },
    assets: {
      retain: unexpected,
      readTool: unexpected,
      inspect() {
        assetReads++;
        return inspectAssets();
      },
    },
    ...(inspectHostSupport ? { inspectHostSupport } : {}),
    supportsHost(manifest) {
      hostReads++;
      return supportsHost(manifest);
    },
  });
  return {
    sources,
    exactSourceFailure,
    counts: () => ({ sourceReads, hostReads, assetReads }),
  };
}

Deno.test("incomplete Release with only pending skill prerequisites reaches exact source validation without changing retention", async () => {
  const { view } = await incompleteSkillRelease();
  for (const status of ["incomplete", "retained"] as const) {
    const selected = structuredClone(view);
    selected.status = status;
    selected.issues = status === "incomplete" ? ["PREREQUISITES_REQUIRED"] : [];
    const before = structuredClone(selected), f = releaseSources(selected);
    await rejects(
      () =>
        f.sources.resolve({
          kind: "release",
          releaseId: selected.id,
          digest: selected.digest!,
        }),
      (error) => error === f.exactSourceFailure,
    );
    deepStrictEqual(f.counts(), {
      sourceReads: 1,
      hostReads: 0,
      assetReads: 0,
    });
    deepStrictEqual(selected, before);
  }
  // Candidate eligibility above is not successful opening: the real retained
  // source/models and paired host inspector remain required. PG/Git qualifies it.
});

Deno.test("Release opening does not waive other incomplete states, issue codes or unverified exact assets", async () => {
  const { view } = await incompleteSkillRelease();
  for (
    const change of [
      (selected: SavedSystemView) => {
        selected.status = "pending";
      },
      (selected: SavedSystemView) => {
        selected.status = "conflict";
      },
      (selected: SavedSystemView) => {
        selected.issues = [];
      },
      (selected: SavedSystemView) => {
        selected.issues.push("EXACT_ASSET_UNAVAILABLE");
      },
      (selected: SavedSystemView) => {
        selected.issues = ["EXACT_ASSET_UNAVAILABLE"];
      },
      (selected: SavedSystemView) => {
        selected.issues.push("PREREQUISITES_REQUIRED");
      },
      (selected: SavedSystemView) => {
        selected.status = "retained";
      },
      (selected: SavedSystemView) => {
        selected.assetAvailability = "unavailable";
      },
      (selected: SavedSystemView) => {
        selected.assetAvailability = "unchecked";
      },
      (selected: SavedSystemView) => {
        selected.id = "another-release";
      },
      (selected: SavedSystemView) => {
        selected.digest = "b".repeat(64);
      },
      (selected: SavedSystemView) => {
        selected.manifest = null;
      },
      (selected: SavedSystemView) => {
        selected.manifest!.source = undefined;
      },
      (selected: SavedSystemView) => {
        selected.manifest!.prerequisites = [];
      },
      (selected: SavedSystemView) => {
        selected.manifest!.operators[0].modelDigest = "b".repeat(64);
      },
    ]
  ) {
    const selected = structuredClone(view);
    change(selected);
    const before = structuredClone(selected), f = releaseSources(selected);
    await rejects(
      () =>
        f.sources.resolve({
          kind: "release",
          releaseId: "release",
          digest: view.digest!,
        }),
      /retained Release is unavailable/,
    );
    deepStrictEqual(f.counts(), {
      sourceReads: 0,
      hostReads: 0,
      assetReads: 0,
    });
    deepStrictEqual(selected, before);
  }
});

async function initialSkillModel(
  base: Awaited<ReturnType<typeof requestOpeningBase>>,
) {
  const model = requestControlModel(), content = "# Exact local instructions\n";
  model.version = {
    ...model.version,
    digest: base.manifest.operators[0].modelDigest,
    repositoryVersion: base.manifest.source!.sourceVersion,
  };
  model.initialSkills = [{
    nativeId: "initial-skill",
    id: "skill",
    source: "bundle:skill",
    digest: await skillContentDigest(content),
    loaded: false,
    sourceIds: ["initial-skill"],
  }];
  model.skillPolicy = {
    kind: "lazy-skills",
    id: "skill-policy",
    revision: 1,
    elementId: "skill-policy",
    sourceIds: ["skill-policy"],
    ownerId: model.identity.builderId,
    allowedHosts: [],
    maxSkillBytes: 256,
    maxInstalledSkills: 1,
    maxLoadedSkills: 1,
    maxLoadedCharacters: 256,
  };
  const kinds = ["skill-install", "skill-list"] as const;
  model.behaviors = kinds.map((kind) => {
    const fields = kind === "skill-list" ? [] : ["id", "url", "expectedDigest"];
    return {
      id: `${kind}-access`,
      name: kind,
      description: "Source fixture skill exposure",
      callerNativeId: model.identity.builderId,
      targetNativeId: kind,
      targetTypeId: `${kind}-type`,
      inputTypeId: `${kind}-input`,
      sourceIds: [kind],
      inputSchema: {
        type: "object",
        properties: Object.fromEntries(
          fields.map((name) => [name, { type: "string" }]),
        ),
        required: fields.filter((name) => name !== "expectedDigest"),
        additionalProperties: false,
      },
    };
  });
  model.operatorEntries = kinds.map((kind) => ({
    id: kind,
    kind,
    typeId: `${kind}-type`,
    performerId: model.identity.builderId,
    allocationId: `${kind}-allocation`,
    sourceIds: [kind],
  }));
  return { model, content };
}

Deno.test("Release base verification still refuses foreign or unknown skill metadata and unsupported exact bundle bytes", async () => {
  const { base, view } = await incompleteSkillRelease();
  const { model, content } = await initialSkillModel(base);
  for (
    const read of [
      () => Promise.reject(new BundledSkillReadError("unavailable")),
      () => Promise.resolve(`${content}changed`),
      () => Promise.resolve("invalid\0content"),
    ]
  ) {
    const f = releaseSources(
      view,
      async (manifest) =>
        (await requestOpeningInitialSkillIssues(
          [model],
          manifest.prerequisites,
          (exact) => inspectRequestInitialSkills(exact, read),
        )).length === 0,
    );
    await rejects(
      () => f.sources.verify(base),
      /host constraints are unavailable/,
    );
    deepStrictEqual(f.counts(), {
      sourceReads: 0,
      hostReads: 1,
      assetReads: 0,
    });
  }
  for (
    const prerequisite of [
      {
        kind: "skill" as const,
        code: "UNKNOWN_SKILL",
        operatorId: model.identity.builderId,
      },
      {
        kind: "skill" as const,
        code: "SKILL_DEPENDENCY",
        operatorId: "foreign-owner",
      },
      {
        kind: "private-resource" as const,
        code: "PRIVATE_RESOURCE",
        operatorId: model.identity.builderId,
      },
    ]
  ) {
    const changed = structuredClone(base);
    changed.manifest.prerequisites = [prerequisite];
    changed.manifestDigest = await requestSpaceDigest(changed.manifest);
    changed.release!.digest = changed.manifestDigest;
    const f = releaseSources(view);
    await rejects(() => f.sources.verify(changed));
    deepStrictEqual(f.counts(), {
      sourceReads: 0,
      hostReads: 0,
      assetReads: 0,
    });
  }
  const omitted = structuredClone(base);
  omitted.manifest.prerequisites = [];
  omitted.manifestDigest = await requestSpaceDigest(omitted.manifest);
  omitted.release!.digest = omitted.manifestDigest;
  const f = releaseSources(
    view,
    async (manifest) =>
      (await requestOpeningInitialSkillIssues(
        [model],
        manifest.prerequisites,
        (exact) =>
          inspectRequestInitialSkills(exact, () => Promise.resolve(content)),
      )).length === 0,
  );
  await rejects(
    () => f.sources.verify(omitted),
    /host constraints are unavailable/,
  );
  deepStrictEqual(f.counts(), { sourceReads: 0, hostReads: 1, assetReads: 0 });
});
Deno.test("unretained Release and unsupported host constraints refuse without a current-main fallback", async () => {
  let mainReads = 0;
  const sources = new RequestOpeningSources({
    sourceScope: { ...requestSpaceScope, executionSpaceId: "main" },
    sourceProjectId: requestSpaceScope.projectId,
    currentMainVersion() {
      mainReads++;
      throw new Error("No main fallback");
    },
    reader() {
      throw new Error("Must not read");
    },
    registry: {
      resolveSource() {
        throw new Error("Must not select current source");
      },
    },
    assets: {
      retain() {
        throw new Error("Must not retain");
      },
      inspect() {
        throw new Error("Unsupported host must refuse first");
      },
      readTool() {
        throw new Error("Must not read tool");
      },
    },
    releases: {
      inspect: () =>
        Promise.resolve({
          id: "release",
          saveKey: "key",
          metadata: { name: "Incomplete", purpose: "" },
          status: "incomplete",
          manifest: null,
          digest: null,
          origin: { ...requestSpaceScope, executionSpaceId: "main" },
          createdAt: "now",
          assetAvailability: "unchecked",
          issues: [],
          revision: 0,
          selectedOperators: [],
          prerequisites: [],
        }),
    },
    supportsHost: () => Promise.resolve(false),
  });
  await rejects(
    () =>
      sources.resolve({
        kind: "release",
        releaseId: "release",
        digest: "a".repeat(64),
      }),
    /retained Release is unavailable/,
  );
  const base = await requestOpeningBase();
  await rejects(() => sources.verify(base), /host constraints are unavailable/);
  equal(mainReads, 0);
});

Deno.test("verified model reads repeat current host and retained asset checks before exact source access", async () => {
  const { base, view } = await incompleteSkillRelease();
  let hostAvailable = true, assetsAvailable = true;
  const assetFailure = new Error("Retained asset is unavailable now");
  const f = releaseSources(view, () => Promise.resolve(hostAvailable), () => {
    if (!assetsAvailable) throw assetFailure;
    return Promise.resolve();
  });
  for (let call = 1; call <= 2; call++) {
    await rejects(
      () => f.sources.readModels(base),
      (error) => error === f.exactSourceFailure,
    );
    deepStrictEqual(f.counts(), {
      hostReads: call,
      assetReads: call,
      sourceReads: call,
    });
  }
  hostAvailable = false;
  await rejects(
    () => f.sources.readModels(base),
    /host constraints are unavailable/,
  );
  deepStrictEqual(f.counts(), { hostReads: 3, assetReads: 2, sourceReads: 2 });
  hostAvailable = true;
  assetsAvailable = false;
  await rejects(
    () => f.sources.readModels(base),
    (error) => error === assetFailure,
  );
  deepStrictEqual(f.counts(), { hostReads: 4, assetReads: 3, sourceReads: 2 });
});

Deno.test("historical model inspection checks exact retained facts without invoking unavailable execution host", async () => {
  const { base, view } = await incompleteSkillRelease();
  const hostFailure = new Error(
    "Execution host must not be probed for inspection",
  );
  const f = releaseSources(view, () => {
    throw hostFailure;
  });
  await rejects(
    () => f.sources.readModelsForInspection(base),
    (error) => error === f.exactSourceFailure,
  );
  deepStrictEqual(f.counts(), { hostReads: 0, assetReads: 1, sourceReads: 1 });
  await rejects(
    () => f.sources.readModels(base),
    (error) => error === hostFailure,
  );
  await rejects(() => f.sources.verify(base), (error) => error === hostFailure);
  deepStrictEqual(f.counts(), { hostReads: 2, assetReads: 1, sourceReads: 1 });
  // Inspection also remains available when support reports a normal refusal.
  const refused = releaseSources(view, () => Promise.resolve(false));
  await rejects(
    () => refused.sources.readModelsForInspection(base),
    (error) => error === refused.exactSourceFailure,
  );
  deepStrictEqual(refused.counts(), {
    hostReads: 0,
    assetReads: 1,
    sourceReads: 1,
  });
});

Deno.test("historical model inspection refuses corrupt manifests and missing retained assets before exact model access", async () => {
  const { base, view } = await incompleteSkillRelease();
  const hostMustNotRun = () => {
    throw new Error("Historical inspection called host readiness");
  };
  const corrupt = structuredClone(base);
  corrupt.manifest.operators[0].modelDigest = "f".repeat(64);
  const f = releaseSources(view, hostMustNotRun);
  await rejects(() => f.sources.readModelsForInspection(corrupt));
  deepStrictEqual(f.counts(), { hostReads: 0, assetReads: 0, sourceReads: 0 });
  const missing = new Error("Exact retained artifact bytes are missing");
  const unavailable = releaseSources(view, hostMustNotRun, () => {
    throw missing;
  });
  await rejects(
    () => unavailable.sources.readModelsForInspection(base),
    (error) => error === missing,
  );
  deepStrictEqual(unavailable.counts(), {
    hostReads: 0,
    assetReads: 1,
    sourceReads: 0,
  });
});

Deno.test("selected readiness reports real skill diagnostics without resolving another Release or retaining assets", async () => {
  const { base, view } = await incompleteSkillRelease();
  const { model, content } = await initialSkillModel(base);
  const before = structuredClone(view);
  for (
    const [read, expected] of [
      [
        () => Promise.reject(new BundledSkillReadError("unavailable")),
        "INITIAL_SKILL_BUNDLE_UNAVAILABLE",
      ],
      [
        () => Promise.resolve(`${content}changed`),
        "INITIAL_SKILL_CONTENT_DIFFERS",
      ],
      [
        () => Promise.resolve("invalid\0content"),
        "INITIAL_SKILL_CONTENT_INVALID",
      ],
    ] as const
  ) {
    let probes = 0;
    const f = releaseSources(view, undefined, undefined, async (manifest) => {
      probes++;
      const issues = await requestOpeningInitialSkillIssues(
        [model],
        manifest.prerequisites,
        (exact) => inspectRequestInitialSkills(exact, read),
      );
      return { supported: issues.length === 0, issues };
    });
    const result = await f.sources.inspectRelease(view);
    equal(result.openingAvailability, "unavailable");
    equal(result.openingIssues.includes(expected), true);
    equal(probes, 1);
    deepStrictEqual(f.counts(), {
      sourceReads: 0,
      hostReads: 0,
      assetReads: 0,
    });
    deepStrictEqual(view, before);
  }
  // A verified local bundle is necessary, but cannot bypass the retained source.
  let probes = 0;
  const supported = releaseSources(
    view,
    undefined,
    undefined,
    async (manifest) => {
      probes++;
      const issues = await requestOpeningInitialSkillIssues(
        [model],
        manifest.prerequisites,
        (exact) =>
          inspectRequestInitialSkills(exact, () => Promise.resolve(content)),
      );
      deepStrictEqual(issues, []);
      return { supported: true, issues };
    },
  );
  deepStrictEqual(await supported.sources.inspectRelease(view), {
    openingAvailability: "unavailable",
    openingIssues: ["SOURCE_OPENING_UNAVAILABLE"],
  });
  equal(probes, 1);
  deepStrictEqual(supported.counts(), {
    sourceReads: 1,
    hostReads: 0,
    assetReads: 0,
  });
  deepStrictEqual(view, before);
});

Deno.test("selected readiness keeps unsupported dependencies and source failures closed and sanitizes unexpected diagnostics", async () => {
  const { view } = await incompleteSkillRelease();
  for (
    const issues of [
      ["SOURCE_DEPENDENCY_UNSUPPORTED"],
      ["HOST_RUNNER_SANDBOX_LAUNCH_FAILED"],
      ["INITIAL_SKILL_CONTENT_DIFFERS", "/private/secret/token"],
      [],
    ]
  ) {
    const f = releaseSources(
      view,
      undefined,
      undefined,
      () => Promise.resolve({ supported: false, issues }),
    );
    const result = await f.sources.inspectRelease(view);
    equal(result.openingAvailability, "unavailable");
    equal(result.openingIssues.length > 0, true);
    equal(JSON.stringify(result).includes("/private/"), false);
    deepStrictEqual(f.counts(), {
      sourceReads: 0,
      hostReads: 0,
      assetReads: 0,
    });
  }
  let probes = 0;
  const f = releaseSources(view, undefined, undefined, () => {
    probes++;
    throw new Error("No probe for an unverified manifest");
  });
  for (
    const altered of [
      { ...view, digest: "b".repeat(64) },
      { ...view, assetAvailability: "unavailable" as const },
      { ...view, status: "conflict" as const },
      { ...view, issues: ["TAG_UNAVAILABLE"] },
    ]
  ) {
    deepStrictEqual(await f.sources.inspectRelease(altered), {
      openingAvailability: "unavailable",
      openingIssues: ["SOURCE_OPENING_UNAVAILABLE"],
    });
  }
  equal(probes, 0);
  deepStrictEqual(f.counts(), { sourceReads: 0, hostReads: 0, assetReads: 0 });
});

Deno.test("unfinished or failed publication cannot reuse an earlier skill-only manifest as current readiness", async () => {
  const { view } = await incompleteSkillRelease();
  let probes = 0;
  for (
    const outcome of ["pending", "preparing", "failed", "refused"] as const
  ) {
    const selected: SavedSystemView = {
      ...view,
      publication: {
        format: "assembly-release-publication-v1",
        outcome,
        attempt: 1,
        updatedAt: "2026-10-31T00:00:00.000Z",
        nextSequence: 1,
        historyTruncated: false,
        events: [],
      },
    };
    const f = releaseSources(selected, undefined, undefined, () => {
      probes++;
      return Promise.resolve({ supported: true, issues: [] });
    });
    deepStrictEqual(await f.sources.inspectRelease(selected), {
      openingAvailability: "unavailable",
      openingIssues: ["SOURCE_OPENING_UNAVAILABLE"],
    });
    await rejects(() =>
      f.sources.resolve({
        kind: "release",
        releaseId: selected.id,
        digest: selected.digest!,
      }), /retained Release is unavailable/);
    deepStrictEqual(f.counts(), {
      sourceReads: 0,
      hostReads: 0,
      assetReads: 0,
    });
  }
  equal(probes, 0);
});

Deno.test("exact models of one manifest are read once and handed out as copies while host and asset checks stay live", async () => {
  const { base, view } = await incompleteSkillRelease();
  const f = releaseSources(view, () => Promise.resolve(true));
  let exactReads = 0, unreadable = true;
  const model = requestControlModel();
  // Stand-in for the exact Git/Toolkit read behind this source.
  Object.assign(f.sources, {
    exactModels() {
      exactReads++;
      return unreadable
        ? Promise.reject(new Error("Exact source unreadable"))
        : Promise.resolve([structuredClone(model)]);
    },
  });
  await rejects(() => f.sources.readModelsForInspection(base), /unreadable/);
  await rejects(() => f.sources.readModelsForInspection(base), /unreadable/);
  equal(exactReads, 2, "a failure is never remembered");
  unreadable = false;
  const first = await f.sources.readModels(base);
  const second = await f.sources.readModelsForInspection(base);
  equal(exactReads, 3);
  deepStrictEqual(second, first);
  (first[0] as typeof model).identity.builderId = "mutated";
  deepStrictEqual(await f.sources.readModels(base), second);
  equal(exactReads, 3);
  deepStrictEqual(f.counts(), { hostReads: 2, assetReads: 5, sourceReads: 0 });
  const other = structuredClone(base);
  other.manifest.prerequisites = [];
  other.manifestDigest = await requestSpaceDigest(other.manifest);
  other.release = { id: "release", digest: other.manifestDigest };
  await f.sources.readModelsForInspection(other);
  equal(exactReads, 4, "another manifest digest reads its own exact source");
});
