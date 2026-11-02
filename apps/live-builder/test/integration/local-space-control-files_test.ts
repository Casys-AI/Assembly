import assert from "node:assert/strict";
import { join } from "node:path";

Deno.test("local control files use owned profile bytes and exclusive private capability delivery", async () => {
  // The maintained launcher places TMPDIR in this checkout's .data/test-runs.
  // No generic OS temporary directory or live named profile is used.
  const temporaryRoot = Deno.env.get("TMPDIR");
  assert.ok(temporaryRoot?.includes("/.data/test-runs/"));
  const directory = await Deno.makeTempDir({
    dir: temporaryRoot,
    prefix: "local-control-",
  });
  const fileModule = new URL(
    "../../src/adapters/in/local/space-control-files.ts",
    import.meta.url,
  ).href;
  const projectModule = new URL(
    "../../src/adapters/out/filesystem/model-project.ts",
    import.meta.url,
  )
    .href;
  const code = `
    import assert from "node:assert/strict";
    import { join } from "node:path";
    import { createModelProject } from ${JSON.stringify(projectModule)};
    import {
      readLocalControlProfile, readLocalCapabilityFile,
      reserveLocalCapabilityFile,
    } from ${JSON.stringify(fileModule)};
    const root = ${JSON.stringify(directory)};
    const instance = join(root, "instance");
    await Deno.mkdir(instance, { mode: 0o700 });
    const created = await createModelProject({ root, name: "model-project", sources: { "empty.sysml": "package Empty {}" } });
    const systemId = "11111111-1111-4111-8111-111111111111";
    const scope = { projectId: "git:" + created.project.id, systemId };
    await Deno.writeTextFile(join(root, "system.json"), JSON.stringify({ format: 2, id: systemId, port: 4313 }), { createNew: true, mode: 0o600 });
    const locator = join(instance, "main-runtime-owner.json");
    await Deno.writeTextFile(locator, JSON.stringify({ format: 1, ...scope, operatorId: "native-runtime-owner" }), { createNew: true, mode: 0o600 });
    const input = { dataDir: instance, projectDir: created.directory, systemId, origin: "http://127.0.0.1:4313" };
    const profile = await readLocalControlProfile(input);
    assert.equal(profile.primaryOperatorId, "native-runtime-owner");
    const path = join(instance, "capability.json");
    const output = await reserveLocalCapabilityFile(path);
    const file = { format: 1, ...scope, origin: input.origin, credentialId: systemId, expiresAt: "2099-01-01T00:00:00Z", capabilitySecret: "a".repeat(64) };
    await output.save(file);
    await output.close();
    assert.equal((await Deno.stat(path)).mode & 0o777, 0o600);
    assert.equal((await readLocalCapabilityFile(path, profile)).credentialId, systemId);
    await assert.rejects(reserveLocalCapabilityFile(path));
    await assert.rejects(readLocalCapabilityFile(path, { ...profile, scope: { ...scope, systemId: "foreign" } }));
    await Deno.chmod(path, 0o644);
    await assert.rejects(readLocalCapabilityFile(path, profile));
    await Deno.chmod(path, 0o600);
    const alias = join(instance, "alias.json");
    await Deno.symlink(path, alias);
    await assert.rejects(readLocalCapabilityFile(alias, profile));
    const writable = join(root, "shared");
    await Deno.mkdir(writable);
    await Deno.chmod(writable, 0o777);
    await assert.rejects(reserveLocalCapabilityFile(join(writable, "secret.json")));
    await Deno.remove(locator);
    await assert.rejects(readLocalControlProfile(input));
    console.log("private-file-witness-passed");
  `;
  let passed = false;
  try {
    const script = join(directory, "witness.ts");
    await Deno.writeTextFile(script, code, { createNew: true });
    // Production same-user checking requires uid. Grant it only to this bounded
    // subprocess; the standard integration worker needs no broader permission.
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        "--allow-read",
        "--allow-write",
        "--allow-sys=uid",
        script,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
    assert.equal(
      new TextDecoder().decode(result.stdout).trim(),
      "private-file-witness-passed",
    );
    passed = true;
  } finally {
    if (passed) await Deno.remove(directory, { recursive: true });
  }
});
