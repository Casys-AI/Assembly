import type { OperatorAuthorityRequest } from "./operator-authority-request.ts";
import {
  requestOperatorSystemName,
  requireValue,
  string,
} from "./operator-authority-values.ts";
import { sha256Bytes as sha256 } from "../../domain/primitives/sha256-bytes.ts";
import { productNameInModel } from "../../domain/model/sysml-product-names.ts";
import {
  HostEditError,
  spelling,
} from "../../domain/model/editing/host-edit.ts";
import type { HostEditRequest } from "../../domain/model/editing/host-edit.ts";

import {
  parseModelEditGrants,
  parseModelEditOperations,
} from "../../domain/governance/model-access/model-edit-policy.ts";
import { validateNetworkScope } from "../../domain/governance/policies/network-policy.ts";
import {
  parseSysmlQualifiedName,
  spellSysmlQualifiedName,
} from "../../domain/model/value-objects/sysml-qualified-name.ts";
import type { SourceRevision } from "../../domain/model/records/source-revision.ts";
import {
  modelSourceElement,
  modelToolingTarget,
} from "../../domain/model/editing/source-index.ts";

import { projectSourceGraph } from "../../domain/model/projections/source-graph.ts";
import {
  sourceLiterals,
  sourceSnapshot,
} from "../../domain/model/projections/source-facts.ts";
import { modelEditingAuthorityRoots } from "./model-access/model-editing-authority-roots.ts";
import {
  assertGrantModelEditingScope,
  isTeamOperatorSpec,
  validateGrantModelEditing,
  validateOperatorCreationSpec,
} from "../../domain/governance/operator-authority.ts";
export type { RequestOperatorSpec } from "../../domain/governance/operator-authority.ts";
import {
  REQUEST_OPERATOR_TEMPLATE,
  teamOperatorTemplate,
} from "../../domain/governance/operator-template.ts";
import { validateOperatorAuthorityPolicyRequest } from "../../domain/governance/policies/operator-authority-policy.ts";
import { validateToolAdmissionPolicyRequest } from "../../domain/governance/policies/tool-admission-policy.ts";
import {
  requestedCreationPolicyId,
  validateOperatorCreationPolicyRequest,
} from "../../domain/governance/policies/operator-creation-policy.ts";

export interface OperatorFlowReader {
  select(
    snapshot: ReturnType<typeof sourceSnapshot>,
    graph: ReturnType<typeof projectSourceGraph>,
    literals: ReturnType<typeof sourceLiterals>,
    systemId: string,
    elements: SourceRevision["elements"],
  ): {
    selected: {
      definition: { qualifiedName: string };
      flow: {
        nodes: readonly { kind: string; mechanism?: string; name: string }[];
      };
      revision?: number;
    };
    revision: { value: string };
  };
  performer(mechanism: string): string | undefined;
}

function exact(base: SourceRevision, name: string, metaclass?: string) {
  try {
    return modelSourceElement(
      base,
      productNameInModel(base.elements, name),
      metaclass,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Ambiguous product library declaration:")
    ) {
      throw new HostEditError("TARGET_AMBIGUOUS", {
        opIndex: 0,
        op: "insertMember",
        target: { qualifiedName: name },
      }, error.message);
    }
    if (
      error instanceof Error && "code" in error &&
      (error.code === "TARGET_MISSING" || error.code === "TARGET_AMBIGUOUS" ||
        error.code === "READ_BACK_MISMATCH")
    ) {
      throw new HostEditError(error.code, {
        opIndex: 0,
        op: "insertMember",
        target: { qualifiedName: name },
      }, error.message);
    }
    throw error;
  }
}
/** An explicit recipient space needs a definition that declares it; systems
 * created before 4.8c keep the relative legacy form only. */
function recipientSpace(
  base: SourceRevision,
  policyType: ReturnType<typeof exact>,
  policy: { recipientExecutionSpaceId?: string },
) {
  if (policy.recipientExecutionSpaceId === undefined) return {};
  exact(base, `${policyType.qualifiedName}::recipientSpace`, "AttributeUsage");
  return { recipientSpace: policy.recipientExecutionSpaceId };
}

/** Build trusted declarations from bounded data; no caller-provided source text. */
async function operatorAuthorityDeclaration(
  base: SourceRevision,
  request: OperatorAuthorityRequest,
  flowReader: OperatorFlowReader,
) {
  const system = exact(base, request.systemName, "PartUsage");
  const id = `operator_${
    (await sha256(string(request.changeId, "change identity"))).slice(0, 24)
  }`;
  if (request.op === "publishOperatorCreationPolicy") {
    const policy = validateOperatorCreationPolicyRequest(request.policy);
    const policyType = exact(
      base,
      "AssemblyAuthority::OperatorCreationPolicy",
      "PartDefinition",
    );
    exact(base, `${policyType.qualifiedName}::mode`, "AttributeUsage");
    exact(base, `${request.systemName}::builder`);
    exact(base, `${request.systemName}::builderMandate`);
    exact(base, `${request.systemName}::owner::ownerMandate::rootAuthority`);
    const policyId = await requestedCreationPolicyId(request.changeId);
    const name = spellSysmlQualifiedName([policyId]);
    const values = {
      id: policyId,
      revision: 1,
      enabled: true,
      networkHosts: JSON.stringify(policy.networkHosts),
      maxChildren: policy.maxChildren,
      maxDelegationDepth: 0,
      mode: policy.mode,
    };
    return {
      owner: { qualifiedName: request.systemName },
      text: `part ${name} : ${policyType.qualifiedName} {\n${
        Object.entries(values).map(([key, value]) =>
          `attribute :>> ${key} = ${spelling(value)};`
        ).join("\n")
      }\n}\nbind ${name}.holder = builder;\nbind ${name}.mandate = builderMandate;\nbind ${name}.issuer = owner.ownerMandate.rootAuthority;`,
      expect: [
        {
          kind: "member" as const,
          qualifiedName: `${request.systemName}::${name}`,
          metaclass: "PartUsage",
        },
        ...Object.entries(values).map(([key, value]) => ({
          kind: "literal" as const,
          path: `${name}::${key}`,
          value,
        })),
      ],
      systemQualifiedName: request.systemName,
    };
  }
  if (request.op === "publishOperatorAuthorityPolicy") {
    const policy = validateOperatorAuthorityPolicyRequest(request.policy);
    const policyType = exact(
      base,
      "AssemblyAuthority::OperatorAuthorityPolicy",
      "PartDefinition",
    );
    exact(base, `${request.systemName}::builder`);
    exact(base, `${request.systemName}::builderMandate`);
    exact(base, `${request.systemName}::owner::ownerMandate::rootAuthority`);
    const name = spellSysmlQualifiedName([
      `operator-authority-${policy.policyId}-${
        policy.expectedPolicyRevision + 1
      }`,
    ]);
    const values = {
      id: policy.policyId,
      revision: policy.expectedPolicyRevision + 1,
      enabled: policy.enabled,
      recipients: JSON.stringify(policy.recipients),
      ...recipientSpace(base, policyType, policy),
      acts: JSON.stringify(policy.acts),
      networkHosts: JSON.stringify(policy.networkHosts),
      toolIds: JSON.stringify(policy.toolIds),
      maxDelegationDepth: policy.maxDelegationDepth,
    };
    return {
      owner: { qualifiedName: request.systemName },
      text: `part ${name} : ${policyType.qualifiedName} {\n${
        Object.entries(values).map(([key, value]) =>
          `attribute :>> ${key} = ${spelling(value)};`
        ).join("\n")
      }\n}\nbind ${name}.holder = builder;\nbind ${name}.mandate = builderMandate;\nbind ${name}.issuer = owner.ownerMandate.rootAuthority;`,
      expect: [
        {
          kind: "member" as const,
          qualifiedName: `${request.systemName}::${name}`,
          metaclass: "PartUsage",
        },
        ...Object.entries(values).map(([key, value]) => ({
          kind: "literal" as const,
          path: `${name}::${key}`,
          value,
        })),
      ],
      systemQualifiedName: request.systemName,
    };
  }
  if (request.op === "publishToolAdmissionPolicy") {
    const policy = validateToolAdmissionPolicyRequest(request.policy);
    const policyType = exact(
      base,
      "AssemblyAuthority::ToolAdmissionPolicy",
      "PartDefinition",
    );
    exact(base, `${request.systemName}::builder`);
    exact(base, `${request.systemName}::builderMandate`);
    exact(base, `${request.systemName}::owner::ownerMandate::rootAuthority`);
    const name = spellSysmlQualifiedName([
      `tool-admission-${policy.policyId}-${policy.expectedPolicyRevision + 1}`,
    ]);
    const values = {
      id: policy.policyId,
      revision: policy.expectedPolicyRevision + 1,
      enabled: policy.enabled,
      recipients: JSON.stringify(policy.recipients),
      ...recipientSpace(base, policyType, policy),
      toolKinds: JSON.stringify(policy.toolKinds),
      maxDelegationDepth: policy.maxDelegationDepth,
    };
    return {
      owner: { qualifiedName: request.systemName },
      text: `part ${name} : ${policyType.qualifiedName} {\n${
        Object.entries(values).map(([key, value]) =>
          `attribute :>> ${key} = ${spelling(value)};`
        ).join("\n")
      }\n}\nbind ${name}.holder = builder;\nbind ${name}.mandate = builderMandate;\nbind ${name}.issuer = owner.ownerMandate.rootAuthority;`,
      expect: [
        {
          kind: "member" as const,
          qualifiedName: `${request.systemName}::${name}`,
          metaclass: "PartUsage",
        },
        ...Object.entries(values).map(([key, value]) => ({
          kind: "literal" as const,
          path: `${name}::${key}`,
          value,
        })),
      ],
      systemQualifiedName: request.systemName,
    };
  }
  if (request.op === "grantModelEditing") {
    const grant = validateGrantModelEditing(request.grant);
    assertGrantModelEditingScope(
      grant,
      request.systemName,
      modelEditingAuthorityRoots(
        sourceSnapshot(base.elements, "root").elements,
      ),
    );
    parseModelEditOperations(JSON.stringify(grant.operations));
    requireValue(
      !grant.operations.some((op: string) => op === "replace-source"),
      "whole-source editing is excluded",
    );
    parseModelEditGrants(
      JSON.stringify([{ file: grant.file, qualifiedRoots: [grant.root] }]),
    );
    requireValue(
      Object.hasOwn(base.sources, grant.file),
      "grant file is absent",
    );
    const root = exact(base, grant.root);
    requireValue(
      modelToolingTarget(base, String(root["@id"])).source.path === grant.file,
      "grant root differs from file",
    );
    const definition = exact(
      base,
      "AssemblyModelEditing::ModelEditPolicy",
      "PartDefinition",
    );
    const snapshot = sourceSnapshot(base.elements, "root");
    const byId = new Map(
      snapshot.elements.map((element) => [element.id, element]),
    );
    requireValue(
      !snapshot.elements.some((element) => {
        if (!element.typeIds.includes(String(definition["@id"]))) return false;
        const seen = new Set<string>();
        let current = byId.get(element.ownerId);
        while (current && !seen.has(current.id)) {
          if (current.id === system["@id"]) return true;
          seen.add(current.id);
          current = byId.get(current.ownerId);
        }
        return false;
      }),
      "model editing policy already exists",
    );
    exact(base, `${request.systemName}::builder`);
    exact(base, `${request.systemName}::builderMandate`);
    exact(base, `${request.systemName}::owner::ownerMandate::rootAuthority`);
    const policy = `${request.systemName}::modelEditPolicy`;
    const text =
      `part modelEditPolicy : ${definition.qualifiedName} {\n attribute :>> id = ${
        spelling(id)
      };\n attribute :>> revision = 1;\n attribute :>> operations = ${
        spelling(JSON.stringify(grant.operations))
      };\n attribute :>> grants = ${
        spelling(
          JSON.stringify([{ file: grant.file, qualifiedRoots: [grant.root] }]),
        )
      };\n}\nbind modelEditPolicy.holder = builder;\nbind modelEditPolicy.mandate = builderMandate;\nbind modelEditPolicy.issuer = owner.ownerMandate.rootAuthority;`;
    return {
      owner: { qualifiedName: request.systemName },
      text,
      expect: [{
        kind: "member" as const,
        qualifiedName: policy,
        metaclass: "PartUsage",
      }],
      systemQualifiedName: request.systemName,
    };
  }
  requireValue(request.op === "createRequestOperator", "unsupported operation");
  const spec = validateOperatorCreationSpec(request.operator);
  string(request.name, "operator name");
  string(spec.instruction, "instruction");
  const team = isTeamOperatorSpec(spec);
  if (!team) string(spec.firstRequest.objective, "first objective");
  if (!team) string(spec.requestType.name, "Request type name");
  if (!team) {
    requireValue(
      Number.isSafeInteger(spec.requestType.maxInvocations) &&
        spec.requestType.maxInvocations >= 1 &&
        spec.requestType.maxInvocations <= 1000,
      "Request invocation ceiling",
    );
  }
  const hosts = team ? spec.provision.networkHosts : spec.networkHosts;
  validateNetworkScope({ allowedHosts: hosts });
  const parts = parseSysmlQualifiedName(request.systemName)!;
  const parentName = spellSysmlQualifiedName(parts.slice(0, -1));
  exact(base, parentName, "Package");
  const systemQualifiedName = await requestOperatorSystemName(
    request.systemName,
    request.changeId,
  );
  let existing;
  try {
    existing = exact(base, systemQualifiedName);
  } catch (error) {
    if (!(error instanceof HostEditError && error.code === "TARGET_MISSING")) {
      throw error;
    }
  }
  requireValue(!existing, "operator already exists");
  const substitutions: Record<string, string> = {
    SYSTEM: id,
    ID: spelling(id),
    NAME: spelling(request.name),
    INSTRUCTION: spelling(spec.instruction),
    HOSTS: spelling(JSON.stringify(hosts)),
    MAY_PROPOSE_SYSML_REVISION: String(
      team && spec.provision.mayProposeSysmlRevision === true,
    ),
    ...(team ? {} : {
      OBJECTIVE: spelling(spec.firstRequest.objective),
      REQUEST: spellSysmlQualifiedName([spec.requestType.name]),
      CEILING: String(spec.requestType.maxInvocations),
    }),
  };
  const declarations: string[] = [];
  if (team) {
    requireValue(
      typeof request.creatorMayAddNetworkHosts === "boolean",
      "team creation requires the creator's modeled network proposal ceiling",
    );
    requireValue(
      request.teamOrigin && request.parentOperatorId,
      "team creation requires exact parent and originating Request",
    );
    requireValue(
      !spec.provision.mayAddNetworkHosts || request.creatorMayAddNetworkHosts,
      "team network proposal exceeds the creator ceiling",
    );
    // The provision was validated closed above; the writer states it, it
    // never re-derives it from the creator.
    const limits = spec.provision.budget;
    string(request.teamOrigin.operatorId, "originating operator");
    string(request.teamOrigin.requestId, "originating Request");
    string(request.parentOperatorId, "creation parent");
    declarations.push(
      `attribute creationParentOperatorId : String = ${
        spelling(request.parentOperatorId)
      };`,
      `attribute originatingRequestOperatorId : String = ${
        spelling(request.teamOrigin.operatorId)
      };`,
      `attribute originatingRequestId : String = ${
        spelling(request.teamOrigin.requestId)
      };`,
      ...(request.creationPolicy
        ? [
          `attribute creationPolicyId : String = ${
            spelling(request.creationPolicy.id)
          };`,
        ]
        : []),
    );
    substitutions.MAX_DECISIONS = String(limits.maxAgentDecisions);
    substitutions.MAX_PROPOSALS = String(limits.maxToolProposals);
    substitutions.MAX_STEPS = String(limits.maxFlowSteps);
    substitutions.MAY_PROPOSE_READ_WEB_PAGE = String(
      spec.provision.mayPropose.includes("read_web_page"),
    );
    substitutions.MAY_PROPOSE_READ_WEB_PAGE_OUTLINE = String(
      spec.provision.mayPropose.includes("read_web_page_outline"),
    );
    substitutions.MAY_INVOKE_ACTIVE_CATALOG = String(
      spec.provision.mayInvokeActiveCatalog,
    );
  }
  if (!team) {
    requireValue(
      !request.creationPolicy && !request.teamOrigin,
      "an independent operator receives only an explicit initial human grant",
    );
  }
  if (spec.creationGrant) {
    const policyType = exact(
      base,
      "AssemblyAuthority::OperatorCreationPolicy",
      "PartDefinition",
    );
    const grant = spec.creationGrant;
    // A persisted pre-4.8e definition declares no mode; an explicit mode is
    // refused there instead of being silently dropped (TARGET_MISSING, as
    // for recipientSpace above).
    if (grant.mode !== undefined) {
      exact(base, `${policyType.qualifiedName}::mode`, "AttributeUsage");
    }
    declarations.push(`part creationPolicy : ${policyType.qualifiedName} {
        attribute :>> id = ${spelling(`${id}-creation`)};
        attribute :>> revision = 1;
        attribute :>> enabled = true;
        attribute :>> networkHosts = ${
      spelling(JSON.stringify(grant.networkHosts))
    };
        attribute :>> maxChildren = ${grant.maxChildren};
        attribute :>> maxDelegationDepth = ${grant.maxDelegationDepth};${
      grant.mode === undefined
        ? ""
        : `\n        attribute :>> mode = ${spelling(grant.mode)};`
    }
      }
      bind creationPolicy.holder = builder;
      bind creationPolicy.mandate = builderMandate;
      bind creationPolicy.issuer = owner.ownerMandate.rootAuthority;`);
    if (request.creationPolicy) {
      const parentPolicy = sourceSnapshot(
        base.elements,
        "operator-authority-writer",
      ).elements.find((element) =>
        element.id === request.creationPolicy!.elementId
      );
      requireValue(parentPolicy, "exact parent creation policy");
      const parentSystem = sourceSnapshot(
        base.elements,
        "operator-authority-writer",
      ).elements.find((element) => element.id === parentPolicy.ownerId);
      requireValue(parentSystem, "exact parent creation system");
      declarations.push(
        `bind creationPolicy.parent = ${parentSystem.qualifiedName}.${
          spellSysmlQualifiedName([parentPolicy.name])
        };`,
      );
    }
  }
  substitutions.TEAM_DECLARATIONS = declarations.join("\n");
  const baseTemplate = team
    ? teamOperatorTemplate(spec.provision.mayAddNetworkHosts ?? false)
    : spec.creationGrant
    ? REQUEST_OPERATOR_TEMPLATE.replace(/\n}$/, "\n__TEAM_DECLARATIONS__\n}")
    : REQUEST_OPERATOR_TEMPLATE;
  const snapshot = sourceSnapshot(base.elements, "operator-template-writer");
  const selectionDeclared = snapshot.elements.some((element) =>
    element.ownerId === system["@id"] &&
    (element.name === "operatorFlowTemplate" ||
      element.name === "operatorFlowTemplateRevision")
  );
  requireValue(
    selectionDeclared,
    "operator creation requires the creator's explicit admitted native flow template",
  );
  // Match the existing sourceModelIdentity registration contract. A view
  // warning is not a substitute for rejecting unsupported creator identities.
  requireValue(
    /^[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)+$/.test(
      request.systemName,
    ),
    "unsupported native conversation system qualified name",
  );
  const executionPolicyType = exact(
    base,
    "AssemblyExecution::ExecutionPolicy",
    "ItemDefinition",
  );
  const readFeatureDeclared = snapshot.elements.some((element) =>
    element.ownerId === executionPolicyType["@id"] &&
    element.name === "mayConsultModel" &&
    element.metaclass === "AttributeUsage"
  );
  const read = String(team ? spec.provision.mayConsultModel === true : true);
  requireValue(
    baseTemplate.split("__MODEL_READ_DECLARATION__").length === 2,
    "the model-read declaration placeholder must occur exactly once",
  );
  substitutions.MODEL_READ_DECLARATION = readFeatureDeclared
    ? `attribute :>> mayConsultModel = ${read};`
    : `attribute mayConsultModel : Boolean = ${read};`;
  let selectedTemplate: string;
  {
    const literals = sourceLiterals(base.elements);
    const identity = {
      projectId: "operator-template-writer",
      editingContextId: base.version,
      rootId: snapshot.rootId,
      systemId: String(system["@id"]),
      builderId: String(exact(base, `${request.systemName}::builder`)["@id"]),
      catalogId: String(exact(base, `${request.systemName}::catalog`)["@id"]),
    };
    const graph = projectSourceGraph(base.elements, identity);
    requireValue(
      !(graph.executionDiagnostics ?? graph.diagnostics)?.length,
      "future operator template native graph",
    );
    const { selected, revision } = flowReader.select(
      snapshot,
      graph,
      literals,
      identity.systemId,
      base.elements,
    );
    requireValue(
      String(selected.revision) === revision.value,
      "future operator template revision",
    );
    requireValue(
      !spec.flowTemplate ||
        spec.flowTemplate.qualifiedName === selected.definition.qualifiedName &&
          spec.flowTemplate.revision === selected.revision,
      "requested template must equal the creator's exact admitted selection",
    );
    const allocations = selected.flow.nodes.filter((node) =>
      node.kind === "action"
    ).map((node) => {
      const actor = flowReader.performer(node.mechanism!);
      requireValue(actor, "supported future template primitive performer");
      return `        allocate conversation.${node.name} to ${actor};`;
    }).join("\n");
    substitutions.FLOW_TYPE = selected.definition.qualifiedName;
    substitutions.FLOW_REVISION = String(selected.revision);
    substitutions.FLOW_ALLOCATIONS = allocations;
    selectedTemplate = baseTemplate.replace(
      "perform action conversation : ConsultingConversationV1 {",
      "perform action conversation : __FLOW_TYPE__ {",
    )
      .replace(
        "perform action operatorFlowTemplate : ConsultingConversationV1;",
        "perform action operatorFlowTemplate : __FLOW_TYPE__;",
      )
      .replace(
        / {8}allocate conversation\.readCaseState to admissionGate;[\s\S]*? {8}allocate conversation\.observeOutcome to admissionGate;/,
        "__FLOW_ALLOCATIONS__",
      );
  }
  const template = selectedTemplate
    .replace(
      /\bAssembly(?:Core|Authority|Cases|Work)(?=::)/g,
      (name) => productNameInModel(base.elements, name),
    );
  const partsOfTemplate = template.split("__");
  requireValue(
    partsOfTemplate.length % 2 === 1,
    "closed operator template placeholders",
  );
  const text = partsOfTemplate.map((part, index) => {
    if (index % 2 === 0) return part;
    requireValue(
      Object.hasOwn(substitutions, part),
      `operator template placeholder ${part}`,
    );
    return substitutions[part]!;
  }).join("");
  return {
    owner: { qualifiedName: parentName },
    text,
    expect: [
      {
        kind: "member" as const,
        qualifiedName: systemQualifiedName,
        metaclass: "PartUsage",
      },
      ...(team ? [] : [{
        kind: "member" as const,
        qualifiedName: `${systemQualifiedName}::${
          spellSysmlQualifiedName([spec.requestType.name])
        }`,
        metaclass: "PartUsage",
      }]),
    ],
    systemQualifiedName,
  };
}

/** Declare bounded authority changes for the shared host editing pipeline. */
export async function operatorAuthorityRequests(
  base: SourceRevision,
  request: OperatorAuthorityRequest,
  flowReader: OperatorFlowReader,
): Promise<{
  requests: HostEditRequest[];
  systemQualifiedName: string;
}> {
  const declaration = await operatorAuthorityDeclaration(
    base,
    request,
    flowReader,
  );
  const accessRequests: HostEditRequest[] = [];
  if (
    request.op === "createRequestOperator" &&
    isTeamOperatorSpec(request.operator)
  ) {
    const accessType = exact(
      base,
      "AssemblyInvocations::BehaviorAccess",
      "PartDefinition",
    );
    const inputType = exact(
      base,
      "AssemblyWork::WorkRequest",
      "ItemDefinition",
    );
    exact(base, "AssemblyWork::AgentInbox", "ActionDefinition");
    const accessName = `teamAccess_${
      (await sha256(request.changeId)).slice(0, 24)
    }`;
    accessRequests.push({
      op: "insertMember",
      intent: "authority",
      owner: { qualifiedName: request.systemName },
      text: `part ${accessName} : ${accessType.qualifiedName} {
        attribute :>> name = ${
        spelling(
          `ContributeTo_${(await sha256(request.changeId)).slice(0, 24)}`,
        )
      };
        attribute :>> description = ${
        spelling(
          `Contribute bounded work to ${request.name} within the originating Request.`,
        )
      };
        attribute :>> enabled = true;
        ref item :>> input : ${inputType.qualifiedName};
      }
      bind ${accessName}.caller = builder;
      bind ${accessName}.target = ${declaration.systemQualifiedName}.inbox;`,
      expect: [{
        kind: "member",
        qualifiedName: `${request.systemName}::${accessName}`,
        metaclass: "PartUsage",
      }],
    });
  }
  return {
    requests: [{
      op: "insertMember",
      intent: "authority",
      owner: declaration.owner,
      text: declaration.text,
      expect: declaration.expect,
    }, ...accessRequests],
    systemQualifiedName: declaration.systemQualifiedName,
  };
}
