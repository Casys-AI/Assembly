import type {
  ProviderCallHostScope,
  ProviderCallObservation,
  ProviderCallObservationStore,
} from "./provider-call.ts";

export const PROVIDER_RESOURCES_INVALIDATED = "provider-resources-invalidated";
export const PROVIDER_RESOURCE_INVALIDATION = Object.freeze({
  schemaVersion: 1,
});

/** A content-free advisory event. It carries neither read authority nor scope. */
export function isProviderResourceInvalidation(value: unknown): boolean {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.keys(value).length === 1 &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1;
}

/** Construction does not resolve a host that may not be registered yet.
 * append resolves after its independent transaction commits. Notification is
 * best effort and must not turn retained telemetry into a failed observation. */
export function createRetainedProviderCallSink(
  store: Pick<ProviderCallObservationStore, "append">,
  scope: () => ProviderCallHostScope,
  notify: () => void,
): (observation: ProviderCallObservation) => Promise<void> {
  return async (observation) => {
    const host = Object.freeze({ ...scope() });
    const result = await store.append(host, observation);
    if (result !== "inserted") return;
    try {
      notify();
    } catch {
      // Advisory delivery never changes persistence or provider outcomes.
    }
  };
}
