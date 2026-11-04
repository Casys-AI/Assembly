import type { OperatorCreationPolicyRequest } from "../../domain/governance/policies/operator-creation-policy.ts";
import type { ToolAdmissionPolicyRequest } from "../../domain/governance/policies/tool-admission-policy.ts";
import type { OperatorAuthorityPolicyRequest } from "../../domain/governance/policies/operator-authority-policy.ts";
import type { ModelEditOperation } from "../../domain/governance/model-access/model-edit-policy.ts";
import type { OperatorCreationSpec } from "../../domain/governance/operator-authority.ts";

export type OperatorAuthorityRequest =
  | {
    op: "publishOperatorCreationPolicy";
    systemName: string;
    changeId: string;
    policy: OperatorCreationPolicyRequest;
  }
  | {
    op: "publishToolAdmissionPolicy";
    systemName: string;
    changeId: string;
    policy: ToolAdmissionPolicyRequest;
  }
  | {
    op: "publishOperatorAuthorityPolicy";
    systemName: string;
    changeId: string;
    policy: OperatorAuthorityPolicyRequest;
  }
  | {
    op: "grantModelEditing";
    systemName: string;
    changeId: string;
    grant: {
      file: string;
      root: string;
      operations: Exclude<ModelEditOperation, "replace-source">[];
    };
  }
  | {
    op: "createRequestOperator";
    systemName: string;
    changeId: string;
    name: string;
    operator: OperatorCreationSpec;
    teamOrigin?: { operatorId: string; requestId: string };
    parentOperatorId?: string;
    creationPolicy?: { id: string; revision: number; elementId: string };
    /** Host-captured from the compiled creator; required for team creation. */
    creatorMayAddNetworkHosts?: boolean;
  };
