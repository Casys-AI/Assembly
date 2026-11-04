import type { ModelRepositoryPort } from "../repository.ts";
import type { ScopedSoftwareSourceAdmissionV2 } from "../source-admission/scoped-software-source-admission.ts";
import type { ScopedSoftwareContextV2 } from "./scoped-software-context.ts";

export interface ScopedEvolutionSourcePort {
  scopedSoftwarePreparationRepository(input: {
    scope: ScopedSoftwareContextV2;
    assertCurrent(): Promise<void>;
  }): Pick<ModelRepositoryPort, "current" | "at" | "proposal" | "descriptorAt">;
  verifyScopedSoftwareSourceAdmission(
    payload: ScopedSoftwareSourceAdmissionV2,
  ): Promise<void>;
}
