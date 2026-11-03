import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  canonicalDigest,
  isSha256Hex,
} from "../../../domain/primitives/execution-digest.ts";
import {
  type AuthorityExercise,
  exerciseOwnerAuthority,
  OWNER_AUTHORITY_IDENTITY_FIELDS,
  type OwnerAuthority,
  sameOwnerAuthorityIdentity,
} from "../../../domain/governance/authority.ts";
import {
  exactSourceVersion,
  type SpaceController,
  type SpaceControlSourceBinding,
} from "../../../domain/work/request-spaces.ts";
import {
  effectiveSpaceControlAuthority,
  spaceControlAuthorityMatchesBinding,
  spaceControlOwnerIdentity,
} from "../../../domain/work/request-space-authority.ts";
import type { ModelIdentity } from "../../../domain/work/dialogue.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import {
  parseRequestModelWriteDestination,
  type RequestModelWriteDestination,
} from "../../../domain/model/editing/request-write-destination.ts";

export interface RequestSourceOwnerPrincipal {
  readonly v: 1;
  readonly kind: "request-source-owner";
  readonly controller: SpaceController;
  readonly sessionRevision: number;
  readonly priorOwner: OwnerAuthority;
}
type RequestSourceOwnerPhase = "proposal" | "acceptance";
export interface RequestSourceOwnerPhaseBinding<
  P extends RequestSourceOwnerPhase = RequestSourceOwnerPhase,
> {
  readonly v: 1;
  readonly phase: P;
  readonly destination: RequestModelWriteDestination;
  readonly priorModel: {
    readonly identity: ModelIdentity;
    readonly version: {
      readonly digest: string;
      readonly repositoryVersion: string;
    };
  };
  readonly principal: RequestSourceOwnerPrincipal;
  readonly exercise: AuthorityExercise;
  readonly capturedAt: string;
}
export interface RequestSourceOwnerAuthorityEnvelope {
  readonly v: 1;
  readonly kind: "request-source-owner-authority";
  readonly proposal: RequestSourceOwnerPhaseBinding<"proposal">;
  readonly acceptance: RequestSourceOwnerPhaseBinding<"acceptance">;
}
export type RequestSourcePriorModel = Pick<
  ExecutableModel,
  "identity" | "version" | "ownerAuthority"
>;
/** Populated by a trusted D2/source reader after exact build/native validation.
 * This value, its decoder and a controller-shaped object issue no permission. */
export interface RequestSourceOwnerContext {
  readonly destination: RequestModelWriteDestination;
  readonly openingOwnerId: string;
  readonly targetOperatorId: string;
  readonly priorModel: RequestSourcePriorModel;
}
export class RequestSourceOwnerError extends Error {
  readonly code = "REQUEST_SOURCE_OWNER_REFUSED";
  constructor(readonly reason: string) {
    super(`Request source owner refused: ${reason}`);
    this.name = "RequestSourceOwnerError";
  }
}
function refuse(reason: string): never {
  throw new RequestSourceOwnerError(reason);
}
function object(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    refuse("closed-object-required");
  }
  const record = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) =>
      !required.includes(key) && !optional.includes(key)
    )
  ) refuse("closed-fields-required");
  return record;
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value.trim() !== value ||
    value.length > 512 || value === "*" ||
    [...value].some((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
    )
  ) refuse("bounded-identity-required");
}
function revision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    refuse("safe-revision-required");
  }
}
function digest(value: unknown): asserts value is string {
  if (!isSha256Hex(value)) {
    refuse("exact-digest-required");
  }
}
function owner(value: unknown): OwnerAuthority {
  const record = object(value, [
    ...OWNER_AUTHORITY_IDENTITY_FIELDS,
    "sourceIds",
  ]);
  if (record.ownerSource !== "modeled") refuse("modeled-root-required");
  for (const key of OWNER_AUTHORITY_IDENTITY_FIELDS) {
    if (key !== "ownerSource" && key !== "mandateRevision") text(record[key]);
  }
  revision(record.mandateRevision);
  if (!Array.isArray(record.sourceIds) || record.sourceIds.length > 1024) {
    refuse("owner-provenance-required");
  }
  for (const id of record.sourceIds) text(id);
  if (
    !spaceControlOwnerIdentity(
      record as unknown as OwnerAuthority,
      record.systemId as string,
    )
  ) refuse("modeled-root-required");
  return record as unknown as OwnerAuthority;
}
function modelIdentity(value: unknown): ModelIdentity {
  const record = object(value, [
    "projectId",
    "editingContextId",
    "rootId",
    "systemId",
    "catalogId",
    "builderId",
  ], ["systemQualifiedName", "backend", "reviewerId"]);
  for (const [key, item] of Object.entries(record)) {
    if (key === "backend") {
      if (item !== "native") refuse("native-model-required");
    } else text(item);
  }
  return record as unknown as ModelIdentity;
}
function controller(value: unknown): SpaceController {
  const record = object(value, [
    "ownerId",
    "capabilityId",
    "capabilityRevision",
    "sessionId",
    "authority",
  ]);
  for (const key of ["ownerId", "capabilityId", "sessionId"]) text(record[key]);
  revision(record.capabilityRevision);
  const authority = object(record.authority, [
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
  const scope = object(authority.scope, ["projectId", "systemId"]);
  text(scope.projectId);
  text(scope.systemId);
  text(authority.sourceSystemNativeId);
  text(authority.policyId);
  revision(authority.policyRevision);
  digest(authority.modelDigest);
  if (!exactSourceVersion(authority.sourceVersion)) {
    refuse("exact-control-source-required");
  }
  owner(authority.owner);
  if (!Array.isArray(authority.operatorIds) || !Array.isArray(authority.acts)) {
    refuse("control-shape-required");
  }
  for (const id of authority.operatorIds) text(id);
  if (
    !effectiveSpaceControlAuthority(
      authority as unknown as SpaceController["authority"],
    )
  ) refuse("current-control-shape-required");
  return record as unknown as SpaceController;
}
function validatePhase<P extends RequestSourceOwnerPhase>(
  value: unknown,
  phase: P,
): RequestSourceOwnerPhaseBinding<P> {
  const record = object(value, [
    "v",
    "phase",
    "destination",
    "priorModel",
    "principal",
    "exercise",
    "capturedAt",
  ]);
  if (record.v !== 1 || record.phase !== phase) refuse("phase-required");
  const destination = parseRequestModelWriteDestination(record.destination);
  const priorModel = object(record.priorModel, ["identity", "version"]),
    identity = modelIdentity(priorModel.identity);
  const version = object(priorModel.version, ["digest", "repositoryVersion"]);
  digest(version.digest);
  if (
    !exactSourceVersion(version.repositoryVersion) ||
    version.repositoryVersion !==
      destination.expectedAdmittedSource.source.version
  ) refuse("prior-source-required");
  const principal = object(record.principal, [
    "v",
    "kind",
    "controller",
    "sessionRevision",
    "priorOwner",
  ]);
  if (principal.v !== 1 || principal.kind !== "request-source-owner") {
    refuse("human-owner-principal-required");
  }
  revision(principal.sessionRevision);
  const control = controller(principal.controller),
    priorOwner = owner(principal.priorOwner);
  if (
    priorOwner.systemId !== identity.systemId ||
    !sameOwnerAuthorityIdentity(control.authority.owner, priorOwner) ||
    canonical(control.authority.scope) !== canonical(destination.host) ||
    control.authority.sourceSystemNativeId !== identity.systemId
  ) refuse("prior-owner-binding-required");
  const exercise = object(record.exercise, [
    ...OWNER_AUTHORITY_IDENTITY_FIELDS,
    "sourceIds",
    "authoritySchema",
    "action",
    "baseModelDigest",
    "outOfMandate",
  ]);
  if (
    exercise.authoritySchema !== 2 || exercise.action !== "model-revision" ||
    exercise.outOfMandate !== false ||
    exercise.baseModelDigest !== version.digest ||
    canonical(
        Object.fromEntries(
          [...OWNER_AUTHORITY_IDENTITY_FIELDS, "sourceIds"].map((
            key,
          ) => [key, exercise[key]]),
        ),
      ) !== canonical(priorOwner)
  ) refuse("prior-human-exercise-required");
  text(record.capturedAt);
  if (
    !Number.isFinite(Date.parse(record.capturedAt)) ||
    new Date(record.capturedAt).toISOString() !== record.capturedAt
  ) refuse("capture-time-required");
  return record as unknown as RequestSourceOwnerPhaseBinding<P>;
}
/** Pure owned snapshot/coherence only. No current-credential or grant check. */
export function parseRequestSourceOwnerPhaseBinding<
  P extends RequestSourceOwnerPhase,
>(value: unknown, phase: P): RequestSourceOwnerPhaseBinding<P> {
  return validatePhase(structuredClone(value), phase);
}
export function parseRequestSourceOwnerAuthority(
  value: unknown,
): RequestSourceOwnerAuthorityEnvelope {
  const snapshot = structuredClone(value),
    envelope = object(snapshot, ["v", "kind", "proposal", "acceptance"]);
  if (envelope.v !== 1 || envelope.kind !== "request-source-owner-authority") {
    refuse("authority-envelope-required");
  }
  const proposal = validatePhase(envelope.proposal, "proposal"),
    acceptance = validatePhase(envelope.acceptance, "acceptance");
  if (
    canonical(proposal.destination) !== canonical(acceptance.destination) ||
    canonical(proposal.priorModel) !== canonical(acceptance.priorModel) ||
    canonical(proposal.principal.priorOwner) !==
      canonical(acceptance.principal.priorOwner)
  ) refuse("independent-decisions-same-prior-required");
  return snapshot as RequestSourceOwnerAuthorityEnvelope;
}
/** Snapshot before the first digest await; the resulting digest is no grant. */
export async function requestSourceOwnerAuthorityDigest(
  value: RequestSourceOwnerAuthorityEnvelope,
): Promise<string> {
  const snapshot = parseRequestSourceOwnerAuthority(value);
  return await canonicalDigest(snapshot);
}
/** Trusted server caller has already authenticated this human channel and
 * physically resolved A0. Pure joining cannot replace those boundaries. */
export function captureRequestSourceOwnerPhase<
  P extends RequestSourceOwnerPhase,
>(input: {
  phase: P;
  controller: SpaceController;
  sessionRevision: number;
  context: RequestSourceOwnerContext;
  binding: SpaceControlSourceBinding;
  capturedAt: string;
}): RequestSourceOwnerPhaseBinding<P> {
  const captured = structuredClone(input),
    { context, binding, controller: control } = captured;
  const priorOwner = context.priorModel.ownerAuthority;
  if (
    priorOwner?.ownerSource !== "modeled" ||
    context.priorModel.version.authoritySchema !== 2 ||
    !spaceControlOwnerIdentity(priorOwner, context.priorModel.identity.systemId)
  ) refuse("explicit-prior-root-required");
  if (
    context.openingOwnerId !== control.ownerId ||
    canonical(context.destination.host) !== canonical(binding.scope) ||
    !spaceControlAuthorityMatchesBinding(control.authority, binding) ||
    context.priorModel.identity.builderId !== context.targetOperatorId ||
    context.priorModel.identity.projectId !==
      `git:${context.destination.repositoryId}` ||
    context.priorModel.identity.systemId !== binding.sourceSystemNativeId ||
    !sameOwnerAuthorityIdentity(control.authority.owner, priorOwner)
  ) refuse("authenticated-prior-owner-join-required");
  const exercise = exerciseOwnerAuthority(context.priorModel, "model-revision");
  return parseRequestSourceOwnerPhaseBinding({
    v: 1,
    phase: captured.phase,
    destination: context.destination,
    priorModel: {
      identity: context.priorModel.identity,
      version: {
        digest: context.priorModel.version.digest,
        repositoryVersion: context.priorModel.version.repositoryVersion,
      },
    },
    principal: {
      v: 1,
      kind: "request-source-owner",
      controller: control,
      sessionRevision: captured.sessionRevision,
      priorOwner,
    },
    exercise,
    capturedAt: captured.capturedAt,
  }, captured.phase);
}
export function assertRequestSourceOwnerPhaseMatches(
  binding: RequestSourceOwnerPhaseBinding,
  context: RequestSourceOwnerContext,
  host: SpaceControlSourceBinding,
): void {
  const expected = captureRequestSourceOwnerPhase({
    phase: binding.phase,
    controller: binding.principal.controller,
    sessionRevision: binding.principal.sessionRevision,
    context,
    binding: host,
    capturedAt: binding.capturedAt,
  });
  if (
    canonical(expected) !==
      canonical(parseRequestSourceOwnerPhaseBinding(binding, binding.phase))
  ) refuse("current-prior-source-differs");
}
