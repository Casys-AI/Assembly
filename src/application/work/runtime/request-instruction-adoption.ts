import type {
  ExecutableModel,
  ModelExecutionReference,
} from "../../../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "./state.ts";
import type { RequestAdoptionIntent } from "../../model/evolution/request-adoption-ports.ts";
import { RequestAdoptionError } from "../../model/evolution/request-adoption-ports.ts";
import {
  requestCreationPolicyCompatibility,
  requestInstructionCompatibility,
  requestNetworkCompatibility,
  requestTeamCompatibility,
} from "../../model/evolution/request-adoption-invariants.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import { effectiveModelUpdate } from "../../../domain/work/records/effective-model-update.ts";
import { normalizeRuntimeMutation } from "./mutation-normalization.ts";

/** Detached instruction-only projection. It never calls generic adopt's budget,
 * schedule, supersession, cursor/context clearing or external model algorithms. */
export async function prepareRequestInstructionStates(input: {
  state: SystemRuntimeState;
  intent: RequestAdoptionIntent;
  commandId: string;
  at: string;
  hasConsultModel: boolean;
  modelTools?: SystemRuntimeState["modelTools"];
}) {
  const { state, intent, commandId, at, hasConsultModel, modelTools } =
    structuredClone(input);
  const previous = state.executionModel!, candidate = intent.candidate.model;
  if (!previous) {
    throw new RequestAdoptionError(
      "CONFLICT",
      "The previous Request model is unavailable.",
    );
  }
  // The approved Request change of either effect (4.8e E4), or none.
  const proof = intent.network ?? intent.team ?? intent.creationPolicy;
  const change = proof &&
    state.configuration?.changes.find((entry) => entry.id === proof.changeId);
  const compatibility = proof && change
    ? intent.team
      ? await requestTeamCompatibility(
        previous,
        candidate,
        change,
        intent.team.publicationBase,
      )
      : intent.creationPolicy
      ? await requestCreationPolicyCompatibility(previous, candidate, change)
      : await requestNetworkCompatibility(previous, candidate, change)
    : proof
    ? null
    : await requestInstructionCompatibility(previous, candidate);
  if (
    !previous || previous.version.digest !== intent.previous.pin.modelDigest ||
    previous.version.repositoryVersion !== intent.previous.pin.source.version ||
    canonical(previous.identity) !== canonical(candidate.identity) ||
    compatibility !== intent.candidate.compatibilityDigest ||
    proof &&
      (!change ||
        await canonicalDigest(change) !== proof.approvedChangeDigest)
  ) {
    throw new RequestAdoptionError(
      "CONFLICT",
      "The exact instruction compatibility changed.",
    );
  }
  const provenance = state.events.findLast((event) =>
    event.runtimeProvenance?.digest === state.runtime?.digest
  )?.runtimeProvenance;
  if (!provenance) {
    throw new RequestAdoptionError(
      "UNAVAILABLE",
      "Runtime provenance is unavailable at the adoption boundary.",
    );
  }
  const reference = (model: ExecutableModel): ModelExecutionReference => ({
    digest: model.version.digest,
    runtime: { digest: provenance.digest },
    sourceIds: model.version.sourceIds,
    repositoryVersion: model.version.repositoryVersion,
  });
  const authorization = structuredClone(state),
    authorizationEventId = `${commandId}:authorization`;
  authorization.events.push({
    id: authorizationEventId,
    at,
    kind: "model-version-admission-authorized",
    label: intent.network
      ? "Request network adoption authorized"
      : intent.team
      ? "Request team adoption authorized"
      : intent.creationPolicy
      ? "Request creation policy adoption authorized"
      : "Request instruction adoption authorized",
    caseId: intent.target.caseId,
    authorityExercise: structuredClone(intent.decision.exercise),
    modelAdoptionAuthorization: {
      target: {
        identity: structuredClone(candidate.identity),
        version: structuredClone(candidate.version),
      },
    },
  });
  normalizeRuntimeMutation(state, authorization, {
    execution: reference(previous),
    hasConsultModel: state.modelTools !== undefined,
    modelTools: state.modelTools,
  });
  const adopted = structuredClone(authorization);
  adopted.executionModel = structuredClone(candidate);
  adopted.model = structuredClone(candidate.identity);
  adopted.ownerAuthority = structuredClone(candidate.ownerAuthority!);
  adopted.configuration = {
    ...structuredClone(candidate.configuration),
    changes: structuredClone(state.configuration?.changes ?? []),
  };
  delete adopted.availableExecutionModel;
  const update = effectiveModelUpdate(previous, candidate, {
    journalId: state.id,
    journalPosition: adopted.events.length,
    activatedAt: at,
    origin: {
      caseId: intent.target.caseId,
      dossierId: commandId,
      actorId: intent.decision.exercise.operatorNativeId,
    },
  });
  if (!update || update.kind !== "model") {
    throw new RequestAdoptionError(
      "INVALID",
      "An instruction-only effective update is required.",
    );
  }
  adopted.events.push({
    id: update.id,
    at,
    kind: "effective-model-updated",
    label: intent.network
      ? "Request network scope updated"
      : intent.team
      ? "Request team updated"
      : intent.creationPolicy
      ? "Request creation policy updated"
      : "Request instructions updated",
    caseId: intent.target.caseId,
    effectiveModelUpdate: update,
  });
  adopted.events.push({
    id: `${commandId}:admitted`,
    at,
    kind: "model-version-admitted",
    label: intent.network
      ? "Request network scope explicitly adopted"
      : intent.team
      ? "Request team explicitly adopted"
      : intent.creationPolicy
      ? "Request creation policy explicitly adopted"
      : "Request instruction explicitly adopted",
    caseId: intent.target.caseId,
    authorityExercise: structuredClone(intent.decision.exercise),
  });
  normalizeRuntimeMutation(authorization, adopted, {
    execution: reference(candidate),
    hasConsultModel,
    modelTools,
  });
  return { authorization, adopted, authorizationEventId };
}
