/** Production service/cache and SQL binding adapter with resource port doubles.
 * Integration classification preserves the existing SQL adapter import profile;
 * this test opens no database, queue, file, native runtime or network service. */
import assert from "node:assert/strict";
import { createArtifactSourceServices } from "../../src/composition/artifact-source-services.ts";
import type { PrismaClient } from "../../src/adapters/out/postgres/client.ts";
import type { PostgresRuntimeScope } from "../../src/adapters/out/postgres/scope.ts";
import type {
  ArtifactSourceSelection,
  ArtifactSourceServicePort,
} from "../../src/application/work/artifacts/publication.ts";
import { skillContentDigest } from "../../src/domain/skills/context-skills.ts";
import type { QueuedArtifactSourcePublication } from "../../src/domain/work/artifacts/source-publication.ts";
import { ArtifactSourceError } from "../../src/domain/work/artifacts/source-reference.ts";

const hostScope = Object.freeze({
  projectId: "git:55555555-5555-4555-8555-555555555555",
  systemId: "source-factory-host",
});
const ownerId = "shared-native-owner";
const baseVersion = `commit:${"a".repeat(40)}`;
const sourceDigest = "b".repeat(64);
const content = "# Exact scoped instructions\n";
const zeroResources = {
  clientAccesses: 0,
  repositoryCalls: 0,
  headerReads: 0,
  publicationCalls: 0,
};
function scope(executionSpaceId: string): PostgresRuntimeScope {
  return Object.freeze({ ...hostScope, executionSpaceId, operatorId: ownerId });
}

async function fixture() {
  const digest = await skillContentDigest(content);
  const manifestDigest = "d".repeat(64);
  const reference: ArtifactSourceSelection["reference"] = {
    version: 2,
    scopeId: "shared-source-scope",
    repositoryId: "55555555-5555-4555-8555-555555555555",
    artifactId: "scoped-skill",
    kind: "skill-document",
    commitOid: "e".repeat(40),
    entryPath: `artifacts/${manifestDigest}/SKILL.md`,
    manifestPath: `artifacts/${manifestDigest}/manifest.json`,
    contentEncoding: "utf8-v1",
    contentDigest: digest,
    manifestFormat: "assembly-artifact-package-v2",
    manifestDigestVersion: "sha256-canonical-json-v1",
    manifestDigest,
  };
  const selection: ArtifactSourceSelection = {
    bindingId: "binding-probe",
    ownerId,
    localArtifactId: "scoped-skill",
    expectedDigest: digest,
    reference,
    expectedBinding: {
      version: 1,
      bindingId: "binding-probe",
      versionId: "version-probe",
      revision: 1,
      ownerId,
      localArtifactId: "scoped-skill",
      invocationId: "seed-probe",
      reference,
    },
  };
  const publications: QueuedArtifactSourcePublication[] = [];
  const lookups: Array<PostgresRuntimeScope & { bindingId: string }> = [];
  let clientAccesses = 0, repositoryCalls = 0, headerReads = 0;
  const stopPublication = new Error("Captured source target before retention");
  const client = new Proxy({
    artifactBinding: {
      findUnique(input: {
        where: {
          projectId_systemId_executionSpaceId_operatorId_bindingId:
            & PostgresRuntimeScope
            & { bindingId: string };
        };
      }) {
        lookups.push(structuredClone(
          input.where.projectId_systemId_executionSpaceId_operatorId_bindingId,
        ));
        return Promise.resolve(null);
      },
    },
  }, {
    get(target, property) {
      clientAccesses++;
      if (property === "artifactBinding") return target.artifactBinding;
      throw new Error(`Unexpected client resource: ${String(property)}`);
    },
  }) as unknown as PrismaClient;
  const forbiddenRepository = () => {
    repositoryCalls++;
    throw new Error("Unexpected retained source access");
  };
  const sources = createArtifactSourceServices({
    client,
    hostScope,
    repositoryId: selection.reference.repositoryId,
    sourceScopeId: selection.reference.scopeId,
    repository: {
      retain: forbiddenRepository,
      read: forbiddenRepository,
      findByCommand: forbiddenRepository,
    },
    queuedPublisher: {
      publish(publication) {
        publications.push(structuredClone(publication));
        return Promise.reject(stopPublication);
      },
    },
    sourceHeader(version) {
      headerReads++;
      assert.equal(version, baseVersion);
      return Promise.resolve({ version, sourceDigest });
    },
  });
  async function assertTarget(
    service: ArtifactSourceServicePort,
    expected: PostgresRuntimeScope,
  ) {
    // Capture the real service's structurally valid publication envelope. The
    // stopped publisher grants no Request business authority or source receipt.
    await assert.rejects(() =>
      service.publishSkill({
        artifactId: selection.reference.artifactId,
        ownerId: expected.operatorId,
        localArtifactId: selection.localArtifactId,
        invocationId: "seed-probe",
        baseVersion,
        expectedDigest: digest,
        content,
        proof: {
          kind: "skill-authority",
          authority: {
            callerId: expected.operatorId,
            policy: {
              id: "fixture-skill-policy",
              ownerId: expected.operatorId,
              allowedHosts: [],
              maxSkillBytes: 65536,
              maxInstalledSkills: 8,
              maxLoadedSkills: 4,
              maxLoadedCharacters: 48000,
            },
            modelVersion: {
              digest: sourceDigest,
              repositoryVersion: baseVersion,
            },
            behaviorId: "fixture-install",
            invocationId: "seed-probe",
            permissions: ["install"],
          },
        },
      }), (error: unknown) => error === stopPublication);
    assert.deepEqual(publications.at(-1)!.target, {
      ...expected,
      ownerId: expected.operatorId,
      localArtifactId: selection.localArtifactId,
      invocationId: "seed-probe",
    });
    // The production binding adapter must query the same exact tuple. Stop on
    // absence rather than manufacture a completed SQL/Git binding receipt.
    await assert.rejects(
      () => service.resolveSkill(selection),
      (error: unknown) =>
        error instanceof ArtifactSourceError && error.code === "not-found",
    );
    assert.deepEqual(lookups.at(-1), {
      ...expected,
      bindingId: selection.bindingId,
    });
  }
  return {
    sources,
    assertTarget,
    publications,
    counts: () => ({
      clientAccesses,
      repositoryCalls,
      headerReads,
      publicationCalls: publications.length,
    }),
  };
}

Deno.test("artifact source factory caches exact scope and separates same-owner Main A B bindings", async () => {
  const f = await fixture();
  const scopes = [scope("main"), scope("request-a"), scope("request-b")];
  const services = await Promise.all(scopes.map(f.sources));
  for (let index = 0; index < scopes.length; index++) {
    assert.equal(services[index], await f.sources(scopes[index]));
    assert.equal(
      services[index],
      await f.sources(Object.freeze({
        operatorId: ownerId,
        executionSpaceId: scopes[index].executionSpaceId,
        systemId: hostScope.systemId,
        projectId: hostScope.projectId,
      })),
    );
    for (let other = 0; other < index; other++) {
      assert.notEqual(services[index], services[other]);
    }
  }
  const peerScope = Object.freeze({ ...scopes[1], operatorId: "peer-owner" });
  const peer = await f.sources(peerScope);
  assert.notEqual(peer, services[1]);
  assert.deepEqual(f.counts(), zeroResources);
  for (let index = 0; index < scopes.length; index++) {
    await f.assertTarget(services[index], scopes[index]);
  }
  await f.assertTarget(peer, peerScope);
  assert.equal(
    new Set(f.publications.map((entry) => entry.publicationId)).size,
    4,
  );
  assert.deepEqual(f.counts(), {
    clientAccesses: 4,
    repositoryCalls: 0,
    headerReads: 4,
    publicationCalls: 4,
  });
});

Deno.test("artifact source factory rejects foreign host and invalid scope before resource access", async () => {
  const f = await fixture();
  const valid = scope("request-a");
  for (
    const foreign of [
      { ...valid, projectId: "git:foreign-project" },
      { ...valid, systemId: "foreign-system" },
    ]
  ) {
    await assert.rejects(
      () => f.sources(foreign),
      (error: unknown) =>
        error instanceof ArtifactSourceError && error.code === "scope",
    );
  }
  for (
    const invalid of [
      { ...valid, projectId: "" },
      { ...valid, systemId: " " },
      { ...valid, executionSpaceId: "\0" },
      { ...valid, operatorId: " " },
    ]
  ) {
    await assert.rejects(
      () => f.sources(invalid),
      /Invalid PostgreSQL .* scope/,
    );
  }
  const service = await f.sources(valid);
  assert.equal(service, await f.sources({ ...valid }));
  assert.deepEqual(f.counts(), zeroResources);
});

Deno.test("artifact source factory captures scope before caller mutation and cannot retarget its cached service", async () => {
  const f = await fixture();
  const original = scope("request-a");
  const supplied = { ...original };
  const pending = f.sources(supplied);
  Object.assign(supplied, {
    projectId: "git:foreign-project",
    systemId: "foreign-system",
    executionSpaceId: "request-b",
    operatorId: "foreign-owner",
  });
  const service = await pending;
  assert.equal(service, await f.sources(original));
  assert.notEqual(service, await f.sources(scope("request-b")));
  await assert.rejects(
    () => f.sources(supplied),
    (error: unknown) =>
      error instanceof ArtifactSourceError && error.code === "scope",
  );
  assert.deepEqual(f.counts(), zeroResources);
  await f.assertTarget(service, original);
});
