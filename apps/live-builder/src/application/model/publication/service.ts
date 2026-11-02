import { errorMessage } from "../../../domain/primitives/error-message.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  anyPublicationAuthor,
  assertAnyPublicationSize,
  ChangePublicationError,
  type PreparedPublication,
  preparePublication,
  type RevalidationEvidence,
  type SourcePublication,
} from "../../../domain/model/publication/change.ts";
import type { CompiledModel } from "../../../domain/model/records/compiled-model.ts";
import type { ModelSources as Sources } from "../../../domain/model/value-objects/sources.ts";
import {
  type HostEdit,
  HostEditError,
} from "../../../domain/model/editing/host-edit.ts";
import {
  artifactDigest,
  type BuildDescriptor,
  buildKey,
  type BuildRecipeInputs,
  recipeDigest as computeRecipeDigest,
} from "../../../domain/model/value-objects/build.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import { modelSourceDigest } from "../../../domain/model/value-objects/sources.ts";
import {
  assertOperationJournal,
  type JournalReplayBlock,
  operationJournalDigest,
  planJournalReplay,
} from "../../../domain/model/editing/write-command.ts";
import { ModelRepositoryError, type PublicationFence } from "../repository.ts";
import type { ModelCompiler } from "../builds/ports/out/model-compiler.port.ts";
import type { PreparePublicationInput } from "./commands/inputs.ts";
import type { HostEditExecutorPort } from "./ports/out/host-edit-executor.port.ts";
import type { PublicationRevalidationPort } from "./ports/out/publication-revalidation.port.ts";
import type { PublicationRepositoryPort } from "./ports/out/publication-repository.port.ts";

/** W3 optimistic publication: preparation/compilation/verification outside the
 * repository lock, publication by CAS under it. The original approval is never
 * rewritten; each attempt names its execution base and its revalidation proof. */

export class ModelPublicationError extends Error {
  readonly recovery: "refuse" | "retry" | { readonly action: "reload" };
  constructor(
    readonly code: "NEEDS_DECISION" | "REFUSED" | "STALE",
    readonly context: {
      readonly changeId: string;
      readonly reason: string;
      readonly block?: JournalReplayBlock;
    },
    message: string,
  ) {
    super(message);
    this.name = "ModelPublicationError";
    this.recovery = code === "NEEDS_DECISION"
      ? "refuse"
      : code === "STALE"
      ? "retry"
      : "refuse";
  }
}

export interface PublicationReason {
  readonly code: string;
  readonly message: string;
  readonly block?: JournalReplayBlock;
}
export type PrepareOutcome =
  | {
    readonly status: "prepared";
    readonly prepared: PreparedPublication;
    readonly candidateSources: Sources;
    /** Verified build hand-off (ensured during preparation): publication
     * resolves these bytes under the lock, never a second compilation. */
    readonly descriptor?: BuildDescriptor;
  }
  | { readonly status: "already-published"; readonly revision: ModelRevision }
  | { readonly status: "needs-decision"; readonly reason: PublicationReason }
  | { readonly status: "refused"; readonly reason: PublicationReason };
export type PublishOutcome =
  | { readonly status: "published"; readonly revision: ModelRevision }
  | { readonly status: "already-published"; readonly revision: ModelRevision }
  | { readonly status: "stale"; readonly headVersion: string | null }
  | { readonly status: "needs-decision"; readonly reason: PublicationReason }
  | { readonly status: "refused"; readonly reason: PublicationReason };

export interface ModelPublicationServiceOptions {
  readonly repositoryId: string;
  readonly repository: PublicationRepositoryPort;
  readonly compiler: ModelCompiler;
  readonly executor: HostEditExecutorPort;
  readonly revalidator: PublicationRevalidationPort;
  /** W2 build hand-off: preparation ensures the verified candidate bytes so
   * publication under the lock resolves them instead of recompiling. */
  readonly builds?: {
    ensure(
      compiled: CompiledModel,
      recipe: BuildRecipeInputs,
    ): Promise<BuildDescriptor>;
  };
}

function reason(code: string, error: unknown): PublicationReason {
  return {
    code,
    message: errorMessage(error),
  };
}

/** Same approval facts behind a filled v1 receipt or a v2 attempt. */
function sameApproval(
  approval: SourcePublication,
  receipt: SourcePublication | PreparedPublication,
): boolean {
  const stored = "v" in receipt && receipt.v === 2 ? receipt.approval : receipt;
  return canonical({ ...stored, edits: [] }) === canonical(approval);
}

export class ModelPublicationService {
  readonly #options: ModelPublicationServiceOptions;
  constructor(options: ModelPublicationServiceOptions) {
    this.#options = options;
  }

  async #alreadyPublished(
    input: {
      approval: SourcePublication;
      command?: { commandId: string; commandDigest: string };
    },
  ): Promise<PrepareOutcome | PublishOutcome | undefined> {
    const { repository } = this.#options;
    const byCommand = input.command
      ? await repository.findPublicationByCommand(input.command.commandId)
      : null;
    const found = byCommand ??
      await repository.findPublication(input.approval.changeId);
    if (!found) return undefined;
    if (
      input.command &&
      (!byCommand || byCommand.commandDigest !== input.command.commandDigest)
    ) {
      return {
        status: "refused",
        reason: {
          code: "WRITE_COMMAND_ANCHOR_MISMATCH",
          message:
            "Published effect lacks this command's atomic digest anchor.",
        },
      };
    }
    if (found.receipt && !sameApproval(input.approval, found.receipt)) {
      return {
        status: "refused",
        reason: {
          code: "PUBLICATION_RECEIPT_MISMATCH",
          message: "Published receipt differs from the original approval.",
        },
      };
    }
    return { status: "already-published", revision: found.revision };
  }

  /** Prepare outside the lock: replay on the current HEAD, compile, verify,
   * revalidate scope/authority. Publishes nothing. */
  async prepare(input: PreparePublicationInput): Promise<PrepareOutcome> {
    const { repository, compiler, executor, revalidator } = this.#options;
    const { approval, journal } = input;
    assertOperationJournal(journal);
    if (journal.base.repositoryId !== this.#options.repositoryId) {
      return {
        status: "refused",
        reason: {
          code: "REPOSITORY_MISMATCH",
          message: "Journal belongs to another model repository.",
        },
      };
    }
    if (approval.edits.length !== 0) {
      return {
        status: "refused",
        reason: {
          code: "PUBLICATION_NOT_APPLICABLE",
          message: "Prepare from the original approval, not a filled receipt.",
        },
      };
    }
    const existing = await this.#alreadyPublished(input);
    if (existing) {
      return existing.status === "already-published"
        ? { status: "already-published", revision: existing.revision }
        : {
          status: "refused",
          reason: (existing as { reason: PublicationReason }).reason,
        };
    }

    const executionBase = await repository.current();
    const baseUnchanged = executionBase.version === journal.base.version;
    if (
      baseUnchanged && executionBase.sourceDigest !== journal.baseSourceDigest
    ) {
      throw new ModelRepositoryError(
        "INVALID_REPOSITORY",
        "Approved base version carries different sources than the journal",
      );
    }
    if (!baseUnchanged) {
      const query = {
        nativeIds: [
          ...new Set(journal.entries.map((entry) => entry.target.nativeId)),
        ],
        qualifiedNames: [
          ...new Set(
            journal.entries.map((entry) => entry.target.qualifiedName),
          ),
        ],
      };
      const inventory = await executor.incarnationInventory(
        executionBase,
        query,
      );
      const plan = planJournalReplay(journal, inventory);
      if (!plan.applicable) {
        return {
          status: "needs-decision",
          reason: {
            code: "REPLAY_BLOCKED",
            message:
              `Journal operation ${plan.block.seq} no longer applies on the current base (${plan.block.code}).`,
            block: plan.block,
          },
        };
      }
    }

    const edits = journal.entries.map((entry) => entry.edit);
    let applied: { sources: Sources; resolvedEdits: HostEdit[] };
    try {
      applied = await executor.apply(structuredClone(executionBase), edits);
    } catch (error) {
      if (error instanceof HostEditError) {
        return baseUnchanged
          ? { status: "refused", reason: reason(error.code, error) }
          : { status: "needs-decision", reason: reason(error.code, error) };
      }
      throw error;
    }
    const compiled: CompiledModel = await compiler.compile(
      structuredClone(applied.sources),
    );
    const candidate: ModelRevision = {
      ...compiled,
      version: executionBase.version,
    };
    try {
      // Verify the journal itself against the execution base and candidate:
      // this is where M1b preimages and incarnations are enforced, exactly as
      // for a stored receipt. Resolved edits only describe this application.
      await executor.verify(candidate, edits, executionBase);
    } catch (error) {
      if (error instanceof HostEditError) {
        return { status: "refused", reason: reason(error.code, error) };
      }
      throw error;
    }

    let evidence: RevalidationEvidence;
    try {
      evidence = await revalidator.revalidate({
        approval,
        executionBase,
        candidate,
        edits: applied.resolvedEdits,
        ...(input.change ? { change: input.change } : {}),
        ...(input.activationCandidate
          ? { activationCandidate: input.activationCandidate }
          : {}),
      });
    } catch (error) {
      if (error instanceof ModelPublicationError) {
        return error.code === "NEEDS_DECISION"
          ? {
            status: "needs-decision",
            reason: {
              code: error.context.reason,
              message: error.message,
              ...(error.context.block ? { block: error.context.block } : {}),
            },
          }
          : { status: "refused", reason: reason(error.context.reason, error) };
      }
      throw error;
    }
    if (
      evidence.executionBaseVersion !== executionBase.version ||
      evidence.baseUnchanged !== baseUnchanged ||
      evidence.authorityStillValid !== true
    ) {
      return {
        status: "refused",
        reason: {
          code: "REVALIDATION_INCONSISTENT",
          message: "Revalidation evidence does not name the execution base.",
        },
      };
    }

    const sourceDigest = await modelSourceDigest(applied.sources);
    if (sourceDigest !== compiled.sourceDigest) {
      throw new Error("Compiler source digest differs from prepared sources");
    }
    const recipe = await compiler.recipe();
    const recipeDigest = await computeRecipeDigest(recipe);
    if (
      input.expectedRecipeDigest !== undefined &&
      input.expectedRecipeDigest !== recipeDigest
    ) {
      return {
        status: "needs-decision",
        reason: {
          code: "RECIPE_CHANGED",
          message: "Pipeline recipe changed since the command was approved.",
        },
      };
    }
    const buildIdentity = {
      sourceDigest,
      recipeDigest,
      buildKey: await buildKey(sourceDigest, recipeDigest),
      artifactDigest: await artifactDigest({
        ...(compiled.provider ? { provider: compiled.provider } : {}),
        engineVersion: compiled.engineVersion,
        elements: compiled.elements,
      }),
    };
    // Verified hand-off: the ensured descriptor must name exactly the
    // S/R/K/A this receipt binds, or preparation proves nothing.
    let descriptor: BuildDescriptor | undefined;
    if (this.#options.builds) {
      descriptor = await this.#options.builds.ensure(
        structuredClone(compiled),
        recipe,
      );
      if (
        descriptor.repositoryId !== this.#options.repositoryId ||
        descriptor.sourceDigest !== buildIdentity.sourceDigest ||
        descriptor.recipe.digest !== buildIdentity.recipeDigest ||
        descriptor.buildKey !== buildIdentity.buildKey ||
        descriptor.artifactDigest !== buildIdentity.artifactDigest
      ) {
        throw new Error(
          "Ensured build descriptor differs from the prepared candidate",
        );
      }
    }
    let prepared: PreparedPublication;
    try {
      prepared = preparePublication(approval, {
        executionBase: {
          repositoryVersion: executionBase.version,
          sourceDigest: executionBase.sourceDigest,
        },
        replayedEdits: applied.resolvedEdits,
        journalDigest: await operationJournalDigest(journal),
        revalidation: evidence,
        result: buildIdentity,
        ...(input.command ? { command: input.command } : {}),
      });
      assertAnyPublicationSize(prepared);
    } catch (error) {
      if (error instanceof ChangePublicationError) {
        return { status: "refused", reason: reason(error.code, error) };
      }
      throw error;
    }
    return {
      status: "prepared",
      prepared,
      candidateSources: applied.sources,
      ...(descriptor ? { descriptor } : {}),
    };
  }

  /** Publish one preparation by CAS. If HEAD moved since preparation the
   * attempt is stale: its evidence proves nothing about the new base. */
  async publish(
    prepared: PreparedPublication,
    candidateSources: Sources,
    handOff: {
      readonly descriptor?: BuildDescriptor;
      readonly fence?: PublicationFence;
    } = {},
  ): Promise<PublishOutcome> {
    const { repository } = this.#options;
    const probe = {
      approval: prepared.approval,
      ...(prepared.command ? { command: prepared.command } : {}),
    };
    const existing = await this.#alreadyPublished(probe);
    if (existing) {
      return existing.status === "already-published"
        ? { status: "already-published", revision: existing.revision }
        : {
          status: "refused",
          reason: (existing as { reason: PublicationReason }).reason,
        };
    }
    try {
      const revision = await repository.publishPrepared({
        expectedHeadVersion: prepared.executionBase.repositoryVersion,
        sources: structuredClone(candidateSources),
        author: anyPublicationAuthor(prepared),
        receipt: prepared,
        ...(handOff.descriptor ? { descriptor: handOff.descriptor } : {}),
        ...(handOff.fence ? { fence: handOff.fence } : {}),
      });
      return { status: "published", revision };
    } catch (error) {
      if (
        error instanceof ModelRepositoryError && error.code === "STALE_REVISION"
      ) {
        const raced = await this.#alreadyPublished(probe);
        if (raced?.status === "already-published") {
          return { status: "already-published", revision: raced.revision };
        }
        return {
          status: "stale",
          headVersion: await repository.headVersion(),
        };
      }
      if (error instanceof ChangePublicationError) {
        return error.code === "PUBLICATION_NOT_APPLICABLE" ||
            error.code === "PUBLICATION_RECEIPT_TOO_LARGE"
          ? { status: "refused", reason: reason(error.code, error) }
          : { status: "needs-decision", reason: reason(error.code, error) };
      }
      throw error;
    }
  }

  /** Prepare then publish, re-preparing on a moved HEAD at most
   * `maxReprepare` times. Each attempt revalidates from scratch. */
  async prepareAndPublish(
    input: PreparePublicationInput,
    options: { maxReprepare?: number } = {},
  ): Promise<PublishOutcome> {
    const attempts = Math.max(0, options.maxReprepare ?? 2) + 1;
    let stale: PublishOutcome | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const prepared = await this.prepare(input);
      if (prepared.status === "already-published") {
        return { status: "already-published", revision: prepared.revision };
      }
      if (prepared.status !== "prepared") return prepared;
      const outcome = await this.publish(
        prepared.prepared,
        prepared.candidateSources,
        prepared.descriptor ? { descriptor: prepared.descriptor } : {},
      );
      if (outcome.status !== "stale") return outcome;
      stale = outcome;
    }
    return stale!;
  }
}
