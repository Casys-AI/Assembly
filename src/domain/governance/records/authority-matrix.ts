import type { BoardGrant } from "../../model/records/board.ts";
import type { ModelEditOperation } from "../policies/model-edit-policy.ts";
import type { ModelRevisionId } from "../../shared-kernel/revision-id.ts";
import { parseSysmlQualifiedName } from "../../model/value-objects/sysml-qualified-name.ts";
import { TOOL_KINDS, type ToolKind } from "../../shared-kernel/tool-kind.ts";

/** Read-only Rights contract. It describes declared authority at an adopted
 * commit; execution still passes the host's checks. No SysML text is read here. */
export const MATRIX_SCHEMA = "ase.authority-matrix/1" as const;
export type AuthoritySchema = "legacy-v1" | "owner-modeled";
export type MatrixFamily =
  | "tools"
  | "admission"
  | "mandate"
  | "model"
  | "memory-skills"
  | "behaviors";
export type MatrixCellState =
  | "allowed"
  | "propose-only"
  | "denied"
  | "inherited"
  | "delegated";
export type MatrixGrantMode = "execute" | "propose" | "review" | "admit";
export type MatrixBasis = "declared" | "closed-world" | "host-rule";

export const MATRIX_FIXED_COLUMN_IDS = [
  "tool.invoke",
  "network.reach",
  "candidate.review",
  "candidate.admit",
  "candidate.activate",
  "operator.create:reviewer",
  "mandate.rewrite",
  "operator.spawn",
  "model.consult",
  "model.edit",
  "model.administer",
  "model.decide",
  "model.adopt",
] as const;
export const MATRIX_MANDATE_CHANGES = [
  "network-hosts",
  "url-selection",
  "self-admission",
] as const;
export const MATRIX_BEHAVIOR_KINDS = [
  "context-evidence",
  "memory-capture",
  "memory-recall",
  "memory-revise",
  "memory-review",
  "memory-withdraw",
  "skill-install",
  "skill-list",
  "skill-load",
  "skill-unload",
  "work-plan",
  "inbox",
  "reuse-tool",
  "published-tools",
  "inspect-work-artifacts",
] as const;
export type MatrixBehaviorKind = typeof MATRIX_BEHAVIOR_KINDS[number];

/** The discriminant survives JSON transport. The id retains the prototype's
 * spelling; only the unit suffix varies, and its runtime parser checks qnames. */
export type MatrixColumnKey =
  | { kind: "fixed"; id: typeof MATRIX_FIXED_COLUMN_IDS[number] }
  | { kind: "tool-build"; id: `tool.build:${ToolKind}` }
  | {
    kind: "mandate-change";
    id: `mandate.change:${typeof MATRIX_MANDATE_CHANGES[number]}`;
  }
  | { kind: "behavior"; id: `behavior:${MatrixBehaviorKind}@${string}` };
export type MatrixColumnId = MatrixColumnKey["id"];

export function parseMatrixColumnId(value: string): MatrixColumnKey {
  if (MATRIX_FIXED_COLUMN_IDS.some((id) => id === value)) {
    return {
      kind: "fixed",
      id: value as typeof MATRIX_FIXED_COLUMN_IDS[number],
    };
  }
  if (TOOL_KINDS.some((kind) => value === `tool.build:${kind}`)) {
    return { kind: "tool-build", id: value as `tool.build:${ToolKind}` };
  }
  if (
    MATRIX_MANDATE_CHANGES.some((kind) => value === `mandate.change:${kind}`)
  ) {
    return {
      kind: "mandate-change",
      id: value as `mandate.change:${typeof MATRIX_MANDATE_CHANGES[number]}`,
    };
  }
  for (const kind of MATRIX_BEHAVIOR_KINDS) {
    const prefix = `behavior:${kind}@`;
    if (
      value.startsWith(prefix) &&
      parseSysmlQualifiedName(value.slice(prefix.length))
    ) {
      return {
        kind: "behavior",
        id: value as `behavior:${MatrixBehaviorKind}@${string}`,
      };
    }
  }
  throw new Error("Invalid authority matrix column id");
}

/** Qualifiers the prototype uses when interpreting a granted right. */
export const UNUSABLE = [
  "RIGHT_WITHOUT_OBJECT",
  "EFFECTIVELY_UNREACHABLE",
  "NO_REACHABLE_HOST",
  "NETWORK_SCOPE_UNUSED",
] as const;
export const BY_HUMAN = [
  "NEEDS_HUMAN_DECISION",
  "ADMISSION_BY_HUMAN",
  "PRIVATE_UNTIL_DECIDED",
] as const;
export const MATRIX_CELL_CODES = [
  ...UNUSABLE,
  ...BY_HUMAN,
  "HARD_DENIED",
  "HOST_RESERVED",
  "OWNER_ONLY_PATH",
  "OWNER_ROOT_GRANT_UNDIFFERENTIATED",
  "OWNER_IMPLICIT",
  "ADMISSION_BY_BUILDER",
  "ADMISSION_BY_REVIEWER",
  "HUMAN_ADMISSION_NOT_REQUIRED",
  "MODEL_POLICY_FORBIDS",
  "NO_ADMINISTRATION_POLICY",
  "NO_EDIT_POLICY",
  "NO_HOSTS_DECLARED",
  "SELF_ADMISSION_FORBIDDEN",
  "POLICY_INACTIVE_WITHOUT_FLAG",
  "EXPOSURE_DISABLED",
  "ALREADY_CREATED",
  "ALREADY_DELEGATED",
] as const;
export type MatrixCellCode = typeof MATRIX_CELL_CODES[number];
export function isMatrixCellCode(value: string): value is MatrixCellCode {
  return MATRIX_CELL_CODES.some((code) => code === value);
}

export type MatrixSourceRole =
  | "grant"
  | "flag"
  | "scope"
  | "exposure"
  | "binding"
  | "allocation"
  | "condition"
  | "holder"
  | "target"
  | "root";
export interface MatrixSourceRef {
  role: MatrixSourceRole;
  elementId: string;
  qname?: string;
  file?: string;
  line?: number;
  column?: number;
}

/** B5 resolves these names to exported host symbols. Coordinates are never
 * encoded here: moving a host rule must not silently stale its reference. */
export type MatrixEnforcementAnchor =
  | "humanAdmission"
  | "humanApprovesChange"
  | "localOwnerModel"
  | "ownerRevisions";
export type MatrixVia =
  | { kind: "own-declaration" }
  | { kind: "unit-configuration"; attribute: string }
  | { kind: "exposure"; accessName: string; accessId: string }
  | {
    kind: "delegation";
    record: string;
    revision: number;
    issuerSystem: string;
    chainDigest: string;
    chain: readonly {
      kind: "root" | "delegation";
      id: string;
      revision: number;
      system: string;
    }[];
  }
  | { kind: "root-grant"; grant: string; mandate: string }
  | { kind: "host-rule"; rule: string; enforcedAt: MatrixEnforcementAnchor };

export interface MatrixScope {
  /** Same canonical grant owner as the board; never a second grant parser. */
  grants?: readonly BoardGrant[];
  operations?: readonly ModelEditOperation[];
  hosts?: readonly string[];
  activeTools?: readonly string[];
  /** Capability-specific bounds supplied by the projector. */
  readonly [bound: string]: unknown;
}
export interface MatrixCell {
  row: string;
  column: MatrixColumnId;
  state: MatrixCellState;
  display: "allowed" | "propose-only" | "denied";
  /** Absent when denied. */
  mode?: MatrixGrantMode;
  basis: MatrixBasis;
  sources: readonly MatrixSourceRef[];
  via?: MatrixVia;
  scope?: MatrixScope;
  codes: readonly MatrixCellCode[];
  uncertain?: { code: "NOT_FROM_COMPILER"; reason: string };
  origin: "compiler" | "projector-fallback" | "host-rule";
}
export interface MatrixGroup {
  id: MatrixFamily;
  label: string;
  order: number;
}
type MatrixFixedColumnId = typeof MATRIX_FIXED_COLUMN_IDS[number];
type MatrixMandateChange = typeof MATRIX_MANDATE_CHANGES[number];
type MatrixFixedFamily<Id extends MatrixFixedColumnId> = Id extends
  "tool.invoke" | "network.reach" ? "tools"
  : Id extends `candidate.${string}` ? "admission"
  : Id extends `model.${string}` ? "model"
  : "mandate";

type MatrixColumnSelection =
  | {
    [Id in MatrixFixedColumnId]:
      & {
        kind: "fixed";
        id: Id;
        group: MatrixFixedFamily<Id>;
      }
      & (Id extends "operator.create:reviewer" ? {
          target: { kind: "change"; ref: "reviewer" };
        }
        : { target?: never });
  }[MatrixFixedColumnId]
  | {
    [Kind in ToolKind]: {
      kind: "tool-build";
      id: `tool.build:${Kind}`;
      group: "tools";
      target: { kind: "tool-kind"; ref: Kind };
    };
  }[ToolKind]
  | {
    [Change in MatrixMandateChange]: {
      kind: "mandate-change";
      id: `mandate.change:${Change}`;
      group: "mandate";
      target: { kind: "change"; ref: Change };
    };
  }[MatrixMandateChange]
  | {
    [Kind in MatrixBehaviorKind]: {
      kind: "behavior";
      id: `behavior:${Kind}@${string}`;
      group: Kind extends
        `context-${string}` | `memory-${string}` | `skill-${string}`
        ? "memory-skills"
        : "behaviors";
      target: { kind: "entry-kind"; ref: Kind; unit: string };
    };
  }[MatrixBehaviorKind];

/** Group and target follow the closed column kind/id, never independent hints. */
export type MatrixColumn = MatrixColumnSelection & {
  capability: string;
  inTypedPlan: boolean;
  label: string;
  mode: MatrixGrantMode;
  tier: "core" | "detail";
  order: number;
  typedScope:
    | "NetworkScope"
    | "ModelScope"
    | "MandateScope"
    | "none"
    | "missing-in-plan";
  doc: string;
};
export interface MatrixRow {
  id: string;
  kind: "software" | "human";
  role: "builder" | "reviewer" | "owner";
  label: string;
  unit: string;
  /** False for the implicit legacy owner. */
  declared: boolean;
  element?: MatrixSourceRef;
  endpoint?: { name: string; primary: boolean; humanInput: boolean };
  limits?: Readonly<Record<string, number | string>>;
  principal?: string;
}
export type MatrixDiagnosticCode =
  | "EXPOSURE_MISMATCH"
  | "DISABLED_EXPOSURE_UNRESOLVED"
  | "UNSUPPORTED_BEHAVIOR_TARGET"
  | "OWNER_IMPLICIT"
  | "RIGHT_WITHOUT_OBJECT"
  | "REVISION_FLAG_WITHOUT_EDIT_POLICY"
  | "MEMORY_REVIEW_UNREACHABLE"
  | "SOURCE_COORDINATE_MISMATCH"
  | "INVALID_MODEL_EDIT_GRANTS";
export interface MatrixDiagnostic {
  code: MatrixDiagnosticCode;
  severity: "error" | "warning" | "info";
  context: Record<string, unknown>;
  recovery: string;
}
export interface MatrixDelegationStatus {
  id: string;
  revision: number;
  issuerSystem: string;
  targetSystem: string;
  active: boolean;
  reason?: string;
}
export type MatrixCaveat =
  | "ADOPTED_VERSION_ONLY"
  | "ALLOWED_IS_DECLARED_NOT_EXECUTED"
  | "ABSENT_CELL_IS_NOT_APPLICABLE"
  | "OWNER_CELLS_ARE_HOST_RULES_BEFORE_LOT_3";
export interface AuthorityMatrix {
  schema: typeof MATRIX_SCHEMA;
  version: ModelRevisionId;
  model: {
    name: string;
    sourceDigest: string;
    toolkit: string;
    authoritySchema: AuthoritySchema;
    units: readonly { system: string; executionDigest: string }[];
  };
  groups: readonly MatrixGroup[];
  rows: readonly MatrixRow[];
  columns: readonly MatrixColumn[];
  cells: readonly MatrixCell[];
  delegations: readonly MatrixDelegationStatus[];
  diagnostics: readonly MatrixDiagnostic[];
  caveats: readonly ["ADOPTED_VERSION_ONLY", ...MatrixCaveat[]];
  summary: {
    byState: Readonly<Record<MatrixCellState, number>>;
    uncertain: number;
    hostRule: number;
    byRow: Readonly<Record<string, Readonly<Record<MatrixCellState, number>>>>;
    coordinates: { checked: number; mismatches: number };
  };
  digest: string;
}
