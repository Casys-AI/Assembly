import {
  deepStrictEqual,
  doesNotMatch,
  equal,
  match,
  ok,
} from "node:assert/strict";
import { evolutionAuthorization } from "../../../test/support/evolution-fixture.ts";
import {
  createModelHistory,
  LONGEST_HISTORY,
  runningVersions,
} from "./history.ts";
import {
  createRevisionApi,
  type RevisionSelection,
  type RuntimeOperator,
} from "./api.ts";
import { localSources } from "../sources/command.ts";
import {
  commit,
  DESIGNER,
  HEAD,
  history,
  modelHost,
  OLD_DIGEST,
  operators,
  PARENT,
  PROPOSED,
  REVIEWER,
  ROOT,
  runtimes,
} from "../../../test/support/revision-fixture.ts";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => release = done);
  return { promise, release };
}

Deno.test("generic history commands cannot accept or reject an operator evolution", async () => {
  const data = history();
  const proposal = data.revisions.proposals.find((entry) =>
    entry.status === "proposed"
  )!;
  proposal.authorization = evolutionAuthorization();
  const { store, host } = setup({ data });
  await store.refresh();
  for (const verdict of ["approve", "refuse"] as const) {
    const result = await store.decideById(proposal.id, verdict);
    equal(result.ok, false);
  }
  equal(host.requests.filter((request) => request.method === "POST").length, 0);
  store.dispose();
});

function setup(
  options: Parameters<typeof modelHost>[0] = {},
  selection?: RevisionSelection,
  roster: readonly RuntimeOperator[] = [],
) {
  const host = modelHost(options);
  const sources = localSources();
  const changes: number[] = [];
  const store = createModelHistory({
    api: createRevisionApi(host.request),
    sources,
    selection: () => selection,
    onChanged: () => {
      changes.push(sources.generation.peek());
    },
    operators: () => roster,
  });
  const reads = () =>
    host.requests.filter((entry) => entry.path === "/api/model-revisions")
      .length;
  return { host, sources, store, changes, reads };
}
/** Waits until the history is no longer being read. */
async function settled(store: { reading: { peek(): boolean } }) {
  for (let turn = 0; turn < 50 && store.reading.peek(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
const proposalOf = (store: ReturnType<typeof setup>["store"], id: string) =>
  store.snapshot.peek()!.revisions.proposals.find((entry) => entry.id === id)!;

Deno.test("the history is read once and shown with its generation: a settled read can be decided on", async () => {
  const { store, host } = setup();
  equal(store.snapshot.peek(), undefined);
  equal(store.canAct.peek(), false);
  const reading = store.refresh();
  equal(store.reading.peek(), true);
  await reading;
  equal(store.reading.peek(), false);
  equal(store.snapshot.peek()?.revisions.version, HEAD);
  equal(store.problem.peek(), null);
  equal(store.canAct.peek(), true);
  deepStrictEqual(
    host.requests.map((entry) => entry.path).sort(),
    ["/api/model-history", "/api/model-revisions"],
  );
});

Deno.test("reads asked for while one runs share a single further read, and all end after it", async () => {
  const gate = deferred();
  const { store, reads } = setup({ gate: gate.promise });
  const first = store.refresh();
  const second = store.refresh();
  const third = store.refresh();
  gate.release();
  await Promise.all([first, second, third]);
  equal(reads(), 2);
  equal(store.snapshot.peek()?.revisions.version, HEAD);
  // Idle again: a new request starts a new read.
  await store.refresh();
  equal(reads(), 3);
});

Deno.test("a read overtaken by a decision somewhere is dropped whole and made again", async () => {
  const gate = deferred();
  const { store, sources, reads } = setup({ gate: gate.promise });
  const reading = store.refresh();
  // A decision elsewhere advances the generation while the read is in flight.
  await sources.invalidate();
  gate.release();
  await reading;
  equal(reads(), 2);
  equal(store.canAct.peek(), true);
  // Until the next read, nothing read before a decision may be decided on.
  await sources.invalidate();
  equal(store.canAct.peek(), false);
  await store.refresh();
  equal(store.canAct.peek(), true);
});

Deno.test("a read that fails keeps the last one and says why; it can be made again", async () => {
  const host = modelHost();
  let down = false;
  const store = createModelHistory({
    api: createRevisionApi(
      ((path: string, init?: RequestInit) =>
        down
          ? Promise.resolve(
            Response.json({ error: "Hors ligne." }, { status: 503 }),
          )
          : host.request(path, init)) as typeof fetch,
    ),
    sources: localSources(),
    selection: () => undefined,
    onChanged: () => {},
  });
  await store.refresh();
  down = true;
  await store.refresh();
  equal(store.snapshot.peek()?.revisions.version, HEAD);
  deepStrictEqual(
    [store.problem.peek()?.code, store.problem.peek()?.status],
    ["read-failed", 503],
  );
  // The host's own words travel along, but the page speaks for itself.
  equal(store.problem.peek()?.detail, "Hors ligne.");
  equal(store.problem.peek()?.message, "The history could not be read.");
  // A failed read is no read to decide on.
  equal(store.canAct.peek(), false);
  down = false;
  await store.refresh();
  equal(store.problem.peek(), null);
  equal(store.canAct.peek(), true);
});

Deno.test("a commit the address names stays in the list when a read no longer holds it", async () => {
  const old = { kind: "commit" as const, id: "commit:old" };
  const { store, host } = setup({}, old);
  await store.refresh();
  const withOld = structuredClone(host.data.history.commits[0]);
  withOld.version = old.id;
  host.data.history.commits.push(withOld);
  await store.refresh();
  host.data.history.commits.pop();
  await store.refresh();
  equal(
    store.snapshot.peek()!.history.commits.some((entry) =>
      entry.version === old.id
    ),
    true,
  );
});

Deno.test("a decision names the head and the sources that were examined, then the history is read again", async () => {
  const { store, host, changes, reads, sources } = setup();
  await store.refresh();
  const before = reads();
  const outcome = await store.decide(proposalOf(store, "p-open"), "approve");
  deepStrictEqual(outcome, { ok: true });
  deepStrictEqual(host.writes(), [{
    path: "/api/model-revisions/p-open/decision",
    method: "POST",
    body: {
      verdict: "approve",
      expectedVersion: HEAD,
      sourceDigest: "p-open-digest",
    },
  }]);
  // The generation advanced, the other views were told, the history was read.
  equal(sources.generation.peek(), 1);
  deepStrictEqual(changes, [1]);
  equal(reads(), before + 1);
  equal(store.deciding.peek(), null);
  equal(store.refusal.peek(), null);
  equal(store.canAct.peek(), true);
  await store.decide(proposalOf(store, "p-open"), "refuse");
  equal((host.writes()[1].body as { verdict: string }).verdict, "refuse");
});

Deno.test("one decision is in flight at a time, here and in every other panel", async () => {
  const { store, host, sources } = setup();
  await store.refresh();
  const proposal = proposalOf(store, "p-open");
  const first = store.decide(proposal, "approve");
  // Pressed again at once: it is not sent.
  const second = await store.decide(proposal, "refuse");
  equal(second.ok === false && second.problem.code, "decision-busy");
  equal(store.canAct.peek(), false);
  await first;
  equal(host.writes().length, 1);
  // Another panel's decision in flight holds this one back as well.
  let finish!: () => void;
  const elsewhere = sources.track(() =>
    new Promise<void>((done) => finish = done)
  );
  const refused = await store.decide(proposal, "approve");
  equal(refused.ok === false && refused.problem.code, "decision-busy");
  equal(host.writes().length, 1);
  finish();
  await elsewhere;
});

Deno.test("only a proposal waiting for a decision, read at the current generation, can be decided", async () => {
  const { store, host, sources } = setup();
  const waiting = history().revisions.proposals.find((entry) =>
    entry.id === "p-open"
  )!;
  // Before any read.
  const unread = await store.decide(waiting, "approve");
  equal(unread.ok === false && unread.problem.code, "decision-unavailable");
  await store.refresh();
  // Settled proposals are not decided again.
  for (const id of ["p-taken", "p-declined", "p-prepare"]) {
    const outcome = await store.decide(proposalOf(store, id), "approve");
    equal(outcome.ok === false && outcome.problem.code, "decision-unavailable");
  }
  // A read from before a decision somewhere else.
  await sources.invalidate();
  const stale = await store.decide(waiting, "approve");
  equal(stale.ok === false && stale.problem.code, "decision-unavailable");
  equal(host.writes().length, 0);
  // Not attempted, so nothing to tell on the proposal.
  equal(store.refusal.peek(), null);
});

Deno.test("a decision the host refuses as stale says so and reads what the host holds now", async () => {
  const { store, reads } = setup({
    decision: () =>
      Response.json({ error: "Le modèle courant a changé." }, { status: 409 }),
  });
  await store.refresh();
  const before = reads();
  const outcome = await store.decide(proposalOf(store, "p-open"), "approve");
  ok(!outcome.ok);
  deepStrictEqual(
    [outcome.problem.code, outcome.problem.status, outcome.problem.detail],
    ["decision-conflict", 409, "Le modèle courant a changé."],
  );
  deepStrictEqual(store.refusal.peek()?.id, "p-open");
  await store.refresh();
  ok(reads() > before);
  // Nothing was confirmed: the other views were not told, nothing is in flight.
  equal(store.deciding.peek(), null);
});

Deno.test("any other failure of a decision is a failure, with the status the host gave, and the history is read again", async () => {
  const { store, changes, reads } = setup({
    decision: () => Response.json({ error: "Boom." }, { status: 500 }),
  });
  await store.refresh();
  const before = reads();
  const outcome = await store.decide(proposalOf(store, "p-open"), "refuse");
  ok(!outcome.ok);
  deepStrictEqual([outcome.problem.code, outcome.problem.status], [
    "decision-failed",
    500,
  ]);
  // The host may have recorded it: it is asked what it holds, nothing is assumed.
  match(outcome.problem.message, /may not have been recorded/);
  await settled(store);
  equal(reads(), before + 1);
  deepStrictEqual(changes, []);
  // The next decision starts clean.
  const again = store.decide(proposalOf(store, "p-open"), "refuse");
  equal(store.refusal.peek(), null);
  await again;
});

Deno.test("the changes of two versions are read once, kept, and read again only after a failure", async () => {
  let fail = true;
  const host = modelHost();
  const store = createModelHistory({
    api: createRevisionApi(
      ((path: string, init?: RequestInit) => {
        if (path.startsWith("/api/model-diff") && fail) {
          return Promise.resolve(
            Response.json({ error: "Non." }, { status: 500 }),
          );
        }
        return host.request(path, init);
      }) as typeof fetch,
    ),
    sources: localSources(),
    selection: () => undefined,
    onChanged: () => {},
  });
  const diffs = () =>
    host.requests.filter((entry) => entry.path.startsWith("/api/model-diff"));
  equal(store.diff(HEAD, PROPOSED), undefined);
  const reading = store.readDiff(HEAD, PROPOSED);
  equal(store.diff(HEAD, PROPOSED)?.status, "loading");
  await reading;
  const failed = store.diff(HEAD, PROPOSED);
  ok(failed?.status === "failed");
  equal(failed.problem.code, "diff-failed");
  fail = false;
  await store.readDiff(HEAD, PROPOSED);
  const ready = store.diff(HEAD, PROPOSED);
  ok(ready?.status === "ready");
  equal(ready.diff.additions, 2);
  // Read, it is not read again; another pair is another change.
  await store.readDiff(HEAD, PROPOSED);
  equal(diffs().length, 1);
  await store.readDiff(PARENT, HEAD);
  equal(diffs().length, 2);
  equal(
    diffs()[0].path,
    `/api/model-diff?from=${encodeURIComponent(HEAD)}&to=${
      encodeURIComponent(PROPOSED)
    }`,
  );
});

Deno.test("a read that is cancelled stores nothing, and nothing is stored after the history is let go", async () => {
  const gate = deferred();
  const { store } = setup({ gate: gate.promise });
  const reading = store.refresh();
  store.cancel();
  gate.release();
  await reading;
  equal(store.snapshot.peek(), undefined);
  equal(store.problem.peek(), null);
  const next = setup();
  const pending = next.store.refresh();
  next.store.dispose();
  await pending;
  equal(next.store.snapshot.peek(), undefined);
  // A disposed history decides nothing.
  const outcome = await next.store.decide(
    history().revisions.proposals[2],
    "approve",
  );
  equal(outcome.ok === false && outcome.problem.code, "decision-unavailable");
  equal(next.host.writes().length, 0);
});

/** The designer (primary) is behind main; the reviewer already runs it. */
const served = () => ({ runtimes: runtimes(), primary: DESIGNER });

Deno.test("each operator is asked what it has in service, with the history; the one the history answers for is not asked twice", async () => {
  const { store, host } = setup(served(), undefined, operators);
  await store.refresh();
  deepStrictEqual(
    host.requests.map((entry) => entry.path).sort(),
    [
      "/api/model-history",
      "/api/model-revisions",
      `/api/model-revisions?agentId=${encodeURIComponent(REVIEWER)}`,
    ].sort(),
  );
  const held = store.runtimes.peek();
  deepStrictEqual(held.map((entry) => entry.operator.nativeId), [
    DESIGNER,
    REVIEWER,
  ]);
  ok(held.every((entry) => entry.state === "ready"));
  // Published with the history: the versions and what runs them agree.
  equal(store.snapshot.peek()?.revisions.agentId, DESIGNER);
});

Deno.test("only an operator whose runtime holds another contract is offered the model; none when every one is up to date", async () => {
  const { store, host } = setup(served(), undefined, operators);
  await store.refresh();
  deepStrictEqual(
    store.offers.peek().map((offer) => [
      offer.operator.nativeId,
      offer.adoption.expectedDigest,
      offer.adoption.expectedVersion,
    ]),
    [[DESIGNER, host.runtimes[DESIGNER].available!.digest, HEAD]],
  );
  // The same version in service everywhere: nothing to offer.
  host.runtimes[DESIGNER].active = host.runtimes[DESIGNER].available;
  await store.refresh();
  deepStrictEqual(store.offers.peek(), []);
  // Without operators there is nobody to offer it to.
  const alone = setup();
  await alone.store.refresh();
  deepStrictEqual(alone.store.offers.peek(), []);
  deepStrictEqual(alone.store.runtimes.peek(), []);
});

Deno.test("the primary operator comes first among those offered, whatever the roster's order", async () => {
  // The roster lists the reviewer first; both are behind main.
  const f = setup(served(), undefined, [...operators].reverse());
  f.host.runtimes[REVIEWER].active = {
    digest: OLD_DIGEST,
    repositoryVersion: PARENT,
  };
  await f.store.refresh();
  deepStrictEqual(
    f.store.runtimes.peek().map((entry) => entry.operator.nativeId),
    [REVIEWER, DESIGNER],
  );
  deepStrictEqual(
    f.store.offers.peek().map((offer) => offer.operator.nativeId),
    [DESIGNER, REVIEWER],
  );
});

Deno.test("an operator whose runtime cannot be read is told as such, and the history and the others stand", async () => {
  const host = modelHost(served());
  const store = createModelHistory({
    api: createRevisionApi(
      ((path: string, init?: RequestInit) =>
        path.includes("agentId")
          ? Promise.resolve(
            Response.json({ error: "Hors ligne." }, { status: 503 }),
          )
          : host.request(path, init)) as typeof fetch,
    ),
    sources: localSources(),
    selection: () => undefined,
    onChanged: () => {},
    operators: () => operators,
  });
  await store.refresh();
  equal(store.problem.peek(), null);
  equal(store.snapshot.peek()?.revisions.version, HEAD);
  const [designer, reviewer] = store.runtimes.peek();
  equal(designer.state, "ready");
  ok(reviewer.state === "failed");
  deepStrictEqual(
    [reviewer.problem.code, reviewer.problem.status, reviewer.problem.detail],
    ["runtime-failed", 503, "Hors ligne."],
  );
  // The one that was read is still offered the model; the other is not guessed.
  deepStrictEqual(
    store.offers.peek().map((offer) => offer.operator.nativeId),
    [DESIGNER],
  );
  equal(store.canAct.peek(), true);
});

Deno.test("what each operator runs is its active version: unread operators are left out", async () => {
  const { store } = setup(served(), undefined, operators);
  await store.refresh();
  deepStrictEqual(runningVersions(store.runtimes.peek()), [
    { name: "Designer", version: PARENT },
    { name: "Reviewer", version: HEAD },
  ]);
  deepStrictEqual(
    runningVersions([{
      operator: operators[0],
      state: "failed",
      problem: { code: "runtime-failed", message: "x" },
    }]),
    [],
  );
});

Deno.test("an adoption names the operator and the contract and version its runtime was read to hold, then the history is read again", async () => {
  const { store, host, changes, reads, sources } = setup(
    served(),
    undefined,
    operators,
  );
  await store.refresh();
  const before = reads();
  const outcome = await store.adopt(DESIGNER);
  deepStrictEqual(outcome, { ok: true });
  deepStrictEqual(host.writes(), [{
    path: "/api/model-version/adopt",
    method: "POST",
    body: {
      expectedDigest: host.runtimes[DESIGNER].available!.digest,
      expectedVersion: HEAD,
      agentId: DESIGNER,
    },
  }]);
  // The generation advanced, the other views were told, the history was read.
  equal(sources.generation.peek(), 1);
  deepStrictEqual(changes, [1]);
  ok(reads() > before);
  equal(store.adopting.peek(), null);
  equal(store.adoptionRefusal.peek(), null);
  // What runs is what the host holds now: nothing is left to offer.
  deepStrictEqual(store.offers.peek(), []);
  deepStrictEqual(runningVersions(store.runtimes.peek()), [
    { name: "Designer", version: HEAD },
    { name: "Reviewer", version: HEAD },
  ]);
  equal(store.canAct.peek(), true);
});

Deno.test("an adoption for a runtime other than the primary's reaches that runtime", async () => {
  const f = setup(served(), undefined, operators);
  f.host.runtimes[REVIEWER].active = {
    digest: OLD_DIGEST,
    repositoryVersion: PARENT,
  };
  await f.store.refresh();
  deepStrictEqual(
    f.store.offers.peek().map((offer) => offer.operator.nativeId),
    [DESIGNER, REVIEWER],
  );
  deepStrictEqual(await f.store.adopt(REVIEWER), { ok: true });
  equal((f.host.writes()[0].body as { agentId: string }).agentId, REVIEWER);
  // Only the reviewer moved; the designer is still waiting.
  deepStrictEqual(
    f.store.offers.peek().map((offer) => offer.operator.nativeId),
    [DESIGNER],
  );
});

Deno.test("one change is in flight at a time: a second adoption, or a decision, is not sent", async () => {
  const { store, host, sources } = setup(served(), undefined, operators);
  await store.refresh();
  const first = store.adopt(DESIGNER);
  // The page can say whose adoption is in flight.
  equal(store.adopting.peek(), DESIGNER);
  // Pressed again at once: it is not sent.
  const second = await store.adopt(DESIGNER);
  equal(second.ok === false && second.problem.code, "adoption-busy");
  const decision = await store.decide(proposalOf(store, "p-open"), "approve");
  equal(decision.ok === false && decision.problem.code, "decision-busy");
  equal(store.canAct.peek(), false);
  await first;
  equal(store.adopting.peek(), null);
  equal(host.writes().length, 1);
  // Another panel's change in flight holds the adoption back as well.
  host.runtimes[REVIEWER].active = {
    digest: OLD_DIGEST,
    repositoryVersion: PARENT,
  };
  await store.refresh();
  let finish!: () => void;
  const elsewhere = sources.track(() =>
    new Promise<void>((done) => finish = done)
  );
  const held = await store.adopt(REVIEWER);
  equal(held.ok === false && held.problem.code, "adoption-busy");
  equal(host.writes().length, 1);
  finish();
  await elsewhere;
});

Deno.test("only an operator the model is offered to, read at the current generation, can be given it", async () => {
  const { store, host, sources } = setup(served(), undefined, operators);
  // Before any read.
  const unread = await store.adopt(DESIGNER);
  equal(unread.ok === false && unread.problem.code, "adoption-unavailable");
  await store.refresh();
  // Up to date, or no operator of the roster at all.
  for (const id of [REVIEWER, "native:unknown"]) {
    const outcome = await store.adopt(id);
    equal(outcome.ok === false && outcome.problem.code, "adoption-unavailable");
  }
  // A read from before a change somewhere else.
  await sources.invalidate();
  const stale = await store.adopt(DESIGNER);
  equal(stale.ok === false && stale.problem.code, "adoption-unavailable");
  equal(host.writes().length, 0);
  // Not attempted, so nothing to tell.
  equal(store.adoptionRefusal.peek(), null);
  // A history let go gives nothing.
  store.dispose();
  const gone = await store.adopt(DESIGNER);
  equal(gone.ok === false && gone.problem.code, "adoption-unavailable");
});

Deno.test("an adoption the host refuses as stale says so with its code and reads what the host holds now", async () => {
  const { store, reads, changes } = setup(
    {
      ...served(),
      adoption: () =>
        Response.json({ error: "Le contrat a changé." }, { status: 409 }),
    },
    undefined,
    operators,
  );
  await store.refresh();
  const before = reads();
  const outcome = await store.adopt(DESIGNER);
  ok(!outcome.ok);
  deepStrictEqual(
    [outcome.problem.code, outcome.problem.status, outcome.problem.detail],
    ["adoption-conflict", 409, "Le contrat a changé."],
  );
  // Told for whom, by the name the roster gives, without the page looking it up.
  deepStrictEqual(
    [
      store.adoptionRefusal.peek()?.agentId,
      store.adoptionRefusal.peek()?.operator,
    ],
    [DESIGNER, "Designer"],
  );
  await store.refresh();
  ok(reads() > before);
  // The operator is still offered the model: the refusal stands, to try again.
  deepStrictEqual(store.adoptionRefusal.peek()?.agentId, DESIGNER);
  // Nothing was confirmed: the other views were not told, nothing is in flight.
  deepStrictEqual(changes, []);
  equal(store.adopting.peek(), null);
  // The next attempt starts clean.
  const again = store.adopt(DESIGNER);
  equal(store.adoptionRefusal.peek(), null);
  await again;
});

Deno.test("any other failure of an adoption is a failure, with the status the host gave, and the history is read again", async () => {
  const { store, changes, reads } = setup(
    {
      ...served(),
      adoption: () => Response.json({ error: "Boom." }, { status: 500 }),
    },
    undefined,
    operators,
  );
  await store.refresh();
  const before = reads();
  const outcome = await store.adopt(DESIGNER);
  ok(!outcome.ok);
  deepStrictEqual([outcome.problem.code, outcome.problem.status], [
    "adoption-failed",
    500,
  ]);
  // The host may have applied it: the message does not claim it did not.
  match(outcome.problem.message, /may not have been put in service/);
  await settled(store);
  equal(reads(), before + 1);
  deepStrictEqual(changes, []);
});

Deno.test("an adoption whose answer never came is read again too: the host may have applied it", async () => {
  const f = setup(
    {
      ...served(),
      // The host applies the adoption, and the connection drops before the answer.
      adoption: () => {
        const runtime = f.host.runtimes[DESIGNER];
        runtime.active = runtime.available;
        throw new TypeError("Failed to fetch");
      },
    },
    undefined,
    operators,
  );
  await f.store.refresh();
  equal(f.store.offers.peek().length, 1);
  const outcome = await f.store.adopt(DESIGNER);
  ok(!outcome.ok);
  deepStrictEqual(
    [outcome.problem.code, outcome.problem.status, outcome.problem.detail],
    ["adoption-failed", undefined, "Failed to fetch"],
  );
  await settled(f.store);
  // What the host holds now is what the page shows: nothing is left to offer,
  // and the refusal has nothing left to try.
  deepStrictEqual(f.store.offers.peek(), []);
  equal(f.store.adoptionRefusal.peek(), null);
  deepStrictEqual(runningVersions(f.store.runtimes.peek()), [
    { name: "Designer", version: HEAD },
    { name: "Reviewer", version: HEAD },
  ]);
});

Deno.test("a refusal about an operator the model is no longer offered to is dropped when the history is read again", async () => {
  const f = setup(
    {
      ...served(),
      adoption: () => {
        // Another session puts the same operator in service first.
        const runtime = f.host.runtimes[DESIGNER];
        runtime.active = runtime.available;
        return Response.json({ error: "Already done." }, { status: 409 });
      },
    },
    undefined,
    operators,
  );
  await f.store.refresh();
  const outcome = await f.store.adopt(DESIGNER);
  equal(!outcome.ok && outcome.problem.code, "adoption-conflict");
  await settled(f.store);
  // The reread shows the operator runs main: no button, so no alert beside it.
  deepStrictEqual(f.store.offers.peek(), []);
  equal(f.store.adoptionRefusal.peek(), null);
});

Deno.test("no adoption is sent while an operator is running: the host would refuse it", async () => {
  const roster = operators.map((operator) => ({ ...operator }));
  const { store, host } = setup(served(), undefined, roster);
  await store.refresh();
  roster[1].busy = true;
  const outcome = await store.adopt(DESIGNER);
  equal(!outcome.ok && outcome.problem.code, "adoption-operator-busy");
  equal(host.writes().length, 0);
  // Not attempted, so nothing to tell; it is not a stale history either.
  equal(store.adoptionRefusal.peek(), null);
  roster[1].busy = false;
  deepStrictEqual(await store.adopt(DESIGNER), { ok: true });
});

Deno.test("a 409 while an operator runs is told as that, not as a stale history", async () => {
  const roster = operators.map((operator) => ({ ...operator }));
  const { store } = setup(
    {
      ...served(),
      adoption: () => {
        // The run started after the click: the host refuses, the roster knows.
        roster[0].busy = true;
        return Response.json({
          error: "Une exécution est en cours pour cet opérateur.",
        }, { status: 409 });
      },
    },
    undefined,
    roster,
  );
  await store.refresh();
  const outcome = await store.adopt(DESIGNER);
  ok(!outcome.ok);
  deepStrictEqual(
    [outcome.problem.code, outcome.problem.status, outcome.problem.detail],
    [
      "adoption-operator-busy",
      409,
      "Une exécution est en cours pour cet opérateur.",
    ],
  );
  doesNotMatch(outcome.problem.message, /history was read again/);
  deepStrictEqual(
    store.adoptionRefusal.peek()?.problem.code,
    outcome.problem.code,
  );
});

Deno.test("a read overtaken by a change somewhere is made again whole: the operators are asked once, at the new generation", async () => {
  const gate = deferred();
  const { store, sources, host } = setup(
    { ...served(), gate: gate.promise },
    undefined,
    operators,
  );
  const reading = store.refresh();
  await sources.invalidate();
  gate.release();
  await reading;
  equal(store.canAct.peek(), true);
  equal(store.runtimes.peek().length, 2);
  // The overtaken read dropped the history before asking anybody.
  equal(
    host.requests.filter((entry) => entry.path.includes("agentId")).length,
    1,
  );
});

Deno.test("a decision by identity is the decision on the proposal the last read lists, and nothing else", async () => {
  const { store, host } = setup();
  // Nothing is listed before the first read: nothing to decide.
  const early = await store.decideById("p-open", "approve");
  equal(early.ok === false && early.problem.code, "decision-unavailable");
  await store.refresh();
  const outcome = await store.decideById("p-open", "approve");
  deepStrictEqual(outcome, { ok: true });
  deepStrictEqual(host.writes(), [{
    path: "/api/model-revisions/p-open/decision",
    method: "POST",
    body: {
      verdict: "approve",
      expectedVersion: HEAD,
      sourceDigest: "p-open-digest",
    },
  }]);
  // A proposal the host does not list, or one that is not waiting for a
  // decision, is refused as unavailable, and nothing is sent.
  for (const id of ["gone", "p-taken", "p-declined", "p-prepare"]) {
    const refused = await store.decideById(id, "refuse");
    equal(refused.ok === false && refused.problem.code, "decision-unavailable");
  }
  equal(host.writes().length, 1);
  // And it is the one decision in flight, like every other.
  const first = store.decideById("p-open", "approve");
  const second = await store.decideById("p-open", "refuse");
  equal(second.ok === false && second.problem.code, "decision-busy");
  await first;
  equal(host.writes().length, 2);
});

/**
 * A history of `count` commits, newest first, each the child of the one after
 * it down to ROOT: the host lists the newest `limit` of them.
 */
function longHistory(count: number) {
  const data = history();
  const version = (index: number) =>
    `commit:${(index + 16).toString(16).padStart(40, "0")}`;
  const middle = Array.from({ length: count - 3 }, (_, index) =>
    commit(
      version(index),
      index === count - 4 ? ROOT : version(index + 1),
      "local-control",
      `Change ${index}`,
      "2026-10-21T00:00:00Z",
    ));
  data.history.commits = [
    ...data.history.commits.slice(0, 2),
    ...middle,
    ...data.history.commits.slice(2),
  ];
  data.history.commits[1] = {
    ...data.history.commits[1],
    parentVersion: middle[0].version,
  };
  return data;
}

Deno.test("a commit the address names that the usual history lacks is looked for in the longest the host lists, once", async () => {
  const data = longHistory(130);
  const named = { kind: "commit" as const, id: ROOT };
  const { store, host } = setup({ data }, named);
  await store.refresh();
  const historyReads = () =>
    host.requests.filter((entry) => entry.path.startsWith("/api/model-history"))
      .map((entry) => entry.path);
  deepStrictEqual(historyReads(), [
    "/api/model-history",
    `/api/model-history?limit=${LONGEST_HISTORY}`,
  ]);
  const read = store.snapshot.peek()!;
  equal(read.history.commits.length, 130);
  equal(read.history.commits.some((entry) => entry.version === ROOT), true);
  // The next read keeps what was found, and asks for the usual length only.
  await store.refresh();
  deepStrictEqual(historyReads().slice(2), ["/api/model-history"]);
  equal(
    store.snapshot.peek()!.history.commits.some((entry) =>
      entry.version === ROOT
    ),
    true,
  );
});

Deno.test("the longer history is not read when it cannot help: a commit it has, one that is not cut, or one that is a proposal's version", async () => {
  // The commit is among the newest: the usual history has it.
  const recent = setup({ data: longHistory(130) }, {
    kind: "commit",
    id: HEAD,
  });
  await recent.store.refresh();
  // The history is not cut: the commit is not there, and never will be.
  const whole = setup({}, { kind: "commit", id: "commit:gone" });
  await whole.store.refresh();
  // A proposal's version is not on main, however long the history.
  const data = longHistory(130);
  const proposed = setup({ data }, { kind: "commit", id: PROPOSED });
  await proposed.store.refresh();
  // Nothing named: the page is not looking for a commit.
  const none = setup({ data: longHistory(130) });
  await none.store.refresh();
  // A proposal is named by its identity, not by a commit.
  const byProposal = setup(
    { data: longHistory(130) },
    { kind: "proposal", id: "p-open" },
  );
  await byProposal.store.refresh();
  for (const run of [recent, whole, none, byProposal]) {
    deepStrictEqual(
      run.host.requests.filter((entry) =>
        entry.path.startsWith("/api/model-history")
      ).map((entry) => entry.path),
      ["/api/model-history"],
    );
  }
  // PROPOSED is the version of open proposals in the fixture: not looked for.
  equal(
    proposed.host.requests.filter((entry) =>
      entry.path.startsWith("/api/model-history")
    ).length,
    1,
  );
});

Deno.test("a commit older than the longest history stays absent, and the history says it was cut", async () => {
  const data = longHistory(230);
  const { store, host } = setup({ data }, { kind: "commit", id: ROOT });
  await store.refresh();
  equal(
    host.requests.filter((entry) => entry.path.startsWith("/api/model-history"))
      .length,
    2,
  );
  const read = store.snapshot.peek()!;
  equal(read.history.commits.length, LONGEST_HISTORY);
  equal(read.history.truncated, true);
  equal(read.history.commits.some((entry) => entry.version === ROOT), false);
  equal(store.problem.peek(), null);
});

Deno.test("when the longer history cannot be read the usual one stands, told as cut", async () => {
  const data = longHistory(130);
  const host = modelHost({ data });
  const store = createModelHistory({
    api: createRevisionApi(
      ((path: string, init?: RequestInit) =>
        path.includes("limit=")
          ? Promise.resolve(Response.json({ error: "Down." }, { status: 503 }))
          : host.request(path, init)) as typeof fetch,
    ),
    sources: localSources(),
    selection: () => ({ kind: "commit", id: ROOT }),
    onChanged: () => {},
  });
  await store.refresh();
  equal(store.problem.peek(), null);
  const read = store.snapshot.peek()!;
  equal(read.history.commits.length, 100);
  equal(read.history.truncated, true);
});
