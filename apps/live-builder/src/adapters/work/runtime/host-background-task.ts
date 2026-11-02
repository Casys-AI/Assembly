import { AsyncLocalStorage } from "node:async_hooks";

/** Bind during host bootstrap, before operator deliveries start. Background
 * work then retains the host context without inheriting a caller's claim,
 * transaction fence or graph configuration. Ordinary delivery contexts remain
 * unchanged. The returned callback may schedule asynchronous work. */
export function bindHostBackgroundTask<Args extends unknown[], Result>(
  task: (...args: Args) => Result,
): (...args: Args) => Result {
  return AsyncLocalStorage.bind(task);
}
