import type { NativePolicyIdentity } from "../../model/execution/executable-model.ts";
import type { OwnerAuthority } from "../authority.ts";

export const SPACE_CONTROL_ACTS = [
  "open-request",
  "execute-conversation",
  "revoke-execution",
  "retain-release",
] as const;
export type SpaceControlAct = typeof SPACE_CONTROL_ACTS[number];
export interface NativeSpaceControlPolicy extends NativePolicyIdentity {
  enabled: boolean;
  acts: SpaceControlAct[];
  /** Exactly one source-owned operator in the conversation-only slice. */
  operatorIds: [string];
  systemId: string;
  holderNativeId: string;
  mandateNativeId: string;
  issuerRootNativeId: string;
  rootAuthority: OwnerAuthority;
}
export class SpaceControlPolicyError extends Error {
  readonly code = "INVALID_SPACE_CONTROL_POLICY";
  constructor(detail: string) {
    super(`Invalid native space-control policy: ${detail}`);
    this.name = "SpaceControlPolicyError";
  }
}
/** One canonical set parser shared by source compilation and execution control. */
export function spaceControlActs(value: unknown): SpaceControlAct[] | null {
  if (
    !Array.isArray(value) || !value.length ||
    !value.every((entry): entry is SpaceControlAct =>
      SPACE_CONTROL_ACTS.some((act) => act === entry)
    ) ||
    new Set(value).size !== value.length
  ) return null;
  return [...value].sort();
}
/** Policy contents are facts, not authentication or a space admission. Disabled
 * and narrowed policies still compile so their changes can be adopted/revoked. */
export function spaceControlPolicyFields(value: {
  id: unknown;
  revision: unknown;
  enabled: unknown;
  acts: unknown;
}): {
  id: string;
  revision: number;
  enabled: boolean;
  acts: SpaceControlAct[];
} {
  const { id, revision, enabled } = value;
  const acts = spaceControlActs(value.acts);
  if (
    typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id) ||
    !Number.isSafeInteger(revision) || Number(revision) < 1 ||
    typeof enabled !== "boolean" ||
    !acts
  ) {
    throw new SpaceControlPolicyError(
      "explicit identity, revision and bounded acts required",
    );
  }
  return { id, revision: Number(revision), enabled, acts };
}
