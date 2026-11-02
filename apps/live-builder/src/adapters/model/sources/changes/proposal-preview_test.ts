import { deepStrictEqual, equal } from "node:assert/strict";
import type {
  ModelRevision,
  ProposalRecord,
} from "../../../../domain/model/records/revision.ts";
import type { ModelDelegationRecord } from "../../../../domain/governance/policies/model-delegation.ts";
import {
  MODEL_DELEGATIONS_FILE,
  renderModelDelegations,
} from "../../../governance/model-access/delegation/ledger.ts";
import { modelProposalPreview } from "./proposal-preview.ts";

const path = "system.sysml";
const oldSource = "package P {\n  attribute x = 1;\n  attribute y = 2;\n}\n";
const newSource = "package P {\n  attribute x = 3;\n  attribute y = 4;\n}\n";
function attribute(source: string, id: string, declaration: string) {
  const start = source.indexOf(declaration);
  const before = source.slice(0, start).split("\n");
  const through = source.slice(0, start + declaration.length).split("\n");
  return {
    "@id": id,
    "@type": "AttributeUsage",
    declaredName: id,
    qualifiedName: `P::${id}`,
    "sysx:sourceDocument": path,
    "sysx:sourceText": declaration,
    "sysx:sourceLine": before.length,
    "sysx:sourceColumn": new TextEncoder().encode(before.at(-1)!).length + 1,
    "sysx:sourceEndLine": through.length,
    "sysx:sourceEndColumn": new TextEncoder().encode(through.at(-1)!).length +
      1,
  };
}
function valueElements(id: string, declaration: string) {
  const literal = /=\s*(.+);$/.exec(declaration)![1]!;
  const value: string | number | boolean = JSON.parse(literal);
  return [{
    "@id": `${id}-value`,
    "@type": "FeatureValue",
    featureWithValue: { "@id": id },
    value: { "@id": `${id}-literal` },
  }, {
    "@id": `${id}-literal`,
    "@type": typeof value === "string"
      ? "LiteralString"
      : typeof value === "boolean"
      ? "LiteralBoolean"
      : typeof value === "number" && Number.isInteger(value)
      ? "LiteralInteger"
      : "LiteralReal",
    value,
  }];
}
function revision(
  version: string,
  source: string,
  x: string,
  y: string,
): ModelRevision {
  return {
    version,
    sources: { [path]: source },
    elements: [
      attribute(source, "x", x),
      attribute(source, "y", y),
      ...valueElements("x", x),
      ...valueElements("y", y),
    ],
    documents: [],
    sourceDigest: "a".repeat(64),
    semanticDigest: "a".repeat(64),
    provenanceDigest: "a".repeat(64),
    sourceHashes: {},
    engineVersion: "test",
  };
}
const proposal: ProposalRecord = {
  id: "proposal-1",
  branch: "proposal_1",
  author: "agent:agent-1",
  reason: "Values",
  baseVersion: "branch:base",
  proposalVersion: "branch:proposed",
  createdAt: "2026-10-23T00:00:00Z",
  status: "proposed",
  validation: "validated",
  sourceDigest: "a".repeat(64),
  diff: [],
};
const base = revision(
  "branch:base",
  oldSource,
  "attribute x = 1;",
  "attribute y = 2;",
);
const proposed = revision(
  "branch:proposed",
  newSource,
  "attribute x = 3;",
  "attribute y = 4;",
);

Deno.test("proposal preview shows exact native attribute spans and proves full source coverage", () => {
  const result = modelProposalPreview({
    proposal,
    agentId: "agent-1",
    base,
    proposed,
    current: base,
  });
  equal(result.completeness, true);
  equal(result.stale, false);
  equal(result.expectedVersion, "branch:base");
  deepStrictEqual(result.rows, [
    {
      id: "x",
      label: "P::x",
      before: "1",
      after: "3",
    },
    {
      id: "y",
      label: "P::y",
      before: "2",
      after: "4",
    },
  ]);
  deepStrictEqual(result.sourceChanges, [{
    path,
    kind: "changed",
    before: oldSource,
    after: newSource,
  }]);
});

Deno.test("uncovered edit keeps exact source fallback and marks cards incomplete", () => {
  const changed = revision(
    "branch:proposed",
    newSource.replace("package P", "package Renamed"),
    "attribute x = 3;",
    "attribute y = 4;",
  );
  const result = modelProposalPreview({
    proposal,
    agentId: "agent-1",
    base,
    proposed: changed,
    current: { ...base, version: "branch:new-head" },
  });
  equal(result.stale, true);
  equal(result.completeness, false);
  equal(result.rows.length, 2);
  equal(result.sourceChanges[0].after, changed.sources[path]);
});

Deno.test("invalid native source extent cannot produce a misleading card", () => {
  const altered = structuredClone(proposed);
  altered.elements[0]!["sysx:sourceText"] = "attribute x = 999;";
  const result = modelProposalPreview({
    proposal,
    agentId: "agent-1",
    base,
    proposed: altered,
    current: base,
  });
  equal(result.completeness, false);
  deepStrictEqual(result.rows.map((row) => row.id), ["y"]);
  equal(result.sourceChanges[0].after, newSource);
});

Deno.test("boolean and JSON string values render as exact scalars", () => {
  const beforeSource =
    'package P {\n  attribute x : String = "café";\n  attribute y : Boolean = true;\n}\n';
  const afterSource =
    'package P {\n  attribute x : String = "台灣";\n  attribute y : Boolean = false;\n}\n';
  const before = revision(
    "branch:base",
    beforeSource,
    'attribute x : String = "café";',
    "attribute y : Boolean = true;",
  );
  const after = revision(
    "branch:proposed",
    afterSource,
    'attribute x : String = "台灣";',
    "attribute y : Boolean = false;",
  );
  const result = modelProposalPreview({
    proposal,
    agentId: "agent-1",
    base: before,
    proposed: after,
    current: before,
  });
  equal(result.completeness, true);
  deepStrictEqual(result.rows.map(({ before, after }) => [before, after]), [
    ['"café"', '"台灣"'],
    ["true", "false"],
  ]);
});

Deno.test("attribute type, modifier or native literal mismatch falls back to exact sources", () => {
  const changedSource = newSource.replace("attribute x", "attribute derived x");
  const changed = revision(
    "branch:proposed",
    changedSource,
    "attribute derived x = 3;",
    "attribute y = 4;",
  );
  changed.elements.find((element) => element["@id"] === "y-literal")!.value =
    999;
  const result = modelProposalPreview({
    proposal,
    agentId: "agent-1",
    base,
    proposed: changed,
    current: base,
  });
  equal(result.completeness, false);
  deepStrictEqual(result.rows, []);
  equal(result.sourceChanges[0].after, changedSource);
});

const grant: ModelDelegationRecord = {
  id: "delegate-b",
  revision: 1,
  issuerSystem: "Systems::A",
  targetSystem: "Systems::B",
  targetHolderNativeId: "holder-b",
  targetMandateId: "mandate-b",
  targetMandateRevision: 1,
  parent: {
    kind: "root",
    id: "root-a",
    revision: 1,
    digest: "d".repeat(64),
  },
  operations: ["set-value"],
  grants: [{ file: "system.sysml", qualifiedRoots: ["Systems::B"] }],
  mayEdit: true,
  recipients: ["Systems::C"],
  maxRedelegationDepth: 0,
  revoked: false,
};

Deno.test("administration preview reads exact canonical grant ledger fields", () => {
  const authorization = {
    kind: "operator-administration" as const,
    systemQualifiedName: "Systems::A",
    operatorNativeId: "agent-1",
    authorityDigest: "d".repeat(64),
    change: {
      kind: "grant" as const,
      id: grant.id,
      targetSystem: grant.targetSystem,
      operations: grant.operations,
      grants: grant.grants,
      mayEdit: grant.mayEdit,
      recipients: grant.recipients,
      maxRedelegationDepth: grant.maxRedelegationDepth,
    },
    record: grant,
  };
  const ledger = renderModelDelegations([grant]);
  const result = modelProposalPreview({
    proposal: { ...proposal, authorization },
    agentId: "agent-1",
    base,
    proposed: {
      ...base,
      version: "branch:proposed",
      sources: { ...base.sources, [MODEL_DELEGATIONS_FILE]: ledger },
    },
    current: base,
  });
  equal(result.completeness, false);
  deepStrictEqual(
    result.rows.map((row) => [row.label, row.before, row.after]),
    [
      ["Bénéficiaire", "", "Systems::B"],
      ["Identité native", "", "holder-b"],
      ["Modification du contenu", "", "true"],
      ["Opérations", "", '["set-value"]'],
      [
        "Périmètres",
        "",
        '[{"file":"system.sysml","qualifiedRoots":["Systems::B"]}]',
      ],
      ["Destinataires possibles", "", '["Systems::C"]'],
      ["Profondeur de redélégation", "", "0"],
      ["Révocation", "", "false"],
    ],
  );
  deepStrictEqual(result.sourceChanges, [{
    path: MODEL_DELEGATIONS_FILE,
    kind: "added",
    after: ledger,
  }]);
});

Deno.test("administration preview distinguishes exact revocation from malformed ledger", () => {
  const revoked: ModelDelegationRecord = {
    ...grant,
    revision: 2,
    revoked: true,
  };
  const beforeSource = renderModelDelegations([grant]);
  const afterSource = renderModelDelegations([revoked]);
  const authorization = {
    kind: "operator-administration" as const,
    systemQualifiedName: "Systems::A",
    operatorNativeId: "agent-1",
    authorityDigest: "d".repeat(64),
    change: { kind: "revoke" as const, id: grant.id },
    record: revoked,
    previousDigest: "e".repeat(64),
  };
  const oldRevision = {
    ...base,
    sources: { ...base.sources, [MODEL_DELEGATIONS_FILE]: beforeSource },
  };
  const nextRevision = {
    ...proposed,
    sources: { ...base.sources, [MODEL_DELEGATIONS_FILE]: afterSource },
  };
  const result = modelProposalPreview({
    proposal: { ...proposal, authorization },
    agentId: "agent-1",
    base: oldRevision,
    proposed: nextRevision,
    current: oldRevision,
  });
  equal(result.completeness, false);
  deepStrictEqual(result.rows.find((row) => row.label === "Révocation"), {
    id: "delegation:delegate-b:revoked",
    label: "Révocation",
    before: "false",
    after: "true",
  });
  const malformed = modelProposalPreview({
    proposal: { ...proposal, authorization },
    agentId: "agent-1",
    base: oldRevision,
    proposed: {
      ...nextRevision,
      sources: {
        ...nextRevision.sources,
        [MODEL_DELEGATIONS_FILE]: afterSource.replace("package", "package "),
      },
    },
    current: oldRevision,
  });
  deepStrictEqual(malformed.rows, []);
  equal(malformed.completeness, false);
  equal(malformed.sourceChanges.length, 1);
  const alteredRevocation = { ...revoked, operations: ["rename" as const] };
  const altered = modelProposalPreview({
    proposal: {
      ...proposal,
      authorization: { ...authorization, record: alteredRevocation },
    },
    agentId: "agent-1",
    base: oldRevision,
    proposed: {
      ...nextRevision,
      sources: {
        ...nextRevision.sources,
        [MODEL_DELEGATIONS_FILE]: renderModelDelegations([alteredRevocation]),
      },
    },
    current: oldRevision,
  });
  deepStrictEqual(altered.rows, []);
  equal(altered.completeness, false);
});
