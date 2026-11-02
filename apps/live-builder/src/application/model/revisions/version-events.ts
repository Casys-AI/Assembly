import { canonicalDigest } from "../../../domain/primitives/execution-digest.ts";
import {
  canonical,
  compareCodeUnits,
} from "../../../domain/primitives/canonical-json.ts";
import {
  parseModelRevisionId,
} from "../../../domain/shared-kernel/revision-id.ts";
import type {
  ModelVersionAttentionPort,
  ModelVersionEvent,
  ModelVersionEventEmitter,
  ModelVersionEventSource,
} from "./ports/out/version-events.port.ts";

/** Design notifications use admitted HEAD, never an isolated proposal version. */
export class ModelVersionEvents {
  #last?: string;
  #queue: Promise<void> = Promise.resolve();
  #attentionFollowUps = new Set<string>();
  constructor(
    private readonly repository: ModelVersionEventSource,
    private readonly emit: ModelVersionEventEmitter,
    private readonly attention?: ModelVersionAttentionPort,
    private readonly onAttentionError?: (
      error: unknown,
      version: string,
    ) => void,
  ) {}

  async #read(): Promise<ModelVersionEvent> {
    // This is an advisory version notification, not an admission check. A
    // verified immutable source header is sufficient; do not rematerialize a
    // full compiled artifact just to announce the published commit.
    const version = this.repository.headVersion && this.repository.header
      ? await this.repository.headVersion()
      : undefined;
    const head = version && this.repository.header
      ? await this.repository.header(version)
      : await this.repository.current();
    const proposals = (await this.repository.readProposalJournal()).map(
      (proposal) => ({
        id: proposal.id,
        status: proposal.status,
        sourceDigest: proposal.sourceDigest,
        proposalVersion: proposal.proposalVersion ?? null,
        acceptedVersion: proposal.acceptedVersion ?? null,
      }),
    ).sort((a, b) => compareCodeUnits(a.id, b.id));
    const digest = await canonicalDigest(proposals);
    const value: ModelVersionEvent = {
      head: parseModelRevisionId(head.version),
      sourceDigest: head.sourceDigest,
      proposals: {
        pending:
          proposals.filter((proposal) =>
            ["preparing", "proposed", "accepting"].includes(proposal.status)
          ).length,
        digest,
      },
    };
    if (this.attention) {
      const count = this.attention.peekCount(value.head);
      if (count !== undefined) {
        value.attention = { count };
      } else {
        this.#warmAttention(value.head);
      }
    }
    return value;
  }

  /** Starts the attention computation without delaying the event, then
   * publishes once more so the count reaches clients when it is ready. At
   * most one follow-up is scheduled per version; a failed warm is reported
   * to the edge hook and its marker removed so a later event can retry. */
  #warmAttention(version: string) {
    if (!this.attention || this.#attentionFollowUps.has(version)) return;
    this.#attentionFollowUps.add(version);
    if (this.#attentionFollowUps.size > 32) {
      this.#attentionFollowUps.delete(
        this.#attentionFollowUps.values().next().value!,
      );
    }
    void this.attention.warm(version)
      .then(() => this.publish())
      .catch((error) => {
        this.#attentionFollowUps.delete(version);
        try {
          this.onAttentionError?.(error, version);
        } catch { /* The edge hook must never fail the notification queue. */ }
      });
  }

  async initial(): Promise<ModelVersionEvent> {
    const value = await this.#read();
    this.#last ??= canonical(value);
    return value;
  }

  /** Serialize notifications; an unchanged model/journal (e.g. a comment) is silent. */
  publish(): Promise<void> {
    const next = this.#queue.then(async () => {
      const previous = this.#last;
      const value = await this.#read();
      const key = canonical(value);
      if (previous !== key) {
        this.emit("model-version", value);
        this.#last = key;
      }
    });
    this.#queue = next.catch(() => {});
    return next;
  }
}
