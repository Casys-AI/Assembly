import { ModelContextLink } from "./ModelContextLink.tsx";
import { Problem, type ProblemFacts } from "./Problem.tsx";
import { useCountdown } from "./useCountdown.ts";

/**
 * A read that failed, as a page tells it: the problem, then the ways out. Read
 * again, when reading again can help: the button waits the seconds the host
 * asked to wait, and while a read is under way. Show current model, when the
 * page was reading a named version, retains its Main or Case source context.
 */
export function ReadFailure(
  { problem, again, home }: {
    problem: ProblemFacts;
    again?: {
      run(): void;
      /** A read is in flight. */
      busy?: boolean;
      /** Seconds the host asks to wait before reading again. */
      wait?: number;
    };
    /** The same page at its current model, retaining the source context. */
    home?: string;
  },
) {
  const left = useCountdown(again?.wait, problem);
  return (
    <Problem problem={problem}>
      {again && (
        <button
          type="button"
          class="rev-retry"
          disabled={again.busy || left > 0}
          onClick={again.run}
        >
          {left > 0 ? `Try again in ${left} s` : "Try again"}
        </button>
      )}
      {home && (
        <ModelContextLink class="rev-retry" href={home}>
          Show current model
        </ModelContextLink>
      )}
    </Problem>
  );
}
