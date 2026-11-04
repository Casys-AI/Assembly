import type { SourceEvolutionCompilationPort } from "../source-compilation.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  EvolutionAct,
  EvolutionAuthorityExercise,
} from "../../../domain/model/evolution/policy.ts";
import { requireEvolution } from "../../../domain/model/evolution/policy.ts";
import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import { classifyEvolutionEffects } from "../../../domain/model/evolution/semantic-effects.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import type { EvolutionAuthorityPort, EvolutionProposal } from "./ports.ts";
import type { ModelRepositoryPort } from "../repository.ts";
import {
  parseScopedSoftwareContext,
  type ScopedSoftwareContextV2,
} from "./scoped-software-context.ts";
import {
  parseScopedSoftwareProposal,
  scopedSoftwareProposalDigest,
} from "./scoped-software-proposal.ts";
import {
  createEvolutionAuthorityExercise,
  requireEvolutionEffectBounds,
} from "../../../domain/model/evolution/authorization.ts";
import {
  compileEvolutionAssessment,
  type EvolutionSettingsAssessment,
  needsEvolutionSettingsPreflight,
} from "./assessment.ts";

/** Per-Request immutable composition. Native policy comes from the actual
 * admitted actor, never current Main/source HEAD or the candidate's grants. */
export class ScopedNativeEvolutionAuthority implements EvolutionAuthorityPort {
  readonly scope: ScopedSoftwareContextV2;
  constructor(
    readonly options: {
      scope: ScopedSoftwareContextV2;
      compilation: SourceEvolutionCompilationPort;
      repository: Pick<ModelRepositoryPort, "at">;
      readActor(): Promise<ExecutableModel>;
      readTarget(operatorId: string): Promise<{ model: ExecutableModel }>;
      validateSettings?(input: EvolutionSettingsAssessment): Promise<void>;
    },
  ) {
    this.scope = parseScopedSoftwareContext(options.scope);
  }
  async authorize(
    act: EvolutionAct,
    actorId: string,
    proposal: EvolutionProposal,
  ): Promise<EvolutionAuthorityExercise> {
    requireEvolution(
      actorId === this.scope.actor.operatorId && proposal.scoped,
      "Scoped authority requires the actual bound actor and signed preimage",
    );
    const scoped = parseScopedSoftwareProposal(proposal.scoped);
    const stable = (context: ScopedSoftwareContextV2) => {
      const { expectedAdmittedSource: _expected, ...destination } =
        context.destination;
      return {
        destination,
        actor: context.actor,
        openingBaseDigest: context.openingBaseDigest,
      };
    };
    requireEvolution(
      canonical(stable(scoped.context)) === canonical(stable(this.scope)) &&
        await scopedSoftwareProposalDigest(scoped) === proposal.digest,
      "Scoped authority destination changed",
    );
    const scope = scoped.context;
    const assessment = await compileEvolutionAssessment({
      before: await this.options.repository.at(proposal.baseVersion),
      after: await this.options.repository.at(proposal.version),
      projectId: `git:${scope.destination.repositoryId}`,
      recipeDigest: proposal.recipeDigest,
    }, this.options.compilation);
    requireEvolution(
      assessment.digest === scoped.sourceAssessmentDigest &&
        assessment.categories.every((category) =>
          scoped.categories.includes(category)
        ) &&
        canonical(
            assessment.targets.map((t) => ({
              operatorId: t.operatorId,
              candidateDigest: t.candidateDigest,
            })),
          ) ===
          canonical(
            proposal.targets.map((t) => ({
              operatorId: t.operatorId,
              candidateDigest: t.candidateDigest,
            })),
          ),
      "Scoped source assessment changed",
    );
    // Reconstruct the OLD executable evidence from each retained execution pin.
    // Current admitted source can legitimately have advanced beyond that pin.
    const before: ScopedExecutableModel[] = [...assessment.before];
    for (const entry of scope.targets) {
      const old = await this.options.compilation.compile(
        await this.options.repository.at(entry.previousPin.source.version),
        `git:${scope.destination.repositoryId}`,
      );
      const exact = old.filter((s) =>
        s.model.identity.builderId === entry.target.operatorId
      );
      requireEvolution(
        exact.length === 1 &&
          exact[0].model.version.digest === entry.previousPin.modelDigest,
        "Previous scoped executable evidence changed",
      );
      const actual = await this.options.readTarget(entry.target.operatorId);
      const candidate = proposal.targets.find((t) =>
        t.operatorId === entry.target.operatorId
      );
      requireEvolution(
        candidate &&
          actual.model.identity.builderId === entry.target.operatorId &&
          (actual.model.version.digest === entry.previousPin.modelDigest ||
            actual.model.version.digest === candidate.candidateDigest),
        "Scoped target has another admitted runtime",
      );
      const index = before.findIndex((s) =>
        s.model.identity.builderId === entry.target.operatorId
      );
      requireEvolution(
        index >= 0,
        "Scoped target has no native source occurrence",
      );
      before[index] = exact[0];
    }
    const runtimeEffects = classifyEvolutionEffects(before, assessment.after);
    const effects = [
      ...new Map(
        [...assessment.effects, ...runtimeEffects].map((
          effect,
        ) => [canonical([effect.targetNativeId, effect.category]), effect]),
      ).values(),
    ];
    requireEvolution(
      canonical([...new Set(effects.map((e) => e.targetNativeId))].sort()) ===
          canonical(proposal.targets.map((t) => t.operatorId).sort()) &&
        canonical([...new Set(effects.map((e) => e.category))].sort()) ===
          canonical([...proposal.categories].sort()),
      "Runtime delta exceeds the signed target/category set",
    );
    const actor = await this.options.readActor();
    requireEvolution(
      actor.identity.builderId === actorId,
      "Scoped actor admission changed",
    );
    const actorScopes = await this.options.compilation.compile(
      await this.options.repository.at(actor.version.repositoryVersion!),
      `git:${scope.destination.repositoryId}`,
    );
    const actorScope = actorScopes.filter((s) =>
      s.model.identity.builderId === actorId &&
      s.model.version.digest === actor.version.digest
    );
    requireEvolution(
      actorScope.length === 1,
      "Scoped actor has no retained exact authority source",
    );
    requireEvolutionEffectBounds(
      actor,
      act,
      assessment.effects,
      assessment.before,
      assessment.after,
    );
    requireEvolutionEffectBounds(
      actor,
      act,
      runtimeEffects,
      before,
      assessment.after,
    );
    const settings = { before, after: assessment.after, effects, proposal };
    if (needsEvolutionSettingsPreflight(settings)) {
      requireEvolution(
        this.options.validateSettings,
        "Scoped settings require actual durable runtime preflight",
      );
    }
    await this.options.validateSettings?.(settings);
    return await createEvolutionAuthorityExercise(actor, {
      act,
      systemQualifiedName: actorScope[0].systemQualifiedName,
      targets: proposal.targets.map((t) => t.operatorId),
      categories: proposal.categories,
      proposalDigest: proposal.digest,
      effects,
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
      "Scoped evolution authority was revoked or changed",
    );
  }
}
