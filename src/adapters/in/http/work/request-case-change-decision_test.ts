import { deepStrictEqual, equal } from "node:assert/strict";
import {
  type ConversationsApplication,
  createConversationsHandler,
} from "./conversations.ts";
import type { RequestCaseConversationsPort } from "../../../../application/work/request-spaces/conversations.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces.ts";

const origin = "http://127.0.0.1:4311";
const secret = "a".repeat(64);
Deno.test("scoped change decision selects exact Case and session without Main fallback", async () => {
  const calls: unknown[] = [];
  const application = {
    get snapshot() {
      throw new Error("Main lookup");
    },
  } as unknown as ConversationsApplication;
  const scoped = {
    conversations: () => {
      throw new Error("Unexpected read");
    },
    submitHuman: () => {
      throw new Error("Unexpected submission");
    },
    decideChange(session, command) {
      calls.push({ session, command });
      return Promise.resolve({ status: "published-awaiting-adoption" });
    },
  } satisfies Pick<
    RequestCaseConversationsPort,
    "conversations" | "submitHuman" | "decideChange"
  >;
  const handler = createConversationsHandler(application, origin, scoped);
  const command = {
    caseId: "case-a",
    expectedRevision: 7,
    configurationRevision: 2,
    verdict: "approve",
  };
  const request = (path: string, body: unknown, cookie = true) =>
    new Request(origin + path, {
      method: "POST",
      headers: {
        origin,
        host: "127.0.0.1:4311",
        "content-type": "application/json",
        ...(cookie ? { cookie: `assembly-space-session=${secret}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const result = await handler(
    request(
      "/api/conversations/operator/changes/change-a/decision?space=requests",
      command,
    ),
  );
  equal(result!.status, 202);
  deepStrictEqual(await result!.json(), {
    status: "published-awaiting-adoption",
  });
  deepStrictEqual(calls, [{
    session: secret,
    command: { agentId: "operator", changeId: "change-a", ...command },
  }]);
  for (
    const bad of [
      { ...command, caseId: "" },
      { ...command, scope: "main" },
      { ...command, verdict: "yes" },
    ]
  ) {
    equal(
      (await handler(
        request(
          "/api/conversations/operator/changes/change-a/decision?space=requests",
          bad,
        ),
      ))!.status,
      400,
    );
  }
  equal(
    (await handler(
      request(
        "/api/conversations/operator/changes/change-a/decision?space=requests",
        command,
        false,
      ),
    ))!.status,
    403,
  );
  equal(calls.length, 1);
});

Deno.test("scoped decision refusal is terminal and cannot route to Main", async () => {
  let main = 0;
  const application = {
    get snapshot() {
      main++;
      throw new Error("Main lookup");
    },
  } as unknown as ConversationsApplication;
  const scoped = {
    conversations: () => {
      throw new Error("Unexpected read");
    },
    submitHuman: () => {
      throw new Error("Unexpected submission");
    },
    decideChange() {
      throw new RequestSpaceError("FORBIDDEN", "not authorized");
    },
  } satisfies Pick<
    RequestCaseConversationsPort,
    "conversations" | "submitHuman" | "decideChange"
  >;
  const response = await createConversationsHandler(
    application,
    origin,
    scoped,
  )(
    new Request(
      origin +
        "/api/conversations/operator/changes/change-a/decision?space=requests",
      {
        method: "POST",
        headers: {
          origin,
          host: "127.0.0.1:4311",
          "content-type": "application/json",
          cookie: `assembly-space-session=${secret}`,
        },
        body: JSON.stringify({
          caseId: "case-a",
          expectedRevision: 1,
          configurationRevision: 1,
          verdict: "approve",
        }),
      },
    ),
  );
  equal(response!.status, 403);
  equal(main, 0);
});
