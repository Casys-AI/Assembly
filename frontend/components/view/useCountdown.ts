import { useEffect, useState } from "preact/hooks";

/**
 * Whole seconds left to wait, counting down from `seconds` once a second until
 * none is left. `since` is whatever starts the wait again when it is a new
 * one (a failure that arrives after another). `tick` is the length of a
 * second; a test shortens it.
 */
export function useCountdown(
  seconds: number | undefined,
  since: unknown,
  tick = 1000,
): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    let remaining = Math.max(0, Math.ceil(seconds ?? 0));
    setLeft(remaining);
    if (remaining === 0) return;
    const timer = setInterval(() => {
      remaining -= 1;
      setLeft(remaining);
      if (remaining === 0) clearInterval(timer);
    }, tick);
    return () => clearInterval(timer);
  }, [seconds, since, tick]);
  return left;
}
