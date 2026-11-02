import type { ModelVersionEvent } from "../../../src/application/model/revisions/ports/out/version-events.port.ts";
import { parseModelRevisionId } from "../../../src/domain/shared-kernel/revision-id.ts";
import { createModelLive, type ModelLive } from "../../lib/model/live.ts";

/**
 * The host's `model-version` event as it sends it: typed by the host's own
 * `ModelVersionEvent`, so a fixture cannot drift from what is on the wire.
 */
export const announcement = (
  head: string,
  proposals = { pending: 0, digest: "journal-0" },
): string => {
  const event: ModelVersionEvent = {
    head: parseModelRevisionId(head),
    sourceDigest: `sources-of-${head}`,
    proposals,
  };
  return JSON.stringify(event);
};

/**
 * The model of a tab, with the host's word handed to it as the workbench does
 * with each `model-version` event of its connection. `tell` is the host
 * announcing that the model is at `head`, to whoever follows.
 */
export function modelFeed(): {
  live: ModelLive;
  tell(head: string, proposals?: { pending: number; digest: string }): void;
} {
  const live = createModelLive();
  return {
    live,
    tell: (head, proposals) => live.accept(announcement(head, proposals)),
  };
}
