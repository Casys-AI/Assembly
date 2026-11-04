/** Effective subjects of a delegated policy in the execution space where it is
 * read. One rule for operator authority and tool admission policies: a policy
 * is relative to its reading space, and a policy read in a branch never names
 * an instance outside that branch. */
import { OperatorAuthorityError } from "../operator-authority-error.ts";
import {
  type ExecutionSpaceRef,
  MAIN_EXECUTION_SPACE_ID,
  sameScopedOperator,
  type ScopedOperatorRef,
} from "../authority.ts";
import { characterCount } from "../../primitives/character-count.ts";

export interface DelegationSubjects {
  holderNativeId: string;
  recipients: readonly string[];
  /** Absent: the legacy form, relative to the space where the policy is read. */
  recipientExecutionSpaceId?: string;
}

/** Why a policy does not cover an exact actor and requester in a space. */
type DelegationScopeRefusal =
  | "policy-not-effective-in-space"
  | "actor-not-holder"
  | "self-approval"
  | "requester-not-recipient";

/** A recipient or space identity in a policy: exact, bounded, no wildcard. */
export function isDelegationIdentity(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() &&
    value.trim() === value && characterCount(value) <= 512 &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    !/[\s*]/.test(value);
}

/** Naming the holder's native ID is another instance only in an explicit
 * branch space; in main, or relative to the reading space, it is the holder. */
export function namesHolderInstance(
  holderNativeId: string,
  policy: Pick<DelegationSubjects, "recipients" | "recipientExecutionSpaceId">,
): boolean {
  return policy.recipients.includes(holderNativeId) &&
    (policy.recipientExecutionSpaceId ?? MAIN_EXECUTION_SPACE_ID) ===
      MAIN_EXECUTION_SPACE_ID;
}

function at(space: ExecutionSpaceRef, executionSpaceId: string) {
  return {
    projectId: space.projectId,
    systemId: space.systemId,
    executionSpaceId,
  };
}

/** The exact instance of a native operator in `space`. */
export function scopedOperator(
  space: ExecutionSpaceRef,
  operatorId: string,
): ScopedOperatorRef {
  return { ...at(space, space.executionSpaceId), operatorId };
}

/** Policies are read in a space of the admitted models' own identity; a caller
 * never re-legitimates a policy by naming another system or project. */
export function assertPolicySpace(
  space: ExecutionSpaceRef,
  models: readonly { identity: { projectId: string; systemId: string } }[],
  context: Record<string, string>,
): void {
  if (
    models.some((model) =>
      model.identity.projectId !== space.projectId ||
      model.identity.systemId !== space.systemId
    )
  ) {
    throw new OperatorAuthorityError(
      "AUTHORITY_PROVENANCE_MISMATCH",
      "The execution space does not belong to the admitted models",
      {
        ...context,
        projectId: space.projectId,
        systemId: space.systemId,
        executionSpaceId: space.executionSpaceId,
      },
    );
  }
}

/** The model where a policy is read is its holder's space. */
export function policyHolder(
  space: ExecutionSpaceRef,
  policy: DelegationSubjects,
): ScopedOperatorRef {
  return scopedOperator(space, policy.holderNativeId);
}

/** [] when the policy is inert in `space`. An explicit other space is effective
 * only from main: delegation flows down from main to branch instances. */
export function policyRecipients(
  space: ExecutionSpaceRef,
  policy: DelegationSubjects,
): ScopedOperatorRef[] {
  const target = policy.recipientExecutionSpaceId ?? space.executionSpaceId;
  if (
    target !== space.executionSpaceId &&
    space.executionSpaceId !== MAIN_EXECUTION_SPACE_ID
  ) return [];
  return policy.recipients.map((operatorId) => ({
    ...at(space, target),
    operatorId,
  }));
}

/** Undefined when covered. Self-approval is judged on composite identity and
 * refused whatever the policy: self-amendment is not executable yet. */
export function policyScopeRefusal(input: {
  space: ExecutionSpaceRef;
  policy: DelegationSubjects;
  actor: ScopedOperatorRef;
  requester: ScopedOperatorRef;
  /** Identity of the independently verified target model; native recipients may be other systems in this source. */
  targetSpace?: ExecutionSpaceRef;
}): DelegationScopeRefusal | undefined {
  const { space, policy, actor, requester } = input;
  const recipients = policyRecipients(space, policy);
  if (!recipients.length) return "policy-not-effective-in-space";
  if (!sameScopedOperator(actor, policyHolder(space, policy))) {
    return "actor-not-holder";
  }
  if (sameScopedOperator(actor, requester)) return "self-approval";
  return recipients.some((recipient) =>
      sameScopedOperator(
        input.targetSpace
          ? {
            ...recipient,
            projectId: input.targetSpace.projectId,
            systemId: input.targetSpace.systemId,
          }
          : recipient,
        requester,
      ) &&
      (!input.targetSpace || input.targetSpace.projectId === space.projectId)
    )
    ? undefined
    : "requester-not-recipient";
}

export function policyCovers(
  input: Parameters<typeof policyScopeRefusal>[0],
): boolean {
  return policyScopeRefusal(input) === undefined;
}
