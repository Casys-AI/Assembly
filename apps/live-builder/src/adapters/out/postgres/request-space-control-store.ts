import { PostgresRequestSourceAdmissionStore } from "./request-source-admission-store.ts";
import { decodeRequestSpaceOpening } from "./request-space-store.ts";
import { requestExecutionPinFor } from "../../../application/model/evolution/request-execution-pin.ts";
import { PostgresPrimarySpaceControlSource } from "./primary-space-control-source.ts";
import { projectSpaceControlAuthority } from "../../../domain/work/space-control-source.ts";
import type {
  SpaceAdmissionStorePort,
  SpaceControlCredential,
  SpaceCredentialStorePort,
} from "../../../application/work/request-spaces/control-ports.ts";
import {
  requestSpaceDigest,
  RequestSpaceError,
  type RequestSpaceScope,
  type SpaceControlAdoptedState,
  type SpaceControlAuthority,
  type SpaceController,
  type SpaceControlSourceBinding,
  type SpaceExecutionAdmission,
} from "../../../domain/work/request-spaces.ts";
import {
  effectiveSpaceControlAuthority,
  sameEffectiveSpaceControlAuthority,
  spaceControlAuthorityMatchesBinding,
} from "../../../domain/work/request-space-authority.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";
import { assertPostgresSystemScope } from "./scope.ts";

type CredentialRow =
  & Omit<SpaceControlCredential, "authority" | "createdAt" | "expiresAt">
  & {
    projectId: string;
    systemId: string;
    authorityJson: string;
    createdAt: Date;
    expiresAt: Date;
  };
type AdmissionRow =
  & Omit<
    SpaceExecutionAdmission,
    "scope" | "authority" | "permissions" | "createdAt" | "expiresAt"
  >
  & {
    projectId: string;
    systemId: string;
    authorityJson: string;
    permissionsJson: string;
    createdAt: Date;
    expiresAt: Date;
  };
function credential(row: CredentialRow): SpaceControlCredential {
  return {
    id: row.id,
    kind: row.kind,
    ownerId: row.ownerId,
    parentCapabilityId: row.parentCapabilityId,
    authority: JSON.parse(row.authorityJson),
    secretHash: row.secretHash,
    revision: row.revision,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
export function decodeSpaceExecutionAdmission(
  row: Omit<AdmissionRow, "status"> & { status: string },
): SpaceExecutionAdmission {
  if (row.status !== "active" && row.status !== "revoked") {
    throw new RequestSpaceError(
      "UNAVAILABLE",
      "The execution admission status is invalid.",
    );
  }
  return {
    id: row.id,
    scope: { projectId: row.projectId, systemId: row.systemId },
    executionSpaceId: row.executionSpaceId,
    openingId: row.openingId,
    ownerId: row.ownerId,
    capabilityId: row.capabilityId,
    capabilityRevision: row.capabilityRevision,
    baseDigest: row.baseDigest,
    authority: JSON.parse(row.authorityJson),
    permissions: JSON.parse(row.permissionsJson),
    revision: row.revision,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}
const refused = () =>
  new RequestSpaceError(
    "ADMISSION_REFUSED",
    "The current space control or execution admission is unavailable.",
  );

export class PostgresSpaceCredentials implements SpaceCredentialStorePort {
  private readonly scope: RequestSpaceScope;
  private readonly binding: SpaceControlSourceBinding;
  constructor(
    private readonly client: PrismaClient,
    private readonly primaryControl: PostgresPrimarySpaceControlSource,
  ) {
    primaryControl.assertClient(client);
    const binding = primaryControl.binding;
    assertPostgresSystemScope(binding.scope);
    this.scope = Object.freeze({ ...binding.scope });
    this.binding = Object.freeze({
      scope: this.scope,
      sourceSystemNativeId: binding.sourceSystemNativeId,
    });
  }
  private table() {
    return postgresQualifiedTable(this.client, "SpaceControlCredential");
  }
  insert(
    row: SpaceControlCredential & { kind: "capability" },
    witness: SpaceControlAdoptedState,
  ): Promise<void>;
  insert(row: SpaceControlCredential & { kind: "session" }): Promise<void>;
  async insert(
    row: SpaceControlCredential,
    witness?: SpaceControlAdoptedState,
  ): Promise<void> {
    if (
      row.revision !== 0 || row.status !== "active" ||
      !/^[a-f0-9]{64}$/.test(row.secretHash) ||
      !Number.isFinite(Date.parse(row.expiresAt)) ||
      row.authority.owner.operatorId !== row.ownerId ||
      !spaceControlAuthorityMatchesBinding(row.authority, this.binding)
    ) throw refused();
    await this.client.$transaction(async (tx) => {
      // Fence even delayed capability issuance against the canonical invalidation
      // transaction. Source evidence may advance only with unchanged policy.
      const adopted = await this.primaryControl.readLocked(tx);
      const current = projectSpaceControlAuthority(
        adopted.source,
        this.binding,
        row.ownerId,
      );
      if (!sameEffectiveSpaceControlAuthority(current, row.authority)) {
        throw refused();
      }
      // Pending issuance is bound to the exact captured PRIMARY revision, even
      // when an intervening save preserved effective authority or restored P.
      if (
        row.kind === "capability" &&
        (!witness || canonical(witness) !== canonical(adopted.adoptedState) ||
          row.authority.sourceVersion !== current.sourceVersion ||
          row.authority.modelDigest !== current.modelDigest ||
          canonical(row.authority.owner.sourceIds) !==
            canonical(current.owner.sourceIds))
      ) throw refused();
      if (row.kind === "session") {
        const parents = await tx.$queryRaw<CredentialRow[]>(
          Prisma
            .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${row.parentCapabilityId} AND "ownerId"=${row.ownerId} AND "kind"='capability' AND "status"='active' AND "expiresAt">clock_timestamp() FOR SHARE`,
        );
        if (
          !parents[0] ||
          parents[0].authorityJson !== canonical(row.authority) ||
          parents[0].expiresAt.getTime() < Date.parse(row.expiresAt)
        ) throw refused();
      } else if (row.kind !== "capability" || row.parentCapabilityId !== null) {
        throw refused();
      }
      await tx.$executeRaw(
        Prisma
          .sql`INSERT INTO ${this.table()} ("id","projectId","systemId","kind","ownerId","parentCapabilityId","parentKind","authorityJson","secretHash","expiresAt","createdAt") VALUES (${row.id},${this.scope.projectId},${this.scope.systemId},${row.kind},${row.ownerId},${row.parentCapabilityId},${
          row.kind === "session" ? "capability" : null
        },${canonical(row.authority)},${row.secretHash},${new Date(
          row.expiresAt,
        )},${new Date(row.createdAt)})`,
      );
    });
  }
  /** Authenticate the captured controller under PRIMARY -> capability -> session
   * locks. This is channel identity, not permission for a source or runtime act.
   * The caller owns tx and must independently check its concrete modeled grant. */
  async assertCurrentController(
    tx: Prisma.TransactionClient,
    controller: SpaceController,
    expectedSessionRevision?: number,
  ) {
    const adopted = await this.primaryControl.readLocked(tx);
    const current = projectSpaceControlAuthority(
      adopted.source,
      this.binding,
      controller.ownerId,
    );
    if (
      !sameEffectiveSpaceControlAuthority(current, controller.authority)
    ) throw refused();
    const capabilities = await tx.$queryRaw<CredentialRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${controller.capabilityId} AND "ownerId"=${controller.ownerId} AND "kind"='capability' AND "status"='active' AND "expiresAt">clock_timestamp() FOR SHARE`,
    );
    const capability = capabilities[0];
    if (
      !capability || capability.parentCapabilityId !== null ||
      capability.revision !== controller.capabilityRevision ||
      capability.authorityJson !== canonical(controller.authority)
    ) throw refused();
    const sessions = await tx.$queryRaw<CredentialRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${controller.sessionId} AND "ownerId"=${controller.ownerId} AND "kind"='session' AND "status"='active' AND "expiresAt">clock_timestamp() FOR SHARE`,
    );
    const session = sessions[0];
    const [clock] = await tx.$queryRaw<Array<{ authorizedAt: Date }>>(
      Prisma.sql`SELECT clock_timestamp() AS "authorizedAt"`,
    );
    if (
      !session || session.parentCapabilityId !== capability.id ||
      session.authorityJson !== capability.authorityJson ||
      (expectedSessionRevision !== undefined &&
        session.revision !== expectedSessionRevision) ||
      !clock || capability.expiresAt <= clock.authorizedAt ||
      session.expiresAt <= clock.authorizedAt
    ) throw refused();
    return {
      authority: current,
      adoptedState: adopted.adoptedState,
      sessionRevision: session.revision,
      authorizedAt: clock.authorizedAt.toISOString(),
    };
  }
  /** Retention still needs its explicit act in addition to current identity. */
  async assertRetainRelease(
    tx: Prisma.TransactionClient,
    controller: SpaceController,
  ) {
    const current = await this.assertCurrentController(tx, controller);
    if (!current.authority.acts.includes("retain-release")) throw refused();
    return current;
  }
  /** Called after all potentially waiting source/scope locks. Row locks prevent
   * revocation, but clock expiry also has to cover the complete native window. */
  async assertRetainReleaseForNative(
    tx: Prisma.TransactionClient,
    controller: SpaceController,
    minimumLifetimeMs: number,
  ): Promise<void> {
    await this.assertRetainRelease(tx, controller);
    if (!Number.isSafeInteger(minimumLifetimeMs) || minimumLifetimeMs <= 0) {
      throw refused();
    }
    const started = performance.now();
    const [window] = await tx.$queryRaw<
      Array<{ count: number; remainingMs: number | null }>
    >(
      Prisma.sql`SELECT COUNT(*)::integer AS "count",
        EXTRACT(EPOCH FROM (MIN("expiresAt") - clock_timestamp()))::double precision * 1000 AS "remainingMs"
        FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId}
          AND "ownerId"=${controller.ownerId} AND "status"='active'
          AND "id" IN (${controller.capabilityId}, ${controller.sessionId})`,
    );
    // Subtract the entire read round trip. The database's clock sample happened
    // within it, so this is conservative even when delivery/scheduling is slow.
    const elapsed = performance.now() - started;
    if (
      !window || window.count !== 2 || window.remainingMs === null ||
      !Number.isFinite(window.remainingMs) ||
      window.remainingMs - elapsed < minimumLifetimeMs
    ) throw refused();
  }
  async findHash(hash: string): Promise<SpaceControlCredential | null> {
    const rows = await this.client.$queryRaw<CredentialRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "secretHash"=${hash}`,
    );
    return rows[0] ? credential(rows[0]) : null;
  }
  async get(id: string): Promise<SpaceControlCredential | null> {
    const rows = await this.client.$queryRaw<CredentialRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${id}`,
    );
    return rows[0] ? credential(rows[0]) : null;
  }
  async revokeCapability(
    id: string,
    ownerId: string,
    expectedRevision: number,
  ): Promise<SpaceControlCredential> {
    return await this.client.$transaction(async (tx) => {
      // Shared order with effect start: capability FIRST, then admission(s).
      const rows = await tx.$queryRaw<CredentialRow[]>(
        Prisma
          .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${id} AND "ownerId"=${ownerId} AND "kind"='capability' FOR UPDATE`,
      );
      const row = rows[0];
      if (!row) throw refused();
      if (row.status === "revoked") return credential(row);
      if (row.revision !== expectedRevision) throw refused();
      const admissions = postgresQualifiedTable(
        this.client,
        "SpaceExecutionAdmission",
      );
      await tx.$queryRaw(
        Prisma
          .sql`SELECT "id" FROM ${admissions} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "capabilityId"=${id} ORDER BY "id" FOR UPDATE`,
      );
      await tx.$executeRaw(
        Prisma
          .sql`UPDATE ${admissions} SET "status"='revoked',"revision"="revision"+1 WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "capabilityId"=${id} AND "status"='active'`,
      );
      const updated = await tx.$queryRaw<CredentialRow[]>(
        Prisma
          .sql`UPDATE ${this.table()} SET "status"='revoked',"revision"="revision"+1 WHERE "id"=${id} AND "revision"=${expectedRevision} RETURNING *`,
      );
      if (!updated[0]) throw refused();
      return credential(updated[0]);
    });
  }
}

export interface SpaceEffectStartCheck {
  admissionId: string;
  expectedRevision: number;
  openingId: string;
  executionSpaceId: string;
  operatorId: string;
  modelDigest: string;
  sourceVersion: string;
  baseDigest: string;
  act: "conversation";
  expectedResourceIds?: string[];
  retainedTool?:
    import("../../../domain/work/retained-tool-dependencies.ts").RetainedToolInvocationTarget;
}
/** Exact adopted source and verified revisions, persisted atomically on started. */
export interface SpaceEffectStartProof {
  scope: RequestSpaceScope;
  openingId: string;
  executionSpaceId: string;
  baseDigest: string;
  capabilityId: string;
  capabilityRevision: number;
  admissionId: string;
  admissionRevision: number;
  currentAuthority: SpaceControlAuthority;
  adoptedState: Awaited<
    ReturnType<PostgresPrimarySpaceControlSource["readLocked"]>
  >["adoptedState"];
  effectiveAuthorityDigest: string;
  retainedTool?:
    import("../../../domain/work/retained-tool-dependencies.ts").RetainedToolInvocationTarget;
}
/** Narrow SQL guard for the same-transaction Effect.started hook.
 * No transaction is opened here; passing a PrismaClient instead of the ledger
 * transaction would not satisfy the required integration contract. */
export class PostgresSpaceAdmissions implements SpaceAdmissionStorePort {
  private readonly scope: RequestSpaceScope;
  private readonly binding: SpaceControlSourceBinding;
  constructor(
    private readonly client: PrismaClient,
    private readonly primaryControl: PostgresPrimarySpaceControlSource,
  ) {
    primaryControl.assertClient(client);
    const binding = primaryControl.binding;
    assertPostgresSystemScope(binding.scope);
    this.scope = Object.freeze({ ...binding.scope });
    this.binding = Object.freeze({
      scope: this.scope,
      sourceSystemNativeId: binding.sourceSystemNativeId,
    });
  }
  private table() {
    return postgresQualifiedTable(this.client, "SpaceExecutionAdmission");
  }
  private credentials() {
    return postgresQualifiedTable(this.client, "SpaceControlCredential");
  }
  async admit(
    input: Parameters<SpaceAdmissionStorePort["admit"]>[0],
  ): Promise<SpaceExecutionAdmission> {
    if (
      canonical(input.scope) !== canonical(this.scope) ||
      input.authority.owner.operatorId !== input.ownerId ||
      !spaceControlAuthorityMatchesBinding(input.authority, this.binding)
    ) throw refused();
    return await this.client.$transaction(async (tx) => {
      const roots = await tx.$queryRaw<CredentialRow[]>(
        Prisma
          .sql`SELECT * FROM ${this.credentials()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${input.capabilityId} AND "ownerId"=${input.ownerId} AND "kind"='capability' AND "status"='active' AND "expiresAt">clock_timestamp() FOR SHARE`,
      );
      if (
        !roots[0] || roots[0].revision !== input.capabilityRevision ||
        !sameEffectiveSpaceControlAuthority(
          credential(roots[0]).authority,
          input.authority,
        )
      ) throw refused();
      const opening = await tx.$queryRaw<
        Array<{ baseDigest: string; phase: string }>
      >(Prisma.sql`SELECT "baseDigest","phase" FROM ${
        postgresQualifiedTable(this.client, "SpaceOpening")
      } WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${input.openingId} AND "ownerId"=${input.ownerId} AND "executionSpaceId"=${input.executionSpaceId} FOR UPDATE`);
      if (
        !opening[0] || opening[0].baseDigest !== input.baseDigest ||
        !["runtime-ready", "admitted", "dispatched"].includes(opening[0].phase)
      ) throw refused();
      const existing = await tx.$queryRaw<AdmissionRow[]>(
        Prisma
          .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "openingId"=${input.openingId} FOR UPDATE`,
      );
      if (existing[0]) {
        const found = decodeSpaceExecutionAdmission(existing[0]);
        if (
          input.permissions.resourceIds.length > 0 && found.id !== input.id ||
          found.ownerId !== input.ownerId ||
          found.capabilityId !== input.capabilityId ||
          found.capabilityRevision !== input.capabilityRevision ||
          found.baseDigest !== input.baseDigest ||
          !sameEffectiveSpaceControlAuthority(
            found.authority,
            input.authority,
          ) || canonical(found.permissions) !== canonical(input.permissions)
        ) throw refused();
        return found;
      }
      const rows = await tx.$queryRaw<AdmissionRow[]>(
        Prisma
          .sql`INSERT INTO ${this.table()} ("id","projectId","systemId","executionSpaceId","openingId","ownerId","capabilityId","capabilityRevision","baseDigest","authorityJson","permissionsJson","expiresAt") VALUES (${input.id},${this.scope.projectId},${this.scope.systemId},${input.executionSpaceId},${input.openingId},${input.ownerId},${input.capabilityId},${input.capabilityRevision},${input.baseDigest},${
          canonical(input.authority)
        },${canonical(input.permissions)},${new Date(
          input.expiresAt,
        )}) RETURNING *`,
      );
      return decodeSpaceExecutionAdmission(rows[0]);
    });
  }
  async get(id: string): Promise<SpaceExecutionAdmission | null> {
    const rows = await this.client.$queryRaw<AdmissionRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${id}`,
    );
    return rows[0] ? decodeSpaceExecutionAdmission(rows[0]) : null;
  }
  async revoke(
    id: string,
    controller: SpaceController,
  ): Promise<SpaceExecutionAdmission> {
    return await this.client.$transaction(async (tx) => {
      const roots = await tx.$queryRaw<CredentialRow[]>(
        Prisma
          .sql`SELECT * FROM ${this.credentials()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${controller.capabilityId} AND "ownerId"=${controller.ownerId} AND "kind"='capability' AND "status"='active' AND "expiresAt">clock_timestamp() FOR SHARE`,
      );
      if (
        !roots[0] || roots[0].revision !== controller.capabilityRevision ||
        roots[0].authorityJson !== canonical(controller.authority)
      ) throw refused();
      const rows = await tx.$queryRaw<AdmissionRow[]>(
        Prisma
          .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${id} AND "ownerId"=${controller.ownerId} AND "capabilityId"=${controller.capabilityId} FOR UPDATE`,
      );
      if (!rows[0]) throw refused();
      if (rows[0].status === "revoked") {
        return decodeSpaceExecutionAdmission(rows[0]);
      }
      const updated = await tx.$queryRaw<AdmissionRow[]>(
        Prisma
          .sql`UPDATE ${this.table()} SET "status"='revoked',"revision"="revision"+1 WHERE "id"=${id} AND "revision"=${
          rows[0].revision
        } RETURNING *`,
      );
      if (!updated[0]) throw refused();
      return decodeSpaceExecutionAdmission(updated[0]);
    });
  }
  async assertEffectStart(
    tx: Prisma.TransactionClient,
    input: SpaceEffectStartCheck,
  ): Promise<SpaceEffectStartProof> {
    // Prisma 7.10 retains $transaction on its nested transaction proxy. The
    // real TransactionClient removes connection-lifetime methods instead; test
    // callable API availability rather than the proxy's property membership.
    if (
      typeof Reflect.get(tx, "$connect") === "function" ||
      typeof Reflect.get(tx, "$disconnect") === "function"
    ) {
      throw new RequestSpaceError(
        "ADMISSION_REFUSED",
        "Effect start requires the caller-owned ledger transaction.",
      );
    }
    const adopted = await this.primaryControl.readLocked(tx);
    // Lookup only discovers the root lock key; all content is reread under locks.
    const before = await tx.$queryRaw<Array<{ capabilityId: string }>>(
      Prisma
        .sql`SELECT "capabilityId" FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${input.admissionId}`,
    );
    if (!before[0]) throw refused();
    const roots = await tx.$queryRaw<CredentialRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.credentials()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${
        before[0].capabilityId
      } AND "kind"='capability' FOR SHARE`,
    );
    const rows = await tx.$queryRaw<AdmissionRow[]>(
      Prisma
        .sql`SELECT * FROM ${this.table()} WHERE "projectId"=${this.scope.projectId} AND "systemId"=${this.scope.systemId} AND "id"=${input.admissionId} AND "expiresAt">clock_timestamp() FOR UPDATE`,
    );
    if (!roots[0] || !rows[0]) throw refused();
    const root = credential(roots[0]),
      current = decodeSpaceExecutionAdmission(rows[0]);
    const currentAuthority = projectSpaceControlAuthority(
      adopted.source,
      this.binding,
      current.ownerId,
    );
    const operatorIndex = current.permissions.operatorIds.indexOf(
      input.operatorId,
    );
    let sourceVersion = current.permissions.sourceVersion;
    if (operatorIndex > 0) {
      const row = await tx.spaceOpening.findFirst({
        where: { ...this.scope, id: current.openingId },
      });
      if (!row) throw refused();
      const opening = decodeRequestSpaceOpening(row);
      const chain = await new PostgresRequestSourceAdmissionStore(this.client)
        .readAdmittedSource(tx, opening);
      const pin = requestExecutionPinFor(
        opening.base!.requestOwner.operatorId,
        chain.execution,
        input.operatorId,
      );
      if (pin.modelDigest !== current.permissions.modelDigests[operatorIndex]) {
        throw refused();
      }
      sourceVersion = pin.source.version;
    }

    if (
      root.status !== "active" || root.ownerId !== current.ownerId ||
      root.revision !== current.capabilityRevision ||
      current.status !== "active" ||
      current.revision !== input.expectedRevision ||
      current.openingId !== input.openingId ||
      current.executionSpaceId !== input.executionSpaceId ||
      current.baseDigest !== input.baseDigest ||
      current.authority.owner.operatorId !== current.ownerId ||
      !spaceControlAuthorityMatchesBinding(currentAuthority, this.binding) ||
      !sameEffectiveSpaceControlAuthority(
        current.authority,
        currentAuthority,
      ) ||
      !sameEffectiveSpaceControlAuthority(root.authority, current.authority) ||
      input.act !== "conversation" ||
      current.permissions.acts.length !== 1 ||
      current.permissions.acts[0] !== input.act ||
      !Array.isArray(current.permissions.resourceIds) ||
      current.permissions.resourceIds.length > 256 ||
      current.permissions.resourceIds.some((id) =>
        typeof id !== "string" || !/^retained-tool:v1:[a-f0-9]{64}$/.test(id)
      ) ||
      new Set(current.permissions.resourceIds).size !==
        current.permissions.resourceIds.length ||
      input.expectedResourceIds !== undefined &&
        canonical(current.permissions.resourceIds) !==
          canonical(input.expectedResourceIds) ||
      input.retainedTool !== undefined &&
        !current.permissions.resourceIds.includes(
          input.retainedTool.resourceId,
        ) ||
      !current.permissions.operatorIds.includes(input.operatorId) ||
      current.permissions.modelDigests[operatorIndex] !== input.modelDigest ||
      sourceVersion !== input.sourceVersion
    ) throw refused();
    // Root capability expiration governs new control sessions/commands; only
    // explicit revocation/revision and this admission's expiry govern old work.
    // No session table lookup occurs on the autonomous execution path.
    // The returned witness records CURRENT source evidence, without overwriting
    // the immutable issuance/admission evidence or rebinding the Case base.
    return {
      scope: { ...this.scope },
      openingId: current.openingId,
      executionSpaceId: current.executionSpaceId,
      baseDigest: current.baseDigest,
      capabilityId: root.id,
      capabilityRevision: root.revision,
      admissionId: current.id,
      admissionRevision: current.revision,
      currentAuthority,
      adoptedState: adopted.adoptedState,
      effectiveAuthorityDigest: await requestSpaceDigest(
        effectiveSpaceControlAuthority(currentAuthority),
      ),
      ...(input.retainedTool ? { retainedTool: input.retainedTool } : {}),
    };
  }
}
