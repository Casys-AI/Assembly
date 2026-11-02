import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
} from "../../../domain/work/request-spaces.ts";
import type { PostgresExecutionLedgerOptions } from "../../work/runtime/postgres-ledger.ts";
import type { PostgresRequestExecutionBindingReader } from "./request-execution-binding.ts";
import type { PostgresSpaceAdmissions } from "./request-space-control-store.ts";
import { decodeRequestSpaceOpening } from "./request-space-store.ts";
import type { PostgresSystemScope } from "./scope.ts";
import type { Prisma } from "./client.ts";
function refused(): never {
  throw new RequestSpaceError(
    "ADMISSION_REFUSED",
    "New input no longer matches this Request's current execution admission.",
  );
}
/** Actual native acceptance transaction. Prior/raced receipt returns occur in
 * dispatch before this guard. Stable parent FOR SHARE separates its two phases. */
export function createRequestInputAdmissionGuard(
  host: PostgresSystemScope,
  binding: PostgresRequestExecutionBindingReader,
  admissions: Pick<PostgresSpaceAdmissions, "assertEffectStart">,
): NonNullable<PostgresExecutionLedgerOptions["acceptDeliveryInTransaction"]> {
  const locked = new WeakMap<Prisma.TransactionClient, string>();
  return async (tx, input) => {
    const { identity, modelPin, phase, scope } = input;
    if (!exactSourceVersion(modelPin.repositoryVersion)) refused();
    if (scope.executionSpaceId === "main") return;
    if (identity.scope.kind !== "request") refused();
    const opening = await tx.spaceOpening.findFirst({
      where: { ...host, caseId: identity.scope.scopeId },
    });
    if (
      !opening || opening.executionSpaceId === "main" ||
      scope.projectId !== host.projectId || scope.systemId !== host.systemId ||
      scope.executionSpaceId !== opening.executionSpaceId ||
      scope.operatorId !== identity.operatorId ||
      opening.caseId !== identity.scope.rootRequestId || !opening.admissionId ||
      !opening.baseJson || !opening.baseDigest
    ) refused();
    const record = decodeRequestSpaceOpening(opening);
    const owner = identity.operatorId === record.base!.requestOwner.operatorId;
    const current = owner
      ? await binding.readInTransaction(tx, record)
      : await binding.readOperatorInTransaction(
        tx,
        record,
        identity.operatorId,
      );
    // The BO first, at the binding's pin; a verified member of its team
    // (4.8e E3) at its own admitted digest and selected source version.
    const { operatorIds, modelDigests } = current.admission.permissions;
    const index = operatorIds.indexOf(identity.operatorId);
    if (
      operatorIds[0] !== record.base!.requestOwner.operatorId || index < 0 ||
      (index === 0) !== owner ||
      // The BO keeps its exact binding pin check, unchanged.
      current.pin.modelDigest !== modelPin.modelDigest ||
      (!owner && modelDigests[index] !== modelPin.modelDigest) ||
      current.pin.source.version !== modelPin.repositoryVersion
    ) refused();
    const key = canonical({
      host,
      executionSpaceId: opening.executionSpaceId,
      operatorId: identity.operatorId,
      admissionId: current.admission.id,
      capabilityId: current.admission.capabilityId,
      capabilityRevision: current.admission.capabilityRevision,
    });
    if (phase === "before-share") {
      if (locked.has(tx)) refused();
      await admissions.assertEffectStart(tx, {
        admissionId: current.admission.id,
        expectedRevision: current.admission.revision,
        openingId: opening.id,
        executionSpaceId: opening.executionSpaceId,
        operatorId: identity.operatorId,
        modelDigest: modelPin.modelDigest,
        sourceVersion: modelPin.repositoryVersion,
        baseDigest: opening.baseDigest,
        act: "conversation",
      });
      locked.set(tx, key);
    } else {
      // No new control/admission lock is discovered under the parent. Every
      // identity was fixed and locked before SHARE; pin proof is reread here.
      if (locked.get(tx) !== key) refused();
      locked.delete(tx);
      await admissions.assertEffectStart(tx, {
        admissionId: current.admission.id,
        expectedRevision: current.admission.revision,
        openingId: opening.id,
        executionSpaceId: opening.executionSpaceId,
        operatorId: identity.operatorId,
        modelDigest: modelPin.modelDigest,
        sourceVersion: modelPin.repositoryVersion,
        baseDigest: opening.baseDigest,
        act: "conversation",
      });
      const barrier = await tx.evolutionTargetBarrier.findUnique({
        where: {
          projectId_systemId_repositoryId_targetScopeKey_operatorId: {
            ...host,
            repositoryId: record.base!.manifest.source!.repositoryId,
            targetScopeKey: `request:${record.executionSpaceId}`,
            operatorId: identity.operatorId,
          },
        },
      });
      if (barrier) refused();
    }
  };
}
