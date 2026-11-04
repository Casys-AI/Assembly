import {
  canonicalDigest,
  isSha256Hex,
} from "../../primitives/execution-digest.ts";
import type { SavedSystemManifest } from "../records/saved-systems.ts";
import { MAX_OPERATOR_UNITS } from "../records/conversations.ts";
import {
  sourceIdentity,
  validateSourceBindingReference,
} from "../artifacts/source-reference.ts";
import {
  exactSourceVersion,
  RequestSpaceError,
  requestSpaceIdentity,
  type RequestSpaceScope,
} from "./scope.ts";
import type { MainOpener } from "./space-control.ts";

export type OpeningSourceChoice =
  | { kind: "current-main"; expectedVersion?: string }
  | { kind: "release"; releaseId: string; digest: string };
/** Public DTO: actor, execution scope, IDs, refs and permissions are host-owned. */
export interface OpeningCommand {
  openingKey: string;
  text: string;
  source: OpeningSourceChoice;
}

/** The recorded command: the public DTO, plus the host-captured opener of a
 * Main Operator opening. It is part of the command digest. */
export interface RecordedOpeningCommand extends OpeningCommand {
  opener?: MainOpener;
}
/** A Main Operator opening's key is derived from its opener, never typed. */
export async function mainOpeningKey(opener: MainOpener): Promise<string> {
  return `main-${await canonicalDigest({
    operator: opener.operator,
    conversationId: opener.origin.conversationId,
    designerScopeId: opener.origin.designerScopeId,
    openingId: opener.origin.openingId,
  })}`;
}
export interface OpeningBase {
  sourceKind: "current-main" | "release";
  release?: { id: string; digest: string };
  manifest: SavedSystemManifest;
  manifestDigest: string;
  requestOwner: { operatorId: string; caseTypeId: string };
}
export type OpeningPhase =
  | "allocated"
  | "source-selected"
  | "branch-ready"
  | "runtime-ready"
  | "admitted"
  | "dispatched";
export const OPENING_PHASES: readonly OpeningPhase[] = [
  "allocated",
  "source-selected",
  "branch-ready",
  "runtime-ready",
  "admitted",
  "dispatched",
];
export interface OpeningIdentity {
  id: string;
  caseId: string;
  caseNumber: number;
  executionSpaceId: string;
  branchId: string;
  initialContributionId: string;
}
export interface OpeningRecord extends OpeningIdentity {
  scope: RequestSpaceScope;
  ownerId: string;
  command: RecordedOpeningCommand;
  commandDigest: string;
  base: OpeningBase | null;
  baseDigest: string | null;
  phase: OpeningPhase;
  admissionId: string | null;
  revision: number;
  issues: string[];
  createdAt: string;
}

function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
}
export function openingCommand(value: unknown): OpeningCommand {
  if (
    !exact(value, ["openingKey", "text", "source"]) ||
    Object.keys(value).length !== 3 ||
    !requestSpaceIdentity(value.openingKey) || typeof value.text !== "string" ||
    !value.text.trim() || value.text.length > 100_000 ||
    value.text.includes("\0")
  ) {
    throw new RequestSpaceError(
      "INVALID_COMMAND",
      "An opening key, bounded request and source choice are required.",
    );
  }
  const source = value.source;
  if (
    !exact(source, ["kind", "expectedVersion", "releaseId", "digest"]) || !(
      source.kind === "current-main" && Object.keys(source).every((key) =>
          ["kind", "expectedVersion"].includes(key)
        ) &&
        (source.expectedVersion === undefined ||
          exactSourceVersion(source.expectedVersion)) ||
      source.kind === "release" && Object.keys(source).length === 3 &&
        requestSpaceIdentity(source.releaseId) &&
        isSha256Hex(source.digest)
    )
  ) {
    throw new RequestSpaceError(
      "INVALID_COMMAND",
      "Select current main or an exact Release.",
    );
  }
  return structuredClone({
    openingKey: value.openingKey,
    text: value.text.trim(),
    source,
  }) as OpeningCommand;
}
/** A recorded command, as stored: the public DTO and, for a Main Operator
 * opening, the exact host-captured opener (4.8d D3). */
export function recordedOpeningCommand(value: unknown): RecordedOpeningCommand {
  const invalid = () =>
    new RequestSpaceError(
      "INVALID_COMMAND",
      "The recorded opening command or its opener is invalid.",
    );
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid();
  }
  const { opener, ...command } = value as Record<string, unknown>;
  const parsed = openingCommand(command);
  if (opener === undefined) return parsed;
  const operator = (opener as Record<string, unknown>)?.operator;
  const origin = (opener as Record<string, unknown>)?.origin;
  if (
    !exact(opener, ["operator", "origin"]) ||
    Object.keys(opener).length !== 2 ||
    !exact(operator, [
      "projectId",
      "systemId",
      "executionSpaceId",
      "operatorId",
    ]) ||
    Object.keys(operator).length !== 4 ||
    !Object.values(operator).every((entry) =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 512
    ) ||
    !exact(origin, [
      "conversationId",
      "designerScopeId",
      "messageId",
      "openingId",
    ]) ||
    !Object.values(origin).every((entry) =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 512
    ) ||
    typeof origin.conversationId !== "string" ||
    typeof origin.designerScopeId !== "string" ||
    typeof origin.openingId !== "string"
  ) throw invalid();
  return {
    ...parsed,
    opener: structuredClone(opener) as unknown as MainOpener,
  };
}
export function assertOpeningBase(base: OpeningBase): void {
  const source = base.manifest?.source;
  if (
    !source || !exactSourceVersion(source.sourceVersion) ||
    !base.manifestDigest ||
    !base.manifest.operators.length ||
    base.manifest.operators.length > MAX_OPERATOR_UNITS ||
    !base.manifest.operators.some((operator) =>
      operator.operatorId === base.requestOwner?.operatorId
    ) ||
    !base.requestOwner.caseTypeId ||
    base.manifest.operators.some((operator) =>
      operator.repositoryVersion !== source.sourceVersion ||
      operator.tools.some((tool) => {
        try {
          if (!tool.sourceBinding) return true;
          validateSourceBindingReference(tool.sourceBinding);
          return tool.sourceBinding.ownerId !== operator.operatorId ||
            tool.sourceBinding.localArtifactId !== tool.candidateId ||
            tool.sourceBinding.reference.kind !== "tool-draft" ||
            tool.sourceBinding.reference.contentDigest !== tool.digest;
        } catch {
          return true;
        }
      })
    ) ||
    base.manifest.prerequisites.some((entry) =>
      entry.kind !== "host-runtime" && !(
        exact(entry, ["kind", "code", "operatorId"]) &&
        Object.keys(entry).length === 3 && entry.kind === "skill" &&
        entry.code === "SKILL_DEPENDENCY" && sourceIdentity(entry.operatorId) &&
        base.manifest.operators.filter((operator) =>
            operator.operatorId === entry.operatorId
          ).length === 1
      )
    ) ||
    (base.sourceKind === "release" &&
      (!base.release || base.release.digest !== base.manifestDigest))
  ) {
    throw new RequestSpaceError(
      "UNAVAILABLE",
      "This exact source or its supported retained dependencies are unavailable.",
    );
  }
}
export function assertBaseForChoice(
  base: OpeningBase,
  choice: OpeningSourceChoice,
): void {
  assertOpeningBase(base);
  if (
    base.sourceKind !== choice.kind ||
    choice.kind === "current-main" && choice.expectedVersion !== undefined &&
      choice.expectedVersion !== base.manifest.source!.sourceVersion ||
    choice.kind === "release" &&
      (base.release?.id !== choice.releaseId ||
        base.release?.digest !== choice.digest)
  ) {
    throw new RequestSpaceError(
      "OPENING_CONFLICT",
      "The resolved base differs from the exact opening source choice.",
    );
  }
}
