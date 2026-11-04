import { spaceSessionSecret } from "../adapters/in/http/work/space-session.ts";
import {
  CASE_MODEL_VERSION,
  CaseModelVersionEvents,
  type CaseModelVersionRead,
} from "../application/work/request-spaces/case-model-notifications.ts";
import type { SpaceControlPort } from "../application/work/request-spaces/ports.ts";
import {
  REQUEST_CONVERSATIONS_INVALIDATED,
  RequestConversationEvents,
} from "../application/work/request-spaces/conversation-notifications.ts";
import { RequestSpaceError } from "../domain/work/request-spaces/scope.ts";
import { type SpaceController } from "../domain/work/request-spaces/space-control.ts";
import { SseAudience } from "../infrastructure/http/sse.ts";

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

/** The private Request events of the workbench's one stream. Sessions join
 * their owner's audience and are revalidated for every delivery. Events carry
 * model versions or invalidations, never content or credentials. */
export function createCaseModelEvents(options: {
  versions(caseId: string): Promise<CaseModelVersionRead | null>;
  conversationOwner(caseId: string): Promise<string | null>;
  controls: SpaceControlPort;
  onError?(error: unknown, caseId: string): void;
}) {
  const audience = new SseAudience<SpaceController>();
  let closed = false;
  const deliver = (ownerId: string, name: string, event: unknown) =>
    audience.send(
      async (controller) => {
        if (closed || controller.ownerId !== ownerId) return false;
        try {
          await options.controls.revalidate(controller);
        } catch (error) {
          if (
            error instanceof RequestSpaceError &&
            error.context?.session === "invalid"
          ) audience.disconnect(controller);
          throw error;
        }
        return !closed;
      },
      name,
      event,
    );
  const events = new CaseModelVersionEvents({
    read: options.versions,
    deliver: (ownerId, event) => deliver(ownerId, CASE_MODEL_VERSION, event),
    onError: options.onError,
  });
  const conversations = new RequestConversationEvents({
    owner: options.conversationOwner,
    deliver: (ownerId, event) =>
      deliver(ownerId, REQUEST_CONVERSATIONS_INVALIDATED, event),
    onError: options.onError,
  });
  return {
    /** Something may have moved this Case's model: read it again. */
    observe: (caseId: string) =>
      closed ? Promise.resolve() : events.observe(caseId),
    /** A Request conversation changed after persistence. */
    observeConversations: (caseId: string) => conversations.observe(caseId),
    async close() {
      closed = true;
      await Promise.all([events.close(), conversations.close()]);
    },
    eventAudience: {
      identify: async (request: Request) =>
        await options.controls.authenticateSession(
          spaceSessionSecret(request),
        ),
      audience,
    },
  };
}
