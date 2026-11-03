import { sha256Bytes as sha256 } from "../../../../domain/primitives/sha256-bytes.ts";
import { projectAuthorityMatrix } from "../../../out/sysml-toolkit/projections/authority-matrix/projection.ts";
import assert from "node:assert/strict";
import { toolkitIntegrationEnabled } from "../../../../../test/support/toolkit-integration.ts";
import {
  type OperatorAuthorityRequest,
  operatorAuthorityRequests,
  requestOperatorSystemName,
} from "./writer.ts";
import {
  applyEdits,
  verifyEdits,
} from "../../../model/sources/editing/host-writer.ts";
import type { HostEdit } from "../../../../domain/model/editing/host-edit.ts";
import { canonical } from "../../../../domain/primitives/canonical-json.ts";

import { parseSysmlQualifiedName } from "../../../../domain/model/value-objects/sysml-qualified-name.ts";
import type { SourceRevision } from "../../../model/sources/source-model.ts";
import { ToolkitCompiler } from "../../../out/sysml-toolkit/compilation/compiler.ts";
import { SysmlToolkitAdapter } from "../../../out/sysml-toolkit/adapter.ts";
import { loadInitialSources } from "../../../out/filesystem/initial-model-sources.ts";
import {
  sourceModelIdentity,
  validateSourceExecutable,
  validateSourceExecutables,
} from "../../../model/sources/source-model.ts";
import {
  projectSourceGraph,
  sourceLiterals,
  sourceSnapshot,
} from "../../../model/projections/graph/source.ts";
import { modelToolingTarget } from "../../../model/sources/editing/tooling.ts";
import { compileModelEditPolicy } from "../../../out/sysml-toolkit/compilation-policies/governance/model-access/editing/policy.ts";
import { compileToolAdmissionPolicies } from "../../../out/sysml-toolkit/compilation-policies/governance/authority/tool-admission-policy.ts";
import type { OperatorAuthorityPolicyRequest } from "../../../../domain/governance/policies/operator-authority-policy.ts";
import type { ToolAdmissionPolicyRequest } from "../../../../domain/governance/policies/tool-admission-policy.ts";
import { REQUEST_OPERATOR_TEMPLATE } from "../../../../domain/governance/operator-template.ts";
import { DYNAMIC_MANDATE_SOURCE } from "../../../../domain/governance/mandates.ts";
import { operatorFlowSemantics } from "../../../out/sysml-toolkit/compilation-policies/work/operator-flow.ts";

function missingFlowFixture(): SourceRevision {
  const systemName = "AssemblyLiveBuilder::liveBuilder";
  const declarations = [
    ["package", "AssemblyLiveBuilder", "Package"],
    ["system", systemName, "PartUsage"],
    ["authority-package", "AssemblyAuthority", "Package"],
    ["access-package", "AssemblyInvocations", "Package"],
    ["work-package", "AssemblyWork", "Package"],
    ["creation", "AssemblyAuthority::OperatorCreationPolicy", "PartDefinition"],
    ["access", "AssemblyInvocations::BehaviorAccess", "PartDefinition"],
    ["input", "AssemblyWork::WorkRequest", "ItemDefinition"],
    ["inbox", "AssemblyWork::AgentInbox", "ActionDefinition"],
    ["parent-grant", `${systemName}::creationPolicy`, "PartUsage"],
  ];
  const base: SourceRevision = {
    version: "base",
    sources: {},
    elements: declarations.map(([id, qualifiedName, metaclass]) => {
      const parentName = qualifiedName!.split("::").slice(0, -1).join("::");
      const parent = declarations.find(([, name]) => name === parentName)?.[0];
      return {
        "@id": id,
        "@type": metaclass,
        qualifiedName,
        declaredName: qualifiedName!.split("::").at(-1),
        ...(parent ? { owner: { "@id": parent } } : {}),
      };
    }),
  };
  return base;
}

Deno.test("a requested creation policy binds only its BO and records exact bounds without redelegation", async () => {
  const base = missingFlowFixture();
  const systemName = "AssemblyLiveBuilder::liveBuilder";
  for (
    const path of [
      "builder",
      "builderMandate",
      "owner",
      "owner::ownerMandate",
      "owner::ownerMandate::rootAuthority",
    ]
  ) {
    base.elements.push({
      "@id": path,
      "@type": "PartUsage",
      qualifiedName: `${systemName}::${path}`,
      declaredName: path.split("::").at(-1),
      owner: {
        "@id": path.includes("::")
          ? path.split("::").slice(0, -1).join("::")
          : "system",
      },
    });
  }
  base.elements.push({
    "@id": "mode",
    "@type": "AttributeUsage",
    qualifiedName: "AssemblyAuthority::OperatorCreationPolicy::mode",
    declaredName: "mode",
    owner: { "@id": "creation" },
  });
  const before = structuredClone(base);
  for (const mode of ["autonomous", "per-creation"] as const) {
    const { requests: [edit], systemQualifiedName } =
      await operatorAuthorityRequests(base, {
        op: "publishOperatorCreationPolicy",
        systemName,
        changeId: "grant-one",
        policy: { networkHosts: ["example.org"], maxChildren: 3, mode },
      });
    assert(edit?.op === "insertMember");
    assert.equal(edit.intent, "authority");
    assert.equal(systemQualifiedName, systemName);
    assert.deepEqual(edit.owner, { qualifiedName: systemName });
    assert.match(edit.text, /\.holder = builder;/);
    assert.match(edit.text, /\.mandate = builderMandate;/);
    assert.match(edit.text, /\.issuer = owner\.ownerMandate\.rootAuthority;/);
    assert.match(edit.text, /maxChildren = 3;/);
    assert.match(edit.text, /maxDelegationDepth = 0;/);
    assert.match(edit.text, new RegExp(`mode = "${mode}";`));
    assert.doesNotMatch(edit.text, /\.parent =/);
  }
  assert.deepEqual(base, before);
});

/** Positive composition assertions run against the real compiled profile below. */
async function assertTeamCreationComposition(base: SourceRevision) {
  const systemName = "AssemblyLiveBuilder::liveBuilder";
  const parentGrantId = String(
    base.elements.find((element) =>
      element.qualifiedName === `${systemName}::creationPolicy`
    )!["@id"],
  );
  const parentOperatorId = String(
    base.elements.find((element) =>
      element.qualifiedName === `${systemName}::builder`
    )?.["@id"] ?? "missing-parent",
  );
  const before = structuredClone(base);
  const command: OperatorAuthorityRequest = {
    op: "createRequestOperator",
    systemName,
    changeId: "one-team-member",
    creatorMayAddNetworkHosts: true,
    name: "Reader",
    teamOrigin: { operatorId: parentOperatorId, requestId: "root-request" },
    parentOperatorId,
    creationPolicy: {
      id: "bounded-creation",
      revision: 1,
      elementId: parentGrantId,
    },
    operator: {
      kind: "request-team-member",
      instruction: 'Read "carefully". } part injected; //',
      provision: {
        budget: { maxAgentDecisions: 5, maxToolProposals: 1, maxFlowSteps: 96 },
        networkHosts: [],
        mayPropose: ["read_web_page"],
        mayInvokeActiveCatalog: false,
      },
      creationGrant: {
        networkHosts: [],
        maxChildren: 1,
        maxDelegationDepth: 0,
      },
    },
  };
  const result = await operatorAuthorityRequests(base, command);
  assert.equal(result.requests.length, 2);
  const [child, access] = result.requests;
  assert(child?.op === "insertMember" && access?.op === "insertMember");
  assert(
    child.text.includes(
      `attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};`,
    ),
  );
  assert(!child.text.includes("firstRequestObjective"));
  assert(!child.text.includes("AssemblyCases::CaseType"));
  assert(
    child.text.includes("perform action inbox : AssemblyWork::AgentInbox;"),
  );
  assert(child.text.includes("allocate inbox to builder;"));
  assert(
    child.text.includes('originatingRequestId : String = "root-request";'),
  );
  assert(
    child.text.includes(
      `creationParentOperatorId : String = ${
        JSON.stringify(parentOperatorId)
      };`,
    ),
  );
  assert(
    child.text.includes(
      `originatingRequestOperatorId : String = ${
        JSON.stringify(parentOperatorId)
      };`,
    ),
  );
  assert(
    child.text.includes('creationPolicyId : String = "bounded-creation";'),
  );
  assert(
    child.text.includes(
      "bind creationPolicy.parent = AssemblyLiveBuilder::liveBuilder.'creationPolicy';",
    ),
  );
  assert(child.text.includes("maxAgentDecisions = 5;"));
  assert(child.text.includes("maxToolProposals = 1;"));
  assert(child.text.includes("maxFlowSteps = 96;"));
  // The provisioned mandate, not the template's builder profile.
  assert(child.text.includes("mayProposeReadWebPage = true;"));
  assert(child.text.includes("mayProposeReadWebPageOutline = false;"));
  assert(child.text.includes("mayInvokeActiveCatalog = false;"));
  assert(child.text.includes("mayConsultModel = false;"));
  assert(child.text.includes("mayProposeSysmlRevision = false;"));
  assert(child.text.includes("mayAddNetworkHosts = false;"));
  assert(child.text.includes(JSON.stringify(command.operator.instruction)));
  assert(!child.text.includes("__"));
  assert.deepEqual(access.owner, { qualifiedName: systemName });
  assert(access.text.includes("AssemblyInvocations::BehaviorAccess"));
  assert(access.text.includes(".caller = builder;"));
  assert(
    access.text.includes(`.target = ${result.systemQualifiedName}.inbox;`),
  );
  assert.deepEqual(base, before);
  await assert.rejects(
    () =>
      operatorAuthorityRequests(base, { ...command, teamOrigin: undefined }),
    /originating Request/,
  );
  const independent = {
    instruction: "Own a Request.",
    networkHosts: [],
    requestType: { name: "Research", maxInvocations: 4 },
    firstRequest: { objective: "Answer with sources." },
  };
  const initial = await operatorAuthorityRequests(base, {
    op: "createRequestOperator",
    systemName,
    changeId: "initial-owner",
    name: "Owner",
    operator: {
      ...independent,
      creationGrant: {
        networkHosts: [],
        maxChildren: 2,
        maxDelegationDepth: 1,
      },
    },
  });
  assert.equal(initial.requests.length, 1);
  const initialEdit = initial.requests[0]!;
  assert(initialEdit.op === "insertMember");
  assert(
    initialEdit.text.includes(
      `attribute :>> source = ${JSON.stringify(DYNAMIC_MANDATE_SOURCE)};`,
    ),
  );
  assert(initialEdit.text.includes("mayConsultModel = true;"));
  assert(initialEdit.text.includes("mayProposeSysmlRevision = false;"));
  assert(initialEdit.text.includes("AssemblyCases::CaseType"));
  assert(initialEdit.text.includes("firstRequestObjective"));
  assert(
    initialEdit.text.includes(
      "part creationPolicy : AssemblyAuthority::OperatorCreationPolicy",
    ),
  );
  assert(
    initialEdit.text.includes(
      "bind creationPolicy.issuer = owner.ownerMandate.rootAuthority;",
    ),
  );
  assert(!initialEdit.text.includes("creationPolicy.parent"));
  assert(!initialEdit.text.includes("originatingRequestId"));
  const ordinary = await operatorAuthorityRequests(base, {
    op: "createRequestOperator",
    systemName,
    changeId: "ordinary-owner",
    name: "Ordinary owner",
    operator: independent,
  });
  assert.equal(ordinary.requests.length, 1);
  assert(ordinary.requests[0]!.op === "insertMember");
  assert(!ordinary.requests[0]!.text.includes("part creationPolicy"));
  return { ...result, command };
}

Deno.test("operator creation refuses a synthetic source without an admitted native flow template", async () => {
  const base = missingFlowFixture();
  await assert.rejects(
    () => assertTeamCreationComposition(base),
    /explicit admitted native flow template/,
  );
});

Deno.test("team creation requires the creator's explicit modeled network proposal ceiling", async () => {
  await assert.rejects(() =>
    operatorAuthorityRequests(missingFlowFixture(), {
      op: "createRequestOperator",
      systemName: "AssemblyLiveBuilder::liveBuilder",
      changeId: "missing-creator-ceiling",
      name: "Reader",
      parentOperatorId: "builder",
      teamOrigin: { operatorId: "builder", requestId: "request" },
      operator: {
        kind: "request-team-member",
        instruction: "Read the Case",
        provision: {
          budget: {
            maxAgentDecisions: 1,
            maxToolProposals: 0,
            maxFlowSteps: 1,
          },
          networkHosts: [],
          mayPropose: [],
          mayInvokeActiveCatalog: false,
        },
      },
    }), /creator.*network proposal/);
});

Deno.test("operator policy declarations bind exact authority and preserve the immutable base", async () => {
  const systemName = "'Team::Space'::system";
  const elements: SourceRevision["elements"] = [{
    "@id": "package",
    "@type": "Package",
    qualifiedName: "'Team::Space'",
    declaredName: "Team::Space",
  }, {
    "@id": "system",
    "@type": "PartUsage",
    qualifiedName: systemName,
    declaredName: "system",
    owner: { "@id": "package" },
  }, {
    "@id": "authority-package",
    "@type": "Package",
    qualifiedName: "ASEAuthority",
    declaredName: "ASEAuthority",
  }, {
    "@id": "policy-type",
    "@type": "PartDefinition",
    qualifiedName: "ASEAuthority::OperatorAuthorityPolicy",
    declaredName: "OperatorAuthorityPolicy",
    owner: { "@id": "authority-package" },
  }];
  for (
    const [path, parent] of [
      ["builder", "system"],
      ["builderMandate", "system"],
      ["owner", "system"],
      ["owner::ownerMandate", "owner"],
      ["owner::ownerMandate::rootAuthority", "owner::ownerMandate"],
    ]
  ) {
    elements.push({
      "@id": path,
      "@type": "PartUsage",
      qualifiedName: `${systemName}::${path}`,
      declaredName: path!.split("::").at(-1),
      owner: { "@id": parent },
    });
  }
  const base: SourceRevision = { version: "base", sources: {}, elements };
  const before = structuredClone(base);
  const policy: OperatorAuthorityPolicyRequest = {
    policyId: "research-network",
    expectedPolicyRevision: 0,
    enabled: true,
    recipients: ["peer-native-id"],
    acts: ["addNetworkHosts"],
    networkHosts: ["example.org"],
    toolIds: [],
    maxDelegationDepth: 0,
  };
  const request = {
    op: "publishOperatorAuthorityPolicy" as const,
    systemName,
    changeId: "policy-one",
    policy,
  };
  const policyBefore = structuredClone(policy);
  const { requests: [edit], systemQualifiedName } =
    await operatorAuthorityRequests(base, request);
  assert(edit && edit.op === "insertMember");
  assert.equal(edit.intent, "authority");
  assert.equal(systemQualifiedName, systemName);
  assert.deepEqual(edit.owner, { qualifiedName: systemName });
  const name = "'operator-authority-research-network-1'";
  assert.deepEqual(edit.expect[0], {
    kind: "member",
    qualifiedName: `${systemName}::${name}`,
    metaclass: "PartUsage",
  });
  assert.deepEqual(
    edit.expect.slice(1),
    [
      ["id", "research-network"],
      ["revision", 1],
      ["enabled", true],
      ["recipients", '["peer-native-id"]'],
      ["acts", '["addNetworkHosts"]'],
      ["networkHosts", '["example.org"]'],
      ["toolIds", "[]"],
      ["maxDelegationDepth", 0],
    ].map(([field, value]) => ({
      kind: "literal",
      path: `${name}::${field}`,
      value,
    })),
  );
  for (
    const [feature, target] of [
      ["holder", "builder"],
      ["mandate", "builderMandate"],
      ["issuer", "owner.ownerMandate.rootAuthority"],
    ]
  ) assert(edit.text.includes(`bind ${name}.${feature} = ${target};`));
  assert(edit.text.includes(": ASEAuthority::OperatorAuthorityPolicy {"));
  const canonicalBase = structuredClone(base);
  for (const element of canonicalBase.elements) {
    if (element.declaredName === "ASEAuthority") {
      element.declaredName = "AssemblyAuthority";
    }
    if (typeof element.qualifiedName === "string") {
      element.qualifiedName = element.qualifiedName.replace(
        /^ASEAuthority(?=::|$)/,
        "AssemblyAuthority",
      );
    }
  }
  const canonicalPolicy =
    (await operatorAuthorityRequests(canonicalBase, request)).requests[0]!;
  assert(canonicalPolicy.op === "insertMember");
  assert(
    canonicalPolicy.text.includes(
      ": AssemblyAuthority::OperatorAuthorityPolicy {",
    ),
  );
  assert.deepEqual(base, before);
  assert.deepEqual(request.policy, policyBefore);
  const revoked = await operatorAuthorityRequests(base, {
    ...request,
    policy: { ...policy, expectedPolicyRevision: 1, enabled: false },
  });
  const revoke = revoked.requests[0]!;
  assert(revoke.op === "insertMember");
  assert(revoke.text.includes("part 'operator-authority-research-network-2'"));
  assert(revoke.text.includes("attribute :>> enabled = false;"));
  for (
    const invalid of [
      { ...policy, policyId: "escaped'; part injection; //" },
      { ...policy, networkHosts: ["*.example.org"] },
      { ...policy, toolIds: ["unexpected-tool"] },
    ]
  ) {
    await assert.rejects(
      () =>
        operatorAuthorityRequests(base, {
          ...request,
          policy: invalid as never,
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error &&
        error.code === "INVALID_AUTHORITY_POLICY",
    );
  }
  for (
    const target of [
      "policy-type",
      "builder",
      "owner::ownerMandate::rootAuthority",
    ]
  ) {
    await assert.rejects(
      () =>
        operatorAuthorityRequests({
          ...base,
          elements: elements.filter((element) => element["@id"] !== target),
        }, request),
      (error: unknown) =>
        error instanceof Error && "code" in error &&
        error.code === "TARGET_MISSING",
    );
  }
  await assert.rejects(
    () =>
      operatorAuthorityRequests({
        ...base,
        elements: [...elements, { ...elements[1]!, "@id": "duplicate-system" }],
      }, request),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "TARGET_AMBIGUOUS",
  );
  await assertRecipientSpaceWritten({
    base,
    request,
    definitionId: "policy-type",
    definitionName: "ASEAuthority::OperatorAuthorityPolicy",
    name,
    legacyText: edit.text,
  });
});

/** The legacy form writes no space; an explicit space is written as its own
 * literal, and refused on a definition that does not declare it. */
async function assertRecipientSpaceWritten(input: {
  base: SourceRevision;
  request: Extract<
    OperatorAuthorityRequest,
    { op: "publishOperatorAuthorityPolicy" | "publishToolAdmissionPolicy" }
  >;
  definitionId: string;
  definitionName: string;
  name: string;
  legacyText: string;
}) {
  assert(!input.legacyText.includes("recipientSpace"));
  const scoped = {
    ...input.request,
    policy: { ...input.request.policy, recipientExecutionSpaceId: "case-x" },
  } as typeof input.request;
  await assert.rejects(
    () => operatorAuthorityRequests(input.base, scoped),
    (error: unknown) =>
      error instanceof Error && "code" in error &&
      error.code === "TARGET_MISSING",
  );
  const declared: SourceRevision = {
    ...input.base,
    elements: [...input.base.elements, {
      "@id": `${input.definitionId}-recipient-space`,
      "@type": "AttributeUsage",
      qualifiedName: `${input.definitionName}::recipientSpace`,
      declaredName: "recipientSpace",
      owner: { "@id": input.definitionId },
    }],
  };
  const edit = (await operatorAuthorityRequests(declared, scoped)).requests[0]!;
  assert(edit.op === "insertMember");
  assert(edit.text.includes('attribute :>> recipientSpace = "case-x";'));
  assert.deepEqual(
    edit.expect.filter((expected) =>
      expected.kind === "literal" &&
      expected.path === `${input.name}::recipientSpace`
    ),
    [{
      kind: "literal",
      path: `${input.name}::recipientSpace`,
      value: "case-x",
    }],
  );
}

Deno.test("tool admission policy declarations bind separate authority with exact bounded literals", async () => {
  const systemName = "'Team::Space'::system";
  const elements: SourceRevision["elements"] = [{
    "@id": "package",
    "@type": "Package",
    qualifiedName: "'Team::Space'",
    declaredName: "Team::Space",
  }, {
    "@id": "system",
    "@type": "PartUsage",
    qualifiedName: systemName,
    declaredName: "system",
    owner: { "@id": "package" },
  }, {
    "@id": "authority-package",
    "@type": "Package",
    qualifiedName: "ASEAuthority",
    declaredName: "ASEAuthority",
  }, {
    "@id": "tool-policy-type",
    "@type": "PartDefinition",
    qualifiedName: "ASEAuthority::ToolAdmissionPolicy",
    declaredName: "ToolAdmissionPolicy",
    owner: { "@id": "authority-package" },
  }];
  for (
    const path of [
      "builder",
      "builderMandate",
      "owner",
      "owner::ownerMandate",
      "owner::ownerMandate::rootAuthority",
    ]
  ) {
    elements.push({
      "@id": path,
      "@type": "PartUsage",
      qualifiedName: `${systemName}::${path}`,
      declaredName: path.split("::").at(-1),
      owner: {
        "@id": path.includes("::")
          ? path.split("::").slice(0, -1).join("::")
          : "system",
      },
    });
  }
  const base: SourceRevision = { version: "base", sources: {}, elements };
  const policy: ToolAdmissionPolicyRequest = {
    policyId: "research-tools",
    expectedPolicyRevision: 0,
    enabled: true,
    recipients: ["peer-native-id"],
    toolKinds: ["read_web_page", "read_web_page_outline"],
    maxDelegationDepth: 0,
  };
  const request = {
    op: "publishToolAdmissionPolicy" as const,
    systemName,
    changeId: "tools-one",
    policy,
  };
  const before = structuredClone({ base, request });
  const { requests: [edit], systemQualifiedName } =
    await operatorAuthorityRequests(base, request);
  assert(edit && edit.op === "insertMember");
  assert.equal(edit.intent, "authority");
  assert.equal(systemQualifiedName, systemName);
  assert.deepEqual(edit.owner, { qualifiedName: systemName });
  const name = "'tool-admission-research-tools-1'";
  assert.deepEqual(edit.expect[0], {
    kind: "member",
    qualifiedName: `${systemName}::${name}`,
    metaclass: "PartUsage",
  });
  assert.deepEqual(
    edit.expect.slice(1),
    [
      ["id", "research-tools"],
      ["revision", 1],
      ["enabled", true],
      ["recipients", '["peer-native-id"]'],
      ["toolKinds", '["read_web_page","read_web_page_outline"]'],
      ["maxDelegationDepth", 0],
    ].map(([field, value]) => ({
      kind: "literal",
      path: `${name}::${field}`,
      value,
    })),
  );
  assert(
    edit.text.startsWith(`part ${name} : ASEAuthority::ToolAdmissionPolicy {`),
  );
  for (
    const [feature, target] of [
      ["holder", "builder"],
      ["mandate", "builderMandate"],
      ["issuer", "owner.ownerMandate.rootAuthority"],
    ]
  ) assert(edit.text.includes(`bind ${name}.${feature} = ${target};`));
  assert.deepEqual({ base, request }, before);
  const revoked = await operatorAuthorityRequests(base, {
    ...request,
    policy: { ...policy, expectedPolicyRevision: 1, enabled: false },
  });
  const revoke = revoked.requests[0]!;
  assert(revoke.op === "insertMember");
  assert(revoke.text.includes("part 'tool-admission-research-tools-2'"));
  assert(revoke.text.includes("attribute :>> enabled = false;"));
  for (
    const invalid of [
      { ...policy, policyId: "escaped'; part injection; //" },
      { ...policy, toolKinds: ["arbitrary-code"] },
      { ...policy, maxDelegationDepth: 1 },
      { ...policy, networkHosts: ["example.org"] },
    ]
  ) {
    await assert.rejects(
      () =>
        operatorAuthorityRequests(base, {
          ...request,
          policy: invalid as never,
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error &&
        error.code === "INVALID_AUTHORITY_POLICY",
    );
  }
  for (
    const target of [
      "tool-policy-type",
      "builder",
      "builderMandate",
      "owner::ownerMandate::rootAuthority",
    ]
  ) {
    await assert.rejects(
      () =>
        operatorAuthorityRequests({
          ...base,
          elements: elements.filter((element) => element["@id"] !== target),
        }, request),
      (error: unknown) =>
        error instanceof Error && "code" in error &&
        error.code === "TARGET_MISSING",
    );
  }
  await assertRecipientSpaceWritten({
    base,
    request,
    definitionId: "tool-policy-type",
    definitionName: "ASEAuthority::ToolAdmissionPolicy",
    name,
    legacyText: edit.text,
  });
});

Deno.test("operator authority requests preserve namespace boundaries and reject unsafe identities", async () => {
  const systemName = "'Team::Space'::system";
  const base: SourceRevision = {
    version: "base",
    sources: {},
    elements: [{
      "@id": "package",
      "@type": "Package",
      qualifiedName: "'Team::Space'",
      declaredName: "Team::Space",
    }, {
      "@id": "system",
      "@type": "PartUsage",
      qualifiedName: systemName,
      declaredName: "system",
      owner: { "@id": "package" },
    }],
  };
  const request: OperatorAuthorityRequest = {
    op: "createRequestOperator",
    systemName,
    changeId: "request-one",
    name: "Research",
    operator: {
      instruction: 'Answer "carefully". } part escape; //',
      networkHosts: [],
      requestType: { name: "Research request", maxInvocations: 4 },
      firstRequest: { objective: "Ask for network scope" },
    },
  };
  const before = structuredClone(base);
  const name = await requestOperatorSystemName(systemName, request.changeId);
  await assert.rejects(
    () =>
      operatorAuthorityRequests({
        ...base,
        elements: [...base.elements, {
          "@id": "selected-template",
          "@type": "PerformActionUsage",
          declaredName: "operatorFlowTemplate",
          qualifiedName: `${systemName}::operatorFlowTemplate`,
          owner: { "@id": "system" },
        }],
      }, request),
    /unsupported native conversation system qualified name/,
  );
  await assert.rejects(
    () => operatorAuthorityRequests(base, request),
    /explicit admitted native flow template/,
  );
  const legacyBase = structuredClone(base);
  for (const namespace of ["Core", "Authority", "Cases"]) {
    legacyBase.elements.push({
      "@id": `legacy-${namespace}`,
      "@type": "Package",
      qualifiedName: `ASE${namespace}`,
      declaredName: `ASE${namespace}`,
    });
  }
  await assert.rejects(
    () => operatorAuthorityRequests(legacyBase, request),
    /explicit admitted native flow template/,
  );
  assert.deepEqual(base, before);
  for (
    const [elements, code] of [
      [base.elements.slice(0, 1), "TARGET_MISSING"],
      [
        [...base.elements, { ...base.elements[1]!, "@id": "duplicate" }],
        "TARGET_AMBIGUOUS",
      ],
      [
        [base.elements[0]!, { ...base.elements[1]!, "@type": "Package" }],
        "READ_BACK_MISMATCH",
      ],
    ] as const
  ) {
    await assert.rejects(
      () =>
        operatorAuthorityRequests(
          { ...base, elements: [...elements] },
          request,
        ),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === code,
    );
  }
  await assert.rejects(() =>
    operatorAuthorityRequests({
      ...base,
      elements: [...base.elements, {
        "@id": "existing",
        "@type": "PartUsage",
        qualifiedName: name,
        declaredName: parseSysmlQualifiedName(name)!.at(-1),
        owner: { "@id": "package" },
      }],
    }, request), /already exists/);
});

for (const product of ["Assembly", "ASE"]) {
  Deno.test({
    name:
      `operator authority writer compiles bounded grant and durable Request composition with real Toolkit (${product})`,
    ignore: !toolkitIntegrationEnabled,
    async fn() {
      const options = { packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")! };
      const compiler = new ToolkitCompiler(options),
        tooling = new SysmlToolkitAdapter(options);
      const initialSources = await loadInitialSources(
        product === "ASE"
          ? new URL(
            "../../../../../test/fixtures/legacy-ase-model/",
            import.meta.url,
          )
          : undefined,
        {
          information: false,
        },
      );
      if (product === "ASE") {
        // Legacy namespaces remain readable. Creation requires an explicit
        // source upgrade selecting the supported profile, never a host default.
        const current = await loadInitialSources(undefined, {
          information: false,
        });
        const currentConversation = current["conversation.sysml"]!;
        const profile = currentConversation.slice(
          currentConversation.indexOf(
            "    item def DeclaredConsultationOutcome",
          ),
          currentConversation.lastIndexOf("\n}"),
        );
        const oldConversation = initialSources["conversation.sysml"]!;
        const close = oldConversation.lastIndexOf("\n}");
        initialSources["conversation.sysml"] = oldConversation.slice(0, close) +
          "\n" + profile + oldConversation.slice(close);
        initialSources["configuration.sysml"] =
          initialSources["configuration.sysml"]!.replace(
            "part liveBuilder : ConversationSystem {",
            `part liveBuilder : ConversationSystem {
            perform action operatorFlowTemplate : ASEConversation::ConsultingConversationV1;
            attribute operatorFlowTemplateRevision : Integer = 2;`,
          );
      }
      const base = {
        ...await compiler.compile(initialSources),
        version: "base",
      };
      const initialModel = await validateSourceExecutable(
        base,
        "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
      );
      const withoutUnusedDefinition = {
        ...initialSources,
        "authority.sysml": initialSources["authority.sysml"]!.replace(
          /\n {4}part def ToolAdmissionPolicy \{[\s\S]*?\n {4}\}\n/,
          "\n",
        ),
      };
      assert.notEqual(
        withoutUnusedDefinition["authority.sysml"],
        initialSources["authority.sysml"],
      );
      const historical = {
        ...await compiler.compile(withoutUnusedDefinition),
        version: base.version,
      };
      const historicalModel = await validateSourceExecutable(
        historical,
        "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
      );
      assert.equal(initialModel.version.digest, historicalModel.version.digest);
      assert.equal(initialModel.toolAdmissionPolicies, undefined);
      assert.equal(
        initialModel.mandate.supportedChanges.some((change) =>
          change.requestedRights === "toolAdmission"
        ),
        true,
      );
      assert.equal(
        historicalModel.mandate.supportedChanges.some((change) =>
          change.requestedRights === "toolAdmission"
        ),
        false,
      );
      assert.equal(historicalModel.toolAdmissionPolicies, undefined);
      const compile = async (sources: Record<string, string>) => ({
        ...await compiler.compile(sources),
        version: base.version,
      });
      const applyAuthority = async (
        revision: SourceRevision,
        request: OperatorAuthorityRequest,
      ) => {
        const { requests, systemQualifiedName } =
          await operatorAuthorityRequests(
            revision,
            request,
          );
        assert.equal(requests.length, 1);
        const prepared = await applyEdits(tooling, revision, requests, {
          compile,
        });
        const candidate = await compile(prepared.sources);
        await verifyEdits(candidate, prepared.edits, { base: revision });
        await validateSourceExecutable(
          candidate,
          "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
          systemQualifiedName,
        );
        return { ...prepared, candidate, systemQualifiedName };
      };
      const grant = {
        op: "grantModelEditing" as const,
        systemName: `${product}LiveBuilder::liveBuilder`,
        changeId: "grant-one",
        grant: {
          file: "configuration.sysml",
          root: `${product}LiveBuilder::liveBuilder::catalog`,
          operations: ["insert-member" as const],
        },
      };
      const prepared = await applyAuthority(base, grant);
      const identity = sourceModelIdentity(
        prepared.candidate,
        "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
      );
      const policy = compileModelEditPolicy(
        sourceSnapshot(prepared.candidate.elements, identity.rootId),
        sourceLiterals(prepared.candidate.elements),
        identity,
      )!;
      assert.deepEqual(policy.operations, ["insert-member"]);
      assert.equal(policy.holderNativeId, identity.builderId);
      assert.equal(policy.rootAuthority?.ownerSource, "modeled");
      await assert.rejects(
        () => applyAuthority(prepared.candidate, grant),
        /already exists/,
      );
      await assert.rejects(() =>
        applyAuthority(base, {
          ...grant,
          grant: { ...grant.grant, operations: ["replace-source" as never] },
        }), /replacement/);
      const created = await applyAuthority(
        prepared.candidate,
        {
          op: "createRequestOperator",
          systemName: grant.systemName,
          changeId: "request-one",
          name: "Research",
          operator: {
            instruction: 'Answer "carefully". } part escape; //',
            networkHosts: [],
            requestType: { name: "Research request", maxInvocations: 4 },
            firstRequest: { objective: "Ask for network scope" },
          },
        },
      );
      const model = await validateSourceExecutable(
        created.candidate,
        "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
        created.systemQualifiedName,
      );
      const tools = await applyAuthority(created.candidate, {
        op: "publishToolAdmissionPolicy",
        systemName: grant.systemName,
        changeId: "tool-policy-one",
        policy: {
          policyId: "research-tools",
          expectedPolicyRevision: 0,
          enabled: true,
          recipients: [model.identity.builderId],
          toolKinds: ["read_web_page_outline"],
          maxDelegationDepth: 0,
        },
      });
      const holder = await validateSourceExecutable(
        tools.candidate,
        "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
        grant.systemName,
      );
      const admittedToolPolicy = holder.toolAdmissionPolicies?.[0];
      assert(admittedToolPolicy);
      assert.equal(admittedToolPolicy.id, "research-tools");
      assert.equal(admittedToolPolicy.revision, 1);
      assert.equal(admittedToolPolicy.enabled, true);
      assert.equal(
        admittedToolPolicy.holderNativeId,
        holder.identity.builderId,
      );
      assert.deepEqual(admittedToolPolicy.recipients, [
        model.identity.builderId,
      ]);
      assert.deepEqual(admittedToolPolicy.toolKinds, ["read_web_page_outline"]);
      assert.equal(admittedToolPolicy.maxDelegationDepth, 0);
      assert.equal(admittedToolPolicy.rootAuthority?.ownerSource, "modeled");
      assert.equal(admittedToolPolicy.recipientExecutionSpaceId, undefined);
      assert.equal(holder.configuration.builder.admissionAuthority, "human");
      assert.equal(holder.operatorAuthorityPolicies, undefined);
      // An explicit recipient space survives writing and compilation; a
      // legacy library without the attribute refuses it instead of dropping it.
      const scopedTools = {
        op: "publishToolAdmissionPolicy" as const,
        systemName: grant.systemName,
        changeId: "tool-policy-two",
        policy: {
          policyId: "research-tools",
          expectedPolicyRevision: 1,
          enabled: true,
          recipients: [model.identity.builderId],
          recipientExecutionSpaceId: "case-x",
          toolKinds: ["read_web_page_outline" as const],
          maxDelegationDepth: 0 as const,
        },
      };
      if (product === "ASE") {
        await assert.rejects(
          () => applyAuthority(tools.candidate, scopedTools),
          (error: unknown) =>
            error instanceof Error && "code" in error &&
            error.code === "TARGET_MISSING",
        );
      } else {
        const scoped = await applyAuthority(tools.candidate, scopedTools);
        const scopedHolder = await validateSourceExecutable(
          scoped.candidate,
          "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
          grant.systemName,
        );
        assert.equal(scopedHolder.toolAdmissionPolicies?.[0]?.revision, 2);
        assert.equal(
          scopedHolder.toolAdmissionPolicies?.[0]?.recipientExecutionSpaceId,
          "case-x",
        );
      }
      const holderIdentity = sourceModelIdentity(
        tools.candidate,
        "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf",
        grant.systemName,
      );
      const toolSnapshot = sourceSnapshot(
        tools.candidate.elements,
        holderIdentity.rootId,
      );
      const toolLiterals = sourceLiterals(tools.candidate.elements);
      for (
        const [name, value] of [
          ["toolKinds", '["unsupported-tool"]'],
          ["recipients", JSON.stringify([holder.identity.builderId])],
        ]
      ) {
        const corrupted = structuredClone(toolLiterals);
        corrupted.find((literal) =>
          literal.owner === admittedToolPolicy.elementId &&
          literal.name === name
        )!.value = value;
        assert.throws(() =>
          compileToolAdmissionPolicies(toolSnapshot, corrupted, holderIdentity)
        );
      }
      for (const featureName of ["holder", "issuer"]) {
        const corrupted = structuredClone(toolSnapshot);
        const feature = corrupted.elements.find((element) =>
          element.qualifiedName ===
            `${product}Authority::ToolAdmissionPolicy::${featureName}`
        )!;
        const binding = corrupted.connectors.find((connector) =>
          connector.ends.some((end) =>
            canonical(end.chain.map((part) => part.id)) ===
              canonical([admittedToolPolicy.elementId, feature.id])
          )
        )!;
        const target = binding.ends.find((end) =>
          canonical(end.chain.map((part) => part.id)) !==
            canonical([admittedToolPolicy.elementId, feature.id])
        )!;
        target.chain = [{ id: model.identity.builderId, name: "builder" }];
        assert.throws(() =>
          compileToolAdmissionPolicies(corrupted, toolLiterals, holderIdentity)
        );
      }
      assert.equal(model.operator?.name, "Research");
      assert.equal(
        model.operator?.instruction,
        'Answer "carefully". } part escape; //',
      );
      assert.equal(model.operator?.primary, false);
      assert.equal(model.mandate.id, "builder-v1");
      assert.equal(model.configuration.builder.admissionAuthority, "human");
      assert.deepEqual(model.mandate.network.allowedHosts, []);
      assert.deepEqual(model.mandate.mayPropose, [
        "read_web_page",
        "read_web_page_outline",
      ]);
      assert.equal(model.mandate.mayInvoke, "active-catalog-only");
      assert.equal(model.mandate.mayReview, false);
      assert.equal(model.mandate.mayActivate, false);
      assert.deepEqual(
        model.mandate.supportedChanges.map((change) => change.requestedRights),
        ["addNetworkHosts"],
      );
      assert.equal(model.policy.mayCreateReviewer, false);
      assert.equal(model.policy.mayConsultModel, true);
      assert.equal(model.policy.mayProposeSysmlRevision, false);
      assert.equal(model.policy.mayDelegateOwnAdmission, false);
      assert.equal(model.operator?.humanInput, false);
      assert.equal(model.modelEditPolicy, undefined);
      assert.equal(model.memoryPolicy, undefined);
      assert.equal(model.skillPolicy, undefined);
      assert.equal(model.caseTypes?.length, 1);
      assert.equal(model.caseTypes?.[0]?.maxInvocations, 4);
      if (product === "ASE") {
        assert(
          created.candidate.sources["configuration.sysml"]!.includes(
            "attribute mayConsultModel : Boolean = true;",
          ),
          "A legacy ExecutionPolicy without this inherited feature declares the new read right locally",
        );
      }
      assert.equal(created.edits[0]?.op, "insertMember");
      assert.equal(
        created.candidate.elements.some((element) =>
          element.declaredName === "escape"
        ),
        false,
      );
      await verifyEdits(created.candidate, created.edits);
      const inserted = created.edits[0]!;
      assert.equal(inserted.op, "insertMember");
      if (inserted.op !== "insertMember") throw new Error("Expected insertion");
      assert.equal(inserted.format, 1);
      assert.equal(inserted.intent, "authority");
      assert.equal(
        inserted.expectDigest,
        await sha256(canonical(inserted.expect)),
      );
      assert(
        inserted.expect.every((expected) =>
          expected.kind === "member" &&
          /^[a-f0-9]{64}$/.test(expected.sourceDigest ?? "") &&
          !Object.hasOwn(expected, "sourceText")
        ),
      );
      const corrupted = structuredClone(created.candidate);
      const entry = corrupted.elements.find((element) =>
        element.qualifiedName ===
          (inserted.expect[0]!.kind === "member"
            ? inserted.expect[0]!.qualifiedName
            : "")
      );
      if (entry) {
        entry["@type"] = "ItemUsage";
      }
      await assert.rejects(() => verifyEdits(corrupted, created.edits));
    },
  });
}

Deno.test("operator insertion recovery checks member proof, operations and targets", async () => {
  const source = "package Demo { part child; }";
  const candidate = {
    version: "published",
    sources: { "model.sysml": source },
    elements: [
      {
        "@id": "p",
        "@type": "Package",
        qualifiedName: "Demo",
        declaredName: "Demo",
        "sysx:sourceDocument": "model.sysml",
        "sysx:sourceLine": 1,
        "sysx:sourceColumn": 1,
        "sysx:sourceEndLine": 1,
        "sysx:sourceEndColumn": source.length + 1,
      },
      {
        "@id": "c",
        "@type": "PartUsage",
        qualifiedName: "Demo::child",
        declaredName: "child",
        owner: { "@id": "p" },
        "sysx:sourceDocument": "model.sysml",
        "sysx:sourceLine": 1,
        "sysx:sourceColumn": 16,
        "sysx:sourceEndLine": 1,
        "sysx:sourceEndColumn": 27,
      },
    ],
  };
  const receipt: HostEdit = {
    format: 1,
    op: "insertMember",
    intent: "authority",
    owner: {
      id: "p",
      qualifiedName: "Demo",
      metaclass: "Package",
      preimage: "unused-in-readback",
    },
    text: "part child;",
    expect: [{
      kind: "member",
      qualifiedName: "Demo::child",
      metaclass: "PartUsage",
      sourceDigest: await sha256("part child;"),
    }],
    expectDigest: "",
    introduced: [{ qualifiedName: "Demo::child", metaclass: "PartUsage" }],
  };
  receipt.expectDigest = await sha256(canonical(receipt.expect));
  await verifyEdits(candidate, [receipt]);
  const withoutProof = [{
    kind: "member" as const,
    qualifiedName: "Demo::child",
    metaclass: "PartUsage",
  }];
  const wrongProof = [{
    ...receipt.expect[0]!,
    sourceDigest: await sha256("part other;"),
  }];
  for (
    const invalid of [
      { ...receipt, op: "unknown" },
      { ...receipt, expect: [] },
      {
        ...receipt,
        expect: [],
        expectDigest: await sha256(canonical([])),
      },
      { ...receipt, expectDigest: undefined },
      {
        ...receipt,
        expect: withoutProof,
        expectDigest: await sha256(canonical(withoutProof)),
      },
      { ...receipt, introduced: [] },
      { ...receipt, expect: [{ ...receipt.expect[0], sourceDigest: "" }] },
      {
        ...receipt,
        expect: [{ ...receipt.expect[0], metaclass: "ItemUsage" }],
      },
      {
        ...receipt,
        expect: wrongProof,
        expectDigest: await sha256(canonical(wrongProof)),
      },
      { ...receipt, owner: { ...receipt.owner, qualifiedName: "Missing" } },
      { ...receipt, owner: { ...receipt.owner, metaclass: "PartUsage" } },
    ]
  ) {
    await assert.rejects(() =>
      verifyEdits(candidate, [invalid as typeof receipt])
    );
  }
});

Deno.test({
  name:
    "future operator factory uses exact creator-selected native template and preserves existing consumers",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const options = { packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")! };
    const compiler = new ToolkitCompiler(options),
      tooling = new SysmlToolkitAdapter(options);
    const initial = await loadInitialSources(undefined, { information: false });
    const compile = async (sources: Record<string, string>) => ({
      ...await compiler.compile(sources),
      version: "commit:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    const base = await compile(initial);
    const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
    const creatorName = "AssemblyLiveBuilder::liveBuilder";
    const creatorBefore = await validateSourceExecutable(
      base,
      projectId,
      creatorName,
    );
    const request: OperatorAuthorityRequest = {
      op: "createRequestOperator",
      systemName: creatorName,
      changeId: "selected-future-template",
      name: "Future profile reader",
      operator: {
        instruction: "Read the declared source under existing read rights.",
        networkHosts: [],
        requestType: { name: "Read declared source", maxInvocations: 4 },
        firstRequest: { objective: "Read the declared source" },
      },
    };
    assert.equal(
      creatorBefore.flows.conversation.executionProfile,
      "operator-command-immutable-group-v1",
    );
    const withoutSelection = {
      ...initial,
      "configuration.sysml": initial["configuration.sysml"]!.replace(
        /\n *perform action operatorFlowTemplate : ImmutableGroupConversationV1;\n *attribute operatorFlowTemplateRevision : Integer = 2;/,
        "",
      ),
    };
    const missingBase = await compile(withoutSelection);
    await assert.rejects(
      () => operatorAuthorityRequests(missingBase, request),
      /explicit admitted native flow template/,
    );
    const selectedSources: Record<string, string> = {
      ...initial,
      "configuration.sysml": initial["configuration.sysml"]!.replace(
        "part liveBuilder : ConversationSystem {",
        `part liveBuilder : ConversationSystem {
        part creationPolicy : AssemblyAuthority::OperatorCreationPolicy {
          attribute :>> id = "bounded-creation";
          attribute :>> revision = 1;
          attribute :>> enabled = true;
          attribute :>> networkHosts = "[]";
          attribute :>> maxChildren = 2;
          attribute :>> maxDelegationDepth = 1;
        }
        bind creationPolicy.holder = builder;
        bind creationPolicy.mandate = builderMandate;
        bind creationPolicy.issuer = owner.ownerMandate.rootAuthority;`,
      ),
    };
    const quotedValues: Record<string, string> = {
      SYSTEM: "system",
      ID: JSON.stringify("quoted-source-operator"),
      NAME: JSON.stringify("Quoted source operator"),
      INSTRUCTION: JSON.stringify("Work within the exact current mandate."),
      HOSTS: JSON.stringify("[]"),
      OBJECTIVE: JSON.stringify("Exercise the admitted source template"),
      REQUEST: "InitialRequest",
      CEILING: "4",
      MODEL_READ_DECLARATION: "attribute :>> mayConsultModel = true;",
      FLOW_REVISION: "2",
      MAY_PROPOSE_SYSML_REVISION: "false",
    };
    const quotedOperator = REQUEST_OPERATOR_TEMPLATE.split("__").map((
      part,
      index,
    ) => index % 2 ? quotedValues[part]! : part).join("");
    assert(!quotedOperator.includes("__"));
    const quotedSources = {
      ...selectedSources,
      "quoted-factory.sysml": `package 'Team::Space' {
      private import ScalarValues::*;
      private import AssemblyCore::*;
      private import AssemblyConversation::*;
      private import AssemblyExecution::*;
      private import AssemblyLiveBuilder::*;
      ${quotedOperator}
    }`,
    };
    const selectedBase = await compile(selectedSources);
    const creatorSelected = await validateSourceExecutable(
      selectedBase,
      projectId,
      creatorName,
    );
    // Adding the fixture's creation grant changes anonymous allocation evidence;
    // it must not change the selected action root/profile. Exact pins remain
    // versioned rather than being declared equivalent across that source edit.
    assert.equal(
      creatorSelected.flows.conversation.rootNativeId,
      creatorBefore.flows.conversation.rootNativeId,
    );
    assert.equal(
      creatorSelected.flows.conversation.executionProfile,
      creatorBefore.flows.conversation.executionProfile,
    );
    assert.equal(
      creatorSelected.operatorFlowTemplate?.qualifiedName,
      "AssemblyConversation::ImmutableGroupConversationV1",
    );
    assert.equal(creatorSelected.operatorFlowTemplate?.revision, 2);
    const quotedRequest = {
      ...request,
      systemName: "'Team::Space'::system",
      changeId: "quoted-request",
      operator: {
        ...request.operator,
        instruction: 'Answer "carefully". } part escape; //',
        requestType: { name: "Research request", maxInvocations: 4 },
      },
    };
    const quotedBase = await compile(quotedSources);
    // Native syntax accepts quoted namespaces. Operator registration and the
    // executable graph retain their existing narrower name contract.
    await assert.rejects(
      () => validateSourceExecutable(quotedBase, projectId, creatorName),
      /Unsupported native conversation system qualified name/,
    );
    await assert.rejects(
      () => operatorAuthorityRequests(quotedBase, quotedRequest),
      /unsupported native conversation system qualified name/,
    );
    const teamComposition = await assertTeamCreationComposition(selectedBase);
    const teamEdits = await applyEdits(
      tooling,
      selectedBase,
      teamComposition.requests,
      { compile },
    );
    const teamCandidate = await compile(teamEdits.sources);
    const teamModel = await validateSourceExecutable(
      teamCandidate,
      projectId,
      teamComposition.systemQualifiedName,
    );
    assert.equal(
      teamModel.flows.conversation.executionProfile,
      "operator-command-immutable-group-v1",
    );
    assert.equal(
      teamModel.operatorFlowTemplate?.qualifiedName,
      creatorSelected.operatorFlowTemplate!.qualifiedName,
    );
    assert.equal(
      teamModel.operatorFlowTemplate?.revision,
      creatorSelected.operatorFlowTemplate!.revision,
    );
    assert(teamModel.operatorEntries?.some((entry) => entry.kind === "inbox"));
    assert.equal(teamModel.policy.mayConsultModel, false);
    assert.equal(teamModel.policy.mayProposeSysmlRevision, false);
    for (const mayConsultModel of [false, true]) {
      for (const mayProposeSysmlRevision of [false, true]) {
        const spec = teamComposition.command.operator;
        assert("kind" in spec && spec.kind === "request-team-member");
        const command = {
          ...teamComposition.command,
          changeId: `rights-${mayConsultModel}-${mayProposeSysmlRevision}`,
          creatorMayAddNetworkHosts: false,
          operator: {
            ...spec,
            provision: {
              ...spec.provision,
              mayConsultModel,
              mayProposeSysmlRevision,
            },
          },
        };
        if (!mayConsultModel && mayProposeSysmlRevision) {
          await assert.rejects(
            () => operatorAuthorityRequests(selectedBase, command),
            (error: unknown) =>
              error instanceof Error && "code" in error &&
              error.code === "INVALID_OPERATOR_REQUEST" &&
              "context" in error &&
              (error.context as { field?: string }).field === "mayConsultModel",
          );
          continue;
        }
        const requested = await operatorAuthorityRequests(
          selectedBase,
          command,
        );
        const declaration = requested.requests[0]!;
        assert(declaration.op === "insertMember");
        assert(
          declaration.text.includes(`mayConsultModel = ${mayConsultModel};`),
        );
        assert(
          declaration.text.includes(
            `mayProposeSysmlRevision = ${mayProposeSysmlRevision};`,
          ),
        );
        const rightsEdit = await applyEdits(
          tooling,
          selectedBase,
          requested.requests,
          { compile },
        );
        const rightsSource = await compile(rightsEdit.sources);
        const rightsModel = await validateSourceExecutable(
          rightsSource,
          projectId,
          requested.systemQualifiedName,
        );
        const matrix = await projectAuthorityMatrix({
          revision: rightsSource,
          units: await validateSourceExecutables(rightsSource, projectId),
        });
        const row = matrix.rows.find((entry) =>
          entry.role === "builder" &&
          entry.unit === requested.systemQualifiedName
        );
        assert(row);
        const readCell = matrix.cells.find((entry) =>
          entry.row === row.id && entry.column === "model.consult"
        );
        assert(readCell);
        assert.equal(readCell.state, mayConsultModel ? "allowed" : "denied");
        assert(
          readCell.sources.some((entry) =>
            entry.qname?.endsWith("::mayConsultModel")
          ),
        );
        assert.equal(rightsModel.policy.mayConsultModel, mayConsultModel);
        assert.equal(
          rightsModel.policy.mayProposeSysmlRevision,
          mayProposeSysmlRevision,
        );
      }
    }
    const prepared = await operatorAuthorityRequests(selectedBase, request);
    const selectedText = prepared.requests[0];
    assert(selectedText.op === "insertMember");
    assert(
      selectedText.text.includes(
        "perform action conversation : AssemblyConversation::ImmutableGroupConversationV1 {",
      ),
    );
    assert(
      !selectedText.text.includes(
        "allocate conversation.consultDeclaredSource to admissionGate;",
      ),
    );
    assert(
      selectedText.text.includes(
        "allocate conversation.executeOperatorCommand to admissionGate;",
      ),
    );
    const edited = await applyEdits(tooling, selectedBase, prepared.requests, {
      compile,
    });
    const candidate = await compile(edited.sources);
    await verifyEdits(candidate, edited.edits, { base: selectedBase });
    const child = await validateSourceExecutable(
      candidate,
      projectId,
      prepared.systemQualifiedName,
    );
    assert.equal(
      child.flows.conversation.executionProfile,
      "operator-command-immutable-group-v1",
    );
    assert.equal(
      child.operatorFlowTemplate?.qualifiedName,
      creatorSelected.operatorFlowTemplate!.qualifiedName,
    );
    assert.equal(
      child.operatorFlowTemplate?.revision,
      creatorSelected.operatorFlowTemplate!.revision,
    );
    assert.equal(
      child.flows.conversation.nodes.filter((node) =>
        node.mechanism === "consult_declared_source"
      ).length,
      0,
    );
    assert.equal(
      child.flows.conversation.nodes.find((node) =>
        node.mechanism === "execute_operator_command"
      )!.performerId,
      candidate.elements.find((element) =>
        element.qualifiedName ===
          `${prepared.systemQualifiedName}::admissionGate`
      )!["@id"],
    );
    const unchanged = await validateSourceExecutable(
      candidate,
      projectId,
      creatorName,
    );
    assert.deepEqual(
      operatorFlowSemantics(unchanged.flows),
      operatorFlowSemantics(creatorSelected.flows),
    );
    assert.deepEqual(unchanged.identity, creatorSelected.identity);
    assert.deepEqual(unchanged.configuration, creatorSelected.configuration);
    await assert.rejects(
      () =>
        operatorAuthorityRequests(selectedBase, {
          ...request,
          operator: {
            ...request.operator,
            flowTemplate: {
              qualifiedName:
                "AssemblyConversation::ImmutableGroupConversationV1",
              revision: 1,
            },
          },
        }),
      /exact admitted selection/,
    );
    const explicit = await operatorAuthorityRequests(selectedBase, {
      ...request,
      operator: {
        ...request.operator,
        flowTemplate: {
          qualifiedName: "AssemblyConversation::ImmutableGroupConversationV1",
          revision: 2,
        },
      },
    });
    assert.deepEqual(explicit, prepared);

    // Reconstruct the retained revision-1 contract explicitly: its selected
    // template still has the read and the writer must generate its allocation.
    const source = selectedSources["conversation.sysml"]!;
    const groupStart = source.indexOf(
      "action def ImmutableGroupConversationV1 {",
    );
    assert(groupStart >= 0);
    const prefix = source.slice(0, groupStart);
    let legacyGroup = source.slice(groupStart);
    assert(legacyGroup.includes("first readCaseState then chooseNextMove;"));
    legacyGroup = legacyGroup.replace(
      "attribute templateRevision : Integer = 2;",
      "attribute templateRevision : Integer = 1;",
    ).replace(
      "action chooseNextMove : ChooseNextMove;",
      `action consultDeclaredSource : ConsultDeclaredModelSource {
            attribute consultationRequest : String = "{\\"operation\\":\\"read_source\\",\\"path\\":\\"conversation.sysml\\"}";
        }
        action chooseNextMove : ChooseNextMove;`,
    ).replace(
      "first readCaseState then chooseNextMove;",
      `first readCaseState then consultDeclaredSource;
        first consultDeclaredSource then consultationOutcome;
        decide consultationOutcome;
            if consultDeclaredSource.consultation.succeeded then chooseNextMove;
            else awaitingContribution;`,
    );
    const configuration = selectedSources["configuration.sysml"]!
      .replace(
        "attribute operatorFlowTemplateRevision : Integer = 2;",
        "attribute operatorFlowTemplateRevision : Integer = 1;",
      ).replace(
        "allocate conversation.readCaseState to admissionGate;",
        `allocate conversation.readCaseState to admissionGate;
        allocate conversation.consultDeclaredSource to admissionGate;`,
      );
    const legacyBase = await compile({
      ...selectedSources,
      "conversation.sysml": prefix + legacyGroup,
      "configuration.sysml": configuration,
    });
    const legacyPrepared = await operatorAuthorityRequests(legacyBase, request);
    const legacyText = legacyPrepared.requests[0]!;
    assert(legacyText.op === "insertMember");
    assert(
      legacyText.text.includes(
        "allocate conversation.consultDeclaredSource to admissionGate;",
      ),
    );
    const legacyEdit = await applyEdits(
      tooling,
      legacyBase,
      legacyPrepared.requests,
      { compile },
    );
    const legacyChild = await validateSourceExecutable(
      await compile(legacyEdit.sources),
      projectId,
      legacyPrepared.systemQualifiedName,
    );
    assert.equal(legacyChild.operatorFlowTemplate?.revision, 1);
    assert.equal(
      legacyChild.flows.conversation.nodes.filter((node) =>
        node.mechanism === "consult_declared_source"
      ).length,
      1,
    );
  },
});

Deno.test({
  name:
    "future template writer separates ambiguous views from execution diagnostics",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const {
      nativeEvolutionSources,
      nativeEvolutionMain,
      nativeEvolutionPeer,
      privateEvolutionFlow,
    } = await import("../../../../../test/fixtures/native-evolution.ts");
    const options = { packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")! };
    const compiler = new ToolkitCompiler(options);
    const tooling = new SysmlToolkitAdapter(options);
    const base = {
      ...await compiler.compile(await nativeEvolutionSources()),
      version: "private-template-base",
    };
    const template = base.elements.find((element) =>
      element.qualifiedName === `${nativeEvolutionMain}::operatorFlowTemplate`
    )!;
    assert(template);
    // The independent template has no allocation sites to retarget. Keep Main
    // and Peer conversations unchanged while selecting the exact private type.
    const edited = await tooling.edit(base.sources, [{
      kind: "set-type",
      target: modelToolingTarget(base, String(template["@id"])),
      type: privateEvolutionFlow,
    }]);
    const selectedBase = {
      ...await compiler.compile(edited.sources),
      version: "private-template-selected",
    };
    const before = structuredClone(selectedBase);
    const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
    const creator = await validateSourceExecutable(
      selectedBase,
      projectId,
      nativeEvolutionMain,
    );
    const peer = await validateSourceExecutable(
      selectedBase,
      projectId,
      nativeEvolutionPeer,
    );
    assert.notEqual(creator.identity.systemId, peer.identity.systemId);
    assert.equal(
      creator.operatorFlowTemplate!.qualifiedName,
      privateEvolutionFlow,
    );
    const graph = projectSourceGraph(selectedBase.elements, creator.identity);
    assert(
      graph.viewDiagnostics?.length,
      "The witness must retain ambiguous presentation exposures",
    );
    assert(graph.diagnostics.length > 0);
    assert.deepEqual(graph.executionDiagnostics, []);
    const request: OperatorAuthorityRequest = {
      op: "createRequestOperator",
      systemName: nativeEvolutionMain,
      changeId: "private-template-view-diagnostics",
      name: "Private template reader",
      operator: {
        instruction:
          "Use the exact selected flow under separately admitted authority.",
        networkHosts: [],
        requestType: { name: "Template request", maxInvocations: 4 },
        firstRequest: { objective: "Exercise the exact selected template" },
        flowTemplate: { qualifiedName: privateEvolutionFlow, revision: 2 },
      },
    };
    const prepared = await operatorAuthorityRequests(selectedBase, request);
    assert.equal(prepared.requests.length, 1);
    const declaration = prepared.requests[0]!;
    assert(declaration.op === "insertMember");
    assert(
      declaration.text.includes(
        `perform action conversation : ${privateEvolutionFlow} {`,
      ),
    );
    assert(
      declaration.text.includes(
        `perform action operatorFlowTemplate : ${privateEvolutionFlow};`,
      ),
    );
    assert(
      declaration.text.includes(
        "attribute operatorFlowTemplateRevision : Integer = 2;",
      ),
    );
    assert.deepEqual(
      selectedBase,
      before,
      "Preparing declarations cannot mutate the pinned base",
    );

    // Inject a malformed compiled connector at this producer boundary. The
    // production projector must still report a real executable diagnostic;
    // this is not presented as a valid native source revision or publication.
    const invalid = structuredClone(selectedBase);
    const allocationId = creator.flows.conversation.nodes.find((node) =>
      node.allocationId
    )!.allocationId!;
    const allocation = invalid.elements.find((element) =>
      element["@id"] === allocationId
    )!;
    assert(allocation);
    allocation.connectorEnd = [];
    allocation.sourceFeature = [];
    allocation.targetFeature = [];
    const invalidGraph = projectSourceGraph(invalid.elements, creator.identity);
    assert(
      (invalidGraph.executionDiagnostics ?? invalidGraph.diagnostics).length >
        0,
    );
    const invalidBefore = structuredClone(invalid);
    await assert.rejects(
      () => operatorAuthorityRequests(invalid, request),
      /future operator template native graph/,
    );
    assert.deepEqual(
      invalid,
      invalidBefore,
      "Executable refusal precedes any source write",
    );
    await assert.rejects(
      () =>
        operatorAuthorityRequests(selectedBase, {
          ...request,
          operator: {
            ...request.operator,
            flowTemplate: { qualifiedName: privateEvolutionFlow, revision: 1 },
          },
        }),
      /exact admitted selection/,
    );
  },
});

Deno.test({
  name:
    "writer emits an explicit creation mode, the compiled occurrence carries it, and a pre-4.8e definition refuses it",
  ignore: !toolkitIntegrationEnabled,
  async fn() {
    const options = { packageDir: Deno.env.get("SYSML_TOOLKIT_DIR")! };
    const compiler = new ToolkitCompiler(options),
      tooling = new SysmlToolkitAdapter(options);
    const initial = await loadInitialSources(undefined, {
      information: false,
    });
    const compile = async (sources: Record<string, string>) => ({
      ...await compiler.compile(sources),
      version: "mode-base",
    });
    const projectId = "git:a7094f0f-2bd8-5810-8c1f-e2675497acbf";
    const creatorName = "AssemblyLiveBuilder::liveBuilder";
    const withParentGrant = (sources: Record<string, string>) => ({
      ...sources,
      "configuration.sysml": sources["configuration.sysml"]!.replace(
        "part liveBuilder : ConversationSystem {",
        `part liveBuilder : ConversationSystem {
        part creationPolicy : AssemblyAuthority::OperatorCreationPolicy {
          attribute :>> id = "bounded-creation";
          attribute :>> revision = 1;
          attribute :>> enabled = true;
          attribute :>> networkHosts = "[]";
          attribute :>> maxChildren = 2;
          attribute :>> maxDelegationDepth = 1;
        }
        bind creationPolicy.holder = builder;
        bind creationPolicy.mandate = builderMandate;
        bind creationPolicy.issuer = owner.ownerMandate.rootAuthority;`,
      ),
    });
    const selectedBase = await compile(withParentGrant(initial));
    const parentGrantId = String(
      selectedBase.elements.find((element) =>
        element.qualifiedName === `${creatorName}::creationPolicy`
      )!["@id"],
    );
    const parentOperatorId = String(
      selectedBase.elements.find((element) =>
        element.qualifiedName === `${creatorName}::builder`
      )!["@id"],
    );
    const command: OperatorAuthorityRequest = {
      op: "createRequestOperator",
      systemName: creatorName,
      changeId: "mode-team-member",
      creatorMayAddNetworkHosts: true,
      name: "Mode reader",
      teamOrigin: { operatorId: parentOperatorId, requestId: "root-request" },
      parentOperatorId,
      creationPolicy: {
        id: "bounded-creation",
        revision: 1,
        elementId: parentGrantId,
      },
      operator: {
        kind: "request-team-member",
        instruction: "Read the assigned source.",
        provision: {
          budget: {
            maxAgentDecisions: 5,
            maxToolProposals: 1,
            maxFlowSteps: 96,
          },
          networkHosts: [],
          mayPropose: ["read_web_page"],
          mayInvokeActiveCatalog: false,
        },
        creationGrant: {
          networkHosts: [],
          maxChildren: 1,
          maxDelegationDepth: 0,
          mode: "per-creation",
        },
      },
    };
    const prepared = await operatorAuthorityRequests(selectedBase, command);
    const childDeclaration = prepared.requests[0]!;
    assert(childDeclaration.op === "insertMember");
    assert(
      childDeclaration.text.includes(
        'attribute :>> mode = "per-creation";',
      ),
    );
    const edited = await applyEdits(tooling, selectedBase, prepared.requests, {
      compile,
    });
    const candidate = await compile(edited.sources);
    const child = await validateSourceExecutable(
      candidate,
      projectId,
      prepared.systemQualifiedName,
    );
    const compiled = child.operatorCreationPolicies?.find((policy) =>
      policy.holderNativeId === child.identity.builderId
    );
    assert.equal(compiled?.mode, "per-creation");
    // A persisted pre-4.8e definition declares no mode attribute: the same
    // explicit mode is refused there, never silently dropped.
    const legacySources = withParentGrant({
      ...initial,
      "authority.sysml": initial["authority.sysml"]!.replace(
        "        attribute mode : String;\n",
        "",
      ),
    });
    const legacyBase = await compile(legacySources);
    await assert.rejects(
      () =>
        operatorAuthorityRequests(legacyBase, {
          ...command,
          changeId: "mode-legacy-member",
          creationPolicy: {
            id: "bounded-creation",
            revision: 1,
            elementId: String(
              legacyBase.elements.find((element) =>
                element.qualifiedName === `${creatorName}::creationPolicy`
              )!["@id"],
            ),
          },
          parentOperatorId: String(
            legacyBase.elements.find((element) =>
              element.qualifiedName === `${creatorName}::builder`
            )!["@id"],
          ),
          teamOrigin: {
            operatorId: String(
              legacyBase.elements.find((element) =>
                element.qualifiedName === `${creatorName}::builder`
              )!["@id"],
            ),
            requestId: "root-request",
          },
        }),
      (error: unknown) =>
        error instanceof Error && "code" in error &&
        error.code === "TARGET_MISSING",
    );
  },
});
