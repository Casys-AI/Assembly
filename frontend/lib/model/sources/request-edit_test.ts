import assert from "node:assert/strict";
import {
  createRequestSourceEditor,
  type RequestEditScope,
  requestSourceIntentKey,
} from "./request-edit.ts";
import {
  RequestSourceApiError,
  type RequestSourceProposal,
} from "./request-revisions.ts";
const base = `commit:${"a".repeat(40)}`, next = `commit:${"b".repeat(40)}`;
export const editScope: RequestEditScope = {
  caseId: "case-a",
  branchId: "branch-a",
  executionSpaceId: "space-a",
  viewedVersion: base,
  admittedVersion: base,
  executionVersion: base,
  sessionReady: true,
};
export function editHarness(
  options: {
    storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  } = {},
) {
  const data = new Map<string, string>(),
    calls: string[] = [],
    confirmed: string[] = [];
  let unauthorized = 0;
  const storage = options.storage === null ? undefined : options.storage ?? {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
  const response: RequestSourceProposal = {
    caseId: "case-a",
    id: "proposal-a",
    baseVersion: base,
    proposalVersion: next,
    sourceDigest: "c".repeat(64),
    createdAt: "now",
    reason: "why",
    diff: [{
      path: "core.sysml",
      kind: "changed",
      before: "old",
      after: "new",
    }],
  };
  const behavior = {
    propose: () => Promise.resolve(structuredClone(response)),
    accept: () => Promise.resolve(),
    resume: () =>
      Promise.resolve({
        caseId: "case-a",
        version: next,
        sourceDigest: "c".repeat(64),
      }),
  };
  const api = {
    propose: (
      input: {
        expectedVersion: string;
        path: string;
        text: string;
        reason: string;
      },
    ) => {
      calls.push(`propose:${input.expectedVersion}`);
      return behavior.propose();
    },
    accept: (id: string) => {
      assert.equal(
        JSON.parse(storage!.getItem(requestSourceIntentKey(editScope))!)
          .acceptAttempted,
        true,
        "identity persisted before send",
      );
      calls.push(`accept:${id}`);
      return behavior.accept();
    },
    resume: (id: string) => {
      calls.push(`resume:${id}`);
      return behavior.resume();
    },
  };
  const build = () =>
    createRequestSourceEditor({
      scope: editScope,
      api,
      storage,
      onConfirmed: (id) => confirmed.push(id),
      onUnauthorized: () => {
        unauthorized++;
      },
    });
  const editor = build();
  const draft = () => {
    editor.start("core.sysml", "old", base);
    editor.text("new");
    editor.reason("why");
  };
  return {
    editor,
    response,
    calls,
    behavior,
    storage,
    data,
    confirmed,
    build,
    draft,
    unauthorized: () => unauthorized,
  };
}
Deno.test("propose uncertainty retains draft without replay, publication claim or acceptance", async () => {
  const h = editHarness();
  h.draft();
  h.behavior.propose = () => Promise.reject(new Error("lost proposal ACK"));
  await h.editor.propose();
  assert.equal(h.editor.draft.peek()?.text, "new");
  assert.equal(h.editor.proposal.peek(), null);
  assert.match(h.editor.message.peek()!, /No publication is confirmed/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.editor.canAccept(), false);
});
Deno.test("different proposal base or server before/after never enables approval", async () => {
  for (
    const changed of [{ baseVersion: next }, {
      diff: [{
        path: "core.sysml",
        kind: "changed" as const,
        before: "another",
        after: "new",
      }],
    }]
  ) {
    const h = editHarness();
    h.draft();
    Object.assign(h.response, changed);
    await h.editor.propose();
    assert.equal(h.editor.proposal.peek(), null);
    assert.equal(h.editor.canAccept(), false);
    assert.equal(h.editor.draft.peek()?.baseVersion, base);
  }
});
Deno.test("acceptance ACK loss reload resumes same durable ID even after source advances, without another approval", async () => {
  const h = editHarness();
  h.draft();
  await h.editor.propose();
  h.behavior.accept = () => Promise.reject(new Error("lost ACK"));
  await h.editor.accept();
  assert.equal(h.editor.intent.peek()?.acceptAttempted, true);
  const restored = h.build();
  restored.setScope({ ...editScope, admittedVersion: next });
  assert.equal(restored.proposal.peek(), null);
  assert.equal(restored.canAccept(), false);
  await restored.resume();
  assert.deepEqual(h.calls, [
    `propose:${base}`,
    "accept:proposal-a",
    "resume:proposal-a",
  ]);
  assert.equal(restored.intent.peek()?.baseVersion, base);
  assert.equal(restored.receipt.peek()?.version, next);
  assert.deepEqual(h.confirmed, ["case-a"]);
});
Deno.test("resume404 retains identity and cannot auto approve without restored review", async () => {
  const h = editHarness();
  h.draft();
  await h.editor.propose();
  h.behavior.accept = () => Promise.reject(new Error("lost"));
  await h.editor.accept();
  h.behavior.resume = () =>
    Promise.reject(new RequestSourceApiError("missing", 404));
  const restored = h.build();
  await restored.resume();
  assert.equal(restored.intent.peek()?.commandId, "proposal-a");
  assert.equal(restored.canAccept(), false);
  assert.equal(h.calls.filter((call) => call.startsWith("accept:")).length, 1);
});
Deno.test("approval is not sent without exact durable identity write/readback", async () => {
  for (
    const storage of [null, {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage denied");
      },
      removeItem: () => {},
    }, { getItem: () => null, setItem: () => {}, removeItem: () => {} }]
  ) {
    const h = editHarness({ storage });
    h.draft();
    await h.editor.propose();
    await h.editor.accept();
    assert.equal(
      h.calls.filter((call) => call.startsWith("accept:")).length,
      0,
    );
    assert.match(h.editor.message.peek()!, /No approval was sent/);
  }
});
Deno.test("A to B to A and session/version changes invalidate old async completions, preserving intent", async () => {
  const h = editHarness();
  h.draft();
  let finish!: (value: RequestSourceProposal) => void;
  h.behavior.propose = () =>
    new Promise<RequestSourceProposal>((resolve) => {
      finish = resolve;
    });
  const pending = h.editor.propose();
  h.editor.select("case-b", true);
  h.editor.select("case-a", true);
  finish(h.response);
  await pending;
  assert.equal(h.editor.proposal.peek(), null);
  assert.equal(h.editor.draft.peek()?.text, "new");
  assert.equal(h.editor.proposalUncertain.peek(), true);
  h.behavior.propose = () => Promise.resolve(h.response);
  await h.editor.propose();
  h.behavior.accept = () =>
    Promise.reject(new RequestSourceApiError("expired", 403));
  await h.editor.accept();
  const saved = h.editor.intent.peek();
  h.editor.setScope({ ...editScope, viewedVersion: next, sessionReady: false });
  assert.deepEqual(h.editor.intent.peek(), saved);
  assert.equal(h.editor.canAccept(), false);
});
Deno.test("delayed auth failure from a deselected Case does not invalidate another Case connection", async () => {
  const h = editHarness();
  h.draft();
  let fail!: (error: Error) => void;
  h.behavior.propose = () =>
    new Promise<RequestSourceProposal>((_resolve, reject) => {
      fail = reject;
    });
  const pending = h.editor.propose();
  h.editor.select("case-b", true);
  fail(new RequestSourceApiError("old request", 403, "FORBIDDEN", true));
  await pending;
  assert.equal(h.unauthorized(), 0);
  assert.equal(h.editor.intent.peek(), null);
});

Deno.test("changed inspection or connection generation never revives an old proposal response", async () => {
  for (
    const changed of [{ ...editScope, viewedVersion: next }, {
      ...editScope,
      admittedVersion: next,
    }, { ...editScope, sessionReady: false }]
  ) {
    const h = editHarness();
    h.draft();
    let finish!: (value: RequestSourceProposal) => void;
    h.behavior.propose = () =>
      new Promise<RequestSourceProposal>((resolve) => {
        finish = resolve;
      });
    const pending = h.editor.propose();
    h.editor.setScope(changed);
    h.editor.setScope(editScope);
    finish(h.response);
    await pending;
    assert.equal(h.editor.proposal.peek(), null);
    assert.equal(h.editor.draft.peek()?.baseVersion, base);
    assert.equal(h.editor.canAccept(), false);
  }
});
Deno.test("a resumed result with another source digest is not confirmed", async () => {
  const h = editHarness();
  h.draft();
  await h.editor.propose();
  h.behavior.resume = () =>
    Promise.resolve({
      caseId: "case-a",
      version: next,
      sourceDigest: "f".repeat(64),
    });
  await h.editor.accept();
  assert.equal(h.editor.receipt.peek(), null);
  assert.deepEqual(h.confirmed, []);
  assert.equal(h.editor.intent.peek()?.commandId, "proposal-a");
});

Deno.test("action 403 preserves control; an explicit session refusal invalidates it without losing approval identity", async () => {
  for (
    const [code, sessionInvalid] of [
      ["REQUEST_SOURCE_OWNER_REFUSED", false],
      ["EDIT_SCOPE_DENIED", false],
      ["UNKNOWN", false],
      ["FORBIDDEN", false],
      ["FORBIDDEN", true],
    ] as const
  ) {
    const h = editHarness();
    h.draft();
    await h.editor.propose();
    h.behavior.accept = () =>
      Promise.reject(
        new RequestSourceApiError("refused", 403, code, sessionInvalid),
      );
    await h.editor.accept();
    assert.equal(h.unauthorized(), sessionInvalid ? 1 : 0);
    assert.equal(h.editor.intent.peek()?.commandId, "proposal-a");
    assert.equal(h.editor.intent.peek()?.acceptAttempted, true);
    assert.equal(h.editor.receipt.peek(), null);
  }
});
