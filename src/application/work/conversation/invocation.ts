import {
  activeCatalogEntry,
  activeTools,
  resolveActiveTool,
} from "../tools/active-tools.ts";
import { canonical } from "../../../domain/primitives/canonical-json.ts";
import { invocationInput, invocationKey } from "../operators/journal.ts";
import { WORK_PLAN_RESULT_FORMAT } from "../plans/result-view.ts";
import {
  caseExecutionContext,
  designerExecutionContext,
} from "../cases/runtime.ts";
import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type {
  FlowActionResult,
  FlowValues,
} from "../../../domain/model/execution/flow.ts";
import type { BehaviorInvocationRequest } from "../../../domain/work/execution/modeled-behavior.ts";
import { ToolInvocationError } from "../../../domain/work/errors/tool-invocation.ts";
import type {
  ChatDecision,
  ToolFailure,
} from "../../../domain/work/dialogue.ts";
import {
  type BehaviorAdmission,
  behaviorVersion,
} from "../../governance/behavior-call-admission.ts";
import { AdmitBehaviorCall } from "../../governance/handlers/behavior-call-admission-handler.ts";
import type {
  ConversationInvocationHost,
  ConversationTurnState,
} from "./turn-context.ts";
import { errorText, makeEvent } from "../runtime/values.ts";

export async function checkInvocation(
  this: ConversationInvocationHost,
  turn: ConversationTurnState,
  current: ExecutableModel,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const decision = inputs.choice as ChatDecision;
  if (decision?.kind === "invoke_behavior") {
    await this.say(decision.text);
    turn.admission = undefined;
    turn.behaviorAdmission = await AdmitBehaviorCall(
      decision,
      current,
      this.ports.schemaValidator,
      this.ports.behaviors,
    );
    return {
      outputs: { decision: structuredClone(turn.behaviorAdmission) },
    };
  }
  if (decision?.kind !== "invoke_tool") {
    throw new Error(
      "Le contrôle natif exige une demande d’appel.",
    );
  }
  await this.say(decision.text);
  turn.behaviorAdmission = undefined;
  turn.admission = await this.invocationAdmission(decision, current);
  return { outputs: { decision: turn.admission } };
}

export async function invokeTool(
  this: ConversationInvocationHost,
  turn: ConversationTurnState,
  current: ExecutableModel,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  if (turn.chosen?.kind === "invoke_behavior") {
    return await invokeBehavior.call(this, turn, turn.chosen, inputs);
  }
  return await invokeActiveTool.call(this, turn, current, inputs);
}

async function invokeBehavior(
  this: ConversationInvocationHost,
  turn: ConversationTurnState,
  chosen: Extract<ChatDecision, { kind: "invoke_behavior" }>,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const checked = inputs.decision as BehaviorAdmission;
  if (
    !turn.behaviorAdmission?.admitted || !checked?.admitted ||
    JSON.stringify(checked) !==
      JSON.stringify(turn.behaviorAdmission)
  ) {
    throw new Error(
      "L’action native exige le contrôle exact du comportement appelé.",
    );
  }
  const fresh = await this.currentModel();
  const rechecked = await AdmitBehaviorCall(
    chosen,
    fresh,
    this.ports.schemaValidator,
    this.ports.behaviors,
    checked.invocationId,
  );
  if (
    !rechecked.admitted ||
    rechecked.inputDigest !== checked.inputDigest ||
    JSON.stringify(rechecked.modelVersion) !==
      JSON.stringify(checked.modelVersion)
  ) {
    throw new Error(
      "Le contrat natif d’appel a changé avant l’effet.",
    );
  }
  const behavior = fresh.behaviors!.find((b) => b.id === checked.behaviorId)!;
  await this.update((s) => {
    s.phase = "Exécution du comportement " + behavior.name;
    s.events.push({
      ...makeEvent(
        this.ports.clock,
        "behavior-called",
        "Appel du comportement " + behavior.name,
      ),
      elementId: behavior.targetNativeId,
    });
  });
  try {
    const caseContext = caseExecutionContext(this.state);
    const invocationRequest: BehaviorInvocationRequest = {
      ...(designerExecutionContext(this.state)
        ? { designerContext: designerExecutionContext(this.state) }
        : {}),
      ...(caseContext ? { caseId: caseContext.caseId, caseContext } : {}),
      behavior: structuredClone(behavior),
      input: structuredClone(rechecked.input!),
      modelVersion: behaviorVersion(fresh),
      callerId: fresh.identity.builderId,
      invocationId: checked.invocationId,
    };
    const previousInvocation = this.behaviorInvocation;
    this.behaviorInvocation = structuredClone(
      invocationRequest,
    );
    let result;
    try {
      result = await this.ports.behaviors!.invoke(
        invocationRequest,
        turn.resumedContribution ? { resume: true } : undefined,
      );
    } finally {
      this.behaviorInvocation = previousInvocation;
    }
    await this.currentModel();
    const expectedVersion = behaviorVersion(fresh);
    const resultVersion = result.modelVersion;
    if (
      result.behaviorId !== behavior.id ||
      result.invocationId !== checked.invocationId ||
      result.targetNativeId !== behavior.targetNativeId ||
      !resultVersion || typeof resultVersion !== "object" ||
      Object.keys(resultVersion).length !== 2 ||
      !Object.hasOwn(resultVersion, "digest") ||
      !Object.hasOwn(resultVersion, "repositoryVersion") ||
      resultVersion.digest !== expectedVersion.digest ||
      resultVersion.repositoryVersion !==
        expectedVersion.repositoryVersion
    ) {
      throw new Error(
        "Le résultat ne correspond pas à l’appel natif exact.",
      );
    }
    const payload = result.result as {
      status?: string;
      format?: string;
      agentId?: string;
      invocationId?: string;
      correlationId?: string;
    } | undefined;
    if (
      payload?.status === "waiting" && payload.agentId &&
      payload.invocationId === checked.invocationId && payload.correlationId
    ) {
      const inputMessageId = turn.inputMessageId ??
        invocationInput(this.state)?.id;
      if (!inputMessageId || !this.state.caseInvocation) {
        throw new Error("Outgoing contribution has no exact caller input");
      }
      const key = invocationKey(this.state.caseInvocation);
      await this.update((state) => {
        const existing = state.pendingContributions?.[checked.invocationId];
        if (
          existing &&
          (existing.invocationKey !== key ||
            existing.inputMessageId !== inputMessageId ||
            existing.targetOperatorId !== payload.agentId)
        ) {
          throw new Error("Outgoing contribution correlation changed");
        }
        (state.pendingContributions ??= {})[checked.invocationId] = {
          invocationKey: key,
          inputMessageId,
          targetOperatorId: payload.agentId!,
          invocationId: checked.invocationId,
          behaviorId: behavior.id,
          status: "pending",
        };
      });
    }
    if (
      payload?.format === WORK_PLAN_RESULT_FORMAT &&
      (payload.status === "waiting" || payload.status === "running")
    ) {
      // Native continuation retains the exact admitted invocation and WorkPlan;
      // a correlated child receipt wakes this action after releasing the worker.
      return { suspend: true };
    }
    const details = JSON.stringify(result);
    if (details.length > 262144) {
      throw new Error(
        "Résultat de comportement trop volumineux",
      );
    }
    return {
      outputs: {
        outcome: {
          succeeded: true,
          code: "BEHAVIOR_COMPLETED",
          details,
          behaviorId: behavior.id,
          behaviorResult: result,
        },
      },
    };
  } catch (error) {
    await this.currentModel();
    return {
      outputs: {
        outcome: {
          succeeded: false,
          code: "BEHAVIOR_RESULT_UNCONFIRMED",
          details:
            "L’appel n’a pas fourni de résultat vérifiable. Consultez le journal avant toute reprise. " +
            errorText(error),
          behaviorId: behavior.id,
          behaviorFailure: true,
        },
      },
    };
  }
}

async function invokeActiveTool(
  this: ConversationInvocationHost,
  turn: ConversationTurnState,
  current: ExecutableModel,
  inputs: FlowValues,
): Promise<FlowActionResult> {
  const checked = inputs.decision as NonNullable<
    typeof turn.admission
  >;
  if (
    !checked || turn.chosen?.kind !== "invoke_tool" ||
    checked.toolId !== turn.chosen.toolId
  ) {
    throw new Error(
      "L’action native n’a pas admis cet appel exact.",
    );
  }
  const rechecked = await this.invocationAdmission(
    turn.chosen,
    current,
  );
  if (
    !rechecked.admitted || rechecked.url !== checked.url ||
    canonical(rechecked.retainedTool ?? null) !==
      canonical(checked.retainedTool ?? null)
  ) {
    throw new Error(
      "L’admission d’appel a changé avant l’effet.",
    );
  }
  const selected =
    (await activeTools(this.state, current, this.ports.retainedTools)).find(
      (entry) => entry.tool.id === checked.toolId,
    );
  if (!selected) throw new Error("The exact active tool is unavailable");
  const tool = selected.tool;
  await this.update((s) => {
    s.phase = "Le tool actif lit la page";
    s.events.push(
      selected.kind === "local-candidate"
        ? makeEvent(
          this.ports.clock,
          "tool-called",
          `Appel réel de ${tool.name}`,
          selected.tool,
        )
        : {
          ...makeEvent(
            this.ports.clock,
            "tool-called",
            `Appel réel de ${tool.name}`,
          ),
          elementId: activeCatalogEntry(current, tool)!.nativeId,
        },
    );
  });
  const fresh = await this.currentModel();
  if (
    !activeCatalogEntry(fresh, tool) ||
    selected.kind === "local-candidate" &&
      !this.nativeCandidate(fresh, selected.tool, "active") ||
    fresh.mandate.mayInvoke !== "active-catalog-only"
  ) {
    throw new Error("Le catalogue natif a changé avant l’appel.");
  }
  try {
    const resolved = await resolveActiveTool(
      this.state,
      fresh,
      tool.id,
      this.ports,
    );
    if (
      !resolved || resolved.kind !== selected.kind ||
      resolved.kind === "retained-dependency" &&
        canonical(resolved.retainedTool) !== canonical(checked.retainedTool)
    ) throw new Error("The admitted tool dependency changed before invocation");
    const result = await this.ports.runner.run(
      resolved.tool,
      { url: checked.url! },
      structuredClone(fresh.mandate.network),
    );
    await this.currentModel();
    return {
      outputs: {
        outcome: {
          succeeded: true,
          code: "TOOL_COMPLETED",
          details: JSON.stringify(result),
          result,
          toolId: tool.id,
        },
      },
    };
  } catch (error) {
    await this.currentModel();
    const failure: ToolFailure = error instanceof ToolInvocationError
      ? { ...error.failure, toolId: tool.id, url: checked.url }
      : {
        code: "TOOL_EXECUTION_FAILED",
        message:
          "L’exécution contrôlée de l’outil n’a pas abouti. Analyse le retour avant de décider d’une nouvelle tentative ou d’une correction.",
        retryable: false,
        toolId: tool.id,
        url: checked.url,
      };
    return {
      outputs: {
        outcome: {
          succeeded: false,
          code: failure.code,
          details: failure.message,
          failure,
        },
      },
    };
  }
}

export function reportRefusal(turn: ConversationTurnState): FlowActionResult {
  if (
    turn.behaviorAdmission && !turn.behaviorAdmission.admitted &&
    turn.behaviorAdmission.failure
  ) {
    return {
      outputs: {
        outcome: {
          succeeded: false,
          code: turn.behaviorAdmission.failure.code,
          details: turn.behaviorAdmission.failure.message,
          behaviorId: turn.behaviorAdmission.behaviorId,
          behaviorFailure: true,
        },
      },
    };
  }
  if (!turn.admission?.failure) {
    throw new Error(
      "Le refus natif ne possède pas de contrôle refusé.",
    );
  }
  return {
    outputs: {
      outcome: {
        succeeded: false,
        code: turn.admission.failure.code,
        details: turn.admission.failure.message,
        failure: turn.admission.failure,
      },
    },
  };
}
