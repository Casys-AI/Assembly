import { sourceExecutablesCompilation } from "../../../adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { executableFixture } from "../../../../test/support/execution-fixture.ts";
import { compareNetworkImpactFrames } from "./analysis.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { NativeBehaviorContract } from "../../../domain/model/execution/native-contracts.ts";
import type {
  NetworkImpactFrame,
  NetworkImpactIssue,
} from "../../../domain/model/consultation/network-impact.ts";
import {
  CompiledNetworkImpactModelReader,
  projectNetworkImpactPaths,
} from "./compiled-model-reader.ts";

const projectId = "git:eaa8ee83-b912-5b8d-b114-db28a72570bd";
const host = "skills.example.org";
function fixture() {
  const model = executableFixture({
    projectId,
    editingContextId: `${projectId}/main`,
    rootId: `${projectId}/root`,
    systemId: "system",
    builderId: "operator",
    catalogId: "catalog",
  });
  const revision: ModelRevision = {
    version: `commit:${"a".repeat(40)}`,
    sources: { "model.sysml": "package Model;" },
    elements: [],
    documents: [],
    sourceDigest: "b".repeat(64),
    semanticDigest: "c".repeat(64),
    provenanceDigest: "d".repeat(64),
    sourceHashes: {},
    engineVersion: "fixture",
  };
  model.configuration.network = { allowedHosts: [host] };
  model.catalog = [{
    nativeId: "tool",
    candidateId: "candidate",
    contractId: "contract",
    name: "Reader",
    kind: "read_web_page",
    digest: "a".repeat(64),
    status: "active",
  }];
  model.contracts = [{
    nativeId: "contract",
    kind: "read_web_page",
    module: "default({url,html}) => {title,text}",
    acceptanceCriteria: ["Read"],
  }];
  const behavior: NativeBehaviorContract = {
    id: "install-access",
    name: "Install",
    description: "PRIVATE INSTRUCTIONS",
    targetNativeId: "install",
    targetTypeId: "install-type",
    inputTypeId: "input",
    callerNativeId: "operator",
    sourceIds: ["install-access"],
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        url: { type: "string" },
        expectedDigest: { type: "string" },
      },
      required: ["id", "url"],
    },
  };
  model.behaviors = [behavior];
  model.operatorEntries = [{
    id: "install",
    kind: "skill-install",
    typeId: "install-type",
    performerId: "gate",
    allocationId: "allocation",
    sourceIds: ["install", "allocation"],
  }];
  model.skillPolicy = {
    kind: "lazy-skills",
    id: "skills",
    revision: 1,
    elementId: "skill-policy",
    ownerId: "operator",
    allowedHosts: [host],
    sourceIds: ["skill-policy"],
    maxSkillBytes: 65536,
    maxInstalledSkills: 8,
    maxLoadedSkills: 4,
    maxLoadedCharacters: 48000,
  };
  const paths = () => projectNetworkImpactPaths(revision, model, [model], host);
  return { model, revision, behavior, paths };
}

function frame(f: ReturnType<typeof fixture>): NetworkImpactFrame {
  const issues: NetworkImpactIssue[] = [];
  return {
    version: f.revision.version,
    state: "known",
    paths: projectNetworkImpactPaths(
      f.revision,
      f.model,
      [f.model],
      host,
      issues,
    ),
    issues,
    indirectAccess: "not-covered",
  };
}

Deno.test("network impact preserves independent web and skills host ceilings", () => {
  const f = fixture();
  deepStrictEqual(f.paths().map((path) => [path.hostPermission, path.state]), [
    ["allowed", "conditional"],
    ["allowed", "conditional"],
  ]);
  f.model.configuration.network!.allowedHosts = [];
  deepStrictEqual(f.paths().map((path) => [path.hostPermission, path.state]), [
    ["denied", "blocked"],
    ["allowed", "conditional"],
  ]);
  f.model.skillPolicy!.allowedHosts = [];
  equal(f.paths()[1]!.state, "blocked");
});

Deno.test("network impact detects a changed download byte limit under unchanged native identities", () => {
  const f = fixture();
  const before = frame(f);
  f.model.skillPolicy!.maxSkillBytes = 32768;
  const after = frame(f);
  const changes = compareNetworkImpactFrames(before, after).changes;
  equal(changes.find((change) => change.channel === "web")!.kind, "unchanged");
  equal(
    changes.find((change) => change.channel === "skill-install")!.kind,
    "route-changed",
  );
  ok(
    after.paths[1]!.guards.find((guard) =>
      guard.code === "SKILL_DOWNLOAD_INPUT_AND_LIMITS"
    )!.explanation.includes("32768 bytes"),
  );
});

Deno.test("network impact detects a changed installation count limit under unchanged native identities", () => {
  const f = fixture();
  const before = frame(f);
  f.model.skillPolicy!.maxInstalledSkills = 6;
  const after = frame(f);
  const changes = compareNetworkImpactFrames(before, after).changes;
  equal(changes.find((change) => change.channel === "web")!.kind, "unchanged");
  equal(
    changes.find((change) => change.channel === "skill-install")!.kind,
    "route-changed",
  );
  ok(
    after.paths[1]!.guards.find((guard) =>
      guard.code === "SKILL_DOWNLOAD_INPUT_AND_LIMITS"
    )!.explanation.includes("skill count is 6"),
  );
});

Deno.test("network impact does not classify local loaded-skill limits as network route changes", () => {
  const f = fixture();
  const before = frame(f);
  f.model.skillPolicy!.maxLoadedSkills = 3;
  f.model.skillPolicy!.maxLoadedCharacters = 24000;
  const after = frame(f);
  deepStrictEqual(
    compareNetworkImpactFrames(before, after).changes.map((change) =>
      change.kind
    ),
    ["unchanged", "unchanged"],
  );
});

Deno.test("network impact reports truncated witness identities and cannot call an omitted tail change unchanged", () => {
  const f = fixture();
  f.model.skillPolicy!.sourceIds = Array.from(
    { length: 129 },
    (_, i) => `skill-source-${i}`,
  );
  const before = frame(f);
  f.model.skillPolicy!.sourceIds[128] = "changed-tail-identity";
  const after = frame(f);
  deepStrictEqual(before.paths, after.paths);
  for (const projected of [before, after]) {
    ok(
      projected.issues.some((issue) =>
        issue.code === "WITNESS_LIMIT" &&
        issue.recordId === "SKILL_LOCAL_POLICY" &&
        issue.version === f.revision.version
      ),
    );
    ok(projected.paths.every((path) => path.witnesses.length <= 128));
    ok(
      projected.paths.every((path) =>
        path.guards.every((guard) => guard.witnesses.length <= 128)
      ),
    );
  }
  const transition = compareNetworkImpactFrames(before, after);
  ok(transition.changes.every((change) => change.kind === "indeterminate"));
  equal(transition.directAccessAfter, "unknown");
});

Deno.test("network impact counts reused native facts once in the path summary while preserving guard roles", () => {
  const f = fixture();
  f.model.skillPolicy!.sourceIds = Array.from(
    { length: 50 },
    (_, i) => `skill-source-${i}`,
  );
  const projected = frame(f);
  deepStrictEqual(projected.issues, []);
  const skill = projected.paths[1]!;
  equal(skill.witnesses.length, 53);
  ok(skill.witnesses.every((witness) => witness.role === "path"));
  for (
    const code of [
      "SKILL_LOCAL_POLICY",
      "SKILL_HOST_SCOPE",
      "SKILL_DOWNLOAD_INPUT_AND_LIMITS",
    ]
  ) {
    const guard = skill.guards.find((entry) => entry.code === code)!;
    equal(guard.witnesses.length, 50);
    ok(guard.witnesses.every((witness) => witness.role === code));
  }
});

Deno.test("network impact reports 129 distinct aggregate identities even when every guard fits its witness bound", () => {
  const f = fixture();
  f.model.skillPolicy!.sourceIds = Array.from(
    { length: 50 },
    (_, i) => `skill-source-${i}`,
  );
  // 50 policy facts + 77 exposure facts + the two allocated-entry facts.
  f.behavior.sourceIds = Array.from(
    { length: 77 },
    (_, i) => `exposure-source-${i}`,
  );
  const projected = frame(f);
  deepStrictEqual(
    projected.issues.map((issue) => [issue.code, issue.recordId]),
    [["WITNESS_LIMIT", "skill-install"]],
  );
  equal(projected.paths[1]!.witnesses.length, 128);
});

Deno.test("network impact honors local skill exposure schema, owner and exact target", () => {
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.behavior.callerNativeId = "peer";
      },
      (f: ReturnType<typeof fixture>) => {
        f.behavior.targetTypeId = "foreign-type";
      },
      (f: ReturnType<typeof fixture>) => {
        f.behavior.inputSchema = { type: "object" };
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.behaviors = [];
      },
      (f: ReturnType<typeof fixture>) => {
        f.model.skillPolicy!.ownerId = "peer";
      },
      (f: ReturnType<typeof fixture>) => {
        delete f.model.skillPolicy;
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    equal(f.paths()[1]!.state, "blocked");
  }
});

Deno.test("network impact keeps web byte and URL provenance checks conditional", () => {
  const f = fixture();
  const web = f.paths()[0]!;
  equal(
    web.guards.find((guard) => guard.code === "WEB_TOOL_BYTES_AND_INPUT")!
      .state,
    "conditional",
  );
  equal(
    web.guards.find((guard) => guard.code === "WEB_URL_SELECTION")!.state,
    "conditional",
  );
  f.model.mandate.mayInvoke = false;
  equal(f.paths()[0]!.state, "blocked");
  f.model.mandate.mayInvoke = "active-catalog-only";
  f.model.catalog[0]!.contractId = "wrong";
  equal(f.paths()[0]!.state, "blocked");
});

Deno.test("network impact witnesses expose source metadata without instruction content", () => {
  const f = fixture();
  f.revision.elements.push({
    "@id": "skill-policy",
    "@type": "PartUsage",
    qualifiedName: "Model::skills",
    "sysx:sourceDocument": "model.sysml",
    "sysx:sourceLine": 4,
    "sysx:sourceColumn": 3,
    instruction: "PRIVATE INSTRUCTIONS",
  });
  const located = f.paths()[1]!.witnesses.find((witness) =>
    witness.elementId === "skill-policy"
  )!;
  equal(located.path, "model.sysml");
  equal(located.line, 4);
  ok(!JSON.stringify(f.paths()).includes("PRIVATE INSTRUCTIONS"));
  f.revision.elements[0]!["sysx:sourceDocument"] = "outside.sysml";
  equal(
    f.paths()[1]!.witnesses.find((witness) =>
      witness.elementId === "skill-policy"
    )!.path,
    undefined,
  );
});

Deno.test("network impact locates a renamed mandate by its holder binding without exporting its source text", () => {
  const f = fixture();
  const ref = (id: string) => ({ "@id": id });
  const raw = (
    id: string,
    metaclass: string,
    name: string,
    owner?: string,
  ) => ({
    "@id": id,
    "@type": metaclass,
    declaredName: name,
    ...(owner ? { owner: ref(owner) } : {}),
  });
  f.revision.elements.push(
    raw("package", "Package", "P"),
    raw("system", "PartUsage", "system", "package"),
    raw("operator", "PartUsage", "operator", "system"),
    raw("mandate-type", "ItemDefinition", "ConfiguredMandate", "package"),
    {
      ...raw("actual-mandate", "ItemUsage", "renamedMandate", "system"),
      type: [ref("mandate-type")],
    },
    raw("holder-feature", "PartUsage", "holder", "mandate-type"),
    {
      ...raw("holder-chain", "Feature", "holderChain"),
      chainingFeature: [ref("actual-mandate"), ref("holder-feature")],
    },
    {
      ...raw("holder-binding", "BindingConnectorAsUsage", "binding", "system"),
      sourceFeature: ref("holder-chain"),
      targetFeature: ref("operator"),
    },
  );
  for (
    const [name, value] of [
      ["evidenceLevel", "configured"],
      ["source", "PRIVATE SOURCE TEXT"],
      ["mayInvokeActiveCatalog", true],
    ] as const
  ) {
    const attributeId = `mandate-${name}`;
    const literalId = `${attributeId}-literal`;
    f.revision.elements.push(
      raw(attributeId, "AttributeUsage", name, "actual-mandate"),
      {
        ...raw(
          literalId,
          typeof value === "boolean" ? "LiteralBoolean" : "LiteralString",
          "",
        ),
        value,
      },
      {
        ...raw(`${attributeId}-value`, "FeatureValue", ""),
        featureWithValue: ref(attributeId),
        value: ref(literalId),
      },
    );
  }
  const web = f.paths()[0]!;
  const witnessIds = web.guards.find((guard) =>
    guard.code === "WEB_INVOKE_MANDATE"
  )!.witnesses.map((witness) => witness.elementId);
  ok(witnessIds.includes("actual-mandate"));
  ok(witnessIds.includes("holder-binding"));
  ok(witnessIds.includes("mandate-mayInvokeActiveCatalog-literal"));
  ok(!JSON.stringify(web).includes("PRIVATE SOURCE TEXT"));
  equal(web.consumer.symbol, "DenoToolRunner.checkedUrl");
});

Deno.test("network impact reader treats an uncalculated empty native artifact as unknown", async () => {
  const f = fixture();
  const calls: string[] = [];
  const reader = new CompiledNetworkImpactModelReader({
    compilation: sourceExecutablesCompilation,
    projectId,
    repository: {
      at(version) {
        calls.push(version);
        return Promise.resolve(f.revision);
      },
      descriptorAt() {
        return Promise.resolve(null);
      },
    },
  });
  const result = await reader.read(f.revision.version, "operator", host);
  equal(result.state, "unknown");
  deepStrictEqual(result.paths, []);
  deepStrictEqual(calls, [f.revision.version]);
  equal(result.build, undefined);
  ok(result.issues.some((issue) => issue.code === "BUILD_RECIPE_UNKNOWN"));
  ok(
    result.issues.some((issue) =>
      issue.code === "EXECUTABLE_MODEL_UNAVAILABLE"
    ),
  );
  equal(result.indirectAccess, "not-covered");
});

Deno.test("network impact reader preserves unknown on artifact errors and cancellation", async () => {
  let reads = 0;
  const reader = new CompiledNetworkImpactModelReader({
    compilation: sourceExecutablesCompilation,
    projectId,
    repository: {
      at() {
        reads++;
        throw new Error("PRIVATE INSTRUCTIONS");
      },
    },
  });
  const unavailable = await reader.read("version", "operator", host);
  equal(unavailable.state, "unknown");
  equal(unavailable.issues[0]!.code, "MODEL_READ_FAILED");
  ok(!JSON.stringify(unavailable).includes("PRIVATE INSTRUCTIONS"));
  const cancelled = await reader.read(
    "version",
    "operator",
    host,
    AbortSignal.abort(),
  );
  equal(cancelled.issues[0]!.code, "MODEL_READ_ABORTED");
  equal(reads, 1);
});

Deno.test("network impact reader forwards cancellation to the descriptor lookup", async () => {
  const f = fixture();
  const controller = new AbortController();
  let descriptorReads = 0;
  const reader = new CompiledNetworkImpactModelReader({
    compilation: sourceExecutablesCompilation,
    projectId,
    repository: {
      at(_version, signal) {
        equal(signal, controller.signal);
        return Promise.resolve(f.revision);
      },
      descriptorAt(version, signal) {
        descriptorReads++;
        equal(version, f.revision.version);
        equal(signal, controller.signal);
        controller.abort();
        signal!.throwIfAborted();
        return Promise.resolve(null);
      },
    },
  });
  const result = await reader.read(
    f.revision.version,
    "operator",
    host,
    controller.signal,
  );
  equal(descriptorReads, 1);
  equal(result.state, "unknown");
  equal(result.issues[0]!.code, "MODEL_READ_ABORTED");
  deepStrictEqual(result.paths, []);
});

Deno.test("network impact reader never turns a global executable compilation failure into denied paths", async () => {
  const f = fixture();
  f.revision.elements.push({
    "@id": "package",
    "@type": "Package",
    declaredName: "Broken",
  });
  const reader = new CompiledNetworkImpactModelReader({
    compilation: sourceExecutablesCompilation,
    projectId,
    repository: {
      at() {
        return Promise.resolve(f.revision);
      },
    },
  });
  const result = await reader.read(f.revision.version, "operator", host);
  equal(result.state, "unknown");
  deepStrictEqual(result.paths, []);
  ok(
    result.issues.some((issue) =>
      issue.code === "EXECUTABLE_MODEL_UNAVAILABLE"
    ),
  );
});

Deno.test("network impact reader retains persisted build pins and refuses foreign descriptor identity", async () => {
  const f = fixture();
  const descriptor = {
    v: 1 as const,
    kind: "ase-model-build" as const,
    repositoryId: projectId.slice(4),
    sourceDigest: f.revision.sourceDigest,
    recipe: {
      toolkit: { version: "fixture", bundleDigest: "1".repeat(64) },
      format: "fixture",
      normalizerVersion: 1,
      irVersion: "1",
      artifactSchema: 1,
      engineVersion: "fixture",
      digest: "2".repeat(64),
    },
    buildKey: "3".repeat(64),
    artifactDigest: "4".repeat(64),
    bytes: 1,
  };
  const reader = new CompiledNetworkImpactModelReader({
    compilation: sourceExecutablesCompilation,
    projectId,
    repository: {
      at() {
        return Promise.resolve(f.revision);
      },
      descriptorAt() {
        return Promise.resolve(descriptor);
      },
    },
  });
  const result = await reader.read(f.revision.version, "operator", host);
  equal(result.build!.recipeDigest, descriptor.recipe.digest);
  equal(result.build!.artifactDigest, descriptor.artifactDigest);
  equal(
    result.issues.some((issue) => issue.code === "BUILD_RECIPE_UNKNOWN"),
    false,
  );
  descriptor.repositoryId = "foreign";
  const invalid = await reader.read(f.revision.version, "operator", host);
  equal(invalid.state, "unknown");
  equal(invalid.build, undefined);
  equal(invalid.issues[0]!.code, "BUILD_DESCRIPTOR_FAILED");
});
