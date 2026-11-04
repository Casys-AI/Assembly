import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import type {
  NativeExecutionActionResult,
  NativeExecutionIdentity,
} from "./contract.ts";
import type { OperatorExecutionCommandOrigin } from "../operators/execution.ts";
import { invocationInput, invocationKey } from "../operators/journal.ts";
import {
  artifactSourceProofModel,
  assertArtifactSourceBusinessProof,
  type QueuedArtifactSourcePublication,
} from "../../../domain/work/artifacts/source-publication.ts";
import {
  artifactSourcePublicationFromDossier,
  assertModelWriteDossier,
  modelWriteCommandDigest,
  type ModelWriteDossier,
  modelWriteDossierDigest,
} from "../../../domain/model/editing/write-command.ts";

/** Exact accepted strings are facts, not a reserialized replacement dossier. */
export interface AcceptedArtifactPublicationIntent {
  readonly dossierJson: unknown;
  readonly commandJson: unknown;
  readonly commandDigest: unknown;
  readonly dossierDigest: unknown;
  readonly state: unknown;
}

export function assertArtifactOriginScope(
  scope: { projectId: string; systemId: string; executionSpaceId: string },
  publication: QueuedArtifactSourcePublication,
) {
  const target = publication.target, proof = publication.proof;
  if (
    target.projectId !== scope.projectId ||
    target.systemId !== scope.systemId ||
    target.executionSpaceId !== scope.executionSpaceId ||
    target.ownerId !== target.operatorId ||
    publication.source.kind !== "tool-draft" ||
    (proof.kind !== "native-action" && proof.kind !== "admitted-model-seed")
  ) {
    throw new Error(
      "Artifact source origin requires its exact native tool-producer scope",
    );
  }
  assertArtifactSourceBusinessProof(proof);
  if (
    proof.ownerId !== target.ownerId ||
    proof.kind === "native-action" &&
      proof.invocationId !== target.invocationId
  ) throw new Error("Artifact source native producer identity mismatch");
}

export function assertArtifactOriginPin(
  publication: QueuedArtifactSourcePublication,
  pin: {
    identity: ExecutableModel["identity"];
    version: ExecutableModel["version"];
  },
) {
  const target = publication.target, proof = publication.proof;
  const requestedPin = artifactSourceProofModel(proof);
  if (
    pin.identity.builderId !== target.ownerId ||
    pin.version.digest !== requestedPin.digest ||
    proof.kind === "native-action" &&
      pin.version.repositoryVersion !== requestedPin.repositoryVersion
  ) {
    throw new Error(
      "Artifact source native producer pin differs from its actual run",
    );
  }
}

export function assertArtifactOriginAction(
  publication: QueuedArtifactSourcePublication,
  historical: SystemRuntimeState,
  pin: { flowRootId: string; flowOccurrenceId: string },
  nodeId: unknown,
) {
  const proof = publication.proof;
  const flow = [
    ...Object.values(historical.executionModel!.flows),
    ...Object.values(historical.executionModel!.caseFlows ?? {}),
  ].find((entry) =>
    entry.rootNativeId === pin.flowRootId &&
    entry.rootOccurrenceId === pin.flowOccurrenceId
  );
  const node = flow?.nodes.find((entry) => entry.nativeId === nodeId);
  if (
    !node || node.mechanism !== "propose_candidate" ||
    proof.kind === "native-action" &&
      (node.nativeId !== proof.nativeActionId ||
        flow!.rootNativeId !== proof.flowRootNativeId)
  ) {
    throw new Error(
      "Artifact source is not anchored to its actual admitted proposal primitive",
    );
  }
}

export async function assertAcceptedArtifactPublication(
  publication: QueuedArtifactSourcePublication,
  command: AcceptedArtifactPublicationIntent,
) {
  if (
    typeof command.dossierJson !== "string" ||
    typeof command.commandJson !== "string" ||
    ![
      "queued",
      "preparing",
      "prepared",
      "publishing",
      "published",
      "retryable",
    ].includes(String(command.state))
  ) {
    throw new Error(
      "Artifact source W4 intent requires explicit disposition",
    );
  }
  const dossier = JSON.parse(command.dossierJson) as ModelWriteDossier;
  await assertModelWriteDossier(dossier);
  if (
    canonical(dossier) !== command.dossierJson ||
    canonical(dossier.command) !== command.commandJson ||
    command.commandDigest !==
      await modelWriteCommandDigest(dossier.command) ||
    command.dossierDigest !== await modelWriteDossierDigest(dossier) ||
    canonical(artifactSourcePublicationFromDossier(dossier)) !==
      canonical(publication)
  ) {
    throw new Error(
      "Artifact source recovery differs from its immutable accepted W4 publication bytes or proof",
    );
  }
}

export function assertCommandOriginInput(
  state: SystemRuntimeState,
  origin: OperatorExecutionCommandOrigin,
) {
  if (
    !state.caseInvocation ||
    invocationInput(state, state.caseInvocation)?.id !==
      origin.inputMessageId
  ) {
    throw new Error(
      "Native command origin does not own the exact canonical input",
    );
  }
}

export function assertCommandOriginIdentity(
  state: SystemRuntimeState,
  origin: OperatorExecutionCommandOrigin,
  identity: NativeExecutionIdentity,
) {
  if (
    identity.invocationKey !== invocationKey(state.caseInvocation!) ||
    identity.scope.kind === "request" &&
      identity.scope.scopeId !==
        (state.caseInvocation!.kind === "local"
          ? state.caseInvocation!.caseId
          : state.caseInvocation!.kind === "delegated"
          ? state.caseInvocation!.work.caseContext.caseId
          : undefined)
  ) throw new Error("Native command origin invocation scope mismatch");
  if (
    identity.purpose === "conversation" &&
    identity.subjectId !== origin.inputMessageId
  ) {
    throw new Error(
      "Native command effect belongs to a different canonical source input",
    );
  }
}

export function assertCommandOriginAction(
  historical: SystemRuntimeState,
  origin: OperatorExecutionCommandOrigin,
  nodeId: unknown,
) {
  if (
    !historical.caseInvocation ||
    invocationInput(historical, historical.caseInvocation)?.id !==
      origin.inputMessageId
  ) {
    throw new Error(
      "Native command action belongs to a different immutable source input",
    );
  }
  const node = [
    ...Object.values(historical.executionModel!.flows),
    ...Object.values(historical.executionModel!.caseFlows ?? {}),
  ].flatMap((flow) => flow.nodes).find((entry) => entry.nativeId === nodeId);
  if (!node) {
    throw new Error(
      "Native command origin action is absent from its actual admitted source model",
    );
  }
  if (node.mechanism !== "execute_operator_command") {
    throw new Error(
      "Delegated command origin is not the admitted native operator-command action",
    );
  }
}

export function assertCompletedCommandOrigin(
  result: NativeExecutionActionResult,
) {
  if (
    result.outputs &&
    Object.values(result.outputs).some((value) =>
      value && typeof value === "object" &&
      (value as Record<string, unknown>).refused === true
    )
  ) {
    throw new Error(
      "Refused native primitive cannot authorize a queued command",
    );
  }
}

export function commandOriginPinMatches(
  model: ExecutableModel,
  actualVersion: unknown,
): boolean {
  return canonical(actualVersion) === canonical(model.version);
}
