import type { ExecutableModel } from "../../../domain/model/execution/executable-model.ts";
import type { ChatDecision } from "../../work/conversation/chat-decision.ts";
import {
  invocationAdmission,
  type ToolInvocationAdmissionHost,
} from "../tool-invocation-admission.ts";

/** Governance family handler: the named tool-invocation-admission use case.
 *
 * Delegates to the existing invocationAdmission mechanism. No logic
 * lives here; this module is the single owner that names the tool
 * admission surface for the hybrid family layout.
 */

/** Admit a tool invocation against the active native catalog and mandate. */
export function AdmitToolInvocation(
  host: ToolInvocationAdmissionHost,
  decision: Extract<ChatDecision, { kind: "invoke_tool" }>,
  model: ExecutableModel,
): ReturnType<typeof invocationAdmission> {
  return invocationAdmission.call(host, decision, model);
}
