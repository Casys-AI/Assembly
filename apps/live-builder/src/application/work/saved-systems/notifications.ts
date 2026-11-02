/** Content-free advice: readers must recheck their own current source authority. */
export const RELEASE_CATALOGUE_INVALIDATED = "release-catalogue-invalidated";
export const RELEASE_CATALOGUE_INVALIDATION = Object.freeze({
  schemaVersion: 1,
});

export function isReleaseCatalogueInvalidation(value: unknown): boolean {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.keys(value).length === 1 &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1;
}

/** The adapter resolves commit only after its durable transaction completes.
 * A no-op/CAS loser is not a mutation. Delivery never changes committed results. */
export async function afterCommittedReleaseMutation<T>(
  commit: Promise<{ value: T; changed: boolean }>,
  notify: () => void,
): Promise<T> {
  const result = await commit;
  if (result.changed) {
    try {
      notify();
    } catch {
      // Advisory stream delivery cannot fail durable retention.
    }
  }
  return result.value;
}
