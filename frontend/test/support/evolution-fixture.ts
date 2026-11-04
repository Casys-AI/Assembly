import type { EvolutionConversationRecord } from "../../../src/domain/work/records/operator-evolution.ts";
import type { Message } from "../../../src/application/work/runtime/state.ts";
export function evolutionRecord(
  patch: Partial<EvolutionConversationRecord> = {},
): EvolutionConversationRecord {
  return {
    dossierId: "evolution:flow",
    revision: 1,
    status: "prepared",
    proposalId: "proposal:flow",
    proposalDigest: "proposal-digest",
    createdAt: "2026-10-27T01:00:00Z",
    updatedAt: "2026-10-27T01:00:00Z",
    reason: "Consult the declared source before deciding.",
    origin: { operatorId: "native:designer", designerScopeId: "scope:main" },
    preparer: { operatorId: "native:designer", name: "Main" },
    finalizer: { operatorId: "native:designer", name: "Main" },
    categories: ["flow", "instructions"],
    targets: [{
      operatorId: "native:research",
      name: "Research",
      previousDigest: "previous",
      candidateDigest: "candidate",
    }],
    base: { version: "commit:base", sourceDigest: "base-source" },
    candidate: {
      version: "commit:candidate",
      sourceDigest: "candidate-source",
    },
    recipeDigest: "recipe",
    adoptions: [],
    blockers: [],
    ...patch,
  };
}
export function evolutionMessage(record = evolutionRecord()): Message {
  return {
    id: `evolution:${record.dossierId}:${record.revision}`,
    at: record.updatedAt,
    role: "tool",
    text: "Legacy result text",
    designerScopeId: record.origin.designerScopeId,
    caseId: record.origin.requestId,
    observation: { kind: "operator-evolution", value: record },
  };
}

/** A real typed preparation authorization, distinct from owner-control. */
export function evolutionAuthorization(
  operatorId = "native:designer",
): import("../../../src/domain/model/evolution/policy.ts").EvolutionProposalAuthorization {
  return {
    kind: "operator-evolution",
    operatorNativeId: operatorId,
    systemQualifiedName: "System",
    recipeDigest: "recipe",
    editAuthorization: {
      kind: "operator",
      operatorNativeId: operatorId,
      systemQualifiedName: "System",
      operatorQualifiedName: "System::operator",
      mandateId: "mandate",
      mandateRevision: 1,
      policyId: "edit",
      policyRevision: 1,
      policyDigest: "edit-digest",
      operations: ["set-value"],
    },
    exercise: {
      act: "prepare",
      operatorNativeId: operatorId,
      systemQualifiedName: "System",
      authorityDigest: "authority",
      policyId: "evolution",
      policyRevision: 1,
      mandateNativeId: "mandate:native",
      mandateId: "mandate",
      mandateRevision: 1,
      targets: ["native:research"],
      categories: ["flow"],
      proposalDigest: "proposal-digest",
    },
  };
}
