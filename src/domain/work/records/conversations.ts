/** Technical capacity of the admitted operator registry; never a creation grant. */
export const MAX_OPERATOR_UNITS = 64;

/** Shared ordinary delivery workers; Main has one additional reserved worker. */
export const MAX_ACTIVE_AGENTS = 16;

/** Whole-team bound inside one Request branch (spec 4.8e, settled Q5). */
export const MAX_BRANCH_TEAM = 3;

/**
 * The single bound for free human text, counted in `String.length`.
 * It is not a JSON Schema bound, so it does not use `characterCount`.
 * Longer input is refused at the HTTP/application boundary. The full
 * accepted text stays in the journal. What reaches the LLM is compacted
 * separately: historical messages are truncated to the context policy's
 * `maxMessageCharacters` with the journal marker, the current message
 * keeps verbatim only while the whole projection fits and is truncated
 * the same way beyond that, and a Case objective derived from the text
 * is truncated to `MAX_CASE_OBJECTIVE_CHARS` in `domain/cases.ts`. An exact
 * re-reading of a message through its journal evidence stays subject to the
 * 262,144-byte restitution bound (`src/adapters/information-behavior.ts:192`)
 * and to `policy.maxContextCharacters`: beyond either, it fails explicitly.
 */
export const MAX_USER_MESSAGE_CHARS = 100_000;
