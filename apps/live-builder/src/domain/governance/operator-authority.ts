import { sameProductName } from "../model/sysml-product-names.ts";
import { characterCount } from "../primitives/character-count.ts";
import { MAX_OPERATOR_UNITS } from "../work/records/conversations.ts";
import type { PendingChange } from "./records/pending-change.ts";
import type { ExecutionSpaceRef, ScopedOperatorRef } from "./authority.ts";
import type { ElementRecord } from "../model/records/snapshot.ts";
import { parseSysmlQualifiedName } from "../model/value-objects/sysml-qualified-name.ts";

import type { ModelEditOperation } from "./policies/model-edit-policy.ts";
import {
  parseModelEditGrants,
  parseModelEditOperations,
} from "./policies/model-edit-policy.ts";
import { validateNetworkScope } from "./policies/network-policy.ts";
import { TOOL_KINDS, type ToolKind } from "../shared-kernel/tool-kind.ts";

export interface ModelEditingGrant {
  file: string;
  root: string;
  operations: Exclude<ModelEditOperation, "replace-source">[];
}

/** Closed authoring input: no free-form mandate or SysML is accepted. */
export interface RequestOperatorSpec {
  instruction: string;
  networkHosts: string[];
  requestType: { name: string; maxInvocations: number };
  firstRequest: { objective: string };
  /** Explicit initial creation rights, admitted by the person with this independent operator. */
  creationGrant?: OperatorCreationGrant;
  flowTemplate?: OperatorFlowTemplateSelection;
}

export interface OperatorFlowTemplateSelection {
  qualifiedName: string;
  revision: number;
}

function validateFlowTemplate(value: unknown): OperatorFlowTemplateSelection {
  if (
    !exact(value, ["qualifiedName", "revision"]) ||
    !text(value.qualifiedName, 512) ||
    !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
  ) {
    throw new Error(
      "Expected an exact native flow template and positive revision",
    );
  }
  parseSysmlQualifiedName(value.qualifiedName);
  return {
    qualifiedName: value.qualifiedName,
    revision: Number(value.revision),
  };
}

/**
 * Two creation forms (spec 4.8e E1). `autonomous`: the holder creates alone
 * within the bound; the human-approved grant is the prior approval.
 * `per-creation`: every creation is a routed change (one card each); the
 * holder never approves its own creation.
 */
export type OperatorCreationMode = "autonomous" | "per-creation";

/** Creation authority is opt-in and remains bounded at every generation. */
export interface OperatorCreationGrant {
  networkHosts: string[];
  maxChildren: number;
  maxDelegationDepth: number;
  /** Absent is the historical `autonomous` form. */
  mode?: OperatorCreationMode;
}

/**
 * The child's explicitly provisioned rights and execution limits (spec 4.8e
 * E2). The creator states every value; nothing is copied from it silently.
 * Each value must stay within the creator's own admitted value.
 */
export interface TeamOperatorProvision {
  budget: {
    maxAgentDecisions: number;
    maxToolProposals: number;
    maxFlowSteps: number;
  };
  networkHosts: string[];
  mayPropose: ToolKind[];
  mayInvokeActiveCatalog: boolean;
  mayAddNetworkHosts?: boolean;
  /** Explicit opt-in; omission grants neither model right. */
  mayConsultModel?: boolean;
  mayProposeSysmlRevision?: boolean;
}

/** A durable teammate works on its originating Request without opening a Case. */
export interface TeamOperatorSpec {
  kind: "request-team-member";
  instruction: string;
  provision: TeamOperatorProvision;
  creationGrant?: OperatorCreationGrant;
  flowTemplate?: OperatorFlowTemplateSelection;
}

export type OperatorCreationSpec = RequestOperatorSpec | TeamOperatorSpec;

export function isTeamOperatorSpec(
  value: OperatorCreationSpec,
): value is TeamOperatorSpec {
  return "kind" in value && value.kind === "request-team-member";
}

export interface PreparedChangeDiff {
  title: string;
  author: string;
  base: {
    repositoryVersion: string;
    modelDigest: string;
    sourceDigest: string;
  };
  sourceDigest: string;
  files: {
    path: string;
    kind: "added" | "changed" | "deleted";
    additions: number;
    deletions: number;
  }[];
  patch: string;
  additions: number;
  deletions: number;
}

/** At most this many requests awaiting the person reach an operator's context. */
export const MAX_AWAITING_PERSON = 20;

/** Requests awaiting the person, newest first then by identity, bounded.
 * `requestedAt` only orders them; it is dropped from the view. */
export function awaitingPersonView<
  T extends { id: string; caseId: string; requestedAt: string },
>(entries: readonly T[]): {
  awaitingPerson: Omit<T, "requestedAt">[];
  awaitingPersonTruncated: boolean;
} {
  const ordered = [...entries].sort((a, b) =>
    a.requestedAt === b.requestedAt
      ? a.caseId === b.caseId
        ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        : a.caseId < b.caseId
        ? -1
        : 1
      : a.requestedAt < b.requestedAt
      ? 1
      : -1
  );
  return {
    awaitingPerson: ordered.slice(0, MAX_AWAITING_PERSON).map((
      { requestedAt: _requestedAt, ...entry },
    ) => entry),
    awaitingPersonTruncated: ordered.length > MAX_AWAITING_PERSON,
  };
}

/** Agent decisions need the proposal index, not publication bytes or instructions. */
export function changeDecisionMetadata(change: PendingChange) {
  return {
    id: change.id,
    kind: change.kind,
    status: change.status,
    requestedBy: change.requestedBy,
    caseId: change.caseId,
    designerScopeId: change.designerScopeId,
    baseRevision: change.baseRevision,
    baseModelDigest: change.baseModelDigest,
    publishedCommit: change.publishedCommit,
    ...(change.diff
      ? {
        diff: {
          files: structuredClone(change.diff.files),
          additions: change.diff.additions,
          deletions: change.diff.deletions,
        },
      }
      : {}),
  };
}

/** Include derived mandate types and their occurrences, regardless of local names. */
export function modelEditingAuthorityRoots(
  elements: readonly ElementRecord[],
): string[] {
  const protectedIds = new Set(
    elements.filter((element) =>
      [
        "AssemblyAuthority::OperatorAuthorityPolicy",
        "AssemblyAuthority::OperatorCreationPolicy",
        "AssemblyAuthority::ToolAdmissionPolicy",
        "AssemblyAuthority::Mandate",
        "AssemblyAuthority::RootAuthority",
        "AssemblyAuthority::RootGrant",
        "AssemblyCore::ConfiguredMandate",
      ].some((name) => sameProductName(element.qualifiedName, name))
    ).map((element) => element.id),
  );
  let size: number;
  do {
    size = protectedIds.size;
    for (const element of elements) {
      if (
        [...element.typeIds, ...element.generalIds].some((id) =>
          protectedIds.has(id)
        )
      ) {
        protectedIds.add(element.id);
      }
    }
  } while (size !== protectedIds.size);
  return elements.filter((element) => protectedIds.has(element.id))
    .map((element) => element.qualifiedName).filter(Boolean).sort();
}

export function assertGrantModelEditingScope(
  grant: ModelEditingGrant,
  systemName: string | undefined,
  authorityRoots?: readonly string[],
): void {
  const system = systemName && parseSysmlQualifiedName(systemName);
  const root = parseSysmlQualifiedName(grant.root);
  const within = (child: readonly string[], parent: readonly string[]) =>
    child.length >= parent.length &&
    parent.every((part, index) => child[index] === part);
  const authorities = authorityRoots ?? (systemName
    ? [
      `${systemName}::owner::ownerMandate`,
      `${systemName}::builderMandate`,
      `${systemName}::reviewerMandate`,
    ]
    : []);
  if (
    !system || !root || !within(root, system) || authorities.some((name) => {
      const authority = parseSysmlQualifiedName(name);
      return authority && (within(authority, root) || within(root, authority));
    })
  ) {
    throw new OperatorAuthorityError(
      "INVALID_MODEL_EDIT_GRANT",
      "The editing root must be within the requesting system and exclude authority declarations: choose a root inside systemName that neither contains nor lies within any of excludedRoots",
      {
        systemName: systemName ?? "",
        root: grant.root,
        file: grant.file,
        excludedRoots: [...authorities],
      },
    );
  }
}

export class OperatorAuthorityError extends Error {
  readonly recovery = { action: "refuse-and-repropose" } as const;
  constructor(
    readonly code:
      | "INVALID_AUTHORITY_POLICY"
      | "AUTHORITY_POLICY_FORBIDDEN"
      | "AUTHORITY_POLICY_STALE"
      | "AUTHORITY_REQUEST_STALE"
      | "AUTHORITY_OUT_OF_BOUNDS"
      | "AUTHORITY_RECEIPT_MISMATCH"
      | "AUTHORITY_PROVENANCE_MISMATCH"
      | "INVALID_MODEL_EDIT_GRANT"
      | "INVALID_OPERATOR_REQUEST"
      | "CHANGE_PREVIEW_MISMATCH"
      | "OPERATOR_OPEN_FAILED"
      | "OPERATOR_CAPACITY_EXCEEDED",
    message: string,
    readonly context: Record<string, string | string[]> = {},
  ) {
    super(message);
    this.name = "OperatorAuthorityError";
  }
}

function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys.sort().join(",");
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    characterCount(value) <= max;
}

export function validateGrantModelEditing(value: unknown): ModelEditingGrant {
  try {
    if (
      !exact(value, ["file", "root", "operations"]) ||
      !text(value.file, 240) || !text(value.root, 512)
    ) throw new Error("Expected an exact file, root and operations");
    const operations = parseModelEditOperations(
      JSON.stringify(value.operations),
    );
    if (operations.includes("replace-source")) {
      throw new Error("Raw source replacement is not an eligible grant");
    }
    parseModelEditGrants(
      JSON.stringify([{ file: value.file, qualifiedRoots: [value.root] }]),
    );
    return {
      file: value.file,
      root: value.root,
      operations: operations as ModelEditingGrant["operations"],
    };
  } catch (error) {
    throw new OperatorAuthorityError(
      "INVALID_MODEL_EDIT_GRANT",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function validateRequestOperatorSpec(
  value: unknown,
): RequestOperatorSpec {
  try {
    const hasCreationGrant = !!value && typeof value === "object" &&
      Object.hasOwn(value, "creationGrant");
    const hasFlowTemplate = !!value && typeof value === "object" &&
      Object.hasOwn(value, "flowTemplate");
    if (
      !exact(value, [
        "instruction",
        "networkHosts",
        "requestType",
        "firstRequest",
        ...(hasCreationGrant ? ["creationGrant"] : []),
        ...(hasFlowTemplate ? ["flowTemplate"] : []),
      ]) ||
      !text(value.instruction, 4000) ||
      !exact(value.requestType, ["name", "maxInvocations"]) ||
      !text(value.requestType.name, 80) ||
      !Number.isSafeInteger(value.requestType.maxInvocations) ||
      Number(value.requestType.maxInvocations) < 1 ||
      Number(value.requestType.maxInvocations) > 100 ||
      !exact(value.firstRequest, ["objective"]) ||
      !text(value.firstRequest.objective, 2000)
    ) {
      throw new Error(
        "An operator requires an instruction, exact hosts, a named Request type, an invocation limit (1–100), and its first objective",
      );
    }
    const hosts = validateNetworkScope({ allowedHosts: value.networkHosts });
    return {
      instruction: value.instruction,
      networkHosts: hosts.allowedHosts,
      requestType: {
        name: value.requestType.name,
        maxInvocations: Number(value.requestType.maxInvocations),
      },
      firstRequest: { objective: value.firstRequest.objective },
      ...(hasCreationGrant
        ? { creationGrant: validateOperatorCreationGrant(value.creationGrant) }
        : {}),
      ...(hasFlowTemplate
        ? { flowTemplate: validateFlowTemplate(value.flowTemplate) }
        : {}),
    };
  } catch (error) {
    throw new OperatorAuthorityError(
      "INVALID_OPERATOR_REQUEST",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export const MAIN_EXECUTION_SPACE_ID = "main";
export type { ExecutionSpaceRef, ScopedOperatorRef } from "./authority.ts";

/** A Branch Operator shares its Main Operator's native ID: only the space tells them apart. */
export function sameScopedOperator(
  a: ScopedOperatorRef,
  b: ScopedOperatorRef,
): boolean {
  return a.projectId === b.projectId && a.systemId === b.systemId &&
    a.executionSpaceId === b.executionSpaceId && a.operatorId === b.operatorId;
}

/** The main space where a model of this identity is admitted. */
export function mainExecutionSpace(
  identity: Pick<ExecutionSpaceRef, "projectId" | "systemId">,
): ExecutionSpaceRef {
  return {
    projectId: identity.projectId,
    systemId: identity.systemId,
    executionSpaceId: MAIN_EXECUTION_SPACE_ID,
  };
}

/** Closed reason of a route that cannot designate a decider. */
export type AuthorityRouteCode =
  | "OPENING_PROOF_UNAVAILABLE"
  | "OPENING_PROOF_MISMATCH"
  | "MAIN_UNAVAILABLE"
  | "MAIN_POLICY_UNREADABLE"
  | "CHANGE_NOT_PENDING"
  | "CHANGE_STALE"
  | "CHAIN_UNVERIFIED";

/** Immutable routing evidence. Eligibility is revalidated before an explicit
 * decision. Every hop is a composite instance: its native ID and its space. */
export interface RequestAuthorityRoute {
  /** Historical notices keep the version 1 route they recorded. */
  version: 2;
  changeId: string;
  caseId: string;
  requestedBy: string;
  /** The requesting instance; replaces the former scopedActors. */
  requester: ScopedOperatorRef;
  /** The verified opening crossed by a branch route. */
  openingId?: string;
  targetOperatorId: string;
  baseRevision: number;
  modelDigest: string;
  status: "actor-decision" | "human-decision" | "needs-resolution";
  /** Present only with needs-resolution. */
  code?: AuthorityRouteCode;
  responsibleOperatorId?: string;
  designatedDecider?: {
    operatorId: string;
    executionSpaceId: string;
    policyId: string;
    policyRevision: number;
  };
  trace: Array<
    {
      operatorId: string;
      executionSpaceId: string;
      eligibility: "eligible" | "not-covered";
      policyId?: string;
      policyRevision?: number;
    }
  >;
  reason?: string;
}

/** Notices report facts to the opener; none exercises delegated authority. */
export type OperatorNotice =
  | {
    kind: "authority-escalation";
    changeId: string;
    requestedBy: string;
    caseId: string;
    recipient: string;
    /** What the relayed diff card loads; absent on historical notices. */
    changeKind?: PendingChange["kind"];
    requestedRights?:
      import("./records/pending-change.ts").MandateRequestedRights;
    decisionAuthority: "operator" | "human" | "unresolved";
    /** Persisted historical notices may hold a version 1 route: data only. */
    route?: RequestAuthorityRoute;
    reason: string;
  }
  | {
    kind: "request-completed";
    caseId: string;
    owner: string;
    openedBy: string;
    status: "closed-done" | "closed-abandoned";
    result: string;
  }
  | {
    /** Spec 4.8e E6: another operator than the parent ordered one of its
     * sub-operators. Observation only: the order was already accepted. */
    kind: "subordinate-order";
    /** The accepted order's invocation: one notice per order. */
    invocationId: string;
    caseId: string;
    /** The sub-operator that received the order. */
    subordinate: string;
    /** Who ordered it; the space is named only when the order crossed
     * from another space (the Main Operator in main). */
    orderedBy: { operatorId: string; executionSpaceId?: string };
    /** The order's text, bounded; data, never an instruction. */
    summary: string;
  };

/** Bounded untrusted text; receiving a notice never executes a decision. */
export function boundedOperatorNoticeText(text: string): string {
  const marker = "… [truncated]";
  return text.length <= 1000
    ? text
    : text.slice(0, 1000 - marker.length) + marker;
}

export function validateOperatorCreationGrant(
  value: unknown,
): OperatorCreationGrant {
  const keys = ["networkHosts", "maxChildren", "maxDelegationDepth"];
  if (
    !!value && typeof value === "object" && !Array.isArray(value) &&
    (value as Record<string, unknown>).mode !== undefined
  ) keys.push("mode");
  if (
    !exact(value, keys) ||
    !Number.isSafeInteger(value.maxChildren) || Number(value.maxChildren) < 1 ||
    Number(value.maxChildren) > MAX_OPERATOR_UNITS ||
    !Number.isSafeInteger(value.maxDelegationDepth) ||
    Number(value.maxDelegationDepth) < 0 ||
    Number(value.maxDelegationDepth) >= MAX_OPERATOR_UNITS ||
    value.mode !== undefined &&
      value.mode !== "autonomous" && value.mode !== "per-creation"
  ) {
    throw new OperatorAuthorityError(
      "INVALID_OPERATOR_REQUEST",
      `Expected exact creation hosts, child count 1–${MAX_OPERATOR_UNITS}, delegation depth 0–${
        MAX_OPERATOR_UNITS - 1
      } and an optional creation mode`,
    );
  }
  return {
    networkHosts:
      validateNetworkScope({ allowedHosts: value.networkHosts }).allowedHosts,
    maxChildren: Number(value.maxChildren),
    maxDelegationDepth: Number(value.maxDelegationDepth),
    ...(value.mode === undefined ? {} : { mode: value.mode }),
  };
}

/** Required resource bounds are exact; model rights are optional explicit opt-ins. */
function validateTeamOperatorProvision(
  value: unknown,
): TeamOperatorProvision {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorAuthorityError(
      "INVALID_OPERATOR_REQUEST",
      "Expected a team provision object",
    );
  }
  const { mayConsultModel, mayProposeSysmlRevision, ...required } =
    value as Record<string, unknown>;
  for (const field of ["mayConsultModel", "mayProposeSysmlRevision"] as const) {
    if (
      Object.hasOwn(value, field) &&
      typeof (value as Record<string, unknown>)[field] !== "boolean"
    ) {
      throw new OperatorAuthorityError(
        "INVALID_OPERATOR_REQUEST",
        "Provisioned model rights must be explicit booleans",
        { field },
      );
    }
  }
  if (mayProposeSysmlRevision === true && mayConsultModel !== true) {
    throw new OperatorAuthorityError(
      "INVALID_OPERATOR_REQUEST",
      "Revision provision requires an explicit model read provision",
      { field: "mayConsultModel" },
    );
  }
  const budget = required.budget;
  if (
    !exact(required, [
      "budget",
      "networkHosts",
      "mayPropose",
      "mayInvokeActiveCatalog",
      ...(required.mayAddNetworkHosts !== undefined
        ? ["mayAddNetworkHosts"]
        : []),
    ]) ||
    !exact(budget, ["maxAgentDecisions", "maxToolProposals", "maxFlowSteps"]) ||
    !Number.isSafeInteger(budget.maxAgentDecisions) ||
    Number(budget.maxAgentDecisions) < 1 ||
    !Number.isSafeInteger(budget.maxToolProposals) ||
    Number(budget.maxToolProposals) < 0 ||
    !Number.isSafeInteger(budget.maxFlowSteps) ||
    Number(budget.maxFlowSteps) < 1 ||
    !Array.isArray(required.mayPropose) ||
    new Set(required.mayPropose).size !== required.mayPropose.length ||
    required.mayPropose.some((kind: unknown) =>
      !(TOOL_KINDS as readonly unknown[]).includes(kind)
    ) ||
    typeof required.mayInvokeActiveCatalog !== "boolean" ||
    (required.mayAddNetworkHosts !== undefined &&
      typeof required.mayAddNetworkHosts !== "boolean")
  ) {
    throw new OperatorAuthorityError(
      "INVALID_OPERATOR_REQUEST",
      "Expected an exact team provision: budget, hosts, proposal kinds and catalog invocation",
    );
  }
  return {
    budget: {
      maxAgentDecisions: Number(budget.maxAgentDecisions),
      maxToolProposals: Number(budget.maxToolProposals),
      maxFlowSteps: Number(budget.maxFlowSteps),
    },
    networkHosts: validateNetworkScope({ allowedHosts: required.networkHosts })
      .allowedHosts,
    mayPropose: TOOL_KINDS.filter((kind) =>
      (required.mayPropose as unknown[]).includes(kind)
    ),
    mayInvokeActiveCatalog: required.mayInvokeActiveCatalog,
    ...(required.mayAddNetworkHosts !== undefined
      ? { mayAddNetworkHosts: required.mayAddNetworkHosts as boolean }
      : {}),
    ...(mayConsultModel === undefined
      ? {}
      : { mayConsultModel: mayConsultModel as boolean }),
    ...(mayProposeSysmlRevision === undefined
      ? {}
      : { mayProposeSysmlRevision: mayProposeSysmlRevision as boolean }),
  };
}

export function validateOperatorCreationSpec(
  value: unknown,
): OperatorCreationSpec {
  if (
    value && typeof value === "object" && "kind" in value &&
    value.kind === "request-team-member"
  ) {
    const v = value as Record<string, unknown>;
    const keys = [
      "kind",
      "instruction",
      "provision",
      ...(v.creationGrant === undefined ? [] : ["creationGrant"]),
      ...(v.flowTemplate === undefined ? [] : ["flowTemplate"]),
    ];
    if (!exact(v, keys) || !text(v.instruction, 4000)) {
      throw new OperatorAuthorityError(
        "INVALID_OPERATOR_REQUEST",
        "Expected an exact team member instruction, provision and optional creation grant",
      );
    }
    return {
      kind: "request-team-member",
      instruction: v.instruction,
      provision: validateTeamOperatorProvision(v.provision),
      ...(v.creationGrant === undefined
        ? {}
        : { creationGrant: validateOperatorCreationGrant(v.creationGrant) }),
      ...(v.flowTemplate === undefined
        ? {}
        : { flowTemplate: validateFlowTemplate(v.flowTemplate) }),
    };
  }
  return validateRequestOperatorSpec(value);
}
