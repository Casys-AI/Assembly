import { errorMessage } from "../../../domain/primitives/error-message.ts";
import { assertRequestChangeDossier } from "./request-change.ts";
import type { ScopedSoftwareWriteDossierV2 } from "./scoped-software-write.ts";
import type { ScopedSoftwareSourceWriteResolver } from "./ports/out/scoped-software-source-publication.port.ts";
import {
  isRequestSourceHistoryConflict,
  isRequestSourceProofUnavailable,
} from "./request-source-context.ts";
import {
  assertModelWriteDestinationMatches,
  isScopedSoftwareWriteDossier,
  type ModelWriteDossierV2,
  parseVersionedModelWriteDossier,
} from "./write-command-v2.ts";
import {
  RequestSourcePublicationPending,
  type RequestSourceWriteResolver,
} from "./ports/out/request-source-publication.port.ts";
import { RequestSourceOwnerError } from "../source-admission/request-source-owner.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import {
  versionedWriteCommandDigest,
  versionedWriteDossierDigest,
} from "./versioned-dossier.ts";
import {
  artifactSourceContentDigest,
  assertQueuedArtifactSourcePublication,
  type QueuedArtifactSourcePublication,
} from "../../../domain/work/artifacts/source-publication.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { validateSourceReference } from "../../../domain/work/artifacts/source-reference.ts";
import type {
  ArtifactSourcePublicationReceipt,
  ArtifactSourceRepositoryPort,
} from "../../work/artifacts/source-repository.ts";
import type { EvolutionAuthorityExercise } from "../../../domain/model/evolution/policy.ts";
import {
  assertPublicationMatches,
  type CandidateActivationPublication,
  type ChangePublication,
  changePublication,
  publicationSourceVersion,
} from "../../../domain/model/publication/change.ts";
import type { AuthorityExercise } from "../../../domain/governance/authority.ts";
import { parseModelRevisionRef } from "../../../domain/model/value-objects/element-ref.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import type { ProposalRecord } from "../../../domain/model/records/revision.ts";
import type { Candidate } from "../../../domain/work/candidates.ts";
import type { PendingChange } from "../../../domain/governance/records/pending-change.ts";
import {
  artifactSourcePublicationFromDossier,
  assertModelWriteDossier,
  type ModelOperationJournal,
  type ModelWriteCommand,
  ModelWriteCommandError,
  type ModelWriteDecision,
  modelWriteDecisionDigest,
  type ModelWriteDossier,
  modelWriteIntentDigest,
  type ModelWriteOperations,
  modelWriteOperationsDigest,
  type WholeFilesOperations,
} from "../../../domain/model/editing/write-command.ts";
import { ModelRepositoryError } from "../repository.ts";
import type { ArtifactSourceWritePort } from "./ports/out/artifact-source-write.port.ts";
import type {
  AcquiredWrite,
  ModelWriteQueuePort,
  SettleOutcome,
  WriteLease,
} from "./ports/out/model-write-queue.port.ts";
import type { WriteWorkerRepositoryPort } from "./ports/out/write-worker-repository.port.ts";
import type { ModelPublicationService } from "./service.ts";

/** W4: durable, serializable write commands and their bounded FIFO execution.
 * Commands are built here, from admitted durable records — a client never
 * grants itself a receipt. One command, one publication, no silent batching. */

async function dossier(input: {
  repositoryId: string;
  commandId: string;
  kind: ModelWriteCommand["kind"];
  operations: ModelWriteOperations;
  decision: ModelWriteDecision;
  recipeDigest: string;
}): Promise<ModelWriteDossier> {
  const approvedBase = input.operations.kind === "host-edits"
    ? input.operations.journal.base
    : input.operations.kind === "whole-files"
    ? input.operations.files.base
    : input.operations.base;
  const intent = {
    repositoryId: input.repositoryId,
    commandId: input.commandId,
    kind: input.kind,
    approvedBase,
    operationsRef: {
      digest: await modelWriteOperationsDigest(input.operations),
    },
    decisionRef: {
      id: input.commandId,
      digest: await modelWriteDecisionDigest(input.decision),
    },
    recipeDigest: input.recipeDigest,
  };
  const built: ModelWriteDossier = {
    v: 1,
    command: {
      v: 1,
      ...intent,
      intentDigest: await modelWriteIntentDigest(intent),
    },
    operations: input.operations,
    decision: input.decision,
  };
  await assertModelWriteDossier(built);
  return built;
}

function journalBaseCheck(
  repositoryId: string,
  journal: ModelOperationJournal,
  pinVersion: string | undefined,
): void {
  if (journal.base.repositoryId !== repositoryId) {
    throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
      reason: "Journal repository differs from the command repository",
      path: "approvedBase",
    }, "Journal repository differs from the command repository");
  }
  if (pinVersion !== undefined && journal.base.version !== pinVersion) {
    throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
      reason: "Journal base differs from the approved pin version",
      path: "approvedBase",
    }, "Journal base differs from the approved pin version");
  }
}

/** From an approved PendingChange and its captured journal. A caller may pass
 * the original recorded approval; it is checked without being regenerated. */
export async function buildApprovedChangeCommand(input: {
  repositoryId: string;
  change: PendingChange;
  pin: ExecutableModel["version"];
  journal: ModelOperationJournal;
  recipeDigest: string;
  approval?: ChangePublication;
}): Promise<ModelWriteDossier> {
  journalBaseCheck(
    input.repositoryId,
    input.journal,
    input.pin.repositoryVersion,
  );
  const approval = input.approval
    ? structuredClone(input.approval)
    : changePublication(structuredClone(input.change), input.pin);
  assertPublicationMatches(input.change, approval);
  if (
    approval.edits.length !== 0 ||
    publicationSourceVersion(approval) !== input.pin.repositoryVersion ||
    approval.adoptedPin.digest !== input.pin.digest ||
    approval.approvedSourceBase !== undefined && (
        approval.approvedSourceBase.modelDigest !== input.pin.digest ||
        approval.approvedSourceBase.sourceDigest !==
          input.journal.baseSourceDigest
      )
  ) {
    throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
      reason: "Approval pin or recorded edits differ from the queued decision",
      path: "decision.approval",
    }, "Approval pin or recorded edits differ from the queued decision");
  }
  return await dossier({
    repositoryId: input.repositoryId,
    commandId: input.change.id,
    kind: "approved-change",
    operations: { kind: "host-edits", journal: input.journal },
    decision: {
      kind: "approved-change",
      approval,
      change: structuredClone(input.change),
    },
    recipeDigest: input.recipeDigest,
  });
}

/** From an admission already recorded in a candidate-activation receipt. */
export async function buildActivationCommand(input: {
  repositoryId: string;
  approval: CandidateActivationPublication;
  journal: ModelOperationJournal;
  recipeDigest: string;
  candidate?: Candidate;
}): Promise<ModelWriteDossier> {
  journalBaseCheck(
    input.repositoryId,
    input.journal,
    input.approval.adoptedPin.repositoryVersion,
  );
  if (input.approval.edits.length !== 0) {
    throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
      reason: "Activation approval must be stored as approved, edits unfilled",
      path: "decision.approval.edits",
    }, "Activation approval must be stored as approved, edits unfilled");
  }
  return await dossier({
    repositoryId: input.repositoryId,
    commandId: input.approval.changeId,
    kind: "activate-candidate",
    operations: { kind: "host-edits", journal: input.journal },
    decision: {
      kind: "activate-candidate",
      approval: structuredClone(input.approval),
      ...(input.candidate
        ? { candidate: structuredClone(input.candidate) }
        : {}),
    },
    recipeDigest: input.recipeDigest,
  });
}

/** From a live proposal record; whole-file preimages come from its recorded
 * diff. Execution still passes through the repository's controlled merge,
 * authorization and CAS — the dossier freezes what was decided. */
export async function buildAcceptProposalCommand(input: {
  repositoryId: string;
  proposal: ProposalRecord;
  expectedVersion: string;
  author: string;
  baseSourceDigest: string;
  decisionAuthorityExercise?: AuthorityExercise;
  evolutionDecision?: EvolutionAuthorityExercise;
  recipeDigest: string;
}): Promise<ModelWriteDossier> {
  const { proposal } = input;
  parseModelRevisionRef({
    repositoryId: input.repositoryId,
    version: input.expectedVersion,
  });
  if (proposal.status !== "proposed" || !proposal.proposalVersion) {
    throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
      reason: "Only a live proposed proposal can be commanded for acceptance",
      path: "decision.proposalId",
    }, "Only a live proposed proposal can be commanded for acceptance");
  }
  const files: WholeFilesOperations = {
    v: 1,
    base: parseModelRevisionRef({
      repositoryId: input.repositoryId,
      version: proposal.baseVersion,
    }),
    baseSourceDigest: input.baseSourceDigest,
    files: await Promise.all(proposal.diff.map(async (change) => ({
      path: change.path,
      baseDigest: change.before === undefined
        ? null
        : await sha256(change.before),
      text: change.after ?? null,
    }))),
  };
  return await dossier({
    repositoryId: input.repositoryId,
    commandId: proposal.id,
    kind: "accept-proposal",
    operations: { kind: "whole-files", files },
    decision: {
      kind: "accept-proposal",
      proposalId: proposal.id,
      baseVersion: proposal.baseVersion,
      proposalSourceDigest: proposal.sourceDigest,
      proposalVersion: proposal.proposalVersion,
      expectedVersion: input.expectedVersion,
      author: input.author,
      ...(input.evolutionDecision
        ? { evolutionDecision: input.evolutionDecision }
        : {}),
      ...(input.decisionAuthorityExercise
        ? { decisionAuthorityExercise: input.decisionAuthorityExercise }
        : {}),
    },
    recipeDigest: input.recipeDigest,
  });
}

/** Source storage intent uses the same W4 FIFO/fence as model publication.
 * The format marker is not a native compilation or activation permission. */
export async function buildArtifactSourceRetentionCommand(
  input: QueuedArtifactSourcePublication & {
    repositoryId: string;
    scopeId: string;
  },
): Promise<ModelWriteDossier> {
  const { repositoryId, scopeId, ...publication } = structuredClone(input);
  await assertQueuedArtifactSourcePublication(publication, repositoryId);
  return await dossier({
    repositoryId,
    commandId: publication.publicationId,
    kind: "retain-artifact-source",
    operations: {
      kind: "artifact-source",
      source: publication.source,
      base: parseModelRevisionRef({
        repositoryId,
        version: publication.baseVersion,
      }),
      baseSourceDigest: publication.baseSourceDigest,
      scopeId,
      contentDigest: await artifactSourceContentDigest(publication.source),
    },
    decision: {
      kind: "retain-artifact-source",
      publicationId: publication.publicationId,
      target: publication.target,
      proof: publication.proof,
      ...(publication.upstream ? { upstream: publication.upstream } : {}),
    },
    recipeDigest: await sha256("assembly-artifact-source-retention-v1"),
  });
}

/** Shared exact-receipt check for the worker and completed publisher retries.
 * Reads only the immutable source pin; never advances/loads a model snapshot. */
export async function assertArtifactSourceRetentionReceipt(
  dossier: ModelWriteDossier,
  commandDigest: string,
  scopeId: string,
  repository: ArtifactSourceRepositoryPort,
  receipt: ArtifactSourcePublicationReceipt,
): Promise<void> {
  const operations = dossier.operations;
  if (operations.kind !== "artifact-source") {
    throw new Error("Artifact source operation kind differs");
  }
  validateSourceReference(receipt.reference);
  if (
    receipt.version !== 1 || receipt.reference.scopeId !== scopeId ||
    receipt.reference.repositoryId !== dossier.command.repositoryId ||
    receipt.reference.artifactId !== operations.source.artifactId ||
    receipt.reference.kind !== operations.source.kind ||
    receipt.reference.contentDigest !== operations.contentDigest ||
    receipt.baseVersion !== operations.base.version ||
    receipt.baseSourceDigest !== operations.baseSourceDigest ||
    receipt.command?.commandId !== dossier.command.commandId ||
    receipt.command?.commandDigest !== commandDigest
  ) {
    throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
      repositoryId: dossier.command.repositoryId,
      commandId: dossier.command.commandId,
      reason: "Source command anchor differs from its exact queued intent",
    }, "Source command anchor differs from its exact queued intent");
  }
  // Adapter verifies the retained manifest/durable ref and exact content.
  // Compare again against the frozen request before SQL acknowledges it.
  const retained = await repository.read(receipt.reference);
  if (
    canonical(retained) !== canonical(operations.source) ||
    await artifactSourceContentDigest(retained) !== operations.contentDigest
  ) {
    throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
      repositoryId: dossier.command.repositoryId,
      commandId: dossier.command.commandId,
      reason: "Retained source content differs from its queued dossier",
    }, "Retained source content differs from its queued dossier");
  }
}

type LegacyAcquiredWrite = Omit<AcquiredWrite, "dossier" | "entry"> & {
  readonly dossier: ModelWriteDossier;
  readonly entry: Omit<AcquiredWrite["entry"], "command"> & {
    readonly command: ModelWriteCommand;
  };
};

export class ModelWriteQueueError extends Error {
  readonly recovery: "refuse" | "retry";
  constructor(
    readonly code:
      | "WRITE_FENCE_LOST"
      | "WRITE_QUEUE_CONFLICT"
      | "WRITE_QUEUE_FULL"
      | "WRITE_QUEUE_INVALID"
      | "WRITE_QUEUE_UNAVAILABLE",
    readonly context: {
      readonly repositoryId?: string;
      readonly commandId?: string;
      readonly reason: string;
    },
    message: string,
  ) {
    super(message);
    this.name = "ModelWriteQueueError";
    this.recovery = code === "WRITE_QUEUE_UNAVAILABLE" ? "retry" : "refuse";
  }
}

export interface ModelWriteWorkerOptions {
  readonly queue: ModelWriteQueuePort;
  readonly publication: Pick<
    ModelPublicationService,
    "prepare" | "publish"
  >;
  readonly repository: WriteWorkerRepositoryPort;
  readonly owner: string;
  readonly leaseMs?: number;
  readonly heartbeatEveryMs?: number;
  readonly maxAttempts?: number;
  /** Current compiler recipe identity. Accept-proposal must not compile a
   * persisted decision under a different recipe after restart. */
  readonly recipeDigest?: () => Promise<string>;
  readonly artifactSourceWrites?: ArtifactSourceWritePort;
  /** Structural/historical binding only; the facade owns fresh D1 publication. */
  readonly requestSources?: RequestSourceWriteResolver;
  readonly scopedSoftwareSources?: ScopedSoftwareSourceWriteResolver;
}

export type WorkerOutcome =
  | { readonly status: "idle" }
  | {
    readonly status: "published";
    readonly commandId: string;
    readonly version: string;
    readonly already: boolean;
  }
  | {
    readonly status: "retryable" | "needs-decision" | "refused";
    readonly commandId: string;
    readonly error: { readonly code: string; readonly message: string };
  }
  | { readonly status: "fence-lost"; readonly commandId: string };

const DEFAULT_LEASE_MS = 300_000;
const DEFAULT_MAX_ATTEMPTS = 5;

function errorInfo(error: unknown): { code: string; message: string } {
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code: unknown }).code)
    : "WRITE_EXECUTION_FAILED";
  return {
    code,
    message: errorMessage(error),
  };
}

/** Executes durable commands one at a time. A queue acknowledgement never
 * counts as activation: only the repository publication does. */
export class ModelWriteWorker {
  readonly #options: ModelWriteWorkerOptions;
  constructor(options: ModelWriteWorkerOptions) {
    this.#options = options;
  }

  async runOnce(repositoryId: string): Promise<WorkerOutcome> {
    const { queue, owner } = this.#options;
    const leaseMs = this.#options.leaseMs ?? DEFAULT_LEASE_MS;
    await queue.recoverExpired();
    const acquired = await queue.acquire(repositoryId, owner, leaseMs);
    if (!acquired) return { status: "idle" };
    const { lease, entry } = acquired;
    const commandId = lease.commandId;
    let fenceLost = false;
    const heartbeatMs = this.#options.heartbeatEveryMs ?? 0;
    const timer = heartbeatMs > 0
      ? setInterval(() => {
        queue.heartbeat(lease, leaseMs).catch(() => {
          fenceLost = true;
        });
      }, heartbeatMs)
      : undefined;
    const settle = async (outcome: SettleOutcome): Promise<WorkerOutcome> => {
      await queue.settle(lease, outcome);
      return outcome.status === "published"
        ? {
          status: "published",
          commandId,
          version: outcome.version,
          already: false,
        }
        : { status: outcome.status, commandId, error: outcome.error };
    };
    try {
      const validated = await parseVersionedModelWriteDossier(acquired.dossier);
      const commandDigest = await versionedWriteCommandDigest(
        validated.command,
      );
      const dossierDigest = await versionedWriteDossierDigest(validated);
      if (
        commandDigest !== entry.commandDigest ||
        dossierDigest !== entry.dossierDigest ||
        canonical(entry.command) !== canonical(validated.command)
      ) {
        return await settle({
          status: "refused",
          error: {
            code: "WRITE_DOSSIER_MISMATCH",
            message: "Stored dossier no longer matches its queued digests.",
          },
        });
      }
      if (validated.v === 2) {
        if (isScopedSoftwareWriteDossier(validated)) {
          return await this.#scopedSoftwareSource(
            validated,
            lease,
            () => fenceLost,
          );
        }
        return await this.#requestSource(validated, lease, () => fenceLost);
      }
      // V1 helpers remain Main-only; the v2 branch cannot reach them.
      const legacy: LegacyAcquiredWrite = {
        ...acquired,
        dossier: validated,
        entry: { ...entry, command: validated.command },
      };
      // Source command anchors have their own namespace and never count as
      // admitted model publication receipts.
      if (legacy.dossier.decision.kind === "retain-artifact-source") {
        if (fenceLost) return { status: "fence-lost", commandId };
        return await this.#retainArtifactSource(legacy, lease);
      }

      // After any crash, the real publication decides before re-applying.
      const published = await this.#alreadyPublished(legacy);
      if (published) {
        await queue.settle(lease, { status: "published", version: published });
        return {
          status: "published",
          commandId,
          version: published,
          already: true,
        };
      }
      if (fenceLost) return { status: "fence-lost", commandId };

      const decision = legacy.dossier.decision;
      if (decision.kind === "accept-proposal") {
        const currentRecipeDigest = await this.#options.recipeDigest?.();
        if (
          currentRecipeDigest !== undefined &&
          currentRecipeDigest !== legacy.dossier.command.recipeDigest
        ) {
          return await settle({
            status: "needs-decision",
            error: {
              code: "RECIPE_CHANGED",
              message:
                "Compiler recipe changed after the proposal acceptance decision.",
            },
          });
        }
        const version = await this.#acceptProposal(legacy, lease);
        await queue.settle(lease, { status: "published", version });
        return { status: "published", commandId, version, already: false };
      }

      const operations = legacy.dossier.operations;
      if (operations.kind !== "host-edits") {
        return await settle({
          status: "refused",
          error: {
            code: "WRITE_DOSSIER_MISMATCH",
            message: "Host-edit commands require an operation journal.",
          },
        });
      }
      const prepared = await this.#options.publication.prepare({
        approval: decision.approval,
        journal: operations.journal,
        command: { commandId, commandDigest },
        expectedRecipeDigest: legacy.dossier.command.recipeDigest,
        ...(decision.kind === "approved-change"
          ? { change: decision.change }
          : {}),
        ...(decision.kind === "activate-candidate" && decision.candidate
          ? { activationCandidate: decision.candidate }
          : {}),
      });
      if (prepared.status === "already-published") {
        await queue.settle(lease, {
          status: "published",
          version: prepared.revision.version,
        });
        return {
          status: "published",
          commandId,
          version: prepared.revision.version,
          already: true,
        };
      }
      if (
        prepared.status === "needs-decision" || prepared.status === "refused"
      ) {
        return await settle({
          status: prepared.status,
          error: prepared.reason,
        });
      }
      if (fenceLost) return { status: "fence-lost", commandId };
      await queue.transition(lease, "prepared");
      // Fence checkpoint: an owner that lost its lease never reaches the CAS.
      await queue.transition(lease, "publishing");
      const outcome = await this.#options.publication.publish(
        prepared.prepared,
        prepared.candidateSources,
        {
          ...(prepared.descriptor ? { descriptor: prepared.descriptor } : {}),
          // Revalidated by the repository under its lock, up to the CAS.
          fence: lease,
        },
      );
      switch (outcome.status) {
        case "published":
        case "already-published":
          await queue.settle(lease, {
            status: "published",
            version: outcome.revision.version,
          });
          return {
            status: "published",
            commandId,
            version: outcome.revision.version,
            already: outcome.status === "already-published",
          };
        case "stale":
          return await this.#retryOrEscalate(legacy, settle, {
            code: "STALE_REVISION",
            message: "Model head changed during publication.",
          });
        case "needs-decision":
        case "refused":
          return await settle({
            status: outcome.status,
            error: outcome.reason,
          });
        default:
          throw new Error("Unreachable publication outcome");
      }
    } catch (error) {
      if (
        error instanceof ModelWriteQueueError &&
        error.code === "WRITE_FENCE_LOST"
      ) {
        return { status: "fence-lost", commandId };
      }
      if (
        error instanceof ModelWriteQueueError &&
        error.code === "WRITE_QUEUE_CONFLICT"
      ) {
        return await settle({
          status: acquired.dossier.v === 2 ? "refused" : "needs-decision",
          error: errorInfo(error),
        });
      }
      if (acquired.dossier.v === 2 && isRequestSourceHistoryConflict(error)) {
        return await settle({ status: "refused", error: errorInfo(error) });
      }
      if (error instanceof RequestSourcePublicationPending) {
        return await settle({ status: "retryable", error: errorInfo(error) });
      }
      if (
        error instanceof RequestSourceOwnerError ||
        error instanceof RequestSpaceError && error.code === "FORBIDDEN"
      ) {
        return await settle({ status: "refused", error: errorInfo(error) });
      }
      if (error instanceof ModelWriteCommandError) {
        return await settle({ status: "refused", error: errorInfo(error) });
      }
      if (error instanceof ModelRepositoryError) {
        if (
          acquired.dossier.v === 2 && !isRequestSourceProofUnavailable(error) &&
          (error.code === "SOURCE_CONFLICT" ||
            error.code === "EDIT_SCOPE_DENIED" ||
            error.code === "INVALID_REPOSITORY")
        ) {
          return await settle({ status: "refused", error: errorInfo(error) });
        }
        if (
          error.code === "SOURCE_CONFLICT" || error.code === "EDIT_SCOPE_DENIED"
        ) {
          return await settle({
            status: "needs-decision",
            error: errorInfo(error),
          });
        }
        if (error.code === "INVALID_REQUEST") {
          return await settle({ status: "refused", error: errorInfo(error) });
        }
      }
      return await this.#retryOrEscalate(acquired, settle, errorInfo(error));
    } finally {
      if (timer !== undefined) clearInterval(timer);
    }
  }

  async #scopedSoftwareSource(
    dossier: ScopedSoftwareWriteDossierV2,
    lease: WriteLease,
    lost: () => boolean,
  ): Promise<WorkerOutcome> {
    const resolver = this.#options.scopedSoftwareSources;
    if (!resolver) {
      throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
        reason: "No exact scoped software source writer is available",
      }, "No exact scoped software source writer is available");
    }
    const facade = await resolver.resolve(dossier);
    assertModelWriteDestinationMatches(dossier.command, facade.destination);
    if (lost()) return { status: "fence-lost", commandId: lease.commandId };
    let recovered;
    try {
      recovered = await facade.recover(lease);
    } catch (error) {
      if (isRequestSourceProofUnavailable(error)) {
        throw new RequestSourcePublicationPending(error);
      }
      throw error;
    }
    if (recovered) {
      await this.#options.queue.settle(lease, {
        status: "published",
        version: recovered.version,
      });
      return {
        status: "published",
        commandId: lease.commandId,
        version: recovered.version,
        already: true,
      };
    }
    const recipe = await this.#options.recipeDigest?.();
    if (recipe !== undefined && recipe !== dossier.command.recipeDigest) {
      const error = {
        code: "RECIPE_CHANGED",
        message: "Compiler recipe changed after scoped software acceptance.",
      };
      await this.#options.queue.settle(lease, {
        status: "needs-decision",
        error,
      });
      return { status: "needs-decision", commandId: lease.commandId, error };
    }
    if (lost()) return { status: "fence-lost", commandId: lease.commandId };
    await this.#options.queue.transition(lease, "publishing");
    const revision = await facade.accept(lease);
    const anchored = await facade.recover(lease);
    if (anchored?.version !== revision.version) {
      throw new ModelRepositoryError(
        "SOURCE_CONFLICT",
        "Scoped software publication lacks its exact settled software anchor",
      );
    }
    await this.#options.queue.settle(lease, {
      status: "published",
      version: revision.version,
    });
    return {
      status: "published",
      commandId: lease.commandId,
      version: revision.version,
      already: false,
    };
  }

  async #requestSource(
    dossier: ModelWriteDossierV2,
    lease: WriteLease,
    lost: () => boolean,
  ): Promise<WorkerOutcome> {
    const { queue, requestSources } = this.#options;
    // Codec support does not implement other source routes. Refuse BEFORE any
    // facade/Main repository/current/publication lookup.
    if (dossier.command.kind === "approved-change") {
      assertRequestChangeDossier(dossier);
    }
    if (
      !requestSources || dossier.command.kind !== "approved-change" && (
          dossier.command.kind !== "accept-proposal" ||
          dossier.decision.kind !== "accept-proposal" ||
          dossier.decision.author !== "local-owner" ||
          dossier.operations.kind !== "whole-files"
        )
    ) {
      throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
        reason: "No exact Request accept-proposal writer is available",
      }, "No exact Request accept-proposal writer is available");
    }
    const facade = await requestSources.resolve(dossier);
    assertModelWriteDestinationMatches(dossier.command, facade.destination);
    if (lost()) return { status: "fence-lost", commandId: lease.commandId };
    // Historical attestation/settlement comes before fresh credential, recipe,
    // lifecycle and current-head requirements. The resolver may not invert this.
    let recovered;
    try {
      recovered = await facade.recover(lease);
    } catch (error) {
      if (isRequestSourceProofUnavailable(error)) {
        throw new RequestSourcePublicationPending(error);
      }
      throw error;
    }
    if (recovered) {
      await queue.settle(lease, {
        status: "published",
        version: recovered.version,
      });
      return {
        status: "published",
        commandId: lease.commandId,
        version: recovered.version,
        already: true,
      };
    }
    const recipe = await this.#options.recipeDigest?.();
    if (recipe !== undefined && recipe !== dossier.command.recipeDigest) {
      await queue.settle(lease, {
        status: "needs-decision",
        error: {
          code: "RECIPE_CHANGED",
          message:
            "Compiler recipe changed after the Request acceptance decision.",
        },
      });
      return {
        status: "needs-decision",
        commandId: lease.commandId,
        error: {
          code: "RECIPE_CHANGED",
          message:
            "Compiler recipe changed after the Request acceptance decision.",
        },
      };
    }
    if (lost()) return { status: "fence-lost", commandId: lease.commandId };
    await queue.transition(lease, "publishing");
    const revision = await facade.accept(lease);
    const anchored = await facade.recover(lease);
    if (anchored?.version !== revision.version) {
      throw new ModelRepositoryError(
        "SOURCE_CONFLICT",
        "Request publication lacks its exact settled command anchor",
      );
    }
    await queue.settle(lease, {
      status: "published",
      version: revision.version,
    });
    return {
      status: "published",
      commandId: lease.commandId,
      version: revision.version,
      already: false,
    };
  }

  async #retainArtifactSource(
    acquired: LegacyAcquiredWrite,
    lease: WriteLease,
  ): Promise<WorkerOutcome> {
    const port = this.#options.artifactSourceWrites;
    const operations = acquired.dossier.operations;
    if (
      !port || operations.kind !== "artifact-source" ||
      operations.scopeId !== port.scopeId
    ) {
      throw new ModelWriteCommandError("WRITE_DOSSIER_MISMATCH", {
        reason: "No exact host-bound artifact source writer is available",
      }, "No exact host-bound artifact source writer is available");
    }
    const publication = artifactSourcePublicationFromDossier(acquired.dossier);
    await port.assertCurrent(structuredClone(publication));
    const command = {
      commandId: lease.commandId,
      commandDigest: acquired.entry.commandDigest,
    };
    let receipt = await port.repository.findByCommand(command);
    const already = receipt !== null;
    if (!receipt) {
      await this.#options.queue.transition(lease, "publishing");
      receipt = await port.repository.retain({
        source: publication.source,
        baseVersion: publication.baseVersion,
        command,
        fence: lease,
      }, {
        assertCurrent: () => port.assertCurrent(structuredClone(publication)),
      });
    }
    await assertArtifactSourceRetentionReceipt(
      acquired.dossier,
      acquired.entry.commandDigest,
      port.scopeId,
      port.repository,
      receipt,
    );
    await port.assertCurrent(structuredClone(publication));
    const version = `commit:${receipt.reference.commitOid}`;
    await this.#options.queue.settle(lease, { status: "published", version });
    return {
      status: "published",
      commandId: lease.commandId,
      version,
      already,
    };
  }

  async #retryOrEscalate(
    acquired: AcquiredWrite,
    settle: (outcome: SettleOutcome) => Promise<WorkerOutcome>,
    error: { code: string; message: string },
  ): Promise<WorkerOutcome> {
    const maxAttempts = this.#options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (acquired.entry.attempts + 1 >= maxAttempts) {
      return await settle({
        status: "needs-decision",
        error: {
          code: "RETRY_BUDGET_EXHAUSTED",
          message: `${error.code}: ${error.message}`,
        },
      });
    }
    return await settle({ status: "retryable", error });
  }

  /** Only an atomic command anchor with the exact digest proves completion.
   * An accepted proposal without one may have been accepted separately. */
  async #alreadyPublished(
    acquired: LegacyAcquiredWrite,
  ): Promise<string | undefined> {
    const { repository } = this.#options;
    const { command } = acquired.dossier;
    const anchored = await repository.findPublicationByCommand(
      command.commandId,
    );
    if (anchored) {
      if (anchored.commandDigest !== acquired.entry.commandDigest) {
        throw new ModelWriteQueueError("WRITE_QUEUE_CONFLICT", {
          repositoryId: command.repositoryId,
          commandId: command.commandId,
          reason: "Command anchor lacks the exact queued command digest",
        }, "Command anchor lacks the exact queued command digest");
      }
      return anchored.revision.version;
    }
    const decision = acquired.dossier.decision;
    if (decision.kind === "accept-proposal") {
      const record = await repository.proposal(decision.proposalId);
      if (record.status === "accepted" && record.acceptedVersion) {
        throw new ModelRepositoryError(
          "SOURCE_CONFLICT",
          "Proposal was accepted without this command's atomic digest anchor",
        );
      }
    }
    return undefined;
  }

  async #acceptProposal(
    acquired: LegacyAcquiredWrite,
    lease: WriteLease,
  ): Promise<string> {
    const { repository, queue } = this.#options;
    const decision = acquired.dossier.decision;
    if (decision.kind !== "accept-proposal") throw new Error("kind mismatch");
    const record = await repository.proposal(decision.proposalId);
    if (record.status === "accepted" && record.acceptedVersion) {
      const anchored = await this.#alreadyPublished(acquired);
      if (anchored) return anchored;
      throw new ModelRepositoryError(
        "SOURCE_CONFLICT",
        "Proposal acceptance has no matching command anchor",
      );
    }
    if (record.status === "rejected") {
      throw new ModelRepositoryError(
        "INVALID_REQUEST",
        "Proposal was rejected after the write command was decided",
      );
    }
    if (
      record.status !== "proposed" ||
      record.sourceDigest !== decision.proposalSourceDigest ||
      record.proposalVersion !== decision.proposalVersion ||
      record.baseVersion !== decision.baseVersion
    ) {
      throw new ModelRepositoryError(
        "INVALID_REQUEST",
        "Proposal changed after the write command was decided",
      );
    }
    await queue.transition(lease, "publishing");
    if (!decision.expectedVersion) {
      throw new ModelRepositoryError(
        "SOURCE_CONFLICT",
        "Legacy proposal command has no approved HEAD version",
      );
    }
    const current = await repository.current();
    if (current.version !== decision.expectedVersion) {
      throw new ModelRepositoryError(
        "SOURCE_CONFLICT",
        "Admitted model HEAD differs from the proposal acceptance decision",
      );
    }
    const revision = await repository.accept({
      id: decision.proposalId,
      expectedVersion: decision.expectedVersion,
      author: decision.author,
      command: {
        commandId: acquired.dossier.command.commandId,
        commandDigest: acquired.entry.commandDigest,
      },
      fence: lease,
      ...(decision.evolutionDecision
        ? { evolutionDecision: decision.evolutionDecision }
        : {}),
      ...(decision.decisionAuthorityExercise
        ? { decisionAuthorityExercise: decision.decisionAuthorityExercise }
        : {}),
    });
    const anchored = await this.#alreadyPublished(acquired);
    if (anchored !== revision.version) {
      throw new ModelRepositoryError(
        "SOURCE_CONFLICT",
        "Proposal acceptance did not anchor this command with HEAD",
      );
    }
    return revision.version;
  }
}
