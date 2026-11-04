import {
  canonicalDigest,
  isSha256Hex,
} from "../../primitives/execution-digest.ts";
import {
  sourceIdentity,
  validateSourceBindingReference,
} from "../artifacts/source-reference.ts";
import type { SavedOperatorManifest } from "./saved-systems.ts";
import type { OpeningRecord } from "../request-spaces/opening.ts";
import type { RequestSpaceScope } from "../request-spaces/scope.ts";

export interface RetainedToolDependencyDescriptor {
  readonly format: "request-retained-tool/v1";
  readonly target: RequestSpaceScope & {
    readonly executionSpaceId: string;
    readonly caseId: string;
    readonly openingId: string;
    readonly operatorId: string;
    readonly admissionId: string;
  };
  readonly openingBaseDigest: string;
  readonly tool: {
    readonly candidateId: string;
    readonly digest: string;
    readonly sourceBinding: NonNullable<
      SavedOperatorManifest["tools"][number]["sourceBinding"]
    >;
  };
}
export interface RetainedToolInvocationTarget {
  readonly resourceId: string;
  readonly descriptorDigest: string;
  readonly toolId: string;
  readonly toolDigest: string;
}
const identity = (value: unknown): value is string =>
  sourceIdentity(value) && value !== "*";
const digest = (value: unknown): value is string => isSha256Hex(value);

/** No current R pin in this identity: instruction-only adoption cannot rebind resources. */
export async function retainedToolResourceId(
  descriptor: RetainedToolDependencyDescriptor,
): Promise<string> {
  const target = descriptor.target, tool = descriptor.tool;
  const keys = (value: object, expected: string) =>
    Object.keys(value).sort().join(",") === expected;
  if (
    !keys(descriptor, "format,openingBaseDigest,target,tool") ||
    !keys(
      target,
      "admissionId,caseId,executionSpaceId,openingId,operatorId,projectId,systemId",
    ) ||
    !keys(tool, "candidateId,digest,sourceBinding")
  ) throw new Error("Invalid retained tool descriptor fields");
  if (
    descriptor.format !== "request-retained-tool/v1" ||
    !Object.values(target).every(identity) ||
    target.executionSpaceId === "main" ||
    !digest(descriptor.openingBaseDigest) || !identity(tool.candidateId) ||
    !digest(tool.digest)
  ) {
    throw new Error("Invalid retained tool dependency target");
  }
  validateSourceBindingReference(tool.sourceBinding);
  if (
    tool.sourceBinding.ownerId !== target.operatorId ||
    tool.sourceBinding.localArtifactId !== tool.candidateId ||
    tool.sourceBinding.reference.kind !== "tool-draft" ||
    tool.sourceBinding.reference.contentDigest !== tool.digest
  ) {
    throw new Error("Retained tool dependency source differs");
  }
  return `retained-tool:v1:${await canonicalDigest(descriptor)}`;
}
export const retainedToolAdmissionId = async (
  scope: RequestSpaceScope,
  openingId: string,
): Promise<string> => {
  if (![scope.projectId, scope.systemId, openingId].every(identity)) {
    throw new Error("Invalid retained tool admission target");
  }
  return `admission-${await canonicalDigest({
    format: "request-retained-tool-admission/v1",
    scope,
    openingId,
  })}`;
};
/** Pure projection from the recorded owner closure; no runtime discovery or grant. */
export function retainedToolDescriptors(
  record: Pick<
    OpeningRecord,
    "scope" | "id" | "caseId" | "executionSpaceId" | "base" | "baseDigest"
  >,
  admissionId: string,
): RetainedToolDependencyDescriptor[] {
  const base = record.base;
  const owners = base?.manifest.operators.filter((item) =>
    item.operatorId === base.requestOwner.operatorId
  );
  if (!base || !record.baseDigest || owners?.length !== 1) {
    throw new Error("Retained tool opening is unavailable");
  }
  const tools = owners[0].tools;
  if (
    tools.length > 256 ||
    new Set(tools.map((tool) => tool.candidateId)).size !== tools.length
  ) throw new Error("Ambiguous retained tool closure");
  return [...tools].sort((a, b) =>
    a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0
  ).map((tool): RetainedToolDependencyDescriptor => {
    if (!tool.sourceBinding) {
      throw new Error("Retained tool binding is unavailable");
    }
    return {
      format: "request-retained-tool/v1",
      target: {
        ...record.scope,
        openingId: record.id,
        caseId: record.caseId,
        executionSpaceId: record.executionSpaceId,
        operatorId: base.requestOwner.operatorId,
        admissionId,
      },
      openingBaseDigest: record.baseDigest!,
      tool: {
        candidateId: tool.candidateId,
        digest: tool.digest,
        sourceBinding: structuredClone(tool.sourceBinding),
      },
    };
  });
}
