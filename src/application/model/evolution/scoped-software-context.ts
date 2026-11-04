import { isSha256Hex } from "../../../domain/primitives/execution-digest.ts";
import type { ScopedOperatorRef as DomainScopedOperatorRef } from "../../../domain/governance/authority.ts";
import { evolutionIdentity } from "../../../domain/model/evolution/policy.ts";
import {
  parseRequestModelWriteDestination,
  type RequestModelWriteDestination,
} from "../../../domain/model/editing/request-write-destination.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import {
  canonical,
  compareCodeUnits,
} from "../../../domain/primitives/canonical-json.ts";
import { requestSpaceIdentity } from "../../../domain/work/request-spaces/scope.ts";
import { MAX_OPERATOR_UNITS } from "../../../domain/work/records/conversations.ts";
import type { RequestExecutionPin } from "./request-adoption-ports.ts";
import { EvolutionError } from "./ports.ts";

export interface ScopedSoftwareTargetContext {
  readonly target: Readonly<DomainScopedOperatorRef>;
  readonly previousPin: RequestExecutionPin;
}
/** Host-resolved addressing only. Shape validation grants no authority,
 * admission, runtime registration or right to use another instance. */
export interface ScopedSoftwareContextV2 {
  readonly format: "software-evolution-scope/v2";
  readonly destination: RequestModelWriteDestination;
  readonly openingBaseDigest: string;
  readonly predecessorManifestDigest: string;
  readonly actor: Readonly<DomainScopedOperatorRef>;
  readonly targets: readonly ScopedSoftwareTargetContext[];
}

function invalid(): never {
  throw new EvolutionError(
    "EVOLUTION_INVALID",
    "Invalid scoped software context",
  );
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const record = value as Record<string, unknown>;
  if (
    Reflect.ownKeys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) invalid();
  return record;
}
function hash(value: unknown): asserts value is string {
  if (!isSha256Hex(value)) invalid();
}
function positive(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) invalid();
}
function operator(value: unknown): Readonly<DomainScopedOperatorRef> {
  const v = object(value, [
    "projectId",
    "systemId",
    "executionSpaceId",
    "operatorId",
  ]);
  if (
    !evolutionIdentity(v.projectId) || !evolutionIdentity(v.systemId) ||
    !requestSpaceIdentity(v.executionSpaceId) ||
    !evolutionIdentity(v.operatorId)
  ) invalid();
  return {
    projectId: v.projectId,
    systemId: v.systemId,
    executionSpaceId: v.executionSpaceId,
    operatorId: v.operatorId,
  };
}
function pin(value: unknown, repositoryId: string): RequestExecutionPin {
  const v = object(value, [
    "source",
    "modelDigest",
    "sourceAdmission",
    "adoption",
  ]);
  const source = parseModelRevisionRef(
    object(v.source, ["repositoryId", "version"]),
  );
  if (source.repositoryId !== repositoryId) invalid();
  hash(v.modelDigest);
  const admission = object(v.sourceAdmission, ["revision", "manifestDigest"]);
  positive(admission.revision);
  hash(admission.manifestDigest);
  let adoption: RequestExecutionPin["adoption"] = null;
  if (v.adoption !== null) {
    const a = object(v.adoption, [
      "commandId",
      "receiptDigest",
      "committedRuntimeRevision",
    ]);
    if (!evolutionIdentity(a.commandId)) invalid();
    hash(a.receiptDigest);
    positive(a.committedRuntimeRevision);
    adoption = {
      commandId: a.commandId,
      receiptDigest: a.receiptDigest,
      committedRuntimeRevision: a.committedRuntimeRevision,
    };
  }
  return {
    source,
    modelDigest: v.modelDigest,
    sourceAdmission: {
      revision: admission.revision,
      manifestDigest: admission.manifestDigest,
    },
    adoption,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Detached and deeply frozen. The previous pin may lag the admitted source;
 * a fresh final runtime revision/checkpoint is captured after settlement later. */
export function parseScopedSoftwareContext(
  value: unknown,
): ScopedSoftwareContextV2 {
  const v = object(structuredClone(value), [
    "format",
    "destination",
    "openingBaseDigest",
    "predecessorManifestDigest",
    "actor",
    "targets",
  ]);
  if (v.format !== "software-evolution-scope/v2") invalid();
  const destination = parseRequestModelWriteDestination(v.destination);
  hash(v.openingBaseDigest);
  hash(v.predecessorManifestDigest);
  const actor = operator(v.actor);
  const sameHost = (ref: Readonly<DomainScopedOperatorRef>) =>
    ref.projectId === destination.host.projectId &&
    ref.systemId === destination.host.systemId;
  if (!sameHost(actor)) invalid();
  if (
    !Array.isArray(v.targets) || !v.targets.length ||
    v.targets.length > MAX_OPERATOR_UNITS
  ) invalid();
  const seen = new Set<string>();
  const targets = Array.from(v.targets).map((entry) => {
    const t = object(entry, ["target", "previousPin"]),
      target = operator(t.target);
    if (
      !sameHost(target) ||
      target.executionSpaceId !== destination.executionSpaceId
    ) invalid();
    const key = canonical(target);
    if (seen.has(key)) invalid();
    seen.add(key);
    return {
      target,
      previousPin: pin(t.previousPin, destination.repositoryId),
    };
  }).sort((a, b) => compareCodeUnits(canonical(a.target), canonical(b.target)));
  return freeze<ScopedSoftwareContextV2>({
    format: "software-evolution-scope/v2",
    destination,
    openingBaseDigest: v.openingBaseDigest,
    predecessorManifestDigest: v.predecessorManifestDigest,
    actor,
    targets,
  });
}
