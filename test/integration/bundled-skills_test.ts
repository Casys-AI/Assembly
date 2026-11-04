import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  BundledSkillReadError,
  type BundledSkillReadErrorCode,
} from "../../src/application/skills/ports.ts";
import {
  bundledSkillReader,
  pinBundledSkillDigests,
} from "../../src/adapters/out/filesystem/skill-bundles.ts";
import { artifactModel } from "../support/tool-artifact-fixture.ts";
import { skillContentDigest } from "../../src/domain/skills/context-skills.ts";
import { inspectRequestInitialSkills } from "../../src/application/skills/request-initial-skills.ts";

const readerFailure = (code: BundledSkillReadErrorCode) => (error: unknown) =>
  error instanceof BundledSkillReadError && error.code === code;

Deno.test("current and legacy bundled skills keep their exact content and independent pins", async () => {
  const read = bundledSkillReader();
  const legacy = await read("bundle:ase-modeling", 65_536);
  const current = await read("bundle:assembly-modeling", 65_536);
  const digest = (content: string) =>
    createHash("sha256").update(content, "utf8").digest("hex");
  // This is the admitted asset's pre-rename digest. Editing its text breaks
  // historical pins even if the new skill is semantically equivalent.
  equal(
    digest(legacy),
    "6284ee61155711dd3ddfb6d980c31093f1e8d19df39e3a7888fb97da829436a7",
  );
  equal(current.includes("name: assembly-modeling"), true);
  equal(current === legacy, false);
  const fragment =
    'attribute old = "__ASE_SKILL_DIGEST__"; attribute current = "__ASSEMBLY_SKILL_DIGEST__";';
  equal(
    await pinBundledSkillDigests(fragment),
    `attribute old = "${digest(legacy)}"; attribute current = "${
      digest(current)
    }";`,
  );
  const historical = `attribute digest = "${digest(legacy)}";`;
  equal(await pinBundledSkillDigests(historical), historical);
});

Deno.test("bundled skill reader preserves exact UTF-8 and confines source references", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-skill-bundle-" });
  try {
    await Deno.mkdir(join(root, "ase-modeling"));
    const content =
      "\ufeff---\nname: ase-modeling\n---\nUne instruction vérifiable.\n";
    await Deno.writeTextFile(join(root, "ase-modeling", "SKILL.md"), content);
    const read = bundledSkillReader(root);
    equal(await read("bundle:ase-modeling", 1000), content);
    await rejects(
      () => read("bundle:ase-modeling", 10),
      readerFailure("limit"),
    );
    for (
      const source of [
        "bundle:../ase-modeling",
        "bundle:ase-modeling/SKILL.md",
        "file:///etc/passwd",
        "bundle:ase-modeling..",
      ]
    ) await rejects(() => read(source, 1000), readerFailure("unavailable"));
    await Deno.symlink(join(root, "ase-modeling"), join(root, "linked"));
    await rejects(
      () => read("bundle:linked", 1000),
      readerFailure("unavailable"),
    );
    await Deno.mkdir(join(root, "linked-file"));
    await Deno.symlink(
      join(root, "ase-modeling", "SKILL.md"),
      join(root, "linked-file", "SKILL.md"),
    );
    await rejects(
      () => read("bundle:linked-file", 1000),
      readerFailure("unavailable"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("bundled skill reader refuses invalid UTF-8 instead of changing bytes", async () => {
  const root = await Deno.makeTempDir({ prefix: "ase-skill-encoding-" });
  try {
    await Deno.mkdir(join(root, "broken"));
    await Deno.writeFile(
      join(root, "broken", "SKILL.md"),
      new Uint8Array([0xc3, 0x28]),
    );
    await rejects(
      () => bundledSkillReader(root)("bundle:broken", 1000),
      readerFailure("invalid-content"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy bundle prefers its archive and falls back only for an absent directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "assembly-legacy-layout-" });
  try {
    const old = join(root, "ase-modeling");
    const legacy = join(root, "legacy");
    const archived = join(legacy, "ase-modeling");
    await Deno.mkdir(old);
    await Deno.writeTextFile(join(old, "SKILL.md"), "old layout");
    const read = bundledSkillReader(root);
    equal(await read("bundle:ase-modeling", 1000), "old layout");
    await Deno.mkdir(legacy);
    equal(await read("bundle:ase-modeling", 1000), "old layout");
    await Deno.mkdir(archived);
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("unavailable"),
    );
    await Deno.writeTextFile(join(archived, "SKILL.md"), "archive");
    equal(await read("bundle:ase-modeling", 1000), "archive");
    await Deno.remove(old, { recursive: true });
    equal(await read("bundle:ase-modeling", 1000), "archive");
    await Deno.mkdir(old);
    await Deno.writeTextFile(join(old, "SKILL.md"), "ok");
    await rejects(() => read("bundle:ase-modeling", 2), readerFailure("limit"));
    await Deno.writeFile(
      join(archived, "SKILL.md"),
      new Uint8Array([0xc3, 0x28]),
    );
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("invalid-content"),
    );
    await Deno.remove(join(archived, "SKILL.md"));
    await Deno.symlink(join(old, "SKILL.md"), join(archived, "SKILL.md"));
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("unavailable"),
    );
    await Deno.remove(archived, { recursive: true });
    await Deno.writeTextFile(archived, "invalid directory");
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("unavailable"),
    );
    await Deno.remove(archived);
    await Deno.symlink(old, archived);
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("unavailable"),
    );
    await Deno.remove(archived);
    await Deno.symlink(join(root, "missing"), archived);
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("unavailable"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("legacy bundle refuses concrete-file and symbolic archive parents", async () => {
  const root = await Deno.makeTempDir({ prefix: "assembly-legacy-parent-" });
  try {
    const old = join(root, "ase-modeling");
    const legacy = join(root, "legacy");
    await Deno.mkdir(old);
    await Deno.writeTextFile(join(old, "SKILL.md"), "old layout");
    const read = bundledSkillReader(root);
    await Deno.writeTextFile(legacy, "invalid parent");
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("unavailable"),
    );
    await Deno.remove(legacy);
    await Deno.symlink(root, legacy);
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("unavailable"),
    );
    await Deno.remove(legacy);
    await Deno.symlink(join(root, "missing"), legacy);
    await rejects(
      () => read("bundle:ase-modeling", 1000),
      readerFailure("unavailable"),
    );
    // Archive validation applies only to the historical bundle identifier.
    await rejects(
      () => read("bundle:other", 1000),
      readerFailure("unavailable"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function inspectionModel(source: string, content: string) {
  const model = artifactModel("bundle-owner");
  model.version.digest = "b".repeat(64);
  model.version.repositoryVersion = `commit:${"a".repeat(40)}`;
  const kinds = ["skill-install", "skill-list", "skill-load"] as const;
  model.behaviors = kinds.map((kind) => {
    const fields = kind === "skill-list"
      ? []
      : kind === "skill-install"
      ? ["id", "url", "expectedDigest"]
      : ["id", "expectedDigest"];
    return {
      id: `${kind}-access`,
      name: kind,
      description: "Exact bundle fixture exposure",
      callerNativeId: model.identity.builderId,
      targetNativeId: `${kind}-target`,
      targetTypeId: `${kind}-type`,
      inputTypeId: `${kind}-input`,
      sourceIds: [kind],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: Object.fromEntries(
          fields.map((name) => [name, { type: "string" }]),
        ),
        required: fields.filter((name) =>
          kind !== "skill-install" || name !== "expectedDigest"
        ),
      },
    };
  });
  model.operatorEntries = kinds.map((kind) => ({
    id: `${kind}-target`,
    kind,
    typeId: `${kind}-type`,
    performerId: model.identity.builderId,
    allocationId: `${kind}-allocation`,
    sourceIds: [kind],
  }));
  model.skillPolicy = {
    kind: "lazy-skills",
    id: "skill-policy",
    revision: 1,
    elementId: "skill-policy",
    sourceIds: ["skill-policy"],
    ownerId: model.identity.builderId,
    allowedHosts: [],
    maxSkillBytes: 65536,
    maxInstalledSkills: 8,
    maxLoadedSkills: 4,
    maxLoadedCharacters: 48000,
  };
  model.initialSkills = [{
    nativeId: "initial-skill",
    id: "initial-skill",
    source,
    digest: await skillContentDigest(content),
    loaded: true,
    sourceIds: ["initial-skill"],
  }];
  return model;
}

Deno.test("Request eligibility inspects exact current and legacy production bundle assets", async () => {
  const read = bundledSkillReader();
  for (const source of ["bundle:assembly-modeling", "bundle:ase-modeling"]) {
    const content = await read(source, 65536);
    const model = await inspectionModel(source, content);
    deepStrictEqual(await inspectRequestInitialSkills(model, read), {
      supported: true,
      issues: [],
    });
  }
});

Deno.test("Request eligibility classifies production-reader missing, oversized, invalid UTF-8 and invalid path assets", async () => {
  const root = await Deno.makeTempDir({ prefix: "request-skill-reader-" });
  try {
    const source = "bundle:assembly-modeling",
      content = "# Exact bundled instructions\n";
    const model = await inspectionModel(source, content);
    model.skillPolicy!.maxSkillBytes = 256;
    const folder = join(root, "assembly-modeling"),
      filename = join(folder, "SKILL.md");
    const read = bundledSkillReader(root);
    const inspect = () => inspectRequestInitialSkills(model, read);
    deepStrictEqual(await inspect(), {
      supported: false,
      issues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"],
    });
    await rejects(() => read(source, 256), readerFailure("unavailable"));
    await Deno.mkdir(folder);
    deepStrictEqual(await inspect(), {
      supported: false,
      issues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"],
    });
    await Deno.writeFile(filename, new Uint8Array(257));
    deepStrictEqual(await inspect(), {
      supported: false,
      issues: ["INITIAL_SKILL_LIMIT_EXCEEDED"],
    });
    await rejects(() => read(source, 256), readerFailure("limit"));
    await Deno.writeFile(filename, new Uint8Array([0xc3, 0x28]));
    deepStrictEqual(await inspect(), {
      supported: false,
      issues: ["INITIAL_SKILL_CONTENT_INVALID"],
    });
    await rejects(() => read(source, 256), readerFailure("invalid-content"));
    await Deno.writeTextFile(filename, "");
    deepStrictEqual(await inspect(), {
      supported: false,
      issues: ["INITIAL_SKILL_CONTENT_INVALID"],
    });
    await Deno.remove(filename);
    await Deno.mkdir(filename);
    deepStrictEqual(await inspect(), {
      supported: false,
      issues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"],
    });
    await Deno.remove(filename);
    const target = join(root, "actual.md");
    await Deno.writeTextFile(target, content);
    await Deno.symlink(target, filename);
    deepStrictEqual(await inspect(), {
      supported: false,
      issues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"],
    });
    await Deno.remove(filename);
    await Deno.writeTextFile(filename, content);
    deepStrictEqual(await inspect(), { supported: true, issues: [] });
    // Root layout failures are availability failures; unexpected I/O is not caught.
    const absentRoot = bundledSkillReader(join(root, "absent"));
    deepStrictEqual(await inspectRequestInitialSkills(model, absentRoot), {
      supported: false,
      issues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"],
    });
    const notDirectory = join(root, "not-directory");
    await Deno.writeTextFile(notDirectory, "file");
    deepStrictEqual(
      await inspectRequestInitialSkills(
        model,
        bundledSkillReader(notDirectory),
      ),
      { supported: false, issues: ["INITIAL_SKILL_BUNDLE_UNAVAILABLE"] },
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
