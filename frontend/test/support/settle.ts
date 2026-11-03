/**
 * Lets the work in flight finish: `turns` turns of the event loop, each one
 * draining the promises queued before it and running the timers due at once.
 * Twenty turns cover a read, its parse and the renders it causes; a test that
 * needs more says so. Under fake timers, step the clock instead.
 */
export async function settle(turns = 20): Promise<void> {
  for (let turn = 0; turn < turns; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
