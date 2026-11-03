import { mayConsultModel } from "../../../domain/model/consultation/model-read-policy.ts";
import { ReadCurrentCase } from "../cases/handlers/case-lifecycle-handler.ts";
import type { SystemRuntimeState } from "../../../domain/work/dialogue.ts";
import type { ModelExecutionReference } from "../../../domain/model/execution/executable-model.ts";
import { modelContextTools } from "../../../domain/model/consultation/context.ts";
import {
  caseExecutionContext,
  designerExecutionContext,
} from "../cases/runtime.ts";

/** Shared canonical framing of one already-applied mutation. No ports, effects,
 * authorization, asynchronous work or resource mutations occur here. */
export function normalizeRuntimeMutation(
  previous: SystemRuntimeState,
  next: SystemRuntimeState,
  options: {
    execution?: ModelExecutionReference;
    hasConsultModel: boolean;
    /** Projection prepared from next's exact model outside final SQL locks. */
    modelTools?: SystemRuntimeState["modelTools"];
  },
): void {
  const caseContext = caseExecutionContext(next) ??
    (next.caseInvocation ? undefined : caseExecutionContext(previous));
  const caseId = caseContext?.caseId;
  const designer = designerExecutionContext(next);
  for (const event of next.events.slice(previous.events.length)) {
    if (caseId && !event.effectiveModelUpdate) event.caseId ??= caseId;
  }
  for (const message of next.messages.slice(previous.messages.length)) {
    if (caseId) message.caseId ??= caseId;
    else if (designer) message.designerScopeId ??= designer.scopeId;
  }
  const caseRecord = ReadCurrentCase(next);
  if (caseRecord) caseRecord.status = next.busy ? "open" : "waiting";
  if (options.hasConsultModel) {
    next.modelTools =
      next.executionModel && mayConsultModel(next.executionModel.policy)
        ? options.modelTools ?? modelContextTools()
        : [];
  } else delete next.modelTools;
  if (options.execution) {
    for (const event of next.events.slice(previous.events.length)) {
      event.execution ??= structuredClone(options.execution);
    }
    for (const message of next.messages.slice(previous.messages.length)) {
      message.execution ??= structuredClone(options.execution);
    }
  }
  next.revision = previous.revision + 1;
}
