import { deepStrictEqual, equal } from "node:assert/strict";
import type { RequestCaseConversationsPort } from "../../../../application/work/request-spaces/conversations.ts";
import { RequestSpaceError } from "../../../../domain/work/request-spaces.ts";
import { type CasesApplication, createCasesHandler } from "./cases.ts";
import {
  type ConversationsApplication,
  createConversationsHandler,
} from "./conversations.ts";

const origin = "http://127.0.0.1:4311";
const cookie = `assembly-space-session=${"a".repeat(64)}`;
function fixture() {
  const main: string[] = [], scopedCalls: unknown[] = [];
  const denyMain = () => {
    main.push("Main");
    throw new Error("Main must not be addressed");
  };
  const cases = {
    get cases() {
      return denyMain();
    },
  } as unknown as CasesApplication;
  const conversations = {
    get snapshot() {
      return denyMain();
    },
    submitHuman: denyMain,
  } as unknown as ConversationsApplication;
  let fail = false;
  const scoped: RequestCaseConversationsPort = {
    cases(secret, caseId) {
      scopedCalls.push({ kind: "cases", secret, caseId });
      if (fail) throw new RequestSpaceError("FORBIDDEN", "unavailable");
      return Promise.resolve({
        systemId: "host",
        cases: [{ id: "caseA" }] as never,
      });
    },
    conversations(secret, caseId) {
      scopedCalls.push({ kind: "conversations", secret, caseId });
      if (fail) throw new RequestSpaceError("FORBIDDEN", "unavailable");
      return Promise.resolve({
        systemId: "host",
        defaultAgentId: "operator",
        version: "v",
        conversations: [],
      });
    },
    submitHuman(secret, command) {
      scopedCalls.push({ kind: "submit", secret, command });
      if (fail) throw new RequestSpaceError("FORBIDDEN", "unavailable");
      return Promise.resolve(command.caseId);
    },
  };
  const caseHandler = createCasesHandler(cases, origin, scoped);
  const conversationHandler = createConversationsHandler(
    conversations,
    origin,
    scoped,
  );
  return {
    main,
    scopedCalls,
    caseHandler,
    conversationHandler,
    fail: () => {
      fail = true;
    },
  };
}
function get(path: string, withCookie = true) {
  return new Request(origin + path, { headers: withCookie ? { cookie } : {} });
}
function post(path: string, body: unknown, withCookie = true) {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      host: "127.0.0.1:4311",
      origin,
      "content-type": "application/json",
      ...(withCookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}
Deno.test("scoped Case collection and detail preserve existing DTOs and never read Main", async () => {
  const f = fixture();
  equal((await f.caseHandler(get("/api/cases?space=requests")))!.status, 200);
  const detail = await f.caseHandler(get("/api/cases/caseA?space=requests"));
  deepStrictEqual(await detail!.json(), {
    systemId: "host",
    case: { id: "caseA" },
  });
  f.fail();
  equal(
    (await f.caseHandler(get("/api/cases/missing?space=requests")))!.status,
    403,
  );
  for (
    const path of [
      "/api/cases?space=main",
      "/api/cases?space=requests&space=requests",
    ]
  ) {
    equal((await f.caseHandler(get(path)))!.status, 400);
  }
  equal(
    (await f.caseHandler(get("/api/cases?space=requests", false)))!.status,
    403,
  );
  deepStrictEqual(f.main, []);
});
Deno.test("scoped conversation read and message keep explicit selection and revision", async () => {
  const f = fixture();
  equal(
    (await f.conversationHandler(get("/api/conversations?caseId=caseA")))!
      .status,
    200,
  );
  const body = {
    caseId: "caseA",
    expectedRevision: 17,
    text: "Continue exact Case",
  };
  const sent = await f.conversationHandler(
    post("/api/conversations/operator/messages?space=requests", body),
  );
  equal(sent!.status, 202);
  deepStrictEqual(await sent!.json(), { accepted: true, caseId: "caseA" });
  deepStrictEqual(f.scopedCalls.at(-1), {
    kind: "submit",
    secret: "a".repeat(64),
    command: { agentId: "operator", ...body },
  });
  f.fail();
  equal(
    (await f.conversationHandler(
      post("/api/conversations/operator/messages?space=requests", body),
    ))!.status,
    403,
  );
  equal(
    (await f.conversationHandler(get("/api/conversations?caseId=missing")))!
      .status,
    403,
  );
  deepStrictEqual(f.main, []);
});
Deno.test("unsupported scoped commands and client scopes fail before any Main lookup", async () => {
  const f = fixture();
  const body = { caseId: "caseA", expectedRevision: 17, text: "Continue" };
  for (
    const [path, input] of [
      ["/api/conversations/operator/messages?space=requests", {
        ...body,
        operatorScope: "Main",
      }],
      ["/api/conversations/operator/messages?space=requests", {
        ...body,
        newConversation: true,
      }],
      [
        "/api/conversations/operator/messages?space=requests&space=requests",
        body,
      ],
      ["/api/conversations/operator/decisions?space=requests", body],
      ["/api/messages?space=requests", body],
    ] as const
  ) {
    equal((await f.conversationHandler(post(path, input)))!.status, 400);
  }
  equal(
    (await f.conversationHandler(
      post("/api/conversations/operator/messages?space=requests", body, false),
    ))!.status,
    403,
  );
  equal(
    (await f.conversationHandler(
      get("/api/conversations?caseId=caseA&caseId=caseB"),
    ))!.status,
    400,
  );
  equal(
    (await f.conversationHandler(
      get("/api/conversations/operator/unknown?space=requests"),
    ))!.status,
    404,
  );
  deepStrictEqual(f.main, []);
  deepStrictEqual(f.scopedCalls, []);
});
