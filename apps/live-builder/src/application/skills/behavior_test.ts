import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { skillSourceFixture } from "../../../test/support/skill-source-fixture.ts";
import { artifactModel } from "../../../test/support/tool-artifact-fixture.ts";
import { ContextSkillsService } from "./context-skills.ts";
import {
  ContextRepresentationLimitError,
  projectDecisionContext,
} from "../work/context/separation.ts";
import type { SkillStorePort } from "./ports.ts";
import {
  skillContentDigest,
  SkillError,
} from "../../domain/skills/context-skills.ts";
import type {
  SkillCatalogRecord,
} from "../../domain/skills/records/catalog.ts";
import type {
  BehaviorInvocationRequest,
} from "../../domain/work/execution/modeled-behavior.ts";
import type {
  NativeBehaviorContract,
} from "../../domain/model/execution/native-contracts.ts";
import type { OperatorEntry } from "../../domain/model/records/operator-entry.ts";
import { SkillsBehavior } from "./behavior.ts";

const ownerId = "builder";
const text =
  "---\nname: ase-modeling\ndescription: Assemble source-owned behavior.\n---\n# Instructions\nExact local skill instructions.\n";
const kinds = [
  "skill-install",
  "skill-list",
  "skill-load",
  "skill-unload",
] as const;
type Kind = typeof kinds[number];

function behavior(kind: Kind): NativeBehaviorContract {
  const fields = kind === "skill-list"
    ? []
    : kind === "skill-install"
    ? ["id", "url", "expectedDigest"]
    : ["id", "expectedDigest"];
  return {
    id: `${kind}-access`,
    name: kind,
    description: "Local context instruction operation.",
    callerNativeId: ownerId,
    targetNativeId: `${kind}-target`,
    targetTypeId: `${kind}-type`,
    inputTypeId: `${kind}-input`,
    sourceIds: [`${kind}-source`],
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(
        fields.map((name) => [name, { type: "string" }]),
      ),
      required: fields.filter((field) =>
        kind !== "skill-install" || field !== "expectedDigest"
      ),
      additionalProperties: false,
    },
  };
}

function fixture() {
  const model = artifactModel(ownerId);
  model.skillPolicy = {
    kind: "lazy-skills",
    id: "local-skills",
    revision: 1,
    elementId: "skills-policy",
    sourceIds: ["policy-source"],
    ownerId,
    allowedHosts: ["example.org"],
    maxSkillBytes: 65536,
    maxInstalledSkills: 8,
    maxLoadedSkills: 4,
    maxLoadedCharacters: 48000,
  };
  model.behaviors = kinds.map(behavior);
  const entries = new Map<
    string,
    { ownerId: string; kind: OperatorEntry["kind"] }
  >();
  model.operatorEntries = kinds.map((kind) => {
    const native = behavior(kind);
    entries.set(native.targetNativeId, { ownerId, kind });
    return {
      id: native.targetNativeId,
      kind,
      typeId: native.targetTypeId,
      performerId: "admission-gate",
      allocationId: `${kind}-allocation`,
      sourceIds: [`${kind}-source`],
    };
  });
  const catalogs = new Map<string, SkillCatalogRecord>();
  let downloads = 0, writes = 0, bundledReads = 0;
  let bundledContent = text;
  const store: SkillStorePort = {
    load: (owner) =>
      Promise.resolve(structuredClone(catalogs.get(owner) ?? null)),
    save(record, expected) {
      equal(catalogs.get(record.ownerId)?.revision ?? null, expected);
      catalogs.set(record.ownerId, structuredClone(record));
      writes++;
      return Promise.resolve();
    },
  };
  const sources = skillSourceFixture();
  const service: ContextSkillsService = new ContextSkillsService({
    ...sources.ports,
    assertCurrentAuthority: (authority, permission): Promise<void> =>
      adapter.assertCurrentAuthority(authority, permission),
    store,
    download: {
      download(url) {
        downloads++;
        return Promise.resolve({
          content: text,
          requestedUrl: url,
          finalUrl: url,
          byteLength: new TextEncoder().encode(text).length,
        });
      },
    },
    now: () => "2026-10-22T01:00:00.000Z",
  });
  const adapter: SkillsBehavior = new SkillsBehavior({
    entries,
    skills: (): Promise<ContextSkillsService> => Promise.resolve(service),
    readBundledSkill(source, maximumBytes) {
      equal(source, "bundle:ase-modeling");
      equal(maximumBytes, model.skillPolicy!.maxSkillBytes);
      bundledReads++;
      return Promise.resolve(bundledContent);
    },
    resolveCallerModel(caller, pin) {
      return Promise.resolve(
        caller === model.identity.builderId &&
          pin.digest === model.version.digest &&
          pin.repositoryVersion === model.version.repositoryVersion
          ? structuredClone(model)
          : null,
      );
    },
  });
  const request = (
    kind: Kind,
    input: Record<string, unknown>,
    invocationId = kind,
  ): BehaviorInvocationRequest => ({
    behavior: behavior(kind),
    input,
    callerId: ownerId,
    invocationId,
    modelVersion: {
      digest: model.version.digest,
      repositoryVersion: model.version.repositoryVersion!,
    },
  });
  return {
    model,
    entries,
    service,
    sources,
    adapter,
    request,
    catalogs,
    setBundledContent(content: string) {
      bundledContent = content;
    },
    get bundledReads() {
      return bundledReads;
    },
    get downloads() {
      return downloads;
    },
    get writes() {
      return writes;
    },
  };
}

Deno.test("skill native calls keep installed text out of receipts and inject only loaded exact versions", async () => {
  const f = fixture();
  const installation = f.request("skill-install", {
    id: "ase-modeling",
    url: "https://example.org/ase-modeling/SKILL.md",
  });
  equal(
    await f.adapter.supports(installation.behavior, installation.modelVersion),
    true,
  );
  const installed = await f.adapter.invoke(installation);
  equal(
    JSON.stringify(installed).includes("Exact local skill instructions"),
    false,
  );
  let context = await f.adapter.read(f.model);
  equal(context.skills!.catalog.length, 1);
  equal(context.skills!.loaded.length, 0);
  equal(
    JSON.stringify(context).includes("Exact local skill instructions"),
    false,
  );
  const digest = await skillContentDigest(text);
  const load = f.request("skill-load", {
    id: "ase-modeling",
    expectedDigest: digest,
  });
  await f.adapter.invoke(load);
  context = await f.adapter.read(f.model);
  equal(context.skills!.loaded[0]!.content, text);
  equal("sourceIds" in context.skills!.policy, false);
  const listed = await f.adapter.invoke(f.request("skill-list", {}));
  equal(
    JSON.stringify(listed).includes("Exact local skill instructions"),
    false,
  );
  await f.adapter.invoke(
    f.request("skill-unload", { id: "ase-modeling", expectedDigest: digest }),
  );
  equal(
    JSON.stringify(await f.adapter.read(f.model)).includes(
      "Exact local skill instructions",
    ),
    false,
  );
  const replayed = await f.adapter.invoke(load);
  equal(JSON.stringify(replayed).includes('"loaded":false'), true);
  deepStrictEqual((await f.adapter.read(f.model)).skills!.loaded, []);
  equal(f.downloads, 1);
});

Deno.test("skill source authority reuses the current native exposure and rejects policy or exposure drift", async () => {
  const f = fixture();
  await f.adapter.invoke(f.request("skill-install", {
    id: "source-authority",
    url: "https://example.org/source-authority/SKILL.md",
  }));
  const proof = f.sources.publications[0]!.proof;
  if (proof.kind !== "skill-authority") {
    throw new Error("Missing captured skill authority");
  }
  await f.adapter.assertCurrentAuthority(proof.authority, "install");
  const originalPolicy = structuredClone(f.model.skillPolicy!);
  f.model.skillPolicy!.maxSkillBytes++;
  await rejects(
    f.adapter.assertCurrentAuthority(proof.authority, "install"),
    (error) => error instanceof SkillError && error.code === "forbidden",
  );
  f.model.skillPolicy = originalPolicy;
  f.model.behaviors = f.model.behaviors!.filter((entry) =>
    entry.id !== proof.authority.behaviorId
  );
  await rejects(
    f.adapter.assertCurrentAuthority(proof.authority, "install"),
    (error) => error instanceof SkillError && error.code === "forbidden",
  );
});

Deno.test("skill exposure rejects another owner, altered contract, unregistered target and stale source before effects", async () => {
  const f = fixture();
  const input = f.request("skill-install", {
    id: "ase-modeling",
    url: "https://example.org/ase-modeling/SKILL.md",
  });
  const peer = structuredClone(input);
  peer.callerId = "other";
  await rejects(f.adapter.invoke(peer));
  const altered = structuredClone(input);
  altered.behavior.description = "Unadmitted contract";
  equal(
    await f.adapter.supports(altered.behavior, altered.modelVersion),
    false,
  );
  await rejects(f.adapter.invoke(altered));
  const stale = structuredClone(input);
  stale.modelVersion.repositoryVersion = "branch:other";
  await rejects(f.adapter.invoke(stale));
  const target = structuredClone(input);
  target.behavior.targetNativeId = "other-target";
  await rejects(f.adapter.invoke(target));
  const schema = structuredClone(input);
  schema.behavior.inputSchema.additionalProperties = true;
  await rejects(f.adapter.invoke(schema));
  equal(f.downloads, 0);
  equal(f.writes, 0);
});

Deno.test("revoked native list or load rights hide instructions even while installed selection persists", async () => {
  const f = fixture();
  await f.adapter.invoke(
    f.request("skill-install", {
      id: "ase-modeling",
      url: "https://example.org/ase-modeling/SKILL.md",
    }),
  );
  await f.adapter.invoke(
    f.request("skill-load", {
      id: "ase-modeling",
      expectedDigest: await skillContentDigest(text),
    }),
  );
  f.model.behaviors = f.model.behaviors!.filter((entry) =>
    entry.id !== "skill-load-access"
  );
  const listOnly = await f.adapter.read(f.model);
  equal(listOnly.skills!.catalog[0]!.loaded, true);
  deepStrictEqual(listOnly.skills!.loaded, []);
  f.model.behaviors = [];
  const none = await f.adapter.read(f.model);
  deepStrictEqual(none.skills!.catalog, []);
  deepStrictEqual(none.skills!.loaded, []);
  equal(JSON.stringify(none).includes("Exact local skill instructions"), false);
});

Deno.test("skill bootstrap uses resolved source seeds and never reloads a persisted unloaded skill", async () => {
  const f = fixture();
  const digest = await skillContentDigest(text);
  f.model.initialSkills = [{
    nativeId: "initial-skill",
    id: "ase-modeling",
    source: "bundle:ase-modeling",
    digest,
    loaded: true,
    sourceIds: ["initial-source"],
  }];
  const forged = structuredClone(f.model);
  forged.initialSkills![0]!.source = "bundle:unadmitted-replacement";
  await f.adapter.initialize(forged);
  equal((await f.adapter.read(f.model)).skills!.loaded[0]!.content, text);
  await f.adapter.invoke(
    f.request("skill-unload", { id: "ase-modeling", expectedDigest: digest }),
  );
  const before = f.writes;
  await f.adapter.initialize(f.model);
  equal(f.writes, before);
  equal(f.bundledReads, 1);
  deepStrictEqual((await f.adapter.read(f.model)).skills!.loaded, []);
  equal(f.downloads, 0);
});

Deno.test("skill bootstrap cannot implicitly load without an admitted load grant", async () => {
  const f = fixture();
  f.model.initialSkills = [{
    nativeId: "initial-skill",
    id: "ase-modeling",
    source: "bundle:ase-modeling",
    digest: await skillContentDigest(text),
    loaded: true,
    sourceIds: ["initial-source"],
  }];
  f.model.behaviors = f.model.behaviors!.filter((entry) =>
    entry.id !== "skill-load-access"
  );
  await rejects(f.adapter.initialize(f.model));
  equal(f.writes, 0);
  deepStrictEqual((await f.adapter.read(f.model)).skills!.loaded, []);
});

Deno.test("bundled initial instructions must match their source-admitted digest before any installation", async () => {
  const f = fixture();
  f.model.initialSkills = [{
    nativeId: "initial-skill",
    id: "ase-modeling",
    source: "bundle:ase-modeling",
    digest: await skillContentDigest(text),
    loaded: true,
    sourceIds: ["initial-source"],
  }];
  f.setBundledContent(
    "A changed local file must never replace the admitted instructions.",
  );
  await rejects(f.adapter.initialize(f.model), /expectedDigest/);
  equal(f.writes, 0);
  deepStrictEqual((await f.adapter.read(f.model)).skills!.loaded, []);
});

Deno.test("legacy models need no skills service and unexpected backend failures stay private", async () => {
  const f = fixture();
  delete f.model.skillPolicy;
  deepStrictEqual(await f.adapter.read(f.model), {});
  await f.adapter.initialize(f.model);
  equal(f.writes, 0);
  const hidden = new SkillsBehavior({
    entries: f.entries,
    resolveCallerModel: () =>
      Promise.resolve({
        ...f.model,
        skillPolicy: {
          kind: "lazy-skills",
          id: "local-skills",
          revision: 1,
          elementId: "policy",
          sourceIds: [],
          ownerId,
          allowedHosts: [],
          maxSkillBytes: 65536,
          maxInstalledSkills: 8,
          maxLoadedSkills: 4,
          maxLoadedCharacters: 48000,
        },
      }),
    skills() {
      throw new Error("secret storage path /private");
    },
  });
  await rejects(
    hidden.invoke(f.request("skill-list", {})),
    (error) =>
      error instanceof Error &&
      error.message === "L’opération de skills locaux n’a pas abouti.",
  );
});

Deno.test("internal loaded instructions use native skill and total-context limits rather than the RPC byte cap", async () => {
  const f = fixture();
  const content = "Référence exacte. ".repeat(18000);
  f.model.skillPolicy!.maxSkillBytes = 700000;
  f.model.skillPolicy!.maxLoadedCharacters = 700000;
  f.setBundledContent(content);
  f.model.initialSkills = [{
    nativeId: "initial-skill",
    id: "ase-modeling",
    source: "bundle:ase-modeling",
    digest: await skillContentDigest(content),
    loaded: true,
    sourceIds: ["initial-source"],
  }];
  await f.adapter.initialize(f.model);
  const current = await f.adapter.read(f.model);
  equal(current.skills!.loaded[0]!.content, content);
  equal(
    new TextEncoder().encode(JSON.stringify(current)).length > 262144,
    true,
  );
  const context = { messages: [], activeTools: [], candidates: [], ...current };
  const policy = {
    kind: "separated-context" as const,
    pattern: "5.1" as const,
    recentMessages: 1,
    maxMessageCharacters: 256,
    maxCollectionItems: 1,
    maxContextCharacters: 600000,
  };
  equal(
    (await projectDecisionContext(context, policy)).skills!.loaded[0]!.content,
    content,
  );
  await rejects(
    projectDecisionContext(context, { ...policy, maxContextCharacters: 4096 }),
    ContextRepresentationLimitError,
  );
  f.model.skillPolicy!.maxLoadedCharacters = content.length - 1;
  await rejects(f.adapter.read(f.model), /loaded instructions exceed/);
});
