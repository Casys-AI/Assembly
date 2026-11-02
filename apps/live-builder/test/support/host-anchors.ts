/** Host enforcement symbols for matrix consumers. Keep this registry outside
 * source authorization so compiled-model readers do not load HTTP handlers. */
import type { MatrixEnforcementAnchor } from "../../src/domain/governance/records/authority-matrix.ts";
import { decideCandidate } from "../../src/application/work/candidates/decisions.ts";
import { SystemGovernance } from "../../src/domain/governance/policies/governance.ts";
import { createModelRevisionHandler } from "../../src/adapters/in/http/model/revisions.ts";
import { NativeModelSourceAuthorization } from "../../src/adapters/governance/model-access/source-authorization.ts";

type EnforcementFunction = (...args: never[]) => unknown;

export const authorityHostAnchors = {
  humanAdmission: decideCandidate,
  humanApprovesChange: SystemGovernance.prototype.decideChange,
  localOwnerModel: NativeModelSourceAuthorization.prototype.validate,
  ownerRevisions: createModelRevisionHandler,
} satisfies Record<MatrixEnforcementAnchor, EnforcementFunction>;
