import type { CurrentSpaceControlSourcePort } from "../../../application/work/request-spaces/space-control-authority.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { SpaceControlSourceBinding } from "../../../domain/work/request-spaces.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import {
  spaceControlChanged,
  type SpaceControlSource,
  spaceControlSourceFromModel,
} from "../../../domain/work/space-control-source.ts";
import { decodePostgresRuntimeState } from "./runtime-state-snapshot.ts";
import {
  RUNTIME_SNAPSHOT_HEADER_CHARS,
  runtimeSnapshotHeader,
} from "./runtime-snapshot-codec.ts";
import {
  assertPostgresRuntimeScope,
  type PostgresRuntimeScope,
} from "./scope.ts";
import { postgresQualifiedTable, Prisma, type PrismaClient } from "./client.ts";

export interface PrimarySpaceControlBinding extends SpaceControlSourceBinding {
  primaryOperatorId: string;
}
const unavailable = () =>
  new RequestSpaceError(
    "ADMISSION_REFUSED",
    "The adopted PRIMARY space control is unavailable.",
  );
interface DecodedControl {
  source: SpaceControlSource | null;
  stateId: string;
  revision: number;
}

/** One composition-fixed PRIMARY locator, shared by canonical saves, issuance and
 * native effect-start. A request cannot supply or retarget this locator. */
export class PostgresPrimarySpaceControlSource
  implements CurrentSpaceControlSourcePort {
  readonly binding: SpaceControlSourceBinding;
  readonly runtimeScope: PostgresRuntimeScope;
  constructor(
    private readonly client: PrismaClient,
    binding: PrimarySpaceControlBinding,
  ) {
    this.binding = Object.freeze({
      scope: Object.freeze({ ...binding.scope }),
      sourceSystemNativeId: binding.sourceSystemNativeId,
    });
    this.runtimeScope = Object.freeze({
      ...binding.scope,
      executionSpaceId: "main",
      operatorId: binding.primaryOperatorId,
    });
    assertPostgresRuntimeScope(this.runtimeScope);
    if (
      !binding.sourceSystemNativeId?.trim() ||
      binding.sourceSystemNativeId.includes("\0")
    ) throw unavailable();
  }
  assertClient(client: PrismaClient): void {
    if (client !== this.client) {
      throw new Error("PRIMARY control must share its host Prisma client");
    }
  }
  owns(scope: PostgresRuntimeScope): boolean {
    return Object.entries(this.runtimeScope).every(([key, value]) =>
      scope[key as keyof PostgresRuntimeScope] === value
    );
  }
  private source(state: SystemRuntimeState | null) {
    if (
      state?.executionModel &&
      state.executionModel.identity.builderId !== this.runtimeScope.operatorId
    ) throw unavailable();
    return spaceControlSourceFromModel(state?.executionModel, this.binding);
  }
  async read() {
    return (await this.capture()).source;
  }
  async capture() {
    return await this.client.$transaction((tx) => this.readLocked(tx));
  }
  /** Caller owns tx. Never calls store.load()/save() or enters a JS store queue. */
  async readLocked(tx: Prisma.TransactionClient) {
    const s = this.runtimeScope;
    const parent = await tx.$queryRaw<Array<{ operatorId: string }>>(
      Prisma.sql`SELECT "operatorId" FROM ${
        postgresQualifiedTable(this.client, "OperatorRuntime")
      } WHERE "projectId"=${s.projectId} AND "systemId"=${s.systemId} AND "executionSpaceId"='main' AND "operatorId"=${s.operatorId} FOR SHARE`,
    );
    if (parent.length !== 1) throw unavailable();
    // The fence holds the row still. Its revision and header (decoded size and
    // SHA-256) name verified content, so an equal key reuses the decode.
    const memo = this.#decoded;
    if (memo) {
      const [probe] = await tx.$queryRaw<
        Array<{ revision: bigint; header: string }>
      >(
        Prisma
          .sql`SELECT "revision", substr("payload", 1, ${RUNTIME_SNAPSHOT_HEADER_CHARS}::integer) AS "header" FROM ${
          postgresQualifiedTable(this.client, "RuntimeState")
        } WHERE "projectId"=${s.projectId} AND "systemId"=${s.systemId} AND "executionSpaceId"='main' AND "operatorId"=${s.operatorId}`,
      );
      if (!probe) throw unavailable();
      if (probe.revision === memo.key && probe.header === memo.header) {
        return this.adopted(memo.control);
      }
    }
    const row = await tx.runtimeState.findFirst({ where: s });
    if (!row) throw unavailable();
    const state = decodePostgresRuntimeState(row);
    const control = {
      source: this.source(state),
      stateId: state.id,
      revision: state.revision,
    };
    const header = runtimeSnapshotHeader(row.payload);
    this.#decoded = header ? { key: row.revision, header, control } : undefined;
    return this.adopted(control);
  }
  /** Last successful decode of this instance's fixed PRIMARY row; never a failure. */
  #decoded?: { key: bigint; header: string; control: DecodedControl };
  private adopted(control: DecodedControl) {
    return {
      source: structuredClone(control.source),
      adoptedState: {
        ...this.runtimeScope,
        executionSpaceId: "main" as const,
        stateId: control.stateId,
        revision: control.revision,
      },
    };
  }
  /** Called only after the canonical writer owns this same PRIMARY row FOR UPDATE.
   * No thread lock is acquired here. Credential locks precede admission locks. */
  async invalidateChanged(
    tx: Prisma.TransactionClient,
    before: SystemRuntimeState | null,
    after: SystemRuntimeState,
  ): Promise<void> {
    if (
      !spaceControlChanged(
        this.source(before),
        this.source(after),
        this.binding,
      )
    ) return;
    const s = this.binding.scope;
    const credentials = postgresQualifiedTable(
      this.client,
      "SpaceControlCredential",
    );
    const admissions = postgresQualifiedTable(
      this.client,
      "SpaceExecutionAdmission",
    );
    await tx.$queryRaw(
      Prisma
        .sql`SELECT "id" FROM ${credentials} WHERE "projectId"=${s.projectId} AND "systemId"=${s.systemId} ORDER BY "id" FOR UPDATE`,
    );
    await tx.$queryRaw(
      Prisma
        .sql`SELECT "id" FROM ${admissions} WHERE "projectId"=${s.projectId} AND "systemId"=${s.systemId} ORDER BY "id" FOR UPDATE`,
    );
    await tx.$executeRaw(
      Prisma
        .sql`UPDATE ${credentials} SET "status"='revoked',"revision"="revision"+1 WHERE "projectId"=${s.projectId} AND "systemId"=${s.systemId} AND "status"='active'`,
    );
    await tx.$executeRaw(
      Prisma
        .sql`UPDATE ${admissions} SET "status"='revoked',"revision"="revision"+1 WHERE "projectId"=${s.projectId} AND "systemId"=${s.systemId} AND "status"='active'`,
    );
  }
}
