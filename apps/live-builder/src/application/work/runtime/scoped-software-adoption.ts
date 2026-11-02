import type {
  ExecutableModel,
  ModelExecutionReference,
} from "../../../domain/model/execution/executable-model.ts";
import { ownerAuthorityFor } from "../../../domain/governance/authority.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import { effectiveModelUpdate } from "../../../domain/work/records/effective-model-update.ts";
import { assertEvolutionReceipt } from "../../model/evolution/invariants.ts";
import {
  EvolutionError,
  type EvolutionTarget,
} from "../../model/evolution/ports.ts";
import type { ScopedSoftwareEvolutionDossierV2 } from "../../model/evolution/scoped-software-dossier.ts";
import type {
  ScopedSoftwareFinalBoundaryV2,
  ScopedSoftwarePublicationV2,
} from "../../model/evolution/scoped-software-adoption.ts";
import { retireEvolutionAwaits } from "./evolution.ts";
import { normalizeRuntimeMutation } from "./mutation-normalization.ts";

/** Detached state preparation. Runtime/SQL/native reservations and budget ledger
 * changes are the caller's separate transaction responsibilities. */
export function prepareScopedSoftwareEvolutionStates(input: {
  state: SystemRuntimeState;
  dossier: ScopedSoftwareEvolutionDossierV2;
  target: EvolutionTarget;
  publication: ScopedSoftwarePublicationV2;
  candidate: ExecutableModel;
  boundary: ScopedSoftwareFinalBoundaryV2;
  at: string;
  hasConsultModel: boolean;
  modelTools?: SystemRuntimeState["modelTools"];
  historicalModels: readonly ExecutableModel[];
}) {
  const {
    state,
    dossier,
    target,
    publication,
    candidate,
    boundary,
    at,
    hasConsultModel,
    modelTools,
    historicalModels,
  } = structuredClone(input);
  const previous = state.executionModel;
  const scopedTarget = dossier.scope.targets.find((entry) =>
    canonical(entry.target) === canonical(boundary.target)
  );
  const refuse = (message: string): never => {
    throw new EvolutionError("EVOLUTION_ADOPTION_MISMATCH", message);
  };
  if (
    !previous || !dossier.adoptionAuthorization ||
    dossier.status !== "published-awaiting-adoption" || !dossier.publication ||
    canonical(dossier.publication) !== canonical(publication) ||
    publication.proposalDigest !== dossier.proposal.digest ||
    !dossier.proposal.targets.some((t) => canonical(t) === canonical(target)) ||
    target.operatorId !== previous.identity.builderId ||
    target.previousDigest !== previous.version.digest ||
    target.candidateDigest !== candidate.version.digest ||
    candidate.version.repositoryVersion !== publication.version ||
    canonical(previous.identity) !== canonical(candidate.identity) ||
    boundary.target.operatorId !== target.operatorId ||
    boundary.target.executionSpaceId !==
      dossier.scope.destination.executionSpaceId ||
    boundary.target.projectId !== dossier.scope.destination.host.projectId ||
    boundary.target.systemId !== dossier.scope.destination.host.systemId ||
    !scopedTarget ||
    canonical(scopedTarget.previousPin) !== canonical(boundary.previousPin) ||
    boundary.previousRuntimeRevision !== state.revision ||
    boundary.previousPin.modelDigest !== previous.version.digest ||
    boundary.previousPin.source.version !== previous.version.repositoryVersion
  ) return refuse("Exact software adoption boundary differs");
  assertEvolutionReceipt(
    dossier.adoptionAuthorization,
    "adopt",
    dossier.proposal,
  );
  // The PostgreSQL transition prepares and locks retained-budget policy
  // changes and projects their real views before committing these states.
  const provenance = state.events.findLast((event) =>
    event.runtimeProvenance?.digest === state.runtime?.digest
  )?.runtimeProvenance;
  if (!provenance) return refuse("Runtime provenance unavailable");
  const reference = (model: ExecutableModel): ModelExecutionReference => ({
    digest: model.version.digest,
    runtime: { digest: provenance.digest },
    sourceIds: model.version.sourceIds,
    repositoryVersion: model.version.repositoryVersion,
  });
  const authorization = structuredClone(state),
    authorizationEventId =
      `${dossier.id}:software-authorization:${target.operatorId}`;
  authorization.events.push({
    id: authorizationEventId,
    at,
    kind: "model-version-admission-authorized",
    label: "Software evolution authorized",
    caseId: dossier.scope.destination.caseId,
    modelAdoptionAuthorization: {
      target: {
        identity: structuredClone(candidate.identity),
        version: structuredClone(candidate.version),
      },
      softwareEvolution: {
        dossierId: dossier.id,
        intentDigest: dossier.intentDigest,
        proposalDigest: dossier.proposal.digest,
        exercise: structuredClone(dossier.adoptionAuthorization),
      },
    },
  });
  normalizeRuntimeMutation(state, authorization, {
    execution: reference(previous),
    hasConsultModel: state.modelTools !== undefined,
    modelTools: state.modelTools,
  });
  const adopted = structuredClone(authorization);
  retireEvolutionAwaits(
    adopted,
    dossier.id,
    at,
    boundary.nativeSnapshots,
    historicalModels,
  );
  if (
    adopted.conversationFlow &&
    JSON.stringify(adopted.conversationFlow) !==
      JSON.stringify(candidate.flows.conversation)
  ) {
    delete adopted.conversationCursor;
    delete adopted.conversationContext;
    delete adopted.conversationFlow;
  }
  const update = effectiveModelUpdate(previous, candidate, {
    journalId: state.id,
    journalPosition: adopted.events.length,
    activatedAt: at,
    origin: {
      caseId: dossier.scope.destination.caseId,
      dossierId: dossier.id,
      actorId: dossier.adoptionAuthorization.operatorNativeId,
    },
  });
  if (!update) return refuse("Exact effective update is absent");
  adopted.events.push({
    id: update.id,
    at,
    kind: "effective-model-updated",
    label: update.kind === "action-flow"
      ? "Action flow updated"
      : "Model updated",
    caseId: dossier.scope.destination.caseId,
    effectiveModelUpdate: update,
  });
  adopted.executionModel = structuredClone(candidate);
  adopted.model = structuredClone(candidate.identity);
  adopted.ownerAuthority = structuredClone(ownerAuthorityFor(candidate));
  const changes = structuredClone(state.configuration?.changes ?? []);
  for (const change of changes) {
    if (
      change.status !== "pending" || change.publishedCommit ||
      change.baseRevision === candidate.configuration.revision &&
        (change.baseModelDigest === undefined ||
          change.baseModelDigest === candidate.version.digest)
    ) continue;
    change.status = "superseded";
    adopted.events.push({
      id: `${dossier.id}:software-superseded:${change.id}`,
      at,
      kind: "configuration-change-superseded",
      label: `Proposition supplantée : ${change.id}`,
      changeId: change.id,
      changeSuperseded: {
        oldPin: {
          ...(change.baseModelDigest !== undefined
            ? { digest: change.baseModelDigest }
            : {}),
          ...(change.diff?.base.repositoryVersion !== undefined
            ? { repositoryVersion: change.diff.base.repositoryVersion }
            : {}),
          revision: change.baseRevision,
        },
        newPin: {
          digest: candidate.version.digest,
          ...(candidate.version.repositoryVersion !== undefined
            ? { repositoryVersion: candidate.version.repositoryVersion }
            : {}),
        },
      },
    });
    delete adopted.changeDecisionContinuations?.[change.id];
    delete adopted.changeWorkContinuations?.[change.id];
  }
  adopted.configuration = {
    ...structuredClone(candidate.configuration),
    changes,
  };
  delete adopted.availableExecutionModel;
  adopted.events.push({
    id: `${dossier.id}:software-admitted:${target.operatorId}`,
    at,
    kind: "model-version-admitted",
    label: "Software evolution adopted",
    caseId: dossier.scope.destination.caseId,
  });
  normalizeRuntimeMutation(authorization, adopted, {
    execution: reference(candidate),
    hasConsultModel,
    modelTools,
  });
  return { authorization, adopted, authorizationEventId };
}
