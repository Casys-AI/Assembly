import type { ModelPort } from "../../../runtime/ports.ts";

/** Model boundary consumed by the candidates family handler.
 *
 * Owned by the candidates handler (lot 9 split of the 15+-method
 * `ModelPort` per consuming handler). The runtime still supplies the
 * full `ModelPort`; candidates only observe these three methods:
 * compile the admitted model, publish one admitted candidate, and
 * recover its exact binding.
 */
export type CandidateModelPort = Pick<
  ModelPort,
  "activateCandidate" | "readExecutableModel" | "findCandidate"
>;

/** Read-only model boundary for the initial-tools preparation. */
export type CandidateModelReaderPort = Pick<
  CandidateModelPort,
  "readExecutableModel"
>;
