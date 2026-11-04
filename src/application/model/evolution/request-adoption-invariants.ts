import { nativeFlowContractDigest } from "../../../domain/model/execution/flow-contract.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  MAX_NETWORK_HOST_ADDITIONS,
  validateNetworkScope,
} from "../../../domain/governance/policies/network-policy.ts";
import {
  assertRequestNetworkChange,
  decidedByNetworkAuthority,
} from "../../../domain/governance/records/request-network-change.ts";
import {
  assertRequestCreationPolicyChange,
  assertRequestTeamChange,
  decidedByTeamAuthority,
} from "../../../domain/governance/records/request-change.ts";
import { requestedCreationPolicyId } from "../../../domain/governance/policies/operator-creation-policy.ts";
import { spellSysmlQualifiedName } from "../../../domain/model/value-objects/sysml-qualified-name.ts";
import { MAX_BRANCH_TEAM } from "../../../domain/work/records/conversations.ts";
import { scopedOperator } from "../../../domain/governance/policies/delegation-scope.ts";
import { sameScopedOperator } from "../../../domain/governance/operator-authority.ts";

import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import {
  type AuthorityExercise,
  OWNER_AUTHORITY_IDENTITY_FIELDS,
  type OwnerAuthority,
  sameOwnerAuthorityIdentity,
} from "../../../domain/governance/authority.ts";
import {
  effectiveSpaceControlAuthority,
  sameSpaceControlPrincipal,
  spaceControlOwnerIdentity,
} from "../../../domain/work/request-space-authority.ts";
import { exactSourceVersion } from "../../../domain/work/request-spaces.ts";
import { parseRequestModelWriteLocator } from "../../../domain/model/editing/request-write-destination.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  buildKey,
  parseBuildDescriptorStrict,
  recipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import {
  type RequestAdoptionDecision,
  RequestAdoptionError,
  type RequestAdoptionIntent,
  type RequestAdoptionManifest,
  type RequestAdoptionReceipt,
  type RequestAdoptionTarget,
  type RequestCreationGrantAdoptionDecision,
  type RequestDelegatedAdoptionDecision,
  type RequestHumanAdoptionDecision,
  type RequestOwnerAdoptionDossier,
} from "./request-adoption-ports.ts";

function invalid(reason: string): never {
  throw new RequestAdoptionError("INVALID", `Request adoption: ${reason}`, {
    context: { reason },
    recovery:
      "Reload the exact recorded Request decision, execution pin and publication proof before retrying adoption.",
  });
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("closed object required");
  }
  const v = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(v, key)) ||
    Object.keys(v).some((key) =>
      !required.includes(key) && !optional.includes(key)
    )
  ) invalid("closed fields required");
  return v;
}
function text(v: unknown): asserts v is string {
  if (
    typeof v !== "string" || !v || v.trim() !== v || v.length > 2048 ||
    v === "*" ||
    [...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  ) invalid("bounded identity required");
}
function integer(v: unknown, minimum = 0): asserts v is number {
  if (!Number.isSafeInteger(v) || Number(v) < minimum) {
    invalid("safe revision required");
  }
}
function hash(v: unknown): asserts v is string {
  if (!isSha256Hex(v)) {
    invalid("exact digest required");
  }
}
function time(v: unknown): asserts v is string {
  text(v);
  if (!Number.isFinite(Date.parse(v)) || new Date(v).toISOString() !== v) {
    invalid("canonical instant required");
  }
}
function source(value: unknown, repositoryId: string) {
  const record = object(value, ["repositoryId", "version"]),
    ref = parseModelRevisionRef(record);
  if (ref.repositoryId !== repositoryId || !exactSourceVersion(ref.version)) {
    invalid("exact repository source required");
  }
  return ref;
}
export function parseRequestAdoptionTarget(
  value: unknown,
): RequestAdoptionTarget {
  const snapshot = structuredClone(value),
    v = object(snapshot, [
      "v",
      "kind",
      "repositoryId",
      "host",
      "openingId",
      "executionSpaceId",
      "caseId",
      "branchId",
      "ref",
      "operatorId",
    ]);
  const { operatorId, ...locator } = v;
  parseRequestModelWriteLocator(locator);
  text(operatorId);
  return snapshot as RequestAdoptionTarget;
}
export function requestAdoptionScopeKey(target: RequestAdoptionTarget): string {
  return `request:${parseRequestAdoptionTarget(target).executionSpaceId}`;
}
function owner(value: unknown): OwnerAuthority {
  const v = object(value, [...OWNER_AUTHORITY_IDENTITY_FIELDS, "sourceIds"]);
  if (v.ownerSource !== "modeled") invalid("modeled R0 owner required");
  for (const key of OWNER_AUTHORITY_IDENTITY_FIELDS) {
    if (key !== "mandateRevision" && key !== "ownerSource") text(v[key]);
  }
  integer(v.mandateRevision);
  if (!Array.isArray(v.sourceIds) || v.sourceIds.length > 1024) {
    invalid("owner source identities required");
  }
  for (const id of v.sourceIds) text(id);
  if (
    !spaceControlOwnerIdentity(
      v as unknown as OwnerAuthority,
      v.systemId as string,
    )
  ) invalid("complete modeled owner required");
  return v as unknown as OwnerAuthority;
}
/** A Main or same-Request operator delegated network decision: its recorded authority digest
 * and exact delegated exercise, never a session or a model-adoption grant. */
function parseDelegatedAdoptionDecision(
  snapshot: unknown,
): RequestDelegatedAdoptionDecision {
  const v = object(snapshot, [
    "kind",
    "authorityDigest",
    "exercise",
    "capturedAt",
  ], ["route"]);
  hash(v.authorityDigest);
  time(v.capturedAt);
  const e = object(v.exercise, [
    ...OWNER_AUTHORITY_IDENTITY_FIELDS,
    "sourceIds",
    "authoritySchema",
    "action",
    "baseModelDigest",
    "outOfMandate",
    "delegation",
  ]);
  owner(Object.fromEntries(
    [...OWNER_AUTHORITY_IDENTITY_FIELDS, "sourceIds"].map((key) => [
      key,
      e[key],
    ]),
  ));
  hash(e.baseModelDigest);
  const d = e.delegation as AuthorityExercise["delegation"];
  if (
    e.authoritySchema !== 2 || e.action !== "model-adoption" ||
    e.outOfMandate !== false || !d?.actor || !d.requester ||
    sameScopedOperator(d.actor, d.requester) ||
    d.actorId !== d.actor.operatorId ||
    d.requestedBy !== d.requester.operatorId ||
    typeof d.requester.executionSpaceId !== "string" ||
    !d.requester.executionSpaceId.trim() ||
    (d.actor.executionSpaceId !== "main" &&
      d.actor.executionSpaceId !== d.requester.executionSpaceId) ||
    d.requester.executionSpaceId === "main" ||
    !d.requestedRights || !("addNetworkHosts" in d.requestedRights)
  ) invalid("exact delegated network decision required");
  for (const scoped of [d.actor, d.requester]) {
    Object.values(
      object(scoped, [
        "projectId",
        "systemId",
        "executionSpaceId",
        "operatorId",
      ]),
    ).forEach(text);
  }
  text(d.policyId);
  text(d.policyElementId);
  text(d.changeId);
  text(d.caseId);
  integer(d.policyRevision, 1);
  if (d.actor.projectId !== d.requester.projectId) {
    invalid("same Request project required");
  }
  if (v.route === undefined) {
    if (d.actor.executionSpaceId !== "main") {
      invalid("exact routed delegated decision required");
    }
  } else {
    const route = object(v.route, [
      "version",
      "status",
      "changeId",
      "caseId",
      "requestedBy",
      "requester",
      "targetOperatorId",
      "baseRevision",
      "modelDigest",
      "designatedDecider",
      "trace",
    ], ["openingId", "code", "responsibleOperatorId", "reason"]);
    const decider = object(route.designatedDecider, [
      "operatorId",
      "executionSpaceId",
      "policyId",
      "policyRevision",
    ]);
    const requester = object(route.requester, [
      "projectId",
      "systemId",
      "executionSpaceId",
      "operatorId",
    ]);
    Object.values(requester).forEach(text);
    integer(route.baseRevision);
    hash(route.modelDigest);
    if (route.openingId !== undefined) text(route.openingId);
    if (
      route.version !== 2 || route.status !== "actor-decision" ||
      route.changeId !== d.changeId || route.caseId !== d.caseId ||
      route.modelDigest !== e.baseModelDigest ||
      route.requestedBy !== d.requestedBy ||
      route.targetOperatorId !== d.requester.operatorId ||
      !sameScopedOperator(
        requester as unknown as typeof d.requester,
        d.requester,
      ) ||
      decider.operatorId !== d.actor.operatorId ||
      decider.executionSpaceId !== d.actor.executionSpaceId ||
      decider.policyId !== d.policyId ||
      decider.policyRevision !== d.policyRevision ||
      !Array.isArray(route.trace)
    ) invalid("exact routed delegated decision required");
    for (const item of route.trace) {
      const entry = object(item, [
        "operatorId",
        "executionSpaceId",
        "eligibility",
      ], ["policyId", "policyRevision"]);
      text(entry.operatorId);
      text(entry.executionSpaceId);
      if (!["eligible", "not-covered"].includes(String(entry.eligibility))) {
        invalid("exact route trace required");
      }
      if (entry.policyId !== undefined) text(entry.policyId);
      if (entry.policyRevision !== undefined) integer(entry.policyRevision, 1);
    }
  }
  return snapshot as RequestDelegatedAdoptionDecision;
}
/** The creator's creation-grant decision (4.8e): its recorded authority
 * digest and exact creation exercise, never a session or a grant of
 * model-adoption on someone else's behalf. */
function parseCreationGrantAdoptionDecision(
  snapshot: unknown,
): RequestCreationGrantAdoptionDecision {
  const v = object(snapshot, [
    "kind",
    "authorityDigest",
    "exercise",
    "capturedAt",
  ]);
  hash(v.authorityDigest);
  time(v.capturedAt);
  const e = object(v.exercise, [
    ...OWNER_AUTHORITY_IDENTITY_FIELDS,
    "sourceIds",
    "authoritySchema",
    "action",
    "baseModelDigest",
    "outOfMandate",
    "creationDelegation",
  ]);
  owner(Object.fromEntries(
    [...OWNER_AUTHORITY_IDENTITY_FIELDS, "sourceIds"].map((key) => [
      key,
      e[key],
    ]),
  ));
  hash(e.baseModelDigest);
  const receipt = e.creationDelegation as
    | AuthorityExercise["creationDelegation"]
    | undefined;
  if (
    e.authoritySchema !== 2 || e.action !== "model-adoption" ||
    e.outOfMandate !== false || !receipt ||
    receipt.actorId !== receipt.requestedBy ||
    !receipt.teamOrigin || receipt.caseId !== receipt.teamOrigin.requestId
  ) invalid("exact creation-grant team decision required");
  return snapshot as RequestCreationGrantAdoptionDecision;
}
export function parseRequestAdoptionDecision(
  value: unknown,
): RequestAdoptionDecision {
  const snapshot = structuredClone(value);
  if (
    snapshot && typeof snapshot === "object" &&
    Reflect.get(snapshot, "kind") === "request-delegated-adoption-decision"
  ) return parseDelegatedAdoptionDecision(snapshot);
  if (
    snapshot && typeof snapshot === "object" &&
    Reflect.get(snapshot, "kind") ===
      "request-creation-grant-adoption-decision"
  ) return parseCreationGrantAdoptionDecision(snapshot);
  const v = object(snapshot, [
    "kind",
    "controller",
    "sessionRevision",
    "exercise",
    "capturedAt",
  ]);
  if (v.kind !== "request-human-adoption-decision") {
    invalid("independent human decision required");
  }
  integer(v.sessionRevision);
  time(v.capturedAt);
  const c = object(v.controller, [
    "ownerId",
    "capabilityId",
    "capabilityRevision",
    "sessionId",
    "authority",
  ]);
  text(c.ownerId);
  text(c.capabilityId);
  text(c.sessionId);
  integer(c.capabilityRevision);
  const a = object(c.authority, [
    "scope",
    "sourceSystemNativeId",
    "sourceVersion",
    "modelDigest",
    "owner",
    "policyId",
    "policyRevision",
    "operatorIds",
    "acts",
  ]);
  const scope = object(a.scope, ["projectId", "systemId"]);
  text(scope.projectId);
  text(scope.systemId);
  text(a.sourceSystemNativeId);
  text(a.policyId);
  hash(a.modelDigest);
  integer(a.policyRevision);
  if (!exactSourceVersion(a.sourceVersion)) {
    invalid("exact control source required");
  }
  const modeled = owner(a.owner);
  if (
    !effectiveSpaceControlAuthority(
      a as unknown as RequestHumanAdoptionDecision["controller"]["authority"],
    )
  ) invalid("valid current-control shape required");
  const e = object(v.exercise, [
    ...OWNER_AUTHORITY_IDENTITY_FIELDS,
    "sourceIds",
    "authoritySchema",
    "action",
    "baseModelDigest",
    "outOfMandate",
  ]);
  const exerciseOwner = Object.fromEntries(
    [...OWNER_AUTHORITY_IDENTITY_FIELDS, "sourceIds"].map((
      key,
    ) => [key, e[key]]),
  );
  owner(exerciseOwner);
  hash(e.baseModelDigest);
  if (
    e.authoritySchema !== 2 || e.action !== "model-adoption" ||
    e.outOfMandate !== false ||
    !sameOwnerAuthorityIdentity(
      modeled,
      exerciseOwner as unknown as OwnerAuthority,
    )
  ) invalid("schema-2 modeled R0 adoption required");
  return snapshot as RequestHumanAdoptionDecision;
}
/** The account owning the adoption key: the person's controller, or for a
 * delegated decision the opening owner its admission already names. */
export function requestAdoptionOwnerId(intent: RequestAdoptionIntent): string {
  return intent.decision.kind === "request-human-adoption-decision"
    ? intent.decision.controller.ownerId
    : intent.previous.admission.ownerId;
}
function modelIdentity(value: unknown) {
  const v = object(value, [
    "projectId",
    "editingContextId",
    "rootId",
    "systemId",
    "catalogId",
    "builderId",
  ], ["systemQualifiedName", "backend", "reviewerId"]);
  for (const [key, item] of Object.entries(v)) {
    if (key === "backend") {
      if (item !== "native") invalid("native model required");
    } else text(item);
  }
  return v;
}
function pin(value: unknown, repositoryId: string) {
  const v = object(value, [
    "source",
    "modelDigest",
    "sourceAdmission",
    "adoption",
  ]);
  source(v.source, repositoryId);
  hash(v.modelDigest);
  const a = object(v.sourceAdmission, ["revision", "manifestDigest"]);
  integer(a.revision, 1);
  hash(a.manifestDigest);
  if (v.adoption !== null) {
    const receipt = object(v.adoption, [
      "commandId",
      "receiptDigest",
      "committedRuntimeRevision",
    ]);
    text(receipt.commandId);
    hash(receipt.receiptDigest);
    integer(receipt.committedRuntimeRevision, 1);
  }
}
function executableModel(value: unknown): ExecutableModel {
  const v = object(value, [
    "identity",
    "version",
    "configuration",
    "mandate",
    "policy",
    "contracts",
    "flows",
    "catalog",
  ], [
    "spaceControlPolicy",
    "evolutionPolicy",
    "operatorFlowTemplate",
    "toolAdmissionPolicies",
    "operatorTeam",
    "operatorCreationPolicies",
    "operatorAuthorityPolicies",
    "modelEditingAuthorityRoots",
    "ownerAuthority",
    "caseTypes",
    "modelEditPolicy",
    "modelAdministrationPolicy",
    "modelAdministration",
    "workBudgetPolicy",
    "workResultContracts",
    "initialTools",
    "contextPolicy",
    "memoryPolicy",
    "skillPolicy",
    "initialSkills",
    "modelingGuidance",
    "operatorEntries",
    "operator",
    "caseFlows",
    "behaviors",
  ]);
  modelIdentity(v.identity);
  const version = object(v.version, [
    "digest",
    "rootId",
    "configurationId",
    "configurationRevision",
    "sourceIds",
    "authoritySchema",
    "repositoryVersion",
  ]);
  hash(version.digest);
  text(version.rootId);
  text(version.configurationId);
  integer(version.configurationRevision);
  if (
    version.authoritySchema !== 2 ||
    !exactSourceVersion(version.repositoryVersion) ||
    !Array.isArray(version.sourceIds)
  ) invalid("complete schema-2 executable version required");
  for (const id of version.sourceIds) text(id);
  owner(v.ownerAuthority);
  const operator = object(v.operator, [
    "name",
    "instruction",
    "primary",
    "humanInput",
  ]);
  text(operator.name);
  if (
    typeof operator.instruction !== "string" || !operator.instruction.trim() ||
    typeof operator.primary !== "boolean" ||
    typeof operator.humanInput !== "boolean"
  ) invalid("complete operator instruction required");
  const configuration = object(v.configuration, [
    "envelope",
    "id",
    "revision",
    "builder",
    "changes",
  ], ["network", "reviewer"]);
  text(configuration.id);
  integer(configuration.revision);
  if (
    !configuration.envelope || typeof configuration.envelope !== "object" ||
    !configuration.builder || typeof configuration.builder !== "object" ||
    !Array.isArray(configuration.changes) || !v.mandate ||
    typeof v.mandate !== "object" || !v.policy ||
    typeof v.policy !== "object" || !Array.isArray(v.contracts) ||
    !Array.isArray(v.catalog)
  ) invalid("complete executable contracts required");
  const flows = object(v.flows, ["conversation", "promotion"]);
  for (const flow of Object.values(flows)) {
    if (
      !flow || typeof flow !== "object" ||
      !Array.isArray((flow as Record<string, unknown>).nodes) ||
      !Array.isArray((flow as Record<string, unknown>).edges) ||
      !Array.isArray((flow as Record<string, unknown>).bindings)
    ) invalid("complete executable flows required");
  }
  for (const [key, item] of Object.entries(v)) {
    if (
      [
        "toolAdmissionPolicies",
        "operatorCreationPolicies",
        "operatorAuthorityPolicies",
        "modelEditingAuthorityRoots",
        "caseTypes",
        "workResultContracts",
        "initialTools",
        "initialSkills",
        "modelingGuidance",
        "operatorEntries",
        "behaviors",
      ].includes(key) && !Array.isArray(item)
    ) invalid("complete optional executable collection required");
  }
  return value as ExecutableModel;
}
/** Pure byte preservation compares every model field other than the exact admitted
 * instruction and source/configuration version counters. No policy/flow/resource
 * key is projected away. Reject missing optional facts rather than synthesize them. */
export async function requestInstructionCompatibility(
  previous: ExecutableModel,
  candidate: ExecutableModel,
): Promise<string> {
  const before = executableModel(structuredClone(previous)),
    after = executableModel(structuredClone(candidate));
  if (
    !before.operator || !after.operator ||
    before.operator.instruction === after.operator.instruction ||
    typeof after.operator.instruction !== "string" ||
    !after.operator.instruction.trim() ||
    before.version.digest === after.version.digest ||
    before.version.authoritySchema !== 2 ||
    after.version.authoritySchema !== 2 || !before.ownerAuthority ||
    !after.ownerAuthority || before.ownerAuthority.ownerSource !== "modeled" ||
    !sameOwnerAuthorityIdentity(before.ownerAuthority, after.ownerAuthority)
  ) invalid("genuine instruction-only change required");
  const beforeFlowDigest = await nativeFlowContractDigest(before),
    afterFlowDigest = await nativeFlowContractDigest(after);
  const structural = (model: ExecutableModel, flowDigest: string) => {
    const {
      digest: _digest,
      repositoryVersion: _source,
      configurationRevision: _revision,
      ...version
    } = model.version;
    const { revision: _configurationRevision, ...configuration } =
      model.configuration;
    return {
      ...model,
      flows: flowDigest,
      caseFlows: undefined,
      version,
      configuration,
      operator: { ...model.operator, instruction: null },
    };
  };
  if (
    canonical(structural(before, beforeFlowDigest)) !==
      canonical(structural(after, afterFlowDigest))
  ) invalid("non-instruction contract changed");
  return await canonicalDigest({
    format: "request-instruction-compatibility/v1",
    previous: before,
    candidate: after,
  });
}

/** The recorded requester selects the target; human BO intents keep their historical path. */
export function adoptionRequester(intent: RequestAdoptionIntent) {
  return intent.decision.kind === "request-human-adoption-decision"
    ? undefined
    : scopedOperator({
      ...intent.previous.identity,
      executionSpaceId: intent.target.executionSpaceId,
    }, intent.target.operatorId);
}

/** Publication proves the retained member digest at A; BO and human decisions keep A=R. */
function exactChangeBase(
  change: PendingChange,
  model: ExecutableModel,
): boolean {
  const base = change.diff?.base;
  // RequestSpaceAuthorityBridge verifies member admission before publication.
  const team = model.operatorTeam;
  return change.requestedBy === model.identity.builderId &&
    change.baseRevision === model.configuration.revision &&
    change.baseModelDigest === model.version.digest &&
    base?.modelDigest === model.version.digest &&
    exactSourceVersion(base.repositoryVersion) &&
    (change.authority !== "human" &&
        !!team && team.requestOwnerId !== model.identity.builderId ||
      base.repositoryVersion === model.version.repositoryVersion);
}

/** Only the explicitly approved additive host delta and its source counters may change. */
export async function requestNetworkCompatibility(
  previous: ExecutableModel,
  candidate: ExecutableModel,
  change: PendingChange,
): Promise<string> {
  const before = executableModel(structuredClone(previous));
  const after = executableModel(structuredClone(candidate));
  change = structuredClone(change);
  assertRequestNetworkChange(change);
  const approvedHosts = change.requestedRights.addNetworkHosts;
  const additions =
    validateNetworkScope({ allowedHosts: [...approvedHosts] }).allowedHosts;
  const oldNetwork = validateNetworkScope(before.configuration.network);
  const nextNetwork = validateNetworkScope(after.configuration.network);
  if (
    change.status !== "approved" || !decidedByNetworkAuthority(change) ||
    !change.decidedAt || !Number.isFinite(Date.parse(change.decidedAt)) ||
    !exactChangeBase(change, before) ||
    !before.policy.mayAddNetworkHosts || !additions.length ||
    additions.length > MAX_NETWORK_HOST_ADDITIONS ||
    additions.some((host) => oldNetwork.allowedHosts.includes(host)) ||
    canonical(nextNetwork.allowedHosts) !==
      canonical([...oldNetwork.allowedHosts, ...additions]) ||
    canonical(before.mandate.network) !== canonical(oldNetwork) ||
    canonical(after.mandate.network) !== canonical(nextNetwork) ||
    before.version.digest === after.version.digest ||
    before.version.authoritySchema !== 2 ||
    after.version.authoritySchema !== 2 ||
    !before.ownerAuthority || !after.ownerAuthority ||
    before.ownerAuthority.ownerSource !== "modeled" ||
    !sameOwnerAuthorityIdentity(before.ownerAuthority, after.ownerAuthority) ||
    before.version.configurationRevision !== before.configuration.revision ||
    after.version.configurationRevision !== after.configuration.revision ||
    after.configuration.revision !== before.configuration.revision + 1 ||
    after.configuration.builder.mandateRevision !==
      before.configuration.builder.mandateRevision + 1 ||
    after.mandate.id !==
      `builder-v${after.configuration.builder.mandateRevision}`
  ) invalid("exact approved network addition required");
  const beforeFlow = await nativeFlowContractDigest(before);
  const afterFlow = await nativeFlowContractDigest(after);
  const structural = (model: ExecutableModel, flow: string) => {
    const {
      digest: _digest,
      repositoryVersion: _source,
      configurationRevision: _revision,
      ...version
    } = model.version;
    const {
      revision: _configurationRevision,
      network: _network,
      builder,
      ...configuration
    } = model.configuration;
    const { mandateRevision: _mandateRevision, ...builderRest } = builder;
    const { id: _id, network: _mandateNetwork, ...mandate } = model.mandate;
    return {
      ...model,
      flows: flow,
      caseFlows: undefined,
      version,
      configuration: { ...configuration, builder: builderRest },
      mandate,
    };
  };
  if (
    canonical(structural(before, beforeFlow)) !==
      canonical(structural(after, afterFlow))
  ) {
    invalid("non-network contract changed");
  }
  return await canonicalDigest({
    format: "request-network-compatibility/v1",
    previous: before,
    candidate: after,
    approvedHosts: additions,
  });
}

/** Only the person's exact first grant and its source counters may change. */
export async function requestCreationPolicyCompatibility(
  previous: ExecutableModel,
  candidate: ExecutableModel,
  change: PendingChange,
): Promise<string> {
  const before = executableModel(structuredClone(previous));
  const after = executableModel(structuredClone(candidate));
  change = structuredClone(change);
  assertRequestCreationPolicyChange(change);
  const request = change.requestedRights.operatorCreation;
  const oldPolicies = before.operatorCreationPolicies ?? [];
  const nextPolicies = after.operatorCreationPolicies ?? [];
  const added = nextPolicies.filter((policy) =>
    !oldPolicies.some((old) => old.id === policy.id)
  );
  const grant = added[0];
  const policyId = await requestedCreationPolicyId(change.id);
  const systemName = before.identity.systemQualifiedName;
  const policyRoot = `${systemName}::${spellSysmlQualifiedName([policyId])}`;
  const previousRoots = before.modelEditingAuthorityRoots ?? [];
  const nextRoots = after.modelEditingAuthorityRoots ?? [];
  if (
    change.status !== "approved" || change.authority !== "human" ||
    !change.decidedAt || !Number.isFinite(Date.parse(change.decidedAt)) ||
    !exactChangeBase(change, before) || before.operatorTeam ||
    oldPolicies.some((policy) => policy.enabled) ||
    nextPolicies.length !== oldPolicies.length + 1 || added.length !== 1 ||
    oldPolicies.some((policy) =>
      canonical(nextPolicies.find((next) => next.id === policy.id)) !==
        canonical(policy)
    ) ||
    !grant || grant.id !== policyId || !systemName ||
    previousRoots.includes(policyRoot) ||
    canonical([...nextRoots].sort()) !==
      canonical([...previousRoots, policyRoot].sort()) ||
    grant.revision !== 1 || !grant.enabled || grant.children.length !== 0 ||
    grant.holderNativeId !== before.identity.builderId ||
    grant.systemId !== before.identity.systemId || !grant.mandateNativeId ||
    grant.parentPolicyElementId !== undefined ||
    grant.maxDelegationDepth !== 0 ||
    grant.maxChildren !== request.maxChildren || grant.mode !== request.mode ||
    canonical(grant.networkHosts) !== canonical(request.networkHosts) ||
    request.networkHosts.some((host) =>
      !(before.configuration.network?.allowedHosts ?? []).includes(host)
    ) ||
    !grant.rootAuthority || !before.ownerAuthority || !after.ownerAuthority ||
    !sameOwnerAuthorityIdentity(grant.rootAuthority, before.ownerAuthority) ||
    !sameOwnerAuthorityIdentity(before.ownerAuthority, after.ownerAuthority) ||
    before.ownerAuthority.ownerSource !== "modeled" ||
    before.version.digest === after.version.digest ||
    before.version.authoritySchema !== 2 ||
    after.version.authoritySchema !== 2 ||
    before.version.configurationRevision !== before.configuration.revision ||
    after.version.configurationRevision !== after.configuration.revision ||
    after.configuration.revision !== before.configuration.revision + 1 ||
    after.configuration.builder.mandateRevision !==
      before.configuration.builder.mandateRevision + 1 ||
    after.mandate.id !==
      `builder-v${after.configuration.builder.mandateRevision}` ||
    before.version.sourceIds.some((id) => !after.version.sourceIds.includes(id))
  ) invalid("exact approved creation policy required");
  const structural = (model: ExecutableModel, flow: string) => {
    const {
      digest: _digest,
      repositoryVersion: _source,
      configurationRevision: _revision,
      sourceIds: _sourceIds,
      ...version
    } = model.version;
    const { revision: _configurationRevision, builder, ...configuration } =
      model.configuration;
    const { mandateRevision: _mandateRevision, ...builderRest } = builder;
    const { id: _id, ...mandate } = model.mandate;
    return {
      ...model,
      flows: flow,
      caseFlows: undefined,
      version,
      configuration: { ...configuration, builder: builderRest },
      mandate,
      operatorCreationPolicies: undefined,
      modelEditingAuthorityRoots: undefined,
    };
  };
  if (
    canonical(structural(before, await nativeFlowContractDigest(before))) !==
      canonical(structural(after, await nativeFlowContractDigest(after)))
  ) {
    invalid("non-creation-policy contract changed");
  }
  return await canonicalDigest({
    format: "request-creation-policy-compatibility/v1",
    previous: before,
    candidate: after,
    requestedGrant: request,
  });
}

/** Only one new child slot in the creator's policy, its one parent→child
 * access and the source counters may change (spec 4.8e E4). The child's
 * provisioned values are verified at publication and by `branchTeam`'s
 * receipt check; this gate pins the creator-side delta. */
export async function requestTeamCompatibility(
  previous: ExecutableModel,
  candidate: ExecutableModel,
  change: PendingChange,
  publicationBase?: ExecutableModel,
): Promise<string> {
  const before = executableModel(structuredClone(previous));
  const after = executableModel(structuredClone(candidate));
  const published = publicationBase === undefined
    ? undefined
    : executableModel(structuredClone(publicationBase));
  change = structuredClone(change);
  assertRequestTeamChange(change);
  if (published) {
    assertRequestTeamPublicationBase(
      published,
      change.diff?.base.repositoryVersion ?? "",
      { identity: before.identity, version: before.version },
    );
    // RequestSpaceAuthorityBridge verifies the roster before this pin comparison.
    const memberTeam = before.operatorTeam;
    if (
      change.authority !== "builder" || !memberTeam ||
      memberTeam.requestOwnerId === before.identity.builderId ||
      published.version.repositoryVersion ===
        before.version.repositoryVersion ||
      published.version.repositoryVersion === after.version.repositoryVersion ||
      !onlyFreshSystemRoots(before, published)
    ) invalid("exact member publication base required");
    const unchanged = (model: ExecutableModel, flow: string) => {
      const { repositoryVersion: _repositoryVersion, ...version } =
        model.version;
      return {
        ...model,
        version,
        flows: flow,
        caseFlows: undefined,
        modelEditingAuthorityRoots: undefined,
      };
    };
    if (
      canonical(unchanged(before, await nativeFlowContractDigest(before))) !==
        canonical(
          unchanged(published, await nativeFlowContractDigest(published)),
        )
    ) invalid("member contract changed before publication");
  }
  if (
    change.status !== "approved" || !decidedByTeamAuthority(change) ||
    !change.decidedAt || !Number.isFinite(Date.parse(change.decidedAt)) ||
    !exactChangeBase(change, before) ||
    before.version.digest === after.version.digest ||
    before.version.authoritySchema !== 2 ||
    after.version.authoritySchema !== 2 ||
    !before.ownerAuthority || !after.ownerAuthority ||
    before.ownerAuthority.ownerSource !== "modeled" ||
    !sameOwnerAuthorityIdentity(before.ownerAuthority, after.ownerAuthority) ||
    before.version.configurationRevision !== before.configuration.revision ||
    after.version.configurationRevision !== after.configuration.revision ||
    after.configuration.revision !== before.configuration.revision + 1 ||
    after.configuration.builder.mandateRevision !==
      before.configuration.builder.mandateRevision + 1 ||
    after.mandate.id !==
      `builder-v${after.configuration.builder.mandateRevision}` ||
    before.version.sourceIds.some((id) => !after.version.sourceIds.includes(id))
  ) invalid("exact approved team creation required");
  // Exactly one policy gains exactly one child system; a creation receipt
  // names that policy. No other policy field moves.
  const receipt = change.authorityExercise?.creationDelegation;
  const beforePolicies = before.operatorCreationPolicies ?? [];
  const afterPolicies = after.operatorCreationPolicies ?? [];
  if (beforePolicies.length !== afterPolicies.length) {
    invalid("exact approved team creation required");
  }
  const grown = afterPolicies.filter((policy, index) => {
    const prior = beforePolicies[index];
    return canonical(policy.children) !== canonical(prior.children);
  });
  if (grown.length !== 1) invalid("exact approved team creation required");
  const grownIndex = afterPolicies.indexOf(grown[0]);
  const priorPolicy = beforePolicies[grownIndex];
  const addedChildren = grown[0].children.filter((child) =>
    !priorPolicy.children.includes(child)
  );
  if (
    grown[0].children.length !== priorPolicy.children.length + 1 ||
    addedChildren.length !== 1 ||
    receipt && receipt.policyId !== grown[0].id ||
    canonical({ ...grown[0], children: priorPolicy.children }) !==
      canonical(priorPolicy)
  ) invalid("exact approved team creation required");
  const childSystemId = addedChildren[0];
  // Exactly one new behavior: this creator contributing to the child.
  const beforeBehaviors = before.behaviors ?? [];
  const afterBehaviors = after.behaviors ?? [];
  const addedBehaviors = afterBehaviors.filter((behavior) =>
    !beforeBehaviors.some((prior) => canonical(prior) === canonical(behavior))
  );
  if (
    afterBehaviors.length !== beforeBehaviors.length + 1 ||
    addedBehaviors.length !== 1 ||
    addedBehaviors[0].callerNativeId !== before.identity.builderId ||
    beforeBehaviors.some((behavior) =>
      !afterBehaviors.some((next) => canonical(next) === canonical(behavior))
    )
  ) invalid("exact approved team creation required");
  // The child system brings its own model-editing authority roots; nothing
  // else may add or remove one.
  if (!onlyOneNewSystemRoots(published ?? before, after)) {
    invalid("non-team contract changed");
  }
  const beforeFlow = await nativeFlowContractDigest(before);
  const afterFlow = await nativeFlowContractDigest(after);
  const structural = (model: ExecutableModel, flow: string) => {
    const {
      digest: _digest,
      repositoryVersion: _source,
      configurationRevision: _revision,
      sourceIds: _sourceIds,
      ...version
    } = model.version;
    const { revision: _configurationRevision, builder, ...configuration } =
      model.configuration;
    const { mandateRevision: _mandateRevision, ...builderRest } = builder;
    const { id: _id, ...mandate } = model.mandate;
    return {
      ...model,
      flows: flow,
      caseFlows: undefined,
      version,
      configuration: { ...configuration, builder: builderRest },
      mandate,
      operatorCreationPolicies: (model.operatorCreationPolicies ?? []).map(
        (policy) => ({ ...policy, children: [] as string[] }),
      ),
      behaviors: undefined,
      modelEditingAuthorityRoots: undefined,
    };
  };
  if (
    canonical(structural(before, beforeFlow)) !==
      canonical(structural(after, afterFlow))
  ) invalid("non-team contract changed");
  return await canonicalDigest({
    format: "request-team-compatibility/v1",
    previous: before,
    candidate: after,
    childSystemId,
    ...(published ? { publicationBase: published } : {}),
  });
}

/** The optional member baseline is independently joined to the publication's
 * exact predecessor at each durable boundary; its mere presence grants nothing. */
export function assertRequestTeamPublicationBase(
  base: ExecutableModel | undefined,
  sourceVersion: string,
  prior: { identity: ExecutableModel["identity"]; version: { digest: string } },
): void {
  if (base === undefined) return;
  const model = executableModel(base);
  if (
    !exactSourceVersion(sourceVersion) ||
    model.version.repositoryVersion !== sourceVersion ||
    model.version.digest !== prior.version.digest ||
    canonical(model.identity) !== canonical(prior.identity)
  ) {
    invalid(
      "team publication base differs from its exact predecessor and prior model",
    );
  }
}

/** A retained member can observe whole new sibling systems at A, never a
 * removal or another root under a system already present at R. */
function onlyFreshSystemRoots(
  before: ExecutableModel,
  after: ExecutableModel,
): boolean {
  const prior = before.modelEditingAuthorityRoots ?? [];
  const next = after.modelEditingAuthorityRoots ?? [];
  if (prior.some((root) => !next.includes(root))) return false;
  const systemOf = (root: string) => root.split("::").slice(0, 2).join("::");
  const systems = new Set(prior.map(systemOf));
  return next.filter((root) => !prior.includes(root)).every((root) =>
    root.split("::").length > 2 && !systems.has(systemOf(root))
  );
}
/** Every other operator executes exactly as before a Request change whose
 * target delta has already been verified. Authority roots are global: each
 * gains exactly the roots the changed operator gained, and nothing else moves. Source
 * positions of a bystander shift when a sibling part is inserted, so its
 * executable, not its source facts, is compared. */
export function requestChangeBystanders(
  creatorBefore: ExecutableModel,
  creatorAfter: ExecutableModel,
  before: readonly ExecutableModel[],
  after: readonly ExecutableModel[],
): void {
  const priorRoots = creatorBefore.modelEditingAuthorityRoots ?? [];
  const added = (creatorAfter.modelEditingAuthorityRoots ?? []).filter((
    root,
  ) => !priorRoots.includes(root));
  if (before.length !== after.length) {
    invalid("a Request change cannot add or remove another operator");
  }
  for (const prior of before) {
    const next = after.filter((model) =>
      model.identity.builderId === prior.identity.builderId
    );
    if (next.length !== 1) {
      invalid("a Request change cannot add or remove another operator");
    }
    const roots = prior.modelEditingAuthorityRoots ?? [];
    const expected = [...roots, ...added].sort();
    // Before and after are read at two source versions.
    const without = (model: ExecutableModel) => {
      const { modelEditingAuthorityRoots: _roots, version, ...rest } = model;
      const { repositoryVersion: _version, ...pin } = version;
      return { ...rest, version: pin };
    };
    if (
      canonical([...next[0].modelEditingAuthorityRoots ?? []].sort()) !==
        canonical(expected) ||
      canonical(without(prior)) !== canonical(without(next[0]))
    ) invalid("a Request change cannot alter another operator");
  }
}

/** Every prior model-editing authority root stays; the added ones all
 * belong to one system part (`Package::part::…`) no prior root named. */
function onlyOneNewSystemRoots(
  before: ExecutableModel,
  after: ExecutableModel,
): boolean {
  const prior = before.modelEditingAuthorityRoots ?? [];
  const next = after.modelEditingAuthorityRoots ?? [];
  if (prior.some((root) => !next.includes(root))) return false;
  const added = next.filter((root) => !prior.includes(root));
  if (added.length === 0) return true;
  const systemOf = (root: string) => root.split("::").slice(0, 2).join("::");
  const system = systemOf(added[0]);
  return added.every((root) =>
    root.split("::").length > 2 && systemOf(root) === system
  ) && !prior.some((root) => systemOf(root) === system);
}

export async function parseRequestAdoptionIntent(
  value: unknown,
): Promise<RequestAdoptionIntent> {
  const snapshot = structuredClone(value),
    v = object(snapshot, [
      "target",
      "openingBaseDigest",
      "adoptionKey",
      "commandDigest",
      "accountingDigest",
      "previous",
      "candidate",
      "decision",
    ], ["network", "team", "creationPolicy"]);
  const target = parseRequestAdoptionTarget(v.target);
  hash(v.openingBaseDigest);
  text(v.adoptionKey);
  hash(v.commandDigest);
  hash(v.accountingDigest);
  const before = object(v.previous, ["pin", "identity", "admission"]);
  pin(before.pin, target.repositoryId);
  const identity = modelIdentity(before.identity);
  const oldPin = before.pin as RequestAdoptionIntent["previous"]["pin"];
  const admission = object(before.admission, [
    "id",
    "scope",
    "executionSpaceId",
    "openingId",
    "ownerId",
    "capabilityId",
    "capabilityRevision",
    "baseDigest",
    "authority",
    "permissions",
    "revision",
    "status",
    "expiresAt",
    "createdAt",
  ]);
  text(admission.id);
  integer(admission.revision);
  integer(admission.capabilityRevision);
  time(admission.expiresAt);
  time(admission.createdAt);
  const permission = object(admission.permissions, [
    "operatorIds",
    "acts",
    "sourceVersion",
    "modelDigests",
    "resourceIds",
  ]);
  const decision = parseRequestAdoptionDecision(v.decision),
    c = decision.kind === "request-human-adoption-decision"
      ? decision.controller
      : undefined;
  if (
    admission.status !== "active" ||
    canonical(admission.scope) !== canonical(target.host) ||
    admission.executionSpaceId !== target.executionSpaceId ||
    admission.openingId !== target.openingId ||
    // The deciding person, not their credential: the admission keeps the
    // capability that opened the Request; the decider's own capability and
    // session are checked current at the final commit cutoff.
    c && !sameSpaceControlPrincipal(
        admission as unknown as RequestAdoptionIntent["previous"]["admission"],
        c,
      ) ||
    admission.baseDigest !== v.openingBaseDigest ||
    // The previous admission names the whole branch team (E3/E4): the
    // executing owner first, then at most MAX_BRANCH_TEAM members, each
    // with its exact executing model digest.
    !Array.isArray(permission.operatorIds) ||
    permission.operatorIds.length < 1 ||
    permission.operatorIds.length > MAX_BRANCH_TEAM + 1 ||
    !(permission.operatorIds as unknown[]).includes(target.operatorId) ||
    decision.kind === "request-delegated-adoption-decision" &&
      (permission.operatorIds as unknown[]).indexOf(target.operatorId) > 0 &&
      !decision.route ||
    decision.kind === "request-human-adoption-decision" &&
      (permission.operatorIds as unknown[])[0] !== target.operatorId ||
    new Set(permission.operatorIds as unknown[]).size !==
      (permission.operatorIds as unknown[]).length ||
    (permission.operatorIds as unknown[]).some((id) =>
      typeof id !== "string" || !id
    ) ||
    canonical(permission.acts) !== canonical(["conversation"]) ||
    (permission.operatorIds as unknown[])[0] === target.operatorId &&
      permission.sourceVersion !== oldPin.source.version ||
    !Array.isArray(permission.modelDigests) ||
    permission.modelDigests.length !==
      (permission.operatorIds as unknown[]).length ||
    (permission.modelDigests as unknown[])[
        (permission.operatorIds as unknown[]).indexOf(target.operatorId)
      ] !== oldPin.modelDigest ||
    (permission.modelDigests as unknown[]).some((digest) =>
      !isSha256Hex(digest)
    ) ||
    !Array.isArray(permission.resourceIds) ||
    permission.resourceIds.length > 256 ||
    permission.resourceIds.some((id: unknown) =>
      typeof id !== "string" || !/^retained-tool:v1:[a-f0-9]{64}$/.test(id)
    ) ||
    new Set(permission.resourceIds).size !== permission.resourceIds.length
  ) invalid("unchanged exact admission required");
  const candidate = object(v.candidate, [
      "source",
      "sourceDigest",
      "sourceAdmission",
      "build",
      "model",
      "compatibilityDigest",
    ]),
    candidateSource = source(candidate.source, target.repositoryId);
  const model = executableModel(candidate.model);
  const sourceAdmission = object(candidate.sourceAdmission, [
    "revision",
    "manifestDigest",
  ]);
  integer(sourceAdmission.revision, 2);
  hash(sourceAdmission.manifestDigest);
  if (
    [v.network, v.team, v.creationPolicy].filter((proof) => proof !== undefined)
      .length > 1
  ) {
    invalid("one change effect required");
  }
  if (v.creationPolicy !== undefined) {
    const proof = object(v.creationPolicy, [
      "kind",
      "changeId",
      "proposalIntentDigest",
      "approvedChangeDigest",
      "sourceAdmission",
    ]);
    const receipt = object(proof.sourceAdmission, [
      "revision",
      "manifestDigest",
      "commandId",
      "publicationReceiptDigest",
      "resultVersion",
    ]);
    if (
      proof.kind !== "request-creation-policy-adoption/v1" ||
      decision.kind !== "request-human-adoption-decision"
    ) {
      invalid("human creation policy proof required");
    }
    text(proof.changeId);
    hash(proof.proposalIntentDigest);
    hash(proof.approvedChangeDigest);
    integer(receipt.revision, 2);
    hash(receipt.manifestDigest);
    hash(receipt.publicationReceiptDigest);
    if (
      receipt.commandId !== proof.changeId ||
      receipt.revision !== sourceAdmission.revision ||
      receipt.manifestDigest !== sourceAdmission.manifestDigest ||
      receipt.resultVersion !== candidateSource.version
    ) {
      invalid("creation policy source receipt differs");
    }
  }
  if (v.network !== undefined) {
    const network = object(v.network, [
      "kind",
      "changeId",
      "proposalIntentDigest",
      "approvedChangeDigest",
      "addedHosts",
      "sourceAdmission",
    ]);
    const receipt = object(network.sourceAdmission, [
      "revision",
      "manifestDigest",
      "commandId",
      "publicationReceiptDigest",
      "resultVersion",
    ]);
    if (network.kind !== "request-network-host-adoption/v1") {
      invalid("network proof kind required");
    }
    text(network.changeId);
    hash(network.proposalIntentDigest);
    hash(network.approvedChangeDigest);
    if (
      !Array.isArray(network.addedHosts) || !network.addedHosts.length ||
      network.addedHosts.length > MAX_NETWORK_HOST_ADDITIONS
    ) invalid("bounded network additions required");
    validateNetworkScope({ allowedHosts: network.addedHosts });
    integer(receipt.revision, 2);
    hash(receipt.manifestDigest);
    hash(receipt.publicationReceiptDigest);
    if (
      receipt.commandId !== network.changeId ||
      receipt.revision !== sourceAdmission.revision ||
      receipt.manifestDigest !== sourceAdmission.manifestDigest ||
      receipt.resultVersion !== candidateSource.version
    ) invalid("network source receipt differs");
  }
  if (v.team !== undefined) {
    const team = object(v.team, [
      "kind",
      "changeId",
      "proposalIntentDigest",
      "approvedChangeDigest",
      "childSystemId",
      "team",
      "sourceAdmission",
    ], ["publicationBase"]);
    if (
      !Array.isArray(team.team) || team.team.length < 1 ||
      team.team.length > MAX_BRANCH_TEAM ||
      new Set(team.team.map((member) => member.operatorId)).size !==
        team.team.length
    ) invalid("exact candidate branch team required");
    for (const member of team.team) {
      const entry = object(member, ["operatorId", "modelDigest"]);
      text(entry.operatorId);
      hash(entry.modelDigest);
    }
    const receipt = object(team.sourceAdmission, [
      "revision",
      "manifestDigest",
      "commandId",
      "publicationReceiptDigest",
      "resultVersion",
    ]);
    if (team.kind !== "request-team-creation-adoption/v1") {
      invalid("team proof kind required");
    }
    text(team.changeId);
    text(team.childSystemId);
    hash(team.proposalIntentDigest);
    hash(team.approvedChangeDigest);
    integer(receipt.revision, 2);
    hash(receipt.manifestDigest);
    hash(receipt.publicationReceiptDigest);
    if (
      receipt.commandId !== team.changeId ||
      receipt.revision !== sourceAdmission.revision ||
      receipt.manifestDigest !== sourceAdmission.manifestDigest ||
      receipt.resultVersion !== candidateSource.version
    ) invalid("team source receipt differs");
    if (team.publicationBase !== undefined) {
      const publicationBase = executableModel(team.publicationBase);
      const publicationTeam = publicationBase.operatorTeam;
      if (
        decision.kind !== "request-creation-grant-adoption-decision" ||
        (permission.operatorIds as string[]).indexOf(target.operatorId) <= 0 ||
        canonical(publicationBase.identity) !== canonical(identity) ||
        publicationBase.version.digest !== oldPin.modelDigest ||
        publicationBase.version.repositoryVersion === oldPin.source.version ||
        publicationBase.version.repositoryVersion === candidateSource.version ||
        canonical(publicationBase.operatorTeam) !==
          canonical(model.operatorTeam) ||
        !publicationTeam ||
        publicationTeam.requestOwnerId !==
          (permission.operatorIds as string[])[0]
      ) invalid("exact admitted member publication base required");
    }
  }
  hash(candidate.sourceDigest);
  hash(candidate.compatibilityDigest);
  const build = parseBuildDescriptorStrict(candidate.build);
  if (
    build.repositoryId !== target.repositoryId ||
    build.sourceDigest !== candidate.sourceDigest ||
    await recipeDigest(build.recipe) !== build.recipe.digest ||
    await buildKey(build.sourceDigest, build.recipe.digest) !== build.buildKey
  ) invalid("exact candidate build required");
  if (
    !model || typeof model !== "object" || !model.version || !model.operator ||
    !model.ownerAuthority
  ) invalid("complete candidate model required");
  hash(model.version.digest);
  modelIdentity(model.identity);
  owner(model.ownerAuthority);
  if (
    model.version.authoritySchema !== 2 ||
    model.version.repositoryVersion !== candidateSource.version ||
    model.version.digest === oldPin.modelDigest ||
    candidateSource.version === oldPin.source.version ||
    canonical(model.identity) !== canonical(identity) ||
    identity.projectId !== `git:${target.repositoryId}` ||
    identity.builderId !== target.operatorId ||
    decision.exercise.systemId !== identity.systemId ||
    decision.exercise.baseModelDigest !== oldPin.modelDigest ||
    !sameOwnerAuthorityIdentity(decision.exercise, model.ownerAuthority) ||
    (c
      ? canonical(c.authority.scope) !== canonical(target.host) ||
        c.authority.sourceSystemNativeId !== identity.systemId
      : decision.kind === "request-creation-grant-adoption-decision"
      // A creation-grant decision adopts only its own provisioned teammate.
      ? v.team === undefined ||
        (v.team as { changeId?: unknown }).changeId !==
          decision.exercise.creationDelegation!.changeId ||
        decision.exercise.creationDelegation!.actorId !== target.operatorId ||
        decision.exercise.creationDelegation!.caseId !== target.caseId
      // A delegated decision adopts only its own approved network delta.
      : v.network === undefined ||
        (v.network as { changeId?: unknown }).changeId !==
          decision.exercise.delegation!.changeId ||
        decision.exercise.delegation!.requester!.executionSpaceId !==
          target.executionSpaceId ||
        decision.exercise.delegation!.requester!.operatorId !==
          target.operatorId)
  ) invalid("prior authority/exact target join required");
  const { commandDigest, accountingDigest: _accountingDigest, ...immutable } =
    v;
  if (await canonicalDigest(immutable) !== commandDigest) {
    invalid("immutable intent digest differs");
  }
  return snapshot as RequestAdoptionIntent;
}
export function assertSameRequestAdoptionCompletion(
  intent: RequestAdoptionIntent,
  value: unknown,
): RequestAdoptionDecision {
  const next = parseRequestAdoptionDecision(value), previous = intent.decision;
  if (previous.kind === "request-delegated-adoption-decision") {
    // A new capture includes the real route even when completing an old
    // Main-to-BO intent. Its authority digest and exercise stay exact; the
    // validated addition never rewrites the historical intent. Once recorded,
    // a route cannot be dropped or replaced.
    const legacyMainOwner = previous.route === undefined &&
      previous.exercise.delegation?.actor?.executionSpaceId === "main" &&
      intent.previous.admission.permissions.operatorIds[0] ===
        intent.target.operatorId;
    if (
      next.kind !== previous.kind ||
      next.authorityDigest !== previous.authorityDigest ||
      !legacyMainOwner && canonical(next.route) !== canonical(previous.route) ||
      canonical(next.exercise) !== canonical(previous.exercise)
    ) invalid("same original delegated decision required");
    return next;
  }
  if (previous.kind === "request-creation-grant-adoption-decision") {
    if (
      next.kind !== previous.kind ||
      next.authorityDigest !== previous.authorityDigest ||
      canonical(next.exercise) !== canonical(previous.exercise)
    ) invalid("same original creation-grant decision required");
    return next;
  }
  // The same person and exact exercise, through any current credential.
  if (
    next.kind !== previous.kind ||
    !sameSpaceControlPrincipal(next.controller, previous.controller) ||
    canonical(next.exercise) !== canonical(previous.exercise)
  ) invalid("same original human intent/principal required");
  return next;
}
export async function requestAdoptionReceiptDigest(
  input: Omit<RequestAdoptionReceipt, "receiptDigest">,
): Promise<string> {
  return await canonicalDigest(input);
}
export async function parseRequestAdoptionReceipt(
  value: unknown,
): Promise<RequestAdoptionReceipt> {
  const snapshot = structuredClone(value),
    v = object(snapshot, [
      "commandId",
      "receiptDigest",
      "committedRuntimeRevision",
      "journalRevision",
      "journalDigest",
      "recordedAt",
    ]);
  text(v.commandId);
  hash(v.receiptDigest);
  hash(v.journalDigest);
  integer(v.committedRuntimeRevision, 2);
  integer(v.journalRevision, 3);
  time(v.recordedAt);
  const { receiptDigest, ...payload } = v;
  if (await canonicalDigest(payload) !== receiptDigest) {
    invalid("receipt digest differs");
  }
  return snapshot as RequestAdoptionReceipt;
}
export async function parseRequestOwnerAdoptionDossier(
  value: unknown,
): Promise<RequestOwnerAdoptionDossier> {
  const snapshot = structuredClone(value),
    v = object(snapshot, [
      "v",
      "kind",
      "id",
      "repositoryId",
      "revision",
      "status",
      "createdAt",
      "updatedAt",
      "intent",
      "blockers",
    ], ["completion", "receipt"]);
  if (
    v.v !== 2 || v.kind !== "request-owner-adoption" ||
    !["prepared", "armed", "adopted", "refused", "cancelled"].includes(
      String(v.status),
    )
  ) invalid("closed Request dossier required");
  text(v.id);
  text(v.repositoryId);
  integer(v.revision);
  time(v.createdAt);
  time(v.updatedAt);
  const intent = await parseRequestAdoptionIntent(v.intent);
  const expectedId = `request-adoption:${await canonicalDigest({
    host: intent.target.host,
    ownerId: requestAdoptionOwnerId(intent),
    openingId: intent.target.openingId,
    adoptionKey: intent.adoptionKey,
  })}`;
  if (v.id !== expectedId) invalid("stable Request adoption identity differs");
  if (
    intent.accountingDigest !==
      await canonicalDigest({
        id: `evolution:${v.repositoryId}:${v.id}`,
        agentInvocations: 0,
      })
  ) invalid("accounting identity differs");
  if (
    intent.target.repositoryId !== v.repositoryId ||
    !Array.isArray(v.blockers) || v.blockers.length > 256
  ) invalid("dossier target/blockers differ");
  for (const blocker of v.blockers) {
    const b = object(blocker, ["code", "detail"], ["operatorId"]);
    text(b.code);
    text(b.detail);
    if (
      b.operatorId !== undefined && b.operatorId !== intent.target.operatorId
    ) invalid("foreign blocker");
  }
  if (v.completion !== undefined) {
    assertSameRequestAdoptionCompletion(intent, v.completion);
  }
  if (v.receipt !== undefined) {
    const receipt = await parseRequestAdoptionReceipt(v.receipt);
    if (receipt.commandId !== v.id || v.status !== "adopted" || !v.completion) {
      invalid("completion receipt required");
    }
  }
  if (
    (v.status === "adopted") !== (v.receipt !== undefined) ||
    v.status === "armed" && !v.completion
  ) invalid("dossier phase evidence differs");
  return snapshot as RequestOwnerAdoptionDossier;
}
export async function assertRequestOwnerAdoptionTransition(
  previous: RequestOwnerAdoptionDossier,
  next: RequestOwnerAdoptionDossier,
): Promise<void> {
  await parseRequestOwnerAdoptionDossier(next);
  if (
    previous.id !== next.id || previous.repositoryId !== next.repositoryId ||
    previous.revision + 1 !== next.revision ||
    previous.createdAt !== next.createdAt ||
    canonical(previous.intent) !== canonical(next.intent) || previous.receipt ||
    !({
      prepared: ["prepared", "armed", "refused", "cancelled"],
      armed: ["armed", "adopted", "refused", "cancelled"],
      adopted: [],
      refused: [],
      cancelled: [],
    } as Record<string, readonly string[]>)[previous.status].includes(
      next.status,
    )
  ) invalid("invalid immutable Request transition");
}
export async function parseRequestAdoptionManifest(
  value: unknown,
): Promise<RequestAdoptionManifest> {
  const snapshot = structuredClone(value),
    v = object(snapshot, [
      "format",
      "commandId",
      "intent",
      "completion",
      "predecessor",
      "sourceHead",
      "previousRuntimeRevision",
      "authorizationRuntimeRevision",
      "committedRuntimeRevision",
      "admissionRevision",
      "nativeRetirement",
    ]);
  if (v.format !== "request-runtime-adoption/v2") {
    invalid("adoption manifest required");
  }
  text(v.commandId);
  const intent = await parseRequestAdoptionIntent(v.intent);
  assertSameRequestAdoptionCompletion(intent, v.completion);
  const predecessor = object(v.predecessor, ["revision", "digest"]),
    head = object(v.sourceHead, ["revision", "manifestDigest"]);
  integer(predecessor.revision, 2);
  hash(predecessor.digest);
  integer(head.revision, 2);
  hash(head.manifestDigest);
  for (
    const key of [
      "previousRuntimeRevision",
      "authorizationRuntimeRevision",
      "committedRuntimeRevision",
      "admissionRevision",
    ]
  ) integer(v[key], key === "previousRuntimeRevision" ? 0 : 1);
  const retirement = object(v.nativeRetirement, [
    "digest",
    "predecessorThreadIds",
    "successorThreadIds",
  ]);
  hash(retirement.digest);
  for (const key of ["predecessorThreadIds", "successorThreadIds"]) {
    const ids = retirement[key];
    if (
      !Array.isArray(ids) || ids.length > 256 ||
      new Set(ids).size !== ids.length
    ) invalid("bounded retirement required");
    for (const id of ids) text(id);
  }
  if (
    (retirement.predecessorThreadIds as unknown[]).length !==
      (retirement.successorThreadIds as unknown[]).length
  ) invalid("retirement pairs required");
  if (
    Number(v.authorizationRuntimeRevision) !==
      Number(v.previousRuntimeRevision) + 1 ||
    Number(v.committedRuntimeRevision) !==
      Number(v.previousRuntimeRevision) + 2 ||
    Number(v.admissionRevision) !== intent.previous.admission.revision + 1 ||
    canonical(head) !== canonical(intent.candidate.sourceAdmission) ||
    Number(head.revision) > Number(predecessor.revision)
  ) invalid("exact transition revisions required");
  return snapshot as RequestAdoptionManifest;
}
