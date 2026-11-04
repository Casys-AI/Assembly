import type { ScopedExecutableModel } from "../../../domain/model/evolution/semantic-effects.ts";
import type { BehaviorSettingsValidationTarget } from "./behavior-settings-validation.ts";

export interface EvolutionSettingsValidationTargetsPort {
  validationTargets(
    models: readonly ScopedExecutableModel[],
  ): Promise<BehaviorSettingsValidationTarget[]>;
}
