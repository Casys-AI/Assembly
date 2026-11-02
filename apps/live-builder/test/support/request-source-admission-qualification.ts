/** Utilities for the dedicated PG + normal-Toolkit source-admission witness.
 * They are assertions and one schema-local fault, not an authority/composition substitute. */
import assert from "node:assert/strict";
import {
  postgresQualifiedTable,
  Prisma,
  type PrismaClient,
} from "../../src/adapters/out/postgres/client.ts";
import { postgresQualifiedTableIdentifier } from "../../src/adapters/out/postgres/client-schema.ts";
import type { ModelSources as Sources } from "../../src/domain/model/value-objects/sources.ts";
import type { OpeningRecord } from "../../src/domain/work/request-spaces.ts";
import type { RequestSourceAdmission } from "../../src/application/model/source-admission/request-source-admission.ts";
import type { GitRequestSourceProofReader } from "../../src/adapters/out/git/repository.ts";

/** Run only against the witness's owned temporary Git repository. This tests
 * the read-only verifier; temporary ref mutations are always restored. */
export async function assertRequestSourceGitAnchors(options: {
  projectDir: string;
  reader: Pick<GitRequestSourceProofReader, "verifyRequestSourceAdmission">;
  admission: RequestSourceAdmission;
  wrongVersion: string;
  requestRef: string;
  expectedRequestVersion: string;
  expectedMainVersion: string;
}): Promise<void> {
  const { admission, reader } = options;
  const version = admission.result.source.version;
  assert.match(version, /^commit:[a-f0-9]{40}$/);
  assert.match(options.wrongVersion, /^commit:[a-f0-9]{40}$/);
  assert.notEqual(options.wrongVersion, version);
  assert.match(options.requestRef, /^refs\/heads\/requests\/[a-f0-9-]+$/);
  const git = async (...args: string[]) => {
    const output = await new Deno.Command("git", {
      args: [`--git-dir=${options.projectDir}/.git`, ...args],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(output.success, new TextDecoder().decode(output.stderr));
    return new TextDecoder().decode(output.stdout).trim();
  };
  const heads = async () => {
    assert.equal(
      `commit:${await git("rev-parse", "--verify", options.requestRef)}`,
      options.expectedRequestVersion,
    );
    assert.equal(
      `commit:${await git("rev-parse", "--verify", "refs/heads/admitted")}`,
      options.expectedMainVersion,
    );
  };
  await heads();
  await reader.verifyRequestSourceAdmission(admission);
  for (
    const ref of [
      admission.publication.commandRef,
      admission.publication.publicationRef,
    ]
  ) {
    try {
      await git("update-ref", "-d", ref, version.slice(7));
      await assert.rejects(() =>
        reader.verifyRequestSourceAdmission(admission)
      );
      await git("update-ref", ref, options.wrongVersion.slice(7));
      await assert.rejects(() =>
        reader.verifyRequestSourceAdmission(admission)
      );
      await git("symbolic-ref", ref, options.requestRef);
      await assert.rejects(() =>
        reader.verifyRequestSourceAdmission(admission)
      );
    } finally {
      await git("update-ref", "--no-deref", ref, version.slice(7));
    }
  }
  await reader.verifyRequestSourceAdmission(admission);
  await heads();
}

const beforeInstruction =
  'attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests.";';
const afterInstruction =
  'attribute operatorInstruction : String = "Design and evolve this system with the person, and create operators to handle Requests. Request qualification witness.";';

/** Fail if the checked-in normal source changes; never edit any other source. */
export function normalInstructionChange(
  sources: Sources,
): { path: string; text: string } {
  const path = "configuration.sysml", text = sources[path];
  assert.equal(typeof text, "string");
  assert.equal(
    text.split(beforeInstruction).length,
    2,
    "expected exactly the normal selected operator instruction",
  );
  const changed = text.replace(beforeInstruction, afterInstruction);
  assert.notEqual(changed, text);
  return { path, text: changed };
}

/** Only the isolated fixture schema is affected. Install before publication,
 * then drop after observing rollback to allow the real participant to recover.
 * Never invoke against a demo/application DB. */
export async function failSourceAdmissionInTestSchema(
  client: PrismaClient,
): Promise<() => Promise<void>> {
  const qualified = postgresQualifiedTableIdentifier(client, "SpaceManifest");
  const current = await client.$queryRaw<Array<{ database: string }>>(
    Prisma.sql`SELECT current_database() AS "database"`,
  );
  if (
    current[0]?.database !== "assembly_pg1_test" ||
    !/^"pg1_[a-f0-9]{32}"\."SpaceManifest"$/.test(qualified)
  ) {
    throw new Error(
      "Source-admission fault requires the isolated PostgreSQL test schema",
    );
  }
  const table = postgresQualifiedTable(client, "SpaceManifest");
  const fn = postgresQualifiedTable(
    client,
    "qualification_fail_source_admission",
  );
  await client.$executeRaw(
    Prisma.sql`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'qualification injected source-admission rollback' USING ERRCODE = '40001'; END $$`,
  );
  try {
    await client.$executeRaw(
      Prisma.sql`CREATE TRIGGER "qualification_fail_source_admission"
      BEFORE INSERT ON ${table} FOR EACH ROW WHEN (NEW."kind" = 'source-admission') EXECUTE FUNCTION ${fn}()`,
    );
  } catch (error) {
    await client.$executeRaw(Prisma.sql`DROP FUNCTION ${fn}()`);
    throw error;
  }
  let removed = false;
  return async () => {
    if (removed) return;
    await client.$executeRaw(
      Prisma
        .sql`DROP TRIGGER IF EXISTS "qualification_fail_source_admission" ON ${table}`,
    );
    await client.$executeRaw(Prisma.sql`DROP FUNCTION IF EXISTS ${fn}()`);
    removed = true;
  };
}

/** Scoped SQL facts that admission must not change. Deliberately excludes the
 * admission chain and queue, whose expected changes are checked separately. */
export async function immutableRequestEvidence(
  client: PrismaClient,
  opening: OpeningRecord,
) {
  const where = {
    ...opening.scope,
    executionSpaceId: opening.executionSpaceId,
  };
  const operator = opening.base!.requestOwner.operatorId;
  const [space, runtime, admission, skills, memory, context] = await Promise
    .all([
      client.executionSpace.findUniqueOrThrow({
        where: { projectId_systemId_executionSpaceId: where },
      }),
      client.runtimeState.findMany({ where, orderBy: { operatorId: "asc" } }),
      client.spaceExecutionAdmission.findMany({
        where,
        orderBy: { id: "asc" },
      }),
      client.skillCatalog.findMany({
        where: { ...where, operatorId: operator },
        orderBy: { operatorId: "asc" },
      }),
      client.governedMemory.findMany({
        where: { ...where, operatorId: operator },
        orderBy: [{ ownerId: "asc" }, { id: "asc" }],
      }),
      client.contextSelection.findMany({
        where: { ...where, operatorId: operator },
        orderBy: { selectionId: "asc" },
      }),
    ]);
  return { space, runtime, admission, skills, memory, context };
}

/** Observe the actual ref/queue/chain after the one injected SQL failure. */
export function assertGitPendingAdmission(input: {
  initialVersion: string;
  initialManifestDigest: string;
  physicalVersion: string;
  commandAnchorVersion: string;
  admissionAnchorVersion: string;
  head: {
    revision: number;
    manifestDigest: string;
    source: { version: string };
  };
  queue: { state: string; publishedVersion: string | null };
  before: Awaited<ReturnType<typeof immutableRequestEvidence>>;
  after: Awaited<ReturnType<typeof immutableRequestEvidence>>;
}) {
  assert.notEqual(input.physicalVersion, input.initialVersion);
  assert.equal(input.commandAnchorVersion, input.physicalVersion);
  assert.equal(input.admissionAnchorVersion, input.physicalVersion);
  assert.equal(input.head.revision, 1);
  assert.equal(input.head.manifestDigest, input.initialManifestDigest);
  assert.equal(input.head.source.version, input.initialVersion);
  assert.equal(input.queue.state, "retryable");
  assert.equal(input.queue.publishedVersion, null);
  assert.deepEqual(
    input.after,
    input.before,
    "Git-only interruption cannot mutate runtime, execution admission or information state",
  );
}

/** Check the exact durable receipt and the three independent UI scope facts. */
export function assertSourceSettled(input: {
  commandId: string;
  initialVersion: string;
  resultVersion: string;
  chain: {
    head: { revision: number; source: { version: string } };
    receipts: readonly {
      payload: {
        command: { commandId: string };
        result: { source: { version: string } };
      };
    }[];
  };
  queue: { state: string; publishedVersion: string | null };
  defaultScope: {
    branchVersion: string;
    executionVersion: string;
    version: string;
  };
  explicitScope: {
    branchVersion: string;
    executionVersion: string;
    version: string;
  };
}) {
  assert.equal(input.chain.head.revision, 2);
  assert.equal(input.chain.head.source.version, input.resultVersion);
  assert.equal(input.chain.receipts.length, 1);
  assert.equal(
    input.chain.receipts[0].payload.command.commandId,
    input.commandId,
  );
  assert.equal(
    input.chain.receipts[0].payload.result.source.version,
    input.resultVersion,
  );
  assert.equal(input.queue.state, "published");
  assert.equal(input.queue.publishedVersion, input.resultVersion);
  assert.deepEqual(input.defaultScope, {
    branchVersion: input.resultVersion,
    executionVersion: input.initialVersion,
    version: input.initialVersion,
  });
  assert.deepEqual(input.explicitScope, {
    branchVersion: input.resultVersion,
    executionVersion: input.initialVersion,
    version: input.resultVersion,
  });
}

/** Test-only revocation of exactly one acceptance session; it leaves the
 * parent capability and the original execution admission untouched. */
export async function revokeCapturedSourceSession(
  client: PrismaClient,
  controller: {
    ownerId: string;
    capabilityId: string;
    sessionId: string;
  },
  scope: { projectId: string; systemId: string },
  revision: number,
) {
  const qualified = postgresQualifiedTableIdentifier(
    client,
    "SpaceControlCredential",
  );
  const current = await client.$queryRaw<Array<{ database: string }>>(
    Prisma.sql`SELECT current_database() AS "database"`,
  );
  if (
    current[0]?.database !== "assembly_pg1_test" ||
    !/^"pg1_[a-f0-9]{32}"\."SpaceControlCredential"$/.test(qualified)
  ) {
    throw new Error(
      "Session fixture requires the isolated PostgreSQL test schema",
    );
  }
  const updated = await client.spaceControlCredential.updateMany({
    where: {
      ...scope,
      id: controller.sessionId,
      ownerId: controller.ownerId,
      parentCapabilityId: controller.capabilityId,
      kind: "session",
      status: "active",
      revision,
    },
    data: { status: "revoked", revision: { increment: 1 } },
  });
  assert.equal(
    updated.count,
    1,
    "the exact captured acceptance session must be revoked",
  );
  const capability = await client.spaceControlCredential.findUniqueOrThrow({
    where: { id: controller.capabilityId },
  });
  assert.equal(
    capability.status,
    "active",
    "recovery fixture must not revoke the execution capability",
  );
}
