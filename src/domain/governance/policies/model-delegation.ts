import { isPlainRecord as object } from "../../primitives/is-plain-record.ts";
import { assert as require } from "../../primitives/assert.ts";
/** APE 4.1 Operator Identity & Mandate: bounded administration, distinct from editing. */
import {
  executionDigest,
  isSha256Hex,
} from "../../primitives/execution-digest.ts";
import type { OwnerAuthority } from "../authority.ts";
import {
  type ModelEditGrant,
  type ModelEditOperation,
  modelEditRootContains,
  parseModelEditGrants,
  parseModelEditOperations,
  validateModelEditPolicyIdentity,
} from "./model-edit-policy.ts";
import { parseSysmlQualifiedName } from "../../model/value-objects/sysml-qualified-name.ts";

export interface ModelAdministrationEnvelope {
  operations: ModelEditOperation[];
  grants: ModelEditGrant[];
  /** Exact systems to which authority may be granted, never namespace prefixes. */
  recipients: string[];
  /** Zero permits grants for exercise only; each administrative hop consumes one. */
  maxRedelegationDepth: number;
}

export interface ModelDelegationIdentity {
  systemQualifiedName: string;
  holderNativeId: string;
  mandateId: string;
  mandateRevision: number;
  mayProposeSysmlRevision: boolean;
}

export interface ModelRootAuthority extends ModelAdministrationEnvelope {
  /** Absent only for historical roots whose encoding is frozen. */
  rootAuthority?: OwnerAuthority;
  id: string;
  revision: number;
  systemQualifiedName: string;
  holderNativeId: string;
  mandateId: string;
  mandateRevision: number;
}

export interface ModelAdministrationAuthority extends ModelRootAuthority {
  kind: "root" | "delegation";
  digest: string;
}

export interface ModelDelegationRecord {
  id: string;
  revision: number;
  issuerSystem: string;
  targetSystem: string;
  targetHolderNativeId: string;
  targetMandateId: string;
  targetMandateRevision: number;
  parent: {
    kind: "root" | "delegation";
    id: string;
    revision: number;
    digest: string;
  };
  operations: ModelEditOperation[];
  grants: ModelEditGrant[];
  mayEdit: boolean;
  recipients: string[];
  maxRedelegationDepth: number | null;
  revoked: boolean;
}

export interface ModelDelegatedEditing {
  rootAuthority?: OwnerAuthority;
  delegationId: string;
  delegationRevision: number;
  /** Pins the complete current chain, including native holder and mandate. */
  digest: string;
  operations: ModelEditOperation[];
  grants: ModelEditGrant[];
  systemQualifiedName: string;
  holderNativeId: string;
  mandateId: string;
  mandateRevision: number;
}

export interface ModelDelegationStatus {
  id: string;
  revision: number;
  active: boolean;
  reason: string | null;
}

export interface ModelDelegationResolution {
  bySystem: Record<string, {
    administration: ModelAdministrationAuthority | null;
    editing: ModelDelegatedEditing | null;
  }>;
  statuses: ModelDelegationStatus[];
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
    .test(value);
}

/** Native providers may use URIs, fragments or quoted qualified names as IDs. */
function nativeIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    ![...value].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    );
}

function policyIdentifier(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    validateModelEditPolicyIdentity(value, 1);
    return true;
  } catch {
    return false;
  }
}

function revision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function depth(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 &&
    (value as number) <= 8;
}

/** Parsed names prevent quote/leading-:: aliases from bypassing bounds. */
function systemKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 1024) return undefined;
  const segments = parseSysmlQualifiedName(value);
  if (!segments || segments.some((segment) => segment.includes("*"))) {
    return undefined;
  }
  return JSON.stringify(segments);
}

function validateRecipients(
  value: unknown,
  allowEmpty = false,
): asserts value is string[] {
  require(
    Array.isArray(value) && (allowEmpty || value.length > 0) &&
      value.length <= 128,
    "Invalid model administration recipients",
  );
  const keys = value.map(systemKey);
  require(
    keys.every((key) => key !== undefined) &&
      new Set(keys).size === keys.length,
    "Invalid or duplicate model administration recipient",
  );
}

function validateBounds(value: Record<string, unknown>): void {
  parseModelEditOperations(JSON.stringify(value.operations));
  parseModelEditGrants(JSON.stringify(value.grants));
}

export function validateModelAdministrationEnvelope(
  value: unknown,
): asserts value is ModelAdministrationEnvelope {
  require(object(value), "Invalid model administration envelope");
  validateBounds(value);
  validateRecipients(value.recipients);
  require(depth(value.maxRedelegationDepth), "Invalid redelegation depth");
}

export function validateModelDelegationRecord(
  value: unknown,
): asserts value is ModelDelegationRecord {
  require(object(value), "Invalid model delegation record");
  require(
    Object.keys(value).sort().join(",") ===
      "grants,id,issuerSystem,maxRedelegationDepth,mayEdit,operations,parent,recipients,revision,revoked,targetHolderNativeId,targetMandateId,targetMandateRevision,targetSystem",
    "Invalid model delegation fields",
  );
  require(
    identifier(value.id) && revision(value.revision) &&
      nativeIdentifier(value.targetHolderNativeId) &&
      policyIdentifier(value.targetMandateId) &&
      revision(value.targetMandateRevision),
    "Invalid model delegation identity",
  );
  const issuer = systemKey(value.issuerSystem),
    target = systemKey(value.targetSystem);
  require(issuer && target && issuer !== target, "Invalid or self delegation");
  const parent = value.parent;
  require(
    object(parent) &&
      Object.keys(parent).sort().join(",") === "digest,id,kind,revision" &&
      (parent.kind === "root" || parent.kind === "delegation") &&
      (parent.kind === "root"
        ? policyIdentifier(parent.id)
        : identifier(parent.id)) &&
      revision(parent.revision) &&
      isSha256Hex(parent.digest) &&
      parent.id !== value.id,
    "Invalid model delegation parent",
  );
  require(
    typeof value.mayEdit === "boolean" && typeof value.revoked === "boolean",
    "Invalid model delegation flags",
  );
  validateBounds(value);
  if (value.maxRedelegationDepth === null) {
    validateRecipients(value.recipients, true);
    require(
      value.mayEdit && value.recipients.length === 0,
      "Empty or nonadministrative delegation",
    );
  } else {
    validateModelAdministrationEnvelope(value);
  }
}

/** Validate a request against one current authority; chain loops need resolution. */
export function assertModelDelegationWithinAuthority(
  authority: ModelAdministrationAuthority,
  record: ModelDelegationRecord,
): void {
  validateModelAdministrationEnvelope(authority);
  validateModelDelegationRecord(record);
  require(
    record.parent.kind === authority.kind &&
      record.parent.id === authority.id &&
      record.parent.revision === authority.revision &&
      record.parent.digest === authority.digest,
    "Stale model delegation parent",
  );
  require(
    systemKey(record.issuerSystem) === systemKey(authority.systemQualifiedName),
    "Model delegation issuer does not hold authority",
  );
  const recipients = new Set(authority.recipients.map(systemKey));
  require(
    recipients.has(systemKey(record.targetSystem)),
    "Model delegation target is outside authority",
  );
  require(
    record.operations.every((operation) =>
      authority.operations.includes(operation)
    ),
    "Model delegation operations exceed authority",
  );
  for (const grant of record.grants) {
    const parent = authority.grants.find((allowed) =>
      allowed.file === grant.file
    );
    require(
      parent &&
        grant.qualifiedRoots.every((root) =>
          parent.qualifiedRoots.some((allowed) =>
            modelEditRootContains(allowed, root)
          )
        ),
      "Model delegation file/root scope exceeds authority",
    );
  }
  require(
    record.recipients.every((recipient) =>
      recipients.has(systemKey(recipient))
    ),
    "Model delegation recipients exceed authority",
  );
  require(
    record.maxRedelegationDepth === null ||
      record.maxRedelegationDepth < authority.maxRedelegationDepth,
    "Model delegation depth exceeds authority",
  );
}

function validateIdentity(
  value: unknown,
): asserts value is ModelDelegationIdentity {
  require(object(value), "Invalid model delegation identity");
  require(
    systemKey(value.systemQualifiedName) &&
      nativeIdentifier(value.holderNativeId) &&
      policyIdentifier(value.mandateId) && revision(value.mandateRevision) &&
      typeof value.mayProposeSysmlRevision === "boolean",
    "Invalid model delegation native identity",
  );
}

interface ResolvedRecord {
  authority: ModelAdministrationAuthority | null;
  editing: ModelDelegatedEditing | null;
  ancestors: string[];
  systems: Set<string>;
}

/**
 * Resolve against one current native snapshot. Broken branches become inactive;
 * revoking an ancestor does not make unrelated systems unloadable. Incoming
 * conflicts fail closed, including descendants of either conflicting branch.
 */
export async function resolveModelDelegations(
  roots: readonly ModelRootAuthority[],
  records: readonly ModelDelegationRecord[],
  identities: readonly ModelDelegationIdentity[],
): Promise<ModelDelegationResolution> {
  // Own immutable input snapshots across asynchronous digest computation.
  roots = structuredClone(roots);
  records = structuredClone(records);
  identities = structuredClone(identities);
  const bySystem: ModelDelegationResolution["bySystem"] = Object.create(null);
  const native = new Map<string, ModelDelegationIdentity[]>();
  for (const identity of identities) {
    try {
      validateIdentity(identity);
    } catch {
      continue;
    }
    const key = systemKey(identity.systemQualifiedName)!;
    native.set(key, [...(native.get(key) ?? []), identity]);
    bySystem[identity.systemQualifiedName] = {
      administration: null,
      editing: null,
    };
  }
  const current = (system: string): ModelDelegationIdentity | undefined => {
    const found = native.get(systemKey(system)!);
    return found?.length === 1 ? found[0] : undefined;
  };
  const rootCounts = new Map<string, number>(),
    rootSystems = new Map<string, number>();
  for (const root of roots) {
    rootCounts.set(root.id, (rootCounts.get(root.id) ?? 0) + 1);
    const key = systemKey(root.systemQualifiedName);
    if (key) rootSystems.set(key, (rootSystems.get(key) ?? 0) + 1);
  }
  const activeRoots = new Map<string, ModelAdministrationAuthority>();
  for (const root of roots) {
    try {
      validateModelAdministrationEnvelope(root);
      validateIdentity({ ...root, mayProposeSysmlRevision: true });
      require(
        policyIdentifier(root.id) && revision(root.revision),
        "Invalid root identity",
      );
      const identity = current(root.systemQualifiedName);
      require(
        rootCounts.get(root.id) === 1 &&
          rootSystems.get(systemKey(root.systemQualifiedName)!) === 1 &&
          identity?.mayProposeSysmlRevision &&
          identity.holderNativeId === root.holderNativeId &&
          identity.mandateId === root.mandateId &&
          identity.mandateRevision === root.mandateRevision,
        "Inactive root authority",
      );
      const binding: ModelRootAuthority = {
        ...(root.rootAuthority ? { rootAuthority: root.rootAuthority } : {}),
        id: root.id,
        revision: root.revision,
        systemQualifiedName: root.systemQualifiedName,
        holderNativeId: root.holderNativeId,
        mandateId: root.mandateId,
        mandateRevision: root.mandateRevision,
        operations: root.operations,
        grants: root.grants,
        recipients: root.recipients,
        maxRedelegationDepth: root.maxRedelegationDepth,
      };
      const authority: ModelAdministrationAuthority = {
        ...binding,
        kind: "root",
        digest: await executionDigest({
          kind: "model-administration-root",
          ...binding,
        }),
      };
      activeRoots.set(root.id, authority);
      bySystem[identity.systemQualifiedName]!.administration = authority;
    } catch { /* Invalid current roots confer no authority. */ }
  }
  const groups = new Map<string, ModelDelegationRecord[]>();
  for (const record of records) {
    groups.set(record.id, [...(groups.get(record.id) ?? []), record]);
  }
  const reasons = new Map<string, string>();
  const resolved = new Map<string, ResolvedRecord>();
  const inactive = (id: string, reason: string): undefined => {
    reasons.set(id, reason);
    return undefined;
  };
  const visit = async (
    id: string,
    path = new Set<string>(),
  ): Promise<ResolvedRecord | undefined> => {
    if (reasons.has(id)) return undefined;
    if (resolved.has(id)) return resolved.get(id);
    if (path.has(id)) return inactive(id, "cycle");
    // At most eight administrative hops, followed by an exercise-only grant.
    // The caller's malformed path must not poison this possibly valid ancestor.
    if (path.size > 9) return undefined;
    const group = groups.get(id);
    if (!group) return undefined;
    if (group.length !== 1 || rootCounts.has(id)) {
      return inactive(id, "duplicate-id");
    }
    const record = group[0]!;
    try {
      validateModelDelegationRecord(record);
    } catch {
      return inactive(id, "invalid-record");
    }
    if (record.revoked) return inactive(id, "revoked");
    const target = current(record.targetSystem);
    if (!target) return inactive(id, "missing-target");
    if (target.holderNativeId !== record.targetHolderNativeId) {
      return inactive(id, "stale-holder");
    }
    if (
      target.mandateId !== record.targetMandateId ||
      target.mandateRevision !== record.targetMandateRevision
    ) {
      return inactive(id, "stale-mandate");
    }
    if (!target.mayProposeSysmlRevision) {
      return inactive(id, "unavailable-capability");
    }
    let parent: ModelAdministrationAuthority | undefined;
    let ancestry: ResolvedRecord | undefined;
    if (record.parent.kind === "root") {
      parent = activeRoots.get(record.parent.id);
    } else {
      const parentRecord = groups.get(record.parent.id);
      if (parentRecord?.length === 1) {
        try {
          validateModelDelegationRecord(parentRecord[0]);
          require(
            parentRecord[0]!.maxRedelegationDepth !== null &&
              (record.maxRedelegationDepth === null ||
                record.maxRedelegationDepth <
                  parentRecord[0]!.maxRedelegationDepth),
            "Invalid administrative parent depth",
          );
        } catch {
          return inactive(id, "inactive-parent");
        }
      }
      ancestry = await visit(record.parent.id, new Set([...path, id]));
      parent = ancestry?.authority ?? undefined;
    }
    if (!parent) return inactive(id, "inactive-parent");
    if (
      record.parent.revision !== parent.revision ||
      record.parent.digest !== parent.digest
    ) {
      return inactive(id, "stale-parent");
    }
    try {
      assertModelDelegationWithinAuthority(parent, record);
    } catch {
      return inactive(id, "outside-authority");
    }
    const systems = new Set(
      ancestry?.systems ?? [systemKey(parent.systemQualifiedName)!],
    );
    if (systems.has(systemKey(record.targetSystem)!)) {
      return inactive(id, "ancestor-target-loop");
    }
    systems.add(systemKey(record.targetSystem)!);
    const digest = await executionDigest({
      kind: "model-delegation-chain",
      record,
      target,
      parentDigest: parent.digest,
    });
    const binding = {
      ...(parent.rootAuthority ? { rootAuthority: parent.rootAuthority } : {}),
      systemQualifiedName: target.systemQualifiedName,
      holderNativeId: target.holderNativeId,
      mandateId: target.mandateId,
      mandateRevision: target.mandateRevision,
    };
    const result: ResolvedRecord = {
      authority: record.maxRedelegationDepth === null ? null : {
        kind: "delegation",
        id: record.id,
        revision: record.revision,
        digest,
        ...binding,
        operations: record.operations,
        grants: record.grants,
        recipients: record.recipients,
        maxRedelegationDepth: record.maxRedelegationDepth,
      },
      editing: record.mayEdit
        ? {
          delegationId: record.id,
          delegationRevision: record.revision,
          digest,
          ...binding,
          operations: record.operations,
          grants: record.grants,
        }
        : null,
      ancestors: [
        ...(ancestry?.ancestors ?? []),
        ...(ancestry ? [record.parent.id] : []),
      ],
      systems,
    };
    resolved.set(id, result);
    return result;
  };
  for (const record of records) await visit(record.id);
  const incoming = new Map<string, string[]>();
  for (const [id] of resolved) {
    const record = groups.get(id)![0]!;
    const key = systemKey(record.targetSystem)!;
    incoming.set(key, [...(incoming.get(key) ?? []), id]);
  }
  for (const ids of incoming.values()) {
    if (ids.length > 1) {
      for (const id of ids) inactive(id, "ambiguous-target");
    }
  }
  for (const [id, value] of resolved) {
    const target = current(groups.get(id)![0]!.targetSystem)!;
    if (
      value.authority && bySystem[target.systemQualifiedName]!.administration
    ) inactive(id, "root-administration-conflict");
  }
  for (const [id, value] of resolved) {
    if (
      !reasons.has(id) &&
      value.ancestors.some((ancestor) => reasons.has(ancestor))
    ) inactive(id, "inactive-parent");
    if (reasons.has(id)) continue;
    const target = current(groups.get(id)![0]!.targetSystem)!;
    const entry = bySystem[target.systemQualifiedName]!;
    if (value.authority) entry.administration = value.authority;
    entry.editing = value.editing;
  }
  return {
    bySystem,
    statuses: records.map((record) => ({
      id: record.id,
      revision: record.revision,
      active: !reasons.has(record.id) && resolved.has(record.id),
      reason: reasons.get(record.id) ?? null,
    })),
  };
}
