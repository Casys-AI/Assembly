import {
  type CodedProblem,
  problemOf,
  requestFailure,
  RevisionRequestError,
  type VersionProblemCode,
  versionProblemOf,
} from "./revisions/api.ts";
import { UnreadableAnswer } from "../transport/unreadable-answer.ts";

/**
 * What the versioned routes of the model (`/api/model/board`,
 * `/api/model/authority-matrix`) have in common, said once. Without a version a
 * route reads the admitted head, which moves, and says which commit it read in
 * `x-model-version`; with one (`commit:<40 hex>`, as the host spells it) it
 * reads that commit, which never changes. A failure is the host's
 * `{code, context, recovery}`; each client turns it, and everything else that
 * can go wrong, into a coded problem its page can act on.
 */

/**
 * One read of a versioned route: the body as the host sent it, and the commit
 * it describes (the version asked, else the one the host says it read; an
 * answer that does not say is an `UnreadableAnswer`). The client of the route
 * checks the body, since what it must look like is its own contract.
 */
export async function readVersioned(
  request: typeof fetch,
  path: string,
  version: string | undefined,
  signal?: AbortSignal,
): Promise<{ body: unknown; version: string }> {
  const query = version === undefined
    ? ""
    : `?${new URLSearchParams({ version })}`;
  // A commit never changes, so the browser may keep its answer; the head is always asked.
  const response = await request(`${path}${query}`, {
    signal,
    ...(version === undefined ? { cache: "no-store" as const } : {}),
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw requestFailure(response, body);
  const read = version ?? response.headers.get("x-model-version");
  if (!read) {
    throw new UnreadableAnswer(
      "The answer does not say which version of the model it describes.",
    );
  }
  return { body, version: read };
}

/** A coded problem and what the host said of it, as it said it. */
export interface ReadProblem<Code extends string = string>
  extends CodedProblem<Code> {
  /** The code the host gave, as it gave it. */
  hostCode?: string;
  /** What the host says to do about it. */
  recovery?: string;
  /** Seconds the host asks to wait before reading again. */
  retryAfter?: number;
}

/** The codes of a route's own: what a page does about each is its client's to say. */
export interface ReadCodes<Code extends string> {
  /** The Toolkit did not answer in time: reading again may work. */
  timeout: Code;
  /** The host could not be reached. */
  unavailable: Code;
  /** The host answered, but not with a body the page can read. */
  invalid: Code;
  /** The host failed to project it. */
  failed: Code;
}

/** The codes of a route, and the words the person is told each in. */
export interface ReadProblems<Code extends string> extends ReadCodes<Code> {
  messages: Readonly<Record<Code | VersionProblemCode, string>>;
}

/**
 * Reading again helps when the host or the Toolkit did not answer, not when
 * the version is refused or the answer is not one a page can use.
 */
export const canRetry = <Code extends string>(
  problem: Pick<ReadProblem, "code">,
  codes: ReadCodes<Code>,
): boolean =>
  problem.code === codes.timeout || problem.code === codes.unavailable ||
  problem.code === codes.failed;

/**
 * The one way a page turns a failed read into a coded problem. `asked` says
 * whether the read named a version: the version may be refused only then,
 * since a head that is not found is the host's failure, not a version the
 * person got wrong.
 */
export function readProblemOf<Code extends string>(
  failure: unknown,
  asked: boolean,
  codes: ReadProblems<Code>,
): ReadProblem<Code | VersionProblemCode> {
  if (failure instanceof RevisionRequestError) {
    const code: Code | VersionProblemCode =
      (asked ? versionProblemOf(failure) : undefined) ??
        (failure.code === "TOOLKIT_TIMEOUT" ? codes.timeout : codes.failed);
    return {
      ...problemOf(code, codes.messages[code], failure),
      ...(failure.code ? { hostCode: failure.code } : {}),
      ...(failure.recovery ? { recovery: failure.recovery } : {}),
      ...(failure.retryAfter !== undefined
        ? { retryAfter: failure.retryAfter }
        : {}),
    };
  }
  const code = failure instanceof UnreadableAnswer
    ? codes.invalid
    : codes.unavailable;
  return problemOf(code, codes.messages[code], failure);
}
