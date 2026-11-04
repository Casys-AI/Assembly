import { assert } from "../../../domain/primitives/assert.ts";
import { pinBundledSkillDigests } from "./skill-bundles.ts";
import type { ModelSources as Sources } from "../../../domain/model/value-objects/sources.ts";

function addPackageFragment(source: string, fragment: string): string {
  const end = source.lastIndexOf("\n}");
  assert(end >= 0, "Source package has no terminal body");
  return source.slice(0, end) + "\n" + fragment.trim() + "\n" +
    source.slice(end);
}

/** Read a directory URL, including its trailing slash. Information definitions
 * remain available with information:false; concrete composition/views are
 * skipped. When that composition is present, its skills use sibling ../skills/.
 */
export async function loadInitialSources(
  sourcesDir = new URL("../../../../models/", import.meta.url),
  options: { information?: boolean } = {},
): Promise<Sources> {
  const sources: Sources = {};
  for (
    const name of [
      "core",
      "conversation",
      "execution",
      "pae",
      "lifecycle",
      "requirements",
      "configuration",
    ]
  ) {
    sources[`${name}.sysml`] = await Deno.readTextFile(
      new URL(`${name}.sysml`, sourcesDir),
    );
  }
  sources["configuration.sysml"] = addPackageFragment(
    sources["configuration.sysml"]!,
    await Deno.readTextFile(new URL("configuration-views.sysml", sourcesDir)),
  );
  // Only new systems receive the concrete default information composition.
  // Persisted source bundles are never silently rewritten on restart.
  for (
    const name of [
      "authority",
      "accountability",
      "context",
      "memory",
      "skills",
      "behavior-invocations",
      "work-budget",
      "cases",
      "work-operators",
      "verified-effect-closure",
      "tool-publication-result",
      "model-editing",
      "model-administration",
    ]
  ) {
    try {
      sources[`${name}.sysml`] = await Deno.readTextFile(
        new URL(`${name}.sysml`, sourcesDir),
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  if (options.information !== false) {
    let fragment: string | undefined;
    try {
      fragment = await Deno.readTextFile(
        new URL("information-bootstrap.sysml", sourcesDir),
      );
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (fragment !== undefined) {
      fragment = await pinBundledSkillDigests(
        fragment,
        new URL("../skills/", sourcesDir),
      );
      const marker = "part liveBuilder : ConversationSystem {";
      assert(
        sources["configuration.sysml"].split(marker).length === 2,
        "Expected one initial conversation system for information bootstrap",
      );
      sources["configuration.sysml"] = sources["configuration.sysml"].replace(
        marker,
        `${marker}\n${fragment}`,
      );
      const overview =
        "view agentOverview : StandardViewDefinitions::GeneralView {";
      assert(
        sources["configuration.sysml"].split(overview).length === 2,
        "Expected one overview for initial information views",
      );
      sources["configuration.sysml"] = addPackageFragment(
        sources["configuration.sysml"].replace(
          overview,
          `${overview}\n    expose Contexte;\n    expose 'Mémoire';`,
        ),
        await Deno.readTextFile(
          new URL("configuration-information-views.sysml", sourcesDir),
        ),
      );
    }
  }
  return sources;
}
