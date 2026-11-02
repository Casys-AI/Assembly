import assert from "node:assert/strict";
import { artifactModel } from "../../../test/support/tool-artifact-fixture.ts";
import { ContextSkillsService } from "../../application/skills/context-skills.ts";
import { ArtifactSourceService } from "../../application/work/artifacts/publication.ts";
import { createRequestCase } from "../../application/work/cases/runtime.ts";
import type { NativeBehaviorContract } from "../../domain/model/execution/native-contracts.ts";
import {
  skillContentDigest,
  SkillError,
} from "../../domain/skills/context-skills.ts";
import type { QueuedArtifactSourcePublication } from "../../domain/work/artifacts/source-publication.ts";
import {
  initialSkillInvocationId,
  SkillsBehavior,
} from "../../application/skills/behavior.ts";
import { BundledSkillReadError } from "../out/filesystem/skill-bundles.ts";
import {
  assertRequestInitialSkillPublication,
  inspectRequestInitialSkills,
  type RequestInitialSkillPublicationContext,
} from "./request-initial-skills.ts";

const ownerId = "request-operator";
const text =
  "# Request instructions\nExact source-selected bundled instructions.\n";
const kinds = [
  "skill-install",
  "skill-list",
  "skill-load",
  "skill-unload",
] as const;

function behavior(kind: typeof kinds[number]): NativeBehaviorContract {
  const fields = kind === "skill-list"
    ? []
    : kind === "skill-install"
    ? ["id", "url", "expectedDigest"]
    : ["id", "expectedDigest"];
  return {
    id: `${kind}-access`,
    name: kind,
    description: "Source-owned skill access",
    callerNativeId: ownerId,
    targetNativeId: `${kind}-target`,
    targetTypeId: `${kind}-type`,
    inputTypeId: `${kind}-input`,
    sourceIds: [`${kind}-source`],
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        fields.map((name) => [name, { type: "string" }]),
      ),
      required: fields.filter((field) =>
        kind !== "skill-install" || field !== "expectedDigest"
      ),
      additionalProperties: false,
    },
  };
}

async function fixture() {
  const model = artifactModel(ownerId);
  model.identity.projectId = "git:repository";
  model.version.digest = "b".repeat(64);
  model.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  model.behaviors = kinds.map(behavior);
  model.operatorEntries = kinds.map((kind) => ({
    id: `${kind}-target`,
    kind,
    typeId: `${kind}-type`,
    performerId: "admitted-performer",
    allocationId: `${kind}-allocation`,
    sourceIds: [`${kind}-source`],
  }));
  model.skillPolicy = {
    kind: "lazy-skills",
    id: "scoped-skills",
    revision: 1,
    elementId: "skills-policy",
    sourceIds: ["skills-policy"],
    ownerId,
    allowedHosts: [],
    maxSkillBytes: 65536,
    maxInstalledSkills: 8,
    maxLoadedSkills: 4,
    maxLoadedCharacters: 48000,
  };
  model.initialSkills = [{
    nativeId: "initial-assembly-skill",
    id: "assembly-modeling",
    source: "bundle:assembly-modeling",
    digest: await skillContentDigest(text),
    loaded: true,
    sourceIds: ["initial-assembly-skill"],
  }];
  model.caseTypes = [{
    id: "request-type",
    name: "Request",
    type: "request",
    envelope: "conversational",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId,
    sourceIds: ["request-type"],
  }];
  const scope = {
    projectId: "host-project",
    systemId: "host-system",
    executionSpaceId: "request-a",
    operatorId: ownerId,
  };
  const birth = {
    runtimeId: `request:${scope.executionSpaceId}:${ownerId}`,
    openingId: "opening-a",
    caseId: "case-a",
    caseNumber: 1,
    caseTypeId: "request-type",
    initialContributionId: "input-a",
    createdAt: "2026-10-29T00:00:00Z",
    openedBy: "modeled-local-owner",
    text: "Own Request input",
  };
  const context: RequestInitialSkillPublicationContext = {
    scope,
    birth,
    model,
    source: {
      repositoryId: "repository",
      projectId: model.identity.projectId,
      version: model.version.repositoryVersion,
      sourceDigest: "c".repeat(64),
    },
    state: {
      id: birth.runtimeId,
      revision: 0,
      catalogRevision: 0,
      model: structuredClone(model.identity),
      executionModel: structuredClone(model),
      messages: [],
      candidates: [],
      cases: [],
      events: [],
      busy: false,
      phase: "ready",
      provider: "controlled",
    },
  };
  createRequestCase(
    context.state,
    {
      id: birth.caseId,
      caseTypeId: birth.caseTypeId,
      objective: birth.text,
      openedBy: birth.openedBy,
      openedFrom: {
        conversationId: birth.runtimeId,
        openingId: birth.openingId,
        messageId: birth.initialContributionId,
      },
    },
    { now: () => birth.createdAt },
    birth.caseNumber,
  );
  let currentModel = structuredClone(model);
  let bundleReads = 0, currentChecks = 0, writes = 0;
  const readBundledSkill = (source: string, maximumBytes: number) => {
    assert.equal(source, "bundle:assembly-modeling");
    assert.equal(maximumBytes, model.skillPolicy!.maxSkillBytes);
    bundleReads++;
    return Promise.resolve(text);
  };
  const forbidden = () => {
    throw new Error("Read-only fixture invoked a write/storage port");
  };
  let captured: QueuedArtifactSourcePublication | undefined;
  // Capture the real service's publication envelope before any retention write.
  // This fixture makes no claim of Git/SQL qualification.
  const sources = new ArtifactSourceService({
    scope,
    repositoryId: context.source.repositoryId,
    sourceScopeId: "source-scope",
    sourceHeader: () =>
      Promise.resolve({
        version: context.source.version,
        sourceDigest: context.source.sourceDigest,
      }),
    repository: {
      retain: forbidden,
      read: forbidden,
      findByCommand: forbidden,
    },
    bindings: { bind: forbidden, read: forbidden },
    queuedPublisher: {
      publish(publication) {
        captured = structuredClone(publication);
        return Promise.reject(
          new SkillError(
            "forbidden",
            "Fixture captured the production publication",
          ),
        );
      },
    },
  });
  const service: ContextSkillsService = new ContextSkillsService({
    now: () => birth.createdAt,
    store: {
      load: () => Promise.resolve(null),
      save: () => {
        writes++;
        return forbidden();
      },
    },
    download: { download: forbidden },
    artifactSources: () => Promise.resolve(sources),
    assertCurrentAuthority: (authority, permission) =>
      skills.assertCurrentAuthority(authority, permission),
  });
  const skills: SkillsBehavior = new SkillsBehavior({
    entries: new Map(
      model.operatorEntries.map((
        entry,
      ) => [entry.id, { ownerId, kind: entry.kind }]),
    ),
    resolveCallerModel: (callerId, version) =>
      Promise.resolve(
        callerId === ownerId &&
          version.digest === currentModel.version.digest &&
          version.repositoryVersion === currentModel.version.repositoryVersion
          ? structuredClone(currentModel)
          : null,
      ),
    skills: () => Promise.resolve(service),
    readBundledSkill,
  });
  await assert.rejects(() => skills.initialize(model), /Fixture captured/);
  assert(captured);
  return {
    model,
    context,
    publication: captured,
    readBundledSkill,
    validation: {
      readBundledSkill,
      assertCurrentAuthority(authority, permission) {
        currentChecks++;
        return skills.assertCurrentAuthority(authority, permission);
      },
    } satisfies Parameters<typeof assertRequestInitialSkillPublication>[2],
    setCurrent(next: typeof model) {
      currentModel = structuredClone(next);
    },
    counts: () => ({ bundleReads, currentChecks, writes }),
  };
}

Deno.test("Request eligibility leaves models without seeds alone and diagnoses exposure or policy failures before reads", async () => {
  const f = await fixture();
  const empty = structuredClone(f.model);
  delete empty.initialSkills;
  delete empty.skillPolicy;
  assert.deepEqual(
    await inspectRequestInitialSkills(empty, () => {
      throw new Error("Unexpected bundle read");
    }),
    { supported: true, issues: [] },
  );
  const before = f.counts().bundleReads;
  for (const kind of ["skill-install", "skill-list", "skill-load"] as const) {
    const model = structuredClone(f.model);
    model.behaviors = model.behaviors!.filter((entry) =>
      entry.id !== `${kind}-access`
    );
    assert.deepEqual(
      await inspectRequestInitialSkills(model, f.readBundledSkill),
      { supported: false, issues: ["INITIAL_SKILL_EXPOSURE_UNAVAILABLE"] },
    );
  }
  const foreign = structuredClone(f.model);
  foreign.skillPolicy!.ownerId = "sibling";
  assert.deepEqual(
    await inspectRequestInitialSkills(foreign, f.readBundledSkill),
    { supported: false, issues: ["INITIAL_SKILL_POLICY_UNAVAILABLE"] },
  );
  const duplicate = structuredClone(f.model);
  duplicate.behaviors!.push(structuredClone(duplicate.behaviors![0]!));
  assert.deepEqual(
    await inspectRequestInitialSkills(duplicate, f.readBundledSkill),
    { supported: false, issues: ["INITIAL_SKILL_EXPOSURE_UNAVAILABLE"] },
  );
  assert.equal(f.counts().bundleReads, before);
});

Deno.test("Request eligibility rejects malformed seed identities and exact byte or aggregate loaded limits", async () => {
  const f = await fixture();
  for (
    const source of [
      "../SKILL.md",
      "https://example.org/SKILL.md",
      "bundle:../escape",
    ]
  ) {
    const model = structuredClone(f.model);
    model.initialSkills![0]!.source = source;
    assert.deepEqual(
      await inspectRequestInitialSkills(model, f.readBundledSkill),
      { supported: false, issues: ["INITIAL_SKILL_MODEL_INVALID"] },
    );
  }
  assert.deepEqual(
    await inspectRequestInitialSkills(
      f.model,
      () => Promise.resolve(`${text}changed`),
    ),
    { supported: false, issues: ["INITIAL_SKILL_CONTENT_DIFFERS"] },
  );
  assert.deepEqual(
    await inspectRequestInitialSkills(
      f.model,
      () => Promise.resolve("bad\0content"),
    ),
    { supported: false, issues: ["INITIAL_SKILL_CONTENT_INVALID"] },
  );
  assert.deepEqual(
    await inspectRequestInitialSkills(
      f.model,
      () => Promise.resolve("é".repeat(40000)),
    ),
    { supported: false, issues: ["INITIAL_SKILL_LIMIT_EXCEEDED"] },
  );
  const model = structuredClone(f.model), content = "x".repeat(300);
  model.skillPolicy!.maxLoadedCharacters = 500;
  model.initialSkills = [
    { ...model.initialSkills![0]!, digest: await skillContentDigest(content) },
    {
      ...model.initialSkills![0]!,
      nativeId: "second-seed",
      id: "second-skill",
      digest: await skillContentDigest(content),
    },
  ];
  assert.deepEqual(
    await inspectRequestInitialSkills(model, () => Promise.resolve(content)),
    { supported: false, issues: ["INITIAL_SKILL_LIMIT_EXCEEDED"] },
  );
});

Deno.test("Request eligibility preserves exact bundle infrastructure failures", async () => {
  const f = await fixture(), failure = new Error("Owned bundle read failed");
  await assert.rejects(
    () => inspectRequestInitialSkills(f.model, () => Promise.reject(failure)),
    (error) => error === failure,
  );
});

Deno.test("Request seed publication validates a production envelope without writes or context mutation", async () => {
  const f = await fixture();
  const before = structuredClone({
    publication: f.publication,
    context: f.context,
  });
  assert.equal(
    f.publication.target.invocationId,
    initialSkillInvocationId(f.model.initialSkills![0]!, f.model.version),
  );
  await assertRequestInitialSkillPublication(
    f.publication,
    f.context,
    f.validation,
  );
  assert.deepEqual({ publication: f.publication, context: f.context }, before);
  assert.equal(f.counts().currentChecks, 2);
  assert.equal(f.counts().writes, 0);
});

Deno.test("Request seed publication refuses Main, sibling, foreign source and closed birth", async () => {
  const f = await fixture();
  for (
    const change of [
      (context: typeof f.context) => {
        context.scope = { ...context.scope, executionSpaceId: "main" };
      },
      (context: typeof f.context) => {
        context.scope = { ...context.scope, executionSpaceId: "request-b" };
      },
      (context: typeof f.context) => {
        context.scope = { ...context.scope, systemId: "foreign-host" };
      },
      (context: typeof f.context) => {
        context.source.sourceDigest = "d".repeat(64);
      },
      (context: typeof f.context) => {
        context.source.version = `commit:${"d".repeat(40)}`;
      },
      (context: typeof f.context) => {
        context.source.projectId = "foreign-source";
      },
      (context: typeof f.context) => {
        context.state.id = "sibling-runtime";
      },
      (context: typeof f.context) => {
        context.state.cases![0]!.status = "closed-done";
      },
      (context: typeof f.context) => {
        context.birth.openingId = "other-opening";
      },
    ]
  ) {
    const context = structuredClone(f.context);
    change(context);
    await assert.rejects(() =>
      assertRequestInitialSkillPublication(f.publication, context, f.validation)
    );
  }
  assert.equal(f.counts().currentChecks, 0);
});

Deno.test("Request seed publication refuses forged invocation, artifact, command, content and install exposure", async () => {
  const f = await fixture();
  for (
    const change of [
      (publication: typeof f.publication) => {
        publication.target.invocationId = "not-an-initial-seed";
      },
      (publication: typeof f.publication) => {
        publication.source.artifactId = "copied-sibling-artifact";
      },
      (publication: typeof f.publication) => {
        publication.publicationId = "other-command";
      },
      (publication: typeof f.publication) => {
        if (publication.source.kind === "skill-document") {
          publication.source
            .content += "changed";
        }
      },
      (publication: typeof f.publication) => {
        if (publication.proof.kind === "skill-authority") {
          publication.proof.authority.behaviorId = "skill-list-access";
        }
      },
      (publication: typeof f.publication) => {
        if (publication.proof.kind === "skill-authority") {
          publication.proof.authority.permissions = ["install", "list"];
        }
      },
    ]
  ) {
    const publication = structuredClone(f.publication);
    change(publication);
    await assert.rejects(() =>
      assertRequestInitialSkillPublication(publication, f.context, f.validation)
    );
  }
  assert.equal(f.counts().writes, 0);
});

Deno.test("Request seed publication revalidates actual current authority after asynchronous bundle reads", async () => {
  const f = await fixture();
  let reads = 0;
  await assert.rejects(
    () =>
      assertRequestInitialSkillPublication(f.publication, f.context, {
        ...f.validation,
        readBundledSkill: (source, maximumBytes) => {
          reads++;
          if (reads === 2) {
            const revoked = structuredClone(f.model);
            revoked.behaviors = revoked.behaviors!.filter((entry) =>
              entry.id !== "skill-install-access"
            );
            f.setCurrent(revoked);
          }
          return f.readBundledSkill(source, maximumBytes);
        },
      }),
    /exposure differs/,
  );
  assert.equal(f.counts().currentChecks, 2);
  assert.equal(f.counts().writes, 0);
});

Deno.test("Request seed publication preserves exact current-authority failures", async () => {
  const f = await fixture(),
    failure = new Error("Durable scoped source is unavailable");
  await assert.rejects(
    () =>
      assertRequestInitialSkillPublication(f.publication, f.context, {
        ...f.validation,
        assertCurrentAuthority: () => Promise.reject(failure),
      }),
    (error) => error === failure,
  );
  assert.equal(f.counts().writes, 0);
});

Deno.test("Request eligibility bounds only typed expected bundle failures and publication remains refused", async () => {
  const f = await fixture();
  for (
    const [code, issue] of [
      ["unavailable", "INITIAL_SKILL_BUNDLE_UNAVAILABLE"],
      ["invalid-content", "INITIAL_SKILL_CONTENT_INVALID"],
      ["limit", "INITIAL_SKILL_LIMIT_EXCEEDED"],
    ] as const
  ) {
    const read = () => Promise.reject(new BundledSkillReadError(code));
    assert.deepEqual(await inspectRequestInitialSkills(f.model, read), {
      supported: false,
      issues: [issue],
    });
    await assert.rejects(() =>
      assertRequestInitialSkillPublication(f.publication, f.context, {
        ...f.validation,
        readBundledSkill: read,
      })
    );
  }
  const failure = new Deno.errors.PermissionDenied(
    "Technical bundle access failure",
  );
  await assert.rejects(
    () => inspectRequestInitialSkills(f.model, () => Promise.reject(failure)),
    (error) => error === failure,
  );
  assert.equal(f.counts().writes, 0);
});
