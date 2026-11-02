import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { RequestOperatorDetails } from "./operator-details.ts";
import type { RequestExecutionBinding } from "../../model/evolution/request-adoption-ports.ts";
import type {
  OpeningRecord,
  SpaceController,
} from "../../../domain/work/request-spaces.ts";
import { RequestSpaceError } from "../../../domain/work/request-spaces.ts";
import type { SkillCatalogRecord } from "../../../domain/skills/records/catalog.ts";
import type { ArtifactSourceBindingReference } from "../../../domain/work/artifacts/source-reference.ts";
import { toolDraftDigest } from "../artifacts/catalog.ts";
import { skillContentDigest } from "../../../domain/skills/context-skills.ts";

async function fixture() {
  const operatorId = "same-native",
    scope = { projectId: "host", systemId: "system" };
  const draft = {
    name: "Retained",
    description: "Retained upstream",
    kind: "read_web_page" as const,
    code: "export default () => 'retained'",
  };
  const content = "# Request-only skill\n",
    digest = await toolDraftDigest(draft);
  const binding = (
    id: string,
    kind: "tool-draft" | "skill-document",
    digest: string,
  ): ArtifactSourceBindingReference => ({
    version: 1,
    bindingId: `binding-${id}`,
    versionId: `version-${id}`,
    revision: 1,
    ownerId: operatorId,
    localArtifactId: id,
    invocationId: `invocation-${id}`,
    reference: {
      version: 2,
      scopeId: "upstream-source",
      repositoryId: "upstream",
      artifactId: id,
      kind,
      commitOid: "a".repeat(40),
      entryPath: `artifacts/${"b".repeat(64)}/${
        kind === "tool-draft" ? "source.json" : "SKILL.md"
      }`,
      manifestPath: `artifacts/${"b".repeat(64)}/manifest.json`,
      contentEncoding: kind === "tool-draft" ? "tool-draft-json-v1" : "utf8-v1",
      contentDigest: digest,
      manifestFormat: "assembly-artifact-package-v2",
      manifestDigestVersion: "sha256-canonical-json-v1",
      manifestDigest: "b".repeat(64),
    },
  });
  const toolBinding = binding("tool", "tool-draft", digest),
    skillBinding = binding(
      "skill",
      "skill-document",
      await skillContentDigest(content),
    );
  const records = ["case-a", "case-b", "case-foreign"].map((caseId, index) =>
    ({
      id: `opening-${index}`,
      scope,
      ownerId: index === 2 ? "foreign" : "owner",
      caseId,
      executionSpaceId: `space-${index}`,
      phase: "dispatched",
      baseDigest: "c".repeat(64),
      base: {
        requestOwner: { operatorId },
        manifest: {
          operators: [{
            operatorId,
            tools: [{
              candidateId: "tool",
              digest,
              sourceBinding: toolBinding,
            }],
          }],
        },
      },
    }) as OpeningRecord
  );
  const pin = {
    source: { version: `commit:${"d".repeat(40)}` },
    modelDigest: "e".repeat(64),
    sourceAdmission: { revision: 1, manifestDigest: "f".repeat(64) },
    adoption: null,
  } as RequestExecutionBinding["pin"];
  let valid = true, skillMissing = false;
  let delayed: (() => void) | undefined;
  let toolReads = 0, skillReads = 0;
  const observations: string[] = [], scopes: unknown[] = [];
  const service = new RequestOperatorDetails({
    scope,
    control: {
      authenticateSession: () => {
        if (!valid) throw new RequestSpaceError("FORBIDDEN", "revoked");
        return Promise.resolve({ ownerId: "owner" } as SpaceController);
      },
      revalidate: () => {
        if (!valid) throw new RequestSpaceError("FORBIDDEN", "revoked");
        return Promise.resolve();
      },
    },
    store: {
      forCase: (id) =>
        Promise.resolve(records.find((entry) => entry.caseId === id) ?? null),
    },
    observations: {
      binding(record) {
        observations.push(record.executionSpaceId);
        return Promise.resolve({
          pin: structuredClone(pin),
          state: {
            executionModel: {
              identity: { builderId: operatorId },
              version: {
                digest: pin.modelDigest,
                repositoryVersion: pin.source.version,
              },
              catalog: [],
            },
            revision: 2,
            candidates: [{
              id: "tool",
              digest,
              name: draft.name,
              description: draft.description,
            }],
          },
        } as unknown as RequestExecutionBinding);
      },
      skills(record) {
        return Promise.resolve(
          skillMissing ? null : {
            ownerId: operatorId,
            revision: 1,
            skills: [{
              id: "skill",
              name: record.caseId,
              description: "Installed",
              digest: skillBinding.reference.contentDigest,
              loaded: record.caseId === "case-a",
              sourceBinding: skillBinding,
            }],
          } as SkillCatalogRecord,
        );
      },
    },
    source: {
      readTool(base, operator, id) {
        toolReads++;
        equal(base, records[0].base);
        equal(operator, operatorId);
        equal(id, "tool");
        delayed?.();
        return Promise.resolve(draft);
      },
    },
    artifactSourcesForScope(scope) {
      scopes.push(scope);
      return Promise.resolve({
        resolveSkill(selection) {
          skillReads++;
          deepStrictEqual(selection.expectedBinding, skillBinding);
          delayed?.();
          return Promise.resolve(content);
        },
      });
    },
    compare: () => "",
  });
  const command = (kind: "tool-draft" | "skill-document" = "tool-draft") => ({
    observedSource: structuredClone(pin),
    selections: [{
      kind,
      id: kind === "tool-draft" ? "tool" : "skill",
      expectedDigest: kind === "tool-draft"
        ? digest
        : skillBinding.reference.contentDigest,
    }],
  });
  return {
    service,
    records,
    command,
    pin,
    scopes,
    observations,
    toolBinding,
    skillBinding,
    draft,
    content,
    counts: () => ({ toolReads, skillReads }),
    revoke: () => valid = false,
    delay: (f: () => void) => delayed = f,
    missing: () => skillMissing = true,
  };
}
Deno.test("Request detail metadata is scoped across shared native IDs and does not read source or mutate", async () => {
  const f = await fixture();
  const a = await f.service.read("session", "case-a", "same-native"),
    b = await f.service.read("session", "case-b", "same-native");
  equal(a.skills.status, "available");
  equal(b.skills.status, "available");
  if (a.skills.status === "available" && b.skills.status === "available") {
    equal(a.skills.items[0].name, "case-a");
    equal(a.skills.items[0].loaded, true);
    equal(b.skills.items[0].loaded, false);
  }
  equal(a.executionSpaceId, "space-0");
  equal(b.executionSpaceId, "space-1");
  deepStrictEqual(f.counts(), { toolReads: 0, skillReads: 0 });
  equal(JSON.stringify(a).includes(f.draft.code), false);
  f.missing();
  equal(
    (await f.service.read("session", "case-a", "same-native")).skills.status,
    "unavailable",
  );
});
Deno.test("Request inspection refuses foreign Case/operator and catalogue members before source access", async () => {
  const f = await fixture();
  await rejects(
    () => f.service.read("session", "case-foreign", "same-native"),
    { code: "FORBIDDEN" },
  );
  await rejects(() => f.service.read("session", "case-a", "other"), {
    code: "FORBIDDEN",
  });
  for (
    const override of [{ id: "foreign" }, { expectedDigest: "0".repeat(64) }, {
      binding: f.toolBinding,
    }]
  ) {
    const command = f.command();
    Object.assign(command.selections[0], override);
    await rejects(
      () => f.service.source("session", "case-a", "same-native", command),
      { code: "FORBIDDEN" },
    );
  }
  deepStrictEqual(f.counts(), { toolReads: 0, skillReads: 0 });
});
Deno.test("Request exact tool inspection uses retained closure and skill inspection uses exact scoped resolver", async () => {
  const f = await fixture();
  deepStrictEqual(
    await f.service.source("session", "case-a", "same-native", f.command()),
    { sources: [{ binding: f.toolBinding, content: f.draft }] },
  );
  deepStrictEqual(
    await f.service.source(
      "session",
      "case-b",
      "same-native",
      f.command("skill-document"),
    ),
    { sources: [{ binding: f.skillBinding, content: f.content }] },
  );
  deepStrictEqual(f.scopes, [{
    projectId: "host",
    systemId: "system",
    executionSpaceId: "space-1",
    operatorId: "same-native",
  }]);
});
Deno.test("Request delayed revocation, source movement and owner movement suppress protected bytes", async () => {
  for (const action of ["revoke", "pin", "owner"] as const) {
    const f = await fixture();
    f.delay(() => {
      if (action === "revoke") f.revoke();
      else if (action === "pin") {
        Object.assign(f.pin, { modelDigest: "0".repeat(64) });
      } else f.records[0].ownerId = "foreign";
    });
    await rejects(() =>
      f.service.source("session", "case-a", "same-native", f.command())
    );
  }
});
