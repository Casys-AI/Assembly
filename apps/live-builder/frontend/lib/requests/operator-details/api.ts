import type {
  RequestOperatorDetailsSnapshot,
  RequestOperatorObservedSource,
} from "../../../../src/application/work/request-spaces/operator-details-view.ts";
import { parseModelRevisionId } from "../../../../src/domain/shared-kernel/revision-id.ts";
import { requestSpaceIdentity } from "../../../../src/domain/work/request-spaces.ts";
import {
  type ArtifactSourceBindingReference,
  sourceDigest,
  sourceIdentity,
  validateSourceBindingReference,
} from "../../../../src/domain/work/artifacts/source-reference.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown, minimum = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;
const text = (
  value: unknown,
  maximum: number,
  empty = false,
): value is string =>
  typeof value === "string" && value.length <= maximum &&
  (empty || !!value.trim()) && !value.includes("\0");
function invalid(): never {
  throw new Error("The exact Request details are unavailable.");
}
export interface RequestDetailsExpectation {
  caseId: string;
  operatorId: string;
  modelDigest: string;
  version?: string;
  executionSpaceId?: string;
}
function binding(
  value: unknown,
  id: string,
  digest: string,
  operatorId: string,
  kind: "tool-draft" | "skill-document",
): ArtifactSourceBindingReference {
  validateSourceBindingReference(value);
  if (
    value.ownerId !== operatorId || value.localArtifactId !== id ||
    value.reference.kind !== kind || value.reference.contentDigest !== digest
  ) invalid();
  return structuredClone(value);
}
function observed(
  value: unknown,
  expected: RequestDetailsExpectation,
): RequestOperatorObservedSource {
  if (
    !object(value) || !object(value.source) ||
    !sourceIdentity(value.source.repositoryId) ||
    typeof value.source.version !== "string" ||
    value.source.version !== expected.version ||
    !sourceDigest(value.modelDigest) ||
    value.modelDigest !== expected.modelDigest ||
    !object(value.sourceAdmission) ||
    !integer(value.sourceAdmission.revision, 1) ||
    !sourceDigest(value.sourceAdmission.manifestDigest)
  ) invalid();
  let adoption: RequestOperatorObservedSource["adoption"] = null;
  if (value.adoption !== null) {
    const raw = value.adoption;
    if (
      !object(raw) || !sourceIdentity(raw.commandId) ||
      !sourceDigest(raw.receiptDigest) || !integer(raw.committedRuntimeRevision)
    ) invalid();
    adoption = {
      commandId: raw.commandId,
      receiptDigest: raw.receiptDigest,
      committedRuntimeRevision: raw.committedRuntimeRevision,
    };
  }
  return {
    source: {
      repositoryId: value.source.repositoryId,
      version: parseModelRevisionId(value.source.version),
    },
    modelDigest: value.modelDigest,
    sourceAdmission: {
      revision: value.sourceAdmission.revision,
      manifestDigest: value.sourceAdmission.manifestDigest,
    },
    adoption,
  };
}
/** Parse the rendered DTO at the HTTP boundary; no unchecked arrays reach JSX. */
export function parseRequestOperatorDetails(
  value: unknown,
  expected: RequestDetailsExpectation,
): RequestOperatorDetailsSnapshot {
  if (
    !object(value) || !requestSpaceIdentity(value.caseId) ||
    value.caseId !== expected.caseId ||
    !sourceIdentity(value.operatorId) ||
    value.operatorId !== expected.operatorId ||
    !requestSpaceIdentity(value.executionSpaceId) ||
    value.executionSpaceId === "main" ||
    expected.executionSpaceId !== undefined &&
      value.executionSpaceId !== expected.executionSpaceId ||
    !integer(value.runtimeRevision) || !Array.isArray(value.tools) ||
    value.tools.length > 256 || !object(value.skills)
  ) invalid();
  const observedSource = observed(value.observedSource, expected);
  const ids = new Set<string>();
  const tools = value.tools.map((raw) => {
    if (
      !object(raw) || !sourceIdentity(raw.id) || ids.has(raw.id) ||
      !text(raw.name, 4096) || !text(raw.description, 100_000, true) ||
      !sourceDigest(raw.digest)
    ) invalid();
    ids.add(raw.id);
    return {
      id: raw.id,
      name: raw.name,
      description: raw.description,
      digest: raw.digest,
      sourceBinding: binding(
        raw.sourceBinding,
        raw.id,
        raw.digest,
        expected.operatorId,
        "tool-draft",
      ),
    };
  });
  let skills: RequestOperatorDetailsSnapshot["skills"];
  if (value.skills.status === "unavailable") {
    if (!text(value.skills.reason, 4096)) invalid();
    skills = { status: "unavailable", reason: value.skills.reason };
  } else {
    if (
      value.skills.status !== "available" ||
      !integer(value.skills.revision, 1) ||
      !Array.isArray(value.skills.items) || value.skills.items.length > 128
    ) invalid();
    ids.clear();
    skills = {
      status: "available",
      revision: value.skills.revision,
      items: value.skills.items.map((raw) => {
        if (
          !object(raw) || !sourceIdentity(raw.id) || ids.has(raw.id) ||
          !text(raw.name, 200) || !text(raw.description, 1000, true) ||
          !sourceDigest(raw.digest) || typeof raw.loaded !== "boolean"
        ) invalid();
        ids.add(raw.id);
        return {
          id: raw.id,
          name: raw.name,
          description: raw.description,
          digest: raw.digest,
          loaded: raw.loaded,
          ...(raw.sourceBinding !== undefined
            ? {
              sourceBinding: binding(
                raw.sourceBinding,
                raw.id,
                raw.digest,
                expected.operatorId,
                "skill-document",
              ),
            }
            : {}),
        };
      }),
    };
  }
  return {
    caseId: value.caseId,
    executionSpaceId: value.executionSpaceId,
    operatorId: value.operatorId,
    observedSource,
    runtimeRevision: value.runtimeRevision,
    tools,
    skills,
  };
}
