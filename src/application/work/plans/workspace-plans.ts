import type { BehaviorInvocationPort } from "../behaviors/invocation.ts";
import type { ObservationInvocationPort } from "../behaviors/observation.ts";
import { WorkPlanExecutor } from "./executor.ts";
import {
  callerWorkPlanPort,
  WorkPlanBehavior,
  type WorkPlanBehaviorOptions,
} from "./plan-behavior.ts";
import type { WorkPlanStorePort } from "./ports.ts";

export interface WorkspacePlansOptions {
  loadStore(callerId: string): Promise<WorkPlanStorePort>;
  now(): string;
  schemaValidator: WorkPlanBehaviorOptions["schemaValidator"];
  resolveCallerModel: WorkPlanBehaviorOptions["resolveCallerModel"];
  isCaller(callerId: string): boolean;
  planOwners: ReadonlyMap<string, string>;
  planTargets: ReadonlySet<string>;
  workTargets: ReadonlySet<string>;
  targets: ReadonlyMap<string, string>;
  workInvoker: BehaviorInvocationPort;
  observationInvoker: ObservationInvocationPort;
}

/** One workspace registration, with lazy planners scoped to each admitted caller. */
export function createWorkspacePlans(options: WorkspacePlansOptions) {
  let registered = false;
  return {
    /** The composition root registers the returned port once. */
    ensure(): BehaviorInvocationPort | undefined {
      if (!options.planOwners.size || registered) return;
      const planners = new Map<string, Promise<WorkPlanBehavior>>();
      const planner = (callerId: string) => {
        let pending = planners.get(callerId);
        if (!pending) {
          pending = (async () => {
            const store = await options.loadStore(callerId);
            const executor = new WorkPlanExecutor({
              now: options.now,
              store,
              invokeTarget: (request) => options.workInvoker.invoke(request),
              observeTarget: (request) =>
                options.observationInvoker.invoke(request),
              completion(receipt) {
                const status = (receipt.result as { status?: unknown })?.status;
                if (
                  status === "completed" || status === "waiting" ||
                  status === "failed"
                ) return status;
                return "failed";
              },
            });
            return new WorkPlanBehavior({
              schemaValidator: options.schemaValidator,
              executor,
              resolveCallerModel: options.resolveCallerModel,
              planTargetIds: options.planTargets,
              planTargetOwners: options.planOwners,
              workTargetIds: options.workTargets,
              workInvoker: options.workInvoker,
              observationInvoker: options.observationInvoker,
              maxConcurrency: 3,
              resourceId: (behavior) =>
                options.targets.get(behavior.targetNativeId) ??
                  behavior.targetNativeId,
            });
          })();
          planners.set(callerId, pending);
          void pending.catch(() => {
            if (planners.get(callerId) === pending) planners.delete(callerId);
          });
        }
        return pending;
      };
      const port = callerWorkPlanPort({
        planTargetIds: options.planTargets,
        isCaller: options.isCaller,
        planner,
      });
      registered = true;
      return port;
    },
  };
}
