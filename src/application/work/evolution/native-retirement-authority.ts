import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  nativeExecutionIdentity,
  type NativeExecutionRequest,
  type NativeExecutionSnapshot,
  type NativeThreadAdvanceAuthorization,
} from "../native-execution/contract.ts";
import { invocationInput } from "../operators/journal.ts";
import {
  emptyNativeEvolutionAwait,
  evolutionCheckpoint,
  evolutionNetworkCheckpoint,
  exactNativeChangeApprovalWait,
} from "../runtime/evolution.ts";
import { ownerAdoptionChange } from "./native-adoption-successor.ts";
import {
  parseRequestOwnerAdoptionDossier,
  requestCreationPolicyCompatibility,
  requestNetworkCompatibility,
  requestTeamCompatibility,
} from "../../model/evolution/request-adoption-invariants.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { EvolutionDossier } from "../../model/evolution/ports.ts";
import type { parseScopedSoftwareDossier } from "../../model/evolution/scoped-software-dossier.ts";

interface RetirementSourcePin {
  identity: ExecutableModel["identity"];
  version: ExecutableModel["version"];
  flowRootId: string;
  flowOccurrenceId: string;
  profile: unknown;
  maxSteps: number;
}

export function assertOwnerRetirementAuthority(
  authorization: Extract<
    NativeThreadAdvanceAuthorization,
    { kind: "owner-adoption" }
  >,
  targetModel: ExecutableModel,
  current: SystemRuntimeState,
  accepted: SystemRuntimeState,
) {
  const event = accepted.events.find((entry) =>
    entry.id === authorization.authorizationEventId
  );
  if (
    !event || event.kind !== "model-version-admission-authorized" ||
    event.authorityExercise?.action !== "model-adoption" ||
    event.authorityExercise.baseModelDigest !==
      current.executionModel?.version.digest ||
    accepted.revision !== current.revision ||
    accepted.executionModel?.version.digest !==
      current.executionModel?.version.digest ||
    accepted.executionModel.version.repositoryVersion !==
      current.executionModel?.version.repositoryVersion ||
    canonical(event.modelAdoptionAuthorization?.target) !==
      canonical({
        identity: targetModel.identity,
        version: targetModel.version,
      })
  ) {
    throw new Error(
      "Owner model adoption lacks its exact canonical target authorization",
    );
  }
}

export function assertScopedSoftwareRetirementAuthority(
  scope: {
    projectId: string;
    systemId: string;
    executionSpaceId: string;
    operatorId: string;
  },
  authorization: Extract<
    NativeThreadAdvanceAuthorization,
    { kind: "software-evolution-scoped-adoption" }
  >,
  targetModel: ExecutableModel,
  current: SystemRuntimeState,
  accepted: SystemRuntimeState,
  dossier: Awaited<ReturnType<typeof parseScopedSoftwareDossier>>,
  barrierDossierId: unknown,
) {
  const event = accepted.events.find((entry) =>
    entry.id === authorization.authorizationEventId
  );
  const software = event?.modelAdoptionAuthorization?.softwareEvolution;
  const target = dossier.proposal.targets.find((t) =>
    t.operatorId === scope.operatorId
  );
  if (
    !event || event.kind !== "model-version-admission-authorized" ||
    event.authorityExercise ||
    !software || software.dossierId !== dossier.id ||
    software.intentDigest !== dossier.intentDigest ||
    software.proposalDigest !== dossier.proposal.digest ||
    canonical(software.exercise) !==
      canonical(dossier.adoptionAuthorization) ||
    canonical(authorization.adoptionAuthorization) !==
      canonical(dossier.adoptionAuthorization) ||
    authorization.intentDigest !== dossier.intentDigest ||
    authorization.proposalDigest !== dossier.proposal.digest ||
    dossier.status !== "published-awaiting-adoption" ||
    barrierDossierId !== dossier.id ||
    dossier.scope.destination.host.projectId !== scope.projectId ||
    dossier.scope.destination.host.systemId !== scope.systemId ||
    dossier.scope.destination.executionSpaceId !== scope.executionSpaceId ||
    !target ||
    target.previousDigest !== current.executionModel?.version.digest ||
    target.candidateDigest !== targetModel.version.digest ||
    dossier.publication?.version !== targetModel.version.repositoryVersion ||
    accepted.revision !== current.revision ||
    canonical(accepted.executionModel) !==
      canonical(current.executionModel) ||
    canonical(event.modelAdoptionAuthorization?.target) !==
      canonical({
        identity: targetModel.identity,
        version: targetModel.version,
      })
  ) {
    throw new Error(
      "Scoped software retirement lacks exact canonical authorization and target",
    );
  }
}

export function assertEvolutionRetirementAuthority(
  operatorId: string,
  authorization: Extract<
    NativeThreadAdvanceAuthorization,
    { kind: "evolution-adoption" }
  >,
  targetModel: ExecutableModel,
  current: SystemRuntimeState,
  dossier: EvolutionDossier,
) {
  if (
    canonical(dossier.adoptionAuthorization) !==
      canonical(authorization.adoptionAuthorization) ||
    !["published-awaiting-adoption", "adopted"].includes(
      dossier.status,
    ) ||
    dossier.publication?.version !==
      targetModel.version.repositoryVersion ||
    !dossier.proposal.targets.some((entry) =>
      entry.operatorId === operatorId &&
      entry.previousDigest === current.executionModel?.version.digest &&
      entry.candidateDigest === targetModel.version.digest
    )
  ) {
    throw new Error(
      "Evolution adoption target or prior authority differs from the durable dossier",
    );
  }
}

export function assertRetirementHistoricalSource(
  snapshot: NativeExecutionSnapshot,
  identityJson: string,
  source: { contribution: NativeExecutionRequest["contribution"] },
  historical: SystemRuntimeState,
  pin: RetirementSourcePin | null,
) {
  const sourceModel = historical.executionModel!;
  const flow = [
    sourceModel.flows.conversation,
    ...Object.values(sourceModel.caseFlows ?? {}),
  ].find((flow) =>
    flow.rootNativeId === snapshot.flowRootId &&
    flow.rootOccurrenceId === pin?.flowOccurrenceId
  );
  if (
    !pin || !flow || source.contribution.id !== snapshot.contributionId ||
    source.contribution.inputMessageId !== undefined &&
      source.contribution.inputMessageId !== snapshot.identity.subjectId ||
    source.contribution.kind === "input" &&
      source.contribution.id !== snapshot.identity.subjectId ||
    invocationInput(historical)?.id !== snapshot.identity.subjectId ||
    canonical(
        nativeExecutionIdentity(
          historical,
          "conversation",
          snapshot.identity.subjectId,
        ),
      ) !== identityJson ||
    canonical(pin.identity) !== canonical(sourceModel.identity) ||
    canonical(pin.version) !== canonical(sourceModel.version) ||
    pin.flowRootId !== snapshot.flowRootId ||
    canonical(pin.profile) !== canonical(flow.executionProfile ?? null) ||
    !Number.isSafeInteger(pin.maxSteps) ||
    sourceModel.version.digest !== snapshot.modelDigest ||
    sourceModel.version.repositoryVersion !== snapshot.repositoryVersion
  ) {
    throw new Error(
      "Historical retirement source does not match its exact retained run pin",
    );
  }
}

/** Safety is evaluated against current authority. The retained source only
 * proves what ran; a dossier is read only for the exact approval-wait branch. */
export async function assertRetirementSafety(
  scope: { operatorId: string; executionSpaceId: string },
  authorization: NativeThreadAdvanceAuthorization,
  targetModel: ExecutableModel,
  current: SystemRuntimeState,
  snapshot: NativeExecutionSnapshot,
  sourceModel: ExecutableModel,
  lockedNetworkSnapshot: NativeExecutionSnapshot | undefined,
  readDossier: (
    id: string,
  ) => Promise<Awaited<ReturnType<typeof parseRequestOwnerAdoptionDossier>>>,
) {
  const changeProof = ownerAdoptionChange(authorization);
  const network = changeProof?.proof;
  // A plain completed wait must remain independently empty. Its business
  // boundary also includes the exact network wait verified in this locked
  // batch: the pending decision belongs to that wait, not to this thread.
  let safe = emptyNativeEvolutionAwait(current, snapshot, sourceModel) &&
    (network && lockedNetworkSnapshot
      ? (await evolutionNetworkCheckpoint(
        { ...current, busy: false },
        [snapshot, lockedNetworkSnapshot],
        network.changeId,
        lockedNetworkSnapshot.identity.scope.kind === "request"
          ? lockedNetworkSnapshot.identity.scope.scopeId
          : "",
        [sourceModel],
      )).safe
      : evolutionCheckpoint({ ...current, busy: false }, [snapshot], [
        sourceModel,
      ]).safe);
  if (network && snapshot.localState?.changeApprovalWait) {
    if (
      authorization.kind !== "owner-adoption" ||
      !authorization.authorizationEventId.endsWith(":authorization")
    ) throw new Error("Network adoption authority is unavailable");
    const dossierId = authorization.authorizationEventId.slice(
      0,
      -":authorization".length,
    );
    const dossier = await readDossier(dossierId);
    if (
      dossier.status !== "armed" || dossier.id !== dossierId ||
      dossier.intent.target.executionSpaceId !== scope.executionSpaceId ||
      dossier.intent.target.operatorId !== scope.operatorId ||
      canonical(
          changeProof!.kind === "team"
            ? dossier.intent.team
            : changeProof!.creationPolicy
            ? dossier.intent.creationPolicy
            : dossier.intent.network,
        ) !== canonical(network) ||
      dossier.intent.candidate.compatibilityDigest !==
        changeProof!.compatibilityDigest ||
      dossier.intent.candidate.model.version.digest !==
        targetModel.version.digest ||
      dossier.intent.candidate.model.version.repositoryVersion !==
        targetModel.version.repositoryVersion
    ) throw new Error("Network adoption dossier differs");
    const change = current.configuration?.changes.find((item) =>
      item.id === network.changeId
    );
    const caseId = snapshot.identity.scope.kind === "request"
      ? snapshot.identity.scope.scopeId
      : "";
    const wait = exactNativeChangeApprovalWait(
      current,
      snapshot,
      sourceModel,
      {
        changeId: network.changeId,
        proposalIntentDigest: network.proposalIntentDigest,
        caseId,
      },
    );
    safe = !!wait && !!change &&
      await canonicalDigest(change) === network.approvedChangeDigest &&
      (changeProof!.kind === "team" || changeProof!.creationPolicy ||
        canonical(
            change.requestedRights &&
              "addNetworkHosts" in change.requestedRights
              ? change.requestedRights.addNetworkHosts
              : null,
          ) ===
          canonical(
            (network as { addedHosts?: unknown }).addedHosts,
          )) &&
      await (changeProof!.kind === "team"
          ? requestTeamCompatibility(
            sourceModel,
            targetModel,
            change,
            changeProof!.proof.publicationBase,
          )
          : changeProof!.creationPolicy
          ? requestCreationPolicyCompatibility(
            sourceModel,
            targetModel,
            change,
          )
          : requestNetworkCompatibility(sourceModel, targetModel, change)) ===
        changeProof!.compatibilityDigest &&
      (await evolutionNetworkCheckpoint(
        { ...current, busy: false },
        [snapshot],
        network.changeId,
        caseId,
        [sourceModel],
      )).safe;
  }
  if (!safe || targetModel.identity.builderId !== scope.operatorId) {
    throw new Error(
      "Canonical business receipts do not prove an empty native input wait",
    );
  }
}
