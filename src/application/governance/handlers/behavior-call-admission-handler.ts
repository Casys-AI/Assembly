import { admitBehaviorCall } from "../behavior-call-admission.ts";

/** Governance family handler: the named behavior-call-admission use case.
 *
 * Delegates to the existing admitBehaviorCall mechanism. No logic lives
 * here; this module is the single owner that names the behavior
 * admission surface for the hybrid family layout.
 */

/** Admit an exact modeled behavior call; the target flow keeps its domain predicates. */
export function AdmitBehaviorCall(
  ...args: Parameters<typeof admitBehaviorCall>
): ReturnType<typeof admitBehaviorCall> {
  return admitBehaviorCall(...args);
}
