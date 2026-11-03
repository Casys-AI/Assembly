import { replaceGlobals } from "../support/globals.ts";
import { doesNotMatch, equal, match } from "node:assert/strict";
import { render } from "preact";
import { act } from "preact/test-utils";
import { RequestOperatorDetails } from "../../components/conversations/RequestOperatorDetails.tsx";
import type { RequestOperatorDetailsSnapshot } from "../../../src/application/work/request-spaces/operator-details-view.ts";
import type { ArtifactSourceBindingReference } from "../../../src/domain/work/artifacts/source-reference.ts";
import { parseModelRevisionId } from "../../../src/domain/shared-kernel/revision-id.ts";
import { skillContentDigest } from "../../../src/domain/skills/context-skills.ts";

Deno.test("mounted Request details show only skill metadata and refresh it or an unavailable status without source controls", async () => {
  const content = "# Long retained skill\n".repeat(100),
    digest = await skillContentDigest(content),
    manifest = "b".repeat(64);
  const version = parseModelRevisionId(`commit:${"c".repeat(40)}`);
  const binding: ArtifactSourceBindingReference = {
    version: 1,
    bindingId: "binding",
    versionId: "version",
    revision: 1,
    ownerId: "native:owner",
    localArtifactId: "skill",
    invocationId: "invocation",
    reference: {
      version: 2,
      scopeId: "scope",
      repositoryId: "repo",
      artifactId: "skill",
      kind: "skill-document",
      commitOid: "a".repeat(40),
      entryPath: `artifacts/${manifest}/SKILL.md`,
      manifestPath: `artifacts/${manifest}/manifest.json`,
      contentEncoding: "utf8-v1",
      contentDigest: digest,
      manifestFormat: "assembly-artifact-package-v2",
      manifestDigestVersion: "sha256-canonical-json-v1",
      manifestDigest: manifest,
    },
  };
  const snapshot: RequestOperatorDetailsSnapshot = {
    caseId: "case-a",
    executionSpaceId: "space-a",
    operatorId: "native:owner",
    observedSource: {
      source: { repositoryId: "repo", version },
      modelDigest: "d".repeat(64),
      sourceAdmission: { revision: 1, manifestDigest: manifest },
      adoption: null,
    },
    runtimeRevision: 4,
    tools: [],
    skills: {
      status: "available",
      revision: 1,
      items: [{
        id: "skill",
        name: "Long skill",
        description: "Guidance",
        digest,
        loaded: true,
        sourceBinding: binding,
      }],
    },
  };
  const pending: Array<(response: Response) => void> = [];
  const { withMountedDom } = await import("../support/mounted-dom.ts");
  await withMountedDom(async (document) => {
    const root = document.createElement("div");
    document.body.append(root);
    const restoreFetch = replaceGlobals({
      fetch: (input) => {
        equal(String(input).endsWith("/details"), true);
        return new Promise<Response>((resolve) => pending.push(resolve));
      },
    });
    const release = async (index: number, response: Response) => {
      await act(async () => {
        pending[index](response);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
    };
    const waitFor = async (pattern: RegExp) => {
      const deadline = Date.now() + 1000;
      while (!pattern.test(root.textContent ?? "") && Date.now() < deadline) {
        await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      }
      match(root.textContent ?? "", pattern, root.innerHTML);
    };
    const noControls = () => {
      equal(root.querySelector("button"), null);
      equal(root.querySelector("pre"), null);
      doesNotMatch(
        root.textContent ?? "",
        /Read again|Open exact source|Keep for comparison|Clear comparison|Retained dependencies|Retained source|Close source/,
      );
    };
    try {
      await act(() =>
        render(
          <RequestOperatorDetails
            caseId="case-a"
            operatorId="native:owner"
            expectedModelDigest={snapshot.observedSource.modelDigest}
            expectedVersion={version}
            sessionReady
            sessionGeneration={1}
            conversationRevision={1}
          />,
          root,
        )
      );
      await release(0, Response.json(snapshot));
      await waitFor(/Long skill/);
      equal(
        root.querySelector("[data-skill-id=skill]")?.getAttribute("title"),
        "Guidance",
      );
      // Loading state adds no badge to the list (cf85bc96).
      doesNotMatch(root.textContent ?? "", /\bloaded\b/);
      noControls();
      await act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      equal(pending.length, 2);
      const changed = {
        ...snapshot,
        skills: {
          status: "available",
          revision: 2,
          items: [{
            ...(snapshot.skills.status === "available"
              ? snapshot.skills.items[0]
              : {}),
            name: "Updated skill",
            loaded: false,
          }],
        },
      };
      await release(1, Response.json(changed));
      await waitFor(/Updated skill/);
      doesNotMatch(root.textContent ?? "", /loaded|Long skill/);
      noControls();
      await act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      equal(pending.length, 3);
      await release(2, Response.json({ error: "revoked" }, { status: 403 }));
      await waitFor(/Tools and skills are unavailable/);
      doesNotMatch(root.textContent ?? "", /Updated skill|Guidance/);
      noControls();
    } finally {
      await act(() => render(null, root));
      root.remove();
      restoreFetch();
    }
  });
});
