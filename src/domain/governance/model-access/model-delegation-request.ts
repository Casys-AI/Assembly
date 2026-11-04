/** APE 4.1: requests carry intent; the host supplies issuer and parent authority. */
import type {
  ModelEditGrant,
  ModelEditOperation,
} from "./model-edit-policy.ts";

export type ModelDelegationChange = {
  kind: "grant";
  id: string;
  targetSystem: string;
  operations: ModelEditOperation[];
  grants: ModelEditGrant[];
  mayEdit: boolean;
  recipients: string[];
  maxRedelegationDepth: number | null;
} | { kind: "revoke"; id: string };

export interface ModelDelegationRequest {
  baseVersion: string;
  sourceDigest: string;
  reason: string;
  change: ModelDelegationChange;
}
