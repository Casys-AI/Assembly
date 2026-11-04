import type { ClockPort } from "../runtime/ports.ts";
import { budgetCeilingModelEquivalent } from "../runtime/budget-transition.ts";
import type {
  ExecutableModel,
} from "../../../domain/model/execution/executable-model.ts";
import type { NativeToolContract } from "../../../domain/work/records/candidates.ts";
import { SystemGovernance } from "../../../domain/governance/policies/governance.ts";
import type {
  AdmissionRecord,
  Candidate,
  Stage,
} from "../../../domain/work/records/candidates.ts";
import type { ArtifactEvidence } from "../conversation/chat-context.ts";
import type { SystemRuntimeState } from "../runtime/state.ts";
import { artifactEvidence as describeArtifactEvidence } from "./artifact-evidence.ts";
import type { CandidateModelPort } from "./ports/out/candidate-model.port.ts";
import { draftDigest, makeEvent, valueDigest } from "../runtime/values.ts";
import { settleActivation } from "./activation.ts";

export interface ExactCandidateReview {
  approved: boolean;
  candidateDigest: string;
  reason: string;
}

/** Promotion capabilities over the facade's live state and serialized updates. */
export interface PromotionCandidatesHost {
  readonly state: SystemRuntimeState;
  readonly ports: {
    clock: ClockPort;
    model: CandidateModelPort;
    stateHistory?:
      import("../native-execution/contract.ts").RuntimeStateHistoryPort;
  };
  currentModel(): Promise<ExecutableModel>;
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  candidate(id: string): Candidate;
  stage(id: string, stage: Stage, label: string): Promise<void>;
  feedback(text: string): Promise<void>;
  candidateContract(
    model: ExecutableModel,
    candidate: Candidate,
  ): NativeToolContract;
  nativeCandidate(
    model: ExecutableModel,
    candidate: Candidate,
    status: Stage,
  ): boolean;
  exactReview(
    model: ExecutableModel,
    candidate: Candidate,
  ): Promise<ExactCandidateReview>;
}
export async function activate(
  this: PromotionCandidatesHost,
  id: string,
  authority: AdmissionRecord["authority"],
  reason: string,
): Promise<void> {
  const model = await this.currentModel();
  const current = this.candidate(id);
  if (
    await draftDigest(current) !== current.digest ||
    current.baseCatalogRevision !== this.state.catalogRevision ||
    current.tests?.passed !== true
  ) {
    throw new Error("Le candidat ou sa base a changé depuis la revue.");
  }
  if (authority === "reviewer") await this.exactReview(model, current);
  if (
    this.state.candidates.some((c) =>
      c.stage === "active" && c.name === current.name
    )
  ) {
    throw new Error(
      "Un tool actif porte déjà ce nom ; remplacement non pris en charge dans ce premier essai.",
    );
  }
  const admission = SystemGovernance.fromExecutable(
    this.state.executionModel!,
    this.state.configuration!.changes,
  )
    .admission(current, authority, reason, this.ports.clock.now());
  // The admission and its activation intent become durable together. From here
  // the intent always has an exit: published, failed with a code, or retried.
  await this.update((s) => {
    const c = s.candidates.find((c) => c.id === id)!;
    c.admission = admission;
    c.activationModelDigest = model.version.digest;
    c.stage = "activating";
    s.phase = "Intégration du tool accepté";
    s.events.push(
      {
        ...makeEvent(
          this.ports.clock,
          "tool-admitted",
          `${authority} admet ${c.name} : ${reason}`,
          c,
        ),
        ...(admission.authorityExercise
          ? { authorityExercise: admission.authorityExercise }
          : {}),
      },
      makeEvent(
        this.ports.clock,
        "tool-activating",
        "Intégration du tool accepté",
        c,
      ),
    );
  });
  const outcome = await settleActivation.call(this, id, "admission");
  if (outcome.status !== "active") throw outcome.error;
  await this.feedback(
    `Tool admis et ACTIF : id=${current.id}, nom=${current.name}. Décision ${authority} : ${reason}. Tu peux appeler cet identifiant avec l’URL demandée.`,
  );
}

export function candidate(
  this: PromotionCandidatesHost,
  id: string,
): Candidate {
  const candidate = this.state.candidates.find((c) => c.id === id);
  if (!candidate) throw new Error("Candidat introuvable");
  return candidate;
}

export async function stage(
  this: PromotionCandidatesHost,
  id: string,
  stage: Stage,
  label: string,
): Promise<void> {
  await this.currentModel();
  await this.update((s) => {
    const c = s.candidates.find((c) => c.id === id)!;
    c.stage = stage;
    s.phase = label;
    s.events.push(makeEvent(this.ports.clock, `tool-${stage}`, label, c));
  });
}

export function candidateContract(
  this: PromotionCandidatesHost,
  model: ExecutableModel,
  candidate: Candidate,
) {
  const contracts = model.contracts.filter((contract) =>
    contract.kind === candidate.kind
  );
  if (contracts.length !== 1) {
    throw new Error(
      "Le catalogue natif ne définit pas un contrat unique pour ce type de candidat.",
    );
  }
  return contracts[0]!;
}

export function nativeCandidate(
  this: PromotionCandidatesHost,
  model: ExecutableModel,
  candidate: Candidate,
  status: Stage,
): boolean {
  return model.catalog.some((entry) =>
    entry.candidateId === candidate.id && entry.digest === candidate.digest &&
    entry.kind === candidate.kind && entry.name === candidate.name &&
    entry.status === status &&
    model.contracts.filter((contract) =>
        contract.nativeId === entry.contractId &&
        contract.kind === candidate.kind
      ).length === 1 &&
    (!candidate.binding || entry.nativeId === candidate.binding.elementId)
  );
}

export async function artifactEvidence(
  this: PromotionCandidatesHost,
  candidate: Candidate,
  native?: ExecutableModel,
): Promise<ArtifactEvidence> {
  const entry = native?.catalog.find((record) =>
    record.candidateId === candidate.id &&
    record.digest === candidate.digest &&
    this.nativeCandidate(native, candidate, record.status)
  );
  const contentDigestMatches =
    await draftDigest(candidate) === candidate.digest;
  const activationConfirmed = candidate.stage === "active" &&
    entry?.status === "active" && contentDigestMatches &&
    native?.version.digest === this.state.executionModel?.version.digest &&
    candidate.tests?.passed === true &&
    candidate.admission?.candidateId === candidate.id &&
    candidate.admission.candidateDigest === candidate.digest;
  return describeArtifactEvidence(candidate, {
    contentDigestMatches,
    activationConfirmed,
    ...(entry
      ? {
        nativeStatus: entry.status,
        nativeModelVersion: {
          digest: native!.version.digest,
          repositoryVersion: native!.version.repositoryVersion,
        },
      }
      : {}),
  });
}

export async function exactReview(
  this: PromotionCandidatesHost,
  model: ExecutableModel,
  candidate: Candidate,
) {
  const proof = candidate.reviewExecution;
  const reviewerId = model.configuration.reviewer?.id;
  const reviewNode = model.flows.promotion.nodes.find((node) =>
    node.nativeId === proof?.actionId && node.mechanism === "review_candidate"
  );
  if (
    !candidate.review ||
    candidate.review.candidateDigest !== candidate.digest ||
    !["approve", "refuse"].includes(candidate.review.verdict) ||
    !proof || proof.modelDigest !== model.version.digest &&
      !await budgetCeilingModelEquivalent(
        this.state,
        proof.modelDigest,
        model.version.digest,
        { candidateId: candidate.id },
        this.ports.stateHistory,
      ) ||
    !reviewerId || proof.reviewerId !== reviewerId ||
    !model.identity.reviewerId ||
    reviewNode?.performerId !== model.identity.reviewerId ||
    proof.testsDigest !== await valueDigest(candidate.tests) ||
    proof.contractDigest !==
      await valueDigest(this.candidateContract(model, candidate))
  ) {
    throw new Error(
      "La revue native ne correspond pas au candidat, aux essais, au contrat ou au reviewer courants.",
    );
  }
  return {
    approved: candidate.review.verdict === "approve",
    candidateDigest: candidate.review.candidateDigest,
    reason: candidate.review.reason,
  };
}

export function exactInputCandidate(
  this: PromotionCandidatesHost,
  input: unknown,
  expectedId?: string,
): Candidate {
  const reference = input as { id?: string; digest?: string };
  if (!expectedId || reference?.id !== expectedId) {
    throw new Error("L’action native vise un autre candidat.");
  }
  const candidate = this.candidate(expectedId);
  if (reference.digest !== candidate.digest) {
    throw new Error("Le digest du candidat natif a changé.");
  }
  return candidate;
}
