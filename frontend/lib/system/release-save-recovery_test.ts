import { withGlobals } from "../../test/support/globals.ts";
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import {
  localSkillRelease,
  RELEASE_HOST,
  RELEASE_VERSION,
} from "../../test/support/release-opening-fixture.ts";
import {
  createSavedSystemsController,
  type SavedSystemsApi,
  SavedSystemsReadError,
  type SavedSystemView,
} from "./saved-systems.ts";
import {
  currentReleaseSaveHost,
  type ReleaseSaveCommand,
} from "./release-save-intent.ts";

const tag = { mode: "create" as const, name: "v1" };
const source = {
  branch: { kind: "case" as const, caseId: "caseA" },
  sourceVersion: RELEASE_VERSION,
};
function fixture() {
  const stored = new Map<string, string>();
  const sent: ReleaseSaveCommand[] = [];
  let keyCount = 0;
  let reads = 0;
  let writesFail = false;
  let removesFail = false;
  let host = { ...RELEASE_HOST };
  let response: (input: ReleaseSaveCommand) => Promise<SavedSystemView> = () =>
    Promise.reject(new Error("ACK lost"));
  // The host's record is the last one it acknowledged, unless a test sets it.
  let recorded = localSkillRelease("accepted", "caseA");
  let inspected: SavedSystemView | null = null;
  let listCalls = 0;
  let listing: () => Promise<SavedSystemView[]> = () => Promise.resolve([]);
  const api: SavedSystemsApi = {
    tags: () => Promise.resolve([]),
    list: () => {
      listCalls++;
      return listing();
    },
    inspect: () => {
      reads++;
      return Promise.resolve(structuredClone(inspected ?? recorded));
    },
    save: (input) => {
      // A byte-for-byte recoverable command already exists at send time.
      const persisted = [...stored.values()].map((raw) => JSON.parse(raw));
      ok(
        persisted.some((v) =>
          JSON.stringify(v.command) === JSON.stringify(input)
        ),
      );
      sent.push(structuredClone(input));
      return response(input).then((view) => {
        recorded = view;
        return view;
      });
    },
  };
  const options = {
    origin: () => "http://127.0.0.1:4311",
    host: () => Promise.resolve(structuredClone(host)),
    storage: () => ({
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (writesFail) throw new Error("Quota blocked");
        stored.set(key, value);
      },
      removeItem: (key: string) => {
        if (removesFail) throw new Error("Removal blocked");
        stored.delete(key);
      },
    }),
  };
  return {
    stored,
    sent,
    options,
    controller: () =>
      createSavedSystemsController(
        api,
        () => {},
        () => `save-${++keyCount}`,
        options,
      ),
    keys: () => keyCount,
    reads: () => reads,
    listCalls: () => listCalls,
    list: (read: typeof listing) => {
      listing = read;
    },
    respond: (fn: typeof response) => {
      response = fn;
    },
    inspected: (view: SavedSystemView) => {
      inspected = view;
    },
    failWrites: () => {
      writesFail = true;
    },
    failRemoves: () => {
      removesFail = true;
    },
    host: (value: typeof host) => {
      host = value;
    },
  };
}
function receipt(
  command: ReleaseSaveCommand,
  status: SavedSystemView["status"] = "incomplete",
): SavedSystemView {
  const view = localSkillRelease(
    "accepted",
    command.source.branch.kind === "case"
      ? command.source.branch.caseId
      : undefined,
  );
  return {
    ...view,
    status,
    saveKey: command.saveKey,
    metadata: { name: command.name, purpose: command.purpose },
    ...(command.tag
      ? {
        tag: {
          selection: command.tag,
          binding: {
            name: command.tag.name,
            refOid: command.source.sourceVersion.slice(7),
            commitOid: command.source.sourceVersion.slice(7),
          },
          verified: true,
        },
        tagAvailability: "verified" as const,
      }
      : {}),
    source: { ...view.source!, ...command.source },
  };
}

Deno.test("automatic catalogue reads coalesce behind creation and preserve only the exact inspected revision", async () => {
  const f = fixture(), c = f.controller();
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<SavedSystemView>();
  f.respond(() => {
    entered.resolve();
    return completed.promise;
  });
  const creating = c.save("Exact release", "Reason", source, tag);
  await entered.promise;
  const accepted = receipt(f.sent[0]);
  f.list(() => Promise.resolve([accepted]));
  const returning = c.open();
  equal(c.open(), returning, "focus and visibility share one queued read");
  equal(f.listCalls(), 0, "a background read cannot overlap creation");
  completed.resolve(accepted);
  await creating;
  await returning;
  equal(f.sent.length, 1, "refresh never retries creation");
  equal(f.keys(), 1);
  deepStrictEqual(c.state.records, [accepted]);
  deepStrictEqual(c.state.selected, accepted);
  ok(c.state.repair);
  const changed = { ...accepted, revision: accepted.revision + 1 };
  f.list(() => Promise.resolve([changed]));
  await c.open();
  deepStrictEqual(c.state.records, [changed]);
  equal(c.state.selected, null, "a changed row needs a fresh exact inspection");
  equal(c.state.repair, null);
  equal(f.sent.length, 1);
  c.dispose();
});

Deno.test("disposed automatic catalogue reads cannot publish a stale source response", async () => {
  const f = fixture(), c = f.controller();
  const entered = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<SavedSystemView[]>();
  f.list(() => {
    entered.resolve();
    return completed.promise;
  });
  const reading = c.open();
  await entered.promise;
  c.dispose();
  completed.resolve([localSkillRelease("stale", "caseA")]);
  await reading;
  deepStrictEqual(c.state.records, []);
  equal(f.sent.length, 0);
});

Deno.test("queued catalogue refresh preserves an actionable failed save and successful explicit retry clears it", async () => {
  const f = fixture(), c = f.controller();
  const entered = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<SavedSystemView>();
  f.respond(() => {
    entered.resolve();
    return failed.promise;
  });
  const saving = c.save("Exact release", "Reason", source, tag);
  await entered.promise;
  const refresh = c.open();
  failed.reject(new Error("Creation acknowledgement lost"));
  await saving;
  await refresh;
  equal(c.state.error, "Creation acknowledgement lost");
  equal(c.state.readError, "");
  ok(c.state.intent);
  equal(f.sent.length, 1);
  f.list(() => Promise.reject(new Error("Catalogue temporarily unavailable")));
  await c.open();
  equal(c.state.error, "Creation acknowledgement lost");
  equal(c.state.readError, "Catalogue temporarily unavailable");
  f.list(() => Promise.resolve([]));
  await c.open();
  equal(
    c.state.readError,
    "",
    "a successful background read clears its own failure",
  );
  equal(c.state.error, "Creation acknowledgement lost");
  f.respond((command) => Promise.resolve(receipt(command)));
  await c.retry(source);
  equal(
    c.state.error,
    "",
    "explicit successful action retires its earlier error",
  );
  equal(c.state.intent, null);
  equal(f.sent.length, 2);
  deepStrictEqual(f.sent[0], f.sent[1]);
  equal(f.keys(), 1);
  c.dispose();
});
Deno.test("uncertain Release save survives reload without automatic send and exact same-source retry keeps key and normalized command", async () => {
  const f = fixture();
  const first = f.controller();
  await first.save("  Original  ", "  Purpose  ", source, tag);
  equal(f.sent.length, 1);
  const durable = [...f.stored.values()][0];
  equal(durable.includes("capabilitySecret"), false);
  equal(durable.includes(RELEASE_HOST.projectId), true);
  first.dispose();
  const next = f.controller();
  await next.open();
  equal(f.sent.length, 1);
  equal(next.state.intent?.command.name, "Original");
  await next.retry(source);
  deepStrictEqual(f.sent[1], f.sent[0]);
  equal(f.keys(), 1);
});
Deno.test("edited command, exact version or Main/Request switch cannot replace uncertain Release identity", async () => {
  const f = fixture();
  const c = f.controller();
  await c.save("Original", "Purpose", source, tag);
  const durable = [...f.stored.entries()];
  await c.save("Edited", "Purpose", source, tag);
  await c.retry({ ...source, sourceVersion: `commit:${"b".repeat(40)}` });
  await c.retry({ branch: { kind: "main" }, sourceVersion: RELEASE_VERSION });
  equal(f.sent.length, 1);
  equal(f.keys(), 1);
  deepStrictEqual([...f.stored.entries()], durable);
  match(c.state.error, /exact source/);
});
Deno.test("malformed, cross-host, extra-field and over-limit stored Release intentions block replacement", async () => {
  const originals = [
    "broken",
    JSON.stringify({ format: 1 }),
    "x".repeat(20_001),
  ];
  for (const corrupt of originals) {
    const f = fixture();
    await f.controller().save("Original", "Purpose", source, tag);
    const key = [...f.stored.keys()][0];
    f.stored.set(key, corrupt);
    const c = f.controller();
    await c.open();
    await c.save("Edited", "Purpose", source, tag);
    equal(f.sent.length, 1);
    equal(f.stored.get(key), corrupt);
    match(c.state.error, /unreadable/);
  }
  for (
    const change of [
      (v: Record<string, unknown>) => {
        v.host = { ...RELEASE_HOST, systemId: "Other::Host" };
      },
      (v: Record<string, unknown>) => {
        v.capabilitySecret = "do not deserialize extra fields";
      },
    ]
  ) {
    const f = fixture();
    await f.controller().save("Original", "Purpose", source, tag);
    const key = [...f.stored.keys()][0];
    const value = JSON.parse(f.stored.get(key)!);
    change(value);
    f.stored.set(key, JSON.stringify(value));
    await f.controller().save("Edited", "Purpose", source, tag);
    equal(f.sent.length, 1);
  }
});
Deno.test("storage failure prevents first send and malformed or mismatched ACK never retires an uncertain key", async () => {
  const blocked = fixture();
  blocked.failWrites();
  await blocked.controller().save("Original", "Purpose", source, tag);
  equal(blocked.sent.length, 0);
  for (
    const mutate of [
      (v: SavedSystemView) => ({ ...v, saveKey: "other-key" }),
      (v: SavedSystemView) => ({
        ...v,
        metadata: { ...v.metadata, name: "Other" },
      }),
      (v: SavedSystemView) => ({
        ...v,
        origin: { ...v.origin, projectId: "git:other" },
      }),
      (v: SavedSystemView) => ({
        ...v,
        source: { ...v.source!, branch: { kind: "main" as const } },
      }),
      (v: SavedSystemView) => ({ ...v, source: undefined }),
    ]
  ) {
    const f = fixture();
    f.respond((input) => Promise.resolve(mutate(receipt(input))));
    const c = f.controller();
    await c.save("Original", "Purpose", source, tag);
    ok(c.state.intent);
    equal(f.stored.size, 1);
    match(c.state.error, /acknowledgement/);
    await c.retry(source);
    equal(f.keys(), 1);
    deepStrictEqual(f.sent[0], f.sent[1]);
  }
});
Deno.test("exact incomplete PREREQUISITES_REQUIRED ACK frees uncertainty, permits deliberate new creation and repairs original canonical identity", async () => {
  const f = fixture();
  f.respond((input) => Promise.resolve(receipt(input)));
  const c = f.controller();
  await c.save("Original", "Purpose", source, tag);
  equal(c.state.selected?.status, "incomplete");
  deepStrictEqual(c.state.selected?.issues, ["PREREQUISITES_REQUIRED"]);
  equal(c.state.intent, null);
  equal(f.stored.size, 0);
  const original = structuredClone(f.sent[0]);
  const accepted = receipt(original);
  f.inspected(accepted);
  await c.save("Another", "Purpose", source, tag);
  equal(f.keys(), 2);
  equal(f.sent[1].saveKey, "save-2");
  c.dispose();
  const next = f.controller();
  await next.open();
  await next.inspect(accepted.id);
  equal(f.sent.length, 2);
  await next.repair(source);
  deepStrictEqual(f.sent[2], original);
  equal(f.keys(), 2);
  // One read for each of the three acknowledgements, the inspection, and the
  // repair's own canonical read.
  equal(f.reads(), 5);
});
Deno.test("each acknowledged save, retry and repair is read at once, so readiness is the host's", async () => {
  const f = fixture();
  const c = f.controller();
  await c.save("Original", "Purpose", source, tag);
  equal(f.reads(), 0, "a lost acknowledgement reads nothing");
  f.respond((input) => Promise.resolve(receipt(input)));
  f.inspected({
    ...receipt(f.sent[0]),
    assetAvailability: "verified",
    openingAvailability: "ready",
    openingIssues: [],
  });
  await c.retry(source);
  equal(f.reads(), 1);
  equal(c.state.selected?.openingAvailability, "ready");
  await c.repair(source);
  equal(f.sent.length, 3);
  equal(f.reads(), 3, "the repair's canonical read, then its acknowledgement");
  await c.save("Another", "Purpose", source, tag);
  equal(f.sent.length, 4);
  equal(f.reads(), 4);
  c.dispose();
});
Deno.test("pending ACK is acknowledged, while 403, receipt removal failure and source drift preserve exact recovery", async () => {
  const pending = fixture();
  pending.respond((input) => Promise.resolve(receipt(input, "pending")));
  const c = pending.controller();
  await c.save("Original", "Purpose", source, tag);
  equal(c.state.selected?.status, "pending");
  equal(c.state.intent, null);
  const denied = fixture();
  denied.respond(() =>
    Promise.reject(
      new SavedSystemsReadError("FORBIDDEN", "Authority withdrawn"),
    )
  );
  const d = denied.controller();
  await d.save("Original", "Purpose", source, tag);
  equal(d.state.refused, true);
  ok(d.state.intent);
  equal(denied.stored.size, 1);
  const removal = fixture();
  removal.failRemoves();
  removal.respond((input) => Promise.resolve(receipt(input)));
  const r = removal.controller();
  await r.save("Original", "Purpose", source, tag);
  ok(r.state.intent);
  equal(removal.stored.size, 1);
  const switched = fixture();
  const s = switched.controller();
  await s.save("Original", "Purpose", source, tag);
  switched.host({ ...RELEASE_HOST, systemId: "Assembly::Other" });
  await s.retry(source);
  equal(switched.sent.length, 1);
  match(s.state.error, /host changed/);
});
Deno.test("repair re-inspects canonical visibility, refuses switched records and never replaces another uncertain command", async () => {
  const f = fixture();
  const c = f.controller();
  await c.inspect("accepted");
  f.inspected({
    ...localSkillRelease("accepted", "caseA"),
    saveKey: "switched",
  });
  await c.repair(source);
  equal(f.sent.length, 0);
  f.inspected(localSkillRelease("accepted", "caseA"));
  await c.inspect("accepted");
  await c.save("Different", "Purpose", source, tag);
  await c.repair(source);
  equal(f.sent.length, 1);
  equal(f.keys(), 1);
});
Deno.test("Release host namespace accepts actual git project and qualified system locators with credentialed no-store context read", async () => {
  const qualified = { ...RELEASE_HOST, systemId: "Assembly::Primary" };
  const fetch = ((path, init) => {
    equal(String(path), "/api/request-space-openings/context");
    equal(init?.credentials, "same-origin");
    equal(init?.cache, "no-store");
    return Promise.resolve(Response.json(qualified));
  }) as typeof globalThis.fetch;
  deepStrictEqual(
    await withGlobals({ fetch }, () => currentReleaseSaveHost()),
    qualified,
  );
});
Deno.test("terminal retained/conflict ACK retires only the matched intention and an unmounted ACK remains recoverable", async () => {
  for (const status of ["retained", "conflict"] as const) {
    const f = fixture();
    f.respond((input) => Promise.resolve(receipt(input, status)));
    const c = f.controller();
    await c.save("Original", "Purpose", source, tag);
    equal(c.state.intent, null);
    equal(f.stored.size, 0);
    equal(c.state.repair, null);
    equal(c.state.selected?.status, status);
  }
  const f = fixture();
  let finish!: (value: SavedSystemView) => void;
  let started!: () => void;
  const seen = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.respond(() => {
    started();
    return new Promise<SavedSystemView>((resolve) => {
      finish = resolve;
    });
  });
  const c = f.controller();
  const flight = c.save("Original", "Purpose", source, tag);
  await seen;
  c.dispose();
  finish(receipt(f.sent[0]));
  await flight;
  equal(f.stored.size, 1);
  const next = f.controller();
  await next.open();
  deepStrictEqual(next.state.intent?.command, f.sent[0]);
  equal(f.sent.length, 1);
});

Deno.test("contradictory or malformed execution-space ACK preserves uncertainty while independent valid Request IDs are accepted", async () => {
  const main = {
    branch: { kind: "main" as const },
    sourceVersion: RELEASE_VERSION,
  };
  for (const selected of [source, main]) {
    const malformed: unknown[] = [
      undefined,
      null,
      0,
      "",
      "*",
      " bad ",
      "Assembly::Primary",
      "x".repeat(129),
      selected.branch.kind === "main" ? "request-runtime-42" : "main",
    ];
    for (const executionSpaceId of malformed) {
      const f = fixture();
      f.respond((input) => {
        const view = receipt(input);
        return Promise.resolve({
          ...view,
          origin: {
            ...view.origin,
            executionSpaceId: executionSpaceId as string,
          },
        });
      });
      const c = f.controller();
      await c.save("Original", "Purpose", selected, tag);
      ok(c.state.intent);
      equal(f.stored.size, 1);
      match(c.state.error, /acknowledgement/);
      await c.retry(selected);
      deepStrictEqual(f.sent[0], f.sent[1]);
      equal(f.keys(), 1);
    }
  }
  const valid = fixture();
  valid.respond((input) => {
    const view = receipt(input);
    return Promise.resolve({
      ...view,
      origin: { ...view.origin, executionSpaceId: "independent-runtime-42" },
    });
  });
  const c = valid.controller();
  await c.save("Original", "Purpose", source, tag);
  equal(c.state.intent, null);
  equal(valid.stored.size, 0);
  equal(c.state.selected?.origin.executionSpaceId, "independent-runtime-42");
});
Deno.test("canonical repair refuses initial or refreshed Main/Request execution-space contradictions before sending", async () => {
  for (const caseId of [undefined, "caseA"]) {
    const selected = caseId
      ? source
      : { branch: { kind: "main" as const }, sourceVersion: RELEASE_VERSION };
    const view = localSkillRelease("accepted", caseId);
    const contradiction = {
      ...view,
      origin: {
        ...view.origin,
        executionSpaceId: caseId ? "main" : "request-runtime-42",
      },
    };
    const f = fixture();
    f.inspected(contradiction);
    const c = f.controller();
    await c.inspect(view.id);
    equal(c.state.repair, null);
    await c.repair(selected);
    equal(f.sent.length, 0);
    equal(f.stored.size, 0);
    f.inspected(view);
    await c.inspect(view.id);
    ok(c.state.repair);
    f.inspected(contradiction);
    await c.repair(selected);
    equal(f.sent.length, 0);
    equal(f.stored.size, 0);
  }
});

Deno.test("a new release requires a tag and retries retain the original tag", async () => {
  const f = fixture(), c = f.controller();
  await c.save("Original", "Purpose", source);
  equal(f.sent.length, 0);
  await c.save("Original", "Purpose", source, tag);
  equal(f.sent.length, 1);
  deepStrictEqual(c.state.intent?.command.tag, tag);
  await c.save("Original", "Purpose", source, { ...tag, name: "v2" });
  equal(f.sent.length, 1);
  await c.retry(source);
  deepStrictEqual(f.sent[1].tag, tag);
});

Deno.test("legacy untagged uncertain intention is retried unchanged", async () => {
  const f = fixture();
  await f.controller().save("Original", "Purpose", source, tag);
  const key = [...f.stored.keys()][0];
  const intent = JSON.parse(f.stored.get(key)!);
  delete intent.command.tag;
  f.stored.set(key, JSON.stringify(intent));
  f.respond((command) => Promise.resolve(receipt(command)));
  const resumed = f.controller();
  await resumed.open();
  await resumed.retry(source);
  equal(f.sent[1].tag, undefined);
  equal(f.sent[1].saveKey, intent.command.saveKey);
  equal(resumed.state.intent, null);
});

Deno.test("malformed tag acknowledgement preserves the exact pending intention", async () => {
  const f = fixture(), c = f.controller();
  f.respond((command) => {
    const view = receipt(command);
    return Promise.resolve({
      ...view,
      tag: {
        ...view.tag!,
        binding: { ...view.tag!.binding, commitOid: "b".repeat(40) },
      },
    });
  });
  await c.save("Original", "Purpose", source, tag);
  ok(c.state.intent);
  equal(f.stored.size, 1);
  match(c.state.error, /acknowledgement/);
});

Deno.test("a matching terminal tag rejection releases the original intention; malformed or changed rejections do not", async () => {
  for (const variant of ["matching", "changed", "malformed"] as const) {
    const f = fixture(), c = f.controller();
    f.respond((command) => {
      const { tag: _tag, tagAvailability: _availability, ...record } = receipt(
        command,
      );
      return Promise.resolve({
        ...record,
        status: "conflict",
        manifest: null,
        digest: null,
        rejection: {
          code: "TAG_UNAVAILABLE",
          tag: variant === "changed"
            ? { ...command.tag!, name: "other" }
            : variant === "malformed"
            ? { ...command.tag!, name: "bad tag" }
            : command.tag!,
        },
      });
    });
    await c.save("Original", "Purpose", source, tag);
    if (variant === "matching") {
      equal(c.state.intent, null);
      equal(f.stored.size, 0);
      equal(c.state.selected?.rejection?.tag.name, tag.name);
    } else {
      ok(c.state.intent);
      equal(f.stored.size, 1);
      match(c.state.error, /acknowledgement/);
    }
  }
});

Deno.test("matching stale-source terminal acknowledgement frees only the exact intention", async () => {
  for (
    const variant of [
      "matching",
      "changed-tag",
      "changed-source",
      "malformed",
    ] as const
  ) {
    const f = fixture(), c = f.controller();
    f.respond((command) => {
      const { tag: _tag, tagAvailability: _availability, ...record } = receipt(
        command,
      );
      return Promise.resolve({
        ...record,
        source: variant === "changed-source"
          ? { ...record.source!, sourceVersion: `commit:${"b".repeat(40)}` }
          : record.source,
        status: variant === "malformed" ? "pending" : "conflict",
        manifest: null,
        digest: null,
        rejection: {
          code: "SOURCE_STALE",
          tag: variant === "changed-tag"
            ? { ...command.tag!, name: "different" }
            : command.tag!,
        },
      });
    });
    await c.save("Original", "Purpose", source, tag);
    if (variant === "matching") {
      equal(c.state.intent, null);
      equal(f.stored.size, 0);
      equal(c.state.selected?.rejection?.code, "SOURCE_STALE");
      const corrected = {
        ...source,
        sourceVersion: `commit:${"b".repeat(40)}`,
      };
      await c.save("Original", "Purpose", corrected, tag);
      equal(f.sent.length, 2);
      equal(f.sent[1].saveKey, "save-2");
      deepStrictEqual(f.sent[1].source, corrected);
    } else {
      ok(c.state.intent);
      equal(f.stored.size, 1);
      match(c.state.error, /acknowledgement/);
    }
  }
});
