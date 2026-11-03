import type { CaseSchedule } from "../value-objects/case-schedule.ts";
import type { ExecutableModel } from "../../model/execution/executable-model.ts";

/** Source-declared work kinds are descriptive; they confer no execution rights. */
export interface NativeCaseType {
  id: string;
  name: string;
  type: "request" | "job" | "watch";
  envelope: "conversational" | "deterministic" | "reassessment";
  behaviorId: string;
  ownerId: string;
  maxInvocations?: number;
  /** Native SysML Every or DailyAt value; UTC. */
  schedule?: CaseSchedule;
  sourceIds: string[];
}

/** Historical contracts keep their exact encoding. The implicit Request is a
 * runtime interpretation of their admitted 1.3 envelope, never a model edit.
 */
export function caseTypesForModel(model: ExecutableModel): NativeCaseType[] {
  const explicit = structuredClone(model.caseTypes ?? []);
  // New team-only contracts deliberately declare no independent Request type.
  // The implicit type is compatibility for historical contracts, not a new right.
  if (model.operatorTeam) return explicit;
  if (
    explicit.length && (explicit.some((type) => type.type === "request") ||
      !explicit.some((type) => type.schedule))
  ) return explicit;
  const envelope = model.configuration.envelope;
  if (
    envelope.kind !== "conversational-case-management" ||
    envelope.pattern !== "1.3" || envelope.revision !== 1
  ) throw new Error("Unsupported implicit Request envelope");
  return [...explicit, {
    id: `${model.identity.systemId}:request`,
    name: "Request",
    type: "request",
    envelope: "conversational",
    behaviorId: model.flows.conversation.rootNativeId,
    ownerId: model.identity.builderId,
    ...(model.workBudgetPolicy
      ? { maxInvocations: model.workBudgetPolicy.limit }
      : {}),
    sourceIds: [...model.version.sourceIds],
  }];
}
