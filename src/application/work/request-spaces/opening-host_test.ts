import { sourceExecutablesCompilation } from "../../../adapters/out/sysml-toolkit/compilation/source-executables.ts";
import { assertRetainedCatalog } from "../tools/retained-catalog.ts";
import assert from "node:assert/strict";
import {
  RequestOpeningHost,
  requestOpeningInitialSkillIssues,
  requestOpeningModelIssues,
} from "./opening-host.ts";
import {
  requestControlModel,
  requestOpeningBase,
  requestSpaceScope,
} from "../../../../test/support/request-space-fixture.ts";
import { RequestRuntimeDependencies } from "../../../composition/request-runtime-dependencies.ts";
import { DenoToolRunner } from "../../../adapters/out/sandbox/runner.ts";
import { AjvSchemaValidator } from "../../../infrastructure/ajv-schema-validation.ts";
import { savedManifest } from "../../../domain/work/saved-systems.ts";
import {
  runtimeProvenanceRecord,
  unknownRuntimeProvenance,
} from "../../../domain/work/value-objects/runtime-provenance.ts";

Deno.test("Request source eligibility rejects exact scheduled types even when an implicit Request remains available", () => {
  const model = requestControlModel();
  assert.deepEqual(requestOpeningModelIssues(model), []);
  model.caseTypes = [{
    id: "scheduled-watch",
    name: "Scheduled watch",
    type: "watch",
    envelope: "reassessment",
    behaviorId: "watch-flow",
    ownerId: model.identity.builderId,
    schedule: { kind: "daily-at", hour: 8, minute: 0 },
    sourceIds: ["scheduled-watch"],
  }];
  const before = structuredClone(model);
  assert.deepEqual(requestOpeningModelIssues(model), [
    "SOURCE_SCHEDULE_UNSUPPORTED",
  ]);
  assert.deepEqual(model, before);
});

Deno.test("Request host inspector refuses omitted mandatory requirements before any readiness or source read", async () => {
  const base = await requestOpeningBase();
  const codes = [
    "FRESH_CACHE_AND_ENVIRONMENT",
    "NO_REMOTE_OR_NPM_RESOLUTION",
    "DENIED_IMPORTS",
    "MACOS_DENY_DEFAULT_SANDBOX",
    "FRESH_PRIVATE_RESOURCE_BINDINGS",
  ];
  let probes = 0, sourceReads = 0, originRelationReads = 0;
  const exactReadFailure = new Error("Exact retained reader reached");
  const runner = new DenoToolRunner();
  runner.inspectReadiness = () => {
    probes++;
    return Promise.resolve({ status: "ready" as const });
  };
  const unexpected = () => {
    throw new Error("Unexpected dependency use in source metadata refusal");
  };
  // Use the same production dependency constructor and runner pairing as host
  // composition. No readiness/private-binding success flag replaces it.
  const factory = new RequestRuntimeDependencies({
    hostScope: requestSpaceScope,
    sourceProjectId: requestSpaceScope.projectId,
    artifactSourcesForScope: unexpected,
    agents: { label: "not invoked", decide: unexpected, review: unexpected },
    runner,
    clock: { now: () => "2026-10-29T00:00:00Z" },
    schemaValidator: new AjvSchemaValidator(),
    runtimeProvenance: {
      collect: () => runtimeProvenanceRecord(unknownRuntimeProvenance()),
    },
    modelContext: {
      reader: { overview: unexpected, query: unexpected },
      toolingQuery: unexpected,
      readSourceRevision: unexpected,
    },
  });
  const inspector = new RequestOpeningHost({
    compilation: sourceExecutablesCompilation,
    scope: { ...requestSpaceScope, executionSpaceId: "main" },
    sourceProjectId: requestSpaceScope.projectId,
    repositoryId: base.manifest.source!.repositoryId,
    repository: { history: unexpected, header: unexpected },
    runner: factory.runner,
    assertSourceOriginRelation() {
      originRelationReads++;
      return Promise.resolve();
    },
    dependencies: factory.create,
    inspectInitialSkills: factory.inspectInitialSkills,
    reader: () =>
      Promise.resolve({
        repositoryId: base.manifest.source!.repositoryId,
        projectId: requestSpaceScope.projectId,
        at(version: string) {
          sourceReads++;
          assert.equal(version, base.manifest.source!.sourceVersion);
          throw exactReadFailure;
        },
        admittedMainSource: unexpected,
        descriptorAt: unexpected,
        readFirstParentInterval: unexpected,
      }),
  });
  for (const omitted of [codes, ...codes.map((code) => [code])]) {
    const manifest = savedManifest({
      ...base.manifest,
      prerequisites: codes.filter((code) => !omitted.includes(code)).map((
        code,
      ) => ({ kind: "host-runtime", operatorId: "operator", code })),
    });
    const result = await inspector.inspectHostSupport(manifest);
    assert.equal(result.supported, false);
    assert.deepEqual(
      result.issues,
      omitted.map((code) => `HOST_REQUIREMENT_MISSING_${code}`),
    );
    assert.equal(probes, 0);
    assert.equal(sourceReads, 0);
  }
  // Complete metadata reaches the supplied exact reader after one runner probe;
  // its technical failure remains observable instead of becoming readiness.
  const complete = savedManifest({
    ...base.manifest,
    prerequisites: codes.map((code) => ({
      kind: "host-runtime",
      operatorId: "operator",
      code,
    })),
  });
  await assert.rejects(
    inspector.inspectHostSupport(complete),
    (error) => error === exactReadFailure,
  );
  assert.equal(probes, 1);
  assert.equal(sourceReads, 1);
  assert.equal(
    originRelationReads,
    codes.length + 2,
    "Each fresh host read checks current origin relation; exact physical reader still runs once for complete metadata",
  );
});

Deno.test("Request model eligibility pairs initial tool coverage and bundled skill inspections", async () => {
  const model = requestControlModel();
  model.initialSkills = [{
    nativeId: "seed-skill",
    id: "skill",
    source: "bundle:skill",
    digest: "a".repeat(64),
    loaded: true,
    sourceIds: ["seed-skill"],
  }];
  assert.deepEqual(requestOpeningModelIssues(model), []);
  model.initialSkills = [];
  model.initialTools = [{
    nativeId: "seed-tool",
    id: "tool",
    sourceIds: ["seed-tool"],
    draft: {
      name: "Initial tool",
      description: "An unsupported source dependency",
      kind: "read_web_page",
      code: "export default () => ({ title: 'fixture', text: 'fixture' });",
    },
  }];
  await assert.rejects(
    () => assertRetainedCatalog(model, []),
    /initial tool seed/,
  );
});

Deno.test("Request initial skill prerequisites map only the known exact seeded owner and actual inspection", async () => {
  const model = requestControlModel();
  model.initialSkills = [{
    nativeId: "seed-skill",
    id: "skill",
    source: "bundle:skill",
    digest: "a".repeat(64),
    loaded: true,
    sourceIds: ["seed-skill"],
  }];
  const owner = model.identity.builderId;
  const known = {
    kind: "skill" as const,
    code: "SKILL_DEPENDENCY",
    operatorId: owner,
  };
  const before = structuredClone({ model, known });
  let calls = 0;
  const inspect = (actual: typeof model) => {
    assert.deepEqual(actual, model);
    calls++;
    return Promise.resolve({ supported: true as const, issues: [] as [] });
  };
  assert.deepEqual(
    await requestOpeningInitialSkillIssues([model], [known], inspect),
    [],
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    await requestOpeningInitialSkillIssues([model], [], inspect),
    ["SOURCE_SKILL_REQUIREMENT_MISSING"],
  );
  for (
    const entry of [
      { ...known, code: "OTHER_SKILL" },
      { ...known, operatorId: "foreign-owner" },
      { kind: "skill" as const, code: "SKILL_DEPENDENCY" },
    ]
  ) {
    assert(
      (await requestOpeningInitialSkillIssues([model], [entry], inspect))
        .includes("SOURCE_DEPENDENCY_UNSUPPORTED"),
    );
  }
  const withoutSeed = structuredClone(model);
  withoutSeed.initialSkills = [];
  assert.deepEqual(
    await requestOpeningInitialSkillIssues([withoutSeed], [known], inspect),
    ["SOURCE_DEPENDENCY_UNSUPPORTED"],
  );
  assert.deepEqual(
    await requestOpeningInitialSkillIssues(
      [model],
      [known],
      () =>
        Promise.resolve({
          supported: false,
          issues: ["INITIAL_SKILL_CONTENT_DIFFERS"],
        }),
    ),
    ["INITIAL_SKILL_CONTENT_DIFFERS", "SOURCE_DEPENDENCY_UNSUPPORTED"],
  );
  const failure = new Error("Exact bundle read unavailable");
  await assert.rejects(
    () =>
      requestOpeningInitialSkillIssues(
        [model],
        [known],
        () => Promise.reject(failure),
      ),
    (error) => error === failure,
  );
  assert.deepEqual({ model, known }, before);
});
