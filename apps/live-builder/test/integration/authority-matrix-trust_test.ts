import assert from "node:assert/strict";
import { ModelRepositoryError } from "../../src/application/model/repository.ts";
import { type ModelRevision } from "../../src/domain/model/records/revision.ts";
import { AuthorityMatrixService } from "../../src/application/governance/authority-matrix.ts";
import { CompiledAuthorityMatrixReader } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/reader.ts";
import { createAuthorityMatrixHandler } from "../../src/adapters/in/http/governance/authority-matrix.ts";
import { projectAuthorityMatrixWorker } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/worker-client.ts";
import { GitModelRepository } from "../../src/adapters/out/git/repository.ts";
import { SysmlToolkitWorkerError } from "../../src/adapters/out/sysml-toolkit/worker-client.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import {
  type MatrixArtifactFixture,
  matrixArtifactRepository,
  prepareMatrixArtifact,
} from "../support/authority-matrix-artifact-fixtures.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const projectId = "git:11111111-1111-4111-8111-111111111111";
const version = parseModelRevisionId(`commit:${"a".repeat(40)}`);
let setup: Promise<MatrixArtifactFixture> | undefined;
function prepared(): Promise<MatrixArtifactFixture> {
  return setup ??= prepareMatrixArtifact("initial", {
    packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")!,
    projectId,
    version,
  });
}
function rejectsCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SysmlToolkitWorkerError);
    assert.equal(error.code, code);
    return true;
  };
}
function corruptBuilderCoordinates(revision: ModelRevision): void {
  const builder = revision.elements.find((element) =>
    element.qualifiedName === "AssemblyLiveBuilder::liveBuilder::builder"
  );
  assert.ok(builder);
  assert.equal(typeof builder["sysx:sourceLine"], "number");
  builder["sysx:sourceLine"] = Number(builder["sysx:sourceLine"]) + 1;
}

Deno.test({
  name:
    "production projection process checks independent source pin and refuses altered artifacts",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const fixture = await prepared();
    assert.equal(
      fixture.pin.sourceDigest,
      await modelSourceDigest(fixture.revision.sources),
    );
    const good = await projectAuthorityMatrixWorker({
      revision: fixture.revision,
      pin: fixture.pin,
      projectId,
      name: "trust-proof",
    });
    assert.equal(good.version, fixture.pin.version);
    assert.equal(good.model.sourceDigest, fixture.pin.sourceDigest);
    assert.equal(good.schema, "ase.authority-matrix/1");
    assert.deepEqual(good.summary.coordinates, { checked: 78, mismatches: 0 });

    // A Toolkit bump must not make stored versions unreadable here: an artifact
    // from a newer engine of the same normalized format projects unchanged, and
    // reports the engine that compiled it.
    const newer = structuredClone(fixture.revision);
    newer.engineVersion = "0.11.0";
    assert.ok(newer.provider);
    newer.provider.version = "0.11.0";
    const fromNewerEngine = await projectAuthorityMatrixWorker({
      revision: newer,
      pin: fixture.pin,
      projectId,
      name: "trust-proof",
    });
    assert.equal(fromNewerEngine.model.toolkit, "0.11.0");
    assert.equal(good.model.toolkit, fixture.revision.engineVersion);
    assert.deepEqual(fromNewerEngine.rows, good.rows);
    assert.deepEqual(fromNewerEngine.cells, good.cells);

    const cases: {
      name: string;
      code: string;
      change(revision: ModelRevision): void | Promise<void>;
    }[] = [
      {
        name: "artifact source digest differs from independent pin",
        code: "MODEL_VERSION_MISMATCH",
        change: (revision) => {
          revision.sourceDigest = "0".repeat(64);
        },
      },
      {
        name:
          "source bytes changed while compiled elements and digests stay unchanged",
        code: "MODEL_VERSION_MISMATCH",
        change: (revision) => {
          revision.sources["configuration.sysml"] +=
            "\n// altered source bytes\n";
        },
      },
      {
        name:
          "source bytes and artifact digest changed together while independent pin stays fixed",
        code: "MODEL_VERSION_MISMATCH",
        async change(revision) {
          revision.sources["configuration.sysml"] +=
            "\n// coherently altered artifact digest\n";
          revision.sourceDigest = await modelSourceDigest(revision.sources);
          assert.notEqual(revision.sourceDigest, fixture.pin.sourceDigest);
        },
      },
      {
        name: "source file is missing",
        code: "MODEL_VERSION_MISMATCH",
        change: (revision) => {
          delete revision.sources["configuration.sysml"];
        },
      },
      {
        name: "engine older than the oldest qualified engine",
        code: "INVALID_PROJECTION_PROVIDER",
        change: (revision) => {
          revision.engineVersion = "0.0.1";
          assert.ok(revision.provider);
          revision.provider.version = "0.0.1";
        },
      },
      {
        name: "engineVersion and provider.version disagree",
        code: "INVALID_PROJECTION_PROVIDER",
        change: (revision) => {
          revision.engineVersion = "0.11.0";
        },
      },
      {
        name: "provider descriptor has a fake format",
        code: "INVALID_PROJECTION_PROVIDER",
        change: (revision) => {
          assert.ok(revision.provider);
          revision.provider.format = "fake-provider-format";
        },
      },
      {
        name: "provider descriptor has an unexpected field",
        code: "INVALID_PROJECTION_PROVIDER",
        change: (revision) => {
          assert.ok(revision.provider);
          Object.assign(revision.provider, { unexpected: true });
        },
      },
    ];
    for (const testCase of cases) {
      const revision = structuredClone(fixture.revision);
      await testCase.change(revision);
      await assert.rejects(
        projectAuthorityMatrixWorker({ revision, pin: fixture.pin, projectId }),
        rejectsCode(testCase.code),
        testCase.name,
      );
    }
  },
});

Deno.test({
  name:
    "coordinate disagreement is refused through the real reader service and HTTP without caching",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const fixture = await prepared();
    const revision = structuredClone(fixture.revision);
    corruptBuilderCoordinates(revision);
    assert.deepEqual(revision.sources, fixture.revision.sources);
    assert.equal(revision.sourceDigest, fixture.pin.sourceDigest);
    const service = new AuthorityMatrixService(
      new CompiledAuthorityMatrixReader(
        matrixArtifactRepository({ ...fixture, revision }),
        projectId,
      ),
    );
    const handler = createAuthorityMatrixHandler(
      service,
      () => Promise.resolve(fixture.pin.version),
    );
    const endpoint = "http://atelier.test/api/model/authority-matrix";
    for (
      const url of [`${endpoint}?version=${fixture.pin.version}`, endpoint]
    ) {
      const response = await handler(new Request(url));
      assert.ok(response);
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("etag"), null);
      const failure = await response.json();
      assert.deepEqual(Object.keys(failure).sort(), [
        "code",
        "context",
        "recovery",
      ]);
      assert.equal(failure.code, "SOURCE_COORDINATE_MISMATCH");
      assert.equal(failure.context.version, fixture.pin.version);
      assert.equal(typeof failure.recovery, "string");
      assert.ok(failure.recovery.length > 0);
    }
    // Every incoherent artifact is a server fault: never a 200, never cached,
    // never a client error, even for the explicit immutable version.
    for (
      const [code, change] of [
        ["INVALID_PROJECTION_PROVIDER", (r: ModelRevision) => {
          r.engineVersion = "0.0.1";
        }],
        ["MODEL_VERSION_MISMATCH", (r: ModelRevision) => {
          r.sources["configuration.sysml"] += "\n// altered\n";
        }],
      ] as const
    ) {
      const altered = structuredClone(fixture.revision);
      change(altered);
      const handler = createAuthorityMatrixHandler(
        new AuthorityMatrixService(
          new CompiledAuthorityMatrixReader(
            matrixArtifactRepository({ ...fixture, revision: altered }),
            projectId,
          ),
        ),
        () => Promise.resolve(fixture.pin.version),
      );
      const response = await handler(
        new Request(`${endpoint}?version=${fixture.pin.version}`),
      );
      assert.ok(response);
      assert.equal(response.status, 500, code);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("etag"), null);
      assert.equal((await response.json()).code, code);
    }
  },
});

Deno.test({
  name:
    "Git source pin is read independently of returned compiled artifact and its metadata",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const fixture = await prepared();
    const projectDir = await Deno.makeTempDir({
      prefix: "ase-matrix-source-pin-",
    });
    let compileCalls = 0;
    try {
      const { version: _fixtureVersion, ...compiled } = fixture.revision;
      const repository = await GitModelRepository.open({
        projectDir,
        repositoryId: projectId.slice("git:".length),
        compiler: {
          compile(sources) {
            compileCalls++;
            assert.deepEqual(sources, fixture.revision.sources);
            // Reuse the setup artifact; this temporary repository never invokes Toolkit.
            return Promise.resolve(structuredClone(compiled));
          },
          recipe() {
            throw new Error(
              "Source-pin proof must not request a compilation recipe",
            );
          },
        },
      });
      const admitted = await repository.initialize(fixture.revision.sources);
      assert.equal(compileCalls, 1);
      assert.notEqual(
        admitted.version,
        fixture.pin.version,
        "use the actual temporary Git commit",
      );
      const expected = {
        version: admitted.version,
        sourceDigest: await modelSourceDigest(fixture.revision.sources),
      };
      assert.deepEqual(await repository.header(admitted.version), {
        ...expected,
        sources: fixture.revision.sources,
      });
      const returned = await repository.at(admitted.version);
      returned.sourceDigest = "f".repeat(64);
      returned.provenanceDigest = "0".repeat(64);
      returned.engineVersion = "0.0.1";
      returned.sources["configuration.sysml"] +=
        "\n// mutation of returned object\n";
      corruptBuilderCoordinates(returned);
      assert.deepEqual(await repository.header(admitted.version), {
        ...expected,
        sources: fixture.revision.sources,
      });
      const pristine = await repository.at(admitted.version);
      assert.equal(pristine.sourceDigest, expected.sourceDigest);
      assert.deepEqual(pristine.sources, fixture.revision.sources);
      assert.equal(compileCalls, 1);

      const readArtifact = repository.at;
      repository.at = () =>
        Promise.reject(
          new Error("Artifact reader must not supply the source pin"),
        );
      try {
        assert.deepEqual(await repository.header(admitted.version), {
          ...expected,
          sources: fixture.revision.sources,
        });
      } finally {
        repository.at = readArtifact;
      }
      await assert.rejects(
        repository.header(`commit:${"f".repeat(40)}`),
        (error) =>
          error instanceof ModelRepositoryError && error.code === "NOT_FOUND",
      );
    } finally {
      await Deno.remove(projectDir, { recursive: true });
    }
  },
});
