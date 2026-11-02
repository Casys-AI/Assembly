import { runTurn } from "../turn.ts";
import type { ConversationTurnHost } from "../turn-context.ts";

/** Conversation family handler: the named conversation use case.
 *
 * The single entry delegates to the existing `runTurn` mechanism. No logic
 * lives here; this module is the single owner that names the conversation
 * surface for the hybrid family layout. Node steps (choose, check,
 * invoke, submit, observe) stay internal steps of the family flow,
 * not top-level use cases.
 */

/** Execute one admitted conversation turn through the native flow. */
export function ExecuteConversationTurn(
  host: ConversationTurnHost,
  ...args: Parameters<typeof runTurn>
): ReturnType<typeof runTurn> {
  return runTurn.call(host, ...args);
}
