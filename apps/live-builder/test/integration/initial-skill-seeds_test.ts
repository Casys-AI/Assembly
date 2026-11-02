import { createHash } from "node:crypto";
import { equal, ok } from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadInitialSources } from "../../src/adapters/out/filesystem/initial-model-sources.ts";

const hash = (content: string) =>
  createHash("sha256").update(content, "utf8").digest("hex");

Deno.test("initial sources pin the Assembly seed without embedding its instructions", async () => {
  const sources = await loadInitialSources();
  const content = await Deno.readTextFile(
    new URL("../../skills/assembly-modeling/SKILL.md", import.meta.url),
  );
  ok(sources["configuration.sysml"]!.includes('id = "assembly-modeling"'));
  ok(
    sources["configuration.sysml"]!.includes(
      'source = "bundle:assembly-modeling"',
    ),
  );
  ok(sources["configuration.sysml"]!.includes(`digest = "${hash(content)}"`));
  equal(JSON.stringify(sources).includes("__ASSEMBLY_SKILL_DIGEST__"), false);
  equal(JSON.stringify(sources).includes("## Faire évoluer le modèle"), false);
});

Deno.test("legacy bootstrap templates retain their own exact bundled asset pin", async () => {
  const directory = await Deno.makeTempDir({ prefix: "assembly-legacy-seed-" });
  try {
    const models = join(directory, "models");
    await Deno.mkdir(models);
    for await (
      const file of Deno.readDir(new URL("../../models/", import.meta.url))
    ) {
      if (!file.isFile || !file.name.endsWith(".sysml")) continue;
      let content = await Deno.readTextFile(
        new URL(`../../models/${file.name}`, import.meta.url),
      );
      if (file.name === "information-bootstrap.sysml") {
        content = content.replaceAll("assembly-modeling", "ase-modeling")
          .replaceAll("assemblyModeling", "aseModeling")
          .replaceAll("__ASSEMBLY_SKILL_DIGEST__", "__ASE_SKILL_DIGEST__");
      }
      await Deno.writeTextFile(join(models, file.name), content);
    }
    const legacyContent = await Deno.readTextFile(
      new URL("../../skills/legacy/ase-modeling/SKILL.md", import.meta.url),
    );
    // Only the old bundle exists here: compatibility cannot accidentally read
    // the new asset or relabel its digest as the admitted legacy skill.
    const legacyDirectory = join(directory, "skills", "ase-modeling");
    await Deno.mkdir(legacyDirectory, { recursive: true });
    await Deno.writeTextFile(join(legacyDirectory, "SKILL.md"), legacyContent);
    const sources = await loadInitialSources(pathToFileURL(`${models}/`));
    ok(
      sources["configuration.sysml"]!.includes(
        'source = "bundle:ase-modeling"',
      ),
    );
    ok(
      sources["configuration.sysml"]!.includes(
        `digest = "${hash(legacyContent)}"`,
      ),
    );
    equal(JSON.stringify(sources).includes("__ASE_SKILL_DIGEST__"), false);
    equal(JSON.stringify(sources).includes("assembly-modeling"), false);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});
