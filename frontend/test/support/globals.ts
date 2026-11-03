/** Globals a test puts in place: `fetch` keeps its type, the rest is free. */
export type Globals = { fetch?: typeof fetch } & Record<string, unknown>;

/**
 * Puts these globals in place and returns what puts back the ones they
 * replaced, and removes the ones that were not there. For a fixture that hands
 * its restore to the test; a test of its own uses `withGlobals`.
 */
export function replaceGlobals(globals: Globals): () => void {
  const before = Object.keys(globals).map((name) =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
  );
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return () => {
    for (const [name, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}

/** Runs `work` with these globals in place, and restores them however it ends. */
export async function withGlobals<T>(
  globals: Globals,
  work: () => T | Promise<T>,
): Promise<T> {
  const restore = replaceGlobals(globals);
  try {
    return await work();
  } finally {
    restore();
  }
}
