import { isRecord } from "../transport/is-record.ts";

/**
 * The host tells when the model moves: `model-version` on `/api/events`
 * (`ModelVersionEvent`, src/application/model-version-events.ts), when the
 * admitted head advances or a proposal is made or decided, and once on every
 * (re)connection. The workbench already holds that connection: it hands each
 * `model-version` event to `accept`, and this module tells whoever follows. It
 * opens no stream of its own. A reader of the model follows with one call and
 * reads the new version once, at its immutable address: it neither polls nor
 * knows the stream.
 */

/**
 * What the host announced of the model. The wire says `head`; it is `version`
 * here on purpose, the name every reader of a version already uses. The rest of
 * the event (the digest of the sources, the proposals of the journal) is not
 * read: nothing reads it, and what is not read is not checked.
 */
export interface ModelHead {
  /** The admitted head (`commit:<40 hex>`): a commit never changes. */
  version: string;
}

/**
 * What a follower does when the model moves: it reads the new `head`. What it
 * returns is not used. One that fails is reported and does not stop the others.
 */
export type ModelFollower = (head: ModelHead) => unknown;

export interface ModelLive {
  /**
   * Calls `read` once for each announcement that tells something new, until
   * the returned function is called.
   */
  follow(read: ModelFollower): () => void;
  /**
   * An announcement from the connection the workbench owns (`data` is the
   * event's text). One that is not an announcement is ignored.
   */
  accept(data: string | undefined): void;
}

/** The announcement the host made, or none when what arrived is not one. */
function readAnnouncement(data: string | undefined): ModelHead | undefined {
  if (!data) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  return isRecord(value) && typeof value.head === "string" && value.head
    ? { version: value.head }
    : undefined;
}

export function createModelLive(options: {
  /** Where the failure of a follower goes; the console when absent. */
  report?: (failure: unknown, head: ModelHead) => void;
} = {}): ModelLive {
  const followers = new Set<{ read: ModelFollower }>();
  /** The last announcement, as sent: the same one again tells nothing new. */
  let last: string | undefined;
  const report = options.report ??
    ((failure, head) =>
      console.error(
        `A reader of the model failed at ${head.version}.`,
        failure,
      ));

  /** A follower's failure, thrown at once or later, is told and goes no further. */
  async function tell(follower: { read: ModelFollower }, head: ModelHead) {
    try {
      await follower.read(head);
    } catch (failure) {
      report(failure, head);
    }
  }

  return {
    follow(read) {
      const follower = { read };
      followers.add(follower);
      return () => {
        followers.delete(follower);
      };
    },
    accept(data) {
      const head = readAnnouncement(data);
      // What arrives again (the host says where it stands on every connection)
      // was read when it first arrived.
      if (!head || data === last) return;
      last = data;
      for (const follower of [...followers]) void tell(follower, head);
    },
  };
}

/** The model of this tab: one word from the host, heard by every page that follows. */
export const modelLive: ModelLive = createModelLive();

/** A word that never comes: for a reader that must not follow the tab's model. */
export const silentModelLive: ModelLive = {
  follow: () => () => {},
  accept() {},
};
