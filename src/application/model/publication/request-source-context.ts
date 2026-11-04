import { RequestSpaceError } from "../../../domain/work/request-spaces/scope.ts";
import { ModelBuildServiceError } from "../builds/service.ts";
import { BuildStoreError } from "../builds/ports/out/build-store.port.ts";
import { ModelRepositoryError } from "../repository.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { ModelWriteCommandError } from "../../../domain/model/editing/write-command-error.ts";
import {
  modelWriteDossierDigestV2,
  parseModelWriteDossierV2,
} from "./write-command-v2.ts";
import { parseRequestSourceAdmission } from "../source-admission/request-source-admission.ts";
import type { RequestSourcePublicationContext } from "./ports/out/request-source-publication.port.ts";

/** Owned integrity snapshot; never evidence that a Git ref or grant exists. */
export async function parseRequestSourcePublicationContext(
  value: RequestSourcePublicationContext,
): Promise<RequestSourcePublicationContext> {
  const owned = structuredClone(value);
  const dossier = await parseModelWriteDossierV2(owned.dossier);
  const admission = await parseRequestSourceAdmission(owned.admission);
  if (
    canonical(dossier.command) !== canonical(admission.command) ||
    canonical(dossier.authority) !== canonical(admission.authority) ||
    await modelWriteDossierDigestV2(dossier) !== admission.dossierDigest
  ) {
    throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
      reason: "Prepared Request evidence differs from its exact dossier",
    }, "Prepared Request evidence differs from its exact dossier");
  }
  return { dossier, admission };
}

/** Spawn unavailability has a distinct type but retains the existing legacy
 * code/message and ModelRepositoryError identity at the Git boundary. */
export class ModelRepositoryInspectionUnavailableError
  extends ModelRepositoryError {
  constructor(readonly reason: "git-executable", message: string) {
    super("INVALID_REPOSITORY", message);
  }
}
/** Only named availability is retryable. Missing/corrupt Git objects and an
 * incompatible materialized model are not inferred to be temporary. */
export function isRequestSourceProofUnavailable(error: unknown): boolean {
  if (error instanceof ModelRepositoryInspectionUnavailableError) return true;
  if (error instanceof ModelBuildServiceError) {
    return error.code === "BUILD_UNAVAILABLE" ||
      error.code === "BUILD_RECIPE_UNAVAILABLE";
  }
  if (error instanceof BuildStoreError) {
    return [
      "BUILD_BLOB_MISSING",
      "BUILD_STORE_UNAVAILABLE",
      "BUILD_STORE_BUSY",
      "BUILD_STORE_QUOTA_EXCEEDED",
    ].includes(error.code);
  }
  return false;
}
/** Existing queue availability is a structured storage-port failure. A D2
 * domain UNAVAILABLE means invalid/unsupported immutable history, not SQL I/O. */
export function isRequestSourceSettlementUnavailable(error: unknown): boolean {
  return isRequestSourceProofUnavailable(error) ||
    error instanceof Error && error.name === "ModelWriteQueueError" &&
      "code" in error && error.code === "WRITE_QUEUE_UNAVAILABLE";
}
export function isRequestSourceHistoryConflict(error: unknown): boolean {
  return error instanceof RequestSpaceError &&
      (error.code === "OPENING_CONFLICT" || error.code === "UNAVAILABLE" ||
        error.code === "INVALID_COMMAND") ||
    error instanceof ModelBuildServiceError &&
      !isRequestSourceProofUnavailable(error) ||
    error instanceof BuildStoreError && !isRequestSourceProofUnavailable(error);
}
