import { matchesExactRevision } from "../../../domain/shared-kernel/revision-id.ts";
/** Advice that a Case's model moved: its branch head, admitted source or the
 * version it runs. It carries versions only; a reader rechecks them through
 * its own authorized Case reads, so the event grants nothing. Browser-safe. */
export const CASE_MODEL_VERSION = "case-model-version";

export interface CaseModelVersion {
  schemaVersion: 1;
  caseId: string;
  /** The Case's branch head as its scope tells it (`commit:<40 hex>`). */
  branchVersion: string;
  /** The model the Case runs (`commit:<40 hex>`): the head of its pages. */
  executionVersion: string;
}

const CASE_IDENTITY = /^[A-Za-z0-9_-]{1,128}$/;
const KEYS = "branchVersion,caseId,executionVersion,schemaVersion";

export function isCaseModelVersion(value: unknown): value is CaseModelVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  return Object.keys(event).sort().join(",") === KEYS &&
    event.schemaVersion === 1 &&
    typeof event.caseId === "string" && CASE_IDENTITY.test(event.caseId) &&
    typeof event.branchVersion === "string" &&
    matchesExactRevision(event.branchVersion) &&
    typeof event.executionVersion === "string" &&
    matchesExactRevision(event.executionVersion);
}

/** A Case's versions as the host resolves them, with the owner they belong to. */
export interface CaseModelVersionRead {
  ownerId: string;
  branchVersion: string;
  executionVersion: string;
}

interface CaseModelVersionPorts {
  /** The Case's current versions, or null when it is no Request with a branch. */
  read(caseId: string): Promise<CaseModelVersionRead | null>;
  /** Hands the event to the owner's own streams, and to no other. */
  deliver(ownerId: string, event: CaseModelVersion): void | Promise<void>;
  onError?(error: unknown, caseId: string): void;
}

/**
 * Announces a Case's model when it changes. Whatever may have moved a Case (a
 * Request write, an adoption, an operator's settled turn) asks `observe`: the
 * Case is read again and only a change is delivered, once, to its owner. The
 * first observation of a Case in this process is announced, as the host's
 * `model-version` is after a start. Observations run one at a time; asking for
 * a Case whose observation has not started yet joins it. Failures are reported
 * and never reach the caller.
 */
export class CaseModelVersionEvents {
  readonly #last = new Map<string, string>();
  readonly #waiting = new Map<string, Promise<void>>();
  #tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly ports: CaseModelVersionPorts,
    /** How many Cases' last announcements are kept, the oldest let go first. */
    private readonly remembered = 1024,
  ) {}

  observe(caseId: string): Promise<void> {
    if (!CASE_IDENTITY.test(caseId)) return Promise.resolve();
    const waiting = this.#waiting.get(caseId);
    if (waiting) return waiting;
    const next = this.#tail.then(async () => {
      this.#waiting.delete(caseId);
      await this.#observe(caseId);
    });
    this.#waiting.set(caseId, next);
    this.#tail = next;
    return next;
  }

  async #observe(caseId: string): Promise<void> {
    try {
      const read = await this.ports.read(caseId);
      if (!read) {
        this.#last.delete(caseId);
        return;
      }
      const event: CaseModelVersion = {
        schemaVersion: 1,
        caseId,
        branchVersion: read.branchVersion,
        executionVersion: read.executionVersion,
      };
      if (!isCaseModelVersion(event) || !read.ownerId) {
        throw new Error("The Case versions read are not exact.");
      }
      const key =
        `${read.ownerId}\n${event.branchVersion}\n${event.executionVersion}`;
      if (this.#last.get(caseId) === key) return;
      this.#last.delete(caseId);
      this.#last.set(caseId, key);
      if (this.#last.size > this.remembered) {
        this.#last.delete(this.#last.keys().next().value!);
      }
      await this.ports.deliver(read.ownerId, event);
    } catch (error) {
      try {
        this.ports.onError?.(error, caseId);
      } catch { /* A diagnostic sink never fails the notification queue. */ }
    }
  }
}
