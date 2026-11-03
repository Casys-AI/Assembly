/** Read-only restart/partial-adoption compatibility, backed by durable receipts. */
import type { WorkspaceEvolutionContext } from "../../work/operator-workspace.ts";
import type {
  EvolutionProposal,
  EvolutionStorePort,
} from "../../../application/model/evolution/ports.ts";
import { EvolutionError } from "../../../application/model/evolution/ports.ts";
import { assertEvolutionReceipt } from "../../../application/model/evolution/invariants.ts";
import { inspectEvolutionAdoption } from "../../../application/work/runtime/evolution.ts";
import {
  type BehaviorSettingsValidationTarget,
  validateBehaviorSettingsChange,
} from "../../../application/work/runtime/behavior-settings-validation.ts";
import type { EvolutionSettingsAssessment } from "./assessment.ts";
import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";

function requirePreflight(value: unknown, message: string): asserts value {
  if (!value) {
    throw new EvolutionError("EVOLUTION_SETTINGS_PIN_CHANGED", message);
  }
}

async function verifiedSettledTarget(input: {
  repositoryId: string;
  store: EvolutionStorePort;
  proposal: EvolutionProposal;
  before: ScopedExecutableModel;
  after: ScopedExecutableModel;
  target: BehaviorSettingsValidationTarget;
}): Promise<{ fullyAdopted: boolean }> {
  const id = input.target.operatorNativeId;
  const pin = input.target.snapshot.executionModel;
  const expected = input.proposal.targets.find((target) =>
    target.operatorId === id
  );
  requirePreflight(
    expected && pin && pin.identity.builderId === id &&
      expected.previousDigest === input.before.model.version.digest &&
      expected.candidateDigest === input.after.model.version.digest &&
      pin.version.digest === expected.candidateDigest,
    "Candidate runtime does not match the exact evolution target",
  );
  const events = input.target.snapshot.events.filter((event) => {
    const update = event.effectiveModelUpdate;
    return update?.dossierId && update.operatorId === id &&
      update.from.digest === expected.previousDigest &&
      update.from.repositoryVersion ===
        input.before.model.version.repositoryVersion &&
      update.to.digest === expected.candidateDigest &&
      update.to.repositoryVersion === pin.version.repositoryVersion;
  });
  requirePreflight(
    events.length > 0,
    "Candidate pin has no durable evolution activation evidence",
  );
  for (const event of events) {
    const update = event.effectiveModelUpdate!;
    // get(), rather than listPending(), also resolves a fully adopted dossier.
    const dossier = await input.store.get(update.dossierId!);
    if (
      !dossier || dossier.repositoryId !== input.repositoryId ||
      canonical(dossier.proposal) !== canonical(input.proposal)
    ) continue;
    const publication = dossier.publication;
    if (
      !publication || publication.proposalDigest !== input.proposal.digest ||
      publication.sourceDigest !== input.proposal.sourceDigest ||
      publication.version !== pin.version.repositoryVersion ||
      !publication.commandId || !publication.commandDigest ||
      !["published-awaiting-adoption", "adopted", "needs-decision"].includes(
        dossier.status,
      ) ||
      dossier.adoptionAuthorization?.operatorNativeId !== update.actorId
    ) continue;
    assertEvolutionReceipt(
      dossier.adoptionAuthorization!,
      "adopt",
      input.proposal,
    );
    const target = dossier.proposal.targets.find((target) =>
      target.operatorId === id
    );
    requirePreflight(
      target && canonical(target) === canonical(expected),
      "Dossier target identity changed after adoption",
    );
    const receipt = inspectEvolutionAdoption(
      input.target.snapshot,
      dossier,
      target,
      publication,
    );
    requirePreflight(
      receipt && receipt.operatorId === id &&
        receipt.previousDigest === expected.previousDigest &&
        receipt.candidateDigest === expected.candidateDigest &&
        receipt.version === publication.version &&
        receipt.proposalDigest === input.proposal.digest &&
        receipt.effectiveAt === update.activatedAt,
      "Runtime adoption receipt differs from its durable dossier/publication",
    );
    return { fullyAdopted: dossier.status === "adopted" };
  }
  throw new EvolutionError(
    "EVOLUTION_SETTINGS_PIN_CHANGED",
    "Candidate pin belongs to no matching durable evolution publication",
  );
}

/** Native grants are intentionally checked separately on every authority call. */
export function createEvolutionSettingsPreflight(options: {
  context: WorkspaceEvolutionContext;
  store: EvolutionStorePort;
  repositoryId: string;
}): (input: EvolutionSettingsAssessment) => Promise<void> {
  return async (input) => {
    const targets = await options.context.validationTargets(input.after);
    const settled = new Set<string>();
    let fullyAdopted = false;
    const previous = new Map(
      input.before.map((scope) => [scope.model.identity.builderId, scope]),
    );
    const next = new Map(
      input.after.map((scope) => [scope.model.identity.builderId, scope]),
    );
    const affected = [
      ...new Set(input.effects.map((effect) => effect.targetNativeId)),
    ];
    for (const id of affected) {
      const before = previous.get(id), after = next.get(id);
      const matches = targets.filter((target) =>
        target.operatorNativeId === id
      );
      requirePreflight(
        before && after && matches.length === 1,
        "Missing exact evolution settings runtime",
      );
      const target = matches[0]!, pin = target.snapshot.executionModel;
      requirePreflight(
        pin?.identity.builderId === id,
        "Runtime settings identity changed",
      );
      if (
        pin.version.digest === before.model.version.digest &&
        pin.version.repositoryVersion === before.model.version.repositoryVersion
      ) continue;
      requirePreflight(
        input.proposal && pin.version.digest === after.model.version.digest,
        "Runtime is neither the exact previous pin nor a receipted candidate",
      );
      const verified = await verifiedSettledTarget({
        ...options,
        proposal: input.proposal,
        before,
        after,
        target,
      });
      fullyAdopted ||= verified.fullyAdopted;
      settled.add(id);
    }
    requirePreflight(
      !fullyAdopted || settled.size === affected.length,
      "A closed adopted dossier has an unadopted runtime target",
    );
    // Preserve every model for remaining typed consumers and shared ledger owners.
    // Only the exact already-applied transition is removed from the preflight diff.
    const before = input.before.map((scope) =>
      settled.has(scope.model.identity.builderId)
        ? {
          ...next.get(scope.model.identity.builderId)!,
          model: structuredClone(
            targets.find((target) =>
              target.operatorNativeId === scope.model.identity.builderId
            )!.snapshot.executionModel!,
          ),
        }
        : scope
    );
    await validateBehaviorSettingsChange({
      before,
      after: input.after,
      effects: input.effects.filter((effect) =>
        !settled.has(effect.targetNativeId)
      ),
      affectedOperatorIds: affected,
      targets,
    });
  };
}
