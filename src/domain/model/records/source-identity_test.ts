import { equal, throws } from "node:assert/strict";
import { sourceModelIdentity } from "./source-identity.ts";
import type { SourceRevision } from "./source-revision.ts";

function fixture() {
  const scope = "Team::operator";
  const projectId = "git:eaa8ee83-b912-5b8d-b114-db28a72570bd";
  const revision: SourceRevision = {
    version: "branch:current",
    sources: {
      "team.sysml":
        "package Team { part operator { part catalog; part builder; } }",
    },
    elements: [{
      "@id": "team-package",
      "@type": "Package",
      qualifiedName: "Team",
      declaredName: "Team",
    }, {
      "@id": "operator-system",
      "@type": "PartUsage",
      qualifiedName: scope,
      declaredName: "operator",
      owner: { "@id": "team-package" },
    }, {
      "@id": "operator-catalog",
      "@type": "PartUsage",
      qualifiedName: `${scope}::catalog`,
      declaredName: "catalog",
      owner: { "@id": "operator-system" },
    }, {
      "@id": "operator-builder",
      "@type": "PartUsage",
      qualifiedName: `${scope}::builder`,
      declaredName: "builder",
      owner: { "@id": "operator-system" },
    }],
  };
  const identity = sourceModelIdentity(revision, projectId, scope);
  return { revision, identity };
}

Deno.test("source identity follows changed revisions and rejects ambiguous declarations", () => {
  const f = fixture();
  const changed = structuredClone(f.revision);
  const builder = changed.elements.find((element) =>
    element["@id"] === "operator-builder"
  )!;
  builder["@id"] = "updated-builder";
  equal(
    sourceModelIdentity(changed, f.identity.projectId, "Team::operator")
      .builderId,
    "updated-builder",
  );
  equal(
    sourceModelIdentity(f.revision, f.identity.projectId, "Team::operator")
      .builderId,
    "operator-builder",
  );
  changed.elements.push({ ...builder, "@id": "ambiguous-builder" });
  throws(
    () => sourceModelIdentity(changed, f.identity.projectId, "Team::operator"),
    /Ambiguous product library declaration/,
  );
});
