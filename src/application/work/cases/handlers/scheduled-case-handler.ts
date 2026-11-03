import type { ScheduledCaseTrigger } from "../../operators/command-delivery.ts";
import {
  executeScheduledCase,
  type ScheduledExecutionHost,
} from "../scheduling.ts";

/** Cases family handler: the named scheduled use case.
 *
 * Delegates to the existing scheduling mechanism. No logic lives here;
 * this module is the single owner that names the scheduled surface for
 * the hybrid family layout (session vs pg-boss dispatch lifecycles).
 */

/** Execute one admitted scheduled Case run under its durable receipt. */
export function RunScheduledCase(
  host: ScheduledExecutionHost,
  input: { id: string; caseId: string; trigger: ScheduledCaseTrigger },
): Promise<void> {
  return executeScheduledCase.call(host, input);
}
