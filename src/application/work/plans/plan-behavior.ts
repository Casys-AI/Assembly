import {
  type ObservationInvocationPort,
  readOnlyObservation,
} from "../behaviors/observation.ts";
/** Register closed-plan transport without granting access to any work target. */
import { instantiateWorkResultContract } from "../../../domain/work/policies/verified-effect-closure.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../../domain/model/execution/native-contracts.ts";
import type { BehaviorModelVersion } from "../../../domain/shared-kernel/behavior-model-version.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import {
  type AdmittedWorkTask,
  parseWorkTasks,
  type WorkPlanOrigin,
} from "../../../domain/work/entities/plans.ts";
import type { BehaviorInvocationPort } from "../behaviors/invocation.ts";
import { AdmitBehaviorCall } from "../../governance/handlers/behavior-call-admission-handler.ts";
import type { SchemaValidationPort } from "../behaviors/schema-validation.ts";
import { type WorkPlanExecutor, workTaskInvocationId } from "./executor.ts";
import { assertWorkPlanGraphFits, workPlanResultView } from "./result-view.ts";

export interface WorkPlanBehaviorOptions {
  schemaValidator: SchemaValidationPort;
  executor: WorkPlanExecutor;
  /**
   * Resolve the requested source pin and verify that its scope is still
   * admitted. `null` means not admitted; a rejection is an infrastructure failure.
   */
  resolveCallerModel(
    callerId: string,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel | null>;
  planTargetIds: ReadonlySet<string>;
  /** Qualified from admitted native ownership, never from the supplied exposure. */
  planTargetOwners: ReadonlyMap<string, string>;
  workTargetIds: ReadonlySet<string>;
  workInvoker: BehaviorInvocationPort;
  observationInvoker?: ObservationInvocationPort;
  maxConcurrency?: number;
  /** Native owning operator, when several inboxes share a sequential runtime. */
  resourceId?(behavior: NativeBehaviorContract): string;
}

function requirePlan(value: unknown, message: string): asserts value {
  if (!value) throw new Error("Work plan refused: " + message);
}

/** One port over every caller's own planner, chosen by the admitted caller.
 * A suspended plan action's native resume reaches the planner unchanged; a
 * dropped resume would re-read the waiting plan instead of continuing it. */
export function callerWorkPlanPort(input: {
  planTargetIds: ReadonlySet<string>;
  isCaller(callerId: string): boolean;
  planner(callerId: string): Promise<BehaviorInvocationPort>;
}): BehaviorInvocationPort {
  return {
    async supports(behavior, version) {
      if (
        !input.planTargetIds.has(behavior.targetNativeId) ||
        !input.isCaller(behavior.callerNativeId)
      ) return false;
      return (await input.planner(behavior.callerNativeId)).supports(
        behavior,
        version,
      );
    },
    async invoke(request, options) {
      if (
        request.callerId !== request.behavior.callerNativeId ||
        !input.isCaller(request.callerId)
      ) {
        throw new Error("Unknown admitted work-plan caller");
      }
      return await (await input.planner(request.callerId)).invoke(
        request,
        options,
      );
    },
  };
}

export class WorkPlanBehavior implements BehaviorInvocationPort {
  constructor(readonly options: WorkPlanBehaviorOptions) {}

  #registered(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ): void {
    requirePlan(
      this.options.planTargetIds.has(behavior.targetNativeId),
      "the target is not a registered native planning action",
    );
    requirePlan(
      this.options.planTargetOwners.get(behavior.targetNativeId) ===
        behavior.callerNativeId,
      "the native planning action does not belong to its caller",
    );
    requirePlan(
      typeof version.digest === "string" && version.digest.length > 0 &&
        typeof version.repositoryVersion === "string" &&
        version.repositoryVersion.length > 0,
      "an immutable model reference is required",
    );
  }

  #pinned(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
    model: ExecutableModel,
  ): ExecutableModel {
    requirePlan(
      model.identity.builderId === behavior.callerNativeId &&
        model.version.digest === version.digest,
      "the caller scope is not admitted under this contract",
    );
    const matches = (model.behaviors ?? []).filter((entry) =>
      entry.id === behavior.id &&
      entry.callerNativeId === model.identity.builderId
    );
    requirePlan(
      matches.length === 1 && canonical(matches[0]) === canonical(behavior),
      "the exact planning exposure is absent from the admitted caller catalog",
    );
    // The resolver verifies source provenance. An unrelated accepted commit may
    // leave this scope's semantics unchanged, but it must not replace this call's pin.
    const pinned = structuredClone(model);
    pinned.version.repositoryVersion = version.repositoryVersion;
    return pinned;
  }

  async #model(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ): Promise<ExecutableModel> {
    this.#registered(behavior, version);
    const model = await this.options.resolveCallerModel(
      behavior.callerNativeId,
      structuredClone(version),
    );
    requirePlan(model, "the plan caller contract is not admitted");
    return this.#pinned(behavior, version, model);
  }

  async supports(
    behavior: NativeBehaviorContract,
    version: BehaviorModelVersion,
  ): Promise<boolean> {
    try {
      this.#registered(behavior, version);
    } catch {
      return false;
    }
    // Infrastructure failures propagate with their code, not as `false`.
    const model = await this.options.resolveCallerModel(
      behavior.callerNativeId,
      structuredClone(version),
    );
    if (!model) return false;
    try {
      this.#pinned(behavior, version, model);
      return true;
    } catch {
      return false;
    }
  }

  async invoke(
    request: BehaviorInvocationRequest,
    options?: { resume?: true },
  ): Promise<BehaviorInvocationResult> {
    const copied = structuredClone(request);
    requirePlan(
      copied.callerId === copied.behavior.callerNativeId,
      "the caller differs from the source exposure",
    );
    requirePlan(
      typeof copied.invocationId === "string" &&
        copied.invocationId.length > 0 && copied.invocationId.length <= 240,
      "invalid invocation identity",
    );
    let model = await this.#model(copied.behavior, copied.modelVersion);
    const outer = await AdmitBehaviorCall(
      {
        behaviorId: copied.behavior.id,
        inputJson: JSON.stringify(copied.input),
      },
      model,
      this.options.schemaValidator,
      this,
      copied.invocationId,
    );
    requirePlan(
      outer.admitted,
      outer.failure?.message ?? "invalid native planning input",
    );
    requirePlan(
      typeof copied.input.tasksJson === "string" &&
        copied.input.tasksJson.length <= 65536 &&
        (copied.input.resume === undefined ||
          typeof copied.input.resume === "boolean") &&
        Object.keys(copied.input).every((key) =>
          key === "tasksJson" || key === "resume" || key === "planId"
        ),
      "unsupported closed-plan input representation",
    );
    let rawTasks: unknown;
    try {
      rawTasks = JSON.parse(copied.input.tasksJson);
    } catch {
      throw new Error("Work plan refused: tasksJson must contain a JSON array");
    }
    const drafts = parseWorkTasks(rawTasks);
    const nativeResume = options?.resume === true;
    const resume = copied.input.resume === true || nativeResume;
    let planId = copied.invocationId;
    let origin: WorkPlanOrigin = {
      behaviorId: copied.behavior.id,
      targetNativeId: copied.behavior.targetNativeId,
      invocationId: copied.invocationId,
    };
    if (resume) {
      if (nativeResume && copied.input.planId === undefined) {
        copied.input.planId = copied.invocationId;
      }
      requirePlan(
        typeof copied.input.planId === "string" &&
          copied.input.planId.trim().length > 0 &&
          copied.input.planId.length <= 240,
        "resume requires the exact planId from a persisted receipt",
      );
      const previous = await this.options.executor.read(copied.input.planId);
      requirePlan(
        previous && previous.id === copied.input.planId &&
          previous.callerId === copied.callerId &&
          (previous.caseId === undefined || previous.caseId === copied.caseId),
        "the referenced plan is absent or belongs to another caller",
      );
      requirePlan(
        previous.modelVersion.digest === copied.modelVersion.digest,
        "the referenced plan's execution contract is no longer admitted",
      );
      requirePlan(
        previous.origin && previous.origin.invocationId === previous.id &&
          previous.origin.behaviorId === copied.behavior.id &&
          previous.origin.targetNativeId === copied.behavior.targetNativeId,
        "the referenced plan has no matching original planning exposure",
      );
      const previousDrafts = previous.tasks.map((task) => ({
        id: task.id,
        behaviorId: task.invocation.behavior.id,
        input: task.invocation.input,
        dependsOn: task.dependsOn,
      }));
      requirePlan(
        canonical(drafts) === canonical(previousDrafts),
        "resume cannot change the admitted tasks, inputs, or dependency graph",
      );
      // Re-read the original source pin as well as the current admitted scope.
      // Fresh chat invocations have new IDs; they never replace the plan's ID,
      // task correlations, source provenance, or original planning exposure.
      model = await this.#model(copied.behavior, previous.modelVersion);
      planId = previous.id;
      origin = structuredClone(previous.origin);
    } else {
      requirePlan(
        copied.input.planId === undefined,
        "planId is accepted only for an explicit resume",
      );
    }
    const tasks: AdmittedWorkTask[] = [];
    // No target invocation occurs in this loop. A later invalid task refuses
    // the whole plan before any earlier valid task can produce an effect.
    for (const draft of drafts) {
      const matches = (model.behaviors ?? []).filter((entry) =>
        entry.id === draft.behaviorId &&
        entry.callerNativeId === copied.callerId
      );
      requirePlan(matches.length === 1, "unknown or ambiguous work exposure");
      const behavior = matches[0]!;
      requirePlan(
        this.options.workTargetIds.has(behavior.targetNativeId) &&
          !this.options.planTargetIds.has(behavior.targetNativeId),
        "the task does not target a qualified native work inbox",
      );
      const resourceId = this.options.resourceId?.(behavior) ??
        behavior.targetNativeId;
      requirePlan(
        typeof resourceId === "string" && resourceId.length > 0 &&
          resourceId !== copied.callerId,
        "the planning caller cannot wait on its own sequential runtime",
      );
      const invocationId = workTaskInvocationId(planId, draft.id);
      const admission = await AdmitBehaviorCall(
        {
          behaviorId: draft.behaviorId,
          inputJson: JSON.stringify(draft.input),
        },
        model,
        this.options.schemaValidator,
        this.options.workInvoker,
        invocationId,
      );
      requirePlan(
        admission.admitted && admission.input && admission.inputDigest &&
          admission.modelVersion,
        admission.failure?.message ?? "work input was not admitted",
      );
      const policies = (model.workResultContracts ?? []).filter((entry) =>
        entry.workBehaviorId === behavior.id
      );
      requirePlan(policies.length <= 1, "ambiguous work result contract");
      let observation: Partial<AdmittedWorkTask> = {};
      if (policies.length) {
        const contract = instantiateWorkResultContract(
          policies[0]!,
          admission.input,
        );
        requirePlan(
          !contract.input || contract.input.typeId === behavior.inputTypeId &&
              canonical(contract.input.schema) ===
                canonical(behavior.inputSchema),
          "result binding does not use the exact native work input",
        );
        requirePlan(
          contract.callerNativeId === copied.callerId &&
            this.options.observationInvoker?.[readOnlyObservation] === true,
          "required result observation has no qualified executor",
        );
        const reads = (model.behaviors ?? []).filter((entry) =>
          entry.id === contract.observationBehaviorId
        );
        requirePlan(
          reads.length === 1,
          "missing exact result observation exposure",
        );
        const readInput = {
          ...(contract.query?.values ?? {}),
          workInvocationId: invocationId,
          workBehaviorId: behavior.id,
          workInputDigest: admission.inputDigest,
        };
        const readAdmission = await AdmitBehaviorCall(
          { behaviorId: reads[0]!.id, inputJson: JSON.stringify(readInput) },
          model,
          this.options.schemaValidator,
          this.options.observationInvoker,
          invocationId + ":observe",
        );
        requirePlan(
          readAdmission.admitted && readAdmission.input &&
            readAdmission.inputDigest && readAdmission.modelVersion,
          readAdmission.failure?.message ??
            "result observation was not admitted",
        );
        observation = {
          resultContract: structuredClone(contract),
          observationInputDigest: readAdmission.inputDigest,
          observationInvocation: {
            ...(copied.designerContext
              ? { designerContext: structuredClone(copied.designerContext) }
              : {}),
            ...(copied.caseId ? { caseId: copied.caseId } : {}),
            ...(copied.caseContext
              ? { caseContext: structuredClone(copied.caseContext) }
              : {}),
            behavior: structuredClone(reads[0]!),
            input: structuredClone(readAdmission.input),
            callerId: copied.callerId,
            invocationId: invocationId + ":observe",
            modelVersion: structuredClone(readAdmission.modelVersion),
          },
        };
      }
      tasks.push({
        ...observation,
        ...(copied.caseId ? { caseId: copied.caseId } : {}),
        id: draft.id,
        dependsOn: [...draft.dependsOn],
        resourceId,
        inputDigest: admission.inputDigest,
        invocation: {
          ...(copied.designerContext
            ? { designerContext: structuredClone(copied.designerContext) }
            : {}),
          ...(copied.caseId ? { caseId: copied.caseId } : {}),
          ...(copied.caseContext
            ? { caseContext: structuredClone(copied.caseContext) }
            : {}),
          behavior: structuredClone(behavior),
          input: structuredClone(admission.input),
          modelVersion: structuredClone(admission.modelVersion),
          callerId: copied.callerId,
          invocationId,
        },
      });
    }
    const execution = {
      id: planId,
      ...(copied.caseId ? { caseId: copied.caseId } : {}),
      callerId: copied.callerId,
      modelVersion: {
        digest: model.version.digest,
        repositoryVersion: model.version.repositoryVersion!,
      },
      origin,
      tasks,
      ...(this.options.maxConcurrency !== undefined
        ? { maxConcurrency: this.options.maxConcurrency }
        : {}),
    };
    assertWorkPlanGraphFits(copied, {
      ...execution,
      tasks: tasks.map((task) => ({ ...task, state: "pending" as const })),
    });
    const plan = await this.options.executor.execute(execution, { resume });
    return await workPlanResultView(copied, plan);
  }
}
