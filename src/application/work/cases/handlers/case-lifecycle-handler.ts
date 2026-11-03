import { OperatorCases } from "../operators.ts";
import { closeCaseById, currentCase } from "../runtime.ts";

/** Cases family handler: the named lifecycle use cases.
 *
 * Each use case delegates to its existing opening/runtime/operators
 * mechanism. No logic lives here; this module is the single owner that
 * names the lifecycle surface for the hybrid family layout.
 */

/** Close a Case by id with an explicit outcome. */
export function CloseCase(
  ...args: Parameters<typeof closeCaseById>
): ReturnType<typeof closeCaseById> {
  return closeCaseById(...args);
}

/** Pilot the Cases owned by all registered operators. */
export function PilotCase(
  ...args: ConstructorParameters<typeof OperatorCases>
): OperatorCases {
  return new OperatorCases(...args);
}

/** Read the currently selected open local Case, if any. */
export function ReadCurrentCase(
  ...args: Parameters<typeof currentCase>
): ReturnType<typeof currentCase> {
  return currentCase(...args);
}
