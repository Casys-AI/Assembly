import { isPlainRecord as object } from "../../../domain/primitives/is-plain-record.ts";
import type {
  BehaviorInvocationRequest,
  BehaviorInvocationResult,
} from "../../../domain/work/execution/modeled-behavior.ts";
import type {
  WorkPlanRecord,
  WorkTaskDraft,
  WorkTaskRecord,
} from "../../../domain/work/entities/plans.ts";
import type {
  ArtifactEvidence,
  ChatCallResult,
  Message,
} from "../../../domain/work/dialogue.ts";
import { sha256 } from "../../../domain/primitives/execution-digest.ts";

export const WORK_PLAN_RESULT_FORMAT = "assembly-work-plan-result/v1";
const MAX_CALL_CHARACTERS = 262_144;
const MAX_ITEMS = 8;

interface WorkTaskResultView {
  id: string;
  caseId?: string;
  state: WorkTaskRecord["state"];
  resourceId: string;
  invocationId: string;
  behaviorId: string;
  targetNativeId: string;
  modelVersion: WorkTaskRecord["invocation"]["modelVersion"];
  startedAt?: string;
  completedAt?: string;
  error?: { code: string; message: string; omittedCharacters: number };
  verification?: { status: string; observations: number };
  contribution?: {
    agentId: string;
    correlationId: string;
    invocationId: string;
    status: string;
    revision: number;
    candidateIds: string[];
    omittedCandidateIds: number;
  };
  artifacts: Array<
    Pick<ArtifactEvidence, "id" | "digest" | "kind" | "localStage"> & {
      testsPassed?: boolean;
      activationConfirmed: boolean;
    }
  >;
  /** Timing and identity only; historical receipts remain in the durable plan. */
  activityWindows: Array<{
    startedAt: string;
    returnedAt?: string;
    state: string;
    invocationId: string;
    correlationId?: string;
    candidateIds: string[];
    omittedCandidateIds: number;
  }>;
  outputs: Array<{
    kind: "tool-source" | "last-reply" | "result";
    reference: {
      operatorId?: string;
      messageId?: string;
      caseId?: string;
      at?: string;
      modelVersion?: { digest: string; repositoryVersion?: string };
    };
    value: unknown;
    /** Digest covers the complete value, before the explicit preview bound. */
    valueDigest: string;
    omittedCharacters: number;
  }>;
  omitted: {
    attempts: number;
    messages: number;
    sourceElementIds: number;
    artifacts: number;
    activityWindows: number;
    outputs: number;
    contribution: number;
    verification: number;
    errors: number;
  };
}

export interface WorkPlanResultView extends
  Pick<
    WorkPlanRecord,
    | "id"
    | "caseId"
    | "callerId"
    | "modelVersion"
    | "origin"
    | "requestDigest"
    | "revision"
    | "status"
    | "createdAt"
    | "updatedAt"
  > {
  format: typeof WORK_PLAN_RESULT_FORMAT;
  /** Complete admitted input. JSON.stringify(graph) is the exact resume graph. */
  graph: WorkTaskDraft[];
  tasks: WorkTaskResultView[];
  journal: {
    kind: "work-plan-journal";
    planId: string;
    revision: number;
    requestDigest: string;
    callerId: string;
    caseId?: string;
  };
  representation: "bounded-view-not-complete-evidence";
}

/** Account for the existing native protocol's repeated details and value, not
 * just the DTO. Keep this in step with invokeActiveBehavior/nativeCallResult. */
export function workPlanCallCharacters(
  result: BehaviorInvocationResult,
): number {
  const details = JSON.stringify(result);
  const outcome = {
    succeeded: true,
    code: "BEHAVIOR_COMPLETED",
    details,
    behaviorId: result.behaviorId,
    behaviorResult: result,
  };
  const call: ChatCallResult = {
    status: "succeeded",
    code: outcome.code,
    details,
    value: outcome,
  };
  return JSON.stringify(call).length;
}

function contribution(
  value: unknown,
): value is {
  agentId: string;
  correlationId: string;
  invocationId: string;
  status: string;
  revision: number;
  candidateIds: string[];
  artifacts?: ArtifactEvidence[];
  messages: Message[];
} {
  return object(value) && typeof value.agentId === "string" &&
    typeof value.correlationId === "string" &&
    typeof value.invocationId === "string" &&
    typeof value.status === "string" && Number.isSafeInteger(value.revision) &&
    Array.isArray(value.candidateIds) &&
    value.candidateIds.every((id) => typeof id === "string") &&
    Array.isArray(value.messages);
}
function graph(plan: WorkPlanRecord): WorkTaskDraft[] {
  return plan.tasks.map((task) => ({
    id: task.id,
    behaviorId: task.invocation.behavior.id,
    input: structuredClone(task.invocation.input),
    dependsOn: [...task.dependsOn],
  }));
}
function baseView(plan: WorkPlanRecord): WorkPlanResultView {
  return {
    format: WORK_PLAN_RESULT_FORMAT,
    id: plan.id,
    ...(plan.caseId ? { caseId: plan.caseId } : {}),
    callerId: plan.callerId,
    modelVersion: structuredClone(plan.modelVersion),
    ...(plan.origin ? { origin: structuredClone(plan.origin) } : {}),
    requestDigest: plan.requestDigest,
    revision: plan.revision,
    status: plan.status,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    graph: graph(plan),
    tasks: plan.tasks.map((task) => {
      const value = task.receipt?.result;
      const work = contribution(value) ? value : undefined;
      return {
        id: task.id,
        ...(task.caseId ? { caseId: task.caseId } : {}),
        state: task.state,
        resourceId: task.resourceId,
        invocationId: task.invocation.invocationId,
        behaviorId: task.invocation.behavior.id,
        targetNativeId: task.invocation.behavior.targetNativeId,
        modelVersion: structuredClone(task.invocation.modelVersion),
        ...(task.startedAt ? { startedAt: task.startedAt } : {}),
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
        artifacts: [],
        activityWindows: [],
        outputs: [],
        omitted: {
          attempts: task.attempts?.length ?? 0,
          messages: work?.messages.length ?? 0,
          sourceElementIds: work?.messages.reduce((count, message) =>
            count + (message.execution?.sourceIds?.length ?? 0), 0) ?? 0,
          artifacts: work?.artifacts?.length ?? 0,
          activityWindows: task.attempts?.length ?? 0,
          outputs: 0,
          contribution: work ? 1 : 0,
          verification: task.resultVerification ? 1 : 0,
          errors: task.error ? 1 : 0,
        },
      };
    }),
    journal: {
      kind: "work-plan-journal",
      planId: plan.id,
      revision: plan.revision,
      requestDigest: plan.requestDigest,
      callerId: plan.callerId,
      ...(plan.caseId ? { caseId: plan.caseId } : {}),
    },
    representation: "bounded-view-not-complete-evidence",
  };
}
function envelope(
  request: BehaviorInvocationRequest,
  view: WorkPlanResultView,
): BehaviorInvocationResult {
  return {
    ...(request.caseId ? { caseId: request.caseId } : {}),
    behaviorId: request.behavior.id,
    invocationId: request.invocationId,
    targetNativeId: request.behavior.targetNativeId,
    modelVersion: structuredClone(request.modelVersion),
    result: view,
  };
}
function requireFit(
  request: BehaviorInvocationRequest,
  view: WorkPlanResultView,
) {
  if (workPlanCallCharacters(envelope(request, view)) > MAX_CALL_CHARACTERS) {
    throw new Error(
      "Work plan refused: exact resume graph and mandatory result identities exceed the bounded native call representation",
    );
  }
}

/** Called before executor dispatch. The probe reserves bounded metadata sizes;
 * it is not published as a receipt or persisted as an execution observation. */
export function assertWorkPlanGraphFits(
  request: BehaviorInvocationRequest,
  plan: Pick<
    WorkPlanRecord,
    "id" | "caseId" | "callerId" | "modelVersion" | "origin" | "tasks"
  >,
) {
  const probe: WorkPlanRecord = {
    ...plan,
    requestDigest: "f".repeat(64),
    revision: Number.MAX_SAFE_INTEGER,
    status: "interrupted",
    createdAt: "9999-12-31T23:59:59.999Z",
    updatedAt: "9999-12-31T23:59:59.999Z",
    tasks: plan.tasks.map((task) => ({
      ...task,
      state: "interrupted",
      startedAt: "9999-12-31T23:59:59.999Z",
      completedAt: "9999-12-31T23:59:59.999Z",
    })),
  };
  const reserved = baseView(probe);
  // Runtime counts may grow after dispatch. Reserve their complete safe integer
  // representation; contribution/verification/error payloads are optional below.
  for (const task of reserved.tasks) {
    for (
      const key of Object.keys(task.omitted) as Array<keyof typeof task.omitted>
    ) task.omitted[key] = Number.MAX_SAFE_INTEGER;
  }
  requireFit(request, reserved);
}

function page(
  message: Message,
): { url: string; title: string; text: string } | undefined {
  if (message.role !== "tool") return;
  let value = message.observation?.kind === "tool-result"
    ? message.observation.value
    : undefined;
  if (
    value === undefined && message.text.startsWith("Résultat réel du tool ")
  ) {
    try {
      value = JSON.parse(message.text.slice(message.text.indexOf("\n") + 1));
    } catch {
      return;
    }
  }
  if (
    object(value) && typeof value.url === "string" &&
    typeof value.title === "string" && typeof value.text === "string"
  ) return { url: value.url, title: value.title, text: value.text };
}

/** The executor has already persisted the complete record. Only this immutable
 * transport view is recorded into chat/protocol history; replay does not rebuild it. */
export async function workPlanResultView(
  request: BehaviorInvocationRequest,
  plan: WorkPlanRecord,
): Promise<BehaviorInvocationResult> {
  const view = baseView(plan);
  requireFit(request, view);
  const fits = () =>
    workPlanCallCharacters(envelope(request, view)) <= MAX_CALL_CHARACTERS;
  for (const [index, task] of plan.tasks.entries()) {
    const target = view.tasks[index]!;
    const work = contribution(task.receipt?.result)
      ? task.receipt.result
      : undefined;
    if (work) {
      target.contribution = {
        agentId: work.agentId,
        correlationId: work.correlationId,
        invocationId: work.invocationId,
        status: work.status,
        revision: work.revision,
        candidateIds: work.candidateIds.slice(0, MAX_ITEMS),
        omittedCandidateIds: Math.max(0, work.candidateIds.length - MAX_ITEMS),
      };
      target.omitted.contribution = 0;
      if (!fits()) {
        delete target.contribution;
        target.omitted.contribution = 1;
      }
    }
    if (task.resultVerification) {
      target.verification = {
        status: task.resultVerification.status,
        observations: task.resultVerification.observations.length,
      };
      target.omitted.verification = 0;
      if (!fits()) {
        delete target.verification;
        target.omitted.verification = 1;
      }
    }
    if (task.error) {
      target.error = {
        code: task.error.code,
        message: task.error.message.slice(0, 512),
        omittedCharacters: Math.max(0, task.error.message.length - 512),
      };
    }
    if (target.error) {
      target.omitted.errors = 0;
      if (!fits()) {
        delete target.error;
        target.omitted.errors = 1;
      }
    }
    for (const artifact of work?.artifacts?.slice(0, MAX_ITEMS) ?? []) {
      target.artifacts.push({
        id: artifact.id,
        digest: artifact.digest,
        kind: artifact.kind,
        localStage: artifact.localStage,
        testsPassed: artifact.tests?.passed,
        activationConfirmed: artifact.activationConfirmed,
      });
      target.omitted.artifacts--;
      if (!fits()) {
        target.artifacts.pop();
        target.omitted.artifacts++;
        break;
      }
    }
    for (const attempt of (task.attempts ?? []).slice(-MAX_ITEMS)) {
      const result = attempt.receipt?.result;
      const observed = contribution(result) ? result : undefined;
      target.activityWindows.push({
        startedAt: attempt.startedAt,
        ...(attempt.returnedAt ? { returnedAt: attempt.returnedAt } : {}),
        state: attempt.state,
        invocationId: task.invocation.invocationId,
        ...(observed ? { correlationId: observed.correlationId } : {}),
        candidateIds: observed?.candidateIds.slice(0, MAX_ITEMS) ?? [],
        omittedCandidateIds: Math.max(
          0,
          (observed?.candidateIds.length ?? 0) - MAX_ITEMS,
        ),
      });
      target.omitted.activityWindows--;
      if (!fits()) {
        target.activityWindows.pop();
        target.omitted.activityWindows++;
        break;
      }
    }
    const outputs: Array<
      {
        message?: Message;
        kind: "tool-source" | "last-reply" | "result";
        value: unknown;
      }
    > = [];
    if (work) {
      for (const message of work.messages) {
        const source = page(message);
        if (source) {
          outputs.push({ message, kind: "tool-source", value: source });
        }
      }
      const last = work.messages.findLast((message) =>
        message.role === "assistant"
      );
      if (last) {
        outputs.push({ message: last, kind: "last-reply", value: last.text });
      }
    } else if (task.receipt) {
      outputs.push({ kind: "result", value: task.receipt.result });
    }
    target.omitted.outputs = outputs.length;
    for (const output of outputs.slice(-MAX_ITEMS)) {
      const serialized = JSON.stringify(output.value);
      if (serialized === undefined) continue;
      const valueDigest = await sha256(serialized);
      let accepted = false;
      for (const bound of [4096, 2048, 512, 128]) {
        const exact = serialized.length <= bound;
        const value = exact
          ? structuredClone(output.value)
          : output.kind === "tool-source"
          ? {
            ...(output.value as { url: string; title: string }),
            url: (output.value as { url: string }).url.slice(0, 1024),
            title: (output.value as { title: string }).title.slice(0, 512),
            text: (output.value as { text: string }).text.slice(0, bound),
          }
          : typeof output.value === "string"
          ? output.value.slice(0, bound)
          : serialized.slice(0, bound);
        const emitted = JSON.stringify(value).length;
        const message = output.message;
        target.outputs.push({
          kind: output.kind,
          reference: {
            ...(work ? { operatorId: work.agentId } : {}),
            ...(message
              ? {
                messageId: message.id,
                at: message.at,
                ...(message.caseId ? { caseId: message.caseId } : {}),
                ...(message.execution
                  ? {
                    modelVersion: {
                      digest: message.execution.digest,
                      ...(message.execution.repositoryVersion
                        ? {
                          repositoryVersion:
                            message.execution.repositoryVersion,
                        }
                        : {}),
                    },
                  }
                  : {}),
              }
              : {}),
          },
          value,
          valueDigest,
          omittedCharacters: exact
            ? 0
            : Math.max(1, serialized.length - emitted),
        });
        target.omitted.outputs--;
        if (fits()) {
          accepted = true;
          if (message) target.omitted.messages--;
          break;
        }
        target.outputs.pop();
        target.omitted.outputs++;
      }
      if (!accepted) continue;
    }
  }
  requireFit(request, view);
  return envelope(request, view);
}
