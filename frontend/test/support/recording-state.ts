import type { ConversationsSnapshot } from "../../../src/application/work/operators/conversation-types.ts";
import { createWorkbenchState } from "../../lib/workbench/state.ts";
import { operatorRoster } from "./operator-fixture.ts";
import { snapshot } from "./workbench-fixture.ts";

/**
 * A state whose host answers with the roster, and accepts every message unless
 * `accepting` is false: it then refuses them as it does a message past its bound.
 */
export function recordingState(
  roster: ConversationsSnapshot = operatorRoster(),
  accepting = true,
) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const current = snapshot();
  current.candidates = [];
  const state = createWorkbenchState({
    initialState: current,
    fetch: (path, init) => {
      if (init?.method === "POST") {
        posts.push({ path, body: JSON.parse(String(init.body)) });
        return Promise.resolve(
          accepting
            ? Response.json({ accepted: true }, { status: 202 })
            : Response.json({ error: "Invalid message." }, { status: 400 }),
        );
      }
      return Promise.resolve(
        path === "/api/conversations"
          ? Response.json(roster)
          : Response.json({}, { status: 404 }),
      );
    },
  });
  state.agentConversations.accept(roster);
  return { state, posts };
}
