import type { ModelEditOperation } from "./model-edit-policy.ts";
import type { ModelDelegationChange } from "./model-delegation-request.ts";
import type { ModelDelegationRecord } from "./model-delegation.ts";
import type { AuthorityExercise } from "../authority.ts";

/** Host-captured administrative intent and exact resulting grant/tombstone. */
export interface ModelAdministrationAuthorization {
  kind: "operator-administration";
  systemQualifiedName: string;
  operatorNativeId: string;
  authorityDigest: string;
  change: ModelDelegationChange;
  record: ModelDelegationRecord;
  previousDigest?: string;
}

/** Principal and policy pinned when a source proposal is created. */
export type ModelProposalAuthorization =
  | import("../../model/evolution/policy.ts").EvolutionProposalAuthorization
  | ModelAdministrationAuthorization
  | {
    kind: "local-owner";
    /** Captured by the local control, never accepted from a request principal. */
    authorityExercise?: AuthorityExercise;
  }
  | {
    kind: "operator";
    systemQualifiedName: string;
    operatorQualifiedName: string;
    operatorNativeId: string;
    mandateId: string;
    mandateRevision: number;
    policyId: string;
    policyRevision: number;
    policyDigest: string;
    operations: ModelEditOperation[];
  };
