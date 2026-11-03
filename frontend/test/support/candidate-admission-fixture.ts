import type { OwnerAuthority } from "../../../src/domain/governance/authority.ts";
import {
  type Candidate,
  TOOL_CONTRACTS,
} from "../../../src/domain/work/candidates.ts";
import { snapshot } from "./workbench-fixture.ts";

export function delegatedCandidate(): Candidate {
  const candidate = snapshot().candidates[0]!;
  candidate.requiredAuthority = "human";
  candidate.caseId = "ui-fixture:case:2";
  candidate.stage = "active";
  candidate.promotionModelDigest = "model-before-admission";
  candidate.toolAdmissionContract = {
    ...structuredClone(TOOL_CONTRACTS[0]!),
    nativeId: "contract:read",
  };
  candidate.toolAdmissionPolicyPins = [{
    policyId: "research-tools",
    policyRevision: 1,
    holderNativeId: "native:designer",
    policyElementId: "tool-policy:1",
  }];
  const issuer: OwnerAuthority = {
    ownerSource: "modeled",
    systemId: "main-system",
    operatorId: "owner",
    operatorNativeId: "native:person",
    mandateId: "owner-mandate",
    mandateNativeId: "native:owner-mandate",
    mandateRevision: 1,
    rootAuthorityId: "root",
    rootAuthorityNativeId: "native:root",
    rootGrantId: "root-grant",
    rootGrantNativeId: "native:root-grant",
    sourceIds: ["owner-source"],
  };
  const authorityExercise = {
    ...issuer,
    authoritySchema: 2 as const,
    action: "candidate-admission" as const,
    baseModelDigest: candidate.promotionModelDigest,
    outOfMandate: false,
    candidateDelegation: {
      actorId: "native:designer",
      requestedBy: "native:research",
      policyId: "research-tools",
      policyRevision: 1,
      policyElementId: "tool-policy:1",
      policyIssuer: issuer,
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      caseId: candidate.caseId,
      toolKind: candidate.kind,
      tests: structuredClone(candidate.tests!),
      contract: structuredClone(candidate.toolAdmissionContract),
    },
  };
  candidate.admissionDecision = {
    candidateDigest: candidate.digest,
    verdict: "approve",
    reason: "The exact checks meet the contract",
    authorityExercise,
  };
  candidate.admission = {
    candidateId: candidate.id,
    candidateDigest: candidate.digest,
    authority: "delegate",
    actorId: "native:designer",
    mandateRevision: 1,
    configurationRevision: 1,
    reason: candidate.admissionDecision.reason,
    at: "2026-10-26T00:00:00Z",
    authorityExercise,
  };
  return candidate;
}
