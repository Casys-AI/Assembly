import { spaceSessionSecret } from "../adapters/in/http/work/space-session.ts";
import {
  CASE_MODEL_VERSION,
  CaseModelVersionEvents,
  type CaseModelVersionRead,
} from "../application/work/request-spaces/case-model-notifications.ts";
import type { SpaceControlPort } from "../application/work/request-spaces/ports.ts";
import type { SpaceController } from "../domain/work/request-spaces.ts";
import { SseAudience } from "../infrastructure/http/sse.ts";

/**
 * The Case model events of the workbench's one event stream: a stream opened
 * with a Request session joins its owner's audience, and a Case's versions,
 * observed again whenever something may have moved them, reach only that
 * owner's streams, each session revalidated at delivery. The event carries
 * versions, never a secret.
 */
/**
 * A successful Request write (not a read) that answers for a Case may have
 * moved that Case's model: the Case it names is observed again, after the
 * answer, which is returned unchanged. `applies` narrows which routes count.
 */
export function observeCaseWrites(
  handler: (request: Request) => Promise<Response | null>,
  observe: (caseId: string) => void,
  applies: (url: URL) => boolean = () => true,
): (request: Request) => Promise<Response | null> {
  return async (request) => {
    const response = await handler(request);
    if (
      response?.ok && !["GET", "HEAD"].includes(request.method) &&
      applies(new URL(request.url))
    ) {
      void response.clone().json().then((body: unknown) => {
        const caseId = (body as { caseId?: unknown } | null)?.caseId;
        if (typeof caseId === "string") observe(caseId);
      }, () => {});
    }
    return response;
  };
}

export function createCaseModelEvents(options: {
  versions(caseId: string): Promise<CaseModelVersionRead | null>;
  controls: SpaceControlPort;
  onError?(error: unknown, caseId: string): void;
}) {
  const audience = new SseAudience<SpaceController>();
  const events = new CaseModelVersionEvents({
    read: options.versions,
    deliver: (ownerId, event) =>
      audience.send(
        async (controller) => {
          if (controller.ownerId !== ownerId) return false;
          await options.controls.revalidate(controller);
          return true;
        },
        CASE_MODEL_VERSION,
        event,
      ),
    onError: options.onError,
  });
  return {
    /** Something may have moved this Case's model: read it again. */
    observe: (caseId: string) => events.observe(caseId),
    eventAudience: {
      identify: async (request: Request) =>
        await options.controls.authenticateSession(
          spaceSessionSecret(request),
        ),
      audience,
    },
  };
}
