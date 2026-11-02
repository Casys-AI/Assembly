import {
  type BehaviorInvocationPort,
  BehaviorInvocationRegistry,
} from "./invocation.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";

/** Trusted composition capability. Native declarations cannot grant this marker. */
export const readOnlyObservation = Symbol("read-only-observation");
export interface ObservationInvocationPort extends BehaviorInvocationPort {
  readonly [readOnlyObservation]: true;
}
/** Kept separate from effect executors: only host supplied read-only readers enter. */
export class ObservationInvocationRegistry
  implements ObservationInvocationPort {
  readonly [readOnlyObservation] = true;
  readonly #registry: BehaviorInvocationRegistry;
  constructor(providers: readonly ObservationInvocationPort[]) {
    if (providers.some((provider) => provider[readOnlyObservation] !== true)) {
      throw new Error(
        "Observation registry requires trusted read-only readers",
      );
    }
    this.#registry = new BehaviorInvocationRegistry([...providers]);
  }
  supports(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ): Promise<boolean> {
    return this.#registry.supports(behavior, version);
  }
  invoke(
    request: BehaviorInvocationRequest,
  ): Promise<BehaviorInvocationResult> {
    return this.#registry.invoke(request);
  }
}
