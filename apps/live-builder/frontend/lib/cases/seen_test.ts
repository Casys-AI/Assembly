import { deepStrictEqual, equal } from "node:assert/strict";
import type { AgentConversation } from "../../../src/domain/work/records/conversations.ts";
import { caseActivity, createCaseSeen } from "./seen.ts";

const conversation = (
  messages: object[],
) => ({ messages } as unknown as AgentConversation);

Deno.test("a Case's activity is the latest message the viewer did not write", () => {
  deepStrictEqual(
    caseActivity([
      conversation([
        { role: "user", at: "2026-10-24T12:00:00Z", caseId: "a" },
        { role: "assistant", at: "2026-10-24T11:00:00Z", caseId: "a" },
        { role: "assistant", at: "2026-10-24T10:00:00Z" },
      ]),
      conversation([
        { role: "tool", at: "2026-10-24T11:30:00Z", caseId: "a" },
        { role: "assistant", at: "2026-10-24T09:00:00Z", caseId: "b" },
      ]),
    ]),
    { a: "2026-10-24T11:30:00Z", b: "2026-10-24T09:00:00Z" },
  );
});

Deno.test("on a first load what exists is seen; only what happens next lights a Case", () => {
  localStorage.clear();
  const seen = createCaseSeen();
  // Before the viewer's record is known, activity lights nothing.
  equal(seen.unseen("a", "2026-10-24T10:00:00Z"), false);
  seen.load("system");
  equal(seen.unseen("a", "2026-10-24T10:00:00Z"), false);
  seen.baseline({ a: "2026-10-24T10:00:00Z" });
  equal(seen.unseen("a", "2026-10-24T10:00:00Z"), false);
  // New activity, and a Case created after the baseline.
  equal(seen.unseen("a", "2026-10-24T11:00:00Z"), true);
  equal(seen.unseen("b", "2026-10-24T11:00:00Z"), true);
  // Opening it marks it seen, and the viewer's storage keeps that.
  seen.mark("a", "2026-10-24T11:00:00Z");
  equal(seen.unseen("a", "2026-10-24T11:00:00Z"), false);
  const again = createCaseSeen();
  again.load("system");
  again.baseline({ a: "2026-10-24T12:00:00Z" });
  equal(again.unseen("a", "2026-10-24T12:00:00Z"), true);
  equal(again.unseen("b", "2026-10-24T11:00:00Z"), true);
  localStorage.clear();
});

Deno.test("an older activity never unmarks what was seen", () => {
  localStorage.clear();
  const seen = createCaseSeen();
  seen.load("system");
  seen.mark("a", "2026-10-24T11:00:00Z");
  seen.mark("a", "2026-10-24T10:00:00Z");
  equal(seen.seen.value.a, "2026-10-24T11:00:00Z");
  equal(seen.unseen("a", undefined), false);
  localStorage.clear();
});

Deno.test("legacy Case activity is retained while new seen times use Assembly", () => {
  localStorage.clear();
  try {
    const legacy = '{ "a": "2026-10-24T11:00:00Z" }';
    localStorage.setItem("ase:seen:system", legacy);
    const seen = createCaseSeen();
    seen.load("system");
    equal(seen.unseen("a", "2026-10-24T11:00:00Z"), false);
    equal(seen.unseen("a", "2026-10-24T12:00:00Z"), true);
    equal(localStorage.getItem("assembly:seen:system"), legacy);
    seen.mark("a", "2026-10-24T12:00:00Z");
    equal(localStorage.getItem("ase:seen:system"), legacy);
    const reopened = createCaseSeen();
    reopened.load("system");
    equal(reopened.unseen("a", "2026-10-24T12:00:00Z"), false);
  } finally {
    localStorage.clear();
  }
});
