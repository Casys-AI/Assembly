import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { RequestExecutionPin } from "../../../application/model/evolution/request-adoption-ports.ts";
import {
  EvolutionError,
  type EvolutionPreparationInput,
  type EvolutionProposal,
} from "../../../application/model/evolution/ports.ts";
import {
  parseScopedSoftwareContext,
  type ScopedSoftwareContextV2,
} from "../../../application/model/evolution/scoped-software-context.ts";
import {
  parseScopedSoftwareProposal,
  scopedSoftwareProposalDigest,
  type ScopedSoftwareProposalV2,
} from "../../../application/model/evolution/scoped-software-proposal.ts";
import type { ScopedSoftwareEvolutionDossierV2 } from "../../../application/model/evolution/scoped-software-dossier.ts";
import type { ProposalRecord } from "../../../domain/model/records/revision.ts";
import type { ModelEditOperation } from "../../../domain/governance/policies/model-edit-policy.ts";
import { ModelPublicationError } from "../../../application/model/publication/service.ts";
import type { ModelWriteQueueEntry } from "../../../application/model/publication/ports/out/model-write-queue.port.ts";
import type { EvolutionCategory } from "../../../domain/model/evolution/policy.ts";
import {
  classifyEvolutionEffects,
  type EvolutionEffect,
} from "../../../domain/model/evolution/semantic-effects.ts";
import { compileEvolutionAssessment } from "./assessment.ts";
import { validateSourceEvolutionExecutables } from "../sources/source-model.ts";

/** Match the durable queue's terminal outcomes without starting another pump. */
export function assertScopedPublicationSettled(
  commandId: string,
  entry: Pick<ModelWriteQueueEntry, "state" | "publishedVersion" | "lastError">,
): void {
  if (entry.state === "needs-decision" || entry.state === "refused") {
    throw new ModelPublicationError(
      entry.state === "needs-decision" ? "NEEDS_DECISION" : "REFUSED",
      { changeId: commandId, reason: entry.lastError?.code ?? entry.state },
      entry.lastError?.message ?? entry.state,
    );
  }
  if (entry.state !== "published" || !entry.publishedVersion) {
    throw new EvolutionError(
      "EVOLUTION_PUBLICATION_PENDING",
      "The exact queued software publication remains recoverable",
    );
  }
}

/** The signed category set covers both the source change and the change from
 * each target's retained execution pin. Unknown or extra targets refuse. */
export function scopedEvolutionCategoryClosure(
  source: readonly EvolutionCategory[],
  effects: readonly EvolutionEffect[],
  targets: readonly string[],
): EvolutionCategory[] {
  const actual = [...new Set(effects.map((effect) => effect.targetNativeId))]
    .sort();
  if (!effects.length || canonical(actual) !== canonical([...targets].sort())) {
    throw new EvolutionError(
      "EVOLUTION_SOURCE_CHANGED",
      "Runtime evolution effects differ from the scoped targets",
    );
  }
  return [...new Set([...source, ...effects.map((effect) => effect.category)])]
    .sort();
}

/** Exact retained assessment recipe; do not infer replace-source from a whole
 * files queue payload, which records output bytes rather than edit authority. */
export async function scopedEvolutionSourceOperations(
  repository: { proposal(id: string): Promise<ProposalRecord> },
  dossier: ScopedSoftwareEvolutionDossierV2,
): Promise<readonly ModelEditOperation[]> {
  const record = await repository.proposal(dossier.proposal.id),
    authorization = record.authorization;
  if (
    !authorization || authorization.kind !== "operator-evolution" ||
    record.id !== dossier.proposal.id ||
    record.baseVersion !== dossier.proposal.baseVersion ||
    record.proposalVersion !== dossier.proposal.version ||
    record.sourceDigest !== dossier.proposal.sourceDigest ||
    authorization.recipeDigest !== dossier.proposal.recipeDigest ||
    authorization.exercise.act !== "prepare" ||
    authorization.exercise.proposalDigest !==
      dossier.scopedProposal.sourceAssessmentDigest
  ) {
    throw new EvolutionError(
      "EVOLUTION_SOURCE_CHANGED",
      "Scoped evolution source recipe differs",
    );
  }
  const expected = authorization.typedEdits
    ? [...new Set(authorization.typedEdits.edits.map((edit) => edit.kind))]
      .sort()
    : ["replace-source"];
  if (
    canonical([...authorization.editAuthorization.operations].sort()) !==
      canonical(expected) ||
    (authorization.typedEdits &&
      (authorization.typedEdits.baseVersion !== dossier.proposal.baseVersion ||
        authorization.typedEdits.sourceDigest !==
          dossier.scope.destination.expectedAdmittedSource.sourceDigest))
  ) {
    throw new EvolutionError(
      "EVOLUTION_SOURCE_CHANGED",
      "Scoped evolution source edit operations differ",
    );
  }
  return structuredClone(authorization.editAuthorization.operations);
}

/** Staging is delegated to the existing source-assessment implementation.
 * This adapter freezes the independently resolved runtime pins into the signed
 * proposal. It does not authorize publication or convert a Main writer into
 * a Request writer. */
export class ScopedEvolutionPreparation {
  readonly scope: ScopedSoftwareContextV2;
  constructor(
    readonly options: {
      scope: ScopedSoftwareContextV2;
      source: NativeEvolutionRepository;
      readTarget(
        operatorId: string,
      ): Promise<{ model: ExecutableModel; pin: RequestExecutionPin }>;
    },
  ) {
    this.scope = parseScopedSoftwareContext(options.scope);
  }
  async prepare(
    input: EvolutionPreparationInput,
  ): Promise<EvolutionProposal & { scoped: ScopedSoftwareProposalV2 }> {
    const scope = this.scope;
    const refuse = () => {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "Scoped source or runtime pin changed",
      );
    };
    if (
      input.repositoryId !== scope.destination.repositoryId ||
      input.actorId !== scope.actor.operatorId ||
      input.expectedVersion !==
        scope.destination.expectedAdmittedSource.source.version
    ) refuse();
    const actual = await Promise.all(
      scope.targets.map(async (entry) => ({
        entry,
        runtime: await this.options.readTarget(entry.target.operatorId),
      })),
    );
    for (const { entry, runtime } of actual) {
      if (
        canonical(runtime.pin) !== canonical(entry.previousPin) ||
        runtime.model.version.digest !== runtime.pin.modelDigest ||
        runtime.model.version.repositoryVersion !==
          runtime.pin.source.version ||
        runtime.model.identity.builderId !== entry.target.operatorId ||
        runtime.model.identity.projectId !==
          `git:${scope.destination.repositoryId}`
      ) refuse();
    }
    const staged = await this.options.source.prepare(input);
    if (
      staged.baseVersion !== input.expectedVersion ||
      staged.targets.length !== scope.targets.length
    ) refuse();
    const repository = this.options.source.options.repository;
    const assessment = await compileEvolutionAssessment({
      before: await repository.at(staged.baseVersion),
      after: await repository.at(staged.version),
      projectId: `git:${scope.destination.repositoryId}`,
      recipeDigest: staged.recipeDigest,
    });
    if (assessment.digest !== staged.digest) refuse();
    const before = [...assessment.before];
    for (const entry of scope.targets) {
      const retained = await validateSourceEvolutionExecutables(
        await repository.at(entry.previousPin.source.version),
        `git:${scope.destination.repositoryId}`,
      );
      const matching = retained.filter((item) =>
        item.model.identity.builderId === entry.target.operatorId &&
        item.model.version.digest === entry.previousPin.modelDigest
      );
      const index = before.findIndex((item) =>
        item.model.identity.builderId === entry.target.operatorId
      );
      if (matching.length !== 1 || index < 0) return refuse();
      before[index] = matching[0];
    }
    const categories = scopedEvolutionCategoryClosure(
      staged.categories,
      classifyEvolutionEffects(before, assessment.after),
      scope.targets.map((entry) => entry.target.operatorId),
    );
    const targets = staged.targets.map((target) => {
      const entry = scope.targets.find((item) =>
        item.target.operatorId === target.operatorId
      );
      if (!entry) return refuse();
      return { target: entry.target, candidateDigest: target.candidateDigest };
    });
    const scoped = parseScopedSoftwareProposal({
      format: "software-evolution-scoped/v2",
      context: scope,
      sourceAssessmentDigest: staged.digest,
      targets,
      categories,
    });
    const digest = await scopedSoftwareProposalDigest(scoped);
    return {
      ...staged,
      digest,
      categories,
      targets: staged.targets.map((target) => {
        const entry = scope.targets.find((item) =>
          item.target.operatorId === target.operatorId
        );
        if (!entry) return refuse();
        return { ...target, previousDigest: entry.previousPin.modelDigest };
      }),
      scoped,
    };
  }
}

import type { EvolutionRepositoryPort } from "../../../application/model/evolution/ports.ts";
import type { ScopedSoftwarePublicationV2 } from "../../../application/model/evolution/scoped-software-adoption.ts";
import { parseScopedSoftwareDossier } from "../../../application/model/evolution/scoped-software-dossier.ts";
import {
  buildScopedSoftwareWriteDossier,
  scopedSoftwareWriteCommandDigest,
} from "../../../application/model/publication/scoped-software-write.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";
import { recipeDigest } from "../../../domain/model/value-objects/build.ts";
import type { NativeEvolutionRepository } from "./repository.ts";
import type { GitModelRepository } from "../../out/git/repository.ts";
import type { QueuedModelWriter } from "../../../application/model/publication/queued-writer.ts";
import type { PostgresRequestSourceAdmissionStore } from "../../out/postgres/request-source-admission-store.ts";
import type { PrismaClient } from "../../out/postgres/client.ts";
import type { OpeningRecord } from "../../../domain/work/request-spaces.ts";

/** Resolve historical reads from the dossier, never from the current factory's
 * newer source head. The returned surface must not stage new Git effects. */
export function scopedEvolutionHistoricalSource(
  repository: Pick<GitModelRepository, "scopedSoftwarePreparationRepository">,
  scope: ScopedSoftwareContextV2,
) {
  return repository.scopedSoftwarePreparationRepository({
    scope,
    assertCurrent: () =>
      Promise.reject(
        new EvolutionError(
          "EVOLUTION_SOURCE_CHANGED",
          "Historical source is read-only",
        ),
      ),
  });
}

/** The scoped Request writer never routes its command through the Main writer
 * or human admission. Source assessment and scoped signature remain distinct. */
export class ScopedEvolutionRepository
  implements EvolutionRepositoryPort<ScopedSoftwareEvolutionDossierV2> {
  constructor(
    readonly options: {
      preparation: Pick<ScopedEvolutionPreparation, "prepare">;
      source: NativeEvolutionRepository;
      sourceRepository: ReturnType<
        GitModelRepository["scopedSoftwarePreparationRepository"]
      >;
      repository: GitModelRepository;
      writer: QueuedModelWriter;
      journal: PostgresRequestSourceAdmissionStore;
      client: PrismaClient;
      opening: OpeningRecord;
    },
  ) {}
  prepare(input: EvolutionPreparationInput) {
    return this.options.preparation.prepare(input);
  }
  /** A resumed dossier keeps its original exact source scope even when the
   * current Request has since advanced. This surface is read-only here. */
  private sourceFor(d: ScopedSoftwareEvolutionDossierV2) {
    return scopedEvolutionHistoricalSource(this.options.repository, d.scope);
  }
  private async command(value: ScopedSoftwareEvolutionDossierV2) {
    const d = await parseScopedSoftwareDossier(value);
    const source = this.sourceFor(d),
      record = await source.proposal(d.proposal.id);
    await scopedEvolutionSourceOperations(source, d);
    if (
      record.baseVersion !== d.proposal.baseVersion ||
      record.proposalVersion !== d.proposal.version ||
      record.sourceDigest !== d.proposal.sourceDigest
    ) {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "The exact scoped proposal changed",
      );
    }
    const operations = {
      kind: "whole-files" as const,
      files: {
        v: 1 as const,
        base: d.scope.destination.expectedAdmittedSource.source,
        baseSourceDigest:
          d.scope.destination.expectedAdmittedSource.sourceDigest,
        files: await Promise.all(
          record.diff.map(async (entry) => ({
            path: entry.path,
            baseDigest: entry.before === undefined
              ? null
              : await sha256(entry.before),
            text: entry.after ?? null,
          })),
        ),
      },
    };
    return await buildScopedSoftwareWriteDossier({ evolution: d, operations });
  }
  async revalidate(value: ScopedSoftwareEvolutionDossierV2): Promise<void> {
    const d = await parseScopedSoftwareDossier(value),
      source = this.sourceFor(d),
      record = await source.proposal(d.proposal.id);
    await scopedEvolutionSourceOperations(source, d);
    const before = await source.current();
    if (
      before.version !== d.proposal.baseVersion ||
      before.sourceDigest !==
        d.scope.destination.expectedAdmittedSource.sourceDigest ||
      record.status !== "proposed"
    ) {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "The scoped Request source changed",
      );
    }
    const recipe = await recipeDigest(
      await this.options.source.options.compiler.recipe(),
    );
    const after = await source.at(d.proposal.version);
    const authorization = record.authorization;
    if (
      !authorization || authorization.kind !== "operator-evolution" ||
      recipe !== d.proposal.recipeDigest
    ) {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "The scoped preparation recipe changed",
      );
    }
    const assessed = await this.options.source.options.assess
      .authorizePreparation({
        before,
        after,
        actorId: d.preparation.operatorNativeId,
        recipeDigest: recipe,
        ...(authorization.typedEdits
          ? { typedEdits: authorization.typedEdits }
          : {}),
      });
    if (
      assessed.digest !== d.scopedProposal.sourceAssessmentDigest ||
      canonical(assessed.authorization) !== canonical(authorization) ||
      assessed.categories.some((category) =>
        !d.proposal.categories.includes(category)
      ) ||
      assessed.targets.length !== d.proposal.targets.length ||
      assessed.targets.some((target) =>
        !d.proposal.targets.some((t) =>
          t.operatorId === target.operatorId &&
          t.candidateDigest === target.candidateDigest
        )
      )
    ) {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "The exact source assessment changed",
      );
    }
    const build = await source.descriptorAt?.(d.proposal.version);
    if (!build || canonical(build) !== canonical(d.proposal.build)) {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "The scoped build changed",
      );
    }
  }
  private async settled(
    d: ScopedSoftwareEvolutionDossierV2,
    version: string,
    commandDigest: string,
  ): Promise<ScopedSoftwarePublicationV2> {
    const chain = await this.options.client.$transaction(
      (tx) => this.options.journal.readAdmittedSource(tx, this.options.opening),
      { isolationLevel: "RepeatableRead" },
    );
    const receipt = chain.softwareReceipts.find((entry) =>
      entry.payload.command.commandId === d.proposal.id &&
      entry.payload.result.source.version === version
    );
    if (
      !receipt || receipt.payload.commandDigest !== commandDigest ||
      receipt.payload.evolutionDossierId !== d.id ||
      receipt.payload.evolutionIntentDigest !== d.intentDigest ||
      receipt.payload.proposalDigest !== d.proposal.digest ||
      receipt.payload.result.sourceDigest !== d.proposal.sourceDigest
    ) {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "Exact software source admission is unavailable",
      );
    }
    await this.options.repository.verifyScopedSoftwareSourceAdmission(
      receipt.payload,
    );
    return {
      commandId: d.proposal.id,
      commandDigest,
      version,
      sourceDigest: receipt.payload.result.sourceDigest,
      proposalDigest: d.proposal.digest,
      sourceAdmission: {
        revision: receipt.revision,
        manifestDigest: receipt.manifestDigest,
      },
    };
  }
  async findPublication(
    value: ScopedSoftwareEvolutionDossierV2,
  ): Promise<ScopedSoftwarePublicationV2 | null> {
    const d = await parseScopedSoftwareDossier(value);
    if (d.status !== "publishing") return null;
    const command = await this.command(d),
      entry = await this.options.writer.queue.get(
        d.repositoryId,
        command.command.commandId,
      );
    if (!entry) return null;
    assertScopedPublicationSettled(command.command.commandId, entry);
    const version = await this.options.writer.resume(
      command.command.commandId,
      undefined,
      d.scope.destination,
    );
    if (!version || version.version !== entry.publishedVersion) {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "Software publication recovery differs",
      );
    }
    return await this.settled(
      d,
      version.version,
      await scopedSoftwareWriteCommandDigest(command.command),
    );
  }
  async publish(
    value: ScopedSoftwareEvolutionDossierV2,
  ): Promise<ScopedSoftwarePublicationV2> {
    const d = await parseScopedSoftwareDossier(value);
    if (d.status !== "publishing") {
      throw new EvolutionError(
        "EVOLUTION_SOURCE_CHANGED",
        "Software publication requires finalization",
      );
    }
    const command = await this.command(d),
      result = await this.options.writer.publish(command);
    return await this.settled(
      d,
      result.version,
      await scopedSoftwareWriteCommandDigest(command.command),
    );
  }
}
