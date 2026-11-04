/** Native semantic assessment used by staging and independently by admission. */
import type { SourceEvolutionCompilationPort } from "../source-compilation.ts";
import type { EvolutionSourceAssessmentPort } from "./repository.ts";
import type { EvolutionProposal } from "./ports.ts";
import type { ModelRevision } from "../../../domain/model/records/revision.ts";
import type { CompiledModel } from "../../../domain/model/records/compiled-model.ts";
import {
  classifyEvolutionEffects,
  type EvolutionEffect,
  type ScopedExecutableModel,
} from "../../../domain/model/evolution/semantic-effects.ts";
import { evolutionProposalDigest } from "../../../domain/model/evolution/proposal-digest.ts";
import { requireEvolution } from "../../../domain/model/evolution/policy.ts";
import { assertModelEditScope } from "../../../domain/model/editing/scope.ts";
import { MODEL_DELEGATIONS_FILE } from "../../../domain/governance/policies/model-delegation-ledger.ts";
import { createOperatorEditAuthorization } from "../../governance/model-access/operator-edit-authorization.ts";
import {
  createEvolutionAuthorityExercise,
  requireEvolutionEffectBounds,
} from "../../../domain/model/evolution/authorization.ts";

export interface EvolutionSettingsAssessment {
  before: ScopedExecutableModel[];
  after: ScopedExecutableModel[];
  effects: EvolutionEffect[];
  proposal?: EvolutionProposal;
}
export function needsEvolutionSettingsPreflight(
  input: EvolutionSettingsAssessment,
): boolean {
  return input.effects.some((effect) =>
    ["budgets", "context", "memory", "contracts"].includes(effect.category) ||
    !!input.after.find((scope) =>
      scope.model.identity.builderId === effect.targetNativeId
    )?.model.contextPolicy
  );
}
export async function compileEvolutionAssessment(
  input: {
    before: ModelRevision;
    after: CompiledModel;
    projectId: string;
    recipeDigest: string;
  },
  compilation: SourceEvolutionCompilationPort,
) {
  const before = await compilation.compile(
    input.before,
    input.projectId,
  );
  const after = await compilation.compile({
    ...input.after,
    version: "unpublished-evolution-assessment",
  }, input.projectId);
  const effects = classifyEvolutionEffects(before, after);
  requireEvolution(
    effects.length > 0,
    "Evolution proposal has no classified executable effect",
  );
  const targetIds = [...new Set(effects.map((effect) => effect.targetNativeId))]
    .sort();
  const targets = targetIds.map((operatorId) => ({
    operatorId,
    previousDigest:
      before.find((scope) => scope.model.identity.builderId === operatorId)!
        .model.version.digest,
    candidateDigest:
      after.find((scope) => scope.model.identity.builderId === operatorId)!
        .model.version.digest,
  }));
  const categories = [...new Set(effects.map((effect) => effect.category))]
    .sort();
  const digest = await evolutionProposalDigest({
    ...input,
    targets,
    categories,
  });
  return { before, after, effects, targets, categories, digest };
}
export class NativeEvolutionSourceAssessment
  implements EvolutionSourceAssessmentPort {
  constructor(
    readonly options: {
      projectId: string;
      compilation: SourceEvolutionCompilationPort;
      /** Scoped composition supplies the actual prior admitted actor. */
      admittedActor?(
        operatorId: string,
      ): Promise<
        import("../../../domain/model/execution/executable-model.ts").ExecutableModel
      >;
      /** Runtime-owned preflight; required for settings that depend on durable state. */
      validateSettings?: (input: EvolutionSettingsAssessment) => Promise<void>;
    },
  ) {}
  async authorizePreparation(
    input: Parameters<EvolutionSourceAssessmentPort["authorizePreparation"]>[0],
  ): ReturnType<EvolutionSourceAssessmentPort["authorizePreparation"]> {
    const assessment = await compileEvolutionAssessment({
      ...input,
      projectId: this.options.projectId,
    }, this.options.compilation);
    const actor = assessment.before.find((scope) =>
      scope.model.identity.builderId === input.actorId
    );
    requireEvolution(
      actor,
      "Evolution preparer is not an admitted native operator",
    );
    const actorModel = this.options.admittedActor
      ? await this.options.admittedActor(input.actorId)
      : actor.model;
    requireEvolution(
      actorModel.identity.builderId === input.actorId,
      "The actual preparation actor differs",
    );
    const operations = input.typedEdits
      ? [...new Set(input.typedEdits.edits.map((edit) => edit.kind))].sort()
      : ["replace-source" as const];
    if (input.typedEdits) {
      requireEvolution(
        input.typedEdits.baseVersion === input.before.version &&
          input.typedEdits.sourceDigest === input.before.sourceDigest,
        "Evolution typed source preimage changed",
      );
    }
    const editAuthorization = await createOperatorEditAuthorization(
      actorModel,
      input.before,
      operations,
    );
    requireEvolution(
      input.before.sources[MODEL_DELEGATIONS_FILE] ===
        input.after.sources[MODEL_DELEGATIONS_FILE],
      "Evolution cannot change the delegation ledger",
    );
    assertModelEditScope(
      input.before,
      input.after,
      actorModel.modelEditPolicy!.grants,
    );
    requireEvolutionEffectBounds(
      actorModel,
      "prepare",
      assessment.effects,
      assessment.before,
      assessment.after,
    );
    if (needsEvolutionSettingsPreflight(assessment)) {
      requireEvolution(
        this.options.validateSettings,
        "Evolution settings require runtime preflight before preparation",
      );
    }
    await this.options.validateSettings?.(assessment);
    const exercise = await createEvolutionAuthorityExercise(actorModel, {
      act: "prepare",
      systemQualifiedName: actor.systemQualifiedName,
      targets: assessment.targets.map((target) => target.operatorId),
      categories: assessment.categories,
      proposalDigest: assessment.digest,
      effects: assessment.effects,
    });
    return {
      authorization: {
        kind: "operator-evolution",
        systemQualifiedName: actor.systemQualifiedName,
        operatorNativeId: input.actorId,
        editAuthorization,
        exercise,
        recipeDigest: input.recipeDigest,
        ...(input.typedEdits
          ? { typedEdits: structuredClone(input.typedEdits) }
          : {}),
      },
      targets: assessment.targets,
      categories: assessment.categories,
      digest: assessment.digest,
    };
  }
}
