import type { OwnerAuthority } from "../governance/authority.ts";
import type { ExecutableModel } from "../model/execution/executable-model.ts";
import { spaceControlActs } from "../governance/policies/space-execution-policy.ts";
import { canonical } from "../primitives/canonical-json.ts";
import {
  spaceControlAuthorityMatchesBinding,
  spaceControlOwnerIdentity,
} from "./request-space-authority.ts";
import { MAX_OPERATOR_UNITS } from "./records/conversations.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
  type SpaceControlAuthority,
  type SpaceControlSourceBinding,
} from "./request-spaces.ts";

export interface SpaceControlSource {
  binding: SpaceControlSourceBinding;
  sourceVersion: string;
  modelDigest: string;
  owner: OwnerAuthority;
  policy: {
    id: string;
    revision: number;
    enabled: boolean;
    holderNativeId: string;
    mandateNativeId: string;
    issuerRootNativeId: string;
    operatorIds: string[];
    acts: SpaceControlAuthority["acts"];
  };
}
const refused = () =>
  new RequestSpaceError(
    "FORBIDDEN",
    "The current modeled space-control act is unavailable.",
  );

/** Source evidence is retained separately from effective control, including
 * disabled/narrowed policies so adopting them can invalidate prior rights. */
function spaceControlSnapshot(
  source: SpaceControlSource | null,
  binding: SpaceControlSourceBinding,
) {
  if (!source) return null;
  const { owner, policy } = source;
  const acts = spaceControlActs(policy?.acts);
  const effectiveOwner = spaceControlOwnerIdentity(
    owner,
    binding.sourceSystemNativeId,
  );
  if (
    !effectiveOwner || !policy ||
    canonical(source.binding) !== canonical(binding) ||
    owner.systemId !== binding.sourceSystemNativeId ||
    !exactSourceVersion(source.sourceVersion) ||
    !/^[a-f0-9]{64}$/.test(source.modelDigest) ||
    !policy.id || !Number.isSafeInteger(policy.revision) ||
    policy.revision < 1 ||
    typeof policy.enabled !== "boolean" || !acts ||
    policy.holderNativeId !== owner.operatorNativeId ||
    policy.mandateNativeId !== owner.mandateNativeId ||
    policy.issuerRootNativeId !== owner.rootAuthorityNativeId ||
    !Array.isArray(policy.operatorIds) || !policy.operatorIds.length ||
    policy.operatorIds.length > MAX_OPERATOR_UNITS ||
    policy.operatorIds.some((id) => !id || id === "*") ||
    new Set(policy.operatorIds).size !== policy.operatorIds.length
  ) throw refused();
  return {
    binding: structuredClone(binding),
    owner: effectiveOwner,
    policy: {
      id: policy.id,
      revision: policy.revision,
      enabled: policy.enabled,
      holderNativeId: policy.holderNativeId,
      mandateNativeId: policy.mandateNativeId,
      issuerRootNativeId: policy.issuerRootNativeId,
      acts,
      operatorIds: [...policy.operatorIds].sort(),
    },
  };
}

export function projectSpaceControlAuthority(
  source: SpaceControlSource | null,
  binding: SpaceControlSourceBinding,
  ownerId: string,
): SpaceControlAuthority {
  const snapshot = spaceControlSnapshot(source, binding);
  if (
    !source || !snapshot || source.owner.operatorId !== ownerId ||
    !snapshot.policy.enabled ||
    !snapshot.policy.acts.includes("open-request") ||
    !snapshot.policy.acts.includes("execute-conversation")
  ) throw refused();
  const result: SpaceControlAuthority = {
    ...structuredClone(binding),
    sourceVersion: source.sourceVersion,
    modelDigest: source.modelDigest,
    owner: structuredClone(source.owner),
    policyId: snapshot.policy.id,
    policyRevision: snapshot.policy.revision,
    operatorIds: snapshot.policy.operatorIds,
    acts: snapshot.policy.acts,
  };
  if (!spaceControlAuthorityMatchesBinding(result, binding)) throw refused();
  return result;
}

/** The canonical adopted executable projection was source-validated on admission.
 * No runtime roster, role, Release or repository HEAD supplies missing policy. */
export function spaceControlSourceFromModel(
  model: ExecutableModel | undefined,
  binding: SpaceControlSourceBinding,
): SpaceControlSource | null {
  if (!model) return null;
  if (
    model.identity.systemId !== binding.sourceSystemNativeId ||
    model.identity.projectId !== binding.scope.projectId
  ) throw refused();
  const policy = model.spaceControlPolicy;
  if (!policy) return null;
  const owner = model.ownerAuthority;
  if (
    !owner || policy.systemId !== binding.sourceSystemNativeId ||
    canonical(
        spaceControlOwnerIdentity(
          policy.rootAuthority,
          binding.sourceSystemNativeId,
        ),
      ) !==
      canonical(spaceControlOwnerIdentity(owner, binding.sourceSystemNativeId))
  ) throw refused();
  const source: SpaceControlSource = {
    binding: structuredClone(binding),
    sourceVersion: model.version.repositoryVersion ?? "",
    modelDigest: model.version.digest,
    owner: structuredClone(owner),
    policy: {
      id: policy.id,
      revision: policy.revision,
      enabled: policy.enabled,
      holderNativeId: policy.holderNativeId,
      mandateNativeId: policy.mandateNativeId,
      issuerRootNativeId: policy.issuerRootNativeId,
      operatorIds: [...policy.operatorIds],
      acts: [...policy.acts],
    },
  };
  spaceControlSnapshot(source, binding);
  return source;
}

/** True means all previously issued credentials/admissions must be invalidated.
 * Same policy identity cannot change effective content without a strict bump. */
export function spaceControlChanged(
  before: SpaceControlSource | null,
  after: SpaceControlSource | null,
  binding: SpaceControlSourceBinding,
): boolean {
  const a = spaceControlSnapshot(before, binding),
    b = spaceControlSnapshot(after, binding);
  if (canonical(a) === canonical(b)) return false;
  if (
    a && b && a.policy.id === b.policy.id &&
    b.policy.revision <= a.policy.revision
  ) {
    throw new RequestSpaceError(
      "FORBIDDEN",
      "Changed space-control content requires a strictly increased modeled policy revision.",
    );
  }
  return true;
}
