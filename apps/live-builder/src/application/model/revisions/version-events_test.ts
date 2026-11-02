import assert from "node:assert/strict";
import { ModelAttentionService } from "../projections/attention.ts";
import { ModelVersionEvents } from "./version-events.ts";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../domain/model/records/revision.ts";

Deno.test("model-version announces source metadata without reading the compiled artifact", async () => {
  const version = `commit:${"e".repeat(40)}`;
  let fullReads = 0;
  const headers: string[] = [];
  const emitted: Array<{ head: string; sourceDigest: string }> = [];
  const events = new ModelVersionEvents({
    current() {
      fullReads++;
      return Promise.reject(new Error("compiled materialization must not run"));
    },
    headVersion: () => Promise.resolve(version),
    header(v) {
      headers.push(v);
      return Promise.resolve({
        version: v,
        sources: {},
        sourceDigest: "verified-source",
      });
    },
    readProposalJournal: () => Promise.resolve([]),
  }, (_name, value) => emitted.push(value));
  await events.publish();
  assert.equal(fullReads, 0);
  assert.deepEqual(headers, [version]);
  assert.equal(emitted[0].head, version);
  assert.equal(emitted[0].sourceDigest, "verified-source");
});

Deno.test("model-version preserves a failed immutable header without a full-read fallback", async () => {
  const failure = new Error("source header is corrupt");
  let fullReads = 0;
  const events = new ModelVersionEvents({
    current() {
      fullReads++;
      return Promise.reject(new Error("unexpected fallback"));
    },
    headVersion: () => Promise.resolve(`commit:${"e".repeat(40)}`),
    header: () => Promise.reject(failure),
    readProposalJournal: () => Promise.resolve([]),
  }, () => assert.fail("no event from an unreadable header"));
  await assert.rejects(() => events.publish(), (error) => error === failure);
  assert.equal(fullReads, 0);
});

function fixture() {
  let head: ModelRevision = {
    version: `commit:${"a".repeat(40)}`,
    sourceDigest: "initial",
    sources: {},
    elements: [],
    documents: [],
    semanticDigest: "",
    provenanceDigest: "",
    sourceHashes: {},
    engineVersion: "fixture",
  };
  const proposals: ProposalRecord[] = [];
  const emitted: unknown[] = [];
  const events = new ModelVersionEvents({
    current: () => Promise.resolve(head),
    readProposalJournal: () => Promise.resolve([...proposals]),
  }, (name, value) => {
    emitted.push({ name, value });
  });
  return {
    events,
    emitted,
    proposals,
    setHead: (version: string, sourceDigest: string) => {
      head = { ...head, version, sourceDigest };
    },
  };
}
function proposal(id: string): ProposalRecord {
  return {
    id,
    branch: `proposal_${id}`,
    author: "local-owner",
    reason: "Change",
    baseVersion: `commit:${"a".repeat(40)}`,
    createdAt: "now",
    status: "proposed",
    validation: "validated",
    sourceDigest: `source-${id}`,
    proposalVersion: `commit:${"b".repeat(40)}`,
    diff: [],
  };
}

Deno.test("model-version initial snapshot uses current head and a stable proposal digest", async () => {
  const f = fixture();
  const first = await f.events.initial();
  assert.equal(first.head, `commit:${"a".repeat(40)}`);
  assert.equal(first.sourceDigest, "initial");
  assert.equal(first.proposals.pending, 0);
  assert.match(first.proposals.digest, /^[a-f0-9]{64}$/);
  f.proposals.push(proposal("z"), proposal("a"));
  const ordered = await f.events.initial();
  f.proposals.reverse();
  assert.deepEqual(await f.events.initial(), ordered);
  assert.equal(
    f.emitted.length,
    0,
    "initial connection payload is read without a broadcast",
  );
  f.setHead(`commit:${"c".repeat(40)}`, "latest");
  assert.equal((await f.events.initial()).head, `commit:${"c".repeat(40)}`);
});

Deno.test("model-version proposal creation, rejection and acceptance change the event; comments stay silent", async () => {
  const f = fixture();
  await f.events.initial();
  await f.events.publish();
  assert.equal(f.emitted.length, 0);
  const pending = proposal("fix");
  f.proposals.push(pending);
  await f.events.publish();
  assert.equal(f.emitted.length, 1);
  let current = await f.events.initial();
  assert.equal(
    current.head,
    pending.baseVersion,
    "proposal commit is never admitted HEAD",
  );
  assert.equal(current.proposals.pending, 1);
  const proposedDigest = current.proposals.digest;
  pending.status = "rejected";
  await f.events.publish();
  assert.equal(f.emitted.length, 2);
  current = await f.events.initial();
  assert.equal(current.proposals.pending, 0);
  assert.notEqual(current.proposals.digest, proposedDigest);
  assert.equal(current.head, pending.baseVersion);
  const accepted = proposal("accepted");
  f.proposals.push(accepted);
  await f.events.publish();
  accepted.status = "accepted";
  accepted.acceptedVersion = `commit:${"d".repeat(40)}`;
  f.setHead(accepted.acceptedVersion, accepted.sourceDigest);
  await f.events.publish();
  assert.equal((await f.events.initial()).head, accepted.acceptedVersion);
  const count = f.emitted.length;
  await Promise.all([f.events.publish(), f.events.publish()]);
  assert.equal(
    f.emitted.length,
    count,
    "a comment outside source/proposal state has no effect",
  );
});

Deno.test("model-version never waits for attention and never invents a count", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready: number | undefined;
  let warms = 0;
  const events = new ModelVersionEvents({
    current: () =>
      Promise.resolve({
        version: `commit:${"a".repeat(40)}`,
        sourceDigest: "initial",
        sources: {},
        elements: [],
        documents: [],
        semanticDigest: "",
        provenanceDigest: "",
        sourceHashes: {},
        engineVersion: "fixture",
      }),
    readProposalJournal: () => Promise.resolve([]),
  }, (_name, value) => {
    f.emitted.push({ name: _name, value });
  }, {
    peekCount: () => ready,
    warm: async () => {
      warms++;
      await gate;
      ready = 3;
    },
  });
  // The gated (slow matrix) warm must not delay the event, and the event
  // carries no attention at all instead of a guessed zero.
  await events.publish();
  assert.equal(f.emitted.length, 1);
  const first = (f.emitted[0] as { value: Record<string, unknown> }).value;
  assert.equal("attention" in first, false);
  assert.equal(warms, 1);
  // Once the computation lands, a follow-up event carries the true count.
  release();
  for (let i = 0; i < 20 && f.emitted.length < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(f.emitted.length, 2);
  const second = (f.emitted[1] as { value: { attention?: { count: number } } })
    .value;
  assert.deepEqual(second.attention, { count: 3 });
  assert.equal(warms, 1, "a ready count never warms again");
  const initial = await events.initial();
  assert.deepEqual(initial.attention, { count: 3 });
});

function attentionEvents(
  attention: {
    peekCount(v: string): number | undefined;
    warm(v: string): Promise<void>;
  },
  emitted: Array<{ attention?: { count: number }; head?: string }>,
  head = `commit:${"a".repeat(40)}`,
  onAttentionError?: (error: unknown, version: string) => void,
) {
  return new ModelVersionEvents(
    {
      current: () =>
        Promise.resolve({
          version: head,
          sourceDigest: "initial",
          sources: {},
          elements: [],
          documents: [],
          semanticDigest: "",
          sourceHashes: {},
          engineVersion: "fixture",
        } as never),
      readProposalJournal: () => Promise.resolve([]),
    },
    (_name, value) => {
      emitted.push(value as never);
    },
    attention,
    onAttentionError,
  );
}

const tick = async (times = 20) => {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

Deno.test("model-version carries a real zero attention count", async () => {
  const emitted: Array<{ attention?: { count: number } }> = [];
  const events = attentionEvents(
    { peekCount: () => 0, warm: () => Promise.resolve() },
    emitted,
  );
  await events.publish();
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].attention, { count: 0 });
});

Deno.test("model-version with the real attention service: follow-up, then a mask drops the count at the same head", async () => {
  let masked = false;
  const head = `commit:${"a".repeat(40)}`;
  const svc = new ModelAttentionService({
    matrix: {
      read: () =>
        Promise.resolve({
          schema: "ase.authority-matrix/1",
          version: head,
          rows: [],
          columns: [],
          cells: [],
          diagnostics: [],
          digest: "m",
        } as never),
    },
    board: {
      read: () =>
        Promise.resolve({
          schema: "ase.board/1",
          meta: {
            model: "t",
            mode: "ase",
            sourceDigest: "s",
            diagnostics: [],
            digest: "b",
          },
          columns: [],
          links: [],
          index: {},
        } as never),
    },
    diagnostics: {
      list: () =>
        Promise.resolve({
          version: head,
          sourceDigest: "s",
          diagnostics: [{
            code: "LOOP_WITHOUT_BUDGET",
            severity: "warning",
            finding: "absent",
            message: "m",
            masked,
            elementId: "el-1",
          }],
        } as never),
    },
  });
  const emitted: Array<{ attention?: { count: number }; head?: string }> = [];
  const events = attentionEvents(svc, emitted, head);
  await events.publish();
  assert.equal(emitted.length, 1);
  assert.equal("attention" in emitted[0], false);
  await tick();
  assert.equal(emitted.length, 2, "follow-up carries the computed count");
  assert.deepEqual(emitted[1].attention, { count: 1 });
  assert.equal(svc.peekCount(head), 1);
  // Mask at the same head (main.ts wiring: warm the head, then publish).
  masked = true;
  await svc.warm(head);
  await events.publish();
  assert.equal(emitted.length, 3);
  assert.deepEqual(emitted[2].attention, { count: 0 });
  assert.equal(emitted[2].head, head, "the head did not move");
  assert.equal(svc.peekCount(head), 0);
});

Deno.test("model-version reports a failed warm, publishes nothing more, and retries on the next event", async () => {
  const emitted: Array<{ attention?: { count: number } }> = [];
  let warms = 0;
  let ready: number | undefined;
  const reported: Array<{ error: unknown; version: string }> = [];
  const events = attentionEvents(
    {
      peekCount: () => ready,
      warm: () => {
        warms++;
        if (warms === 1) return Promise.reject(new Error("matrix slow"));
        ready = 2;
        return Promise.resolve();
      },
    },
    emitted,
    undefined,
    (error, version) => {
      reported.push({ error, version });
    },
  );
  await events.publish();
  await tick();
  assert.equal(emitted.length, 1, "a failed warm publishes no follow-up");
  assert.equal(warms, 1);
  assert.equal(reported.length, 1, "the failure is reported once");
  assert.equal((reported[0].error as Error).message, "matrix slow");
  assert.equal(reported[0].version, `commit:${"a".repeat(40)}`);
  await events.publish();
  await tick();
  assert.equal(warms, 2, "the marker was removed, so a retry is possible");
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted[1].attention, { count: 2 });
});

Deno.test("model-version retries after an observer emission failure", async () => {
  let attempts = 0;
  const f = fixture();
  const head = await f.events.initial();
  const events = new ModelVersionEvents({
    current: () =>
      Promise.resolve({
        version: head.head,
        sourceDigest: head.sourceDigest,
        sources: {},
        elements: [],
        documents: [],
        semanticDigest: "",
        provenanceDigest: "",
        sourceHashes: {},
        engineVersion: "fixture",
      }),
    readProposalJournal: () => Promise.resolve([]),
  }, () => {
    if (++attempts === 1) throw new Error("disconnected");
  });
  await assert.rejects(() => events.publish(), /disconnected/);
  // No successful broadcast was recorded, so the same event can be retried.
  await events.publish();
  assert.equal(attempts, 2);
});
