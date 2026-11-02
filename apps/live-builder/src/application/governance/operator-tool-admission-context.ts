import type { ExecutableModel } from "../../domain/model/execution/executable-model.ts";
import type {
  ChatContext,
  SystemRuntimeState,
} from "../../domain/work/dialogue.ts";
import { delegatedCandidateAuthorityExercise } from "../../domain/governance/policies/tool-admission-policy.ts";
import {
  mainExecutionSpace,
  OperatorAuthorityError,
} from "../../domain/governance/operator-authority.ts";
import { CaseError } from "../../domain/work/errors/case.ts";
import { candidateCaseInvocation } from "../work/operators/journal.ts";

/** Lightweight discovery only. Exact source pins and code are checked at inspection. */
export function toolAdmissionDecisionContext(
  actorModel: ExecutableModel,
  recipients: readonly SystemRuntimeState[],
): NonNullable<ChatContext["operatorToolAdmission"]> {
  const actorId = actorModel.identity.builderId;
  const policies = structuredClone(actorModel.toolAdmissionPolicies ?? [])
    .filter((policy) => policy.holderNativeId === actorId);
  return {
    policies,
    candidates: recipients.flatMap((state) => {
      const model = state.executionModel;
      if (!model || model.identity.builderId === actorId) return [];
      return state.candidates.flatMap((candidate) => {
        if (
          candidate.stage !== "awaiting-admission" ||
          candidate.admissionDecision !== undefined ||
          candidate.baseCatalogRevision !== state.catalogRevision
        ) return [];
        try {
          if (!candidateCaseInvocation(state, candidate)) return [];
        } catch (error) {
          if (error instanceof CaseError) return [];
          throw error;
        }
        return policies.flatMap((policy) => {
          try {
            delegatedCandidateAuthorityExercise(model, candidate, {
              actorId,
              policyId: policy.id,
              policyRevision: policy.revision,
            }, mainExecutionSpace(model.identity));
          } catch (error) {
            if (error instanceof OperatorAuthorityError) return [];
            throw error;
          }
          return [{
            operatorId: model.identity.builderId,
            candidateId: candidate.id,
            candidateDigest: candidate.digest,
            expectedRevision: state.revision,
            caseId: candidate.caseId!,
            name: candidate.name,
            kind: candidate.kind,
            policyId: policy.id,
            policyRevision: policy.revision,
          }];
        });
      });
    }),
  };
}
