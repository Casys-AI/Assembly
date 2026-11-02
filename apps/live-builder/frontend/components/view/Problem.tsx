import type { ComponentChildren } from "preact";

/** What went wrong, as a page tells it: a code, a sentence, what the host said. */
export interface ProblemFacts {
  /** For whatever reads the page after a program (`data-code`). */
  code: string;
  /** For the person. */
  message: string;
  /** What the host said, as it said it. */
  detail?: string;
  /** The code the host gave (`data-host-code`), when it spoke in its envelope. */
  hostCode?: string;
  /** What the host says to do about it. */
  recovery?: string;
}

/**
 * The one paragraph a page uses for what failed: the sentence for the person,
 * what the host said under it (its words, then its code and what it says to
 * do), and the page's code in `data-code`. `subject` names who
 * it is about when the page holds several of them; `children` sit at its end,
 * where a page puts its way to try again.
 */
export function Problem(
  { problem, subject, children }: {
    problem: ProblemFacts;
    subject?: string;
    children?: ComponentChildren;
  },
) {
  return (
    <p
      class="proposal-error"
      role="alert"
      data-code={problem.code}
      {...(problem.hostCode ? { "data-host-code": problem.hostCode } : {})}
    >
      {subject && (
        <>
          <strong class="rev-subject">{subject}</strong>
          {": "}
        </>
      )}
      {problem.message}
      {problem.detail && <span class="rev-host-says">{problem.detail}</span>}
      {(problem.hostCode || problem.recovery) && (
        <span class="rev-host-says">
          {problem.hostCode && (
            <code class="rev-host-code">{problem.hostCode}</code>
          )}
          {problem.recovery}
        </span>
      )}
      {children}
    </p>
  );
}
