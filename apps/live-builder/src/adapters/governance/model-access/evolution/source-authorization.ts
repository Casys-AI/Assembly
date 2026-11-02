import type { ModelSourceAuthorizationPort } from "../../../../application/governance/ports/out/model-source-authorization.port.ts";
import type { ModelToolingPort } from "../../../../application/model/tooling.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";
import { requireEvolution } from "../../../../domain/model/evolution/policy.ts";
import { compileEvolutionAssessment } from "../../../model/evolution/assessment.ts";
import { createOperatorEditAuthorization } from "../source-authorization.ts";
import { assertModelEditScope } from "../editing/scope.ts";
import { MODEL_DELEGATIONS_FILE } from "../delegation/ledger.ts";
import {
  requireEvolutionEffectBounds,
  revalidateEvolutionAuthorityExercise,
} from "../../../../domain/model/evolution/authorization.ts";
import { resolveModelEdits } from "../../../model/sources/editing/tooling.ts";
import { assertSourceSplices } from "../../../model/sources/editing/host-writer.ts";

/** This branch never weakens the ordinary ModelEditPolicy digest equality. */
export async function validateEvolutionSourceAuthorization(
  input: Parameters<ModelSourceAuthorizationPort["validate"]>[0],
  projectId: string,
  tooling?: ModelToolingPort,
  scopedActor?:
    import("../../../../domain/model/execution/executable-model.ts").ExecutableModel,
): Promise<void> {
  const principal = input.authorization;
  requireEvolution(
    principal?.kind === "operator-evolution",
    "Missing separate evolution source authority",
  );
  requireEvolution(
    input.author === `agent:${principal.operatorNativeId}` &&
      principal.exercise.act === "prepare" &&
      principal.exercise.operatorNativeId === principal.operatorNativeId &&
      principal.exercise.systemQualifiedName === principal.systemQualifiedName,
    "Evolution source principal mismatch",
  );
  requireEvolution(
    input.before.version === input.authority.version,
    "Evolution cannot rebase or reuse stale source authority",
  );
  if (principal.typedEdits) {
    const request = principal.typedEdits;
    requireEvolution(
      tooling && request.baseVersion === input.before.version &&
        request.sourceDigest === input.before.sourceDigest &&
        request.edits.length > 0,
      "Evolution typed edit preimage or tooling unavailable",
    );
    const operations = [...new Set(request.edits.map((edit) => edit.kind))]
      .sort();
    requireEvolution(
      canonical(operations) ===
        canonical(principal.editAuthorization.operations),
      "Evolution typed edits differ from their operation authority",
    );
    const replayed = await tooling.edit(
      input.before.sources,
      resolveModelEdits(input.before, request.edits),
    );
    assertSourceSplices(input.before.sources, replayed, {
      opIndex: -1,
      op: "proposeEdit",
      target: { qualifiedName: principal.systemQualifiedName },
    });
    requireEvolution(
      canonical(replayed.sources) === canonical(input.after.sources),
      "Evolution typed edits do not reproduce the complete candidate sources",
    );
  } else {
    requireEvolution(
      canonical(principal.editAuthorization.operations) ===
        canonical(["replace-source"]),
      "Raw evolution sources require explicit whole-source operation authority",
    );
  }
  const assessment = await compileEvolutionAssessment({
    before: input.before,
    after: input.after,
    projectId,
    recipeDigest: principal.recipeDigest,
  });
  requireEvolution(
    assessment.digest === principal.exercise.proposalDigest,
    "Evolution proposal differs from its exact preparation receipt",
  );
  const actor = assessment.before.find((scope) =>
    scope.model.identity.builderId === principal.operatorNativeId &&
    scope.systemQualifiedName === principal.systemQualifiedName
  );
  requireEvolution(actor, "Evolution preparer no longer exists");
  const authorityModel = scopedActor ?? actor.model;
  requireEvolution(
    authorityModel.identity.builderId === principal.operatorNativeId,
    "Scoped evolution actor differs",
  );
  const edit = await createOperatorEditAuthorization(
    authorityModel,
    input.authority,
    principal.editAuthorization.operations,
  );
  requireEvolution(
    canonical(edit) === canonical(principal.editAuthorization),
    "Evolution file/root editing authority changed",
  );
  requireEvolution(
    input.before.sources[MODEL_DELEGATIONS_FILE] ===
      input.after.sources[MODEL_DELEGATIONS_FILE],
    "Evolution cannot edit delegation authority",
  );
  assertModelEditScope(
    input.before,
    input.after,
    authorityModel.modelEditPolicy!.grants,
  );
  await revalidateEvolutionAuthorityExercise(
    authorityModel,
    principal.exercise,
    assessment.effects,
  );
  requireEvolutionEffectBounds(
    authorityModel,
    "prepare",
    assessment.effects,
    assessment.before,
    assessment.after,
  );
  if (input.phase !== "proposal") {
    const decision = input.evolutionDecision;
    requireEvolution(
      decision?.act === "accept" &&
        decision.proposalDigest === assessment.digest &&
        canonical(decision.targets) === canonical(principal.exercise.targets) &&
        canonical(decision.categories) ===
          canonical(principal.exercise.categories),
      "Evolution acceptance requires its independent exact receipt",
    );
    const decider = assessment.before.find((scope) =>
      scope.model.identity.builderId === decision.operatorNativeId &&
      scope.systemQualifiedName === decision.systemQualifiedName
    );
    requireEvolution(decider, "Evolution acceptance actor no longer exists");
    await revalidateEvolutionAuthorityExercise(
      decider.model,
      decision,
      assessment.effects,
    );
    requireEvolutionEffectBounds(
      decider.model,
      "accept",
      assessment.effects,
      assessment.before,
      assessment.after,
    );
  }
}
