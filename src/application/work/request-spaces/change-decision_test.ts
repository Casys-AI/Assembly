import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { RequestCaseConversations } from "./conversations.ts";
import {
  type OpeningRecord,
  RequestSpaceError,
  type SpaceController,
} from "../../../domain/work/request-spaces.ts";

Deno.test("Request decision requires the authenticated owner, exact Case and admitted operator", async () => {
  const host = { projectId: "project", systemId: "system" };
  const controller = { ownerId: "human" } as SpaceController;
  const record = {
    id: "opening",
    scope: host,
    ownerId: "human",
    phase: "dispatched",
    caseId: "case",
    base: { requestOwner: { operatorId: "native" } },
  } as OpeningRecord;
  let enabled = true, admitted = true, calls = 0;
  const seen: unknown[] = [];
  const app = new RequestCaseConversations({
    scope: host,
    control: {
      authenticateSession(secret) {
        if (!enabled || secret !== "session") {
          throw new RequestSpaceError("FORBIDDEN", "session");
        }
        return Promise.resolve(controller);
      },
      revalidate() {
        if (!enabled) throw new RequestSpaceError("FORBIDDEN", "revoked");
        return Promise.resolve();
      },
    },
    store: {
      forCase: (id) => Promise.resolve(id === record.caseId ? record : null),
      forOwner: () => Promise.resolve([record]),
    },
    admissions: {
      assertConversation() {
        if (!admitted) {
          throw new RequestSpaceError("ADMISSION_REFUSED", "revoked");
        }
        return Promise.resolve();
      },
    },
    runtime: {
      closeCase: () => {
        throw new Error("unexpected close");
      },
      read: () => {
        throw new Error("unexpected read");
      },
      submitHuman: () => {
        throw new Error("unexpected send");
      },
    },
    changeDecision: {
      decide(secret, selected, command) {
        calls++;
        seen.push({ secret, selected, command });
        return Promise.resolve({ status: "pending" });
      },
    },
  });
  const command = {
    caseId: "case",
    agentId: "native",
    changeId: "change",
    expectedRevision: 2,
    configurationRevision: 1,
    verdict: "approve" as const,
  };
  deepStrictEqual(await app.decideChange("session", command), {
    status: "pending",
  });
  equal(calls, 1);
  deepStrictEqual(seen, [{ secret: "session", selected: record, command }]);
  await rejects(() =>
    app.decideChange("session", { ...command, caseId: "other" })
  );
  await rejects(() =>
    app.decideChange("session", { ...command, agentId: "foreign" })
  );
  admitted = false;
  await rejects(() => app.decideChange("session", command));
  admitted = true;
  enabled = false;
  await rejects(() => app.decideChange("session", command));
  equal(calls, 1);
});
