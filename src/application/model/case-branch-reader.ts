import type { RequestExecutionBindingPort } from "./evolution/request-adoption-ports.ts";
import {
  assertOpeningBase,
  exactSourceVersion,
  OPENING_PHASES,
  type OpeningRecord,
  requestSpaceDigest,
  RequestSpaceError,
  requestSpaceIdentity,
  type RequestSpaceScope,
  type SpaceController,
} from "../../domain/work/request-spaces.ts";
import type { CaseModelVersionRead } from "../work/request-spaces/case-model-notifications.ts";
import type {
  OpeningSourcePort,
  OpeningStorePort,
  RequestBranchPort,
} from "../work/request-spaces/ports.ts";

/** Resolve every read from host-owned Case state. A browser never supplies a ref. */
export function createCaseBranchReader(options: {
  scope: RequestSpaceScope;
  store: Pick<OpeningStorePort, "forCase">;
  source: Pick<OpeningSourcePort, "readModelsForInspection">;
  executionBindings?: RequestExecutionBindingPort;
  /** Verified D2 source projection; never substitutes the physical branch tip. */
  admittedInspection?: (
    record: OpeningRecord,
    version: string,
  ) => Promise<string>;
  branches: Pick<RequestBranchPort, "sourceVersion"> & {
    assertVersion(
      record: OpeningRecord,
      version: string,
    ): Promise<void>;
  };
}) {
  const admittedPhase = (record: OpeningRecord) =>
    ["admitted", "dispatched"].includes(record.phase);
  /** The recorded Request of this host with a branch, whoever owns it. */
  async function recorded(caseId: string): Promise<OpeningRecord | null> {
    if (!requestSpaceIdentity(caseId)) return null;
    const record = await options.store.forCase(caseId);
    if (
      !record || record.caseId !== caseId ||
      record.scope.projectId !== options.scope.projectId ||
      record.scope.systemId !== options.scope.systemId ||
      !record.base ||
      OPENING_PHASES.indexOf(record.phase) <
        OPENING_PHASES.indexOf("branch-ready")
    ) return null;
    if (
      !record.baseDigest ||
      await requestSpaceDigest(record.base) !== record.baseDigest
    ) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "Request base integrity could not be verified.",
      );
    }
    assertOpeningBase(record.base);
    return record;
  }
  /** The version it runs, the one read (that one unless asked) and its branch head. */
  async function versionsOf(record: OpeningRecord, requested?: string) {
    const binding = options.executionBindings && admittedPhase(record)
      ? await options.executionBindings.read(record)
      : undefined;
    const executionVersion = binding?.pin.source.version ??
      record.base!.manifest.source!.sourceVersion;
    const version = requested ?? executionVersion;
    if (!exactSourceVersion(version)) {
      throw new RequestSpaceError(
        "INVALID_COMMAND",
        "An exact model version is required.",
      );
    }
    const branchVersion = options.admittedInspection && admittedPhase(record)
      ? await options.admittedInspection(record, version)
      : await options.branches.sourceVersion(record);
    if (!exactSourceVersion(branchVersion)) {
      throw new RequestSpaceError(
        "UNAVAILABLE",
        "Request branch unavailable.",
      );
    }
    return { version, branchVersion, executionVersion };
  }
  return {
    async resolve(
      caseId: string,
      controller: SpaceController,
      requested?: string,
    ) {
      const record = await recorded(caseId);
      if (!record || record.ownerId !== controller.ownerId) {
        throw new RequestSpaceError(
          "UNAVAILABLE",
          "Request model unavailable.",
        );
      }
      await options.source.readModelsForInspection(record.base!);
      const { version, branchVersion, executionVersion } = await versionsOf(
        record,
        requested,
      );
      if (!options.admittedInspection || !admittedPhase(record)) {
        await options.branches.assertVersion(record, version);
      }
      return {
        caseId: record.caseId,
        branchId: record.branchId,
        executionSpaceId: record.executionSpaceId,
        branchVersion,
        version,
        executionVersion,
        baseVersion: record.base!.manifest.source!.sourceVersion,
        release: record.base!.release ?? null,
        readOnly: true as const,
      };
    },
    /** Host-side, for notifications only: the versions a scope read without
     * a version would tell, and the owner they belong to. A reader still
     * resolves its own scope, authorized, before reading anything. */
    async versions(caseId: string): Promise<CaseModelVersionRead | null> {
      const record = await recorded(caseId);
      if (!record) return null;
      const { branchVersion, executionVersion } = await versionsOf(record);
      return { ownerId: record.ownerId, branchVersion, executionVersion };
    },
  };
}
