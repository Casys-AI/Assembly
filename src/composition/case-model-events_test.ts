import { deepStrictEqual, equal } from "node:assert/strict";
import {
  createCaseModelEvents,
  observeCaseWrites,
} from "./case-model-events.ts";
import { SPACE_SESSION_COOKIE } from "../adapters/in/http/work/space-session.ts";
import {
  CASE_MODEL_VERSION,
  type CaseModelVersionRead,
  isCaseModelVersion,
} from "../application/work/request-spaces/case-model-notifications.ts";
import type { SpaceController } from "../domain/work/request-spaces.ts";
import type { SseClient } from "../infrastructure/http/sse.ts";

const a = `commit:${"a".repeat(40)}`;
const b = `commit:${"b".repeat(40)}`;
const secret = (owner: string) => owner.repeat(64).slice(0, 64);

Deno.test("a Case's model change reaches its owner's streams once, and no foreign or revoked stream", async () => {
  const versions: Record<string, CaseModelVersionRead> = {
    "case-A": { ownerId: "a", branchVersion: a, executionVersion: a },
  };
  const revoked = new Set<string>();
  const events = createCaseModelEvents({
    versions: (caseId) => Promise.resolve(versions[caseId] ?? null),
    controls: {
      authenticateSession: (value) =>
        Promise.resolve({
          ownerId: value[0],
          sessionId: value,
        } as unknown as SpaceController),
      revalidate: (controller) =>
        revoked.has((controller as SpaceController).sessionId)
          ? Promise.reject(new Error("revoked"))
          : Promise.resolve(),
    },
  });
  const frames = new Map<string, unknown[]>();
  const open = async (name: string, cookie?: string) => {
    frames.set(name, []);
    const client = {
      enqueue(bytes: Uint8Array) {
        const [event, data] = new TextDecoder().decode(bytes).split("\n");
        equal(event, `event: ${CASE_MODEL_VERSION}`);
        frames.get(name)!.push(JSON.parse(data.slice("data: ".length)));
      },
    } as unknown as SseClient;
    let member: SpaceController | undefined;
    try {
      member = await events.eventAudience.identify(
        new Request("http://127.0.0.1/api/events", {
          headers: cookie ? { cookie } : {},
        }),
      );
    } catch {
      member = undefined;
    }
    if (member) events.eventAudience.audience.join(client, member);
  };
  await open("owner", `${SPACE_SESSION_COOKIE}=${secret("a")}`);
  await open(
    "other tab",
    `${SPACE_SESSION_COOKIE}=${secret("a").slice(0, 63)}0`,
  );
  await open("foreign", `${SPACE_SESSION_COOKIE}=${secret("b")}`);
  await open("revoked", `${SPACE_SESSION_COOKIE}=${secret("a").slice(0, 63)}1`);
  await open("anonymous");
  revoked.add(`${secret("a").slice(0, 63)}1`);

  await events.observe("case-A");
  await events.observe("case-A");
  versions["case-A"] = { ownerId: "a", branchVersion: b, executionVersion: a };
  await events.observe("case-A");
  await events.observe("case-A");
  versions["case-A"] = { ownerId: "a", branchVersion: b, executionVersion: b };
  await events.observe("case-A");

  const told = [
    {
      schemaVersion: 1,
      caseId: "case-A",
      branchVersion: a,
      executionVersion: a,
    },
    {
      schemaVersion: 1,
      caseId: "case-A",
      branchVersion: b,
      executionVersion: a,
    },
    {
      schemaVersion: 1,
      caseId: "case-A",
      branchVersion: b,
      executionVersion: b,
    },
  ];
  deepStrictEqual(frames.get("owner"), told);
  deepStrictEqual(frames.get("other tab"), told);
  deepStrictEqual(frames.get("foreign"), []);
  deepStrictEqual(frames.get("revoked"), []);
  deepStrictEqual(frames.get("anonymous"), []);
  for (const frame of told) equal(isCaseModelVersion(frame), true);
});

Deno.test("only a successful Request write naming its Case observes that Case again", async () => {
  const observed: string[] = [];
  const answers: Record<string, Response> = {};
  const handler = observeCaseWrites(
    (request) => {
      const answer =
        answers[`${request.method} ${new URL(request.url).pathname}`];
      return Promise.resolve(answer ?? null);
    },
    (caseId) => observed.push(caseId),
    (url) => url.searchParams.get("space") !== "main",
  );
  const call = async (method: string, path: string, answer?: Response) => {
    if (answer) {
      answers[`${method} ${new URL(path, "http://h").pathname}`] = answer;
    }
    const response = await handler(new Request(`http://h${path}`, { method }));
    if (response) await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await call(
    "POST",
    "/adopt",
    Response.json({ caseId: "case-A", status: "adopted" }),
  );
  await call("GET", "/scope", Response.json({ caseId: "case-B" }));
  await call(
    "POST",
    "/refused",
    Response.json({ caseId: "case-C" }, { status: 409 }),
  );
  await call(
    "POST",
    "/elsewhere?space=main",
    Response.json({ caseId: "case-D" }),
  );
  await call("POST", "/anonymous", Response.json({ accepted: true }));
  await call("POST", "/text", new Response("not json"));
  await call("POST", "/not-mine");
  deepStrictEqual(observed, ["case-A"]);
});
