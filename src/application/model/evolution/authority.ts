import type { SourceEvolutionCompilationPort } from "../source-compilation.ts";
import type { EvolutionAuthorityPort, EvolutionProposal } from "./ports.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import type {
  EvolutionAct,
  EvolutionAuthorityExercise,
} from "../../../domain/model/evolution/policy.ts";
import { requireEvolution } from "../../../domain/model/evolution/policy.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  createEvolutionAuthorityExercise,
  requireEvolutionEffectBounds,
} from "../../../domain/model/evolution/authorization.ts";
import {
  compileEvolutionAssessment,
  type EvolutionSettingsAssessment,
  needsEvolutionSettingsPreflight,
} from "./assessment.ts";

/** All operator levels use the same source-owned grants, including self-targets. */
export class NativeEvolutionAuthority implements EvolutionAuthorityPort {
  constructor(
    readonly options: {
      projectId: string;
      compilation: SourceEvolutionCompilationPort;
      repository: Pick<ModelRepositoryPort, "current" | "at">;
      validateSettings?: (input: EvolutionSettingsAssessment) => Promise<void>;
    },
  ) {}
  async authorize(
    act: EvolutionAct,
    actorId: string,
    proposal: EvolutionProposal,
  ): Promise<EvolutionAuthorityExercise> {
    const before = await this.options.repository.at(proposal.baseVersion);
    const after = await this.options.repository.at(proposal.version);
    const assessment = await compileEvolutionAssessment({
      before,
      after,
      projectId: this.options.projectId,
      recipeDigest: proposal.recipeDigest,
    }, this.options.compilation);
    requireEvolution(
      assessment.digest === proposal.digest &&
        canonical(assessment.targets) === canonical(proposal.targets) &&
        canonical(assessment.categories) === canonical(proposal.categories),
      "Evolution decision subject changed",
    );
    const current = await this.options.repository.current();
    const currentScopes = await this.options.compilation.compile(
      current,
      this.options.projectId,
    );
    const actor = currentScopes.find((scope) =>
      scope.model.identity.builderId === actorId
    );
    requireEvolution(
      actor,
      "Evolution decision actor is absent from current authority",
    );
    requireEvolutionEffectBounds(
      actor.model,
      act,
      assessment.effects,
      assessment.before,
      assessment.after,
    );
    if (needsEvolutionSettingsPreflight(assessment)) {
      requireEvolution(
        this.options.validateSettings,
        "Evolution settings require current runtime preflight",
      );
    }
    await this.options.validateSettings?.({ ...assessment, proposal });
    return await createEvolutionAuthorityExercise(actor.model, {
      act,
      systemQualifiedName: actor.systemQualifiedName,
      targets: proposal.targets.map((target) => target.operatorId),
      categories: proposal.categories,
      proposalDigest: proposal.digest,
      effects: assessment.effects,
    });
  }
  async revalidate(
    receipt: EvolutionAuthorityExercise,
    proposal: EvolutionProposal,
  ): Promise<void> {
    const expected = await this.authorize(
      receipt.act,
      receipt.operatorNativeId,
      proposal,
    );
    requireEvolution(
      canonical(expected) === canonical(receipt),
      "Evolution authority revoked, changed or applied to another proposal",
    );
  }
}
