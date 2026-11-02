import type { ModelBoard } from "../../../../src/domain/model/records/board.ts";
import { parseModelBoard } from "./parse.ts";
import {
  versionMessages,
  type VersionProblemCode,
} from "../../model/revisions/api.ts";
import {
  canRetry,
  type ReadCodes,
  type ReadProblem,
  readProblemOf,
  readVersioned,
} from "../../model/versioned-read.ts";

/**
 * The one client of the board: `GET /api/model/board`, the table the System
 * pages are drawn from, read the way every versioned route is (see
 * `readVersioned`).
 */

/**
 * What went wrong, for a program to act on; `message` is for the person. The
 * version asked for may be refused (`VersionProblemCode`): only when one was
 * asked, since the head is not a version a person names.
 */
export type BoardProblemCode =
  | VersionProblemCode
  /** The Toolkit did not answer in time: reading again may work. */
  | "board-timeout"
  /** The host could not be reached. */
  | "board-unavailable"
  /** The host answered, but not with a board this page can read. */
  | "board-invalid"
  /** The host failed to project the board. */
  | "board-failed";

export type BoardProblem = ReadProblem<BoardProblemCode>;

/** What the board's reads fail with: the codes of `BoardProblemCode`. */
const CODES: ReadCodes<BoardProblemCode> = {
  timeout: "board-timeout",
  unavailable: "board-unavailable",
  invalid: "board-invalid",
  failed: "board-failed",
};

/**
 * The one way a page turns a failed read into a coded problem. `asked` says
 * whether the read named a version: a head that is not found is the host's
 * failure, not a version the person got wrong.
 */
export function boardProblem(
  failure: unknown,
  asked: boolean = false,
): BoardProblem {
  return readProblemOf<BoardProblemCode>(failure, asked, {
    ...CODES,
    messages: {
      ...versionMessages,
      "board-timeout": "The system took too long to read.",
      "board-unavailable": "The system could not be read.",
      "board-invalid": "The system was read in a form this page cannot use.",
      "board-failed": "The system could not be read.",
    },
  });
}

/** Reading again helps when the host or the Toolkit did not answer, not when the version is refused or the answer is not a board. */
export const boardCanRetry = (problem: Pick<BoardProblem, "code">): boolean =>
  canRetry(problem, CODES);

/** A board, and the commit of the model it describes. */
export interface BoardRead {
  board: ModelBoard;
  /** The immutable commit the board describes: the head's when none was asked. */
  version: string;
}

export function createBoardApi(
  options: { fetch?: typeof fetch } = {},
) {
  const request = options.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    /**
     * The board of `version`, or of the head without one. A commit never
     * changes, so the browser may keep its answer; the head is always asked.
     */
    async read(version?: string, signal?: AbortSignal): Promise<BoardRead> {
      const read = await readVersioned(
        request,
        "/api/model/board",
        version,
        signal,
      );
      return { board: parseModelBoard(read.body), version: read.version };
    },
  };
}

export type BoardApi = ReturnType<typeof createBoardApi>;
