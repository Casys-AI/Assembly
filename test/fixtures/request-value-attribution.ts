import type { Event, Message } from "../../src/domain/work/dialogue.ts";
import type { PageResult } from "../../src/domain/work/candidates.ts";
import {
  WORK_PLAN_RESULT_FORMAT,
  type WorkPlanResultView,
} from "../../src/application/work/plans/result-view.ts";
import type { MainCandidateInspection } from "../../src/application/work/operators/conversations.ts";

/** Historical inspection omissions are valid only after the exact previously
 * observed candidate was decided. Missing current detail must stop the driver. */
export function currentCandidateInspection(
  messages: readonly Message[],
  decided: ReadonlySet<string>,
  observed: ReadonlyMap<string, string>,
): MainCandidateInspection | undefined {
  let current: MainCandidateInspection | undefined;
  for (const message of messages) {
    if (message.observation?.kind !== "candidate-inspection") continue;
    const value = message.observation.value as MainCandidateInspection & {
      $contextOmission?: { reason?: string };
    };
    if (value?.$contextOmission?.reason === "historical-inspection") {
      const candidateId = observed.get(message.id);
      if (!candidateId || !decided.has(candidateId)) {
        throw new Error(
          "Historical inspection was omitted before its exact observed decision",
        );
      }
      continue;
    }
    if (
      !value?.candidate?.id || !value.candidate.digest ||
      !value.candidate.code ||
      !value.candidate.tests?.passed || !value.contract ||
      !value.authorityExercise ||
      !value.decisionReference ||
      observed.get(message.id) !== value.candidate.id
    ) {
      throw new Error(
        "Current candidate inspection is incomplete or was not observed exactly",
      );
    }
    if (!decided.has(value.candidate.id)) current = value;
  }
  return current;
}

/** Latest host-observed revision of each versioned view, never model prose. */
export function recordedWorkPlans(
  messages: readonly Message[],
): WorkPlanResultView[] {
  const plans = new Map<string, WorkPlanResultView>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const feedback = recordedFeedback(
      message,
      "behavior-result",
      "Résultat observé du comportement ",
    ) as { result?: WorkPlanResultView } | undefined;
    const plan = feedback?.result;
    if (
      plan?.format !== WORK_PLAN_RESULT_FORMAT || typeof plan.id !== "string" ||
      !Array.isArray(plan.graph) || !Array.isArray(plan.tasks) ||
      !Number.isSafeInteger(plan.revision)
    ) continue;
    if (!plans.has(plan.id) || plans.get(plan.id)!.revision < plan.revision) {
      plans.set(plan.id, plan);
    }
  }
  return [...plans.values()];
}

/** Compare actual candidate-bearing activity windows, excluding waiting gaps.
 * Full historical receipts stay in the referenced durable plan journal. */
export function parallelPreparationEvidence(
  plans: readonly WorkPlanResultView[],
  caseId: string,
  callerId: string,
  assignments: readonly {
    id: string;
    resourceId: string;
    url: string;
    candidateId: string;
  }[],
) {
  if (
    assignments.length !== 2 ||
    new Set(assignments.map((item) => item.resourceId)).size !== 2
  ) return;
  for (const plan of plans) {
    if (
      plan.caseId !== caseId || plan.callerId !== callerId ||
      plan.status !== "completed"
    ) continue;
    const tasks = assignments.map((assignment) =>
      plan.tasks.find((task) => {
        const graph = plan.graph.find((node) => node.id === task.id);
        return task.id === assignment.id &&
          task.resourceId === assignment.resourceId && task.caseId === caseId &&
          task.state === "completed" &&
          task.modelVersion.digest === plan.modelVersion.digest &&
          task.modelVersion.repositoryVersion ===
            plan.modelVersion.repositoryVersion &&
          graph?.behaviorId === task.behaviorId &&
          typeof graph.input.text === "string" &&
          graph.input.text.includes(assignment.url) &&
          /prepar/i.test(graph.input.text) &&
          task.contribution?.agentId === assignment.resourceId &&
          task.contribution.invocationId === task.invocationId;
      })
    );
    if (
      tasks.some((task) => !task) ||
      tasks[0]!.invocationId === tasks[1]!.invocationId
    ) continue;
    const windows = tasks.map((task, index) =>
      task!.activityWindows.filter((window) =>
        window.invocationId === task!.invocationId &&
        window.correlationId === task!.contribution!.correlationId &&
        window.candidateIds.includes(assignments[index]!.candidateId)
      )
    );
    for (const first of windows[0]!) {
      for (const second of windows[1]!) {
        if (first.correlationId === second.correlationId) continue;
        const starts = [first, second].map((window) =>
          Date.parse(window.startedAt)
        );
        const ends = [first, second].map((window) =>
          Date.parse(window.returnedAt ?? "")
        );
        if (
          [...starts, ...ends].every(Number.isFinite) &&
          starts.every((start, index) => start < ends[index]!) &&
          starts[0]! < ends[1]! && starts[1]! < ends[0]!
        ) {
          return {
            planId: plan.id,
            revision: plan.revision,
            caseId,
            callerId,
            modelVersion: plan.modelVersion,
            tasks: tasks.map((task, index) => ({
              id: task!.id,
              resourceId: task!.resourceId,
              invocationId: task!.invocationId,
              behaviorId: task!.behaviorId,
              candidateId: assignments[index]!.candidateId,
              correlationId: [first, second][index]!.correlationId,
              startedAt: [first, second][index]!.startedAt,
              returnedAt: [first, second][index]!.returnedAt,
            })),
          };
        }
      }
    }
  }
}

/** Read a host-written observation, including its legacy textual representation. */
export function recordedFeedback(
  message: Message,
  kind: string,
  prefix: string,
): unknown {
  if (message.observation?.kind === kind) return message.observation.value;
  if (message.role !== "tool" || !message.text.startsWith(prefix)) {
    return undefined;
  }
  const newline = message.text.indexOf("\n");
  if (newline < 0) return undefined;
  try {
    return JSON.parse(message.text.slice(newline + 1));
  } catch {
    return undefined;
  }
}

export function recordedToolPages(messages: readonly Message[]): PageResult[] {
  const pages: PageResult[] = [];
  for (const message of messages) {
    const value = recordedFeedback(
      message,
      "tool-result",
      "Résultat réel du tool ",
    );
    if (!value || typeof value !== "object") continue;
    const item = value as Partial<PageResult>;
    if (
      typeof item.url === "string" && typeof item.title === "string" &&
      typeof item.text === "string" && item.title.trim() && item.text.trim()
    ) {
      pages.push({ url: item.url, title: item.title, text: item.text });
    }
  }
  return pages;
}

/** One call, one completed event and one feedback record in an operator state
 * uniquely connect a page result to the candidate. Multiple calls or results
 * are deliberately ambiguous: timestamps and list positions are not identities. */
export function soleToolPageEvidence(
  messages: readonly Message[],
  events: readonly Event[],
  expectedUrl: string,
): {
  page: PageResult;
  candidateId?: string;
  callEventId?: string;
  completionEventId?: string;
  limitation?: string;
} | undefined {
  const pages = recordedToolPages(messages);
  const matching = pages.filter((page) => page.url === expectedUrl);
  if (matching.length !== 1) return undefined;
  const called = events.filter((event) => event.kind === "tool-called");
  const completed = events.filter((event) => event.kind === "tool-completed");
  if (
    pages.length !== 1 || called.length !== 1 || completed.length !== 1 ||
    !called[0]!.candidateId ||
    called[0]!.candidateId !== completed[0]!.candidateId ||
    called[0]!.caseId !== completed[0]!.caseId ||
    events.indexOf(called[0]!) >= events.indexOf(completed[0]!)
  ) {
    return {
      page: matching[0]!,
      limitation:
        "The retained events and feedback do not uniquely identify the producing candidate.",
    };
  }
  return {
    page: matching[0]!,
    candidateId: called[0]!.candidateId,
    callEventId: called[0]!.id,
    completionEventId: completed[0]!.id,
  };
}
