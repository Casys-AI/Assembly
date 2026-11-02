import { type ReadonlySignal, signal } from "@preact/signals";
import type { CurrentProviderResourceReadout } from "../../../../src/application/telemetry/current-provider-resources.ts";
import {
  type PerformanceApi,
  type PerformanceFailure,
  PerformanceReadError,
  type PerformanceSelection,
} from "./api.ts";

export interface PerformanceState {
  readonly key?: string;
  readonly status: "loading" | "ready" | PerformanceFailure;
  readonly readout?: CurrentProviderResourceReadout;
}
export const UNAVAILABLE_PERFORMANCE: PerformanceState = Object.freeze({
  status: "unavailable",
});
export const performanceKey = (
  selection: PerformanceSelection,
  sessionReady = false,
  sessionGeneration = 0,
) =>
  JSON.stringify([
    selection.caseId ?? null,
    selection.expectedVersion,
    sessionReady,
    sessionGeneration,
  ]);
export interface PerformanceStore {
  readonly state: ReadonlySignal<PerformanceState>;
  open(
    selection: PerformanceSelection | undefined,
    sessionReady?: boolean,
    refreshGeneration?: number,
    sessionGeneration?: number,
  ): Promise<void>;
  dispose(): void;
}

/** One current-selection snapshot. Advisory generations trigger authorized
 * rereads; bursts during a read collapse to one dirty follow-up, never deltas. */
export function createPerformanceStore(
  options: { api: Pick<PerformanceApi, "read"> },
): PerformanceStore {
  const state = signal<PerformanceState>(UNAVAILABLE_PERFORMANCE);
  type Flight = {
    key: string;
    selection: PerformanceSelection;
    controller: AbortController;
    dirty: boolean;
    promise: Promise<void>;
  };
  let active: Flight | undefined;
  let disposed = false;
  let lastGeneration: number | undefined;

  async function drain(flight: Flight): Promise<void> {
    do {
      flight.dirty = false;
      try {
        const readout = await options.api.read(
          flight.selection,
          flight.controller.signal,
        );
        if (disposed || active !== flight || flight.controller.signal.aborted) {
          return;
        }
        state.value = { key: flight.key, status: "ready", readout };
      } catch (failure) {
        if (disposed || active !== flight || flight.controller.signal.aborted) {
          return;
        }
        state.value = {
          key: flight.key,
          status: failure instanceof PerformanceReadError
            ? failure.state
            : "unavailable",
        };
      }
    } while (flight.dirty);
    if (active === flight) active = undefined;
  }

  return {
    state,
    open(
      selection,
      sessionReady = false,
      refreshGeneration = 0,
      sessionGeneration = 0,
    ) {
      if (disposed) return Promise.resolve();
      if (!selection) {
        active?.controller.abort();
        active = undefined;
        lastGeneration = undefined;
        state.value = UNAVAILABLE_PERFORMANCE;
        return Promise.resolve();
      }
      const requested = Object.freeze({
        expectedVersion: selection.expectedVersion,
        ...(selection.caseId === undefined ? {} : { caseId: selection.caseId }),
      });
      const key = performanceKey(requested, sessionReady, sessionGeneration);
      if (state.peek().key === key) {
        if (lastGeneration === refreshGeneration) {
          return active?.promise ?? Promise.resolve();
        }
        lastGeneration = refreshGeneration;
        if (active) {
          active.dirty = true;
          return active.promise;
        }
      }
      active?.controller.abort();
      lastGeneration = refreshGeneration;
      const flight: Flight = {
        key,
        selection: requested,
        controller: new AbortController(),
        dirty: false,
        promise: Promise.resolve(),
      };
      active = flight;
      state.value = { key, status: "loading" };
      flight.promise = drain(flight);
      return flight.promise;
    },
    dispose() {
      disposed = true;
      active?.controller.abort();
      active = undefined;
    },
  };
}
