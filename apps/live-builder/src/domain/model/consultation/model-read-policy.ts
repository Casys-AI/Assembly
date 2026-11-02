import type { ExecutionPolicy } from "../execution/executable-model.ts";

/** Explicit policies separate reading from revision. Absence identifies the
 * historical pin encoding, whose previously granted reads remain unchanged. */
export function mayConsultModel(
  policy: Pick<ExecutionPolicy, "mayConsultModel" | "mayProposeSysmlRevision">,
): boolean {
  return policy.mayConsultModel ?? policy.mayProposeSysmlRevision === true;
}

export type ModelRightField = "mayConsultModel" | "mayProposeSysmlRevision";
type ModelRightsErrorCode =
  | "MODEL_READ_POLICY_INVALID"
  | "MODEL_REVISION_POLICY_INVALID"
  | "MODEL_REVISION_AUTHORITY";

export class ModelRightsError extends Error {
  constructor(
    readonly code: ModelRightsErrorCode,
    message: string,
    readonly context: { field: ModelRightField; operation?: string },
    readonly recovery: string,
  ) {
    super(message);
    this.name = "ModelRightsError";
  }
}
