import {
  requestSpaceIdentity,
  type RequestSpaceScope,
} from "../../../domain/work/request-spaces/scope.ts";
import type { OpeningStorePort } from "./ports.ts";

/** Advisory only: read the changed Request through its authorized endpoint.
 * Browser-safe; neither conversation content nor authority crosses the stream. */
export const REQUEST_CONVERSATIONS_INVALIDATED =
  "request-conversations-invalidated";

export interface RequestConversationsInvalidation {
  schemaVersion: 1;
  caseId: string;
}

export function isRequestConversationsInvalidation(
  value: unknown,
): value is RequestConversationsInvalidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return Object.keys(event).sort().join(",") === "caseId,schemaVersion" &&
    event.schemaVersion === 1 && requestSpaceIdentity(event.caseId);
}

/** Resolve only the persisted Request owner; no model or conversation read is
 * needed for an advisory invalidation. The HTTP reader still checks authority. */
export function createRequestConversationOwnerReader(options: {
  scope: RequestSpaceScope;
  store: Pick<OpeningStorePort, "forCase">;
}): (caseId: string) => Promise<string | null> {
  return async (caseId) => {
    const record = await options.store.forCase(caseId);
    if (
      !record?.base || record.caseId !== caseId ||
      record.scope.projectId !== options.scope.projectId ||
      record.scope.systemId !== options.scope.systemId ||
      !["runtime-ready", "admitted", "dispatched"].includes(record.phase)
    ) return null;
    return record.ownerId;
  };
}

interface RequestConversationEventPorts {
  /** Resolve ownership from the persisted OpeningRecord in this host scope. */
  owner(caseId: string): Promise<string | null>;
  deliver(
    ownerId: string,
    event: RequestConversationsInvalidation,
  ): void | Promise<void>;
  onError?(error: unknown, caseId: string): void;
}

/** Coalesce waiting invalidations per Request, preserving one more pass when a
 * persisted change arrives during its observation. One slow Request does not
 * delay others. A failed read or delivery is reported and retried once, without
 * a timer; continued failure waits for another observation or reconnection. */
export class RequestConversationEvents {
  readonly #waiting = new Map<string, Promise<void>>();
  readonly #tails = new Map<string, Promise<void>>();
  #closed = false;

  constructor(private readonly ports: RequestConversationEventPorts) {}

  observe(caseId: string): Promise<void> {
    if (this.#closed || !requestSpaceIdentity(caseId)) return Promise.resolve();
    const waiting = this.#waiting.get(caseId);
    if (waiting) return waiting;
    const next = (this.#tails.get(caseId) ?? Promise.resolve()).then(
      async () => {
        this.#waiting.delete(caseId);
        for (let attempt = 0; attempt < 2 && !this.#closed; attempt++) {
          try {
            const ownerId = await this.ports.owner(caseId);
            if (!ownerId || this.#closed) return;
            await this.ports.deliver(ownerId, { schemaVersion: 1, caseId });
            return;
          } catch (error) {
            try {
              this.ports.onError?.(error, caseId);
            } catch { /* Diagnostics cannot fail committed work. */ }
          }
        }
      },
    ).finally(() => {
      if (this.#tails.get(caseId) === next) this.#tails.delete(caseId);
    });
    this.#waiting.set(caseId, next);
    this.#tails.set(caseId, next);
    return next;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.all(this.#tails.values());
  }
}
