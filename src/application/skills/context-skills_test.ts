import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  type SkillAuthority,
  skillContentDigest,
  SkillError,
} from "../../domain/skills/context-skills.ts";
import type {
  SkillCatalogRecord,
} from "../../domain/skills/records/catalog.ts";
import { ContextSkillsService } from "./context-skills.ts";
import type {
  ContextSkillsPorts,
  SkillDownloadPort,
  SkillStorePort,
} from "./ports.ts";
import { skillSourceFixture } from "../../../test/support/skill-source-fixture.ts";

const text =
  "---\nname: ase-modeling\ndescription: Model exact contracts.\n---\n# Instructions\nPreserve explicit authority.\n";
const version = {
  digest: "a".repeat(64),
  repositoryVersion: "branch:admitted",
};
function auth(invocationId: string, ownerId = "builder"): SkillAuthority {
  return {
    callerId: ownerId,
    policy: {
      id: "skills-policy",
      ownerId,
      allowedHosts: ["example.org"],
      maxSkillBytes: 65536,
      maxInstalledSkills: 32,
      maxLoadedSkills: 4,
      maxLoadedCharacters: 48000,
    },
    modelVersion: version,
    behaviorId: "native-skill-operation",
    invocationId,
    permissions: ["install", "list", "load", "unload"],
  };
}
function fixture(
  options: {
    content?: string;
    download?: SkillDownloadPort;
    currentAuthority?: ContextSkillsPorts["assertCurrentAuthority"];
  } = {},
) {
  const catalogs = new Map<string, SkillCatalogRecord>();
  let downloads = 0, writes = 0;
  const sources = skillSourceFixture();
  const store: SkillStorePort = {
    load: (ownerId) =>
      Promise.resolve(structuredClone(catalogs.get(ownerId) ?? null)),
    async save(record, expected) {
      await Promise.resolve();
      const before = catalogs.get(record.ownerId);
      if ((before?.revision ?? null) !== expected) {
        throw new SkillError("conflict", "catalog revision changed");
      }
      catalogs.set(record.ownerId, structuredClone(record));
      writes++;
    },
  };
  const service = new ContextSkillsService({
    ...sources.ports,
    ...(options.currentAuthority
      ? { assertCurrentAuthority: options.currentAuthority }
      : {}),
    store,
    now: () => "2026-10-22T10:00:00.000Z",
    download: options.download ?? {
      download(url) {
        downloads++;
        const content = options.content ?? text;
        return Promise.resolve({
          content,
          requestedUrl: url,
          finalUrl: url,
          byteLength: new TextEncoder().encode(content).length,
        });
      },
    },
  });
  return {
    service,
    sources,
    catalogs,
    get downloads() {
      return downloads;
    },
    get writes() {
      return writes;
    },
  };
}
const install = (id = "ase-modeling") => ({
  id,
  url: `https://example.org/${id}/SKILL.md`,
});
const code = (value: unknown) => (error: unknown) =>
  error instanceof SkillError && error.code === value;

Deno.test("skills separate installed metadata from exact loaded instructions", async () => {
  const f = fixture();
  const installed = await f.service.install(auth("install"), install());
  equal(installed.skill.loaded, false);
  equal("content" in installed.skill, false);
  equal(installed.skill.name, "ase-modeling");
  equal(
    JSON.stringify(installed).includes("Preserve explicit authority"),
    false,
  );
  equal(
    JSON.stringify(await f.service.list(auth("list"))).includes("Instructions"),
    false,
  );
  deepStrictEqual(await f.service.guidance(auth("prepare")), []);
  const expected = {
    id: "ase-modeling",
    expectedDigest: installed.skill.digest,
  };
  const loaded = await f.service.load(auth("load"), expected);
  equal(loaded.skill.loaded, true);
  equal(loaded.content, text);
  equal((await f.service.guidance(auth("prepare")))[0]!.content, text);
  const unloaded = await f.service.unload(auth("unload"), expected);
  equal(unloaded.skill.loaded, false);
  equal("content" in unloaded.skill, false);
  deepStrictEqual(await f.service.guidance(auth("prepare")), []);
  const replay = await f.service.load(auth("load"), expected);
  equal(replay.replayed, true);
  equal(replay.skill.loaded, false);
  equal("content" in replay, false);
  equal(replay.catalogRevision, 3);
  equal(f.writes, 3);
});

Deno.test("skill installation replay never downloads twice or reuses an invocation", async () => {
  const f = fixture();
  const first = await f.service.install(auth("same"), install());
  const replay = await f.service.install(auth("same"), install());
  equal(replay.replayed, true);
  equal(replay.skill.digest, first.skill.digest);
  equal(f.downloads, 1);
  await rejects(
    f.service.install(auth("same"), install("other")),
    code("conflict"),
  );
  equal(f.downloads, 1);
  equal(f.writes, 1);
});

Deno.test("skill ownership and each native operation permission are explicit", async () => {
  const f = fixture();
  const wrongOwner = auth("install");
  wrongOwner.callerId = "peer";
  await rejects(f.service.install(wrongOwner, install()), code("forbidden"));
  const listOnly = auth("install");
  listOnly.permissions = ["list"];
  await rejects(f.service.install(listOnly, install()), code("forbidden"));
  const installed = await f.service.install(auth("install"), install());
  const expected = {
    id: installed.skill.id,
    expectedDigest: installed.skill.digest,
  };
  await rejects(f.service.load(listOnly, expected), code("forbidden"));
  await f.service.load(auth("load"), expected);
  await rejects(f.service.guidance(listOnly), code("forbidden"));
  const loadOnly = auth("load");
  loadOnly.permissions = ["load"];
  await rejects(f.service.load(loadOnly, expected), code("forbidden"));
  deepStrictEqual(await f.service.list(auth("list", "peer")), []);
  equal(f.downloads, 1);
});

Deno.test("skills reject changed digest and preserve immutable installed identities", async () => {
  const f = fixture();
  const badExpected = { ...install(), expectedDigest: "b".repeat(64) };
  await rejects(f.service.install(auth("bad"), badExpected), code("integrity"));
  equal(f.writes, 0);
  const installed = await f.service.install(auth("install"), install());
  await rejects(
    f.service.load(auth("load"), {
      id: installed.skill.id,
      expectedDigest: "b".repeat(64),
    }),
    code("conflict"),
  );
  const secondService = new ContextSkillsService({
    ...f.service.ports,
    store: f.service.ports.store,
    download: {
      download: (url) =>
        Promise.resolve({
          content: "Changed remote instructions",
          requestedUrl: url,
          finalUrl: url,
          byteLength: 27,
        }),
    },
  });
  await rejects(
    secondService.install(auth("change"), install()),
    code("conflict"),
  );
  equal(
    (await f.service.list(auth("list")))[0]!.digest,
    installed.skill.digest,
  );
  equal(f.writes, 1);
});

Deno.test("skill source policies deny unlisted hosts before download", async () => {
  const f = fixture();
  await rejects(
    f.service.install(auth("install"), {
      id: "ase",
      url: "https://other.org/ase/SKILL.md",
    }),
    code("forbidden"),
  );
  equal(f.downloads, 0);
  const limited = auth("install");
  limited.policy.maxSkillBytes = 256;
  const large = fixture({ content: text.repeat(4) });
  await rejects(large.service.install(limited, install()), code("limit"));
  equal(f.writes, 0);
});

Deno.test("skills reject mismatched download provenance and byte count", async () => {
  const f = fixture({
    download: {
      download: (url) =>
        Promise.resolve({
          content: text,
          requestedUrl: url,
          finalUrl: "https://other.org/SKILL.md",
          byteLength: text.length,
        }),
    },
  });
  await rejects(
    f.service.install(auth("install"), install()),
    code("integrity"),
  );
  equal(f.writes, 0);
  const broken = fixture({
    download: {
      download: (url) =>
        Promise.resolve({
          content: text,
          requestedUrl: url,
          finalUrl: url,
          byteLength: 1,
        }),
    },
  });
  await rejects(
    broken.service.install(auth("install"), install()),
    code("integrity"),
  );
});

Deno.test("skills enforce owner catalog CAS under concurrent installation limits", async () => {
  const f = fixture();
  const a = auth("one"), b = auth("two");
  a.policy.maxInstalledSkills = a.policy.maxLoadedSkills = 1;
  b.policy.maxInstalledSkills = b.policy.maxLoadedSkills = 1;
  const results = await Promise.allSettled([
    f.service.install(a, install("one")),
    f.service.install(b, install("two")),
  ]);
  equal(results.filter((result) => result.status === "fulfilled").length, 1);
  equal(f.catalogs.get("builder")!.skills.length, 1);
  const third = auth("third");
  third.policy.maxInstalledSkills = third.policy.maxLoadedSkills = 1;
  await rejects(f.service.install(third, install("three")), code("limit"));
});

Deno.test("skills enforce aggregate loaded count and exact text limits", async () => {
  const f = fixture({ content: text.repeat(4) });
  const first = await f.service.install(auth("one"), install("one"));
  const second = await f.service.install(auth("two"), install("two"));
  const a = auth("load-one"), b = auth("load-two");
  a.policy.maxLoadedSkills = b.policy.maxLoadedSkills = 1;
  const results = await Promise.allSettled([
    f.service.load(a, { id: "one", expectedDigest: first.skill.digest }),
    f.service.load(b, { id: "two", expectedDigest: second.skill.digest }),
  ]);
  equal(results.filter((result) => result.status === "fulfilled").length, 1);
  equal((await f.service.guidance(auth("prepare"))).length, 1);
  const short = auth("prepare");
  short.policy.maxLoadedCharacters = 256;
  await rejects(f.service.guidance(short), code("limit"));
  equal((await f.service.list(auth("list"))).length, 2);
});

Deno.test("skill bundled bootstrap is atomic and never reactivates unloaded seeds", async () => {
  const f = fixture();
  const seed = {
    id: "ase-modeling",
    content: text,
    source: "bundled:ase-modeling",
    expectedDigest: await skillContentDigest(text),
    loaded: true,
  };
  const installed = await f.service.installBundled(auth("bootstrap"), seed);
  equal(installed.skill.loaded, true);
  equal(installed.catalogRevision, 1);
  equal(f.writes, 1);
  equal(f.downloads, 0);
  await f.service.unload(auth("unload"), {
    id: seed.id,
    expectedDigest: seed.expectedDigest,
  });
  const replay = await f.service.installBundled(auth("bootstrap"), seed);
  equal(replay.replayed, true);
  equal(replay.skill.loaded, false);
  const nextPin = auth("bootstrap-new-pin");
  nextPin.modelVersion = { ...version, digest: "b".repeat(64) };
  const existing = await f.service.installBundled(nextPin, seed);
  equal(existing.skill.loaded, false);
  deepStrictEqual(await f.service.guidance(auth("prepare")), []);
});

Deno.test("initial bundled loading requires explicit load and list grants", async () => {
  const f = fixture();
  const installOnly = auth("bootstrap");
  installOnly.permissions = ["install"];
  const seed = {
    id: "ase",
    content: text,
    source: "bundled:ase",
    expectedDigest: await skillContentDigest(text),
    loaded: true,
  };
  await rejects(f.service.installBundled(installOnly, seed), code("forbidden"));
  equal(f.writes, 0);
  const installed = await f.service.installBundled(installOnly, {
    ...seed,
    loaded: false,
  });
  equal(installed.skill.loaded, false);
});

Deno.test("skill read detects corrupt installed content instead of injecting it", async () => {
  const f = fixture();
  const installed = await f.service.install(auth("install"), install());
  await f.service.load(auth("load"), {
    id: installed.skill.id,
    expectedDigest: installed.skill.digest,
  });
  f.catalogs.get("builder")!.skills[0]!.content = "Altered instruction text";
  await rejects(f.service.guidance(auth("prepare")), code("integrity"));
});

Deno.test("skill requests and authority are isolated while download awaits", async () => {
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => finish = resolve);
  const f = fixture({
    download: {
      async download(url) {
        await ready;
        return {
          content: text,
          requestedUrl: url,
          finalUrl: url,
          byteLength: text.length,
        };
      },
    },
  });
  const authority = auth("install");
  const request = install();
  const result = f.service.install(authority, request);
  authority.policy.ownerId = "peer";
  request.id = "changed";
  finish();
  const receipt = await result;
  equal(receipt.skill.id, "ase-modeling");
  equal(f.catalogs.has("peer"), false);
});

Deno.test("skills consume exact retained sources and fail closed when only cached text remains", async () => {
  const f = fixture();
  const installed = await f.service.install(auth("install"), install());
  equal(f.sources.publications.length, 1);
  equal(
    installed.skill.sourceBinding!.reference.contentDigest,
    installed.skill.digest,
  );
  const selection = {
    id: installed.skill.id,
    expectedDigest: installed.skill.digest,
  };
  f.sources.setUnavailable(true);
  await rejects(
    f.service.load(auth("load-unavailable"), selection),
    /Retained source unavailable/,
  );
  equal(f.catalogs.get("builder")!.skills[0]!.loaded, false);
  equal(f.writes, 1);
  f.sources.setUnavailable(false);
  await f.service.load(auth("load"), selection);
  equal((await f.service.guidance(auth("guidance")))[0]!.content, text);
  f.sources.replaceResolvedContent("Changed retained source bytes");
  await rejects(f.service.guidance(auth("mismatch")), code("integrity"));
  f.sources.replaceResolvedContent(undefined);
  f.sources.setUnavailable(true);
  await rejects(
    f.service.guidance(auth("missing")),
    /Retained source unavailable/,
  );
  // Disabling the selection does not need the unavailable instruction source.
  await f.service.unload(auth("disable"), selection);
  equal(f.catalogs.get("builder")!.skills[0]!.loaded, false);
  f.sources.setUnavailable(false);
  delete f.catalogs.get("builder")!.skills[0]!.sourceBinding;
  await rejects(f.service.load(auth("unbound"), selection), code("integrity"));
  equal((await f.service.list(auth("historical-metadata"))).length, 1);
});

Deno.test("retaining a source never installs it after current authority is revoked", async () => {
  let current = true;
  const f = fixture({
    currentAuthority: () => {
      if (!current) {
        return Promise.reject(
          new SkillError("forbidden", "current authority revoked"),
        );
      }
      return Promise.resolve();
    },
  });
  f.sources.afterPublication(() => {
    current = false;
  });
  await rejects(
    f.service.install(auth("install"), install()),
    code("forbidden"),
  );
  equal(f.sources.retained.size, 1);
  equal(f.catalogs.size, 0);
  equal(f.writes, 0);
  await rejects(
    f.service.install(auth("install"), install()),
    code("forbidden"),
  );
  equal(f.downloads, 1);
  equal(f.writes, 0);
});

Deno.test("current R1 authority reads the same installed and loaded R0 skill without reinstallation", async () => {
  const f = fixture();
  const r0 = auth("r0-install"),
    installed = await f.service.install(r0, install());
  await f.service.load(auth("r0-load"), {
    id: "ase-modeling",
    expectedDigest: installed.skill.digest,
  });
  const historical = structuredClone(f.catalogs.get("builder")!);
  const r1 = {
    ...auth("r1-guidance"),
    modelVersion: {
      digest: "c".repeat(64),
      repositoryVersion: `commit:${"d".repeat(40)}`,
    },
  };
  const guidance = await f.service.guidance(r1);
  equal(guidance.length, 1);
  equal(guidance[0].content, text);
  deepStrictEqual(f.catalogs.get("builder"), historical);
  equal(f.downloads, 1);
  equal(f.writes, 2);
});
