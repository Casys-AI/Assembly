import { shortDate } from "../dates.ts";
import { sameSourceVersion } from "../model/revisions/api.ts";
import type { CaseModelScope } from "../case-model-scope.ts";

export type VersionSource =
  | { kind: "main" }
  | {
    kind: "request";
    number?: number;
    caseId?: string;
    branchId?: string;
    baseVersion?: string;
  }
  | { kind: "release"; name: string; id: string };

/** Display metadata only. An address pin says nothing about runtime adoption. */
export interface VersionInfo {
  source: VersionSource;
  version?: string;
  createdAt?: string;
  inService?: string;
  headVersion?: string;
  modelDigest?: string;
  qualifiedName?: string;
  readOnly?: boolean;
}

export function requestVersionInfo(
  request: { id: string; number?: number },
  scope?: CaseModelScope,
): VersionInfo {
  return {
    source: {
      kind: "request",
      caseId: request.id,
      number: request.number,
      branchId: scope?.branchId,
      baseVersion: scope?.baseVersion,
    },
    version: scope?.version,
    inService: scope?.executionVersion,
    headVersion: scope?.branchVersion,
    readOnly: true,
  };
}

/** Dates belong to the exact commit, never to the system or Request's birth. */
export function versionLabel(info: VersionInfo): string {
  const { source, version, createdAt } = info;
  if (source.kind === "release") return source.name;
  if (source.kind === "request") {
    const name = source.number === undefined
      ? "Request"
      : `Request ${source.number}`;
    return version && source.baseVersion &&
        !sameSourceVersion(version, source.baseVersion)
      ? `${name} · modified`
      : name;
  }
  return createdAt && !Number.isNaN(Date.parse(createdAt))
    ? `Main · ${shortDate(createdAt)}`
    : "Main";
}

export const VERSION_STATUS_LABELS = {
  "in-service": "In service",
  "not-in-service": "Not in service",
  "past": "Past version",
  "version-unavailable": "Version unavailable",
  "service-unknown": "Service status unavailable",
} as const;
export type VersionStatus = keyof typeof VERSION_STATUS_LABELS;

export function versionStatus(info: VersionInfo): VersionStatus {
  if (!info.version) return "version-unavailable";
  if (!info.inService) return "service-unknown";
  if (sameSourceVersion(info.version, info.inService)) return "in-service";
  return info.headVersion && !sameSourceVersion(info.version, info.headVersion)
    ? "past"
    : "not-in-service";
}

/** The same exact facts serve the tooltip and the expandable inspector. */
export function versionFacts(info: VersionInfo): [string, string][] {
  const { source } = info;
  const facts: [string, string | undefined][] = [
    ["Status", VERSION_STATUS_LABELS[versionStatus(info)]],
    ["Version", info.version],
    [
      "Created (UTC)",
      info.createdAt ??
        (source.kind === "main" ? "Commit date unavailable" : undefined),
    ],
    ["Request", source.kind === "request" ? source.caseId : undefined],
    ["Branch", source.kind === "request" ? source.branchId : undefined],
    ["Release", source.kind === "release" ? source.id : undefined],
    ["In service", info.inService],
    ["Admitted source", info.headVersion],
    [
      "Base version",
      source.kind === "request" ? source.baseVersion : undefined,
    ],
    ["Model digest", info.modelDigest],
    ["System", info.qualifiedName],
    ["Access", info.readOnly ? "Read-only" : undefined],
  ];
  return facts.filter((fact): fact is [string, string] =>
    fact[1] !== undefined
  );
}
