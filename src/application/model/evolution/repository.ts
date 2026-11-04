import type { ModelToolingPort } from "../tooling.ts";
import type { ModelEditRequest } from "../../../domain/model/editing/tooling.ts";
import { resolveModelEdits } from "../../../domain/model/editing/source-index.ts";
import { assertSourceSplices } from "../editing/host-writer.ts";
import type {
  EvolutionDossier,
  EvolutionPreparationInput,
  EvolutionProposal,
  EvolutionPublication,
  EvolutionRepositoryPort,
  EvolutionTarget,
} from "./ports.ts";
import { EvolutionError } from "./ports.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import type { ModelCompiler } from "../builds/ports/out/model-compiler.port.ts";
import type {
  EvolutionCategory,
  EvolutionProposalAuthorization,
} from "../../../domain/model/evolution/policy.ts";
import type { CompiledModel } from "../../../domain/model/records/compiled-model.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../domain/model/records/revision.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { recipeDigest } from "../../../domain/model/value-objects/build.ts";
import { buildAcceptProposalCommand } from "../publication/write-queue.ts";
import { modelWriteCommandDigest } from "../../../domain/model/editing/write-command.ts";

/** Trusted semantic assessment: ordinary file/root grants intersect native
 * evolution grants, with every compiled consumer and unclassified fact checked.
 * This port is supplied by host composition, never by request JSON. */
export interface EvolutionSourceAssessmentPort {
  authorizePreparation(input: {
    before: ModelRevision;
    after: CompiledModel;
    actorId: string;
    recipeDigest: string;
    typedEdits?: ModelEditRequest;
  }): Promise<{
    authorization: EvolutionProposalAuthorization;
    targets: EvolutionTarget[];
    categories: EvolutionCategory[];
    digest: string;
  }>;
}

function requireExact(value: unknown, message: string): asserts value {
  if (!value) throw new EvolutionError("EVOLUTION_SOURCE_CHANGED", message);
}

/** Staging uses the existing proposal branch. Admission happens exclusively
 * through the queued repository.accept surface after the lifecycle checkpoint. */
export class NativeEvolutionRepository implements EvolutionRepositoryPort {
  constructor(
    readonly options: {
      repositoryId: string;
      repository: Pick<
        ModelRepositoryPort,
        | "current"
        | "at"
        | "header"
        | "propose"
        | "proposal"
        | "accept"
        | "descriptorAt"
        | "findPublicationByCommand"
      >;
      compiler: ModelCompiler;
      tooling?: Pick<ModelToolingPort, "edit">;
      assess: EvolutionSourceAssessmentPort;
    },
  ) {}

  async prepare(input: EvolutionPreparationInput): Promise<EvolutionProposal> {
    requireExact(
      input.repositoryId === this.options.repositoryId,
      "Evolution repository differs",
    );
    const before = await this.options.repository.current();
    requireExact(
      before.version === input.expectedVersion,
      "Evolution base changed before staging",
    );
    requireExact(
      Boolean(input.edit) !== Boolean(input.sources),
      "Choose targeted edits or an explicit source replacement",
    );
    let sources: Record<string, string>;
    let typedEdits: ModelEditRequest | undefined;
    if (input.edit) {
      typedEdits = structuredClone(input.edit);
      requireExact(
        typedEdits.baseVersion === before.version &&
          typedEdits.sourceDigest === before.sourceDigest,
        "Targeted evolution edits differ from the consulted exact base",
      );
      requireExact(
        this.options.tooling,
        "Targeted evolution requires native editing tooling",
      );
      const resolved = resolveModelEdits(before, typedEdits.edits);
      const result = await this.options.tooling.edit(before.sources, resolved);
      assertSourceSplices(before.sources, result, {
        opIndex: -1,
        op: "proposeEdit",
        target: { qualifiedName: "evolution" },
      });
      sources = result.sources;
    } else {
      sources = structuredClone(input.sources!);
    }
    const after = await this.options.compiler.compile(sources);
    const recipe = await recipeDigest(await this.options.compiler.recipe());
    const assessed = await this.options.assess.authorizePreparation({
      before,
      after,
      actorId: input.actorId,
      recipeDigest: recipe,
      ...(typedEdits ? { typedEdits } : {}),
    });
    requireExact(
      assessed.authorization.exercise.act === "prepare" &&
        assessed.authorization.exercise.proposalDigest === assessed.digest,
      "Preparation assessment is not bound to this proposal",
    );
    const record = await this.options.repository.propose({
      baseVersion: before.version,
      sources,
      author: `agent:${assessed.authorization.operatorNativeId}`,
      reason: input.reason,
      ...(typedEdits?.addresses ? { addresses: typedEdits.addresses } : {}),
      authorization: assessed.authorization,
    });
    requireExact(
      record.status === "proposed" && record.proposalVersion &&
        record.sourceDigest === after.sourceDigest,
      "Staged proposal differs from assessed sources",
    );
    const build = await this.options.repository.descriptorAt?.(
      record.proposalVersion,
    );
    requireExact(
      build && build.sourceDigest === record.sourceDigest &&
        build.recipe.digest === recipe,
      "Evolution requires an exact stored build descriptor",
    );
    return {
      id: record.id,
      version: record.proposalVersion,
      baseVersion: record.baseVersion,
      sourceDigest: record.sourceDigest,
      recipeDigest: recipe,
      digest: assessed.digest,
      targets: structuredClone(assessed.targets),
      categories: [...assessed.categories],
      build,
    };
  }

  async #record(dossier: EvolutionDossier): Promise<ProposalRecord> {
    requireExact(
      dossier.repositoryId === this.options.repositoryId,
      "Evolution repository differs",
    );
    const record = await this.options.repository.proposal(dossier.proposal.id);
    requireExact(
      record.proposalVersion === dossier.proposal.version &&
        record.baseVersion === dossier.proposal.baseVersion &&
        record.sourceDigest === dossier.proposal.sourceDigest &&
        record.authorization?.kind === "operator-evolution" &&
        record.authorization.exercise.proposalDigest ===
          dossier.proposal.digest,
      "Evolution proposal identity changed",
    );
    return record;
  }

  async revalidate(dossier: EvolutionDossier): Promise<void> {
    const record = await this.#record(dossier);
    requireExact(
      record.status === "proposed",
      "Evolution proposal is no longer available",
    );
    const before = await this.options.repository.current();
    requireExact(
      before.version === dossier.proposal.baseVersion,
      "Evolution cannot rebase its approved source revision",
    );
    const recipe = await recipeDigest(await this.options.compiler.recipe());
    requireExact(
      recipe === dossier.proposal.recipeDigest,
      "Evolution compiler recipe changed",
    );
    const after = await this.options.repository.at(dossier.proposal.version);
    const assessed = await this.options.assess.authorizePreparation({
      before,
      after,
      actorId: dossier.preparation.operatorNativeId,
      recipeDigest: recipe,
      ...(record.authorization?.kind === "operator-evolution" &&
          record.authorization.typedEdits
        ? { typedEdits: record.authorization.typedEdits }
        : {}),
    });
    requireExact(
      assessed.digest === dossier.proposal.digest &&
        canonical(assessed.authorization) === canonical(record.authorization) &&
        canonical(assessed.targets) === canonical(dossier.proposal.targets) &&
        canonical(assessed.categories) ===
          canonical(dossier.proposal.categories),
      "Evolution semantic assessment changed",
    );
    const build = await this.options.repository.descriptorAt?.(
      dossier.proposal.version,
    );
    requireExact(
      build && canonical(build) === canonical(dossier.proposal.build),
      "Evolution build identity changed",
    );
  }

  async #command(dossier: EvolutionDossier, record: ProposalRecord) {
    requireExact(
      dossier.acceptance && dossier.acceptance.act === "accept" &&
        dossier.acceptance.proposalDigest === dossier.proposal.digest,
      "Evolution needs its separate exact acceptance receipt",
    );
    const base = await this.options.repository.header(
      dossier.proposal.baseVersion,
    );
    return await buildAcceptProposalCommand({
      repositoryId: this.options.repositoryId,
      // The durable acceptance journal may have advanced to accepting/accepted.
      // Reconstruct only the original frozen command, never a new approval.
      proposal: { ...record, status: "proposed" },
      expectedVersion: dossier.proposal.baseVersion,
      author: `agent:${dossier.acceptance.operatorNativeId}`,
      baseSourceDigest: base.sourceDigest,
      recipeDigest: dossier.proposal.recipeDigest,
      evolutionDecision: dossier.acceptance,
    });
  }

  async findPublication(
    dossier: EvolutionDossier,
  ): Promise<EvolutionPublication | null> {
    const record = await this.#record(dossier);
    const lookup = this.options.repository.findPublicationByCommand;
    requireExact(lookup, "Evolution requires durable command anchors");
    const anchored = await lookup.call(
      this.options.repository,
      dossier.proposal.id,
    );
    if (!anchored) {
      // An interrupted Git acceptance is not proof of absence. The existing
      // writer recovers under a fresh lease before this can become cancellable.
      requireExact(
        record.status === "proposed" || record.status === "rejected",
        "Evolution publication outcome remains uncertain",
      );
      return null;
    }
    const command = await this.#command(dossier, record);
    const digest = await modelWriteCommandDigest(command.command);
    requireExact(
      anchored.commandDigest === digest &&
        anchored.revision.sourceDigest === dossier.proposal.sourceDigest,
      "Evolution publication anchor differs from its exact frozen command",
    );
    return {
      commandId: dossier.proposal.id,
      commandDigest: digest,
      version: anchored.revision.version,
      sourceDigest: anchored.revision.sourceDigest,
      proposalDigest: dossier.proposal.digest,
    };
  }

  async publish(dossier: EvolutionDossier): Promise<EvolutionPublication> {
    const found = await this.findPublication(dossier);
    if (found) return found;
    requireExact(
      dossier.status === "publishing",
      "Evolution can publish only at its finalization checkpoint",
    );
    await this.revalidate(dossier);
    const record = await this.#record(dossier);
    const command = await this.#command(dossier, record);
    const decision = command.decision;
    requireExact(
      decision.kind === "accept-proposal",
      "Evolution command kind differs",
    );
    await this.options.repository.accept({
      id: record.id,
      expectedVersion: dossier.proposal.baseVersion,
      author: decision.author,
      evolutionDecision: dossier.acceptance,
    });
    const publication = await this.findPublication(dossier);
    requireExact(
      publication,
      "Evolution admission has no exact durable command anchor",
    );
    return publication;
  }
}
