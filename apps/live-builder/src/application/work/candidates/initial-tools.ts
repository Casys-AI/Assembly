import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  ArtifactReuseOrigin,
  Candidate,
  Stage,
  ToolDraft,
} from "../../../domain/work/candidates.ts";
import type {
  InitialToolsPreparationReference,
  SystemRuntimeState,
} from "../../../domain/work/dialogue.ts";
import type { ClockPort } from "../runtime/ports.ts";
import type { CandidateModelReaderPort } from "./ports/out/candidate-model.port.ts";
import type { CaseNumberPort } from "../cases/ports/out/case-number.port.ts";
import { draftDigest } from "../runtime/values.ts";
import {
  closeCaseById,
  selectCaseInvocation,
  selectDesignerInvocation,
} from "../cases/runtime.ts";
import { isOpenCase } from "../../../domain/work/entities/cases.ts";
import { abandonCaseCandidates } from "./case-candidates.ts";
import {
  InitialToolsPreparationRefused,
  verifyInitialToolsPreparation,
} from "./initial-tools-preparation.ts";

export interface InitialToolsHost {
  readonly state: SystemRuntimeState;
  readonly pending: Promise<void> | null;
  assertInitialToolAvailability?(): void;
  readonly ports: {
    readonly model: CandidateModelReaderPort;
    readonly clock: ClockPort;
    readonly caseNumbers: CaseNumberPort;
  };
  update(change: (state: SystemRuntimeState) => void): Promise<void>;
  control(action: () => Promise<void>): Promise<void>;
  currentModel(): Promise<ExecutableModel>;
  stage(id: string, stage: Stage, label: string): Promise<void>;
  build(
    draft?: ToolDraft,
    resumeId?: string,
    origin?: ArtifactReuseOrigin,
    initialToolSeed?: Candidate["initialToolSeed"],
  ): Promise<void>;
}

/** The queue already owns the canonical initialization Case. It may only
 * acknowledge its terminal result or execute under that exact open scope. */
export async function prepareInitialTools(
  this: InitialToolsHost,
  reference: InitialToolsPreparationReference,
): Promise<void> {
  const intent = await verifyInitialToolsPreparation(this.state, reference);
  if (intent.phase === "terminal") return;
  if (this.assertInitialToolAvailability) this.assertInitialToolAvailability();
  else if (this.state.busy || this.pending) {
    throw new Error("Une réponse est déjà en cours.");
  }
  await this.control(() => prepareSelectedTools.call(this, reference));
}

async function prepareSelectedTools(
  this: InitialToolsHost,
  reference: InitialToolsPreparationReference,
): Promise<void> {
  const intent = await verifyInitialToolsPreparation(this.state, reference);
  if (intent.phase === "terminal") return;
  const model = await this.currentModel();
  await verifyInitialToolsPreparation(
    { ...this.state, executionModel: model },
    reference,
  );
  if (
    model.version.digest !== intent.modelVersion.digest ||
    model.version.repositoryVersion !== intent.modelVersion.repositoryVersion
  ) {
    throw new InitialToolsPreparationRefused("current-source-pin");
  }
  const seed = model.initialTools?.find((seed) => seed.id === intent.seedId);
  const selected = intent.selections.find((selection) =>
    selection.id === intent.seedId
  );
  if (
    !seed || !selected || seed.nativeId !== selected.nativeId ||
    await draftDigest(seed.draft) !== selected.selectionDigest
  ) {
    throw new InitialToolsPreparationRefused("selected-seed");
  }
  const previous = structuredClone(this.state.caseInvocation);
  await this.update((state) =>
    selectCaseInvocation(state, { kind: "local", caseId: intent.caseId })
  );
  let returned = false;
  try {
    // The stable initial-tool contribution resumes the original native run
    // after interruption. Completed receipts prevent proposal/tests replay;
    // unknown effects retain their ordinary refusal.
    await this.build(seed.draft, undefined, undefined, {
      id: seed.id,
      nativeId: seed.nativeId,
      selectionDigest: selected.selectionDigest,
      modelVersion: structuredClone(intent.modelVersion),
    });
    returned = true;
  } finally {
    if (returned && !this.state.budgetSuspension) {
      const candidate = this.state.candidates.find((candidate) =>
        candidate.caseId === intent.caseId &&
        candidate.initialToolSeed?.id === intent.seedId
      );
      const outcome =
        !candidate || ["failed", "refused"].includes(candidate.stage)
          ? "abandoned" as const
          : "done" as const;
      if (outcome === "abandoned") {
        await abandonCaseCandidates.call(this, intent.caseId);
      }
      await this.update((state) => {
        closeCaseById(state, intent.caseId, outcome, this.ports.clock);
        const stored = state.initialToolsPreparations![intent.key];
        stored.phase = "terminal";
        stored.terminal = {
          outcome,
          closedAt: state.cases!.find((record) => record.id === intent.caseId)!
            .closedAt!,
          candidateIds: state.candidates.filter((candidate) =>
            candidate.caseId === intent.caseId &&
            candidate.initialToolSeed?.id === intent.seedId
          )
            .map((candidate) => candidate.id),
        };
        if (
          previous?.kind === "local" && previous.caseId !== intent.caseId &&
          state.cases?.some((record) =>
            record.id === previous.caseId && isOpenCase(record)
          )
        ) {
          selectCaseInvocation(state, previous);
        } else if (
          previous && previous.kind !== "local" && previous.kind !== "designer"
        ) {
          selectCaseInvocation(state, previous);
        } else {
          selectDesignerInvocation(state);
        }
      });
    } else {
      // A settled budget wait is not a terminal preparation result either.
      // Preserve A and its intent for the exact native continuation; cleanup
      // must not abandon its reservation or settle an unknown effect.
      await this.update((state) => {
        if (state.budgetSuspension) return;
        if (
          previous?.kind === "local" &&
          state.cases?.some((record) =>
            record.id === previous.caseId && isOpenCase(record)
          )
        ) {
          selectCaseInvocation(state, previous);
        } else if (
          previous && previous.kind !== "local" && previous.kind !== "designer"
        ) {
          selectCaseInvocation(state, previous);
        } else {
          selectDesignerInvocation(state);
        }
      });
    }
  }
}
