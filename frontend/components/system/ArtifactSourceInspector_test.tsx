import { replaceGlobals } from "../../test/support/globals.ts";
import { doesNotMatch, equal, match } from "node:assert/strict";
import { act } from "preact/test-utils";
import type { VNode } from "preact";
import type { ArtifactSourceBindingReference } from "../../../src/domain/work/artifacts/source-reference.ts";
import { skillContentDigest } from "../../../src/domain/skills/context-skills.ts";
import { comparisonSource } from "../../lib/system/tools/artifact-sources.ts";
import { probeRoot } from "../../test/support/hook-probe.ts";
import { press } from "../../test/support/press.ts";
import { ArtifactSourceInspector } from "./ArtifactSourceInspector.tsx";

async function settled(draw: () => string, expected: RegExp) {
  for (let attempt = 0; attempt < 40 && !expected.test(draw()); attempt++) {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
  }
  match(draw(), expected);
}

async function known(
  revision: number,
  content: string,
): Promise<ArtifactSourceBindingReference> {
  const manifest = String(revision).repeat(64);
  return {
    version: 1,
    bindingId: `binding-${revision}`,
    versionId: `version-${revision}`,
    revision,
    ownerId: "owner",
    localArtifactId: "skill",
    invocationId: `invocation-${revision}`,
    reference: {
      version: 2,
      scopeId: "scope",
      repositoryId: "repo",
      artifactId: "skill",
      kind: "skill-document",
      commitOid: String(revision).repeat(40),
      entryPath: `artifacts/${manifest}/SKILL.md`,
      manifestPath: `artifacts/${manifest}/manifest.json`,
      contentEncoding: "utf8-v1",
      contentDigest: await skillContentDigest(content),
      manifestFormat: "assembly-artifact-package-v2",
      manifestDigestVersion: "sha256-canonical-json-v1",
      manifestDigest: manifest,
    },
  };
}

Deno.test("source inspector holds captured exact version through catalog refresh and clears it on owner switch", async () => {
  const content = "# Retained skill\n<script>data only</script>\n";
  const first = await known(1, content), second = await known(2, "# Changed\n");
  let reads = 0;
  const restoreFetch = replaceGlobals({
    fetch: (_input, options) => {
      reads++;
      const { bindings } = JSON.parse(String(options?.body));
      equal(bindings[0].bindingId, first.bindingId);
      return Promise.resolve(
        Response.json({ sources: [{ binding: first, content }] }),
      );
    },
  });
  const root = probeRoot();
  let node!: VNode;
  function Probe(
    props: { agentId: string; binding: ArtifactSourceBindingReference },
  ) {
    node = ArtifactSourceInspector({ ...props, label: "Skill" });
    return null;
  }
  try {
    await root.show(Probe, { agentId: "owner", binding: first });
    doesNotMatch(press(node).html, /Retained skill/);
    await act(() => {
      press(node).click("Open exact source");
    });
    await settled(() => press(node).html, /Retained skill/);
    match(press(node).html, /&lt;script(?:>|&gt;)data only/);
    doesNotMatch(press(node).html, /<script>/);
    await root.show(Probe, { agentId: "owner", binding: second });
    match(press(node).html, new RegExp(first.reference.contentDigest));
    match(press(node).html, /Retained skill/);
    equal(reads, 1);
    await root.show(Probe, { agentId: "another-owner", binding: second });
    doesNotMatch(press(node).html, /Retained skill/);
  } finally {
    comparisonSource.value = null;
    restoreFetch();
    await root.restore();
  }
});

Deno.test("failed reread clears previous source bytes and exposes a safe unavailable message", async () => {
  const content = "# Private retained bytes\n",
    binding = await known(1, content);
  let fail = false;
  const restoreFetch = replaceGlobals({
    fetch: () =>
      Promise.resolve(
        fail
          ? Response.json({ error: "/private/repository" }, { status: 404 })
          : Response.json({ sources: [{ binding, content }] }),
      ),
  });
  const root = probeRoot();
  let node!: VNode;
  function Probe() {
    node = ArtifactSourceInspector({
      agentId: "owner",
      label: "Skill",
      binding,
    });
    return null;
  }
  try {
    await root.show(Probe, {});
    await act(() => {
      press(node).click("Open exact source");
    });
    await settled(() => press(node).html, /Private retained bytes/);
    fail = true;
    await act(() => {
      press(node).click("Open exact source");
    });
    await settled(
      () => press(node).html,
      /exact retained source is unavailable/,
    );
    doesNotMatch(
      press(node).html,
      /Private retained bytes|private\/repository/,
    );
  } finally {
    comparisonSource.value = null;
    restoreFetch();
    await root.restore();
  }
});
