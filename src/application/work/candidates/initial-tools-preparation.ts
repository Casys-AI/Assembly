/** Narrow host-owned initial preparation. No provider/DTO chooses its Case. */
import type {
  InitialToolsPreparationIntent,
  InitialToolsPreparationReference,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { executionDigest } from "../../../domain/primitives/execution-digest.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { hasActivationIntent } from "../../../domain/work/policies/candidate-activation.ts";
import { draftDigest } from "../runtime/values.ts";
import { nativeFlowContractDigest } from "../../../domain/model/execution/flow-contract.ts";
import { initialAdmissionTargetCaseDigest } from "../runtime/initial-admission-transfer.ts";
import { invocationKey } from "../operators/journal.ts";
import type { NativeExecutionIdentity } from "../native-execution/contract.ts";

export class InitialToolsPreparationRefused extends Error {
  readonly code = "INITIAL_TOOLS_PREPARATION_REFUSED";
  constructor(readonly reason: string) {
    super(`Initial tools preparation refused: ${reason}`);
    this.name = "InitialToolsPreparationRefused";
  }
}
function requirePreparation(value: unknown, reason: string): asserts value {
  if (!value) throw new InitialToolsPreparationRefused(reason);
}

export async function initialToolsSelectionPlan(
  state: SystemRuntimeState,
  model: ExecutableModel,
) {
  const selections = await Promise.all(
    (model.initialTools ?? []).map(async (seed) => {
      const selectionDigest = await draftDigest(seed.draft);
      const prior = state.candidates.filter((candidate) =>
        candidate.initialToolSeed?.id === seed.id
      );
      if (
        prior.length && (prior.length !== 1 ||
          prior[0].initialToolSeed!.selectionDigest !== selectionDigest ||
          await draftDigest(prior[0]) !== selectionDigest)
      ) {
        throw new Error(
          "La sélection initiale a changé ; révisez explicitement son candidat existant.",
        );
      }
      return { seed, selectionDigest, prior: prior[0] };
    }),
  );
  if (
    state.candidates.some((candidate) =>
      candidate.stage === "awaiting-admission" || hasActivationIntent(candidate)
    )
  ) return undefined;
  const pending = selections.find((selection) => !selection.prior);
  if (!pending) return undefined;
  if (
    state.candidates.some((candidate) =>
      candidate.name === pending.seed.draft.name
    )
  ) {
    throw new Error(
      "Un candidat du catalogue porte déjà ce nom ; la sélection initiale ne le remplace pas.",
    );
  }
  requirePreparation(model.version.repositoryVersion, "missing-source-version");
  // One selection owns one preparation Case. A later catalog decision may
  // unblock another selection even when a controlled port retains its pin.
  const key = `initial-tools:${await executionDigest({
    operatorId: model.identity.builderId,
    model: model.version,
    selections: model.initialTools,
    seedId: pending.seed.id,
  })}`;
  return {
    key,
    seed: structuredClone(pending.seed),
    selections: selections.map(({ seed, selectionDigest }) => ({
      id: seed.id,
      nativeId: seed.nativeId,
      selectionDigest,
    })),
    flowDigest: await nativeFlowContractDigest(model),
  };
}

export function initialToolsPreparationIdentity(
  intent: InitialToolsPreparationIntent,
): NativeExecutionIdentity {
  return {
    operatorId: intent.operatorId,
    invocationKey: invocationKey({ kind: "local", caseId: intent.caseId }),
    scope: {
      kind: "request",
      scopeId: intent.caseId,
      rootRequestId: intent.caseId,
    },
    purpose: "conversation",
    subjectId: intent.key,
  };
}

export async function verifyInitialToolsPreparation(
  state: SystemRuntimeState,
  reference: InitialToolsPreparationReference,
  identity?: NativeExecutionIdentity,
): Promise<InitialToolsPreparationIntent> {
  const intent = state.initialToolsPreparations?.[reference.key];
  requirePreparation(
    intent && intent.key === reference.key &&
      intent.revision === reference.revision &&
      state.id === intent.runtimeId &&
      state.executionModel?.identity.builderId === intent.operatorId &&
      state.executionModel.identity.projectId === intent.projectId &&
      state.executionModel.identity.systemId === intent.systemId,
    "missing-or-foreign-intent",
  );
  if (identity) {
    requirePreparation(
      canonical(identity) ===
        canonical(initialToolsPreparationIdentity(intent)),
      "delivery-scope",
    );
  }
  const record = state.cases?.find((item) => item.id === intent.caseId);
  requirePreparation(
    record && record.type === "request" &&
      record.openedFrom.origin === "initialization" &&
      record.owner === intent.operatorId &&
      await initialAdmissionTargetCaseDigest(record) === intent.caseBirthDigest,
    "preparation-case",
  );
  if (intent.phase === "terminal") {
    requirePreparation(
      intent.terminal && !isOpenCase(record) &&
        (intent.terminal.outcome !== "done" ||
          intent.terminal.candidateIds.length === 1) &&
        record.status ===
          (intent.terminal.outcome === "done"
            ? "closed-done"
            : "closed-abandoned") &&
        record.closedAt === intent.terminal.closedAt &&
        intent.terminal.candidateIds.every((id) =>
          state.candidates.some((candidate) =>
            candidate.id === id && candidate.caseId === intent.caseId &&
            candidate.initialToolSeed?.id === intent.seedId
          )
        ),
      "terminal-outcome",
    );
    return intent;
  }
  requirePreparation(
    intent.phase === "pending" && !intent.terminal &&
      isOpenCase(record) && record.closedAt === undefined,
    "closed-or-replaced-case",
  );
  const model = state.executionModel!;
  const selections = await Promise.all(
    (model.initialTools ?? []).map(async (seed) => ({
      id: seed.id,
      nativeId: seed.nativeId,
      selectionDigest: await draftDigest(seed.draft),
    })),
  );
  requirePreparation(
    model.version.digest === intent.modelVersion.digest &&
      model.version.repositoryVersion ===
        intent.modelVersion.repositoryVersion &&
      intent.key === `initial-tools:${await executionDigest({
          operatorId: model.identity.builderId,
          model: model.version,
          selections: model.initialTools,
          seedId: intent.seedId,
        })}` &&
      model.flows.promotion.rootNativeId === intent.flowRootId &&
      model.flows.promotion.rootOccurrenceId === intent.flowOccurrenceId &&
      await nativeFlowContractDigest(model) === intent.flowDigest &&
      canonical(selections) === canonical(intent.selections) &&
      selections.some((seed) => seed.id === intent.seedId),
    "pin-flow-or-selection",
  );
  const selected = selections.find((seed) => seed.id === intent.seedId)!;
  const prior = state.candidates.filter((candidate) =>
    candidate.initialToolSeed?.id === intent.seedId
  );
  requirePreparation(prior.length <= 1, "ambiguous-seed-candidate");
  for (const candidate of prior) {
    requirePreparation(
      candidate.caseId === intent.caseId &&
        candidate.initialToolSeed?.nativeId === selected.nativeId &&
        candidate.initialToolSeed.selectionDigest ===
          selected.selectionDigest &&
        candidate.digest === selected.selectionDigest &&
        await draftDigest(candidate) === selected.selectionDigest,
      "seed-candidate",
    );
  }
  requirePreparation(
    !state.candidates.some((candidate) =>
      candidate.caseId !== intent.caseId &&
      (candidate.stage === "awaiting-admission" ||
        hasActivationIntent(candidate))
    ),
    "other-promotion-pending",
  );
  return intent;
}

/** Lifecycle/result are the only mutable parts of the originally accepted intent. */
export function initialToolsPreparationDefinition(
  intent: InitialToolsPreparationIntent,
) {
  const { phase: _phase, terminal: _terminal, ...definition } = intent;
  return definition;
}
