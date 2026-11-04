import type { ClockPort } from "../runtime/ports.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type {
  ExecutableModel,
  ModelExecutionReference,
} from "../../../domain/model/execution/executable-model.ts";
import type { BehaviorInvocationRequest } from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  ArtifactReuseOrigin,
  Candidate,
  Stage,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import {
  publishedToolDraft,
  requireToolReuseAdmission,
  reuseOrigin,
  type ToolReuseImport,
  type ToolReuseReceipt,
  toolReuseReceipt,
} from "./catalog.ts";
import { draftDigest, makeEvent } from "../runtime/values.ts";

export interface ToolArtifactImportHost {
  readonly ports: { clock: ClockPort };
  readonly state: SystemRuntimeState;
  readonly pending: Promise<void> | null;
  readonly execution: ModelExecutionReference | undefined;
  readonly behaviorInvocation: BehaviorInvocationRequest | undefined;
  readonly artifactImports: Map<
    string,
    { signature: string; pending: Promise<ToolReuseReceipt> }
  >;
  currentModel(): Promise<ExecutableModel>;
  candidate(id: string): Candidate;
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  build(
    draft?: ToolDraft,
    resumeId?: string,
    origin?: ArtifactReuseOrigin,
    initialToolSeed?: Candidate["initialToolSeed"],
  ): Promise<void>;
  nativeCandidate(
    model: ExecutableModel,
    candidate: Candidate,
    status: Stage,
  ): boolean;
  importArtifact(
    input: ToolReuseImport,
    draft: ToolDraft,
  ): Promise<ToolReuseReceipt>;
  verifiedToolReuseReceipt(
    candidateId: string,
    replayed: boolean,
  ): Promise<ToolReuseReceipt>;
}

/** Host-only continuation of an admitted native import behavior. The imported
 * bytes traverse this operator's ordinary tests and promotion flow again. */
export async function importAdmittedArtifact(
  this: ToolArtifactImportHost,
  input: ToolReuseImport,
): Promise<ToolReuseReceipt> {
  const copied = structuredClone(input);
  const active = this.behaviorInvocation;
  if (
    !this.state.busy || !this.pending || !this.execution || !active ||
    active.invocationId !== copied.proof.invocationId ||
    active.callerId !== copied.proof.callerId ||
    canonical(active.behavior) !== canonical(copied.proof.behavior) ||
    canonical(active.modelVersion) !== canonical(copied.proof.modelVersion) ||
    active.input.sourceAgentId !== copied.artifact.agentId ||
    active.input.candidateId !== copied.artifact.candidate.id ||
    active.input.digest !== copied.artifact.candidate.digest ||
    !this.state.executionModel?.flows.conversation.nodes.some((node) =>
      node.nativeId === this.execution!.actionId &&
      node.mechanism === "invoke_tool"
    )
  ) {
    throw new Error(
      "La réutilisation exige son invocation native en cours exacte.",
    );
  }
  const draft = await publishedToolDraft(copied.artifact);
  const signature = canonical({
    callerId: copied.proof.callerId,
    behavior: copied.proof.behavior,
    modelDigest: copied.proof.modelVersion.digest,
    sourceAgentId: copied.artifact.agentId,
    candidateId: copied.artifact.candidate.id,
    draft,
  });
  const correlationId = copied.proof.invocationId;
  const running = this.artifactImports.get(correlationId);
  if (running) {
    if (running.signature !== signature) {
      throw new Error("La corrélation d’import désigne un autre artefact.");
    }
    return structuredClone(await running.pending);
  }
  const pending = this.importArtifact(copied, draft);
  this.artifactImports.set(correlationId, { signature, pending });
  try {
    return structuredClone(await pending);
  } finally {
    this.artifactImports.delete(correlationId);
  }
}

export async function importArtifact(
  this: ToolArtifactImportHost,
  input: ToolReuseImport,
  draft: ToolDraft,
): Promise<ToolReuseReceipt> {
  const model = await this.currentModel();
  requireToolReuseAdmission(input.proof, model);
  const origin = reuseOrigin(input);
  const existing = this.state.candidates.filter((candidate) =>
    candidate.reusedFrom?.correlationId === origin.correlationId
  );
  if (existing.length) {
    const candidate = existing[0]!;
    if (
      existing.length !== 1 ||
      candidate.reusedFrom!.agentId !== origin.agentId ||
      candidate.reusedFrom!.candidateId !== origin.candidateId ||
      candidate.reusedFrom!.digest !== origin.digest ||
      candidate.reusedFrom!.behaviorId !== origin.behaviorId ||
      await draftDigest(candidate) !== origin.digest
    ) {
      throw new Error(
        "La corrélation d’import ne correspond plus aux octets source.",
      );
    }
    return await this.verifiedToolReuseReceipt(candidate.id, true);
  }
  await this.build(draft, undefined, origin);
  const created = this.state.candidates.filter((candidate) =>
    candidate.reusedFrom?.correlationId === origin.correlationId
  );
  if (created.length !== 1) {
    throw new Error("L’import n’a pas fourni de candidat local vérifiable.");
  }
  const receipt = await this.verifiedToolReuseReceipt(created[0]!.id, false);
  await this.update((state) => {
    state.events.push(
      makeEvent(
        this.ports.clock,
        "tool-artifact-imported",
        `Artefact réutilisé dans le catalogue local : ${
          created[0]!.name
        } · ${receipt.stage}`,
        created[0],
      ),
    );
  });
  return receipt;
}

export async function verifiedToolReuseReceipt(
  this: ToolArtifactImportHost,
  candidateId: string,
  replayed: boolean,
): Promise<ToolReuseReceipt> {
  const native = await this.currentModel();
  const candidate = this.candidate(candidateId);
  if (
    candidate.stage === "active" &&
    (!this.nativeCandidate(native, candidate, "active") ||
      candidate.tests?.passed !== true ||
      candidate.admission?.candidateId !== candidate.id ||
      candidate.admission.candidateDigest !== candidate.digest)
  ) {
    throw new Error(
      "Le catalogue natif local ne confirme plus l’activation de l’artefact réutilisé.",
    );
  }
  return toolReuseReceipt(candidate, replayed);
}
