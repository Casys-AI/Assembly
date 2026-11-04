import assert from "node:assert/strict";
import { projectAuthorityMatrix } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/projection.ts";
import { parseModelRevisionId } from "../../src/domain/shared-kernel/revision-id.ts";
import type {
  AuthorityMatrix,
  MatrixColumnId,
  MatrixRow,
} from "../../src/domain/governance/records/authority-matrix.ts";
import { authorityHostAnchors as hostAnchors } from "../support/host-anchors.ts";
import { modelSourceDigest } from "../../src/domain/model/value-objects/sources.ts";
import { CompiledAuthorityMatrixReader } from "../../src/adapters/out/sysml-toolkit/projections/authority-matrix/reader.ts";
import { AuthorityMatrixService } from "../../src/application/governance/authority-matrix.ts";
import { createAuthorityMatrixHandler } from "../../src/adapters/in/http/governance/authority-matrix.ts";
import {
  matrixArtifactRepository,
  prepareMatrixArtifact,
} from "../support/authority-matrix-artifact-fixtures.ts";
import { assertClosedAuthorityMatrix } from "../support/assert-closed-authority-matrix.ts";
import { toolkitIntegrationEnabled } from "../support/toolkit-integration.ts";

const version = parseModelRevisionId(`commit:${"a".repeat(40)}`);
const projectId = "git:11111111-1111-4111-8111-111111111111";

function verify(matrix: AuthorityMatrix): void {
  assertClosedAuthorityMatrix(matrix);
  assert.equal(matrix.version, version);
  assert.equal(matrix.schema, "ase.authority-matrix/1");
  assert.equal(matrix.caveats[0], "ADOPTED_VERSION_ONLY");
  assert.equal(matrix.summary.coordinates.mismatches, 0);
  assert.ok(matrix.summary.coordinates.checked > 0);
  assert.match(matrix.digest, /^[0-9a-f]{64}$/);
  const rows = new Set(matrix.rows.map((row) => row.id));
  const columns = new Set(matrix.columns.map((column) => column.id));
  const pairs = new Set<string>();
  for (const cell of matrix.cells) {
    assert.ok(rows.has(cell.row), `known row ${cell.row}`);
    assert.ok(columns.has(cell.column), `known column ${cell.column}`);
    const pair = JSON.stringify([cell.row, cell.column]);
    assert.equal(pairs.has(pair), false, `unique row/column cell ${pair}`);
    pairs.add(pair);
    if (cell.via?.kind === "host-rule") {
      assert.ok(Object.hasOwn(hostAnchors, cell.via.enforcedAt));
      assert.notEqual(hostAnchors[cell.via.enforcedAt], undefined);
    }
  }
  assert.equal(
    Object.values(matrix.summary.byState).reduce((a, b) => a + b, 0),
    matrix.cells.length,
  );
}

function cell(matrix: AuthorityMatrix, row: MatrixRow, column: MatrixColumnId) {
  const found = matrix.cells.find((candidate) =>
    candidate.row === row.id && candidate.column === column
  );
  assert.ok(found, `${row.role} ${row.unit}: ${column}`);
  return found;
}

Deno.test("host enforcement anchors exhaust the matrix contract and point to real checks", async () => {
  assert.deepEqual(
    Object.keys(hostAnchors).sort(),
    [
      "humanAdmission",
      "humanApprovesChange",
      "localOwnerModel",
      "ownerRevisions",
    ].sort(),
  );
  assert.ok(
    Object.values(hostAnchors).every((anchor) => typeof anchor === "function"),
  );
  const [
    { decideCandidate },
    { SystemGovernance },
    { NativeModelSourceAuthorization },
    { createModelRevisionHandler },
  ] = await Promise.all([
    import("../../src/application/work/candidates/decisions.ts"),
    import("../../src/domain/governance/policies/governance.ts"),
    import(
      "../../src/application/governance/model-access/source-authorization.ts"
    ),
    import("../../src/adapters/in/http/model/revisions.ts"),
  ]);
  assert.strictEqual(hostAnchors.humanAdmission, decideCandidate);
  assert.strictEqual(
    hostAnchors.humanApprovesChange,
    SystemGovernance.prototype.decideChange,
  );
  assert.strictEqual(
    hostAnchors.localOwnerModel,
    NativeModelSourceAuthorization.prototype.validate,
  );
  assert.strictEqual(hostAnchors.ownerRevisions, createModelRevisionHandler);
});

Deno.test({
  name:
    "compiled artifact initial matrix declares the owner, verifies coordinates and has a stable digest",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const prepared = await prepareMatrixArtifact("initial", {
      packageDir,
      projectId,
      version,
    });
    const { revision, units } = prepared;
    const { sources } = revision;
    let repositoryReads = 0;
    let pinReads = 0;
    const repository = matrixArtifactRepository(prepared);
    const service = new AuthorityMatrixService(
      new CompiledAuthorityMatrixReader({
        at(requested) {
          repositoryReads++;
          assert.equal(requested, version);
          return repository.at(requested);
        },
        header(requested) {
          pinReads++;
          return repository.header(requested);
        },
      }, projectId),
    );
    const handler = createAuthorityMatrixHandler(
      service,
      () => Promise.resolve(version),
    );
    const endpoint = "http://atelier.test/api/model/authority-matrix";
    const invalid = await handler(
      new Request(`${endpoint}?version=not-a-commit`),
    );
    assert.equal(invalid?.status, 400);
    assert.equal(repositoryReads, 0);
    assert.equal(pinReads, 0);
    const response = await handler(
      new Request(`${endpoint}?version=${version}`),
    );
    assert.equal(response?.status, 200);
    const etag = response?.headers.get("etag");
    assert.ok(etag, "real matrix response supplies an ETag");
    const first: AuthorityMatrix = await response!.json();
    const unchanged = await handler(
      new Request(`${endpoint}?version=${version}`, {
        headers: { "if-none-match": etag },
      }),
    );
    assert.equal(unchanged?.status, 304);
    assert.equal(unchanged?.headers.get("etag"), etag);
    assert.equal(await unchanged?.text(), "");
    const head = await handler(new Request(endpoint));
    assert.equal(head?.status, 200);
    assert.equal(head?.headers.get("cache-control"), "no-store");
    assert.equal(head?.headers.get("x-model-version"), version);
    assert.deepEqual(await head?.json(), first);
    assert.equal(
      repositoryReads,
      1,
      "version, ETag and head requests share one artifact-derived projection",
    );
    assert.equal(pinReads, 1);
    verify(first);
    assert.equal(first.model.authoritySchema, "owner-modeled");
    assert.equal(first.model.sourceDigest, await modelSourceDigest(sources));
    const owner = first.rows.find((row) => row.role === "owner");
    assert.ok(owner?.declared);
    assert.equal(
      owner.element?.qname,
      "AssemblyLiveBuilder::liveBuilder::owner",
    );
    assert.equal(first.rows.filter((row) => row.role === "builder").length, 1);
    assert.equal(cell(first, owner, "candidate.admit").state, "allowed");
    assert.ok(
      first.diagnostics.some((diagnostic) =>
        diagnostic.code === "MEMORY_REVIEW_UNREACHABLE"
      ),
    );
    assert.ok(
      first.diagnostics.some((diagnostic) =>
        diagnostic.code === "REVISION_FLAG_WITHOUT_EDIT_POLICY"
      ),
    );
    assert.equal(
      first.diagnostics.some((diagnostic) =>
        diagnostic.code === "OWNER_IMPLICIT"
      ),
      false,
    );
    const reversed = {
      ...revision,
      sources: Object.fromEntries(Object.entries(sources).reverse()),
    };
    const second = await projectAuthorityMatrix({
      name: projectId,
      revision: reversed,
      units,
    });
    assert.deepEqual(
      second,
      first,
      "source-map insertion order changes no transport field or digest",
    );
    const direct = await projectAuthorityMatrix({
      name: projectId,
      revision,
      units,
    });
    assert.deepEqual(
      direct,
      first,
      "HTTP transports the exact artifact-derived projector output",
    );
  },
});

Deno.test({
  name:
    "compiled artifact reviewer fixture separates builder editing from reviewer admission and exposures",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const prepared = await prepareMatrixArtifact("fixture-reviewer-policies", {
      packageDir,
      projectId,
      version,
    });
    const matrix = await projectAuthorityMatrix({
      name: "fixture-reviewer-policies",
      revision: prepared.revision,
      units: prepared.units,
    });
    verify(matrix);
    const builder = matrix.rows.find((row) => row.role === "builder")!;
    const reviewer = matrix.rows.find((row) => row.role === "reviewer")!;
    assert.ok(builder && reviewer);
    assert.equal(
      builder.unit,
      reviewer.unit,
      "two distinct operators share this unit",
    );
    assert.notEqual(builder.id, reviewer.id);
    assert.equal(cell(matrix, builder, "candidate.review").state, "denied");
    assert.equal(cell(matrix, builder, "candidate.admit").state, "denied");
    assert.equal(cell(matrix, builder, "model.edit").state, "propose-only");
    assert.deepEqual(cell(matrix, builder, "model.edit").scope?.operations, [
      "set-value",
      "insert-member",
    ]);
    assert.equal(
      cell(matrix, builder, "model.administer").state,
      "propose-only",
    );
    assert.equal(cell(matrix, reviewer, "candidate.review").state, "allowed");
    assert.equal(cell(matrix, reviewer, "candidate.admit").state, "allowed");
    assert.equal(cell(matrix, reviewer, "model.edit").state, "denied");
    assert.equal(cell(matrix, reviewer, "model.administer").state, "denied");
    assert.equal(
      cell(matrix, reviewer, `behavior:skill-list@${reviewer.unit}`).state,
      "allowed",
    );
    const disabled = cell(
      matrix,
      builder,
      `behavior:memory-withdraw@${builder.unit}`,
    );
    assert.equal(disabled.state, "denied");
    assert.ok(disabled.codes.includes("EXPOSURE_DISABLED"));
  },
});

Deno.test({
  name:
    "compiled artifact delegation fixture preserves recipient scope and the source authority chain",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const packageDir = Deno.env.get("SYSML_TOOLKIT_DIR")!;
    const prepared = await prepareMatrixArtifact("fixture-delegation", {
      packageDir,
      projectId,
      version,
    });
    const matrix = await projectAuthorityMatrix({
      name: "fixture-delegation",
      revision: prepared.revision,
      units: prepared.units,
    });
    verify(matrix);
    const collector = matrix.rows.find((row) =>
      row.role === "builder" && row.unit === "ASECollect::collector"
    )!;
    assert.ok(collector);
    const delegated = cell(matrix, collector, "model.edit");
    assert.equal(delegated.state, "delegated");
    assert.equal(delegated.display, "propose-only");
    assert.deepEqual(delegated.scope?.operations, ["set-value"]);
    assert.deepEqual(delegated.scope?.grants, [{
      file: "mission.sysml",
      qualifiedRoots: ["CommercialWatchMission::sourcePolicy"],
    }]);
    assert.equal(delegated.via?.kind, "delegation");
    if (delegated.via?.kind !== "delegation") {
      throw new Error("missing delegation chain");
    }
    assert.equal(delegated.via.record, "delegation-collector-1");
    assert.deepEqual(
      delegated.via.chain.map(({ kind, id }) => ({ kind, id })),
      [{ kind: "root", id: "coordinator-administration" }, {
        kind: "delegation",
        id: "delegation-collector-1",
      }],
    );
    assert.match(delegated.via.chainDigest, /^[0-9a-f]{64}$/);
    assert.equal(cell(matrix, collector, "model.administer").state, "denied");
    assert.ok(
      matrix.delegations.some((record) =>
        record.id === "delegation-collector-1" && record.active
      ),
    );
  },
});
