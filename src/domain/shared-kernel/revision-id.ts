/** A model revision is an immutable Git commit, never a mutable branch name. */
declare const modelRevisionId: unique symbol;
export type ModelRevisionId = string & { readonly [modelRevisionId]: true };

export function parseModelRevisionId(value: string): ModelRevisionId {
  if (!matchesExactRevision(value)) {
    throw new Error("Expected an immutable model commit identity");
  }
  return value as ModelRevisionId;
}

export function modelCommitHash(revision: ModelRevisionId): string {
  return revision.slice("commit:".length);
}

/** Format only: preserves RegExp coercion and exceptions; this is not a type guard. */
export function matchesExactRevision(value: unknown): boolean {
  return /^commit:[a-f0-9]{40}$/.test(value as string);
}
