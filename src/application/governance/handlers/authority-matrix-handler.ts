import { AuthorityMatrixService } from "../authority-matrix.ts";

/** Governance family handler: the named authority-matrix use case.
 *
 * Delegates to the existing AuthorityMatrixService mechanism. No logic
 * lives here; this module is the single owner that names the
 * authority-matrix surface for the hybrid family layout.
 */

/** Read versioned authority matrices through the cached service. */
export function ReadAuthorityMatrix(
  ...args: ConstructorParameters<typeof AuthorityMatrixService>
): AuthorityMatrixService {
  return new AuthorityMatrixService(...args);
}
