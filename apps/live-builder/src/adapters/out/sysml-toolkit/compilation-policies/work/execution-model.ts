import {
  type ModelRightField,
  ModelRightsError,
} from "../../../../../domain/model/consultation/model-read-policy.ts";
import { persistedOrder } from "../../../../../domain/primitives/persisted-order.ts";
import {
  compileSelectedOperatorFlow,
  flowLiteral,
  operatorFlowSemantics,
  selectedFlowRoot,
} from "./operator-flow.ts";
import { compileOperatorCreationPolicies } from "../governance/authority/operator/creation-policy.ts";
import { compileToolAdmissionPolicies } from "../governance/authority/tool-admission-policy.ts";
import { sameProductName } from "../../../../../domain/model/sysml-product-names.ts";
import { compileOperatorAuthorityPolicies } from "../governance/authority/operator/policy.ts";
import { isNamespacePartOccurrence } from "../../../../../domain/model/policies/model-occurrence.ts";
import { executionDigest } from "../../../../../domain/primitives/execution-digest.ts";
import { compileOwnerAuthority } from "../governance/authority/owner-authority.ts";
import type { OwnerAuthority } from "../../../../../domain/governance/authority.ts";
import type { NativeCaseType } from "../../../../../domain/work/records/case-types.ts";
import { CaseError } from "../../../../../domain/work/errors/case.ts";
/** Compile authority from native typed SysML facts. No host configuration input. */
import type {
  ElementRecord,
  ModelSnapshot,
} from "../../../../../domain/model/records/snapshot.ts";
import type {
  ExecutableModel,
  ExecutionPolicy,
} from "../../../../../domain/model/execution/executable-model.ts";
import {
  type CompiledFlow,
  compileModelFlow,
  type FlowProjection,
} from "../../../../../domain/model/execution/flow.ts";
import { validateNetworkScope } from "../../../../../domain/governance/policies/network-policy.ts";
import { type ModelIdentity } from "../../../../../domain/work/dialogue.ts";
import {
  type SystemConfiguration,
} from "../../../../../domain/governance/records/system-configuration.ts";
import {
  TOOL_KINDS,
  type ToolKind,
} from "../../../../../domain/shared-kernel/tool-kind.ts";

export interface NativeLiteral {
  owner: string;
  name: string;
  attributeId: string;
  literalId: string;
  kind: string;
  value: string;
  typeIds: string[];
  typeNames: string[];
}
export interface NativeMandate {
  nativeId: string;
  holderNativeId: string;
  id: string;
  version: number;
  mayPropose: ToolKind[];
  mayInvokeActiveCatalog: boolean;
  mayReviewExactCandidate: boolean;
  mayAdmit: boolean;
  /** The `open-request` act (4.8d D3, settled Q1); absent when not granted,
   * so models without the optional attribute keep their digest. */
  mayOpenRequests?: true;
  sourceIds: string[];
}
export interface NativeCapability {
  nativeId: string;
  contractId: string;
  candidateId: string;
  name: string;
  kind: ToolKind;
  digest: string;
  status: string;
  sourceIds: string[];
}
export interface NativePolicy {
  maxAgentDecisions: number;
  maxToolProposals: number;
  maxFlowSteps: number;
  urlSelectionMode: "user-provided" | "authorized-host";
  mayAddNetworkHosts: boolean;
  mayDelegateOwnAdmission: boolean;
  mayCreateReviewer: boolean;
  mayChangeUrlSelection: boolean;
  mayConsultModel?: boolean;
  mayProposeSysmlRevision?: boolean;
}
export interface NativeAuthority {
  ownerAuthority: OwnerAuthority;
  identity: ModelIdentity;
  operator?: ExecutableModel["operator"];
  configuration: SystemConfiguration;
  builderMandate: NativeMandate;
  reviewerMandate?: NativeMandate;
  policy: NativePolicy;
  capabilities: NativeCapability[];
  contracts: ExecutableModel["contracts"];
  sourceIds: string[];
}
/** The modeled primary contact; the default designer when no system declares one. */
export function isPrimaryDesigner(
  native: Pick<NativeAuthority, "operator">,
  systemQualifiedName: string | undefined,
  literals: readonly NativeLiteral[],
): boolean {
  return native.operator?.primary ??
    (sameProductName(
      systemQualifiedName ?? "ASELiveBuilder::liveBuilder",
      "AssemblyLiveBuilder::liveBuilder",
    ) &&
      !literals.some((l) =>
        l.name === "primaryContact" && l.kind === "LiteralBoolean" &&
        l.value === "true"
      ));
}
const rights = [
  "mayProposeReadWebPage",
  "mayProposeReadWebPageOutline",
  "mayInvokeActiveCatalog",
  "mayReviewExactCandidate",
  "mayAdmit",
  "mayActivate",
  "mayChangeOwnMandate",
  "mayCreateAgents",
] as const;
export function compileNativeAuthority(
  snapshot: ModelSnapshot,
  literals: NativeLiteral[],
  identity: ModelIdentity,
  caseTypes: readonly NativeCaseType[] = [],
): NativeAuthority {
  const literalIds = new Set<string>();
  for (const literal of literals) {
    if (!literal.literalId || literalIds.has(literal.literalId)) {
      throw new Error("Ambiguous native literal identity");
    }
    literalIds.add(literal.literalId);
  }
  const sources = new Set<string>();
  const ownerAuthority = compileOwnerAuthority(
    snapshot,
    literals,
    identity.systemId,
  );
  if (ownerAuthority.ownerSource === "modeled") {
    for (const id of ownerAuthority.sourceIds) sources.add(id);
  }
  const byId = new Map(snapshot.elements.map((e) => [e.id, e]));
  if (byId.size !== snapshot.elements.length) {
    throw new Error("Duplicate native element identity");
  }
  const one = (
    name: string,
    metaclass: string,
    owner?: string,
  ): ElementRecord => {
    const matches = snapshot.elements.filter((e) =>
      e.name === name && e.metaclass === metaclass &&
      (owner === undefined || e.ownerId === owner)
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one native ${metaclass} ${name}`);
    }
    sources.add(matches[0]!.id);
    return matches[0]!;
  };
  const instance = (
    name: string,
    metaclass: string,
    owner: string,
    typeName: string,
    typeMetaclass: string,
  ) => {
    const e = one(name, metaclass, owner), t = one(typeName, typeMetaclass);
    if (e.typeIds.length !== 1 || e.typeIds[0] !== t.id) {
      throw new Error(`Invalid native typing ${name}`);
    }
    return e;
  };
  const field = (
    owner: string,
    name: string,
    scalar: "String" | "Boolean" | "Integer",
  ) => {
    const attribute = one(name, "AttributeUsage", owner);
    const matches = literals.filter((v) =>
      v.owner === owner && v.name === name
    );
    if (matches.length !== 1) {
      throw new Error(`Expected one native literal ${name}`);
    }
    const v = matches[0]!;
    if (
      v.attributeId !== attribute.id || !v.literalId ||
      v.kind !== `Literal${scalar}` || v.typeIds.length !== 1 ||
      v.typeNames.length !== 1 ||
      !(v.typeNames[0] === `ScalarValues::${scalar}` ||
        v.typeNames[0]!.endsWith(`::ScalarValues::${scalar}`)) ||
      attribute.typeIds.length !== 1 || attribute.typeIds[0] !== v.typeIds[0]
    ) throw new Error(`Invalid typed native literal ${name}`);
    sources.add(v.literalId);
    sources.add(v.typeIds[0]!);
    return v;
  };
  const string = (owner: string, name: string) =>
    field(owner, name, "String").value;
  const bool = (owner: string, name: string) => {
    const value = field(owner, name, "Boolean").value;
    if (value !== "true" && value !== "false") {
      throw new Error(`Invalid native Boolean ${name}`);
    }
    return value === "true";
  };
  const optionalNativeBool = (owner: ElementRecord, name: ModelRightField) => {
    const owners = new Set([owner.id, ...owner.typeIds]);
    const declared =
      snapshot.elements.some((element) =>
        element.name === name && owners.has(element.ownerId)
      ) || literals.some((literal) =>
        literal.name === name && owners.has(literal.owner)
      );
    if (!declared) return undefined;
    try {
      return bool(owner.id, name);
    } catch (error) {
      throw new ModelRightsError(
        name === "mayConsultModel"
          ? "MODEL_READ_POLICY_INVALID"
          : "MODEL_REVISION_POLICY_INVALID",
        error instanceof Error ? error.message : String(error),
        { field: name },
        `Declare ${name} as one explicit native Boolean on the execution policy and compile a new revision.`,
      );
    }
  };
  const integer = (
    owner: string,
    name: string,
    minimum: number,
    scalar: "String" | "Integer" = "String",
  ) => {
    const value = field(owner, name, scalar).value;
    if (
      !/^(0|[1-9][0-9]*)$/.test(value) ||
      !Number.isSafeInteger(Number(value)) || Number(value) < minimum
    ) throw new Error(`Invalid native Integer ${name}`);
    return Number(value);
  };
  const namespaceOccurrence = (element: ElementRecord) =>
    isNamespacePartOccurrence(element, byId.get(element.ownerId));
  const systemElement = byId.get(identity.systemId);
  if (
    !systemElement || systemElement.metaclass !== "PartUsage" ||
    (systemElement.isReference && !namespaceOccurrence(systemElement))
  ) {
    throw new Error("Missing concrete native conversation system");
  }
  const systemOwner = byId.get(systemElement.ownerId);
  if (!systemOwner || /Definition$/.test(systemOwner.metaclass)) {
    throw new Error("Native conversation system is not a concrete occurrence");
  }
  // Retain the same package/source evidence for the original single-unit model.
  let packageOwner = systemOwner;
  const ancestors = new Set<string>();
  while (!/^(Library)?Package$/.test(packageOwner.metaclass)) {
    if (
      ancestors.has(packageOwner.id) ||
      /Definition$/.test(packageOwner.metaclass)
    ) {
      throw new Error(
        "Native conversation system has no concrete package context",
      );
    }
    ancestors.add(packageOwner.id);
    const parent = byId.get(packageOwner.ownerId);
    if (!parent) throw new Error("Missing native conversation owner");
    packageOwner = parent;
  }
  sources.add(packageOwner.id);
  const systemType = one("ConversationSystem", "PartDefinition");
  const system = instance(
    systemElement.name,
    "PartUsage",
    systemElement.ownerId,
    "ConversationSystem",
    "PartDefinition",
  );
  // Other actual units retain their own policies/contracts. Orphaned or misplaced
  // authority outside any concrete conversation unit is still rejected.
  const anotherUnit = (element: ElementRecord): boolean => {
    const seen = new Set<string>();
    let current: ElementRecord | undefined = element;
    while (current && !seen.has(current.id)) {
      if (
        current.metaclass === "PartUsage" &&
        (!current.isReference || namespaceOccurrence(current)) &&
        current.typeIds.length === 1 && current.typeIds[0] === systemType.id
      ) {
        return current.id !== system.id;
      }
      if (/Definition$/.test(current.metaclass)) return false;
      seen.add(current.id);
      current = byId.get(current.ownerId);
    }
    return false;
  };
  if (system.id !== identity.systemId) {
    throw new Error("Native system identity changed");
  }
  const builder = instance(
    "builder",
    "PartUsage",
    system.id,
    "ConversationBuilder",
    "PartDefinition",
  );
  const catalog = instance(
    "catalog",
    "PartUsage",
    system.id,
    "ToolCatalog",
    "PartDefinition",
  );
  if (builder.id !== identity.builderId || catalog.id !== identity.catalogId) {
    throw new Error("Native operator/catalog identity changed");
  }
  const mandateType = one("ConfiguredMandate", "ItemDefinition");
  const operatorType = one("SoftwareOperator", "PartDefinition");
  const isOperator = (
    definitionId: string,
    seen = new Set<string>(),
  ): boolean => {
    if (definitionId === operatorType.id) return true;
    if (seen.has(definitionId)) return false;
    seen.add(definitionId);
    return byId.get(definitionId)?.generalIds.some((id) =>
      isOperator(id, seen)
    ) ?? false;
  };
  if (!isOperator(builder.typeIds[0]!)) {
    throw new Error("Native builder is not a software operator");
  }
  const mandateFeature = one("mandate", "ItemUsage", operatorType.id);
  const holderFeature = one("holder", "ReferenceUsage", mandateType.id);
  const equal = (a: string[], b: string[]) =>
    a.length === b.length && a.every((v, i) => v === b[i]);
  const mandate = (name: string, holder: string): NativeMandate => {
    const m = instance(
      name,
      "ItemUsage",
      system.id,
      "ConfiguredMandate",
      "ItemDefinition",
    );
    const ownSources = new Set<string>([m.id, holder]);
    for (
      const [left, right] of [[[holder, mandateFeature.id], [m.id]], [[
        m.id,
        holderFeature.id,
      ], [holder]]]
    ) {
      const matches = snapshot.connectors.filter((c) =>
        c.ownerId === system.id && c.metaclass === "BindingConnectorAsUsage" &&
        c.ends.length === 2 && (equal(
              c.ends[0]!.chain.map((e) => e.id),
              left!,
            ) && equal(c.ends[1]!.chain.map((e) => e.id), right!) ||
          equal(c.ends[1]!.chain.map((e) => e.id), left!) &&
            equal(c.ends[0]!.chain.map((e) => e.id), right!))
      );
      if (matches.length !== 1) {
        throw new Error(`Invalid native holder binding ${name}`);
      }
      ownSources.add(matches[0]!.id);
      sources.add(matches[0]!.id);
    }
    const values = Object.fromEntries(
      rights.map((key) => [key, bool(m.id, key)]),
    ) as Record<typeof rights[number], boolean>;
    if (
      values.mayActivate || values.mayChangeOwnMandate || values.mayCreateAgents
    ) throw new Error(`Unsupported native authority ${name}`);
    for (const v of literals.filter((v) => v.owner === m.id)) {
      ownSources.add(v.attributeId);
      ownSources.add(v.literalId);
    }
    const id = string(m.id, "id"), version = integer(m.id, "version", 1);
    if (!id) throw new Error("Empty native mandate identity");
    // Optional act: a library without the attribute grants nothing.
    const mayOpenRequests =
      literals.some((v) => v.owner === m.id && v.name === "mayOpenRequests") &&
      bool(m.id, "mayOpenRequests");
    return {
      nativeId: m.id,
      holderNativeId: holder,
      id,
      version,
      mayPropose: [
        ...(values.mayProposeReadWebPage ? ["read_web_page" as const] : []),
        ...(values.mayProposeReadWebPageOutline
          ? ["read_web_page_outline" as const]
          : []),
      ],
      mayInvokeActiveCatalog: values.mayInvokeActiveCatalog,
      mayReviewExactCandidate: values.mayReviewExactCandidate,
      mayAdmit: values.mayAdmit,
      ...(mayOpenRequests ? { mayOpenRequests: true as const } : {}),
      sourceIds: [...ownSources].sort(),
    };
  };
  const builderMandate = mandate("builderMandate", builder.id);
  const admissionMode = string(system.id, "admissionMode");
  if (
    !["human", "builder", "reviewer"].includes(admissionMode) ||
    builderMandate.mayAdmit !== (admissionMode === "builder") ||
    builderMandate.mayReviewExactCandidate
  ) throw new Error("Contradictory native admission authority");
  const reviewers = snapshot.elements.filter((e) =>
    e.ownerId === system.id &&
    (e.name === "reviewer" || e.name === "reviewerMandate")
  );
  let reviewerMandate: NativeMandate | undefined;
  let reviewer: SystemConfiguration["reviewer"];
  let reviewerId: string | undefined;
  if (reviewers.length) {
    const r = instance(
      "reviewer",
      "PartUsage",
      system.id,
      "IndependentReviewer",
      "PartDefinition",
    );
    reviewerId = r.id;
    if (!isOperator(r.typeIds[0]!)) {
      throw new Error("Native reviewer is not a software operator");
    }
    if (identity.reviewerId && identity.reviewerId !== r.id) {
      throw new Error("Native reviewer identity changed");
    }
    reviewerMandate = mandate("reviewerMandate", r.id);
    if (
      !reviewerMandate.mayReviewExactCandidate || !reviewerMandate.mayAdmit ||
      reviewerMandate.mayPropose.length ||
      reviewerMandate.mayInvokeActiveCatalog || admissionMode !== "reviewer"
    ) throw new Error("Contradictory native reviewer authority");
    const id = string(r.id, "operatorId"),
      name = string(r.id, "configuredName");
    if (!id || !name.trim()) {
      throw new Error("Invalid native reviewer metadata");
    }
    reviewer = { id, name, mandateRevision: reviewerMandate.version };
  } else if (admissionMode === "reviewer" || identity.reviewerId) {
    throw new Error("Native reviewer missing");
  }
  const id = string(system.id, "configurationId");
  if (!id) throw new Error("Empty native configuration identity");
  // Legacy envelope fields remain authoritative when present. Explicit case
  // declarations may replace all three, while the central phase-1 conversation
  // retains its existing 1.3 configuration shape.
  const explicitCasesOnly = caseTypes.length > 0 &&
    !snapshot.elements.some((element) =>
      element.ownerId === system.id &&
      ["envelopeKind", "envelopePattern", "envelopeRevision"].includes(
        element.name,
      )
    );
  const kind = explicitCasesOnly
      ? "conversational-case-management"
      : string(system.id, "envelopeKind"),
    pattern = explicitCasesOnly ? "1.3" : string(system.id, "envelopePattern"),
    envelopeRevision = explicitCasesOnly
      ? 1
      : integer(system.id, "envelopeRevision", 1);
  if (
    kind !== "conversational-case-management" || pattern !== "1.3" ||
    envelopeRevision !== 1
  ) throw new Error("Unsupported native process envelope");
  let hosts: unknown;
  try {
    hosts = JSON.parse(string(system.id, "networkHosts"));
  } catch {
    throw new Error("Invalid native network hosts");
  }
  const network = validateNetworkScope({ allowedHosts: hosts });
  const configuration: SystemConfiguration = {
    id,
    revision: integer(system.id, "configurationRevision", 0),
    envelope: { kind, pattern, revision: envelopeRevision },
    network,
    builder: {
      id: "builder",
      mandateRevision: builderMandate.version,
      admissionAuthority: admissionMode as "human" | "builder" | "reviewer",
    },
    ...(reviewer ? { reviewer } : {}),
    changes: [],
  };
  const { root: conversation, definition: conversationDefinition } =
    selectedFlowRoot(snapshot, system.id, "conversation");
  sources.add(conversation.id);
  sources.add(conversationDefinition.id);
  const p = instance(
    "executionPolicy",
    "ItemUsage",
    conversation.id,
    "ExecutionPolicy",
    "ItemDefinition",
  );
  if (
    snapshot.elements.some((e) =>
      e.metaclass === "ItemUsage" && e.name === "executionPolicy" &&
      e.id !== p.id && !anotherUnit(e)
    )
  ) {
    throw new Error("Ambiguous or misplaced native execution policy");
  }
  const revision = optionalNativeBool(p, "mayProposeSysmlRevision");
  if (revision === undefined) {
    throw new ModelRightsError(
      "MODEL_REVISION_POLICY_INVALID",
      "The native revision right must be declared explicitly",
      { field: "mayProposeSysmlRevision" },
      "Declare mayProposeSysmlRevision as one explicit native Boolean and compile a new revision.",
    );
  }
  const read = optionalNativeBool(p, "mayConsultModel");
  if (revision && read === false) {
    throw new ModelRightsError(
      "MODEL_READ_POLICY_INVALID",
      "Model revision authority requires model read authority",
      { field: "mayConsultModel" },
      "Grant mayConsultModel with revision authority, or remove mayProposeSysmlRevision, and compile a new revision.",
    );
  }
  const policy: NativePolicy = {
    maxAgentDecisions: integer(p.id, "maxAgentDecisions", 1, "Integer"),
    maxToolProposals: integer(p.id, "maxToolProposals", 0, "Integer"),
    maxFlowSteps: integer(p.id, "maxFlowSteps", 1, "Integer"),
    urlSelectionMode: string(
      p.id,
      "urlSelectionMode",
    ) as NativePolicy["urlSelectionMode"],
    mayAddNetworkHosts: bool(p.id, "mayAddNetworkHosts"),
    mayDelegateOwnAdmission: bool(p.id, "mayDelegateOwnAdmission"),
    mayCreateReviewer: bool(p.id, "mayCreateReviewer"),
    mayChangeUrlSelection: bool(p.id, "mayChangeUrlSelection"),
    mayProposeSysmlRevision: revision,
    // Historical pins omit the read field and retain their original digest.
    ...(read === undefined ? {} : { mayConsultModel: read }),
  };
  if (!["user-provided", "authorized-host"].includes(policy.urlSelectionMode)) {
    throw new Error("Unsupported native URL selection mode");
  }
  const contractType = one("CapabilityContract", "ItemDefinition");
  const candidateType = one("ToolCandidate", "PartDefinition");
  const contractFeature = instance(
    "contract",
    "ItemUsage",
    candidateType.id,
    "CapabilityContract",
    "ItemDefinition",
  );
  if (!contractFeature.isReference) {
    throw new Error(
      "Invalid native candidate contract feature: reference required",
    );
  }
  const contracts: ExecutableModel["contracts"] = [];
  const contractOccurrences = snapshot.elements.filter((e) =>
    e.metaclass === "ItemUsage" && !e.isReference &&
    e.typeIds.includes(contractType.id) && !anotherUnit(e)
  );
  if (contractOccurrences.some((e) => e.ownerId !== catalog.id)) {
    throw new Error(
      "Invalid native capability contract owner: catalog required",
    );
  }
  for (
    const e of contractOccurrences
  ) {
    const t = one("CapabilityContract", "ItemDefinition");
    if (e.typeIds.length !== 1 || e.typeIds[0] !== t.id) {
      throw new Error("Invalid native contract typing");
    }
    sources.add(e.id);
    const kind = string(e.id, "kind"),
      module = string(e.id, "module"),
      criteria = string(e.id, "acceptanceCriteria").split("\n");
    if (
      !TOOL_KINDS.includes(kind as ToolKind) ||
      module !== "default({url,html}) => {title,text}" ||
      criteria.length === 0 || criteria.some((c) => !c.trim()) ||
      contracts.some((c) => c.kind === kind)
    ) throw new Error("Invalid native capability contract");
    contracts.push({
      nativeId: e.id,
      kind: kind as ToolKind,
      module,
      acceptanceCriteria: criteria,
    });
  }
  if (
    builderMandate.mayPropose.some((kind) =>
      !contracts.some((c) => c.kind === kind)
    )
  ) throw new Error("Native proposal right lacks capability contract");
  contracts.sort((a, b) => persistedOrder(a.kind, b.kind));
  const operatorFields = [
    "operatorName",
    "operatorInstruction",
    "primaryContact",
    "humanInputEnabled",
  ];
  const declaredOperatorFields = snapshot.elements.filter((element) =>
    element.ownerId === system.id && element.metaclass === "AttributeUsage" &&
    operatorFields.includes(element.name)
  );
  let operator: ExecutableModel["operator"];
  if (declaredOperatorFields.length) {
    if (
      declaredOperatorFields.length !== operatorFields.length ||
      new Set(declaredOperatorFields.map((element) => element.name)).size !==
        operatorFields.length
    ) {
      throw new Error("Incomplete native operator endpoint metadata");
    }
    operator = {
      name: string(system.id, "operatorName"),
      instruction: string(system.id, "operatorInstruction"),
      primary: bool(system.id, "primaryContact"),
      humanInput: bool(system.id, "humanInputEnabled"),
    };
    if (
      !operator.name.trim() || operator.name.length > 160 ||
      !operator.instruction.trim() || operator.instruction.length > 16000 ||
      operator.primary && !operator.humanInput
    ) {
      throw new Error("Invalid native operator endpoint metadata");
    }
  }
  const authoritySourceIds = [...sources].sort();
  const capabilities: NativeCapability[] = [];
  for (
    const e of snapshot.elements.filter((e) =>
      e.ownerId === catalog.id && e.metaclass === "PartUsage"
    )
  ) {
    const t = one("ToolCandidate", "PartDefinition");
    if (e.typeIds.length !== 1 || e.typeIds[0] !== t.id) {
      throw new Error("Invalid native capability typing");
    }
    const values = {
      candidateId: string(e.id, "candidateId"),
      name: string(e.id, "name"),
      kind: string(e.id, "kind"),
      digest: string(e.id, "digest"),
      // Historical status remains readable; new catalog entries are active by presence.
      status: snapshot.elements.some((field) =>
          field.ownerId === e.id && field.name === "status"
        )
        ? string(e.id, "status")
        : "active",
    };
    if (
      !values.candidateId || !values.name ||
      !TOOL_KINDS.includes(values.kind as ToolKind) ||
      !/^[0-9a-f]{64}$/.test(values.digest) ||
      ![
        "proposed",
        "testing",
        "reviewing",
        "awaiting-admission",
        "refused",
        "activating",
        "active",
        "failed",
      ].includes(values.status)
    ) {
      throw new Error("Invalid native catalog entry");
    }
    if (
      capabilities.some((c) =>
        c.candidateId === values.candidateId ||
        c.status === "active" && values.status === "active" &&
          c.name === values.name
      )
    ) {
      throw new Error("Ambiguous native catalog entry");
    }
    // Resolve the native reference; a matching kind alone cannot supply a contract.
    const bindings = snapshot.connectors.filter((c) =>
      c.ownerId === e.id && c.metaclass === "BindingConnectorAsUsage" &&
      c.ends.some((end) =>
        end.chain.some((segment) =>
          segment.id === contractFeature.id
        )
      )
    );
    if (bindings.length !== 1 || bindings[0]!.ends.length !== 2) {
      throw new Error("Missing or ambiguous native candidate contract binding");
    }
    const binding = bindings[0]!;
    const left = binding.ends[0]!.chain.map((segment) => segment.id);
    const right = binding.ends[1]!.chain.map((segment) => segment.id);
    const target = equal(left, [contractFeature.id])
      ? right
      : equal(right, [contractFeature.id])
      ? left
      : [];
    const systemPath: string[] = [system.id];
    let contextOwner = byId.get(system.ownerId);
    while (
      contextOwner && !/^(Library)?Package$/.test(contextOwner.metaclass)
    ) {
      systemPath.unshift(contextOwner.id);
      contextOwner = byId.get(contextOwner.ownerId);
    }
    const contract = contracts.find((contract) =>
      equal(target, [...systemPath, catalog.id, contract.nativeId])
    );
    if (!contract || contract.kind !== values.kind) {
      throw new Error("Invalid native candidate contract reference or kind");
    }
    capabilities.push({
      nativeId: e.id,
      contractId: contract.nativeId,
      ...values,
      kind: values.kind as ToolKind,
      sourceIds: [
        e.id,
        binding.id,
        contractFeature.id,
        ...target,
        ...literals.filter((v) => v.owner === e.id).flatMap(
          (v) => [v.attributeId, v.literalId],
        ),
      ].sort(),
    });
  }
  return {
    identity: { ...identity, ...(reviewerId ? { reviewerId } : {}) },
    ownerAuthority,
    ...(operator ? { operator } : {}),
    configuration,
    builderMandate,
    ...(reviewerMandate ? { reviewerMandate } : {}),
    policy,
    capabilities,
    contracts,
    sourceIds: authoritySourceIds,
  };
}

/** Compile the admitted native source into the bounded Assembly execution contract. */
export async function compileExecutableModel(
  snapshot: ModelSnapshot,
  graph: FlowProjection & { diagnostics?: string[] },
  literals: NativeLiteral[],
  identity: ModelIdentity,
  caseTypes: readonly NativeCaseType[] = [],
  captureDigestInput?: (evidence: Record<string, unknown>) => void,
  nativeActionBaseIds: ReadonlySet<string> = new Set(),
): Promise<ExecutableModel> {
  const native = compileNativeAuthority(
    snapshot,
    literals,
    identity,
    caseTypes,
  );
  if (graph.diagnostics?.length) {
    throw new Error(
      `Unresolved native execution graph: ${graph.diagnostics.join("; ")}`,
    );
  }
  const flowTypeIds: string[] = [];
  const flowRoot = (name: string, typeName: string) => {
    const roots = snapshot.elements.filter((e) =>
      e.ownerId === identity.systemId && e.name === name &&
      e.metaclass === "PerformActionUsage"
    );
    const types = snapshot.elements.filter((e) =>
      e.name === typeName && e.metaclass === "ActionDefinition"
    );
    if (
      roots.length !== 1 || types.length !== 1 ||
      roots[0]!.typeIds.length !== 1 || roots[0]!.typeIds[0] !== types[0]!.id
    ) throw new Error(`Unresolved native executable flow ${name}`);
    flowTypeIds.push(types[0]!.id);
    return roots[0]!.id;
  };
  const reviewed =
    native.configuration.builder.admissionAuthority === "reviewer";
  const selectedConversation = compileSelectedOperatorFlow(
    snapshot,
    graph,
    literals,
    identity.systemId,
    "conversation",
    native.policy.maxFlowSteps,
    nativeActionBaseIds,
  );
  flowTypeIds.push(...selectedConversation.sourceIds);
  const templateDeclarations = snapshot.elements.filter((element) =>
    element.ownerId === identity.systemId &&
    element.name === "operatorFlowTemplate"
  );
  const templateRevisions = snapshot.elements.filter((element) =>
    element.ownerId === identity.systemId &&
    element.name === "operatorFlowTemplateRevision"
  );
  let operatorFlowTemplate: ExecutableModel["operatorFlowTemplate"];
  if (templateDeclarations.length || templateRevisions.length) {
    const selected = compileSelectedOperatorFlow(
      snapshot,
      graph,
      literals,
      identity.systemId,
      "operatorFlowTemplate",
      native.policy.maxFlowSteps,
      nativeActionBaseIds,
    );
    const revision = flowLiteral(
      snapshot,
      literals,
      identity.systemId,
      "operatorFlowTemplateRevision",
      "Integer",
    );
    if (String(selected.revision) !== revision.value) {
      throw new Error("Native future operator template revision mismatch");
    }
    const selectedSourceIds = [
      ...new Set([
        ...selected.sourceIds,
        revision.attributeId,
        revision.literalId,
        ...revision.typeIds,
        selected.flow.rootNativeId,
        ...selected.flow.nodes.flatMap((
          node,
        ) => [
          node.nativeId,
          ...(node.typeNativeId ? [node.typeNativeId] : []),
          ...node.assertions.flatMap((
            assertion,
          ) => [assertion.nativeId, ...assertion.expressionSourceIds]),
        ]),
        ...selected.flow.edges.flatMap((
          edge,
        ) => [edge.nativeId, ...edge.guardIds]),
        ...selected.flow.bindings.map((binding) => binding.nativeId),
      ]),
    ].sort();
    operatorFlowTemplate = {
      qualifiedName: selected.definition.qualifiedName,
      revision: selected.revision!,
      typeNativeId: selected.definition.id,
      digest: await executionDigest(
        operatorFlowSemantics({ template: selected.flow }),
      ),
      sourceIds: selectedSourceIds,
    };
    flowTypeIds.push(...selectedSourceIds);
  }
  const flows = {
    conversation: selectedConversation.flow,
    promotion: compileModelFlow(graph, {
      rootNativeId: flowRoot(
        "promotion",
        reviewed ? "ReviewedCapabilityPromotion" : "CapabilityPromotion",
      ),
      maxSteps: native.policy.maxFlowSteps,
    }),
  };
  const caseFlows: Record<string, CompiledFlow> = {};
  const unsupportedOwner = caseTypes.find((type) =>
    type.schedule &&
    type.ownerId !== identity.builderId
  );
  if (unsupportedOwner) {
    throw new CaseError(
      "INVALID_CASE",
      "A scheduled Case owner must be the executable operator of its system",
      { caseTypeId: unsupportedOwner.id, ownerId: unsupportedOwner.ownerId },
      "Declare the Case in its owner's conversation system and reference that system's executable operator.",
    );
  }
  const scheduledTypes = caseTypes.filter((type) =>
    type.schedule &&
    type.type !== "request" && type.ownerId === identity.builderId &&
    type.behaviorId !== flows.conversation.rootNativeId
  );
  const caseFlowFailure = (type: NativeCaseType, cause: unknown) =>
    new CaseError(
      "INVALID_CASE",
      `The scheduled Case behavior is not executable: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      {
        caseTypeId: type.id,
        behaviorId: type.behaviorId,
        ownerId: type.ownerId,
      },
      "Declare a native behavior using supported conversation primitives, explicit successions and exact local performer allocations, then propose a corrected model revision.",
    );
  const conversationMechanisms = new Set([
    "read_case",
    "choose_move",
    "reply",
    "await_input",
    "check_invocation",
    "invoke_tool",
    "report_refusal",
    "submit_proposal",
    "observe_outcome",
  ]);
  for (const type of scheduledTypes) {
    if (Object.hasOwn(caseFlows, type.behaviorId)) continue;
    try {
      const root = snapshot.elements.find((element) =>
        element.id === type.behaviorId
      );
      if (
        !root || !["ActionUsage", "PerformActionUsage"].includes(root.metaclass)
      ) {
        throw new Error(
          "The behavior must identify a native action occurrence",
        );
      }
      const flow = compileModelFlow(graph, {
        rootNativeId: type.behaviorId,
        maxSteps: native.policy.maxFlowSteps,
      });
      if (
        flow.nodes.some((node) =>
          node.kind === "action" && !conversationMechanisms.has(node.mechanism!)
        )
      ) {
        throw new Error(
          "Only conversation primitives are supported in a scheduled behavior",
        );
      }
      flowTypeIds.push(...root.typeIds);
      caseFlows[type.behaviorId] = flow;
    } catch (cause) {
      throw caseFlowFailure(type, cause);
    }
  }
  const performerTypes: Record<string, string> = {
    read_case: "CatalogAdmissionGate",
    choose_move: "ConversationBuilder",
    reply: "ConversationBuilder",
    await_input: "CatalogAdmissionGate",
    check_invocation: "CatalogAdmissionGate",
    invoke_tool: "ToolCatalog",
    report_refusal: "CatalogAdmissionGate",
    submit_proposal: "CatalogAdmissionGate",
    observe_outcome: "CatalogAdmissionGate",
    consult_declared_source: "CatalogAdmissionGate",
    execute_operator_command: "CatalogAdmissionGate",
    propose_candidate: "ConversationBuilder",
    test_candidate: "CandidateTestSandbox",
    review_candidate: "IndependentReviewer",
    decide_admission: "CatalogAdmissionGate",
    activate_candidate: "ToolCatalog",
    refuse_candidate: "CatalogAdmissionGate",
  };
  for (const flow of [...Object.values(flows), ...Object.values(caseFlows)]) {
    try {
      for (const action of flow.nodes.filter((n) => n.kind === "action")) {
        const candidates = snapshot.connectors.filter((c) =>
          /Allocation/.test(c.metaclass) && c.ownerId === identity.systemId &&
          c.ends.length === 2
        ).flatMap((c) => {
          const matches = (chain: string[]) =>
            chain.length === 2 && chain[0] === flow.rootNativeId &&
              chain[1] === action.nativeId ||
            chain.length === 1 && chain[0] === action.nativeId;
          const a = c.ends[0]!.chain.map((s) => s.id),
            b = c.ends[1]!.chain.map((s) => s.id);
          return matches(a) && b.length === 1
            ? [{ allocation: c, actor: b[0]! }]
            : matches(b) && a.length === 1
            ? [{ allocation: c, actor: a[0]! }]
            : [];
        });
        if (candidates.length !== 1) {
          throw new Error(
            `Missing or ambiguous native primitive allocation: ${action.nativeId}`,
          );
        }
        const { allocation, actor } = candidates[0]!,
          target = snapshot.elements.find((e) => e.id === actor);
        const type = snapshot.elements.filter((e) =>
          e.name === performerTypes[action.mechanism!] &&
          e.metaclass === "PartDefinition"
        );
        if (
          !target || target.metaclass !== "PartUsage" ||
          target.ownerId !== identity.systemId || type.length !== 1 ||
          target.typeIds.length !== 1 || target.typeIds[0] !== type[0]!.id ||
          performerTypes[action.mechanism!] === "ConversationBuilder" &&
            actor !== identity.builderId ||
          action.mechanism === "review_candidate" &&
            (!reviewed || actor !== native.identity.reviewerId ||
              !native.reviewerMandate?.mayReviewExactCandidate ||
              !native.reviewerMandate.mayAdmit)
        ) {
          throw new Error(
            `Unsupported native primitive performer: ${action.nativeId}`,
          );
        }
        Object.assign(action, {
          performerId: actor,
          allocationId: allocation.id,
        });
      }
    } catch (cause) {
      const type = scheduledTypes.find((type) =>
        type.behaviorId === flow.rootNativeId
      );
      if (type) throw caseFlowFailure(type, cause);
      throw cause;
    }
  }
  const reviews = Object.values(flows).flatMap((flow) =>
    flow.nodes.filter((node) => node.mechanism === "review_candidate")
  );
  if (reviewed) {
    const promotion = flows.promotion;
    const oneAction = (mechanism: string) => {
      const matches = promotion.nodes.filter((node) =>
        node.mechanism === mechanism
      );
      if (matches.length !== 1) {
        throw new Error(
          `Expected one native reviewed promotion primitive: ${mechanism}`,
        );
      }
      return matches[0]!;
    };
    const propose = oneAction("propose_candidate"),
      test = oneAction("test_candidate"),
      review = oneAction("review_candidate"),
      admit = oneAction("decide_admission");
    const admissionTypes = snapshot.elements.filter((element) =>
      element.name === "ReviewedConfiguredAdmission" &&
      element.metaclass === "ActionDefinition"
    );
    if (
      reviews.length !== 1 || admissionTypes.length !== 1 ||
      admit.typeNativeId !== admissionTypes[0]!.id
    ) throw new Error("Invalid native explicit reviewed admission");
    // These bindings establish exact evidence identity. The model's successions
    // and guards remain responsible for deciding when each action is reached.
    for (
      const [from, output, to, input] of [
        [propose, "candidate", test, "candidate"],
        [propose, "candidate", review, "candidate"],
        [test, "result", review, "tests"],
        [propose, "candidate", admit, "candidate"],
        [test, "result", admit, "tests"],
        [review, "decision", admit, "review"],
      ] as const
    ) {
      const matches = promotion.bindings.filter((binding) =>
        binding.sourcePath.join(".") === `${from.name}.${output}` &&
        binding.targetPath.join(".") === `${to.name}.${input}`
      );
      if (matches.length !== 1) {
        throw new Error(
          `Invalid native reviewed evidence binding: ${from.name}.${output} -> ${to.name}.${input}`,
        );
      }
    }
  } else if (reviews.length) {
    throw new Error(
      "Native review primitive requires explicit reviewer authority",
    );
  }
  const allocations = snapshot.connectors.filter((c) =>
    /Allocation/.test(c.metaclass) && c.ownerId === identity.systemId
  ).map((c) => ({
    id: c.id,
    metaclass: c.metaclass,
    ownerId: c.ownerId,
    ends: c.ends.map((end) => end.chain.map((segment) => segment.id)),
  })).sort((a, b) => persistedOrder(a.id, b.id));
  const operatorCreationPolicies = compileOperatorCreationPolicies(
    snapshot,
    literals,
    identity,
  );
  const operatorAuthorityPolicies = compileOperatorAuthorityPolicies(
    snapshot,
    literals,
    identity,
  );
  const toolAdmissionPolicies = compileToolAdmissionPolicies(
    snapshot,
    literals,
    identity,
  );
  const sourceIds = [
    ...new Set([
      ...native.sourceIds,
      ...operatorCreationPolicies.flatMap((policy) => policy.sourceIds),
      ...toolAdmissionPolicies.flatMap((policy) => policy.sourceIds),
      ...operatorAuthorityPolicies.flatMap((policy) => policy.sourceIds),
      ...flowTypeIds,
      ...allocations.flatMap((a) => [a.id, ...a.ends.flat()]),
      ...[...Object.values(flows), ...Object.values(caseFlows)].flatMap(
        (flow) => [
          flow.rootNativeId,
          ...flow.nodes.flatMap(
            (
              n,
            ) => [
              n.nativeId,
              ...(n.typeNativeId ? [n.typeNativeId] : []),
              ...n.assertions.flatMap(
                (a) => [a.nativeId, ...a.expressionSourceIds],
              ),
            ],
          ),
          ...flow.edges.flatMap((e) => [e.nativeId, ...e.guardIds]),
          ...flow.bindings.map((b) => b.nativeId),
        ],
      ),
    ]),
  ].sort();
  // Native identities, exact typing, primitive allocations, guards, and values are
  // execution semantics. View metadata, descriptions, and catalog state are not.
  const semantics = operatorFlowSemantics;
  const delegatedPolicies = {
    ...(operatorFlowTemplate ? { operatorFlowTemplate } : {}),
    ...(operatorCreationPolicies.length ? { operatorCreationPolicies } : {}),
    ...(operatorAuthorityPolicies.length ? { operatorAuthorityPolicies } : {}),
    ...(toolAdmissionPolicies.length ? { toolAdmissionPolicies } : {}),
  };
  const digestInput = {
    ...delegatedPolicies,
    ...(native.ownerAuthority.ownerSource === "modeled"
      ? { authoritySchema: 2, ownerAuthority: native.ownerAuthority }
      : {}),
    configuration: native.configuration,
    ...(native.operator ? { operator: native.operator } : {}),
    builderMandate: native.builderMandate,
    reviewerMandate: native.reviewerMandate,
    policy: native.policy,
    contracts: native.contracts,
    flows: semantics(flows),
    ...(Object.keys(caseFlows).length
      ? { caseFlows: semantics(caseFlows) }
      : {}),
    allocations,
    sourceIds,
  };
  captureDigestInput?.(structuredClone(digestInput));
  const digest = await executionDigest(digestInput);
  const mandate: ExecutableModel["mandate"] = {
    id: native.builderMandate.id,
    ...(native.builderMandate.mayOpenRequests
      ? { mayOpenRequests: true as const }
      : {}),
    mayPropose: native.builderMandate.mayPropose,
    mayInvoke: native.builderMandate.mayInvokeActiveCatalog
      ? "active-catalog-only"
      : false,
    mayReview: native.builderMandate.mayReviewExactCandidate,
    mayAdmitOwnCandidates: native.builderMandate.mayAdmit,
    mayActivate: false,
    mayChangeOwnMandate: false,
    network: native.configuration.network!,
    supportedChanges: [
      ...(isPrimaryDesigner(native, identity.systemQualifiedName, literals) &&
          native.ownerAuthority.ownerSource === "modeled" &&
          native.policy.mayProposeSysmlRevision
        ? [
          // Compilation above validates the optional native definition. A legacy
          // model without it cannot publish this grant through the source writer.
          ...(snapshot.elements.some((element) =>
              sameProductName(
                element.qualifiedName,
                "AssemblyAuthority::ToolAdmissionPolicy",
              ) &&
              element.metaclass === "PartDefinition"
            )
            ? [{
              kind: "propose_mandate_change" as const,
              requestedRights: "toolAdmission" as const,
              description:
                "Request or revise bounded admission of other operators’ exact tested candidates, subject to a separate human decision.",
            }]
            : []),
          {
            kind: "propose_mandate_change" as const,
            requestedRights: "operatorAuthority" as const,
            description:
              "Request or revise bounded operator authority, subject to a separate human decision.",
          },
        ]
        : []),
      ...(native.policy.mayProposeSysmlRevision
        ? [{
          kind: "propose_mandate_change" as const,
          requestedRights: "grantModelEditing" as const,
          description:
            "Request an exact file/root model editing grant without raw replacement, subject to separate human approval.",
        }]
        : []),
      ...(native.policy.mayChangeUrlSelection
        ? [{
          kind: "propose_mandate_change" as const,
          requestedRights: "setUrlSelectionMode" as const,
          description:
            "Propose an explicit URL selection policy revision for separate approval.",
        }]
        : []),
      ...(native.policy.mayAddNetworkHosts
        ? [{
          kind: "propose_mandate_change" as const,
          requestedRights: "addNetworkHosts" as const,
          description:
            "Propose exact canonical network hosts for separate approval.",
        }]
        : []),
      ...(native.policy.mayDelegateOwnAdmission &&
          native.configuration.builder.admissionAuthority === "human"
        ? [{
          kind: "propose_mandate_change" as const,
          requestedRights: "mayAdmitOwnCandidates" as const,
          description: "Propose a separate admission mandate decision.",
        }]
        : []),
    ],
  };
  return {
    ...delegatedPolicies,
    identity: native.identity,
    ownerAuthority: native.ownerAuthority,
    ...(native.operator ? { operator: native.operator } : {}),
    version: {
      digest,
      ...(native.ownerAuthority.ownerSource === "modeled"
        ? { authoritySchema: 2 as const }
        : {}),
      rootId: identity.rootId,
      configurationId: native.configuration.id,
      configurationRevision: native.configuration.revision,
      sourceIds,
    },
    configuration: native.configuration,
    mandate,
    policy: native.policy as ExecutionPolicy,
    contracts: native.contracts,
    flows,
    ...(Object.keys(caseFlows).length ? { caseFlows } : {}),
    catalog: native.capabilities.map(({ sourceIds: _source, ...entry }) => ({
      ...entry,
      status: entry.status as ExecutableModel["catalog"][number]["status"],
    })),
  };
}
